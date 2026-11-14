/**
 * src/world/zones/batch13.ts — ZONE BATCH 13: the deep desert (south-center).
 *
 *   scrublands            The Scrublands         (savanna, lv 15-24)
 *   char_beyond           The Char Beyond        (wastes,  lv 19-29)
 *   great_sandbox         The Great Sandbox      (desert,  lv 42-55)
 *   mirage_mile           Mirage Mile            (desert,  lv 45-58, waystone 0,440)
 *   sandblasted_badlands  Sandblasted Badlands   (desert,  lv 62-76)
 *   undercrack            The Undercrack         (canyon,  lv 66-82)
 *
 * Contract per the streaming core: stamp surfaces FIRST (kitPath etc.),
 * then streamGroundPass, then props (kit builders mark collision).
 * Deterministic — every placement flows from the zone-seeded ctx.rng or
 * hand-placed constants, so eviction + re-entry rebuilds bit-for-bit.
 *
 * The S arterial ([1,240]→[-10,300]→[8,370]→[-6,440]→[12,520]) runs straight
 * through scrublands and mirage_mile; the other four zones get trails pointed
 * at their nearest arterial edge.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import {
  BONE_WHITE,
  CANYON_GROUND,
  DESERT_GROUND,
  EMBER,
  LAGOON_WATER,
  STRAW,
  WOOD,
  WOOD_DARK,
  kitBone,
  kitCactus,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitLantern,
  kitPalm,
  kitPath,
  kitRock,
  kitRuinPillar,
  kitTree
} from '../kit'
import { S_GRASS, S_SAND, setSurface, surfaceAt, type Ctx } from '../layout'
import type { ZoneDef } from './registry'

// Scraggly savanna canopy — gold-green, permanently considering combustion.
const SCRUB_LEAF = [0x9fae4f, 0xb0bd5f, 0x8d9c43, 0xc2b96a] as const
// Scorched char — for things that finished considering it.
const CHAR_BLACK = [0x2c2830, 0x242028, 0x363038] as const

// ---------------------------------------------------------------------------
// Shared placement helpers (deterministic: all randomness from ctx.rng)
// ---------------------------------------------------------------------------

/** [cx, cz, radius] prop keep-out circles (landmarks, waystones). */
type KeepOut = ReadonlyArray<readonly [number, number, number]>

function clearOf(ko: KeepOut, x: number, z: number): boolean {
  for (const [kx, kz, r] of ko) {
    const dx = x - kx
    const dz = z - kz
    if (dx * dx + dz * dz < r * r) return false
  }
  return true
}

/** True when (ix, iz) is open grass, unblocked, and outside every keep-out. */
function placeable(ctx: Ctx, ko: KeepOut, ix: number, iz: number): boolean {
  return (
    surfaceAt(ctx, ix, iz) === S_GRASS &&
    !ctx.grid.isBlocked(ix + 0.5, iz + 0.5) &&
    clearOf(ko, ix + 0.5, iz + 0.5)
  )
}

/** Sparse scatter across the zone rect (inset 4 from edges), n attempts. */
function scatter(
  ctx: Ctx,
  zone: ZoneDef,
  n: number,
  ko: KeepOut,
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < n; i++) {
    const ix = Math.floor(rng.range(zone.x0 + 4, zone.x1 - 4))
    const iz = Math.floor(rng.range(zone.z0 + 4, zone.z1 - 4))
    if (placeable(ctx, ko, ix, iz)) place(ix, iz)
  }
}

/** Cozy-dense ring scatter around a landmark, n attempts in [rMin, rMax]. */
function ring(
  ctx: Ctx,
  cx: number,
  cz: number,
  rMin: number,
  rMax: number,
  n: number,
  ko: KeepOut,
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2)
    const r = rng.range(rMin, rMax)
    const ix = Math.floor(cx + Math.cos(a) * r)
    const iz = Math.floor(cz + Math.sin(a) * r)
    if (placeable(ctx, ko, ix, iz)) place(ix, iz)
  }
}

// ---------------------------------------------------------------------------
// Bespoke landmark builders (voxel-box style, collision marked here)
// ---------------------------------------------------------------------------

