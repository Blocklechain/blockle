/**
 * THE ROYAL CAPITAL — region builder (x -80..80, z -240..-80, biome city).
 *
 * A proper walled city in the village's own voxel vocabulary: pale stone
 * ramparts with gate towers, cobbled street blocks, a stall-lined market
 * square, guild hall, columned bank facade, a fountain plaza, a hedged
 * royal garden, and — crowning the north end — the grand castle: curtain
 * wall, tiered keep, turrets, green spires and crimson banners.
 *
 * Everything is batches + surface stamps + collision, exactly like the
 * village. Kept clear: the north road corridor from the village gate to
 * the Capital Waystone (6, -140), the waystone plaza itself, and the NPC
 * anchor cells (Captain Elara 0,-150 / Banker Aldous 20,-170 / Archmage
 * Lyra -30,-190). Point lights: 6 lanterns total (city gate, fountain
 * plaza, castle gate).
 */
import type * as THREE from 'three'
import {
  S_COBBLE,
  S_GRASS,
  S_SOIL,
  setSurface,
  setSurfaceRect,
  type BuildingSpec,
  type Ctx
} from '../layout'
import {
  kitHouseShell,
  kitFenceRun,
  kitLantern,
  kitPath,
  kitTree,
  FLOWER,
  LEAF,
  STONE,
  WATER,
  WINDOW_GLOW,
  WOOD,
  WOOD_DARK
} from '../kit'

// Royal accent colors (flat, same Lambert look as everything else)
const CRIMSON = 0xa8333d
const GOLD = 0xd9a93c
const CREAM = 0xece4d2
const BLUE = 0x3f6fb5

/** Pale capital masonry — lighter than the village's grey STONE. */
const CAP_STONE = [0xbdb8ab, 0xaeaa9d, 0xc8c3b6] as const
const CAP_PLASTER = [0xefe8d6, 0xe7dfca] as const
const CAP_PAL = { stone: CAP_STONE, plaster: CAP_PLASTER } as const

// ---------------------------------------------------------------------------
// Small builders (kept local — city-only shapes)
// ---------------------------------------------------------------------------

/** Crenellated rampart run: long body box + base course + merlons. */
function wallRun(
  ctx: Ctx,
  x0: number,
  z0: number,
  len: number,
  alongX: boolean,
  h = 3.4,
  stone: readonly number[] = CAP_STONE
): void {
  const { batches, grid, rng } = ctx
  if (alongX) {
    batches.stone.add(x0, 0, z0, len, h, 1, stone[1]!)
    batches.stone.add(x0, 0, z0 - 0.15, len, 0.7, 1.3, stone[0]!)
    batches.stone.add(x0, h - 0.25, z0 - 0.12, len, 0.3, 1.24, stone[2]!)
    for (let i = 0; i < len; i += 2) {
      batches.stone.add(x0 + i + 0.15, h, z0 + 0.15, 0.7, 0.7, 0.7, rng.pick(stone))
    }
    grid.blockRect(x0, z0, len, 1)
  } else {
    batches.stone.add(x0, 0, z0, 1, h, len, stone[1]!)
    batches.stone.add(x0 - 0.15, 0, z0, 1.3, 0.7, len, stone[0]!)
    batches.stone.add(x0 - 0.12, h - 0.25, z0, 1.24, 0.3, len, stone[2]!)
    for (let i = 0; i < len; i += 2) {
      batches.stone.add(x0 + 0.15, h, z0 + i + 0.15, 0.7, 0.7, 0.7, rng.pick(stone))
    }
    grid.blockRect(x0, z0, 1, len)
  }
}

interface TowerOpts {
  stone?: readonly number[]
  /** Stepped green spire on top. */
  spire?: boolean
  /** Crimson banner hung from the parapet. */
  banner?: boolean
}

