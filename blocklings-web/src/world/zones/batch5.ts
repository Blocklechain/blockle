/**
 * src/world/zones/batch5.ts — ZONE_BATCHES[4]: the Northeast
 * (frozen ruins + taiga + cherry highlands).
 *
 *   frosthold          — The Throne of a Thousand Shivers + The Last Librarian
 *   mammoth_misgivings — Big Agnes (half-buried mammoth skeleton) + wrecked caravan
 *   chatterlands       — Chatterbox Hot Spring + the Shiverers' Anonymous camp
 *   reindeer_standoff  — The Negotiating Table (fenced arena) + the Failed Gift Sled
 *   burly_birches      — The Oldest Bouncer (colossal birch) + Arm-Wrestling Stump
 *   petal_peak         — The Blushing Summit shrine plaza + Petal-Viewing Pavilion
 *
 * Style contract honored: VoxelBatch Lambert boxes only, no textures, glow
 * ONLY via the shared flickering window batch. ZERO kitLantern here on
 * purpose — zone builders re-run on every re-entry and a PointLight added to
 * the scene would leak past eviction; the light budget stays in the heart.
 * Deterministic: only ctx.rng (seeded from the zone id by the stream).
 * Collision: kit builders mark themselves; hand-built landmarks mark grid
 * explicitly (idempotent set-marks, safe to re-run).
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import {
  FLOWER,
  ICE,
  LAGOON_WATER,
  RUIN_STONE,
  STONE,
  STRAW,
  WINDOW_GLOW,
  WOOD,
  WOOD_DARK,
  isLand,
  kitBone,
  kitCampfire,
  kitCherryTree,
  kitDeadTree,
  kitFenceRun,
  kitGrave,
  kitIceSpike,
  kitPath,
  kitPine,
  kitRock,
  kitRuinPillar,
  kitStatue,
  kitTotem,
  kitTree
} from '../kit'
import { S_COBBLE, S_GRASS, S_RIVER, setSurface, surfaceAt, type Ctx } from '../layout'
import type { ZoneDef } from './registry'

// ---------------------------------------------------------------------------
// Local palette accents (flat colors, village-harmonious)
// ---------------------------------------------------------------------------

const BIRCH_BARK = [0xeae5d8, 0xe2ddd0, 0xf0ebe0] as const
const BIRCH_FLECK = 0x3d3a33
const BIRCH_LEAF = [0x8fbf6a, 0x7cb35d, 0x9ccc78, 0x6ea853] as const
const STEAM = [0xf4f7f8, 0xe9eef0] as const
const HOTSPRING = 0x55cfc0
const TORII_RED = FLOWER[0]! // the village's own red

// ---------------------------------------------------------------------------
// Shared placement helpers (deterministic — ctx.rng only)
// ---------------------------------------------------------------------------

interface Avoid {
  x: number
  z: number
  r: number
}

/** Cell is open grass, on solid land (not a beach lip), unblocked, and clear
 *  of every keep-out circle (waystones, landmark plazas). */
function openCell(ctx: Ctx, ix: number, iz: number, avoid: readonly Avoid[]): boolean {
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (
    !isLand(ix + 0.5, iz + 0.5) ||
    !isLand(ix + 4, iz) ||
    !isLand(ix - 4, iz) ||
    !isLand(ix, iz + 4) ||
    !isLand(ix, iz - 4)
  ) {
    return false
  }
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  for (const a of avoid) {
    const dx = ix - a.x
    const dz = iz - a.z
    if (dx * dx + dz * dz < a.r * a.r) return false
  }
  return true
}

/** Sprinkle `count` props across the whole zone rect (sparser between-lands). */
function scatter(
  ctx: Ctx,
  zone: ZoneDef,
  count: number,
  avoid: readonly Avoid[],
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  let placed = 0
  for (let tries = 0; placed < count && tries < count * 7; tries++) {
    const ix = Math.floor(rng.range(zone.x0 + 3, zone.x1 - 3))
    const iz = Math.floor(rng.range(zone.z0 + 3, zone.z1 - 3))
    if (!openCell(ctx, ix, iz, avoid)) continue
    place(ix, iz)
    placed++
  }
}

/** Cozy-dense ring of props around a landmark (uniform over the disc). */
function cluster(
  ctx: Ctx,
  cx: number,
  cz: number,
  radius: number,
  count: number,
  avoid: readonly Avoid[],
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  let placed = 0
  for (let tries = 0; placed < count && tries < count * 7; tries++) {
    const ang = rng.range(0, Math.PI * 2)
    const d = radius * Math.sqrt(rng.next())
    const ix = Math.floor(cx + Math.cos(ang) * d)
    const iz = Math.floor(cz + Math.sin(ang) * d)
    if (!openCell(ctx, ix, iz, avoid)) continue
    place(ix, iz)
    placed++
  }
}

