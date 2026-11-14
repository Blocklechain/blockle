/**
 * Village layout — every structure's footprint in one place, shared by the
 * terrain pass (paths/surfaces) and the structure pass (buildings).
 * All coordinates are voxel-grid cells (min corner), world units.
 */
import type { CollisionGrid } from './collision'
import type { Rng } from './rng'
import type { VoxelBatch } from './batch'

/** Surface classification per ground cell. */
export const S_GRASS = 0
export const S_COBBLE = 1
export const S_RIVER = 2
export const S_BANK = 3
export const S_SOIL = 4
export const S_BRIDGE = 5
export const S_SAND = 6

export interface Rect {
  x0: number
  z0: number
  w: number
  d: number
}

export type DoorSide = 'N' | 'S' | 'E' | 'W'

export interface BuildingSpec extends Rect {
  wallH: number
  door: DoorSide
  /** Extra cobble spur connecting the door to a main road. */
  spur?: Rect
  chimney?: boolean
}

/** Fence ring half-extent and gate half-width. */
export const FENCE_R = 38
export const GATE_HALF = 2

/** River band (cells, inclusive) and the bridge crossing it. */
export const RIVER_X0 = 44
export const RIVER_X1 = 52
export const BRIDGE: Rect = { x0: 42, z0: -3, w: 13, d: 6 } // outer rows are railings

export const PLAZA_RADIUS = 9

export const BUILDINGS: readonly BuildingSpec[] = [
  // The Sleeping Blockling Inn — biggest building, NW of the plaza
  { x0: -22, z0: -16, w: 10, d: 8, wallH: 4, door: 'E', spur: { x0: -12, z0: -13, w: 11, d: 2 }, chimney: true },
  // Blacksmith — NE
  { x0: 12, z0: -18, w: 8, d: 6, wallH: 3, door: 'W', spur: { x0: 2, z0: -16, w: 10, d: 2 }, chimney: true },
  // Elder's Hall — north end of the main road, tall roof
  { x0: -5, z0: -30, w: 9, d: 8, wallH: 5, door: 'S' },
  // Cottage A — SW
  { x0: -20, z0: 8, w: 7, d: 6, wallH: 3, door: 'E', spur: { x0: -13, z0: 10, w: 12, d: 2 }, chimney: true },
  // Cottage B — SE
  { x0: 14, z0: 10, w: 7, d: 6, wallH: 3, door: 'W', spur: { x0: 2, z0: 12, w: 12, d: 2 } },
  // Cottage C — by the east road toward the bridge
  { x0: 22, z0: 3, w: 6, d: 5, wallH: 3, door: 'N' }
]

/** door = 'S' means the door is on the z0 wall, 'N' on the z1 wall, etc. */

export const FARM: Rect = { x0: -30, z0: 18, w: 10, d: 8 }
export const STALL: Rect = { x0: 6, z0: 5, w: 4, d: 3 }
export const WELL: Rect = { x0: -1, z0: -1, w: 3, d: 3 }

/** Training-dummy posts (cells) + the sand yard under them. */
export const DUMMIES: ReadonlyArray<readonly [number, number]> = [
  [20, 18],
  [24, 20],
  [21, 23]
]
export const DUMMY_YARD: Rect = { x0: 18, z0: 16, w: 9, d: 9 }

/** Lantern-post cells (each carries a warm point light — keep this short). */
export const LANTERNS: ReadonlyArray<readonly [number, number]> = [
  [8, 8],
  [-9, 8],
  [8, -9],
  [-9, -9],
  [40, -3] // by the bridge
]

/** Shared build context handed between the world sub-modules. */
export interface Ctx {
  rng: Rng
  grid: CollisionGrid
  /** Surface type per cell, S_* codes, indexed like the collision grid. */
  surface: Uint8Array
  batches: {
    grass: VoxelBatch
    path: VoxelBatch
    stone: VoxelBatch
    wood: VoxelBatch
    plaster: VoxelBatch
    roof: VoxelBatch
    window: VoxelBatch
    leaf: VoxelBatch
    misc: VoxelBatch
  }
}

export function surfIdx(ix: number, iz: number): number {
  return ix + 60 + (iz + 60) * 120
}

export function surfaceAt(ctx: Ctx, ix: number, iz: number): number {
  if (ix < -60 || ix >= 60 || iz < -60 || iz >= 60) return S_GRASS
  return ctx.surface[surfIdx(ix, iz)] ?? S_GRASS
}

export function setSurface(ctx: Ctx, ix: number, iz: number, s: number): void {
  if (ix < -60 || ix >= 60 || iz < -60 || iz >= 60) return
  ctx.surface[surfIdx(ix, iz)] = s
}

export function setSurfaceRect(ctx: Ctx, r: Rect, s: number): void {
  for (let ix = r.x0; ix < r.x0 + r.w; ix++) {
    for (let iz = r.z0; iz < r.z0 + r.d; iz++) setSurface(ctx, ix, iz, s)
  }
}
