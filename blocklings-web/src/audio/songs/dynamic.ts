/**
 * Blocklings — dynamic / musical-moment set.
 *
 * LOOPS (registered in the songbook — play via `audio.playSong(id)`):
 *   'combat'          — tense aggro loop (~26s), D minor w/ phrygian bite
 *   'boss_greenwood'  — feral tom-driven forest-beast theme
 *   'boss_ironhold'   — stone-heavy march w/ anvil hits
 *   'boss_ashen'      — rattling bone waltz (3/4, A harmonic minor)
 *   'boss_forgotten'  — war-chant stomp (D phrygian)
 *
 * STINGERS (non-looping 2–6s). The sequencer loops every song forever, so
 * stingers are NOT put in the songbook (a looping sad trombone is a bug, not
 * a feature). They are written in the same Song format but registered as
 * one-shot SFX recipes on the sfx bus: they play ON TOP of whatever music is
 * running without crossfading it out. Trigger with `playStinger('levelup')`
 * (or `audio.sfx.play('levelup')` — same thing).
 *
 * This module registers everything via side effects — the integrator must
 * side-effect import it once (e.g. `import './audio/songs/dynamic'`).
 */
import type { Song, SongNote, SongTrack } from '../sequencer'
import { registerSong } from '../songbook'
import { registerSfx } from '../sfx-core'
import type { SfxRecipe } from '../sfx-core'
import { getInstrument } from '../instruments'
import { audio } from '../engine'

// ---------------------------------------------------------------------------
// Tiny composition helpers
// ---------------------------------------------------------------------------

/** Push `pat` into `out` shifted right by `offset` beats. */
function at(out: SongNote[], offset: number, pat: SongNote[]): void {
  for (const n of pat) out.push([n[0] + offset, n[1], n[2], n[3] ?? 0.8])
}

/** Stack a chord: every midi in `chord` as one note at `beat`. */
function chord(
  out: SongNote[],
  beat: number,
  midis: number[],
  dur: number,
  vel: number
): void {
  for (const m of midis) out.push([beat, m, dur, vel])
}

// ===========================================================================
// 'combat' — tense aggro loop. D minor, 148 BPM, 16 bars (~26s).
// Driving eighth-note bass, offbeat saw stabs, pulse lead that climbs in the
// back half, straight urgent drums with bar-8/16 snare fills.
// ===========================================================================

