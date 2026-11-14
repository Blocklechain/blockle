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
import { HALF, HEART_HALF } from './collision'
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

// --- outer-ring biome grounds (streamed zones; village-palette-harmonious)
export const SWAMP_GROUND = [0x4a5d3a, 0x41543a, 0x54663e, 0x3a4c34] as const
export const SWAMP_MURK = 0x39544d
export const DESERT_GROUND = [0xd9bd7f, 0xcfb272, 0xe2c78b, 0xc6a968] as const
export const TUNDRA_GROUND = [0xb9c4bb, 0xaeb9b2, 0xc6cfc7, 0x9fada6] as const
export const VOLCANIC_GROUND = [0x4a3f3c, 0x423734, 0x544744, 0x382f2d] as const
export const CRYSTAL_GROUND = [0x8d7fb5, 0x8172ab, 0x998cc0, 0x75689e] as const
export const CRYSTAL_GLOW = 0x9fe8ff
export const RUINS_GROUND = [0x8f8d7e, 0x848273, 0x9b9889, 0x787667] as const
export const BEACH_GROUND = [0xe0cf96, 0xd6c489, 0xe9d9a4, 0xccb97c] as const
export const MUSHROOM_GROUND = [0x6b5a66, 0x5f4f5c, 0x776672, 0x534450] as const
export const MUSHROOM_CAP = [0xd96459, 0xc4574e, 0xe8786d] as const
export const MUSHROOM_SPOT = 0xf3e9d8
export const MUSHROOM_STEM = [0xe6dcc8, 0xdcd2bd] as const
export const CHERRY_GROUND = [0x6fa45c, 0x7cb168, 0x639752, 0x86b973] as const
export const CHERRY_LEAF = [0xf2a7c3, 0xeb96b6, 0xf8bcd2, 0xe687ab] as const
export const SAVANNA_GROUND = [0xb8a85e, 0xaf9e54, 0xc2b36a, 0xa39149] as const
export const CANYON_GROUND = [0xb97a4e, 0xae6f45, 0xc48757, 0xa0633d] as const
export const LAGOON_GROUND = [0xdccd92, 0xd2c385, 0xe5d7a0, 0xc8b978] as const
export const LAGOON_WATER = 0x46c2b8
export const GRAVEYARD_GROUND = [0x55644d, 0x4c5a45, 0x5f6e55, 0x44523e] as const
export const GLACIER_GROUND = [0xd7e4ec, 0xcbdae4, 0xe2edf3, 0xbfd0dc] as const
export const ICE = [0xbfe3f2, 0xaedaec, 0xd0ecf7] as const
export const CACTUS_GREEN = [0x4e8f4a, 0x447f41, 0x58a053] as const
export const PALM_LEAF = [0x4da152, 0x3f9148, 0x5cb05c] as const
export const BONE_WHITE = [0xe8e2d2, 0xded7c4, 0xf1ecdd] as const
export const RUIN_STONE = [0xa8a594, 0x9c9988, 0xb4b1a0] as const

/** biome (RegionDef/ZoneDef .biome) → base ground palette for ground passes. */
export const BIOME_GROUND: Record<string, readonly number[]> = {
  meadow: MEADOW_GROUND,
  forest: FOREST_GROUND,
  mountain: MOUNTAIN_GROUND,
  city: FLAGSTONE,
  dungeon: DUNGEON_GROUND,
  wastes: WASTES_GROUND,
  swamp: SWAMP_GROUND,
  desert: DESERT_GROUND,
  tundra: TUNDRA_GROUND,
  volcanic: VOLCANIC_GROUND,
  crystal: CRYSTAL_GROUND,
  ruins: RUINS_GROUND,
  beach: BEACH_GROUND,
  mushroom: MUSHROOM_GROUND,
  cherry: CHERRY_GROUND,
  savanna: SAVANNA_GROUND,
  canyon: CANYON_GROUND,
  lagoon: LAGOON_GROUND,
  graveyard: GRAVEYARD_GROUND,
  glacier: GLACIER_GROUND
}

// ---------------------------------------------------------------------------
// Landmass
// ---------------------------------------------------------------------------

