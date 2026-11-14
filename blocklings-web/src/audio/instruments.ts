/**
 * Blocklings — synthesized instrument bank (chiptune / 8-bit-orchestral hybrid).
 *
 * Every instrument is a pure trigger function: it builds a short-lived WebAudio
 * node graph into the given bus, schedules its envelope at an absolute context
 * time, and cleans itself up when the longest source ends. No instrument holds
 * state between notes, so the sequencer can fire them freely.
 *
 * Content agents: use `registerInstrument(name, fn)` to add new voices, and
 * `getInstrument(name)` / `instrumentNames()` to look them up. Shared helpers
 * (`midiToFreq`, `whiteNoiseBuffer`, `pinkNoiseBuffer`) are exported for SFX
 * and ambient recipes too.
 */

/** One scheduled note. `t` is an absolute AudioContext time in seconds. */
export interface NoteEvent {
  midi: number
  /** Absolute AudioContext time at which the note starts. */
  t: number
  /** Note duration in seconds (release tail is added on top). */
  dur: number
  /** Velocity 0..1. */
  vel: number
}

/** An instrument: schedule one note into `bus` and clean up after yourself. */
export type Instrument = (
  ctx: BaseAudioContext,
  bus: AudioNode,
  note: NoteEvent
) => void

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Disconnect `nodes` once `src` (the longest-lived source) finishes. */
function reap(
  src: OscillatorNode | AudioBufferSourceNode,
  nodes: AudioNode[]
): void {
  src.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect()
      } catch {
        /* already disconnected */
      }
    }
  }
}

/**
 * Click-free ADSR built from ramp + two setTargetAtTime curves.
 * Returns the gain node plus the safe source-stop time.
 */
function adsrGain(
  ctx: BaseAudioContext,
  t: number,
  peak: number,
  a: number,
  d: number,
  s: number,
  noteEnd: number,
  r: number
): { g: GainNode; stop: number } {
  const g = ctx.createGain()
  const p = Math.max(0.0001, peak)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(p, t + a)
  g.gain.setTargetAtTime(Math.max(0.0001, p * s), t + a, Math.max(0.005, d * 0.4))
  const rel = Math.max(t + a, noteEnd)
  g.gain.setTargetAtTime(0.0001, rel, Math.max(0.01, r * 0.3))
  return { g, stop: rel + Math.max(0.05, r) }
}

/** Attach a vibrato LFO (in cents) to an oscillator's detune. */
function vibrato(
  ctx: BaseAudioContext,
  targets: AudioParam[],
  t: number,
  stop: number,
  hz: number,
  cents: number
): OscillatorNode {
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = hz
  const depth = ctx.createGain()
  depth.gain.value = cents
  lfo.connect(depth)
  for (const p of targets) depth.connect(p)
  lfo.start(t)
  lfo.stop(stop)
  return lfo
}

// -- cached per-context resources -------------------------------------------

const pulseCache = new WeakMap<BaseAudioContext, PeriodicWave>()

/** 25%-duty pulse wave (classic NES lead colour), cached per context. */
export function pulse25Wave(ctx: BaseAudioContext): PeriodicWave {
  let w = pulseCache.get(ctx)
  if (w) return w
  const n = 32
  const real = new Float32Array(n)
  const imag = new Float32Array(n)
  for (let k = 1; k < n; k++) {
    real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * 0.25)
  }
  w = ctx.createPeriodicWave(real, imag)
  pulseCache.set(ctx, w)
  return w
}

const whiteCache = new WeakMap<BaseAudioContext, AudioBuffer>()
const pinkCache = new WeakMap<BaseAudioContext, AudioBuffer>()

/** 1s loopable white-noise buffer, cached per context. */
export function whiteNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = whiteCache.get(ctx)
  if (b) return b
  const len = Math.floor(ctx.sampleRate)
  b = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  whiteCache.set(ctx, b)
  return b
}

