/**
 * ===========================================================================
 *  MOB PACK — DEMONS & FIENDS
 *  Hellhounds, fiendlings, ash-imps, pit-brutes and balor-spawn: the stuff
 *  the outer continent coughs up once the scenery stops being cute. Tiers 3-4,
 *  shoved into the harsh biomes (volcanic / wastes / dungeon / graveyard /
 *  canyon / ruins / crystal / glacier) so they haunt the far level bands.
 *
 *  14 species, each with a 'base' pet plus two rare variants (42 pet rows),
 *  a biome spawn for every species, and a loot table per species that mostly
 *  drops disappointment ('nothing').
 * ===========================================================================
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'
import { registerMobPack } from './mobpacks'

const DEMON_SPECIES: SpeciesDef[] = [
  // Tier 3 — the merely infernal starter fiends.
  { id: 'hellhound', name: 'Hellhound', tier: 3, color: 0x8b1a1a, shape: 'quadruped' },
  { id: 'cinder_hound', name: 'Cinderhound', tier: 3, color: 0xd4541e, shape: 'quadruped' },
  { id: 'ash_imp', name: 'Ash Imp', tier: 3, color: 0x5a4a44, shape: 'biped' },
  { id: 'fiendling', name: 'Fiendling', tier: 3, color: 0x9b2d5c, shape: 'biped' },
  { id: 'soot_crawler', name: 'Soot Crawler', tier: 3, color: 0x33302e, shape: 'crawler' },
  { id: 'magma_blob', name: 'Magma Blob', tier: 3, color: 0xe0541e, shape: 'blob' },
  { id: 'sulfur_sprite', name: 'Sulfur Sprite', tier: 3, color: 0xd4c23a, shape: 'flyer' },
  { id: 'ember_crawler', name: 'Ember Crawler', tier: 3, color: 0xb83a1a, shape: 'crawler' },
  { id: 'gloom_imp', name: 'Gloom Imp', tier: 3, color: 0x4a3d5c, shape: 'biped' },
  // Tier 4 — the ones that file their horns to a point before meeting you.
  { id: 'pit_brute', name: 'Pit Brute', tier: 4, color: 0x6e2a1a, shape: 'biped' },
  { id: 'balor_spawn', name: 'Balorling', tier: 4, color: 0xc43a1a, shape: 'flyer' },
  { id: 'brimstone_fiend', name: 'Brimstone Fiend', tier: 4, color: 0x7a3326, shape: 'biped' },
  { id: 'dread_maw', name: 'Dread Maw', tier: 4, color: 0x2e1a26, shape: 'blob' },
  { id: 'char_drake', name: 'Char Drake', tier: 4, color: 0x3a2420, shape: 'flyer' },
]

const DEMON_PETS: PetDef[] = [
  // Hellhound — three heads, zero recall training.
  { species: 'hellhound', variant: 'base', name: 'Who Let The Dogs Out', dropOneIn: 400 },
  { species: 'hellhound', variant: 'ember', name: 'Hot Dog', dropOneIn: 1200 },
  { species: 'hellhound', variant: 'shadow', name: 'Bad Boy (Very Bad)', dropOneIn: 3000 },

  // Cinderhound — leaves scorch marks on the carpet and your heart.
  { species: 'cinder_hound', variant: 'base', name: 'Sparky', dropOneIn: 400 },
  { species: 'cinder_hound', variant: 'ember', name: 'Smoulderpup', dropOneIn: 1200 },
  { species: 'cinder_hound', variant: 'golden', name: 'Good Boy From Hell', dropOneIn: 3000 },

  // Ash Imp — small, sooty, deeply unhelpful.
  { species: 'ash_imp', variant: 'base', name: 'Cinder Gremlin', dropOneIn: 400 },
  { species: 'ash_imp', variant: 'snow', name: 'Frostbitten Imp', dropOneIn: 1200 },
  { species: 'ash_imp', variant: 'shadow', name: 'The Little Mistake', dropOneIn: 3000 },

  // Fiendling — a demon the size of a grudge.
  { species: 'fiendling', variant: 'base', name: 'Pocket Devil', dropOneIn: 400 },
  { species: 'fiendling', variant: 'ember', name: 'Tiny Temptation', dropOneIn: 1200 },
  { species: 'fiendling', variant: 'golden', name: 'Minor Inconvenience', dropOneIn: 3000 },

  // Soot Crawler — eight legs, zero chill, leaves footprints everywhere.
  { species: 'soot_crawler', variant: 'base', name: 'Dust Bunny From Below', dropOneIn: 400 },
  { species: 'soot_crawler', variant: 'snow', name: 'Chilled Soot', dropOneIn: 1200 },
  { species: 'soot_crawler', variant: 'golden', name: 'Fancy Filth', dropOneIn: 3000 },

  // Magma Blob — basically a slime that discovered arson.
  { species: 'magma_blob', variant: 'base', name: 'Lava Lamp', dropOneIn: 400 },
  { species: 'magma_blob', variant: 'ember', name: 'Molten Mood', dropOneIn: 1200 },
  { species: 'magma_blob', variant: 'golden', name: 'Hot Pocket', dropOneIn: 3000 },

  // Sulfur Sprite — smells like a struck match and bad decisions.
  { species: 'sulfur_sprite', variant: 'base', name: 'Rotten Egg', dropOneIn: 400 },
  { species: 'sulfur_sprite', variant: 'snow', name: 'Cold Shoulder', dropOneIn: 1200 },
  { species: 'sulfur_sprite', variant: 'shadow', name: 'Silent But Deadly', dropOneIn: 3000 },

  // Ember Crawler — a centipede that is, regrettably, on fire.
  { species: 'ember_crawler', variant: 'base', name: 'Hundred Hot Feet', dropOneIn: 400 },
  { species: 'ember_crawler', variant: 'ember', name: 'Conga Line Of Pain', dropOneIn: 1200 },
  { species: 'ember_crawler', variant: 'shadow', name: 'The Crawly Regret', dropOneIn: 3000 },

  // Gloom Imp — the imp that read one philosophy book.
  { species: 'gloom_imp', variant: 'base', name: 'Little Doomer', dropOneIn: 400 },
  { species: 'gloom_imp', variant: 'snow', name: 'Seasonal Depression', dropOneIn: 1200 },
  { species: 'gloom_imp', variant: 'golden', name: 'Gilded Nihilist', dropOneIn: 3000 },

  // Pit Brute — all muscle, no neck, famously poor conversationalist.
  { species: 'pit_brute', variant: 'base', name: 'Beefcake', dropOneIn: 400 },
  { species: 'pit_brute', variant: 'shadow', name: 'Leg Day Enthusiast', dropOneIn: 3000 },
  { species: 'pit_brute', variant: 'golden', name: 'Swole Patrol', dropOneIn: 3000 },

  // Balorling — a baby balor, which is still worse than your whole day.
  { species: 'balor_spawn', variant: 'base', name: 'Winged Tantrum', dropOneIn: 400 },
  { species: 'balor_spawn', variant: 'ember', name: 'Flaming Toddler', dropOneIn: 1200 },
  { species: 'balor_spawn', variant: 'shadow', name: 'Doom, But Smaller', dropOneIn: 3000 },

  // Brimstone Fiend — smells management from a mile away.
  { species: 'brimstone_fiend', variant: 'base', name: 'Middle Manager', dropOneIn: 400 },
  { species: 'brimstone_fiend', variant: 'ember', name: 'Performance Review', dropOneIn: 1200 },
  { species: 'brimstone_fiend', variant: 'golden', name: 'Employee Of The Month', dropOneIn: 3000 },

  // Dread Maw — mostly teeth, a little regret, absolutely no manners.
  { species: 'dread_maw', variant: 'base', name: 'All Mouth', dropOneIn: 400 },
  { species: 'dread_maw', variant: 'shadow', name: 'The Snack That Bites Back', dropOneIn: 3000 },
  { species: 'dread_maw', variant: 'golden', name: 'Pearly Whites', dropOneIn: 3000 },

  // Char Drake — a dragon that got left in the oven.
  { species: 'char_drake', variant: 'base', name: 'Overcooked', dropOneIn: 400 },
  { species: 'char_drake', variant: 'ember', name: 'Well Done', dropOneIn: 1200 },
  { species: 'char_drake', variant: 'shadow', name: 'Burnt To A Crisp', dropOneIn: 3000 },
]

registerMobPack({
  species: DEMON_SPECIES,
  pets: DEMON_PETS,

  // Themed spawns — t3 fiends haunt the near-harsh biomes, t4 brutes get
  // shoved into the far outer zones (volcanic/glacier/crystal/graveyard).
  biomeSpawns: {
    volcanic: [
      ['magma_blob', 10],
      ['cinder_hound', 8],
      ['ember_crawler', 7],
      ['sulfur_sprite', 6],
      ['balor_spawn', 5],
      ['char_drake', 4],
      ['brimstone_fiend', 4],
    ],
    wastes: [
      ['ash_imp', 9],
      ['hellhound', 7],
      ['soot_crawler', 6],
      ['fiendling', 5],
      ['pit_brute', 4],
    ],
    dungeon: [
      ['gloom_imp', 8],
      ['fiendling', 7],
      ['ash_imp', 6],
      ['soot_crawler', 5],
      ['dread_maw', 3],
    ],
    canyon: [
      ['hellhound', 8],
      ['cinder_hound', 6],
      ['ember_crawler', 5],
      ['pit_brute', 4],
    ],
    ruins: [
      ['gloom_imp', 7],
      ['ash_imp', 6],
      ['brimstone_fiend', 4],
      ['dread_maw', 3],
    ],
    graveyard: [
      ['gloom_imp', 6],
      ['dread_maw', 5],
      ['balor_spawn', 3],
    ],
    crystal: [
      ['sulfur_sprite', 5],
      ['brimstone_fiend', 4],
      ['char_drake', 3],
    ],
    glacier: [
      ['dread_maw', 4],
      ['char_drake', 3],
      ['pit_brute', 3],
    ],
  },

  // Loot — tier 3 pays in iron/steel/crystal_raw, tier 4 in gold/crystal.
  // Every table keeps a fat 'nothing' row so kills don't rain loot.
  loot: {
    hellhound: [
      ['hide_tough', 30, 2],
      ['bar_iron', 18, 1],
      ['food_jerky', 14, 2],
      ['crystal_raw', 6, 1],
      ['nothing', 55],
    ],
    cinder_hound: [
      ['hide_tough', 28, 2],
      ['ore_iron', 20, 3],
      ['food_jerky', 12, 2],
      ['bar_steel', 6, 1],
      ['nothing', 58],
    ],
    ash_imp: [
      ['ore_iron', 26, 3],
      ['clay_lump', 18, 2],
      ['herb_red', 12, 2],
      ['crystal_raw', 5, 1],
      ['nothing', 60],
    ],
    fiendling: [
      ['bar_iron', 22, 1],
      ['herb_red', 16, 2],
      ['potion_regret', 8, 1],
      ['crystal_shard', 4, 1],
      ['nothing', 60],
    ],
    soot_crawler: [
      ['ore_iron', 24, 3],
      ['hide_tough', 16, 1],
      ['clay_lump', 14, 2],
      ['nothing', 62],
    ],
    magma_blob: [
      ['ore_iron', 22, 3],
      ['crystal_raw', 14, 2],
      ['bar_steel', 8, 1],
      ['food_jelly', 10, 2],
      ['nothing', 58],
    ],
    sulfur_sprite: [
      ['herb_gold', 16, 2],
      ['crystal_raw', 12, 1],
      ['crystal_shard', 6, 1],
      ['potion_regret', 6, 1],
      ['nothing', 64],
    ],
    ember_crawler: [
      ['hide_tough', 24, 2],
      ['ore_iron', 18, 3],
      ['bar_steel', 8, 1],
      ['nothing', 62],
    ],
    gloom_imp: [
      ['herb_blue', 18, 2],
      ['bar_iron', 14, 1],
      ['potion_regret', 10, 1],
      ['crystal_shard', 5, 1],
      ['nothing', 62],
    ],
    pit_brute: [
      ['bar_gold', 20, 1],
      ['hide_tough', 18, 2],
      ['crystal_cut', 8, 1],
      ['food_pie', 10, 1],
      ['nothing', 56],
    ],
    balor_spawn: [
      ['bar_gold', 18, 1],
      ['crystal_shard', 14, 2],
      ['crystal_cut', 7, 1],
      ['potion_regret', 6, 1],
      ['nothing', 58],
    ],
    brimstone_fiend: [
      ['ore_gold', 20, 2],
      ['bar_gold', 12, 1],
      ['crystal_cut', 8, 1],
      ['herb_gold', 10, 2],
      ['nothing', 58],
    ],
    dread_maw: [
      ['bar_gold', 16, 1],
      ['crystal_shard', 12, 2],
      ['food_cake', 10, 1],
      ['crystal_cut', 6, 1],
      ['nothing', 60],
    ],
    char_drake: [
      ['bar_gold', 18, 1],
      ['crystal_cut', 12, 1],
      ['hide_tough', 14, 2],
      ['crystal_raw', 10, 2],
      ['nothing', 54],
    ],
  },
})