/** Square tower: skirt, body, parapet with merlons, windows, extras. */
function tower(ctx: Ctx, x0: number, z0: number, s: number, h: number, opts: TowerOpts = {}): void {
  const { batches, grid, rng } = ctx
  const stone = opts.stone ?? CAP_STONE
  batches.stone.add(x0 - 0.3, 0, z0 - 0.3, s + 0.6, 1.1, s + 0.6, stone[0]!)
  batches.stone.add(x0, 0, z0, s, h, s, stone[1]!)
  batches.stone.add(x0 - 0.35, h, z0 - 0.35, s + 0.7, 0.5, s + 0.7, stone[2]!)
  // merlons around the parapet rim
  for (let i = 0; i < s; i += 2) {
    batches.stone.add(x0 + i + 0.15, h + 0.5, z0 - 0.2, 0.7, 0.7, 0.7, rng.pick(stone))
    batches.stone.add(x0 + i + 0.15, h + 0.5, z0 + s - 0.5, 0.7, 0.7, 0.7, rng.pick(stone))
    batches.stone.add(x0 - 0.2, h + 0.5, z0 + i + 0.15, 0.7, 0.7, 0.7, rng.pick(stone))
    batches.stone.add(x0 + s - 0.5, h + 0.5, z0 + i + 0.15, 0.7, 0.7, 0.7, rng.pick(stone))
  }
  // a glowing arrow-slit window on the south face
  batches.window.add(x0 + s / 2 - 0.4, h * 0.55, z0 + s - 0.15, 0.8, 1.3, 0.3, WINDOW_GLOW)
  if (opts.spire) {
    let rw = s + 0.6
    let y = h + 0.5
    let off = -0.3
    while (rw > 0.8) {
      batches.roof.add(x0 + off, y, z0 + off, rw, 0.6, rw, rng.pick([0x2f7d46, 0x29703e, 0x38914f] as const))
      y += 0.6
      rw -= 1.1
      off += 0.55
    }
    batches.misc.add(x0 + s / 2 - 0.12, y, z0 + s / 2 - 0.12, 0.24, 0.9, 0.24, GOLD)
  }
  if (opts.banner) {
    const bx = x0 + s / 2 - 0.1
    batches.misc.add(bx, h - 3.2, z0 + s + 0.1, 0.9, 2.6, 0.14, CRIMSON)
    batches.misc.add(bx, h - 3.2, z0 + s + 0.1, 0.9, 0.35, 0.15, GOLD)
  }
  grid.blockRect(x0, z0, s, s)
}

/** Street banner pole — crimson royal cloth on a dark post. Blocks the cell. */
function bannerPole(ctx: Ctx, ix: number, iz: number): void {
  const { batches, grid } = ctx
  batches.wood.add(ix + 0.4, 0, iz + 0.4, 0.2, 3.8, 0.2, WOOD_DARK)
  batches.wood.add(ix + 0.4, 3.8, iz - 0.3, 0.2, 0.18, 1.4, WOOD_DARK)
  batches.misc.add(ix + 0.33, 1.9, iz - 0.25, 0.34, 1.95, 0.8, CRIMSON)
  batches.misc.add(ix + 0.31, 1.9, iz - 0.27, 0.38, 0.3, 0.84, GOLD)
  grid.block(ix, iz)
}

/** Market stall: posts, counter, striped awning, goods. 4x3 cells. */
function stall(ctx: Ctx, x0: number, z0: number, c1: number, c2: number): void {
  const { batches, grid, rng } = ctx
  for (const [px, pz] of [
    [0.1, 0.1],
    [3.6, 0.1],
    [0.1, 2.6],
    [3.6, 2.6]
  ] as const) {
    batches.wood.add(x0 + px, 0, z0 + pz, 0.3, 2.2, 0.3, rng.pick(WOOD))
  }
  batches.wood.add(x0, 0.75, z0 + 0.5, 4, 0.35, 2, rng.pick(WOOD))
  batches.wood.add(x0 + 0.3, 0, z0 + 0.9, 0.35, 0.75, 1.2, WOOD_DARK)
  batches.wood.add(x0 + 3.35, 0, z0 + 0.9, 0.35, 0.75, 1.2, WOOD_DARK)
  // goods
  batches.misc.add(x0 + 0.5, 1.1, z0 + 0.8, 0.55, 0.5, 0.55, rng.pick(FLOWER))
  batches.misc.add(x0 + 1.7, 1.1, z0 + 1.3, 0.6, 0.4, 0.6, GOLD)
  batches.misc.add(x0 + 2.9, 1.1, z0 + 0.9, 0.5, 0.55, 0.5, rng.pick(WOOD))
  // striped awning
  for (let i = 0; i < 4; i++) {
    batches.misc.add(x0 + i, 2.2, z0 - 0.4, 1, 0.22, 3.8, i % 2 === 0 ? c1 : c2)
  }
  grid.blockRect(x0, z0, 4, 3)
}

