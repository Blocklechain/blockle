/**
 * ===========================================================================
 *  AQUATIC MOB PACK — "The Tide Hates You Too"
 *  Coastal & deep-water horrors: reef crabs, sea-serpents, anglers,
 *  krakenlings and tide-wraiths. 14 new species, tiers 2-3, each with a
 *  base pet plus one or two rare variants, biome spawns and a loot table.
 * ===========================================================================
 *
 * Self-contained: imports only TYPES from ../ids / ../types plus the runtime
 * registrar. Wired in later by appending one import line to mobpacks_all.ts.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

/* --------------------------------------------------------------------------
 * SPECIES — 14 themed critters. Shapes reuse the voxel rigs (no mesh code).
 * Tier 2 shore-dwellers; tier 3 deep/harsh-biome nightmares.
 * ------------------------------------------------------------------------ */
const AQUATIC_SPECIES: SpeciesDef[] = [
  // --- Tier 2: shallows, lagoon, beach, swamp ---
  { id: 'reefcrab', name: 'Reef Crab', tier: 2, color: 0xe2714f, shape: 'crawler' },
  { id: 'tidehopper', name: 'Tide Hopper', tier: 2, color: 0x4fb3a0, shape: 'blob' },
  { id: 'bogleech', name: 'Bog Leech', tier: 2, color: 0x5c6b3d, shape: 'crawler' },
  { id: 'mudskip', name: 'Sulking Mudskip', tier: 2, color: 0x8a7b4a, shape: 'quadruped' },
  { id: 'brinebat', name: 'Brine Bat', tier: 2, color: 0x4a6b7a, shape: 'flyer' },
  { id: 'pufferpup', name: 'Puffer Pup', tier: 2, color: 0xe6c84f, shape: 'blob' },
  { id: 'sandwraith', name: 'Sand Wraith', tier: 2, color: 0xd9c9a3, shape: 'biped' },
  // --- Tier 3: deep, glacier, canyon, ruins, graveyard ---
  { id: 'seaserpent', name: 'Sea Serpent', tier: 3, color: 0x2e7d8a, shape: 'crawler' },
  { id: 'anglerfiend', name: 'Angler Fiend', tier: 3, color: 0x3a2d4a, shape: 'biped' },
  { id: 'krakenling', name: 'Krakenling', tier: 3, color: 0x6b3d7a, shape: 'crawler' },
  { id: 'tidewraith', name: 'Tide Wraith', tier: 3, color: 0x5fb8d4, shape: 'biped' },
  { id: 'coralgolem', name: 'Coral Golem', tier: 3, color: 0xd96f8c, shape: 'biped' },
  { id: 'frostfin', name: 'Frostfin Lurker', tier: 3, color: 0xa6d8e6, shape: 'quadruped' },
  { id: 'drownedman', name: 'The Drowned', tier: 3, color: 0x3d5a6b, shape: 'biped' },
]

/* --------------------------------------------------------------------------
 * PETS — every species gets a 'base' (Common) plus 1-2 rares.
 * base ~400, ember/snow ~1200 (Rare), golden/shadow ~3000 (Epic).
 * Names lean into the game's mean-at-life comedy.
 * ------------------------------------------------------------------------ */
