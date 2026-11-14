/**
 * Blocklings — audio engine singleton (THE sanctioned cross-module import:
 * `import { audio } from '../audio/engine'`).
 *
 * Mixer topology:
 *
 *   music bus  ─┐
 *   sfx bus    ─┼─► master gain ─► safety compressor ─► destination
 *   ambient bus┘
 *
 * The music and sfx buses are driven by the EXISTING persisted settings
 * sliders (localStorage keys blocklings.vol.music / blocklings.vol.sfx); the
 * ambient bus rides the music slider at 0.6x. The AudioContext is created on
 * the first user gesture (autoplay policy) and resumed on visibilitychange —
 * iOS Safari suspends it when the tab backgrounds or the shell app loses
 * audio focus. Music/sfx/ambient requests made before unlock are queued and
 * applied the moment the context exists.
 */
import { MusicPlayer } from './sequencer'
import type { Song, SongTrack } from './sequencer'
import { getSong, registerSong } from './songbook'
import { playSfx } from './sfx-core'
import type { SfxOpts } from './sfx-core'
import { getAmbient } from './ambient-core'
import type { AmbientHandle } from './ambient-core'
// Content files self-register into the registries on import.
import './sfx-defs'
import './ambient-defs'

const MUSIC_KEY = 'blocklings.vol.music'
const SFX_KEY = 'blocklings.vol.sfx'

/** Headroom trims so a full mix at slider=1 stays comfortably unclipped. */
const MUSIC_TRIM = 0.6
const SFX_TRIM = 0.9
/** Ambient rides the music slider at 0.6x (plus its own trim). */
const AMBIENT_RATIO = 0.6
const AMBIENT_TRIM = 0.5

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

interface ActiveAmbient {
  id: string
  gain: GainNode
  handle: AmbientHandle
}

class AudioEngine {
  private ctx: AudioContext | null = null
  private musicBus: GainNode | null = null
  private sfxBus: GainNode | null = null
  private ambientBus: GainNode | null = null
  private player: MusicPlayer | null = null

  private musicVol = loadVol(MUSIC_KEY, 0.4)
  private sfxVol = loadVol(SFX_KEY, 0.7)

  private pendingSong: { song: Song; fade: number } | null = null
  /** Last requested ambient bed (also serves as the pre-unlock queue). */
  private ambientWanted: string | null = null
  private ambientNow: ActiveAmbient | null = null
  private unlockCbs: Array<() => void> = []

  /** `audio.sfx.play('coin', { vel, pitch, pan })` */
  readonly sfx = {
    play: (name: string, opts?: SfxOpts): void => {
      const ctx = this.ensureContext()
      if (!ctx || !this.sfxBus) return
      playSfx(ctx, this.sfxBus, name, opts)
    }
  }

  /** `audio.ambient.set('wind', { fade: 3 })` / `audio.ambient.set(null)` */
  readonly ambient = {
    set: (bedId: string | null, opts?: { fade?: number }): void => {
      this.setAmbient(bedId, opts?.fade ?? 2)
    },
    current: (): string | null => this.ambientNow?.id ?? null
  }

