/**
 * Blocklings — ambient bed content (biome + time-of-day atmosphere).
 *
 * OWNED BY THE AMBIENCE CONTENT AGENT. Every bed is 100% WebAudio-synthesized
 * (no samples): a couple of continuously-looping filtered-noise / oscillator
 * layers plus a few randomized one-shot event schedulers (bird chirps, drips,
 * frog croaks, bell tolls...). Beds are deliberately CPU-cheap — 2-6 live
 * nodes each; one-shots build tiny graphs that reap themselves on `onended`.
 *
 * Bed contract: see AmbientBed in ambient-core.ts — build looping sources
 * into `bus`, return `{ stop(t) }` that stops every continuous source (and
 * kills the event timers). Selection logic lives in ../audio/ambience.ts.
 *
 * Beds registered here:
 *   meadow_day      breeze + occasional pentatonic bird micro-motifs
 *   forest_day      denser birds + leaf rustle
 *   night_crickets  cricket trill chorus + rare owl
 *   water_edge      wave wash + lapping + gull cries
 *   mountain_wind   hollow resonant wind + rare rock tick
 *   dungeon_drip    drips + low rumble + rare chain rattle
 *   volcanic_rumble sub throb + ember crackle
 *   tundra_wind     thin whistling + snow hiss
 *   swamp_frogs     frog croak choir (comedy frequency)
 *   capital_crowd   distant murmur walla + occasional bell toll
 *   wastes_hum      eerie detuned hum + slow shimmer tones
 */
import { registerAmbient } from './ambient-core'
import { pinkNoiseBuffer, whiteNoiseBuffer } from './instruments'

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function rr(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T
}

/** Per-bed build kit: tracks continuous sources + event timers for stop(). */
interface Kit {
  /** Track a continuous source so the bed's stop() stops it. */
  keep<T extends AudioScheduledSourceNode>(src: T): T
  /**
   * Fire `fn` repeatedly at a random interval in [minS, maxS] seconds
   * (self-rescheduling setTimeout chain; cleared on bed stop).
   */
  every(minS: number, maxS: number, fn: () => void): void
}

type BedBuild = (ctx: AudioContext, bus: AudioNode, kit: Kit) => void

/** registerAmbient wrapper that provides the kit + standard stop handling. */
function defineBed(name: string, build: BedBuild): void {
  registerAmbient(name, (ctx, bus) => {
    const srcs: AudioScheduledSourceNode[] = []
    const clears: Array<() => void> = []
    const kit: Kit = {
      keep(src) {
        srcs.push(src)
        return src
      },
      every(minS, maxS, fn) {
        let id = 0
        let dead = false
        const arm = (): void => {
          id = window.setTimeout(() => {
            if (dead) return
            try {
              fn()
            } catch {
              /* a one-shot failing must not kill the scheduler */
            }
            arm()
          }, rr(minS, maxS) * 1000)
        }
        arm()
        clears.push(() => {
          dead = true
          window.clearTimeout(id)
        })
      }
    }
    build(ctx, bus, kit)
    return {
      stop(t: number): void {
        for (const clear of clears) clear()
        for (const s of srcs) {
          try {
            s.stop(t)
          } catch {
            /* already stopped */
          }
        }
      }
    }
  })
}

/** Disconnect a one-shot's node chain once its longest source ends. */
function reap(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  src.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect()
      } catch {
        /* fine */
      }
    }
  }
}

/**
 * Continuous looping noise layer: noise → biquad filter → gain → bus.
 * Optional LFO wobbles either the filter frequency or the layer gain.
 */
