/**
 * ===========================================================================
 *  WYRMS & DRAGONS MOB PACK — the apex endgame bestiary.
 * ===========================================================================
 *
 * Fifteen scaly disappointments ranging from barely-hatched wyrmlings (tier 2)
 * through drakes and wyverns (tier 3) up to ancient wyrms and full dragons
 * (tier 4). They nest in the harsh OUTER biomes — volcanic, glacier, crystal,
 * canyon, graveyard, ruins, wastes, tundra — so they surface in the high level
 * bands way out on the enlarged continent, exactly where an under-levelled
 * optimist goes to find out they were under-levelled.
 *
 * Every species ships a 'base' pet plus 1-2 rare variants (ember/snow = Rare,
 * golden/shadow = Epic), auto-recolored from the species rig. Loot richness
 * tracks tier (iron/steel at t3, gold/crystal at t4); each table carries a
 * 'nothing' row so farming them does not literally rain treasure.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

const WYRM_SPECIES: SpeciesDef[] = [
  // ---- tier 2: hatchlings that peaked at being born -----------------------
  { id: 'wyrmling_ember', name: 'Ember Wyrmling', tier: 2, color: 0xe2572b, shape: 'crawler' },
  { id: 'wyrmling_frost', name: 'Frost Wyrmling', tier: 2, color: 0x8fd4e8, shape: 'crawler' },
  // ---- tier 3: drakes & wyverns, the mid-tier menace ----------------------
  { id: 'drake_ash', name: 'Ash Drake', tier: 3, color: 0x5a4a44, shape: 'quadruped' },
  { id: 'drake_crag', name: 'Crag Drake', tier: 3, color: 0x7b6f63, shape: 'quadruped' },
  { id: 'drake_dune', name: 'Dune Drake', tier: 3, color: 0xc9a567, shape: 'quadruped' },
  { id: 'wyvern_cinder', name: 'Cinder Wyvern', tier: 3, color: 0xb3331d, shape: 'flyer' },
  { id: 'wyvern_glacier', name: 'Glacier Wyvern', tier: 3, color: 0x6fb8d6, shape: 'flyer' },
  { id: 'drake_prism', name: 'Prism Drake', tier: 3, color: 0x9b7fd4, shape: 'quadruped' },
  // ---- tier 4: ancient wyrms & dragons, the apology-note foes --------------
  { id: 'wyrm_magma', name: 'Magma Wyrm', tier: 4, color: 0xd1421a, shape: 'crawler' },
  { id: 'wyrm_permafrost', name: 'Permafrost Wyrm', tier: 4, color: 0xa8e4f0, shape: 'crawler' },
  { id: 'wyrm_crystalline', name: 'Crystalline Wyrm', tier: 4, color: 0x7fe0d4, shape: 'crawler' },
  { id: 'wyrm_bone', name: 'Bone Wyrm', tier: 4, color: 0xe4ddc8, shape: 'crawler' },
  { id: 'dragon_ashfall', name: 'Ashfall Dragon', tier: 4, color: 0x3a2f2b, shape: 'flyer' },
  { id: 'dragon_rime', name: 'Rime Dragon', tier: 4, color: 0xc0e8f5, shape: 'flyer' },
  { id: 'dragon_obsidian', name: 'Obsidian Dragon', tier: 4, color: 0x1f1b24, shape: 'flyer' },
]

const WYRM_PETS: PetDef[] = [
  // Ember Wyrmling
  { species: 'wyrmling_ember', variant: 'base', name: 'Matchstick', dropOneIn: 400 },
  { species: 'wyrmling_ember', variant: 'ember', name: 'Full Combustion', dropOneIn: 1200 },
  { species: 'wyrmling_ember', variant: 'golden', name: 'Pre-Approved Firebrand', dropOneIn: 3000 },
  // Frost Wyrmling
  { species: 'wyrmling_frost', variant: 'base', name: 'Brain Freeze', dropOneIn: 400 },
  { species: 'wyrmling_frost', variant: 'snow', name: 'Deeper Freeze', dropOneIn: 1200 },
  { species: 'wyrmling_frost', variant: 'shadow', name: 'Left in the Freezer', dropOneIn: 3000 },
  // Ash Drake
  { species: 'drake_ash', variant: 'base', name: 'Cinderella (No Ball)', dropOneIn: 400 },
  { species: 'drake_ash', variant: 'ember', name: 'Smoke Break', dropOneIn: 1200 },
  { species: 'drake_ash', variant: 'shadow', name: 'Ashes to Ashes to HR', dropOneIn: 3000 },
  // Crag Drake
  { species: 'drake_crag', variant: 'base', name: 'Pebbles', dropOneIn: 400 },
  { species: 'drake_crag', variant: 'snow', name: 'Scree Scream', dropOneIn: 1200 },
  { species: 'drake_crag', variant: 'golden', name: 'Load-Bearing Lizard', dropOneIn: 3000 },
  // Dune Drake
  { species: 'drake_dune', variant: 'base', name: 'Sandy Claws', dropOneIn: 400 },
  { species: 'drake_dune', variant: 'ember', name: 'Sun-Dried', dropOneIn: 1200 },
  { species: 'drake_dune', variant: 'golden', name: 'Timeshare in the Dunes', dropOneIn: 3000 },
  // Cinder Wyvern
  { species: 'wyvern_cinder', variant: 'base', name: 'Hot Take', dropOneIn: 400 },
  { species: 'wyvern_cinder', variant: 'ember', name: 'Even Hotter Take', dropOneIn: 1200 },
  { species: 'wyvern_cinder', variant: 'shadow', name: 'Deleted Hot Take', dropOneIn: 3000 },
  // Glacier Wyvern
  { species: 'wyvern_glacier', variant: 'base', name: 'Cold Shoulder', dropOneIn: 400 },
  { species: 'wyvern_glacier', variant: 'snow', name: 'Giving Nothing', dropOneIn: 1200 },
  { species: 'wyvern_glacier', variant: 'golden', name: 'Chilled Investment', dropOneIn: 3000 },
  // Prism Drake
  { species: 'drake_prism', variant: 'base', name: 'Rainbow Connection (Bad)', dropOneIn: 400 },
  { species: 'drake_prism', variant: 'ember', name: 'Refraction Error', dropOneIn: 1200 },
  { species: 'drake_prism', variant: 'golden', name: 'Overpriced Spectrum', dropOneIn: 3000 },
  // Magma Wyrm
  { species: 'wyrm_magma', variant: 'base', name: 'Lava Lamp', dropOneIn: 400 },
  { species: 'wyrm_magma', variant: 'ember', name: 'Molten Opinion', dropOneIn: 1200 },
  { species: 'wyrm_magma', variant: 'shadow', name: 'Cooled to Resentment', dropOneIn: 3000 },
  // Permafrost Wyrm
  { species: 'wyrm_permafrost', variant: 'base', name: 'Freezer Aisle', dropOneIn: 400 },
  { species: 'wyrm_permafrost', variant: 'snow', name: 'Ice-Cold Regards', dropOneIn: 1200 },
  { species: 'wyrm_permafrost', variant: 'golden', name: 'Frozen Assets', dropOneIn: 3000 },
  // Crystalline Wyrm
  { species: 'wyrm_crystalline', variant: 'base', name: 'Cubic Zirconia', dropOneIn: 400 },
  { species: 'wyrm_crystalline', variant: 'snow', name: 'Clearly Overcompensating', dropOneIn: 1200 },
  { species: 'wyrm_crystalline', variant: 'golden', name: 'Conflict-Free (Allegedly)', dropOneIn: 3000 },
  // Bone Wyrm
  { species: 'wyrm_bone', variant: 'base', name: 'Spinal Tap', dropOneIn: 400 },
  { species: 'wyrm_bone', variant: 'ember', name: 'Marrow Escape', dropOneIn: 1200 },
  { species: 'wyrm_bone', variant: 'shadow', name: 'Skeleton Staff', dropOneIn: 3000 },
  // Ashfall Dragon
  { species: 'dragon_ashfall', variant: 'base', name: 'Light Drizzle (of Doom)', dropOneIn: 400 },
  { species: 'dragon_ashfall', variant: 'ember', name: 'Apocalypse, But Cozy', dropOneIn: 1200 },
  { species: 'dragon_ashfall', variant: 'shadow', name: 'The Forecast Was Wrong', dropOneIn: 3000 },
  // Rime Dragon
  { species: 'dragon_rime', variant: 'base', name: 'Window Frost', dropOneIn: 400 },
  { species: 'dragon_rime', variant: 'snow', name: 'Record Lows', dropOneIn: 1200 },
  { species: 'dragon_rime', variant: 'golden', name: 'Platinum Hypothermia', dropOneIn: 3000 },
  // Obsidian Dragon
  { species: 'dragon_obsidian', variant: 'base', name: 'Dark Mode', dropOneIn: 400 },
  { species: 'dragon_obsidian', variant: 'ember', name: 'Glass Half Molten', dropOneIn: 1200 },
  { species: 'dragon_obsidian', variant: 'shadow', name: 'Read Receipts: Off', dropOneIn: 3000 },
]

registerMobPack({
  species: WYRM_SPECIES,
  pets: WYRM_PETS,
  // Scaly things into the harsh outer biomes; tougher = farther / nastier.
  biomeSpawns: {
    // tier 2 wyrmlings skulk near the heat and the cold
    volcanic: [
      ['wyrmling_ember', 6],
      ['drake_ash', 4],
      ['wyvern_cinder', 4],
      ['wyrm_magma', 2],
      ['dragon_ashfall', 1],
    ],
    glacier: [
      ['wyrmling_frost', 6],
      ['wyvern_glacier', 4],
      ['wyrm_permafrost', 2],
      ['dragon_rime', 1],
    ],
    tundra: [
      ['wyrmling_frost', 5],
      ['wyvern_glacier', 3],
    ],
    mountain: [
      ['wyrmling_ember', 3],
      ['drake_crag', 5],
    ],
    crystal: [
      ['drake_prism', 5],
      ['wyrm_crystalline', 3],
    ],
    canyon: [
      ['drake_dune', 5],
      ['drake_crag', 3],
      ['dragon_obsidian', 1],
    ],
    desert: [
      ['drake_dune', 4],
    ],
    wastes: [
      ['drake_ash', 3],
      ['wyrm_magma', 2],
      ['dragon_ashfall', 1],
    ],
    graveyard: [
      ['wyrm_bone', 4],
      ['dragon_obsidian', 1],
    ],
    ruins: [
      ['wyrm_bone', 3],
      ['dragon_obsidian', 2],
      ['wyrm_crystalline', 1],
    ],
  },
  // Loot richness tracks tier: t2 copper/hide/herb, t3 iron/steel/shard,
  // t4 gold/crystal. Every table ends on a 'nothing' row.
  loot: {
    // --- tier 2 ---
    wyrmling_ember: [
      ['ore_copper', 28, 2],
      ['hide_tough', 20],
      ['herb_red', 14],
      ['food_jerky', 8],
      ['nothing', 55],
    ],
    wyrmling_frost: [
      ['ore_copper', 28, 2],
      ['hide_tough', 20],
      ['herb_blue', 14],
      ['fish_raw', 8],
      ['nothing', 55],
    ],
    // --- tier 3 ---
    drake_ash: [
      ['ore_iron', 24, 2],
      ['bar_iron', 12],
      ['hide_tough', 18],
      ['crystal_shard', 8],
      ['herb_red', 10],
      ['nothing', 48],
    ],
    drake_crag: [
      ['ore_iron', 26, 2],
      ['bar_steel', 10],
      ['clay_lump', 16],
      ['crystal_raw', 8],
      ['wood_ancient', 6],
      ['nothing', 48],
    ],
    drake_dune: [
      ['ore_iron', 22, 2],
      ['bar_iron', 12],
      ['hide_tough', 16],
      ['herb_gold', 8],
      ['crystal_shard', 6],
      ['nothing', 48],
    ],
    wyvern_cinder: [
      ['bar_iron', 16],
      ['bar_steel', 10],
      ['crystal_shard', 10],
      ['herb_red', 12],
      ['food_jerky', 8],
      ['nothing', 46],
    ],
    wyvern_glacier: [
      ['bar_iron', 16],
      ['bar_steel', 10],
      ['crystal_shard', 10],
      ['herb_blue', 12],
      ['fish_salmon', 8],
      ['nothing', 46],
    ],
    drake_prism: [
      ['crystal_raw', 18, 2],
      ['crystal_shard', 14],
      ['crystal_cut', 6],
      ['bar_steel', 10],
      ['nothing', 46],
    ],
    // --- tier 4 ---
    wyrm_magma: [
      ['bar_gold', 14],
      ['ore_gold', 18, 2],
      ['crystal_raw', 12],
      ['crystal_cut', 7],
      ['herb_gold', 10],
      ['nothing', 42],
    ],
    wyrm_permafrost: [
      ['bar_gold', 14],
      ['ore_gold', 18, 2],
      ['crystal_shard', 14],
      ['crystal_cut', 7],
      ['fish_salmon', 10],
      ['nothing', 42],
    ],
    wyrm_crystalline: [
      ['crystal_cut', 14],
      ['crystal_raw', 20, 2],
      ['crystal_shard', 16],
      ['bar_gold', 10],
      ['nothing', 42],
    ],
    wyrm_bone: [
      ['bar_gold', 12],
      ['ore_gold', 16, 2],
      ['crystal_shard', 12],
      ['potion_regret', 4],
      ['food_jerky', 10],
      ['nothing', 44],
    ],
    dragon_ashfall: [
      ['bar_gold', 18, 2],
      ['ore_gold', 16, 2],
      ['crystal_cut', 10],
      ['crystal_raw', 12],
      ['herb_gold', 10],
      ['potion_regret', 4],
      ['nothing', 40],
    ],
    dragon_rime: [
      ['bar_gold', 18, 2],
      ['ore_gold', 16, 2],
      ['crystal_cut', 10],
      ['crystal_shard', 14],
      ['herb_blue', 10],
      ['nothing', 40],
    ],
    dragon_obsidian: [
      ['bar_gold', 20, 2],
      ['crystal_cut', 14],
      ['crystal_raw', 14],
      ['crystal_shard', 12],
      ['potion_regret', 5],
      ['nothing', 38],
    ],
  },
})
