/**
 * IRONHOLD MOUNTAINS — region builder.
 *
 * Bounds: x in [-240, -80], z in [-120, 120]. Level band 8-18. Biome:
 * mountain. Waystone anchor (-130, 10); NPC anchors (ids.ts): Foreman Dagna
 * (-120, 0), Smith Orin (-150, 30), Prospector Finn (-190, -40).
 *
 * What lives here (same flat-color voxel vocabulary as the village):
 *  - voxel crags and ridge lines everywhere, snow-dusted peaks walling the
 *    west edge where the continent falls into the sea
 *  - a dry ravine ripping north-south through the middle, crossed by two
 *    sagging rope bridges (the planks are load-rated for optimists)
 *  - switchback cobble paths: waystone → foreman camp → high pass lookout,
 *    plus mine roads north and south
 *  - two working mine mouths with timber frames, rails and ore carts
 *    (Rustvein in the north by Prospector Finn, Deepdelve in the south),
 *    and one boarded-up adit nobody talks about
 *  - exposed ore-vein boulders glinting copper/iron/gold (visual only —
 *    the gather module places the actual interactables)
 *  - the dwarven-flavored foreman camp: stone lodge, open-air forge with a
 *    proper warm glow, timber stacks, ore crates and a fence that mostly
 *    keeps the golems out
 *  - the Gravelord's Hollow: a crag ring arena in the south-west where the
 *    boss golem does its brooding
 *
 * Build order: rope-bridge decks → ravine carve (parts around the decks) →
 * paths (kitPath skips river/bridge cells) → landmarks → peaks/ridges →
 * guarded scatter. Region builders run BEFORE the ground pass, so surface
 * stamps take effect and S_RIVER ravine cells self-block at paint time.
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
  EMBER,
  PINE_LEAF,
  ROOF,
  SNOW,
  STONE,
  WINDOW_GLOW,
  WOOD,
  WOOD_DARK,
  isLand,
  kitFenceRun,
  kitHouseShell,
  kitLantern,
  kitPath,
  kitPine,
  kitDeadTree,
  kitRock
} from '../kit'

// ---------------------------------------------------------------------------
// Local palette accents (flat colors, village-adjacent)
// ---------------------------------------------------------------------------

/** Crag rock — village stone greys shading into the cold mountain blues. */
const CRAG_ROCK = [0x8b9197, 0x9aa0a6, 0x76839b, 0x6d7a93, 0x857f72] as const
/** Ore flecks: copper, rusty iron, gold, raw iron. */
const ORE = [0xc96f3b, 0x8a4f33, 0xd9a94a, 0x7f8fa6] as const
/** Frost-bitten pine canopy for the high west slopes. */
const FROST_PINE = [0x4a7a62, 0x3f6f57, 0x567f68] as const
/** Weathered hemp rope. */
const ROPE = 0x9a7b4f
/** The inside of a mine. Spoiler: it's dark. */
const MINE_DARK = 0x17171c
/** Ravine shadow floor. */
const RAVINE_DARK = 0x23262e
/** Grey-tan lodge plaster (dwarves don't do pastels). */
const LODGE_PLASTER = [0xd9d2c2, 0xcec6b4] as const
const ANVIL_IRON = 0x3d4148

// ---------------------------------------------------------------------------
// Ravine + rope bridges
// ---------------------------------------------------------------------------

/** Ravine strip: x in [RAV_X0, RAV_X1], z in [RAV_Z0, RAV_Z1]. */
const RAV_X0 = -170
const RAV_X1 = -167
const RAV_Z0 = -30
const RAV_Z1 = 60

/**
 * A sagging rope bridge crossing the ravine along X: deck stamped S_BRIDGE
 * (the ground pass renders it at walking height), blocked rope-rail rows on
 * the outside, drooping rope spans between end posts. The two middle rows
 * stay walkable. d is fixed at 4 (rail, walk, walk, rail).
 */
