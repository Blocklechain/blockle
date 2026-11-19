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

import { EXTRA_RECIPES } from '../content/packs'

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
  r('blacksmithing', 60, [inp('crystal_raw', 1), inp('crystal_shard', 1)], { id: 'crystal_cut', qty: 1 }, 40, 'recipe:bar_crystal'),
  // --- endgame smelting chain (ungated: the high blacksmithing level IS the gate) ---
  r('blacksmithing', 80, [inp('ore_obsidian', 2), inp('bar_gold', 1)], { id: 'bar_obsidian', qty: 1 }, 110),
  r('blacksmithing', 150, [inp('ore_dragonbone', 2), inp('bar_obsidian', 1)], { id: 'bar_dragonbone', qty: 1 }, 180),
  r('blacksmithing', 260, [inp('ore_void', 2), inp('bar_dragonbone', 1)], { id: 'bar_void', qty: 1 }, 280),
  r('blacksmithing', 420, [inp('ore_astral', 2), inp('bar_void', 1)], { id: 'bar_astral', qty: 1 }, 420),
  r('blacksmithing', 640, [inp('ore_titan', 2), inp('bar_astral', 1)], { id: 'bar_titan', qty: 1 }, 640),
  r('blacksmithing', 999, [inp('ore_runic', 2), inp('bar_titan', 1)], { id: 'bar_runic', qty: 1 }, 999)
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
  { mat: 'crystal', bar: 'crystal_cut', lvl: 60, gate: 'recipe:bar_crystal', xp: 80, wood: 'wood_ancient' },
  // endgame gear ladder (ungated — reaching the blacksmithing level is the gate)
  { mat: 'obsidian', bar: 'bar_obsidian', lvl: 80, gate: '', xp: 130, wood: 'wood_ancient' },
  { mat: 'dragonbone', bar: 'bar_dragonbone', lvl: 150, gate: '', xp: 210, wood: 'wood_ancient' },
  { mat: 'void', bar: 'bar_void', lvl: 260, gate: '', xp: 330, wood: 'wood_ancient' },
  { mat: 'astral', bar: 'bar_astral', lvl: 420, gate: '', xp: 500, wood: 'wood_ancient' },
  { mat: 'titan', bar: 'bar_titan', lvl: 640, gate: '', xp: 760, wood: 'wood_ancient' },
  { mat: 'runic', bar: 'bar_runic', lvl: 999, gate: '', xp: 1200, wood: 'wood_ancient' }
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
    // Chicken-and-egg fix: the STARTER (copper) hatchet needs no logs — you
    // need a hatchet to chop wood in the first place, so it can't require any.
    const woodQty = k.kind === 'hatchet' && t.mat === 'copper' ? 0 : k.wood
    if (woodQty > 0) inputs.push(inp(t.wood, woodQty))
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
  r('cooking', 60, [inp('fish_golden', 1), inp('food_pie', 1), inp('food_cake', 1)], { id: 'food_feast', qty: 1 }, 70, 'recipe:food_feast'),
  // --- expanded cooking menu (craftable from the base cooking unlock) ---
  r('cooking', 6, [inp('berry_red', 1), inp('mushroom_brown', 1), inp('wheat', 1)], { id: 'food_trail_mix', qty: 2 }, 8, 'unlock:cook'),
  r('cooking', 8, [inp('mushroom_brown', 2), inp('herb_green', 1)], { id: 'food_mushroom_soup', qty: 1 }, 10, 'unlock:cook'),
  r('cooking', 10, [inp('berry_red', 2), inp('wheat', 2)], { id: 'food_berry_tart', qty: 1 }, 12, 'unlock:cook'),
  r('cooking', 22, [inp('fish_salmon', 1), inp('mushroom_brown', 2), inp('wheat', 1)], { id: 'food_fish_chowder', qty: 1 }, 20, 'unlock:cook'),
  r('cooking', 26, [inp('hide_boar', 1), inp('herb_red', 2)], { id: 'food_herb_roast', qty: 1 }, 24, 'unlock:cook'),
  r('cooking', 38, [inp('food_honey', 2), inp('wheat', 2)], { id: 'food_honey_glazed', qty: 1 }, 36, 'unlock:cook'),
  r('cooking', 62, [inp('fish_golden', 1), inp('herb_gold', 2)], { id: 'food_golden_fillet', qty: 1 }, 72, 'unlock:cook')
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
  r('alchemy', 60, [inp('herb_gold', 2), inp('crystal_cut', 1)], { id: 'potion_elixir', qty: 1 }, 70, 'recipe:potion_elixir'),
  // --- expanded alchemy shelf (craftable from the base brew unlock) ---
  r('alchemy', 2, [inp('herb_green', 1), inp('berry_red', 1)], { id: 'potion_stamina', qty: 1 }, 6, 'unlock:brew'),
  r('alchemy', 14, [inp('herb_red', 1), inp('herb_blue', 1)], { id: 'potion_vigor', qty: 1 }, 14, 'unlock:brew'),
  r('alchemy', 26, [inp('herb_blue', 2), inp('crystal_shard', 1)], { id: 'potion_clarity', qty: 1 }, 24, 'unlock:brew'),
  r('alchemy', 45, [inp('herb_red', 2), inp('herb_blue', 2), inp('herb_gold', 1)], { id: 'potion_restoration', qty: 1 }, 48, 'unlock:brew')
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
// Tailoring — wearable armor sets. Ranger (light leather: hood/leathers/treads)
// and Mage (cloth robes: mhat/robe/slippers), copper..crystal. Hides + a tier
// thread (bar/crystal). Mythic is drop-only, like every other gear line.
// ---------------------------------------------------------------------------