/** Little stone hero statue on a pedestal (big head, obviously). 1 cell. */
function statue(ctx: Ctx, ix: number, iz: number): void {
  const { batches } = ctx
  batches.stone.add(ix - 0.15, 0, iz - 0.15, 1.3, 0.5, 1.3, CAP_STONE[0]!)
  batches.stone.add(ix + 0.1, 0.5, iz + 0.1, 0.8, 0.6, 0.8, CAP_STONE[1]!)
  batches.stone.add(ix + 0.22, 1.1, iz + 0.28, 0.56, 0.8, 0.44, STONE[0]!)
  batches.stone.add(ix + 0.12, 1.9, iz + 0.18, 0.76, 0.76, 0.64, STONE[2]!)
  batches.misc.add(ix + 0.3, 2.66, iz + 0.3, 0.4, 0.18, 0.4, GOLD) // tiny crown
  ctx.grid.block(ix, iz)
}

/** Pave a disc of cells to cobble (surface only — ground pass renders it). */
function paveDisc(ctx: Ctx, cx: number, cz: number, r: number): void {
  const r2 = r * r
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r2) continue
      setSurface(ctx, cx + dx, cz + dz, S_COBBLE)
    }
  }
}

/** Trimmed hedge run (leaf boxes), with gap indices left open. */
function hedgeRun(
  ctx: Ctx,
  x0: number,
  z0: number,
  len: number,
  alongX: boolean,
  gaps: readonly number[] = []
): void {
  const { batches, grid, rng } = ctx
  for (let i = 0; i < len; i++) {
    if (gaps.includes(i)) continue
    const ix = alongX ? x0 + i : x0
    const iz = alongX ? z0 : z0 + i
    batches.leaf.add(ix, 0, iz, 1, 1.15, 1, rng.pick(LEAF))
    grid.block(ix, iz)
  }
}

/** A park patch: grass disc + the village tree. */
function parkTree(ctx: Ctx, ix: number, iz: number): void {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx * dx + dz * dz > 5) continue
      setSurface(ctx, ix + dx, iz + dz, S_GRASS)
    }
  }
  kitTree(ctx, ix, iz)
}

// ---------------------------------------------------------------------------
// Districts
// ---------------------------------------------------------------------------

function buildCityWall(ctx: Ctx): void {
  // South rampart, gate opening x -8..6 (the north road crosses z -92 near x -1)
  wallRun(ctx, -70, -92, 62, true) // x -70..-9
  wallRun(ctx, 7, -92, 64, true) // x 7..70
  wallRun(ctx, -70, -232, 141, true) // north
  wallRun(ctx, -70, -231, 139, false) // west
  wallRun(ctx, 70, -231, 139, false) // east
  // Corner towers
  tower(ctx, -73, -235, 6, 8, { spire: true })
  tower(ctx, 68, -235, 6, 8, { spire: true })
  tower(ctx, -73, -95, 6, 8, { spire: true })
  tower(ctx, 68, -95, 6, 8, { spire: true })
  // Gate towers + overhead arch (no collision — it spans the road)
  tower(ctx, -13, -95, 5, 7, { banner: true })
  tower(ctx, 8, -95, 5, 7, { banner: true })
  ctx.batches.stone.add(-9, 3.6, -92.2, 22, 1.3, 1.4, CAP_STONE[1]!)
  for (let i = 0; i < 22; i += 2) {
    ctx.batches.stone.add(-9 + i + 0.15, 4.9, -92, 0.7, 0.6, 0.7, CAP_STONE[2]!)
  }
}

