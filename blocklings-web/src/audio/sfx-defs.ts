/**
 * Blocklings — SFX recipe content (the full library, ~46 recipes).
 *
 * OWNED BY THE SFX CONTENT AGENT. Every sound is a short, punchy WebAudio
 * synth recipe registered with `registerSfx(name, recipe)`; the file is
 * side-effect-imported by the engine so registration happens automatically.
 * Mix law: peaks sit around 0.05 (footsteps) .. 0.45 (boss roar) so the whole
 * library rides under the music through the sfx bus (SFX_TRIM 0.9).
 *
 * Event wiring lives in src/audio/sfx.ts (initSfx). Recipes that no bus event
 * covers yet (sword whooshes, per-swing chops/clinks, error-buzz, ui-open/
 * close) are available to any module via `audio.sfx.play(name)`.
 */
import { registerSfx } from './sfx-core'
import { whiteNoiseBuffer, pinkNoiseBuffer } from './instruments'

/* ========================================================================== *
 *  Local synth helpers (recipes compose these; nothing exported).            *
 * ========================================================================== */

interface ToneOpts {
  /** Oscillator type (default 'sine'). */
  type?: OscillatorType
  /** Start frequency (Hz, pre-pitch). */
  f0: number
  /** Optional glide target frequency. */
  f1?: number
  /** Glide time (default = dur). */
  slideT?: number
  /** Start delay in seconds (default 0). */
  at?: number
  /** Body length in seconds (release tail added on top). */
  dur: number
  /** Peak gain (pre-vel). */
  peak: number
  /** Attack seconds (default 0.004). */
  a?: number
  /** Release tau for setTargetAtTime (default dur * 0.4). */
  rel?: number
  /** Optional lowpass cutoff (Hz) in front of the envelope. */
  lp?: number
  /** Optional vibrato { freq, depth(Hz) }. */
  vib?: { freq: number; depth: number }
}

/** One enveloped oscillator; cleans itself up on end. */
function tone(
  ctx: AudioContext,
  bus: AudioNode,
  vel: number,
  pitch: number,
  o: ToneOpts
): void {
  const t = ctx.currentTime + (o.at ?? 0)
  const osc = ctx.createOscillator()
  osc.type = o.type ?? 'sine'
  const f0 = Math.max(20, o.f0 * pitch)
  osc.frequency.setValueAtTime(f0, t)
  if (o.f1 !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(20, o.f1 * pitch),
      t + (o.slideT ?? o.dur)
    )
  }
  const extras: AudioNode[] = []
  let head: AudioNode = osc
  if (o.lp !== undefined) {
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = o.lp
    head.connect(f)
    head = f
    extras.push(f)
  }
  if (o.vib) {
    const lf = ctx.createOscillator()
    lf.frequency.value = o.vib.freq
    const lg = ctx.createGain()
    lg.gain.value = o.vib.depth
    lf.connect(lg)
    lg.connect(osc.frequency)
    lf.start(t)
    lf.stop(t + o.dur + 1)
    extras.push(lg)
  }
  const g = ctx.createGain()
  const peak = Math.max(0.0001, o.peak * vel)
  const a = o.a ?? 0.004
  const rel = o.rel ?? o.dur * 0.4
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(peak, t + a)
  g.gain.setTargetAtTime(0.0001, t + Math.max(a, o.dur * 0.4), Math.max(0.01, rel))
  head.connect(g)
  g.connect(bus)
  osc.start(t)
  osc.stop(t + o.dur + rel * 4 + 0.1)
  osc.onended = () => {
    g.disconnect()
    for (const n of extras) {
      try {
        n.disconnect()
      } catch {
        /* fine */
      }
    }
  }
}

interface HissOpts {
  at?: number
  dur: number
  peak: number
  a?: number
  rel?: number
  /** Filter type (default 'lowpass' when f0 given). */
  type?: BiquadFilterType
  /** Filter start cutoff/center (Hz, pre-pitch). */
  f0?: number
  /** Filter glide target. */
  f1?: number
  slideT?: number
  q?: number
  /** Pink noise instead of white (darker). */
  pink?: boolean
  /** Filter-frequency LFO { freq, depth(Hz) } — swirls/growls. */
  wob?: { freq: number; depth: number }
}