/** 2s loopable pink-noise buffer (Paul Kellet filter), cached per context. */
export function pinkNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buf = pinkCache.get(ctx)
  if (buf) return buf
  const len = Math.floor(ctx.sampleRate * 2)
  buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
  }
  pinkCache.set(ctx, buf)
  return buf
}

/** One-shot noise source playing the shared buffer. */
function noiseSource(
  ctx: BaseAudioContext,
  pink = false
): AudioBufferSourceNode {
  const src = ctx.createBufferSource()
  src.buffer = pink ? pinkNoiseBuffer(ctx) : whiteNoiseBuffer(ctx)
  src.loop = true
  return src
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

interface LeadOpts {
  a?: number
  d?: number
  s?: number
  r?: number
  peak?: number
  vibHz?: number
  vibCents?: number
  lp?: number
}

/** Factory for single-oscillator chip leads with ADSR + vibrato. */
function lead(type: OscillatorType | 'pulse25', o: LeadOpts): Instrument {
  return (ctx, bus, { midi, t, dur, vel }) => {
    const osc = ctx.createOscillator()
    if (type === 'pulse25') osc.setPeriodicWave(pulse25Wave(ctx))
    else osc.type = type
    osc.frequency.value = midiToFreq(midi)
    const { g, stop } = adsrGain(
      ctx,
      t,
      (o.peak ?? 0.2) * vel,
      o.a ?? 0.012,
      o.d ?? 0.1,
      o.s ?? 0.65,
      t + dur,
      o.r ?? 0.12
    )
    const extra: AudioNode[] = []
    let out: AudioNode = g
    if (o.lp !== undefined) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = o.lp
      g.connect(lp)
      out = lp
      extra.push(lp)
    }
    osc.connect(g)
    out.connect(bus)
    const cents = o.vibCents ?? 0
    if (cents > 0) {
      extra.push(vibrato(ctx, [osc.detune], t + 0.09, stop, o.vibHz ?? 5.6, cents))
    }
    osc.start(t)
    osc.stop(stop)
    reap(osc, [g, ...extra])
  }
}

/** Triangle + sub-octave sine bass. */
const bass: Instrument = (ctx, bus, { midi, t, dur, vel }) => {
  const f = midiToFreq(midi)
  const { g, stop } = adsrGain(ctx, t, 0.3 * vel, 0.008, 0.08, 0.8, t + dur, 0.08)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 700
  const o1 = ctx.createOscillator()
  o1.type = 'triangle'
  o1.frequency.value = f
  const o2 = ctx.createOscillator()
  o2.type = 'sine'
  o2.frequency.value = f / 2
  const sub = ctx.createGain()
  sub.gain.value = 0.6
  o1.connect(g)
  o2.connect(sub)
  sub.connect(g)
  g.connect(lp)
  lp.connect(bus)
  o1.start(t)
  o2.start(t)
  o1.stop(stop)
  o2.stop(stop)
  reap(o1, [g, lp, sub])
}

/** Karplus-ish pluck: fast-decay saw through a falling lowpass. */
const pluck: Instrument = (ctx, bus, { midi, t, dur, vel }) => {
  const f = midiToFreq(midi)
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.value = f
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(0.28 * vel, t + 0.004)
  g.gain.setTargetAtTime(0.0001, t + 0.004, 0.08 + Math.min(0.2, dur * 0.1))
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.Q.value = 1.2
  lp.frequency.setValueAtTime(Math.min(9000, f * 9), t)
  lp.frequency.exponentialRampToValueAtTime(Math.max(120, f * 1.4), t + 0.22)
  osc.connect(g)
  g.connect(lp)
  lp.connect(bus)
  const stop = t + Math.min(1.2, 0.45 + dur * 0.4)
  osc.start(t)
  osc.stop(stop)
  reap(osc, [g, lp])
}

