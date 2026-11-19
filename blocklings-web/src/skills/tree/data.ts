/**
 * Blocklings skill trees — the node catalog.
 *
 * 14 skills x 241 nodes = 3374 nodes. The first 24 slots of every skill are
 * the original hand-authored skeleton (ids FROZEN — saves reference them); the
 * remaining ~217 are procedurally stamped deeper ranks that reuse each skill's
 * own effect vocabulary, escalating in magnitude AND in point price:
 *
 *   autos    u1..u8   @ lvl 1/5/10/20/30/40/60/85 — granted free (actions,
 *                       recipes, material tiers) — PLUS u9..u21 @ 100..910, free
 *                       passive bonuses in the skill's own stat.
 *   branch A a1..a4   @ lvl 3/12/22/38 — PLUS a5..a72 @ 44..975, one long chained
 *                       perk path (each needs the previous).
 *   branch B b1..b4   @ lvl 3/12/22/38 — PLUS b5..b72, the rival chained path.
 *   floaters f1..f3   @ lvl 8/16/28    — PLUS f4..f60 @ 35..950, standalone perks.
 *   capstones         @ 50/50/75/75/99 — original five — PLUS five new exclusive
 *                       pairs c150a|c150b .. c800a|c800b and a final c999.
 *
 * Point economy: autos cost 0; perk cost = round(lvl/36) (1..60), capstone cost
 * = round(lvl/26) (2..70). The whole catalog costs ~41,160 points; a fully-maxed
 * (all skills 999) player earns 13,972 — so picks are scarce and choices matter.
 *
 * Node ids are `${skill}.${slot}` ('mining.b4') — short on purpose, they are
 * persisted. Effects are modifier keys summed by SkillTreeAPI.modifier();
 * 'recipe:*' / 'tier:*' / 'unlock:*' keys are 0/1 flags, everything else is
 * an additive fraction (0.05 = +5%). Generated nodes NEVER mint new gate keys.
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
  /** Layout grid position (x grows with lvlReq, y picks a lane). */
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
const BRANCH_LVLS = [3, 12, 22, 38] as const
const FLOAT_LVLS = [8, 16, 28] as const

/* -------------------------------------------------------------------------- *
 *  Extended-tree level ladders (shared by every skill).                      *
 * -------------------------------------------------------------------------- */

/** New free-auto levels (u9..u21). */
const NEW_AUTO_LVLS = [100, 120, 145, 175, 210, 250, 300, 360, 430, 520, 630, 760, 910] as const
/** New chained-perk levels (a5..a72 / b5..b72): 68 steps, 44 -> 975. */
const NEW_BRANCH_LVLS: number[] = Array.from({ length: 68 }, (_, k) =>
  Math.round(44 + (k * (975 - 44)) / 67)
)
/** New standalone-floater levels (f4..f60): 57 steps, 35 -> 950. */
const NEW_FLOAT_LVLS: number[] = Array.from({ length: 57 }, (_, k) =>
  Math.round(35 + (k * (950 - 35)) / 56)
)
/** New exclusive capstone pairs. */
const NEW_CAP_LVLS = [150, 250, 400, 600, 800] as const

/* -------------------------------------------------------------------------- *
 *  Cost + magnitude curves.                                                  *
 * -------------------------------------------------------------------------- */

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const round2 = (n: number): number => Math.round(n * 100) / 100

/** Perk-point price from kind + level. autos free; deep nodes dear. */
function costOf(kind: TreeNode['kind'], lvlReq: number): number {
  if (kind === 'auto') return 0
  if (kind === 'capstone') return clampN(Math.round(lvlReq / 26), 2, 70)
  return clampN(Math.round(lvlReq / 36), 1, 60)
}

const isFlatKey = (key: string): boolean => key === 'hpRegen' || key === 'mpRegen'