/** One enveloped (optionally filtered) noise burst; self-cleaning. */
function hiss(
  ctx: AudioContext,
  bus: AudioNode,
  vel: number,
  pitch: number,
  o: HissOpts
): void {
  const t = ctx.currentTime + (o.at ?? 0)
  const src = ctx.createBufferSource()
  src.buffer = o.pink ? pinkNoiseBuffer(ctx) : whiteNoiseBuffer(ctx)
  src.loop = true
  const extras: AudioNode[] = []
  let head: AudioNode = src
  if (o.f0 !== undefined) {
    const f = ctx.createBiquadFilter()
    f.type = o.type ?? 'lowpass'
    f.frequency.setValueAtTime(Math.max(40, o.f0 * pitch), t)
    if (o.f1 !== undefined) {
      f.frequency.exponentialRampToValueAtTime(
        Math.max(40, o.f1 * pitch),
        t + (o.slideT ?? o.dur)
      )
    }
    if (o.q !== undefined) f.Q.value = o.q
    if (o.wob) {
      const lf = ctx.createOscillator()
      lf.frequency.value = o.wob.freq
      const lg = ctx.createGain()
      lg.gain.value = o.wob.depth
      lf.connect(lg)
      lg.connect(f.frequency)
      lf.start(t)
      lf.stop(t + o.dur + 1)
      extras.push(lg)
    }
    src.connect(f)
    head = f
    extras.push(f)
  }
  const g = ctx.createGain()
  const peak = Math.max(0.0001, o.peak * vel)
  const a = o.a ?? 0.003
  const rel = o.rel ?? o.dur * 0.35
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(peak, t + a)
  g.gain.setTargetAtTime(0.0001, t + Math.max(a, o.dur * 0.4), Math.max(0.01, rel))
  head.connect(g)
  g.connect(bus)
  src.start(t, Math.random() * 0.4) // random buffer offset: repeats never phase
  src.stop(t + o.dur + rel * 4 + 0.1)
  src.onended = () => {
    g.disconnect()
    for (const n of extras) {
      try {
        n.disconnect()
      } catch {
        /* fine */
      }
    }
  }
}

/** Tiny high tick (mechanical clicks, reel clicks). */
function tick(
  ctx: AudioContext,
  bus: AudioNode,
  vel: number,
  f: number,
  at = 0,
  peak = 0.12
): void {
  hiss(ctx, bus, vel, 1, { at, dur: 0.02, peak, type: 'bandpass', f0: f, q: 6, rel: 0.012 })
}

/* ========================================================================== *
 *  COMBAT                                                                    *
 * ========================================================================== */

/** Sword whoosh, falling — the "big arc" swing. */
registerSfx('sword-whoosh-1', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, {
    dur: 0.14, peak: 0.16, a: 0.025, type: 'bandpass', f0: 2300, f1: 650, q: 1.6, rel: 0.05
  })
})

/** Sword whoosh, rising — the quick backswing variant. */
registerSfx('sword-whoosh-2', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, {
    dur: 0.12, peak: 0.15, a: 0.02, type: 'bandpass', f0: 850, f1: 2600, q: 1.6, rel: 0.045
  })
})

/** Melee connect: meaty low thunk. */
registerSfx('hit-thunk', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 185, f1: 70, dur: 0.1, peak: 0.3, rel: 0.05 })
  hiss(ctx, bus, vel, pitch, { dur: 0.06, peak: 0.18, f0: 1300, f1: 450, rel: 0.03 })
})

/** Critical hit: bigger, brighter, nastier crunch. */
registerSfx('crit-crunch', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'square', f0: 210, f1: 52, dur: 0.14, peak: 0.26, lp: 1200, rel: 0.06 })
  hiss(ctx, bus, vel, pitch, { dur: 0.1, peak: 0.26, f0: 2800, f1: 420, rel: 0.05 })
  tick(ctx, bus, vel, 3400, 0.012, 0.14)
})

/** Cartoon blood splat: two wet lowpassed plops. */
registerSfx('blood-splat', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.05, peak: 0.16, f0: 900, f1: 300, q: 2, rel: 0.03 })
  hiss(ctx, bus, vel, pitch, { at: 0.05, dur: 0.07, peak: 0.12, f0: 650, f1: 220, q: 2, rel: 0.04 })
  tone(ctx, bus, vel, pitch, { f0: 240, f1: 110, dur: 0.08, peak: 0.1, rel: 0.04 })
})