/** Two-operator FM bell. */
const bell: Instrument = (ctx, bus, { midi, t, dur, vel }) => {
  const f = midiToFreq(midi)
  const mod = ctx.createOscillator()
  mod.type = 'sine'
  mod.frequency.value = f * 3.53
  const modGain = ctx.createGain()
  modGain.gain.setValueAtTime(f * 2.2 * (0.4 + 0.6 * vel), t)
  modGain.gain.setTargetAtTime(0, t, 0.12 + dur * 0.25)
  const car = ctx.createOscillator()
  car.type = 'sine'
  car.frequency.value = f
  mod.connect(modGain)
  modGain.connect(car.frequency)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(0.25 * vel, t + 0.004)
  g.gain.setTargetAtTime(0.0001, t + 0.004, 0.22 + dur * 0.3)
  car.connect(g)
  g.connect(bus)
  const stop = t + Math.min(2.5, dur + 1.2)
  mod.start(t)
  car.start(t)
  mod.stop(stop)
  car.stop(stop)
  reap(car, [g, modGain])
}

/** Detuned-saw pad behind a lowpass; slow attack and release. */
const pad: Instrument = (ctx, bus, { midi, t, dur, vel }) => {
  const f = midiToFreq(midi)
  const a = Math.min(0.55, 0.15 + dur * 0.15)
  const { g, stop } = adsrGain(ctx, t, 0.12 * vel, a, 0.3, 0.85, t + dur, 0.9)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 1100
  lp.Q.value = 0.5
  g.connect(lp)
  lp.connect(bus)
  const oscs: OscillatorNode[] = []
  for (const det of [-8, 0, 8]) {
    const o = ctx.createOscillator()
    o.type = 'sawtooth'
    o.frequency.value = f
    o.detune.value = det
    o.connect(g)
    o.start(t)
    o.stop(stop)
    oscs.push(o)
  }
  const first = oscs[0]
  if (first) reap(first, [g, lp])
}

/** Additive drawbar organ: four harmonic sines, near-instant attack. */
const organ: Instrument = (ctx, bus, { midi, t, dur, vel }) => {
  const f = midiToFreq(midi)
  const { g, stop } = adsrGain(ctx, t, 0.16 * vel, 0.02, 0.02, 1, t + dur, 0.07)
  g.connect(bus)
  const levels: Array<[number, number]> = [
    [1, 0.7],
    [2, 0.4],
    [3, 0.25],
    [4, 0.15]
  ]
  let firstOsc: OscillatorNode | null = null
  const partials: AudioNode[] = [g]
  for (const [h, lvl] of levels) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = f * h
    const pg = ctx.createGain()
    pg.gain.value = lvl
    o.connect(pg)
    pg.connect(g)
    o.start(t)
    o.stop(stop)
    partials.push(pg)
    firstOsc ??= o
  }
  if (firstOsc) reap(firstOsc, partials)
}

/** Choir-ish: three detuned triangles, slow attack, gentle vibrato + lowpass. */
const choirish: Instrument = (ctx, bus, { midi, t, dur, vel }) => {
  const f = midiToFreq(midi)
  const a = Math.min(0.45, 0.12 + dur * 0.12)
  const { g, stop } = adsrGain(ctx, t, 0.14 * vel, a, 0.25, 0.85, t + dur, 0.55)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 2000
  g.connect(lp)
  lp.connect(bus)
  const detunes = [-10, 0, 9]
  const params: AudioParam[] = []
  const oscs: OscillatorNode[] = []
  for (const det of detunes) {
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.value = f
    o.detune.value = det
    o.connect(g)
    o.start(t)
    o.stop(stop)
    params.push(o.detune)
    oscs.push(o)
  }
  const lfo = vibrato(ctx, params, t + a, stop, 4.5, 6)
  const first = oscs[0]
  if (first) reap(first, [g, lp, lfo])
}