function buildCastle(ctx: Ctx): void {
  const { batches, rng, grid } = ctx
  // Curtain wall (grey stone — the castle reads darker than the pale city)
  wallRun(ctx, -32, -188, 29, true, 4.2, STONE) // x -32..-4
  wallRun(ctx, 4, -188, 28, true, 4.2, STONE) // x 4..31
  wallRun(ctx, -32, -228, 64, true, 4.2, STONE)
  wallRun(ctx, -32, -227, 39, false, 4.2, STONE)
  wallRun(ctx, 31, -227, 39, false, 4.2, STONE)
  tower(ctx, -35, -231, 7, 11, { stone: STONE, spire: true, banner: true })
  tower(ctx, 29, -231, 7, 11, { stone: STONE, spire: true, banner: true })
  // SW tower is one cell slimmer: Archmage Lyra's anchor (-30, -190) stands
  // in its shadow, between the castle and the royal-garden gate.
  tower(ctx, -36, -195, 6, 11, { stone: STONE, spire: true, banner: true })
  tower(ctx, 29, -195, 7, 11, { stone: STONE, spire: true, banner: true })
  // Gatehouse (opening x -3..3)
  tower(ctx, -9, -191, 5, 9, { stone: STONE, banner: true })
  tower(ctx, 4, -191, 5, 9, { stone: STONE, banner: true })
  batches.stone.add(-5, 4.4, -188.2, 10, 1.4, 1.4, STONE[1]!)
  batches.wood.add(-3, 3.4, -187.9, 6, 1, 0.3, WOOD_DARK) // raised portcullis

  // --- The keep: three tiers + great tower ---
  batches.stone.add(-14, 0, -222, 28, 7, 20, STONE[1]!) // base
  batches.stone.add(-14.4, 0, -222.4, 28.8, 1.2, 20.8, STONE[0]!) // plinth
  batches.stone.add(-9, 7, -218, 18, 5, 12, STONE[2]!) // tier 2
  batches.stone.add(-4, 12, -214, 8, 10, 8, STONE[1]!) // great tower
  grid.blockRect(-14, -222, 28, 20)
  // crenellations on each tier rim
  for (let i = 0; i < 28; i += 2) {
    batches.stone.add(-14 + i + 0.15, 7, -222 + 0.15, 0.7, 0.7, 0.7, rng.pick(STONE))
    batches.stone.add(-14 + i + 0.15, 7, -202 - 0.85, 0.7, 0.7, 0.7, rng.pick(STONE))
  }
  for (let i = 0; i < 18; i += 2) {
    batches.stone.add(-9 + i + 0.15, 12, -218 + 0.15, 0.7, 0.7, 0.7, rng.pick(STONE))
    batches.stone.add(-9 + i + 0.15, 12, -206 - 0.85, 0.7, 0.7, 0.7, rng.pick(STONE))
  }
  for (let i = 0; i < 8; i += 2) {
    batches.stone.add(-4 + i + 0.15, 22, -214 + 0.15, 0.7, 0.7, 0.7, rng.pick(STONE))
    batches.stone.add(-4 + i + 0.15, 22, -206 - 0.85, 0.7, 0.7, 0.7, rng.pick(STONE))
    batches.stone.add(-4 + 0.15, 22, -214 + i + 0.15, 0.7, 0.7, 0.7, rng.pick(STONE))
    batches.stone.add(4 - 0.85, 22, -214 + i + 0.15, 0.7, 0.7, 0.7, rng.pick(STONE))
  }
  // green royal spire + gold finial + the great banner
  let rw = 8.6
  let y = 22.6
  let off = -4.3
  while (rw > 1) {
    batches.roof.add(off, y, -214.3 + (8.6 - rw) / 2, rw, 0.65, rw, rng.pick([0x2f7d46, 0x38914f] as const))
    y += 0.65
    rw -= 1.3
    off += 0.65
  }
  batches.misc.add(-0.15, y, -210.15, 0.3, 1.6, 0.3, GOLD)
  batches.misc.add(0.15, y + 0.9, -210.1, 1.6, 0.9, 0.12, CRIMSON)
  // hanging banners on the keep's south face
  for (const bx of [-11, 7]) {
    batches.misc.add(bx, 2.2, -201.95, 1.2, 4.2, 0.14, CRIMSON)
    batches.misc.add(bx - 0.03, 5.9, -201.98, 1.26, 0.5, 0.18, GOLD)
  }
  // glowing windows (proud of each south face so they read at distance)
  for (const wx of [-12, -8, -4, 1, 5, 9]) {
    batches.window.add(wx, 2.6, -202.15, 0.9, 1.3, 0.3, WINDOW_GLOW)
    batches.window.add(wx, 4.7, -202.15, 0.9, 1.3, 0.3, WINDOW_GLOW)
  }
  for (const wx of [-7, -3, 1, 5]) {
    batches.window.add(wx, 8.6, -206.15, 0.9, 1.4, 0.3, WINDOW_GLOW)
  }
  for (const wy of [14.2, 17.4]) {
    batches.window.add(-1.6, wy, -206.15, 1.2, 1.6, 0.3, WINDOW_GLOW)
  }
  // grand door + arch + steps
  batches.stone.add(-2.6, 0, -202.5, 5.2, 3.9, 0.6, STONE[0]!)
  batches.wood.add(-2, 0.12, -202.45, 4, 3.2, 0.5, WOOD_DARK)
  batches.stone.add(-3, 0, -201.6, 6, 0.12, 1.6, CAP_STONE[2]!)
  // corner turrets
  for (const [tx, tz] of [
    [-17, -224],
    [13, -224],
    [-17, -207],
    [13, -207]
  ] as const) {
    batches.stone.add(tx, 0, tz, 4, 15, 4, STONE[2]!)
    batches.stone.add(tx - 0.3, 14.6, tz - 0.3, 4.6, 0.5, 4.6, STONE[0]!)
    batches.roof.add(tx - 0.2, 15.1, tz - 0.2, 4.4, 0.6, 4.4, 0x2f7d46)
    batches.roof.add(tx + 0.7, 15.7, tz + 0.7, 2.6, 0.6, 2.6, 0x29703e)
    batches.roof.add(tx + 1.4, 16.3, tz + 1.4, 1.2, 0.8, 1.2, 0x38914f)
    batches.misc.add(tx + 1.85, 17.1, tz + 1.85, 0.3, 1.2, 0.3, GOLD)
    batches.window.add(tx + 1.5, 9, tz + 3.85, 0.9, 1.2, 0.3, WINDOW_GLOW)
    grid.blockRect(tx, tz, 4, 4)
  }
  // courtyard: paving + a pair of shade trees
  paveDisc(ctx, 0, -199, 4)
  kitPath(ctx, [
    [0, -189],
    [0, -195],
    [0, -200]
  ])
  parkTree(ctx, -24, -196)
  parkTree(ctx, 23, -194)
  parkTree(ctx, -25, -221)
  parkTree(ctx, 22, -221)
}

