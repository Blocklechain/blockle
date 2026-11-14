/**
 * Crafting recipes — the full book for the 4 production professions.
 * Every id is a REAL src/items/catalog.ts id (no invented outputs; the items
 * module exposes no runtime registration, so nothing synthetic ships).
 *
 * Gating: a recipe needs `levelReq` in its skill AND (when `gate` is set) a
 * truthy skill-tree modifier — the 'recipe:*' / 'unlock:*' flags the talent
 * trees grant automatically at their level (src/skills/tree/data.ts), read
 * through SkillTreeAPI.modifier(). A modifier `recipe:<outputId>` > 0 also
 * force-unlocks a recipe regardless of gates (future tree content hook).
 *
 * Counts: blacksmithing 57 (5 smelt + 2 rods + 50 gear), cooking 12,
 * alchemy 12 (2 jokey), tailoring 9 — 90 total. Mythic is NOT craftable:
 * drops only, exactly as the mythic tier deserves.
 */

export type CraftSkill = 'blacksmithing' | 'cooking' | 'alchemy' | 'tailoring'

export interface RecipeInput {
  id: string
  qty: number
}

export interface Recipe {
  id: string
  skill: CraftSkill
  /** Skill level required (display + hard gate). */
  levelReq: number
  inputs: RecipeInput[]
  output: { id: string; qty: number }
  /** Skill XP granted per successful craft. */
  xp: number
  /** Skill-tree flag that must be >0 ('recipe:*' / 'unlock:*'). */
  gate?: string
}

const r = (
  skill: CraftSkill,
  levelReq: number,
  inputs: RecipeInput[],
  output: { id: string; qty: number },
  xp: number,
  gate?: string
): Recipe => ({
  id: `${skill}:${output.id}`,
  skill,
  levelReq,
  inputs,
  output,
  xp,
  ...(gate !== undefined ? { gate } : {})
})

const inp = (id: string, qty: number): RecipeInput => ({ id, qty })

// ---------------------------------------------------------------------------
// Blacksmithing — smelting + the full gear ladder, copper..crystal.
// ---------------------------------------------------------------------------

const SMELTING: Recipe[] = [
  r('blacksmithing', 1, [inp('ore_copper', 2)], { id: 'bar_copper', qty: 1 }, 6, 'recipe:bar_copper'),
  r('blacksmithing', 10, [inp('ore_iron', 2)], { id: 'bar_iron', qty: 1 }, 10, 'recipe:bar_iron'),
  r('blacksmithing', 20, [inp('bar_iron', 2), inp('wood_oak', 1)], { id: 'bar_steel', qty: 1 }, 16, 'recipe:bar_steel'),
  r('blacksmithing', 40, [inp('ore_gold', 2)], { id: 'bar_gold', qty: 1 }, 26, 'recipe:bar_gold'),
  r('blacksmithing', 60, [inp('crystal_raw', 1), inp('crystal_shard', 1)], { id: 'crystal_cut', qty: 1 }, 40, 'recipe:bar_crystal')
]

const RODS: Recipe[] = [
  r('blacksmithing', 10, [inp('bar_iron', 1), inp('wood_oak', 2)], { id: 'rod_sturdy', qty: 1 }, 14, 'recipe:bar_iron'),
  r('blacksmithing', 40, [inp('bar_gold', 1), inp('wood_ancient', 1)], { id: 'rod_golden', qty: 1 }, 40, 'recipe:bar_gold')
]

/** Tier table: material suffix, "bar" input, level/gate/xp, wood flavor. */
const GEAR_TIERS = [
  { mat: 'copper', bar: 'bar_copper', lvl: 1, gate: 'recipe:bar_copper', xp: 12, wood: 'wood_oak' },
  { mat: 'iron', bar: 'bar_iron', lvl: 10, gate: 'recipe:bar_iron', xp: 20, wood: 'wood_oak' },
  { mat: 'steel', bar: 'bar_steel', lvl: 20, gate: 'recipe:bar_steel', xp: 34, wood: 'wood_oak' },
  { mat: 'gold', bar: 'bar_gold', lvl: 40, gate: 'recipe:bar_gold', xp: 55, wood: 'wood_ancient' },
  { mat: 'crystal', bar: 'crystal_cut', lvl: 60, gate: 'recipe:bar_crystal', xp: 80, wood: 'wood_ancient' }
] as const

