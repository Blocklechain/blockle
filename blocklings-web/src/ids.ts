/**
 * Blocklings — canonical ID registry (frozen contract).
 *
 * Every system references regions, mobs, NPCs, resource nodes, waystones and
 * item-id conventions THROUGH this file so parallel modules agree on names.
 * Do not rename existing ids; add, don't mutate.
 *
 * World layout: one continent, ~480x480 world units, the loved hand-built
 * Kingdom of Beginnings village at the origin. Regions radiate outward.
 * Coordinates are world units (1 voxel = 1 unit), X east, Z south.
 */

export interface RegionDef {
  id: string
  name: string
  /** Inclusive world-unit bounds. */
  x0: number
  z0: number
  x1: number
  z1: number
  /** Mob level band. */
  minLevel: number
  maxLevel: number
  /** Flavor driving ground/nature palettes. */
  biome: 'meadow' | 'forest' | 'mountain' | 'dungeon' | 'city' | 'wastes'
}

/** The six regions of the master prompt, laid out around the origin village. */
export const REGIONS: readonly RegionDef[] = [
  { id: 'beginnings', name: 'Kingdom of Beginnings', x0: -80, z0: -80, x1: 80, z1: 80, minLevel: 1, maxLevel: 5, biome: 'meadow' },
  { id: 'greenwood', name: 'Greenwood Forest', x0: 80, z0: -120, x1: 240, z1: 120, minLevel: 4, maxLevel: 12, biome: 'forest' },
  { id: 'ironhold', name: 'Ironhold Mountains', x0: -240, z0: -120, x1: -80, z1: 120, minLevel: 8, maxLevel: 18, biome: 'mountain' },
  { id: 'capital', name: 'The Royal Capital', x0: -80, z0: -240, x1: 80, z1: -80, minLevel: 1, maxLevel: 99, biome: 'city' },
  { id: 'ashen', name: 'Ashen Dungeons', x0: -240, z0: 120, x1: 0, z1: 240, minLevel: 12, maxLevel: 25, biome: 'dungeon' },
  { id: 'forgotten', name: 'The Forgotten Lands', x0: 0, z0: 120, x1: 240, z1: 240, minLevel: 20, maxLevel: 40, biome: 'wastes' },
] as const

export function regionAt(x: number, z: number): RegionDef | null {
  // Beginnings is checked LAST so overlapping edges resolve to the wilder region.
  for (let i = REGIONS.length - 1; i >= 0; i--) {
    const r = REGIONS[i]!
    if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return r
  }
  return null
}

/**
 * Boxy monster species — cute voxel critters with the same procedural
 * bob/waddle animation charm as the player character. `tier` buckets them
 * into region difficulty; bosses exist per region on top of these.
 */
export interface SpeciesDef {
  id: string
  name: string
  tier: 1 | 2 | 3 | 4
  /** Base body color (hex) — builders derive shades from it. */
  color: number
  /** Rough body archetype for the voxel builder. */
  shape: 'blob' | 'quadruped' | 'biped' | 'crawler' | 'flyer'
}

export const SPECIES: readonly SpeciesDef[] = [
  { id: 'slime', name: 'Slime', tier: 1, color: 0x7ed957, shape: 'blob' },
  { id: 'mushroom', name: 'Shroomling', tier: 1, color: 0xd96459, shape: 'blob' },
  { id: 'crab', name: 'Pebble Crab', tier: 1, color: 0xe08c4f, shape: 'crawler' },
  { id: 'wolf', name: 'Wolf', tier: 2, color: 0x8a8d93, shape: 'quadruped' },
  { id: 'goblin', name: 'Goblin', tier: 2, color: 0x6aa84f, shape: 'biped' },
  { id: 'bat', name: 'Cave Bat', tier: 2, color: 0x5b4a6b, shape: 'flyer' },
  { id: 'spider', name: 'Spider', tier: 2, color: 0x3d3d3d, shape: 'crawler' },
  { id: 'bandit', name: 'Bandit', tier: 3, color: 0x7a5c3a, shape: 'biped' },
  { id: 'skeleton', name: 'Skeleton', tier: 3, color: 0xd8d4c8, shape: 'biped' },
  { id: 'imp', name: 'Ember Imp', tier: 3, color: 0xc4452b, shape: 'biped' },
  { id: 'golem', name: 'Stone Golem', tier: 4, color: 0x6e6e78, shape: 'biped' },
  { id: 'orc', name: 'Orc', tier: 4, color: 0x4f7a45, shape: 'biped' },
  { id: 'wisp', name: 'Grave Wisp', tier: 4, color: 0x7fd4ff, shape: 'flyer' },
] as const