function buildMarket(ctx: Ctx): void {
  setSurfaceRect(ctx, { x0: 16, z0: -126, w: 30, d: 23 }, S_COBBLE)
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [CRIMSON, CREAM],
    [GOLD, CREAM],
    [BLUE, CREAM],
    [0x2f7d46, CREAM]
  ]
  for (let i = 0; i < 4; i++) {
    const p = pairs[i]!
    stall(ctx, 20 + i * 7, -123, p[0], p[1]) // north row
    const q = pairs[(i + 2) % 4]!
    stall(ctx, 20 + i * 7, -109, q[0], q[1]) // south row
  }
}

function buildBank(ctx: Ctx): void {
  const { batches, grid } = ctx
  // Bank of Blockle — door faces Banker Aldous' spot at (20, -170)
  kitHouseShell(
    ctx,
    { x0: 16, z0: -178, w: 14, d: 8, wallH: 5, door: 'N' },
    { ...CAP_PAL, timber: 0x8a8577 }
  )
  // columned facade: wide steps (low, walkable) + two pillars + gold sign
  batches.stone.add(15.5, 0, -170.6, 15, 0.12, 2.2, CAP_STONE[2]!)
  for (const px of [17, 27]) {
    batches.stone.add(px + 0.15, 0, -170.75, 0.7, 4.4, 0.7, CAP_STONE[2]!)
    batches.stone.add(px, 4.4, -170.9, 1, 0.5, 1, CAP_STONE[0]!)
    grid.block(px, -171)
  }
  batches.stone.add(16.5, 4.9, -170.7, 12, 0.8, 1.2, CAP_STONE[1]!)
  batches.misc.add(21.5, 5.1, -169.6, 2, 0.5, 0.2, GOLD)
}