function noiseLayer(
  ctx: AudioContext,
  bus: AudioNode,
  kit: Kit,
  opts: {
    white?: boolean
    type: BiquadFilterType
    freq: number
    q?: number
    gain: number
    lfoHz?: number
    lfoDepth?: number
    lfoTarget?: 'freq' | 'gain'
  }
): GainNode {
  const src = kit.keep(ctx.createBufferSource())
  src.buffer = opts.white ? whiteNoiseBuffer(ctx) : pinkNoiseBuffer(ctx)
  src.loop = true
  const f = ctx.createBiquadFilter()
  f.type = opts.type
  f.frequency.value = opts.freq
  f.Q.value = opts.q ?? 0.8
  const g = ctx.createGain()
  g.gain.value = opts.gain
  src.connect(f)
  f.connect(g)
  g.connect(bus)
  if (opts.lfoHz !== undefined && opts.lfoDepth !== undefined) {
    const lfo = kit.keep(ctx.createOscillator())
    lfo.type = 'sine'
    lfo.frequency.value = opts.lfoHz
    const depth = ctx.createGain()
    depth.gain.value = opts.lfoDepth
    lfo.connect(depth)
    depth.connect(opts.lfoTarget === 'gain' ? g.gain : f.frequency)
    lfo.start()
  }
  src.start()
  return g
}

/** One-shot band-passed noise burst (rustle / lap / crackle / tick). */
function noiseBurst(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  opts: {
    white?: boolean
    freq: number
    q?: number
    attack: number
    dur: number
    vol: number
  }
): void {
  const src = ctx.createBufferSource()
  src.buffer = opts.white ? whiteNoiseBuffer(ctx) : pinkNoiseBuffer(ctx)
  src.loop = true
  const f = ctx.createBiquadFilter()
  f.type = 'bandpass'
  f.frequency.value = opts.freq
  f.Q.value = opts.q ?? 1.2
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(opts.vol, t + opts.attack)
  g.gain.setTargetAtTime(0.0001, t + opts.attack, Math.max(0.01, opts.dur * 0.35))
  src.connect(f)
  f.connect(g)
  g.connect(out)
  src.start(t)
  src.stop(t + opts.attack + opts.dur + 0.3)
  reap(src, [src, f, g])
}

/** One-shot gliding tone (drips, ticks, hoots, cries). */
function glideTone(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  opts: {
    type?: OscillatorType
    f0: number
    f1: number
    attack: number
    dur: number
    vol: number
    vibHz?: number
    vibCents?: number
    lowpass?: number
  }
): void {
  const osc = ctx.createOscillator()
  osc.type = opts.type ?? 'sine'
  osc.frequency.setValueAtTime(Math.max(1, opts.f0), t)
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.f1), t + opts.dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(opts.vol, t + opts.attack)
  g.gain.setTargetAtTime(0.0001, t + Math.max(opts.attack, opts.dur * 0.6), Math.max(0.01, opts.dur * 0.25))
  const chain: AudioNode[] = [osc, g]
  let head: AudioNode = osc
  if (opts.lowpass !== undefined) {
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = opts.lowpass
    head.connect(lp)
    head = lp
    chain.push(lp)
  }
  head.connect(g)
  g.connect(out)
  // Long swells need a proportionally long tail before the hard stop.
  const stop = t + opts.dur + Math.max(0.5, opts.dur)
  if (opts.vibHz !== undefined && opts.vibCents !== undefined) {
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = opts.vibHz
    const depth = ctx.createGain()
    depth.gain.value = opts.vibCents
    lfo.connect(depth)
    depth.connect(osc.detune)
    lfo.start(t)
    lfo.stop(stop)
    chain.push(lfo, depth)
  }
  osc.start(t)
  osc.stop(stop)
  reap(osc, chain)
}

// ---------------------------------------------------------------------------
// One-shot voices shared by several beds
// ---------------------------------------------------------------------------

/** Pentatonic frequencies for bird motifs (A-major-ish pentatonic, 5th-6th octave). */
const BIRD_FREQS = [1760, 1976, 2217, 2637, 2960, 3520] as const

/** A 2-4 note randomized pentatonic bird micro-motif. */
function birdMotif(ctx: AudioContext, out: AudioNode, vol: number): void {
  const t0 = ctx.currentTime + 0.02
  const notes = 2 + Math.floor(Math.random() * 3)
  let t = t0
  for (let i = 0; i < notes; i++) {
    const f = pick(BIRD_FREQS) * rr(0.98, 1.02)
    const up = Math.random() < 0.5
    const dur = rr(0.06, 0.13)
    glideTone(ctx, out, t, {
      f0: up ? f * 0.82 : f * 1.16,
      f1: f,
      attack: 0.015,
      dur,
      vol: vol * rr(0.7, 1),
      vibHz: 24,
      vibCents: 30
    })
    t += dur + rr(0.03, 0.09)
  }
}

