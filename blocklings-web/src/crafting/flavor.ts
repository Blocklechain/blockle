/**
 * Crafting flavor — the comedy layer. Mature-cartoon register: mean to life
 * choices, never to people. Locked rows get a quip, successes occasionally
 * gloat, and the stove failures are documented honestly.
 */
import type { CraftSkill } from './recipes'

const LOCKED: Record<CraftSkill, readonly string[]> = {
  blacksmithing: [
    'The anvil has standards. Currently: not you.',
    'Metallurgy is just spicy patience. Earn more patience.',
    'The forge respects you. The recipe does not. Yet.',
    'Come back when your hammer arm has a résumé.'
  ],
  cooking: [
    'The recipe saw your knife skills and locked itself.',
    'Legally, this dish requires adult supervision. Become the adult.',
    'The stove believes in you. The ingredients voted no.',
    'Flavor this advanced has a waiting list.'
  ],
  alchemy: [
    'This brew requires a license you have not exploded enough to earn.',
    'The cauldron read your notes and filed a complaint.',
    'Mix this now and the fumes write your eulogy.',
    'Chemistry is earned, one singed eyebrow at a time.'
  ],
  tailoring: [
    'The pattern is in a language your thimble cannot read yet.',
    'This stitch has prerequisites. And opinions.',
    'The loom remembers your last hem. It needs time.',
    'Fashion this advanced can cause injuries. Mostly social.'
  ]
}

const SUCCESS: Record<CraftSkill, readonly string[]> = {
  blacksmithing: [
    'The anvil nods, imperceptibly. Highest honor there is.',
    'Still warm. Resist the urge to hug it.',
    'Forged! The hammer would like a raise.'
  ],
  cooking: [
    'Edible AND intentional. Growth.',
    'The smoke alarm stayed silent. A love letter.',
    'Cooked through. The mystery remains, the salmonella does not.'
  ],
  alchemy: [
    'It is the right color. Probably the right potion.',
    'Bottled! Label it before future-you gambles.',
    'The cauldron burps approvingly.'
  ],
  tailoring: [
    'Seams straight, dignity intact.',
    'Stitched! The runway is a battlefield and you just armed it.',
    'Not a single pin left in it. Allegedly.'
  ]
}

const BURNT: readonly string[] = [
  'That is not seasoning. That is carbon.',
  'The recipe said "golden brown", not "forensic evidence".',
  'You invented a new material. It is called regret.',
  'Dinner has been downgraded to a warning.'
]

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function lockedLine(skill: CraftSkill): string {
  return pick(LOCKED[skill])
}

/** ~1 in 4 successful crafts gets a gloat (keeps chat from drowning). */
export function maybeSuccessLine(skill: CraftSkill): string | null {
  return Math.random() < 0.25 ? pick(SUCCESS[skill]) : null
}

export function burntLine(): string {
  return pick(BURNT)
}
