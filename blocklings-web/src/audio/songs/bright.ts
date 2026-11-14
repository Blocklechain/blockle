/**
 * Blocklings — "bright" songbook: the title theme plus seven sunny-zone loops.
 *
 * Eight hand-arranged chiptune/8-bit-orchestral songs (45–90s seamless loops,
 * lead + counter + bass + drums + pads where fitting). The title theme carries
 * THE 8-note Blocklings motif — scale degrees 5-1-2-3-2-1-6-5 — which is
 * quoted (transposed, re-rhythmed) in `village`, `capital` and `cherry`, and
 * happens to be fully pentatonic so it slots into `cherry` untouched.
 *
 * All songs register at module import; play with `audio.playSong(id)`.
 */
import type { Song, SongNote, SongTrack } from '../sequencer'
import { registerSong } from '../songbook'

// ---------------------------------------------------------------------------
// Note helpers
// ---------------------------------------------------------------------------

/** Copy notes shifted in time (beats) and pitch (semis), velocity scaled. */
function at(src: SongNote[], beats: number, semis = 0, velMul = 1): SongNote[] {
  return src.map((note) => {
    const [b, m, d, v] = note
    const vel = Math.min(1, (v ?? 0.8) * velMul)
    const out: SongNote = [b + beats, m + semis, d, vel]
    return out
  })
}

function cat(...parts: SongNote[][]): SongNote[] {
  return parts.flat()
}

/** All midis of a chord struck together. */
function chord(beat: number, midis: number[], dur: number, vel = 0.8): SongNote[] {
  return midis.map((m): SongNote => [beat, m, dur, vel])
}

/** One sustained chord per bar. */
function pads(
  chords: number[][],
  barBeats: number,
  dur: number,
  vel: number,
  startBar = 0
): SongNote[] {
  const out: SongNote[] = []
  chords.forEach((c, i) => out.push(...chord((startBar + i) * barBeats, c, dur, vel)))
  return out
}

/** Stamp a per-bar pattern for each root: entries [offset, semisFromRoot, dur, vel]. */
function stamp(
  roots: number[],
  barBeats: number,
  pattern: Array<[number, number, number, number]>,
  startBar = 0
): SongNote[] {
  const out: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = (startBar + bar) * barBeats
    for (const [o, s, d, v] of pattern) out.push([b + o, r + s, d, v])
  })
  return out
}

/** Repeated hit (hats, shakers): vel as a function of hit index. */
function every(
  fromBeat: number,
  toBeat: number,
  step: number,
  midi: number,
  dur: number,
  vel: (i: number) => number
): SongNote[] {
  const out: SongNote[] = []
  let i = 0
  for (let b = fromBeat; b < toBeat - 1e-6; b += step, i++) out.push([b, midi, dur, vel(i)])
  return out
}

const fill = (count: number, midi: number): number[] => new Array<number>(count).fill(midi)

// ---------------------------------------------------------------------------
// 1. TITLE — "Blocklings Theme". C major, 100 BPM, 96 beats (~57.6s).
// Warm hopeful wonder. The 8-note motif: G C D E | D C A G (5-1-2-3-2-1-6-5).
// Form: A (motif, 8 bars) — B (floating lift, 8) — A' (restated + bells, 8).
// ---------------------------------------------------------------------------

