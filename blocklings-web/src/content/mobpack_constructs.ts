/**
 * ===========================================================================
 *  MOB PACK — CONSTRUCTS & AUTOMATONS
 * ===========================================================================
 *
 * The things people built to do their dirty work, then abandoned when the
 * funding ran out. Crystal sentinels still guarding doors to rooms that
 * collapsed centuries ago. Iron wardens patrolling a wall that isn't there.
 * Clockwork knights sworn to a king who is extremely dead. They don't hate
 * you. They just never got the memo that the job ended, and you walked into
 * the part of the map where the job is "kill whatever moves."
 *
 * 15 species, tiers 3-4, pushed into the harsh outer biomes (crystal, ruins,
 * mountain, city, volcanic, glacier, graveyard, canyon, tundra, wastes) so
 * the enlarged continent's high-level rings are where you'll actually meet
 * them. Each species ships a 'base' pet plus 1-2 rare variants, a biome
 * spawn entry, and a loot table that mostly drops scrap and regret.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

const SPECIES: SpeciesDef[] = [
  // Tier 3 — the rank-and-file maintenance staff of the apocalypse.
  { id: 'crystal_sentinel', name: 'Crystal Sentinel', tier: 3, color: 0x7fd4ff, shape: 'biped' },
  { id: 'iron_warden', name: 'Iron Warden', tier: 3, color: 0x6f7378, shape: 'biped' },
  { id: 'shard_crawler', name: 'Shard Crawler', tier: 3, color: 0x9ad8ff, shape: 'crawler' },
  { id: 'gearhound', name: 'Gearhound', tier: 3, color: 0xb0863a, shape: 'quadruped' },
  { id: 'brass_sentry', name: 'Brass Sentry', tier: 3, color: 0xc9a227, shape: 'biped' },
  { id: 'mirror_golem', name: 'Mirror Golem', tier: 3, color: 0xcfe8f2, shape: 'blob' },
  { id: 'cog_sprite', name: 'Cog Sprite', tier: 3, color: 0xd9b24a, shape: 'flyer' },
  { id: 'prism_drone', name: 'Prism Drone', tier: 3, color: 0xa6e3ff, shape: 'flyer' },
  // Tier 4 — the ones with a budget. You are the budget cut.
  { id: 'clockwork_knight', name: 'Clockwork Knight', tier: 4, color: 0x8c7b52, shape: 'biped' },
  { id: 'siege_golem', name: 'Siege Golem', tier: 4, color: 0x5a5e66, shape: 'biped' },
  { id: 'rune_colossus', name: 'Rune Colossus', tier: 4, color: 0x6c5ce0, shape: 'biped' },
  { id: 'obsidian_automaton', name: 'Obsidian Automaton', tier: 4, color: 0x2a2730, shape: 'biped' },
  { id: 'bastion_walker', name: 'Bastion Walker', tier: 4, color: 0x7d6b55, shape: 'quadruped' },
  { id: 'glacier_warden', name: 'Glacier Warden', tier: 4, color: 0xbfeaff, shape: 'biped' },
  { id: 'aegis_titan', name: 'Aegis Titan', tier: 4, color: 0x9aa0a8, shape: 'biped' },
]

const PETS: PetDef[] = [
  // crystal_sentinel
  { species: 'crystal_sentinel', variant: 'base', name: 'Sir Shinesalot', dropOneIn: 400 },
  { species: 'crystal_sentinel', variant: 'snow', name: 'Frostfacet, Doorman Emeritus', dropOneIn: 1200 },
  { species: 'crystal_sentinel', variant: 'golden', name: 'The Load-Bearing Gemstone', dropOneIn: 3000 },
  // iron_warden
  { species: 'iron_warden', variant: 'base', name: 'Rusty McPatrol', dropOneIn: 400 },
  { species: 'iron_warden', variant: 'ember', name: 'Warden Who Runs Hot', dropOneIn: 1200 },
  // shard_crawler
  { species: 'shard_crawler', variant: 'base', name: 'Skittersworn', dropOneIn: 400 },
  { species: 'shard_crawler', variant: 'snow', name: 'Little Mister Stabby-Glass', dropOneIn: 1200 },
  // gearhound
  { species: 'gearhound', variant: 'base', name: 'Clank, Good Boy', dropOneIn: 400 },
  { species: 'gearhound', variant: 'ember', name: 'Overheating Rover', dropOneIn: 1200 },
  { species: 'gearhound', variant: 'golden', name: 'Fetch, The Prototype', dropOneIn: 3000 },
  // brass_sentry
  { species: 'brass_sentry', variant: 'base', name: 'Beep-Boop the Vigilant', dropOneIn: 400 },
  { species: 'brass_sentry', variant: 'golden', name: 'Employee of the Millennium', dropOneIn: 3000 },
  // mirror_golem
  { species: 'mirror_golem', variant: 'base', name: 'Reflecto, Hates You Back', dropOneIn: 400 },
  { species: 'mirror_golem', variant: 'shadow', name: 'Your Reflection, But Worse', dropOneIn: 3000 },
  // cog_sprite
  { species: 'cog_sprite', variant: 'base', name: 'Tiny Ticking Problem', dropOneIn: 400 },
  { species: 'cog_sprite', variant: 'snow', name: 'Wind-Up Winter', dropOneIn: 1200 },
  // prism_drone
  { species: 'prism_drone', variant: 'base', name: 'Drone Strike (Rainbow)', dropOneIn: 400 },
  { species: 'prism_drone', variant: 'golden', name: 'Chromatic Disappointment', dropOneIn: 3000 },
  // clockwork_knight
  { species: 'clockwork_knight', variant: 'base', name: 'Sir Winds-A-Lot', dropOneIn: 400 },
  { species: 'clockwork_knight', variant: 'ember', name: 'The Knight That Grinds Gears', dropOneIn: 1200 },
  { species: 'clockwork_knight', variant: 'shadow', name: 'His Majesty Forgot About Me', dropOneIn: 3000 },
  // siege_golem
  { species: 'siege_golem', variant: 'base', name: 'Big Stompy', dropOneIn: 400 },
  { species: 'siege_golem', variant: 'ember', name: 'The Wall-Was-Already-Down Golem', dropOneIn: 1200 },
  // rune_colossus
  { species: 'rune_colossus', variant: 'base', name: 'Glyphius Maximus', dropOneIn: 400 },
  { species: 'rune_colossus', variant: 'shadow', name: 'The Typo That Became Sentient', dropOneIn: 3000 },
  // obsidian_automaton
  { species: 'obsidian_automaton', variant: 'base', name: 'Matte Finish', dropOneIn: 400 },
  { species: 'obsidian_automaton', variant: 'ember', name: 'Still Lava-Warm, Weirdly', dropOneIn: 1200 },
  { species: 'obsidian_automaton', variant: 'golden', name: 'Factory Second', dropOneIn: 3000 },
  // bastion_walker
  { species: 'bastion_walker', variant: 'base', name: 'Mobile Wall, No Legs Named', dropOneIn: 400 },
  { species: 'bastion_walker', variant: 'snow', name: 'Fortress With Frostbite', dropOneIn: 1200 },
  // glacier_warden
  { species: 'glacier_warden', variant: 'base', name: 'Chilly McGuardface', dropOneIn: 400 },
  { species: 'glacier_warden', variant: 'snow', name: 'Absolute Zero Tolerance', dropOneIn: 1200 },
  { species: 'glacier_warden', variant: 'golden', name: 'The Ice Age HR Rep', dropOneIn: 3000 },
  // aegis_titan
  { species: 'aegis_titan', variant: 'base', name: 'Shieldy the Unemployed', dropOneIn: 400 },
  { species: 'aegis_titan', variant: 'shadow', name: 'Last Line of a Dead Defense', dropOneIn: 3000 },
]

registerMobPack({
  species: SPECIES,
  pets: PETS,
  biomeSpawns: {
    crystal: [
      ['crystal_sentinel', 10],
      ['shard_crawler', 8],
      ['mirror_golem', 6],
      ['prism_drone', 7],
      ['rune_colossus', 4],
    ],
    ruins: [
      ['iron_warden', 9],
      ['clockwork_knight', 6],
      ['siege_golem', 5],
      ['cog_sprite', 7],
      ['aegis_titan', 4],
      ['rune_colossus', 3],
    ],
    mountain: [
      ['iron_warden', 8],
      ['gearhound', 6],
      ['bastion_walker', 4],
    ],
    city: [
      ['brass_sentry', 10],
      ['gearhound', 8],
      ['cog_sprite', 6],
      ['clockwork_knight', 5],
    ],
    volcanic: [
      ['obsidian_automaton', 10],
      ['siege_golem', 5],
    ],
    wastes: [
      ['bastion_walker', 8],
      ['siege_golem', 6],
      ['iron_warden', 5],
    ],
    canyon: [
      ['bastion_walker', 9],
      ['gearhound', 5],
    ],
    glacier: [
      ['glacier_warden', 10],
      ['crystal_sentinel', 5],
    ],
    tundra: [
      ['glacier_warden', 8],
      ['shard_crawler', 4],
    ],
    graveyard: [
      ['aegis_titan', 9],
      ['clockwork_knight', 5],
      ['siege_golem', 4],
    ],
  },
  loot: {
    // Tier 3 — iron, steel, raw crystal, the occasional shard.
    crystal_sentinel: [
      ['crystal_raw', 32, 3],
      ['crystal_shard', 18, 2],
      ['bar_iron', 14, 2],
      ['crystal_cut', 5],
      ['nothing', 40],
    ],
    iron_warden: [
      ['ore_iron', 30, 3],
      ['bar_iron', 20, 2],
      ['bar_steel', 10],
      ['hide_tough', 8],
      ['nothing', 42],
    ],
    shard_crawler: [
      ['crystal_raw', 28, 2],
      ['crystal_shard', 16, 2],
      ['ore_copper', 12, 3],
      ['nothing', 48],
    ],
    gearhound: [
      ['bar_copper', 24, 3],
      ['bar_iron', 16, 2],
      ['ore_iron', 14, 3],
      ['food_jerky', 6, 2],
      ['nothing', 44],
    ],
    brass_sentry: [
      ['bar_copper', 26, 3],
      ['ore_gold', 12, 2],
      ['bar_iron', 12, 2],
      ['crystal_shard', 6],
      ['nothing', 46],
    ],
    mirror_golem: [
      ['crystal_shard', 24, 2],
      ['crystal_raw', 18, 2],
      ['crystal_cut', 6],
      ['potion_regret', 4],
      ['nothing', 48],
    ],
    cog_sprite: [
      ['bar_copper', 22, 3],
      ['ore_copper', 18, 3],
      ['bar_iron', 10, 2],
      ['nothing', 52],
    ],
    prism_drone: [
      ['crystal_raw', 26, 2],
      ['crystal_shard', 15, 2],
      ['crystal_cut', 5],
      ['herb_blue', 8],
      ['nothing', 48],
    ],
    // Tier 4 — steel, gold, cut crystal; richer, but they hit back.
    clockwork_knight: [
      ['bar_steel', 24, 2],
      ['bar_gold', 12, 2],
      ['crystal_cut', 10],
      ['ore_gold', 14, 2],
      ['nothing', 40],
    ],
    siege_golem: [
      ['bar_steel', 26, 3],
      ['bar_iron', 18, 3],
      ['ore_iron', 16, 3],
      ['crystal_raw', 8, 2],
      ['nothing', 42],
    ],
    rune_colossus: [
      ['crystal_cut', 20, 2],
      ['crystal_shard', 18, 2],
      ['bar_gold', 12, 2],
      ['potion_regret', 6],
      ['nothing', 44],
    ],
    obsidian_automaton: [
      ['bar_steel', 24, 2],
      ['bar_gold', 14, 2],
      ['crystal_cut', 10],
      ['crystal_raw', 10, 2],
      ['nothing', 42],
    ],
    bastion_walker: [
      ['bar_steel', 26, 3],
      ['bar_iron', 18, 3],
      ['hide_tough', 12, 2],
      ['ore_gold', 10, 2],
      ['nothing', 44],
    ],
    glacier_warden: [
      ['crystal_cut', 20, 2],
      ['crystal_raw', 18, 3],
      ['bar_steel', 14, 2],
      ['bar_gold', 8],
      ['nothing', 44],
    ],
    aegis_titan: [
      ['bar_gold', 18, 2],
      ['bar_steel', 18, 2],
      ['crystal_cut', 12, 2],
      ['ore_gold', 14, 2],
      ['nothing', 42],
    ],
  },
})
