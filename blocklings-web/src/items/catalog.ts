/**
 * Items — the full catalog (~130 ItemDefs).
 *
 * Id conventions follow src/ids.ts exactly:
 *   weapons  sword_<material>, axe_<material>, staff_<material>, bow_<material>
 *   armor    helm_/chest_/boots_<material>, shield_<material>
 *   tools    pick_<material>, hatchet_<material>, rod_basic...
 *   mats     ore_*, bar_*, wood_*, herb_*, fish_*, hide_*, crystal_*, wheat
 *   consum.  food_*, potion_*
 * Material ladder copper..mythic maps straight onto rarity tiers 0..5.
 */
import type { ItemDef, ItemSlot, Rarity } from '../types'
import { MATERIALS } from '../ids'

const MAT_NAME = ['Copper', 'Iron', 'Steel', 'Gold', 'Crystal', 'Mythic'] as const
const TIER_LEVEL = [1, 5, 10, 20, 30, 40] as const
const TIER_VALUE = [15, 45, 140, 450, 1500, 6000] as const

type Stats = NonNullable<ItemDef['stats']>
type SixStrings = readonly [string, string, string, string, string, string]

interface LadderSpec {
  kind: string
  slot: ItemSlot
  /** "Sword" -> "Copper Sword" etc. */
  noun: string
  valueMul: number
  stats: (t: number) => Stats
  descs: SixStrings
}

function ladder(spec: LadderSpec): ItemDef[] {
  return MATERIALS.map((mat, t) => ({
    id: `${spec.kind}_${mat}`,
    name: `${MAT_NAME[t]!} ${spec.noun}`,
    slot: spec.slot,
    rarity: t as Rarity,
    stats: spec.stats(t),
    levelReq: TIER_LEVEL[t]!,
    value: Math.round(TIER_VALUE[t]! * spec.valueMul),
    desc: spec.descs[t]!,
  }))
}

// Per-tier stat ramps (index = tier).
const SWORD_ATK = [4, 8, 14, 22, 32, 46] as const
const SWORD_STR = [1, 2, 3, 5, 7, 10] as const
const AXE_ATK = [5, 9, 16, 24, 35, 50] as const
const AXE_STR = [2, 3, 5, 7, 10, 14] as const
const STAFF_ATK = [3, 6, 11, 17, 26, 38] as const
const STAFF_INT = [3, 6, 10, 15, 22, 32] as const
const BOW_ATK = [4, 7, 13, 20, 30, 43] as const
const BOW_AGI = [2, 4, 6, 9, 13, 18] as const
const SHIELD_DEF = [3, 6, 10, 16, 24, 35] as const
const HELM_DEF = [2, 4, 7, 11, 17, 25] as const
const CHEST_DEF = [4, 8, 13, 20, 30, 44] as const
const BOOTS_DEF = [1, 3, 5, 8, 13, 19] as const
const BOOTS_AGI = [1, 1, 2, 3, 4, 6] as const
const TOOL_ATK = [2, 3, 5, 8, 12, 17] as const
const TOOL_STR = [1, 1, 2, 3, 4, 6] as const