/** Stamp an elliptical S_RIVER pool BEFORE the ground pass; returns cells so
 *  the builder can lay its own water on top after. Cells get blocked by the
 *  ground pass itself (S_RIVER cells block). */
function stampPool(ctx: Ctx, cx: number, cz: number, rx: number, rz: number): Array<readonly [number, number]> {
  const cells: Array<readonly [number, number]> = []
  for (let ix = Math.floor(cx - rx); ix <= Math.ceil(cx + rx); ix++) {
    for (let iz = Math.floor(cz - rz); iz <= Math.ceil(cz + rz); iz++) {
      const dx = (ix + 0.5 - cx) / rx
      const dz = (iz + 0.5 - cz) / rz
      if (dx * dx + dz * dz <= 1) {
        setSurface(ctx, ix, iz, S_RIVER)
        cells.push([ix, iz])
      }
    }
  }
  return cells
}

/** Recessed still-water surface over stamped pool cells. */
function fillPool(ctx: Ctx, cells: ReadonlyArray<readonly [number, number]>, color: number): void {
  for (const [ix, iz] of cells) {
    ctx.batches.misc.add(ix, -0.56, iz, 1, 0.34, 1, color)
  }
}

/** Slender birch — pale banded trunk, airy light-green canopy. Blocks. */
function birch(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 4 + rng.int(3)
  batches.plaster.add(ix + 0.25, 0, iz + 0.25, 0.5, h, 0.5, rng.pick(BIRCH_BARK))
  // bark flecks — thin dark bands at random heights
  batches.wood.add(ix + 0.22, rng.range(0.6, h - 1.4), iz + 0.22, 0.56, 0.16, 0.26, BIRCH_FLECK)
  batches.wood.add(ix + 0.22, rng.range(0.6, h - 1.2), iz + 0.46, 0.26, 0.16, 0.34, BIRCH_FLECK)
  grid.block(ix, iz)
  batches.leaf.add(ix - 1, h, iz - 1, 3, 1.4, 3, rng.pick(BIRCH_LEAF))
  batches.leaf.add(ix - 0.5, h + 1.4, iz - 0.5, 2, 1, 2, rng.pick(BIRCH_LEAF))
  batches.leaf.voxel(ix, h + 2, iz, rng.pick(BIRCH_LEAF))
}

/** Little A-frame canvas tent (plaster wedge + dark ridge). Blocks 2x2. */
function tent(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.plaster.add(ix, 0, iz, 2, 1, 2.2, rng.pick(BIRCH_BARK))
  batches.plaster.add(ix + 0.4, 1, iz + 0.1, 1.2, 0.7, 2, rng.pick(BIRCH_BARK))
  batches.wood.add(ix + 0.8, 1.6, iz, 0.4, 0.25, 2.3, WOOD_DARK)
  grid.blockRect(ix, iz, 2, 2)
}

/** Crate pile — 2-3 weathered boxes. Blocks the cell. */
function crates(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0, iz, 0.85, 0.85, 0.85, rng.pick(WOOD))
  batches.wood.add(ix + 0.7, 0, iz + 0.5, 0.7, 0.7, 0.7, rng.pick(WOOD))
  if (rng.next() < 0.6) {
    batches.wood.add(ix + 0.25, 0.85, iz + 0.15, 0.65, 0.65, 0.65, rng.pick(WOOD))
  }
  grid.block(ix, iz)
}

// ---------------------------------------------------------------------------
// frosthold — Frosthold Ruins (ruins 70-86) — ws_frosthold at (420, -620)
// ---------------------------------------------------------------------------

