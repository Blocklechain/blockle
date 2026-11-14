/**
 * Blocklings — ambience selection shim (biome + CST time + water proximity).
 *
 * OWNED BY THE AMBIENCE CONTENT AGENT. Every 2 seconds this picks the right
 * ambient bed for where the player is standing and what time it is on the
 * shared CST world clock, then asks the engine to crossfade to it
 * (`audio.ambient.set` dedupes, so re-picking the same bed is free).
 *
 * INTEGRATOR WIRING (main.ts):
 *   const amb = initAmbience(api)
 *   amb.setHourSource(() => atmo.hourCST())        // atmosphere's world clock
 *   amb.setWaterSource((x, z) => {                 // surface map water test
 *     const s = surfaceTypeAt(x, z)
 *     return s === S_RIVER || s === S_BANK || s === -1   // -1 = open sea
 *   })
 *
 * Unwired fallbacks: local wall-clock time rendered in America/Chicago (the
 * same timezone the atmosphere runs on), and biome-only water detection
 * (beach / lagoon still get the shoreline bed).
 *
 * Selection table (night = before 06:00 or after 19:30 CST, matching the
 * atmosphere's sunrise/sunset):
 *
 *   biome              day              night
 *   ----------------   --------------   --------------
 *   meadow             meadow_day       night_crickets
 *   savanna            meadow_day       night_crickets
 *   forest             forest_day       night_crickets
 *   cherry             forest_day       night_crickets
 *   mushroom           forest_day       night_crickets
 *   city               capital_crowd    night_crickets
 *   mountain           mountain_wind    mountain_wind
 *   canyon             mountain_wind    mountain_wind
 *   desert             mountain_wind    night_crickets
 *   tundra             tundra_wind      tundra_wind
 *   glacier            tundra_wind      tundra_wind
 *   swamp              swamp_frogs      swamp_frogs
 *   beach              water_edge       water_edge
 *   lagoon             water_edge       water_edge
 *   wastes             wastes_hum       wastes_hum
 *   ruins              wastes_hum       wastes_hum
 *   graveyard          wastes_hum       wastes_hum
 *   crystal            wastes_hum       wastes_hum
 *   dungeon            dungeon_drip     dungeon_drip   (indoor: ignores time)
 *   volcanic           volcanic_rumble  volcanic_rumble (indoor-ish: ignores time)
 *   (off-map / null)   meadow_day       night_crickets
 *
 * Water proximity (any wired-source water within ~10 units) overrides the
 * table with water_edge — except in the indoor biomes (dungeon / volcanic),
 * whose own beds always win.
 */
import { audio } from './engine'
import type { GameAPI } from '../types'
// PURE lookup only (sanctioned, same as gather/): side-effect-free zone/region defs.
import { regionOrZoneAt } from '../world/index'

/** How often the picker re-evaluates, ms. */
const PICK_MS = 2000
/** Crossfade between beds, seconds. */
const BED_FADE = 2.5
/** Night bounds on the CST world clock (matches atmosphere SUNRISE/SUNSET). */
const DAWN = 6
const DUSK = 19.5
/** Water-proximity sampling: ring radius (world units) around the player. */
const WATER_RADIUS = 10

export interface AmbienceAPI {
  /** Wire the atmosphere's shared CST world clock (`atmo.hourCST`). */
  setHourSource(fn: () => number): void
  /** Wire a water test over the world surface map (true = water at x,z). */
  setWaterSource(fn: (x: number, z: number) => boolean): void
  /** The bed the picker last asked for (null before the first pick). */
  currentBed(): string | null
  /** Stop picking and fade ambience out. */
  dispose(): void
}

/** Beds that ignore time of day and beat water proximity (indoor-ish). */
const INDOOR_BIOMES: ReadonlySet<string> = new Set(['dungeon', 'volcanic'])

