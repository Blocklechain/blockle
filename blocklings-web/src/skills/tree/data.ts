/**
 * Blocklings skill trees — the node catalog.
 *
 * 13 skills x 24 nodes = 312 nodes, all built from one skeleton so save data
 * stays tiny and layout stays sane:
 *
 *   autos    u1..u8  @ lvl 1/5/10/20/30/40/60/85 — granted free (actions,
 *                      recipes, material tiers)
 *   branch A a1..a4  @ lvl 3/12/22/38 — chained perk path (requires previous)
 *   branch B b1..b4  @ lvl 3/12/22/38 — rival chained perk path
 *   floaters f1..f3  @ lvl 8/16/28    — standalone perks
 *   capstones        @ 50/50/75/75/99 — c50a|c50b exclusive pair (c50a needs
 *                      the A-branch tip, c50b the B tip), c75a|c75b exclusive
 *                      pair, c99 the grand finisher
 *
 * Node ids are `${skill}.${slot}` ('mining.b4') — short on purpose, they are
 * persisted. Effects are modifier keys summed by SkillTreeAPI.modifier();
 * 'recipe:*' / 'tier:*' / 'unlock:*' keys are 0/1 flags, everything else is
 * an additive fraction (0.05 = +5%).
 */
import type { TreeNode } from '../../types'

/** TreeNode + module-internal extras (prereqs, exclusivity, layout). */
export interface TreeNodeDef extends TreeNode {
  /** Node ids that must already be chosen/granted. */
  requires: readonly string[]
  /** Mutual-exclusion group — only one node per group may ever be chosen. */
  excl?: string
  /** Visual-only edge parent (drawn, not required). */
  vis?: string
  /** Layout grid position (columns right, lanes down). */
  x: number
  y: number
}

/** [name, desc, effects] — the per-skill content triple. */
type T = readonly [string, string, Record<string, number>]

interface Spec {
  autos: readonly [T, T, T, T, T, T, T, T]
  a: readonly [T, T, T, T]
  b: readonly [T, T, T, T]
  f: readonly [T, T, T]
  /** c50a, c50b, c75a, c75b, c99 */
  caps: readonly [T, T, T, T, T]
}

const AUTO_LVLS = [1, 5, 10, 20, 30, 40, 60, 85] as const
const AUTO_X = [0, 1, 2, 3, 4, 5, 6.6, 8.2] as const
const BRANCH_LVLS = [3, 12, 22, 38] as const
const FLOAT_LVLS = [8, 16, 28] as const

function build(skill: string, s: Spec): TreeNodeDef[] {
  const id = (slot: string): string => `${skill}.${slot}`
  const out: TreeNodeDef[] = []
  const node = (
    slot: string,
    kind: TreeNode['kind'],
    lvlReq: number,
    t: T,
    x: number,
    y: number,
    requires: readonly string[] = [],
    extra: { excl?: string; vis?: string } = {}
  ): void => {
    out.push({
      id: id(slot),
      skill,
      kind,
      lvlReq,
      name: t[0],
      desc: t[1],
      effects: t[2],
      requires,
      x,
      y,
      ...extra
    })
  }

  // auto spine, lane 2
  for (let i = 0; i < 8; i++) {
    node(`u${i + 1}`, 'auto', AUTO_LVLS[i]!, s.autos[i]!, AUTO_X[i]!, 2, [],
      i > 0 ? { vis: id(`u${i}`) } : {})
  }
  // branch A (upper) + branch B (lower)
  const ax = [0.7, 1.7, 2.7, 3.7]
  const ay = [1.05, 0.6, 0.3, 0]
  const by = [2.95, 3.4, 3.7, 4]
  for (let i = 0; i < 4; i++) {
    node(`a${i + 1}`, 'perk', BRANCH_LVLS[i]!, s.a[i]!, ax[i]!, ay[i]!,
      i > 0 ? [id(`a${i}`)] : [], i === 0 ? { vis: id('u1') } : {})
    node(`b${i + 1}`, 'perk', BRANCH_LVLS[i]!, s.b[i]!, ax[i]!, by[i]!,
      i > 0 ? [id(`b${i}`)] : [], i === 0 ? { vis: id('u1') } : {})
  }
  // floaters, between spine and branches
  node('f1', 'perk', FLOAT_LVLS[0]!, s.f[0]!, 1.35, 1.5, [], { vis: id('u2') })
  node('f2', 'perk', FLOAT_LVLS[1]!, s.f[1]!, 2.35, 2.55, [], { vis: id('u3') })
  node('f3', 'perk', FLOAT_LVLS[2]!, s.f[2]!, 3.4, 1.55, [], { vis: id('u4') })
  // capstones
  node('c50a', 'capstone', 50, s.caps[0]!, 4.9, 0.35, [id('a4')], { excl: id('c50') })
  node('c50b', 'capstone', 50, s.caps[1]!, 4.9, 3.65, [id('b4')], { excl: id('c50') })
  node('c75a', 'capstone', 75, s.caps[2]!, 6.1, 0.9, [], { excl: id('c75'), vis: id('c50a') })
  node('c75b', 'capstone', 75, s.caps[3]!, 6.1, 3.1, [], { excl: id('c75'), vis: id('c50b') })
  node('c99', 'capstone', 99, s.caps[4]!, 7.5, 1.2, [], { vis: id('u7') })
  return out
}

/* ========================================================================== *
 *  CONTENT — mature-cartoon-comedy register, short and mean (to life         *
 *  choices, never to people).                                                *
 * ========================================================================== */