function buildFountainPlaza(ctx: Ctx, scene: THREE.Scene): void {
  const { batches, grid, rng } = ctx
  paveDisc(ctx, 0, -160, 10)
  // fountain basin: stone ring, water, tiered center jet
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const d = Math.sqrt(dx * dx + dz * dz)
      if (d > 3.6) continue
      if (d > 2.6) batches.stone.add(dx, 0, -160 + dz, 1, 0.85, 1, rng.pick(CAP_STONE))
      else batches.misc.add(dx, 0, -160 + dz, 1, 0.5, 1, WATER)
      grid.block(dx, -160 + dz)
    }
  }
  batches.stone.add(-0.7, 0.5, -160.7, 1.4, 1.1, 1.4, CAP_STONE[1]!)
  batches.stone.add(-1.5, 1.6, -161.5, 3, 0.35, 3, CAP_STONE[2]!)
  batches.misc.add(-1.2, 1.95, -161.2, 2.4, 0.3, 2.4, WATER)
  batches.stone.add(-0.35, 1.95, -160.35, 0.7, 1.2, 0.7, CAP_STONE[0]!)
  batches.misc.add(-0.6, 3.1, -160.6, 1.2, 0.5, 1.2, WATER)
  kitLantern(ctx, scene, -8, -156)
  kitLantern(ctx, scene, 8, -164)
}

function buildGarden(ctx: Ctx): void {
  const { batches, rng } = ctx
  // Royal garden: grass interior, trimmed hedge, soil beds bursting flowers.
  setSurfaceRect(ctx, { x0: -55, z0: -199, w: 29, d: 25 }, S_GRASS)
  hedgeRun(ctx, -56, -200, 31, true) // north hedge x -56..-26
  hedgeRun(ctx, -56, -174, 31, true, [14, 15, 16]) // south, gate at x -42..-40
  hedgeRun(ctx, -56, -199, 25, false) // west
  hedgeRun(ctx, -26, -199, 25, false, [10, 11, 12]) // east, gate at z -189..-187
  kitPath(
    ctx,
    [
      [-41, -175],
      [-41, -182],
      [-41, -188]
    ],
    1.2
  )
  kitPath(
    ctx,
    [
      [-27, -188],
      [-35, -188],
      [-44, -188]
    ],
    1.2
  )
  for (const [bx, bz] of [
    [-53, -197],
    [-53, -183],
    [-35, -197],
    [-35, -183]
  ] as const) {
    setSurfaceRect(ctx, { x0: bx, z0: bz, w: 6, d: 5 }, S_SOIL)
    for (let ix = bx; ix < bx + 6; ix++) {
      for (let iz = bz; iz < bz + 5; iz++) {
        if (rng.next() < 0.55) {
          batches.misc.add(
            ix + rng.range(0.15, 0.6),
            0,
            iz + rng.range(0.15, 0.6),
            0.22,
            rng.range(0.3, 0.5),
            0.22,
            rng.pick(FLOWER)
          )
        }
      }
    }
  }
  kitTree(ctx, -53, -177)
  kitTree(ctx, -29, -177)
  kitTree(ctx, -53, -198)
  kitTree(ctx, -29, -198)
}

function buildStreets(ctx: Ctx): void {
  const paths: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    // gate avenue spurs east to the market, west to the guild hall
    [
      [0, -102],
      [8, -106],
      [16, -112],
      [24, -115]
    ],
    [
      [-3, -98],
      [-14, -104],
      [-28, -110],
      [-40, -118]
    ],
    // waystone plaza → fountain plaza
    [
      [6, -147],
      [3, -153],
      [0, -158]
    ],
    // ceremonial way: fountain → castle gate
    [
      [0, -166],
      [0, -176],
      [0, -187]
    ],
    // fountain → bank
    [
      [5, -163],
      [12, -166],
      [19, -169]
    ],
    // fountain → garden gate
    [
      [-6, -164],
      [-16, -169],
      [-28, -172],
      [-41, -176]
    ],
    // west terrace street
    [
      [-8, -160],
      [-22, -155],
      [-36, -151],
      [-43, -149]
    ],
    // east terrace street (south of the row houses)
    [
      [10, -154],
      [22, -157],
      [34, -158],
      [46, -157],
      [56, -156]
    ],
    // ring lanes around the castle precinct (skirting the bank, garden
    // and north-quarter houses)
    [
      [12, -164],
      [24, -168],
      [34, -172],
      [40, -180],
      [42, -190],
      [42, -204],
      [45, -211]
    ],
    [
      [-10, -166],
      [-24, -171],
      [-40, -172],
      [-54, -176],
      [-60, -186],
      [-61, -198],
      [-58, -212],
      [-50, -220]
    ]
  ]
  for (const p of paths) kitPath(ctx, p)
}