/** Mob death: comedy poof + descending slide-whistle farewell. */
registerSfx('mob-death', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.22, peak: 0.18, a: 0.008, f0: 850, f1: 220, rel: 0.1 })
  tone(ctx, bus, vel, pitch, {
    type: 'triangle', f0: 520, f1: 130, dur: 0.3, peak: 0.12, a: 0.01, slideT: 0.28, rel: 0.08
  })
})

/** Player hurt: short synth "oof" grunt (no voice — two dark saws). */
registerSfx('player-hurt', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'sawtooth', f0: 165, f1: 92, dur: 0.14, peak: 0.2, lp: 900, rel: 0.06 })
  tone(ctx, bus, vel, pitch, { type: 'sawtooth', f0: 250, f1: 150, dur: 0.11, peak: 0.1, lp: 1100, rel: 0.05 })
})

/** Whirlwind special: three-swirl cyclone whoosh. */
registerSfx('special-whirlwind', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, {
    dur: 0.6, peak: 0.2, a: 0.04, type: 'bandpass', f0: 750, f1: 1200, q: 2.2,
    wob: { freq: 6.5, depth: 520 }, rel: 0.14
  })
})

/** Lunge/dash special: fast rising zip + air cut. */
registerSfx('special-lunge', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'square', f0: 220, f1: 880, dur: 0.12, peak: 0.1, lp: 2200, rel: 0.04 })
  hiss(ctx, bus, vel, pitch, {
    dur: 0.16, peak: 0.16, a: 0.015, type: 'bandpass', f0: 600, f1: 3100, q: 1.4, rel: 0.05
  })
})

/** Fireball cast: gathering flame — rising hum + crackle. */
registerSfx('fireball-cast', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 210, f1: 760, dur: 0.3, peak: 0.12, a: 0.03, vib: { freq: 22, depth: 14 }, rel: 0.08 })
  hiss(ctx, bus, vel, pitch, { dur: 0.3, peak: 0.08, a: 0.05, type: 'highpass', f0: 2400, rel: 0.09 })
})

/** Fireball impact: boom + flame wash. */
registerSfx('fireball-explode', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 130, f1: 40, dur: 0.3, peak: 0.34, rel: 0.12 })
  hiss(ctx, bus, vel, pitch, { dur: 0.35, peak: 0.22, f0: 1500, f1: 180, rel: 0.14 })
})

/** Bow volley: string twang + arrow flight hiss. */
registerSfx('bow-volley', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 430, f1: 330, dur: 0.07, peak: 0.2, a: 0.002, rel: 0.035 })
  hiss(ctx, bus, vel, pitch, {
    at: 0.03, dur: 0.2, peak: 0.1, a: 0.02, type: 'bandpass', f0: 1900, f1: 3200, q: 2, rel: 0.07
  })
})

/** Shield bash: dissonant metal clang. */
registerSfx('shield-bash', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'square', f0: 523, dur: 0.12, peak: 0.12, lp: 2600, rel: 0.07 })
  tone(ctx, bus, vel, pitch, { type: 'square', f0: 741, dur: 0.1, peak: 0.09, lp: 2600, rel: 0.06 })
  hiss(ctx, bus, vel, pitch, { dur: 0.1, peak: 0.16, type: 'bandpass', f0: 2500, q: 7, rel: 0.05 })
  tone(ctx, bus, vel, pitch, { f0: 150, f1: 80, dur: 0.09, peak: 0.14, rel: 0.04 })
})

/** Boss roar: big filtered-noise growl + sub throat. */
registerSfx('boss-roar', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, {
    dur: 0.85, peak: 0.4, a: 0.06, pink: true, f0: 330, q: 5,
    wob: { freq: 11, depth: 130 }, rel: 0.22
  })
  tone(ctx, bus, vel, pitch, {
    type: 'sawtooth', f0: 78, f1: 46, dur: 0.8, peak: 0.22, a: 0.05, lp: 320,
    vib: { freq: 13, depth: 6 }, rel: 0.2
  })
})

/* ========================================================================== *
 *  GATHERING                                                                 *
 * ========================================================================== */