function combatSong(): Song {
  // Chord roots per bar (octave 2). Eb = phrygian menace; bar 16 walks up.
  const roots = [
    38, 38, 39, 38, 38, 38, 36, 45, 38, 38, 39, 38, 41, 43, 45, 45
  ]

  const bassN: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    if (bar === 15) {
      // chromatic walkup back into the loop: A A B C#
      bassN.push([b, 45, 0.9, 0.95], [b + 1, 45, 0.9, 0.8])
      bassN.push([b + 2, 47, 0.9, 0.85], [b + 3, 49, 0.9, 0.9])
      return
    }
    const vels = [0.95, 0.7, 0.8, 0.7, 0.9, 0.7, 0.8, 0.75]
    for (let e = 0; e < 8; e++) bassN.push([b + e * 0.5, r, 0.45, vels[e] ?? 0.75])
  })

  const stabN: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    stabN.push([b + 1.5, r + 24, 0.3, 0.75], [b + 1.5, r + 31, 0.3, 0.6])
    stabN.push([b + 3.5, r + 24, 0.3, 0.65], [b + 3.5, r + 31, 0.3, 0.5])
  })

  const leadN: SongNote[] = []
  const riffA: SongNote[] = [
    [0, 74, 0.5, 0.95], [0.5, 72, 0.25], [0.75, 74, 0.25], [1, 70, 0.5],
    [1.5, 69, 0.5], [2, 67, 1, 0.85], [3, 69, 0.5], [3.5, 70, 0.5],
    [4, 69, 0.5], [4.5, 67, 0.5], [5, 65, 0.5], [5.5, 64, 0.5],
    [6, 63, 1.25, 0.9], [7.5, 62, 0.5, 0.7]
  ]
  at(leadN, 0, riffA)
  at(leadN, 8, riffA)
  at(leadN, 16, riffA)
  at(leadN, 24, [
    [0, 65, 0.5], [0.5, 67, 0.5], [1, 69, 0.5], [1.5, 70, 0.5], [2, 72, 1],
    [3, 70, 0.5], [3.5, 69, 0.5], [4, 67, 0.5], [4.5, 69, 0.5], [5, 70, 0.5],
    [5.5, 72, 0.5], [6, 73, 2, 0.95]
  ])
  const riffB: SongNote[] = [
    [0, 77, 0.5, 0.95], [0.5, 76, 0.25], [0.75, 77, 0.25], [1, 74, 0.5],
    [1.5, 72, 0.5], [2, 74, 1], [3, 70, 0.5], [3.5, 72, 0.5],
    [4, 74, 0.5], [4.5, 76, 0.5], [5, 77, 0.5], [5.5, 79, 0.5],
    [6, 81, 1.5, 0.95], [7.5, 79, 0.5]
  ]
  at(leadN, 32, riffB)
  at(leadN, 40, riffB)
  at(leadN, 48, [
    [0, 77, 1], [1, 76, 0.5], [1.5, 77, 0.5], [2, 79, 1], [3, 77, 0.5],
    [3.5, 76, 0.5], [4, 79, 1], [5, 77, 0.5], [5.5, 79, 0.5], [6, 81, 1.5, 0.95],
    [8, 81, 0.5], [8.5, 79, 0.5], [9, 77, 0.5], [9.5, 76, 0.5], [10, 74, 1],
    [11, 73, 0.5], [11.5, 74, 0.5], [12, 76, 2, 0.95], [14, 73, 1, 0.85],
    [15, 69, 1, 0.8]
  ])

  const kickN: SongNote[] = []
  const snareN: SongNote[] = []
  const hatN: SongNote[] = []
  for (let bar = 0; bar < 16; bar++) {
    const b = bar * 4
    const fill = bar % 8 === 7
    kickN.push([b, 36, 0.2, 0.95], [b + 1.5, 36, 0.2, 0.7], [b + 2.5, 36, 0.2, 0.85])
    snareN.push([b + 1, 38, 0.2, 0.8])
    if (fill) {
      for (let i = 0; i < 4; i++) {
        snareN.push([b + 3 + i * 0.25, 38, 0.15, 0.5 + i * 0.15])
      }
    } else {
      snareN.push([b + 3, 38, 0.2, 0.9])
    }
    for (let e = 0; e < 8; e++) {
      const open = e === 7 && bar % 4 === 3 && !fill
      hatN.push([b + e * 0.5, 42, open ? 0.4 : 0.12, e % 2 ? 0.5 : 0.3])
    }
  }

  const tracks: SongTrack[] = [
    { inst: 'pulse25', vol: 0.75, notes: leadN },
    { inst: 'saw', vol: 0.5, notes: stabN },
    { inst: 'bass', vol: 0.9, notes: bassN },
    { inst: 'kick', vol: 0.9, notes: kickN },
    { inst: 'snare', vol: 0.65, notes: snareN },
    { inst: 'hat', vol: 0.5, notes: hatN }
  ]
  return { id: 'combat', bpm: 148, loopBeats: 64, tracks }
}

// ===========================================================================
// 'boss_greenwood' — feral drums. E minor pentatonic, 172 BPM, 16 bars.
// Pitched toms (kick instrument at three midis) carry the groove; a low
// growled chant underneath; the pentatonic lead only bares its teeth in the
// second half. Periodic bandpassed-noise "roars".
// ===========================================================================

