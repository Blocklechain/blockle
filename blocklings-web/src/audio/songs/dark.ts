/**
 * Blocklings — dark song set (minor/modal zone themes).
 *
 * Eight looping songs for the grim half of the world map, composed against
 * the sequencer's Song format and the stock instrument bank. Same craft bar
 * as the bright set, opposite mood palette:
 *
 *  - dungeon         slow dread heartbeat in D phrygian, sparse lonely bells
 *  - graveyard       lamento-bass funeral hymn, choir triads + tolling bell
 *  - volcanic        driving E-phrygian riff rock, four-on-floor + tom fill
 *  - wastes          desolate wide C-minor pads, a lead that mostly stays quiet
 *  - glacier_tundra  crystalline bell arpeggios over slow E-minor add9 pads
 *  - swamp           murky swung G-dorian blues, muted pluck + organ murk
 *  - ruins           the title motif again, slower, minor, echoing off stone
 *  - night           global safe-biome night overlay: soft pads + star twinkles
 *
 * Registered at module import; integrator picks ids from DARK_SONG_IDS.
 */
import type { Song, SongNote, SongTrack } from '../sequencer'
import { registerSong } from '../songbook'

// ---------------------------------------------------------------------------
// Small build helpers
// ---------------------------------------------------------------------------

/** Push one chord: every midi in `midis` held from `beat` for `dur`. */
function chord(
  out: SongNote[],
  beat: number,
  midis: number[],
  dur: number,
  vel: number
): void {
  for (const m of midis) out.push([beat, m, dur, vel])
}

/** Straight eighth-note hats for `bars` bars, alternating velocities. */
function hatEighths(
  bars: number,
  loVel: number,
  hiVel: number,
  openOnBars: number[] = []
): SongNote[] {
  const notes: SongNote[] = []
  for (let bar = 0; bar < bars; bar++) {
    const b = bar * 4
    const open = openOnBars.includes(bar)
    for (let e = 0; e < 8; e++) {
      const last = e === 7
      notes.push([
        b + e * 0.5,
        42,
        open && last ? 0.4 : 0.1,
        e % 2 === 0 ? loVel : hiVel
      ])
    }
  }
  return notes
}

// ---------------------------------------------------------------------------
// 'dungeon' — low dread pulse, sparse bells. D phrygian, 76 BPM.
// A heartbeat kick + root-pulse bass under a near-static pad; high bells
// drip in from the dark like water off the ceiling.
// ---------------------------------------------------------------------------

function dungeon(): Song {
  // 16 bars. D2 pedal with phrygian Eb and a C dip; one F lift near the end.
  const roots = [38, 38, 38, 38, 39, 38, 36, 38, 38, 38, 38, 38, 39, 41, 36, 38]

  const bassNotes: SongNote[] = []
  const kickNotes: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    bassNotes.push([b, r, 0.8, 0.8], [b + 2, r, 0.7, 0.55], [b + 3.5, r, 0.4, 0.4])
    // Heartbeat: thump, then a weaker echo three-quarters of a beat later.
    kickNotes.push([b, 36, 0.2, 0.75], [b + 0.75, 36, 0.2, 0.45])
  })

  const padNotes: SongNote[] = []
  chord(padNotes, 0, [50, 57], 31.5, 0.55) // D3 + A3 open fifth
  chord(padNotes, 32, [50, 57, 53], 31.5, 0.5) // F3 creeps in: minor colour

  const bells: SongNote[] = [
    [6, 74, 1.5, 0.4],
    [14, 75, 1.5, 0.35], // phrygian Eb5 — the wrongness note
    [22, 69, 2, 0.4],
    [30.5, 72, 1.5, 0.3],
    [38, 74, 1.5, 0.4],
    [46, 77, 1.5, 0.3],
    [54, 75, 1.5, 0.35],
    [61, 74, 2.5, 0.45]
  ]

  // Distant sub-rumbles ahead of each half's turnaround.
  const rumbles: SongNote[] = [
    [15.5, 31, 2, 0.5],
    [47.5, 31, 2, 0.5]
  ]

  const tracks: SongTrack[] = [
    { inst: 'bass', vol: 0.85, notes: bassNotes },
    { inst: 'pad', vol: 0.6, notes: padNotes },
    { inst: 'bell', vol: 0.55, notes: bells },
    { inst: 'kick', vol: 0.8, notes: kickNotes },
    { inst: 'noise', vol: 0.5, notes: rumbles }
  ]
  return { id: 'dungeon', bpm: 76, loopBeats: 64, tracks }
}

