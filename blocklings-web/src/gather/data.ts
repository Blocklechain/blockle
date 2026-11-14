/**
 * Gathering data tables: per-node-kind tuning (tool gating, speed, xp,
 * yield) + where nodes are placed across the continent.
 *
 * Tool-id conventions come from src/ids.ts: pick_<material>,
 * hatchet_<material>, rod_basic; MATERIALS is the copper..mythic ladder.
 */
import { MATERIALS } from '../ids'

/** Tool families the gather skills care about. */
export type ToolFamily = 'pick' | 'hatchet' | 'rod'

/**
 * How a node visually dies when harvested:
 *  - topple  — trunk + canopy fall over (stump keeps), tree-style
 *  - crumble — mound collapses into a rubble scatter, ore-style
 *  - pause   — fish ring stops bobbing and shrinks (still visible)
 *  - wilt    — plant shrinks away; a sad wilted remnant shows
 */
export type DepleteStyle = 'topple' | 'crumble' | 'pause' | 'wilt'

/** Per-kind gameplay tuning, keyed by NODE_KINDS id. */
export interface KindTuning {
  /** Prompt verb ("Mine", "Chop", ...). */
  verb: string
  /** Required tool family, or null = bare hands welcome. */
  tool: ToolFamily | null
  /**
   * Minimum material tier (index into MATERIALS) the tool must be.
   * Ignored for rods (any rod works) and tool-less kinds.
   */
  minTier: number
  /** Skill xp per successful harvest. */
  xp: number
  /** Items per harvest. */
  qty: number
  /** Depletion animation style. */
  style: DepleteStyle
  /** Respawn window [min, max] seconds — per kind, jittered per harvest. */
  respawn: readonly [number, number]
}

export const TUNING: Record<string, KindTuning> = {
  copper_vein: { verb: 'Mine', tool: 'pick', minTier: 0, xp: 8, qty: 1, style: 'crumble', respawn: [28, 36] },
  iron_vein: { verb: 'Mine', tool: 'pick', minTier: 1, xp: 14, qty: 1, style: 'crumble', respawn: [32, 42] },
  gold_vein: { verb: 'Mine', tool: 'pick', minTier: 3, xp: 24, qty: 1, style: 'crumble', respawn: [45, 60] },
  crystal_node: { verb: 'Mine', tool: 'pick', minTier: 4, xp: 40, qty: 1, style: 'crumble', respawn: [70, 95] },
  oak_tree: { verb: 'Chop', tool: 'hatchet', minTier: 0, xp: 8, qty: 1, style: 'topple', respawn: [45, 60] },
  pine_tree: { verb: 'Chop', tool: 'hatchet', minTier: 1, xp: 13, qty: 1, style: 'topple', respawn: [50, 65] },
  fishing_spot: { verb: 'Fish', tool: 'rod', minTier: 0, xp: 12, qty: 1, style: 'pause', respawn: [10, 16] },
  herb_patch: { verb: 'Pick', tool: null, minTier: 0, xp: 10, qty: 1, style: 'wilt', respawn: [26, 34] },
  farm_plot: { verb: 'Harvest', tool: null, minTier: 0, xp: 7, qty: 2, style: 'wilt', respawn: [40, 52] },
  // wave-2 node kinds (ids.ts appends)
  berry_bush: { verb: 'Pick', tool: null, minTier: 0, xp: 9, qty: 2, style: 'wilt', respawn: [26, 34] },
  mushroom_cluster: { verb: 'Forage', tool: null, minTier: 0, xp: 11, qty: 1, style: 'wilt', respawn: [30, 40] },
  clay_pit: { verb: 'Dig', tool: null, minTier: 0, xp: 9, qty: 1, style: 'wilt', respawn: [22, 30] }
}

/** Base harvest time; each tool tier above the requirement shaves 0.15s. */
export const BASE_TIME = 1.8
export const TIME_PER_TIER = 0.15
export const MIN_TIME = 1.0