/** Nominal coast ring — open ocean beyond ~|x|,|z| 700 (wobbled shoreline). */
export const COAST = 696

/**
 * True when (x, z) is on the landmass of the 1440x1440 world.
 *
 * Inside the heart (|x|,|z| <= 240) this is EXACTLY the original rule:
 * the NW and NE bays (|x| > 80 and z < -120) are water, everything else is
 * land — the loved heart coastline is preserved bit-for-bit. Beyond the
 * heart, the new ring is land out to a gently wobbled coast around ±COAST;
 * past that is open ocean. Deterministic (pure function of x, z).
 */
export function isLand(x: number, z: number): boolean {
  if (x < -HALF || x >= HALF || z < -HALF || z >= HALF) return false
  if (x >= -HEART_HALF && x < HEART_HALF && z >= -HEART_HALF && z < HEART_HALF) {
    return !(z < -120 && (x < -80 || x > 80))
  }
  const wob =
    Math.sin(x * 0.019 + z * 0.011) * 5 + Math.sin(z * 0.023 - x * 0.007) * 4
  return Math.max(Math.abs(x), Math.abs(z)) < COAST + wob
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

// ---------------------------------------------------------------------------
// OUTER-RING KIT — builders for the 90 streamed zones (same voxel style:
// VoxelBatch Lambert boxes, no textures, <=120 voxels each, collision marked
// by the builder, glow ONLY via the shared flickering window batch — the
// scarce PointLight budget stays with kitLantern).
// ---------------------------------------------------------------------------

/** Cherry-blossom tree — village tree silhouette with a pink canopy and a
 *  few fallen petals. Blocks the trunk cell. */
export function kitCherryTree(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 2 + rng.int(3)
  batches.wood.add(ix + 0.2, 0, iz + 0.2, 0.6, h, 0.6, rng.pick(P.WOOD))
  grid.block(ix, iz)
  const base = rng.next() < 0.4 ? 2 : 1
  for (let dx = -base; dx <= base; dx++) {
    for (let dz = -base; dz <= base; dz++) {
      const edge = Math.abs(dx) === base && Math.abs(dz) === base
      if (edge && rng.next() < 0.5) continue
      batches.leaf.voxel(ix + dx, h, iz + dz, rng.pick(CHERRY_LEAF))
      if (!edge) batches.leaf.voxel(ix + dx, h + 1, iz + dz, rng.pick(CHERRY_LEAF))
    }
  }
  batches.leaf.voxel(ix, h + 2, iz, rng.pick(CHERRY_LEAF))
  // fallen petals
  for (let i = 0; i < 3; i++) {
    batches.misc.add(
      ix + rng.range(-2, 2.6), 0, iz + rng.range(-2, 2.6),
      0.22, 0.08, 0.22, rng.pick(CHERRY_LEAF)
    )
  }
}

/** Giant toadstool — pale stem, red spotted cap. Blocks the stem cell. */
export function kitMushroomGiant(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 2 + rng.int(3)
  batches.plaster.add(ix + 0.2, 0, iz + 0.2, 0.6, h, 0.6, rng.pick(MUSHROOM_STEM))
  grid.block(ix, iz)
  const cap = rng.pick(MUSHROOM_CAP)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      batches.roof.voxel(ix + dx, h, iz + dz, cap)
      if (rng.next() < 0.22) {
        batches.misc.add(ix + dx + 0.3, h + 1, iz + dz + 0.3, 0.35, 0.12, 0.35, MUSHROOM_SPOT)
      }
    }
  }
  batches.roof.voxel(ix, h + 1, iz, cap)
}