function greenwoodSong(): Song {
  // 2-bar feral tom pattern: [beat, midi(low 36 / mid 43 / high 48), vel]
  const tomPat: Array<[number, number, number]> = [
    [0, 36, 1], [0.5, 36, 0.65], [0.75, 43, 0.8], [1.5, 36, 0.9],
    [1.75, 48, 0.6], [2, 36, 1], [2.5, 43, 0.75], [3.25, 36, 0.7],
    [3.5, 48, 0.65], [3.75, 48, 0.55],
    [4, 36, 1], [4.5, 43, 0.7], [5, 36, 0.85], [5.75, 48, 0.6],
    [6, 36, 1], [6.5, 43, 0.8], [6.75, 36, 0.7], [7.5, 48, 0.7],
    [7.75, 43, 0.6]
  ]
  const tomN: SongNote[] = []
  for (let i = 0; i < 8; i++) {
    for (const [bt, m, v] of tomPat) tomN.push([i * 8 + bt, m, 0.2, v])
  }

  const snareN: SongNote[] = []
  const hatN: SongNote[] = []
  for (let bar = 0; bar < 16; bar++) {
    const b = bar * 4
    snareN.push([b + 2.75, 38, 0.15, 0.4], [b + 3, 38, 0.2, 0.85])
    if (bar % 4 === 3) {
      for (let i = 1; i < 4; i++) {
        snareN.push([b + 3 + i * 0.25, 38, 0.12, 0.45 + i * 0.12])
      }
    }
    for (let e = 0; e < 4; e++) hatN.push([b + e + 0.5, 42, 0.1, 0.35])
  }

  // Tribal eighth-note bass drone: mostly E, briefly lifting to G/A and D.
  const roots = [
    40, 40, 40, 40, 40, 40, 43, 45, 40, 40, 40, 40, 38, 38, 45, 45
  ]
  const bassN: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    for (let e = 0; e < 8; e++) {
      bassN.push([b + e * 0.5, r, 0.4, e % 4 === 0 ? 0.9 : 0.65])
    }
  })

  // Low growl-chant: long alternating E3/D3, fifths join in the back half.
  const chantN: SongNote[] = []
  for (let bar = 0; bar < 16; bar += 2) {
    const m = bar % 4 === 0 ? 52 : 50
    chantN.push([bar * 4, m, 3.5, 0.65])
    if (bar >= 8) chantN.push([bar * 4, m + 7, 3.5, 0.5])
  }

  // Roars: long low bandpassed noise swells at the loop's pillars.
  const roarN: SongNote[] = [
    [0, 41, 2, 0.5], [30, 44, 2, 0.45], [32, 41, 2, 0.55], [60, 47, 3, 0.55]
  ]

  // Lead enters at the halfway point: E minor pentatonic, biting.
  const leadN: SongNote[] = []
  const bite: SongNote[] = [
    [0, 76, 0.5, 0.95], [0.5, 74, 0.5], [1, 71, 0.5], [1.5, 74, 0.5],
    [2, 76, 0.75], [2.75, 79, 0.25], [3, 76, 0.5], [3.5, 74, 0.5],
    [4, 71, 1], [5, 69, 0.5], [5.5, 71, 0.5], [6, 67, 1.5]
  ]
  at(leadN, 32, bite)
  at(leadN, 40, bite)
  at(leadN, 48, [
    [0, 79, 0.5], [0.5, 81, 0.5], [1, 79, 0.5], [1.5, 76, 0.5],
    [2, 74, 0.75], [2.75, 76, 0.25], [3, 74, 0.5], [3.5, 71, 0.5],
    [4, 74, 2, 0.95], [6, 71, 0.5], [6.5, 69, 0.5], [7, 67, 0.5], [7.5, 64, 0.5]
  ])
  at(leadN, 56, [
    [0, 64, 0.5, 0.9], [0.5, 64, 0.25], [0.75, 64, 0.25], [1, 67, 0.5],
    [1.5, 69, 0.5], [2, 71, 0.5], [2.5, 74, 0.5], [3, 76, 2, 0.95],
    [6, 74, 1], [7, 71, 1]
  ])

  const tracks: SongTrack[] = [
    { inst: 'pulse25', vol: 0.7, notes: leadN },
    { inst: 'choirish', vol: 0.55, notes: chantN },
    { inst: 'bass', vol: 0.85, notes: bassN },
    { inst: 'kick', vol: 0.95, notes: tomN },
    { inst: 'snare', vol: 0.6, notes: snareN },
    { inst: 'hat', vol: 0.4, notes: hatN },
    { inst: 'noise', vol: 0.5, notes: roarN }
  ]
  return { id: 'boss_greenwood', bpm: 172, loopBeats: 64, tracks }
}

// ===========================================================================
// 'boss_ironhold' — stone-heavy march. C minor, 92 BPM, 8 bars (~21s).
// Half-note bass slabs, military snare drags, drawbar-organ masonry, a low
// brass-ish saw theme, and an anvil (bell + noise clink) on alternate bars.
// ===========================================================================