function titleSong(): Song {
  // The Blocklings motif, beats 0-7 (two bars). Quoted across the soundtrack.
  const motif: SongNote[] = [
    [0, 67, 1], [1, 72, 1], [2, 74, 1], [3, 76, 2],
    [5, 74, 0.5], [5.5, 72, 0.5], [6, 69, 1], [7, 67, 1]
  ]

  const lead: SongNote[] = cat(
    // A — bars 0-7 (C Am F G | C Am F G)
    motif,
    [
      [8, 65, 1], [9, 69, 1], [10, 72, 2],
      [12, 74, 1], [13, 71, 1], [14, 67, 2]
    ],
    at(motif, 16),
    [
      [24, 69, 0.5], [24.5, 72, 0.5], [25, 74, 1], [26, 76, 2],
      [28, 74, 1], [29, 71, 0.5], [29.5, 74, 0.5], [30, 76, 1], [31, 79, 1]
    ],
    // B — bars 8-15 (Am F C G | Am F Dm G), floaty and higher
    [
      [32, 76, 1], [33, 81, 1], [34, 79, 1], [35, 76, 1],
      [36, 77, 1.5], [37.5, 76, 0.5], [38, 74, 1], [39, 72, 1],
      [40, 76, 1], [41, 72, 1], [42, 67, 1], [43, 72, 1],
      [44, 74, 2], [46, 71, 1], [47, 67, 1],
      [48, 76, 1], [49, 81, 1], [50, 79, 1], [51, 76, 1],
      [52, 77, 1], [53, 79, 1], [54, 81, 2],
      [56, 77, 1], [57, 74, 1], [58, 72, 1], [59, 69, 1],
      [60, 74, 1.5], [61.5, 71, 0.5], [62, 67, 2]
    ],
    // A' — bars 16-23 (C Am F G | F G C C), motif home + cadence
    at(motif, 64),
    [
      [72, 65, 1], [73, 69, 1], [74, 72, 2],
      [76, 74, 1], [77, 71, 1], [78, 67, 2],
      [80, 69, 1], [81, 72, 1], [82, 74, 2],
      [84, 76, 1], [85, 74, 1], [86, 71, 1], [87, 74, 1],
      [88, 79, 1.5], [89.5, 76, 0.5], [90, 74, 1], [91, 76, 1],
      [92, 72, 3.5]
    ]
  )

  // Counter-melody: long chord tones, enters at B.
  const counter: SongNote[] = [
    [32, 72, 3.5], [36, 69, 3.5], [40, 67, 3.5], [44, 62, 3.5],
    [48, 72, 3.5], [52, 69, 3.5], [56, 65, 3.5], [60, 62, 3.5],
    [64, 64, 3.5], [68, 60, 3.5], [72, 60, 3.5], [76, 59, 3.5],
    [80, 60, 3.5], [84, 62, 3.5], [88, 64, 3.5], [92, 67, 3.5]
  ]

  // Chords per bar: C Am F G voicings with smooth voice leading.
  const C = [60, 64, 67]
  const Am = [60, 64, 69]
  const F = [60, 65, 69]
  const G = [59, 62, 67]
  const Dm = [62, 65, 69]
  const padChords = [
    C, Am, F, G, C, Am, F, G,
    Am, F, C, G, Am, F, Dm, G,
    C, Am, F, G, F, G, C, C
  ]
  const bassRoots = [
    48, 45, 41, 43, 48, 45, 41, 43,
    45, 41, 48, 43, 45, 41, 50, 43,
    48, 45, 41, 43, 41, 43, 48, 48
  ]

  const bells: SongNote[] = cat(
    [
      [15, 84, 0.5, 0.45], [31, 88, 0.5, 0.45],
      [47, 86, 0.5, 0.4], [63, 83, 0.5, 0.4]
    ],
    at(motif, 64, 12, 0.55), // A' motif shimmer an octave up
    [[92, 84, 1, 0.4], [93.5, 88, 1, 0.35]]
  )

  const tracks: SongTrack[] = [
    { inst: 'pulse25', vol: 0.75, notes: lead },
    { inst: 'triangle', vol: 0.5, notes: counter },
    { inst: 'pad', vol: 0.7, notes: pads(padChords, 4, 3.9, 0.7) },
    { inst: 'bass', vol: 0.85, notes: stamp(bassRoots, 4, [
      [0, 0, 1.7, 0.85], [2, 0, 0.9, 0.6], [3, 7, 0.9, 0.55]
    ]) },
    { inst: 'bell', vol: 0.5, notes: bells },
    { inst: 'kick', vol: 0.6, notes: stamp(fill(20, 36), 4, [
      [0, 0, 0.2, 0.75], [2.5, 0, 0.15, 0.45]
    ], 4) },
    { inst: 'hat', vol: 0.4, notes: every(32, 96, 0.5, 42, 0.1, (i) => (i % 2 === 0 ? 0.26 : 0.4)) }
  ]

  return { id: 'title', bpm: 100, loopBeats: 96, tracks }
}

// ---------------------------------------------------------------------------
// 2. VILLAGE — cozy home waltz. F major, 3/4 at 138 BPM, 144 beats (~62.6s).
// Oom-pah-pah bass+pluck under a triangle melody; the B section quotes the
// title motif in F (C F G A | G F D C). Form: A (16 bars) B (16) A' (16).
// ---------------------------------------------------------------------------

function villageSong(): Song {
  // A melody, bars 0-15 (F Dm Bb C | F Dm Gm C | Bb C F Dm | Gm C F F)
  const melA1: SongNote[] = [
    [0, 69, 1], [1, 72, 1], [2, 74, 1],
    [3, 74, 2], [5, 72, 1],
    [6, 70, 1], [7, 74, 1], [8, 77, 1],
    [9, 76, 2], [11, 72, 1],
    [12, 69, 1], [13, 65, 1], [14, 69, 1],
    [15, 74, 2], [17, 72, 1],
    [18, 70, 1], [19, 67, 1], [20, 70, 1],
    [21, 72, 2], [23, 64, 1, 0.6]
  ]
  const melA2: SongNote[] = [
    [24, 65, 0.5], [24.5, 67, 0.5], [25, 70, 1], [26, 74, 1],
    [27, 76, 1], [28, 74, 1], [29, 72, 1],
    [30, 69, 1], [31, 72, 1], [32, 69, 1],
    [33, 74, 2], [35, 77, 1],
    [36, 76, 1], [37, 74, 1], [38, 72, 1],
    [39, 71, 1], [40, 72, 1], [41, 74, 1],
    [42, 72, 2], [44, 69, 1],
    [45, 65, 2.5]
  ]
  // B melody, bars 16-31 (Dm Bb Gm C | Dm Bb C C | F Dm Bb C | Gm Gm C C)
  // Bars 24-27 are the title motif in F, waltz-timed.
  const melB: SongNote[] = [
    [48, 74, 2], [50, 72, 1],
    [51, 70, 2], [53, 67, 1],
    [54, 70, 1], [55, 74, 1], [56, 72, 1],
    [57, 76, 2], [59, 74, 1],
    [60, 77, 2], [62, 74, 1],
    [63, 74, 1], [64, 72, 1], [65, 70, 1],
    [66, 71, 1], [67, 72, 1], [68, 74, 1],
    [69, 76, 2], [71, 72, 1],
    // motif quote: C5 F5 G5 A5 | G5 F5 D5 C5 over F Dm Bb C
    [72, 72, 1], [73, 77, 1], [74, 79, 1],
    [75, 81, 3],
    [78, 79, 1], [79, 77, 1], [80, 74, 1],
    [81, 72, 3],
    // cadence home
    [84, 70, 1], [85, 72, 1], [86, 74, 1],
    [87, 76, 1], [88, 74, 1], [89, 71, 1],
    [90, 72, 2],
    [93, 65, 1, 0.6], [94, 67, 1, 0.65], [95, 69, 1, 0.7]
  ]
  const melody = cat(melA1, melA2, melB, at(melA1, 96), at(melA2, 96))

  const Fc = [65, 69, 72]
  const Dm = [62, 65, 69]
  const Bb = [62, 65, 70]
  const C = [60, 64, 67]
  const Gm = [62, 67, 70]
  const chordsA = [Fc, Dm, Bb, C, Fc, Dm, Gm, C, Bb, C, Fc, Dm, Gm, C, Fc, Fc]
  const chordsB = [Dm, Bb, Gm, C, Dm, Bb, C, C, Fc, Dm, Bb, C, Gm, Gm, C, C]
  const chords48 = [...chordsA, ...chordsB, ...chordsA]

  const rootsA = [41, 38, 46, 48, 41, 38, 43, 48, 46, 48, 41, 38, 43, 48, 41, 41]
  const rootsB = [38, 46, 43, 48, 38, 46, 48, 48, 41, 38, 46, 48, 43, 43, 48, 48]
  const roots48 = [...rootsA, ...rootsB, ...rootsA]

  // Oom (bass beat 0) pah-pah (pluck chords beats 1 & 2).
  const comp: SongNote[] = []
  chords48.forEach((c, bar) => {
    comp.push(...chord(bar * 3 + 1, c, 0.7, 0.5), ...chord(bar * 3 + 2, c, 0.7, 0.42))
  })

  const tracks: SongTrack[] = [
    { inst: 'triangle', vol: 0.8, notes: melody },
    { inst: 'pluck', vol: 0.7, notes: comp },
    { inst: 'bass', vol: 0.85, notes: stamp(roots48, 3, [[0, 0, 1.2, 0.8]]) },
    // A' sparkle: first A phrase doubled an octave up on bells
    { inst: 'bell', vol: 0.45, notes: at(melA1, 96, 12, 0.55) },
    { inst: 'hat', vol: 0.3, notes: stamp(fill(16, 42), 3, [
      [1, 0, 0.08, 0.3], [2, 0, 0.08, 0.22]
    ], 32) }
  ]

  return { id: 'village', bpm: 138, loopBeats: 144, tracks }
}