/** Saguaro cactus — green column + 1-2 stubby arms. Blocks the cell. */
export function kitCactus(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 2 + rng.int(2)
  const c = rng.pick(CACTUS_GREEN)
  batches.leaf.add(ix + 0.25, 0, iz + 0.25, 0.5, h, 0.5, c)
  grid.block(ix, iz)
  const arms = 1 + rng.int(2)
  for (let a = 0; a < arms; a++) {
    const ay = 0.8 + rng.range(0, h - 1.4)
    const side = rng.next() < 0.5 ? -0.45 : 0.9
    if (rng.next() < 0.5) {
      batches.leaf.add(ix + side, ay, iz + 0.3, 0.55, 0.4, 0.4, c)
      batches.leaf.add(ix + (side < 0 ? -0.45 : 1.05), ay, iz + 0.3, 0.4, 1 + rng.range(0, 0.6), 0.4, c)
    } else {
      batches.leaf.add(ix + 0.3, ay, iz + side, 0.4, 0.4, 0.55, c)
      batches.leaf.add(ix + 0.3, ay, iz + (side < 0 ? -0.45 : 1.05), 0.4, 1 + rng.range(0, 0.6), 0.4, c)
    }
  }
}

/** Leaning palm — offset trunk stack + a leaf cross. Blocks the base cell. */
export function kitPalm(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 4 + rng.int(2)
  const leanX = rng.range(-0.22, 0.22)
  const leanZ = rng.range(-0.22, 0.22)
  for (let y = 0; y < h; y++) {
    batches.wood.add(ix + 0.28 + leanX * y, y, iz + 0.28 + leanZ * y, 0.44, 1, 0.44, rng.pick(P.WOOD))
  }
  grid.block(ix, iz)
  const tx = ix + 0.5 + leanX * h
  const tz = iz + 0.5 + leanZ * h
  const leaf = rng.pick(PALM_LEAF)
  batches.leaf.add(tx - 1.7, h, tz - 0.3, 3.4, 0.3, 0.6, leaf)
  batches.leaf.add(tx - 0.3, h, tz - 1.7, 0.6, 0.3, 3.4, rng.pick(PALM_LEAF))
  batches.leaf.add(tx - 1.1, h + 0.3, tz - 1.1, 2.2, 0.28, 2.2, rng.pick(PALM_LEAF))
  batches.leaf.add(tx - 0.4, h + 0.58, tz - 0.4, 0.8, 0.3, 0.8, leaf)
}

/** Tapered ice spike (1-3 units of shimmering pale blue). Blocks the cell. */
export function kitIceSpike(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 1.6 + rng.range(0, 1.8)
  const c = rng.pick(ICE)
  batches.misc.add(ix + 0.08, 0, iz + 0.08, 0.84, h * 0.5, 0.84, c)
  batches.misc.add(ix + 0.24, h * 0.5, iz + 0.24, 0.52, h * 0.34, 0.52, rng.pick(ICE))
  batches.misc.add(ix + 0.36, h * 0.84, iz + 0.36, 0.28, h * 0.26, 0.28, c)
  grid.block(ix, iz)
}

/** Glowing crystal shard cluster — EMISSIVE via the shared flickering window
 *  batch (no light). Blocks the cell. */
export function kitCrystalShard(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 1.4 + rng.range(0, 1.6)
  batches.window.add(ix + 0.2, 0, iz + 0.2, 0.6, h, 0.6, CRYSTAL_GLOW)
  batches.window.add(ix + 0.34, h, iz + 0.34, 0.32, h * 0.35, 0.32, CRYSTAL_GLOW)
  const spurs = 1 + rng.int(2)
  for (let s = 0; s < spurs; s++) {
    batches.window.add(
      ix + rng.range(-0.3, 0.75), 0, iz + rng.range(-0.3, 0.75),
      0.3, 0.5 + rng.range(0, h * 0.5), 0.3, CRYSTAL_GLOW
    )
  }
  grid.block(ix, iz)
}

/** Broken ancient pillar, optionally with its fallen top. Blocks the cell. */
export function kitRuinPillar(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 1.5 + rng.range(0, 2.5)
  batches.stone.add(ix + 0.1, 0, iz + 0.1, 0.8, 0.3, 0.8, rng.pick(RUIN_STONE)) // plinth
  batches.stone.add(ix + 0.2, 0.3, iz + 0.2, 0.6, h, 0.6, rng.pick(RUIN_STONE))
  batches.stone.add(ix + 0.24, 0.3 + h, iz + 0.24, 0.52, 0.4, 0.3, rng.pick(RUIN_STONE)) // jagged top
  grid.block(ix, iz)
  if (rng.next() < 0.5) {
    const fx = ix + (rng.next() < 0.5 ? -1.4 : 1.4)
    const fz = iz + rng.range(-1, 1)
    batches.stone.add(fx, 0, fz, 1.3, 0.55, 0.6, rng.pick(RUIN_STONE))
    grid.block(Math.floor(fx + 0.5), Math.floor(fz + 0.3))
  }
}