function ironholdSong(): Song {
  // Cm Cm Ab Bb | Cm Fm G Cm
  const roots = [36, 36, 44, 46, 36, 41, 43, 36]
  const triads: number[][] = [
    [60, 63, 67], [60, 63, 67], [56, 60, 63], [58, 62, 65],
    [60, 63, 67], [53, 56, 60], [55, 59, 62], [60, 63, 67]
  ]

  const bassN: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    if (bar === 7) {
      bassN.push([b, 36, 1.8, 0.95], [b + 2, 43, 1, 0.8], [b + 3, 47, 1, 0.85])
      return
    }
    bassN.push([b, r, 1.8, 0.95], [b + 2, r, 1.8, 0.8])
  })

  const organN: SongNote[] = []
  triads.forEach((t, bar) => chord(organN, bar * 4, t, 3.6, 0.6))

  const themeN: SongNote[] = [
    [0, 60, 1.5, 0.9], [1.5, 63, 0.5], [2, 67, 2, 0.85],
    [4, 63, 1.5], [5.5, 62, 0.5], [6, 60, 2],
    [8, 68, 1.5, 0.9], [9.5, 67, 0.5], [10, 63, 2],
    [12, 65, 1.5], [13.5, 62, 0.5], [14, 58, 2],
    [16, 60, 1], [17, 63, 1], [18, 67, 1], [19, 72, 1, 0.95],
    [20, 68, 1.5], [21.5, 67, 0.5], [22, 65, 2],
    [24, 62, 1], [25, 59, 1], [26, 55, 1.5, 0.9], [27.5, 59, 0.5],
    [28, 60, 3, 0.95]
  ]

  const kickN: SongNote[] = []
  const snareN: SongNote[] = []
  for (let bar = 0; bar < 8; bar++) {
    const b = bar * 4
    kickN.push([b, 36, 0.2, 1], [b + 2, 36, 0.2, 0.85], [b + 3.5, 36, 0.15, 0.55])
    snareN.push([b + 2, 38, 0.2, 0.85])
    // drag roll into the next downbeat
    snareN.push(
      [b + 3.25, 38, 0.1, 0.45], [b + 3.5, 38, 0.1, 0.55], [b + 3.75, 38, 0.1, 0.7]
    )
  }

  // Anvil on beat 2 of bars 1/3/5/7: bright bell ping + metallic noise clink.
  const anvilBellN: SongNote[] = []
  const anvilClinkN: SongNote[] = []
  for (const bar of [0, 2, 4, 6]) {
    anvilBellN.push([bar * 4 + 2, 88, 0.5, 0.5])
    anvilClinkN.push([bar * 4 + 2, 86, 0.1, 0.5])
  }

  const droneN: SongNote[] = []
  roots.forEach((r, bar) => droneN.push([bar * 4, r + 12, 3.8, 0.5]))

  const tracks: SongTrack[] = [
    { inst: 'saw', vol: 0.6, notes: themeN },
    { inst: 'organ', vol: 0.5, notes: organN },
    { inst: 'choirish', vol: 0.45, notes: droneN },
    { inst: 'bass', vol: 0.95, notes: bassN },
    { inst: 'kick', vol: 0.95, notes: kickN },
    { inst: 'snare', vol: 0.6, notes: snareN },
    { inst: 'bell', vol: 0.5, notes: anvilBellN },
    { inst: 'noise', vol: 0.45, notes: anvilClinkN }
  ]
  return { id: 'boss_ironhold', bpm: 92, loopBeats: 32, tracks }
}

// ===========================================================================
// 'boss_ashen' — rattling bone waltz. A harmonic minor, 3/4 at 162 BPM,
// 16 bars (48 beats, ~18s). Oom-pah-pah with a xylophone-ish pluck melody,
// bone clicks (high noise) and hat rattles.
// ===========================================================================

