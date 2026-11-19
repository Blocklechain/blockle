/**
 * Content pack — CRAFTING & CONSUMABLES expansion: "The Wandering Artificer".
 *
 * A broad, cross-skill content drop layered on top of the existing skill trees.
 * It does NOT add new NPCs, quests, or town geometry — purely catalog items +
 * craft recipes so every gathering/crafting skill has substantially more to
 * make and more to drink/eat/wear:
 *
 *   - Alchemy  (unlock:brew) — 15 new brews: field/grand restoratives, dual
 *     casks, and the Phoenix Draught capstone. All render via buildPotion.
 *   - Cooking  (unlock:cook) — 12 new dishes, each with a dedicated buildFood
 *     mesh case so none fall back to the "?" crate.
 *   - Blacksmithing (level-gated) — 8 forged metal trinkets (rings/amulets/
 *     plate charms), each with a buildAccessory mesh case.
 *   - Tailoring (unlock:sew) — 8 stitched cloth trinkets (scarves, sashes,
 *     charms), each with a buildAccessory mesh case.
 *   - Plus 3 uncrafted "field kit" combat consumables (battlefield quick-quaffs).
 *
 * Every new item id renders a real mesh — the food_* ids get buildFood cases,
 * the accessory ids get buildAccessory cases (see src/items/mesh.ts), and every
 * potion_* id is handled generically by buildPotion. No fallback crates.
 *
 * Side-effect: calls registerPack({...}) at import time.
 */