const AQUATIC_PETS: PetDef[] = [
  // reefcrab
  { species: 'reefcrab', variant: 'base', name: 'Side-Steve', dropOneIn: 400 },
  { species: 'reefcrab', variant: 'ember', name: 'Boiled Already', dropOneIn: 1200 },
  { species: 'reefcrab', variant: 'golden', name: 'The Market Price', dropOneIn: 3000 },
  // tidehopper
  { species: 'tidehopper', variant: 'base', name: 'Splashley', dropOneIn: 400 },
  { species: 'tidehopper', variant: 'snow', name: 'Chilly Puddle', dropOneIn: 1200 },
  // bogleech
  { species: 'bogleech', variant: 'base', name: 'Clingy Greg', dropOneIn: 400 },
  { species: 'bogleech', variant: 'shadow', name: 'Emotional Baggage', dropOneIn: 3000 },
  // mudskip
  { species: 'mudskip', variant: 'base', name: 'Mopey', dropOneIn: 400 },
  { species: 'mudskip', variant: 'ember', name: 'Sun-Dried Dreams', dropOneIn: 1200 },
  // brinebat
  { species: 'brinebat', variant: 'base', name: 'Saltbag', dropOneIn: 400 },
  { species: 'brinebat', variant: 'snow', name: 'Freezer Burn', dropOneIn: 1200 },
  { species: 'brinebat', variant: 'golden', name: 'Rich Wet Idiot', dropOneIn: 3000 },
  // pufferpup
  { species: 'pufferpup', variant: 'base', name: 'Mild Threat', dropOneIn: 400 },
  { species: 'pufferpup', variant: 'golden', name: 'Overinflated Ego', dropOneIn: 3000 },
  // sandwraith
  { species: 'sandwraith', variant: 'base', name: 'Beach Haunt Barry', dropOneIn: 400 },
  { species: 'sandwraith', variant: 'shadow', name: 'In The Sunscreen', dropOneIn: 3000 },
  // seaserpent
  { species: 'seaserpent', variant: 'base', name: 'Noodle of Dread', dropOneIn: 400 },
  { species: 'seaserpent', variant: 'ember', name: 'Boiled Noodle', dropOneIn: 1200 },
  { species: 'seaserpent', variant: 'golden', name: 'Loch Ness Flex', dropOneIn: 3000 },
  // anglerfiend
  { species: 'anglerfiend', variant: 'base', name: 'Little Lamp Liar', dropOneIn: 400 },
  { species: 'anglerfiend', variant: 'shadow', name: 'Deadlights', dropOneIn: 3000 },
  // krakenling
  { species: 'krakenling', variant: 'base', name: 'Seven Clingy Arms', dropOneIn: 400 },
  { species: 'krakenling', variant: 'ember', name: 'Calamari Incident', dropOneIn: 1200 },
  { species: 'krakenling', variant: 'shadow', name: 'Release The', dropOneIn: 3000 },
  // tidewraith
  { species: 'tidewraith', variant: 'base', name: 'Damp Regret', dropOneIn: 400 },
  { species: 'tidewraith', variant: 'snow', name: 'Hypothermia', dropOneIn: 1200 },
  { species: 'tidewraith', variant: 'golden', name: 'Undertow Gold', dropOneIn: 3000 },
  // coralgolem
  { species: 'coralgolem', variant: 'base', name: 'Pretty Rubble', dropOneIn: 400 },
  { species: 'coralgolem', variant: 'golden', name: 'Reef Timeshare', dropOneIn: 3000 },
  // frostfin
  { species: 'frostfin', variant: 'base', name: 'Cold Shoulder', dropOneIn: 400 },
  { species: 'frostfin', variant: 'snow', name: 'Brain Freeze', dropOneIn: 1200 },
  // drownedman
  { species: 'drownedman', variant: 'base', name: 'Still Bloated', dropOneIn: 400 },
  { species: 'drownedman', variant: 'ember', name: 'Cremation Backfire', dropOneIn: 1200 },
  { species: 'drownedman', variant: 'shadow', name: 'Davy Jones Jr.', dropOneIn: 3000 },
]

/* --------------------------------------------------------------------------
 * BIOME SPAWNS — shore species in warm/wet coastal biomes, deep-water
 * nightmares pushed into the harsh OUTER biomes so they surface at high
 * level bands out on the enlarged continent.
 * ------------------------------------------------------------------------ */
const AQUATIC_BIOME_SPAWNS: Record<string, [string, number][]> = {
  beach: [
    ['reefcrab', 10],
    ['tidehopper', 8],
    ['pufferpup', 6],
    ['sandwraith', 4],
    ['seaserpent', 2],
  ],
  lagoon: [
    ['tidehopper', 9],
    ['reefcrab', 6],
    ['brinebat', 7],
    ['coralgolem', 4],
    ['krakenling', 3],
    ['tidewraith', 2],
  ],
  swamp: [
    ['bogleech', 10],
    ['mudskip', 9],
    ['brinebat', 5],
    ['drownedman', 3],
  ],
  tundra: [
    ['frostfin', 8],
    ['tidewraith', 5],
    ['brinebat', 3],
  ],
  glacier: [
    ['frostfin', 9],
    ['tidewraith', 6],
    ['seaserpent', 3],
  ],
  canyon: [
    ['seaserpent', 6],
    ['anglerfiend', 7],
    ['krakenling', 4],
  ],
  ruins: [
    ['coralgolem', 6],
    ['drownedman', 7],
    ['anglerfiend', 4],
  ],
  graveyard: [
    ['drownedman', 9],
    ['tidewraith', 5],
    ['anglerfiend', 3],
  ],
  wastes: [
    ['sandwraith', 7],
    ['anglerfiend', 4],
    ['krakenling', 3],
  ],
}