const WEAPONS_AND_ARMOR: ItemDef[] = [
  ...ladder({
    kind: 'sword', slot: 'weapon', noun: 'Sword', valueMul: 2,
    stats: t => ({ atk: SWORD_ATK[t]!, str: SWORD_STR[t]! }),
    descs: [
      'Technically a sword. Also technically a large orange butter knife.',
      'Standard-issue stabbing iron. The goblins have filed several complaints.',
      'Sharp enough to shave with, if you hate your face.',
      'Soft metal, terrible edge, looks FABULOUS. Priorities.',
      'Hums when swung. The hum is mocking you, but beautifully.',
      'Forged in a dying star, or a very dramatic forge. Either way: ow.',
    ],
  }),
  ...ladder({
    kind: 'axe', slot: 'weapon', noun: 'Battleaxe', valueMul: 2,
    stats: t => ({ atk: AXE_ATK[t]!, str: AXE_STR[t]! }),
    descs: [
      'Chops wood, chops goblins. The axe does not judge. Much.',
      "The lumberjack's answer to most of life's problems.",
      'Swing first, apologize never.',
      'An absurdly expensive way to open skulls. Shiny, though.',
      'Every swing sounds like a wind chime having a violent episode.',
      'Legends say it once felled a god. The god had it coming.',
    ],
  }),
  ...ladder({
    kind: 'staff', slot: 'weapon', noun: 'Staff', valueMul: 2,
    stats: t => ({ atk: STAFF_ATK[t]!, int: STAFF_INT[t]! }),
    descs: [
      'A stick with delusions of grandeur. The delusions cast fireballs, so fine.',
      'Channels arcane power and doubles as a walking aid. Multiclass responsibly.',
      'The orb stares back. Try not to make it weird.',
      'Mostly bought by mages going through something.',
      'Charged with raw crystal mana. Do not lick. Again.',
      'Reality bends around it. Your chiropractor is thrilled.',
    ],
  }),
  ...ladder({
    kind: 'bow', slot: 'weapon', noun: 'Bow', valueMul: 2,
    stats: t => ({ atk: BOW_ATK[t]!, agi: BOW_AGI[t]! }),
    descs: [
      'Bends, twangs, occasionally fires where you aimed.',
      'For when you want the goblin dead but, like, from over there.',
      'Spring-steel limbs. The arrow arrives before the apology.',
      'A golden bow, because stealth was never the plan.',
      'Strings itself with solid light. Show-off.',
      "The arrow hits before you draw. Don't think about it too hard.",
    ],
  }),
  ...ladder({
    kind: 'shield', slot: 'shield', noun: 'Shield', valueMul: 1.5,
    stats: t => ({ def: SHIELD_DEF[t]! }),
    descs: [
      'Keeps the pointy things out of your soft things. Mostly.',
      "A big metal 'no thank you.'",
      'Hide behind it and reconsider your life choices in comfort.',
      'Blocks blows AND blinds attackers with your reflected wealth.',
      'Translucent, so you can watch exactly what almost killed you.',
      'It has stopped dragonfire. It is not impressed by your goblin.',
    ],
  }),
  ...ladder({
    kind: 'helm', slot: 'helm', noun: 'Helm', valueMul: 1.5,
    stats: t => ({ def: HELM_DEF[t]! }),
    descs: [
      'A copper bucket with aspirations. Your skull says thanks anyway.',
      'Protects the brain you keep making questionable choices with.',
      'Now with a plume! The plume does nothing. The plume is everything.',
      'Heavy, gaudy, magnificent. Like wearing a trophy for surviving.',
      'See-through crystal. Enemies can watch you watching them. Awkward.',
      'Whispers ancient secrets. Mostly gossip about dead kings.',
    ],
  }),
  ...ladder({
    kind: 'chest', slot: 'chest', noun: 'Chestplate', valueMul: 2,
    stats: t => ({ def: CHEST_DEF[t]! }),
    descs: [
      'Copper plating: stops one (1) stabbing. Collect all six!',
      'Industry-standard torso insurance.',
      'Polished steel. Check yourself out mid-battle. Worth it.',
      'The breastplate of someone with more gold than survival instinct.',
      'Crystal-woven plate. Light as regret, hard as the truth.',
      'Mythic plate. Arrows bounce off and feel embarrassed about it.',
    ],
  }),
  ...ladder({
    kind: 'boots', slot: 'boots', noun: 'Boots', valueMul: 1.2,
    stats: t => ({ def: BOOTS_DEF[t]!, agi: BOOTS_AGI[t]! }),
    descs: [
      'Chunky copper boots. Every step is a tiny gong announcement.',
      'Stomp puddles, stomp spiders, stomp onward.',
      'Steel toes: for kicking down doors and winning arguments.',
      'Gold boots. Walking on your net worth, literally.',
      'Leave faintly glowing footprints. Terrible for stealth, great for drama.',
      "They've walked through hell. Your commute will be fine.",
    ],
  }),
]