// ---------------------------------------------------------------------------
// 3. MEADOW — sunny stroll. G major, 112 BPM swung, 112 beats (~60s).
// Skipping pulse lead, walking bass, brushy kit. Form: A (8) B (8) A' (8)
// + 4-bar turnaround tag.
// ---------------------------------------------------------------------------

function meadowSong(): Song {
  // A, bars 0-7 (G C G D | G C D G)
  const melA: SongNote[] = [
    [0, 71, 0.5], [0.5, 74, 0.5], [1, 79, 1], [2, 78, 0.5], [2.5, 74, 0.5], [3, 71, 1],
    [4, 72, 0.5], [4.5, 76, 0.5], [5, 79, 1], [6, 81, 1], [7, 79, 0.5], [7.5, 76, 0.5],
    [8, 74, 1], [9, 71, 0.5], [9.5, 67, 0.5], [10, 71, 1.5], [11.5, 74, 0.5],
    [12, 78, 1], [13, 76, 0.5], [13.5, 74, 0.5], [14, 69, 2],
    [16, 71, 0.5], [16.5, 74, 0.5], [17, 79, 1], [18, 78, 0.5], [18.5, 74, 0.5], [19, 71, 1],
    [20, 72, 0.5], [20.5, 76, 0.5], [21, 79, 1], [22, 81, 0.5], [22.5, 84, 0.5], [23, 81, 1],
    [24, 79, 1], [25, 78, 0.5], [25.5, 74, 0.5], [26, 71, 1], [27, 69, 1],
    [28, 67, 2.5], [31, 74, 1, 0.7]
  ]
  // B, bars 8-15 (Em C G D | Em C D D)
  const melB: SongNote[] = [
    [32, 76, 1], [33, 79, 0.5], [33.5, 76, 0.5], [34, 74, 1], [35, 71, 1],
    [36, 72, 1], [37, 76, 0.5], [37.5, 79, 0.5], [38, 81, 2],
    [40, 79, 1], [41, 74, 0.5], [41.5, 71, 0.5], [42, 74, 1.5], [43.5, 76, 0.5],
    [44, 78, 1], [45, 74, 1], [46, 71, 0.5], [46.5, 69, 0.5], [47, 66, 1],
    [48, 76, 1], [49, 79, 0.5], [49.5, 76, 0.5], [50, 74, 1], [51, 71, 1],
    [52, 72, 1], [53, 76, 0.5], [53.5, 79, 0.5], [54, 81, 1.5], [55.5, 84, 0.5],
    [56, 83, 1], [57, 81, 0.5], [57.5, 78, 0.5], [58, 74, 1], [59, 71, 1],
    [60, 69, 1], [61, 71, 0.5], [61.5, 72, 0.5], [62, 74, 2]
  ]
  // Tag, bars 24-27 (C D G G)
  const melTag: SongNote[] = [
    [96, 84, 1], [97, 81, 1], [98, 79, 1], [99, 81, 1],
    [100, 79, 1], [101, 78, 1], [102, 74, 1], [103, 78, 1],
    [104, 79, 2], [106, 74, 1], [107, 71, 1],
    [108, 79, 2.5]
  ]
  const melody = cat(melA, melB, at(melA, 64), melTag)

  const rootsA = [43, 48, 43, 50, 43, 48, 50, 43]
  const rootsB = [40, 48, 43, 50, 40, 48, 50, 50]
  const rootsTag = [48, 50, 43, 43]
  const roots = [...rootsA, ...rootsB, ...rootsA, ...rootsTag]

  // Gentle pluck arps through the B section.
  const arpsB = stamp(rootsB, 4, [
    [0, 12, 0.4, 0.5], [1, 19, 0.4, 0.4], [2, 24, 0.4, 0.45], [3, 19, 0.4, 0.35]
  ], 8)

  // Organ warmth (dyads) through B.
  const organB = pads(
    [[64, 67], [60, 67], [62, 67], [62, 66], [64, 67], [60, 67], [62, 66], [62, 66]],
    4, 3.8, 0.5, 8
  )

  const tracks: SongTrack[] = [
    { inst: 'pulse25', vol: 0.75, notes: melody },
    { inst: 'pluck', vol: 0.6, notes: arpsB },
    { inst: 'organ', vol: 0.55, notes: organB },
    { inst: 'bass', vol: 0.85, notes: stamp(roots, 4, [
      [0, 0, 1.4, 0.8], [2, 0, 0.9, 0.6], [3, 7, 0.9, 0.5]
    ]) },
    { inst: 'kick', vol: 0.65, notes: stamp(fill(28, 36), 4, [
      [0, 0, 0.2, 0.7], [2.5, 0, 0.15, 0.4]
    ]) },
    { inst: 'snare', vol: 0.4, notes: cat(
      stamp(fill(8, 38), 4, [[2, 0, 0.15, 0.4]], 8),
      stamp(fill(4, 38), 4, [[2, 0, 0.15, 0.4]], 24)
    ) },
    { inst: 'hat', vol: 0.45, notes: every(0, 112, 0.5, 42, 0.1, (i) => (i % 2 === 0 ? 0.22 : 0.36)) }
  ]

  return { id: 'meadow', bpm: 112, loopBeats: 112, swing: 0.16, tracks }
}

