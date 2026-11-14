/**
 * src/world/zones/batch14.ts — ZONE_BATCHES[13]: the SUN-BLASTED FRONTIER.
 *
 *   vulture_veranda  wastes  21-30  the politest scavengers in the business
 *   sunburn_flats    desert  43-56  SPF four thousand recommended
 *   big_crack        canyon  44-58  a gorge with excellent acoustics
 *   glass_furnace    desert  72-88  lightning turned the sand to mirrors
 *   pharaohs_folly   ruins   70-86  great gold, terrible exit signage
 *   stampede_lands   savanna 58-72  hear thunder? climb something
 *
 * Contract per builder: stamp surfaces FIRST (kitPath / kitBridgePlank /
 * setSurface), then streamGroundPass, then props (kit builders mark their
 * own collision). Everything draws from ctx.rng (seeded per-zone by the
 * stream) so re-entry rebuilds the identical zone. Placement never consults
 * the collision grid (marks are permanent — grid checks would dedupe a
 * rebuild into an empty zone); overlap is avoided with a per-run local set.
 */
import { registerZoneBuilder, streamGroundPass } from '../stream'
import {
  BONE_WHITE,
  DEAD_WOOD,
  FLOWER,
  ICE,
  PLASTER,
  RUIN_STONE,
  STONE,
  WOOD,
  WOOD_DARK,
  isLand,
  kitBone,
  kitBridgePlank,
  kitCactus,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitGrave,
  kitLantern,
  kitPalm,
  kitPath,
  kitRock,
  kitRuinPillar,
  kitStatue,
  kitTotem,
  kitTree
} from '../kit'
import { S_GRASS, S_SOIL, setSurface, surfaceAt, type Ctx } from '../layout'

// ---------------------------------------------------------------------------
// Deterministic scatter helpers (no grid reads — see file docs)
// ---------------------------------------------------------------------------

interface Clear {
  x: number
  z: number
  r: number
}

const key = (ix: number, iz: number): number => (ix + 720) * 1441 + (iz + 720)

function okCell(ctx: Ctx, ix: number, iz: number, used: Set<number>, clears: readonly Clear[]): boolean {
  if (!isLand(ix + 0.5, iz + 0.5)) return false
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (used.has(key(ix, iz))) return false
  for (const c of clears) {
    const dx = ix - c.x
    const dz = iz - c.z
    if (dx * dx + dz * dz < c.r * c.r) return false
  }
  return true
}

function take(used: Set<number>, ix: number, iz: number): void {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) used.add(key(ix + dx, iz + dz))
  }
}

type Placer = (ix: number, iz: number) => void

/** Sparse fill across a rect — tries `count` spots, skips bad ones. */
function scatter(
  ctx: Ctx,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  count: number,
  used: Set<number>,
  clears: readonly Clear[],
  fn: Placer
): void {
  for (let i = 0; i < count; i++) {
    const ix = Math.floor(ctx.rng.range(x0, x1))
    const iz = Math.floor(ctx.rng.range(z0, z1))
    if (!okCell(ctx, ix, iz, used, clears)) continue
    take(used, ix, iz)
    fn(ix, iz)
  }
}

/** Cozy-dense ring of props around a landmark. */
function cluster(
  ctx: Ctx,
  cx: number,
  cz: number,
  r: number,
  count: number,
  used: Set<number>,
  clears: readonly Clear[],
  fn: Placer
): void {
  for (let i = 0; i < count; i++) {
    const a = ctx.rng.range(0, Math.PI * 2)
    const d = ctx.rng.range(r * 0.3, r)
    const ix = Math.floor(cx + Math.cos(a) * d)
    const iz = Math.floor(cz + Math.sin(a) * d)
    if (!okCell(ctx, ix, iz, used, clears)) continue
    take(used, ix, iz)
    fn(ix, iz)
  }
}

// ---------------------------------------------------------------------------
// Shared micro-props
// ---------------------------------------------------------------------------

const VULTURE_BODY = 0x3b3833
const BEAK = 0xd98a3e
const SANDSTONE = [0xd8c088, 0xcdb379, 0xe2cc98] as const
const ACACIA_LEAF = [0x6f8f3c, 0x7a9c44, 0x637f35] as const
const GLASS_DARK = 0x1a1410
const GOLD = 0xdcb13f