/** One named boss per combat region. */
export const BOSSES: readonly { id: string; name: string; regionId: string; species: string; level: number }[] = [
  { id: 'boss_greenwood', name: 'Alpha Direwolf', regionId: 'greenwood', species: 'wolf', level: 14 },
  { id: 'boss_ironhold', name: 'Gravelord Golem', regionId: 'ironhold', species: 'golem', level: 20 },
  { id: 'boss_ashen', name: 'Skeleton King', regionId: 'ashen', species: 'skeleton', level: 27 },
  { id: 'boss_forgotten', name: 'Warchief Grukk', regionId: 'forgotten', species: 'orc', level: 42 },
] as const

/** NPCs (quest givers, vendors, flavor). Placed by the NPC module near these anchors. */
export interface NpcDef {
  id: string
  name: string
  role: 'quests' | 'vendor' | 'trainer' | 'flavor'
  regionId: string
  /** Preferred anchor position (module nudges to walkable). */
  x: number
  z: number
}

export const NPCS: readonly NpcDef[] = [
  { id: 'elder_rowan', name: 'Elder Rowan', role: 'quests', regionId: 'beginnings', x: 3, z: -6 },
  { id: 'merchant_hilda', name: 'Merchant Hilda', role: 'vendor', regionId: 'beginnings', x: 8, z: 7 },
  { id: 'farmer_bram', name: 'Farmer Bram', role: 'quests', regionId: 'beginnings', x: -14, z: 16 },
  { id: 'guard_tomas', name: 'Guard Tomas', role: 'flavor', regionId: 'beginnings', x: 0, z: 20 },
  { id: 'scout_wren', name: 'Scout Wren', role: 'quests', regionId: 'greenwood', x: 110, z: 0 },
  { id: 'herbalist_moss', name: 'Herbalist Moss', role: 'vendor', regionId: 'greenwood', x: 150, z: 40 },
  { id: 'ranger_kael', name: 'Ranger Kael', role: 'trainer', regionId: 'greenwood', x: 190, z: -60 },
  { id: 'foreman_dagna', name: 'Foreman Dagna', role: 'quests', regionId: 'ironhold', x: -120, z: 0 },
  { id: 'smith_orin', name: 'Smith Orin', role: 'trainer', regionId: 'ironhold', x: -150, z: 30 },
  { id: 'prospector_finn', name: 'Prospector Finn', role: 'vendor', regionId: 'ironhold', x: -190, z: -40 },
  { id: 'captain_elara', name: 'Captain Elara', role: 'quests', regionId: 'capital', x: 0, z: -150 },
  { id: 'banker_aldous', name: 'Banker Aldous', role: 'vendor', regionId: 'capital', x: 20, z: -170 },
  { id: 'mage_lyra', name: 'Archmage Lyra', role: 'trainer', regionId: 'capital', x: -30, z: -190 },
  { id: 'gravekeeper_sol', name: 'Gravekeeper Sol', role: 'quests', regionId: 'ashen', x: -120, z: 170 },
  { id: 'hermit_vex', name: 'Hermit Vex', role: 'quests', regionId: 'forgotten', x: 120, z: 180 },
  // --- wave-3 appends: outer-zone outpost NPCs, parked at real landmarks ---
  // (regionId is the ZONE id for these; coords sit beside the landmark props)
  { id: 'survivor_petra', name: 'Petra the Previous', role: 'quests', regionId: 'brainfreeze', x: -546, z: -597 }, // Camp Bad Idea
  { id: 'lookout_grettel', name: 'Grettel of the Last Laugh', role: 'flavor', regionId: 'nope_shelf', x: -648, z: -632 }, // the frozen pirate ship
  { id: 'prophet_karl', name: 'Prophet Karl (Whale-Certified)', role: 'quests', regionId: 'glacier_point', x: 628, z: -584 }, // Moby's Last Laugh
  { id: 'maestro_ribbert', name: 'Maestro Ribbert', role: 'quests', regionId: 'drizzlemire', x: -660, z: 148 }, // the Frog Choir
  { id: 'tadpole_tony', name: 'Tadpole Tony, Grudge Notary', role: 'flavor', regionId: 'croakening', x: -556, z: 414 }, // Big Gerald's sign
  { id: 'honest_jim', name: 'Honest Jim', role: 'quests', regionId: 'mirage_mile', x: -32, z: 464 }, // the Mirage Emporium
  { id: 'shardwarden_igor', name: 'Shard-Warden Igor', role: 'quests', regionId: 'prism_break', x: -536, z: 4 }, // the Great Refractor
  { id: 'inspector_flora', name: 'Dormancy Inspector Flora', role: 'quests', regionId: 'simmering_steps', x: 556, z: 464 }, // Dormancy Verification Station
] as const