function buildFrosthold(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  const { batches, grid, rng } = ctx

  // 1. Surfaces: road in from the east edge (meets Mammoth Misgivings' path
  //    at the shared border, z~-596) to the waystone, then a processional
  //    way down to the throne hall.
  kitPath(ctx, [
    [479, -596],
    [462, -602],
    [446, -610],
    [432, -616],
    [423, -619]
  ])
  kitPath(ctx, [
    [421, -624],
    [416, -636],
    [410, -648]
  ], 1.2)

  // 2. Ground
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Throne of a Thousand Shivers" — the great hall lost its
  // walls, its king, and its heating bill; the throne kept the ice.
  const tx = 408
  const tz = -652
  batches.stone.add(tx - 4, 0, tz - 4, 8, 0.14, 6, rng.pick(RUIN_STONE)) // dais (walkable slab)
  batches.stone.add(tx - 1, 0.14, tz - 3, 3, 1.2, 1, rng.pick(RUIN_STONE)) // seat
  batches.stone.add(tx - 1, 0.14, tz - 4, 3, 3.6, 0.8, rng.pick(RUIN_STONE)) // back
  batches.stone.add(tx - 1.6, 0.14, tz - 3.2, 0.6, 2, 1.4, rng.pick(STONE)) // armrests
  batches.stone.add(tx + 2, 0.14, tz - 3.2, 0.6, 2, 1.4, rng.pick(STONE))
  batches.misc.add(tx - 0.6, 3.7, tz - 3.9, 1.2, 1, 0.7, rng.pick(ICE)) // ice crown
  batches.misc.add(tx + 1.2, 0.3, tz - 2.4, 0.7, 1.4, 0.7, rng.pick(ICE))
  grid.blockRect(tx - 2, tz - 4, 5, 2) // throne itself; dais stays walkable
  // broken wall fragments of the old hall
  batches.stone.add(tx - 7, 0, tz - 5, 2, 1.3, 6, rng.pick(RUIN_STONE))
  grid.blockRect(tx - 7, tz - 5, 2, 6)
  batches.stone.add(tx + 4, 0, tz - 5, 2, 0.9, 5, rng.pick(RUIN_STONE))
  grid.blockRect(tx + 4, tz - 5, 2, 5)
  batches.stone.add(tx - 5, 0, tz - 7, 9, 1.1, 2, rng.pick(RUIN_STONE))
  grid.blockRect(tx - 5, tz - 7, 9, 2)
  // processional colonnade (pairs flanking the way down from the waystone)
  kitRuinPillar(ctx, 414, -631)
  kitRuinPillar(ctx, 423, -629)
  kitRuinPillar(ctx, 410, -641)
  kitRuinPillar(ctx, 419, -639)
  kitRuinPillar(ctx, 404, -647)
  kitRuinPillar(ctx, 415, -647)

  // LANDMARK: "The Last Librarian" — a colossus still shushing an empty
  // kingdom, ringed by the court (dead, but punctual).
  kitStatue(ctx, 436, -602)
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2
    kitGrave(ctx, Math.floor(437.5 + Math.cos(ang) * 6), Math.floor(-600.5 + Math.sin(ang) * 6))
  }

  const avoid: Avoid[] = [
    { x: 420, z: -620, r: 7 }, // waystone anchor stays clear + reachable
    { x: tx, z: tz - 2, r: 11 },
    { x: 437, z: -601, r: 9 }
  ]
  // cozy-dense ruin yard near the throne, sparser frozen ruin beyond
  cluster(ctx, tx, tz, 26, 10, avoid, (x, z) => {
    ctx.rng.next() < 0.5 ? kitRuinPillar(ctx, x, z) : kitIceSpike(ctx, x, z)
  })
  scatter(ctx, zone, 12, avoid, (x, z) => kitRuinPillar(ctx, x, z))
  scatter(ctx, zone, 22, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, zone, 10, avoid, (x, z) => kitRock(ctx, x, z, (1 + ctx.rng.int(2)) as 1 | 2))
  scatter(ctx, zone, 8, avoid, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, zone, 6, avoid, (x, z) => kitGrave(ctx, x, z))
}

// ---------------------------------------------------------------------------
// mammoth_misgivings — tundra 55-70
// ---------------------------------------------------------------------------