/** One hunched vulture — body, bald bone head, beak. Decorative, no block. */
function vulture(ctx: Ctx, x: number, y: number, z: number): void {
  const { rng, batches } = ctx
  batches.misc.add(x, y, z, 0.62, 0.5, 0.5, VULTURE_BODY) // hunched body
  batches.misc.add(x + 0.05, y + 0.4, z + 0.12, 0.2, 0.42, 0.26, VULTURE_BODY) // neck hunch
  batches.misc.add(x - 0.02, y + 0.78, z + 0.1, 0.26, 0.24, 0.3, rng.pick(BONE_WHITE)) // bald head
  batches.misc.add(x - 0.24, y + 0.8, z + 0.17, 0.24, 0.12, 0.16, BEAK) // beak
}

/** Signpost — post + plaster board. Blocks the cell. */
function signpost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.4, 0.24, 1.9, 0.24, WOOD_DARK)
  batches.plaster.add(ix - 0.25, 1.15, iz + 0.36, 1.5, 0.75, 0.16, rng.pick(PLASTER))
  grid.block(ix, iz)
}

/** A covered trade wagon (or its overturned corpse). Blocks ~3x2. */
function wagon(ctx: Ctx, ix: number, iz: number, wrecked: boolean): void {
  const { rng, batches, grid } = ctx
  if (!wrecked) {
    batches.wood.add(ix, 0.5, iz, 3, 0.9, 1.8, rng.pick(WOOD)) // bed
    batches.plaster.add(ix + 0.3, 1.4, iz + 0.15, 2.4, 1.1, 1.5, rng.pick(PLASTER)) // canvas
    batches.roof.add(ix + 0.2, 2.5, iz + 0.05, 2.6, 0.35, 1.7, WOOD_DARK) // bowed top
    batches.stone.add(ix + 0.3, 0, iz - 0.25, 0.9, 0.9, 0.3, WOOD_DARK) // wheels
    batches.stone.add(ix + 1.9, 0, iz - 0.25, 0.9, 0.9, 0.3, WOOD_DARK)
    batches.stone.add(ix + 0.3, 0, iz + 1.75, 0.9, 0.9, 0.3, WOOD_DARK)
    batches.stone.add(ix + 1.9, 0, iz + 1.75, 0.9, 0.9, 0.3, WOOD_DARK)
  } else {
    batches.wood.add(ix, 0, iz, 1.9, 2.8, 0.5, rng.pick(WOOD)) // bed flipped on its side
    batches.plaster.add(ix + 0.2, 0, iz + 0.6, 1.6, 0.5, 2.2, rng.pick(PLASTER)) // spilled canvas
    batches.stone.add(ix + 2.1, 0, iz + 0.4, 0.9, 0.9, 0.3, WOOD_DARK) // one wheel, rolling free
    batches.stone.add(ix - 0.6, 0, iz + 1.6, 0.3, 0.9, 0.9, WOOD_DARK) // one still attached, skyward
    batches.wood.add(ix + 0.4, 0, iz + 2.6, 0.8, 0.8, 0.8, rng.pick(WOOD)) // flung crate
  }
  grid.blockRect(ix - 1, iz - 1, 5, 4)
}

/** Half-sunk mirror slab of storm glass. Blocks the cell. */
function mirrorShard(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 1.2 + rng.range(0, 1.4)
  const alongX = rng.next() < 0.5
  batches.misc.add(
    ix + (alongX ? -0.2 : 0.3), 0, iz + (alongX ? 0.3 : -0.2),
    alongX ? 1.4 : 0.4, h, alongX ? 0.4 : 1.4, rng.pick(ICE)
  )
  batches.misc.add(ix + 0.25, h, iz + 0.25, 0.5, 0.3, 0.5, rng.pick(ICE)) // chipped top
  grid.block(ix, iz)
}

/** Flat-topped acacia — tall bare trunk, wide pancake canopy. Blocks. */
function acacia(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 3 + rng.int(2)
  batches.wood.add(ix + 0.25, 0, iz + 0.25, 0.5, h, 0.5, rng.pick(DEAD_WOOD))
  batches.wood.add(ix + 0.55, h - 1.2, iz + 0.1, 0.9, 0.35, 0.35, rng.pick(DEAD_WOOD)) // crook branch
  batches.leaf.add(ix - 1.6, h, iz - 1.6, 4.2, 0.5, 4.2, rng.pick(ACACIA_LEAF)) // the pancake
  batches.leaf.add(ix - 0.7, h + 0.5, iz - 0.7, 2.4, 0.4, 2.4, rng.pick(ACACIA_LEAF))
  grid.block(ix, iz)
}

