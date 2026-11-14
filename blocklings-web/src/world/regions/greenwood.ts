/**
 * GREENWOOD FOREST — region builder.
 *
 * Bounds: x in [80, 240], z in [-120, 120]. Level band 4-12. Biome: forest.
 * Waystone anchor (130, 10); NPC anchors (ids.ts): Scout Wren (110, 0),
 * Herbalist Moss (150, 40), Ranger Kael (190, -60).
 *
 * What lives here (same flat-color voxel vocabulary as the village):
 *  - dense oak/pine groves with winding clearings (grove-noise scatter that
 *    keeps every road, trail, stream bank, anchor and landmark open)
 *  - a creek from the NE bay to the east coast, with two log bridges where
 *    the side trails cross it
 *  - Ranger Kael's camp: canvas tents, a crackling campfire (one warm light),
 *    log benches, an archery target and a drying rack
 *  - a bandit stockade: sharpened-log palisade, crooked warning sign,
 *    watchtower, a crude hut, ember fire pit and stolen crates
 *  - a hidden treasure grove: a ring of big oaks around a glowing chest
 *    (the loot literally winks at you — it shares the window flicker)
 *  - Herbalist Moss's hut + rare-herb glades, and shroomling-red mushroom
 *    circles deep between the trees
 *
 * Build order inside this module matters: bridge decks → stream → trails →
 * water, then landmarks, then the grove scatter (which checks the surface
 * map + collision + clearing masks so it never swallows any of the above).
 * Region builders run BEFORE the ground pass, so surface stamps take effect.
 */
import * as THREE from 'three'
import {
  S_BRIDGE,
  S_COBBLE,
  S_GRASS,
  S_RIVER,
  S_SOIL,
  setSurface,
  surfaceAt,
  type Ctx
} from '../layout'
import {
  FLOWER,
  FOREST_MOSS,
  LEAF,
  PINE_LEAF,
  ROOF,
  STONE,
  STRAW,
  WATER,
  WOOD,
  WOOD_DARK,
  isLand,
  kitFenceRun,
  kitHouseShell,
  kitLantern,
  kitPath,
  kitPine,
  kitRock,
  kitTree
} from '../kit'

// ---------------------------------------------------------------------------
// Local palette accents (all flat colors, village-adjacent)
// ---------------------------------------------------------------------------

/** Weathered forest-green tent canvas. */
const CANVAS = [0x5f7c4c, 0x567347, 0x687f52] as const
/** Darker oak canopy mixed in for deep-forest depth. */
const DEEP_LEAF = [0x2f7a36, 0x3a8a3c, 0x2a6e33, 0x41923f] as const
/** Grubby bandit-hut plaster. */
const BANDIT_PLASTER = [0xcfc3a0, 0xc2b48e] as const
/** Shroomling red (matches the mob's 0xd96459). */
const SHROOM_CAP = 0xd96459
const DOORWAY_DARK = 0x2c2218

// ---------------------------------------------------------------------------
// Geometry bookkeeping
// ---------------------------------------------------------------------------

/** Pack a cell into one int (grid spans ±240). */
function encode(ix: number, iz: number): number {
  return (ix + 240) * 481 + (iz + 240)
}

/**
 * Clearing masks [cx, cz, r]: landmarks + anchors + hand-placed open glades.
 * The grove scatter and prop scatter stay out of these.
 */
const CLEARINGS: ReadonlyArray<readonly [number, number, number]> = [
  [130, 10, 7], // waystone
  [110, 0, 4], // Scout Wren's roadside spot
  [190, -60, 12], // ranger camp
  [147, 44, 9], // herbalist hut + home glade
  [212, 72, 15], // bandit stockade + its cleared ring
  [222, -92, 10], // treasure grove (its oak ring is hand-placed)
  [112, 78, 6], // rare-herb glade (west)
  [205, -18, 6], // rare-herb glade (east)
  [98, -44, 5], // mushroom circles…
  [170, -86, 5],
  [128, 96, 5],
  [226, 30, 5],
  [94, 40, 5],
  [100, 30, 7], // …and plain winding clearings
  [165, 22, 6],
  [215, -40, 7],
  [125, -60, 6],
  [150, 100, 8],
  [185, 108, 7]
]