function ashenSong(): Song {
  // Per-bar roots: Am×4 | Dm Dm Am Am | E E Am Am | Dm E Am Am
  const roots = [45, 45, 45, 45, 50, 50, 45, 45, 40, 40, 45, 45, 50, 40, 45, 45]
  const triadOf = (root: number): number[] =>
    root === 50 ? [57, 62, 65] : root === 40 ? [56, 59, 64] : [57, 60, 64]

  const bassN: SongNote[] = []
  const pahN: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 3
    bassN.push([b, r, 0.9, 0.9])
    const t = triadOf(r)
    chord(pahN, b + 1, t, 0.4, 0.55)
    chord(pahN, b + 2, t, 0.4, 0.45)
  })

  const melN: SongNote[] = [
    [0, 69, 1], [1, 72, 1], [2, 71, 1],
    [3, 72, 1], [4, 76, 1], [5, 74, 1],
    [6, 76, 0.5], [6.5, 77, 0.5], [7, 76, 1], [8, 74, 1],
    [9, 72, 2], [11, 69, 1],
    [12, 74, 1], [13, 77, 1], [14, 76, 1],
    [15, 74, 1], [16, 72, 1], [17, 71, 1],
    [18, 72, 2], [20, 69, 1],
    [21, 71, 1], [22, 68, 1], [23, 64, 1],
    [24, 68, 1], [25, 71, 1], [26, 74, 1],
    [27, 76, 2], [29, 74, 1],
    [30, 72, 1], [31, 69, 1], [32, 72, 1],
    [33, 76, 2, 0.9], [35, 74, 1],
    [36, 77, 1], [37, 74, 1], [38, 71, 1],
    [39, 68, 1], [40, 71, 1], [41, 74, 1],
    [42, 76, 1], [43, 72, 1], [44, 69, 1],
    [45, 69, 2, 0.9], [47, 68, 1, 0.7]
  ]

  // Sparse bell doubling on the long held notes — ghostly music-box sheen.
  const bellN: SongNote[] = [
    [9, 84, 2, 0.35], [18, 84, 2, 0.3], [27, 88, 2, 0.35], [33, 88, 2, 0.35],
    [45, 81, 2, 0.3]
  ]

  // Bone rattles: dry clicks on the "and" of pah-2, bursts every 4th bar.
  const clickN: SongNote[] = []
  const hatN: SongNote[] = []
  roots.forEach((_, bar) => {
    const b = bar * 3
    if (bar % 2 === 0) clickN.push([b + 2.5, 92, 0.08, 0.4])
    hatN.push([b + 1, 42, 0.08, 0.3], [b + 2, 42, 0.08, 0.3])
    if (bar % 4 === 3) {
      for (let i = 0; i < 3; i++) hatN.push([b + 2 + i * 0.25, 42, 0.07, 0.45])
    }
  })

  const tracks: SongTrack[] = [
    { inst: 'pluck', vol: 0.85, notes: melN },
    { inst: 'bell', vol: 0.4, notes: bellN },
    { inst: 'pluck', vol: 0.5, notes: pahN },
    { inst: 'bass', vol: 0.85, notes: bassN },
    { inst: 'noise', vol: 0.5, notes: clickN },
    { inst: 'hat', vol: 0.45, notes: hatN }
  ]
  return { id: 'boss_ashen', bpm: 162, loopBeats: 48, tracks }
}

// ===========================================================================
// 'boss_forgotten' — war-chant stomp. D phrygian, 104 BPM, 8 bars (~18.5s).
// Stomp-stomp-CLAP drums, a low voiced chant that gains a parallel fifth in
// the back half, saw power chords and a war-horn organ. A battle-cry lead
// answers in bars 5–8.
// ===========================================================================

function forgottenSong(): Song {
  // Per-bar roots (octave 2): D D Eb D | D F Eb C
  const roots = [38, 38, 39, 38, 38, 41, 39, 36]

  const kickN: SongNote[] = []
  const snareN: SongNote[] = []
  for (let bar = 0; bar < 8; bar++) {
    const b = bar * 4
    kickN.push([b, 36, 0.2, 1], [b + 1, 36, 0.2, 0.95])
    snareN.push([b + 2, 38, 0.2, 0.9])
    if (bar % 2 === 1) kickN.push([b + 3.5, 36, 0.15, 0.6])
  }

  const bassN: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    const vels = [0.9, 0.6, 0.75, 0.6]
    for (let q = 0; q < 4; q++) bassN.push([b + q, r, 0.8, vels[q] ?? 0.6])
  })

  const chordN: SongNote[] = []
  roots.forEach((r, bar) => {
    const b = bar * 4
    chord(chordN, b, [r + 12, r + 19], 0.75, 0.7)
    chord(chordN, b + 2, [r + 12, r + 19], 0.75, 0.6)
  })

  // Chant: 16-beat phrase stated twice (quarter-note grunts, D–Eb–F–C).
  const chantPhrase: SongNote[] = [
    [0, 50, 1, 0.8], [1, 50, 0.75, 0.6], [2, 51, 1, 0.75], [3, 50, 1, 0.65],
    [4, 50, 1, 0.8], [5, 53, 1, 0.75], [6, 51, 2, 0.8],
    [8, 50, 1, 0.8], [9, 50, 0.75, 0.6], [10, 51, 1, 0.75], [11, 53, 1, 0.7],
    [12, 51, 1, 0.8], [13, 50, 1, 0.7], [14, 48, 2, 0.8]
  ]
  const chantN: SongNote[] = []
  at(chantN, 0, chantPhrase)
  at(chantN, 16, chantPhrase)
  // parallel fifth joins the second statement
  for (const n of chantPhrase) chantN.push([n[0] + 16, n[1] + 7, n[2], (n[3] ?? 0.8) * 0.8])

  const hornN: SongNote[] = [
    [0, 62, 3.5, 0.75], [8, 63, 3.5, 0.75], [16, 62, 3.5, 0.8],
    [24, 65, 2, 0.8], [26, 63, 2, 0.8]
  ]

  const cryN: SongNote[] = [
    [16, 74, 0.5, 0.9], [16.5, 74, 0.5, 0.7], [17, 75, 1, 0.9], [18, 74, 1],
    [19, 72, 1], [20, 74, 2, 0.95],
    [24, 75, 0.5], [24.5, 75, 0.5], [25, 77, 1], [26, 75, 1], [27, 74, 1],
    [28, 72, 1], [29, 74, 3, 0.9]
  ]

  const tracks: SongTrack[] = [
    { inst: 'choirish', vol: 0.65, notes: chantN },
    { inst: 'pulse25', vol: 0.55, notes: cryN },
    { inst: 'organ', vol: 0.5, notes: hornN },
    { inst: 'saw', vol: 0.45, notes: chordN },
    { inst: 'bass', vol: 0.9, notes: bassN },
    { inst: 'kick', vol: 1, notes: kickN },
    { inst: 'snare', vol: 0.7, notes: snareN }
  ]
  return { id: 'boss_forgotten', bpm: 104, loopBeats: 32, tracks }
}