function buildTownHouses(ctx: Ctx): void {
  const houses: ReadonlyArray<BuildingSpec> = [
    // guild hall — big, west lower town
    { x0: -52, z0: -124, w: 12, d: 9, wallH: 5, door: 'E', chimney: true },
    // lower town west
    { x0: -64, z0: -110, w: 7, d: 6, wallH: 3, door: 'E', chimney: true },
    { x0: -64, z0: -100, w: 7, d: 6, wallH: 3, door: 'E' },
    { x0: -46, z0: -106, w: 6, d: 5, wallH: 3, door: 'W', chimney: true },
    // east terrace rows (doors face the street to their south)
    { x0: 26, z0: -152, w: 7, d: 6, wallH: 3, door: 'S', chimney: true },
    { x0: 38, z0: -152, w: 6, d: 5, wallH: 3, door: 'S' },
    { x0: 52, z0: -152, w: 7, d: 6, wallH: 3, door: 'S', chimney: true },
    // west terrace
    { x0: -50, z0: -152, w: 7, d: 6, wallH: 3, door: 'E', chimney: true },
    { x0: -62, z0: -146, w: 6, d: 5, wallH: 3, door: 'E' },
    // north-east quarter
    { x0: 44, z0: -202, w: 7, d: 6, wallH: 3, door: 'S', chimney: true },
    { x0: 54, z0: -192, w: 6, d: 5, wallH: 3, door: 'W' },
    { x0: 44, z0: -220, w: 8, d: 7, wallH: 4, door: 'N' }, // chapel by the ring lane
    // north-west quarter
    { x0: -58, z0: -208, w: 7, d: 6, wallH: 3, door: 'E', chimney: true }
  ]
  for (const h of houses) kitHouseShell(ctx, h, CAP_PAL)
  // guild crest over the door + a banner by the entrance
  ctx.batches.misc.add(-39.9, 3.6, -121.5, 0.3, 1.2, 2, BLUE)
  ctx.batches.misc.add(-39.95, 4.3, -121.3, 0.35, 0.4, 1.6, GOLD)
  bannerPole(ctx, -38, -123)
  // allotment fence behind the lower-west cottages
  kitFenceRun(ctx, -68, -110, 6, false)
  kitFenceRun(ctx, -68, -110, 4, true)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function buildRegion(ctx: Ctx, scene: THREE.Scene): void {
  buildCityWall(ctx)
  buildStreets(ctx)

  // Waystone plaza — paved and deliberately left open (ids: ws_capital 6,-140)
  paveDisc(ctx, 6, -140, 8)

  buildMarket(ctx)
  buildTownHouses(ctx)
  buildBank(ctx)
  buildFountainPlaza(ctx, scene)
  buildGarden(ctx)
  buildCastle(ctx)

  // Ceremonial way: paired royal banners + statues + castle-gate lanterns
  for (const bz of [-169, -176, -183]) {
    bannerPole(ctx, -6, bz)
    bannerPole(ctx, 6, bz)
  }
  statue(ctx, -5, -180)
  statue(ctx, 4, -180)
  kitLantern(ctx, scene, -6, -186)
  kitLantern(ctx, scene, 6, -186)

  // City-gate lanterns greeting the road from the village
  kitLantern(ctx, scene, -15, -94)
  kitLantern(ctx, scene, 14, -94)

  // Shade trees greening the flagstone quarters
  for (const [tx, tz] of [
    [-30, -96],
    [30, -98],
    [60, -120],
    [60, -140],
    [36, -192],
    [60, -200],
    [58, -212],
    [36, -226],
    [-44, -208],
    [-62, -220],
    [-40, -225],
    [-64, -186],
    [-20, -134],
    [22, -132]
  ] as const) {
    parkTree(ctx, tx, tz)
  }
}