/** One enormous flat-topped acacia — the only shade for a day's walk. */
function buildShadeTree(ctx: Ctx, tx: number, tz: number): void {
  const { rng, batches, grid } = ctx
  // thick forked trunk
  batches.wood.add(tx, 0, tz, 1.2, 4.6, 1.2, rng.pick(WOOD))
  batches.wood.add(tx + 0.9, 2.2, tz + 0.5, 1.6, 0.5, 0.5, rng.pick(WOOD)) // fork
  batches.wood.add(tx + 2.2, 2.6, tz + 0.5, 0.5, 2, 0.5, rng.pick(WOOD))
  // the famous flat top
  batches.leaf.add(tx - 3.4, 4.6, tz - 3.4, 8, 0.9, 8, rng.pick(SCRUB_LEAF))
  batches.leaf.add(tx - 2.2, 5.5, tz - 2.2, 5.6, 0.7, 5.6, rng.pick(SCRUB_LEAF))
  batches.leaf.add(tx - 0.8, 6.2, tz - 0.8, 2.8, 0.5, 2.8, rng.pick(SCRUB_LEAF))
  grid.blockRect(Math.floor(tx), Math.floor(tz), 2, 1)
  // the queue of picnics underneath: blanket, basket, abandoned second blanket
  batches.misc.add(tx - 2.6, 0, tz + 1.6, 1.8, 0.1, 1.4, 0xe14b4b)
  batches.wood.add(tx - 2.2, 0.1, tz + 1.9, 0.6, 0.5, 0.6, WOOD_DARK) // basket
  batches.misc.add(tx + 2.4, 0, tz - 2.2, 1.6, 0.1, 1.3, 0xf5d547)
}

/** A brush fire that got put on probation: charred scrub, one smolder, the
 *  bucket line that (mostly) won. ONE ember-glow use. */
function buildSmolderPatch(ctx: Ctx, cx: number, cz: number): void {
  const { rng, batches, grid } = ctx
  for (let i = 0; i < 9; i++) {
    const a = rng.range(0, Math.PI * 2)
    const r = rng.range(1, 5)
    const bx = cx + Math.cos(a) * r
    const bz = cz + Math.sin(a) * r
    const s = rng.range(0.3, 0.7)
    batches.misc.add(bx, 0, bz, s, rng.range(0.3, 0.9), s, rng.pick(CHAR_BLACK))
  }
  batches.window.add(cx - 0.4, 0, cz - 0.4, 0.8, 0.3, 0.8, EMBER) // still thinking about it
  grid.blockRect(Math.floor(cx) - 1, Math.floor(cz) - 1, 2, 2)
  // the bucket line, dropped mid-victory
  for (let i = 0; i < 3; i++) {
    batches.wood.add(cx + 6 + i * 1.4, 0, cz + 1 + (i % 2) * 0.8, 0.55, 0.5, 0.55, WOOD_DARK)
  }
}

/** Colossal half-buried ribcage arching over a long-cold feast pit. */
function buildRibcage(ctx: Ctx, rx: number, rz: number): void {
  const { rng, batches, grid } = ctx
  // spine, mostly swallowed by the ground
  batches.misc.add(rx - 1, 0, rz + 6.4, 17, 0.6, 0.9, rng.pick(BONE_WHITE))
  // five rib arches you can walk beneath (only the rib feet block)
  for (let i = 0; i < 5; i++) {
    const x = rx + i * 3.2
    const c = rng.pick(BONE_WHITE)
    const h = 3.4 + rng.range(0, 1)
    batches.misc.add(x, 0, rz, 0.7, h, 0.7, c) // south rib foot
    batches.misc.add(x, 0, rz + 5.6, 0.7, h, 0.7, c) // north rib foot
    batches.misc.add(x, h, rz + 0.2, 0.7, 0.6, 5.8, c) // the arch over
    grid.block(Math.floor(x), Math.floor(rz))
    grid.block(Math.floor(x), Math.floor(rz + 5.6))
  }
  // the feast pit it was presumably the main course of — ONE ember-glow use
  batches.stone.add(rx + 5, 0, rz + 2.2, 2.2, 0.35, 2.2, rng.pick(CHAR_BLACK))
  batches.window.add(rx + 5.7, 0.1, rz + 2.9, 0.8, 0.3, 0.8, EMBER)
  grid.blockRect(Math.floor(rx + 5), Math.floor(rz + 2.2), 2, 2)
}