function inClearing(ix: number, iz: number, shrink = 0): boolean {
  for (const [cx, cz, r] of CLEARINGS) {
    const rr = r - shrink
    if (rr <= 0) continue
    const dx = ix - cx
    const dz = iz - cz
    if (dx * dx + dz * dz < rr * rr) return true
  }
  return false
}

/** Solid-prop placement guard: open grass, off roads/stream/beach/landmarks. */
function spotOk(ctx: Ctx, ix: number, iz: number, clearShrink = 0): boolean {
  if (ix < 85 || ix > 236 || iz < -116 || iz > 116) return false
  // stay off the beaches (and out of the NE bay)
  if (
    !isLand(ix + 4, iz) || !isLand(ix - 4, iz) || !isLand(ix, iz + 4) || !isLand(ix, iz - 4) ||
    !isLand(ix + 3, iz + 3) || !isLand(ix - 3, iz - 3) || !isLand(ix + 3, iz - 3) || !isLand(ix - 3, iz + 3)
  ) {
    return false
  }
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  if (inClearing(ix, iz, clearShrink)) return false
  // keep an open gap along every road/trail/bridge…
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const s = surfaceAt(ctx, ix + dx, iz + dz)
      if (s === S_COBBLE || s === S_BRIDGE) return false
    }
  }
  // …and keep the creek banks walkable
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (surfaceAt(ctx, ix + dx, iz + dz) === S_RIVER) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// The creek (NE bay → east coast) + log bridges
// ---------------------------------------------------------------------------

/**
 * Hand-placed creek waypoints. The two straight vertical runs (x 142 and
 * x 176) are deliberate: the side trails cross them orthogonally on the log
 * bridges, so deck + trail + channel always line up.
 */
const STREAM_PTS: ReadonlyArray<readonly [number, number]> = [
  [102, -118],
  [112, -98],
  [100, -80],
  [116, -62],
  [134, -46],
  [142, -38],
  [142, -26],
  [152, -16],
  [164, -8],
  [172, 8],
  [178, 26],
  [168, 44],
  [176, 54],
  [176, 66],
  [186, 78],
  [204, 92],
  [222, 102],
  [239, 106]
]

/**
 * A log footbridge over the creek, crossing along X: wooden deck stamped as
 * S_BRIDGE (the ground pass renders it at walking height), two long side
 * logs on the outer rows (blocked, so nobody belly-flops into the creek)
 * and stub posts at the corners. Stamped BEFORE the stream, which skips
 * bridge cells.
 */
function logBridge(ctx: Ctx, x0: number, z0: number, w: number, d: number): void {
  const { rng, batches, grid } = ctx
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) setSurface(ctx, ix, iz, S_BRIDGE)
  }
  batches.wood.add(x0, 0.05, z0 + 0.28, w, 0.34, 0.44, rng.pick(WOOD))
  batches.wood.add(x0, 0.05, z0 + d - 1 + 0.28, w, 0.34, 0.44, rng.pick(WOOD))
  grid.blockRect(x0, z0, w, 1)
  grid.blockRect(x0, z0 + d - 1, w, 1)
  for (const ex of [x0, x0 + w - 1]) {
    for (const ez of [z0, z0 + d - 1]) {
      batches.wood.add(ex + 0.25, 0, ez + 0.25, 0.5, 0.9, 0.5, WOOD_DARK)
    }
  }
}

