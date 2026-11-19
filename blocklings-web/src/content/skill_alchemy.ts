/**
 * Content pack — ALCHEMY skill expansion: "The Simmering Shelf".
 *
 * A proper, deep brewing tree layered on top of the base `unlock:brew` gate:
 * reusable reagents distilled from real herbs/crystals/mushrooms/berries, then
 * HP / MP / combo restoratives that climb from the trembling first cantrip
 * (potion_hp_tiny) all the way to the frankly irresponsible potion_sunspring.
 *
 * Only new catalog items (consumables + intermediate reagent materials) and
 * alchemy recipes. No NPCs, quests, or town build — purely the crafting tree.
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
//   - potion_* consumables render a real mesh for any suffix.
//   - reagent_* materials are intermediate "crate" reagents (deliberate: they
//     are workbench stock, not loot you parade around).
// ---------------------------------------------------------------------------

const items: ItemDef[] = [
  // --- reusable reagents (materials) -------------------------------------
  {
    id: 'reagent_herb_essence',
    name: 'Herbal Essence',
    slot: 'material',
    rarity: 1,
    value: 18,
    desc: 'Three fistfuls of greenery, boiled down to one honest teaspoon. Tastes like a lawn apologising.'
  },
  {
    id: 'reagent_berry_syrup',
    name: 'Berry Syrup',
    slot: 'material',
    rarity: 1,
    value: 16,
    desc: 'Sticky, suspiciously purple, and structurally load-bearing in most pies. Alchemists hoard it; children find it.'
  },
  {
    id: 'reagent_spore_extract',
    name: 'Spore Extract',
    slot: 'material',
    rarity: 2,
    value: 28,
    desc: 'Pressed from brown cap mushrooms under a cloth, in the dark, while NOT breathing in. The label simply reads "patience".'
  },
  {
    id: 'reagent_mineral_dust',
    name: 'Mineral Dust',
    slot: 'material',
    rarity: 2,
    value: 40,
    desc: 'Crystal ground so fine it floats. Gets everywhere, into everything, and faintly into your dreams.'
  },

  // --- HP / MP cantrips (the trembling first steps) ----------------------
  {
    id: 'potion_hp_tiny',
    name: 'Scratch Tonic',
    slot: 'consumable',
    rarity: 0,
    value: 8,
    restores: { hp: 20 },
    desc: 'For papercuts, splinters, and that one bruise you keep poking. Barely a potion. Technically a potion.'
  },
  {
    id: 'potion_mp_tiny',
    name: 'Thinking Juice',
    slot: 'consumable',
    rarity: 0,
    value: 8,
    restores: { mp: 20 },
    desc: 'Restores just enough mana to remember where you left the rest of your mana.'
  },

  // --- combo restoratives (the heart of the shelf) -----------------------
  {
    id: 'potion_combo_small',
    name: 'Two-Birds Draught',
    slot: 'consumable',
    rarity: 1,
    value: 30,
    restores: { hp: 35, mp: 25 },
    desc: 'Patches the body AND tops the mind, because standing still to drink two separate potions is how adventurers get eaten.'
  },
  {
    id: 'potion_combo_med',
    name: 'Second Wind',
    slot: 'consumable',
    rarity: 2,
    value: 70,
    restores: { hp: 90, mp: 70 },
    desc: 'That specific moment, bottled, where you decide the fight is NOT over. Fizzes with petty determination.'
  },
  {
    id: 'potion_combo_large',
    name: 'Rallying Flask',
    slot: 'consumable',
    rarity: 3,
    value: 160,
    restores: { hp: 180, mp: 140 },
    desc: 'Field-grade dual restorative. Glows faintly, hums faintly, and makes you feel like a verb instead of a noun.'
  },

  // --- specialist single-stat heavyweights -------------------------------
  {
    id: 'potion_dawnwater',
    name: 'Dawnwater',
    slot: 'consumable',
    rarity: 3,
    value: 150,
    restores: { hp: 260 },
    desc: 'Tastes like the first warm morning after a terrible week. Knits flesh with alarming optimism.'
  },
  {
    id: 'potion_nightcap',
    name: 'Nightcap Brew',
    slot: 'consumable',
    rarity: 2,
    value: 110,
    restores: { mp: 200 },
    desc: 'Deep, quiet, and a little smug. Refills the spellbook of your soul without the yawning.'
  },
  {
    id: 'potion_crystal_tonic',
    name: 'Crystal Tonic',
    slot: 'consumable',
    rarity: 3,
    value: 210,
    restores: { mp: 320 },
    desc: 'Drinkable powdered crystal. Yes, it crunches. No, we will not be discussing the texture further.'
  },

  // --- capstones ----------------------------------------------------------
  {
    id: 'potion_panacea',
    name: 'Panacea',
    slot: 'consumable',
    rarity: 4,
    value: 600,
    restores: { hp: 400, mp: 400 },
    desc: 'Cures almost everything, including the belief that you could not afford a Panacea. You could not, really.'
  },
  {
    id: 'potion_sunspring',
    name: 'Sunspring Elixir',
    slot: 'consumable',
    rarity: 5,
    value: 2000,
    restores: { hp: 900, mp: 900 },
    desc: 'Liquid sunrise in a bottle you are too nervous to actually open. Brewed once, bragged about forever.'
  }
]

// ---------------------------------------------------------------------------
// Recipes — alchemy, levelReq 1..72, gated on the base brew unlock.
//   Reagents feed the restoratives; top-tier potions consume lower-tier
//   potions, so the shelf reads as one connected tree rather than a list.
// ---------------------------------------------------------------------------

const recipes: Recipe[] = [
  // tier 0 — cantrips
  {
    id: 'alchemy:potion_hp_tiny',
    skill: 'alchemy',
    levelReq: 1,
    inputs: [{ id: 'herb_green', qty: 1 }, { id: 'berry_red', qty: 1 }],
    output: { id: 'potion_hp_tiny', qty: 1 },
    xp: 5,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_mp_tiny',
    skill: 'alchemy',
    levelReq: 1,
    inputs: [{ id: 'herb_green', qty: 1 }, { id: 'mushroom_brown', qty: 1 }],
    output: { id: 'potion_mp_tiny', qty: 1 },
    xp: 5,
    gate: 'unlock:brew'
  },

  // reagents — the workbench staples
  {
    id: 'alchemy:reagent_herb_essence',
    skill: 'alchemy',
    levelReq: 5,
    inputs: [{ id: 'herb_green', qty: 3 }],
    output: { id: 'reagent_herb_essence', qty: 1 },
    xp: 9,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:reagent_berry_syrup',
    skill: 'alchemy',
    levelReq: 8,
    inputs: [{ id: 'berry_red', qty: 3 }],
    output: { id: 'reagent_berry_syrup', qty: 1 },
    xp: 11,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:reagent_spore_extract',
    skill: 'alchemy',
    levelReq: 12,
    inputs: [{ id: 'mushroom_brown', qty: 3 }, { id: 'herb_green', qty: 1 }],
    output: { id: 'reagent_spore_extract', qty: 1 },
    xp: 14,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:reagent_mineral_dust',
    skill: 'alchemy',
    levelReq: 18,
    inputs: [{ id: 'crystal_shard', qty: 2 }],
    output: { id: 'reagent_mineral_dust', qty: 1 },
    xp: 18,
    gate: 'unlock:brew'
  },

  // tier 1 — combo small
  {
    id: 'alchemy:potion_combo_small',
    skill: 'alchemy',
    levelReq: 6,
    inputs: [{ id: 'reagent_herb_essence', qty: 1 }, { id: 'berry_red', qty: 2 }],
    output: { id: 'potion_combo_small', qty: 1 },
    xp: 13,
    gate: 'unlock:brew'
  },

  // tier 2 — combo med + night/day specialists
  {
    id: 'alchemy:potion_combo_med',
    skill: 'alchemy',
    levelReq: 20,
    inputs: [
      { id: 'reagent_herb_essence', qty: 2 },
      { id: 'reagent_berry_syrup', qty: 1 },
      { id: 'herb_blue', qty: 1 }
    ],
    output: { id: 'potion_combo_med', qty: 1 },
    xp: 23,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_nightcap',
    skill: 'alchemy',
    levelReq: 24,
    inputs: [{ id: 'herb_blue', qty: 2 }, { id: 'reagent_spore_extract', qty: 1 }],
    output: { id: 'potion_nightcap', qty: 1 },
    xp: 25,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_dawnwater',
    skill: 'alchemy',
    levelReq: 28,
    inputs: [{ id: 'herb_red', qty: 3 }, { id: 'reagent_berry_syrup', qty: 1 }],
    output: { id: 'potion_dawnwater', qty: 1 },
    xp: 29,
    gate: 'unlock:brew'
  },

  // tier 3 — combo large + crystal tonic
  {
    id: 'alchemy:potion_combo_large',
    skill: 'alchemy',
    levelReq: 35,
    inputs: [
      { id: 'reagent_herb_essence', qty: 3 },
      { id: 'reagent_mineral_dust', qty: 1 },
      { id: 'herb_gold', qty: 1 }
    ],
    output: { id: 'potion_combo_large', qty: 1 },
    xp: 40,
    gate: 'unlock:brew'
  },
  {
    id: 'alchemy:potion_crystal_tonic',
    skill: 'alchemy',
    levelReq: 40,
    inputs: [
      { id: 'reagent_mineral_dust', qty: 2 },
      { id: 'herb_blue', qty: 3 },
      { id: 'crystal_cut', qty: 1 }
    ],
    output: { id: 'potion_crystal_tonic', qty: 1 },
    xp: 46,
    gate: 'unlock:brew'
  },

  // tier 4 — panacea (consumes a combo_large)
  {
    id: 'alchemy:potion_panacea',
    skill: 'alchemy',
    levelReq: 60,
    inputs: [
      { id: 'potion_combo_large', qty: 1 },
      { id: 'herb_gold', qty: 2 },
      { id: 'crystal_cut', qty: 1 }
    ],
    output: { id: 'potion_panacea', qty: 1 },
    xp: 72,
    gate: 'unlock:brew'
  },

  // tier 5 — sunspring capstone (consumes a panacea)
  {
    id: 'alchemy:potion_sunspring',
    skill: 'alchemy',
    levelReq: 72,
    inputs: [
      { id: 'potion_panacea', qty: 1 },
      { id: 'herb_gold', qty: 3 },
      { id: 'crystal_cut', qty: 2 },
      { id: 'reagent_mineral_dust', qty: 2 }
    ],
    output: { id: 'potion_sunspring', qty: 1 },
    xp: 95,
    gate: 'unlock:brew'
  }
]

// Satisfy the "import only types" linter for the unused optional type imports.
const _unused: [NpcDef[], QuestDef[], (ctx: Ctx) => void] | null = null
void _unused

registerPack({ items, recipes })