const SPECS: Record<string, Spec> = {
  attack: {
    autos: [
      ['Hold It by the Handle', 'You may now swing weapons on purpose. Basic attacks unlocked.', { 'unlock:attack': 1 }],
      ['Follow-Through', 'Unlocks power swings: slower, harder, extremely dramatic.', { 'unlock:powerSwing': 1 }],
      ['Iron License', 'You are legally allowed to hold iron weapons now.', { 'tier:iron': 1 }],
      ['Steel Yourself', 'Steel weapons unlocked. Pun mandatory.', { 'tier:steel': 1 }],
      ['Combo Theory', 'Third hit in a row lands 15% harder. Math is violence.', { comboDmg: 0.15 }],
      ['Gold-Plated Menace', 'Gold weapons unlocked. Impractical. Gorgeous.', { 'tier:gold': 1 }],
      ['Crystal Clearance', 'Crystal weapons unlocked. Try not to drop them.', { 'tier:crystal': 1 }],
      ['Mythic Paperwork', 'Mythic weapons unlocked. The forms filed themselves in fear.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Aim for the Soft Bits', '+3% crit chance. Everything has soft bits. Everything.', { crit: 0.03 }],
      ['Anatomy Dropout', '+4% crit chance. Flunked healer school, remembers where it hurts.', { crit: 0.04 }],
      ['Overkill Enthusiast', '+25% crit damage. Why hit once when once can be bigger?', { critDmg: 0.25 }],
      ['Surgical. Ish.', '+5% crit, +25% crit damage. Precision, with collateral.', { crit: 0.05, critDmg: 0.25 }]
    ],
    b: [
      ['Wide Swings', 'Hits splash 15% damage to nearby enemies. Share the pain.', { cleave: 0.15 }],
      ['Personal Space Issues', '+6% attack speed. Everyone is too close. Fix that.', { atkSpeed: 0.06 }],
      ['Crowd Work', '+15% cleave. You kill rooms, not people.', { cleave: 0.15 }],
      ['Lawnmower Technique', '+20% cleave. Mobs are grass. You are Tuesday.', { cleave: 0.2 }]
    ],
    f: [
      ['Warm-Up Stretches', '+4% damage. Hamstrings: the secret weapon.', { atkDmgPct: 0.04 }],
      ['Grip Strength', '+6% damage from squeezing the handle with intent.', { atkDmgPct: 0.06 }],
      ['Violence Journal', '+2% crit, +4% damage. Dear diary: today I hit things. It helped.', { crit: 0.02, atkDmgPct: 0.04 }]
    ],
    caps: [
      ["Executioner's Memo", 'Enemies under 25% HP take +30% damage. HR has been notified.', { execDmg: 0.3 }],
      ['Hurricane Clause', '+25% cleave, +5% attack speed. Legally a weather event.', { cleave: 0.25, atkSpeed: 0.05 }],
      ['Critical Thinker', '+8% crit, +40% crit damage. Finally, thinking pays.', { crit: 0.08, critDmg: 0.4 }],
      ['Property Damage', '+12% damage, +10% cleave. The village sends invoices.', { atkDmgPct: 0.12, cleave: 0.1 }],
      ['Final Boss Energy', '+20% damage, +5% crit. Things check under the bed for YOU.', { atkDmgPct: 0.2, crit: 0.05 }]
    ]
  },

  defense: {
    autos: [
      ['Stand There Menacingly', 'Blocking unlocked. Your whole job is being in the way.', { 'unlock:block': 1 }],
      ['Flinch Less', '+2% damage reduction through sheer stubbornness.', { dmgReducePct: 0.02 }],
      ['Iron Wardrobe', 'Iron armor unlocked. Fashion is a shield now.', { 'tier:iron': 1 }],
      ['Steel Wardrobe', 'Steel armor unlocked. Heavier. Shinier. Clankier.', { 'tier:steel': 1 }],
      ['Shrug Technique', '+5% block chance. Advanced not-caring.', { blockChance: 0.05 }],
      ['Gold Wardrobe', 'Gold armor unlocked. Soft metal, hard statement.', { 'tier:gold': 1 }],
      ['Crystal Wardrobe', 'Crystal armor unlocked. See-through courage.', { 'tier:crystal': 1 }],
      ['Mythic Wardrobe', 'Mythic armor unlocked. Dry cleaning: impossible.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Thick Skin', '+2% damage reduction. Criticism also bounces off.', { dmgReducePct: 0.02 }],
      ['Thicker Skin', '+3% damage reduction. The insults barely land either.', { dmgReducePct: 0.03 }],
      ['Basically Bark', '+3% reduction, +3% max HP. Trees respect you as a peer.', { dmgReducePct: 0.03, maxHpPct: 0.03 }],
      ['Walking Fortress', '+4% damage reduction. Doors now consider YOU.', { dmgReducePct: 0.04 }]
    ],
    b: [
      ['Rude Reflection', 'Attackers take 5% of their damage back. Rude of them, really.', { thorns: 0.05 }],
      ['No, YOU', '+7% thorns. Devastating comeback, physically.', { thorns: 0.07 }],
      ['Spite Armor', '+8% thorns, +2% reduction. Powered by grudges.', { thorns: 0.08, dmgReducePct: 0.02 }],
      ['Return to Sender', '+12% thorns. Postage due: their own damage.', { thorns: 0.12 }]
    ],
    f: [
      ['Helmet Appreciation', '+3% max HP. Turns out the head matters.', { maxHpPct: 0.03 }],
      ['Braced Posture', '+3% block chance. Core engaged. Soul engaged.', { blockChance: 0.03 }],
      ['Insurance Fraud', 'Heal 2% max HP on block. Do not explain this to anyone.', { blockHeal: 0.02 }]
    ],
    caps: [
      ['The Anvil Lifestyle', '+6% reduction, +5% max HP. Things break on you.', { dmgReducePct: 0.06, maxHpPct: 0.05 }],
      ['Full Metal Tantrum', '+15% thorns, +5% block. Hitting you is self-harm.', { thorns: 0.15, blockChance: 0.05 }],
      ['Unbothered', '+5% reduction, monsters notice you 20% less. Moisturized. In your lane.', { dmgReducePct: 0.05, aggroDown: 0.2 }],
      ['Mutually Assured', '+20% thorns. Everyone loses. Mostly them.', { thorns: 0.2 }],
      ['Load-Bearing Hero', '+10% reduction, +10% max HP. Remove you and the fight collapses.', { dmgReducePct: 0.1, maxHpPct: 0.1 }]
    ]
  },

  magic: {
    autos: [
      ['Sparkle Fingers', 'Basic bolt unlocked. It stings AND glitters.', { 'unlock:bolt': 1 }],
      ['Mana Budgeting', '+5% max MP. Financial literacy, but glowing.', { mpMaxPct: 0.05 }],
      ['Fire, But Indoors', 'Fireball unlocked. The landlord was not consulted.', { 'unlock:fireball': 1 }],
      ['Frost Etiquette', 'Frostbolt unlocked. Cold, but polite about it.', { 'unlock:frostbolt': 1 }],
      ['Mana Composting', '+0.1 MP regen. Recycle your vibes.', { mpRegen: 0.1 }],
      ['Lightning Permit', 'Lightning unlocked. Zeus signed off reluctantly.', { 'unlock:lightning': 1 }],
      ['Crystal Focus', 'Crystal staves unlocked. Conducts smug energy.', { 'tier:crystal': 1 }],
      ['Mythic Thesis', 'Mythic staves unlocked. Peer-reviewed by dragons.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Louder Spells', '+4% spell damage. Volume IS a school of magic.', { magDmgPct: 0.04 }],
      ['Unnecessary Pyrotechnics', '8% chance to ignite. Was it needed? No. Was it cool? Yes.', { burnChance: 0.08 }],
      ['Glass Cannon Curriculum', '+8% spell damage. Defense class was at 8am.', { magDmgPct: 0.08 }],
      ['Overchannel', '+10% spell damage. Warranty on your eyebrows: void.', { magDmgPct: 0.1 }]
    ],
    b: [
      ['Coupon Casting', 'Spells cost 5% less MP. Extreme couponing, arcane edition.', { mpCostDown: 0.05 }],
      ['Mana Hoarder', '+8% max MP. It sparks joy. All of it sparks joy.', { mpMaxPct: 0.08 }],
      ['Drip Feed', '+0.15 MP regen. Slow magic is still magic.', { mpRegen: 0.15 }],
      ['Free Trial Forever', 'Spells cost 8% less MP. Never entered a card.', { mpCostDown: 0.08 }]
    ],
    f: [
      ['Wand Hygiene', '+3% spell damage. A clean wand is a deadly wand.', { magDmgPct: 0.03 }],
      ['Pointy Hat Tax Break', '+4% max MP. The hat is a business expense.', { mpMaxPct: 0.04 }],
      ['Chant Shortcuts', '+5% cast speed. "Abraca-whatever" works fine.', { castSpeed: 0.05 }]
    ],
    caps: [
      ['Arcane Hoarding Disorder', 'Spells have a 10% chance to bounce to another enemy.', { chain: 0.1 }],
      ['Renewable Sorcery', '+0.25 MP regen, 5% cheaper spells. Green energy, literally.', { mpRegen: 0.25, mpCostDown: 0.05 }],
      ['Chain Reaction', '+15% bounce. Hits a friend. Their friend. Their accountant.', { chain: 0.15 }],
      ['Mana Monopoly', '+15% max MP, +0.1 regen. Pass GO, collect mana.', { mpMaxPct: 0.15, mpRegen: 0.1 }],
      ['Reality Is a Suggestion', '+20% spell damage, +10% bounce. Physics filed a complaint.', { magDmgPct: 0.2, chain: 0.1 }]
    ]
  },

  vitality: {
    autos: [
      ['Baseline Pulse', 'Your heart beats. 10/10, keep that up.', { 'unlock:alive': 1 }],
      ['Snack Absorption', 'Food heals 5% more. Your body said thanks for once.', { foodHealPct: 0.05 }],
      ['Second Wind', '+0.1 HP regen. The first wind quit.', { hpRegen: 0.1 }],
      ['Thick Blood', '+2% max HP. Basically soup now.', { maxHpPct: 0.02 }],
      ['Nap Efficiency', '+0.1 HP regen. Professional-grade lying down.', { hpRegen: 0.1 }],
      ['Iron Stomach', 'Food heals 10% more. Expiry dates fear you.', { foodHealPct: 0.1 }],
      ['Spite-Based Survival', '+4% max HP. Alive specifically to annoy your enemies.', { maxHpPct: 0.04 }],
      ['Too Angry to Die', 'Once per fight, survive a killing blow at 1 HP.', { secondChance: 1 }]
    ],
    a: [
      ['Extra Padding', '+3% max HP. Insulation is survival.', { maxHpPct: 0.03 }],
      ['Big-Boned Canonically', '+4% max HP. It is official lore now.', { maxHpPct: 0.04 }],
      ['Absolute Unit', '+5% max HP. In awe at the size of this build.', { maxHpPct: 0.05 }],
      ['Geographic Feature', '+6% max HP. Cartographers want to label you.', { maxHpPct: 0.06 }]
    ],
    b: [
      ['Scab Speedrun', '+0.1 HP regen. Any% wound recovery.', { hpRegen: 0.1 }],
      ['Leech Etiquette', 'Heal 2% of damage dealt. The leeches taught you manners.', { lifesteal: 0.02 }],
      ['Combat Snacking', 'Food heals 10% more. Mid-fight charcuterie.', { foodHealPct: 0.1 }],
      ['Photosynthesis (Unverified)', '+0.2 HP regen. You stood in the sun and felt something.', { hpRegen: 0.2 }]
    ],
    f: [
      ['Hydration', '+2% max HP. The water bottle people were right.', { maxHpPct: 0.02 }],
      ['Cardio Debt', '+0.1 HP regen. Finally paying it off.', { hpRegen: 0.1 }],
      ['Pain Tolerance Hobbyist', '+3% max HP. Weird hobby. Great results.', { maxHpPct: 0.03 }]
    ],
    caps: [
      ['HP Goes Brrr', '+10% max HP. The health bar needed a scrollbar.', { maxHpPct: 0.1 }],
      ['Walking Buffet', '+4% lifesteal, food heals 10% more. All you can eat: them.', { lifesteal: 0.04, foodHealPct: 0.1 }],
      ['Unreasonably Alive', '+8% max HP, +0.2 regen. Doctors call it "showing off".', { maxHpPct: 0.08, hpRegen: 0.2 }],
      ['Vampire-Adjacent', '+5% lifesteal. Legally distinct from vampirism.', { lifesteal: 0.05 }],
      ['Actuarial Nightmare', '+15% max HP, +0.3 regen. Your life insurer quit the industry.', { maxHpPct: 0.15, hpRegen: 0.3 }]
    ]
  },

  mining: {
    autos: [
      ['Rock Acknowledgment', 'Copper mining unlocked. You and the rock have an understanding.', { 'unlock:mine': 1 }],
      ['Swing Rhythm', '+5% mining speed. Clang. Clang. Clang. Art.', { mineSpeed: 0.05 }],
      ['Iron Eyes', 'Iron ore unlocked. It was there the whole time.', { 'tier:iron': 1 }],
      ['Steel Sense', 'Steel-grade veins unlocked. The good crunchy ones.', { 'tier:steel': 1 }],
      ['Ore Radar', '+2% gem find. Your nose twitches near shiny.', { gemFind: 0.02 }],
      ['Gold Fever (Managed)', 'Gold ore unlocked. The fever is under control. Mostly.', { 'tier:gold': 1 }],
      ['Crystal Whisperer', 'Crystal nodes unlocked. They hum. You hum back.', { 'tier:crystal': 1 }],
      ['Mythic Vein Clearance', 'Mythic ore unlocked. The mountain signed a waiver.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Loose Wrists', '+5% mining speed. Terrifying handshakes, great output.', { mineSpeed: 0.05 }],
      ['Caffeinated Swings', '+6% mining speed. Sponsored by anxiety.', { mineSpeed: 0.06 }],
      ['Pickaxe Telepathy', '+7% mining speed. The pick knows where to go.', { mineSpeed: 0.07 }],
      ['Jackhammer Soul', '+8% mining speed. The pick swings you now.', { mineSpeed: 0.08 }]
    ],
    b: [
      ['Shiny Magpie', '4% chance of double ore. Ooh. OOH.', { doubleOre: 0.04 }],
      ['Pocket Dimension Pockets', '+5% double ore. Do not audit the pockets.', { doubleOre: 0.05 }],
      ['Geode Greed', '+3% gem find. Cracking rocks like piñatas.', { gemFind: 0.03 }],
      ['Buy One Get One', '+7% double ore. The rock is running a promotion.', { doubleOre: 0.07 }]
    ],
    f: [
      ['Helmet Lamp', '+4% mining speed. Seeing the rock helps. Who knew.', { mineSpeed: 0.04 }],
      ['Scheduled Snack Breaks', '+3% mining speed. Union-mandated, morale-tested.', { mineSpeed: 0.03 }],
      ['Rock Small Talk', '+2% gem find. They open up if you ask about their day.', { gemFind: 0.02 }]
    ],
    caps: [
      ['Speedrun Any%', '+15% mining speed. The cave has a leaderboard now.', { mineSpeed: 0.15 }],
      ["Hoarder's Dream", '+10% double ore. One is none, two is one, forty is comfy.', { doubleOre: 0.1 }],
      ['Tectonic Rudeness', '+10% speed, +5% double ore. The plates shifted to avoid you.', { mineSpeed: 0.1, doubleOre: 0.05 }],
      ['Crystal Dowsing', '+6% gem find. You vibrate near value.', { gemFind: 0.06 }],
      ['One With the Wall', '+15% speed, +10% double ore. The mountain claims you as a dependent.', { mineSpeed: 0.15, doubleOre: 0.1 }]
    ]
  },

  woodcutting: {
    autos: [
      ['Tree Identification', 'Chopping unlocked. That one. That is a tree.', { 'unlock:chop': 1 }],
      ['Swing Economy', '+5% chop speed. Fewer swings, same crime.', { chopSpeed: 0.05 }],
      ['Pine Permission', 'Pine trees unlocked. They smell nice and fall great.', { 'tier:pine': 1 }],
      ['Hardwood License', 'Hardwood unlocked. The trees with opinions.', { 'tier:hardwood': 1 }],
      ['Nest Spotting', '+3% chance of bonus nest loot. Finders keepers, birds.', { nestFind: 0.03 }],
      ['Lumber Logistics', '+3% double wood. Stack it. Admire it. Repeat.', { doubleWood: 0.03 }],
      ['Crystal-Edge Hatchets', 'Crystal hatchets unlocked. Overkill, beautifully.', { 'tier:crystal': 1 }],
      ['Mythic Grove Pass', 'Mythic trees unlocked. They allow it. Barely.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Warm Hands', '+5% chop speed. Blisters evolved into armor.', { chopSpeed: 0.05 }],
      ['Angle Nerd', '+6% chop speed. 43 degrees. Trust the process.', { chopSpeed: 0.06 }],
      ['Two-Hit Trees', '+7% chop speed. One-hit trees are the dream.', { chopSpeed: 0.07 }],
      ['Beaver Diplomacy', '+8% chop speed. The beavers consult YOU now.', { chopSpeed: 0.08 }]
    ],
    b: [
      ['Splinter Savings', '4% chance of double wood. Every splinter counts.', { doubleWood: 0.04 }],
      ['Branch Manager', '+5% double wood. Corporate title, real sticks.', { doubleWood: 0.05 }],
      ['Sap Sommelier', '+3% nest find. Notes of oak, hints of bird.', { nestFind: 0.03 }],
      ['Log Duplication Glitch (Legal)', '+7% double wood. Patched never.', { doubleWood: 0.07 }]
    ],
    f: [
      ['Flannel Bonus', '+4% chop speed. The shirt does something. Scientists baffled.', { chopSpeed: 0.04 }],
      ['Sharp Thoughts', '+3% chop speed. Sharpen the axe. Also the mind. Mostly the axe.', { chopSpeed: 0.03 }],
      ['Tree Apologies', '+2% double wood. Saying sorry first yields more. Trees respect manners.', { doubleWood: 0.02 }]
    ],
    caps: [
      ['Timber Tornado', '+15% chop speed. Forecast: falling trees.', { chopSpeed: 0.15 }],
      ['Infinite Forest Theorem', '+10% double wood. The math checks out. Do not check the math.', { doubleWood: 0.1 }],
      ['Clean Cuts Only', '+10% speed, +5% double wood. Surgical forestry.', { chopSpeed: 0.1, doubleWood: 0.05 }],
      ['Nest Egg', '+6% nest find. Retirement plan: bird stuff.', { nestFind: 0.06 }],
      ["Lorax's Nemesis", '+15% speed, +10% double wood. You speak for the stumps.', { chopSpeed: 0.15, doubleWood: 0.1 }]
    ]
  },

  fishing: {
    autos: [
      ['Hold Rod Correctly', 'Fishing unlocked. Pointy end toward water.', { 'unlock:fish': 1 }],
      ['Patience I', '+5% catch speed. Staring at water: certified.', { fishSpeed: 0.05 }],
      ['Bait Opinions', '+5% catch speed. You have bait takes now. Loud ones.', { fishSpeed: 0.05 }],
      ['Deep Spots', 'Deep fishing spots unlocked. Where the weird ones live.', { 'unlock:deepFish': 1 }],
      ['Treasure Sense', '+2% treasure find. Some tugs are not fish.', { treasureFind: 0.02 }],
      ['Weatherproof Sitting', '+5% catch speed. Rain is just ambiance.', { fishSpeed: 0.05 }],
      ['Crystal Lures', 'Crystal lures unlocked. Fish love drama.', { 'tier:crystal': 1 }],
      ['Mythic Waters Pass', 'Mythic waters unlocked. The lake has a bouncer.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Twitchy Reflexes', '+5% catch speed. Blink and you still catch it.', { fishSpeed: 0.05 }],
      ['Fish Psychology', '+6% catch speed. You know what they fear. Hooks. It is hooks.', { fishSpeed: 0.06 }],
      ['Irresistible Wiggle', '+7% catch speed. The lure dances. The fish RSVP.', { fishSpeed: 0.07 }],
      ['The Fish Respect You', '+8% catch speed. They surrender with dignity.', { fishSpeed: 0.08 }]
    ],
    b: [
      ['Two-Hook Loophole', '4% chance of double fish. Technically legal.', { doubleFish: 0.04 }],
      ['Net Gains', '+5% double fish. Finance pun, actual fish.', { doubleFish: 0.05 }],
      ['Boot Avoidance', '+3% treasure find. Fewer boots, more chests.', { treasureFind: 0.03 }],
      ['Overfishing (Single-Player)', '+7% double fish. Sustainable, because video game.', { doubleFish: 0.07 }]
    ],
    f: [
      ['Lucky Hat', '+2% treasure find. The hat knows things.', { treasureFind: 0.02 }],
      ['Zen Posture', '+4% catch speed. Inner peace, outer fish.', { fishSpeed: 0.04 }],
      ['Worm Rapport', '+3% catch speed. The worms trust you. Poor worms.', { fishSpeed: 0.03 }]
    ],
    caps: [
      ['Speed Angler', '+15% catch speed. Catch and release and catch and release and—', { fishSpeed: 0.15 }],
      ['The Sea Provides', '+10% double fish. The sea is an enabler.', { doubleFish: 0.1 }],
      ['Tide Whisperer', '+10% speed, +5% double fish. The moon takes your calls.', { fishSpeed: 0.1, doubleFish: 0.05 }],
      ['Sunken Treasure Magnet', '+6% treasure find. Shipwrecks reroute to you.', { treasureFind: 0.06 }],
      ['Fish Folk Hero', '+15% speed, +10% double. Fish beach themselves to meet you.', { fishSpeed: 0.15, doubleFish: 0.1 }]
    ]
  },

  farming: {
    autos: [
      ['Dirt Orientation', 'Farming unlocked. The dirt goes on the bottom.', { 'unlock:farm': 1 }],
      ['Row Discipline', '+5% growth speed. Straight lines scare the weeds.', { growSpeed: 0.05 }],
      ['Compost Rights', '+5% growth speed. Garbage in, dinner out.', { growSpeed: 0.05 }],
      ['Crop Rotation', '+5% growth speed. The crops enjoy the variety.', { growSpeed: 0.05 }],
      ['Seed Thrift', '5% chance to keep your seed when planting.', { seedSave: 0.05 }],
      ['Scarecrow Engineering', '+5% growth speed. It is too scary. Dial it back.', { growSpeed: 0.05 }],
      ['Crystal Greenhouse', 'Crystal-tier crops unlocked. Shiny vegetables. Sure.', { 'tier:crystal': 1 }],
      ['Mythic Seed Vault', 'Mythic crops unlocked. Do not plant near the house.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Morning Person (Forced)', '+5% growth speed. The rooster won. You adapted.', { growSpeed: 0.05 }],
      ['Weed Grudge', '+6% growth speed. Personal. It is personal.', { growSpeed: 0.06 }],
      ['Talking to Plants', '+7% growth speed. They grow faster to make you stop.', { growSpeed: 0.07 }],
      ['Time-Lapse Lifestyle', '+8% growth speed. You blink, it is harvest.', { growSpeed: 0.08 }]
    ],
    b: [
      ['Fat Harvest', '4% chance of double crops. Thicc wheat.', { doubleCrop: 0.04 }],
      ['Seed Banking', '+5% seed save. Compound interest, but dirt.', { seedSave: 0.05 }],
      ['Prize Pumpkin Mindset', '+5% double crops. Every gourd a champion.', { doubleCrop: 0.05 }],
      ['Agricultural Anomaly', '+7% double crops. Scientists keep visiting.', { doubleCrop: 0.07 }]
    ],
    f: [
      ['Good Boots', '+4% growth speed. Respect the mud, rule the mud.', { growSpeed: 0.04 }],
      ['Soil Tasting', '+3% growth speed. Do not ask. It works.', { growSpeed: 0.03 }],
      ['Lucky Trowel', '+2% double crops. Found it in a stump. Never questioned it.', { doubleCrop: 0.02 }]
    ],
    caps: [
      ['Industrial Patience', '+15% growth speed. Waiting, perfected.', { growSpeed: 0.15 }],
      ['Cornucopia Clause', '+10% double crops. The horn is contractually obligated.', { doubleCrop: 0.1 }],
      ['Green Thumb, Whole Hand', '+10% growth, +5% double. The arm is next.', { growSpeed: 0.1, doubleCrop: 0.05 }],
      ['Seedless Economy', '+15% seed save. Infinite seeds hate this one trick.', { seedSave: 0.15 }],
      ['Harvest Deity (Local)', '+15% growth, +10% double. The crops unionized and elected you god.', { growSpeed: 0.15, doubleCrop: 0.1 }]
    ]
  },

  herbalism: {
    autos: [
      ['Salad vs Murder', 'Herb gathering unlocked. Most plants are salad. Most.', { 'unlock:herb': 1 }],
      ['Gentle Hands', '+5% gather speed. The petals stopped filing complaints.', { gatherSpeed: 0.05 }],
      ['Berry Clearance', 'Berry bushes unlocked. The red ones. Probably fine.', { 'unlock:berry': 1 }],
      ['Mushroom Trust Issues', 'Mushroom clusters unlocked. Trust, but verify. Twice.', { 'unlock:mushroom': 1 }],
      ['Nose Calibration', '+2% rare herb find. One nostril is for business.', { rareHerb: 0.02 }],
      ['Pocket Herbarium', '+5% gather speed. Organized crime against foliage.', { gatherSpeed: 0.05 }],
      ['Crystal Sickle', 'Crystal sickle unlocked. Elegant weapon, civilized herbs.', { 'tier:crystal': 1 }],
      ['Mythic Meadow Pass', 'Mythic herbs unlocked. The meadow does background checks.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Quick Pinch', '+5% gather speed. Pinch, pocket, pivot.', { gatherSpeed: 0.05 }],
      ['Stem Etiquette', '+6% gather speed. There is a wrong way. You unlearned it.', { gatherSpeed: 0.06 }],
      ['Forager Flow State', '+7% gather speed. Hours vanish. Baskets appear.', { gatherSpeed: 0.07 }],
      ['Plant Whisper Network', '+8% gather speed. The ferns snitch on the good spots.', { gatherSpeed: 0.08 }]
    ],
    b: [
      ['Rootsy Bonus', '4% chance of double herbs. Take the root. Take it all.', { doubleHerb: 0.04 }],
      ['Petal Pincher', '+5% double herbs. Every petal, itemized.', { doubleHerb: 0.05 }],
      ['Rare Nose', '+3% rare herb find. It twitches near the good stuff.', { rareHerb: 0.03 }],
      ['Botanical Heist', '+7% double herbs. The meadow never saw it coming.', { doubleHerb: 0.07 }]
    ],
    f: [
      ['Basket Upgrade', '+4% gather speed. Wicker technology peaked here.', { gatherSpeed: 0.04 }],
      ['Field Guide Margins', '+2% rare herb find. Your notes have notes.', { rareHerb: 0.02 }],
      ['Bee Diplomacy', '+3% gather speed. A treaty was signed. In honey.', { gatherSpeed: 0.03 }]
    ],
    caps: [
      ['Graze Mode', '+15% gather speed. You move through meadows like weather.', { gatherSpeed: 0.15 }],
      ['Double Bouquet', '+10% double herbs. Two hands, zero restraint.', { doubleHerb: 0.1 }],
      ['The Green Market', '+10% speed, +5% double. Supply chain: you.', { gatherSpeed: 0.1, doubleHerb: 0.05 }],
      ['Legendary Sniffer', '+6% rare herb find. Museums call about your nose.', { rareHerb: 0.06 }],
      ['Druid (Self-Certified)', '+15% speed, +10% double. The forest sends a fruit basket. Of itself.', { gatherSpeed: 0.15, doubleHerb: 0.1 }]
    ]
  },

  blacksmithing: {
    autos: [
      ['Hammer Orientation', 'Copper smithing unlocked. Flat end hits the metal.', { 'recipe:bar_copper': 1 }],
      ['Bellows Cardio', '+5% smith speed. The forge counts as a gym.', { smithSpeed: 0.05 }],
      ['Iron Recipes', 'Iron bars + iron gear recipes unlocked.', { 'recipe:bar_iron': 1 }],
      ['Steel Recipes', 'Steel bars + steel gear recipes unlocked.', { 'recipe:bar_steel': 1 }],
      ['Quench Confidence', '+3% quality chance. The hiss means it is working.', { quality: 0.03 }],
      ['Gold Recipes', 'Gold bars + gold gear recipes unlocked.', { 'recipe:bar_gold': 1 }],
      ['Crystal Forging', 'Crystal smithing unlocked. Hit it SOFTLY hard.', { 'recipe:bar_crystal': 1 }],
      ['Mythic Smithing', 'Mythic smithing unlocked. The anvil is honored.', { 'recipe:bar_mythic': 1 }]
    ],
    a: [
      ['Hot Hands', '+5% smith speed. Calluses on the calluses.', { smithSpeed: 0.05 }],
      ['Anvil Rapport', '+6% smith speed. You two finish each other’s clangs.', { smithSpeed: 0.06 }],
      ['Muscle Memory Metal', '+7% smith speed. The arms know the shapes now.', { smithSpeed: 0.07 }],
      ['Forge Gremlin', '+8% smith speed. You live here now. It is fine.', { smithSpeed: 0.08 }]
    ],
    b: [
      ['Scrap Scrounger', '4% chance to save a bar when crafting.', { saveBar: 0.04 }],
      ['Measured Twice', '+3% quality chance. Cut once. Brag forever.', { quality: 0.03 }],
      ['Slag Recycling', '+5% bar save. One smith’s trash, same smith’s treasure.', { saveBar: 0.05 }],
      ["Master's Eye", '+5% quality chance. You can SEE the flaws leaving.', { quality: 0.05 }]
    ],
    f: [
      ['Apron Pockets', '+2% bar save. Everything falls into the apron. Everything.', { saveBar: 0.02 }],
      ['Ear Protection', '+4% smith speed. Hearing: a craftsman’s luxury.', { smithSpeed: 0.04 }],
      ['Hammer Naming', '+3% smith speed. Her name is Mildred. She never misses.', { smithSpeed: 0.03 }]
    ],
    caps: [
      ['Assembly Line of One', '+15% smith speed. You ARE the industrial revolution.', { smithSpeed: 0.15 }],
      ['Waste Not', '+10% bar save. The scrap bin filed for unemployment.', { saveBar: 0.1 }],
      ['Heirloom Quality', '+8% quality chance. Your grandkids’ grandkids will argue over it.', { quality: 0.08 }],
      ['Half-Price Forge', '+8% bar save, +5% speed. Materials fear commitment to you.', { saveBar: 0.08, smithSpeed: 0.05 }],
      ['The Folded-1000-Times Guy', '+10% quality, +10% speed. Yes, THAT guy. It is you.', { quality: 0.1, smithSpeed: 0.1 }]
    ]
  },

  cooking: {
    autos: [
      ['Boiling Water (Supervised)', 'Cooking unlocked. The water survived.', { 'unlock:cook': 1 }],
      ['Knife Respect', '+5% cook speed. All ten fingers, all ten respected.', { cookSpeed: 0.05 }],
      ['Bread Rights', 'Bread recipes unlocked. Civilization begins.', { 'recipe:food_bread': 1 }],
      ['Stew Science', 'Stew recipes unlocked. Everything is stew if you believe.', { 'recipe:food_stew': 1 }],
      ['Smoke Alarm Truce', '5% less chance to burn food. The alarm misses you.', { noBurn: 0.05 }],
      ['Pie Clearance', 'Pie recipes unlocked. Weaponized comfort.', { 'recipe:food_pie': 1 }],
      ['Feast Engineering', 'Feast recipes unlocked. Structural gravy.', { 'recipe:food_feast': 1 }],
      ['Mythic Gastronomy', 'Mythic dishes unlocked. The flavor has lore.', { 'recipe:food_mythic': 1 }]
    ],
    a: [
      ['Mise en Place-ish', '+5% cook speed. Everything in its place. Roughly.', { cookSpeed: 0.05 }],
      ['Pan Juggling', '+6% cook speed. Three pans, two hands, one legend.', { cookSpeed: 0.06 }],
      ['Four Burners, One Brain', '+7% cook speed. Multitasking at a rolling boil.', { cookSpeed: 0.07 }],
      ['Kitchen Poltergeist', '+8% cook speed. Drawers open themselves for you.', { cookSpeed: 0.08 }]
    ],
    b: [
      ['Season to Taste', 'Food heals 4% more. "To taste" means MORE.', { foodHealPct: 0.04 }],
      ['Butter Doctrine', 'Food heals 5% more. The answer was always butter.', { foodHealPct: 0.05 }],
      ['Char Is Flavor (Lie)', '7% less burn chance. Stop telling that lie.', { noBurn: 0.07 }],
      ['Secret Ingredient (Crime?)', 'Food heals 7% more. Do not disclose. Ever.', { foodHealPct: 0.07 }]
    ],
    f: [
      ['Clean Station', '+4% cook speed. Chaos is for the plate, not the counter.', { cookSpeed: 0.04 }],
      ['Taste Testing', 'Food heals 3% more. Quality control is eating. Officially.', { foodHealPct: 0.03 }],
      ['Confident Plating', '+3% cook speed. Slam it down. Call it rustic.', { cookSpeed: 0.03 }]
    ],
    caps: [
      ['Flash Chef', '+15% cook speed. The kitchen blurs around you.', { cookSpeed: 0.15 }],
      ['Grandma Mode', 'Food heals 10% more. You are legally someone’s grandma now.', { foodHealPct: 0.1 }],
      ['Zero Waste Kitchen', '15% less burn chance. The bin forgot your name.', { noBurn: 0.15 }],
      ['Michelin Starred-ish', 'Food heals 8% more, +5% speed. The tire man nodded once.', { foodHealPct: 0.08, cookSpeed: 0.05 }],
      ['Flavor Singularity', 'Food heals 12% more, 10% less burn. Critics weep, then ask for seconds.', { foodHealPct: 0.12, noBurn: 0.1 }]
    ]
  },

  alchemy: {
    autos: [
      ["Don't Drink That", 'Alchemy unlocked. Rule one, learned the hard way.', { 'unlock:brew': 1 }],
      ['Stir Technique', '+5% brew speed. Clockwise. ALWAYS clockwise.', { brewSpeed: 0.05 }],
      ['Minor Potions', 'Minor potion recipes unlocked. Training-wheel chemistry.', { 'recipe:potion_minor': 1 }],
      ['Antidote Access', 'Antidote recipes unlocked. For the OTHER potions.', { 'recipe:potion_antidote': 1 }],
      ['Fume Tolerance', '+3% potency. The fumes respect you now.', { potency: 0.03 }],
      ['Greater Potions', 'Greater potion recipes unlocked. Now with more "whoa".', { 'recipe:potion_greater': 1 }],
      ['Elixir Rights', 'Elixir recipes unlocked. The fancy bottles.', { 'recipe:potion_elixir': 1 }],
      ['Mythic Brews', 'Mythic brews unlocked. Label them. LABEL THEM.', { 'recipe:potion_mythic': 1 }]
    ],
    a: [
      ['Pre-Measured Chaos', '+5% brew speed. Chaos, but in little jars.', { brewSpeed: 0.05 }],
      ['Two Cauldrons', '+6% brew speed. Double the bubble.', { brewSpeed: 0.06 }],
      ['Controlled Burns', '+7% brew speed. The explosions are scheduled now.', { brewSpeed: 0.07 }],
      ['Lab Goblin Hours', '+8% brew speed. 3am is when the good brewing happens.', { brewSpeed: 0.08 }]
    ],
    b: [
      ['Strong Stuff', '+4% potency. The label just says "NO".', { potency: 0.04 }],
      ['Residue Rescue', '4% chance of a bonus potion. Scrape the cauldron.', { doublePotion: 0.04 }],
      ['Reduction Reduction', '+4% potency. Boil it down. Then down again.', { potency: 0.04 }],
      ['Suspiciously Effective', '+6% bonus potion chance. Stop asking how.', { doublePotion: 0.06 }]
    ],
    f: [
      ['Labeled Jars', '+4% brew speed. Revolutionary technology: words.', { brewSpeed: 0.04 }],
      ['Goggles Actually On', '+3% brew speed. On the EYES. Not the forehead.', { brewSpeed: 0.03 }],
      ['Taste-Adjacent Testing', '+2% potency. You wave it near your face. Science.', { potency: 0.02 }]
    ],
    caps: [
      ['Industrial Bubbling', '+15% brew speed. OSHA has questions. OSHA can wait.', { brewSpeed: 0.15 }],
      ['Double Batch Doctrine', '+10% bonus potion chance. One cauldron, two incomes.', { doublePotion: 0.1 }],
      ['Potent Precision', '+8% potency. Measured to the eyelash.', { potency: 0.08 }],
      ['Overflowing Flasks', '+6% bonus potions, +5% speed. The shelf is begging for mercy.', { doublePotion: 0.06, brewSpeed: 0.05 }],
      ["Philosopher's Intern", '+10% potency, +8% bonus potions. Lead into gold? No. Herbs into miracles? Daily.', { potency: 0.1, doublePotion: 0.08 }]
    ]
  },

  tailoring: {
    autos: [
      ['Thread the Needle (Eventually)', 'Tailoring unlocked. Attempt 47 was the charm.', { 'unlock:sew': 1 }],
      ['Straight Seams', '+5% sew speed. The hem committee approves.', { sewSpeed: 0.05 }],
      ['Cloth Armor Patterns', 'Cloth armor recipes unlocked. Cozy protection.', { 'recipe:cloth_set': 1 }],
      ['Leather Patterns', 'Leather gear recipes unlocked. Rugged. Squeaky.', { 'recipe:leather_set': 1 }],
      ['Pattern Memory', '4% chance to save cloth. The scissors remember.', { saveCloth: 0.04 }],
      ['Fine Garb Patterns', 'Fine garb recipes unlocked. For fancy violence.', { 'recipe:fine_set': 1 }],
      ['Crystal-Weave', 'Crystal-weave recipes unlocked. Thread that hums.', { 'recipe:crystal_set': 1 }],
      ['Mythic Couture', 'Mythic couture unlocked. The runway is a battlefield.', { 'recipe:mythic_set': 1 }]
    ],
    a: [
      ['Thimble Devotion', '+5% sew speed. Protect the finger. Honor the finger.', { sewSpeed: 0.05 }],
      ['Pins Everywhere', '+6% sew speed. The floor is a minefield. Worth it.', { sewSpeed: 0.06 }],
      ['Sewing Trance', '+7% sew speed. You woke up and the cloak was done.', { sewSpeed: 0.07 }],
      ['Possessed Needle', '+8% sew speed. It sews alone. You take the credit.', { sewSpeed: 0.08 }]
    ],
    b: [
      ['Scrap Patchwork', '+4% cloth save. Scraps are just small victories.', { saveCloth: 0.04 }],
      ['Double Stitching', '+3% quality chance. Twice the stitch, none of the regret.', { quality: 0.03 }],
      ['Offcut Alchemy', '+5% cloth save. Nothing hits the floor on your watch.', { saveCloth: 0.05 }],
      ['Haute Structure', '+5% quality chance. Shoulder pads with a thesis.', { quality: 0.05 }]
    ],
    f: [
      ['Good Lighting', '+4% sew speed. Squinting was never the aesthetic.', { sewSpeed: 0.04 }],
      ['Measured Thrice', '+2% quality chance. Paranoia, but fashionable.', { quality: 0.02 }],
      ['Lint Removal Ritual', '+3% sew speed. The ritual demands tape.', { sewSpeed: 0.03 }]
    ],
    caps: [
      ['Sweatshop of One', '+15% sew speed. You unionized against yourself and lost.', { sewSpeed: 0.15 }],
      ['Zero-Waste Pattern', '+10% cloth save. The offcut bin retired early.', { saveCloth: 0.1 }],
      ['Runway Ready', '+8% quality chance. Monsters pause to appreciate the fit.', { quality: 0.08 }],
      ['Fabric Wholesaler', '+8% cloth save, +5% speed. Bolts of cloth fear your scissors.', { saveCloth: 0.08, sewSpeed: 0.05 }],
      ['The Needle Ascendant', '+10% quality, +10% speed. NPCs change their canon outfits for you.', { quality: 0.1, sewSpeed: 0.1 }]
    ]
  }
}

/* ========================================================================== *
 *  Built catalog + lookups.                                                  *
 * ========================================================================== */

const TREES = new Map<string, readonly TreeNodeDef[]>()
const BY_ID = new Map<string, TreeNodeDef>()
for (const [skill, spec] of Object.entries(SPECS)) {
  const nodes = build(skill, spec)
  TREES.set(skill, nodes)
  for (const n of nodes) BY_ID.set(n.id, n)
}

/** All nodes of one skill's tree ([] for unknown skills). */
export function treeNodes(skill: string): readonly TreeNodeDef[] {
  return TREES.get(skill) ?? []
}

/** Node lookup by id. */
export function treeNode(id: string): TreeNodeDef | undefined {
  return BY_ID.get(id)
}

/** Every node of every tree. */
export function allTreeNodes(): ReadonlyMap<string, TreeNodeDef> {
  return BY_ID
}