/** Carve the creek bed into the surface map (never cuts roads or decks). */
function buildStream(ctx: Ctx): Set<number> {
  const cells = new Set<number>()
  for (let i = 0; i < STREAM_PTS.length - 1; i++) {
    const [ax, az] = STREAM_PTS[i]!
    const [bx, bz] = STREAM_PTS[i + 1]!
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) * 2))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const cx = Math.round(ax + (bx - ax) * t)
      const cz = Math.round(az + (bz - az) * t)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const ix = cx + dx
          const iz = cz + dz
          if (!isLand(ix + 0.5, iz + 0.5)) continue
          const sf = surfaceAt(ctx, ix, iz)
          if (sf === S_COBBLE || sf === S_BRIDGE) continue
          setSurface(ctx, ix, iz, S_RIVER)
          cells.add(encode(ix, iz))
        }
      }
    }
  }
  return cells
}

/**
 * Flat water layer in the carved channel (the bed sits at -0.58, this tops
 * out at -0.38 — below the grass lip, same sunken-channel read as the big
 * river). Consecutive cells merge into row runs so the creek costs a few
 * hundred instances, not per-cell thousands.
 */
function pourStreamWater(ctx: Ctx, cells: Set<number>): void {
  const byRow = new Map<number, number[]>()
  for (const key of cells) {
    const ix = Math.floor(key / 481) - 240
    const iz = (key % 481) - 240
    if (surfaceAt(ctx, ix, iz) !== S_RIVER) continue
    let row = byRow.get(iz)
    if (!row) {
      row = []
      byRow.set(iz, row)
    }
    row.push(ix)
  }
  for (const [iz, xs] of byRow) {
    xs.sort((a, b) => a - b)
    let start = xs[0]!
    let prev = xs[0]!
    const flush = (end: number): void => {
      ctx.batches.misc.add(start, -0.72, iz, end - start + 1, 0.34, 1, WATER)
    }
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i]!
      if (x === prev + 1) {
        prev = x
        continue
      }
      flush(prev)
      start = x
      prev = x
    }
    flush(prev)
  }
}

/** Side trails: road → ranger camp, waystone → herbalist → bandit stockade. */
function buildTrails(ctx: Ctx): void {
  // camp trail — crosses the creek's vertical run on the north log bridge
  kitPath(ctx, [
    [120, 2],
    [128, -10],
    [134, -22],
    [134, -28],
    [138, -32],
    [147, -32],
    [156, -40],
    [172, -50],
    [188, -57]
  ])
  // waystone → herbalist
  kitPath(ctx, [
    [130, 10],
    [137, 22],
    [145, 34],
    [151, 44]
  ])
  // herbalist → stockade (crosses the south log bridge)
  kitPath(ctx, [
    [151, 44],
    [160, 50],
    [168, 56],
    [172, 60],
    [181, 60],
    [190, 64],
    [202, 70]
  ])
}

// ---------------------------------------------------------------------------
// Small prop builders (all mark collision themselves where solid)
// ---------------------------------------------------------------------------

type Face = '-z' | '+z' | '-x' | '+x'

/** Stepped canvas tent (3x3 footprint) with a dark doorway flap. */
function tent(ctx: Ctx, ix: number, iz: number, door: Face): void {
  const { rng, batches, grid } = ctx
  batches.plaster.add(ix, 0, iz, 3, 1, 3, rng.pick(CANVAS))
  batches.plaster.add(ix + 0.35, 1, iz + 0.35, 2.3, 0.85, 2.3, rng.pick(CANVAS))
  batches.plaster.add(ix + 0.85, 1.85, iz + 0.85, 1.3, 0.7, 1.3, rng.pick(CANVAS))
  batches.wood.add(ix + 1.25, 2.55, iz + 1.25, 0.5, 0.55, 0.5, WOOD_DARK)
  switch (door) {
    case '-z':
      batches.wood.add(ix + 1.05, 0, iz - 0.06, 0.9, 0.9, 0.18, DOORWAY_DARK)
      break
    case '+z':
      batches.wood.add(ix + 1.05, 0, iz + 2.88, 0.9, 0.9, 0.18, DOORWAY_DARK)
      break
    case '-x':
      batches.wood.add(ix - 0.06, 0, iz + 1.05, 0.18, 0.9, 0.9, DOORWAY_DARK)
      break
    case '+x':
      batches.wood.add(ix + 2.88, 0, iz + 1.05, 0.18, 0.9, 0.9, DOORWAY_DARK)
      break
  }
  grid.blockRect(ix, iz, 3, 3)
}