/** Rows of thoroughly dead trees somebody planted anyway, plus the can. */
function buildDeadOrchard(ctx: Ctx, ox: number, oz: number): void {
  const { batches, grid } = ctx
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      kitDeadTree(ctx, ox + col * 4, oz + row * 5)
    }
  }
  kitFenceRun(ctx, ox - 2, oz - 3, 8, true) // optimistic fencing
  kitFenceRun(ctx, ox - 2, oz - 2, 5, false)
  // the watering can of a true believer
  batches.misc.add(ox + 6, 0, oz + 2.4, 0.5, 0.5, 0.5, 0x8a8f96)
  batches.misc.add(ox + 6.45, 0.2, oz + 2.55, 0.5, 0.14, 0.14, 0x8a8f96)
  grid.block(ox + 6, oz + 2)
}

/** A sandcastle the size of an actual castle, bucket turrets and all. */
function buildSandcastle(ctx: Ctx, sx: number, sz: number): void {
  const { rng, batches, grid } = ctx
  // stepped keep
  batches.stone.add(sx, 0, sz, 9, 2.2, 9, rng.pick(DESERT_GROUND))
  batches.stone.add(sx + 1.2, 2.2, sz + 1.2, 6.6, 1.6, 6.6, rng.pick(DESERT_GROUND))
  batches.stone.add(sx + 2.6, 3.8, sz + 2.6, 3.8, 1.3, 3.8, rng.pick(DESERT_GROUND))
  // upturned-bucket corner turrets (the classic technique, scaled up)
  for (const [dx, dz] of [[-0.8, -0.8], [8.2, -0.8], [-0.8, 8.2], [8.2, 8.2]] as const) {
    batches.stone.add(sx + dx, 0, sz + dz, 1.6, 3, 1.6, rng.pick(DESERT_GROUND))
    batches.stone.add(sx + dx - 0.2, 3, sz + dz - 0.2, 2, 0.5, 2, rng.pick(DESERT_GROUND))
  }
  // seashell crenellations + a proud little flag
  batches.misc.add(sx + 3.6, 5.1, sz + 3.6, 1.8, 0.3, 1.8, rng.pick(BONE_WHITE))
  batches.wood.add(sx + 4.4, 5.4, sz + 4.4, 0.14, 2.2, 0.14, WOOD_DARK)
  batches.misc.add(sx + 4.54, 6.9, sz + 4.4, 0.9, 0.55, 0.1, 0xe14b4b)
  grid.blockRect(sx - 1, sz - 1, 11, 11)
  // the architect's shovel — colossal, abandoned, load-bearingly smug
  batches.wood.add(sx + 11, 0.3, sz + 2, 7, 0.5, 0.5, rng.pick(WOOD)) // haft
  batches.misc.add(sx + 18, 0, sz + 1.3, 2.2, 0.6, 1.9, 0x8a8f96) // blade
  grid.blockRect(sx + 11, sz + 1, 9, 2)
}

/** Funnel trap of something with far too many legs: sunken sand pit, rim
 *  mounds, and the belongings of previous visitors. */
function buildLegPit(ctx: Ctx, cx: number, cz: number): void {
  const { rng, batches, grid } = ctx
  // sunken pit floor (the sand surface is pre-stamped around it)
  batches.grass.add(cx - 2.5, -0.55, cz - 2.5, 5, 0.5, 5, rng.pick(DESERT_GROUND))
  batches.grass.add(cx - 1.2, -0.75, cz - 1.2, 2.4, 0.3, 2.4, rng.pick(DESERT_GROUND))
  grid.blockRect(Math.floor(cx) - 2, Math.floor(cz) - 2, 4, 4) // nobody walks in. On purpose.
  // rim mounds kicked up by the excavator
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3
    const mx = cx + Math.cos(a) * 4.2
    const mz = cz + Math.sin(a) * 4.2
    batches.grass.add(mx, 0, mz, 1.3, rng.range(0.3, 0.7), 1.3, rng.pick(DESERT_GROUND))
  }
  // previous visitors' effects, politely spat back out
  kitBone(ctx, Math.floor(cx) + 5, Math.floor(cz) - 4)
  batches.wood.add(cx - 5.5, 0, cz + 3.5, 0.7, 0.7, 0.7, WOOD_DARK) // one (1) boot-sized crate
  grid.block(Math.floor(cx - 5.5), Math.floor(cz + 3.5))
}