// ===========================================================================
// Stingers — Song-format one-shots, played once through the sfx bus.
// ===========================================================================

/** Sfx bus runs hotter than music (trims 0.9 vs 0.6) — sit stingers back. */
const STINGER_TRIM = 0.7

/** Wrap a Song as a one-shot SFX recipe: schedule every note exactly once. */
function stingerRecipe(song: Song): SfxRecipe {
  return (ctx, bus, { vel, pitch }) => {
    const spb = 60 / song.bpm
    const t0 = ctx.currentTime + 0.02
    const semis = pitch === 1 ? 0 : Math.round(12 * Math.log2(pitch))
    for (const tr of song.tracks) {
      const inst = getInstrument(tr.inst)
      if (!inst) continue
      const g = ctx.createGain()
      g.gain.value = (tr.vol ?? 1) * STINGER_TRIM * vel
      g.connect(bus)
      let lastEnd = 0
      for (const n of tr.notes) {
        const t = t0 + n[0] * spb
        const dur = Math.max(0.03, n[2] * spb)
        inst(ctx, g, { midi: n[1] + semis, t, dur, vel: n[3] ?? 0.8 })
        lastEnd = Math.max(lastEnd, n[0] * spb + dur)
      }
      // Instruments reap their own nodes; reclaim the track gain afterwards.
      window.setTimeout(() => {
        try {
          g.disconnect()
        } catch {
          /* already gone */
        }
      }, (lastEnd + 3) * 1000)
    }
  }
}

/** 'levelup' — triumphant: sparkle run into a C-major fanfare chord. */
function levelupSong(): Song {
  const run: SongNote[] = [
    [0, 72, 0.2, 0.7], [0.25, 76, 0.2, 0.75], [0.5, 79, 0.2, 0.8],
    [0.75, 83, 0.2, 0.85], [1, 86, 0.3, 0.9]
  ]
  const fanfare: SongNote[] = [
    [1, 79, 0.5, 0.85], [1.5, 79, 0.25, 0.7], [1.75, 79, 0.25, 0.7],
    [2, 84, 2.5, 0.95]
  ]
  const organN: SongNote[] = []
  chord(organN, 2, [60, 64, 67, 72], 2.5, 0.7)
  const bells: SongNote[] = [[2, 96, 3, 0.5], [2.5, 91, 2, 0.4]]
  return {
    id: 'levelup',
    bpm: 150,
    loopBeats: 6,
    tracks: [
      { inst: 'pluck', vol: 0.8, notes: run },
      { inst: 'square', vol: 0.75, notes: fanfare },
      { inst: 'organ', vol: 0.6, notes: organN },
      { inst: 'bell', vol: 0.5, notes: bells },
      { inst: 'kick', vol: 0.7, notes: [[0, 36, 0.2, 0.8]] },
      { inst: 'snare', vol: 0.5, notes: [[2, 38, 0.2, 0.7]] },
      { inst: 'hat', vol: 0.4, notes: [[2, 42, 0.4, 0.5]] }
    ]
  }
}

/** 'quest_accept' — short rising "off we go" (F → G, unresolved on purpose). */
function questAcceptSong(): Song {
  const arp: SongNote[] = [
    [0, 65, 0.25, 0.7], [0.25, 69, 0.25], [0.5, 72, 0.25], [0.75, 77, 0.25],
    [1, 67, 0.25, 0.75], [1.25, 71, 0.25], [1.5, 74, 0.25], [1.75, 79, 0.5, 0.85]
  ]
  const organN: SongNote[] = []
  chord(organN, 0, [65, 69, 72], 1, 0.65)
  chord(organN, 1, [67, 71, 74], 1.5, 0.7)
  return {
    id: 'quest_accept',
    bpm: 132,
    loopBeats: 4,
    tracks: [
      { inst: 'pluck', vol: 0.8, notes: arp },
      { inst: 'organ', vol: 0.55, notes: organN },
      { inst: 'bell', vol: 0.45, notes: [[2, 86, 1.5, 0.5]] }
    ]
  }
}