// ---------------------------------------------------------------------------
// 'graveyard' — lament, choirish. A minor lamento bass (A-G-F-E), 58 BPM.
// Choir triads sink through the classic descending tetrachord while a
// triangle voice keens overhead; a low bell tolls every other bar.
// ---------------------------------------------------------------------------

function graveyard(): Song {
  const bassRoots = [45, 43, 41, 40, 45, 43, 41, 40] // A2 G2 F2 E2, twice
  const triads: number[][] = [
    [57, 60, 64], // Am
    [55, 59, 62], // G
    [53, 57, 60], // F
    [52, 56, 59] // E (harmonic-minor dominant)
  ]

  const bassNotes: SongNote[] = []
  const choirNotes: SongNote[] = []
  bassRoots.forEach((r, bar) => {
    bassNotes.push([bar * 4, r, 3.6, 0.65])
    const t = triads[bar % 4]
    if (t) chord(choirNotes, bar * 4, t, 3.8, 0.6)
  })

  const lament: SongNote[] = [
    // First verse: falling sighs.
    [0, 76, 1.5, 0.55], [1.5, 74, 1, 0.5], [2.5, 72, 1.5, 0.55],
    [4, 71, 1.5, 0.55], [5.5, 72, 1, 0.5], [6.5, 69, 1.5, 0.55],
    [8, 69, 1, 0.5], [9, 72, 1, 0.55], [10, 74, 2, 0.6],
    [12, 71, 2.5, 0.55], [15, 68, 1, 0.45], // G# leading tone, unresolved
    // Second verse: answer from below, resolving home.
    [16, 72, 1.5, 0.55], [17.5, 71, 1, 0.5], [18.5, 69, 1.5, 0.55],
    [20, 67, 1.5, 0.55], [21.5, 69, 1, 0.5], [22.5, 71, 1.5, 0.55],
    [24, 72, 1, 0.5], [25, 74, 1, 0.55], [26, 76, 2, 0.6],
    [28, 68, 2, 0.5], [30, 69, 2, 0.55]
  ]

  const toll: SongNote[] = [
    [0, 57, 2, 0.45],
    [8, 57, 2, 0.45],
    [16, 57, 2, 0.45],
    [24, 57, 2, 0.45],
    [31, 64, 1.5, 0.3]
  ]

  const tracks: SongTrack[] = [
    { inst: 'choirish', vol: 0.8, notes: choirNotes },
    { inst: 'triangle', vol: 0.7, notes: lament },
    { inst: 'bass', vol: 0.7, notes: bassNotes },
    { inst: 'bell', vol: 0.5, notes: toll }
  ]
  return { id: 'graveyard', bpm: 58, loopBeats: 32, tracks }
}

// ---------------------------------------------------------------------------
// 'volcanic' — driving phrygian. E phrygian riff rock at 138 BPM:
// pumping eighth-note bass, saw riff that leans hard on the b2 (F),
// four-on-the-floor kick, snare backbeat, tom-and-snare fill into the loop.
// ---------------------------------------------------------------------------