/**
 * Stone-ring campfire with crossed logs and a flickering ember core (rides
 * the window batch, so it pulses with the village lights). Optionally adds
 * ONE warm PointLight — the ranger camp gets it; the bandits sit in the dark
 * because they're bandits and ambience is free.
 */
function campfire(ctx: Ctx, ix: number, iz: number, scene: THREE.Scene | null): void {
  const { rng, batches, grid } = ctx
  const ring: ReadonlyArray<readonly [number, number]> = [
    [0.5, -0.18],
    [1.12, 0.5],
    [0.5, 1.12],
    [-0.18, 0.5]
  ]
  for (const [ox, oz] of ring) {
    batches.stone.add(ix + ox - 0.22, 0, iz + oz - 0.22, 0.44, 0.36, 0.44, rng.pick(STONE))
  }
  batches.wood.add(ix + 0.05, 0.1, iz + 0.38, 0.95, 0.24, 0.26, rng.pick(WOOD))
  batches.wood.add(ix + 0.38, 0.22, iz + 0.05, 0.26, 0.24, 0.95, rng.pick(WOOD))
  batches.window.add(ix + 0.25, 0.14, iz + 0.25, 0.5, 0.36, 0.5, 0xff8c3a)
  batches.window.add(ix + 0.35, 0.5, iz + 0.35, 0.3, 0.32, 0.3, 0xffd36b)
  if (scene) {
    const light = new THREE.PointLight(0xff9a4a, 16, 12, 1.8)
    light.position.set(ix + 0.5, 1.1, iz + 0.5)
    scene.add(light)
  }
  grid.block(ix, iz)
}

/** Low split-log bench, 2 cells along X. */
function logBench(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0, iz + 0.2, 2, 0.5, 0.65, rng.pick(WOOD))
  grid.blockRect(ix, iz, 2, 1)
}

/** Straw archery target on a post (bullseye included, dignity not). */
function archeryTarget(ctx: Ctx, ix: number, iz: number): void {
  const { batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 1.1, 0.24, WOOD_DARK)
  batches.misc.add(ix + 0.08, 0.9, iz + 0.32, 0.84, 0.84, 0.3, STRAW)
  batches.misc.add(ix + 0.32, 1.14, iz + 0.28, 0.36, 0.36, 0.32, FLOWER[0]!)
  grid.block(ix, iz)
}

/** Two-post drying rack with hanging herb bunches. */
function dryingRack(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.3, 0, iz + 0.35, 0.25, 1.7, 0.25, rng.pick(WOOD))
  batches.wood.add(ix + 2.4, 0, iz + 0.35, 0.25, 1.7, 0.25, rng.pick(WOOD))
  batches.wood.add(ix + 0.2, 1.7, iz + 0.32, 2.6, 0.18, 0.2, WOOD_DARK)
  for (let i = 0; i < 4; i++) {
    batches.leaf.add(ix + 0.55 + i * 0.55, 1.05, iz + 0.28, 0.3, 0.65, 0.3, rng.pick(LEAF))
  }
  grid.blockRect(ix, iz, 3, 1)
}

