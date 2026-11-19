/**
 * Content pack — THE DEEP FORGE: a blacksmithing crafting-tree expansion.
 *
 * No new gear (the weapon/armor ladder is sacred and untouched). Instead this
 * pack adds the *plumbing* of a real smithy: alloy bars, rivets, chain, flux,
 * hinges, reinforced tool-rods — the intermediate parts a serious forge chews
 * through — plus a handful of flavorful pocket-trinket charms a smith clutches
 * when the quench goes wrong.
 *
 * Materials use descriptive ids; the alloy bars deliberately take the `bar_*`
 * prefix so they render as real bar meshes, and the charms take `potion_*` so
 * they render instead of falling back to a crate. The recipes form one long
 * blacksmithing ladder from lvl 1 to lvl 75. Blacksmithing has no base-unlock
 * flag (it gates on `recipe:bar_*` nodes, not an `unlock:*`), so per the recipe
 * contract these new recipes omit `gate` and are level-gated only.
 *
 * Writing register: mature cartoon-comedy. The forge is hot, the smith is
 * tired, and metal has opinions. Every referenced id is real (ITEM MAP) or
 * added here in `items`.
 */
import { registerPack } from './packs'
import type { ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'

// ---------------------------------------------------------------------------
// New catalog items
//   Alloy bars take `bar_*` → real bar mesh. Rivets/flux/chain/hinge/rod take
//   descriptive ids (fallback crate — fine for workshop components). The four
//   charms take `potion_*` → real potion mesh, and carry modest restores so
//   they function as the pocket pick-me-ups the flavor describes.
// ---------------------------------------------------------------------------
const items: ItemDef[] = [
  // --- Alloy bars (bar_* → real bar mesh) ---------------------------------
  {
    id: 'bar_bronze',
    name: 'Bronze Bar',
    slot: 'material',
    rarity: 1,
    value: 34,
    desc: 'Copper and iron, bullied into getting along. Harder than either, prouder than both, and the first alloy every apprentice ruins twice before getting right.',
  },
  {
    id: 'bar_electrum',
    name: 'Electrum Bar',
    slot: 'material',
    rarity: 3,
    value: 170,
    desc: 'Gold that agreed to be useful for once. A pale, shimmering alloy that holds an enchantment the way a gossip holds a secret — eagerly, and not for long unless you seal it.',
  },
  {
    id: 'bar_darksteel',
    name: 'Darksteel Bar',
    slot: 'material',
    rarity: 3,
    value: 210,
    desc: 'Steel folded with crystal dust and smelting flux until it drinks the light. Rings a low, rude note when struck. Smiths nod at it respectfully and stand slightly to one side.',
  },
  {
    id: 'bar_starforged',
    name: 'Starforged Bar',
    slot: 'material',
    rarity: 4,
    value: 640,
    desc: 'Darksteel and electrum married at a heat that warps the anvil. It still remembers being very hot and will tell you so if you touch it. The capstone of a career spent not catching fire.',
  },

  // --- Fittings / components (descriptive ids → crate mesh) ---------------
  {
    id: 'rivet_iron',
    name: 'Iron Rivets',
    slot: 'material',
    rarity: 0,
    value: 9,
    desc: 'A fistful of stubby iron pins that hold the world together one tiny tantrum at a time. Spill them once and you will be finding rivets with your bare feet for a year.',
  },
  {
    id: 'rivet_steel',
    name: 'Steel Rivets',
    slot: 'material',
    rarity: 1,
    value: 24,
    desc: 'Iron rivets that went to finishing school. They do not bend, do not complain, and judge the iron ones silently from across the parts-bin.',
  },
  {
    id: 'chain_links',
    name: 'Chain Links',
    slot: 'material',
    rarity: 1,
    value: 28,
    desc: 'A coil of hand-closed iron links, each a tiny argument the smith won with a hammer. Only as strong as the one you forgot to weld shut, so weld them all shut.',
  },
  {
    id: 'flux_smelting',
    name: 'Smelting Flux',
    slot: 'material',
    rarity: 1,
    value: 20,
    desc: 'Ground crystal and ore-dust that persuades two metals that were never introduced to bond anyway. The handshake at a forge wedding. Smells faintly of ambition and ozone.',
  },
  {
    id: 'hinge_steel',
    name: 'Steel Hinge',
    slot: 'material',
    rarity: 2,
    value: 52,
    desc: 'A riveted steel hinge, swung a thousand times on the bench to test it and still perfectly, smugly silent. The difference between a door and a wall with regrets.',
  },
  {
    id: 'toolrod_oak',
    name: 'Reinforced Tool-Rod',
    slot: 'material',
    rarity: 1,
    value: 38,
    desc: 'Seasoned oak sleeved in iron and pinned with rivets — the no-nonsense handle beneath every pick, hammer, and hatchet that outlived its owner. Does not splinter, does not flatter.',
  },

  // --- Charms / trinkets (potion_* → real potion mesh, consumable) --------
  {
    id: 'potion_forge_charm',
    name: 'Forgefire Charm',
    slot: 'consumable',
    rarity: 2,
    value: 70,
    restores: { hp: 55 },
    desc: 'A bronze bead with a chip of cut crystal that stays warm no matter the weather. Clutch it before a bad quench; it will not help, but a warm thing to hold rarely hurts.',
  },
  {
    id: 'potion_anvil_luck',
    name: "Anvil-Luck Token",
    slot: 'consumable',
    rarity: 3,
    value: 130,
    restores: { hp: 60, mp: 40 },
    desc: 'An electrum disc stamped with a crossed hammer, rubbed shiny by generations of smiths who swear it keeps the hot sparks out of the collar. Statistically it does nothing. Spiritually it does everything.',
  },
  {
    id: 'potion_coldiron_ward',
    name: 'Cold-Iron Ward',
    slot: 'consumable',
    rarity: 3,
    value: 165,
    restores: { hp: 90 },
    desc: 'A darksteel charm on a steel hinge so it clicks shut like a tiny door against the dark. Old smiths hang it over the quench-barrel to keep the unquiet things out of the water. It mostly keeps the smith calm.',
  },
  {
    id: 'potion_mastersmith',
    name: "Mastersmith's Sigil",
    slot: 'consumable',
    rarity: 4,
    value: 420,
    restores: { hp: 140, mp: 90 },
    desc: 'A starforged medallion you can only make after a lifetime of not ruining things. Holding it, you feel briefly certain that the next weld will hold. For a mastersmith, that certainty is the whole trade.',
  },
]

// ---------------------------------------------------------------------------
// Display names for the new ids (quests/reward tables keep their own lookup).
// ---------------------------------------------------------------------------
const itemNames: Record<string, string> = {
  bar_bronze: 'Bronze Bar',
  bar_electrum: 'Electrum Bar',
  bar_darksteel: 'Darksteel Bar',
  bar_starforged: 'Starforged Bar',
  rivet_iron: 'Iron Rivets',
  rivet_steel: 'Steel Rivets',
  chain_links: 'Chain Links',
  flux_smelting: 'Smelting Flux',
  hinge_steel: 'Steel Hinge',
  toolrod_oak: 'Reinforced Tool-Rod',
  potion_forge_charm: 'Forgefire Charm',
  potion_anvil_luck: 'Anvil-Luck Token',
  potion_coldiron_ward: 'Cold-Iron Ward',
  potion_mastersmith: "Mastersmith's Sigil",
}

// ---------------------------------------------------------------------------
// Recipes — one blacksmithing ladder, lvl 1..75. Inputs/outputs are real
// catalog ids or items added above. No `gate` (blacksmithing has no unlock:*
// flag; it is level-gated per the recipe contract). XP scales with levelReq.
// ---------------------------------------------------------------------------
const recipes: Recipe[] = [
  // 1 — the first alloy every apprentice fumbles
  {
    id: 'blacksmithing:bar_bronze',
    skill: 'blacksmithing',
    levelReq: 1,
    inputs: [{ id: 'ore_copper', qty: 2 }, { id: 'ore_iron', qty: 1 }],
    output: { id: 'bar_bronze', qty: 1 },
    xp: 8,
  },
  // 2 — rivets, the grout of smithing
  {
    id: 'blacksmithing:rivet_iron',
    skill: 'blacksmithing',
    levelReq: 4,
    inputs: [{ id: 'bar_iron', qty: 1 }],
    output: { id: 'rivet_iron', qty: 4 },
    xp: 12,
  },
  // 3 — chain, one won argument per link
  {
    id: 'blacksmithing:chain_links',
    skill: 'blacksmithing',
    levelReq: 7,
    inputs: [{ id: 'bar_iron', qty: 1 }, { id: 'rivet_iron', qty: 2 }],
    output: { id: 'chain_links', qty: 4 },
    xp: 16,
  },
  // 4 — the upgraded rivet
  {
    id: 'blacksmithing:rivet_steel',
    skill: 'blacksmithing',
    levelReq: 12,
    inputs: [{ id: 'bar_steel', qty: 1 }],
    output: { id: 'rivet_steel', qty: 4 },
    xp: 22,
  },
  // 5 — flux, the forge matchmaker
  {
    id: 'blacksmithing:flux_smelting',
    skill: 'blacksmithing',
    levelReq: 15,
    inputs: [{ id: 'crystal_shard', qty: 1 }, { id: 'ore_iron', qty: 2 }],
    output: { id: 'flux_smelting', qty: 2 },
    xp: 26,
  },
  // 6 — hinge
  {
    id: 'blacksmithing:hinge_steel',
    skill: 'blacksmithing',
    levelReq: 18,
    inputs: [{ id: 'bar_steel', qty: 1 }, { id: 'rivet_steel', qty: 2 }],
    output: { id: 'hinge_steel', qty: 1 },
    xp: 30,
  },
  // 7 — reinforced tool-rod (wood + metal intermediate)
  {
    id: 'blacksmithing:toolrod_oak',
    skill: 'blacksmithing',
    levelReq: 20,
    inputs: [{ id: 'wood_oak', qty: 2 }, { id: 'rivet_iron', qty: 2 }],
    output: { id: 'toolrod_oak', qty: 1 },
    xp: 34,
  },
  // 8 — electrum, gold persuaded to be useful (needs flux)
  {
    id: 'blacksmithing:bar_electrum',
    skill: 'blacksmithing',
    levelReq: 25,
    inputs: [{ id: 'bar_gold', qty: 1 }, { id: 'ore_copper', qty: 2 }, { id: 'flux_smelting', qty: 1 }],
    output: { id: 'bar_electrum', qty: 1 },
    xp: 44,
  },
  // 9 — darksteel, the light-drinker
  {
    id: 'blacksmithing:bar_darksteel',
    skill: 'blacksmithing',
    levelReq: 30,
    inputs: [{ id: 'bar_steel', qty: 2 }, { id: 'crystal_shard', qty: 1 }, { id: 'flux_smelting', qty: 1 }],
    output: { id: 'bar_darksteel', qty: 1 },
    xp: 58,
  },
  // 10 — first charm, the warm-thing-to-hold
  {
    id: 'blacksmithing:potion_forge_charm',
    skill: 'blacksmithing',
    levelReq: 35,
    inputs: [{ id: 'bar_bronze', qty: 1 }, { id: 'crystal_cut', qty: 1 }, { id: 'chain_links', qty: 1 }],
    output: { id: 'potion_forge_charm', qty: 1 },
    xp: 66,
  },
  // 11 — anvil-luck token
  {
    id: 'blacksmithing:potion_anvil_luck',
    skill: 'blacksmithing',
    levelReq: 45,
    inputs: [{ id: 'bar_electrum', qty: 1 }, { id: 'crystal_shard', qty: 2 }, { id: 'rivet_steel', qty: 2 }],
    output: { id: 'potion_anvil_luck', qty: 1 },
    xp: 85,
  },
  // 12 — cold-iron ward
  {
    id: 'blacksmithing:potion_coldiron_ward',
    skill: 'blacksmithing',
    levelReq: 55,
    inputs: [{ id: 'bar_darksteel', qty: 1 }, { id: 'hinge_steel', qty: 1 }, { id: 'crystal_cut', qty: 1 }],
    output: { id: 'potion_coldiron_ward', qty: 1 },
    xp: 110,
  },
  // 13 — starforged bar, the alloy of alloys
  {
    id: 'blacksmithing:bar_starforged',
    skill: 'blacksmithing',
    levelReq: 65,
    inputs: [
      { id: 'bar_darksteel', qty: 1 },
      { id: 'bar_electrum', qty: 1 },
      { id: 'crystal_cut', qty: 1 },
      { id: 'flux_smelting', qty: 2 },
    ],
    output: { id: 'bar_starforged', qty: 1 },
    xp: 150,
  },
  // 14 — capstone sigil
  {
    id: 'blacksmithing:potion_mastersmith',
    skill: 'blacksmithing',
    levelReq: 75,
    inputs: [
      { id: 'bar_starforged', qty: 1 },
      { id: 'crystal_cut', qty: 2 },
      { id: 'bar_gold', qty: 1 },
      { id: 'hinge_steel', qty: 1 },
    ],
    output: { id: 'potion_mastersmith', qty: 1 },
    xp: 210,
  },
]

registerPack({ items, itemNames, recipes })
