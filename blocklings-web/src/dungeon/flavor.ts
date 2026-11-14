/**
 * Trial of the Deep — comedy copy. Mature cartoon tone, nothing crude.
 */

const ENTER_LINES = [
  'The Trial of the Deep. Endless waves, questionable life choices.',
  'Something down there is very excited to meet you. Bring a sword.',
  'The Deep does not offer refunds, exits, or emotional support.'
]

const WAVE_QUIPS = [
  'They keep coming. Rude.',
  'More of them. Fewer of you. Classic Deep.',
  "The Deep catered this. It's all monsters. The monsters are the snacks.",
  'Reinforcements! For them. You get vibes.',
  'Another wave. The Deep has commitment issues in your favor, somehow not.'
]

const MINI_LINES = [
  'A bigger one shows up, wearing a tiny crown of spite.',
  'Mini-boss! Same energy, more health bar.',
  'Something mid-sized and furious has entered the chat.'
]

const BOSS_LINES = [
  'The floor rumbles. The Deep sends its regards, and its biggest guy.',
  'BOSS WAVE. Everyone else was the opening act.',
  'A truly load-bearing monster arrives. Mind the fists.'
]

const CLEAR_LINES = [
  'Wave cleared. The Deep is annoyed and impressed.',
  'Still alive. Statistically rude of you.',
  'Cleared it. Shards banked. Dignity: pending.'
]

const DEATH_LINES = [
  'The Deep wins this round. It always has more rounds.',
  'You fought bravely and briefly. Mostly briefly.',
  "Down you go. We'll bank what you earned; the Deep keeps the bruises."
]

const FLEE_LINES = [
  'You retreat up the stairs, rewards clutched to your chest like a raccoon.',
  'Tactical withdrawal. Very tactical. Totally not running.',
  'You leave the Deep. The Deep will be here. The Deep is patient.'
]

function pick(arr: readonly string[], rng: () => number): string {
  return arr[Math.floor(rng() * arr.length)] ?? arr[0] ?? ''
}

export const enterLine = (rng: () => number): string => pick(ENTER_LINES, rng)
export const waveQuip = (rng: () => number): string => pick(WAVE_QUIPS, rng)
export const miniLine = (rng: () => number): string => pick(MINI_LINES, rng)
export const bossLine = (rng: () => number): string => pick(BOSS_LINES, rng)
export const clearLine = (rng: () => number): string => pick(CLEAR_LINES, rng)
export const deathLine = (rng: () => number): string => pick(DEATH_LINES, rng)
export const fleeLine = (rng: () => number): string => pick(FLEE_LINES, rng)

/** Said once when a tier's cosmetic unlocks. */
export function cosmeticLine(title: string): string {
  return `First clear! You are now, officially and cosmetically, "${title}". A cape is involved.`
}