/** Crooked wooden warning sign. Imagine something rude carved into it. */
function warningSign(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.4, 0, iz + 0.4, 0.25, 1.6, 0.25, WOOD_DARK)
  batches.wood.add(ix - 0.15, 1.1, iz + 0.32, 1.5, 0.75, 0.2, rng.pick(WOOD))
  batches.misc.add(ix + 0.15, 1.25, iz + 0.28, 0.4, 0.42, 0.26, FLOWER[0]!)
  batches.misc.add(ix + 0.75, 1.25, iz + 0.28, 0.4, 0.42, 0.26, FLOWER[0]!)
  grid.block(ix, iz)
}

/** Stacked loot crates (1-2 high). */
function crate(ctx: Ctx, ix: number, iz: number, stacked: boolean): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.05, 0, iz + 0.05, 0.9, 0.85, 0.9, rng.pick(WOOD))
  batches.wood.add(ix + 0.05, 0.85, iz + 0.05, 0.9, 0.12, 0.9, WOOD_DARK)
  if (stacked) {
    batches.wood.add(ix + 0.15, 0.97, iz + 0.15, 0.7, 0.68, 0.7, rng.pick(WOOD))
    batches.wood.add(ix + 0.15, 1.65, iz + 0.15, 0.7, 0.1, 0.7, WOOD_DARK)
  }
  grid.block(ix, iz)
}

/** Lookout tower: four posts, platform, parapet, little green hat. */
function watchtower(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  for (const dx of [0, 2]) {
    for (const dz of [0, 2]) {
      batches.wood.add(ix + dx + 0.3, 0, iz + dz + 0.3, 0.4, 4, 0.4, rng.pick(WOOD))
    }
  }
  batches.wood.add(ix - 0.2, 4, iz - 0.2, 3.4, 0.4, 3.4, WOOD_DARK)
  batches.wood.add(ix - 0.2, 4.4, iz - 0.2, 3.4, 0.55, 0.25, rng.pick(WOOD))
  batches.wood.add(ix - 0.2, 4.4, iz + 2.95, 3.4, 0.55, 0.25, rng.pick(WOOD))
  batches.wood.add(ix - 0.2, 4.4, iz + 0.05, 0.25, 0.55, 2.9, rng.pick(WOOD))
  batches.wood.add(ix + 2.95, 4.4, iz + 0.05, 0.25, 0.55, 2.9, rng.pick(WOOD))
  batches.roof.add(ix - 0.4, 5.6, iz - 0.4, 3.8, 0.55, 3.8, rng.pick(ROOF))
  batches.roof.add(ix + 0.45, 6.15, iz + 0.45, 2.1, 0.5, 2.1, rng.pick(ROOF))
  batches.roof.add(ix + 1.15, 6.65, iz + 1.15, 0.7, 0.45, 0.7, rng.pick(ROOF))
  // ladder rails on the south face
  batches.wood.add(ix + 1.05, 0, iz - 0.12, 0.14, 4, 0.14, WOOD_DARK)
  batches.wood.add(ix + 1.8, 0, iz - 0.12, 0.14, 4, 0.14, WOOD_DARK)
  grid.blockRect(ix, iz, 3, 3)
}

/** The treasure chest: plinth, gold-strapped box, glowing seam. */
function treasureChest(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix - 0.4, 0, iz - 0.25, 1.8, 0.25, 1.5, rng.pick(STONE))
  batches.wood.add(ix, 0.25, iz + 0.08, 1.1, 0.55, 0.85, rng.pick(WOOD))
  batches.window.add(ix + 0.05, 0.72, iz + 0.13, 1, 0.1, 0.75, 0xffd36b)
  batches.wood.add(ix - 0.05, 0.82, iz + 0.03, 1.2, 0.32, 0.95, WOOD_DARK)
  batches.misc.add(ix + 0.18, 0.28, iz + 0.06, 0.14, 0.92, 0.89, STRAW)
  batches.misc.add(ix + 0.78, 0.28, iz + 0.06, 0.14, 0.92, 0.89, STRAW)
  grid.block(ix, iz)
}