/** Escalating magnitude for a generated perk effect. */
function perkMag(key: string, lvl: number): number {
  return isFlatKey(key) ? round2(0.1 + lvl * 0.0018) : round2(0.02 + lvl * 0.00035)
}
/** Escalating magnitude for a free-auto bonus (gentler than a perk). */
function autoMag(key: string, lvl: number): number {
  return isFlatKey(key) ? round2(0.1 + lvl * 0.0008) : round2(0.02 + lvl * 0.0002)
}
/** Escalating magnitude for a capstone effect (steepest). */
function capMag(key: string, lvl: number): number {
  return isFlatKey(key) ? round2(0.15 + lvl * 0.00035) : round2(0.05 + lvl * 0.0005)
}

/* -------------------------------------------------------------------------- *
 *  Generated-content flavor (names + quips). Deterministic, varied, on-voice. *
 * -------------------------------------------------------------------------- */

const pick = <X>(arr: readonly X[], seed: number): X =>
  arr[((Math.trunc(seed) % arr.length) + arr.length) % arr.length]!

const ADJ = [
  'Relentless', 'Unhinged', 'Caffeinated', 'Spiteful', 'Feral', 'Obsessive',
  'Unpaid', 'Overqualified', 'Sleep-Deprived', 'Mildly Cursed', 'Aggressively Average',
  'Professionally Petty', 'Suspiciously Effective', 'Legally Distinct', 'Quietly Unwell',
  'Chronically Committed', 'Borderline Illegal', 'Emotionally Invested',
  'Deeply Unnecessary', 'Weaponized'
] as const

const QUIPS = [
  'The grind respects no one. You, least of all.',
  'Progress! Allegedly.',
  'Your ancestors are confused, but supportive.',
  'Nobody asked for this. You did it anyway.',
  'A skill nobody will thank you for.',
  'Diminishing returns, maximized spite.',
  'You could have slept. You chose this.',
  'The numbers go up. The soul stays put.',
  'Peaked at a hobby. Still climbing.',
  'One more rank. It is always one more rank.',
  'Mastery: a word, a burden, a Tuesday.',
  'The talent tree grew. So did the debt.',
  'Technically an improvement.',
  'Your therapist calls this "a lot".',
  'Worth it, probably, almost certainly, maybe.',
  'The bar went up. You went with it.',
  'Hard work beats talent when talent naps.',
  'Excellence, out of pure stubbornness.',
  'You optimized a life you forgot to live.',
  'Small gains, enormous commitment issues.',
  'The meta fears a person with free time.',
  'Min-maxed, max-regretted.',
  'Still better than a real job. Marginally.',
  'Growth: unsettling, relentless, yours.'
] as const

const CAP_QUIPS = [
  'A capstone. The tree bends the knee.',
  'This is what the whole grind was for. Supposedly.',
  'Legends are mostly just people who did not stop.',
  'The ceiling called. You put a hole in it.',
  'History will footnote this. In small print.',
  'You crossed a line most people cannot see.',
  'Overpowered, over budget, over it.',
  'The devs did not plan for you.',
  'A power so great it needs a nap after.',
  'Peak form. Downhill is a myth you ignore.',
  'The grandmaster tier. Lonely up here.',
  'Final-form energy, with a slight limp.'
] as const

const CAP_TITLE = [
  'Apex', 'Zenith', 'Ascendant', 'Grandmaster', 'Paragon', 'Transcendent',
  'Ultimate', 'Legendary', 'Mythic', 'Overlord'
] as const

