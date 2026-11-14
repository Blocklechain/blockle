/**
 * Blocklings — SFX event wiring (shim: `initSfx(api)` from main.ts).
 *
 * Subscribes the SFX library (src/audio/sfx-defs.ts) to the global event bus
 * with sensible throttles so busy combat never turns into white noise, and
 * runs the footstep driver (polls `api.player.moving`, alternates L/R pan,
 * picks the recipe from the integrator-wired surface source).
 *
 * Integrator wiring:
 *   initSfx(api)
 *   setSurfaceSource((x, z) => 'grass' | 'cobble' | 'sand' | 'snow' | null)
 *     // optional — footsteps default to grass until wired
 *
 * Everything here is fire-and-forget audio: no game state is mutated, and all
 * triggers run through the engine's sfx bus (so the persisted SFX slider and
 * pre-unlock silence are respected for free).
 */
import type { GameAPI } from '../types'
import { events } from '../events'
import { audio } from './engine'
// Make sure the library is registered even if the engine import order changes.
import './sfx-defs'

/* ========================================================================== *
 *  Surface source (footsteps)                                                *
 * ========================================================================== */

export type SurfaceFn = (x: number, z: number) => string | null

let surfaceFn: SurfaceFn | null = null

/**
 * Wire the ground-surface sampler used to pick footstep sounds. Return one of
 * 'grass' | 'cobble' | 'sand' | 'snow' (anything else falls back to grass).
 */
export function setSurfaceSource(fn: SurfaceFn): void {
  surfaceFn = fn
}

/* ========================================================================== *
 *  Local helpers                                                             *
 * ========================================================================== */

/** Simple min-interval gate: returns true when enough time has passed. */
function gate(minMs: number): () => boolean {
  let last = 0
  return () => {
    const n = performance.now()
    if (n - last < minMs) return false
    last = n
    return true
  }
}

/** Sliding-window rate limiter: at most `perSec` passes per second. */
function budget(perSec: number): () => boolean {
  let stamps: number[] = []
  return () => {
    const n = performance.now()
    stamps = stamps.filter((s) => n - s < 1000)
    if (stamps.length >= perSec) return false
    stamps.push(n)
    return true
  }
}

/** Small random pitch jitter so repeated sounds never machine-gun. */
function jitter(spread = 0.12): number {
  return 1 - spread / 2 + Math.random() * spread
}

const STEP_SURFACES: ReadonlySet<string> = new Set(['grass', 'cobble', 'sand', 'snow'])

let inited = false

/* ========================================================================== *
 *  initSfx                                                                   *
 * ========================================================================== */