const RANGER_PIECES = [
  { kind: 'hood', hides: 1 },
  { kind: 'leathers', hides: 2 },
  { kind: 'treads', hides: 1 }
] as const

const MAGE_PIECES = [
  { kind: 'mhat', hides: 1 },
  { kind: 'robe', hides: 2 },
  { kind: 'slippers', hides: 1 }
] as const

/** Craftable tiers (copper..crystal): hide base + an optional tier thread. */
const ARMOR_TAILOR_TIERS = [
  { mat: 'copper', lvl: 3, xp: 10, hide: 'hide_wolf', thread: null as string | null, tqty: 0 },
  { mat: 'iron', lvl: 12, xp: 18, hide: 'hide_wolf', thread: 'bar_copper' as string | null, tqty: 1 },
  { mat: 'steel', lvl: 22, xp: 30, hide: 'hide_boar', thread: 'bar_iron' as string | null, tqty: 1 },
  { mat: 'gold', lvl: 40, xp: 52, hide: 'hide_tough', thread: 'bar_gold' as string | null, tqty: 1 },
  { mat: 'crystal', lvl: 55, xp: 76, hide: 'hide_tough', thread: 'crystal_cut' as string | null, tqty: 1 },
  // endgame cloth/leather sets (ungated — the tailoring level is the gate)
  { mat: 'obsidian', lvl: 80, xp: 120, hide: 'hide_tough', thread: 'bar_obsidian' as string | null, tqty: 1 },
  { mat: 'dragonbone', lvl: 150, xp: 200, hide: 'hide_tough', thread: 'bar_dragonbone' as string | null, tqty: 1 },
  { mat: 'void', lvl: 260, xp: 320, hide: 'hide_tough', thread: 'bar_void' as string | null, tqty: 2 },
  { mat: 'astral', lvl: 420, xp: 480, hide: 'hide_tough', thread: 'bar_astral' as string | null, tqty: 2 },
  { mat: 'titan', lvl: 640, xp: 720, hide: 'hide_tough', thread: 'bar_titan' as string | null, tqty: 2 },
  { mat: 'runic', lvl: 999, xp: 1100, hide: 'hide_tough', thread: 'bar_runic' as string | null, tqty: 2 }
] as const

const ENDGAME_MATS = new Set(['obsidian', 'dragonbone', 'void', 'astral', 'titan', 'runic'])
function tailorGate(mat: string, set: 'leather' | 'cloth'): string {
  if (mat === 'copper' || mat === 'iron') return set === 'leather' ? 'recipe:leather_set' : 'recipe:cloth_set'
  if (mat === 'steel' || mat === 'gold') return 'recipe:fine_set'
  if (ENDGAME_MATS.has(mat)) return '' // ungated — tailoring level is the gate
  return 'recipe:crystal_set'
}

function armorRecipes(
  pieces: readonly { kind: string; hides: number }[],
  set: 'leather' | 'cloth'
): Recipe[] {
  return ARMOR_TAILOR_TIERS.flatMap((t, ti) =>
    pieces.map((pc) => {
      const inputs: RecipeInput[] = [inp(t.hide, pc.hides + Math.floor(ti / 2))]
      if (t.thread) inputs.push(inp(t.thread, t.tqty))
      return r('tailoring', t.lvl, inputs, { id: `${pc.kind}_${t.mat}`, qty: 1 }, t.xp, tailorGate(t.mat, set))
    })
  )
}

const RANGER_ARMOR: Recipe[] = armorRecipes(RANGER_PIECES, 'leather')
const MAGE_ARMOR: Recipe[] = armorRecipes(MAGE_PIECES, 'cloth')

// ---------------------------------------------------------------------------

export const RECIPES: readonly Recipe[] = [
  ...SMELTING,
  ...RODS,
  ...GEAR,
  ...COOKING,
  ...ALCHEMY,
  ...TAILORING,
  ...RANGER_ARMOR,
  ...MAGE_ARMOR
]

const bySkill = new Map<CraftSkill, Recipe[]>()
for (const rec of [...RECIPES, ...EXTRA_RECIPES]) {
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

// Reverse index: output item id -> the recipe that makes it. Used by the
// salvage/breakdown system to reclaim a fraction of an item's craft cost.
const byOutput = new Map<string, Recipe>()
for (const rec of [...RECIPES, ...EXTRA_RECIPES]) {
  if (!byOutput.has(rec.output.id)) byOutput.set(rec.output.id, rec)
}

/** The recipe whose output is `id`, if any item in the catalog crafts it. */
export function recipeForOutput(id: string): Recipe | undefined {
  return byOutput.get(id)
}
