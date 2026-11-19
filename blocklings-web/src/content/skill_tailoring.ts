/**
 * Content pack — TAILORING crafting tree expansion: "The Soft Trades".
 *
 * A deep needle-and-thread progression that turns raw hide, wood, and herbs
 * into bolts of cloth, waxed canvas, carrying bags, lucky charms, and — the
 * whole point of a dangerous hobby — bandages that stitch a Blockling back
 * together mid-fight. Materials feed into one another up the ladder, so by the
 * top end you are weaving crystal thread the way you once knotted sinew.
 *
 * Side-effect: calls registerPack({...}) at import time. Items + recipes only;
 * no NPCs, quests, or town build.
 */
import { registerPack } from './packs'
import type { NpcDef } from '../ids'
import type { QuestDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import type { ItemDef } from '../types'
import type { Ctx } from '../world/layout'

// ---------------------------------------------------------------------------
// New items
//   Materials use descriptive ids (most render the generic crate, which is
//   fine for mats). Consumables use the potion_* prefix so buildPotion gives
//   them a real mesh — all of these are BANDAGES that restore hp.
// ---------------------------------------------------------------------------
const items: ItemDef[] = [
  // --- Materials: the cloth ladder -----------------------------------------
  {
    id: 'thread_sinew',
    name: 'Sinew Thread',
    slot: 'material',
    rarity: 0,
    value: 3,
    desc: 'Spun from wolf tendon. Technically dental floss for something much larger than you.'
  },
  {
    id: 'bolt_wolfhide',
    name: 'Bolt of Wolfhide Cloth',
    slot: 'material',
    rarity: 1,
    value: 12,
    desc: 'A rolled bolt of tanned, softened hide. Still faintly disapproves of you at night.'
  },
  {
    id: 'boar_leather',
    name: 'Cured Boar Leather',
    slot: 'material',
    rarity: 1,
    value: 14,
    desc: 'Thick, honest leather. Smells of oak smoke and poor decisions in the woods.'
  },
  {
    id: 'padded_lining',
    name: 'Padded Herb Lining',
    slot: 'material',
    rarity: 1,
    value: 18,
    desc: 'Quilted cloth stuffed with green herbs. Comfortable, aromatic, mildly medicinal, slightly salad.'
  },
  {
    id: 'waxed_canvas',
    name: 'Waxed Canvas',
    slot: 'material',
    rarity: 2,
    value: 34,
    desc: 'Rain rolls right off it, as do most compliments. Waterproof, rugged, smug.'
  },
  {
    id: 'satchel_small',
    name: 'Small Hide Satchel',
    slot: 'material',
    rarity: 1,
    value: 40,
    desc: 'A modest bag that holds slightly more than it has any right to. Do not ask how.'
  },
  {
    id: 'satchel_ranger',
    name: "Ranger's Field Satchel",
    slot: 'material',
    rarity: 2,
    value: 85,
    desc: 'Pockets inside pockets inside a pocket. Somewhere in here is a snack from last season.'
  },
  {
    id: 'crystal_weave',
    name: 'Crystal-Thread Weave',
    slot: 'material',
    rarity: 4,
    value: 260,
    desc: 'Cloth shot through with filaments of cut crystal. Hums when you sew. Possibly judging your stitches.'
  },

  // --- Consumables: bandages (restore hp), potion_* prefix for a real mesh --
  {
    id: 'potion_bandage_rough',
    name: 'Rough Linen Bandage',
    slot: 'consumable',
    rarity: 0,
    value: 8,
    restores: { hp: 18 },
    desc: 'Wrap it tight, think brave thoughts. Closes the smaller holes in a Blockling.'
  },
  {
    id: 'potion_bandage_herbal',
    name: 'Herbal Poultice Bandage',
    slot: 'consumable',
    rarity: 1,
    value: 20,
    restores: { hp: 40, mp: 8 },
    desc: 'Crushed red and blue herbs under clean cloth. Tingles, then forgives you.'
  },
  {
    id: 'potion_bandage_field',
    name: 'Field Dressing',
    slot: 'consumable',
    rarity: 2,
    value: 48,
    restores: { hp: 85 },
    desc: 'Waxed, padded, and genuinely competent. The bandage a sensible adventurer carries and a brave one forgets.'
  },
  {
    id: 'potion_bandage_tough',
    name: 'Boarhide Compression Wrap',
    slot: 'consumable',
    rarity: 3,
    value: 95,
    restores: { hp: 150 },
    desc: 'Thick enough to turn a careless blade and still cinch a wound shut. Hugs harder than your grandma.'
  },
  {
    id: 'potion_bandage_crystal',
    name: 'Crystal Suture Kit',
    slot: 'consumable',
    rarity: 4,
    value: 220,
    restores: { hp: 320, mp: 60 },
    desc: 'Self-tightening crystal thread that closes a wound before you finish wincing. Faintly magical, enormously expensive.'
  }
]

// ---------------------------------------------------------------------------
// Recipes — tailoring, levelReq 1..75, xp scaling with level.
// gate 'unlock:sew' (the base profession unlock) so each is craftable the
// moment tailoring is available. Every input/output id is a real catalog id
// or one of the items added above.
// ---------------------------------------------------------------------------
const recipes: Recipe[] = [
  // Tier 0 — the absolute basics
  {
    id: 'tailoring:thread_sinew',
    skill: 'tailoring',
    levelReq: 1,
    inputs: [{ id: 'hide_wolf', qty: 1 }],
    output: { id: 'thread_sinew', qty: 2 },
    xp: 4,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:potion_bandage_rough',
    skill: 'tailoring',
    levelReq: 2,
    inputs: [{ id: 'thread_sinew', qty: 1 }, { id: 'herb_green', qty: 1 }],
    output: { id: 'potion_bandage_rough', qty: 2 },
    xp: 6,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:bolt_wolfhide',
    skill: 'tailoring',
    levelReq: 3,
    inputs: [{ id: 'hide_wolf', qty: 2 }, { id: 'thread_sinew', qty: 1 }],
    output: { id: 'bolt_wolfhide', qty: 1 },
    xp: 9,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:boar_leather',
    skill: 'tailoring',
    levelReq: 5,
    inputs: [{ id: 'hide_boar', qty: 2 }, { id: 'thread_sinew', qty: 1 }, { id: 'wood_oak', qty: 1 }],
    output: { id: 'boar_leather', qty: 1 },
    xp: 11,
    gate: 'unlock:sew'
  },
  // Tier 1 — bags, linings, better bandages
  {
    id: 'tailoring:padded_lining',
    skill: 'tailoring',
    levelReq: 8,
    inputs: [{ id: 'bolt_wolfhide', qty: 1 }, { id: 'herb_green', qty: 2 }],
    output: { id: 'padded_lining', qty: 1 },
    xp: 15,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:potion_bandage_herbal',
    skill: 'tailoring',
    levelReq: 10,
    inputs: [{ id: 'bolt_wolfhide', qty: 1 }, { id: 'herb_red', qty: 2 }, { id: 'herb_blue', qty: 1 }],
    output: { id: 'potion_bandage_herbal', qty: 2 },
    xp: 19,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:satchel_small',
    skill: 'tailoring',
    levelReq: 14,
    inputs: [{ id: 'boar_leather', qty: 2 }, { id: 'thread_sinew', qty: 2 }, { id: 'wood_pine', qty: 1 }],
    output: { id: 'satchel_small', qty: 1 },
    xp: 24,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:waxed_canvas',
    skill: 'tailoring',
    levelReq: 18,
    inputs: [{ id: 'boar_leather', qty: 1 }, { id: 'herb_gold', qty: 1 }, { id: 'wood_pine', qty: 1 }],
    output: { id: 'waxed_canvas', qty: 2 },
    xp: 28,
    gate: 'unlock:sew'
  },
  // Tier 2 — field kit
  {
    id: 'tailoring:potion_bandage_field',
    skill: 'tailoring',
    levelReq: 22,
    inputs: [{ id: 'padded_lining', qty: 1 }, { id: 'waxed_canvas', qty: 1 }, { id: 'herb_blue', qty: 2 }],
    output: { id: 'potion_bandage_field', qty: 2 },
    xp: 34,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:satchel_ranger',
    skill: 'tailoring',
    levelReq: 30,
    inputs: [{ id: 'satchel_small', qty: 1 }, { id: 'waxed_canvas', qty: 2 }, { id: 'hide_tough', qty: 1 }],
    output: { id: 'satchel_ranger', qty: 1 },
    xp: 44,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:potion_bandage_tough',
    skill: 'tailoring',
    levelReq: 38,
    inputs: [{ id: 'hide_tough', qty: 1 }, { id: 'padded_lining', qty: 1 }, { id: 'herb_gold', qty: 2 }],
    output: { id: 'potion_bandage_tough', qty: 2 },
    xp: 56,
    gate: 'unlock:sew'
  },
  // Tier 3 — a lucky charm sewn from the good materials (existing accessory)
  {
    id: 'tailoring:charm_rabbit',
    skill: 'tailoring',
    levelReq: 45,
    inputs: [{ id: 'bolt_wolfhide', qty: 2 }, { id: 'crystal_shard', qty: 1 }, { id: 'herb_gold', qty: 1 }],
    output: { id: 'charm_rabbit', qty: 1 },
    xp: 62,
    gate: 'unlock:sew'
  },
  // Tier 4 — crystal textiles and the top-shelf bandage
  {
    id: 'tailoring:crystal_weave',
    skill: 'tailoring',
    levelReq: 52,
    inputs: [{ id: 'hide_tough', qty: 2 }, { id: 'crystal_shard', qty: 2 }, { id: 'crystal_cut', qty: 1 }],
    output: { id: 'crystal_weave', qty: 1 },
    xp: 74,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:potion_bandage_crystal',
    skill: 'tailoring',
    levelReq: 60,
    inputs: [{ id: 'crystal_weave', qty: 1 }, { id: 'herb_gold', qty: 2 }, { id: 'crystal_shard', qty: 1 }],
    output: { id: 'potion_bandage_crystal', qty: 2 },
    xp: 92,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:acc_lucky_rock',
    skill: 'tailoring',
    levelReq: 68,
    inputs: [{ id: 'satchel_ranger', qty: 1 }, { id: 'crystal_weave', qty: 1 }, { id: 'thread_sinew', qty: 3 }],
    output: { id: 'acc_lucky_rock', qty: 1 },
    xp: 108,
    gate: 'unlock:sew'
  },
  {
    id: 'tailoring:amulet_block',
    skill: 'tailoring',
    levelReq: 75,
    inputs: [{ id: 'crystal_weave', qty: 2 }, { id: 'crystal_cut', qty: 2 }, { id: 'bar_gold', qty: 1 }],
    output: { id: 'amulet_block', qty: 1 },
    xp: 130,
    gate: 'unlock:sew'
  }
]

registerPack({ items, recipes })

// Keep type-only imports referenced for strict TS without emitting runtime use.
export type { NpcDef, QuestDef, Ctx }