/** Headstone — slab + base, slightly tilted feel via offset cap. Blocks. */
export function kitGrave(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const s = rng.pick(P.STONE)
  batches.stone.add(ix + 0.08, 0, iz + 0.25, 0.84, 0.18, 0.5, s)
  batches.stone.add(ix + 0.18, 0.18, iz + 0.34, 0.64, 0.9 + rng.range(0, 0.4), 0.3, s)
  batches.stone.add(ix + 0.26, 1.05 + rng.range(0, 0.35), iz + 0.36, 0.48, 0.22, 0.26, s)
  grid.block(ix, iz)
}

/** Big weathered bone poking out of the ground. Blocks the cell. */
export function kitBone(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const c = rng.pick(BONE_WHITE)
  const alongX = rng.next() < 0.5
  if (alongX) {
    batches.misc.add(ix - 0.3, 0, iz + 0.3, 1.6, 0.3, 0.4, c) // shaft
    batches.misc.add(ix - 0.5, 0, iz + 0.2, 0.42, 0.55, 0.6, c) // knob
    batches.misc.add(ix + 1.1, 0, iz + 0.2, 0.42, 0.55, 0.6, c)
  } else {
    batches.misc.add(ix + 0.3, 0, iz - 0.3, 0.4, 0.3, 1.6, c)
    batches.misc.add(ix + 0.2, 0, iz - 0.5, 0.6, 0.55, 0.42, c)
    batches.misc.add(ix + 0.2, 0, iz + 1.1, 0.6, 0.55, 0.42, c)
  }
  if (rng.next() < 0.5) {
    batches.misc.add(ix + rng.range(-0.6, 0.9), 0, iz + rng.range(-0.6, 0.9), 0.3, 0.26, 0.3, c)
  }
  grid.block(ix, iz)
}

/** Campfire — stone ring, crossed logs, EMBER glow cubes on the shared
 *  flickering window batch (NO PointLight — lights stay budgeted). Blocks. */
export function kitCampfire(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix - 0.2, 0, iz + 0.25, 0.4, 0.3, 0.4, rng.pick(P.STONE))
  batches.stone.add(ix + 0.85, 0, iz + 0.25, 0.4, 0.3, 0.4, rng.pick(P.STONE))
  batches.stone.add(ix + 0.3, 0, iz - 0.25, 0.4, 0.3, 0.4, rng.pick(P.STONE))
  batches.stone.add(ix + 0.3, 0, iz + 0.85, 0.4, 0.3, 0.4, rng.pick(P.STONE))
  batches.wood.add(ix - 0.1, 0.12, iz + 0.32, 1.2, 0.24, 0.26, rng.pick(P.WOOD))
  batches.wood.add(ix + 0.32, 0.12, iz - 0.1, 0.26, 0.24, 1.2, rng.pick(P.WOOD))
  batches.window.add(ix + 0.25, 0.1, iz + 0.25, 0.5, 0.45, 0.5, EMBER)
  batches.window.add(ix + 0.36, 0.55, iz + 0.36, 0.28, 0.3, 0.28, EMBER)
  grid.block(ix, iz)
}

/**
 * Wooden plank walkway `len` cells long from (x0, z0) along +X or +Z —
 * swamp boardwalks, lagoon jetties. WALKABLE: it does not block, and it
 * stamps S_BRIDGE so ground passes leave the crossing alone (stamp BEFORE
 * streamGroundPass paints the zone).
 */
