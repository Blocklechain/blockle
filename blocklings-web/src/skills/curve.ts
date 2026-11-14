/**
 * Blocklings skills — the XP curve.
 *
 * RS-flavored: gently exponential, levels 1..99. The cost of a level
 * bracket doubles every 10 levels:
 *
 *   bracketCost(L) = floor(100 * 2^((L - 1) / 10))   // XP from L -> L+1
 *
 *   L1 -> 2 : 100 xp        L50 -> 51 : 2,985 xp
 *   L10->11 : 186 xp        L75 -> 76 : 16,889 xp
 *   L25->26 : 527 xp        L98 -> 99 : 83,174 xp
 *
 * Total XP for 99 = 1,240,582 per skill (half of it after level 90) —
 * a long grind, not a second job.
 */

export const MAX_LEVEL = 99

/** XP needed to climb from `level` to `level + 1` (0 at the cap). */
export function bracketCost(level: number): number {
  if (level < 1 || level >= MAX_LEVEL) return 0
  return Math.floor(100 * Math.pow(2, (level - 1) / 10))
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

/** Total XP required to have reached `level` (clamped 1..99). */
export function xpForLevel(level: number): number {
  const lvl = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)))
  return THRESHOLDS[lvl]!
}

/** Hard cap on stored XP (the level-99 threshold). */
export const XP_CAP = xpForLevel(MAX_LEVEL)

/** Level for a total-XP amount (1..99). */
export function levelForXp(xp: number): number {
  const x = Math.max(0, xp)
  // 99 entries — linear scan is instant and obviously correct.
  for (let lvl = MAX_LEVEL; lvl >= 2; lvl--) {
    if (x >= THRESHOLDS[lvl]!) return lvl
  }
  return 1
}

/** Progress inside the current bracket: xp earned + bracket size. */
export function bracketProgress(xp: number): { level: number; into: number; size: number } {
  const level = levelForXp(xp)
  if (level >= MAX_LEVEL) return { level, into: 0, size: 0 }
  return { level, into: Math.max(0, xp - xpForLevel(level)), size: bracketCost(level) }
}