/** One red-capped shroom (decorative, walk-through — it's a mushroom). */
function shroom(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  const h = rng.range(0.4, 0.7)
  batches.plaster.add(ix + 0.33, 0, iz + 0.33, 0.34, h, 0.34, 0xe7dcc4)
  batches.misc.add(ix + 0.08, h, iz + 0.08, 0.84, 0.3, 0.84, SHROOM_CAP)
  if (rng.next() < 0.5) {
    batches.plaster.add(ix + rng.range(0.2, 0.6), h + 0.3, iz + rng.range(0.2, 0.6), 0.18, 0.08, 0.18, 0xf2ead8)
  }
}

/** A rare-herb sprig: tall green stalk, usually with a bright flower tip. */
function herbSprig(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  const h = rng.range(0.4, 0.75)
  batches.leaf.add(ix + 0.35, 0, iz + 0.35, 0.3, h, 0.3, rng.pick(LEAF))
  if (rng.next() < 0.6) {
    batches.misc.add(ix + 0.4, h, iz + 0.4, 0.2, 0.2, 0.2, rng.pick(FLOWER))
  }
}

/** Decorative scatter guard (non-blocking props): open grass off roads. */
function softSpotOk(ctx: Ctx, ix: number, iz: number): boolean {
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const s = surfaceAt(ctx, ix + dx, iz + dz)
      if (s === S_COBBLE || s === S_BRIDGE) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/** Ranger Kael's camp (trainer anchor 190,-60 stays walkable). */
function buildRangerCamp(ctx: Ctx, scene: THREE.Scene): void {
  // packed-earth camp floor around the fire
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      if (dx * dx + dz * dz > 18) continue
      const ix = 191 + dx
      const iz = -58 + dz
      if (surfaceAt(ctx, ix, iz) === S_GRASS) setSurface(ctx, ix, iz, S_SOIL)
    }
  }
  tent(ctx, 185, -66, '+z')
  tent(ctx, 195, -64, '-x')
  tent(ctx, 184, -56, '+x')
  campfire(ctx, 191, -58, scene)
  logBench(ctx, 188, -61)
  logBench(ctx, 192, -55)
  archeryTarget(ctx, 198, -54)
  dryingRack(ctx, 187, -52)
  kitFenceRun(ctx, 183, -68, 6, true)
  kitRock(ctx, 196, -68, 1)
}

/** The bandit stockade: palisade ring, gate to the west, crude interior. */
function buildStockade(ctx: Ctx): void {
  const { rng, batches, grid } = ctx
  const x0 = 203
  const x1 = 221
  const z0 = 62
  const z1 = 82
  const gateZ0 = 69
  const gateZ1 = 73
  for (let ix = x0; ix <= x1; ix++) {
    for (let iz = z0; iz <= z1; iz++) {
      const onRing = ix === x0 || ix === x1 || iz === z0 || iz === z1
      if (!onRing) continue
      if (ix === x0 && iz >= gateZ0 && iz <= gateZ1) continue // the gate
      const h = rng.range(2.6, 3.4)
      batches.wood.add(ix + 0.15, 0, iz + 0.15, 0.7, h, 0.7, rng.pick(WOOD))
      batches.wood.add(ix + 0.3, h, iz + 0.3, 0.4, 0.45, 0.4, WOOD_DARK) // sharpened tip
      grid.block(ix, iz)
    }
  }
  // taller gate posts + crossbeam over the opening
  batches.wood.add(x0 + 0.1, 0, gateZ0 - 1 + 0.1, 0.8, 4, 0.8, rng.pick(WOOD))
  batches.wood.add(x0 + 0.1, 0, gateZ1 + 1 + 0.1, 0.8, 4, 0.8, rng.pick(WOOD))
  batches.wood.add(x0 + 0.2, 3.5, gateZ0 - 1, 0.6, 0.6, gateZ1 - gateZ0 + 3, WOOD_DARK)
  warningSign(ctx, 200, 75)

  kitHouseShell(
    ctx,
    { x0: 210, z0: 74, w: 6, d: 5, wallH: 3, door: 'S', chimney: true },
    { plaster: BANDIT_PLASTER, timber: WOOD_DARK }
  )
  watchtower(ctx, 205, 63)
  campfire(ctx, 213, 68, null) // embers only; bandits can't afford a light
  logBench(ctx, 211, 66)
  crate(ctx, 218, 65, true)
  crate(ctx, 219, 66, false)
  crate(ctx, 218, 67, false)
  crate(ctx, 206, 78, true)
}