/** 'quest_complete' — a proper resolved cadence (F → G → C). */
function questCompleteSong(): Song {
  const mel: SongNote[] = [
    [0, 76, 0.5, 0.85], [0.5, 74, 0.5, 0.8], [1, 72, 0.5, 0.8],
    [1.5, 74, 0.5, 0.8], [2, 79, 2.5, 0.95]
  ]
  const organN: SongNote[] = []
  chord(organN, 0, [65, 69, 72], 1, 0.6)
  chord(organN, 1, [67, 71, 74], 1, 0.6)
  chord(organN, 2, [72, 76, 79, 84], 3, 0.7)
  const bells: SongNote[] = [[2, 88, 2.5, 0.55], [2.5, 84, 2, 0.4]]
  return {
    id: 'quest_complete',
    bpm: 126,
    loopBeats: 6,
    tracks: [
      { inst: 'triangle', vol: 0.8, notes: mel },
      { inst: 'organ', vol: 0.55, notes: organN },
      { inst: 'bell', vol: 0.5, notes: bells },
      { inst: 'kick', vol: 0.6, notes: [[2, 36, 0.2, 0.7]] }
    ]
  }
}

/** 'death' — comedic sad trombone: chromatic saw slide down + final splat. */
function deathSong(): Song {
  const trombone: SongNote[] = [
    [0, 64, 0.9, 0.85], [1, 63, 0.9, 0.8], [2, 62, 0.9, 0.8],
    [3, 61, 3.5, 0.9] // long last note — the built-in vibrato does the "waaah"
  ]
  // mopey C#m pad under the final note
  const padN: SongNote[] = []
  chord(padN, 3, [49, 52, 56], 3.5, 0.5)
  const splat: SongNote[] = [[6.5, 30, 0.3, 0.9]]
  const tuba: SongNote[] = [[6.5, 37, 1.2, 0.85]]
  return {
    id: 'death',
    bpm: 86,
    loopBeats: 8,
    tracks: [
      { inst: 'saw', vol: 0.85, notes: trombone },
      { inst: 'pad', vol: 0.6, notes: padN },
      { inst: 'bass', vol: 0.8, notes: tuba },
      { inst: 'kick', vol: 0.8, notes: splat }
    ]
  }
}

/** 'pet_drop' — jackpot sparkle: triple ding, pentatonic cascade, big chord. */
function petDropSong(): Song {
  const dings: SongNote[] = [
    [0, 88, 0.3, 0.8], [0.5, 88, 0.3, 0.85], [1, 88, 0.5, 0.9]
  ]
  const run: SongNote[] = []
  const pent = [72, 74, 76, 79, 81, 84, 86, 88, 91, 93]
  pent.forEach((m, i) => run.push([1.5 + i * 0.25, m, 0.15, 0.6 + i * 0.03]))
  const finale: SongNote[] = [[4, 96, 2, 0.9], [4.5, 100, 1, 0.4], [5, 98, 1.5, 0.35]]
  const organN: SongNote[] = []
  chord(organN, 4, [72, 76, 79, 84], 2, 0.65)
  return {
    id: 'pet_drop',
    bpm: 150,
    loopBeats: 8,
    tracks: [
      { inst: 'bell', vol: 0.6, notes: [...dings, ...finale] },
      { inst: 'pluck', vol: 0.75, notes: run },
      { inst: 'organ', vol: 0.5, notes: organN },
      { inst: 'hat', vol: 0.4, notes: [[4, 42, 0.6, 0.5]] },
      { inst: 'kick', vol: 0.6, notes: [[4, 36, 0.2, 0.8]] }
    ]
  }
}