function buildMammoth(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  const { batches, grid, rng } = ctx

  // 1. Surfaces: spur off the NE arterial (clips the SE corner) to the
  //    skeleton, then on west to the Frosthold border road.
  kitPath(ctx, [
    [586, -528],
    [572, -546],
    [556, -566],
    [544, -582],
    [538, -592]
  ])
  kitPath(ctx, [
    [536, -594],
    [510, -594],
    [492, -595],
    [481, -596]
  ])

  // 2. Ground
  streamGroundPass(ctx, zone)

  // LANDMARK: "Big Agnes" — a half-buried mammoth skeleton. She remembers
  // exactly who did this, and she is being very patient about it.
  const sx = 518
  const sz = -602
  // skull + eye socket + tusks
  batches.misc.add(sx - 3, 0, sz - 1.2, 2.6, 1.7, 2.4, rng.pick([0xe8e2d2, 0xded7c4] as const))
  batches.wood.add(sx - 2.6, 0.9, sz - 0.9, 0.4, 0.4, 0.4, BIRCH_FLECK)
  batches.misc.add(sx - 3.6, 0.2, sz + 0.9, 0.5, 0.5, 2.2, 0xe8e2d2) // tusk L
  batches.misc.add(sx - 3.6, 0.5, sz + 2.8, 0.5, 0.5, 1.2, 0xf1ecdd)
  batches.misc.add(sx - 3.6, 0.2, sz - 3.3, 0.5, 0.5, 2.2, 0xe8e2d2) // tusk R
  batches.misc.add(sx - 3.6, 0.5, sz - 4.2, 0.5, 0.5, 1.2, 0xf1ecdd)
  grid.blockRect(sx - 4, sz - 2, 4, 4)
  // ribcage — paired ribs arching, sinking toward the tail
  for (let i = 0; i < 5; i++) {
    const rx = sx + i * 2
    const rh = 2.8 - i * 0.42
    batches.misc.add(rx, 0, sz - 2.4, 0.5, rh, 0.5, 0xded7c4)
    batches.misc.add(rx, 0, sz + 1.9, 0.5, rh, 0.5, 0xe8e2d2)
    grid.block(rx, sz - 3)
    grid.block(rx, sz + 2)
    if (i < 3) {
      batches.misc.add(rx, rh, sz - 2.2, 0.5, 0.45, 4.6, 0xf1ecdd) // arch top
    }
  }
  // sunken spine + pelvis mound
  for (let i = 0; i < 4; i++) {
    batches.misc.add(sx + 1 + i * 2, 0, sz - 0.4, 0.9, 0.5, 0.8, 0xded7c4)
  }
  batches.misc.add(sx + 10, 0, sz - 1, 1.8, 1.1, 2, 0xe8e2d2)
  grid.blockRect(sx + 10, sz - 1, 2, 2)

  // LANDMARK: "The Wrong-Way Caravan" — a trade wagon that took the scenic
  // route through mammoth country exactly once.
  const wx = 542
  const wz = -586
  batches.wood.add(wx, 0, wz, 2.6, 1.1, 1.6, rng.pick(WOOD)) // tipped body
  batches.wood.add(wx + 0.4, 1.1, wz - 0.5, 2.2, 0.9, 1.2, rng.pick(WOOD))
  batches.misc.add(wx - 0.5, 0, wz - 0.3, 0.25, 0.9, 0.9, WOOD_DARK) // wheels
  batches.misc.add(wx + 2.7, 0, wz + 1.4, 0.25, 0.9, 0.9, WOOD_DARK)
  batches.misc.add(wx + 4.2, 0, wz + 1.8, 0.9, 0.25, 0.9, WOOD_DARK) // one rolled away, gave up
  batches.misc.add(wx + 1, 2, wz - 0.3, 1.4, 0.3, 0.8, STRAW) // spilled cargo
  grid.blockRect(wx, wz, 3, 2)
  crates(ctx, wx + 3, wz - 2)
  kitCampfire(ctx, wx - 3, wz + 1) // ember-glow 1/2

  const avoid: Avoid[] = [
    { x: sx + 3, z: sz, r: 12 },
    { x: wx + 1, z: wz, r: 8 }
  ]
  cluster(ctx, sx + 3, sz, 24, 9, avoid, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 8, avoid, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 16, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, zone, 12, avoid, (x, z) => kitRock(ctx, x, z, (1 + ctx.rng.int(2)) as 1 | 2))
  scatter(ctx, zone, 18, avoid, (x, z) => kitPine(ctx, x, z))
}

// ---------------------------------------------------------------------------
// chatterlands — tundra 48-60
// ---------------------------------------------------------------------------

