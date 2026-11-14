/**
 * src/world/kit.ts — SHARED REGION-BUILDER KIT (the region agents' toolbox).
 *
 * Every region module (src/world/regions/<id>.ts) builds with these helpers
 * so the whole continent keeps the village's hand-built flat-color voxel
 * vocabulary: VoxelBatch Lambert boxes, NO textures, warm lantern glow,
 * green roofs. Import from this file + ./layout types; never from ./village.
 *
 * IMPORTANT ORDERING FACT: region builders run BEFORE the ground-instancing
 * pass, so `kitPath` / `setSurface` still take effect on the painted ground
 * (stamp your streets and plazas; the terrain pass renders them as cobble).
 *
 * All prop builders mark the collision grid themselves. Keep point lights
 * (kitLantern) RARE — a handful per region at most; lights are the budget.
 */
import * as THREE from 'three'
import { HALF } from './collision'
import {
  S_BRIDGE,
  S_COBBLE,
  S_RIVER,
  setSurface,
  surfaceAt,
  type BuildingSpec,
  type Ctx
} from './layout'
import * as P from './palette'

// Re-export the whole village palette so regions share the exact colors.
export * from './palette'

// ---------------------------------------------------------------------------
// Biome ground palettes (flat-color, dappled per voxel — same style as GRASS)
// ---------------------------------------------------------------------------

export const MEADOW_GROUND = P.GRASS
export const FOREST_GROUND = [0x3a7a38, 0x2f6b31, 0x44843c, 0x356f3d] as const
export const FOREST_MOSS = 0x5a9150
export const MOUNTAIN_GROUND = [0x8a7f6d, 0x7c7468, 0x94897a, 0x6f685e] as const
export const FLAGSTONE = [0xcfcbc0, 0xc4c0b4, 0xd8d4c9, 0xbab5a9] as const
export const DUNGEON_GROUND = [0x3a3a40, 0x33333a, 0x44444b, 0x2d2d33] as const
export const WASTES_GROUND = [0x6e6278, 0x655a70, 0x786d82, 0x5c5368] as const
export const EMBER = 0xff6a2a
export const PINE_LEAF = [0x2e6b46, 0x27603f, 0x37784e] as const
export const DEAD_WOOD = [0x4a4038, 0x3f362f, 0x554a40] as const

/** biome (RegionDef.biome) → base ground palette used by the terrain pass. */
export const BIOME_GROUND: Record<string, readonly number[]> = {
  meadow: MEADOW_GROUND,
  forest: FOREST_GROUND,
  mountain: MOUNTAIN_GROUND,
  city: FLAGSTONE,
  dungeon: DUNGEON_GROUND,
  wastes: WASTES_GROUND
}

// ---------------------------------------------------------------------------
// Landmass
// ---------------------------------------------------------------------------

/**
 * True when (x, z) is on the continent landmass. The NW and NE corners
 * (|x| > 80 and z < -120) are ocean bays, as is everything beyond ±240.
 */
export function isLand(x: number, z: number): boolean {
  if (x < -HALF || x >= HALF || z < -HALF || z >= HALF) return false
  return !(z < -120 && (x < -80 || x > 80))
}

// ---------------------------------------------------------------------------
// Winding cobble paths (Catmull-Rom through hand-placed waypoints)
// ---------------------------------------------------------------------------

/**
 * Stamp a winding cobble path through `pts` ([x, z] waypoints) into the
 * surface map. Rivers and bridge decks are left alone (bridges ARE the
 * crossing). Works only BEFORE the ground pass instancing (see file docs).
 */
