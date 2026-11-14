/**
 * World-map authored data — everything the map draws that isn't in ids.ts.
 *
 * ROUTES mirrors the hand-placed continental road waypoints the world module
 * stamps into the terrain (src/world/roads.ts). Modules must not import each
 * other, so the waypoint DATA is duplicated here; if the world's roads ever
 * move, update this copy to match.
 */

export interface Pt {
  x: number
  z: number
}

/** [x, z] waypoint chains, village gates → each region waystone. */
export const ROUTES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  // East over the bridge → Greenwood Waystone
  [[54, 0], [68, 6], [86, -4], [104, 14], [120, 2], [130, 10]],
  // West gate → Ironhold Waystone
  [[-40, 0], [-58, 8], [-76, -6], [-96, 10], [-116, -2], [-130, 10]],
  // North gate → Capital Waystone
  [[0, -40], [7, -62], [-5, -86], [9, -108], [-2, -126], [6, -140]],
  // South gate → south-west → Ashen Waystone
  [[-1, 40], [-14, 58], [-30, 74], [-52, 90], [-72, 108], [-88, 126], [-102, 140], [-110, 150]],
  // South gate → south-east over the south bridge → Forgotten Waystone
  [[1, 40], [12, 58], [26, 72], [38, 84], [48, 91], [58, 94], [72, 104], [88, 122], [100, 138], [110, 150]]
]

/** The great river: a north→south band centred on x≈48 (world units). */
export const RIVER_CENTER_X = 48
export const RIVER_WIDTH = 9

/** Bridge decks crossing the river (world-unit centres). */
export const BRIDGES: readonly Pt[] = [
  { x: 48, z: 0 },
  { x: 48, z: 91 }
]

/** Hand-picked boss-lair map positions, keyed by boss id (ids.ts BOSSES). */
export const BOSS_SPOTS: Readonly<Record<string, Pt>> = {
  boss_greenwood: { x: 205, z: 75 },
  boss_ironhold: { x: -205, z: -75 },
  boss_ashen: { x: -190, z: 205 },
  boss_forgotten: { x: 185, z: 215 }
}

/** Flat biome fill colors for the parchment map (cozy, muted). */
export const BIOME_FILL: Readonly<Record<string, string>> = {
  meadow: '#96bf70',
  forest: '#5f9154',
  mountain: '#9c9ca6',
  city: '#c9b893',
  dungeon: '#806d88',
  wastes: '#bf9c68'
}

/** Slightly darker biome shades for the mini-map ground. */
export const BIOME_MINI: Readonly<Record<string, string>> = {
  meadow: '#44663a',
  forest: '#32522e',
  mountain: '#4e4e58',
  city: '#5f5a44',
  dungeon: '#3e3346',
  wastes: '#5e4c33'
}

/** World extent the map frames (REGIONS span -240..240 on both axes). */
export const MAP_MIN = -252
export const MAP_MAX = 252