function ropeBridge(ctx: Ctx, x0: number, z0: number, w: number): void {
  const { rng, batches, grid } = ctx
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + 4; iz++) setSurface(ctx, ix, iz, S_BRIDGE)
  }
  for (const rz of [z0, z0 + 3]) {
    grid.blockRect(x0, rz, w, 1)
    // end posts
    batches.wood.add(x0 + 0.25, 0, rz + 0.3, 0.45, 1.35, 0.45, WOOD_DARK)
    batches.wood.add(x0 + w - 0.7, 0, rz + 0.3, 0.45, 1.35, 0.45, WOOD_DARK)
    // drooping rope spans + the odd vertical tie
    const mid = (w - 1) / 2
    for (let i = 0; i < w; i++) {
      const t = (i - mid) / mid
      const y = 0.52 + 0.62 * t * t
      batches.wood.add(x0 + i, y, rz + 0.42, 1, 0.09, 0.14, ROPE)
      if (i % 2 === 1 && i > 0 && i < w - 1) {
        batches.wood.add(x0 + i + 0.44, 0.2, rz + 0.44, 0.08, y - 0.2, 0.08, ROPE)
      }
    }
  }
  // a couple of mismatched replacement planks (deck repairs, dwarf-grade)
  batches.wood.add(x0 + 1 + rng.int(w - 2), 0.02, z0 + 1, 1, 0.08, 0.9, WOOD_DARK)
  batches.wood.add(x0 + 1 + rng.int(w - 2), 0.02, z0 + 2.1, 1, 0.08, 0.9, rng.pick(WOOD))
}

/**
 * Carve the dry ravine (S_RIVER with no water poured = sunken dark chasm;
 * paintCell blocks the cells). Skips bridge decks and any road cell.
 */
function buildRavine(ctx: Ctx): void {
  const { batches } = ctx
  for (let iz = RAV_Z0; iz <= RAV_Z1; iz++) {
    for (let ix = RAV_X0; ix <= RAV_X1; ix++) {
      const s = surfaceAt(ctx, ix, iz)
      if (s === S_BRIDGE || s === S_COBBLE) continue
      setSurface(ctx, ix, iz, S_RIVER)
    }
    // near-black shadow floor on the carved bed (bed top sits at y -0.58)
    let run = -1
    for (let ix = RAV_X0; ix <= RAV_X1 + 1; ix++) {
      const isRav = ix <= RAV_X1 && surfaceAt(ctx, ix, iz) === S_RIVER
      if (isRav && run < 0) run = ix
      if (!isRav && run >= 0) {
        batches.misc.add(run, -0.58, iz, ix - run, 0.08, 1, RAVINE_DARK)
        run = -1
      }
    }
  }
  // crumbled rim stones so the edge reads from a distance
  const { rng } = ctx
  for (let iz = RAV_Z0; iz <= RAV_Z1; iz += 3 + rng.int(4)) {
    const west = rng.next() < 0.5
    const ix = west ? RAV_X0 - 1 : RAV_X1 + 1
    if (surfaceAt(ctx, ix, iz) !== S_GRASS) continue
    if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) continue
    kitRock(ctx, ix, iz, 1)
  }
}

// ---------------------------------------------------------------------------
// Placement guards
// ---------------------------------------------------------------------------

/** [cx, cz, r] keep-clear discs: anchors, landmark floors, mine fronts. */
const KEEP_CLEAR: ReadonlyArray<readonly [number, number, number]> = [
  [-130, 10, 6], // waystone
  [-120, 0, 3], // Foreman Dagna's roadside spot
  [-150, 30, 3], // Smith Orin
  [-190, -40, 3], // Prospector Finn
  [-151, 25, 11], // foreman camp
  [-197, -46, 5], // Rustvein mine front
  [-155, 87, 5], // Deepdelve mine front
  [-163, 7, 4], // boarded adit front
  [-202, 78, 13], // Gravelord's Hollow
  [-221, 38, 6] // high-pass lookout
]

function inKeepClear(ix: number, iz: number): boolean {
  for (const [cx, cz, r] of KEEP_CLEAR) {
    const dx = ix - cx
    const dz = iz - cz
    if (dx * dx + dz * dz < r * r) return true
  }
  return false
}