const SKILL_NOUN: Record<string, readonly string[]> = {
  attack: ['Swing', 'Haymaker', 'Follow-Through', 'Overhead', 'Backhand', 'Windup', 'Smackdown', 'Clobber', 'Wallop', 'Bonk Theory', 'Grievance', 'Finisher'],
  defense: ['Stance', 'Bulwark', 'Flinch', 'Turtling', 'Wall', 'Guard', 'Shrug', 'Deflection', 'Stubbornness', 'Resolve', 'Blockade', 'Immovability'],
  magic: ['Incantation', 'Sparkwork', 'Hex', 'Cantrip', 'Channel', 'Arcana', 'Sorcery', 'Mumbo', 'Glyphcraft', 'Overcast', 'Thaumaturgy', 'Spellspam'],
  archery: ['Loose', 'Draw', 'Volley', 'Bullseye', 'Nock', 'Longshot', 'Snipe', 'Fletching', 'Trick Shot', 'Quickdraw', 'Perforation', 'Groupings'],
  vitality: ['Constitution', 'Second Wind', 'Stamina', 'Beefiness', 'Vigor', 'Heartbeat', 'Durability', 'Gusto', 'Lifeforce', 'Hardiness', 'Pulse', 'Survivability'],
  mining: ['Swing', 'Delve', 'Vein Sense', 'Excavation', 'Crunch', 'Pickwork', 'Tunneling', 'Ore Lust', 'Deep Dig', 'Rock Logic', 'Prospecting', 'Quarrying'],
  woodcutting: ['Chop', 'Timber', 'Felling', 'Notch', 'Swing', 'Limbing', 'Clearcut', 'Grain Sense', 'Splitting', 'Lumberjackery', 'Deforestation', 'Sawdust'],
  fishing: ['Cast', 'Reel', 'Catch', 'Patience', 'Lure Craft', 'Angling', 'Nibble', 'Tug', 'Deep Haul', 'Baitcraft', 'Trawling', 'Overfishing'],
  farming: ['Harvest', 'Tilling', 'Sowing', 'Cultivation', 'Green Thumb', 'Rotation', 'Yield', 'Pruning', 'Reaping', 'Agronomy', 'Composting', 'Bumper Crop'],
  herbalism: ['Gather', 'Forage', 'Pinch', 'Snip', 'Pluck', 'Fieldcraft', 'Harvest', 'Bundle', 'Trimming', 'Botany', 'Weed Lore', 'Overpicking'],
  blacksmithing: ['Hammer', 'Forge', 'Temper', 'Quench', 'Anvilcraft', 'Strike', 'Fold', 'Smithing', 'Clang', 'Metallurgy', 'Heatwork', 'Reforge'],
  cooking: ['Simmer', 'Sear', 'Plating', 'Chop', 'Flambé', 'Seasoning', 'Sauté', 'Roast', 'Flavorcraft', 'Mise', 'Braise', 'Overcooking'],
  alchemy: ['Brew', 'Distillation', 'Stir', 'Reduction', 'Bubble', 'Mixology', 'Reagentwork', 'Infusion', 'Decoction', 'Transmutation', 'Steeping', 'Overbrew'],
  tailoring: ['Stitch', 'Seam', 'Hemwork', 'Cut', 'Weave', 'Needlecraft', 'Pattern', 'Tailoring', 'Pleat', 'Dressmaking', 'Lining', 'Overstitch']
}

const ROMAN: readonly [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
]
function roman(n: number): string {
  let r = ''
  let v = n
  for (const [val, sym] of ROMAN) {
    while (v >= val) {
      r += sym
      v -= val
    }
  }
  return r || 'I'
}

/** A generated perk/auto name — adj + skill noun + a rank numeral (unique/rank). */
function genName(skill: string, off: number, rank: number): string {
  const nouns = SKILL_NOUN[skill] ?? ['Mastery']
  return `${pick(ADJ, rank * 2 + off)} ${pick(nouns, rank * 3 + off * 5)} ${roman(rank)}`
}
/** A generated capstone name — grand title + skill noun. */
function genCapName(skill: string, off: number): string {
  const nouns = SKILL_NOUN[skill] ?? ['Mastery']
  return `${pick(CAP_TITLE, off)}: ${pick(nouns, off * 3 + 4)}`
}

/* -------------------------------------------------------------------------- *
 *  Per-skill effect palette for the generated ranks (reuses existing keys).  *
 * -------------------------------------------------------------------------- */

interface Palette {
  /** Stat the free deep autos pump. */
  auto: string
  /** Branch-A chained-perk stat. */
  a: string
  /** Branch-B chained-perk stat. */
  b: string
  /** Floater stats, cycled by floater index. */
  f: readonly string[]
  /** Capstone side-A combo (two stats). */
  capA: readonly [string, string]
  /** Capstone side-B combo (two stats). */
  capB: readonly [string, string]
  /** The final c999 combo. */
  capFinal: readonly [string, string]
}