export function initSfx(api: GameAPI): void {
  if (inited) return
  inited = true

  /** Screen-space-ish stereo pan of a world position relative to the hero
   *  (isometric camera: screen-x grows with +x and -z). */
  function panOf(pos: { x: number; z: number }): number {
    const dx = pos.x - api.player.pos.x
    const dz = pos.z - api.player.pos.z
    return Math.max(-0.6, Math.min(0.6, (dx - dz) * 0.08))
  }

  // ---- combat --------------------------------------------------------------

  const hitGate = budget(10)
  const splatBudget = budget(6) // max 6 splats/s, spec'd
  events.on('mob:hit', ({ crit, pos }) => {
    if (!hitGate()) return
    const pan = panOf(pos)
    if (crit) audio.sfx.play('crit-crunch', { pitch: jitter(0.08), pan })
    else audio.sfx.play('hit-thunk', { pitch: jitter(), pan })
    if (Math.random() < 0.45 && splatBudget()) {
      audio.sfx.play('blood-splat', { vel: 0.8, pitch: jitter(0.2), pan })
    }
  })

  const deathGate = budget(5)
  events.on('mob:killed', ({ boss, pos }) => {
    if (!deathGate()) return
    const pan = panOf(pos)
    audio.sfx.play('mob-death', { pitch: boss ? 0.8 : jitter(0.15), pan })
    if (boss) audio.sfx.play('boss-roar', { vel: 0.9, pan })
  })

  const hurtGate = gate(250)
  events.on('player:damaged', ({ amount }) => {
    if (!hurtGate()) return
    audio.sfx.play('player-hurt', {
      vel: amount >= 15 ? 1 : 0.8,
      pitch: (amount >= 15 ? 0.88 : 1) * jitter(0.08)
    })
  })

  events.on('player:died', () => {
    audio.sfx.play('thud', { pitch: 0.6 })
    audio.sfx.play('pet-whimper', { vel: 0.6, pitch: 0.85 }) // comedy beat
  })

  const specialGate = gate(200)
  events.on('special:used', ({ id }) => {
    if (!specialGate()) return
    const s = id.toLowerCase()
    if (s.includes('whirl') || s.includes('spin') || s.includes('cyclone')) {
      audio.sfx.play('special-whirlwind')
    } else if (s.includes('fire') || s.includes('blast') || s.includes('bolt') || s.includes('meteor')) {
      audio.sfx.play('fireball-cast')
      window.setTimeout(() => audio.sfx.play('fireball-explode'), 450)
    } else if (s.includes('volley') || s.includes('arrow') || s.includes('bow') || s.includes('multi') || s.includes('shot')) {
      audio.sfx.play('bow-volley')
    } else if (s.includes('bash') || s.includes('shield') || s.includes('slam') || s.includes('stomp')) {
      audio.sfx.play('shield-bash')
    } else if (s.includes('lunge') || s.includes('dash') || s.includes('charge') || s.includes('leap')) {
      audio.sfx.play('special-lunge')
    } else {
      audio.sfx.play('sword-whoosh-2')
    }
  })

  // ---- gathering -----------------------------------------------------------

  const gatherGate = gate(300)
  events.on('gather:done', ({ nodeType, skill }) => {
    if (!gatherGate()) return
    const k = `${nodeType} ${skill}`.toLowerCase()
    if (k.includes('tree') || k.includes('wood')) {
      audio.sfx.play('axe-chop-2', { vel: 0.8, pitch: jitter() })
      audio.sfx.play('tree-topple')
    } else if (k.includes('fish')) {
      audio.sfx.play('fish-splash', { pitch: jitter(0.08) })
    } else if (k.includes('clay') || k.includes('mud')) {
      audio.sfx.play('clay-squish', { pitch: jitter() })
    } else if (
      k.includes('vein') || k.includes('crystal') || k.includes('rock') ||
      k.includes('ore') || k.includes('mining')
    ) {
      audio.sfx.play('pick-clink-1', { vel: 0.7, pitch: jitter() })
      audio.sfx.play('rock-crumble')
    } else {
      // herb_patch / berry_bush / mushroom_cluster / farm_plot and friends
      audio.sfx.play('herb-pluck', { pitch: jitter(0.2) })
    }
  })

  // ---- items / loot / equipment -------------------------------------------

  const lootGate = gate(150)
  events.on('item:gained', ({ source }) => {
    if (!lootGate()) return
    if (source === 'loot' || source === 'quest') {
      audio.sfx.play('loot-pickup', { pitch: jitter(0.06) })
    } else if (source === 'craft') {
      audio.sfx.play('coin', { vel: 0.7, pitch: 0.9 })
    } else if (source === 'vendor') {
      if (chaChingGate()) audio.sfx.play('cha-ching-chime')
    }
    // 'gather' already sings via gather:done; 'restore' stays silent on load.
  })

  events.on('item:equipped', ({ id }) => {
    if (id) audio.sfx.play('equip-clack', { pitch: jitter(0.08) })
    else audio.sfx.play('equip-clack', { vel: 0.6, pitch: 0.72 })
  })

  // ---- economy -------------------------------------------------------------

  // One shared gate so a gold spend + its item:gained never double-ka-chings.
  const chaChingGate = gate(400)
  let goldSeen = false
  events.on('gold:changed', () => {
    if (!goldSeen) {
      goldSeen = true // initial balance snapshot at boot — not a transaction
      return
    }
    if (chaChingGate()) audio.sfx.play('cha-ching-coin')
  })

  events.on('market:sold', () => {
    audio.sfx.play('cha-ching-chime')
    audio.sfx.play('chat-pop', { vel: 0.7 })
  })

  events.on('item:minted', () => audio.sfx.play('mint-stamp'))
  events.on('pet:minted', () => audio.sfx.play('mint-stamp'))

  // ---- pets ----------------------------------------------------------------

  events.on('pet:dropped', () => {
    audio.sfx.play('pet-chirp')
    audio.sfx.play('loot-pickup', { vel: 0.7, pitch: 1.1 })
  })

  // ---- progression ---------------------------------------------------------
  // level:up / quest:accepted / quest:completed get MUSICAL stingers from the
  // director (src/audio/director.ts) — no melodic chime here or they'd clash.

  const questProgGate = gate(1000)
  events.on('quest:progress', () => {
    if (questProgGate()) audio.sfx.play('ui-tick', { vel: 0.6, pitch: 1.25 })
  })

  events.on('npc:talked', () => audio.sfx.play('ui-close', { vel: 0.7 }))

  // ---- waystones -----------------------------------------------------------
  // waystone:traveled gets the director's 'waystone_travel' stinger instead.

  events.on('waystone:attuned', () => audio.sfx.play('waystone-attune'))

  // ---- chat ----------------------------------------------------------------

  const chatGate = gate(500)
  events.on('chat:system', () => {
    if (chatGate()) audio.sfx.play('chat-pop', { vel: 0.8 })
  })

  // ---- footsteps (poll api.player.moving; surface from the wired source) ---

  let stepLeft = false
  let lastStep = 0
  window.setInterval(() => {
    if (!audio.unlocked || !api.player.moving) return
    const n = performance.now()
    if (n - lastStep < 330) return
    lastStep = n
    stepLeft = !stepLeft
    const raw = surfaceFn ? surfaceFn(api.player.pos.x, api.player.pos.z) : null
    const surf = raw && STEP_SURFACES.has(raw) ? raw : 'grass'
    audio.sfx.play(`step-${surf}`, {
      vel: 0.75 + Math.random() * 0.25,
      pitch: jitter(0.14),
      pan: stepLeft ? -0.22 : 0.22
    })
  }, 80)
}