/** Seagull: a wavery descending cry (sometimes doubled). */
function gullCry(ctx: AudioContext, out: AudioNode): void {
  const cries = Math.random() < 0.4 ? 2 : 1
  let t = ctx.currentTime + 0.02
  for (let i = 0; i < cries; i++) {
    const f = rr(1150, 1450)
    glideTone(ctx, out, t, {
      f0: f,
      f1: f * rr(0.55, 0.65),
      attack: 0.08,
      dur: rr(0.4, 0.65),
      vol: 0.05,
      vibHz: 7,
      vibCents: 70,
      lowpass: 2600
    })
    t += rr(0.5, 0.8)
  }
}

/** Owl: two soft low hoos. */
function owlHoot(ctx: AudioContext, out: AudioNode): void {
  let t = ctx.currentTime + 0.02
  for (let i = 0; i < 2; i++) {
    glideTone(ctx, out, t, {
      f0: 340,
      f1: 295,
      attack: 0.06,
      dur: i === 0 ? 0.22 : 0.38,
      vol: 0.05,
      lowpass: 700
    })
    t += 0.42
  }
}

/** Frog croak: AM-gated lowpassed saw. `big` = the comedy burp variant. */
function frogCroak(ctx: AudioContext, out: AudioNode, big: boolean): void {
  const t = ctx.currentTime + 0.02
  const f0 = big ? rr(120, 150) : rr(85, 170)
  const dur = big ? rr(0.5, 0.8) : rr(0.16, 0.34)
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(f0, t)
  osc.frequency.exponentialRampToValueAtTime(f0 * (big ? 0.55 : 0.82), t + dur)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = big ? 650 : 900
  lp.Q.value = 2
  // Croak "ribbit" texture: amplitude gate wobbling at ~20Hz.
  const am = ctx.createGain()
  am.gain.value = 0.5
  const trill = ctx.createOscillator()
  trill.type = 'sine'
  trill.frequency.value = rr(16, 24)
  const trillDepth = ctx.createGain()
  trillDepth.gain.value = 0.45
  trill.connect(trillDepth)
  trillDepth.connect(am.gain)
  const g = ctx.createGain()
  const vol = big ? 0.085 : 0.06
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(vol, t + 0.04)
  g.gain.setTargetAtTime(0.0001, t + dur, 0.05)
  osc.connect(lp)
  lp.connect(am)
  am.connect(g)
  g.connect(out)
  const stop = t + dur + 0.4
  osc.start(t)
  osc.stop(stop)
  trill.start(t)
  trill.stop(stop)
  reap(osc, [osc, lp, am, g, trill, trillDepth])
}

/** Distant bell toll: three decaying inharmonic partials. */
function bellToll(ctx: AudioContext, out: AudioNode, base: number): void {
  const t = ctx.currentTime + 0.02
  const partials: Array<[number, number]> = [
    [1, 0.05],
    [2.42, 0.02],
    [3.95, 0.01]
  ]
  for (const [ratio, vol] of partials) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = base * ratio * rr(0.998, 1.002)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.015)
    g.gain.setTargetAtTime(0.0001, t + 0.015, 0.7 / ratio)
    osc.connect(g)
    g.connect(out)
    osc.start(t)
    osc.stop(t + 3.5)
    reap(osc, [osc, g])
  }
}

