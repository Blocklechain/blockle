/**
 * ===========================================================================
 *  ELEMENTALS MOB PACK — flame / frost / storm / stone / void, plus their
 *  lesser motes. 14 species, each with a 'base' pet and 1-2 rare variants
 *  (36 pet rows total). Tiers 3-4: these are the things living in the harsh
 *  OUTER biomes (volcanic, glacier, crystal, mountain, canyon, tundra,
 *  wastes, ruins) that the enlarged continent uses at high level bands.
 * ===========================================================================
 *
 * Elementals are the universe's way of outsourcing weather to things that
 * hold grudges. The motes are their interns. Nobody is having a good time.
 *
 * Self-contained: imports only TYPES from ../ids / ../types plus
 * registerMobPack (a value) from ./mobpacks — no runtime import of SPECIES.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

// --- Species -----------------------------------------------------------------
// ids are globally unique, lowercase, element-prefixed. Shapes reuse the four
// auto-rigs: blob (motes/oozes), flyer (storm things), biped (humanoid
// elementals), crawler (skittering shards). tier 3 = lesser, tier 4 = greater.
const ELEMENTAL_SPECIES: SpeciesDef[] = [
  // Flame line
  { id: 'mote_cinder', name: 'Cinder Mote', tier: 3, color: 0xff7a1a, shape: 'blob' },
  { id: 'elem_flame', name: 'Flame Elemental', tier: 4, color: 0xff3b1f, shape: 'biped' },
  { id: 'elem_magma', name: 'Magma Lurcher', tier: 4, color: 0xc43a12, shape: 'biped' },
  // Frost line
  { id: 'mote_frost', name: 'Frost Mote', tier: 3, color: 0xa9e4ff, shape: 'blob' },
  { id: 'elem_frost', name: 'Frost Elemental', tier: 4, color: 0x5fb8e9, shape: 'biped' },
  { id: 'elem_glacier', name: 'Glacier Warden', tier: 4, color: 0x7fd4ff, shape: 'biped' },
  // Storm line
  { id: 'mote_spark', name: 'Spark Mote', tier: 3, color: 0xfff27a, shape: 'flyer' },
  { id: 'elem_storm', name: 'Storm Elemental', tier: 4, color: 0x9fb8ff, shape: 'flyer' },
  { id: 'elem_gale', name: 'Gale Shrieker', tier: 4, color: 0xcfe0ff, shape: 'flyer' },
  // Stone line
  { id: 'mote_pebble', name: 'Pebble Mote', tier: 3, color: 0x9a8a72, shape: 'crawler' },
  { id: 'elem_stone', name: 'Stone Elemental', tier: 4, color: 0x7b7266, shape: 'biped' },
  { id: 'elem_crystal', name: 'Crystal Elemental', tier: 4, color: 0x9be8e0, shape: 'crawler' },
  // Void line
  { id: 'mote_void', name: 'Void Mote', tier: 3, color: 0x4b3a6b, shape: 'blob' },
  { id: 'elem_void', name: 'Void Elemental', tier: 4, color: 0x2a1f44, shape: 'biped' },
]

// --- Pets --------------------------------------------------------------------
// Every species: 'base' (Common, ~400). Rares: ember/snow (~1200), golden/
// shadow (~3000). Variant chosen to fit the element (flame->ember, frost->snow,
// everyone can go golden/shadow). Names lean mean-at-life.
const ELEMENTAL_PETS: PetDef[] = [
  // Cinder Mote
  { species: 'mote_cinder', variant: 'base', name: 'Lil Arson', dropOneIn: 400 },
  { species: 'mote_cinder', variant: 'ember', name: 'Ember, Who Peaked Early', dropOneIn: 1200 },
  { species: 'mote_cinder', variant: 'golden', name: 'Gilded Smolder', dropOneIn: 3000 },
  // Flame Elemental
  { species: 'elem_flame', variant: 'base', name: 'Warm Regards', dropOneIn: 400 },
  { species: 'elem_flame', variant: 'ember', name: 'Second-Degree Gary', dropOneIn: 1200 },
  { species: 'elem_flame', variant: 'golden', name: 'The Eternal Flambé', dropOneIn: 3000 },
  // Magma Lurcher
  { species: 'elem_magma', variant: 'base', name: 'Hot Mess', dropOneIn: 400 },
  { species: 'elem_magma', variant: 'ember', name: 'Lava-Lamp Larry', dropOneIn: 1200 },
  { species: 'elem_magma', variant: 'shadow', name: 'Obsidian Grudge', dropOneIn: 3000 },
  // Frost Mote
  { species: 'mote_frost', variant: 'base', name: 'Brain Freeze', dropOneIn: 400 },
  { species: 'mote_frost', variant: 'snow', name: 'Flurry of Disappointment', dropOneIn: 1200 },
  { species: 'mote_frost', variant: 'golden', name: 'Frostea, Gilded', dropOneIn: 3000 },
  // Frost Elemental
  { species: 'elem_frost', variant: 'base', name: 'Cold Shoulder', dropOneIn: 400 },
  { species: 'elem_frost', variant: 'snow', name: 'Emotionally Unavailable Ice', dropOneIn: 1200 },
  { species: 'elem_frost', variant: 'golden', name: 'Winter, But Make It Expensive', dropOneIn: 3000 },
  // Glacier Warden
  { species: 'elem_glacier', variant: 'base', name: 'Slow-Moving Problem', dropOneIn: 400 },
  { species: 'elem_glacier', variant: 'snow', name: 'The Big Chill, Personally', dropOneIn: 1200 },
  { species: 'elem_glacier', variant: 'shadow', name: 'Glacial Pace of Regret', dropOneIn: 3000 },
  // Spark Mote
  { species: 'mote_spark', variant: 'base', name: 'Static Cling', dropOneIn: 400 },
  { species: 'mote_spark', variant: 'ember', name: 'Mild Electrocution', dropOneIn: 1200 },
  { species: 'mote_spark', variant: 'golden', name: 'Gold-Plated Shock', dropOneIn: 3000 },
  // Storm Elemental
  { species: 'elem_storm', variant: 'base', name: 'Minor Weather Event', dropOneIn: 400 },
  { species: 'elem_storm', variant: 'ember', name: 'Thundercloud With Opinions', dropOneIn: 1200 },
  { species: 'elem_storm', variant: 'shadow', name: 'The Forecast Nobody Wanted', dropOneIn: 3000 },
  // Gale Shrieker
  { species: 'elem_gale', variant: 'base', name: 'Loud Breeze', dropOneIn: 400 },
  { species: 'elem_gale', variant: 'snow', name: 'Windchill Karen', dropOneIn: 1200 },
  { species: 'elem_gale', variant: 'golden', name: 'Gale of the Gilded Shriek', dropOneIn: 3000 },
  // Pebble Mote
  { species: 'mote_pebble', variant: 'base', name: 'Kidney Stone', dropOneIn: 400 },
  { species: 'mote_pebble', variant: 'golden', name: 'Nugget, Technically', dropOneIn: 3000 },
  { species: 'mote_pebble', variant: 'shadow', name: 'The Pet Rock That Hates You', dropOneIn: 3000 },
  // Stone Elemental
  { species: 'elem_stone', variant: 'base', name: 'Rocky, No Sequel', dropOneIn: 400 },
  { species: 'elem_stone', variant: 'ember', name: 'Igneous Dave', dropOneIn: 1200 },
  { species: 'elem_stone', variant: 'golden', name: 'Boulder, Dash of Gold', dropOneIn: 3000 },
  // Crystal Elemental
  { species: 'elem_crystal', variant: 'base', name: 'Geode the Terrible', dropOneIn: 400 },
  { species: 'elem_crystal', variant: 'snow', name: 'Clearly Overpriced', dropOneIn: 1200 },
  { species: 'elem_crystal', variant: 'golden', name: 'Facet of Pure Greed', dropOneIn: 3000 },
  // Void Mote
  { species: 'mote_void', variant: 'base', name: 'Existential Dread, Travel Size', dropOneIn: 400 },
  { species: 'mote_void', variant: 'shadow', name: 'The Gap in Your Memory', dropOneIn: 3000 },
  // Void Elemental
  { species: 'elem_void', variant: 'base', name: 'Staring Into It', dropOneIn: 400 },
  { species: 'elem_void', variant: 'shadow', name: 'Oblivion, But Clingy', dropOneIn: 3000 },
]

registerMobPack({
  species: ELEMENTAL_SPECIES,
  pets: ELEMENTAL_PETS,
  // Each species seeded into its thematic harsh biome(s). Motes also leak into
  // a milder adjacent biome so players meet the line before the big version.
  biomeSpawns: {
    volcanic: [
      ['mote_cinder', 6],
      ['elem_flame', 4],
      ['elem_magma', 3],
      ['mote_spark', 2],
    ],
    wastes: [
      ['mote_cinder', 2],
      ['elem_magma', 2],
      ['mote_void', 3],
      ['elem_void', 1],
    ],
    glacier: [
      ['mote_frost', 6],
      ['elem_frost', 4],
      ['elem_glacier', 3],
    ],
    tundra: [
      ['mote_frost', 4],
      ['elem_frost', 2],
      ['mote_spark', 2],
    ],
    mountain: [
      ['mote_pebble', 4],
      ['elem_stone', 2],
      ['mote_spark', 3],
      ['elem_storm', 2],
    ],
    canyon: [
      ['mote_pebble', 3],
      ['elem_stone', 3],
      ['elem_gale', 3],
      ['mote_spark', 2],
    ],
    crystal: [
      ['mote_pebble', 2],
      ['elem_crystal', 5],
      ['elem_glacier', 2],
    ],
    ruins: [
      ['mote_void', 5],
      ['elem_void', 3],
      ['elem_storm', 2],
      ['elem_gale', 2],
    ],
    graveyard: [
      ['mote_void', 4],
      ['elem_void', 2],
    ],
  },
  // One loot table per species. tier 4 pulls richer materials (steel/gold/
  // crystal); tier 3 motes drop lesser stuff. Every table ends on 'nothing'
  // so kills don't rain items. maxQty caps stacky drops.
  loot: {
    // --- Flame line (fire -> ash, ore, charred food) ---
    mote_cinder: [
      ['ore_copper', 20, 2],
      ['herb_red', 14, 2],
      ['food_jerky', 8, 1],
      ['nothing', 58],
    ],
    elem_flame: [
      ['bar_steel', 14, 2],
      ['ore_iron', 16, 3],
      ['crystal_raw', 8, 1],
      ['herb_red', 10, 2],
      ['nothing', 52],
    ],
    elem_magma: [
      ['bar_steel', 12, 2],
      ['ore_gold', 8, 1],
      ['crystal_shard', 6, 1],
      ['clay_lump', 12, 3],
      ['nothing', 62],
    ],
    // --- Frost line (ice -> blue herbs, crystal, cold fish) ---
    mote_frost: [
      ['ore_copper', 18, 2],
      ['herb_blue', 16, 2],
      ['fish_raw', 10, 2],
      ['nothing', 56],
    ],
    elem_frost: [
      ['crystal_raw', 14, 2],
      ['bar_steel', 12, 2],
      ['herb_blue', 12, 2],
      ['fish_salmon', 6, 1],
      ['nothing', 56],
    ],
    elem_glacier: [
      ['crystal_shard', 12, 2],
      ['crystal_cut', 4, 1],
      ['bar_steel', 10, 2],
      ['herb_blue', 10, 2],
      ['nothing', 64],
    ],
    // --- Storm line (lightning -> gold flecks, gold herb, fast rare) ---
    mote_spark: [
      ['ore_iron', 16, 2],
      ['herb_gold', 8, 1],
      ['crystal_raw', 6, 1],
      ['nothing', 70],
    ],
    elem_storm: [
      ['bar_gold', 8, 1],
      ['ore_gold', 12, 2],
      ['crystal_shard', 8, 1],
      ['herb_gold', 8, 1],
      ['nothing', 64],
    ],
    elem_gale: [
      ['bar_steel', 12, 2],
      ['crystal_raw', 10, 2],
      ['herb_gold', 6, 1],
      ['wood_ancient', 8, 1],
      ['nothing', 64],
    ],
    // --- Stone line (earth -> ore, bars, clay) ---
    mote_pebble: [
      ['ore_copper', 22, 3],
      ['clay_lump', 16, 3],
      ['bar_copper', 8, 2],
      ['nothing', 54],
    ],
    elem_stone: [
      ['ore_iron', 18, 3],
      ['bar_iron', 12, 2],
      ['bar_steel', 8, 2],
      ['clay_lump', 12, 3],
      ['nothing', 50],
    ],
    elem_crystal: [
      ['crystal_raw', 16, 3],
      ['crystal_shard', 10, 2],
      ['crystal_cut', 4, 1],
      ['bar_gold', 6, 1],
      ['nothing', 64],
    ],
    // --- Void line (nothing is literally on-theme -> potion_regret) ---
    mote_void: [
      ['crystal_shard', 10, 1],
      ['potion_regret', 6, 1],
      ['nothing', 84],
    ],
    elem_void: [
      ['crystal_cut', 6, 1],
      ['bar_gold', 8, 1],
      ['potion_regret', 8, 1],
      ['ore_gold', 10, 2],
      ['nothing', 68],
    ],
  },
})