export function kitPath(
  ctx: Ctx,
  pts: ReadonlyArray<readonly [number, number]>,
  width = 1.4
): void {
  if (pts.length < 2) return
  const ext = [pts[0]!, ...pts, pts[pts.length - 1]!]
  const w2 = width * width
  const rad = Math.ceil(width)
  const stamp = (x: number, z: number): void => {
    const cx = Math.round(x)
    const cz = Math.round(z)
    for (let dx = -rad; dx <= rad; dx++) {
      for (let dz = -rad; dz <= rad; dz++) {
        if (dx * dx + dz * dz > w2) continue
        const s = surfaceAt(ctx, cx + dx, cz + dz)
        if (s === S_RIVER || s === S_BRIDGE) continue
        setSurface(ctx, cx + dx, cz + dz, S_COBBLE)
      }
    }
  }
  for (let i = 0; i < ext.length - 3; i++) {
    const p0 = ext[i]!
    const p1 = ext[i + 1]!
    const p2 = ext[i + 2]!
    const p3 = ext[i + 3]!
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const steps = Math.max(2, Math.ceil(segLen * 2))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      const cat = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3)
      stamp(cat(p0[0], p1[0], p2[0], p3[0]), cat(p0[1], p1[1], p2[1], p3[1]))
    }
  }
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeOpts {
  /** Canopy palette (defaults to the village LEAF greens). */
  leaves?: readonly number[]
  /** Force big/small canopy; omitted = village 35% big roll. */
  big?: boolean
}

/**
 * The village's round-canopy tree (identical geometry + rng sequence when
 * called with no opts — the village ring uses exactly this).
 */
export function kitTree(ctx: Ctx, ix: number, iz: number, opts: TreeOpts = {}): void {
  const { rng, batches, grid } = ctx
  const leaves = opts.leaves ?? P.LEAF
  const h = 2 + rng.int(3) // trunk height 2-4
  batches.wood.add(ix + 0.2, 0, iz + 0.2, 0.6, h, 0.6, rng.pick(P.WOOD))
  grid.block(ix, iz)

  const big = opts.big ?? rng.next() < 0.35
  const base = big ? 2 : 1 // canopy half-extent
  for (let dx = -base; dx <= base; dx++) {
    for (let dz = -base; dz <= base; dz++) {
      const edge = Math.abs(dx) === base && Math.abs(dz) === base
      if (edge && rng.next() < 0.5) continue // rounded corners
      batches.leaf.voxel(ix + dx, h, iz + dz, rng.pick(leaves))
      if (!edge) batches.leaf.voxel(ix + dx, h + 1, iz + dz, rng.pick(leaves))
    }
  }
  batches.leaf.voxel(ix, h + 2, iz, rng.pick(leaves))
}

export interface PineOpts {
  leaves?: readonly number[]
  tall?: boolean
}

/** Conical pine — Greenwood / Ironhold tree (dark tiered canopy). */
export function kitPine(ctx: Ctx, ix: number, iz: number, opts: PineOpts = {}): void {
  const { rng, batches, grid } = ctx
  const leaves = opts.leaves ?? PINE_LEAF
  const h = opts.tall ? 3 + rng.int(2) : 2 + rng.int(2)
  batches.wood.add(ix + 0.25, 0, iz + 0.25, 0.5, h, 0.5, rng.pick(P.WOOD))
  grid.block(ix, iz)
  let r = opts.tall ? 2 : 1
  let y = h
  while (r >= 0) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (r > 0 && Math.abs(dx) === r && Math.abs(dz) === r) continue // cut corners
        batches.leaf.voxel(ix + dx, y, iz + dz, rng.pick(leaves))
      }
    }
    y++
    r--
  }
}

/** Bare twisted tree for the wastes / dungeon approaches. */
export function kitDeadTree(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 2 + rng.int(3)
  batches.wood.add(ix + 0.25, 0, iz + 0.25, 0.5, h, 0.5, rng.pick(DEAD_WOOD))
  grid.block(ix, iz)
  const arms = 2 + rng.int(2)
  for (let a = 0; a < arms; a++) {
    const ay = 1 + rng.range(0, h - 1)
    const len = 0.8 + rng.range(0, 1)
    if (rng.next() < 0.5) {
      batches.wood.add(ix + (rng.next() < 0.5 ? 0.5 : -len + 0.5), ay, iz + 0.3, len, 0.22, 0.22, rng.pick(DEAD_WOOD))
    } else {
      batches.wood.add(ix + 0.3, ay, iz + (rng.next() < 0.5 ? 0.5 : -len + 0.5), 0.22, 0.22, len, rng.pick(DEAD_WOOD))
    }
  }
  batches.wood.add(ix + 0.32, h, iz + 0.32, 0.36, 0.9, 0.36, rng.pick(DEAD_WOOD))
}

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------