/** Hidden treasure grove: a tight ring of big oaks, loot winking inside. */
function buildTreasureGrove(ctx: Ctx): void {
  const { rng } = ctx
  const cx = 222
  const cz = -92
  const n = 13
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2
    const deg = (a * 180) / Math.PI
    if (deg > 195 && deg < 255) continue // the one way in (SW)
    const ix = Math.round(cx + Math.cos(a) * 6.3)
    const iz = Math.round(cz + Math.sin(a) * 6.3)
    if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) continue
    kitTree(ctx, ix, iz, { big: true, leaves: DEEP_LEAF })
  }
  treasureChest(ctx, cx, cz)
  for (let i = 0; i < 8; i++) {
    const fx = cx + rng.range(-3.5, 3.5)
    const fz = cz + rng.range(-3.5, 3.5)
    ctx.batches.misc.add(fx, 0, fz, 0.22, rng.range(0.25, 0.45), 0.22, rng.pick(FLOWER))
  }
  shroom(ctx, cx - 3, cz + 2)
  shroom(ctx, cx + 2, cz - 3)
}

/** Herbalist Moss's hut + the rare-herb glades. */
function buildHerbGlades(ctx: Ctx, scene: THREE.Scene): void {
  const { rng } = ctx
  kitHouseShell(
    ctx,
    { x0: 143, z0: 43, w: 5, d: 4, wallH: 3, door: 'E', chimney: true },
    { plaster: [0xdfd9b8, 0xd6cfab] }
  )
  kitPath(ctx, [
    [149, 45],
    [151, 44]
  ])
  kitLantern(ctx, scene, 150, 47)
  dryingRack(ctx, 143, 48)
  const glades: ReadonlyArray<readonly [number, number, number]> = [
    [152, 38, 7], // her home patch
    [112, 78, 10],
    [205, -18, 10]
  ]
  for (const [gx, gz, count] of glades) {
    for (let i = 0; i < count; i++) {
      const ix = Math.round(gx + rng.range(-3.5, 3.5))
      const iz = Math.round(gz + rng.range(-3.5, 3.5))
      if (!softSpotOk(ctx, ix, iz)) continue
      herbSprig(ctx, ix, iz)
    }
    for (let i = 0; i < 3; i++) {
      const fx = gx + rng.range(-4, 4)
      const fz = gz + rng.range(-4, 4)
      ctx.batches.misc.add(fx, 0, fz, 0.22, rng.range(0.25, 0.45), 0.22, rng.pick(FLOWER))
    }
  }
}

/** Mushroom circles — perfectly natural, definitely not fae. */
function buildMushroomCircles(ctx: Ctx): void {
  const { rng } = ctx
  const centers: ReadonlyArray<readonly [number, number]> = [
    [98, -44],
    [170, -86],
    [128, 96],
    [226, 30],
    [94, 40]
  ]
  for (const [cx, cz] of centers) {
    const r = rng.range(2.1, 3)
    const n = 7 + rng.int(3)
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng.range(-0.15, 0.15)
      const ix = Math.round(cx + Math.cos(a) * r)
      const iz = Math.round(cz + Math.sin(a) * r)
      if (!softSpotOk(ctx, ix, iz)) continue
      shroom(ctx, ix, iz)
    }
  }
}

// ---------------------------------------------------------------------------
// The forest itself
// ---------------------------------------------------------------------------