// ---------------------------------------------------------------------------
// 4. FOREST — mysterious green, D dorian, 92 BPM, 96 beats (~62.6s).
// Open-fifth pluck arps over a D pedal, choir breathing above, a shy triangle
// voice in the last section. Form: A (8) B (8) A'+lead (8).
// ---------------------------------------------------------------------------

function forestSong(): Song {
  // Arp roots per bar: A (Dm C Dm G | Dm C G Dm), B (F G Am Am | F G C Dm), A'.
  const arpA = [50, 48, 50, 55, 50, 48, 55, 50]
  const arpB = [53, 55, 57, 57, 53, 55, 60, 50]
  const arpRoots = [...arpA, ...arpB, ...arpA]
  const arps = stamp(arpRoots, 4, [
    [0, 0, 0.45, 0.6], [0.5, 7, 0.45, 0.48], [1, 12, 0.45, 0.55], [1.5, 7, 0.45, 0.42],
    [2, 0, 0.45, 0.52], [2.5, 7, 0.45, 0.42], [3, 12, 0.45, 0.5], [3.5, 7, 0.45, 0.38]
  ])

  // Choir: slow modal sighs. B natural (dorian) colours bars 2 and 6.
  const choirA: SongNote[] = [
    [0, 69, 3.5], [4, 67, 3.5],
    [8, 71, 2], [10, 69, 1.5], [12, 74, 3.5],
    [16, 72, 3.5], [20, 71, 2], [22, 69, 1.5],
    [24, 71, 3.5], [28, 69, 3.5]
  ]
  const choirB: SongNote[] = [
    [32, 72, 3.5], [36, 74, 3.5], [40, 76, 3.5], [44, 72, 3.5],
    [48, 69, 3.5], [52, 71, 3.5], [56, 72, 3.5], [60, 74, 3.5]
  ]
  const choir = cat(choirA, choirB, at(choirA, 64))

  // Triangle lead, A' only: quiet dorian ornaments.
  const lead: SongNote[] = [
    [64, 74, 0.5], [64.5, 76, 0.5], [65, 74, 1], [66, 71, 1], [67, 69, 1],
    [68, 72, 1.5], [69.5, 71, 0.5], [70, 67, 2],
    [72, 74, 0.5], [72.5, 76, 0.5], [73, 77, 1], [74, 76, 0.5], [74.5, 74, 0.5], [75, 71, 1],
    [76, 71, 2], [78, 67, 1], [79, 71, 1],
    [80, 74, 1], [81, 77, 1], [82, 76, 1], [83, 74, 1],
    [84, 72, 2], [86, 69, 1], [87, 67, 1],
    [88, 71, 1.5], [89.5, 69, 0.5], [90, 67, 1], [91, 64, 1],
    [92, 74, 3]
  ]

  // Bass: D pedal through A sections (the dorian trick); roots walk in B.
  const bassRoots = [
    ...fill(8, 38),
    41, 43, 45, 45, 41, 43, 48, 38,
    ...fill(8, 38)
  ]

  // Open-fifth pad only under B — the canopy opens.
  const padB = stamp([41, 43, 45, 45, 41, 43, 48, 50], 4, [
    [0, 12, 3.8, 0.55], [0, 19, 3.8, 0.5]
  ], 8)

  // Percussion: a far-off heartbeat tom + rare high tick.
  const toms: SongNote[] = []
  for (let bar = 0; bar < 24; bar++) {
    const b = bar * 4
    if (bar % 2 === 0) toms.push([b, 43, 0.25, 0.45], [b + 2.5, 43, 0.2, 0.3])
    else toms.push([b + 3.5, 88, 0.08, 0.2])
  }

  const tracks: SongTrack[] = [
    { inst: 'pluck', vol: 0.75, notes: arps },
    { inst: 'choirish', vol: 0.65, notes: choir },
    { inst: 'triangle', vol: 0.55, notes: lead },
    { inst: 'pad', vol: 0.6, notes: padB },
    { inst: 'bass', vol: 0.7, notes: stamp(bassRoots, 4, [[0, 0, 3.6, 0.6]]) },
    { inst: 'noise', vol: 0.5, notes: toms }
  ]

  return { id: 'forest', bpm: 92, loopBeats: 96, tracks }
}