/** The 100% Genuine Oasis — water, palms, and a sign protesting too much.
 *  Stamp its sand apron BEFORE streamGroundPass (see stampOasisSand). */
function stampOasisSand(ctx: Ctx, cx: number, cz: number): void {
  for (let ix = cx - 6; ix <= cx + 6; ix++) {
    for (let iz = cz - 5; iz <= cz + 5; iz++) {
      const dx = ix - cx
      const dz = iz - cz
      if (dx * dx + dz * dz <= 32) setSurface(ctx, ix, iz, S_SAND)
    }
  }
}
function buildOasis(ctx: Ctx, cx: number, cz: number): void {
  const { batches, grid } = ctx
  // the pool (sunken, suspiciously perfect)
  batches.misc.add(cx - 3, -0.6, cz - 2.4, 6, 0.55, 4.8, LAGOON_WATER)
  grid.blockRect(Math.floor(cx) - 3, Math.floor(cz) - 2, 6, 5)
  kitPalm(ctx, Math.floor(cx) - 5, Math.floor(cz) - 4)
  kitPalm(ctx, Math.floor(cx) + 4, Math.floor(cz) - 3)
  kitPalm(ctx, Math.floor(cx) + 3, Math.floor(cz) + 3)
  // the sign: "REAL WATER. STOP ASKING."
  batches.wood.add(cx - 5, 0, cz + 3.6, 0.2, 1.7, 0.2, WOOD_DARK)
  batches.wood.add(cx - 5.8, 1.3, cz + 3.56, 1.9, 0.8, 0.14, 0xd8b84a)
  grid.block(Math.floor(cx - 5), Math.floor(cz + 3.6))
}

/** Honest Jim's Mirage Emporium — a vendor stall selling absolutely nothing,
 *  stock guaranteed invisible or your money back. */
function buildEmporium(ctx: Ctx, scene: THREE.Scene, ex: number, ez: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ex, 0, ez, 4, 1, 1.2, rng.pick(WOOD)) // counter
  batches.wood.add(ex + 0.1, 1, ez + 2.6, 0.3, 2.2, 0.3, WOOD_DARK) // back posts
  batches.wood.add(ex + 3.6, 1, ez + 2.6, 0.3, 2.2, 0.3, WOOD_DARK)
  batches.misc.add(ex - 0.4, 3, ez - 0.4, 4.8, 0.3, 3.8, STRAW) // awning
  // shelves of premium nothing + one crate of backup nothing
  batches.wood.add(ex + 0.2, 1.6, ez + 2.5, 3.6, 0.18, 0.6, rng.pick(WOOD))
  batches.wood.add(ex + 4.6, 0, ez + 1.4, 0.8, 0.8, 0.8, WOOD_DARK)
  grid.blockRect(ex, ez, 4, 3)
  grid.block(ex + 4, ez + 1)
  // Jim left the light on — this zone's one lantern
  kitLantern(ctx, scene, ex + 5, ez + 3)
}

/** Judgy McBonesface — a colossal half-buried skull wearing a permanent
 *  disapproving brow, vertebrae trailing off into the dunes. */
function buildJudgySkull(ctx: Ctx, kx: number, kz: number): void {
  const { rng, batches, grid } = ctx
  const c = rng.pick(BONE_WHITE)
  batches.misc.add(kx, 0, kz, 6, 3.4, 5, c) // cranium
  batches.misc.add(kx + 0.6, 0, kz - 1.6, 4.8, 1.6, 1.8, rng.pick(BONE_WHITE)) // jaw, buried
  // eye sockets — dark, unblinking, judging your build
  batches.stone.add(kx + 1, 1.5, kz - 0.25, 1.3, 1.1, 0.4, 0x1d1b22)
  batches.stone.add(kx + 3.7, 1.5, kz - 0.25, 1.3, 1.1, 0.4, 0x1d1b22)
  // THE BROW (tilted-slab disapproval)
  batches.misc.add(kx + 0.7, 2.7, kz - 0.4, 2, 0.5, 0.6, c)
  batches.misc.add(kx + 3.3, 2.9, kz - 0.4, 2, 0.5, 0.6, c)
  grid.blockRect(kx, kz - 2, 6, 7)
  // vertebrae wandering off like an ellipsis
  for (let i = 0; i < 5; i++) {
    const vx = kx + 7.5 + i * 2.6
    const vz = kz + 1.5 + Math.sin(i * 1.7) * 1.6
    const s = 1.3 - i * 0.14
    batches.misc.add(vx, 0, vz, s, s * 0.7, s, rng.pick(BONE_WHITE))
    grid.block(Math.floor(vx), Math.floor(vz))
  }
}

