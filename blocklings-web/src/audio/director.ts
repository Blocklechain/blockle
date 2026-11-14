/**
 * Blocklings — music director (integrator-owned).
 *
 * One small brain that decides WHICH song the engine should be playing:
 *
 *   priority:  boss theme  >  combat loop  >  explore (biome + night)  >  title
 *
 *   - title     : 'title' from boot until the world is entered (queued
 *                 pre-unlock; the engine flushes it on the first gesture).
 *   - explore   : biome -> song table over the bright + dark songbooks, with
 *                 the 'village' waltz special-cased for the starting kingdom
 *                 and the 'night' nocturne overriding SAFE biomes after dark
 *                 on the shared CST clock (wired from the atmosphere module).
 *   - combat    : inferred combat heat from 'mob:hit' / 'player:damaged'
 *                 events with an 8s decay — no combat-module coupling.
 *   - boss      : 'mob:hit' / 'mob:killed' carry an optional boss flag (and
 *                 'player:damaged' a boss name); each of the four named
 *                 bosses has its own theme (ids match BOSSES ids). Victory
 *                 or 12s of disengagement releases the theme.
 *
 * Musical stingers (one-shots riding the sfx bus, from songs/dynamic) are
 * also fired here: levelup, quest accept/complete, death, pet drop, waystone
 * travel, mint success, gold purchase.
 *
 * Imports: engine (sanctioned), the three song content modules (side-effect
 * registration + stinger player), events, and the PURE regionOrZoneAt lookup
 * (same sanctioned exception the ambience shim uses).
 */
import type { GameAPI } from '../types'
import { events } from '../events'
import { BOSSES } from '../ids'
import { regionOrZoneAt } from '../world/index'
import { audio } from './engine'
// Side-effect imports: every song registers into the songbook at module load.
import './songs/bright'
import './songs/dark'
import { playStinger } from './songs/dynamic'

/** How often the director re-evaluates, ms. */
const TICK_MS = 1000
/** Combat heat decay — quiet this long means the fight is over. */
const COMBAT_DECAY_MS = 8000
/** Boss engagement decay (no boss hits this long = disengaged/fled). */
const BOSS_DECAY_MS = 12000
/** Night bounds on the CST clock (matches atmosphere + ambience). */
const DAWN = 6
const DUSK = 19.5

/** Crossfades, seconds. */
const FADE_EXPLORE = 3
const FADE_INTO_COMBAT = 0.6
const FADE_OUT_OF_COMBAT = 2.5

/** biome -> explore song id (bright + dark songbooks). */
const BIOME_SONG: Readonly<Record<string, string>> = {
  meadow: 'meadow',
  savanna: 'meadow',
  forest: 'forest',
  mushroom: 'forest',
  cherry: 'cherry',
  city: 'capital',
  mountain: 'mountain',
  canyon: 'mountain',
  desert: 'mountain',
  tundra: 'glacier_tundra',
  glacier: 'glacier_tundra',
  swamp: 'swamp',
  beach: 'beach_lagoon',
  lagoon: 'beach_lagoon',
  wastes: 'wastes',
  ruins: 'ruins',
  crystal: 'ruins',
  graveyard: 'graveyard',
  dungeon: 'dungeon',
  volcanic: 'volcanic'
}

/** Safe biomes where the 'night' nocturne takes over after dark. */
const NIGHT_BIOMES: ReadonlySet<string> = new Set([
  'meadow',
  'savanna',
  'forest',
  'cherry',
  'mushroom',
  'city',
  'beach',
  'lagoon'
])

/** Boss ids whose themes exist in songs/dynamic. */
const BOSS_THEMES: ReadonlySet<string> = new Set([
  'boss_greenwood',
  'boss_ironhold',
  'boss_ashen',
  'boss_forgotten'
])

export interface DirectorAPI {
  /** Flip from the title song to world-driven music (call at world entry). */
  enterWorld(): void
  /** Wire the atmosphere's shared CST clock (`atmo.hourCST`). */
  setHourSource(fn: () => number): void
  /** The song id the director last asked for (debug/HUD). */
  currentWanted(): string | null
}

let inited = false