/** A continuous cricket voice: carrier + trill AM + burst gate. */
function cricketVoice(ctx: AudioContext, bus: AudioNode, kit: Kit): void {
  const osc = kit.keep(ctx.createOscillator())
  osc.type = 'sine'
  osc.frequency.value = rr(4100, 4900)
  // Trill: fast AM so the tone reads as "chirp-chirp" texture.
  const am = ctx.createGain()
  am.gain.value = 0.5
  const trill = kit.keep(ctx.createOscillator())
  trill.type = 'square'
  trill.frequency.value = rr(22, 30)
  const trillDepth = ctx.createGain()
  trillDepth.gain.value = 0.5
  trill.connect(trillDepth)
  trillDepth.connect(am.gain)
  // Burst gate: opens for short chirping phrases, rests between.
  const gate = ctx.createGain()
  gate.gain.value = 0.0001
  const vol = rr(0.016, 0.028)
  kit.every(0.7, 2.6, () => {
    const t = ctx.currentTime
    const hold = rr(0.25, 0.9)
    gate.gain.cancelScheduledValues(t)
    gate.gain.setValueAtTime(0.0001, t)
    gate.gain.linearRampToValueAtTime(vol, t + 0.05)
    gate.gain.setValueAtTime(vol, t + 0.05 + hold)
    gate.gain.linearRampToValueAtTime(0.0001, t + 0.05 + hold + 0.08)
  })
  osc.connect(am)
  am.connect(gate)
  gate.connect(bus)
  osc.start()
  trill.start()
}

// ---------------------------------------------------------------------------
// The beds
// ---------------------------------------------------------------------------

/** meadow_day — soft breeze + occasional pentatonic bird micro-motifs. */
defineBed('meadow_day', (ctx, bus, kit) => {
  noiseLayer(ctx, bus, kit, {
    type: 'lowpass',
    freq: 420,
    gain: 0.4,
    lfoHz: 0.07,
    lfoDepth: 220,
    lfoTarget: 'freq'
  })
  kit.every(3, 9, () => birdMotif(ctx, bus, 0.035))
})

/** forest_day — hushed wind, denser birds, leaf rustle. */
defineBed('forest_day', (ctx, bus, kit) => {
  noiseLayer(ctx, bus, kit, {
    type: 'lowpass',
    freq: 360,
    gain: 0.32,
    lfoHz: 0.09,
    lfoDepth: 160,
    lfoTarget: 'freq'
  })
  // Two overlapping bird schedulers = a busier canopy.
  kit.every(1.6, 5, () => birdMotif(ctx, bus, 0.035))
  kit.every(2.5, 7, () => birdMotif(ctx, bus, 0.025))
  kit.every(4, 10, () =>
    noiseBurst(ctx, bus, ctx.currentTime + 0.02, {
      white: true,
      freq: rr(2600, 3600),
      q: 0.9,
      attack: rr(0.15, 0.3),
      dur: rr(0.8, 1.4),
      vol: 0.03
    })
  )
})

/** night_crickets — cricket trill chorus + the rare owl. */
defineBed('night_crickets', (ctx, bus, kit) => {
  // Barely-there night air so silence between chirps isn't dead.
  noiseLayer(ctx, bus, kit, {
    type: 'lowpass',
    freq: 260,
    gain: 0.12,
    lfoHz: 0.05,
    lfoDepth: 0.05,
    lfoTarget: 'gain'
  })
  cricketVoice(ctx, bus, kit)
  cricketVoice(ctx, bus, kit)
  cricketVoice(ctx, bus, kit)
  kit.every(16, 42, () => owlHoot(ctx, bus))
})

/** water_edge — wave wash + lapping + gull cries. */
defineBed('water_edge', (ctx, bus, kit) => {
  // Deep slow wash: gain LFO swells the whole water body.
  noiseLayer(ctx, bus, kit, {
    type: 'lowpass',
    freq: 520,
    gain: 0.32,
    lfoHz: 0.11,
    lfoDepth: 0.16,
    lfoTarget: 'gain'
  })
  kit.every(2, 5, () =>
    noiseBurst(ctx, bus, ctx.currentTime + 0.02, {
      freq: rr(420, 820),
      q: 0.8,
      attack: rr(0.12, 0.25),
      dur: rr(0.6, 1.1),
      vol: rr(0.05, 0.09)
    })
  )
  kit.every(9, 26, () => gullCry(ctx, bus))
})