function buildChatterlands(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  const { batches, rng } = ctx

  // 1. Surfaces: spur from the NE arterial (SE corner) to the spring, and
  //    the pool basin stamped before ground.
  kitPath(ctx, [
    [470, -372],
    [456, -384],
    [442, -398],
    [430, -412],
    [421, -423]
  ])
  const pool = stampPool(ctx, 416, -434, 4.5, 3.5)

  // 2. Ground
  streamGroundPass(ctx, zone)

  // LANDMARK: "Chatterbox Hot Spring" — the only warm thing for miles.
  // Rumor says it gossips. Rumor is correct.
  fillPool(ctx, pool, HOTSPRING)
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2 + 0.3
    kitRock(ctx, Math.floor(416 + Math.cos(ang) * 6), Math.floor(-434 + Math.sin(ang) * 5), 1)
  }
  for (let i = 0; i < 7; i++) {
    // steam puffs drifting up (no collision — they're steam)
    batches.misc.add(
      415 + rng.range(-2.5, 2.5),
      0.4 + i * 0.34 + rng.range(0, 0.3),
      -434 + rng.range(-2, 2),
      0.7 - i * 0.06,
      0.5,
      0.7 - i * 0.06,
      rng.pick(STEAM)
    )
  }

  // LANDMARK: "Shiverers' Anonymous" — step one is admitting you're cold.
  const cx = 432
  const cz = -420
  kitCampfire(ctx, cx, cz) // ember-glow 1/2
  batches.wood.add(cx - 2.4, 0, cz - 1.4, 2, 0.5, 0.7, rng.pick(WOOD)) // log benches
  batches.wood.add(cx + 1.6, 0, cz + 1.6, 0.7, 0.5, 2, rng.pick(WOOD))
  ctx.grid.blockRect(cx - 2, cz - 1, 2, 1)
  ctx.grid.blockRect(cx + 2, cz + 2, 1, 2)
  tent(ctx, cx + 3, cz - 3)
  tent(ctx, cx - 4, cz + 2)
  kitTotem(ctx, cx - 1, cz - 4)

  const avoid: Avoid[] = [
    { x: 416, z: -434, r: 10 },
    { x: cx, z: cz, r: 8 }
  ]
  cluster(ctx, 420, -430, 20, 8, avoid, (x, z) => kitPine(ctx, x, z))
  scatter(ctx, zone, 20, avoid, (x, z) => kitPine(ctx, x, z, { tall: ctx.rng.next() < 0.3 }))
  scatter(ctx, zone, 14, avoid, (x, z) => kitRock(ctx, x, z, (1 + ctx.rng.int(2)) as 1 | 2))
  scatter(ctx, zone, 10, avoid, (x, z) => kitIceSpike(ctx, x, z))
}

// ---------------------------------------------------------------------------
// reindeer_standoff — tundra 52-65
// ---------------------------------------------------------------------------

function buildReindeer(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  const { batches, grid, rng } = ctx

  // 1. Surfaces: spur off the NE arterial (which crosses this zone) to the
  //    arena's west gate.
  kitPath(ctx, [
    [510, -424],
    [507, -429],
    [506, -434],
    [508, -436]
  ])

  // 2. Ground
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Negotiating Table" — the caribou union's bargaining
  // arena. Mediation is horn-based. Nobody has signed anything in years.
  const ax = 509 // arena rect x 509..522, z -443..-430, gates mid W + E
  const az = -443
  kitFenceRun(ctx, ax, az, 14, true) // north side
  kitFenceRun(ctx, ax, -430, 14, true) // south side
  kitFenceRun(ctx, ax, az, 5, false) // west, north of gate
  kitFenceRun(ctx, ax, -435, 6, false) // west, south of gate
  kitFenceRun(ctx, ax + 13, az, 5, false) // east, north of gate
  kitFenceRun(ctx, ax + 13, -435, 6, false) // east, south of gate
  // the long table nobody agrees across
  batches.wood.add(512.5, 0.7, -437.4, 7, 0.35, 1.8, WOOD_DARK)
  batches.wood.add(513, 0, -437.2, 0.4, 0.7, 0.4, rng.pick(WOOD))
  batches.wood.add(518.8, 0, -437.2, 0.4, 0.7, 0.4, rng.pick(WOOD))
  for (let i = 0; i < 3; i++) {
    batches.wood.add(513.6 + i * 2.1, 0, -439, 0.7, 0.55, 0.7, rng.pick(WOOD)) // stools, north
    batches.wood.add(513.6 + i * 2.1, 0, -435.8, 0.7, 0.55, 0.7, rng.pick(WOOD)) // stools, south
  }
  grid.blockRect(512, -438, 8, 2)
  kitTotem(ctx, 510, -442) // union banners
  kitTotem(ctx, 521, -432)
  kitCampfire(ctx, 504, -446) // management's camp — ember-glow 1/2
  tent(ctx, 501, -449)
  kitCampfire(ctx, 528, -426) // the union's camp — ember-glow 2/2
  crates(ctx, 530, -428)

  // LANDMARK: "The Failed Gift Sled" — management sent a fruit basket by
  // sled. The sled made it. The basket did not.
  const gx = 553
  const gz = -461
  batches.wood.add(gx, 0.3, gz, 2.8, 0.4, 1.4, rng.pick(WOOD)) // sled bed, nose-up
  batches.wood.add(gx - 0.6, 0, gz - 0.1, 0.9, 0.5, 1.6, WOOD_DARK)
  batches.misc.add(gx + 0.2, 0, gz - 0.35, 2.4, 0.22, 0.3, WOOD_DARK) // runners
  batches.misc.add(gx + 0.2, 0, gz + 1.45, 2.4, 0.22, 0.3, WOOD_DARK)
  batches.misc.add(gx + 3, 0, gz + 0.4, 0.8, 0.5, 0.8, STRAW) // the late basket
  grid.blockRect(gx, gz, 3, 2)
  kitBone(ctx, gx + 2, gz + 3)

  const avoid: Avoid[] = [
    { x: 515, z: -436, r: 12 },
    { x: gx + 1, z: gz, r: 6 }
  ]
  cluster(ctx, 516, -437, 24, 10, avoid, (x, z) => kitPine(ctx, x, z))
  scatter(ctx, zone, 24, avoid, (x, z) => kitPine(ctx, x, z, { tall: ctx.rng.next() < 0.35 }))
  scatter(ctx, zone, 12, avoid, (x, z) => kitRock(ctx, x, z, (1 + ctx.rng.int(2)) as 1 | 2))
  scatter(ctx, zone, 8, avoid, (x, z) => kitIceSpike(ctx, x, z))
}

