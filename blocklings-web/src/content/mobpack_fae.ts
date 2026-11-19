/**
 * ===========================================================================
 *  FAE & SPIRITS MOB PACK — the small, the shimmering, the petty.
 * ===========================================================================
 *
 * Fourteen bits of the hedge that got opinions: dew sprites, thorn pixies and
 * garden grigs that swarm the flower country (tier 1), the spriggans, pookas,
 * nixies, moss-fauns, dream-moths and boggarts that make a forest/swamp walk
 * a negotiation (tier 2), and three tier-3 grudges — the leshy, the sylph and
 * the marsh will-o'-wisp — that drift out into the harsh crystal/glacier/canyon
 * bands to lead over-levelled optimists somewhere quiet and final.
 *
 * Theme bias: cherry / mushroom / forest / meadow are lousy with fae; a couple
 * of tier-3s wander the cold, crystalline outer zones so high-level players in
 * the pretty-but-deadly biomes still meet something with pointy teeth.
 *
 * Each species ships a 'base' pet plus 1-2 rare variants (ember/snow = Rare,
 * golden/shadow = Epic), auto-recolored from the species rig — no mesh code.
 * Loot richness tracks tier (t1 herb/wood/berry, t2 ancient-wood/crystal-shard,
 * t3 crystal/gold-bar/honey); every table carries a 'nothing' row so pressing
 * the flowers does not literally rain loot.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

const FAE_SPECIES: SpeciesDef[] = [
  // ---- tier 1: the hedge's starter cast, tiny and already annoyed --------
  { id: 'sprite_dew', name: 'Dew Sprite', tier: 1, color: 0x9fe6c4, shape: 'flyer' },
  { id: 'pixie_thorn', name: 'Thorn Pixie', tier: 1, color: 0xe88bb0, shape: 'flyer' },
  { id: 'grig', name: 'Garden Grig', tier: 1, color: 0x8fbf5a, shape: 'crawler' },
  { id: 'dryad_sapling', name: 'Dryad Sapling', tier: 1, color: 0x6f9f54, shape: 'biped' },
  // ---- tier 2: the hedge with a grudge and a plan -----------------------
  { id: 'spriggan_oak', name: 'Oak Spriggan', tier: 2, color: 0x7a5a38, shape: 'biped' },
  { id: 'faun_moss', name: 'Moss Faun', tier: 2, color: 0x5c7b46, shape: 'biped' },
  { id: 'pooka', name: 'Pooka', tier: 2, color: 0x4a4458, shape: 'quadruped' },
  { id: 'nixie', name: 'Bog Nixie', tier: 2, color: 0x4f93a6, shape: 'biped' },
  { id: 'dreammoth', name: 'Dream Moth', tier: 2, color: 0xb79adf, shape: 'flyer' },
  { id: 'boggart', name: 'Boggart', tier: 2, color: 0x6b5a44, shape: 'blob' },
  { id: 'sprite_bloom', name: 'Bloom Sprite', tier: 2, color: 0xf2a7c4, shape: 'flyer' },
  // ---- tier 3: old things that lead you somewhere quiet -----------------
  { id: 'leshy', name: 'Leshy', tier: 3, color: 0x3f5c33, shape: 'biped' },
  { id: 'sylph', name: 'Rime Sylph', tier: 3, color: 0xbfe4f2, shape: 'flyer' },
  { id: 'will_o_wisp', name: "Marsh Will-o'-Wisp", tier: 3, color: 0xa8ff8f, shape: 'flyer' },
]

const FAE_PETS: PetDef[] = [
  // Dew Sprite
  { species: 'sprite_dew', variant: 'base', name: 'Mild Dampness', dropOneIn: 400 },
  { species: 'sprite_dew', variant: 'snow', name: 'Frostbite the Friendly', dropOneIn: 1200 },
  { species: 'sprite_dew', variant: 'golden', name: 'Morning Glare', dropOneIn: 3000 },
  // Thorn Pixie
  { species: 'pixie_thorn', variant: 'base', name: 'Pointy Little Problem', dropOneIn: 400 },
  { species: 'pixie_thorn', variant: 'ember', name: 'Tiny Arsonist', dropOneIn: 1200 },
  { species: 'pixie_thorn', variant: 'shadow', name: 'Splinter From Below', dropOneIn: 3000 },
  // Garden Grig
  { species: 'grig', variant: 'base', name: 'Chirps, Then Bites', dropOneIn: 400 },
  { species: 'grig', variant: 'snow', name: 'Winter Cricket, Still Mad', dropOneIn: 1200 },
  { species: 'grig', variant: 'golden', name: 'First-Chair Violinist', dropOneIn: 3000 },
  // Dryad Sapling
  { species: 'dryad_sapling', variant: 'base', name: 'Sprout the Spiteful', dropOneIn: 400 },
  { species: 'dryad_sapling', variant: 'ember', name: 'Kindling With Feelings', dropOneIn: 1200 },
  { species: 'dryad_sapling', variant: 'golden', name: 'Overwatered, Overdramatic', dropOneIn: 3000 },
  // Oak Spriggan
  { species: 'spriggan_oak', variant: 'base', name: 'Knock On Wood (It Knocks Back)', dropOneIn: 400 },
  { species: 'spriggan_oak', variant: 'ember', name: 'Yule Log, Lit', dropOneIn: 1200 },
  { species: 'spriggan_oak', variant: 'shadow', name: 'The Groaning Floorboard', dropOneIn: 3000 },
  // Moss Faun
  { species: 'faun_moss', variant: 'base', name: 'Fuzzy and Furious', dropOneIn: 400 },
  { species: 'faun_moss', variant: 'snow', name: 'North-Facing Grudge', dropOneIn: 1200 },
  { species: 'faun_moss', variant: 'golden', name: 'Lawn Ornament, Unpaid', dropOneIn: 3000 },
  // Pooka
  { species: 'pooka', variant: 'base', name: 'Definitely Not a Rabbit', dropOneIn: 400 },
  { species: 'pooka', variant: 'shadow', name: 'Hitchhiker You Regret', dropOneIn: 1200 },
  { species: 'pooka', variant: 'golden', name: 'Lucky, For Him', dropOneIn: 3000 },
  // Bog Nixie
  { species: 'nixie', variant: 'base', name: 'Riverside Liability', dropOneIn: 400 },
  { species: 'nixie', variant: 'snow', name: 'Ice Water Personality', dropOneIn: 1200 },
  { species: 'nixie', variant: 'shadow', name: 'The Undertow Says Hi', dropOneIn: 3000 },
  // Dream Moth
  { species: 'dreammoth', variant: 'base', name: 'Nap Thief', dropOneIn: 400 },
  { species: 'dreammoth', variant: 'ember', name: 'Porch Light Zealot', dropOneIn: 1200 },
  { species: 'dreammoth', variant: 'golden', name: 'Eats Your Good Sweater', dropOneIn: 3000 },
  // Boggart
  { species: 'boggart', variant: 'base', name: 'Rent-Free Tenant', dropOneIn: 400 },
  { species: 'boggart', variant: 'ember', name: 'Milk Gone Sour, On Purpose', dropOneIn: 1200 },
  { species: 'boggart', variant: 'shadow', name: 'The Thing Under the Sink', dropOneIn: 3000 },
  // Bloom Sprite
  { species: 'sprite_bloom', variant: 'base', name: 'Allergy Season Incarnate', dropOneIn: 400 },
  { species: 'sprite_bloom', variant: 'ember', name: 'Scorched Petal Princess', dropOneIn: 1200 },
  { species: 'sprite_bloom', variant: 'golden', name: 'Bouquet of Regret', dropOneIn: 3000 },
  // Leshy
  { species: 'leshy', variant: 'base', name: 'Lost the Trail (On Purpose)', dropOneIn: 400 },
  { species: 'leshy', variant: 'shadow', name: 'The Forest Does Not Forgive', dropOneIn: 1200 },
  { species: 'leshy', variant: 'golden', name: 'Shoes On Backwards, Still Faster', dropOneIn: 3000 },
  // Rime Sylph
  { species: 'sylph', variant: 'base', name: 'A Cold Draft With Intent', dropOneIn: 400 },
  { species: 'sylph', variant: 'snow', name: "The Blizzard's Polite Cousin", dropOneIn: 1200 },
  { species: 'sylph', variant: 'golden', name: 'Windchill, Weaponized', dropOneIn: 3000 },
  // Marsh Will-o'-Wisp
  { species: 'will_o_wisp', variant: 'base', name: 'This Way! (It Is Not)', dropOneIn: 400 },
  { species: 'will_o_wisp', variant: 'ember', name: "Follow the Pretty Light (Don't)", dropOneIn: 1200 },
  { species: 'will_o_wisp', variant: 'shadow', name: 'Last Thing Many Saw', dropOneIn: 3000 },
]

registerMobPack({
  species: FAE_SPECIES,
  pets: FAE_PETS,
  // Fae pile into the flowery biomes (cherry/mushroom/meadow/forest/swamp);
  // the tier-3s drift out to the cold, crystalline outer bands at high level.
  biomeSpawns: {
    meadow: [
      ['sprite_dew', 8],
      ['pixie_thorn', 6],
      ['grig', 6],
      ['dryad_sapling', 4],
      ['sprite_bloom', 3],
    ],
    cherry: [
      ['sprite_bloom', 8],
      ['pixie_thorn', 6],
      ['dreammoth', 5],
      ['sprite_dew', 4],
      ['sylph', 2],
    ],
    mushroom: [
      ['boggart', 7],
      ['grig', 6],
      ['dreammoth', 5],
      ['faun_moss', 4],
      ['will_o_wisp', 2],
    ],
    forest: [
      ['dryad_sapling', 6],
      ['spriggan_oak', 6],
      ['faun_moss', 5],
      ['pooka', 4],
      ['leshy', 2],
    ],
    swamp: [
      ['nixie', 7],
      ['boggart', 5],
      ['will_o_wisp', 4],
      ['pooka', 3],
      ['leshy', 2],
    ],
    lagoon: [
      ['nixie', 6],
      ['sprite_dew', 5],
      ['dreammoth', 3],
    ],
    crystal: [
      ['sylph', 5],
      ['sprite_dew', 3],
      ['leshy', 2],
    ],
    glacier: [
      ['sylph', 5],
      ['pooka', 3],
    ],
    canyon: [
      ['leshy', 4],
      ['spriggan_oak', 3],
      ['will_o_wisp', 2],
    ],
  },
  // Loot richness tracks tier; every table ends on a 'nothing' row.
  loot: {
    // --- tier 1 ---
    sprite_dew: [
      ['herb_blue', 24],
      ['herb_green', 16],
      ['berry_red', 12],
      ['food_jelly', 6],
      ['nothing', 60],
    ],
    pixie_thorn: [
      ['herb_red', 22],
      ['herb_green', 16],
      ['wood_pine', 12],
      ['berry_red', 10],
      ['nothing', 60],
    ],
    grig: [
      ['herb_green', 24],
      ['wheat', 16],
      ['mushroom_brown', 12],
      ['berry_red', 10],
      ['nothing', 60],
    ],
    dryad_sapling: [
      ['wood_oak', 24, 2],
      ['wood_pine', 16],
      ['herb_green', 14],
      ['berry_red', 10],
      ['nothing', 58],
    ],
    // --- tier 2 ---
    spriggan_oak: [
      ['wood_oak', 26, 2],
      ['wood_ancient', 10],
      ['herb_gold', 10],
      ['crystal_shard', 8],
      ['clay_lump', 10],
      ['nothing', 50],
    ],
    faun_moss: [
      ['hide_wolf', 20, 2],
      ['wood_oak', 16],
      ['herb_green', 14],
      ['herb_gold', 10],
      ['mushroom_brown', 10],
      ['nothing', 52],
    ],
    pooka: [
      ['hide_wolf', 22, 2],
      ['herb_red', 14],
      ['crystal_shard', 10],
      ['food_jelly', 10],
      ['potion_regret', 3],
      ['nothing', 52],
    ],
    nixie: [
      ['fish_trout', 20, 2],
      ['fish_salmon', 12],
      ['herb_blue', 16],
      ['crystal_shard', 10],
      ['clay_lump', 10],
      ['nothing', 52],
    ],
    dreammoth: [
      ['herb_blue', 20],
      ['crystal_shard', 14],
      ['herb_gold', 10],
      ['food_honey', 10],
      ['food_jelly', 8],
      ['nothing', 54],
    ],
    boggart: [
      ['mushroom_brown', 20, 2],
      ['herb_red', 14],
      ['clay_lump', 12],
      ['food_pie', 8],
      ['potion_regret', 4],
      ['nothing', 54],
    ],
    sprite_bloom: [
      ['herb_gold', 20],
      ['herb_red', 14],
      ['berry_red', 12],
      ['food_honey', 10],
      ['crystal_shard', 8],
      ['nothing', 54],
    ],
    // --- tier 3 ---
    leshy: [
      ['wood_ancient', 22, 2],
      ['wood_oak', 14],
      ['bar_iron', 10],
      ['crystal_raw', 10],
      ['herb_gold', 10],
      ['food_honey', 8],
      ['nothing', 46],
    ],
    sylph: [
      ['crystal_raw', 20],
      ['crystal_cut', 8],
      ['bar_steel', 10],
      ['herb_blue', 14],
      ['bar_gold', 4],
      ['nothing', 46],
    ],
    will_o_wisp: [
      ['crystal_raw', 18],
      ['crystal_shard', 14],
      ['bar_gold', 6],
      ['herb_gold', 12],
      ['potion_regret', 5],
      ['food_jelly', 8],
      ['nothing', 46],
    ],
  },
})