/** Teleport waystones: attune by touching, then travel between any attuned pair. */
export const WAYSTONES: readonly { id: string; name: string; regionId: string; x: number; z: number }[] = [
  { id: 'ws_village', name: 'Village Waystone', regionId: 'beginnings', x: 6, z: -2 },
  { id: 'ws_greenwood', name: 'Greenwood Waystone', regionId: 'greenwood', x: 130, z: 10 },
  { id: 'ws_ironhold', name: 'Ironhold Waystone', regionId: 'ironhold', x: -130, z: 10 },
  { id: 'ws_capital', name: 'Capital Waystone', regionId: 'capital', x: 6, z: -140 },
  { id: 'ws_ashen', name: 'Ashen Waystone', regionId: 'ashen', x: -110, z: 150 },
  { id: 'ws_forgotten', name: 'Forgotten Waystone', regionId: 'forgotten', x: 110, z: 150 },
] as const

/** Resource node kinds for gathering professions. */
export const NODE_KINDS: readonly { id: string; skill: string; itemId: string; name: string }[] = [
  { id: 'copper_vein', skill: 'mining', itemId: 'ore_copper', name: 'Copper Vein' },
  { id: 'iron_vein', skill: 'mining', itemId: 'ore_iron', name: 'Iron Vein' },
  { id: 'gold_vein', skill: 'mining', itemId: 'ore_gold', name: 'Gold Vein' },
  { id: 'crystal_node', skill: 'mining', itemId: 'crystal_raw', name: 'Rare Crystal' },
  { id: 'oak_tree', skill: 'woodcutting', itemId: 'wood_oak', name: 'Oak Tree' },
  { id: 'pine_tree', skill: 'woodcutting', itemId: 'wood_pine', name: 'Pine Tree' },
  { id: 'fishing_spot', skill: 'fishing', itemId: 'fish_raw', name: 'Fishing Spot' },
  { id: 'herb_patch', skill: 'herbalism', itemId: 'herb_green', name: 'Herb Patch' },
  { id: 'farm_plot', skill: 'farming', itemId: 'wheat', name: 'Farm Plot' },
  // wave-2 appends:
  { id: 'berry_bush', skill: 'herbalism', itemId: 'berry_red', name: 'Berry Bush' },
  { id: 'mushroom_cluster', skill: 'herbalism', itemId: 'mushroom_brown', name: 'Mushroom Cluster' },
  { id: 'clay_pit', skill: 'mining', itemId: 'clay_lump', name: 'Clay Pit' },
] as const

/**
 * Skill ids. Combat skills level from fighting; professions from gathering/crafting.
 */
export const SKILLS = [
  'attack', 'defense', 'magic', 'vitality',
  'mining', 'woodcutting', 'fishing', 'farming', 'herbalism',
  'blacksmithing', 'cooking', 'alchemy', 'tailoring',
] as const
export type SkillId = (typeof SKILLS)[number]