export function kitBridgePlank(ctx: Ctx, x0: number, z0: number, len: number, alongX: boolean): void {
  const { rng, batches } = ctx
  for (let i = 0; i < len; i++) {
    const ix = alongX ? x0 + i : x0
    const iz = alongX ? z0 : z0 + i
    setSurface(ctx, ix, iz, S_BRIDGE)
    batches.wood.add(ix, -0.12, iz + 0.04, alongX ? 1 : 0.92, 0.24, alongX ? 0.92 : 1, rng.pick(P.WOOD))
    if (i % 3 === 1) {
      batches.wood.add(ix + 0.34, -0.6, iz + 0.34, 0.32, 0.5, 0.32, P.WOOD_DARK) // stilts
    }
  }
}

/** Blocky weathered colossus on a plinth — legs, torso, head, one raised
 *  arm. ~20 boxes. Blocks its 3x3 footprint. */
export function kitStatue(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const s = rng.pick(RUIN_STONE)
  const s2 = rng.pick(P.STONE)
  batches.stone.add(ix, 0, iz, 3, 0.5, 3, s2) // plinth
  batches.stone.add(ix + 0.65, 0.5, iz + 1.1, 0.55, 1.4, 0.7, s) // legs
  batches.stone.add(ix + 1.8, 0.5, iz + 1.1, 0.55, 1.4, 0.7, s)
  batches.stone.add(ix + 0.5, 1.9, iz + 0.95, 2, 1.7, 1, s) // torso
  batches.stone.add(ix + 0.05, 2.9, iz + 1.05, 0.5, 0.9, 0.8, s) // arm down
  batches.stone.add(ix + 2.45, 2.2, iz + 1.05, 0.5, 1.9, 0.8, s) // arm raised
  batches.stone.add(ix + 2.4, 4.1, iz + 1, 0.6, 0.6, 0.9, s2) // fist
  batches.stone.add(ix + 0.95, 3.6, iz + 0.9, 1.1, 1.1, 1.1, s) // big head
  batches.stone.add(ix + 1.05, 4.7, iz + 1, 0.9, 0.25, 0.9, s2) // brow/crown
  grid.blockRect(ix, iz, 3, 3)
}

/** Carved painted totem pole with stubby wings. Blocks the cell. */
export function kitTotem(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const tiers = 3 + rng.int(2)
  for (let t = 0; t < tiers; t++) {
    const c = t % 2 === 0 ? rng.pick(P.WOOD) : rng.pick(P.FLOWER)
    batches.wood.add(ix + 0.15, t * 0.9, iz + 0.15, 0.7, 0.9, 0.7, c)
    if (t === tiers - 2) {
      batches.wood.add(ix - 0.75, t * 0.9 + 0.3, iz + 0.25, 0.9, 0.3, 0.5, P.WOOD_DARK)
      batches.wood.add(ix + 0.85, t * 0.9 + 0.3, iz + 0.25, 0.9, 0.3, 0.5, P.WOOD_DARK)
    }
  }
  batches.roof.add(ix + 0.05, tiers * 0.9, iz + 0.05, 0.9, 0.3, 0.9, rng.pick(P.ROOF))
  grid.block(ix, iz)
}

/** Round-ish straw-roofed hut (4x4) with a dark doorway + glow window.
 *  Blocks its 4x4 footprint — place clear of roads. */
export function kitHut(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const wallH = 2
  for (let dx = 0; dx < 4; dx++) {
    for (let dz = 0; dz < 4; dz++) {
      const wall = dx === 0 || dx === 3 || dz === 0 || dz === 3
      if (!wall) continue
      const corner = (dx === 0 || dx === 3) && (dz === 0 || dz === 3)
      const door = dz === 0 && dx === 1
      batches.stone.add(ix + dx, 0, iz + dz, 1, 0.25, 1, rng.pick(P.STONE))
      for (let y = 0; y < wallH; y++) {
        if (door) continue
        if (y === 1 && dz === 3 && dx === 2) {
          batches.window.voxel(ix + dx, 0.25 + y, iz + dz, P.WINDOW_GLOW)
        } else {
          batches.plaster.add(
            ix + dx, 0.25 + y, iz + dz, 1, 1, 1,
            corner ? P.WOOD_DARK : rng.pick(P.PLASTER)
          )
        }
      }
    }
  }
  batches.wood.add(ix + 1.08, 0.25, iz + 0.35, 0.84, 1.75, 0.3, P.WOOD_DARK) // door leaf
  // stepped straw cone roof
  batches.misc.add(ix - 0.4, 0.25 + wallH, iz - 0.4, 4.8, 0.55, 4.8, P.STRAW)
  batches.misc.add(ix + 0.5, 0.8 + wallH, iz + 0.5, 3, 0.55, 3, P.STRAW)
  batches.misc.add(ix + 1.3, 1.35 + wallH, iz + 1.3, 1.4, 0.55, 1.4, P.STRAW)
  grid.blockRect(ix, iz, 4, 4)
}

