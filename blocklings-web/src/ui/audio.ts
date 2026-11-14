/**
 * Blocklings — HUD audio manager (thin shim over the real audio engine).
 *
 * The Phase-1 placeholder oscillator pad is gone: this now delegates to
 * src/audio/engine (mixer + sequencer + synthesized instruments). The
 * exported surface and slider behavior are unchanged — volumes persist to
 * the same localStorage keys (blocklings.vol.music / blocklings.vol.sfx) and
 * the AudioContext still unlocks on the first user gesture.
 *
 * Until the soundtrack content lands, the engine's demo jingle starts on
 * unlock (if nothing else is playing) so the music slider stays audible.
 */
import { audio } from '../audio/engine'
import { DEMO_SONG_ID } from '../audio/songbook'

export class AudioManager {
  constructor() {
    audio.onUnlocked(() => {
      if (audio.currentSongId === null) {
        audio.playSong(DEMO_SONG_ID, { fade: 2 })
      }
    })
  }

  get music(): number {
    return audio.musicVolume
  }

  get sfx(): number {
    return audio.sfxVolume
  }

  setMusicVolume(v: number): void {
    audio.setMusicVolume(v)
  }

  setSfxVolume(v: number): void {
    audio.setSfxVolume(v)
  }

  /** Short, soft UI tick (button presses, chat send). */
  tick(freq = 660): void {
    audio.sfx.play('ui-tick', { pitch: freq / 660 })
  }
}
