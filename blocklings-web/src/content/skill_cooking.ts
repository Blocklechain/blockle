/**
 * Content pack — COOKING skill expansion: "The Greasy Spoon".
 *
 * A proper farm-to-frying-pan crafting tree layered on the base `unlock:cook`
 * gate. Real foraged ingredients (wheat, berries, mushrooms, herbs, honey,
 * fish, and rendered hide-fat) get prepped into reusable kitchen staples
 * (dough, stock, tallow), then cooked up into HP / MP restoratives that climb
 * from a humble berry scone to the frankly unreasonable Golden Banquet.
 *
 * Only new catalog items (food_* consumables + descriptive-id kitchen staples)
 * and cooking recipes. No NPCs, quests, or town build — purely the tree.
 *
 * Side-effect: calls registerPack({...}) at import time.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import type { ItemDef } from '../types'
import type { Ctx } from '../world/layout'

// ---------------------------------------------------------------------------
// New items
//   - food_* consumables render via the food mesh family.
//   - cooking_* kitchen staples are descriptive-id materials (deliberate crate
//     meshes: they live on the prep bench, nobody adventures with a bowl of
//     raw dough).
// ---------------------------------------------------------------------------

const items: ItemDef[] = [
  // --- reusable kitchen staples (materials) ------------------------------
  {
    id: 'cooking_dough',
    name: 'Kneaded Dough',
    slot: 'material',
    rarity: 1,
    value: 10,
    desc: 'Wheat, water, and roughly forty minutes of taking your frustrations out on a lump. Doubles as a stress ball.'
  },
  {
    id: 'cooking_stock',
    name: 'Fish Stock',
    slot: 'material',
    rarity: 1,
    value: 14,
    desc: 'The parts of the fish nobody wanted, simmered until they forgive you. The soul of every soup worth eating.'
  },
  {
    id: 'cooking_tallow',
    name: 'Rendered Tallow',
    slot: 'material',
    rarity: 2,
    value: 22,
    desc: 'Boar fat cooked down to a pale, honest grease. Fries anything. Clogs everything. Chefs weep for it.'
  },

  // --- early breakfast-grade snacks (the trembling first bites) ----------
  {
    id: 'food_berry_scone',
    name: 'Berry Scone',
    slot: 'consumable',
    rarity: 1,
    value: 16,
    restores: { hp: 45 },
    desc: 'Crumbly, warm, and studded with berries that WILL stain your good tunic. Worth it. Always worth it.'
  },
  {
    id: 'food_mushroom_skewer',
    name: 'Mushroom Skewer',
    slot: 'consumable',
    rarity: 1,
    value: 18,
    restores: { hp: 55 },
    desc: 'Brown caps grilled on a stick over an open fire. Rustic, earthy, and only occasionally the WRONG kind of mushroom.'
  },
  {
    id: 'food_herb_omelette',
    name: 'Herb Omelette',
    slot: 'consumable',
    rarity: 1,
    value: 20,
    restores: { mp: 50 },
    desc: 'Fluffy, folded, and faintly magical. The green flecks are herbs. We are CHOOSING to believe they are herbs.'
  },
  {
    id: 'food_honey_bun',
    name: 'Honey Bun',
    slot: 'consumable',
    rarity: 1,
    value: 26,
    restores: { hp: 40, mp: 30 },
    desc: 'Sticky, golden, and gone in two bites. Mends body and mind, mostly by reminding both why they bother.'
  },

  // --- proper sit-down meals (the heart of the menu) ---------------------
  {
    id: 'food_trout_dinner',
    name: 'Pan-Fried Trout',
    slot: 'consumable',
    rarity: 2,
    value: 60,
    restores: { hp: 120 },
    desc: 'Caught this morning, crisped this evening, bones mostly accounted for. Served with a wedge of smugness.'
  },
  {
    id: 'food_mage_loaf',
    name: 'Mage Loaf',
    slot: 'consumable',
    rarity: 2,
    value: 70,
    restores: { mp: 130 },
    desc: 'A dense blue-swirled bread baked by people who should not be allowed near an oven, but ARE allowed near mana.'
  },
  {
    id: 'food_wild_stew',
    name: 'Wild Forager Stew',
    slot: 'consumable',
    rarity: 2,
    value: 80,
    restores: { hp: 110, mp: 90 },
    desc: 'Everything the forest offered, in one pot, in no particular order. Restores body and mind and a vague sense of trust.'
  },

  // --- feast-grade restoratives ------------------------------------------
  {
    id: 'food_salmon_roast',
    name: 'Butter-Roasted Salmon',
    slot: 'consumable',
    rarity: 3,
    value: 170,
    restores: { hp: 220 },
    desc: 'Glistening, flaky, and roasted in enough tallow to concern a healer. The fish died doing what it loved: being delicious.'
  },
  {
    id: 'food_forest_pie',
    name: 'Deep Forest Pie',
    slot: 'consumable',
    rarity: 3,
    value: 210,
    restores: { hp: 260, mp: 120 },
    desc: 'Golden lattice crust over a filling of fish, berries, and secrets. Heavy enough to count as both dinner and a weapon.'
  },

  // --- capstone -----------------------------------------------------------
  {
    id: 'food_golden_banquet',
    name: 'Golden Banquet',
    slot: 'consumable',
    rarity: 5,
    value: 2400,
    restores: { hp: 800, mp: 800 },
    desc: 'A table-length spread crowned with a whole golden fish, served once and photographed forever. You will not finish it. You will try.'
  }
]

// ---------------------------------------------------------------------------
// Recipes — cooking, levelReq 1..75, gated on the base cook unlock.
//   Staples (dough/stock/tallow) feed the meals; the top tiers consume a whole
//   feast, so the menu reads as one connected kitchen rather than a flat list.
// ---------------------------------------------------------------------------

const recipes: Recipe[] = [
  // tier 0 — snacks + first staple
  {
    id: 'cooking:food_berry_scone',
    skill: 'cooking',
    levelReq: 1,
    inputs: [{ id: 'berry_red', qty: 2 }, { id: 'wheat', qty: 1 }],
    output: { id: 'food_berry_scone', qty: 1 },
    xp: 5,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:cooking_dough',
    skill: 'cooking',
    levelReq: 3,
    inputs: [{ id: 'wheat', qty: 2 }],
    output: { id: 'cooking_dough', qty: 1 },
    xp: 7,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:food_mushroom_skewer',
    skill: 'cooking',
    levelReq: 6,
    inputs: [{ id: 'mushroom_brown', qty: 2 }, { id: 'herb_green', qty: 1 }],
    output: { id: 'food_mushroom_skewer', qty: 1 },
    xp: 10,
    gate: 'unlock:cook'
  },

  // staples — the prep-bench backbone
  {
    id: 'cooking:cooking_stock',
    skill: 'cooking',
    levelReq: 8,
    inputs: [{ id: 'fish_raw', qty: 2 }, { id: 'herb_green', qty: 1 }],
    output: { id: 'cooking_stock', qty: 1 },
    xp: 12,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:food_herb_omelette',
    skill: 'cooking',
    levelReq: 10,
    inputs: [{ id: 'herb_green', qty: 1 }, { id: 'herb_blue', qty: 1 }, { id: 'wheat', qty: 1 }],
    output: { id: 'food_herb_omelette', qty: 1 },
    xp: 13,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:food_honey_bun',
    skill: 'cooking',
    levelReq: 14,
    inputs: [{ id: 'cooking_dough', qty: 1 }, { id: 'food_honey', qty: 1 }, { id: 'berry_red', qty: 1 }],
    output: { id: 'food_honey_bun', qty: 1 },
    xp: 16,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:cooking_tallow',
    skill: 'cooking',
    levelReq: 18,
    inputs: [{ id: 'hide_boar', qty: 2 }],
    output: { id: 'cooking_tallow', qty: 1 },
    xp: 18,
    gate: 'unlock:cook'
  },

  // tier 2 — proper meals
  {
    id: 'cooking:food_trout_dinner',
    skill: 'cooking',
    levelReq: 20,
    inputs: [{ id: 'fish_trout', qty: 1 }, { id: 'cooking_tallow', qty: 1 }, { id: 'herb_green', qty: 1 }],
    output: { id: 'food_trout_dinner', qty: 1 },
    xp: 21,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:food_mage_loaf',
    skill: 'cooking',
    levelReq: 26,
    inputs: [{ id: 'cooking_dough', qty: 1 }, { id: 'herb_blue', qty: 2 }, { id: 'mushroom_brown', qty: 1 }],
    output: { id: 'food_mage_loaf', qty: 1 },
    xp: 26,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:food_wild_stew',
    skill: 'cooking',
    levelReq: 32,
    inputs: [
      { id: 'cooking_stock', qty: 1 },
      { id: 'mushroom_brown', qty: 2 },
      { id: 'herb_red', qty: 1 },
      { id: 'wheat', qty: 1 }
    ],
    output: { id: 'food_wild_stew', qty: 1 },
    xp: 33,
    gate: 'unlock:cook'
  },

  // tier 3 — feast-grade
  {
    id: 'cooking:food_salmon_roast',
    skill: 'cooking',
    levelReq: 40,
    inputs: [{ id: 'fish_salmon', qty: 1 }, { id: 'cooking_tallow', qty: 2 }, { id: 'herb_red', qty: 1 }],
    output: { id: 'food_salmon_roast', qty: 1 },
    xp: 42,
    gate: 'unlock:cook'
  },
  {
    id: 'cooking:food_forest_pie',
    skill: 'cooking',
    levelReq: 48,
    inputs: [
      { id: 'cooking_dough', qty: 2 },
      { id: 'fish_trout', qty: 1 },
      { id: 'berry_red', qty: 3 },
      { id: 'herb_gold', qty: 1 }
    ],
    output: { id: 'food_forest_pie', qty: 1 },
    xp: 50,
    gate: 'unlock:cook'
  },

  // bridge into the existing grand feast (real catalog output)
  {
    id: 'cooking:food_feast',
    skill: 'cooking',
    levelReq: 58,
    inputs: [
      { id: 'food_salmon_roast', qty: 1 },
      { id: 'food_forest_pie', qty: 1 },
      { id: 'cooking_stock', qty: 1 },
      { id: 'herb_gold', qty: 1 }
    ],
    output: { id: 'food_feast', qty: 1 },
    xp: 60,
    gate: 'unlock:cook'
  },

  // tier 5 — the Golden Banquet capstone (consumes a whole feast)
  {
    id: 'cooking:food_golden_banquet',
    skill: 'cooking',
    levelReq: 75,
    inputs: [
      { id: 'food_feast', qty: 1 },
      { id: 'fish_golden', qty: 1 },
      { id: 'cooking_tallow', qty: 2 },
      { id: 'cooking_dough', qty: 2 },
      { id: 'herb_gold', qty: 2 }
    ],
    output: { id: 'food_golden_banquet', qty: 1 },
    xp: 100,
    gate: 'unlock:cook'
  }
]

// Satisfy the "import only types" linter for the unused optional type imports.
const _unused: [NpcDef[], QuestDef[], (ctx: Ctx) => void] | null = null
void _unused

registerPack({ items, recipes })