/** Solid-prop guard: open mountain ground, off every path/ravine/landmark. */
function spotOk(ctx: Ctx, ix: number, iz: number): boolean {
  if (ix < -236 || ix > -84 || iz < -116 || iz > 116) return false
  // stay off the beaches and out of the NW bay
  if (
    !isLand(ix + 4, iz) || !isLand(ix - 4, iz) || !isLand(ix, iz + 4) || !isLand(ix, iz - 4) ||
    !isLand(ix + 3, iz + 3) || !isLand(ix - 3, iz - 3) || !isLand(ix + 3, iz - 3) || !isLand(ix - 3, iz + 3)
  ) {
    return false
  }
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  if (inKeepClear(ix, iz)) return false
  // keep an obvious open gap along every road, path and bridge…
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const s = surfaceAt(ctx, ix + dx, iz + dz)
      if (s === S_COBBLE || s === S_BRIDGE) return false
    }
  }
  // …and keep the ravine rims walkable
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (surfaceAt(ctx, ix + dx, iz + dz) === S_RIVER) return false
    }
  }
  return true
}

/** Wide-footprint guard (crags): center + corners must all pass. */
function areaOk(ctx: Ctx, ix: number, iz: number, r: number): boolean {
  return (
    spotOk(ctx, ix, iz) &&
    spotOk(ctx, ix - r, iz - r) &&
    spotOk(ctx, ix + r, iz - r) &&
    spotOk(ctx, ix - r, iz + r) &&
    spotOk(ctx, ix + r, iz + r)
  )
}

/**
 * Crag guard: single-point sampling (so the peak wall can hug the coast)
 * but with wider path/ravine windows sized to a crag's blocked skirt.
 */
function cragOk(ctx: Ctx, ix: number, iz: number): boolean {
  if (!spotOk(ctx, ix, iz)) return false
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const s = surfaceAt(ctx, ix + dx, iz + dz)
      if (s === S_COBBLE || s === S_BRIDGE) return false
      if (s === S_RIVER && Math.abs(dx) <= 2 && Math.abs(dz) <= 2) return false
    }
  }
  return true
}

/**
 * Light guard for hand-placed camp/roadside props (keep-clear discs don't
 * apply — the landmarks own those): open unblocked ground, off the stamps.
 */