/** The Dry Regatta — a proud sailing ship wrecked a comfortable day's walk
 *  from any water whatsoever. */
function buildSandShip(ctx: Ctx, wx: number, wz: number): void {
  const { rng, batches, grid } = ctx
  const hull = rng.pick(WOOD)
  // tilted hull, half-swallowed
  batches.wood.add(wx, 0, wz, 11, 1.6, 4, hull)
  batches.wood.add(wx + 0.8, 1.6, wz - 0.4, 9.4, 1.1, 4.8, rng.pick(WOOD)) // gunwale flare
  batches.wood.add(wx + 11, 0, wz + 0.8, 1.8, 2.6, 2.4, hull) // raked bow block
  batches.wood.add(wx - 1.2, 0, wz + 0.9, 1.4, 2.1, 2.2, rng.pick(WOOD)) // stern castle
  grid.blockRect(wx - 2, wz - 1, 15, 6)
  // mast, boom, and a sail that gave up in tatters
  batches.wood.add(wx + 5.4, 2.7, wz + 1.7, 0.5, 6.5, 0.5, WOOD_DARK)
  batches.wood.add(wx + 3.4, 8.2, wz + 1.75, 4.6, 0.35, 0.35, WOOD_DARK)
  batches.plaster.add(wx + 3.6, 5.6, wz + 1.65, 1.8, 2.6, 0.12, 0xe9ddc2)
  batches.plaster.add(wx + 6.1, 6.4, wz + 1.65, 1.6, 1.8, 0.12, 0xe2d4b6)
  // the captain went down with the dignity
  batches.misc.add(wx + 1.4, 2.7, wz + 1.4, 0.7, 0.5, 0.7, WOOD_DARK) // wheel stump
  kitBone(ctx, wx + 3, wz + 6)
}

/** The slot canyon itself: two winding walls, a passage one regret wide.
 *  Stamps its own sandy floor BEFORE the ground pass (call pre-ground). */
function stampSlotFloor(ctx: Ctx, cx: number, z0: number, z1: number): void {
  for (let z = z0; z <= z1; z++) {
    const mid = cx + Math.sin(z * 0.09) * 4
    for (let ix = Math.floor(mid) - 2; ix <= Math.floor(mid) + 2; ix++) {
      setSurface(ctx, ix, z, S_SAND)
    }
  }
}
function buildSlotCanyon(ctx: Ctx, cx: number, z0: number, z1: number): void {
  const { rng, batches, grid } = ctx
  for (let z = z0; z <= z1; z += 2) {
    const mid = cx + Math.sin(z * 0.09) * 4
    const wH = 5 + rng.range(0, 2.5)
    const eH = 5 + rng.range(0, 2.5)
    const wx = Math.floor(mid) - 5
    const ex = Math.floor(mid) + 3
    batches.stone.add(wx, 0, z, 3, wH, 2, rng.pick(CANYON_GROUND)) // west wall
    batches.stone.add(wx + 0.5, wH, z + 0.2, 2, 0.8, 1.6, rng.pick(CANYON_GROUND)) // cap
    batches.stone.add(ex, 0, z, 3, eH, 2, rng.pick(CANYON_GROUND)) // east wall
    batches.stone.add(ex + 0.5, eH, z + 0.2, 2, 0.8, 1.6, rng.pick(CANYON_GROUND))
    grid.blockRect(wx, z, 3, 2)
    grid.blockRect(ex, z, 3, 2)
  }
}

/** The Echo Toll Gate — an honor-system turnpike mid-canyon. The hermit
 *  accepts coins, compliments, and snacks. Mostly snacks. */