import { registerPack } from './packs'
import type { ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'

// ===========================================================================
// Items
// ===========================================================================

const potions: ItemDef[] = [
  // --- alchemy brews (craftable; see recipes below) ----------------------
  { id: 'potion_hp_field', name: 'Field Salve', slot: 'consumable', rarity: 1, restores: { hp: 45 }, value: 18, desc: 'Brewed in a hurry, between one bad decision and the next.' },
  { id: 'potion_hp_grand', name: 'Grand Vitae', slot: 'consumable', rarity: 3, restores: { hp: 420 }, value: 180, desc: 'The alchemist swears it is not just ketchup. The alchemist is lying about several things.' },
  { id: 'potion_mp_field', name: 'Field Infusion', slot: 'consumable', rarity: 1, restores: { mp: 45 }, value: 18, desc: 'Steeped mushroom water. The buzz is real; the taste is a war crime.' },
  { id: 'potion_mp_grand', name: 'Grand Infusion', slot: 'consumable', rarity: 3, restores: { mp: 420 }, value: 180, desc: 'Your thoughts briefly travel faster than light and come back smug.' },
  { id: 'potion_dualcask', name: 'Dual Cask', slot: 'consumable', rarity: 2, restores: { hp: 160, mp: 160 }, value: 120, desc: 'Red on the left, blue on the right. Do NOT shake. We learned that the hard way.' },
  { id: 'potion_emberbrew', name: 'Emberbrew', slot: 'consumable', rarity: 1, restores: { hp: 95 }, value: 42, desc: 'Warms you from the inside. Possibly a little too much from the inside.' },
  { id: 'potion_tidebrew', name: 'Tidebrew', slot: 'consumable', rarity: 1, restores: { mp: 95 }, value: 42, desc: 'Cool, salty, and faintly disapproving of your spell choices.' },
  { id: 'potion_mossmend', name: 'Mossmend Tonic', slot: 'consumable', rarity: 1, restores: { hp: 75 }, value: 34, desc: 'Tastes like a forest floor. Heals like one too, apparently.' },
  { id: 'potion_starwater', name: 'Starwater', slot: 'consumable', rarity: 2, restores: { mp: 130 }, value: 80, desc: 'Bottled under a clear sky. The bubbles spell rude words if you squint.' },
  { id: 'potion_ironblood', name: 'Ironblood Draught', slot: 'consumable', rarity: 2, restores: { hp: 240 }, value: 110, desc: 'Thick, dark, metallic. Builds character. And iron. Mostly iron.' },
  { id: 'potion_dreamfizz', name: 'Dreamfizz', slot: 'consumable', rarity: 2, restores: { mp: 240 }, value: 110, desc: 'Violet and effervescent. Side effects include ideas you cannot afford.' },
  { id: 'potion_heartroot', name: 'Heartroot Elixir', slot: 'consumable', rarity: 3, restores: { hp: 320 }, value: 160, desc: 'Distilled from a root shaped suspiciously like a tiny fist.' },
  { id: 'potion_voidsip', name: 'Voidsip', slot: 'consumable', rarity: 3, restores: { mp: 320 }, value: 160, desc: 'Darker than it has any right to be. Refills mana and mild existential dread.' },
  { id: 'potion_sunsap', name: 'Sunsap Cordial', slot: 'consumable', rarity: 2, restores: { hp: 70, mp: 70 }, value: 90, desc: 'Golden, sweet, and balanced — body and mind in one gulp.' },
  { id: 'potion_phoenixdraught', name: 'Phoenix Draught', slot: 'consumable', rarity: 4, restores: { hp: 520, mp: 220 }, value: 420, desc: 'The capstone brew. Burns going down, rebuilds you on the way back up.' },

  // --- field-kit combat consumables (uncrafted drops / vendor) ------------
  { id: 'potion_warcry', name: 'Warcry Shot', slot: 'consumable', rarity: 1, restores: { hp: 130 }, value: 55, desc: 'A sharp little shot you slam mid-swing. Tastes of battle and bad citrus.' },
  { id: 'potion_secondwind', name: 'Second Wind', slot: 'consumable', rarity: 2, restores: { hp: 90, mp: 90 }, value: 70, desc: 'For when the fight is not over but you clearly are.' },
  { id: 'potion_adrenagel', name: 'Adrenagel', slot: 'consumable', rarity: 1, restores: { hp: 110 }, value: 50, desc: 'A squeezable field gel. Faster than a potion, stickier than a decision.' },
]

const foods: ItemDef[] = [
  { id: 'food_omelette_deluxe', name: 'Deluxe Omelette', slot: 'consumable', rarity: 1, restores: { hp: 90 }, value: 40, desc: 'Folded by someone who has strong opinions about folding.' },
  { id: 'food_crab_cakes', name: 'Crab Cakes', slot: 'consumable', rarity: 1, restores: { hp: 110 }, value: 48, desc: 'More crab than cake, which is exactly the correct ratio.' },
  { id: 'food_dragon_chili', name: 'Dragon Chili', slot: 'consumable', rarity: 2, restores: { hp: 120, mp: 40 }, value: 85, desc: 'So hot it technically counts as a magic attack on your own mouth.' },
  { id: 'food_frostberry_pie', name: 'Frostberry Pie', slot: 'consumable', rarity: 2, restores: { hp: 140 }, value: 78, desc: 'Served cold. Heals warm. Nobody knows how; the baker refuses to elaborate.' },
  { id: 'food_mushroom_risotto', name: 'Mushroom Risotto', slot: 'consumable', rarity: 2, restores: { hp: 95, mp: 60 }, value: 72, desc: 'Stirred for exactly forty minutes by someone who resents every second.' },
  { id: 'food_royal_roast', name: 'Royal Roast', slot: 'consumable', rarity: 3, restores: { hp: 260 }, value: 150, desc: 'Fit for a king, eaten by you, in a field, with your hands.' },
  { id: 'food_sea_platter', name: 'Sea Platter', slot: 'consumable', rarity: 2, restores: { hp: 180 }, value: 100, desc: 'Everything the ocean owed you, arranged nicely on a shell.' },
  { id: 'food_sugar_donut', name: 'Sugar Donut', slot: 'consumable', rarity: 0, restores: { hp: 60 }, value: 14, desc: 'A hole surrounded by poor decisions. Restores HP and briefly, joy.' },
  { id: 'food_trail_biscuit', name: 'Trail Biscuit', slot: 'consumable', rarity: 0, restores: { hp: 70 }, value: 16, desc: 'Hard enough to block a blow, edible enough to regret it.' },
  { id: 'food_spicy_noodles', name: 'Spicy Noodles', slot: 'consumable', rarity: 1, restores: { hp: 130 }, value: 56, desc: 'Slurp loud enough and nearby enemies reconsider their life choices.' },
  { id: 'food_berry_parfait', name: 'Berry Parfait', slot: 'consumable', rarity: 1, restores: { hp: 80, mp: 80 }, value: 60, desc: 'Layered, fancy, and gone in four bites. Restores body and mind.' },
  { id: 'food_campfire_sausage', name: 'Campfire Sausage', slot: 'consumable', rarity: 1, restores: { hp: 100 }, value: 44, desc: 'Charred on the outside, debatable on the inside, perfect in context.' },
]

const smithAccessories: ItemDef[] = [
  { id: 'ring_signet', name: 'Forged Signet', slot: 'accessory', rarity: 1, value: 60, stats: { def: 2, str: 1 }, desc: 'Stamped with a crest you invented on the spot. Looks official enough.' },
  { id: 'ring_bandit', name: 'Bandit Band', slot: 'accessory', rarity: 1, value: 70, stats: { agi: 2 }, desc: 'Previously owned. The previous owner no longer needs rings, or anything.' },
  { id: 'amulet_forgeheart', name: 'Forgeheart Amulet', slot: 'accessory', rarity: 2, value: 160, stats: { str: 3, atk: 2 }, desc: 'A coal that never quite cools. Keeps your arm warm and your hits warmer.' },
  { id: 'acc_toolbelt', name: 'Tinker Toolbelt', slot: 'accessory', rarity: 1, value: 80, stats: { agi: 1, int: 2 }, desc: 'Nine pockets, one of which always has the wrong wrench.' },
  { id: 'ring_bulwark', name: 'Bulwark Ring', slot: 'accessory', rarity: 2, value: 180, stats: { def: 4 }, desc: 'Heavy enough that your hand defends you by accident.' },
  { id: 'amulet_lodestone', name: 'Lodestone Pendant', slot: 'accessory', rarity: 2, value: 170, stats: { int: 3 }, desc: 'Points north, mostly. Sometimes points at the nearest bad idea.' },
  { id: 'acc_warplate', name: 'Warplate Pauldron', slot: 'accessory', rarity: 3, value: 280, stats: { def: 3, str: 2 }, desc: 'A single ornate shoulder. The other shoulder is simply jealous.' },
  { id: 'ring_emberband', name: 'Emberband', slot: 'accessory', rarity: 3, value: 320, stats: { atk: 3 }, desc: 'A ring of banked fire. Do not scratch your nose while wearing it.' },
]

const tailorAccessories: ItemDef[] = [
  { id: 'acc_scarf', name: 'Wool Scarf', slot: 'accessory', rarity: 1, value: 50, stats: { int: 2 }, desc: 'Knitted with love, or at least with grim determination.' },
  { id: 'acc_satchel_fine', name: 'Fine Satchel', slot: 'accessory', rarity: 1, value: 75, stats: { agi: 2 }, desc: 'Carries everything. Weighs nothing. Loses your keys reliably.' },
  { id: 'charm_clover', name: 'Four-Leaf Charm', slot: 'accessory', rarity: 2, value: 120, stats: { agi: 3 }, desc: 'Pressed, stitched, and definitely-not-a-three-leaf-with-a-friend.' },
  { id: 'acc_sash', name: 'Mage Sash', slot: 'accessory', rarity: 2, value: 110, stats: { str: 1, int: 2 }, desc: 'Ties your robe shut and your dignity together.' },
  { id: 'acc_bandana', name: 'Ranger Bandana', slot: 'accessory', rarity: 1, value: 65, stats: { agi: 2, str: 1 }, desc: 'Keeps sweat out of your eyes and mystery out of your hairline.' },
  { id: 'amulet_silkknot', name: 'Silkknot Amulet', slot: 'accessory', rarity: 2, value: 190, stats: { int: 2, def: 2 }, desc: 'A knot so intricate the tailor cried twice making it.' },
  { id: 'acc_silkgloves', name: 'Silk Gloves', slot: 'accessory', rarity: 2, value: 140, stats: { agi: 2, int: 1 }, desc: 'Too nice for fighting. You fight in them anyway, obviously.' },
  { id: 'charm_feather', name: 'Featherweight Charm', slot: 'accessory', rarity: 2, value: 130, stats: { agi: 3 }, desc: 'A single dyed feather. Makes you feel light. Does not make you light.' },
]

const items: ItemDef[] = [
  ...potions,
  ...foods,
  ...smithAccessories,
  ...tailorAccessories,
]

// ===========================================================================
// Recipes
// ===========================================================================

const recipes: Recipe[] = [
  // --- ALCHEMY (unlock:brew) --------------------------------------------
  { id: 'alchemy:potion_hp_field', skill: 'alchemy', levelReq: 6, inputs: [{ id: 'herb_green', qty: 2 }, { id: 'berry_red', qty: 2 }], output: { id: 'potion_hp_field', qty: 2 }, xp: 11, gate: 'unlock:brew' },
  { id: 'alchemy:potion_mp_field', skill: 'alchemy', levelReq: 6, inputs: [{ id: 'herb_green', qty: 2 }, { id: 'mushroom_brown', qty: 2 }], output: { id: 'potion_mp_field', qty: 2 }, xp: 11, gate: 'unlock:brew' },
  { id: 'alchemy:potion_mossmend', skill: 'alchemy', levelReq: 9, inputs: [{ id: 'herb_green', qty: 3 }, { id: 'mushroom_brown', qty: 1 }], output: { id: 'potion_mossmend', qty: 1 }, xp: 15, gate: 'unlock:brew' },
  { id: 'alchemy:potion_emberbrew', skill: 'alchemy', levelReq: 12, inputs: [{ id: 'herb_red', qty: 2 }, { id: 'reagent_berry_syrup', qty: 1 }], output: { id: 'potion_emberbrew', qty: 1 }, xp: 18, gate: 'unlock:brew' },
  { id: 'alchemy:potion_tidebrew', skill: 'alchemy', levelReq: 12, inputs: [{ id: 'herb_blue', qty: 2 }, { id: 'reagent_spore_extract', qty: 1 }], output: { id: 'potion_tidebrew', qty: 1 }, xp: 18, gate: 'unlock:brew' },
  { id: 'alchemy:potion_sunsap', skill: 'alchemy', levelReq: 16, inputs: [{ id: 'herb_gold', qty: 1 }, { id: 'reagent_herb_essence', qty: 1 }, { id: 'honey', qty: 1 }], output: { id: 'potion_sunsap', qty: 1 }, xp: 24, gate: 'unlock:brew' },
  { id: 'alchemy:potion_ironblood', skill: 'alchemy', levelReq: 20, inputs: [{ id: 'herb_red', qty: 3 }, { id: 'reagent_mineral_dust', qty: 1 }], output: { id: 'potion_ironblood', qty: 1 }, xp: 30, gate: 'unlock:brew' },
  { id: 'alchemy:potion_dreamfizz', skill: 'alchemy', levelReq: 20, inputs: [{ id: 'herb_blue', qty: 3 }, { id: 'reagent_spore_extract', qty: 1 }], output: { id: 'potion_dreamfizz', qty: 1 }, xp: 30, gate: 'unlock:brew' },
  { id: 'alchemy:potion_starwater', skill: 'alchemy', levelReq: 22, inputs: [{ id: 'herb_blue', qty: 2 }, { id: 'crystal_shard', qty: 1 }], output: { id: 'potion_starwater', qty: 1 }, xp: 33, gate: 'unlock:brew' },
  { id: 'alchemy:potion_dualcask', skill: 'alchemy', levelReq: 24, inputs: [{ id: 'reagent_herb_essence', qty: 1 }, { id: 'reagent_berry_syrup', qty: 1 }, { id: 'reagent_spore_extract', qty: 1 }], output: { id: 'potion_dualcask', qty: 1 }, xp: 38, gate: 'unlock:brew' },
  { id: 'alchemy:potion_heartroot', skill: 'alchemy', levelReq: 28, inputs: [{ id: 'herb_gold', qty: 2 }, { id: 'reagent_mineral_dust', qty: 1 }, { id: 'berry_red', qty: 3 }], output: { id: 'potion_heartroot', qty: 1 }, xp: 44, gate: 'unlock:brew' },
  { id: 'alchemy:potion_voidsip', skill: 'alchemy', levelReq: 28, inputs: [{ id: 'herb_gold', qty: 2 }, { id: 'crystal_shard', qty: 1 }, { id: 'mushroom_brown', qty: 3 }], output: { id: 'potion_voidsip', qty: 1 }, xp: 44, gate: 'unlock:brew' },
  { id: 'alchemy:potion_hp_grand', skill: 'alchemy', levelReq: 32, inputs: [{ id: 'potion_heartroot', qty: 1 }, { id: 'reagent_herb_essence', qty: 2 }], output: { id: 'potion_hp_grand', qty: 1 }, xp: 52, gate: 'unlock:brew' },
  { id: 'alchemy:potion_mp_grand', skill: 'alchemy', levelReq: 32, inputs: [{ id: 'potion_voidsip', qty: 1 }, { id: 'reagent_spore_extract', qty: 2 }], output: { id: 'potion_mp_grand', qty: 1 }, xp: 52, gate: 'unlock:brew' },
  { id: 'alchemy:potion_phoenixdraught', skill: 'alchemy', levelReq: 40, inputs: [{ id: 'potion_hp_grand', qty: 1 }, { id: 'potion_mp_grand', qty: 1 }, { id: 'crystal_cut', qty: 1 }, { id: 'herb_gold', qty: 3 }], output: { id: 'potion_phoenixdraught', qty: 1 }, xp: 80, gate: 'unlock:brew' },

  // --- COOKING (unlock:cook) --------------------------------------------
  { id: 'cooking:food_sugar_donut', skill: 'cooking', levelReq: 3, inputs: [{ id: 'cooking_dough', qty: 1 }, { id: 'honey', qty: 1 }], output: { id: 'food_sugar_donut', qty: 2 }, xp: 7, gate: 'unlock:cook' },
  { id: 'cooking:food_trail_biscuit', skill: 'cooking', levelReq: 4, inputs: [{ id: 'cooking_dough', qty: 1 }, { id: 'wheat', qty: 2 }], output: { id: 'food_trail_biscuit', qty: 3 }, xp: 8, gate: 'unlock:cook' },
  { id: 'cooking:food_omelette_deluxe', skill: 'cooking', levelReq: 8, inputs: [{ id: 'cooking_tallow', qty: 1 }, { id: 'mushroom_brown', qty: 1 }, { id: 'herb_green', qty: 1 }], output: { id: 'food_omelette_deluxe', qty: 1 }, xp: 13, gate: 'unlock:cook' },
  { id: 'cooking:food_campfire_sausage', skill: 'cooking', levelReq: 9, inputs: [{ id: 'cooking_tallow', qty: 1 }, { id: 'herb_red', qty: 1 }], output: { id: 'food_campfire_sausage', qty: 2 }, xp: 14, gate: 'unlock:cook' },
  { id: 'cooking:food_berry_parfait', skill: 'cooking', levelReq: 11, inputs: [{ id: 'berry_red', qty: 3 }, { id: 'honey', qty: 1 }], output: { id: 'food_berry_parfait', qty: 1 }, xp: 16, gate: 'unlock:cook' },
  { id: 'cooking:food_crab_cakes', skill: 'cooking', levelReq: 13, inputs: [{ id: 'fish_raw', qty: 2 }, { id: 'cooking_dough', qty: 1 }], output: { id: 'food_crab_cakes', qty: 2 }, xp: 19, gate: 'unlock:cook' },
  { id: 'cooking:food_spicy_noodles', skill: 'cooking', levelReq: 14, inputs: [{ id: 'cooking_dough', qty: 1 }, { id: 'cooking_stock', qty: 1 }, { id: 'herb_red', qty: 2 }], output: { id: 'food_spicy_noodles', qty: 2 }, xp: 21, gate: 'unlock:cook' },
  { id: 'cooking:food_mushroom_risotto', skill: 'cooking', levelReq: 17, inputs: [{ id: 'cooking_stock', qty: 1 }, { id: 'mushroom_brown', qty: 3 }, { id: 'wheat', qty: 2 }], output: { id: 'food_mushroom_risotto', qty: 1 }, xp: 25, gate: 'unlock:cook' },
  { id: 'cooking:food_frostberry_pie', skill: 'cooking', levelReq: 19, inputs: [{ id: 'cooking_dough', qty: 1 }, { id: 'berry_red', qty: 4 }, { id: 'herb_blue', qty: 1 }], output: { id: 'food_frostberry_pie', qty: 1 }, xp: 28, gate: 'unlock:cook' },
  { id: 'cooking:food_sea_platter', skill: 'cooking', levelReq: 22, inputs: [{ id: 'fish_salmon', qty: 1 }, { id: 'fish_trout', qty: 1 }, { id: 'herb_green', qty: 1 }], output: { id: 'food_sea_platter', qty: 1 }, xp: 33, gate: 'unlock:cook' },
  { id: 'cooking:food_dragon_chili', skill: 'cooking', levelReq: 26, inputs: [{ id: 'cooking_stock', qty: 1 }, { id: 'herb_red', qty: 3 }, { id: 'herb_gold', qty: 1 }], output: { id: 'food_dragon_chili', qty: 1 }, xp: 40, gate: 'unlock:cook' },
  { id: 'cooking:food_royal_roast', skill: 'cooking', levelReq: 30, inputs: [{ id: 'cooking_tallow', qty: 2 }, { id: 'cooking_stock', qty: 1 }, { id: 'herb_gold', qty: 2 }], output: { id: 'food_royal_roast', qty: 1 }, xp: 48, gate: 'unlock:cook' },

  // --- BLACKSMITHING (level-gated; no unlock flag, matching base pack) ----
  { id: 'blacksmithing:ring_signet', skill: 'blacksmithing', levelReq: 8, inputs: [{ id: 'bar_iron', qty: 2 }], output: { id: 'ring_signet', qty: 1 }, xp: 14 },
  { id: 'blacksmithing:ring_bandit', skill: 'blacksmithing', levelReq: 9, inputs: [{ id: 'bar_copper', qty: 2 }, { id: 'wood_oak', qty: 1 }], output: { id: 'ring_bandit', qty: 1 }, xp: 15 },
  { id: 'blacksmithing:acc_toolbelt', skill: 'blacksmithing', levelReq: 12, inputs: [{ id: 'bar_iron', qty: 1 }, { id: 'hide_boar', qty: 1 }], output: { id: 'acc_toolbelt', qty: 1 }, xp: 18 },
  { id: 'blacksmithing:amulet_forgeheart', skill: 'blacksmithing', levelReq: 16, inputs: [{ id: 'bar_steel', qty: 2 }, { id: 'crystal_shard', qty: 1 }], output: { id: 'amulet_forgeheart', qty: 1 }, xp: 24 },
  { id: 'blacksmithing:ring_bulwark', skill: 'blacksmithing', levelReq: 20, inputs: [{ id: 'bar_steel', qty: 3 }], output: { id: 'ring_bulwark', qty: 1 }, xp: 30 },
  { id: 'blacksmithing:amulet_lodestone', skill: 'blacksmithing', levelReq: 22, inputs: [{ id: 'bar_steel', qty: 2 }, { id: 'ore_gold', qty: 1 }], output: { id: 'amulet_lodestone', qty: 1 }, xp: 33 },
  { id: 'blacksmithing:acc_warplate', skill: 'blacksmithing', levelReq: 28, inputs: [{ id: 'bar_gold', qty: 2 }, { id: 'bar_steel', qty: 2 }], output: { id: 'acc_warplate', qty: 1 }, xp: 44 },
  { id: 'blacksmithing:ring_emberband', skill: 'blacksmithing', levelReq: 34, inputs: [{ id: 'bar_gold', qty: 2 }, { id: 'crystal_cut', qty: 1 }], output: { id: 'ring_emberband', qty: 1 }, xp: 56 },

  // --- TAILORING (unlock:sew) -------------------------------------------
  { id: 'tailoring:acc_scarf', skill: 'tailoring', levelReq: 6, inputs: [{ id: 'bolt_wolfhide', qty: 1 }, { id: 'thread_sinew', qty: 1 }], output: { id: 'acc_scarf', qty: 1 }, xp: 11, gate: 'unlock:sew' },
  { id: 'tailoring:acc_bandana', skill: 'tailoring', levelReq: 7, inputs: [{ id: 'bolt_wolfhide', qty: 1 }, { id: 'herb_red', qty: 1 }], output: { id: 'acc_bandana', qty: 1 }, xp: 12, gate: 'unlock:sew' },
  { id: 'tailoring:acc_satchel_fine', skill: 'tailoring', levelReq: 10, inputs: [{ id: 'boar_leather', qty: 1 }, { id: 'thread_sinew', qty: 2 }], output: { id: 'acc_satchel_fine', qty: 1 }, xp: 16, gate: 'unlock:sew' },
  { id: 'tailoring:acc_sash', skill: 'tailoring', levelReq: 13, inputs: [{ id: 'padded_lining', qty: 1 }, { id: 'herb_blue', qty: 1 }], output: { id: 'acc_sash', qty: 1 }, xp: 20, gate: 'unlock:sew' },
  { id: 'tailoring:charm_feather', skill: 'tailoring', levelReq: 15, inputs: [{ id: 'bolt_wolfhide', qty: 1 }, { id: 'herb_gold', qty: 1 }], output: { id: 'charm_feather', qty: 1 }, xp: 23, gate: 'unlock:sew' },
  { id: 'tailoring:acc_silkgloves', skill: 'tailoring', levelReq: 18, inputs: [{ id: 'waxed_canvas', qty: 1 }, { id: 'thread_sinew', qty: 2 }], output: { id: 'acc_silkgloves', qty: 1 }, xp: 27, gate: 'unlock:sew' },
  { id: 'tailoring:amulet_silkknot', skill: 'tailoring', levelReq: 22, inputs: [{ id: 'waxed_canvas', qty: 2 }, { id: 'crystal_shard', qty: 1 }], output: { id: 'amulet_silkknot', qty: 1 }, xp: 34, gate: 'unlock:sew' },
  { id: 'tailoring:charm_clover', skill: 'tailoring', levelReq: 26, inputs: [{ id: 'crystal_weave', qty: 1 }, { id: 'herb_gold', qty: 2 }], output: { id: 'charm_clover', qty: 1 }, xp: 42, gate: 'unlock:sew' },
]

// ===========================================================================
// Display names (inventory / tooltips pull from the merged ITEM_NAMES map too)
// ===========================================================================

const itemNames: Record<string, string> = Object.fromEntries(
  items.map((it) => [it.id, it.name]),
)

registerPack({ items, recipes, itemNames })