function openCell(ctx: Ctx, ix: number, iz: number, pad = 1): boolean {
  const s0 = surfaceAt(ctx, ix, iz)
  if (s0 !== S_GRASS && s0 !== S_SOIL) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  for (let dx = -pad; dx <= pad; dx++) {
    for (let dz = -pad; dz <= pad; dz++) {
      const s = surfaceAt(ctx, ix + dx, iz + dz)
      if (s === S_COBBLE || s === S_BRIDGE || s === S_RIVER) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Prop builders (all mark collision where solid)
// ---------------------------------------------------------------------------

/** Tiered voxel crag, optionally snow-capped. Blocks its footprint + skirt. */
function crag(ctx: Ctx, ix: number, iz: number, big: boolean, snow: boolean): void {
  const { rng, batches, grid } = ctx
  const s = big ? 3 + rng.int(2) : 2 + rng.int(2) // 2-4 cell footprint
  const h = rng.range(1.6, 2.4) + s * rng.range(0.8, 1.2)
  batches.stone.add(ix, 0, iz, s, h * 0.5, s, rng.pick(CRAG_ROCK))
  batches.stone.add(
    ix + rng.range(0.2, 0.7),
    0,
    iz + rng.range(0.2, 0.7),
    s - 1,
    h * 0.78,
    s - 1,
    rng.pick(CRAG_ROCK)
  )
  const topW = Math.max(0.8, s - 2)
  const tx = ix + rng.range(0.5, Math.max(0.7, s - topW - 0.4))
  const tz = iz + rng.range(0.5, Math.max(0.7, s - topW - 0.4))
  batches.stone.add(tx, 0, tz, topW, h, topW, rng.pick(CRAG_ROCK))
  if (snow) {
    batches.stone.add(tx - 0.12, h, tz - 0.12, topW + 0.24, 0.3, topW + 0.24, SNOW)
    if (s >= 3) {
      batches.stone.add(ix + 0.3, h * 0.78, iz + 0.3, s - 1.6, 0.18, s - 1.6, SNOW)
    }
  }
  // shoulder boulder
  batches.stone.add(
    ix + rng.range(-0.6, s - 0.4),
    0,
    iz + rng.range(-0.6, s - 0.4),
    1,
    rng.range(0.5, 1.1),
    1,
    rng.pick(CRAG_ROCK)
  )
  grid.blockRect(ix - 1, iz - 1, s + 2, s + 2)
}

/** Ore-vein boulder: outcrop with copper/iron/gold flecks (visual only). */
function oreBoulder(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  kitRock(ctx, ix, iz, 2)
  const n = 3 + rng.int(3)
  for (let i = 0; i < n; i++) {
    batches.misc.add(
      ix + rng.range(-0.2, 1.7),
      rng.range(0.3, 1.4),
      iz + rng.range(-0.2, 1.7),
      0.3,
      0.3,
      0.3,
      rng.pick(ORE)
    )
  }
  // the occasional glint that makes prospectors do questionable things
  if (rng.next() < 0.25) {
    batches.window.add(ix + rng.range(0.2, 1.4), rng.range(0.5, 1.2), iz + rng.range(0.2, 1.4), 0.2, 0.2, 0.2, 0xffd36b)
  }
}

/**
 * Mine mouth driven into a tiered rock massif, opening on the EAST face:
 * dark portal, timber posts + lintel + plank awning, rails and an ore cart
 * out front. `boarded` nails planks over it instead (don't ask). Blocks the
 * massif + the cart; rails are walk-over thin.
 */
function mineMouth(
  ctx: Ctx,
  x0: number,
  z0: number,
  w: number,
  d: number,
  mouthZ: number,
  boarded: boolean
): void {
  const { rng, batches, grid } = ctx
  const fx = x0 + w // east face plane
  // the hillside: three shrinking tiers
  batches.stone.add(x0, 0, z0, w, 2.3, d, rng.pick(CRAG_ROCK))
  batches.stone.add(x0, 2.3, z0 + 0.6, w - 1, 1.3, d - 1.2, rng.pick(CRAG_ROCK))
  batches.stone.add(x0 + 0.6, 3.6, z0 + 1.4, w - 2.4, 1.1, d - 2.8, rng.pick(CRAG_ROCK))
  // shoulder rocks hugging the face
  batches.stone.add(fx - 0.5, 0, z0 - 0.4, 1.2, 1.4, 1.1, rng.pick(CRAG_ROCK))
  batches.stone.add(fx - 0.5, 0, z0 + d - 0.7, 1.2, 1.7, 1.1, rng.pick(CRAG_ROCK))

  if (boarded) {
    // the opening, sealed with planks nailed on by someone in a hurry
    batches.misc.add(fx - 0.45, 0, mouthZ, 0.6, 2.2, 2, MINE_DARK)
    batches.wood.add(fx + 0.1, 0.25, mouthZ - 0.15, 0.16, 0.3, 2.3, rng.pick(WOOD))
    batches.wood.add(fx + 0.1, 0.95, mouthZ - 0.15, 0.16, 0.3, 2.3, rng.pick(WOOD))
    batches.wood.add(fx + 0.12, 1.65, mouthZ - 0.05, 0.16, 0.3, 2.1, WOOD_DARK)
  } else {
    // open portal with a faint glow from somewhere down there
    batches.misc.add(fx - 0.45, 0, mouthZ, 0.8, 2.3, 2, MINE_DARK)
    batches.window.add(fx - 0.35, 0.85, mouthZ + 0.55, 0.3, 0.35, 0.3, WINDOW_GLOW)
    batches.window.add(fx - 0.3, 0.35, mouthZ + 1.2, 0.22, 0.25, 0.22, EMBER)
    // rails heading east out of the mouth (thin — walk right over them)
    batches.wood.add(fx + 0.3, 0, mouthZ + 0.25, 3.2, 0.1, 0.22, WOOD_DARK)
    batches.wood.add(fx + 0.3, 0, mouthZ + 1.5, 3.2, 0.1, 0.22, WOOD_DARK)
    for (let i = 0; i < 3; i++) {
      batches.wood.add(fx + 0.6 + i * 1.1, 0, mouthZ + 0.1, 0.5, 0.08, 1.8, rng.pick(WOOD))
    }
    // ore cart, parked badly
    const cx = fx + 1.6
    const cz = mouthZ + 0.35
    batches.wood.add(cx, 0.28, cz, 1.2, 0.72, 1.3, rng.pick(WOOD))
    batches.wood.add(cx - 0.08, 0.92, cz - 0.08, 1.36, 0.14, 1.46, WOOD_DARK)
    batches.misc.add(cx + 0.12, 0.06, cz + 0.12, 0.3, 0.3, 0.3, ANVIL_IRON)
    batches.misc.add(cx + 0.8, 0.06, cz + 0.9, 0.3, 0.3, 0.3, ANVIL_IRON)
    batches.misc.add(cx + 0.2, 1.0, cz + 0.25, 0.5, 0.3, 0.5, rng.pick(ORE))
    batches.misc.add(cx + 0.6, 1.0, cz + 0.6, 0.45, 0.38, 0.45, rng.pick(ORE))
    grid.blockRect(Math.round(cx), Math.round(cz), 2, 2)
  }

  // timber frame: posts, lintel, little plank awning
  batches.wood.add(fx - 0.2, 0, mouthZ - 0.6, 0.5, 2.6, 0.5, WOOD_DARK)
  batches.wood.add(fx - 0.2, 0, mouthZ + 2.1, 0.5, 2.6, 0.5, WOOD_DARK)
  batches.wood.add(fx - 0.25, 2.5, mouthZ - 0.65, 0.6, 0.5, 3.3, WOOD_DARK)
  batches.wood.add(fx - 0.05, 3.0, mouthZ - 0.85, 1.1, 0.22, 3.7, rng.pick(WOOD))

  grid.blockRect(x0, z0, w, d)
  // the shoulder stones poke past the face — block their cells too
  grid.block(fx, z0 - 1)
  grid.block(fx, z0 + d - 1)
  grid.block(fx, z0 + d)
}

/**
 * The open-air forge: four posts under a little green roof, stone hearth +
 * chimney, glowing coal bed (window batch — it flickers with the village),
 * anvil on a stump, quench barrel. Carries the region's warm PointLight.
 */
function forge(ctx: Ctx, scene: THREE.Scene, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  for (const [dx, dz] of [
    [0.2, 0.2],
    [2.3, 0.2],
    [0.2, 3.3],
    [2.3, 3.3]
  ] as const) {
    batches.wood.add(ix + dx, 0, iz + dz, 0.4, 2.4, 0.4, rng.pick(WOOD))
  }
  batches.roof.add(ix - 0.4, 2.4, iz - 0.4, 3.8, 0.5, 4.8, rng.pick(ROOF))
  batches.roof.add(ix + 0.3, 2.9, iz + 0.3, 2.4, 0.45, 3.4, rng.pick(ROOF))
  // hearth against the west side + chimney punching through the roof
  batches.stone.add(ix, 0, iz + 0.8, 1.2, 1.1, 2.4, rng.pick(STONE))
  batches.stone.add(ix + 0.1, 1.1, iz + 1.5, 0.9, 2.9, 0.9, rng.pick(STONE))
  // the coal bed (flickers) + one honest warm light
  batches.window.add(ix + 0.95, 1.05, iz + 1.1, 0.55, 0.22, 1.5, 0xff8c3a)
  batches.window.add(ix + 1.05, 1.27, iz + 1.5, 0.3, 0.16, 0.6, 0xffd36b)
  const light = new THREE.PointLight(0xff9a4a, 16, 12, 1.8)
  light.position.set(ix + 1.3, 1.9, iz + 1.8)
  scene.add(light)
  // anvil on a stump, quench barrel in the corner
  batches.wood.add(ix + 2.0, 0, iz + 1.5, 0.6, 0.5, 0.6, WOOD_DARK)
  batches.misc.add(ix + 1.82, 0.5, iz + 1.55, 0.95, 0.35, 0.5, ANVIL_IRON)
  batches.wood.add(ix + 2.1, 0, iz + 2.9, 0.75, 0.8, 0.75, rng.pick(WOOD))
  batches.misc.add(ix + 2.2, 0.72, iz + 3.0, 0.55, 0.1, 0.55, 0x3f87d6)
  grid.blockRect(ix, iz, 3, 4)
}

/** Crate with raw ore lumps on top (the camp's entire economy). */
function oreCrate(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.05, 0, iz + 0.05, 0.9, 0.8, 0.9, rng.pick(WOOD))
  batches.wood.add(ix + 0.05, 0.8, iz + 0.05, 0.9, 0.12, 0.9, WOOD_DARK)
  batches.misc.add(ix + 0.18, 0.92, iz + 0.2, 0.34, 0.3, 0.34, rng.pick(ORE))
  batches.misc.add(ix + 0.5, 0.92, iz + 0.45, 0.3, 0.38, 0.3, rng.pick(ORE))
  grid.block(ix, iz)
}

/** Stacked timber (2 + 1 logs along X, 3 cells). */
function timberStack(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0, iz + 0.08, 3, 0.55, 0.42, rng.pick(WOOD))
  batches.wood.add(ix, 0, iz + 0.52, 3, 0.55, 0.42, rng.pick(WOOD))
  batches.wood.add(ix + 0.1, 0.55, iz + 0.3, 2.8, 0.5, 0.42, rng.pick(WOOD))
  grid.blockRect(ix, iz, 3, 1)
}

/** Wooden sign on a post (assume the carving is rude). */
function sign(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.4, 0, iz + 0.4, 0.25, 1.6, 0.25, WOOD_DARK)
  batches.wood.add(ix - 0.15, 1.05, iz + 0.32, 1.5, 0.75, 0.2, rng.pick(WOOD))
  grid.block(ix, iz)
}