// ---------------------------------------------------------------------------
// 5. CAPITAL — regal fanfare march. Bb major, 120 BPM, 128 beats (64s).
// Square fanfares + organ stabs + march snare. The trio's last four bars
// quote the title motif in Bb (F Bb C D | C Bb G F).
// Form: fanfare intro (4) — march A (8) — trio (12, quote at the end) — A' (8).
// ---------------------------------------------------------------------------

function capitalSong(): Song {
  // Intro fanfare, bars 0-3 (Bb Bb Bb F)
  const intro: SongNote[] = [
    [0, 70, 0.75], [0.75, 70, 0.25], [1, 70, 0.5], [1.5, 74, 0.5], [2, 77, 1],
    [3, 74, 0.5], [3.5, 77, 0.5],
    [4, 82, 2], [6, 79, 0.5], [6.5, 77, 0.5], [7, 74, 1],
    [8, 77, 0.75], [8.75, 77, 0.25], [9, 77, 0.5], [9.5, 79, 0.5], [10, 82, 2],
    [12, 79, 1], [13, 77, 1], [14, 74, 1], [15, 70, 1]
  ]
  // March A, bars 4-11 (Bb Eb Bb F | Bb Eb F Bb), dotted strut
  const marchA: SongNote[] = [
    [16, 70, 0.75], [16.75, 72, 0.25], [17, 74, 1], [18, 77, 1], [19, 74, 1],
    [20, 75, 0.75], [20.75, 74, 0.25], [21, 72, 1], [22, 75, 1], [23, 72, 1],
    [24, 74, 0.75], [24.75, 72, 0.25], [25, 70, 1], [26, 74, 1], [27, 77, 1],
    [28, 77, 0.5], [28.5, 74, 0.5], [29, 72, 1], [30, 69, 1], [31, 72, 1],
    [32, 74, 0.75], [32.75, 74, 0.25], [33, 74, 0.5], [33.5, 77, 0.5], [34, 79, 1], [35, 77, 1],
    [36, 79, 0.75], [36.75, 77, 0.25], [37, 75, 1], [38, 72, 1], [39, 75, 1],
    [40, 77, 1], [41, 74, 0.5], [41.5, 72, 0.5], [42, 69, 1], [43, 74, 1],
    [44, 70, 0.75], [44.75, 72, 0.25], [45, 74, 0.5], [45.5, 77, 0.5], [46, 82, 2]
  ]
  // Trio (lyrical, softer), bars 12-19 (Eb Cm F Bb | Eb Cm F Bb)
  const trio: SongNote[] = [
    [48, 75, 1.5], [49.5, 74, 0.5], [50, 72, 1], [51, 70, 1],
    [52, 72, 1.5], [53.5, 70, 0.5], [54, 67, 1], [55, 72, 1],
    [56, 74, 1], [57, 72, 0.5], [57.5, 70, 0.5], [58, 69, 2],
    [60, 70, 1], [61, 74, 1], [62, 77, 2],
    [64, 75, 1.5], [65.5, 77, 0.5], [66, 79, 1], [67, 77, 1],
    [68, 79, 1], [69, 77, 1], [70, 75, 1], [71, 74, 1],
    [72, 72, 1], [73, 74, 1], [74, 69, 1], [75, 74, 1],
    [76, 74, 2], [78, 70, 1], [79, 74, 1, 0.7]
  ]
  // Motif quote, bars 20-23 (Bb Gm Eb F): F Bb C D | C Bb G F, then cadence.
  const quote: SongNote[] = [
    [80, 65, 1], [81, 70, 1], [82, 72, 1], [83, 74, 2],
    [85, 72, 0.5], [85.5, 70, 0.5], [86, 67, 1], [87, 65, 1],
    [88, 67, 1], [89, 70, 1], [90, 72, 1], [91, 74, 1],
    [92, 77, 2], [94, 75, 1], [95, 74, 1]
  ]
  const lead = cat(intro, marchA, trio, quote, at(marchA, 80))

  // Chords per bar (32 bars).
  const Bb = [58, 62, 65]
  const Eb = [58, 63, 67]
  const Fc = [57, 60, 65]
  const Gm = [55, 58, 62]
  const Cm = [60, 63, 67]
  const chords32 = [
    Bb, Bb, Bb, Fc,
    Bb, Eb, Bb, Fc, Bb, Eb, Fc, Bb,
    Eb, Cm, Fc, Bb, Eb, Cm, Fc, Bb,
    Bb, Gm, Eb, Fc,
    Bb, Eb, Bb, Fc, Bb, Eb, Fc, Bb
  ]
  const roots32 = [
    46, 46, 46, 41,
    46, 39, 46, 41, 46, 39, 41, 46,
    39, 48, 41, 46, 39, 48, 41, 46,
    46, 43, 39, 41,
    46, 39, 46, 41, 46, 39, 41, 46
  ]

  // Organ stabs on beats 1 & 3 ("oom-PAH" against the bass).
  const stabs: SongNote[] = []
  chords32.forEach((c, bar) => {
    stabs.push(...chord(bar * 4 + 1, c, 0.6, 0.6), ...chord(bar * 4 + 3, c, 0.6, 0.5))
  })

  // March snare: full pattern everywhere except the lyrical trio (lighter).
  const snarePat: Array<[number, number, number, number]> = [
    [0, 0, 0.1, 0.45], [0.5, 0, 0.1, 0.25], [1, 0, 0.1, 0.5], [1.5, 0, 0.1, 0.25],
    [2, 0, 0.1, 0.45], [2.5, 0, 0.1, 0.25], [3, 0, 0.1, 0.55], [3.5, 0, 0.1, 0.3],
    [3.75, 0, 0.1, 0.3]
  ]
  const snare = cat(
    every(12, 16, 0.25, 38, 0.1, (i) => 0.15 + i * 0.025), // intro roll crescendo
    stamp(fill(8, 38), 4, snarePat, 4),
    stamp(fill(8, 38), 4, [[1, 0, 0.1, 0.3], [3, 0, 0.1, 0.35]], 12), // trio: light
    stamp(fill(12, 38), 4, snarePat, 20)
  )

  const tracks: SongTrack[] = [
    { inst: 'square', vol: 0.8, notes: lead },
    { inst: 'organ', vol: 0.6, notes: stabs },
    { inst: 'bass', vol: 0.85, notes: stamp(roots32, 4, [
      [0, 0, 0.8, 0.85], [2, 7, 0.8, 0.6]
    ]) },
    { inst: 'bell', vol: 0.45, notes: cat(
      at(intro, 0, 12, 0.5),
      at(quote, 0, 12, 0.5),
      at(marchA, 80, 12, 0.45)
    ) },
    { inst: 'kick', vol: 0.7, notes: stamp(fill(28, 36), 4, [
      [0, 0, 0.2, 0.8], [2, 0, 0.2, 0.6]
    ], 4) },
    { inst: 'snare', vol: 0.55, notes: snare }
  ]

  return { id: 'capital', bpm: 120, loopBeats: 128, tracks }
}

