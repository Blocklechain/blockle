/**
 * ZONE REGISTRY — the 90 wilderness zones ringing the preserved 6-region
 * heart (|x|,|z| <= 240) out to the coast (|x|,|z| <= 720).
 *
 * Tiling: a global grid with 11 columns and 9 rows whose lines pass exactly
 * through +/-240 and +/-720; the central 3x3 block is the heart and is NOT a
 * zone. 11*9 - 9 = 90 cells, zero gaps, zero overlaps, all integers.
 *
 *   X columns: -720,-600,-480,-360,-240 | -80,80 | 240,360,480,600,720
 *   Z rows:    -720,-520,-360,-240 | -80,80 | 240,360,520,720
 *
 * North is -z (the Capital's side), so glaciers top the map and deserts
 * bake the south. Difficulty radiates outward from the heart:
 * inner ring lv 10-30, middle lv 25-60, outer lv 45-99.
 */

export type ZoneBiome =
  | 'meadow'
  | 'forest'
  | 'mountain'
  | 'dungeon'
  | 'city'
  | 'wastes'
  | 'swamp'
  | 'desert'
  | 'tundra'
  | 'volcanic'
  | 'crystal'
  | 'ruins'
  | 'beach'
  | 'mushroom'
  | 'cherry'
  | 'savanna'
  | 'canyon'
  | 'lagoon'
  | 'graveyard'
  | 'glacier'

/** Pinned zone contract — do not reshape. */
export type ZoneDef = {
  id: string
  name: string
  biome: ZoneBiome
  x0: number
  z0: number
  x1: number
  z1: number
  minLevel: number
  maxLevel: number
  desc: string
  waystone?: { id: string; name: string; x: number; z: number }
}