const TOOLS: ItemDef[] = [
  ...ladder({
    kind: 'pick', slot: 'tool', noun: 'Pickaxe', valueMul: 1.8,
    stats: t => ({ atk: TOOL_ATK[t]!, str: TOOL_STR[t]! }),
    descs: [
      'Swing at rock. Repeat until rich or bored.',
      'Rocks fear it. Your blisters respect it.',
      'Bites into stone like it owes it money.',
      'Mining with a golden pick: peak irony, excellent chipping.',
      'Resonates with ore veins. Also with your deep need for shiny things.',
      "Could crack the planet's crust. Please don't.",
    ],
  }),
  ...ladder({
    kind: 'hatchet', slot: 'tool', noun: 'Hatchet', valueMul: 1.8,
    stats: t => ({ atk: TOOL_ATK[t]!, str: TOOL_STR[t]! }),
    descs: [
      'Little chopper, big dreams.',
      'The trees have started a support group.',
      'One swing, two logs, zero remorse.',
      'A gilded hatchet, for lumberjacks with a sponsorship deal.',
      'Slices timber so clean the stump says thank you.',
      'Deforestation, but make it legendary.',
    ],
  }),
  { id: 'rod_basic', name: 'Basic Fishing Rod', slot: 'tool', rarity: 0, levelReq: 1, value: 12, desc: 'A stick, a string, and unearned optimism.' },
  { id: 'rod_sturdy', name: 'Sturdy Fishing Rod', slot: 'tool', rarity: 2, levelReq: 10, value: 150, desc: 'Reinforced for the fish that fight back. They all fight back.' },
  { id: 'rod_golden', name: 'Golden Fishing Rod', slot: 'tool', rarity: 3, levelReq: 20, value: 500, desc: 'The fish see it coming a mile away. They come anyway. Vanity.' },
]

function mat(id: string, name: string, rarity: Rarity, value: number, desc: string): ItemDef {
  return { id, name, slot: 'material', rarity, value, desc }
}

const MATERIALS_CATALOG: ItemDef[] = [
  mat('ore_copper', 'Copper Ore', 0, 5, 'Raw copper. Smells like pennies and opportunity.'),
  mat('ore_iron', 'Iron Ore', 1, 12, 'Iron ore. Heavy, ugly, extremely employable.'),
  mat('ore_gold', 'Gold Ore', 3, 80, 'The rock equivalent of a lottery ticket that actually hit.'),
  mat('ore_mythic', 'Mythic Ore', 5, 900, 'Vibrates gently when nobody is looking. Probably fine.'),
  mat('bar_copper', 'Copper Bar', 0, 12, 'Smelted and smug about it.'),
  mat('bar_iron', 'Iron Bar', 1, 30, 'An honest bar of iron. The backbone of civilization and swords.'),
  mat('bar_steel', 'Steel Bar', 2, 80, 'Iron that went to the gym.'),
  mat('bar_gold', 'Gold Bar', 3, 220, "Solid gold. Yes, you're going to make armor out of money."),
  mat('bar_mythic', 'Mythic Bar', 5, 1800, 'Took three days and one eyebrow to smelt.'),
  mat('crystal_raw', 'Raw Crystal', 4, 400, "Hums with mana. Don't use it as a nightlight unless you enjoy dreaming in math."),
  mat('crystal_cut', 'Cut Crystal', 4, 700, 'Precision-cut. The jeweler wept. Twice.'),
  mat('crystal_shard', 'Crystal Shard', 3, 150, 'A splinter of crystal. Pointy end toward enemies, ideally.'),
  mat('wood_oak', 'Oak Log', 0, 6, 'Sturdy oak. The tree fought bravely.'),
  mat('wood_pine', 'Pine Log', 0, 5, 'Smells like holidays and splinters.'),
  mat('wood_ancient', 'Ancient Wood', 3, 120, 'Older than your bloodline and twice as stubborn.'),
  mat('herb_green', 'Green Herb', 0, 4, 'Alchemists swear by it. Also at it.'),
  mat('herb_red', 'Red Herb', 1, 10, 'Tastes like a campfire argument.'),
  mat('herb_blue', 'Blue Herb', 2, 25, 'Mana-rich, flavor-poor.'),
  mat('herb_gold', 'Golden Bloom', 3, 90, 'Blooms once a decade, usually out of spite.'),
  mat('fish_raw', 'Raw Fish', 0, 3, 'It has seen things. Cook it anyway.'),
  mat('fish_trout', 'Trout', 1, 8, 'A trout of average ambition.'),
  mat('fish_salmon', 'Salmon', 2, 15, 'Swam upstream its whole life just to meet you. Tragic.'),
  mat('fish_puffer', 'Pufferfish', 3, 40, 'Mostly spikes and attitude.'),
  mat('fish_golden', 'Golden Fish', 4, 300, 'Grants no wishes. Grants excellent soup.'),
  mat('fish_boot', 'Old Boot', 0, 1, "You fished up a boot. It's not even your size."),
  mat('hide_wolf', 'Wolf Hide', 1, 10, 'The wolf no longer needs it. You were there. You know why.'),
  mat('hide_boar', 'Boar Hide', 1, 12, 'Thick, bristly, faintly offended.'),
  mat('hide_tough', 'Tough Hide', 2, 35, 'So tough the tanner billed extra.'),
  mat('wheat', 'Wheat', 0, 2, "Golden wheat. Bread's origin story."),
]

