/**
 * Blocklings — SFX recipe content.
 *
 * OWNED BY THE SFX CONTENT AGENT. Add game sounds here with
 * `registerSfx(name, recipe)`; the file is side-effect-imported by the engine
 * so registration happens automatically. Recipe contract: see SfxRecipe in
 * sfx-core.ts — compose oscillators / noise / envelopes into `bus`, scale
 * loudness by `vel`, frequencies by `pitch`, and clean up via `src.onended`.
 *
 * Three example recipes below show the pattern (ui-tick is live: the HUD's
 * button/slider tick plays it).
 */
import { registerSfx } from './sfx-core'
import { whiteNoiseBuffer } from './instruments'

/** Soft UI tick (buttons, chat send) — port of the old AudioManager.tick(). */
registerSfx('ui-tick', (ctx, bus, { vel, pitch }) => {
  const t = ctx.currentTime
  const f = 660 * pitch
  const osc = ctx.createOscillator()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(f, t)
  osc.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.09)
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(0.18 * vel, t + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
  osc.connect(env)
  env.connect(bus)
  osc.start(t)
  osc.stop(t + 0.14)
  osc.onended = () => env.disconnect()
})

/** Coin / pickup: two quick ascending sine blips with a sparkle tail. */
registerSfx('coin', (ctx, bus, { vel, pitch }) => {
  const t = ctx.currentTime
  const steps: Array<[number, number]> = [
    [0, 987.77 * pitch], // B5
    [0.07, 1318.5 * pitch] // E6
  ]
  for (const [dt, f] of steps) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = f
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t + dt)
    env.gain.linearRampToValueAtTime(0.22 * vel, t + dt + 0.008)
    env.gain.setTargetAtTime(0.0001, t + dt + 0.03, 0.06)
    osc.connect(env)
    env.connect(bus)
    osc.start(t + dt)
    osc.stop(t + dt + 0.4)
    osc.onended = () => env.disconnect()
  }
})

/** Thud / impact: pitch-dropping sine body + lowpassed noise burst. */
registerSfx('thud', (ctx, bus, { vel, pitch }) => {
  const t = ctx.currentTime
  const body = ctx.createOscillator()
  body.type = 'sine'
  body.frequency.setValueAtTime(140 * pitch, t)
  body.frequency.exponentialRampToValueAtTime(48 * pitch, t + 0.1)
  const bg = ctx.createGain()
  bg.gain.setValueAtTime(0.0001, t)
  bg.gain.linearRampToValueAtTime(0.4 * vel, t + 0.004)
  bg.gain.setTargetAtTime(0.0001, t + 0.004, 0.07)
  body.connect(bg)
  bg.connect(bus)

  const noise = ctx.createBufferSource()
  noise.buffer = whiteNoiseBuffer(ctx)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = 900 * pitch
  const ng = ctx.createGain()
  ng.gain.setValueAtTime(0.0001, t)
  ng.gain.linearRampToValueAtTime(0.25 * vel, t + 0.003)
  ng.gain.setTargetAtTime(0.0001, t + 0.003, 0.05)
  noise.connect(lp)
  lp.connect(ng)
  ng.connect(bus)

  body.start(t)
  body.stop(t + 0.4)
  noise.start(t)
  noise.stop(t + 0.35)
  noise.onended = () => {
    bg.disconnect()
    lp.disconnect()
    ng.disconnect()
  }
})