/** Grey outcrop cluster, footprint size x size cells (1-3). Blocks cells. */
export function kitRock(ctx: Ctx, ix: number, iz: number, size: 1 | 2 | 3 = 1): void {
  const { rng, batches, grid } = ctx
  const h = rng.range(0.7, 0.9 + size * 0.6)
  batches.stone.add(ix, 0, iz, size, h, size, rng.pick(P.STONE))
  // a smaller shoulder stone or two
  for (let i = 0; i < size; i++) {
    const sx = rng.range(0.4, 0.9)
    batches.stone.add(
      ix + rng.range(-0.5, size - 0.3),
      0,
      iz + rng.range(-0.5, size - 0.3),
      sx,
      rng.range(0.3, h * 0.7),
      sx,
      rng.pick(P.STONE)
    )
  }
  grid.blockRect(ix, iz, size, size)
}

// ---------------------------------------------------------------------------
// Lanterns (POINT LIGHTS — use sparingly, a handful per region max)
// ---------------------------------------------------------------------------

/** The village lantern post: warm glow cube + one PointLight. Blocks the cell. */
export function kitLantern(
  ctx: Ctx,
  scene: THREE.Scene,
  ix: number,
  iz: number,
  color = 0xffb45e
): void {
  const { batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 2.3, 0.24, P.WOOD_DARK)
  batches.wood.add(ix + 0.38, 2.3, iz + 0.1, 0.24, 0.16, 0.8, P.WOOD_DARK)
  batches.window.add(ix + 0.3, 1.95, iz + 0.02, 0.4, 0.45, 0.4, P.WINDOW_GLOW)
  const light = new THREE.PointLight(color, 14, 10, 1.8)
  light.position.set(ix + 0.5, 2.2, iz + 0.2)
  scene.add(light)
  grid.block(ix, iz)
}

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

/**
 * A run of the village's two-rail wooden fence starting at (x0, z0),
 * `len` cells long, along +X (alongX) or +Z. Blocks every cell.
 */
export function kitFenceRun(ctx: Ctx, x0: number, z0: number, len: number, alongX: boolean): void {
  const { rng, batches, grid } = ctx
  for (let i = 0; i < len; i++) {
    const ix = alongX ? x0 + i : x0
    const iz = alongX ? z0 : z0 + i
    grid.block(ix, iz)
    if ((alongX ? ix : iz) % 2 === 0) {
      batches.wood.add(ix + 0.35, 0, iz + 0.35, 0.3, 1.2, 0.3, rng.pick(P.WOOD))
    }
    if (alongX) {
      batches.wood.add(ix, 0.45, iz + 0.4, 1, 0.14, 0.2, P.WOOD_DARK)
      batches.wood.add(ix, 0.9, iz + 0.4, 1, 0.14, 0.2, P.WOOD_DARK)
    } else {
      batches.wood.add(ix + 0.4, 0.45, iz, 0.2, 0.14, 1, P.WOOD_DARK)
      batches.wood.add(ix + 0.4, 0.9, iz, 0.2, 0.14, 1, P.WOOD_DARK)
    }
  }
}

// ---------------------------------------------------------------------------
// House shells
// ---------------------------------------------------------------------------

export interface HousePalette {
  /** Base course + chimney stones. */
  stone?: readonly number[]
  /** Wall infill between timber studs. */
  plaster?: readonly number[]
  /** Roof tiles (village green by default — keep green unless the region
   *  truly demands otherwise; the green roofs ARE the look). */
  roof?: readonly number[]
  /** Timber studs/corners + door leaf color. */
  timber?: number
}

/**
 * The village building shell (stone base, timber + plaster walls, glowing
 * windows, stepped green hip roof, optional chimney) with palette overrides
 * for region flavor. Identical construction to the village's own houses.
 * Blocks the footprint. Stamp a door spur with kitPath yourself if needed.
 */