export function initDirector(api: GameAPI): DirectorAPI {
  if (inited) {
    // Defensive: a second init returns an inert handle (never happens in main).
    return { enterWorld: () => {}, setHourSource: () => {}, currentWanted: () => null }
  }
  inited = true

  let inWorld = false
  let hourSource: (() => number) | null = null
  let wanted: string | null = null

  // --- combat / boss heat ---------------------------------------------------

  let lastCombatAt = 0
  let bossId: string | null = null
  let lastBossAt = 0

  /** Boss display name -> boss id (for 'player:damaged'.from attribution). */
  const bossByName = new Map<string, string>(BOSSES.map((b) => [b.name, b.id]))

  function touchCombat(): void {
    lastCombatAt = performance.now()
  }

  function touchBoss(id: string): void {
    if (!BOSS_THEMES.has(id)) return
    bossId = id
    lastBossAt = performance.now()
    touchCombat()
    tick() // boss music should land on the first hit, not the next poll
  }

  events.on('mob:hit', (e) => {
    touchCombat()
    if (e.boss && e.bossId) touchBoss(e.bossId)
  })
  events.on('player:damaged', (e) => {
    touchCombat()
    const id = bossByName.get(e.from)
    if (id) touchBoss(id)
  })
  events.on('mob:killed', (e) => {
    if (e.boss) {
      // Victory — release the theme immediately; explore music swells back.
      bossId = null
      lastBossAt = 0
    }
  })

  // --- stingers (musical one-shots on top of whatever is playing) -----------

  events.on('level:up', () => playStinger('levelup'))
  events.on('quest:accepted', () => playStinger('quest_accept'))
  events.on('quest:completed', () => playStinger('quest_complete'))
  events.on('player:died', () => playStinger('death'))
  events.on('pet:dropped', () => playStinger('pet_drop'))
  events.on('waystone:traveled', () => playStinger('waystone_travel'))
  events.on('item:minted', () => playStinger('mint_success'))
  events.on('pet:minted', () => playStinger('mint_success'))
  // GOLD: stinger only when the balance goes UP (IAP purchase landed) —
  // spends and the boot snapshot stay quiet.
  let goldPrev: number | null = null
  events.on('gold:changed', ({ balance }) => {
    if (goldPrev !== null && balance > goldPrev) playStinger('gold_purchase')
    goldPrev = balance
  })

  // --- song selection -------------------------------------------------------

  function hourCST(): number {
    if (hourSource) return hourSource()
    // Fallback before the atmosphere is wired: local time in America/Chicago.
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
      const d = new Date()
      return d.getHours() + d.getMinutes() / 60
    }
  }

  function exploreSong(): string {
    const r = regionOrZoneAt(api.player.pos.x, api.player.pos.z)
    // The starting kingdom gets the cozy village waltz, not generic meadow.
    if (r?.id === 'beginnings') {
      const hour = hourCST()
      return hour < DAWN || hour >= DUSK ? 'night' : 'village'
    }
    const biome = r?.biome ?? null
    const song = (biome !== null ? BIOME_SONG[biome] : undefined) ?? 'meadow'
    if (biome !== null && NIGHT_BIOMES.has(biome)) {
      const hour = hourCST()
      if (hour < DAWN || hour >= DUSK) return 'night'
    }
    return song
  }

  function tick(): void {
    if (!inWorld) return
    const now = performance.now()
    if (bossId !== null && now - lastBossAt > BOSS_DECAY_MS) bossId = null
    const inCombat = now - lastCombatAt < COMBAT_DECAY_MS

    let next: string
    let fade: number
    if (bossId !== null) {
      next = bossId
      fade = FADE_INTO_COMBAT
    } else if (inCombat) {
      next = 'combat'
      fade = FADE_INTO_COMBAT
    } else {
      next = exploreSong()
      fade =
        wanted === 'combat' || (wanted !== null && BOSS_THEMES.has(wanted))
          ? FADE_OUT_OF_COMBAT
          : FADE_EXPLORE
    }

    if (next !== wanted) {
      wanted = next
      audio.playSong(next, { fade })
    }
  }

  window.setInterval(tick, TICK_MS)

  // --- title ----------------------------------------------------------------

  // Queued now (pre-unlock); the engine flushes it on the first gesture, so
  // the title theme is the first thing the player ever hears.
  wanted = 'title'
  audio.playSong('title', { fade: 2 })

  return {
    enterWorld() {
      if (inWorld) return
      inWorld = true
      tick()
    },
    setHourSource(fn) {
      hourSource = fn
    },
    currentWanted() {
      return wanted
    }
  }
}