/**
 * Item id conventions (items module owns the full catalog):
 *   weapons  sword_<material>, axe_<material>, bow_<wood>, staff_<kind>
 *   armor    helm_/chest_/boots_<material>, shield_<material>
 *   tools    pick_<material>, hatchet_<material>, rod_basic
 *   mats     ore_*, bar_*, wood_*, herb_*, fish_*, hide_*, crystal_*
 *   consum.  food_*, potion_*
 * Materials ladder: copper, iron, steel, gold, crystal, mythic (maps to the
 * six rarity tiers common..mythical).
 */
export const MATERIALS = ['copper', 'iron', 'steel', 'gold', 'crystal', 'mythic'] as const

/* ========================================================================== *
 *  WAVE-2 APPENDS — pet catalog.                                             *
 * ========================================================================== */

import type { PetDef, PetVariant } from './types'

/** Canonical pet id for a catalog entry: `${species}.${variant}`. */
export function petIdOf(species: string, variant: PetVariant): string {
  return `${species}.${variant}`
}

/**
 * The full pet catalog: every SPECIES in base + ember + snow + one prestige
 * variant (golden or shadow, alternating by species), plus one unique baby
 * pet per region boss (variant 'boss', drops from that boss only).
 *
 * Drop model: on a qualifying kill of the species, each variant rolls
 * independently at 1-in-`dropOneIn` (base ~1/400, ember/snow ~1/1200,
 * golden/shadow ~1/3000, boss babies 1/40 off the boss itself).
 * A drop emits 'pet:dropped' and creates a PetInstance with a fresh uid.
 */