/** Standing stone (old, tilted, judgemental). */
function standingStone(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix + 0.15, 0, iz + 0.25, 0.8, rng.range(2.4, 3.2), 0.6, rng.pick(CRAG_ROCK))
  batches.stone.add(ix + 0.05, 0, iz + 0.15, 1, 0.4, 0.9, rng.pick(CRAG_ROCK))
  grid.block(ix, iz)
}

/** Summit cairn + banner pole for the high-pass lookout. */
function cairn(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix, 0, iz, 1.6, 0.6, 1.6, rng.pick(CRAG_ROCK))
  batches.stone.add(ix + 0.25, 0.6, iz + 0.25, 1.1, 0.55, 1.1, rng.pick(CRAG_ROCK))
  batches.stone.add(ix + 0.5, 1.15, iz + 0.5, 0.6, 0.5, 0.6, SNOW)
  batches.wood.add(ix + 0.72, 1.6, iz + 0.72, 0.16, 2.6, 0.16, WOOD_DARK)
  batches.roof.add(ix + 0.88, 3.4, iz + 0.66, 0.9, 0.55, 0.12, rng.pick(ROOF))
  grid.blockRect(ix, iz, 2, 2)
}

// ---------------------------------------------------------------------------
// Paths (switchbacks — the zigzags are the point)
// ---------------------------------------------------------------------------