function buildTollGate(ctx: Ctx, gx: number, gz: number): void {
  const { rng, batches, grid } = ctx
  // gate posts either side of the passage + a bar you duck under
  batches.wood.add(gx - 2.4, 0, gz, 0.45, 2.6, 0.45, WOOD_DARK)
  batches.wood.add(gx + 2, 0, gz, 0.45, 2.6, 0.45, WOOD_DARK)
  batches.wood.add(gx - 2.4, 2.3, gz + 0.05, 4.9, 0.3, 0.3, rng.pick(WOOD))
  grid.block(Math.floor(gx - 2.4), Math.floor(gz))
  grid.block(Math.floor(gx + 2), Math.floor(gz))
  // the booth (hermit-sized) + the snack tin
  batches.wood.add(gx + 3, 0, gz - 1.6, 2, 2.2, 2, rng.pick(WOOD))
  batches.misc.add(gx + 2.6, 0.9, gz + 0.4, 0.5, 0.35, 0.5, 0x8a8f96)
  batches.misc.add(gx + 2.9, 0, gz - 2.2, 2.4, 0.5, 2.6, STRAW) // booth roof... on the ground
  grid.blockRect(Math.floor(gx + 3), Math.floor(gz - 2), 2, 3)
}

// ---------------------------------------------------------------------------
// 1. THE SCRUBLANDS — everything is mildly on fire, or thinking about it
// ---------------------------------------------------------------------------

registerZoneBuilder('scrublands', (ctx, _scene, zone) => {
  // LANDMARK A: "The One Shade Tree" — a colossal acacia with a picnic queue.
  // LANDMARK B: "Smokey's Probation Meadow" — a brush fire on its last warning.
  const tree: readonly [number, number] = [-44, 292]
  const smolder: readonly [number, number] = [38, 332]

  // spurs off the S arterial (runs through at [-10,300] / [8,370])
  kitPath(ctx, [[-11, 300], [-22, 297], [-34, 294], [-42, 292]])
  kitPath(ctx, [[2, 340], [14, 336], [26, 334], [36, 332]], 1.1)
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[tree[0], tree[1], 7], [smolder[0], smolder[1], 7]]
  buildShadeTree(ctx, tree[0], tree[1])
  buildSmolderPatch(ctx, smolder[0], smolder[1]) // ember-glow use 1 (and only)

  // golden scrub: dense-ish around the tree, scraggle between
  ring(ctx, tree[0], tree[1], 8, 18, 18, ko, (x, z) => kitTree(ctx, x, z, { leaves: SCRUB_LEAF }))
  ring(ctx, smolder[0], smolder[1], 7, 14, 10, ko, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, zone, 34, ko, (x, z) => kitTree(ctx, x, z, { leaves: SCRUB_LEAF }))
  scatter(ctx, zone, 16, ko, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, zone, 18, ko, (x, z) => kitRock(ctx, x, z, 1))
})

// ---------------------------------------------------------------------------
// 2. THE CHAR BEYOND — the ash out here has career ambitions
// ---------------------------------------------------------------------------

registerZoneBuilder('char_beyond', (ctx, _scene, zone) => {
  // LANDMARK A: "The Grand Barbecue" — a colossal ribcage over a cold feast pit.
  // LANDMARK B: "The Optimist's Orchard" — dead trees, planted in neat rows, on purpose.
  const ribs: readonly [number, number] = [142, 294] // ribcage west end
  const orchard: readonly [number, number] = [190, 332] // orchard NW corner

  // trail in from the SE arterial clipping the NE corner (~(236,236))
  kitPath(ctx, [[234, 243], [220, 254], [204, 266], [186, 278], [168, 288], [152, 295]])
  kitPath(ctx, [[186, 278], [189, 296], [193, 314], [191, 330]], 1.1)
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [
    [ribs[0] + 8, ribs[1] + 3, 12],
    [orchard[0] + 6, orchard[1] + 3, 10]
  ]
  buildRibcage(ctx, ribs[0], ribs[1]) // ember-glow use 1 (and only)
  buildDeadOrchard(ctx, orchard[0], orchard[1])

  ring(ctx, ribs[0] + 8, ribs[1] + 3, 10, 18, 14, ko, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 30, ko, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, zone, 18, ko, (x, z) => kitRock(ctx, x, z, ctx.rng.next() < 0.3 ? 2 : 1))
  scatter(ctx, zone, 12, ko, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 6, ko, (x, z) => kitRuinPillar(ctx, x, z))
})

// ---------------------------------------------------------------------------
// 3. THE GREAT SANDBOX — an endless play-pit for things with too many legs
// ---------------------------------------------------------------------------