  constructor() {
    if (typeof window === 'undefined') return
    // Persistent gesture listeners: first gesture creates the context, later
    // ones re-resume it if iOS suspended it behind our back.
    const unlock = (): void => {
      this.ensureContext()
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
    document.addEventListener('visibilitychange', () => {
      if (
        document.visibilityState === 'visible' &&
        this.ctx &&
        this.ctx.state !== 'running'
      ) {
        void this.ctx.resume()
      }
    })
  }

  // -- volumes (persisted; the settings sliders drive these) ----------------

  get musicVolume(): number {
    return this.musicVol
  }

  get sfxVolume(): number {
    return this.sfxVol
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp01(v)
    saveVol(MUSIC_KEY, this.musicVol)
    if (!this.ctx) return
    const t = this.ctx.currentTime
    this.musicBus?.gain.setTargetAtTime(this.musicVol * MUSIC_TRIM, t, 0.05)
    this.ambientBus?.gain.setTargetAtTime(
      this.musicVol * AMBIENT_RATIO * AMBIENT_TRIM,
      t,
      0.05
    )
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp01(v)
    saveVol(SFX_KEY, this.sfxVol)
    if (!this.ctx) return
    this.sfxBus?.gain.setTargetAtTime(
      this.sfxVol * SFX_TRIM,
      this.ctx.currentTime,
      0.02
    )
  }

  // -- music ----------------------------------------------------------------

  /**
   * Play a song (by registered id, or a Song object — objects are
   * auto-registered), crossfading from the current one.
   */
  playSong(song: Song | string, opts?: { fade?: number }): void {
    const fade = opts?.fade ?? 1.2
    let resolved: Song | undefined
    if (typeof song === 'string') {
      resolved = getSong(song)
      if (!resolved) {
        console.warn(`[audio] unknown song "${song}"`)
        return
      }
    } else {
      if (!getSong(song.id)) registerSong(song)
      resolved = song
    }
    if (!this.player) {
      this.pendingSong = { song: resolved, fade }
      return
    }
    this.pendingSong = null
    this.player.play(resolved, fade)
  }

  stopMusic(fade = 1.2): void {
    this.pendingSong = null
    this.player?.stop(fade)
  }

  /** Beat-aligned overlay (e.g. combat drums). False if no song is playing. */
  addLayer(layerId: string, track: SongTrack, opts?: { fade?: number }): boolean {
    return this.player?.addLayer(layerId, track, opts?.fade ?? 0.8) ?? false
  }

  removeLayer(layerId: string, opts?: { fade?: number }): void {
    this.player?.removeLayer(layerId, opts?.fade ?? 0.8)
  }

  get currentSongId(): string | null {
    return this.player?.currentSongId ?? this.pendingSong?.song.id ?? null
  }

  // -- lifecycle ------------------------------------------------------------

  get unlocked(): boolean {
    return this.ctx !== null
  }

  /** Current AudioContext time (0 before unlock). */
  now(): number {
    return this.ctx?.currentTime ?? 0
  }

  /**
   * Run `cb` once the context exists (immediately if it already does).
   * Handy for kicking off default music/ambience without racing the gesture.
   */
  onUnlocked(cb: () => void): void {
    if (this.ctx) cb()
    else this.unlockCbs.push(cb)
  }

  /** Force-create the context — call from within a user-gesture handler. */
  unlock(): void {
    this.ensureContext()
  }

  // -------------------------------------------------------------------------

  private setAmbient(id: string | null, fade: number): void {
    this.ambientWanted = id
    const ctx = this.ctx
    const bus = this.ambientBus
    if (!ctx || !bus) return // queued; applied on unlock
    if (this.ambientNow?.id === id) return
    const now = ctx.currentTime
    if (this.ambientNow) {
      const old = this.ambientNow
      this.ambientNow = null
      old.gain.gain.cancelScheduledValues(now)
      old.gain.gain.setValueAtTime(old.gain.gain.value, now)
      old.gain.gain.linearRampToValueAtTime(0.0001, now + Math.max(0.02, fade))
      old.handle.stop(now + fade + 0.05)
      window.setTimeout(() => {
        try {
          old.gain.disconnect()
        } catch {
          /* fine */
        }
      }, (fade + 0.25) * 1000)
    }
    if (id === null) return
    const bed = getAmbient(id)
    if (!bed) {
      console.warn(`[audio] unknown ambient bed "${id}"`)
      return
    }
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.linearRampToValueAtTime(1, now + Math.max(0.02, fade))
    g.connect(bus)
    this.ambientNow = { id, gain: g, handle: bed(ctx, g) }
  }

  /** Create context + mixer once; resume if suspended. Null = no WebAudio. */
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

    const master = ctx.createGain()
    master.gain.value = 1
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -14
    limiter.knee.value = 18
    limiter.ratio.value = 5
    limiter.attack.value = 0.004
    limiter.release.value = 0.22
    master.connect(limiter)
    limiter.connect(ctx.destination)

    this.musicBus = ctx.createGain()
    this.musicBus.gain.value = this.musicVol * MUSIC_TRIM
    this.musicBus.connect(master)

    this.sfxBus = ctx.createGain()
    this.sfxBus.gain.value = this.sfxVol * SFX_TRIM
    this.sfxBus.connect(master)

    this.ambientBus = ctx.createGain()
    this.ambientBus.gain.value = this.musicVol * AMBIENT_RATIO * AMBIENT_TRIM
    this.ambientBus.connect(master)

    this.player = new MusicPlayer(ctx, this.musicBus)

    // Flush everything queued before the first gesture.
    if (this.pendingSong) {
      const { song, fade } = this.pendingSong
      this.pendingSong = null
      this.player.play(song, fade)
    }
    if (this.ambientWanted !== null) {
      const wanted = this.ambientWanted
      this.ambientWanted = null
      this.setAmbient(wanted, 2)
    }
    const cbs = this.unlockCbs
    this.unlockCbs = []
    for (const cb of cbs) cb()

    return ctx
  }
}

/** The one shared audio engine. */
export const audio = new AudioEngine()
