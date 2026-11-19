/**
 * ===========================================================================
 *  UNDEAD HORRORS MOB PACK — the stuff that shambles out when the sun gives up.
 * ===========================================================================
 *
 * 14 themed species (tiers 2-4) for the rotting edges of the map: ghouls,
 * wraiths, revenants, bone-knights, a lich, and assorted crawling regret.
 * Each gets a 'base' pet plus 1-2 rare variants (ember/snow = Rare,
 * golden/shadow = Epic), biome spawns across the grim biomes, and a loot
 * table that mostly pays out in 'nothing' — because the dead keep their stuff.
 *
 * Registered at import time via registerMobPack; meshes auto-generate from
 * each species' `shape`. Imports are TYPE-ONLY from ../ids / ../types (no
 * runtime value from ids) per the no-cycle rule in mobpacks.ts.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

// ---------------------------------------------------------------------------
// SPECIES — 14 undead, tiers 2-4. Colors trend bone-white, grave-grey, sick
// green and spectral blue. Shapes reuse the base voxel rigs.
// ---------------------------------------------------------------------------
const UNDEAD_SPECIES: SpeciesDef[] = [
  // --- Tier 2: the rank-and-file dead you trip over in any boneyard ---
  { id: 'ghoul_grave',    name: 'Graveyard Ghoul',   tier: 2, color: 0x8a9b6e, shape: 'biped' },
  { id: 'gravecrawler',   name: 'Grave Maggot',      tier: 2, color: 0xd9cbb2, shape: 'crawler' },
  { id: 'deathmoth_pale', name: "Death's-Head Moth", tier: 2, color: 0x6b6676, shape: 'flyer' },
  { id: 'plague_rat',     name: 'Plague Rat',        tier: 2, color: 0x5c5247, shape: 'crawler' },
  { id: 'corpse_imp',     name: 'Corpse Imp',        tier: 2, color: 0x7d8a4f, shape: 'biped' },
  { id: 'ash_spectre',    name: 'Ashen Spectre',     tier: 2, color: 0x9aa7b0, shape: 'flyer' },

  // --- Tier 3: the dead that remember how to hold a grudge (and a blade) ---
  { id: 'wraith_pale',    name: 'Pale Wraith',       tier: 3, color: 0xb6c9d6, shape: 'flyer' },
  { id: 'revenant_rust',  name: 'Rusted Revenant',   tier: 3, color: 0x8a5a3c, shape: 'biped' },
  { id: 'gloomhound',     name: 'Gloomhound',        tier: 3, color: 0x4a4752, shape: 'quadruped' },
  { id: 'barrow_wight',   name: 'Barrow Wight',      tier: 3, color: 0xc9c2a8, shape: 'biped' },
  { id: 'crypt_widow',    name: 'Crypt Widow',       tier: 3, color: 0x2e2a35, shape: 'crawler' },

  // --- Tier 4: the ones the signposts warned you about. You didn't listen ---
  { id: 'boneknight_cursed', name: 'Cursed Bone-Knight', tier: 4, color: 0xe3ddcc, shape: 'biped' },
  { id: 'lich_frost',        name: 'Frostbound Lich',    tier: 4, color: 0x6fb4c4, shape: 'biped' },
  { id: 'tomb_colossus',     name: 'Tomb Colossus',      tier: 4, color: 0x7a7468, shape: 'biped' },
]

// ---------------------------------------------------------------------------
// PETS — every species has a 'base' (Common) plus 1-2 rares. Rarer => higher
// dropOneIn. Names are, as per house style, mean to the thing being adopted.
// ---------------------------------------------------------------------------
const UNDEAD_PETS: PetDef[] = [
  // ghoul_grave
  { species: 'ghoul_grave',    variant: 'base',   name: 'Nibbles the Ghoul',      dropOneIn: 400 },
  { species: 'ghoul_grave',    variant: 'ember',  name: 'Smoulderin\' Stan',      dropOneIn: 1200 },
  { species: 'ghoul_grave',    variant: 'golden', name: 'Lord of the Leftovers',  dropOneIn: 3000 },

  // gravecrawler
  { species: 'gravecrawler',   variant: 'base',   name: 'Squirmothy',             dropOneIn: 400 },
  { species: 'gravecrawler',   variant: 'snow',   name: 'Frostbite the Grub',     dropOneIn: 1200 },

  // deathmoth_pale
  { species: 'deathmoth_pale', variant: 'base',   name: 'Doomflap',               dropOneIn: 400 },
  { species: 'deathmoth_pale', variant: 'snow',   name: 'Winter Dustbag',         dropOneIn: 1200 },
  { species: 'deathmoth_pale', variant: 'golden', name: 'His Majesty, The Lamp',  dropOneIn: 3000 },

  // plague_rat
  { species: 'plague_rat',     variant: 'base',   name: 'Patient Zero',           dropOneIn: 400 },
  { species: 'plague_rat',     variant: 'shadow', name: 'Lil Pandemic',           dropOneIn: 3000 },

  // corpse_imp
  { species: 'corpse_imp',     variant: 'base',   name: 'Giblet',                 dropOneIn: 400 },
  { species: 'corpse_imp',     variant: 'ember',  name: 'Toasted Giblet',         dropOneIn: 1200 },

  // ash_spectre
  { species: 'ash_spectre',    variant: 'base',   name: 'Whispy McRegret',        dropOneIn: 400 },
  { species: 'ash_spectre',    variant: 'shadow', name: 'The Full Haunting',      dropOneIn: 3000 },

  // wraith_pale
  { species: 'wraith_pale',    variant: 'base',   name: 'Moan-a Lisa',            dropOneIn: 400 },
  { species: 'wraith_pale',    variant: 'snow',   name: 'Chilly Wails',           dropOneIn: 1200 },
  { species: 'wraith_pale',    variant: 'shadow', name: 'Existential Dread Jr.',  dropOneIn: 3000 },

  // revenant_rust
  { species: 'revenant_rust',  variant: 'base',   name: 'Grudgy',                 dropOneIn: 400 },
  { species: 'revenant_rust',  variant: 'ember',  name: 'Still Mad, Now Warm',    dropOneIn: 1200 },

  // gloomhound
  { species: 'gloomhound',     variant: 'base',   name: 'Good Boy (Deceased)',    dropOneIn: 400 },
  { species: 'gloomhound',     variant: 'shadow', name: 'Who\'s a Void Boy',      dropOneIn: 3000 },

  // barrow_wight
  { species: 'barrow_wight',   variant: 'base',   name: 'Gary the Grave-Squatter',dropOneIn: 400 },
  { species: 'barrow_wight',   variant: 'golden', name: 'The Gilded Freeloader',  dropOneIn: 3000 },

  // crypt_widow
  { species: 'crypt_widow',    variant: 'base',   name: 'Eight-Legged Alimony',   dropOneIn: 400 },
  { species: 'crypt_widow',    variant: 'shadow', name: 'Till Death (Still Mad)',  dropOneIn: 3000 },
  { species: 'crypt_widow',    variant: 'golden', name: 'Gold-Digger Deluxe',     dropOneIn: 3000 },

  // boneknight_cursed
  { species: 'boneknight_cursed', variant: 'base',   name: 'Sir Loin-of-Dust',     dropOneIn: 400 },
  { species: 'boneknight_cursed', variant: 'golden', name: 'Ser Shiny Regret',     dropOneIn: 3000 },
  { species: 'boneknight_cursed', variant: 'shadow', name: 'The Oathbreaker Pup',  dropOneIn: 3000 },

  // lich_frost
  { species: 'lich_frost',     variant: 'base',   name: 'Phil Actory',            dropOneIn: 400 },
  { species: 'lich_frost',     variant: 'snow',   name: 'Brain Freeze',           dropOneIn: 1200 },
  { species: 'lich_frost',     variant: 'shadow', name: 'Darkest Timeline Phil',  dropOneIn: 3000 },

  // tomb_colossus
  { species: 'tomb_colossus',  variant: 'base',   name: 'Pebbles (He\'s Huge)',   dropOneIn: 400 },
  { species: 'tomb_colossus',  variant: 'golden', name: 'The Mausoleum With Legs',dropOneIn: 3000 },
  { species: 'tomb_colossus',  variant: 'shadow', name: 'Big Sad Rockfella',      dropOneIn: 3000 },
]

// ---------------------------------------------------------------------------
// SPAWNS — grim biomes only. Tier-4 horrors go to the harsh outer biomes
// (glacier/tundra/crystal/canyon/ruins) so they surface in the far level bands.
// ---------------------------------------------------------------------------
const UNDEAD_BIOME_SPAWNS: Record<string, [string, number][]> = {
  graveyard: [
    ['ghoul_grave', 10],
    ['gravecrawler', 8],
    ['deathmoth_pale', 6],
    ['barrow_wight', 5],
    ['boneknight_cursed', 2],
  ],
  ruins: [
    ['ghoul_grave', 5],
    ['wraith_pale', 7],
    ['crypt_widow', 5],
    ['boneknight_cursed', 4],
    ['tomb_colossus', 2],
  ],
  dungeon: [
    ['plague_rat', 9],
    ['corpse_imp', 7],
    ['revenant_rust', 5],
    ['crypt_widow', 4],
  ],
  wastes: [
    ['ash_spectre', 8],
    ['gloomhound', 6],
    ['revenant_rust', 5],
  ],
  swamp: [
    ['gravecrawler', 6],
    ['deathmoth_pale', 5],
  ],
  canyon: [
    ['gloomhound', 5],
    ['tomb_colossus', 3],
  ],
  tundra: [
    ['ash_spectre', 5],
    ['lich_frost', 3],
  ],
  glacier: [
    ['lich_frost', 5],
  ],
  crystal: [
    ['lich_frost', 2],
  ],
}

// ---------------------------------------------------------------------------
// LOOT — tier drives material richness (t2 copper/iron, t3 iron/steel/crystal
// shards, t4 gold/crystal). Every table carries a 'nothing' row so a kill
// usually gives you the great gift of nothing.
// ---------------------------------------------------------------------------
const UNDEAD_LOOT: Record<string, [string, number, number?][]> = {
  // --- Tier 2 ---
  ghoul_grave: [
    ['hide_tough', 20, 2],
    ['food_jerky', 14, 2],
    ['bar_copper', 10, 1],
    ['herb_green', 10, 2],
    ['potion_regret', 2, 1],
    ['nothing', 44],
  ],
  gravecrawler: [
    ['herb_green', 18, 3],
    ['clay_lump', 16, 2],
    ['mushroom_brown', 12, 2],
    ['ore_copper', 8, 1],
    ['nothing', 46],
  ],
  deathmoth_pale: [
    ['herb_blue', 16, 2],
    ['hide_wolf', 12, 2],
    ['food_honey', 8, 1],
    ['ore_iron', 6, 1],
    ['nothing', 48],
  ],
  plague_rat: [
    ['hide_wolf', 16, 2],
    ['herb_red', 12, 2],
    ['bar_copper', 9, 1],
    ['potion_regret', 3, 1],
    ['nothing', 50],
  ],
  corpse_imp: [
    ['ore_iron', 16, 2],
    ['bar_copper', 12, 1],
    ['herb_red', 10, 2],
    ['crystal_raw', 4, 1],
    ['nothing', 48],
  ],
  ash_spectre: [
    ['crystal_raw', 12, 1],
    ['herb_blue', 14, 2],
    ['bar_iron', 8, 1],
    ['potion_regret', 2, 1],
    ['nothing', 52],
  ],

  // --- Tier 3 ---
  wraith_pale: [
    ['crystal_shard', 14, 2],
    ['bar_iron', 12, 1],
    ['herb_blue', 10, 2],
    ['crystal_cut', 3, 1],
    ['potion_regret', 3, 1],
    ['nothing', 48],
  ],
  revenant_rust: [
    ['bar_iron', 18, 2],
    ['bar_steel', 10, 1],
    ['ore_iron', 12, 2],
    ['hide_tough', 8, 1],
    ['nothing', 44],
  ],
  gloomhound: [
    ['hide_tough', 20, 2],
    ['bar_iron', 10, 1],
    ['food_jerky', 10, 2],
    ['crystal_shard', 5, 1],
    ['nothing', 46],
  ],
  barrow_wight: [
    ['bar_steel', 12, 1],
    ['crystal_shard', 12, 2],
    ['bar_gold', 6, 1],
    ['herb_gold', 6, 1],
    ['potion_regret', 4, 1],
    ['nothing', 48],
  ],
  crypt_widow: [
    ['crystal_shard', 14, 2],
    ['hide_tough', 12, 2],
    ['bar_steel', 9, 1],
    ['herb_red', 8, 2],
    ['nothing', 48],
  ],

  // --- Tier 4 ---
  boneknight_cursed: [
    ['bar_steel', 16, 2],
    ['bar_gold', 10, 1],
    ['crystal_cut', 8, 1],
    ['crystal_shard', 10, 2],
    ['herb_gold', 5, 1],
    ['potion_regret', 4, 1],
    ['nothing', 42],
  ],
  lich_frost: [
    ['crystal_cut', 12, 1],
    ['bar_gold', 12, 1],
    ['crystal_shard', 12, 2],
    ['herb_gold', 8, 2],
    ['potion_regret', 6, 1],
    ['nothing', 44],
  ],
  tomb_colossus: [
    ['bar_gold', 14, 2],
    ['crystal_cut', 10, 1],
    ['bar_steel', 12, 2],
    ['crystal_raw', 10, 2],
    ['clay_lump', 8, 2],
    ['nothing', 42],
  ],
}

registerMobPack({
  species: UNDEAD_SPECIES,
  pets: UNDEAD_PETS,
  biomeSpawns: UNDEAD_BIOME_SPAWNS,
  loot: UNDEAD_LOOT,
})