/** Tuft of dry savanna grass. Decorative, no block. */
function grassTuft(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  batches.leaf.add(ix + 0.2, 0, iz + 0.2, 0.6, 0.5 + rng.range(0, 0.4), 0.6, 0xb3a452)
  batches.leaf.add(ix + 0.38, 0, iz + 0.05, 0.25, 0.9, 0.25, 0xa2933f)
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function registerBatch14(): void {
  // -------------------------------------------------------------------------
  // VULTURE VERANDA (wastes 21-30, x 240..360, z 240..360)
  // The SE arterial runs corner-to-corner through here; everything that
  // limps along it eventually stops. The vultures appreciate the service.
  // -------------------------------------------------------------------------
  registerZoneBuilder('vulture_veranda', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Path: short spur east off the SE arterial (which passes ~(300, 290))
    // to where the last caravan made its final, extremely final, stop.
    kitPath(ctx, [[302, 292], [312, 288], [322, 285]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Buffet Line": a wrecked trade caravan, one wagon
    // upright and abandoned, one flipped with its wheel still spinning in
    // spirit. The vultures have formed an orderly queue behind a sign that
    // the ringleader insists reads "PLEASE WAIT TO BE SEATED".
    wagon(ctx, 327, 282, false)
    wagon(ctx, 334, 287, true)
    signpost(ctx, 324, 290)
    for (let i = 0; i < 5; i++) {
      vulture(ctx, 324.4 + 1.6 * (i + 1), 0, 292 + Math.sin(i * 1.7) * 0.5) // the queue
    }
    vulture(ctx, 328, 3.1, 282.4) // queue-jumper on the canvas roof
    batches.wood.add(330, 0, 285.5, 0.8, 0.8, 0.8, rng.pick(WOOD)) // scattered cargo
    batches.wood.add(331.1, 0, 284.8, 0.65, 0.65, 0.65, rng.pick(WOOD))
    grid.block(330, 285)
    grid.block(331, 284)
    kitBone(ctx, 338, 284)
    kitBone(ctx, 331, 291)

    // LANDMARK 2 — "The Maitre d'": a crooked rock spire where the oldest,
    // fattest vulture surveys the veranda, napkin figuratively at the ready.
    // The campfire below is for guests who arrive pre-cooked. (1 ember use)
    const mx = 282
    const mz = 330
    batches.stone.add(mx - 1, 0, mz - 1, 3.4, 2.2, 3.4, rng.pick(STONE))
    batches.stone.add(mx - 0.4, 2.2, mz - 0.4, 2.2, 2.4, 2.2, rng.pick(STONE))
    batches.stone.add(mx, 4.6, mz + 0.1, 1.3, 2, 1.3, rng.pick(STONE))
    grid.blockRect(mx - 1, mz - 1, 4, 4)
    vulture(ctx, mx + 0.3, 6.6, mz + 0.4) // the man himself
    kitCampfire(ctx, mx + 5, mz + 3)
    kitBone(ctx, mx + 4, mz - 3)
    kitPath(ctx, [[292, 316], [288, 324], [286, 330]], 1.1) // spur off the arterial

    const clears: Clear[] = [
      { x: 331, z: 287, r: 10 },
      { x: mx + 1, z: mz + 1, r: 7 }
    ]
    cluster(ctx, 331, 287, 16, 10, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 244, 244, 356, 356, 30, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 244, 244, 356, 356, 22, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 244, 244, 356, 356, 10, used, clears, (x, z) => kitBone(ctx, x, z))
    // a few freelance vultures in the dead trees
    scatter(ctx, 248, 248, 352, 352, 6, used, clears, (x, z) => {
      kitDeadTree(ctx, x, z)
      vulture(ctx, x + 0.2, 3.2, z + 0.2)
    })
  })

  // -------------------------------------------------------------------------
  // SUNBURN FLATS (desert 43-56, x 80..240, z 360..520)
  // -------------------------------------------------------------------------
  registerZoneBuilder('sunburn_flats', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Surfaces first: the dried pond bed, then the path in from the west
    // edge (the S arterial sends a spur across Mirage Mile to (80, 448)).
    const ox = 140 // the ex-oasis
    const oz = 452
    for (let ix = ox - 7; ix <= ox + 7; ix++) {
      for (let iz = oz - 5; iz <= oz + 5; iz++) {
        const nx = (ix - ox) / 7
        const nz = (iz - oz) / 5
        if (nx * nx + nz * nz <= 1) setSurface(ctx, ix, iz, S_SOIL) // cracked mud
      }
    }
    kitPath(ctx, [[80, 448], [98, 452], [116, 447], [130, 452]])
    kitPath(ctx, [[144, 444], [160, 432], [174, 424]], 1.1) // on to Sizzle Rock

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Oasis of Lowered Expectations": the water left years
    // ago and nobody updated the brochure. Palm ring, abandoned towels, and
    // a refreshments stand whose sign reads "WATER: SOLD OUT (FOREVER)".
    batches.misc.add(ox - 5, -0.25, oz - 3.5, 10, 0.2, 7, 0xb59a66) // sun-cracked pond bed
    signpost(ctx, ox - 9, oz - 2)
    batches.wood.add(ox + 7, 0, oz - 6, 2.6, 2, 0.4, rng.pick(WOOD)) // the stand
    batches.roof.add(ox + 6.6, 2, oz - 6.6, 3.4, 0.35, 1.8, rng.pick(WOOD)) // its optimistic awning
    batches.wood.add(ox + 7.2, 0, oz - 5.2, 0.3, 1.1, 0.3, WOOD_DARK)
    batches.wood.add(ox + 9.1, 0, oz - 5.2, 0.3, 1.1, 0.3, WOOD_DARK)
    grid.blockRect(ox + 6, oz - 7, 4, 3)
    batches.plaster.add(ox - 2, 0.02, oz + 6.5, 1, 0.08, 2, 0xd96459) // beach towels, pre-toasted
    batches.plaster.add(ox + 1, 0.02, oz + 7, 1, 0.08, 2, 0x5b8fd4)
    batches.plaster.add(ox + 4, 0.02, oz + 6.2, 1, 0.08, 2, 0xe0c24e)

    // LANDMARK 2 — "Sizzle Rock": a griddle-flat boulder hot enough to fry
    // an egg, proven daily by the giant egg somebody keeps frying on it.
    // Spatula included. Breakfast is a public service here.
    const sx = 178
    const sz = 420
    batches.stone.add(sx - 3, 0, sz - 2.5, 6.5, 1.1, 5.5, rng.pick(STONE)) // the griddle
    batches.misc.add(sx - 1.4, 1.1, sz - 1.2, 3, 0.18, 2.6, 0xf4efe2) // the white
    batches.misc.add(sx - 0.3, 1.26, sz - 0.2, 1, 0.45, 1, 0xf2b230) // the yolk
    batches.wood.add(sx + 3.4, 0.4, sz + 1.6, 2.2, 0.16, 0.5, WOOD_DARK) // spatula handle
    batches.misc.add(sx + 5.4, 0.4, sz + 1.35, 0.9, 0.12, 1, 0x9aa0ad) // spatula blade
    grid.blockRect(sx - 3, sz - 3, 7, 6)
    kitBone(ctx, sx - 6, sz + 4)

    const clears: Clear[] = [
      { x: ox, z: oz, r: 12 },
      { x: sx, z: sz, r: 7 }
    ]
    cluster(ctx, ox, oz, 13, 9, used, clears, (x, z) => kitPalm(ctx, x, z)) // the palm ring
    cluster(ctx, sx, sz, 12, 7, used, clears, (x, z) => kitCactus(ctx, x, z))
    scatter(ctx, 84, 364, 236, 516, 34, used, clears, (x, z) => kitCactus(ctx, x, z))
    scatter(ctx, 84, 364, 236, 516, 18, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 84, 364, 236, 516, 8, used, clears, (x, z) => kitBone(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // THE BIG CRACK (canyon 44-58, x 240..360, z 360..520)
  // -------------------------------------------------------------------------
  registerZoneBuilder('big_crack', (ctx, scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Surfaces first: the bridge deck across the crack, then the paths —
    // in from the SE arterial corner (~356, 364), down the east rim to the
    // overlook and the bridge, and out the south edge toward the Stampede
    // Lands at (290, 520).
    kitBridgePlank(ctx, 288, 440, 25, true)
    kitBridgePlank(ctx, 288, 441, 25, true)
    kitPath(ctx, [[354, 366], [340, 388], [330, 406], [320, 416]])
    kitPath(ctx, [[320, 418], [318, 430], [315, 440]], 1.1)
    kitPath(ctx, [[287, 442], [292, 468], [288, 494], [290, 518]])

    streamGroundPass(ctx, zone)

    // THE CRACK ITSELF — a wobbling chasm straight down the zone. The rim
    // is built up in red rock, the floor is far-below dark, and every cell
    // of it is permanently blocked except the bridge row.
    const RED = [0xa8663a, 0x9c5d34, 0xb57244] as const
    for (let iz = 368; iz < 514; iz++) {
      const cx = 300 + Math.round(Math.sin(iz * 0.09) * 3)
      for (let ix = cx - 5; ix <= cx + 5; ix++) {
        if (iz === 440 || iz === 441) continue // Granny's bridge crosses here
        grid.block(ix, iz)
      }
      batches.misc.add(cx - 5, -0.5, iz, 11, 0.2, 1, GLASS_DARK) // the abyss (budget edition)
      if (iz % 2 === 0) {
        batches.stone.add(cx - 6, 0, iz, 1, 0.8 + rng.range(0, 1.4), 2, rng.pick(RED)) // west rim
        batches.stone.add(cx + 5, 0, iz, 1, 0.8 + rng.range(0, 1.4), 2, rng.pick(RED)) // east rim
      }
    }

    // LANDMARK 1 — "The Heckler's Overlook": a plank platform on the east
    // rim where you shout your best material into the crack and the echo
    // workshops it back, meaner. Lantern lit for open-mic night.
    // (1 ember use + the zone's 1 lantern)
    const vx = 309
    const vz = 414
    for (let dx = 0; dx < 6; dx++) {
      for (let dz = 0; dz < 5; dz++) {
        batches.wood.add(vx - 3 + dx, 0.05, vz + dz, 1, 0.18, 1, rng.pick(WOOD)) // deck, half overhanging
      }
    }
    kitFenceRun(ctx, vx + 2, vz - 1, 6, false) // rail on the solid side
    kitFenceRun(ctx, vx - 2, vz - 1, 5, true) // north rail
    kitLantern(ctx, scene, vx + 2, vz + 5)
    kitCampfire(ctx, vx + 6, vz + 2)
    signpost(ctx, vx + 4, vz - 2) // "THE ECHO IS NOT SORRY"

    // LANDMARK 2 — "Granny Splinters' Rope Bridge": two planks wide, one
    // handrail short, zero inspections passed. The gateposts hold a sign
    // limiting crossings to MAX 1 (ONE) regret per customer.
    batches.wood.add(312.3, 0, 439.2, 0.4, 2.6, 0.4, WOOD_DARK) // east gateposts
    batches.wood.add(312.3, 0, 442.4, 0.4, 2.6, 0.4, WOOD_DARK)
    batches.wood.add(288.3, 0, 439.2, 0.4, 2.6, 0.4, WOOD_DARK) // west gateposts
    batches.wood.add(288.3, 0, 442.4, 0.4, 2.6, 0.4, WOOD_DARK)
    batches.wood.add(288.5, 1.9, 439.3, 24, 0.14, 0.14, WOOD_DARK) // the rope (north, taut)
    batches.wood.add(288.5, 1.5, 442.5, 11, 0.14, 0.14, WOOD_DARK) // the rope (south, half gone)
    signpost(ctx, 314, 443)

    const clears: Clear[] = [
      { x: vx, z: vz + 2, r: 9 },
      { x: 300, z: 440, r: 6 }
    ]
    cluster(ctx, vx + 5, vz + 4, 13, 8, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 244, 364, 356, 516, 36, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(3)) as 1 | 2 | 3))
    scatter(ctx, 244, 364, 356, 516, 16, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, 244, 364, 356, 516, 14, used, clears, (x, z) => kitCactus(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // THE GLASS FURNACE (desert 72-88, x -80..80, z 520..720)
  // -------------------------------------------------------------------------
  registerZoneBuilder('glass_furnace', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Path: spur east off the S arterial (which passes ~(-2, 600)) to the
    // Vanity Flats, then on to the big fulgurite.
    kitPath(ctx, [[0, 602], [14, 606], [26, 602]], 1.1)
    kitPath(ctx, [[34, 600], [44, 622], [50, 636]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Vanity Flats": a half-ring of storm-glass mirrors
    // around a pedestal. The desert checks itself out here; the sign says
    // "NO EYE CONTACT" and means it. Mirrors polished nightly by the wind.
    const vx = 34
    const vz = 598
    batches.stone.add(vx - 1, 0, vz - 1, 3, 0.7, 3, rng.pick(STONE)) // the pedestal
    batches.misc.add(vx - 0.4, 0.7, vz - 0.4, 1.8, 0.25, 1.8, rng.pick(ICE)) // its mirror top
    grid.blockRect(vx - 1, vz - 1, 3, 3)
    for (let i = 0; i < 7; i++) {
      const a = Math.PI * (0.15 + (i / 7) * 1.2)
      const mx = Math.round(vx + Math.cos(a) * 8)
      const mz = Math.round(vz - Math.sin(a) * 7)
      const h = 2 + rng.range(0, 1.6)
      batches.misc.add(mx + 0.1, 0, mz + 0.3, 0.9, h, 0.35, rng.pick(ICE)) // tall mirror
      batches.stone.add(mx, 0, mz + 0.2, 1.1, 0.35, 0.6, rng.pick(STONE)) // its foot
      grid.block(mx, mz)
    }
    signpost(ctx, vx - 4, vz + 4)

    // LANDMARK 2 — "The Masterpiece": where the big bolt hit. A branching
    // fulgurite the size of a chapel, still warm, still smug about it. The
    // glow in its heart hasn't gone out since the storm. (2 ember uses)
    const fx = 52
    const fz = 642
    batches.misc.add(fx - 3, 0, fz - 3, 7, 0.5, 7, 0xc9b183) // fused sand apron
    batches.misc.add(fx - 1, 0.5, fz - 1, 2.6, 4.5, 2.6, rng.pick(ICE)) // trunk
    batches.misc.add(fx - 0.4, 5, fz - 0.4, 1.5, 3.4, 1.5, rng.pick(ICE))
    batches.misc.add(fx, 8.4, fz, 0.8, 2.2, 0.8, rng.pick(ICE)) // tip
    batches.misc.add(fx - 2.6, 3.4, fz + 0.2, 1.8, 0.7, 0.7, rng.pick(ICE)) // west branch
    batches.misc.add(fx - 3.2, 4.1, fz + 0.3, 0.6, 1.8, 0.6, rng.pick(ICE))
    batches.misc.add(fx + 1.5, 4.6, fz - 0.2, 1.9, 0.7, 0.7, rng.pick(ICE)) // east branch
    batches.misc.add(fx + 2.8, 5.3, fz - 0.1, 0.6, 1.4, 0.6, rng.pick(ICE))
    batches.window.add(fx - 0.4, 1, fz - 0.4, 1.4, 1.6, 1.4, 0xffd9a0) // the warm heart
    batches.window.add(fx - 0.1, 2.6, fz - 0.1, 0.8, 1, 0.8, 0xffd9a0)
    grid.blockRect(fx - 3, fz - 3, 7, 7)

    const clears: Clear[] = [
      { x: vx, z: vz, r: 11 },
      { x: fx, z: fz, r: 8 }
    ]
    cluster(ctx, fx, fz, 15, 10, used, clears, (x, z) => mirrorShard(ctx, x, z))
    scatter(ctx, -76, 524, 76, 716, 30, used, clears, (x, z) => mirrorShard(ctx, x, z))
    scatter(ctx, -76, 524, 76, 716, 16, used, clears, (x, z) => kitCactus(ctx, x, z))
    scatter(ctx, -76, 524, 76, 716, 12, used, clears, (x, z) => kitRock(ctx, x, z, 1))
    scatter(ctx, -76, 524, 76, 716, 8, used, clears, (x, z) => kitBone(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // PHARAOH'S FOLLY (ruins 70-86, x 80..240, z 520..720)
  // -------------------------------------------------------------------------
  registerZoneBuilder('pharaohs_folly', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Path: in from the west edge at (80, 610) — the Glass Furnace spur
    // points this way — up the old processional to the tomb mouth.
    kitPath(ctx, [[80, 610], [100, 606], [118, 610], [134, 608]])
    kitPath(ctx, [[150, 612], [160, 626], [166, 638]], 1.1) // side trip to the sphinx

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Grand Entrance (Do Not Use)": a half-buried step
    // pyramid, doorway yawning, gold still glittering inside. The exit
    // signage was budgeted but never installed; neither were the exits.
    const px = 146
    const pz = 596
    batches.stone.add(px - 9, 0, pz - 7, 19, 2.6, 15, rng.pick(SANDSTONE)) // buried base tier
    batches.stone.add(px - 6.5, 2.6, pz - 5, 14, 2.4, 11, rng.pick(SANDSTONE))
    batches.stone.add(px - 4, 5, pz - 3.2, 9, 2.2, 7.4, rng.pick(SANDSTONE))
    batches.stone.add(px - 1.8, 7.2, pz - 1.6, 4.6, 1.9, 4.2, rng.pick(SANDSTONE))
    batches.stone.add(px - 0.4, 9.1, pz - 0.4, 1.8, 1.2, 1.8, GOLD) // the capstone they DID pay for
    const dz = pz + 8 // south face doorway
    batches.misc.add(px - 1.6, 0, dz - 0.9, 3.2, 3, 1, GLASS_DARK) // the dark mouth
    batches.stone.add(px - 2.3, 0, dz - 0.6, 0.7, 3.6, 0.9, rng.pick(RUIN_STONE)) // jambs
    batches.stone.add(px + 1.6, 0, dz - 0.6, 0.7, 3.6, 0.9, rng.pick(RUIN_STONE))
    batches.stone.add(px - 2.3, 3.6, dz - 0.65, 4.6, 0.8, 1, rng.pick(RUIN_STONE)) // lintel
    batches.window.add(px - 0.7, 0.2, dz - 0.5, 0.6, 0.5, 0.5, GOLD) // treasure, glinting
    batches.window.add(px + 0.2, 0.2, dz - 0.45, 0.45, 0.7, 0.45, GOLD) // (2 ember uses)
    grid.blockRect(px - 9, pz - 7, 19, 15)
    kitStatue(ctx, px - 14, dz - 3) // flanking colossi, one per budget cut
    kitStatue(ctx, px + 11, dz - 3)
    // processional colonnade down to the path
    for (let i = 0; i < 3; i++) {
      kitRuinPillar(ctx, px - 5, dz + 3 + i * 4)
      kitRuinPillar(ctx, px + 4, dz + 3 + i * 4)
    }
    kitBone(ctx, px - 3, dz + 6) // a looter who found the entrance. only the entrance.
    kitBone(ctx, px + 6, dz + 10)

    // LANDMARK 2 — "The Sphinx of Awkward Questions": nose long gone (it's
    // right there on the ground, nobody will reattach it), riddles downgraded
    // to small talk: 'so... seen any exits around here?'
    const sx = 172
    const sz = 646
    batches.stone.add(sx, 0, sz, 9, 2.6, 4.2, rng.pick(SANDSTONE)) // body
    batches.stone.add(sx + 7.4, 0, sz - 0.6, 2.4, 1.1, 5.4, rng.pick(SANDSTONE)) // forepaws
    batches.stone.add(sx + 9.4, 0.2, sz + 0.2, 1.2, 0.8, 1.4, rng.pick(SANDSTONE)) // paw tips
    batches.stone.add(sx + 9.4, 0.2, sz + 2.6, 1.2, 0.8, 1.4, rng.pick(SANDSTONE))
    batches.stone.add(sx + 6.6, 2.6, sz + 0.6, 2.8, 2.8, 3, rng.pick(SANDSTONE)) // head
    batches.roof.add(sx + 6.2, 4.6, sz + 0.2, 3.6, 0.9, 3.8, GOLD) // headdress band
    batches.misc.add(sx + 7.6, 3.2, sz + 1.3, 0.5, 0.4, 0.5, GLASS_DARK) // nose socket
    batches.misc.add(sx + 11.5, 0, sz + 1.6, 0.9, 0.7, 0.9, rng.pick(SANDSTONE)) // THE NOSE
    grid.blockRect(sx - 1, sz - 1, 13, 7)
    signpost(ctx, sx + 12, sz + 4) // "DO NOT DISCUSS THE NOSE"

    const clears: Clear[] = [
      { x: px, z: pz + 4, r: 17 },
      { x: sx + 5, z: sz + 2, r: 9 }
    ]
    cluster(ctx, px, dz + 8, 20, 10, used, clears, (x, z) => kitRuinPillar(ctx, x, z))
    scatter(ctx, 84, 524, 236, 716, 24, used, clears, (x, z) => kitRuinPillar(ctx, x, z))
    scatter(ctx, 84, 524, 236, 716, 16, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 84, 524, 236, 716, 12, used, clears, (x, z) => kitBone(ctx, x, z))
    scatter(ctx, 84, 524, 236, 716, 10, used, clears, (x, z) => kitCactus(ctx, x, z))
  })

  // -------------------------------------------------------------------------
  // THE STAMPEDE LANDS (savanna 58-72, x 240..360, z 520..720)
  // -------------------------------------------------------------------------
  registerZoneBuilder('stampede_lands', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Path: continues the Big Crack's south spur from (290, 520) down to
    // the official emergency rock, then on past the flattened camp.
    kitPath(ctx, [[290, 522], [296, 544], [304, 562], [308, 574]])
    kitPath(ctx, [[310, 580], [320, 600], [326, 614]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "Climb Something": the region's entire safety protocol,
    // rendered in stone. A proud kopje with a bolted-on ladder, a totem up
    // top you can cling to, and a sign reading "IN CASE OF THUNDER: UP".
    const kx = 306
    const kz = 582
    batches.stone.add(kx - 4, 0, kz - 3, 9, 2.4, 7, rng.pick(STONE)) // base slab
    batches.stone.add(kx - 2.5, 2.4, kz - 2, 6.5, 2.4, 5, rng.pick(STONE))
    batches.stone.add(kx - 1, 4.8, kz - 1, 4, 2.2, 3.4, rng.pick(STONE)) // the podium
    batches.stone.add(kx + 4.6, 0, kz + 2.8, 2.2, 1.3, 2, rng.pick(STONE)) // tumbled shoulder
    grid.blockRect(kx - 4, kz - 3, 9, 7)
    grid.blockRect(kx + 4, kz + 2, 3, 3)
    for (let i = 0; i < 7; i++) {
      batches.wood.add(kx + 5.1, i * 0.95, kz - 0.2 - i * 0.28, 0.25, 1, 0.8, WOOD_DARK) // the ladder
    }
    kitTotem(ctx, kx, kz) // the thing you cling to
    signpost(ctx, kx + 7, kz + 1)
    vulture(ctx, kx - 3.6, 2.4, kz - 2.6) // early for the next stampede

    // LANDMARK 2 — "The Flattening": last season's safari camp, now two
    // dimensions. Flat tent, flat crates, flat kettle — and one upright
    // memorial for Gary, who heard the thunder and chose to finish his tea.
    // (1 ember use)
    const cx = 330
    const cz = 620
    batches.plaster.add(cx - 2, 0.02, cz - 1.5, 4, 0.12, 3, 0xc46a4e) // the tent, ex-dome
    batches.wood.add(cx - 2.4, 0, cz - 1.8, 0.3, 0.5, 0.3, WOOD_DARK) // one defiant pole
    batches.wood.add(cx + 2.4, 0.02, cz + 1.8, 1.1, 0.14, 1.1, rng.pick(WOOD)) // crate, flat-pack now
    batches.wood.add(cx + 3.7, 0.02, cz + 0.8, 0.9, 0.12, 0.9, rng.pick(WOOD))
    batches.misc.add(cx - 3.5, 0.02, cz + 2.2, 0.7, 0.14, 0.7, 0x8e949e) // the kettle
    grid.blockRect(cx - 3, cz - 2, 7, 5)
    kitGrave(ctx, cx + 1, cz + 4) // Gary
    batches.misc.add(cx + 1.2, 0.05, cz + 5.1, 0.3, 0.25, 0.3, rng.pick(FLOWER)) // flowers for Gary
    batches.misc.add(cx + 1.7, 0.05, cz + 4.9, 0.25, 0.3, 0.25, rng.pick(FLOWER))
    kitCampfire(ctx, cx - 6, cz + 2) // survivors' brew-up (lookout posted this time)
    kitFenceRun(ctx, cx - 4, cz - 4, 5, true) // the fence that slowed nothing down

    const clears: Clear[] = [
      { x: kx, z: kz, r: 11 },
      { x: cx, z: cz, r: 9 }
    ]
    cluster(ctx, kx, kz, 17, 9, used, clears, (x, z) => acacia(ctx, x, z))
    cluster(ctx, cx, cz, 14, 8, used, clears, (x, z) => grassTuft(ctx, x, z))
    scatter(ctx, 244, 524, 356, 716, 26, used, clears, (x, z) => acacia(ctx, x, z))
    scatter(ctx, 244, 524, 356, 716, 30, used, clears, (x, z) => grassTuft(ctx, x, z))
    scatter(ctx, 244, 524, 356, 716, 14, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, 244, 524, 356, 716, 10, used, clears, (x, z) => kitBone(ctx, x, z))
    scatter(ctx, 244, 524, 356, 716, 6, used, clears, (x, z) => kitTree(ctx, x, z, { leaves: ACACIA_LEAF, big: true }))
  })
}