/** Fallback respawn window for kinds missing a `respawn` entry. */
export const RESPAWN_MIN = 28
export const RESPAWN_MAX = 34

/** How close (world units) the player must be to interact. */
export const INTERACT_RADIUS = 2.6

/**
 * Parse an equipped tool id into family + material tier.
 * 'pick_iron' -> {family:'pick', tier:1}; 'rod_basic' -> {family:'rod', tier:0}.
 */
export function parseTool(id: string | null | undefined): { family: ToolFamily; tier: number } | null {
  if (!id) return null
  const us = id.indexOf('_')
  if (us < 0) return null
  const family = id.slice(0, us)
  if (family !== 'pick' && family !== 'hatchet' && family !== 'rod') return null
  const mat = id.slice(us + 1)
  const tier = (MATERIALS as readonly string[]).indexOf(mat)
  return { family, tier: tier < 0 ? 0 : tier }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Scatter `count` nodes of `kind` inside a circle (walkable cells only). */
export interface ClusterSpec {
  kind: string
  cx: number
  cz: number
  r: number
  count: number
}

/**
 * Cluster placements. Ore hugs the Ironhold ranges (plus a few scorched
 * veins in Ashen); trees fill Greenwood and the Beginnings tree-line;
 * herb glades hide in Greenwood with a starter pair near the village.
 */
export const CLUSTERS: readonly ClusterSpec[] = [
  // --- Ironhold Mountains: the mining heartland
  { kind: 'copper_vein', cx: -110, cz: -40, r: 12, count: 5 },
  { kind: 'copper_vein', cx: -130, cz: 60, r: 12, count: 5 },
  { kind: 'iron_vein', cx: -160, cz: -20, r: 12, count: 5 },
  { kind: 'iron_vein', cx: -170, cz: 70, r: 10, count: 3 },
  { kind: 'gold_vein', cx: -200, cz: -70, r: 10, count: 4 },
  { kind: 'crystal_node', cx: -215, cz: 30, r: 8, count: 2 },
  // --- Ashen Dungeons: scorched late-game veins
  { kind: 'iron_vein', cx: -60, cz: 160, r: 10, count: 4 },
  { kind: 'gold_vein', cx: -150, cz: 200, r: 10, count: 3 },
  { kind: 'crystal_node', cx: -200, cz: 160, r: 8, count: 3 },
  // --- Greenwood Forest: lumber + herb glades
  { kind: 'oak_tree', cx: 110, cz: -30, r: 20, count: 5 },
  { kind: 'oak_tree', cx: 150, cz: 60, r: 20, count: 5 },
  { kind: 'oak_tree', cx: 200, cz: -70, r: 18, count: 4 },
  { kind: 'pine_tree', cx: 210, cz: 30, r: 20, count: 5 },
  { kind: 'pine_tree', cx: 170, cz: -90, r: 16, count: 5 },
  { kind: 'herb_patch', cx: 125, cz: 35, r: 8, count: 4 },
  { kind: 'herb_patch', cx: 185, cz: 80, r: 8, count: 4 },
  // --- Kingdom of Beginnings edges: starter trees + herbs outside the fence
  { kind: 'oak_tree', cx: -60, cz: 50, r: 10, count: 3 },
  { kind: 'oak_tree', cx: -50, cz: -60, r: 10, count: 3 },
  { kind: 'herb_patch', cx: 20, cz: -60, r: 6, count: 2 }
] as const

/**
 * Fixed anchors (stand cell) for nodes that must sit on specific terrain.
 * Fishing: the river runs x 44..52 top to bottom; banks are x=43 / x=53.
 * `ox/oz` offsets the visual (the bobbing ring floats over the water).
 * Farm plots: just south of the village farm's fence (the farm itself is
 * fenced shut — Farmer Bram guards his cabbages like a dragon).
 */
export interface FixedSpec {
  kind: string
  x: number
  z: number
  ox?: number
  oz?: number
}

// ---------------------------------------------------------------------------
// Streamed-zone density pass — per-biome node mixes
// ---------------------------------------------------------------------------

/**
 * One entry of a biome's node mix: place rng-rolled [min..max] nodes of
 * `kind` in the zone. `water: true` = needs a waterline cell (fish rings).
 */
export interface ZoneMix {
  kind: string
  min: number
  max: number
  water?: boolean
}

/**
 * Biome -> node mix for the 90 streamed wilderness zones. Totals land in
 * the ~10-18/zone band. Ores hug mountain/volcanic/canyon (+ harsh biomes),
 * trees fill everything green, fish ring lagoon/beach shores, herbs grow in
 * forest/swamp, berries in meadow/cherry, clay in swamp/lagoon, mushrooms
 * in mushroom/forest — per the wave-2 brief.
 */
export const BIOME_NODES: Record<string, readonly ZoneMix[]> = {
  meadow: [
    { kind: 'oak_tree', min: 4, max: 5 },
    { kind: 'pine_tree', min: 1, max: 2 },
    { kind: 'berry_bush', min: 4, max: 5 },
    { kind: 'herb_patch', min: 2, max: 3 }
  ],
  forest: [
    { kind: 'oak_tree', min: 5, max: 6 },
    { kind: 'pine_tree', min: 3, max: 4 },
    { kind: 'herb_patch', min: 3, max: 4 },
    { kind: 'mushroom_cluster', min: 2, max: 3 }
  ],
  cherry: [
    { kind: 'oak_tree', min: 4, max: 5 },
    { kind: 'berry_bush', min: 5, max: 6 },
    { kind: 'herb_patch', min: 2, max: 3 }
  ],
  savanna: [
    { kind: 'oak_tree', min: 6, max: 7 },
    { kind: 'herb_patch', min: 3, max: 4 },
    { kind: 'berry_bush', min: 1, max: 2 }
  ],
  swamp: [
    { kind: 'herb_patch', min: 4, max: 5 },
    { kind: 'clay_pit', min: 4, max: 5 },
    { kind: 'mushroom_cluster', min: 2, max: 3 },
    { kind: 'oak_tree', min: 1, max: 2 }
  ],
  mushroom: [
    { kind: 'mushroom_cluster', min: 7, max: 8 },
    { kind: 'herb_patch', min: 2, max: 3 },
    { kind: 'oak_tree', min: 1, max: 2 }
  ],
  mountain: [
    { kind: 'copper_vein', min: 3, max: 4 },
    { kind: 'iron_vein', min: 3, max: 4 },
    { kind: 'gold_vein', min: 2, max: 3 },
    { kind: 'crystal_node', min: 1, max: 1 },
    { kind: 'pine_tree', min: 2, max: 3 }
  ],
  volcanic: [
    { kind: 'copper_vein', min: 2, max: 3 },
    { kind: 'iron_vein', min: 3, max: 4 },
    { kind: 'gold_vein', min: 3, max: 4 },
    { kind: 'crystal_node', min: 2, max: 3 }
  ],
  canyon: [
    { kind: 'copper_vein', min: 4, max: 5 },
    { kind: 'iron_vein', min: 3, max: 4 },
    { kind: 'gold_vein', min: 3, max: 4 }
  ],
  crystal: [
    { kind: 'crystal_node', min: 5, max: 6 },
    { kind: 'gold_vein', min: 2, max: 3 },
    { kind: 'iron_vein', min: 2, max: 3 },
    { kind: 'pine_tree', min: 1, max: 2 }
  ],
  lagoon: [
    { kind: 'fishing_spot', min: 5, max: 6, water: true },
    { kind: 'clay_pit', min: 3, max: 4 },
    { kind: 'oak_tree', min: 2, max: 3 },
    { kind: 'herb_patch', min: 1, max: 2 }
  ],
  beach: [
    { kind: 'fishing_spot', min: 6, max: 8, water: true },
    { kind: 'oak_tree', min: 2, max: 3 },
    { kind: 'herb_patch', min: 2, max: 3 }
  ],
  tundra: [
    { kind: 'pine_tree', min: 5, max: 6 },
    { kind: 'iron_vein', min: 2, max: 3 },
    { kind: 'copper_vein', min: 2, max: 3 },
    { kind: 'mushroom_cluster', min: 1, max: 2 }
  ],
  glacier: [
    { kind: 'pine_tree', min: 2, max: 3 },
    { kind: 'iron_vein', min: 3, max: 4 },
    { kind: 'crystal_node', min: 2, max: 3 },
    { kind: 'copper_vein', min: 3, max: 3 }
  ],
  desert: [
    { kind: 'gold_vein', min: 4, max: 5 },
    { kind: 'copper_vein', min: 3, max: 4 },
    { kind: 'iron_vein', min: 2, max: 3 },
    { kind: 'crystal_node', min: 1, max: 2 }
  ],
  wastes: [
    { kind: 'iron_vein', min: 4, max: 5 },
    { kind: 'copper_vein', min: 3, max: 4 },
    { kind: 'mushroom_cluster', min: 2, max: 3 },
    { kind: 'gold_vein', min: 1, max: 2 }
  ],
  dungeon: [
    { kind: 'iron_vein', min: 4, max: 4 },
    { kind: 'gold_vein', min: 2, max: 3 },
    { kind: 'crystal_node', min: 2, max: 3 },
    { kind: 'mushroom_cluster', min: 2, max: 3 }
  ],
  ruins: [
    { kind: 'oak_tree', min: 2, max: 3 },
    { kind: 'iron_vein', min: 2, max: 3 },
    { kind: 'gold_vein', min: 2, max: 3 },
    { kind: 'herb_patch', min: 2, max: 3 },
    { kind: 'mushroom_cluster', min: 2, max: 3 }
  ],
  city: [
    { kind: 'oak_tree', min: 4, max: 5 },
    { kind: 'herb_patch', min: 3, max: 4 },
    { kind: 'berry_bush', min: 3, max: 4 }
  ],
  graveyard: [
    { kind: 'mushroom_cluster', min: 4, max: 5 },
    { kind: 'herb_patch', min: 3, max: 4 },
    { kind: 'oak_tree', min: 2, max: 3 },
    { kind: 'iron_vein', min: 1, max: 2 }
  ]
}

export const FIXED: readonly FixedSpec[] = [
  // Fishing — Beginnings stretch of the river (both banks, clear of bridges)
  { kind: 'fishing_spot', x: 43, z: -20, ox: 1.6 },
  { kind: 'fishing_spot', x: 43, z: 30, ox: 1.6 },
  { kind: 'fishing_spot', x: 53, z: 10, ox: -1.6 },
  { kind: 'fishing_spot', x: 53, z: 55, ox: -1.6 },
  { kind: 'fishing_spot', x: 43, z: 70, ox: 1.6 },
  // Fishing — Capital stretch
  { kind: 'fishing_spot', x: 43, z: -120, ox: 1.6 },
  { kind: 'fishing_spot', x: 53, z: -160, ox: -1.6 },
  // Fishing — Forgotten Lands stretch
  { kind: 'fishing_spot', x: 53, z: 130, ox: -1.6 },
  { kind: 'fishing_spot', x: 43, z: 170, ox: 1.6 },
  { kind: 'fishing_spot', x: 53, z: 200, ox: -1.6 },
  // Farm plots — south of the village farm fence (fence row is z=26)
  { kind: 'farm_plot', x: -28, z: 28 },
  { kind: 'farm_plot', x: -25, z: 28 },
  { kind: 'farm_plot', x: -22, z: 28 },
  { kind: 'farm_plot', x: -28, z: 31 },
  { kind: 'farm_plot', x: -25, z: 31 },
  { kind: 'farm_plot', x: -22, z: 31 }
] as const