function buildPaths(ctx: Ctx): void {
  // waystone → foreman camp
  kitPath(ctx, [
    [-130, 10],
    [-137, 15],
    [-144, 19],
    [-151, 24]
  ])
  // road → north rope bridge → Rustvein Mine (past Prospector Finn)
  kitPath(ctx, [
    [-133, 4],
    [-140, -2],
    [-148, -4],
    [-156, -8],
    [-162, -10],
    [-175, -11],
    [-181, -18],
    [-186, -28],
    [-190, -36],
    [-196, -45]
  ])
  // camp → switchbacks south → Deepdelve Mine
  kitPath(ctx, [
    [-146, 31],
    [-144, 38],
    [-136, 48],
    [-142, 60],
    [-136, 72],
    [-144, 82],
    [-151, 87]
  ])
  // camp → south rope bridge → high pass → the lookout
  kitPath(ctx, [
    [-154, 27],
    [-159, 31],
    [-162, 35],
    [-175, 36],
    [-183, 32],
    [-192, 40],
    [-202, 34],
    [-212, 42],
    [-221, 38]
  ])
  // Deepdelve → the Gravelord's Hollow (marked "do not", widely ignored)
  kitPath(ctx, [
    [-152, 91],
    [-160, 95],
    [-170, 92],
    [-182, 86],
    [-193, 80]
  ])
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/** The foreman camp (Dagna runs it; Orin's anvil anchors stay walkable). */
function buildForemanCamp(ctx: Ctx, scene: THREE.Scene): void {
  // packed-earth camp floor
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      if (dx * dx + dz * dz > 22) continue
      const ix = -150 + dx
      const iz = 26 + dz
      if (surfaceAt(ctx, ix, iz) === S_GRASS) setSurface(ctx, ix, iz, S_SOIL)
    }
  }
  // the foreman's stone lodge (green roof, obviously — we're not animals)
  kitHouseShell(
    ctx,
    { x0: -160, z0: 17, w: 7, d: 6, wallH: 3, door: 'E', chimney: true },
    { stone: CRAG_ROCK, plaster: LODGE_PLASTER, timber: WOOD_DARK }
  )
  forge(ctx, scene, -149, 25) // Smith Orin works at (-150, 30), just outside
  if (openCell(ctx, -157, 26) && openCell(ctx, -155, 26)) timberStack(ctx, -157, 26)
  if (openCell(ctx, -143, 22)) oreCrate(ctx, -143, 22)
  if (openCell(ctx, -142, 21)) oreCrate(ctx, -142, 21)
  if (openCell(ctx, -156, 31)) oreCrate(ctx, -156, 31)
  kitFenceRun(ctx, -160, 14, 8, true)
  kitFenceRun(ctx, -141, 22, 4, false)
  if (openCell(ctx, -144, 25)) kitLantern(ctx, scene, -144, 25)
  if (openCell(ctx, -146, 17)) sign(ctx, -146, 17)
}