// ---------------------------------------------------------------------------
// burly_birches — forest 28-40
// ---------------------------------------------------------------------------

function buildBurlyBirches(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  const { batches, grid, rng } = ctx

  // 1. Surfaces: two short spurs off the NE arterial (which runs through
  //    this zone) — one to each landmark.
  kitPath(ctx, [
    [398, -278],
    [394, -277],
    [392, -278]
  ], 1.2)
  kitPath(ctx, [
    [392, -268],
    [404, -264],
    [418, -262],
    [430, -266],
    [433, -267]
  ])

  // 2. Ground
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Oldest Bouncer" — a birch so big it checks IDs. Note the
  // velvet rope. You are not on the list.
  const bx = 389 // 3x3 trunk at 389..391
  const bz = -283
  for (let y = 0; y < 9; y++) {
    batches.plaster.add(bx, y, bz, 3, 1, 3, rng.pick(BIRCH_BARK))
    if (rng.next() < 0.5) {
      batches.wood.add(bx - 0.08, y + 0.3, bz + rng.range(0, 2.2), 0.2, 0.3, 0.7, BIRCH_FLECK)
    }
    if (rng.next() < 0.5) {
      batches.wood.add(bx + rng.range(0, 2.2), y + 0.5, bz - 0.08, 0.7, 0.3, 0.2, BIRCH_FLECK)
    }
  }
  // root flares
  batches.plaster.add(bx - 1, 0, bz + 0.8, 1.2, 1.1, 1.4, rng.pick(BIRCH_BARK))
  batches.plaster.add(bx + 2.8, 0, bz + 0.8, 1.2, 0.9, 1.4, rng.pick(BIRCH_BARK))
  batches.plaster.add(bx + 0.8, 0, bz + 2.8, 1.4, 1, 1.2, rng.pick(BIRCH_BARK))
  grid.blockRect(bx - 1, bz, 5, 3)
  grid.blockRect(bx, bz - 1, 3, 5)
  // the canopy — a stacked green thunderhead
  batches.leaf.add(bx - 3, 8.6, bz - 3, 9, 2, 9, rng.pick(BIRCH_LEAF))
  batches.leaf.add(bx - 2, 10.6, bz - 2, 7, 1.6, 7, rng.pick(BIRCH_LEAF))
  batches.leaf.add(bx - 1, 12.2, bz - 1, 5, 1.3, 5, rng.pick(BIRCH_LEAF))
  batches.leaf.add(bx, 13.5, bz, 3, 1, 3, rng.pick(BIRCH_LEAF))
  // rope swing off the south bough
  batches.wood.add(bx + 1.3, 5.4, bz + 4.2, 0.1, 3.2, 0.1, WOOD_DARK)
  batches.wood.add(bx + 2.1, 5.4, bz + 4.2, 0.1, 3.2, 0.1, WOOD_DARK)
  batches.wood.add(bx + 1.15, 5.1, bz + 4, 1.2, 0.15, 0.5, rng.pick(WOOD))
  // velvet rope at the "entrance"
  batches.wood.add(bx + 3.8, 0, bz + 1.2, 0.25, 1.1, 0.25, WOOD_DARK)
  batches.wood.add(bx + 5.8, 0, bz + 1.2, 0.25, 1.1, 0.25, WOOD_DARK)
  batches.misc.add(bx + 4, 0.85, bz + 1.25, 1.9, 0.14, 0.14, TORII_RED)
  grid.block(bx + 3, bz + 1)
  grid.block(bx + 5, bz + 1)

  // LANDMARK: "The Arm-Wrestling Stump" — all forest disputes settled here,
  // best of three, loser waters the saplings.
  const sx = 433
  const sz = -269
  batches.wood.add(sx, 0, sz, 3, 1.15, 3, rng.pick(WOOD)) // the stump
  batches.misc.add(sx + 0.2, 1.15, sz + 0.2, 2.6, 0.1, 2.6, STRAW) // pale ring face
  batches.misc.add(sx + 0.8, 1.25, sz + 0.8, 1.4, 0.06, 1.4, rng.pick(WOOD)) // growth ring
  batches.wood.add(sx - 1.4, 0, sz + 1, 0.8, 0.7, 0.8, rng.pick(WOOD)) // challenger stools
  batches.wood.add(sx + 3.6, 0, sz + 1, 0.8, 0.7, 0.8, rng.pick(WOOD))
  grid.blockRect(sx, sz, 3, 3)
  grid.block(sx - 2, sz + 1)
  grid.block(sx + 4, sz + 1)
  kitCampfire(ctx, sx + 1, sz + 5) // ember-glow 1/2

  const avoid: Avoid[] = [
    { x: 390, z: -282, r: 9 },
    { x: sx + 1, z: sz + 1, r: 7 }
  ]
  // birch country: dense groves near the landmarks, honest forest between
  cluster(ctx, 390, -282, 24, 26, avoid, (x, z) => birch(ctx, x, z))
  cluster(ctx, sx, sz, 18, 14, avoid, (x, z) => birch(ctx, x, z))
  scatter(ctx, zone, 50, avoid, (x, z) => birch(ctx, x, z))
  scatter(ctx, zone, 16, avoid, (x, z) => kitTree(ctx, x, z, { big: ctx.rng.next() < 0.6 }))
  scatter(ctx, zone, 8, avoid, (x, z) => kitRock(ctx, x, z, 1))
}