/** Axe chop into wood, variant A. */
registerSfx('axe-chop-1', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.06, peak: 0.22, f0: 1250, f1: 380, rel: 0.03 })
  tone(ctx, bus, vel, pitch, { f0: 160, f1: 85, dur: 0.07, peak: 0.16, rel: 0.035 })
})

/** Axe chop, variant B (brighter knock). */
registerSfx('axe-chop-2', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.055, peak: 0.2, f0: 1600, f1: 500, rel: 0.028 })
  tone(ctx, bus, vel, pitch, { f0: 200, f1: 105, dur: 0.06, peak: 0.14, rel: 0.03 })
})

/** Tree falls: long creak, then a ground thud. */
registerSfx('tree-topple', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, {
    type: 'sawtooth', f0: 95, f1: 60, dur: 0.5, peak: 0.1, a: 0.08, lp: 420,
    vib: { freq: 7, depth: 9 }, rel: 0.1
  })
  hiss(ctx, bus, vel, pitch, {
    dur: 0.45, peak: 0.06, a: 0.1, type: 'bandpass', f0: 500, f1: 300, q: 4, rel: 0.1
  })
  // the landing, after the lean
  tone(ctx, bus, vel, pitch, { at: 0.55, f0: 120, f1: 42, dur: 0.14, peak: 0.3, rel: 0.07 })
  hiss(ctx, bus, vel, pitch, { at: 0.55, dur: 0.12, peak: 0.2, f0: 800, f1: 200, rel: 0.06 })
})

/** Pickaxe clink on rock, variant A. */
registerSfx('pick-clink-1', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 1800, f1: 1500, dur: 0.05, peak: 0.16, a: 0.002, rel: 0.03 })
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 2700, dur: 0.035, peak: 0.08, a: 0.002, rel: 0.02 })
  tick(ctx, bus, vel, 3600, 0, 0.1)
})

/** Pickaxe clink, variant B (lower ring). */
registerSfx('pick-clink-2', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 1450, f1: 1250, dur: 0.055, peak: 0.16, a: 0.002, rel: 0.032 })
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 2150, dur: 0.04, peak: 0.08, a: 0.002, rel: 0.02 })
  tick(ctx, bus, vel, 3000, 0, 0.1)
})

/** Rock gives way: three descending crumbles. */
registerSfx('rock-crumble', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.08, peak: 0.18, f0: 900, f1: 420, rel: 0.04 })
  hiss(ctx, bus, vel, pitch, { at: 0.09, dur: 0.08, peak: 0.15, f0: 650, f1: 300, rel: 0.04 })
  hiss(ctx, bus, vel, pitch, { at: 0.19, dur: 0.1, peak: 0.12, f0: 450, f1: 180, rel: 0.06 })
  tone(ctx, bus, vel, pitch, { at: 0.19, f0: 110, f1: 60, dur: 0.1, peak: 0.12, rel: 0.05 })
})

/** Catch! Splash + happy little reel clicks. */
registerSfx('fish-splash', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.18, peak: 0.2, f0: 1700, f1: 380, q: 1.2, rel: 0.08 })
  tone(ctx, bus, vel, pitch, { f0: 260, f1: 95, dur: 0.12, peak: 0.12, rel: 0.05 })
  for (let i = 0; i < 5; i++) {
    tick(ctx, bus, vel, 1500 + i * 180, 0.24 + i * 0.045, 0.08)
  }
})

/** Herb / berry pluck: soft pop-blip. */
registerSfx('herb-pluck', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 320, f1: 560, dur: 0.05, peak: 0.14, a: 0.003, rel: 0.03 })
  hiss(ctx, bus, vel, pitch, { dur: 0.03, peak: 0.05, f0: 1800, rel: 0.02 })
})

/** Clay dig: comedic double squish. */
registerSfx('clay-squish', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.1, peak: 0.16, f0: 700, f1: 240, q: 3, rel: 0.05 })
  hiss(ctx, bus, vel, pitch, { at: 0.11, dur: 0.12, peak: 0.13, f0: 520, f1: 170, q: 3, rel: 0.06 })
  tone(ctx, bus, vel, pitch, { f0: 180, f1: 95, dur: 0.1, peak: 0.08, rel: 0.05 })
})

/* ========================================================================== *
 *  WORLD / IDLE                                                              *
 * ========================================================================== */

