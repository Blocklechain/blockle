/**
 * Blocklings — SFX registry mechanics.
 *
 * An SFX is a named synth recipe: a function that builds a one-shot WebAudio
 * graph into the sfx bus. Recipe CONTENT lives in sfx-defs.ts (owned by the
 * sfx content agent); this file is only the registry + trigger plumbing.
 *
 * Play through the engine: `audio.sfx.play('coin', { vel, pitch, pan })`.
 */

/** Options accepted by `audio.sfx.play`. */
export interface SfxOpts {
  /** Loudness 0..1 (default 1). */
  vel?: number
  /** Pitch multiplier, 1 = recipe's base pitch (default 1). */
  pitch?: number
  /** Stereo position -1..1 (default 0 = center). */
  pan?: number
}

/**
 * A synth recipe. Build oscillators/noise/envelopes into `bus`, start them at
 * `ctx.currentTime`, and stop/clean up your sources (use `src.onended` to
 * disconnect). `vel` is 0..1 loudness, `pitch` a frequency multiplier.
 */
export type SfxRecipe = (
  ctx: AudioContext,
  bus: AudioNode,
  opts: { vel: number; pitch: number }
) => void

const recipes = new Map<string, SfxRecipe>()
const warned = new Set<string>()

export function registerSfx(name: string, recipe: SfxRecipe): void {
  recipes.set(name, recipe)
}

export function getSfx(name: string): SfxRecipe | undefined {
  return recipes.get(name)
}

export function sfxNames(): string[] {
  return [...recipes.keys()]
}

/** Engine-internal trigger: resolves the recipe and applies panning. */
export function playSfx(
  ctx: AudioContext,
  bus: AudioNode,
  name: string,
  opts?: SfxOpts
): void {
  const recipe = recipes.get(name)
  if (!recipe) {
    if (!warned.has(name)) {
      warned.add(name)
      console.warn(`[audio] unknown sfx "${name}"`)
    }
    return
  }
  let dest: AudioNode = bus
  const pan = opts?.pan ?? 0
  if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner()
    p.pan.value = Math.min(1, Math.max(-1, pan))
    p.connect(bus)
    dest = p
    // One-shot SFX are short; reclaim the panner after they are surely done.
    window.setTimeout(() => {
      try {
        p.disconnect()
      } catch {
        /* fine */
      }
    }, 4000)
  }
  recipe(ctx, dest, {
    vel: Math.min(1, Math.max(0, opts?.vel ?? 1)),
    pitch: opts?.pitch ?? 1
  })
}