/** Dagna's roadside spot: a sign and the paperwork crates she lives behind. */
function buildForemanPost(ctx: Ctx): void {
  if (openCell(ctx, -124, -4, 2)) sign(ctx, -124, -4)
  if (openCell(ctx, -117, 4, 2)) oreCrate(ctx, -117, 4)
  if (openCell(ctx, -116, 5, 2)) oreCrate(ctx, -116, 5)
}

/** Gravelord's Hollow: a crag ring arena with an east opening. */
function buildGolemHollow(ctx: Ctx): void {
  const { rng, batches } = ctx
  const cx = -202
  const cz = 78
  const n = 12
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2
    const deg = (a * 180) / Math.PI
    if (deg < 30 || deg > 330) continue // the way in (east)
    const ix = Math.round(cx + Math.cos(a) * 10)
    const iz = Math.round(cz + Math.sin(a) * 10)
    crag(ctx, ix, iz, k % 2 === 0, false)
  }
  standingStone(ctx, -207, 73)
  standingStone(ctx, -198, 83)
  // rubble the big fella kicked loose (walk-through gravel)
  for (let i = 0; i < 10; i++) {
    const rx = cx + rng.range(-6, 6)
    const rz = cz + rng.range(-6, 6)
    batches.stone.add(rx, 0, rz, rng.range(0.3, 0.7), rng.range(0.2, 0.45), rng.range(0.3, 0.7), rng.pick(CRAG_ROCK))
  }
}

/** The high-pass lookout: cairn, banner, snowline view, howling wind free. */
function buildLookout(ctx: Ctx): void {
  cairn(ctx, -224, 36)
  if (openCell(ctx, -225, 41)) kitRock(ctx, -225, 41, 2)
  crag(ctx, -229, 31, true, true)
  if (openCell(ctx, -219, 43, 2)) kitRock(ctx, -219, 43, 1)
}

/** Ore-vein boulder clusters near each mine + a mid-slope seam. */
function buildOreFields(ctx: Ctx): void {
  const { rng } = ctx
  const clusters: ReadonlyArray<readonly [number, number, number]> = [
    [-188, -50, 5], // Rustvein spill
    [-147, 80, 4], // Deepdelve spill
    [-178, 52, 4], // mid-slope seam west of the ravine
    [-126, -52, 3] // the one Finn won't shut up about
  ]
  for (const [gx, gz, count] of clusters) {
    for (let i = 0; i < count; i++) {
      const ix = Math.round(gx + rng.range(-4.5, 4.5))
      const iz = Math.round(gz + rng.range(-4.5, 4.5))
      if (!areaOk(ctx, ix, iz, 2)) continue
      oreBoulder(ctx, ix, iz)
    }
  }
}

// ---------------------------------------------------------------------------
// Peaks, ridges and the general rockiness
// ---------------------------------------------------------------------------

