/**
 * Blocklings prestige — total-star milestones: cosmetic titles + aura tiers.
 *
 * Total Mastery = the sum of every skill's stars. As it crosses 5 / 10 / 20 /
 * 50 the player earns a title (shown on the Mastery flex) and the character
 * lights up with an ever-gaudier prestige aura. Aura tier 0 = none.
 */

export interface Milestone {
  /** Total stars required. */
  stars: number
  /** Cosmetic title (comedy register, clean). */
  title: string
  /** Aura tier granted at this milestone (1..4). */
  aura: 1 | 2 | 3 | 4
  /** Aura colour (hex) — fed to the rig/aura sink. */
  color: number
  /** One-line toast when first crossed. */
  toast: string
}

/** Ascending; the highest reached one wins. */
export const MILESTONES: readonly Milestone[] = [
  {
    stars: 5,
    title: 'Glutton for Punishment',
    aura: 1,
    color: 0xcd7f32, // bronze
    toast: '5 Mastery stars. You reset a 99 FIVE times. On purpose. A bronze glow now follows you around, judging you.'
  },
  {
    stars: 10,
    title: 'Certified Repeat Offender',
    aura: 2,
    color: 0xc0c7d0, // silver
    toast: '10 Mastery stars! Your aura upgraded to silver and your free time filed a missing-person report.'
  },
  {
    stars: 20,
    title: 'The Grind Stares Back',
    aura: 3,
    color: 0xe8c15a, // gold
    toast: '20 Mastery stars. Golden aura unlocked. Somewhere a therapist senses a disturbance and raises their rates.'
  },
  {
    stars: 50,
    title: 'Ascended Beyond All Reason',
    aura: 4,
    color: 0xb48cff, // prismatic violet
    toast: '50 Mastery stars. You are now legally a landmark. The prismatic aura is permanent. So, apparently, are you.'
  }
] as const

/** The milestone currently satisfied by `totalStars`, or null below the first. */
export function reachedMilestone(totalStars: number): Milestone | null {
  let best: Milestone | null = null
  for (const m of MILESTONES) if (totalStars >= m.stars) best = m
  return best
}

/** Aura tier (0 = none) for a total-star count. */
export function auraTier(totalStars: number): 0 | 1 | 2 | 3 | 4 {
  return reachedMilestone(totalStars)?.aura ?? 0
}

/** Aura colour for a total-star count, or null when no aura yet. */
export function auraColor(totalStars: number): number | null {
  return reachedMilestone(totalStars)?.color ?? null
}

/** Current title, or a snarky default below the first milestone. */
export function masteryTitle(totalStars: number): string {
  return reachedMilestone(totalStars)?.title ?? (totalStars > 0 ? 'Dabbling in Regret' : 'Blissfully Unmastered')
}