/** Footstep, grass: tiny soft puff. */
registerSfx('step-grass', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.05, peak: 0.05, a: 0.006, pink: true, f0: 750, f1: 350, rel: 0.028 })
})

/** Footstep, cobble: dry little knock. */
registerSfx('step-cobble', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.03, peak: 0.055, f0: 1500, f1: 600, rel: 0.018 })
  tone(ctx, bus, vel, pitch, { f0: 190, f1: 120, dur: 0.035, peak: 0.035, rel: 0.018 })
})

/** Footstep, sand: longer shuffling shhh. */
registerSfx('step-sand', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.09, peak: 0.045, a: 0.015, f0: 1000, f1: 450, rel: 0.045 })
})

/** Footstep, snow: two-stage crunch. */
registerSfx('step-snow', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.03, peak: 0.05, f0: 1300, f1: 700, rel: 0.016 })
  hiss(ctx, bus, vel, pitch, { at: 0.035, dur: 0.045, peak: 0.04, f0: 900, f1: 420, rel: 0.025 })
})

/** Waystone attune: mystical two-tone hum + sparkles. */
registerSfx('waystone-attune', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 220, dur: 0.8, peak: 0.1, a: 0.2, vib: { freq: 5.5, depth: 4 }, rel: 0.25 })
  tone(ctx, bus, vel, pitch, { f0: 331, dur: 0.75, peak: 0.08, a: 0.25, vib: { freq: 5.5, depth: 5 }, rel: 0.25 })
  const sparkle = [1319, 1760, 2217]
  sparkle.forEach((f, i) => {
    tone(ctx, bus, vel, pitch, { at: 0.32 + i * 0.14, f0: f, dur: 0.07, peak: 0.07, a: 0.004, rel: 0.05 })
  })
})

/** Chest / loot pickup: bright upward triad flourish. */
registerSfx('loot-pickup', (ctx, bus, { vel, pitch }) => {
  const notes = [660, 880, 1320]
  notes.forEach((f, i) => {
    tone(ctx, bus, vel, pitch, { at: i * 0.05, type: 'triangle', f0: f, dur: 0.07, peak: 0.15, a: 0.004, rel: 0.045 })
  })
})

/** Item equip: satisfying wooden clack. */
registerSfx('equip-clack', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'square', f0: 480, f1: 290, dur: 0.045, peak: 0.12, a: 0.002, lp: 1600, rel: 0.022 })
  tick(ctx, bus, vel, 2600, 0.004, 0.08)
  tone(ctx, bus, vel, pitch, { f0: 160, f1: 110, dur: 0.05, peak: 0.08, rel: 0.025 })
})

/** Panel/door open: rising gliss. */
registerSfx('ui-open', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 330, f1: 520, dur: 0.1, peak: 0.1, a: 0.008, rel: 0.045 })
})

/** Panel/door close: falling gliss. */
registerSfx('ui-close', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 520, f1: 330, dur: 0.1, peak: 0.09, a: 0.008, rel: 0.045 })
})

/* ========================================================================== *
 *  PETS                                                                      *
 * ========================================================================== */

/** Happy pet chirp: two rising tweets. */
registerSfx('pet-chirp', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 950, f1: 1450, dur: 0.07, peak: 0.12, a: 0.005, rel: 0.035 })
  tone(ctx, bus, vel, pitch, { at: 0.1, f0: 1150, f1: 1750, dur: 0.08, peak: 0.12, a: 0.005, rel: 0.04 })
})

/** Cowering whimper: drooping wobble. */
registerSfx('pet-whimper', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, {
    type: 'triangle', f0: 720, f1: 340, dur: 0.3, peak: 0.09, a: 0.02,
    vib: { freq: 9, depth: 26 }, rel: 0.1
  })
})

/** Pet attack nip: tiny snap. */
registerSfx('pet-nip', (ctx, bus, { vel, pitch }) => {
  tick(ctx, bus, vel, 2900, 0, 0.12)
  tone(ctx, bus, vel, pitch, { type: 'square', f0: 520, f1: 380, dur: 0.04, peak: 0.1, a: 0.002, lp: 1800, rel: 0.02 })
})

/* ========================================================================== *
 *  ECONOMY / UI                                                              *
 * ========================================================================== */