function buildPeaks(ctx: Ctx): void {
  const { rng } = ctx
  // the west wall: snow-dusted peaks shoulder-to-shoulder along the rim
  for (let gz = -102; gz <= 110; gz += 5) {
    const ix = -231 + rng.int(5)
    const iz = gz + rng.int(4) - 2
    if (!cragOk(ctx, ix, iz)) continue
    crag(ctx, ix, iz, true, true)
  }
  // an inner shoulder row, patchier snow
  for (let gz = -92; gz <= 102; gz += 8) {
    const ix = -222 + rng.int(8)
    const iz = gz + rng.int(5) - 2
    if (!cragOk(ctx, ix, iz)) continue
    crag(ctx, ix, iz, rng.next() < 0.7, rng.next() < 0.55)
  }
  // ridge chains framing the mine valleys
  const chains: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [-208, -82, -198, -56, 4], // north of Rustvein
    [-210, 58, -206, 104, 5], // south-west highlands
    [-138, -86, -108, -106, 4], // NE coastward spine
    [-96, -40, -90, 20, 4] // eastern slopes stepping down to the meadow
  ]
  for (const [ax, az, bx, bz, n] of chains) {
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const ix = Math.round(ax + (bx - ax) * t + rng.range(-3, 3))
      const iz = Math.round(az + (bz - az) * t + rng.range(-3, 3))
      if (!cragOk(ctx, ix, iz)) continue
      crag(ctx, ix, iz, rng.next() < 0.5, ix < -215)
    }
  }
}

/** Guarded scatter: scree, lone crags, hardy pines, snow patches. */
function scatterMountain(ctx: Ctx): void {
  const { rng, batches } = ctx
  for (let gx = -236; gx <= -84; gx += 5) {
    for (let gz = -116; gz <= 116; gz += 5) {
      const ix = gx + rng.int(5) - 2
      const iz = gz + rng.int(5) - 2
      const roll = rng.next()
      // pines thin out as the ground climbs west
      const pineP = ix > -150 ? 0.14 : ix > -195 ? 0.07 : 0.025
      if (roll < pineP) {
        if (!spotOk(ctx, ix, iz)) continue
        const opts: { tall: boolean; leaves?: readonly number[] } = { tall: rng.next() < 0.45 }
        if (ix < -185) opts.leaves = FROST_PINE
        else if (rng.next() < 0.5) opts.leaves = PINE_LEAF
        kitPine(ctx, ix, iz, opts)
      } else if (roll < pineP + 0.12) {
        if (!spotOk(ctx, ix, iz)) continue
        kitRock(ctx, ix, iz, (1 + rng.int(2)) as 1 | 2)
      } else if (roll < pineP + 0.17) {
        if (!cragOk(ctx, ix, iz)) continue
        crag(ctx, ix, iz, rng.next() < 0.35, ix < -218)
      } else if (roll < pineP + 0.182 && ix > -160) {
        if (!spotOk(ctx, ix, iz)) continue
        kitDeadTree(ctx, ix, iz)
      } else if (roll < pineP + 0.24 && ix < -200) {
        // snow patches creeping down from the rim (walk-through)
        if (surfaceAt(ctx, ix, iz) !== S_GRASS) continue
        if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) continue
        batches.grass.add(ix, 0, iz, rng.range(1, 2.2), 0.07, rng.range(1, 2.2), SNOW)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildRegion(ctx: Ctx, scene: THREE.Scene): void {
  // decks first so the ravine parts around them; paths skip both
  ropeBridge(ctx, -172, -12, 8) // north crossing (mine road)
  ropeBridge(ctx, -172, 34, 8) // south crossing (high pass)
  buildRavine(ctx)
  buildPaths(ctx)

  buildForemanCamp(ctx, scene)
  buildForemanPost(ctx)
  // Rustvein Mine (Prospector Finn vends tall tales out front)
  mineMouth(ctx, -205, -50, 8, 9, -47, false)
  kitLantern(ctx, scene, -195, -49)
  // Deepdelve Mine
  mineMouth(ctx, -163, 83, 7, 8, 86, false)
  // the boarded adit by the ravine (it's fine, everything's fine)
  mineMouth(ctx, -166, 4, 3, 5, 6, true)
  buildGolemHollow(ctx)
  buildLookout(ctx)
  buildOreFields(ctx)

  buildPeaks(ctx)
  scatterMountain(ctx)
}