/** Gear kinds: bars + wood per craft (wood 0 = pure metalwork). */
const GEAR_KINDS = [
  { kind: 'sword', bars: 3, wood: 1 },
  { kind: 'axe', bars: 3, wood: 1 },
  { kind: 'staff', bars: 1, wood: 3 },
  { kind: 'bow', bars: 1, wood: 3 },
  { kind: 'shield', bars: 4, wood: 1 },
  { kind: 'helm', bars: 3, wood: 0 },
  { kind: 'chest', bars: 5, wood: 0 },
  { kind: 'boots', bars: 2, wood: 0 },
  { kind: 'pick', bars: 2, wood: 2 },
  { kind: 'hatchet', bars: 2, wood: 2 }
] as const

const GEAR: Recipe[] = GEAR_TIERS.flatMap((t) =>
  GEAR_KINDS.map((k) => {
    const inputs: RecipeInput[] = [inp(t.bar, k.bars)]
    if (k.wood > 0) inputs.push(inp(t.wood, k.wood))
    return r('blacksmithing', t.lvl, inputs, { id: `${k.kind}_${t.mat}`, qty: 1 }, t.xp, t.gate)
  })
)

// ---------------------------------------------------------------------------
// Cooking — real restores from real ingredients (plus one proud failure).
// ---------------------------------------------------------------------------

const COOKING: Recipe[] = [
  r('cooking', 1, [inp('fish_raw', 1)], { id: 'food_fish', qty: 1 }, 5, 'unlock:cook'),
  r('cooking', 1, [inp('fish_raw', 1), inp('wood_pine', 1)], { id: 'food_burnt', qty: 1 }, 2, 'unlock:cook'),
  r('cooking', 5, [inp('fish_trout', 1), inp('wood_oak', 1)], { id: 'food_skewer', qty: 1 }, 8, 'unlock:cook'),
  r('cooking', 8, [inp('hide_wolf', 1)], { id: 'food_jerky', qty: 2 }, 9, 'unlock:cook'),
  r('cooking', 10, [inp('wheat', 3)], { id: 'food_bread', qty: 2 }, 11, 'recipe:food_bread'),
  r('cooking', 12, [inp('berry_red', 2), inp('mushroom_brown', 1)], { id: 'food_jelly', qty: 1 }, 12, 'recipe:food_bread'),
  r('cooking', 20, [inp('fish_salmon', 1), inp('wheat', 2), inp('mushroom_brown', 2)], { id: 'food_stew', qty: 1 }, 18, 'recipe:food_stew'),
  r('cooking', 24, [inp('mushroom_brown', 2), inp('herb_red', 1), inp('wood_oak', 1)], { id: 'food_kebab', qty: 1 }, 20, 'recipe:food_stew'),
  r('cooking', 28, [inp('fish_puffer', 1)], { id: 'food_pufferfish', qty: 1 }, 26),
  r('cooking', 40, [inp('wheat', 3), inp('food_jerky', 1)], { id: 'food_pie', qty: 1 }, 34, 'recipe:food_pie'),
  r('cooking', 45, [inp('wheat', 4), inp('berry_red', 3), inp('herb_gold', 1)], { id: 'food_cake', qty: 1 }, 44, 'recipe:food_pie'),
  r('cooking', 60, [inp('fish_golden', 1), inp('food_pie', 1), inp('food_cake', 1)], { id: 'food_feast', qty: 1 }, 70, 'recipe:food_feast')
]

// ---------------------------------------------------------------------------
// Alchemy — herbs + crystals in, regret-adjacent liquids out (2 jokey).
// ---------------------------------------------------------------------------

