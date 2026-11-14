/**
 * Deterministic seeded RNG (mulberry32) so the village is identical for
 * every player on every load — important once multiplayer ships.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number
  /** Integer in [0, n). */
  int(n: number): number
  /** Float in [min, max). */
  range(min: number, max: number): number
  /** Random element of a non-empty array. */
  pick<T>(arr: readonly T[]): T
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0
  const next = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    range: (min: number, max: number) => min + next() * (max - min),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T
  }
}