export const PET_VARIANTS: readonly PetDef[] = [
  // slime
  { species: 'slime', variant: 'base', name: 'Goober', dropOneIn: 400 },
  { species: 'slime', variant: 'ember', name: 'Crème Goulée', dropOneIn: 1200 },
  { species: 'slime', variant: 'snow', name: 'Slushie', dropOneIn: 1200 },
  { species: 'slime', variant: 'golden', name: '24-Karat Goober', dropOneIn: 3000 },
  // mushroom
  { species: 'mushroom', variant: 'base', name: 'Button', dropOneIn: 400 },
  { species: 'mushroom', variant: 'ember', name: 'Lil\' Sauté', dropOneIn: 1200 },
  { species: 'mushroom', variant: 'snow', name: 'Frostcap', dropOneIn: 1200 },
  { species: 'mushroom', variant: 'shadow', name: 'Portobello Noir', dropOneIn: 3000 },
  // crab
  { species: 'crab', variant: 'base', name: 'Sir Pinchley', dropOneIn: 400 },
  { species: 'crab', variant: 'ember', name: 'Crab Rangoon', dropOneIn: 1200 },
  { species: 'crab', variant: 'snow', name: 'Cold Snap', dropOneIn: 1200 },
  { species: 'crab', variant: 'golden', name: 'The Gilded Pinch', dropOneIn: 3000 },
  // wolf
  { species: 'wolf', variant: 'base', name: 'Pupper', dropOneIn: 400 },
  { species: 'wolf', variant: 'ember', name: 'Hot Dog', dropOneIn: 1200 },
  { species: 'wolf', variant: 'snow', name: 'Pupsicle', dropOneIn: 1200 },
  { species: 'wolf', variant: 'shadow', name: 'Midnight Zoomies', dropOneIn: 3000 },
  // goblin
  { species: 'goblin', variant: 'base', name: 'Dave', dropOneIn: 400 },
  { species: 'goblin', variant: 'ember', name: 'Spicy Dave', dropOneIn: 1200 },
  { species: 'goblin', variant: 'snow', name: 'Cool Dave', dropOneIn: 1200 },
  { species: 'goblin', variant: 'golden', name: 'Tax-Bracket Dave', dropOneIn: 3000 },
  // bat
  { species: 'bat', variant: 'base', name: 'Flappy', dropOneIn: 400 },
  { species: 'bat', variant: 'ember', name: 'Hot Wing', dropOneIn: 1200 },
  { species: 'bat', variant: 'snow', name: 'Freezer Wing', dropOneIn: 1200 },
  { species: 'bat', variant: 'shadow', name: 'Echo (Location Unknown)', dropOneIn: 3000 },
  // spider
  { species: 'spider', variant: 'base', name: 'Sir Legs-a-Lot', dropOneIn: 400 },
  { species: 'spider', variant: 'ember', name: 'Toasty Toes', dropOneIn: 1200 },
  { species: 'spider', variant: 'snow', name: 'Cold Feet', dropOneIn: 1200 },
  { species: 'spider', variant: 'golden', name: 'Silk Road', dropOneIn: 3000 },
  // bandit
  { species: 'bandit', variant: 'base', name: 'Petty Theft', dropOneIn: 400 },
  { species: 'bandit', variant: 'ember', name: 'Arson-Adjacent', dropOneIn: 1200 },
  { species: 'bandit', variant: 'snow', name: 'Cold Case', dropOneIn: 1200 },
  { species: 'bandit', variant: 'shadow', name: 'Plausible Deniability', dropOneIn: 3000 },
  // skeleton
  { species: 'skeleton', variant: 'base', name: 'Rattles', dropOneIn: 400 },
  { species: 'skeleton', variant: 'ember', name: 'Extra Crispy', dropOneIn: 1200 },
  { species: 'skeleton', variant: 'snow', name: 'Freezer Burn', dropOneIn: 1200 },
  { species: 'skeleton', variant: 'golden', name: 'Trust-Fund Boney', dropOneIn: 3000 },
  // imp
  { species: 'imp', variant: 'base', name: 'Lil\' Problem', dropOneIn: 400 },
  { species: 'imp', variant: 'ember', name: 'Slightly Bigger Problem', dropOneIn: 1200 },
  { species: 'imp', variant: 'snow', name: 'Imp on Ice', dropOneIn: 1200 },
  { species: 'imp', variant: 'shadow', name: 'The Fine Print', dropOneIn: 3000 },
  // golem
  { species: 'golem', variant: 'base', name: 'Chip', dropOneIn: 400 },
  { species: 'golem', variant: 'ember', name: 'Briquette', dropOneIn: 1200 },
  { species: 'golem', variant: 'snow', name: 'Permafrost Chip', dropOneIn: 1200 },
  { species: 'golem', variant: 'golden', name: 'Load-Bearing Investment', dropOneIn: 3000 },
  // orc
  { species: 'orc', variant: 'base', name: 'Grunk Jr.', dropOneIn: 400 },
  { species: 'orc', variant: 'ember', name: 'Spicy Grunk', dropOneIn: 1200 },
  { species: 'orc', variant: 'snow', name: 'Chilled Grunk', dropOneIn: 1200 },
  { species: 'orc', variant: 'shadow', name: 'Night-Shift Grunk', dropOneIn: 3000 },
  // wisp
  { species: 'wisp', variant: 'base', name: 'Nightlight', dropOneIn: 400 },
  { species: 'wisp', variant: 'ember', name: 'Fire Hazard', dropOneIn: 1200 },
  { species: 'wisp', variant: 'snow', name: 'Cold Glow', dropOneIn: 1200 },
  { species: 'wisp', variant: 'golden', name: 'The Electric Bill', dropOneIn: 3000 },
  // boss babies (one per region boss; drop from that boss only)
  { species: 'wolf', variant: 'boss', name: 'Beta Direpup', dropOneIn: 40 },
  { species: 'golem', variant: 'boss', name: 'Gravel Intern', dropOneIn: 40 },
  { species: 'skeleton', variant: 'boss', name: 'Skeleton Prince (Unpaid)', dropOneIn: 40 },
  { species: 'orc', variant: 'boss', name: "Grukk's Nephew Kevin", dropOneIn: 40 },
] as const

/** Lookup a catalog entry by canonical petId (`species.variant`). */
export function petDef(petId: string): PetDef | undefined {
  const dot = petId.indexOf('.')
  if (dot < 0) return undefined
  const species = petId.slice(0, dot)
  const variant = petId.slice(dot + 1)
  return PET_VARIANTS.find((p) => p.species === species && p.variant === variant)
}