registerZoneBuilder('great_sandbox', (ctx, _scene, zone) => {
  // LANDMARK A: "Castle Buckethead" — a sandcastle built by something ENORMOUS.
  // LANDMARK B: "The Welcome Funnel" — a leg-thing's trap pit, politely marked.
  const castle: readonly [number, number] = [-168, 420] // keep rect corner
  const pit: readonly [number, number] = [-128, 472]

  // trail west from the mirage_mile border (its spur meets us at z=436)
  kitPath(ctx, [[-80, 436], [-98, 434], [-116, 430], [-136, 426], [-152, 424], [-158, 423]])
  kitPath(ctx, [[-136, 426], [-132, 444], [-128, 460], [-128, 466]], 1.1)
  stampOasisSand(ctx, pit[0], pit[1]) // the funnel sits in its own sand bowl
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[castle[0] + 4.5, castle[1] + 4.5, 13], [pit[0], pit[1], 8]]
  buildSandcastle(ctx, castle[0], castle[1])
  buildLegPit(ctx, pit[0], pit[1])

  ring(ctx, castle[0] + 4, castle[1] + 4, 13, 22, 16, ko, (x, z) => kitCactus(ctx, x, z))
  ring(ctx, pit[0], pit[1], 8, 15, 10, ko, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 26, ko, (x, z) => kitCactus(ctx, x, z))
  scatter(ctx, zone, 16, ko, (x, z) => kitRock(ctx, x, z, ctx.rng.next() < 0.3 ? 2 : 1))
  scatter(ctx, zone, 10, ko, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 6, ko, (x, z) => kitDeadTree(ctx, x, z))
})

// ---------------------------------------------------------------------------
// 4. MIRAGE MILE — the oasis is fake, the scorpions are devastatingly real
//    (waystone ws_mirage_mile at 0, 440)
// ---------------------------------------------------------------------------

registerZoneBuilder('mirage_mile', (ctx, scene, zone) => {
  // LANDMARK A: "The 100% Genuine Oasis" — real water, allegedly. Stop asking.
  // LANDMARK B: "Honest Jim's Mirage Emporium" — premium invisible inventory.
  const oasis: readonly [number, number] = [38, 408]
  const stall: readonly [number, number] = [-36, 468] // stall rect corner

  // spurs off the S arterial (runs through at [-6,440]); west spur carries on
  // to the great_sandbox border trail at z=436
  kitPath(ctx, [[-4, 428], [10, 420], [24, 414], [34, 410]])
  kitPath(ctx, [[-6, 448], [-18, 458], [-30, 465], [-34, 467]], 1.1)
  kitPath(ctx, [[-8, 440], [-28, 438], [-50, 437], [-66, 436], [-80, 436]], 1.1)
  stampOasisSand(ctx, oasis[0], oasis[1])
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [
    [0, 440, 6], // waystone anchor stays clear + reachable (it's roadside)
    [oasis[0], oasis[1], 9],
    [stall[0] + 2.5, stall[1] + 1.5, 7]
  ]
  buildOasis(ctx, oasis[0], oasis[1])
  buildEmporium(ctx, scene, stall[0], stall[1]) // includes this zone's 1 lantern

  ring(ctx, oasis[0], oasis[1], 9, 17, 12, ko, (x, z) => kitCactus(ctx, x, z))
  ring(ctx, stall[0] + 2, stall[1] + 1, 7, 13, 8, ko, (x, z) => kitCactus(ctx, x, z))
  scatter(ctx, zone, 30, ko, (x, z) => kitCactus(ctx, x, z))
  scatter(ctx, zone, 14, ko, (x, z) => kitRock(ctx, x, z, 1))
  scatter(ctx, zone, 10, ko, (x, z) => kitBone(ctx, x, z))
})

// ---------------------------------------------------------------------------
// 5. SANDBLASTED BADLANDS — bleached bones in increasingly judgmental patterns
// ---------------------------------------------------------------------------