function food(id: string, name: string, rarity: Rarity, value: number, hp: number, mp: number, desc: string): ItemDef {
  const restores: NonNullable<ItemDef['restores']> = mp > 0 ? { hp, mp } : { hp }
  return { id, name, slot: 'consumable', rarity, restores, value, desc }
}

const FOODS: ItemDef[] = [
  food('food_bread', 'Crusty Bread', 0, 4, 15, 0, 'Fresh-ish. The crust is a workout, the inside is a hug.'),
  food('food_apple', 'Apple', 0, 2, 8, 0, 'An apple a day keeps nobody away. You have a sword for that.'),
  food('food_cheese', 'Aged Cheese', 0, 3, 12, 0, "Aged where? Don't ask questions you can smell the answer to."),
  food('food_burnt', 'Burnt Mystery Meat', 0, 1, 2, 0, 'You did this. Own it.'),
  food('food_skewer', 'Meat Skewer', 1, 6, 20, 0, 'Mystery meat on a stick. The mystery is part of the seasoning.'),
  food('food_fish', 'Grilled Fish', 1, 8, 25, 0, 'Finally, revenge tastes good.'),
  food('food_jerky', 'Tough Jerky', 1, 6, 18, 0, 'Chewing this counts as combat training for your jaw.'),
  food('food_honey', 'Wild Honey', 1, 7, 10, 10, 'Stolen from bees who absolutely remember your face.'),
  food('food_jelly', 'Slime Jelly', 1, 8, 12, 12, 'Wobbly, radiant, legally food.'),
  food('food_stew', 'Hearty Stew', 2, 15, 40, 0, "Grandma's recipe, warlord's portion size."),
  food('food_pie', 'Meat Pie', 2, 20, 50, 0, 'Contents: meat (probably), pie (confirmed).'),
  food('food_kebab', 'Orc Kebab', 2, 18, 45, 0, 'Orc-style: heavy on everything.'),
  food('food_block', 'BLOCK Pop', 2, 25, 20, 20, 'A BLOCK-shaped lollipop. Tastes like candy and market volatility.'),
  food('food_cake', 'Victory Cake', 3, 40, 60, 20, "Eat it before you've earned it. We won't tell."),
  food('food_pufferfish', 'Puffer Sashimi', 3, 80, 90, 0, '9 out of 10 survivors recommend it.'),
  food('food_feast', 'Royal Feast', 4, 200, 120, 60, 'A royal feast in a box. The box is doing a lot of work.'),
]