// ---------------------------------------------------------------------------
// 6. MOUNTAIN — sturdy hikes, open fifths. E minor, 104 BPM, 96 beats (~55s).
// Saw lead over power-fifth pads and a root-fifth bass; A' adds a triangle
// voice a parallel fifth up (the open-air sound). Form: A (8) B (8) A'+5th (8).
// ---------------------------------------------------------------------------

function mountainSong(): Song {
  // A, bars 0-7 (Em D C D | Em G D Em) — E minor pentatonic stride
  const melA: SongNote[] = [
    [0, 64, 1], [1, 67, 1], [2, 69, 1], [3, 71, 1],
    [4, 74, 2], [6, 71, 1], [7, 69, 1],
    [8, 67, 1.5], [9.5, 64, 0.5], [10, 67, 1], [11, 69, 1],
    [12, 71, 2], [14, 69, 1], [15, 67, 1],
    [16, 64, 1], [17, 67, 1], [18, 71, 1], [19, 74, 1],
    [20, 76, 2], [22, 74, 1], [23, 71, 1],
    [24, 74, 1], [25, 71, 1], [26, 69, 1.5], [27.5, 67, 0.5],
    [28, 64, 2.5], [31, 64, 1, 0.6]
  ]
  // B, bars 8-15 (C D Em Em | C G D D) — the summit view
  const melB: SongNote[] = [
    [32, 76, 1], [33, 79, 1], [34, 76, 1], [35, 74, 1],
    [36, 74, 1.5], [37.5, 71, 0.5], [38, 74, 1], [39, 76, 1],
    [40, 79, 2], [42, 76, 1], [43, 74, 1],
    [44, 71, 1], [45, 74, 1], [46, 76, 1], [47, 79, 1],
    [48, 81, 2], [50, 79, 1], [51, 76, 1],
    [52, 79, 1.5], [53.5, 74, 0.5], [54, 76, 1], [55, 74, 1],
    [56, 74, 1], [57, 71, 1], [58, 69, 1], [59, 66, 1],
    [60, 64, 2], [62, 62, 1], [63, 64, 1]
  ]
  const lead = cat(melA, melB, at(melA, 64))

  const rootsA = [40, 38, 36, 38, 40, 43, 38, 40]
  const rootsB = [36, 38, 40, 40, 36, 43, 38, 38]
  const roots = [...rootsA, ...rootsB, ...rootsA]

  const tracks: SongTrack[] = [
    { inst: 'saw', vol: 0.75, notes: lead },
    // A' harmony: the A melody a parallel fifth up — big open-fifth air.
    { inst: 'triangle', vol: 0.5, notes: at(melA, 64, 7, 0.65) },
    { inst: 'pad', vol: 0.65, notes: stamp(roots, 4, [
      [0, 12, 3.8, 0.6], [0, 19, 3.8, 0.55]
    ]) },
    { inst: 'bass', vol: 0.9, notes: stamp(roots, 4, [
      [0, 0, 1.4, 0.85], [2, 7, 0.9, 0.6], [3, 0, 0.9, 0.5]
    ]) },
    { inst: 'kick', vol: 0.75, notes: stamp(fill(24, 36), 4, [
      [0, 0, 0.2, 0.85], [2, 0, 0.2, 0.6]
    ]) },
    { inst: 'noise', vol: 0.5, notes: stamp(fill(24, 48), 4, [
      [1.5, 0, 0.2, 0.4], [3.5, 0, 0.18, 0.3]
    ]) },
    { inst: 'snare', vol: 0.45, notes: stamp(fill(8, 38), 4, [
      [1, 0, 0.15, 0.4], [3, 0, 0.15, 0.45]
    ], 8) },
    { inst: 'hat', vol: 0.35, notes: every(0, 96, 1, 42, 0.1, () => 0.24) }
  ]

  return { id: 'mountain', bpm: 104, loopBeats: 96, tracks }
}