function volcanic(): Song {
  const roots = [40, 40, 41, 40, 40, 40, 38, 40] // E E F E | E E D E

  const bassNotes: SongNote[] = []
  const stabNotes: SongNote[] = []
  const kickNotes: SongNote[] = []
  const snareNotes: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    for (let e = 0; e < 8; e++) {
      bassNotes.push([b + e * 0.5, r, 0.4, e % 2 === 0 ? 0.9 : 0.65])
    }
    // Offbeat octave stabs track the root.
    stabNotes.push([b + 1.5, r + 12, 0.25, 0.5], [b + 3.5, r + 12, 0.25, 0.5])
    kickNotes.push(
      [b, 36, 0.2, 1], [b + 1, 36, 0.2, 0.8],
      [b + 2, 36, 0.2, 1], [b + 3, 36, 0.2, 0.8]
    )
    if (bar === 3 || bar === 7) kickNotes.push([b + 3.5, 36, 0.2, 0.7])
    snareNotes.push([b + 1, 38, 0.2, 0.7], [b + 3, 38, 0.2, 0.75])
  })
  // Loop-turnaround snare build.
  snareNotes.push(
    [30.5, 38, 0.1, 0.4], [30.75, 38, 0.1, 0.5],
    [31, 38, 0.1, 0.6], [31.25, 38, 0.1, 0.7], [31.5, 38, 0.1, 0.85]
  )

  const riff: SongNote[] = [
    // Low statement.
    [0, 64, 0.5, 0.85], [0.5, 65, 0.5, 0.8], [1, 64, 0.5, 0.8], [1.5, 62, 0.5, 0.75],
    [2, 64, 1, 0.85], [3, 67, 1, 0.8],
    [4, 64, 0.5, 0.85], [4.5, 65, 0.5, 0.8], [5, 67, 0.5, 0.8], [5.5, 69, 0.5, 0.85],
    [6, 65, 1.5, 0.85], [7.5, 64, 0.5, 0.7],
    [8, 65, 0.5, 0.9], [8.5, 67, 0.5, 0.8], [9, 65, 0.5, 0.8], [9.5, 64, 0.5, 0.75],
    [10, 65, 1, 0.85], [11, 60, 1, 0.75],
    [12, 64, 0.5, 0.8], [12.5, 62, 0.5, 0.75], [13, 64, 0.5, 0.8], [13.5, 65, 0.5, 0.8],
    [14, 64, 2, 0.9],
    // High restatement — the eruption.
    [16, 76, 0.5, 0.9], [16.5, 77, 0.5, 0.85], [17, 76, 0.5, 0.85], [17.5, 74, 0.5, 0.8],
    [18, 76, 1, 0.9], [19, 79, 1, 0.85],
    [20, 77, 1, 0.9], [21, 76, 0.5, 0.8], [21.5, 74, 0.5, 0.8],
    [22, 72, 1, 0.85], [23, 71, 1, 0.8],
    [24, 74, 1, 0.85], [25, 72, 0.5, 0.8], [25.5, 71, 0.5, 0.75],
    [26, 69, 1, 0.8], [27, 65, 1, 0.75],
    [28, 64, 0.5, 0.85], [28.5, 65, 0.5, 0.85], [29, 64, 0.5, 0.85], [29.5, 65, 0.5, 0.85],
    [30, 64, 2, 0.95]
  ]

  // Tom hits under the fill.
  const toms: SongNote[] = [
    [31, 50, 0.2, 0.6],
    [31.5, 45, 0.2, 0.7]
  ]

  const tracks: SongTrack[] = [
    { inst: 'saw', vol: 0.85, notes: riff },
    { inst: 'pulse25', vol: 0.5, notes: stabNotes },
    { inst: 'bass', vol: 0.9, notes: bassNotes },
    { inst: 'kick', vol: 0.9, notes: kickNotes },
    { inst: 'snare', vol: 0.65, notes: snareNotes },
    { inst: 'hat', vol: 0.5, notes: hatEighths(8, 0.35, 0.55, [3, 7]) },
    { inst: 'noise', vol: 0.6, notes: toms }
  ]
  return { id: 'volcanic', bpm: 138, loopBeats: 32, tracks }
}

// ---------------------------------------------------------------------------
// 'wastes' — desolate wide pad, lonely lead. C minor, 66 BPM, drumless.
// Eight slow chords stretch across the horizon; a single quiet square lead
// wanders in twice, says very little, and falls silent again.
// ---------------------------------------------------------------------------

function wastes(): Song {
  const chords: number[][] = [
    [48, 55, 63], // Cm
    [44, 51, 60], // Ab
    [51, 58, 67], // Eb
    [43, 50, 58], // Gm
    [48, 55, 63], // Cm
    [44, 51, 60], // Ab
    [46, 53, 62], // Bb
    [48, 55, 63] // Cm
  ]
  const bassRoots = [36, 44, 39, 43, 36, 44, 46, 36]

  const padNotes: SongNote[] = []
  const bassNotes: SongNote[] = []
  chords.forEach((c, i) => {
    chord(padNotes, i * 8, c, 7.6, 0.6)
    const r = bassRoots[i]
    if (r !== undefined) bassNotes.push([i * 8, r, 7, 0.5])
  })

  const lead: SongNote[] = [
    // First wandering phrase.
    [8, 72, 2, 0.45], [11, 70, 1, 0.4], [12.5, 67, 2.5, 0.45],
    [20, 67, 1.5, 0.4], [22, 70, 1, 0.4], [23.5, 72, 2, 0.45],
    [26, 75, 2, 0.5], [28.5, 72, 3, 0.45],
    // Second phrase, higher and shorter — then nothing.
    [40, 75, 2, 0.45], [42.5, 72, 1.5, 0.4], [44.5, 70, 3, 0.45],
    [52, 70, 1.5, 0.4], [54, 67, 1, 0.4], [55.5, 65, 2.5, 0.4],
    [58, 63, 4.5, 0.35]
  ]

  const bells: SongNote[] = [
    [16, 79, 2, 0.3],
    [48, 75, 2, 0.25]
  ]

  const tracks: SongTrack[] = [
    { inst: 'pad', vol: 0.85, notes: padNotes },
    { inst: 'square', vol: 0.6, notes: lead },
    { inst: 'bass', vol: 0.6, notes: bassNotes },
    { inst: 'bell', vol: 0.45, notes: bells }
  ]
  return { id: 'wastes', bpm: 66, loopBeats: 64, tracks }
}

