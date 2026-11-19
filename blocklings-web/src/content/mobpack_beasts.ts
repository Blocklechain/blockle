/**
 * ===========================================================================
 *  WILD BEASTS & PREDATORS MOB PACK — the honest half of the food chain.
 * ===========================================================================
 *
 * Fourteen things with teeth, hooves, or a grudge: meadow fawns and feral
 * hounds (tier 1), the dire boars / panthers / bears / raptors that make the
 * forest and savanna a bad place to jog (tier 2), and two apex regrets — the
 * savanna lion and the cave bear (tier 3) — that wander the harsh outer
 * canyon/wastes/glacier bands to eat optimists who out-levelled their common
 * sense but not their legs.
 *
 * Each species ships a 'base' pet plus 1-2 rare variants (ember/snow = Rare,
 * golden/shadow = Epic), auto-recolored from the species rig — no mesh code.
 * Loot richness tracks tier (t1 copper/hide/herb, t2 iron/steel/tough-hide,
 * t3 steel/crystal); every table carries a 'nothing' row so skinning the
 * wildlife does not literally rain leather.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

const BEAST_SPECIES: SpeciesDef[] = [
  // ---- tier 1: starter wildlife, i.e. lunch that fights back a little -----
  { id: 'meadow_fawn', name: 'Meadow Fawn', tier: 1, color: 0xc98f5a, shape: 'quadruped' },
  { id: 'thicket_lynx', name: 'Thicket Lynx', tier: 1, color: 0x9a7b4f, shape: 'quadruped' },
  { id: 'tundra_fox', name: 'Tundra Fox', tier: 1, color: 0xe7e2d6, shape: 'quadruped' },
  { id: 'ridgeback_hound', name: 'Ridgeback Hound', tier: 1, color: 0x8a6a46, shape: 'quadruped' },
  // ---- tier 2: the actual predators, the part of nature with opinions -----
  { id: 'dire_boar', name: 'Dire Boar', tier: 2, color: 0x5c4634, shape: 'quadruped' },
  { id: 'shadow_panther', name: 'Shadow Panther', tier: 2, color: 0x2b2b33, shape: 'quadruped' },
  { id: 'grizzled_bruin', name: 'Grizzled Bruin', tier: 2, color: 0x6b4a30, shape: 'quadruped' },
  { id: 'pack_raptor', name: 'Pack Raptor', tier: 2, color: 0x7d8a52, shape: 'biped' },
  { id: 'horned_stag', name: 'Horned Stag', tier: 2, color: 0x9c6b3e, shape: 'quadruped' },
  { id: 'savanna_hyena', name: 'Savanna Hyena', tier: 2, color: 0xb59a6a, shape: 'quadruped' },
  { id: 'crag_ram', name: 'Crag Ram', tier: 2, color: 0x8d8278, shape: 'quadruped' },
  { id: 'frost_lynx', name: 'Frost Lynx', tier: 2, color: 0xbcd6e2, shape: 'quadruped' },
  // ---- tier 3: apex regrets, the "you should have run" bracket ------------
  { id: 'savanna_lion', name: 'Savanna Lion', tier: 3, color: 0xd1a855, shape: 'quadruped' },
  { id: 'cave_bear', name: 'Cave Bear', tier: 3, color: 0x4a3626, shape: 'quadruped' },
]

const BEAST_PETS: PetDef[] = [
  // Meadow Fawn
  { species: 'meadow_fawn', variant: 'base', name: 'Bambi, Legally Distinct', dropOneIn: 400 },
  { species: 'meadow_fawn', variant: 'snow', name: 'Winter Coat, No Plan', dropOneIn: 1200 },
  { species: 'meadow_fawn', variant: 'golden', name: 'Trophy Participation', dropOneIn: 3000 },
  // Thicket Lynx
  { species: 'thicket_lynx', variant: 'base', name: 'Mister Tufts', dropOneIn: 400 },
  { species: 'thicket_lynx', variant: 'ember', name: 'Scorched Earpuffs', dropOneIn: 1200 },
  { species: 'thicket_lynx', variant: 'shadow', name: 'Ambush From HR', dropOneIn: 3000 },
  // Tundra Fox
  { species: 'tundra_fox', variant: 'base', name: 'Snacks McGee', dropOneIn: 400 },
  { species: 'tundra_fox', variant: 'snow', name: 'Camouflage (Too Good)', dropOneIn: 1200 },
  { species: 'tundra_fox', variant: 'golden', name: 'What Does It Say (Nothing)', dropOneIn: 3000 },
  // Ridgeback Hound
  { species: 'ridgeback_hound', variant: 'base', name: 'Good Boy (Lying)', dropOneIn: 400 },
  { species: 'ridgeback_hound', variant: 'ember', name: 'Hot Dog, Literally', dropOneIn: 1200 },
  { species: 'ridgeback_hound', variant: 'shadow', name: 'Who Let Him Out', dropOneIn: 3000 },
  // Dire Boar
  { species: 'dire_boar', variant: 'base', name: 'Hamhock the Dire', dropOneIn: 400 },
  { species: 'dire_boar', variant: 'ember', name: 'Pulled Pork (Angry)', dropOneIn: 1200 },
  { species: 'dire_boar', variant: 'golden', name: 'Prize Hog, Unearned', dropOneIn: 3000 },
  // Shadow Panther
  { species: 'shadow_panther', variant: 'base', name: 'Edgelord Whiskers', dropOneIn: 400 },
  { species: 'shadow_panther', variant: 'shadow', name: 'Already Behind You', dropOneIn: 1200 },
  { species: 'shadow_panther', variant: 'golden', name: 'Luxury Mauling', dropOneIn: 3000 },
  // Grizzled Bruin
  { species: 'grizzled_bruin', variant: 'base', name: 'Just Woke Up, Furious', dropOneIn: 400 },
  { species: 'grizzled_bruin', variant: 'snow', name: 'Skipped Hibernation', dropOneIn: 1200 },
  { species: 'grizzled_bruin', variant: 'shadow', name: 'The Camping Trip Ender', dropOneIn: 3000 },
  // Pack Raptor
  { species: 'pack_raptor', variant: 'base', name: 'Clever Girl (Overrated)', dropOneIn: 400 },
  { species: 'pack_raptor', variant: 'ember', name: 'Door-Opening Enthusiast', dropOneIn: 1200 },
  { species: 'pack_raptor', variant: 'golden', name: 'Employee of the Month', dropOneIn: 3000 },
  // Horned Stag
  { species: 'horned_stag', variant: 'base', name: 'Twelve-Point Problem', dropOneIn: 400 },
  { species: 'horned_stag', variant: 'ember', name: 'Rutting Season Rage', dropOneIn: 1200 },
  { species: 'horned_stag', variant: 'golden', name: 'Hood Ornament, Pending', dropOneIn: 3000 },
  // Savanna Hyena
  { species: 'savanna_hyena', variant: 'base', name: 'Laughs At Your Build', dropOneIn: 400 },
  { species: 'savanna_hyena', variant: 'ember', name: 'Cackle Intensifies', dropOneIn: 1200 },
  { species: 'savanna_hyena', variant: 'shadow', name: 'The Last Laugh (Yours? No)', dropOneIn: 3000 },
  // Crag Ram
  { species: 'crag_ram', variant: 'base', name: 'Headbutt McGraw', dropOneIn: 400 },
  { species: 'crag_ram', variant: 'snow', name: 'Concussion Protocol', dropOneIn: 1200 },
  { species: 'crag_ram', variant: 'golden', name: 'Load-Bearing Headache', dropOneIn: 3000 },
  // Frost Lynx
  { species: 'frost_lynx', variant: 'base', name: 'Cold Paws, Warm Murder', dropOneIn: 400 },
  { species: 'frost_lynx', variant: 'snow', name: 'Freezer-Burned Beauty', dropOneIn: 1200 },
  { species: 'frost_lynx', variant: 'shadow', name: 'Silent and Judging', dropOneIn: 3000 },
  // Savanna Lion
  { species: 'savanna_lion', variant: 'base', name: 'King of Doing Nothing', dropOneIn: 400 },
  { species: 'savanna_lion', variant: 'ember', name: 'Mane Character Energy', dropOneIn: 1200 },
  { species: 'savanna_lion', variant: 'golden', name: 'Circle of Life (Yours Ends)', dropOneIn: 3000 },
  // Cave Bear
  { species: 'cave_bear', variant: 'base', name: 'Rent-Controlled Rage', dropOneIn: 400 },
  { species: 'cave_bear', variant: 'snow', name: 'Ten Thousand Years Grumpy', dropOneIn: 1200 },
  { species: 'cave_bear', variant: 'shadow', name: 'The Reason Caves Are Empty', dropOneIn: 3000 },
]

registerMobPack({
  species: BEAST_SPECIES,
  pets: BEAST_PETS,
  // Wildlife into the biomes that fit; apex tier-3s drift into the harsh
  // outer bands (wastes / canyon / glacier / tundra) at high levels.
  biomeSpawns: {
    meadow: [
      ['meadow_fawn', 8],
      ['ridgeback_hound', 5],
      ['horned_stag', 4],
      ['dire_boar', 3],
    ],
    forest: [
      ['thicket_lynx', 7],
      ['dire_boar', 5],
      ['horned_stag', 5],
      ['grizzled_bruin', 4],
      ['shadow_panther', 3],
    ],
    savanna: [
      ['savanna_hyena', 7],
      ['pack_raptor', 6],
      ['shadow_panther', 4],
      ['horned_stag', 3],
      ['savanna_lion', 2],
    ],
    mountain: [
      ['crag_ram', 7],
      ['grizzled_bruin', 4],
      ['cave_bear', 2],
    ],
    tundra: [
      ['tundra_fox', 7],
      ['frost_lynx', 5],
      ['grizzled_bruin', 3],
    ],
    glacier: [
      ['frost_lynx', 6],
      ['tundra_fox', 4],
      ['cave_bear', 2],
    ],
    canyon: [
      ['crag_ram', 4],
      ['pack_raptor', 4],
      ['savanna_lion', 3],
      ['cave_bear', 2],
    ],
    wastes: [
      ['savanna_hyena', 4],
      ['savanna_lion', 3],
      ['dire_boar', 2],
    ],
  },
  // Loot richness tracks tier; every table ends on a 'nothing' row.
  loot: {
    // --- tier 1 ---
    meadow_fawn: [
      ['hide_wolf', 26, 2],
      ['food_jerky', 12],
      ['herb_green', 14],
      ['berry_red', 12],
      ['nothing', 60],
    ],
    thicket_lynx: [
      ['hide_wolf', 24, 2],
      ['ore_copper', 14],
      ['herb_green', 12],
      ['mushroom_brown', 10],
      ['nothing', 58],
    ],
    tundra_fox: [
      ['hide_wolf', 24, 2],
      ['herb_blue', 14],
      ['fish_raw', 12],
      ['berry_red', 10],
      ['nothing', 58],
    ],
    ridgeback_hound: [
      ['hide_wolf', 26, 2],
      ['ore_copper', 14],
      ['food_jerky', 12],
      ['herb_green', 10],
      ['nothing', 60],
    ],
    // --- tier 2 ---
    dire_boar: [
      ['hide_boar', 28, 2],
      ['hide_tough', 14],
      ['ore_iron', 16],
      ['food_jerky', 12],
      ['herb_red', 10],
      ['nothing', 50],
    ],
    shadow_panther: [
      ['hide_tough', 22, 2],
      ['ore_iron', 16],
      ['bar_copper', 10],
      ['herb_blue', 10],
      ['nothing', 50],
    ],
    grizzled_bruin: [
      ['hide_tough', 24, 2],
      ['hide_boar', 14],
      ['ore_iron', 14],
      ['food_honey', 10],
      ['berry_red', 10],
      ['nothing', 50],
    ],
    pack_raptor: [
      ['hide_tough', 20, 2],
      ['ore_iron', 16],
      ['bar_copper', 12],
      ['food_jerky', 12],
      ['herb_green', 8],
      ['nothing', 50],
    ],
    horned_stag: [
      ['hide_boar', 24, 2],
      ['hide_tough', 14],
      ['wood_oak', 14],
      ['herb_green', 12],
      ['food_pie', 6],
      ['nothing', 52],
    ],
    savanna_hyena: [
      ['hide_tough', 22, 2],
      ['ore_iron', 16],
      ['bar_copper', 10],
      ['food_jerky', 12],
      ['nothing', 52],
    ],
    crag_ram: [
      ['hide_tough', 22, 2],
      ['ore_iron', 18],
      ['clay_lump', 12],
      ['bar_copper', 10],
      ['herb_red', 8],
      ['nothing', 50],
    ],
    frost_lynx: [
      ['hide_tough', 22, 2],
      ['ore_iron', 14],
      ['herb_blue', 14],
      ['fish_salmon', 10],
      ['nothing', 52],
    ],
    // --- tier 3 ---
    savanna_lion: [
      ['hide_tough', 24, 2],
      ['bar_iron', 14],
      ['bar_steel', 8],
      ['crystal_shard', 8],
      ['herb_gold', 8],
      ['food_jerky', 10],
      ['nothing', 46],
    ],
    cave_bear: [
      ['hide_tough', 26, 2],
      ['bar_iron', 14],
      ['bar_steel', 8],
      ['crystal_raw', 8],
      ['food_honey', 10],
      ['potion_regret', 4],
      ['nothing', 46],
    ],
  },
})