const ALCHEMY: Recipe[] = [
  r('alchemy', 1, [inp('herb_green', 2)], { id: 'potion_hp_small', qty: 1 }, 6, 'unlock:brew'),
  r('alchemy', 1, [inp('fish_boot', 1), inp('herb_green', 1)], { id: 'potion_regret', qty: 1 }, 3, 'unlock:brew'), // jokey
  r('alchemy', 3, [inp('herb_green', 1), inp('herb_blue', 1)], { id: 'potion_mp_small', qty: 1 }, 7, 'unlock:brew'),
  r('alchemy', 10, [inp('herb_red', 2)], { id: 'potion_hp_med', qty: 1 }, 12, 'recipe:potion_minor'),
  r('alchemy', 12, [inp('herb_blue', 2)], { id: 'potion_mp_med', qty: 1 }, 13, 'recipe:potion_minor'),
  r('alchemy', 16, [inp('mushroom_brown', 1), inp('berry_red', 2), inp('herb_green', 1)], { id: 'potion_mystery', qty: 1 }, 15, 'recipe:potion_antidote'), // jokey
  r('alchemy', 22, [inp('herb_red', 3), inp('crystal_shard', 1)], { id: 'potion_hp_large', qty: 1 }, 22),
  r('alchemy', 24, [inp('herb_blue', 3), inp('crystal_shard', 1)], { id: 'potion_mp_large', qty: 1 }, 23),
  r('alchemy', 30, [inp('crystal_shard', 4)], { id: 'crystal_raw', qty: 1 }, 30),
  r('alchemy', 40, [inp('herb_red', 4), inp('herb_gold', 1)], { id: 'potion_hp_huge', qty: 1 }, 40, 'recipe:potion_greater'),
  r('alchemy', 42, [inp('herb_blue', 4), inp('herb_gold', 1)], { id: 'potion_mp_huge', qty: 1 }, 42, 'recipe:potion_greater'),
  r('alchemy', 60, [inp('herb_gold', 2), inp('crystal_cut', 1)], { id: 'potion_elixir', qty: 1 }, 70, 'recipe:potion_elixir')
]

// ---------------------------------------------------------------------------
// Tailoring — hides + oddments into accessories (the catalog has no capes,
// and items exposes no runtime registration, so the drip is accessory-based).
// ---------------------------------------------------------------------------

const TAILORING: Recipe[] = [
  r('tailoring', 1, [inp('hide_wolf', 1)], { id: 'acc_mustache', qty: 1 }, 6, 'unlock:sew'),
  r('tailoring', 1, [inp('wood_oak', 1), inp('hide_wolf', 1)], { id: 'ring_participation', qty: 1 }, 4, 'unlock:sew'),
  r('tailoring', 5, [inp('hide_boar', 1), inp('crystal_shard', 1)], { id: 'acc_goggles', qty: 1 }, 9, 'unlock:sew'),
  r('tailoring', 10, [inp('hide_wolf', 2)], { id: 'charm_rabbit', qty: 1 }, 13, 'recipe:cloth_set'),
  r('tailoring', 12, [inp('bar_copper', 1), inp('hide_tough', 1)], { id: 'acc_tinfoil', qty: 1 }, 15, 'recipe:cloth_set'),
  r('tailoring', 15, [inp('crystal_shard', 1), inp('hide_wolf', 1)], { id: 'ring_mood', qty: 1 }, 17, 'recipe:leather_set'),
  r('tailoring', 20, [inp('hide_tough', 1), inp('bar_gold', 1)], { id: 'amulet_grandma', qty: 1 }, 24, 'recipe:leather_set'),
  r('tailoring', 30, [inp('bar_gold', 2), inp('hide_tough', 2)], { id: 'amulet_debt', qty: 1 }, 36, 'recipe:fine_set'),
  r('tailoring', 45, [inp('crystal_cut', 1), inp('bar_gold', 1), inp('hide_tough', 1)], { id: 'amulet_block', qty: 1 }, 60, 'recipe:crystal_set')
]

// ---------------------------------------------------------------------------

export const RECIPES: readonly Recipe[] = [
  ...SMELTING,
  ...RODS,
  ...GEAR,
  ...COOKING,
  ...ALCHEMY,
  ...TAILORING
]

const bySkill = new Map<CraftSkill, Recipe[]>()
for (const rec of RECIPES) {
  const list = bySkill.get(rec.skill) ?? []
  list.push(rec)
  bySkill.set(rec.skill, list)
}
// Stable presentation order: by level, then by name-ish id.
for (const list of bySkill.values()) {
  list.sort((a, b) => a.levelReq - b.levelReq || a.id.localeCompare(b.id))
}

export function recipesFor(skill: CraftSkill): readonly Recipe[] {
  return bySkill.get(skill) ?? []
}