// ---------------------------------------------------------------------------
// Dungeon entrance (Ashen Dungeons) — STANDALONE prop
// ---------------------------------------------------------------------------

/**
 * The Trial of the Deep gateway: a hewn dark-stone archway over a pitch-black
 * descent, ember runes glowering from the keystone. Unlike the ctx builders
 * above, this returns a self-contained THREE.Group (its own geometry +
 * Lambert materials + a single ember PointLight) so the dungeon module can
 * place and own it directly — it is NOT batched and marks no collision; the
 * dungeon module drives proximity "enter" interaction instead. Origin at the
 * base centre, mouth facing +Z. Flat-color voxel vocabulary, same as the
 * village. ONE light, per the lantern budget.
 */
export function kitDungeonEntrance(): THREE.Group {
  const group = new THREE.Group()
  const mats: THREE.MeshLambertMaterial[] = []
  const mat = (c: number, emissive = 0): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color: c })
    if (emissive) m.emissive.setHex(emissive)
    mats.push(m)
    return m
  }
  const stoneA = mat(DUNGEON_GROUND[0])
  const stoneB = mat(DUNGEON_GROUND[2])
  const stoneDark = mat(0x201f26)
  const voidMat = mat(0x050507)
  const emberMat = mat(EMBER, EMBER)

  const box = (
    x: number, y: number, z: number,
    w: number, h: number, d: number,
    m: THREE.MeshLambertMaterial
  ): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
    mesh.position.set(x, y + h / 2, z) // y = bottom of the box
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }

  // sunken platform + black descent mouth
  box(0, -0.1, 0, 5.2, 0.3, 4.0, stoneA)
  box(0, 0, 0.9, 2.2, 0.04, 2.0, voidMat) // the dark where the stairs go down
  // stepped jambs (two chunky pillars)
  for (const sx of [-1.6, 1.6]) {
    box(sx, 0, -0.2, 1.1, 3.2, 1.1, stoneB)
    box(sx, 3.2, -0.2, 1.3, 0.4, 1.3, stoneDark)
    box(sx, 1.4, 0.35, 1.2, 0.5, 0.2, stoneDark) // ledge facing the mouth
  }
  // lintel + keystone
  box(0, 3.3, -0.2, 4.6, 0.6, 1.2, stoneB)
  box(0, 3.9, -0.2, 1.1, 0.7, 1.0, stoneDark)
  // ember runes glowering from the keystone + two jamb sconces
  box(0, 4.0, 0.3, 0.5, 0.5, 0.12, emberMat)
  box(-1.6, 1.7, 0.42, 0.3, 0.3, 0.14, emberMat)
  box(1.6, 1.7, 0.42, 0.3, 0.3, 0.14, emberMat)
  // broken rubble at the feet
  box(-2.3, 0, 1.3, 0.7, 0.5, 0.7, stoneDark)
  box(2.1, 0, 1.5, 0.6, 0.35, 0.6, stoneDark)

  const light = new THREE.PointLight(EMBER, 10, 11, 1.9)
  light.position.set(0, 2.6, 1.0)
  group.add(light)

  // dispose hook (geometry is per-mesh here; free it with the group)
  group.userData['dispose'] = (): void => {
    group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) mesh.geometry.dispose()
    })
    for (const m of mats) m.dispose()
  }
  return group
}