/** 'waystone_travel' — whoosh: rising noise sweep + whole-tone arpeggio up. */
function waystoneTravelSong(): Song {
  const whoosh: SongNote[] = []
  for (let k = 0; k < 8; k++) {
    whoosh.push([k * 0.25, 55 + 5 * k, 0.3, 0.3 + 0.05 * k])
  }
  const arp: SongNote[] = [
    [0, 62, 0.25, 0.6], [0.5, 66, 0.25, 0.65], [1, 70, 0.25, 0.7],
    [1.5, 74, 0.25, 0.75], [1.75, 78, 0.25, 0.8], [2, 82, 0.5, 0.85]
  ]
  const arrive: SongNote[] = [[2.5, 94, 2, 0.6], [3, 89, 1.5, 0.45]]
  const padN: SongNote[] = [[2.5, 62, 2.5, 0.5], [2.5, 69, 2.5, 0.4]]
  return {
    id: 'waystone_travel',
    bpm: 140,
    loopBeats: 6,
    tracks: [
      { inst: 'noise', vol: 0.6, notes: whoosh },
      { inst: 'pluck', vol: 0.7, notes: arp },
      { inst: 'bell', vol: 0.5, notes: arrive },
      { inst: 'pad', vol: 0.55, notes: padN }
    ]
  }
}

/** 'mint_success' — crypto-chime fanfare: shiny, major, faintly smug. */
function mintSuccessSong(): Song {
  const fanfare: SongNote[] = [
    [0, 79, 0.25, 0.8], [0.25, 84, 0.25, 0.8], [0.5, 88, 0.5, 0.9],
    [1, 88, 0.25, 0.7], [1.25, 88, 0.25, 0.7], [1.5, 91, 1.5, 0.95]
  ]
  const coins: SongNote[] = [
    [0.5, 100, 0.5, 0.5], [1.5, 103, 2, 0.5], [3, 96, 2, 0.5], [3.5, 100, 1.5, 0.4]
  ]
  const organN: SongNote[] = []
  chord(organN, 1.5, [72, 76, 79, 84], 2, 0.55)
  const bassN: SongNote[] = [[0, 48, 0.5, 0.7], [1.5, 48, 1.5, 0.8]]
  return {
    id: 'mint_success',
    bpm: 128,
    loopBeats: 8,
    tracks: [
      { inst: 'square', vol: 0.7, notes: fanfare },
      { inst: 'bell', vol: 0.55, notes: coins },
      { inst: 'organ', vol: 0.5, notes: organN },
      { inst: 'bass', vol: 0.7, notes: bassN },
      { inst: 'hat', vol: 0.35, notes: [[1.5, 42, 0.5, 0.5]] }
    ]
  }
}

/** 'gold_purchase' — short ka-ching: coin flip up + confirming chord. */
function goldPurchaseSong(): Song {
  const coin: SongNote[] = [
    [0, 95, 0.3, 0.75], [0.25, 100, 1.2, 0.85], [1, 88, 1.5, 0.5]
  ]
  const organN: SongNote[] = []
  chord(organN, 0.5, [76, 79, 83], 1, 0.5)
  return {
    id: 'gold_purchase',
    bpm: 140,
    loopBeats: 4,
    tracks: [
      { inst: 'bell', vol: 0.6, notes: coin },
      { inst: 'noise', vol: 0.4, notes: [[0, 98, 0.08, 0.5]] },
      { inst: 'bass', vol: 0.65, notes: [[0.5, 52, 0.5, 0.7]] },
      { inst: 'organ', vol: 0.45, notes: organN }
    ]
  }
}

// ---------------------------------------------------------------------------
// Registration + exports
// ---------------------------------------------------------------------------

/** Looping dynamic songs — play via `audio.playSong(id)`. */
export const DYNAMIC_SONG_IDS = [
  'combat',
  'boss_greenwood',
  'boss_ironhold',
  'boss_ashen',
  'boss_forgotten'
] as const
export type DynamicSongId = (typeof DYNAMIC_SONG_IDS)[number]

/** One-shot stingers — play via `playStinger(id)` (NOT audio.playSong). */
export const STINGER_IDS = [
  'levelup',
  'quest_complete',
  'quest_accept',
  'death',
  'pet_drop',
  'waystone_travel',
  'mint_success',
  'gold_purchase'
] as const
export type StingerId = (typeof STINGER_IDS)[number]

registerSong(combatSong())
registerSong(greenwoodSong())
registerSong(ironholdSong())
registerSong(ashenSong())
registerSong(forgottenSong())

for (const s of [
  levelupSong(),
  questCompleteSong(),
  questAcceptSong(),
  deathSong(),
  petDropSong(),
  waystoneTravelSong(),
  mintSuccessSong(),
  goldPurchaseSong()
]) {
  registerSfx(s.id, stingerRecipe(s))
}

/**
 * Fire a musical stinger once, on top of whatever music is playing.
 * `pitch` is a multiplier (quantized to semitones), `vel` 0..1 loudness.
 */
export function playStinger(
  id: StingerId,
  opts?: { vel?: number; pitch?: number }
): void {
  audio.sfx.play(id, opts)
}
