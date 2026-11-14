/**
 * Blocklings — ambient-bed registry mechanics.
 *
 * An ambient bed is a looping generative recipe: given the context and a bus
 * (a per-bed gain the engine crossfades), it builds continuously-running
 * nodes and returns a handle the engine calls to stop the sources once the
 * bed has been faded out. Bed CONTENT lives in ambient-defs.ts (owned by the
 * ambience content agent).
 *
 * Switch beds through the engine: `audio.ambient.set('wind', { fade: 3 })`,
 * `audio.ambient.set(null)` for silence.
 */

/** Returned by a bed; `stop(t)` must stop every started source at time t. */
export interface AmbientHandle {
  stop(t: number): void
}

/**
 * A looping generative recipe. Build sources/filters/LFOs into `bus`, start
 * them immediately, and return a handle that stops all sources. The engine
 * owns `bus` (crossfade + disconnect) — do not disconnect it yourself.
 */
export type AmbientBed = (ctx: AudioContext, bus: AudioNode) => AmbientHandle

const beds = new Map<string, AmbientBed>()

export function registerAmbient(name: string, bed: AmbientBed): void {
  beds.set(name, bed)
}

export function getAmbient(name: string): AmbientBed | undefined {
  return beds.get(name)
}

export function ambientNames(): string[] {
  return [...beds.keys()]
}