// ---------------------------------------------------------------------------
// 'glacier_tundra' — crystalline bells, slow. E minor add9, 70 BPM.
// Slow pads underneath; FM bells arpeggiate upward like ice crystals
// catching light; faint hat ticks are the glacier settling.
// ---------------------------------------------------------------------------

function glacierTundra(): Song {
  const pads: number[][] = [
    [52, 59, 64, 66], // Em add9
    [48, 55, 59, 64], // Cmaj7
    [45, 52, 59, 60], // Am9
    [47, 54, 59, 62], // Bm
    [48, 55, 60, 64], // C
    [50, 57, 62, 66] // D — dorian cadence back to Em
  ]
  const bassRoots = [40, 36, 45, 47, 36, 38]
  const arps: number[][] = [
    [76, 79, 83, 86, 88],
    [76, 79, 84, 88, 83],
    [76, 81, 84, 88, 83],
    [78, 83, 86, 83, 78],
    [79, 84, 88, 84, 79],
    [78, 81, 86, 81, 78]
  ]

  const padNotes: SongNote[] = []
  const bassNotes: SongNote[] = []
  const bellNotes: SongNote[] = []
  pads.forEach((c, i) => {
    const b = i * 8
    chord(padNotes, b, c, 7.5, 0.55)
    const r = bassRoots[i]
    if (r !== undefined) bassNotes.push([b, r, 7, 0.45])
    const arp = arps[i]
    if (arp) {
      arp.forEach((m, j) => {
        if (j < 4) bellNotes.push([b + j, m, 0.5, 0.42 - j * 0.02])
        else bellNotes.push([b + 5, m, 1, 0.45])
      })
    }
  })

  const lead: SongNote[] = [
    [24, 71, 3, 0.45], [28, 74, 2.5, 0.4],
    [32, 76, 3, 0.45], [36, 74, 2.5, 0.4],
    [40, 72, 3, 0.45], [44, 74, 3.5, 0.4]
  ]

  // Ice ticks: every other bar, barely there.
  const ticks: SongNote[] = []
  for (let bar = 0; bar < 12; bar += 2) {
    ticks.push([bar * 4 + 1.5, 42, 0.1, 0.2], [bar * 4 + 3.25, 42, 0.1, 0.18])
  }

  const tracks: SongTrack[] = [
    { inst: 'bell', vol: 0.7, notes: bellNotes },
    { inst: 'pad', vol: 0.75, notes: padNotes },
    { inst: 'triangle', vol: 0.55, notes: lead },
    { inst: 'bass', vol: 0.55, notes: bassNotes },
    { inst: 'hat', vol: 0.4, notes: ticks }
  ]
  return { id: 'glacier_tundra', bpm: 70, loopBeats: 48, tracks }
}

// ---------------------------------------------------------------------------
// 'swamp' — murky swing, muted pluck. G dorian, 96 BPM, swing 0.3.
// Lazy swung blues: walking bass, low-velocity pluck melody with one blue
// note, organ murk-stabs on the offbeats, brushy drums.
// ---------------------------------------------------------------------------