/** GOLD-rail purchase: coin-register ka-ching. */
registerSfx('cha-ching-coin', (ctx, bus, { vel, pitch }) => {
  tick(ctx, bus, vel, 3200, 0, 0.1)
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 523, dur: 0.07, peak: 0.13, a: 0.003, rel: 0.04 })
  tone(ctx, bus, vel, pitch, { at: 0.07, type: 'triangle', f0: 659, dur: 0.07, peak: 0.13, a: 0.003, rel: 0.04 })
  tone(ctx, bus, vel, pitch, { at: 0.15, type: 'triangle', f0: 784, dur: 0.14, peak: 0.15, a: 0.003, rel: 0.08 })
})

/** Crypto-rail purchase: two-note FM-ish bell chime. */
registerSfx('cha-ching-chime', (ctx, bus, { vel, pitch }) => {
  for (const [at, f] of [[0, 1319], [0.12, 1976]] as const) {
    tone(ctx, bus, vel, pitch, { at, f0: f, dur: 0.22, peak: 0.12, a: 0.004, rel: 0.12 })
    tone(ctx, bus, vel, pitch, { at, f0: f * 2.76, dur: 0.1, peak: 0.04, a: 0.004, rel: 0.05 })
  }
})

/** NFT mint: official stamp thump + mechanical click + confirm blip. */
registerSfx('mint-stamp', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 130, f1: 58, dur: 0.1, peak: 0.26, rel: 0.05 })
  tick(ctx, bus, vel, 2200, 0.015, 0.14)
  tone(ctx, bus, vel, pitch, { at: 0.16, f0: 880, dur: 0.09, peak: 0.1, a: 0.004, rel: 0.05 })
})

/** Marketplace listing posted: paper swish + pin tack. */
registerSfx('listing-posted', (ctx, bus, { vel, pitch }) => {
  hiss(ctx, bus, vel, pitch, { dur: 0.14, peak: 0.08, a: 0.02, type: 'highpass', f0: 900, f1: 3200, rel: 0.05 })
  tick(ctx, bus, vel, 2700, 0.16, 0.12)
})

/** Gentle error buzz: polite "nope", never harsh. */
registerSfx('error-buzz', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'square', f0: 185, dur: 0.09, peak: 0.07, a: 0.008, lp: 650, rel: 0.035 })
  tone(ctx, bus, vel, pitch, { at: 0.12, type: 'square', f0: 165, dur: 0.11, peak: 0.07, a: 0.008, lp: 650, rel: 0.045 })
})

/** Soft UI tick (buttons, sliders, chat send) — AudioManager.tick() plays this. */
registerSfx('ui-tick', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { type: 'triangle', f0: 660, f1: 400, dur: 0.09, peak: 0.16, a: 0.012, rel: 0.04 })
})

/** Chat message pop: tiny bubble. */
registerSfx('chat-pop', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 620, f1: 940, dur: 0.045, peak: 0.1, a: 0.004, rel: 0.025 })
})

/** Level-up roll: ascending pentatonic run + shimmer (pairs with the stinger). */
registerSfx('level-up', (ctx, bus, { vel, pitch }) => {
  const run = [523, 659, 784, 1047, 1319]
  run.forEach((f, i) => {
    tone(ctx, bus, vel, pitch, { at: i * 0.085, type: 'triangle', f0: f, dur: 0.1, peak: 0.14, a: 0.004, rel: 0.06 })
  })
  hiss(ctx, bus, vel, pitch, { at: 0.34, dur: 0.3, peak: 0.05, a: 0.05, type: 'highpass', f0: 3800, rel: 0.14 })
})

/** Coin / generic pickup: two quick ascending blips with a sparkle tail. */
registerSfx('coin', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 987.77, dur: 0.05, peak: 0.2, a: 0.008, rel: 0.05 })
  tone(ctx, bus, vel, pitch, { at: 0.07, f0: 1318.5, dur: 0.06, peak: 0.2, a: 0.008, rel: 0.06 })
})

/** Generic heavy thud (falls, body drops). */
registerSfx('thud', (ctx, bus, { vel, pitch }) => {
  tone(ctx, bus, vel, pitch, { f0: 140, f1: 48, dur: 0.12, peak: 0.36, rel: 0.06 })
  hiss(ctx, bus, vel, pitch, { dur: 0.08, peak: 0.22, f0: 900, f1: 250, rel: 0.045 })
})