const PALETTE: Record<string, Palette> = {
  attack: { auto: 'atkDmgPct', a: 'critDmg', b: 'cleave', f: ['atkSpeed', 'comboDmg', 'crit'], capA: ['critDmg', 'crit'], capB: ['cleave', 'atkSpeed'], capFinal: ['atkDmgPct', 'crit'] },
  defense: { auto: 'maxHpPct', a: 'dmgReducePct', b: 'thorns', f: ['maxHpPct', 'blockChance', 'dmgReducePct'], capA: ['dmgReducePct', 'maxHpPct'], capB: ['thorns', 'blockChance'], capFinal: ['dmgReducePct', 'maxHpPct'] },
  magic: { auto: 'mpMaxPct', a: 'magDmgPct', b: 'dmgReducePct', f: ['castSpeed', 'mpRegen', 'magDmgPct'], capA: ['magDmgPct', 'chain'], capB: ['dmgReducePct', 'maxHpPct'], capFinal: ['magDmgPct', 'mpMaxPct'] },
  archery: { auto: 'atkDmgPct', a: 'critDmg', b: 'dmgReducePct', f: ['atkSpeed', 'comboDmg', 'atkDmgPct'], capA: ['critDmg', 'crit'], capB: ['dmgReducePct', 'blockChance'], capFinal: ['atkDmgPct', 'crit'] },
  vitality: { auto: 'maxHpPct', a: 'maxHpPct', b: 'hpRegen', f: ['maxHpPct', 'hpRegen', 'lifesteal'], capA: ['maxHpPct', 'hpRegen'], capB: ['lifesteal', 'foodHealPct'], capFinal: ['maxHpPct', 'hpRegen'] },
  mining: { auto: 'mineSpeed', a: 'mineSpeed', b: 'doubleOre', f: ['mineSpeed', 'gemFind', 'doubleOre'], capA: ['mineSpeed', 'gemFind'], capB: ['doubleOre', 'gemFind'], capFinal: ['mineSpeed', 'doubleOre'] },
  woodcutting: { auto: 'chopSpeed', a: 'chopSpeed', b: 'doubleWood', f: ['chopSpeed', 'nestFind', 'doubleWood'], capA: ['chopSpeed', 'nestFind'], capB: ['doubleWood', 'nestFind'], capFinal: ['chopSpeed', 'doubleWood'] },
  fishing: { auto: 'fishSpeed', a: 'fishSpeed', b: 'doubleFish', f: ['fishSpeed', 'treasureFind', 'doubleFish'], capA: ['fishSpeed', 'treasureFind'], capB: ['doubleFish', 'treasureFind'], capFinal: ['fishSpeed', 'doubleFish'] },
  farming: { auto: 'growSpeed', a: 'growSpeed', b: 'doubleCrop', f: ['growSpeed', 'seedSave', 'doubleCrop'], capA: ['growSpeed', 'seedSave'], capB: ['doubleCrop', 'seedSave'], capFinal: ['growSpeed', 'doubleCrop'] },
  herbalism: { auto: 'gatherSpeed', a: 'gatherSpeed', b: 'doubleHerb', f: ['gatherSpeed', 'rareHerb', 'doubleHerb'], capA: ['gatherSpeed', 'rareHerb'], capB: ['doubleHerb', 'rareHerb'], capFinal: ['gatherSpeed', 'doubleHerb'] },
  blacksmithing: { auto: 'smithSpeed', a: 'smithSpeed', b: 'saveBar', f: ['smithSpeed', 'quality', 'saveBar'], capA: ['smithSpeed', 'quality'], capB: ['saveBar', 'quality'], capFinal: ['smithSpeed', 'quality'] },
  cooking: { auto: 'cookSpeed', a: 'cookSpeed', b: 'foodHealPct', f: ['cookSpeed', 'noBurn', 'foodHealPct'], capA: ['cookSpeed', 'noBurn'], capB: ['foodHealPct', 'noBurn'], capFinal: ['cookSpeed', 'foodHealPct'] },
  alchemy: { auto: 'brewSpeed', a: 'brewSpeed', b: 'potency', f: ['brewSpeed', 'doublePotion', 'potency'], capA: ['brewSpeed', 'doublePotion'], capB: ['potency', 'doublePotion'], capFinal: ['brewSpeed', 'potency'] },
  tailoring: { auto: 'sewSpeed', a: 'sewSpeed', b: 'saveCloth', f: ['sewSpeed', 'quality', 'saveCloth'], capA: ['sewSpeed', 'quality'], capB: ['saveCloth', 'quality'], capFinal: ['sewSpeed', 'saveCloth'] }
}