// ---------------------------------------------------------------------------
// petal_peak — cherry 46-58
// ---------------------------------------------------------------------------

function buildPetalPeak(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  const { batches, grid, rng } = ctx
  const px = 540 // summit plaza center
  const pz = -298

  // 1. Surfaces: pilgrim path in from the NW corner (toward the arterial in
  //    the Chatterlands' corner), summit plaza circle, reflecting pool.
  kitPath(ctx, [
    [481, -357],
    [496, -342],
    [510, -328],
    [524, -314],
    [534, -304]
  ])
  for (let ix = px - 5; ix <= px + 5; ix++) {
    for (let iz = pz - 5; iz <= pz + 5; iz++) {
      if ((ix + 0.5 - px) ** 2 + (iz + 0.5 - pz) ** 2 <= 25) setSurface(ctx, ix, iz, S_COBBLE)
    }
  }
  kitPath(ctx, [
    [545, -301],
    [551, -308],
    [556, -316]
  ], 1.2)
  const pool = stampPool(ctx, 562, -322, 4, 3)

  // 2. Ground
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Blushing Summit" — a shrine plaza under one grand cherry
  // that has never once stopped showing off.
  // red gate at the path's mouth (SW approach)
  const gx = 536
  const gz = -305
  batches.misc.add(gx, 0, gz, 0.5, 3.4, 0.5, TORII_RED)
  batches.misc.add(gx + 4, 0, gz, 0.5, 3.4, 0.5, TORII_RED)
  batches.misc.add(gx - 0.5, 3.4, gz - 0.05, 5.5, 0.4, 0.6, TORII_RED)
  batches.misc.add(gx - 0.2, 2.6, gz, 4.9, 0.3, 0.5, WOOD_DARK)
  grid.block(gx, gz)
  grid.block(gx + 4, gz)
  // shrine stone with a warm offering-glow (shared window batch — no light)
  batches.stone.add(px - 0.5, 0, pz - 1.5, 1.4, 0.5, 1, rng.pick(STONE))
  batches.stone.add(px - 0.2, 0.5, pz - 1.3, 0.8, 0.8, 0.7, rng.pick(RUIN_STONE))
  batches.window.add(px + 0.05, 0.6, pz - 1.15, 0.36, 0.36, 0.36, WINDOW_GLOW)
  grid.blockRect(px - 1, pz - 2, 2, 2)
  // the grand cherry, NE of the plaza
  const cx = 546
  const cz = -293
  batches.wood.add(cx, 0, cz, 2, 5, 2, rng.pick(WOOD))
  batches.leaf.add(cx - 2.5, 5, cz - 2.5, 7, 1.8, 7, 0xf2a7c3)
  batches.leaf.add(cx - 1.5, 6.8, cz - 1.5, 5, 1.4, 5, 0xeb96b6)
  batches.leaf.add(cx - 0.5, 8.2, cz - 0.5, 3, 1.1, 3, 0xf8bcd2)
  grid.blockRect(cx, cz, 2, 2)
  for (let i = 0; i < 14; i++) {
    // petal-fall drifting on the plaza (no collision)
    batches.misc.add(
      px + rng.range(-5, 5),
      rng.next() < 0.5 ? 0.02 : rng.range(0.5, 3),
      pz + rng.range(-5, 5),
      0.22,
      0.07,
      0.22,
      rng.pick([0xf2a7c3, 0xf8bcd2, 0xe687ab] as const)
    )
  }

  // LANDMARK: "The Petal-Viewing Pavilion" — sit, sigh, pretend you meant
  // to get this emotional about a tree.
  const vx = 556
  const vz = -320
  batches.wood.add(vx, 0, vz, 0.4, 2.4, 0.4, WOOD_DARK)
  batches.wood.add(vx + 3, 0, vz, 0.4, 2.4, 0.4, WOOD_DARK)
  batches.wood.add(vx, 0, vz + 3, 0.4, 2.4, 0.4, WOOD_DARK)
  batches.wood.add(vx + 3, 0, vz + 3, 0.4, 2.4, 0.4, WOOD_DARK)
  batches.roof.add(vx - 0.8, 2.4, vz - 0.8, 5, 0.5, 5, 0x2f7d46) // village green, always
  batches.roof.add(vx + 0.3, 2.9, vz + 0.3, 2.8, 0.45, 2.8, 0x38914f)
  batches.wood.add(vx + 0.4, 0, vz + 1.2, 2.6, 0.5, 0.8, rng.pick(WOOD)) // bench
  grid.block(vx, vz)
  grid.block(vx + 3, vz)
  grid.block(vx, vz + 3)
  grid.block(vx + 3, vz + 3)
  // the reflecting pool, dusted with floating petals
  fillPool(ctx, pool, LAGOON_WATER)
  for (const [ix, iz] of pool) {
    if (rng.next() < 0.3) {
      batches.misc.add(ix + rng.range(0.1, 0.6), -0.2, iz + rng.range(0.1, 0.6), 0.22, 0.06, 0.22, 0xf2a7c3)
    }
  }
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 + 0.5
    kitRock(ctx, Math.floor(562 + Math.cos(ang) * 5.5), Math.floor(-322 + Math.sin(ang) * 4.5), 1)
  }

  const avoid: Avoid[] = [
    { x: px, z: pz, r: 9 },
    { x: 562, z: -322, r: 8 },
    { x: vx + 1, z: vz + 1, r: 5 }
  ]
  // blossom groves crowd the summit, thin out down the slopes
  cluster(ctx, px, pz, 22, 24, avoid, (x, z) => kitCherryTree(ctx, x, z))
  cluster(ctx, 562, -322, 14, 10, avoid, (x, z) => kitCherryTree(ctx, x, z))
  scatter(ctx, zone, 34, avoid, (x, z) => kitCherryTree(ctx, x, z))
  scatter(ctx, zone, 8, avoid, (x, z) => kitRock(ctx, x, z, 1))
}

// ---------------------------------------------------------------------------
// Registration — the zones/index barrel calls this once at boot
// ---------------------------------------------------------------------------

/** Register builders for ZONE_BATCHES[4] (the Northeast six). */
export function registerBatch5(): void {
  registerZoneBuilder('frosthold', buildFrosthold)
  registerZoneBuilder('mammoth_misgivings', buildMammoth)
  registerZoneBuilder('chatterlands', buildChatterlands)
  registerZoneBuilder('reindeer_standoff', buildReindeer)
  registerZoneBuilder('burly_birches', buildBurlyBirches)
  registerZoneBuilder('petal_peak', buildPetalPeak)
}