/** mountain_wind — hollow resonant wind + rare rock tick. */
defineBed('mountain_wind', (ctx, bus, kit) => {
  // Hollow resonant body wandering in pitch.
  noiseLayer(ctx, bus, kit, {
    type: 'bandpass',
    freq: 480,
    q: 4.5,
    gain: 0.4,
    lfoHz: 0.05,
    lfoDepth: 220,
    lfoTarget: 'freq'
  })
  noiseLayer(ctx, bus, kit, { type: 'lowpass', freq: 240, gain: 0.18 })
  kit.every(10, 30, () => {
    const t = ctx.currentTime + 0.02
    glideTone(ctx, bus, t, { f0: rr(1500, 2100), f1: 300, attack: 0.004, dur: 0.06, vol: 0.05 })
    noiseBurst(ctx, bus, t + 0.03, { freq: 300, q: 1.5, attack: 0.005, dur: 0.18, vol: 0.05 })
  })
})

/** dungeon_drip — drips + low rumble + rare chain rattle. */
defineBed('dungeon_drip', (ctx, bus, kit) => {
  noiseLayer(ctx, bus, kit, {
    type: 'lowpass',
    freq: 110,
    gain: 0.4,
    lfoHz: 0.06,
    lfoDepth: 0.14,
    lfoTarget: 'gain'
  })
  kit.every(1.4, 5.5, () => {
    const t = ctx.currentTime + 0.02
    const f = rr(1400, 2600)
    glideTone(ctx, bus, t, { f0: f, f1: f * 0.5, attack: 0.004, dur: 0.1, vol: 0.06 })
    // Faint cavern echo of the same drip.
    glideTone(ctx, bus, t + 0.17, { f0: f * 0.98, f1: f * 0.5, attack: 0.01, dur: 0.12, vol: 0.022 })
  })
  kit.every(22, 50, () => {
    let t = ctx.currentTime + 0.02
    const ticks = 6 + Math.floor(Math.random() * 5)
    for (let i = 0; i < ticks; i++) {
      noiseBurst(ctx, bus, t, {
        white: true,
        freq: rr(2300, 3100),
        q: 8,
        attack: 0.002,
        dur: 0.05,
        vol: 0.04
      })
      t += rr(0.03, 0.09)
    }
  })
})

/** volcanic_rumble — sub throb + deep rumble + ember crackle. */
defineBed('volcanic_rumble', (ctx, bus, kit) => {
  const sub = kit.keep(ctx.createOscillator())
  sub.type = 'sine'
  sub.frequency.value = 38
  const subGain = ctx.createGain()
  subGain.gain.value = 0.22
  const throb = kit.keep(ctx.createOscillator())
  throb.type = 'sine'
  throb.frequency.value = 0.13
  const throbDepth = ctx.createGain()
  throbDepth.gain.value = 0.1
  throb.connect(throbDepth)
  throbDepth.connect(subGain.gain)
  sub.connect(subGain)
  subGain.connect(bus)
  sub.start()
  throb.start()
  noiseLayer(ctx, bus, kit, { type: 'lowpass', freq: 90, gain: 0.35 })
  // Ember crackle: clusters of tiny bright ticks.
  kit.every(0.18, 0.9, () => {
    const n = 1 + Math.floor(Math.random() * 3)
    let t = ctx.currentTime + 0.01
    for (let i = 0; i < n; i++) {
      noiseBurst(ctx, bus, t, {
        white: true,
        freq: rr(1800, 4200),
        q: 6,
        attack: 0.002,
        dur: rr(0.02, 0.06),
        vol: rr(0.015, 0.04)
      })
      t += rr(0.02, 0.08)
    }
  })
})

/** tundra_wind — thin whistling + constant snow hiss. */
defineBed('tundra_wind', (ctx, bus, kit) => {
  // The thin whistle, wandering up and down.
  noiseLayer(ctx, bus, kit, {
    type: 'bandpass',
    freq: 1700,
    q: 11,
    gain: 0.22,
    lfoHz: 0.06,
    lfoDepth: 650,
    lfoTarget: 'freq'
  })
  // Snow hiss: airy top end.
  noiseLayer(ctx, bus, kit, { white: true, type: 'highpass', freq: 5600, gain: 0.05 })
  // Cold body underneath.
  noiseLayer(ctx, bus, kit, {
    type: 'lowpass',
    freq: 320,
    gain: 0.22,
    lfoHz: 0.08,
    lfoDepth: 0.09,
    lfoTarget: 'gain'
  })
})