const DEFAULT_PALETTE: Palette = {
  auto: 'maxHpPct', a: 'maxHpPct', b: 'maxHpPct', f: ['maxHpPct'],
  capA: ['maxHpPct', 'maxHpPct'], capB: ['maxHpPct', 'maxHpPct'], capFinal: ['maxHpPct', 'maxHpPct']
}

/* -------------------------------------------------------------------------- *
 *  Layout: x grows with lvlReq (left -> right progression), y is the lane.    *
 * -------------------------------------------------------------------------- */

const LVL_SX = 0.11 // grid columns per level
const LANE = {
  capTop: 0.2,
  branchA: 1.1,
  floatA: 1.55,
  spine: 2.0,
  floatB: 2.45,
  branchB: 2.9,
  capBot: 3.8
} as const

const lvlX = (lvl: number): number => lvl * LVL_SX

function build(skill: string, s: Spec): TreeNodeDef[] {
  const id = (slot: string): string => `${skill}.${slot}`
  const out: TreeNodeDef[] = []
  const node = (
    slot: string,
    kind: TreeNode['kind'],
    lvlReq: number,
    t: T,
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
      cost: costOf(kind, lvlReq),
      effects: t[2],
      requires,
      x: lvlX(lvlReq),
      y,
      ...extra
    })
  }

  const pal = PALETTE[skill] ?? DEFAULT_PALETTE
  let seedBase = 0
  for (let i = 0; i < skill.length; i++) seedBase += skill.charCodeAt(i) * (i + 1)

  // --- auto spine: original 8 (free gate/stat unlocks) -----------------------
  for (let i = 0; i < 8; i++) {
    node(`u${i + 1}`, 'auto', AUTO_LVLS[i]!, s.autos[i]!, LANE.spine, [],
      i > 0 ? { vis: id(`u${i}`) } : {})
  }
  // --- deep autos u9..u21: free passive bonuses in the skill's stat ----------
  for (let i = 0; i < NEW_AUTO_LVLS.length; i++) {
    const slot = `u${9 + i}`
    const lvl = NEW_AUTO_LVLS[i]!
    const t: T = [genName(skill, seedBase + 101, i + 1), pick(QUIPS, seedBase + i * 5 + 1),
      { [pal.auto]: autoMag(pal.auto, lvl) }]
    node(slot, 'auto', lvl, t, LANE.spine, [], { vis: id(`u${8 + i}`) })
  }

  // --- branch A (chained) + branch B (chained): original 4 + deep ranks -------
  for (let i = 0; i < 4; i++) {
    node(`a${i + 1}`, 'perk', BRANCH_LVLS[i]!, s.a[i]!, LANE.branchA,
      i > 0 ? [id(`a${i}`)] : [], i === 0 ? { vis: id('u1') } : {})
    node(`b${i + 1}`, 'perk', BRANCH_LVLS[i]!, s.b[i]!, LANE.branchB,
      i > 0 ? [id(`b${i}`)] : [], i === 0 ? { vis: id('u1') } : {})
  }
  for (let i = 0; i < NEW_BRANCH_LVLS.length; i++) {
    const rank = i + 5 // slot index (a5, a6, ...)
    const lvl = NEW_BRANCH_LVLS[i]!
    const ta: T = [genName(skill, seedBase + 11, rank), pick(QUIPS, seedBase + rank * 3),
      { [pal.a]: perkMag(pal.a, lvl) }]
    node(`a${rank}`, 'perk', lvl, ta, LANE.branchA, [id(`a${rank - 1}`)])
    const tb: T = [genName(skill, seedBase + 29, rank), pick(QUIPS, seedBase + rank * 3 + 7),
      { [pal.b]: perkMag(pal.b, lvl) }]
    node(`b${rank}`, 'perk', lvl, tb, LANE.branchB, [id(`b${rank - 1}`)])
  }

  // --- floaters (standalone): original 3 + deep ranks ------------------------
  node('f1', 'perk', FLOAT_LVLS[0]!, s.f[0]!, LANE.floatA, [], { vis: id('u2') })
  node('f2', 'perk', FLOAT_LVLS[1]!, s.f[1]!, LANE.floatB, [], { vis: id('u3') })
  node('f3', 'perk', FLOAT_LVLS[2]!, s.f[2]!, LANE.floatA, [], { vis: id('u4') })
  for (let i = 0; i < NEW_FLOAT_LVLS.length; i++) {
    const rank = i + 4 // f4, f5, ...
    const lvl = NEW_FLOAT_LVLS[i]!
    const key = pal.f[i % pal.f.length]!
    const t: T = [genName(skill, seedBase + 53, rank), pick(QUIPS, seedBase + rank * 5 + 3),
      { [key]: perkMag(key, lvl) }]
    node(`f${rank}`, 'perk', lvl, t, i % 2 === 0 ? LANE.floatA : LANE.floatB)
  }

  // --- capstones: original 5 (ids + excl + requires FROZEN) ------------------
  node('c50a', 'capstone', 50, s.caps[0]!, LANE.capTop, [id('a4')], { excl: id('c50') })
  node('c50b', 'capstone', 50, s.caps[1]!, LANE.capBot, [id('b4')], { excl: id('c50') })
  node('c75a', 'capstone', 75, s.caps[2]!, LANE.capTop, [], { excl: id('c75'), vis: id('c50a') })
  node('c75b', 'capstone', 75, s.caps[3]!, LANE.capBot, [], { excl: id('c75'), vis: id('c50b') })
  node('c99', 'capstone', 99, s.caps[4]!, LANE.spine, [], { vis: id('u7') })
  // --- new exclusive capstone pairs ------------------------------------------
  for (let i = 0; i < NEW_CAP_LVLS.length; i++) {
    const lvl = NEW_CAP_LVLS[i]!
    const grp = id(`c${lvl}`)
    const aName = genCapName(skill, seedBase + lvl)
    const bName = genCapName(skill, seedBase + lvl + 7)
    const ta: T = [aName, pick(CAP_QUIPS, seedBase + i),
      { [pal.capA[0]]: capMag(pal.capA[0], lvl), [pal.capA[1]]: capMag(pal.capA[1], lvl) }]
    const tb: T = [bName, pick(CAP_QUIPS, seedBase + i + 6),
      { [pal.capB[0]]: capMag(pal.capB[0], lvl), [pal.capB[1]]: capMag(pal.capB[1], lvl) }]
    node(`c${lvl}a`, 'capstone', lvl, ta, LANE.capTop, [], { excl: grp })
    node(`c${lvl}b`, 'capstone', lvl, tb, LANE.capBot, [], { excl: grp })
  }
  // --- the grand finisher ----------------------------------------------------
  {
    const tf: T = [`Singularity: ${pick(SKILL_NOUN[skill] ?? ['Mastery'], seedBase + 2)}`,
      pick(CAP_QUIPS, seedBase + 11),
      { [pal.capFinal[0]]: capMag(pal.capFinal[0], 999), [pal.capFinal[1]]: capMag(pal.capFinal[1], 999) }]
    node('c999', 'capstone', 999, tf, LANE.spine, [], { vis: id('c800a') })
  }
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
      ['Mana Ward', 'Bleed off a little mana to blunt blows: +3% damage reduction.', { dmgReducePct: 0.03 }],
      ['Spell Resist', '+3% reduction, +3% max HP. Hostile magic finds you deeply boring.', { dmgReducePct: 0.03, maxHpPct: 0.03 }],
      ['Backlash Barrier', 'Attackers eat 6% of their own damage as arcane feedback.', { thorns: 0.06 }],
      ['Arcane Shell', '+5% damage reduction. A shimmer you can almost see.', { dmgReducePct: 0.05 }]
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

  archery: {
    autos: [
      ['Which End Points Out', 'You may now nock an arrow correctly. Basic shots unlocked.', { 'unlock:shoot': 1 }],
      ['Draw Weight', 'Unlocks power shots: slower draw, much ruder arrival.', { 'unlock:powerShot': 1 }],
      ['Iron Tips', 'You are allowed iron arrowheads now. The deer have noticed.', { 'tier:iron': 1 }],
      ['Steel Fletching', 'Steel-tipped arrows unlocked. Heavier. Meaner.', { 'tier:steel': 1 }],
      ['Rapid Nock', 'Every third shot flies 15% harder. Rhythm is a weapon.', { comboDmg: 0.15 }],
      ['Gold Shafts', 'Gold arrows unlocked. Wildly impractical. You do it anyway.', { 'tier:gold': 1 }],
      ['Crystal Broadheads', 'Crystal arrows unlocked. They sparkle mid-flight. Then mid-you.', { 'tier:crystal': 1 }],
      ['Mythic Quiver', 'Mythic arrows unlocked. They never run out, and they know it.', { 'tier:mythic': 1 }]
    ],
    a: [
      ['Aim Small, Miss Small', '+3% crit chance. Pick a freckle. Hit the freckle.', { crit: 0.03 }],
      ['Weak-Point Enthusiast', '+4% crit chance. You read the enemy manual. Cover to cover.', { crit: 0.04 }],
      ['Impalement Studies', '+25% crit damage. Honours thesis: "Through And Out The Back."', { critDmg: 0.25 }],
      ['Bullseye. Mostly.', '+5% crit, +25% crit damage. Precision, with a scenic exit wound.', { crit: 0.05, critDmg: 0.25 }]
    ],
    b: [
      ['Nimble Footwork', '+2% damage reduction — you are rarely still where the blow lands.', { dmgReducePct: 0.02 }],
      ['Leather and Luck', '+3% reduction, +3% max HP. Light armor, lighter conscience.', { dmgReducePct: 0.03, maxHpPct: 0.03 }],
      ['Roll Away', '+5% evasion (block chance). The ground is a fine place to be, briefly.', { blockChance: 0.05 }],
      ['Ghost Step', '+4% reduction. They keep swinging at where you just were.', { dmgReducePct: 0.04 }]
    ],
    f: [
      ['Bracer Discipline', '+4% arrow damage. No more string-slapped forearms.', { atkDmgPct: 0.04 }],
      ['Steady Breath', '+6% arrow damage from exhaling at the right moment.', { atkDmgPct: 0.06 }],
      ['Range Diary', '+2% crit, +4% damage. Dear diary: hit the thing from very far away.', { crit: 0.02, atkDmgPct: 0.04 }]
    ],
    caps: [
      ['Headhunter Memo', 'Enemies under 25% HP take +30% damage. The quiver does the paperwork.', { execDmg: 0.3 }],
      ['Arrow Storm', '+25% pierce, +5% draw speed. Legally classified as weather.', { cleave: 0.25, atkSpeed: 0.05 }],
      ['Dead-Eye', '+8% crit, +40% crit damage. You stopped missing. It got awkward.', { crit: 0.08, critDmg: 0.4 }],
      ['Collateral Fletching', '+12% damage, +10% pierce. The fence behind them also died.', { atkDmgPct: 0.12, cleave: 0.1 }],
      ['Legolas Allegations', '+20% damage, +5% crit. Witnesses disagree on how many arrows that was.', { atkDmgPct: 0.2, crit: 0.05 }]
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