/** Cheap deterministic grove field: >0 means "inside a grove". */
function groveNoise(ix: number, iz: number): number {
  return Math.sin(ix * 0.11 + 1.7) * Math.sin(iz * 0.087 + 0.6) + 0.15
}

/** Dense oak/pine scatter with winding clearings, plus floor dressing. */
function scatterForest(ctx: Ctx): void {
  const { rng } = ctx

  // trees — jittered grid, grove-noise density, every guard in spotOk
  for (let gx = 85; gx <= 236; gx += 3) {
    for (let gz = -116; gz <= 116; gz += 3) {
      const ix = gx + rng.int(3) - 1
      const iz = gz + rng.int(3) - 1
      const p = groveNoise(ix, iz) > 0 ? 0.34 : 0.07
      if (rng.next() >= p) continue
      if (!spotOk(ctx, ix, iz)) continue
      if (rng.next() < 0.58) {
        kitPine(ctx, ix, iz, { tall: rng.next() < 0.3 })
      } else {
        const opts: { big: boolean; leaves?: readonly number[] } = { big: rng.next() < 0.25 }
        if (rng.next() < 0.5) opts.leaves = DEEP_LEAF
        kitTree(ctx, ix, iz, opts)
      }
    }
  }

  // mossy fallen logs
  for (let i = 0; i < 14; i++) {
    const ix = 86 + rng.int(148)
    const iz = -114 + rng.int(228)
    const len = 2 + rng.int(2)
    if (!spotOk(ctx, ix, iz) || !spotOk(ctx, ix + len - 1, iz)) continue
    ctx.batches.wood.add(ix, 0, iz + 0.2, len, 0.55, 0.6, rng.pick(WOOD))
    ctx.batches.leaf.add(ix + 0.3, 0.55, iz + 0.25, len - 0.6, 0.14, 0.45, FOREST_MOSS)
    ctx.grid.blockRect(ix, iz, len, 1)
  }

  // the odd outcrop
  for (let i = 0; i < 26; i++) {
    const ix = 86 + rng.int(148)
    const iz = -114 + rng.int(228)
    if (!spotOk(ctx, ix, iz)) continue
    kitRock(ctx, ix, iz, (1 + rng.int(2)) as 1 | 2)
  }

  // fern tufts + forest flowers for the dappled floor (walk-through)
  for (let gx = 86; gx <= 234; gx += 5) {
    for (let gz = -114; gz <= 114; gz += 5) {
      if (rng.next() >= 0.42) continue
      const ix = gx + rng.int(5) - 2
      const iz = gz + rng.int(5) - 2
      if (!softSpotOk(ctx, ix, iz)) continue
      if (inClearing(ix, iz, 3)) continue
      if (rng.next() < 0.12) {
        ctx.batches.misc.add(ix + 0.4, 0, iz + 0.4, 0.22, rng.range(0.25, 0.45), 0.22, rng.pick(FLOWER))
      } else {
        ctx.batches.leaf.add(ix + 0.25, 0, iz + 0.25, 0.5, rng.range(0.22, 0.38), 0.5, rng.pick(PINE_LEAF))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildRegion(ctx: Ctx, scene: THREE.Scene): void {
  // decks first so the stream parts around them, trails after both
  logBridge(ctx, 139, -34, 7, 5) // camp-trail crossing (creek run at x 142)
  logBridge(ctx, 173, 58, 7, 5) // stockade-trail crossing (creek run at x 176)
  const water = buildStream(ctx)
  buildTrails(ctx)
  pourStreamWater(ctx, water)

  buildRangerCamp(ctx, scene)
  buildStockade(ctx)
  buildTreasureGrove(ctx)
  buildHerbGlades(ctx, scene)
  buildMushroomCircles(ctx)
  scatterForest(ctx)

  // one lantern where the king's road meets the waystone clearing
  kitLantern(ctx, scene, 134, 14)
}
