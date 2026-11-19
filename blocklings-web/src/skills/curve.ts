/**
 * Blocklings skills — the XP curve.
 *
 * A smooth power curve, levels 1..999. The cost of a level bracket grows
 * polynomially instead of doubling, so the cumulative total never overflows
 * (an exponential doubling curve blows past Number.MAX_SAFE_INTEGER long
 * before 999 — this one tops out at a tidy ~9.9 billion):
 *
 *   bracketCost(L) = floor(80 * L^1.85)              // XP from L -> L+1
 *
 *   L1  -> 2  : 80 xp         L50  -> 51  : 111,220 xp
 *   L10 -> 11 : 5,663 xp      L99  -> 100 : 393,563 xp
 *   L25 -> 26 : 30,851 xp     L998 -> 999 : 28,280,135 xp
 *
 * Total XP for 99 = 13,474,943 per skill; total XP for 999 (XP_CAP) =
 * 9,917,152,857 — safely under 9e15, and small enough to print. A very
 * long grind, not a heat-death-of-the-universe one.
 */

export const MAX_LEVEL = 999

/** XP needed to climb from `level` to `level + 1` (0 at the cap). */
export function bracketCost(level: number): number {
  if (level < 1 || level >= MAX_LEVEL) return 0
  return Math.floor(80 * Math.pow(level, 1.85))
}

/** Cumulative XP threshold at which `level` is reached (level 1 = 0). */
const THRESHOLDS: number[] = (() => {
  const t: number[] = [0, 0] // index by level; [1] = 0
  let acc = 0
  for (let lvl = 1; lvl < MAX_LEVEL; lvl++) {
    acc += bracketCost(lvl)
    t[lvl + 1] = acc
  }
  return t
})()

/** Total XP required to have reached `level` (clamped 1..MAX_LEVEL). */
export function xpForLevel(level: number): number {
  const lvl = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)))
  return THRESHOLDS[lvl]!
}

/** Hard cap on stored XP (the MAX_LEVEL threshold). */
export const XP_CAP = xpForLevel(MAX_LEVEL)

/** Level for a total-XP amount (1..MAX_LEVEL). */
export function levelForXp(xp: number): number {
  const x = Math.max(0, xp)
  // Binary search over the monotonic THRESHOLDS table for the highest level
  // whose threshold is <= x. THRESHOLDS is indexed by level (1..MAX_LEVEL).
  let lo = 1
  let hi = MAX_LEVEL
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (x >= THRESHOLDS[mid]!) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Progress inside the current bracket: xp earned + bracket size. */
export function bracketProgress(xp: number): { level: number; into: number; size: number } {
  const level = levelForXp(xp)
  if (level >= MAX_LEVEL) return { level, into: 0, size: 0 }
  return { level, into: Math.max(0, xp - xpForLevel(level)), size: bracketCost(level) }
}
