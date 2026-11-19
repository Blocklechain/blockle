/**
 * ===========================================================================
 *  MOB PACK — CREEPY-CRAWLIES: giant insects & arachnids
 * ===========================================================================
 *
 * A themed pack of 15 oversized bugs — beetles, mantises, scorpions, wasps,
 * centipedes, spiders, ants, locusts and one truly disgusting tick. They lean
 * into the damp/scorched edges of the map: swamp, forest, canyon and desert,
 * with the nastier tier-3 horrors wandering into the far harsh biomes (wastes,
 * ruins, canyon, graveyard) where the high-level bands put them.
 *
 * Every species gets a 'base' pet plus 1-2 rare variants (ember/snow/golden/
 * shadow), each biome-spawned, each with its own loot table (incl. a 'nothing'
 * row so squashing a bug doesn't reliably rain treasure). Meshes auto-generate
 * from `shape`; no mesh code here.
 *
 * Species: 15.  Pets: 35 (15 base + 20 rare).
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

// --- Species -------------------------------------------------------------
// Tier buckets loot richness: 1 copper/wood, 2 iron/crystal_raw, 3 gold/crystal_cut.
const SPECIES: SpeciesDef[] = [
  { id: 'beetle_dung', name: 'Dung Beetle', tier: 1, color: 0x4b3a2a, shape: 'crawler' },
  { id: 'beetle_rhino', name: 'Rhino Beetle', tier: 2, color: 0x3a2e1f, shape: 'crawler' },
  { id: 'mantis_prayer', name: 'Praying Mantis', tier: 2, color: 0x6fae4a, shape: 'biped' },
  { id: 'mantis_blade', name: 'Scythe Mantis', tier: 3, color: 0x3f7a35, shape: 'biped' },
  { id: 'scorpion_sand', name: 'Sand Scorpion', tier: 2, color: 0xc8a24f, shape: 'crawler' },
  { id: 'scorpion_emperor', name: 'Emperor Scorpion', tier: 3, color: 0x2b2440, shape: 'crawler' },
  { id: 'wasp_paper', name: 'Paper Wasp', tier: 1, color: 0xd9a43a, shape: 'flyer' },
  { id: 'wasp_hornet', name: 'Murder Hornet', tier: 3, color: 0xcf7a1f, shape: 'flyer' },
  { id: 'centipede_bog', name: 'Bog Centipede', tier: 2, color: 0x7a3550, shape: 'crawler' },
  { id: 'centipede_chasm', name: 'Chasm Centipede', tier: 3, color: 0x8a1f2a, shape: 'crawler' },
  { id: 'spider_funnel', name: 'Funnel-Web Spider', tier: 2, color: 0x2e2a2e, shape: 'crawler' },
  { id: 'spider_recluse', name: 'Desert Recluse', tier: 3, color: 0x6b4a33, shape: 'crawler' },
  { id: 'ant_soldier', name: 'Soldier Ant', tier: 1, color: 0x7a2e1f, shape: 'crawler' },
  { id: 'locust_swarm', name: 'Swarm Locust', tier: 1, color: 0x9aa84a, shape: 'flyer' },
  { id: 'tick_bloated', name: 'Bloated Tick', tier: 2, color: 0x8c6b55, shape: 'blob' },
]

// --- Pets ----------------------------------------------------------------
// base ~400 (Common), ember/snow ~1200 (Rare), golden/shadow ~3000 (Epic).
const PETS: PetDef[] = [
  { species: 'beetle_dung', variant: 'base', name: 'Sir Rolls-a-Lot', dropOneIn: 400 },
  { species: 'beetle_dung', variant: 'snow', name: 'Frostball', dropOneIn: 1200 },

  { species: 'beetle_rhino', variant: 'base', name: 'Honk the Charger', dropOneIn: 420 },
  { species: 'beetle_rhino', variant: 'ember', name: 'Cinderhorn', dropOneIn: 1200 },
  { species: 'beetle_rhino', variant: 'golden', name: 'Overcompensating Gary', dropOneIn: 3000 },

  { species: 'mantis_prayer', variant: 'base', name: 'Brother Nibbles', dropOneIn: 430 },
  { species: 'mantis_prayer', variant: 'snow', name: 'Chilly Confession', dropOneIn: 1250 },

  { species: 'mantis_blade', variant: 'base', name: 'Divorce Lawyer', dropOneIn: 450 },
  { species: 'mantis_blade', variant: 'golden', name: 'Alimony', dropOneIn: 3000 },
  { species: 'mantis_blade', variant: 'shadow', name: 'The Prenup', dropOneIn: 3200 },

  { species: 'scorpion_sand', variant: 'base', name: 'Pinchy McRegret', dropOneIn: 420 },
  { species: 'scorpion_sand', variant: 'ember', name: 'Sunstroke', dropOneIn: 1200 },

  { species: 'scorpion_emperor', variant: 'base', name: 'His Tiny Majesty', dropOneIn: 460 },
  { species: 'scorpion_emperor', variant: 'golden', name: 'Taxpayer Funded', dropOneIn: 3100 },
  { species: 'scorpion_emperor', variant: 'shadow', name: 'The Succession Crisis', dropOneIn: 3400 },

  { species: 'wasp_paper', variant: 'base', name: 'Unpaid Intern', dropOneIn: 400 },
  { species: 'wasp_paper', variant: 'snow', name: 'Seasonal Layoff', dropOneIn: 1200 },

  { species: 'wasp_hornet', variant: 'base', name: 'HR Complaint', dropOneIn: 470 },
  { species: 'wasp_hornet', variant: 'ember', name: 'Workplace Incident', dropOneIn: 1300 },
  { species: 'wasp_hornet', variant: 'shadow', name: 'Formal Grievance', dropOneIn: 3300 },

  { species: 'centipede_bog', variant: 'base', name: 'Too Many Legs', dropOneIn: 430 },
  { species: 'centipede_bog', variant: 'snow', name: 'Cold Feet (Forty of Them)', dropOneIn: 1250 },

  { species: 'centipede_chasm', variant: 'base', name: 'Existential Dread', dropOneIn: 460 },
  { species: 'centipede_chasm', variant: 'golden', name: 'Midlife Crisis', dropOneIn: 3100 },

  { species: 'spider_funnel', variant: 'base', name: 'Rent Collector', dropOneIn: 430 },
  { species: 'spider_funnel', variant: 'ember', name: 'Eviction Notice', dropOneIn: 1250 },

  { species: 'spider_recluse', variant: 'base', name: 'Hates Company', dropOneIn: 460 },
  { species: 'spider_recluse', variant: 'golden', name: 'Left On Read', dropOneIn: 3100 },
  { species: 'spider_recluse', variant: 'shadow', name: 'Blocked Everyone', dropOneIn: 3400 },

  { species: 'ant_soldier', variant: 'base', name: 'Private Snack', dropOneIn: 400 },
  { species: 'ant_soldier', variant: 'snow', name: 'Winter Rations', dropOneIn: 1200 },

  { species: 'locust_swarm', variant: 'base', name: 'Crop Failure', dropOneIn: 400 },
  { species: 'locust_swarm', variant: 'ember', name: 'Biblical Problem', dropOneIn: 1200 },

  { species: 'tick_bloated', variant: 'base', name: 'Little Freeloader', dropOneIn: 420 },
  { species: 'tick_bloated', variant: 'golden', name: 'Full Of Your Blood', dropOneIn: 3000 },
]

registerMobPack({
  species: SPECIES,
  pets: PETS,
  // Themed biomes (swamp/forest/canyon/desert) plus harsh outer biomes for the
  // tier-3 horrors so they appear in the far high-level bands.
  biomeSpawns: {
    swamp: [
      ['beetle_dung', 10],
      ['centipede_bog', 8],
      ['spider_funnel', 6],
      ['tick_bloated', 7],
      ['mantis_prayer', 4],
    ],
    forest: [
      ['beetle_dung', 6],
      ['beetle_rhino', 7],
      ['mantis_prayer', 6],
      ['wasp_paper', 9],
      ['ant_soldier', 10],
      ['wasp_hornet', 3],
    ],
    desert: [
      ['scorpion_sand', 10],
      ['locust_swarm', 9],
      ['spider_recluse', 5],
      ['ant_soldier', 5],
    ],
    canyon: [
      ['scorpion_emperor', 6],
      ['mantis_blade', 5],
      ['centipede_chasm', 6],
      ['wasp_hornet', 4],
      ['spider_recluse', 4],
    ],
    wastes: [
      ['scorpion_emperor', 4],
      ['centipede_chasm', 5],
      ['tick_bloated', 3],
    ],
    ruins: [
      ['spider_recluse', 5],
      ['mantis_blade', 4],
      ['wasp_hornet', 3],
    ],
    graveyard: [
      ['centipede_chasm', 4],
      ['tick_bloated', 4],
      ['scorpion_emperor', 3],
    ],
  },
  // One 'nothing' row per table keeps kills from reliably raining items.
  loot: {
    beetle_dung: [
      ['clay_lump', 24, 2],
      ['ore_copper', 14, 2],
      ['mushroom_brown', 16, 2],
      ['herb_green', 10],
      ['nothing', 46],
    ],
    beetle_rhino: [
      ['ore_iron', 18, 2],
      ['bar_copper', 12],
      ['hide_tough', 10],
      ['wood_oak', 14, 2],
      ['nothing', 48],
    ],
    mantis_prayer: [
      ['herb_green', 20, 2],
      ['herb_blue', 12],
      ['ore_iron', 12, 2],
      ['hide_boar', 10],
      ['nothing', 48],
    ],
    mantis_blade: [
      ['bar_steel', 14],
      ['ore_gold', 12, 2],
      ['crystal_shard', 10],
      ['hide_tough', 12],
      ['nothing', 52],
    ],
    scorpion_sand: [
      ['ore_iron', 16, 2],
      ['crystal_raw', 12],
      ['herb_red', 14],
      ['bar_copper', 10],
      ['nothing', 48],
    ],
    scorpion_emperor: [
      ['bar_gold', 12],
      ['crystal_cut', 8],
      ['crystal_shard', 14],
      ['potion_regret', 6],
      ['nothing', 56],
    ],
    wasp_paper: [
      ['food_honey', 22, 2],
      ['herb_gold', 8],
      ['wood_pine', 14, 2],
      ['ore_copper', 10],
      ['nothing', 48],
    ],
    wasp_hornet: [
      ['food_honey', 16, 3],
      ['bar_steel', 12],
      ['crystal_raw', 12],
      ['herb_gold', 10],
      ['nothing', 54],
    ],
    centipede_bog: [
      ['hide_boar', 16],
      ['ore_iron', 14, 2],
      ['herb_blue', 12],
      ['fish_raw', 12, 2],
      ['nothing', 50],
    ],
    centipede_chasm: [
      ['ore_gold', 14, 2],
      ['crystal_shard', 12],
      ['bar_steel', 10],
      ['wood_ancient', 8],
      ['nothing', 54],
    ],
    spider_funnel: [
      ['hide_tough', 14],
      ['crystal_raw', 12],
      ['ore_iron', 12, 2],
      ['herb_red', 12],
      ['nothing', 50],
    ],
    spider_recluse: [
      ['bar_gold', 12],
      ['crystal_cut', 8],
      ['hide_tough', 14],
      ['herb_gold', 10],
      ['nothing', 54],
    ],
    ant_soldier: [
      ['ore_copper', 20, 2],
      ['food_jerky', 14, 2],
      ['wheat', 16, 2],
      ['berry_red', 12, 2],
      ['nothing', 46],
    ],
    locust_swarm: [
      ['wheat', 24, 3],
      ['herb_green', 16, 2],
      ['berry_red', 14, 2],
      ['food_pie', 6],
      ['nothing', 44],
    ],
    tick_bloated: [
      ['potion_regret', 8],
      ['food_jelly', 14, 2],
      ['hide_boar', 12],
      ['crystal_raw', 10],
      ['nothing', 56],
    ],
  },
})