/** Kick: pitched-down sine thump. Pitch scales gently from midi. */
const kick: Instrument = (ctx, bus, { midi, t, vel }) => {
  const base = midiToFreq(midi)
  const f0 = clamp(base * 2.2, 80, 260)
  const f1 = Math.max(34, base * 0.6)
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(f0, t)
  osc.frequency.exponentialRampToValueAtTime(f1, t + 0.09)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(0.5 * vel, t + 0.003)
  g.gain.setTargetAtTime(0.0001, t + 0.003, 0.07)
  osc.connect(g)
  g.connect(bus)
  osc.start(t)
  osc.stop(t + 0.35)
  reap(osc, [g])
}

/** Snare: sine body + bandpassed white-noise crack. */
const snare: Instrument = (ctx, bus, { t, vel }) => {
  const body = ctx.createOscillator()
  body.type = 'sine'
  body.frequency.setValueAtTime(185, t)
  body.frequency.exponentialRampToValueAtTime(120, t + 0.06)
  const bg = ctx.createGain()
  bg.gain.setValueAtTime(0.0001, t)
  bg.gain.linearRampToValueAtTime(0.22 * vel, t + 0.003)
  bg.gain.setTargetAtTime(0.0001, t + 0.003, 0.04)
  body.connect(bg)
  bg.connect(bus)

  const noise = noiseSource(ctx)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 1400
  const ng = ctx.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.linearRampToValueAtTime(0.3 * vel, t + 0.002)
  ng.gain.setTargetAtTime(0.0001, t + 0.002, 0.055)
  noise.connect(hp)
  hp.connect(ng)
  ng.connect(bus)

  body.start(t)
  body.stop(t + 0.25)
  noise.start(t)
  noise.stop(t + 0.3)
  reap(noise, [bg, hp, ng])
}

/** Hi-hat: short highpassed noise. durBeats > ~1/4 note = open hat. */
const hat: Instrument = (ctx, bus, { t, dur, vel }) => {
  const noise = noiseSource(ctx)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 6500
  const decay = dur > 0.25 ? 0.12 : 0.022
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.002)
  g.gain.setTargetAtTime(0.0001, t + 0.002, decay)
  noise.connect(hp)
  hp.connect(g)
  g.connect(bus)
  const stop = t + decay * 6 + 0.05
  noise.start(t)
  noise.stop(stop)
  reap(noise, [hp, g])
}

/** Generic pitched noise hit: white noise through a bandpass at the note. */
const noise: Instrument = (ctx, bus, { midi, t, dur, vel }) => {
  const src = noiseSource(ctx)
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = clamp(midiToFreq(midi), 60, 12000)
  bp.Q.value = 1
  const { g, stop } = adsrGain(ctx, t, 0.25 * vel, 0.01, dur * 0.3 + 0.02, 0.5, t + dur, 0.15)
  src.connect(bp)
  bp.connect(g)
  g.connect(bus)
  src.start(t)
  src.stop(stop)
  reap(src, [bp, g])
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, Instrument>()

export function registerInstrument(name: string, inst: Instrument): void {
  registry.set(name, inst)
}

export function getInstrument(name: string): Instrument | undefined {
  return registry.get(name)
}

export function instrumentNames(): string[] {
  return [...registry.keys()]
}

registerInstrument('square', lead('square', { peak: 0.14, vibCents: 7 }))
registerInstrument('pulse25', lead('pulse25', { peak: 0.16, vibCents: 8 }))
registerInstrument(
  'triangle',
  lead('triangle', { peak: 0.22, vibCents: 6, s: 0.75 })
)
registerInstrument(
  'saw',
  lead('sawtooth', { peak: 0.13, vibCents: 7, lp: 2600 })
)
registerInstrument('bass', bass)
registerInstrument('pluck', pluck)
registerInstrument('bell', bell)
registerInstrument('pad', pad)
registerInstrument('organ', organ)
registerInstrument('choirish', choirish)
registerInstrument('kick', kick)
registerInstrument('snare', snare)
registerInstrument('hat', hat)
registerInstrument('noise', noise)