registerZoneBuilder('sandblasted_badlands', (ctx, _scene, zone) => {
  // LANDMARK A: "Judgy McBonesface" — a colossal skull that disapproves of you.
  // LANDMARK B: "The Dry Regatta" — a shipwreck a full day's walk from water.
  const skull: readonly [number, number] = [-312, 586] // cranium rect corner
  const wreck: readonly [number, number] = [-310, 664] // hull rect corner

  // trailhead at the north border, pointed at the SW arterial (~(-430,440)),
  // winding down past the skull to the wreck
  kitPath(ctx, [[-350, 522], [-340, 538], [-330, 554], [-320, 570], [-312, 582]])
  kitPath(ctx, [[-312, 582], [-306, 606], [-310, 628], [-304, 648], [-305, 660]], 1.1)
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[skull[0] + 3, skull[1] + 1, 10], [wreck[0] + 5, wreck[1] + 1, 11]]
  buildJudgySkull(ctx, skull[0], skull[1])
  buildSandShip(ctx, wreck[0], wreck[1])

  // the judgmental patterns: bone semicircles fanned before the skull
  for (let arc = 0; arc < 2; arc++) {
    const r = 9 + arc * 4
    for (let i = 0; i < 5 + arc * 2; i++) {
      const a = Math.PI * (0.15 + (0.7 * i) / (4 + arc * 2))
      const bx = Math.floor(skull[0] + 3 + Math.cos(a) * r)
      const bz = Math.floor(skull[1] - 2 - Math.sin(a) * r * 0.7)
      if (placeable(ctx, ko, bx, bz)) kitBone(ctx, bx, bz)
    }
  }
  ring(ctx, wreck[0] + 5, wreck[1] + 1, 11, 18, 8, ko, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 22, ko, (x, z) => kitBone(ctx, x, z))
  scatter(ctx, zone, 18, ko, (x, z) => kitRock(ctx, x, z, ctx.rng.next() < 0.35 ? 2 : 1))
  scatter(ctx, zone, 14, ko, (x, z) => kitCactus(ctx, x, z))
  scatter(ctx, zone, 8, ko, (x, z) => kitDeadTree(ctx, x, z))
})

// ---------------------------------------------------------------------------
// 6. THE UNDERCRACK — a canyon so narrow your shadow walks behind you
// ---------------------------------------------------------------------------

registerZoneBuilder('undercrack', (ctx, _scene, zone) => {
  // LANDMARK A: "The Undercrack" — the slot canyon itself, one regret wide.
  // LANDMARK B: "The Echo Toll Gate" — an honor-system turnpike, snacks accepted.
  const slotX = -160 // canyon midline
  const slotZ0 = 560
  const slotZ1 = 660
  const gate: readonly [number, number] = [-160 + Math.sin(610 * 0.09) * 4, 610]

  // trail in from the east border (pointed at the S arterial, ~x 0) to the
  // canyon's north mouth, with floor + walls stamped before the ground pass
  kitPath(ctx, [[-80, 598], [-98, 590], [-114, 580], [-130, 570], [-146, 562], [-158, 558]])
  stampSlotFloor(ctx, slotX, slotZ0, slotZ1)
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[slotX, (slotZ0 + slotZ1) / 2, 14], [gate[0], gate[1], 6]]
  buildSlotCanyon(ctx, slotX, slotZ0, slotZ1)
  buildTollGate(ctx, gate[0], gate[1])
  kitCampfire(ctx, Math.floor(gate[0]) + 5, gate[1] - 6) // hermit's brew fire — ember use 1

  // mesa rubble crowding the rims, thinning toward the zone edges
  ring(ctx, slotX, slotZ0 + 20, 12, 24, 18, ko, (x, z) =>
    kitRock(ctx, x, z, ctx.rng.next() < 0.4 ? 3 : 2)
  )
  ring(ctx, slotX, slotZ1 - 20, 12, 24, 18, ko, (x, z) =>
    kitRock(ctx, x, z, ctx.rng.next() < 0.4 ? 3 : 2)
  )
  scatter(ctx, zone, 30, ko, (x, z) =>
    kitRock(ctx, x, z, ctx.rng.next() < 0.2 ? 3 : ctx.rng.next() < 0.5 ? 2 : 1)
  )
  scatter(ctx, zone, 14, ko, (x, z) => kitCactus(ctx, x, z))
  scatter(ctx, zone, 10, ko, (x, z) => kitDeadTree(ctx, x, z))
})

/**
 * Barrel hook — the zones/index barrel calls this. Registration actually
 * happens at module import (registerZoneBuilder calls above), so this is an
 * idempotent no-op that exists to give the barrel an explicit import edge.
 */
export function registerBatch13(): void {
  // builders registered at module scope; nothing further to do
}