// ---------------------------------------------------------------------------
// 7. BEACH_LAGOON — calypso lilt. C major, 126 BPM light swing, 128 beats (61s).
// Steel-drum bells, offbeat pluck comping, soca bass, shaker.
// Form: A (bells, 8) — A2 (pluck takes the tune, 8) — B (8) — A' (unison, 8).
// ---------------------------------------------------------------------------

function beachLagoonSong(): Song {
  // A, bars 0-7 (C F C G | C F G C) — syncopated steel-drum tune
  const melA: SongNote[] = [
    [0, 72, 0.5], [0.5, 76, 0.5], [1, 79, 1], [2.5, 76, 0.5], [3, 74, 1],
    [4, 74, 0.5], [4.5, 77, 0.5], [5, 81, 1], [6.5, 77, 0.5], [7, 74, 1],
    [8, 76, 0.5], [8.5, 79, 0.5], [9, 84, 1], [10.5, 79, 0.5], [11, 76, 1],
    [12, 74, 1], [13, 71, 0.5], [13.5, 74, 0.5], [14, 79, 1.5],
    [16, 72, 0.5], [16.5, 76, 0.5], [17, 79, 1], [18.5, 76, 0.5], [19, 74, 1],
    [20, 77, 0.5], [20.5, 81, 0.5], [21, 84, 1], [22.5, 81, 0.5], [23, 77, 1],
    [24, 79, 0.5], [24.5, 74, 0.5], [25, 71, 1], [26, 74, 0.5], [26.5, 76, 0.5], [27, 74, 1],
    [28, 72, 1.5], [29.5, 76, 0.5], [30, 79, 1], [31, 76, 1, 0.7]
  ]
  // B, bars 16-23 (F G Em Am | F G C G)
  const melB: SongNote[] = [
    [64, 81, 1], [65.5, 84, 0.5], [66, 81, 1], [67, 77, 1],
    [68, 79, 1], [69.5, 83, 0.5], [70, 79, 1], [71, 74, 1],
    [72, 76, 0.5], [72.5, 79, 0.5], [73, 76, 1], [74, 74, 1.5],
    [76, 72, 0.5], [76.5, 76, 0.5], [77, 72, 1], [78, 69, 1.5],
    [80, 77, 1], [81.5, 81, 0.5], [82, 84, 1], [83, 81, 1],
    [84, 79, 1], [85, 74, 0.5], [85.5, 71, 0.5], [86, 74, 1], [87, 76, 1],
    [88, 76, 1.5], [89.5, 79, 0.5], [90, 76, 1], [91, 72, 1],
    [92, 74, 1], [93, 76, 0.5], [93.5, 77, 0.5], [94, 79, 1.5]
  ]
  // Bells: A, interjections over A2, B, then A' in unison with the pluck.
  const bells = cat(
    melA,
    [
      [39, 84, 0.5, 0.45], [47, 83, 0.5, 0.45],
      [55, 84, 0.5, 0.5], [62, 83, 0.5, 0.45]
    ],
    melB,
    at(melA, 96)
  )
  // Pluck: comping except A2/A', where it carries the tune an octave down.
  const C = [64, 67, 72]
  const Fc = [65, 69, 72]
  const G = [62, 67, 71]
  const Em = [64, 67, 71]
  const Am = [64, 69, 72]
  const barChords = [
    C, Fc, C, G, C, Fc, G, C,
    C, Fc, C, G, C, Fc, G, C,
    Fc, G, Em, Am, Fc, G, C, G,
    C, Fc, C, G, C, Fc, G, C
  ]
  const comp: SongNote[] = []
  barChords.forEach((c, bar) => {
    if (bar >= 8 && bar < 16) return // A2: pluck has the melody
    comp.push(...chord(bar * 4 + 1.5, c, 0.4, 0.5), ...chord(bar * 4 + 3.5, c, 0.4, 0.42))
  })
  const pluck = cat(comp, at(melA, 32, -12, 0.9), at(melA, 96, -12, 0.75))

  const roots = [
    48, 41, 48, 43, 48, 41, 43, 48,
    48, 41, 48, 43, 48, 41, 43, 48,
    41, 43, 40, 45, 41, 43, 48, 43,
    48, 41, 48, 43, 48, 41, 43, 48
  ]

  // Hats: offbeats, with an open hat closing every 4th bar.
  const hats: SongNote[] = []
  for (let bar = 0; bar < 32; bar++) {
    const b = bar * 4
    for (let q = 0; q < 4; q++) {
      const open = q === 3 && bar % 4 === 3
      hats.push([b + q + 0.5, 42, open ? 0.3 : 0.1, open ? 0.5 : 0.4])
    }
  }

  const tracks: SongTrack[] = [
    { inst: 'bell', vol: 0.65, notes: bells },
    { inst: 'pluck', vol: 0.7, notes: pluck },
    { inst: 'bass', vol: 0.85, notes: stamp(roots, 4, [
      [0, 0, 1.2, 0.85], [1.5, 0, 0.5, 0.5], [2.5, 7, 0.5, 0.6], [3, 0, 0.8, 0.55]
    ]) },
    { inst: 'kick', vol: 0.6, notes: every(0, 128, 1, 36, 0.15, (i) =>
      i % 4 === 0 ? 0.7 : i % 2 === 0 ? 0.55 : 0.45
    ) },
    { inst: 'hat', vol: 0.45, notes: hats },
    // Shaker: bandpassed noise way up high, swung eighths.
    { inst: 'noise', vol: 0.35, notes: every(0, 128, 0.5, 108, 0.08, (i) => (i % 2 === 0 ? 0.3 : 0.18)) }
  ]

  return { id: 'beach_lagoon', bpm: 126, loopBeats: 128, swing: 0.12, tracks }
}