function swamp(): Song {
  const roots = [43, 43, 48, 48, 43, 43, 41, 43] // G G C C G G F G

  const bassNotes: SongNote[] = []
  const kickNotes: SongNote[] = []
  const snareNotes: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    bassNotes.push(
      [b, r, 1.5, 0.8],
      [b + 2, r, 0.5, 0.5],
      [b + 3, r + 3, 0.5, 0.55],
      [b + 3.5, r + 5, 0.5, 0.6]
    )
    kickNotes.push([b, 36, 0.2, 0.85], [b + 2.5, 36, 0.2, 0.6])
    snareNotes.push([b + 1, 38, 0.2, 0.5], [b + 3, 38, 0.2, 0.6])
  })

  const melody: SongNote[] = [
    [0, 67, 0.5, 0.6], [0.5, 70, 0.5, 0.6], [1, 72, 1, 0.65],
    [2.5, 70, 0.5, 0.55], [3, 67, 1, 0.6],
    [4.5, 64, 0.5, 0.55], [5, 65, 0.5, 0.55], [5.5, 67, 1.5, 0.6], [7, 62, 1, 0.55],
    [8, 72, 0.5, 0.6], [8.5, 74, 0.5, 0.6], [9, 76, 1, 0.65],
    [10.5, 74, 0.5, 0.55], [11, 72, 1, 0.6],
    [12, 72, 0.5, 0.6], [12.5, 70, 0.5, 0.55], [13, 67, 1, 0.6],
    [14.5, 64, 0.5, 0.5], [15, 62, 1, 0.55],
    [16, 67, 0.5, 0.6], [16.5, 70, 0.5, 0.6], [17, 72, 1, 0.65],
    [18.5, 74, 0.5, 0.6], [19, 75, 1, 0.55], // blue Eb — the gator wink
    [20, 74, 0.5, 0.6], [20.5, 72, 0.5, 0.55], [21, 70, 1, 0.6],
    [22.5, 67, 0.5, 0.55], [23, 65, 1, 0.55],
    [24, 65, 0.5, 0.6], [24.5, 69, 0.5, 0.6], [25, 72, 1, 0.65],
    [26, 70, 0.5, 0.55], [26.5, 69, 0.5, 0.55], [27, 65, 0.5, 0.55],
    [28, 67, 2.5, 0.65], [31, 62, 0.5, 0.4]
  ]

  // Organ murk: offbeat stabs on even bars, chord tracks the root.
  const murk: SongNote[] = []
  const stabChords: Record<number, number[]> = {
    43: [58, 62, 65], // Gm
    48: [55, 60, 64], // C
    41: [57, 60, 65] // F
  }
  roots.forEach((r, bar) => {
    if (bar % 2 !== 0) return
    const c = stabChords[r]
    if (c) chord(murk, bar * 4 + 1.5, c, 0.5, 0.4)
  })

  const tracks: SongTrack[] = [
    { inst: 'pluck', vol: 0.8, notes: melody },
    { inst: 'bass', vol: 0.85, notes: bassNotes },
    { inst: 'organ', vol: 0.5, notes: murk },
    { inst: 'kick', vol: 0.7, notes: kickNotes },
    { inst: 'snare', vol: 0.5, notes: snareNotes },
    { inst: 'hat', vol: 0.45, notes: hatEighths(8, 0.3, 0.45, [3, 7]) }
  ]
  return { id: 'swamp', bpm: 96, loopBeats: 32, swing: 0.3, tracks }
}

// ---------------------------------------------------------------------------
// 'ruins' — melancholy echo of the title motif in minor. A minor, 84 BPM.
// The title melody's opening phrase, slowed to half speed, played on a bell
// and answered an octave down by a pluck "echo" a beat and a half later —
// the tune the ruins remember. Soft pads, distant thuds, no drums.
// ---------------------------------------------------------------------------

function ruins(): Song {
  const pads: number[][] = [
    [57, 60, 64], // Am
    [53, 57, 60], // F
    [50, 57, 65], // Dm
    [52, 56, 59], // E
    [57, 60, 64], // Am
    [53, 57, 60], // F
    [52, 56, 59], // E
    [57, 60, 64] // Am
  ]
  const bassRoots = [45, 41, 38, 40, 45, 41, 40, 45]

  const padNotes: SongNote[] = []
  const bassNotes: SongNote[] = []
  pads.forEach((c, i) => {
    chord(padNotes, i * 8, c, 7.5, 0.55)
    const r = bassRoots[i]
    if (r !== undefined) bassNotes.push([i * 8, r, 7, 0.5])
  })

  // Title motif, half speed (cf. the menu jingle's opening bars).
  const motif: SongNote[] = [
    [0, 69, 2, 0.5], [2, 72, 1, 0.5], [3, 74, 1, 0.5], [4, 76, 3, 0.55],
    [8, 72, 2, 0.5], [10, 69, 1, 0.5], [11, 67, 1, 0.45], [12, 69, 3, 0.55],
    [16, 74, 2, 0.5], [18, 72, 1, 0.5], [19, 69, 1, 0.45], [20, 65, 3, 0.5],
    [24, 68, 2, 0.5], [26, 71, 1, 0.5], [27, 68, 1, 0.45], [28, 64, 3, 0.5],
    // Second half: the memory frays — fewer notes each phrase.
    [32, 76, 2, 0.5], [34, 74, 1, 0.45], [35, 72, 1, 0.45], [36, 69, 3, 0.5],
    [40, 72, 3, 0.45], [44, 69, 2.5, 0.4],
    [48, 68, 2, 0.45], [51, 64, 2.5, 0.4],
    [56, 69, 5, 0.45]
  ]

  // Stone echo: same line, octave down, 1.5 beats late, much softer.
  const echo: SongNote[] = motif.map(
    ([b, m, d, v]) => [b + 1.5, m - 12, d, (v ?? 0.8) * 0.6] as SongNote
  )

  const thuds: SongNote[] = [
    [0, 33, 0.2, 0.4],
    [16, 33, 0.2, 0.35],
    [32, 33, 0.2, 0.4],
    [48, 33, 0.2, 0.35]
  ]

  const tracks: SongTrack[] = [
    { inst: 'bell', vol: 0.75, notes: motif },
    { inst: 'pluck', vol: 0.6, notes: echo },
    { inst: 'pad', vol: 0.7, notes: padNotes },
    { inst: 'bass', vol: 0.6, notes: bassNotes },
    { inst: 'kick', vol: 0.5, notes: thuds }
  ]
  return { id: 'ruins', bpm: 84, loopBeats: 64, tracks }
}