const POTIONS: ItemDef[] = [
  food('potion_hp_small', 'Small Health Potion', 0, 10, 25, 0, 'Red goo in a bottle. Tastes like cherry and poor decisions.'),
  food('potion_hp_med', 'Health Potion', 1, 25, 60, 0, 'Now with 140% more goo.'),
  food('potion_hp_large', 'Large Health Potion', 2, 60, 120, 0, 'A bottled commitment to survival.'),
  food('potion_hp_huge', 'Huge Health Potion', 3, 140, 250, 0, "Chugging this voids several warranties, including your liver's."),
  { id: 'potion_mp_small', name: 'Small Mana Potion', slot: 'consumable', rarity: 0, restores: { mp: 25 }, value: 10, desc: 'Blue, fizzy, makes your thoughts sparkle.' },
  { id: 'potion_mp_med', name: 'Mana Potion', slot: 'consumable', rarity: 1, restores: { mp: 60 }, value: 25, desc: "The wizard's coffee." },
  { id: 'potion_mp_large', name: 'Large Mana Potion', slot: 'consumable', rarity: 2, restores: { mp: 120 }, value: 60, desc: 'Enough mana to make bad spell choices at scale.' },
  { id: 'potion_mp_huge', name: 'Huge Mana Potion', slot: 'consumable', rarity: 3, restores: { mp: 250 }, value: 140, desc: 'Your veins hum the arcane anthem for an hour.' },
  food('potion_elixir', 'Golden Elixir', 4, 300, 150, 150, 'Fixes everything except your personality.'),
  food('potion_regret', 'Potion of Regret', 0, 1, 1, 0, 'Restores 1 HP. It knows what it did.'),
  food('potion_mystery', 'Mystery Potion', 2, 30, 50, 50, 'Could be healing. Could be soup. One way to find out.'),
]

function acc(id: string, name: string, rarity: Rarity, value: number, stats: Stats, desc: string, levelReq?: number): ItemDef {
  return levelReq !== undefined
    ? { id, name, slot: 'accessory', rarity, stats, levelReq, value, desc }
    : { id, name, slot: 'accessory', rarity, stats, value, desc }
}

const ACCESSORIES: ItemDef[] = [
  acc('ring_participation', 'Participation Ring', 0, 5, { atk: 1, def: 1, str: 1, int: 1, agi: 1 }, "You showed up. Here's the proof nobody asked for."),
  acc('acc_lucky_rock', 'Lucky Rock', 1, 20, { agi: 1 }, "It's a rock. It is not lucky. It doesn't even like you."),
  acc('ring_onion', 'Onion Ring', 1, 15, { str: 1 }, 'Technically jewelry. Makes your enemies cry. Mostly makes you cry.'),
  acc('acc_mustache', 'Fake Mustache', 1, 25, { str: 2 }, "A disguise so good even your problems won't recognize you."),
  acc('acc_goggles', 'Tinker Goggles', 1, 30, { agi: 2, int: 1 }, 'Protect your eyes from sparks, dust, and eye contact.'),
  acc('charm_rabbit', "Rabbit's Foot", 2, 60, { agi: 3 }, 'Lucky for you. Spectacularly unlucky for the rabbit.', 8),
  acc('ring_mood', 'Mood Ring', 2, 50, { int: 2 }, 'Currently the color of mild disappointment.', 8),
  acc('acc_tinfoil', 'Tinfoil Hat', 2, 45, { int: 4, def: 1 }, 'Blocks mind control, sunburn, and social invitations.', 10),
  acc('amulet_grandma', "Grandma's Locket", 3, 200, { def: 4 }, 'Smells like cookies and unconditional judgment.', 15),
  acc('amulet_debt', 'Amulet of Crippling Debt', 3, 250, { atk: 2, int: 3 }, 'Power now, interest later. The interest is also power. Compounding.', 20),
  acc('amulet_block', 'BLOCK Pendant', 4, 1000, { atk: 2, def: 2, int: 2 }, 'A glowing BLOCK pendant. HODL it close to your heart.', 25),
]

/** The whole catalog, frozen at module load. */
export const CATALOG: readonly ItemDef[] = [
  ...WEAPONS_AND_ARMOR,
  ...TOOLS,
  ...MATERIALS_CATALOG,
  ...FOODS,
  ...POTIONS,
  ...ACCESSORIES,
]