// ---------------------------------------------------------------------------
// 8. CHERRY — gentle pentatonic spring. A major pentatonic, 84 BPM, 80 beats
// (~57s). Koto-ish pluck with bell echoes over breathing choir dyads; the
// title motif (itself pentatonic) is quoted whole in the third section.
// Form: A (8) — lift (4) — motif quote (4) — coda (4).
// ---------------------------------------------------------------------------

function cherrySong(): Song {
  // A, bars 0-7 (A F#m D E | A F#m D E)
  const melA: SongNote[] = [
    [0, 69, 1], [1, 71, 0.5], [1.5, 73, 0.5], [2, 76, 2],
    [4, 73, 1], [5, 71, 1], [6, 69, 2],
    [8, 66, 1], [9, 69, 1], [10, 71, 1.5], [11.5, 73, 0.5],
    [12, 71, 1], [13, 69, 0.5], [13.5, 66, 0.5], [14, 64, 2],
    [16, 69, 1], [17, 73, 1], [18, 76, 1.5], [19.5, 78, 0.5],
    [20, 76, 1], [21, 73, 1], [22, 71, 2],
    [24, 69, 0.5], [24.5, 71, 0.5], [25, 73, 1], [26, 69, 1], [27, 66, 1],
    [28, 64, 3]
  ]
  // Lift, bars 8-11 (D E F#m E) — higher blossom
  const melLift: SongNote[] = [
    [32, 78, 1], [33, 76, 1], [34, 73, 1.5], [35.5, 76, 0.5],
    [36, 78, 1], [37, 81, 2], [39, 78, 1],
    [40, 76, 1], [41, 73, 1], [42, 71, 1], [43, 69, 1],
    [44, 71, 1.5], [45.5, 69, 0.5], [46, 66, 2]
  ]
  // Title motif in A, stretched soft and slow, bars 12-15 (A F#m D E):
  // E A B C# | B A F# E — every note sits in the A pentatonic.
  const melQuote: SongNote[] = [
    [48, 64, 1.5], [50, 69, 1.5], [52, 71, 1.5], [54, 73, 2.5],
    [57, 71, 1], [58, 69, 1.5], [60, 66, 2], [62, 64, 2]
  ]
  // Coda, bars 16-19 (D E A A) — settle, breath, pickup
  const melCoda: SongNote[] = [
    [64, 66, 1], [65, 69, 1], [66, 71, 1], [67, 73, 1],
    [68, 76, 2], [70, 73, 1], [71, 71, 1],
    [72, 69, 4],
    [78, 64, 1, 0.5], [79, 66, 1, 0.55]
  ]
  const melody = cat(melA, melLift, melQuote, melCoda)

  // Bell echoes: phrase tails answered an octave up, quietly.
  const echoes: SongNote[] = [
    [3, 88, 1, 0.3], [15, 76, 1, 0.3], [23, 83, 1, 0.3], [30, 76, 1, 0.28],
    [38.5, 93, 0.5, 0.3], [47, 78, 1, 0.3],
    [55, 85, 1.5, 0.32], [63, 76, 1, 0.3],
    [70, 88, 1, 0.3], [74, 81, 2, 0.3]
  ]

  // Choir dyads (root + sixth/fifth) per bar: A F#m D E voicings.
  const A5 = [57, 64]
  const Fsm = [54, 61]
  const D5 = [50, 57]
  const E5 = [52, 59]
  const choirBars = [
    A5, Fsm, D5, E5, A5, Fsm, D5, E5,
    D5, E5, Fsm, E5,
    A5, Fsm, D5, E5,
    D5, E5, A5, A5
  ]

  const bassRoots = [
    45, 42, 38, 40, 45, 42, 38, 40,
    38, 40, 42, 40,
    45, 42, 38, 40,
    38, 40, 45, 45
  ]

  // A single soft taiko at each section door.
  const taiko: SongNote[] = [
    [32, 38, 0.3, 0.5], [48, 38, 0.3, 0.45], [64, 38, 0.3, 0.5], [72, 38, 0.3, 0.35]
  ]

  const tracks: SongTrack[] = [
    { inst: 'pluck', vol: 0.75, notes: melody },
    { inst: 'bell', vol: 0.5, notes: echoes },
    { inst: 'choirish', vol: 0.6, notes: pads(choirBars, 4, 3.9, 0.6) },
    { inst: 'bass', vol: 0.65, notes: stamp(bassRoots, 4, [[0, 0, 3, 0.55]]) },
    { inst: 'noise', vol: 0.5, notes: taiko }
  ]

  return { id: 'cherry', bpm: 84, loopBeats: 80, tracks }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const BRIGHT_SONGS: Song[] = [
  titleSong(),
  villageSong(),
  meadowSong(),
  forestSong(),
  capitalSong(),
  mountainSong(),
  beachLagoonSong(),
  cherrySong()
]

for (const song of BRIGHT_SONGS) registerSong(song)

/** Ids of every song this module registers. */
export const BRIGHT_SONG_IDS = [
  'title',
  'village',
  'meadow',
  'forest',
  'capital',
  'mountain',
  'beach_lagoon',
  'cherry'
] as const

export type BrightSongId = (typeof BRIGHT_SONG_IDS)[number]