export const ZONES: readonly ZoneDef[] = [
  // ───────────────────────── FAR NORTH (z -720..-520) ─────────────────────────
  {
    id: 'nope_shelf', name: 'The Nope Shelf', biome: 'glacier',
    x0: -720, z0: -720, x1: -600, z1: -520, minLevel: 72, maxLevel: 88,
    desc: 'A mile of groaning pack ice that cracks jokes right before it just cracks.',
  },
  {
    id: 'brainfreeze', name: 'Brainfreeze Expanse', biome: 'glacier',
    x0: -600, z0: -720, x1: -480, z1: -520, minLevel: 66, maxLevel: 80,
    desc: 'Eat the snow here and you will taste colors; two of them are hostile.',
  },
  {
    id: 'windchill_nine', name: 'Windchill Factor Nine', biome: 'tundra',
    x0: -480, z0: -720, x1: -360, z1: -520, minLevel: 58, maxLevel: 72,
    desc: 'The wind files formal complaints directly into your bones.',
  },
  {
    id: 'shiverspikes', name: 'The Shiverspikes', biome: 'mountain',
    x0: -360, z0: -720, x1: -240, z1: -520, minLevel: 62, maxLevel: 78,
    desc: 'Peaks so sharp the clouds refuse to sit on them anymore.',
  },
  {
    id: 'deepfreeze', name: 'The Deepfreeze', biome: 'dungeon',
    x0: -240, z0: -720, x1: -80, z1: -520, minLevel: 75, maxLevel: 92,
    desc: 'An ancient vault where something very old is kept on ice, on purpose, by professionals.',
  },
  {
    id: 'zero_chill', name: 'Absolute Zero Chill', biome: 'glacier',
    x0: -80, z0: -720, x1: 80, z1: -520, minLevel: 80, maxLevel: 99,
    desc: 'The literal top of the world, home to things that think frostbite is flirting.',
    waystone: { id: 'ws_zero_chill', name: 'Polar Waystone', x: 0, z: -620 },
  },
  {
    id: 'yeti_pastures', name: 'Yeti Pastures', biome: 'tundra',
    x0: 80, z0: -720, x1: 240, z1: -520, minLevel: 60, maxLevel: 75,
    desc: 'Free-range yetis roam here, and no, they are not cuddly, stop asking.',
  },
  {
    id: 'slip_n_slayed', name: "The Slip 'n' Slayed", biome: 'glacier',
    x0: 240, z0: -720, x1: 360, z1: -520, minLevel: 64, maxLevel: 79,
    desc: 'An ice sheet with a kill count and, frankly, a bit of an attitude.',
  },
  {
    id: 'frosthold', name: 'Frosthold Ruins', biome: 'ruins',
    x0: 360, z0: -720, x1: 480, z1: -520, minLevel: 70, maxLevel: 86,
    desc: "A frozen kingdom that bet everything on 'endless winter' and somehow still lost.",
    waystone: { id: 'ws_frosthold', name: 'Frosthold Waystone', x: 420, z: -620 },
  },
  {
    id: 'mammoth_misgivings', name: 'Mammoth Misgivings', biome: 'tundra',
    x0: 480, z0: -720, x1: 600, z1: -520, minLevel: 55, maxLevel: 70,
    desc: 'Herds of woolly tanks with long memories and extremely short tempers.',
  },
  {
    id: 'glacier_point', name: 'Glacier Point Blank', biome: 'glacier',
    x0: 600, z0: -720, x1: 720, z1: -520, minLevel: 68, maxLevel: 84,
    desc: 'Where the ice meets the sea and both of them want you dead.',
  },

  // ───────────────────────── NORTH (z -520..-360) ─────────────────────────
  {
    id: 'coldshoulder', name: 'Coldshoulder Coast', biome: 'glacier',
    x0: -720, z0: -520, x1: -600, z1: -360, minLevel: 52, maxLevel: 66,
    desc: 'Even the seagulls here have given up and learned to sulk indoors.',
  },
  {
    id: 'longjohns', name: 'The Longjohns', biome: 'tundra',
    x0: -600, z0: -520, x1: -480, z1: -360, minLevel: 48, maxLevel: 60,
    desc: 'Rolling frozen flats named after the only sensible gear for visiting them.',
  },
  {
    id: 'snowblind', name: 'Snowblind Steppe', biome: 'tundra',
    x0: -480, z0: -520, x1: -360, z1: -360, minLevel: 46, maxLevel: 58,
    desc: 'Everything out here is white, including the things sneaking up on you.',
  },
  {
    id: 'ironhold_attic', name: "Ironhold's Attic", biome: 'mountain',
    x0: -360, z0: -520, x1: -240, z1: -360, minLevel: 46, maxLevel: 60,
    desc: 'The high shelf of the old mountains, where the ore is rich and the air is a rumor.',
  },
  {
    id: 'permafrost_parade', name: 'Permafrost Parade', biome: 'tundra',
    x0: -240, z0: -520, x1: -80, z1: -360, minLevel: 47, maxLevel: 59,
    desc: 'A frozen promenade of heroic statues; some are statues, some are waiting.',
  },
  {
    id: 'north_roads_end', name: "The North Road's End", biome: 'tundra',
    x0: -80, z0: -520, x1: 80, z1: -360, minLevel: 45, maxLevel: 56,
    desc: "Where the King's highway gives up, shrugs, and becomes a suggestion.",
    waystone: { id: 'ws_north_roads_end', name: "Road's End Waystone", x: 0, z: -440 },
  },
  {
    id: 'pinecone_gauntlet', name: 'Pinecone Gauntlet', biome: 'forest',
    x0: 80, z0: -520, x1: 240, z1: -360, minLevel: 46, maxLevel: 58,
    desc: 'Snow-heavy pines that drop their cones with genuinely malicious timing.',
  },
  {
    id: 'frostbitten_fields', name: 'Frostbitten Fields', biome: 'tundra',
    x0: 240, z0: -520, x1: 360, z1: -360, minLevel: 48, maxLevel: 60,
    desc: 'A farm belt that planted winter wheat and harvested regret.',
  },
  {
    id: 'chatterlands', name: 'The Chatterlands', biome: 'tundra',
    x0: 360, z0: -520, x1: 480, z1: -360, minLevel: 48, maxLevel: 60,
    desc: 'Named for the sound your teeth make here, which is roughly forever.',
  },
  {
    id: 'reindeer_standoff', name: 'Reindeer Standoff', biome: 'tundra',
    x0: 480, z0: -520, x1: 600, z1: -360, minLevel: 52, maxLevel: 65,
    desc: 'The local caribou have unionized and negotiations are not going well.',
  },
  {
    id: 'icicle_works', name: 'The Icicle Works', biome: 'glacier',
    x0: 600, z0: -520, x1: 720, z1: -360, minLevel: 54, maxLevel: 68,
    desc: "A frozen cliff-coast factory of nature's most stabbable architecture.",
  },

  // ───────────────────────── NEAR NORTH (z -360..-240) ─────────────────────────
  {
    id: 'gooseflesh_shores', name: 'Gooseflesh Shores', biome: 'beach',
    x0: -720, z0: -360, x1: -600, z1: -240, minLevel: 58, maxLevel: 72,
    desc: 'A beach, technically, if your idea of sunbathing involves wool.',
  },
  {
    id: 'knucklerange', name: 'The Knucklerange', biome: 'mountain',
    x0: -600, z0: -360, x1: -480, z1: -240, minLevel: 50, maxLevel: 62,
    desc: 'Four stubby peaks in a row, like the land itself is squaring up.',
  },
  {
    id: 'avalanche_alley', name: 'Avalanche Alley', biome: 'mountain',
    x0: -480, z0: -360, x1: -360, z1: -240, minLevel: 30, maxLevel: 45,
    desc: "Gravity's favorite bowling lane, and you're the pins.",
  },
  {
    id: 'upper_ironhold', name: 'Upper Ironhold', biome: 'mountain',
    x0: -360, z0: -360, x1: -240, z1: -240, minLevel: 14, maxLevel: 22,
    desc: 'The mining frontier past the old mountains, rich in ore and poor in guardrails.',
  },
  {
    id: 'bracing_pines', name: 'The Bracing Pines', biome: 'forest',
    x0: -240, z0: -360, x1: -80, z1: -240, minLevel: 10, maxLevel: 16,
    desc: 'A crisp evergreen wood where the squirrels hoard like tiny doomsday preppers.',
  },
  {
    id: 'kings_back_lawn', name: "The King's Back Lawn", biome: 'meadow',
    x0: -80, z0: -360, x1: 80, z1: -240, minLevel: 10, maxLevel: 15,
    desc: 'Rolling royal farmland the Capital insists it mows regularly; it does not.',
    waystone: { id: 'ws_kings_back_lawn', name: 'Back Lawn Waystone', x: 0, z: -300 },
  },
  {
    id: 'whistlewood', name: 'Whistlewood', biome: 'forest',
    x0: 80, z0: -360, x1: 240, z1: -240, minLevel: 12, maxLevel: 18,
    desc: "The trees whistle when the wind hits; nobody has told them it's creepy.",
  },
  {
    id: 'greenwood_heights', name: 'Greenwood Heights', biome: 'forest',
    x0: 240, z0: -360, x1: 360, z1: -240, minLevel: 15, maxLevel: 24,
    desc: 'The old forest climbs uphill and gets noticeably full of itself.',
  },
  {
    id: 'burly_birches', name: 'The Burly Birches', biome: 'forest',
    x0: 360, z0: -360, x1: 480, z1: -240, minLevel: 28, maxLevel: 40,
    desc: 'Trees with the girth of towers and the personality of bouncers.',
  },
  {
    id: 'petal_peak', name: 'Petal Peak', biome: 'cherry',
    x0: 480, z0: -360, x1: 600, z1: -240, minLevel: 46, maxLevel: 58,
    desc: 'A year-round blizzard of pink petals; gorgeous, fragrant, surprisingly violent.',
  },
  {
    id: 'driftwood_dumps', name: 'Driftwood Dumps', biome: 'beach',
    x0: 600, z0: -360, x1: 720, z1: -240, minLevel: 50, maxLevel: 64,
    desc: "Where the eastern sea throws away everything it's done with, including sailors.",
  },

  // ───────────────────────── WEST FLANK (z -240..-80) ─────────────────────────
  {
    id: 'worldsedge_cliffs', name: 'Worldsedge Cliffs', biome: 'mountain',
    x0: -720, z0: -240, x1: -600, z1: -80, minLevel: 55, maxLevel: 70,
    desc: 'Sheer sea cliffs where the map ends and the bad decisions begin.',
  },
  {
    id: 'craggfather', name: 'The Craggfather', biome: 'mountain',
    x0: -600, z0: -240, x1: -480, z1: -80, minLevel: 48, maxLevel: 62,
    desc: 'One enormous mountain so old it remembers when dirt was invented.',
  },
  {
    id: 'boulderdash', name: 'Boulderdash Basin', biome: 'mountain',
    x0: -480, z0: -240, x1: -360, z1: -80, minLevel: 27, maxLevel: 38,
    desc: 'The rocks here roll uphill, out of pure spite.',
  },
  {
    id: 'rumbling_foothills', name: 'The Rumbling Foothills', biome: 'mountain',
    x0: -360, z0: -240, x1: -240, z1: -80, minLevel: 10, maxLevel: 17,
    desc: 'Friendly-looking hills with indigestion and a magma problem far, far below.',
  },

  // ───────────────────────── WEST FLANK (z -80..80) ─────────────────────────
  {
    id: 'smugglers_armpit', name: "Smuggler's Armpit", biome: 'beach',
    x0: -720, z0: -80, x1: -600, z1: 80, minLevel: 50, maxLevel: 65,
    desc: 'A damp western cove beloved by pirates with admirably low standards.',
  },
  {
    id: 'prism_break', name: 'Prism Break', biome: 'crystal',
    x0: -600, z0: -80, x1: -480, z1: 80, minLevel: 52, maxLevel: 68,
    desc: 'A shattered crystal field that turns honest sunlight into weaponry.',
    waystone: { id: 'ws_prism_break', name: 'Prism Waystone', x: -540, z: 0 },
  },
  {
    id: 'glimmer_gulch', name: 'The Glimmer Gulch', biome: 'crystal',
    x0: -480, z0: -80, x1: -360, z1: 80, minLevel: 30, maxLevel: 44,
    desc: 'A ravine of singing crystals that are worth a fortune and absolutely know it.',
  },
  {
    id: 'ironvein_hollow', name: 'Ironvein Hollow', biome: 'mountain',
    x0: -360, z0: -80, x1: -240, z1: 80, minLevel: 12, maxLevel: 20,
    desc: 'A mining valley west of Ironhold where every pickaxe swing is a gamble.',
    waystone: { id: 'ws_ironvein_hollow', name: 'Ironvein Waystone', x: -300, z: 0 },
  },

  // ───────────────────────── WEST FLANK (z 80..240) ─────────────────────────
  {
    id: 'drizzlemire', name: 'The Drizzlemire', biome: 'swamp',
    x0: -720, z0: 80, x1: -600, z1: 240, minLevel: 48, maxLevel: 62,
    desc: 'A west-coast bog under permanent light rain and heavy disappointment.',
  },
  {
    id: 'shardlight_hollow', name: 'Shardlight Hollow', biome: 'crystal',
    x0: -600, z0: 80, x1: -480, z1: 240, minLevel: 55, maxLevel: 72,
    desc: 'The deep crystal heart, where the ground glows and your shadow runs the wrong way.',
  },
  {
    id: 'funguy_hills', name: 'The Funguy Hills', biome: 'mushroom',
    x0: -480, z0: 80, x1: -360, z1: 240, minLevel: 32, maxLevel: 46,
    desc: 'Cap-headed giants loom over the trail here, and some of them are mushrooms.',
  },
  {
    id: 'tombstone_flats', name: 'Tombstone Flats', biome: 'graveyard',
    x0: -360, z0: 80, x1: -240, z1: 240, minLevel: 16, maxLevel: 26,
    desc: "Ashen's overflow cemetery; the plots are cheap because the tenants wander.",
  },

  // ───────────────────────── EAST FLANK (z -240..-80) ─────────────────────────
  {
    id: 'tanglewilds', name: 'The Tanglewilds', biome: 'forest',
    x0: 240, z0: -240, x1: 360, z1: -80, minLevel: 11, maxLevel: 18,
    desc: "Greenwood's feral cousin; the vines here have opinions and grip strength.",
  },
  {
    id: 'oakzilla_grove', name: 'Oakzilla Grove', biome: 'forest',
    x0: 360, z0: -240, x1: 480, z1: -80, minLevel: 29, maxLevel: 42,
    desc: 'Home to the single largest oak in existence and its deeply insecure rivals.',
  },
  {
    id: 'blushing_orchard', name: 'The Blushing Orchard', biome: 'cherry',
    x0: 480, z0: -240, x1: 600, z1: -80, minLevel: 45, maxLevel: 58,
    desc: 'Pink canopies, drifting petals, and the politest ambushes in the realm.',
    waystone: { id: 'ws_blushing_orchard', name: 'Orchard Waystone', x: 540, z: -160 },
  },
  {
    id: 'port_saltlick', name: 'Port Saltlick', biome: 'city',
    x0: 600, z0: -240, x1: 720, z1: -80, minLevel: 48, maxLevel: 64,
    desc: "A crusty east-coast port where everything is for sale and most of it is stolen.",
    waystone: { id: 'ws_port_saltlick', name: 'Saltlick Waystone', x: 660, z: -160 },
  },

  // ───────────────────────── EAST FLANK (z -80..80) ─────────────────────────
  {
    id: 'heartwood_hollow', name: 'Heartwood Hollow', biome: 'forest',
    x0: 240, z0: -80, x1: 360, z1: 80, minLevel: 13, maxLevel: 21,
    desc: 'A deep green dell where the trees grow close enough to eavesdrop.',
    waystone: { id: 'ws_heartwood_hollow', name: 'Heartwood Waystone', x: 300, z: 0 },
  },
  {
    id: 'overgrown_opus', name: 'The Overgrown Opus', biome: 'ruins',
    x0: 360, z0: -80, x1: 480, z1: 80, minLevel: 31, maxLevel: 45,
    desc: 'A ruined amphitheater reclaimed by moss, vines, and the critics.',
  },
  {
    id: 'elderbark', name: 'The Elderbark', biome: 'forest',
    x0: 480, z0: -80, x1: 600, z1: 80, minLevel: 47, maxLevel: 60,
    desc: 'Forest so ancient the trees have stopped pretending to be asleep.',
  },
  {
    id: 'mermaids_hot_tub', name: "Mermaid's Hot Tub", biome: 'lagoon',
    x0: 600, z0: -80, x1: 720, z1: 80, minLevel: 50, maxLevel: 66,
    desc: 'A steamy turquoise lagoon with a strict no-drowning policy, loosely enforced.',
  },

  // ───────────────────────── EAST FLANK (z 80..240) ─────────────────────────
  {
    id: 'forgottener_lands', name: 'The Forgotten-er Lands', biome: 'wastes',
    x0: 240, z0: 80, x1: 360, z1: 240, minLevel: 18, maxLevel: 28,
    desc: 'Like the Forgotten Lands, but even the maps stopped trying.',
  },
  {
    id: 'dustbowl_diner', name: 'Dustbowl Diner', biome: 'wastes',
    x0: 360, z0: 80, x1: 480, z1: 240, minLevel: 33, maxLevel: 48,
    desc: "A cracked wasteland where everything wants a bite and you're the menu.",
  },
  {
    id: 'lions_share', name: "The Lion's Share", biome: 'savanna',
    x0: 480, z0: 80, x1: 600, z1: 240, minLevel: 46, maxLevel: 60,
    desc: "Golden grass to the horizon, and every single blade of it is somebody's territory.",
  },
  {
    id: 'shallow_end', name: 'The Shallow End', biome: 'lagoon',
    x0: 600, z0: 80, x1: 720, z1: 240, minLevel: 48, maxLevel: 62,
    desc: 'A sparkling reef lagoon where the water is three feet deep and the trouble is not.',
  },

  // ───────────────────────── NEAR SOUTH (z 240..360) ─────────────────────────
  {
    id: 'soggy_bottoms', name: 'The Soggy Bottoms', biome: 'swamp',
    x0: -720, z0: 240, x1: -600, z1: 360, minLevel: 52, maxLevel: 66,
    desc: "The realm's lowest, wettest, proudest mud; bring boots, lose boots.",
  },
  {
    id: 'leechfinger_fen', name: 'Leechfinger Fen', biome: 'swamp',
    x0: -600, z0: 240, x1: -480, z1: 360, minLevel: 49, maxLevel: 62,
    desc: 'The leeches here have grown fingers, and strong opinions about yours.',
  },
  {
    id: 'sporeburb', name: 'Sporeburb', biome: 'mushroom',
    x0: -480, z0: 240, x1: -360, z1: 360, minLevel: 34, maxLevel: 47,
    desc: 'A quaint suburb of mushroom cottages whose residents ARE the cottages.',
  },
  {
    id: 'catacombs_of_moist', name: 'The Catacombs of Moist', biome: 'dungeon',
    x0: -360, z0: 240, x1: -240, z1: 360, minLevel: 20, maxLevel: 30,
    desc: "Ashen's basement: miles of damp crypts named by someone who truly hated you.",
  },
  {
    id: 'gravely_serious', name: 'Gravely Serious', biome: 'graveyard',
    x0: -240, z0: 240, x1: -80, z1: 360, minLevel: 17, maxLevel: 27,
    desc: "The Skeleton King's favorite recruitment office; the headstones double as job listings.",
    waystone: { id: 'ws_gravely_serious', name: 'Gravedigger Waystone', x: -160, z: 300 },
  },
  {
    id: 'scrublands', name: 'The Scrublands', biome: 'savanna',
    x0: -80, z0: 240, x1: 80, z1: 360, minLevel: 15, maxLevel: 24,
    desc: 'Scraggly golden grass where everything is mildly on fire or thinking about it.',
  },
  {
    id: 'char_beyond', name: 'The Char Beyond', biome: 'wastes',
    x0: 80, z0: 240, x1: 240, z1: 360, minLevel: 19, maxLevel: 29,
    desc: "The Forgotten Lands' scorched back fence, where the ash gets ambitious.",
  },
  {
    id: 'vulture_veranda', name: 'Vulture Veranda', biome: 'wastes',
    x0: 240, z0: 240, x1: 360, z1: 360, minLevel: 21, maxLevel: 30,
    desc: "The vultures circle politely, like waiters who know you'll order eventually.",
  },
  {
    id: 'gorge_yourself', name: 'Gorge Yourself', biome: 'canyon',
    x0: 360, z0: 240, x1: 480, z1: 360, minLevel: 35, maxLevel: 50,
    desc: 'A layered red canyon that eats hikers and then compliments the chef.',
    waystone: { id: 'ws_gorge_yourself', name: 'Gorge Waystone', x: 420, z: 300 },
  },
  {
    id: 'prideful_plains', name: 'Prideful Plains', biome: 'savanna',
    x0: 480, z0: 240, x1: 600, z1: 360, minLevel: 47, maxLevel: 61,
    desc: 'Savanna royalty struts through here; the manes are big and the egos are bigger.',
  },
  {
    id: 'sirens_karaoke_cove', name: "Siren's Karaoke Cove", biome: 'lagoon',
    x0: 600, z0: 240, x1: 720, z1: 360, minLevel: 52, maxLevel: 67,
    desc: "A southeastern lagoon where the singing is lovely and the survival rate isn't.",
  },

  // ───────────────────────── SOUTH (z 360..520) ─────────────────────────
  {
    id: 'bogwater_deluxe', name: 'Bogwater Deluxe', biome: 'swamp',
    x0: -720, z0: 360, x1: -600, z1: 520, minLevel: 56, maxLevel: 70,
    desc: 'Premium-grade swamp: twice the stink, thrice the teeth.',
  },
  {
    id: 'croakening', name: 'The Croakening', biome: 'swamp',
    x0: -600, z0: 360, x1: -480, z1: 520, minLevel: 58, maxLevel: 74,
    desc: 'The frogs here are the size of sheds and the tadpoles hold grudges.',
    waystone: { id: 'ws_croakening', name: 'Croaking Waystone', x: -540, z: 440 },
  },
  {
    id: 'dry_heat', name: 'The Dry Heat', biome: 'savanna',
    x0: -480, z0: 360, x1: -360, z1: 520, minLevel: 44, maxLevel: 56,
    desc: "Locals insist it's a nice dry heat; the locals are skeletons.",
  },
  {
    id: 'needlepoint_nowhere', name: 'Needlepoint Nowhere', biome: 'desert',
    x0: -360, z0: 360, x1: -240, z1: 520, minLevel: 40, maxLevel: 54,
    desc: 'A cactus forest where every plant is a lawsuit waiting to happen.',
  },
  {
    id: 'great_sandbox', name: 'The Great Sandbox', biome: 'desert',
    x0: -240, z0: 360, x1: -80, z1: 520, minLevel: 42, maxLevel: 55,
    desc: 'An endless golden play-pit for things with far too many legs.',
  },
  {
    id: 'mirage_mile', name: 'Mirage Mile', biome: 'desert',
    x0: -80, z0: 360, x1: 80, z1: 520, minLevel: 45, maxLevel: 58,
    desc: 'The oasis is fake, the vendors are fake, the scorpions are devastatingly real.',
    waystone: { id: 'ws_mirage_mile', name: 'Mirage Waystone', x: 0, z: 440 },
  },
  {
    id: 'sunburn_flats', name: 'Sunburn Flats', biome: 'desert',
    x0: 80, z0: 360, x1: 240, z1: 520, minLevel: 43, maxLevel: 56,
    desc: 'SPF four thousand recommended; the sun here takes it personally.',
  },
  {
    id: 'big_crack', name: 'The Big Crack', biome: 'canyon',
    x0: 240, z0: 360, x1: 360, z1: 520, minLevel: 44, maxLevel: 58,
    desc: 'A gorge so deep the echoes come back with souvenirs.',
  },
  {
    id: 'switchback_spite', name: 'Switchback Spite', biome: 'canyon',
    x0: 360, z0: 360, x1: 480, z1: 520, minLevel: 46, maxLevel: 60,
    desc: 'A trail of one thousand hairpin turns designed by someone recently divorced.',
  },
  {
    id: 'simmering_steps', name: 'The Simmering Steps', biome: 'volcanic',
    x0: 480, z0: 360, x1: 600, z1: 520, minLevel: 60, maxLevel: 76,
    desc: 'Terraced lava fields that are technically dormant and technically liars.',
    waystone: { id: 'ws_simmering_steps', name: 'Simmering Waystone', x: 540, z: 440 },
  },
  {
    id: 'magma_mia', name: 'Magma Mia', biome: 'volcanic',
    x0: 600, z0: 360, x1: 720, z1: 520, minLevel: 64, maxLevel: 80,
    desc: 'Where the coast boils the sea, and the sea keeps coming back for more.',
  },

  // ───────────────────────── FAR SOUTH (z 520..720) ─────────────────────────
  {
    id: 'mudflap_beach', name: 'Mudflap Beach', biome: 'beach',
    x0: -720, z0: 520, x1: -600, z1: 720, minLevel: 55, maxLevel: 68,
    desc: 'A gray southwestern shore where the tide goes out and never apologizes.',
  },
  {
    id: 'sunken_suburbs', name: 'The Sunken Suburbs', biome: 'ruins',
    x0: -600, z0: 520, x1: -480, z1: 720, minLevel: 60, maxLevel: 75,
    desc: 'A drowned town square where the statues wave back, slowly.',
  },
  {
    id: 'shifting_sneaks', name: 'The Shifting Sneaks', biome: 'desert',
    x0: -480, z0: 520, x1: -360, z1: 720, minLevel: 58, maxLevel: 72,
    desc: 'Dunes that rearrange themselves behind you, purely to watch you panic.',
  },
  {
    id: 'sandblasted_badlands', name: 'Sandblasted Badlands', biome: 'desert',
    x0: -360, z0: 520, x1: -240, z1: 720, minLevel: 62, maxLevel: 76,
    desc: 'Wind, grit, and bleached bones arranged in increasingly judgmental patterns.',
  },
  {
    id: 'undercrack', name: 'The Undercrack', biome: 'canyon',
    x0: -240, z0: 520, x1: -80, z1: 720, minLevel: 66, maxLevel: 82,
    desc: 'A slot canyon so narrow your shadow has to walk behind you.',
  },
  {
    id: 'glass_furnace', name: 'The Glass Furnace', biome: 'desert',
    x0: -80, z0: 520, x1: 80, z1: 720, minLevel: 72, maxLevel: 88,
    desc: 'Deep desert where lightning fused the sand to mirrors; try not to make eye contact.',
  },
  {
    id: 'pharaohs_folly', name: "Pharaoh's Folly", biome: 'ruins',
    x0: 80, z0: 520, x1: 240, z1: 720, minLevel: 70, maxLevel: 86,
    desc: 'A half-buried tomb complex with excellent gold and terrible exit signage.',
  },
  {
    id: 'stampede_lands', name: 'The Stampede Lands', biome: 'savanna',
    x0: 240, z0: 520, x1: 360, z1: 720, minLevel: 58, maxLevel: 72,
    desc: 'Flat, fast, and frequently flattened; listen for thunder, then climb something.',
  },
  {
    id: 'cinderchoke', name: 'Cinderchoke', biome: 'volcanic',
    x0: 360, z0: 520, x1: 480, z1: 720, minLevel: 68, maxLevel: 84,
    desc: 'Ashfall country where the air chews back.',
  },
  {
    id: 'mount_tantrum', name: 'Mount Tantrum', biome: 'volcanic',
    x0: 480, z0: 520, x1: 600, z1: 720, minLevel: 78, maxLevel: 95,
    desc: "The realm's angriest volcano; it erupts on a schedule, and the schedule is 'whenever'.",
  },
  {
    id: 'obsidian_strand', name: 'The Obsidian Strand', biome: 'beach',
    x0: 600, z0: 520, x1: 720, z1: 720, minLevel: 65, maxLevel: 80,
    desc: 'A black-glass beach where the waves hiss and the sand was born yesterday, literally.',
  },
] as const