/** swamp_frogs — frog croak choir at comedy frequency. */
defineBed('swamp_frogs', (ctx, bus, kit) => {
  // Thick wet air.
  noiseLayer(ctx, bus, kit, {
    type: 'lowpass',
    freq: 280,
    gain: 0.22,
    lfoHz: 0.07,
    lfoDepth: 0.08,
    lfoTarget: 'gain'
  })
  // Two independent frog sections keep the choir conversational.
  kit.every(0.9, 3.4, () => frogCroak(ctx, bus, false))
  kit.every(1.4, 4.5, () => frogCroak(ctx, bus, false))
  // The big one. Every swamp has one.
  kit.every(12, 30, () => frogCroak(ctx, bus, true))
})

/** capital_crowd — distant murmur walla + occasional bell toll. */
defineBed('capital_crowd', (ctx, bus, kit) => {
  // Speech-band walla body with an irregular swell (two incommensurate LFOs).
  const walla = noiseLayer(ctx, bus, kit, {
    type: 'bandpass',
    freq: 520,
    q: 1.1,
    gain: 0.3,
    lfoHz: 0.13,
    lfoDepth: 0.08,
    lfoTarget: 'gain'
  })
  const lfo2 = kit.keep(ctx.createOscillator())
  lfo2.type = 'sine'
  lfo2.frequency.value = 0.31
  const lfo2Depth = ctx.createGain()
  lfo2Depth.gain.value = 0.05
  lfo2.connect(lfo2Depth)
  lfo2Depth.connect(walla.gain)
  lfo2.start()
  // Voice burbles: short filtered swells at talking-pitch frequencies.
  kit.every(0.25, 0.9, () =>
    noiseBurst(ctx, bus, ctx.currentTime + 0.01, {
      freq: rr(280, 1100),
      q: 3,
      attack: rr(0.04, 0.1),
      dur: rr(0.12, 0.3),
      vol: rr(0.015, 0.04)
    })
  )
  // Cathedral bell, somewhere across the rooftops.
  kit.every(25, 60, () => {
    const tolls = 1 + Math.floor(Math.random() * 3)
    const base = pick([392, 440, 523])
    for (let i = 0; i < tolls; i++) {
      window.setTimeout(() => bellToll(ctx, bus, base), i * 1250)
    }
  })
})

/** wastes_hum — eerie detuned hum + slow shimmer tones. */
defineBed('wastes_hum', (ctx, bus, kit) => {
  // Detuned low pair beats slowly against itself: instant unease.
  for (const f of [108, 108.7]) {
    const osc = kit.keep(ctx.createOscillator())
    osc.type = 'sine'
    osc.frequency.value = f
    const g = ctx.createGain()
    g.gain.value = 0.05
    osc.connect(g)
    g.connect(bus)
    osc.start()
  }
  // Hollow airy band drifting around.
  noiseLayer(ctx, bus, kit, {
    type: 'bandpass',
    freq: 2300,
    q: 7,
    gain: 0.05,
    lfoHz: 0.04,
    lfoDepth: 900,
    lfoTarget: 'freq'
  })
  // Shimmer: lone tones swelling out of nowhere (diminished-ish set).
  kit.every(4, 9, () => {
    const f = pick([660, 784, 932, 1108, 1320, 1568]) * rr(0.995, 1.005)
    glideTone(ctx, bus, ctx.currentTime + 0.02, {
      f0: f,
      f1: f * rr(0.99, 1.01),
      attack: rr(1, 1.8),
      dur: rr(2.4, 3.6),
      vol: rr(0.02, 0.035),
      vibHz: 5,
      vibCents: 12
    })
  })
})
