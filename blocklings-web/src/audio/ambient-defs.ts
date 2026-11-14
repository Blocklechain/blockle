/**
 * Blocklings — ambient bed content.
 *
 * OWNED BY THE AMBIENCE CONTENT AGENT. Add zone beds here with
 * `registerAmbient(name, bed)`; the file is side-effect-imported by the
 * engine. Bed contract: see AmbientBed in ambient-core.ts — build looping
 * sources into `bus`, return `{ stop(t) }` that stops every source.
 *
 * One example bed below shows the pattern.
 */
import { registerAmbient } from './ambient-core'
import { pinkNoiseBuffer } from './instruments'

/** Gentle wind: looped pink noise behind a slowly-breathing lowpass. */
registerAmbient('wind', (ctx, bus) => {
  const src = ctx.createBufferSource()
  src.buffer = pinkNoiseBuffer(ctx)
  src.loop = true

  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 420
  lp.Q.value = 0.7

  // Slow LFO breathes the cutoff so the wind swells and settles.
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.07
  const lfoDepth = ctx.createGain()
  lfoDepth.gain.value = 240
  lfo.connect(lfoDepth)
  lfoDepth.connect(lp.frequency)

  const level = ctx.createGain()
  level.gain.value = 0.5

  src.connect(lp)
  lp.connect(level)
  level.connect(bus)

  const t0 = ctx.currentTime
  src.start(t0)
  lfo.start(t0)

  return {
    stop(t: number): void {
      try {
        src.stop(t)
        lfo.stop(t)
      } catch {
        /* already stopped */
      }
    }
  }
})