export function kitHouseShell(ctx: Ctx, b: BuildingSpec, pal: HousePalette = {}): void {
  const { rng, grid, batches } = ctx
  const stone = pal.stone ?? P.STONE
  const plaster = pal.plaster ?? P.PLASTER
  const roof = pal.roof ?? P.ROOF
  const timber = pal.timber ?? P.WOOD_DARK

  const x1 = b.x0 + b.w - 1 // last cell
  const z1 = b.z0 + b.d - 1

  const doorAlongX = b.door === 'N' || b.door === 'S'
  const doorLo = doorAlongX ? b.x0 + Math.floor(b.w / 2) - 1 : b.z0 + Math.floor(b.d / 2) - 1
  const doorHi = doorLo + 1

  const isDoorCell = (ix: number, iz: number): boolean => {
    switch (b.door) {
      case 'S':
        return iz === b.z0 && ix >= doorLo && ix <= doorHi
      case 'N':
        return iz === z1 && ix >= doorLo && ix <= doorHi
      case 'W':
        return ix === b.x0 && iz >= doorLo && iz <= doorHi
      case 'E':
        return ix === x1 && iz >= doorLo && iz <= doorHi
    }
  }

  for (let ix = b.x0; ix <= x1; ix++) {
    for (let iz = b.z0; iz <= z1; iz++) {
      const isWall = ix === b.x0 || ix === x1 || iz === b.z0 || iz === z1
      if (!isWall) continue
      const door = isDoorCell(ix, iz)
      const corner = (ix === b.x0 || ix === x1) && (iz === b.z0 || iz === z1)
      const stud = corner || (ix + iz) % 3 === 0

      if (door) {
        batches.stone.add(ix, 0, iz, 1, 0.12, 1, rng.pick(stone)) // threshold
      } else {
        batches.stone.voxel(ix, 0, iz, rng.pick(stone))
      }

      for (let y = 1; y < b.wallH; y++) {
        if (door && y <= 2) continue
        const isWindow = y === 2 && !corner && !stud && rng.next() < 0.55
        if (isWindow) {
          batches.window.voxel(ix, y, iz, P.WINDOW_GLOW)
        } else if (stud) {
          batches.wood.voxel(ix, y, iz, timber)
        } else {
          batches.plaster.voxel(ix, y, iz, rng.pick(plaster))
        }
      }
    }
  }

  // Door leaf
  switch (b.door) {
    case 'S':
      batches.wood.add(doorLo, 0.12, b.z0 + 0.35, 2, 2.1, 0.3, timber)
      break
    case 'N':
      batches.wood.add(doorLo, 0.12, z1 + 0.35, 2, 2.1, 0.3, timber)
      break
    case 'W':
      batches.wood.add(b.x0 + 0.35, 0.12, doorLo, 0.3, 2.1, 2, timber)
      break
    case 'E':
      batches.wood.add(x1 + 0.35, 0.12, doorLo, 0.3, 2.1, 2, timber)
      break
  }

  // Stepped hip roof
  let rx0 = b.x0 - 1
  let rz0 = b.z0 - 1
  let rw = b.w + 2
  let rd = b.d + 2
  let layer = 0
  while (rw >= 1 && rd >= 1) {
    const y = b.wallH + layer * 0.62
    for (let ix = rx0; ix < rx0 + rw; ix++) {
      for (let iz = rz0; iz < rz0 + rd; iz++) {
        const ring = ix === rx0 || ix === rx0 + rw - 1 || iz === rz0 || iz === rz0 + rd - 1
        if (ring || (rw <= 3 && rd <= 3)) {
          batches.roof.add(ix, y, iz, 1, 0.62, 1, rng.pick(roof))
        }
      }
    }
    rx0++
    rz0++
    rw -= 2
    rd -= 2
    layer++
  }

  if (b.chimney) {
    const cy = b.wallH + layer * 0.62
    batches.stone.add(x1 - 1, b.wallH, z1 - 1, 1, cy - b.wallH + 1.1, 1, rng.pick(stone))
  }

  grid.blockRect(b.x0, b.z0, b.w, b.d)
}