/**
 * The 90 zone ids partitioned into 15 geographic batches of 6 — neighbors
 * grouped together so streaming/builder work can proceed region by region.
 */
export const ZONE_BATCHES: string[][] = [
  // 1. Northwest corner (far NW glacier/tundra + west coast north)
  ['nope_shelf', 'brainfreeze', 'coldshoulder', 'longjohns', 'gooseflesh_shores', 'knucklerange'],
  // 2. North-center-west (tundra ridge above Ironhold)
  ['windchill_nine', 'shiverspikes', 'snowblind', 'ironhold_attic', 'avalanche_alley', 'upper_ironhold'],
  // 3. True north (polar cap + the road north of the Capital)
  ['deepfreeze', 'zero_chill', 'permafrost_parade', 'north_roads_end', 'bracing_pines', 'kings_back_lawn'],
  // 4. North-center-east (taiga above Greenwood)
  ['yeti_pastures', 'slip_n_slayed', 'pinecone_gauntlet', 'frostbitten_fields', 'whistlewood', 'greenwood_heights'],
  // 5. Northeast (frozen ruins + cherry highlands)
  ['frosthold', 'mammoth_misgivings', 'chatterlands', 'reindeer_standoff', 'burly_birches', 'petal_peak'],
  // 6. East coast strip (NE corner down the seaboard)
  ['glacier_point', 'icicle_works', 'driftwood_dumps', 'port_saltlick', 'mermaids_hot_tub', 'shallow_end'],
  // 7. West inner flank (mountains + graveyard west of the heart)
  ['rumbling_foothills', 'ironvein_hollow', 'tombstone_flats', 'boulderdash', 'glimmer_gulch', 'funguy_hills'],
  // 8. West outer flank (coast, crystal country)
  ['worldsedge_cliffs', 'craggfather', 'smugglers_armpit', 'prism_break', 'drizzlemire', 'shardlight_hollow'],
  // 9. East inner flank (wild forests + wastes east of the heart)
  ['tanglewilds', 'heartwood_hollow', 'forgottener_lands', 'oakzilla_grove', 'overgrown_opus', 'dustbowl_diner'],
  // 10. East middle + southeast shoulder (cherry/savanna into the canyon rim)
  ['blushing_orchard', 'elderbark', 'lions_share', 'gorge_yourself', 'prideful_plains', 'sirens_karaoke_cove'],
  // 11. Southwest corner (the great swamps)
  ['soggy_bottoms', 'leechfinger_fen', 'sporeburb', 'bogwater_deluxe', 'croakening', 'mudflap_beach'],
  // 12. South-center-west (Ashen's dark doorstep into the dry lands)
  ['catacombs_of_moist', 'gravely_serious', 'dry_heat', 'needlepoint_nowhere', 'sunken_suburbs', 'shifting_sneaks'],
  // 13. South-center (the deep desert)
  ['scrublands', 'char_beyond', 'great_sandbox', 'mirage_mile', 'sandblasted_badlands', 'undercrack'],
  // 14. South-center-east (sun-blasted frontier)
  ['vulture_veranda', 'sunburn_flats', 'big_crack', 'glass_furnace', 'pharaohs_folly', 'stampede_lands'],
  // 15. Southeast corner (canyon into volcano country)
  ['switchback_spite', 'simmering_steps', 'magma_mia', 'cinderchoke', 'mount_tantrum', 'obsidian_strand'],
]

/** Zone lookup by world position; null inside the heart or off the map. */
export function zoneAt(x: number, z: number): ZoneDef | null {
  for (const zn of ZONES) {
    if (x >= zn.x0 && x < zn.x1 && z >= zn.z0 && z < zn.z1) return zn
  }
  return null
}
