/**
 * Blocklings — HUD audio manager (Phase 1 stub, but real).
 *
 * No audio assets yet: "music" is a gentle looping ambient pad synthesized
 * with WebAudio oscillators through a slowly-breathing lowpass filter, and
 * SFX are short synthesized UI ticks. Both run through independent gain
 * nodes so the settings sliders audibly work. Volumes persist to
 * localStorage. The AudioContext is created lazily on the first user
 * gesture (browser autoplay policy).
 */

const MUSIC_KEY = 'blocklings.vol.music'
const SFX_KEY = 'blocklings.vol.sfx'

/** Pad loudness at music volume 1.0 — deliberately gentle. */
const PAD_CEILING = 0.22

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function loadVol(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? clamp01(n) : fallback
  } catch {
    return fallback
  }
}

function saveVol(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v))
  } catch {
    /* storage unavailable (private mode) — volume still works this session */
  }
}

export class AudioManager {
  private ctx: AudioContext | null = null
  private musicGain: GainNode | null = null
  private sfxGain: GainNode | null = null

  private musicVol = loadVol(MUSIC_KEY, 0.4)
  private sfxVol = loadVol(SFX_KEY, 0.7)

  constructor() {
    // Lazily unlock audio on the first gesture anywhere in the page.
    const unlock = (): void => {
      this.ensureContext()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
  }

  get music(): number {
    return this.musicVol
  }

  get sfx(): number {
    return this.sfxVol
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp01(v)
    saveVol(MUSIC_KEY, this.musicVol)
    if (this.ctx && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(
        this.musicVol * PAD_CEILING,
        this.ctx.currentTime,
        0.05
      )
    }
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp01(v)
    saveVol(SFX_KEY, this.sfxVol)
    if (this.ctx && this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(this.sfxVol, this.ctx.currentTime, 0.02)
    }
  }

  /** Short, soft UI tick (button presses, chat send). */
  tick(freq = 660): void {
    const ctx = this.ensureContext()
    if (!ctx || !this.sfxGain) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.09)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.exponentialRampToValueAtTime(0.18, t + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    osc.connect(env).connect(this.sfxGain)
    osc.start(t)
    osc.stop(t + 0.14)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
    }
  }

  /**
   * Create the AudioContext + ambient pad. Safe to call repeatedly; only
   * does work once. Returns null when WebAudio is unavailable.
   */
  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return this.ctx
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return null

    const ctx = new Ctor()
    this.ctx = ctx

    this.musicGain = ctx.createGain()
    this.musicGain.gain.value = 0 // fade the pad in below
    this.musicGain.connect(ctx.destination)

    this.sfxGain = ctx.createGain()
    this.sfxGain.gain.value = this.sfxVol
    this.sfxGain.connect(ctx.destination)

    this.startPad(ctx, this.musicGain)
    // Gentle fade-in to the saved music volume.
    this.musicGain.gain.setTargetAtTime(
      this.musicVol * PAD_CEILING,
      ctx.currentTime,
      1.5
    )
    return ctx
  }

  /** Looping ambient pad: a soft A-minor-ish drone behind a breathing filter. */
  private startPad(ctx: AudioContext, out: GainNode): void {
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 480
    filter.Q.value = 0.8
    filter.connect(out)

    // Slow LFO "breathes" the filter cutoff for movement.
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 0.06
    const lfoDepth = ctx.createGain()
    lfoDepth.gain.value = 220
    lfo.connect(lfoDepth).connect(filter.frequency)
    lfo.start()

    // Pad voices: root, fifth, octave, with light detune for width.
    const voices: Array<{ freq: number; detune: number; level: number }> = [
      { freq: 110.0, detune: -5, level: 0.5 }, // A2
      { freq: 110.0, detune: +6, level: 0.5 },
      { freq: 164.81, detune: -4, level: 0.35 }, // E3
      { freq: 220.0, detune: +5, level: 0.22 } // A3
    ]
    for (const v of voices) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = v.freq
      osc.detune.value = v.detune
      const g = ctx.createGain()
      g.gain.value = v.level
      osc.connect(g).connect(filter)
      osc.start()
    }
  }
}
