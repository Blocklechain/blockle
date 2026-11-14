/**
 * Blocklings — songbook registry + demo jingle.
 *
 * Content agents register their zone/combat/menu songs here with
 * `registerSong(song)` and play them via `audio.playSong(id)`. The demo
 * jingle below proves the sequencer end-to-end and doubles as the default
 * menu music until the real soundtrack lands — replace by registering real
 * songs and pointing playSong at them.
 */
import type { Song, SongNote, SongTrack } from './sequencer'

const songs = new Map<string, Song>()

export function registerSong(song: Song): void {
  if (songs.has(song.id)) console.warn(`[audio] song "${song.id}" re-registered`)
  songs.set(song.id, song)
}

export function getSong(id: string): Song | undefined {
  return songs.get(id)
}

export function songIds(): string[] {
  return [...songs.keys()]
}

// ---------------------------------------------------------------------------
// Demo: 8-bar test jingle (A minor, 116 BPM, light swing). WILL BE REPLACED.
// ---------------------------------------------------------------------------

export const DEMO_SONG_ID = 'demo-jingle'

function demoSong(): Song {
  // Chord roots per bar: Am F C G | Am F G Am
  const roots = [45, 41, 48, 43, 45, 41, 43, 45] // A2 F2 C3 G2 ...

  const bassNotes: SongNote[] = []
  roots.forEach((r, bar) => {
    bassNotes.push([bar * 4, r, 1.6, 0.9], [bar * 4 + 2, r, 1.6, 0.75])
  })

  const melody: SongNote[] = [
    // bar 1 (Am)
    [0, 69, 1], [1, 72, 0.5], [1.5, 74, 0.5], [2, 76, 1.5],
    // bar 2 (F)
    [4, 72, 1], [5, 69, 0.5], [5.5, 67, 0.5], [6, 69, 2],
    // bar 3 (C)
    [8, 67, 1], [9, 64, 0.5], [9.5, 67, 0.5], [10, 72, 1.5],
    // bar 4 (G)
    [12, 71, 1], [13, 74, 0.5], [13.5, 71, 0.5], [14, 67, 2],
    // bar 5 (Am)
    [16, 76, 1], [17, 74, 0.5], [17.5, 72, 0.5], [18, 69, 1.5],
    // bar 6 (F)
    [20, 65, 1], [21, 69, 0.5], [21.5, 72, 0.5], [22, 74, 2],
    // bar 7 (G)
    [24, 76, 0.5], [24.5, 74, 0.5], [25, 71, 1], [26, 67, 1.5],
    // bar 8 (Am)
    [28, 69, 2.5], [31.5, 64, 0.5, 0.6]
  ]

  const bells: SongNote[] = [
    [8, 84, 2, 0.45],
    [24, 83, 2, 0.45]
  ]

  const kickNotes: SongNote[] = []
  const snareNotes: SongNote[] = []
  const hatNotes: SongNote[] = []
  for (let bar = 0; bar < 8; bar++) {
    const b = bar * 4
    kickNotes.push([b, 36, 0.2, 1], [b + 2, 36, 0.2, 0.8])
    snareNotes.push([b + 1, 38, 0.2, 0.55], [b + 3, 38, 0.2, 0.7])
    for (let e = 0; e < 8; e++) {
      hatNotes.push([b + e * 0.5, 42, 0.1, e % 2 === 0 ? 0.35 : 0.55])
    }
  }

  const tracks: SongTrack[] = [
    { inst: 'pulse25', vol: 0.8, notes: melody },
    { inst: 'bass', vol: 0.9, notes: bassNotes },
    { inst: 'bell', vol: 0.5, notes: bells },
    { inst: 'kick', vol: 0.85, notes: kickNotes },
    { inst: 'snare', vol: 0.6, notes: snareNotes },
    { inst: 'hat', vol: 0.5, notes: hatNotes }
  ]

  return { id: DEMO_SONG_ID, bpm: 116, loopBeats: 32, swing: 0.12, tracks }
}

registerSong(demoSong())