/** biome → [day bed, night bed]. */
const BED_TABLE: Readonly<Record<string, readonly [string, string]>> = {
  meadow: ['meadow_day', 'night_crickets'],
  savanna: ['meadow_day', 'night_crickets'],
  forest: ['forest_day', 'night_crickets'],
  cherry: ['forest_day', 'night_crickets'],
  mushroom: ['forest_day', 'night_crickets'],
  city: ['capital_crowd', 'night_crickets'],
  mountain: ['mountain_wind', 'mountain_wind'],
  canyon: ['mountain_wind', 'mountain_wind'],
  desert: ['mountain_wind', 'night_crickets'],
  tundra: ['tundra_wind', 'tundra_wind'],
  glacier: ['tundra_wind', 'tundra_wind'],
  swamp: ['swamp_frogs', 'swamp_frogs'],
  beach: ['water_edge', 'water_edge'],
  lagoon: ['water_edge', 'water_edge'],
  wastes: ['wastes_hum', 'wastes_hum'],
  ruins: ['wastes_hum', 'wastes_hum'],
  graveyard: ['wastes_hum', 'wastes_hum'],
  crystal: ['wastes_hum', 'wastes_hum'],
  dungeon: ['dungeon_drip', 'dungeon_drip'],
  volcanic: ['volcanic_rumble', 'volcanic_rumble']
}

/** Fallback when the biome is unknown / off-map. */
const DEFAULT_BEDS: readonly [string, string] = ['meadow_day', 'night_crickets']

/** Local wall-clock hour in America/Chicago (fallback when unwired). */
function localCstHour(): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).formatToParts(new Date())
    let h = 0
    let m = 0
    for (const p of parts) {
      if (p.type === 'hour') h = Number(p.value) % 24
      else if (p.type === 'minute') m = Number(p.value)
    }
    return h + m / 60
  } catch {
    // Environment without timezone data: plain local time beats silence.
    const d = new Date()
    return d.getHours() + d.getMinutes() / 60
  }
}

export function initAmbience(api: GameAPI): AmbienceAPI {
  let hourSource: (() => number) | null = null
  let waterSource: ((x: number, z: number) => boolean) | null = null
  let current: string | null = null
  let disposed = false

  const nearWater = (): boolean => {
    if (!waterSource) return false
    const { x, z } = api.player.pos
    // Player cell + an 8-point ring at WATER_RADIUS.
    if (waterSource(x, z)) return true
    const r = WATER_RADIUS
    const d = r * Math.SQRT1_2
    return (
      waterSource(x + r, z) ||
      waterSource(x - r, z) ||
      waterSource(x, z + r) ||
      waterSource(x, z - r) ||
      waterSource(x + d, z + d) ||
      waterSource(x + d, z - d) ||
      waterSource(x - d, z + d) ||
      waterSource(x - d, z - d)
    )
  }

  const pickBed = (): string => {
    const { x, z } = api.player.pos
    const biome = regionOrZoneAt(x, z)?.biome ?? null
    const hour = hourSource ? hourSource() : localCstHour()
    const night = hour < DAWN || hour >= DUSK
    if (biome !== null && INDOOR_BIOMES.has(biome)) {
      // Indoor-ish: own bed always, time and shoreline ignored.
      return (BED_TABLE[biome] ?? DEFAULT_BEDS)[night ? 1 : 0]
    }
    if (nearWater()) return 'water_edge'
    const pair = (biome !== null ? BED_TABLE[biome] : undefined) ?? DEFAULT_BEDS
    return pair[night ? 1 : 0]
  }

  const tick = (): void => {
    if (disposed) return
    const bed = pickBed()
    if (bed !== current) {
      current = bed
      audio.ambient.set(bed, { fade: BED_FADE })
    }
  }

  const timer = window.setInterval(tick, PICK_MS)
  // First pick immediately — audio.ambient.set queues pre-unlock, and
  // onUnlocked re-picks so the first audible bed matches where the player
  // actually is by the time they click.
  tick()
  audio.onUnlocked(() => {
    current = null
    tick()
  })

  return {
    setHourSource(fn) {
      hourSource = fn
    },
    setWaterSource(fn) {
      waterSource = fn
    },
    currentBed() {
      return current
    },
    dispose() {
      disposed = true
      window.clearInterval(timer)
      current = null
      audio.ambient.set(null, { fade: BED_FADE })
    }
  }
}
