/**
 * World-map authored data — everything the map draws that isn't in ids.ts
 * or the wilderness zone registry.
 *
 * ROUTES mirrors the hand-placed continental road waypoints the world module
 * stamps into the terrain (src/world/roads.ts). Modules must not import each
 * other, so the waypoint DATA is duplicated here; if the world's roads ever
 * move, update this copy to match.
 */
import { WAYSTONES } from '../ids'
import { ZONES } from '../world/zones/registry'

export interface Pt {
  x: number
  z: number
}

/** Every waystone on the continent: 6 heart stones + 14 zone stones. */
export const ALL_WAYSTONES: readonly { id: string; name: string; x: number; z: number }[] = [
  ...WAYSTONES.map((w) => ({ id: w.id, name: w.name, x: w.x, z: w.z })),
  ...ZONES.filter((zn) => zn.waystone).map((zn) => ({
    id: zn.waystone!.id,
    name: zn.waystone!.name,
    x: zn.waystone!.x,
    z: zn.waystone!.z
  }))
]

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

/** Flat biome fill colors for the parchment map (cozy, muted) — all 20. */
export const BIOME_FILL: Readonly<Record<string, string>> = {
  meadow: '#96bf70',
  forest: '#5f9154',
  mountain: '#9c9ca6',
  city: '#c9b893',
  dungeon: '#806d88',
  wastes: '#bf9c68',
  swamp: '#71915e',
  desert: '#dfc37e',
  tundra: '#c6d2cc',
  volcanic: '#b06a52',
  crystal: '#a5b4d6',
  ruins: '#a8a08a',
  beach: '#e3d49e',
  mushroom: '#bf8ca6',
  cherry: '#e5aec4',
  savanna: '#cdb86a',
  canyon: '#c78f5f',
  lagoon: '#7fc4c9',
  graveyard: '#8b8f84',
  glacier: '#d7e4ea'
}

/** Slightly darker biome shades for the mini-map ground — all 20. */
export const BIOME_MINI: Readonly<Record<string, string>> = {
  meadow: '#44663a',
  forest: '#32522e',
  mountain: '#4e4e58',
  city: '#5f5a44',
  dungeon: '#3e3346',
  wastes: '#5e4c33',
  swamp: '#39482e',
  desert: '#6e5e3a',
  tundra: '#5a6662',
  volcanic: '#5c3328',
  crystal: '#49536e',
  ruins: '#55503f',
  beach: '#6f6448',
  mushroom: '#5e4152',
  cherry: '#6e4a58',
  savanna: '#665a30',
  canyon: '#5f4228',
  lagoon: '#2f5d5f',
  graveyard: '#46493f',
  glacier: '#5f707a'
}

/** Land extends to the coast at |x|,|z| = 720; beyond that, sea. */
export const WORLD_HALF = 720
/** World extent the map frames (land + a ribbon of sea). */
export const MAP_MIN = -744
export const MAP_MAX = 744
/** The great river only flows through the heart (z band, world units). */
export const RIVER_Z0 = -240
export const RIVER_Z1 = 240
