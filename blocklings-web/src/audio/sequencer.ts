/**
 * Blocklings — lookahead music sequencer.
 *
 * Plays `Song` objects through the instrument bank with a 25ms scheduler tick
 * and a 120ms scheduling horizon, loops seamlessly, crossfades between songs,
 * and supports beat-aligned overlay layers (e.g. a combat drum track) on top
 * of the playing song.
 *
 * The engine owns the single MusicPlayer instance; content modules talk to it
 * via `audio.playSong` / `audio.stopMusic` / `audio.addLayer`.
 */
import { getInstrument } from './instruments'
import type { Instrument } from './instruments'

/** [beat, midi, durBeats, vel?] — beat 0 = loop start, vel defaults to 0.8. */
export type SongNote = [beat: number, midi: number, durBeats: number, vel?: number]

export interface SongTrack {
  /** Instrument name from the instrument registry. */
  inst: string
  /** Track gain 0..1 (default 1). */
  vol?: number
  notes: SongNote[]
}

export interface Song {
  id: string
  bpm: number
  /** Loop length in beats; the song repeats seamlessly every loopBeats. */
  loopBeats: number
  /**
   * 0..~0.4: off-beat eighth notes (beat fraction .5) are delayed by
   * swing * half a beat.
   */
  swing?: number
  tracks: SongTrack[]
}

const TICK_MS = 25
const HORIZON_S = 0.12
/** Max notes scheduled per cursor per tick (hidden-tab catch-up guard). */
const MAX_PER_TICK = 256

interface Cursor {
  track: SongTrack
  inst: Instrument | null
  /** Beat-sorted copy of the track's notes. */
  notes: SongNote[]
  idx: number
  loop: number
  gain: GainNode
}

interface ActiveSong {
  song: Song
  gain: GainNode
  startTime: number
  spb: number
  cursors: Cursor[]
  layers: Map<string, Cursor>
}

export class MusicPlayer {
  private readonly ctx: AudioContext
  private readonly out: AudioNode
  private active: ActiveSong | null = null
  private timer: number | null = null

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx
    this.out = out
  }

  get currentSongId(): string | null {
    return this.active?.song.id ?? null
  }

  /** Start a song, crossfading from whatever is currently playing. */
  play(song: Song, fade = 1.2): void {
    if (this.active?.song.id === song.id) return
    const now = this.ctx.currentTime
    if (this.active) this.fadeOutAndDrop(this.active, fade)
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(1, now + Math.max(0.02, fade))
    gain.connect(this.out)
    const spb = 60 / song.bpm
    const active: ActiveSong = {
      song,
      gain,
      startTime: now + 0.08,
      spb,
      cursors: [],
      layers: new Map()
    }
    for (const tr of song.tracks) active.cursors.push(this.makeCursor(tr, gain))
    this.active = active
    this.ensureTimer()
  }

  stop(fade = 1.2): void {
    if (!this.active) return
    this.fadeOutAndDrop(this.active, fade)
    this.active = null
  }

  /**
   * Add a beat-aligned overlay track on top of the playing song.
   * Returns false when no song is playing.
   */
  addLayer(layerId: string, track: SongTrack, fade = 0.8): boolean {
    const a = this.active
    if (!a) return false
    if (a.layers.has(layerId)) return true
    const c = this.makeCursor(track, a.gain)
    const now = this.ctx.currentTime
    c.gain.gain.setValueAtTime(0.0001, now)
    c.gain.gain.linearRampToValueAtTime(track.vol ?? 1, now + Math.max(0.02, fade))
    this.fastForward(a, c, now + HORIZON_S)
    a.layers.set(layerId, c)
    return true
  }

  removeLayer(layerId: string, fade = 0.8): void {
    const a = this.active
    const c = a?.layers.get(layerId)
    if (!a || !c) return
    a.layers.delete(layerId)
    const now = this.ctx.currentTime
    c.gain.gain.cancelScheduledValues(now)
    c.gain.gain.setValueAtTime(c.gain.gain.value, now)
    c.gain.gain.linearRampToValueAtTime(0.0001, now + Math.max(0.02, fade))
    window.setTimeout(() => {
      try {
        c.gain.disconnect()
      } catch {
        /* fine */
      }
    }, (fade + 0.2) * 1000)
  }

  // -------------------------------------------------------------------------

  private makeCursor(track: SongTrack, parent: GainNode): Cursor {
    const g = this.ctx.createGain()
    g.gain.value = track.vol ?? 1
    g.connect(parent)
    const inst = getInstrument(track.inst) ?? null
    if (!inst) console.warn(`[audio] unknown instrument "${track.inst}"`)
    return {
      track,
      inst,
      notes: [...track.notes].sort((x, y) => x[0] - y[0]),
      idx: 0,
      loop: 0,
      gain: g
    }
  }

  private fadeOutAndDrop(a: ActiveSong, fade: number): void {
    const now = this.ctx.currentTime
    a.gain.gain.cancelScheduledValues(now)
    a.gain.gain.setValueAtTime(a.gain.gain.value, now)
    a.gain.gain.linearRampToValueAtTime(0.0001, now + Math.max(0.02, fade))
    window.setTimeout(() => {
      try {
        a.gain.disconnect()
      } catch {
        /* fine */
      }
    }, (fade + 0.25) * 1000)
  }

  /** Jump a cursor forward so its next note lands at or after `time`. */
  private fastForward(a: ActiveSong, c: Cursor, time: number): void {
    if (c.notes.length === 0) return
    const beatNow = Math.max(0, (time - a.startTime) / a.spb)
    c.loop = Math.floor(beatNow / a.song.loopBeats)
    const local = beatNow - c.loop * a.song.loopBeats
    c.idx = 0
    while (c.idx < c.notes.length) {
      const n = c.notes[c.idx]
      if (!n || n[0] >= local) break
      c.idx++
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return
    this.timer = window.setInterval(() => this.tick(), TICK_MS)
  }

  private tick(): void {
    const a = this.active
    if (!a) {
      if (this.timer !== null) {
        clearInterval(this.timer)
        this.timer = null
      }
      return
    }
    const until = this.ctx.currentTime + HORIZON_S
    for (const c of a.cursors) this.scheduleCursor(a, c, until)
    for (const c of a.layers.values()) this.scheduleCursor(a, c, until)
  }

  private scheduleCursor(a: ActiveSong, c: Cursor, until: number): void {
    if (c.notes.length === 0 || !c.inst) return
    const now = this.ctx.currentTime
    const swing = a.song.swing ?? 0
    for (let guard = 0; guard < MAX_PER_TICK; guard++) {
      if (c.idx >= c.notes.length) {
        c.idx = 0
        c.loop++
      }
      const n = c.notes[c.idx]
      if (!n) return
      let beat = n[0]
      const frac = beat - Math.floor(beat)
      if (swing > 0 && Math.abs(frac - 0.5) < 1e-3) beat += swing * 0.5
      const t = a.startTime + (c.loop * a.song.loopBeats + beat) * a.spb
      if (t > until) return
      c.idx++
      if (t < now - 1) {
        // Way behind (tab was hidden): jump to the present instead of
        // replaying the gap.
        this.fastForward(a, c, now)
        continue
      }
      if (t < now - 0.03) continue // narrowly missed — drop the note
      c.inst(this.ctx, c.gain, {
        midi: n[1],
        t: Math.max(t, now + 0.002),
        dur: Math.max(0.03, n[2] * a.spb),
        vel: n[3] ?? 0.8
      })
    }
  }
}
