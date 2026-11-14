/**
 * Blocklings — audio module shim.
 *
 * Re-exports the audio engine surface so callers outside src/audio can
 * `import { audio } from './audio'` (or deeper modules
 * `import { audio } from '../audio/engine'` — the sanctioned exception).
 */
export { audio } from './audio/engine'
export type { Song, SongTrack, SongNote } from './audio/sequencer'
export { registerSong, getSong, songIds, DEMO_SONG_ID } from './audio/songbook'
export {
  registerInstrument,
  getInstrument,
  instrumentNames,
  midiToFreq,
  whiteNoiseBuffer,
  pinkNoiseBuffer
} from './audio/instruments'
export type { Instrument, NoteEvent } from './audio/instruments'
export { registerSfx, sfxNames } from './audio/sfx-core'
export type { SfxRecipe, SfxOpts } from './audio/sfx-core'
export { registerAmbient, ambientNames } from './audio/ambient-core'
export type { AmbientBed, AmbientHandle } from './audio/ambient-core'
export { initAmbience } from './audio/ambience'
export type { AmbienceAPI } from './audio/ambience'