// ---------------------------------------------------------------------------
// 'night' — global night overlay for safe biomes. D minor (gentle), 62 BPM.
// Soft drifting pads, irregular high bell twinkles for stars, a faint choir
// after the halfway mark, and a triangle melody that only hums a little.
// ---------------------------------------------------------------------------

function night(): Song {
  const pads: number[][] = [
    [50, 57, 65], // Dm
    [46, 53, 62], // Bb
    [53, 57, 60], // F
    [48, 55, 64], // C
    [50, 57, 65], // Dm
    [46, 53, 62], // Bb
    [48, 55, 64], // C
    [50, 57, 65] // Dm
  ]
  const bassRoots = [38, 46, 41, 48, 38, 46, 48, 38]

  const padNotes: SongNote[] = []
  const bassNotes: SongNote[] = []
  pads.forEach((c, i) => {
    chord(padNotes, i * 8, c, 7.6, 0.5)
    const r = bassRoots[i]
    if (r !== undefined) bassNotes.push([i * 8, r, 7, 0.45])
  })

  // Stars: irregular, high, quiet, never twice in the same place.
  const stars: SongNote[] = [
    [1.5, 86, 1, 0.3], [5, 81, 1, 0.25],
    [9.5, 82, 1, 0.3], [13, 86, 1, 0.22],
    [17, 84, 1, 0.28], [21.5, 81, 1, 0.25],
    [25, 84, 1, 0.3], [28.5, 88, 1, 0.2],
    [33.5, 86, 1, 0.28], [37, 77, 1, 0.3],
    [41, 82, 1, 0.26], [45.5, 86, 1, 0.22],
    [49, 84, 1, 0.28], [52.5, 79, 1, 0.3],
    [57, 86, 1.5, 0.3], [61, 81, 1, 0.25], [62.5, 74, 1.5, 0.28]
  ]

  const hum: SongNote[] = [
    [16, 69, 3, 0.4], [20, 72, 2.5, 0.38],
    [24, 76, 3, 0.4], [28, 74, 2.5, 0.38],
    [48, 72, 3, 0.4], [52, 71, 2.5, 0.38],
    [56, 69, 4, 0.4]
  ]

  const breath: SongNote[] = [
    [32, 62, 7.5, 0.35],
    [40, 62, 7.5, 0.3]
  ]

  const tracks: SongTrack[] = [
    { inst: 'pad', vol: 0.8, notes: padNotes },
    { inst: 'bell', vol: 0.55, notes: stars },
    { inst: 'triangle', vol: 0.5, notes: hum },
    { inst: 'choirish', vol: 0.5, notes: breath },
    { inst: 'bass', vol: 0.5, notes: bassNotes }
  ]
  return { id: 'night', bpm: 62, loopBeats: 64, tracks }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const DARK_SONGS: Song[] = [
  dungeon(),
  graveyard(),
  volcanic(),
  wastes(),
  glacierTundra(),
  swamp(),
  ruins(),
  night()
]

for (const song of DARK_SONGS) registerSong(song)

/** Ids of every song in the dark set, in registration order. */
export const DARK_SONG_IDS: readonly string[] = DARK_SONGS.map((s) => s.id)