/* --------------------------------------------------------------------------
 * LOOT — tier drives material richness. Every table includes a 'nothing' row
 * so kills don't rain items. Items referenced are all real base items.
 * ------------------------------------------------------------------------ */
const AQUATIC_LOOT: Record<string, [string, number, number?][]> = {
  // --- Tier 2 (copper/iron, fish, hides, herbs) ---
  reefcrab: [
    ['fish_raw', 30, 3],
    ['ore_copper', 20, 2],
    ['clay_lump', 15, 2],
    ['bar_copper', 6],
    ['nothing', 40],
  ],
  tidehopper: [
    ['fish_raw', 28, 2],
    ['herb_blue', 18, 2],
    ['food_jelly', 12, 2],
    ['clay_lump', 10, 2],
    ['nothing', 45],
  ],
  bogleech: [
    ['herb_green', 22, 3],
    ['herb_red', 14, 2],
    ['potion_regret', 4],
    ['hide_tough', 8],
    ['nothing', 50],
  ],
  mudskip: [
    ['fish_raw', 26, 2],
    ['clay_lump', 18, 3],
    ['hide_boar', 12, 2],
    ['food_jerky', 8, 2],
    ['nothing', 46],
  ],
  brinebat: [
    ['hide_wolf', 18, 2],
    ['ore_iron', 16, 2],
    ['fish_raw', 14, 2],
    ['herb_blue', 10],
    ['nothing', 48],
  ],
  pufferpup: [
    ['fish_trout', 24, 2],
    ['potion_regret', 6],
    ['food_jelly', 14, 2],
    ['herb_gold', 4],
    ['nothing', 48],
  ],
  sandwraith: [
    ['ore_iron', 20, 2],
    ['bar_iron', 8],
    ['crystal_raw', 10],
    ['hide_tough', 12, 2],
    ['nothing', 46],
  ],
  // --- Tier 3 (iron/steel/gold, crystal, fine fish, cake) ---
  seaserpent: [
    ['fish_salmon', 24, 3],
    ['bar_steel', 14, 2],
    ['hide_tough', 16, 2],
    ['crystal_shard', 8],
    ['nothing', 42],
  ],
  anglerfiend: [
    ['crystal_shard', 18, 2],
    ['crystal_cut', 5],
    ['bar_steel', 12, 2],
    ['fish_salmon', 14, 2],
    ['nothing', 44],
  ],
  krakenling: [
    ['fish_salmon', 20, 3],
    ['bar_steel', 14, 2],
    ['crystal_raw', 14, 2],
    ['bar_gold', 5],
    ['nothing', 44],
  ],
  tidewraith: [
    ['crystal_shard', 16, 2],
    ['crystal_cut', 6],
    ['ore_gold', 12, 2],
    ['potion_regret', 8],
    ['nothing', 46],
  ],
  coralgolem: [
    ['crystal_raw', 22, 3],
    ['crystal_cut', 8],
    ['bar_gold', 7],
    ['clay_lump', 16, 3],
    ['nothing', 42],
  ],
  frostfin: [
    ['fish_salmon', 22, 2],
    ['crystal_shard', 14, 2],
    ['bar_steel', 12, 2],
    ['hide_tough', 14, 2],
    ['nothing', 44],
  ],
  drownedman: [
    ['bar_steel', 16, 2],
    ['bar_gold', 8],
    ['crystal_cut', 6],
    ['food_cake', 6],
    ['potion_regret', 10],
    ['nothing', 44],
  ],
}

registerMobPack({
  species: AQUATIC_SPECIES,
  pets: AQUATIC_PETS,
  biomeSpawns: AQUATIC_BIOME_SPAWNS,
  loot: AQUATIC_LOOT,
})
