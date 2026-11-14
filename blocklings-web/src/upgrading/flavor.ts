/**
 * Upgrading — comedy lines for the Anvil of Ascension. Mature cartoon tone,
 * no slurs / nothing sexual. Picked at random by the module on each outcome.
 */

function pick(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)] ?? pool[0] ?? ''
}

const UPGRADE_OK: readonly string[] = [
  'CLANG. The metal files a noise complaint. Your gear files a glow-up.',
  'Sparks, smoke, and a suspicious smell of success. +1 it is.',
  'The anvil approves. The anvil does not applaud. The anvil has no hands.',
  'Tempered, hammered, and slightly judged. Stronger now.',
  'That hit so hard the item briefly questioned its whole identity. In a good way.'
]

const UPGRADE_FAIL: readonly string[] = [
  'The forge coughed, ate half your mats, and gave you nothing. Rude, but fair.',
  'Almost! The item wobbled, considered it, and said "no thanks." Mats gone.',
  'A spectacular failure. Loud, smoky, educational. Your + stayed put, your mats did not.',
  'The anvil sneezed at the worst moment. Some mats are now vapor. The gear survives.',
  'Physics said yes. Luck said "lol no." Partial mats consumed; nothing broke.'
]

const UPGRADE_MAX: readonly string[] = [
  'This is +10. The ceiling. The summit. There is no +11; stop poking it.',
  'Maxed out. The item is now legally too cool to improve further.'
]

const ENCHANT_OK: readonly string[] = [
  'Runes etched. The item hums a tune only it finds impressive.',
  'Enchantment seated. It now glows just enough to annoy stealth builds.',
  'Magic word muttered, crystal consumed, effect applied. No refunds.',
  'The glyphs took. Your gear is now 100% more likely to be described as "fancy."'
]

const ENCHANT_FULL: readonly string[] = [
  'Both sockets are full. Even magic respects a two-drink minimum.',
  'No free slot. This item is enchanted to capacity and smug about it.'
]

const REFORGE_OK: readonly string[] = [
  'Reforged. Same budget, new personality. Bold of you to gamble.',
  'The stats got shuffled like a deck of cards by a nervous dealer. Enjoy.',
  'Rerolled. Fate shrugged, rolled dice, and handed you THIS spread.',
  'The anvil redistributed your numbers with the confidence of a bad accountant.'
]

const NO_MATS: readonly string[] = [
  'Not enough materials. The anvil is a professional, not a charity.',
  'Come back when your pockets clink. Mats missing.',
  'The forge glanced at your mats, then at you, then said nothing. (You need more.)'
]

export const line = {
  upgradeOk: () => pick(UPGRADE_OK),
  upgradeFail: () => pick(UPGRADE_FAIL),
  upgradeMax: () => pick(UPGRADE_MAX),
  enchantOk: () => pick(ENCHANT_OK),
  enchantFull: () => pick(ENCHANT_FULL),
  reforgeOk: () => pick(REFORGE_OK),
  noMats: () => pick(NO_MATS)
}
