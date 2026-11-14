/**
 * src/world/zones/batch10.ts — BATCH 10: EAST MIDDLE + SOUTHEAST SHOULDER
 * (cherry highlands down through savanna into the canyon rim and the
 * southeastern cove): blushing_orchard, elderbark, lions_share,
 * gorge_yourself, prideful_plains, sirens_karaoke_cove.
 *
 * Same hand-built voxel vocabulary as the heart: VoxelBatch Lambert boxes,
 * no textures, glow ONLY via the shared flickering window batch (ember budget
 * <=2 per zone, honored below). Builders are deterministic (ctx.rng is seeded
 * from the zone id by the stream) and idempotent re collision. Surface stamps
 * (paths / plazas) happen BEFORE streamGroundPass; props after.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import { S_COBBLE, S_GRASS, setSurface, surfaceAt, type Ctx } from '../layout'
import {
  BONE_WHITE,
  CANYON_GROUND,
  CHERRY_LEAF,
  CROP,
  DEAD_WOOD,
  FLOWER,
  FOREST_MOSS,
  LAGOON_WATER,
  LEAF,
  PLASTER,
  RUIN_STONE,
  SAND,
  STONE,
  STRAW,
  SWAMP_MURK,
  WINDOW_GLOW,
  WOOD,
  WOOD_DARK,
  isLand,
  kitBone,
  kitCactus,
  kitCampfire,
  kitCherryTree,
  kitDeadTree,
  kitFenceRun,
  kitHut,
  kitLantern,
  kitPalm,
  kitPath,
  kitRock,
  kitStatue,
  kitTotem,
  kitTree
} from '../kit'

// ---------------------------------------------------------------------------
// Local helpers (deterministic — all randomness through ctx.rng)
// ---------------------------------------------------------------------------

/** Scatter `n` attempts of `place` in the rect; skips sea, roads, blocked. */
function scatter(
  ctx: Ctx,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  n: number,
  place: (ix: number, iz: number) => void
): void {
  const { rng, grid } = ctx
  for (let i = 0; i < n; i++) {
    const ix = Math.floor(rng.range(x0, x1))
    const iz = Math.floor(rng.range(z0, z1))
    if (!isLand(ix + 0.5, iz + 0.5)) continue
    if (surfaceAt(ctx, ix, iz) !== S_GRASS) continue
    if (grid.isBlocked(ix + 0.5, iz + 0.5)) continue
    place(ix, iz)
  }
}

/** Cozy-dense cluster of `n` attempts around (cx, cz) within radius r. */
function cluster(
  ctx: Ctx,
  cx: number,
  cz: number,
  r: number,
  n: number,
  place: (ix: number, iz: number) => void
): void {
  scatter(ctx, cx - r, cz - r, cx + r, cz + r, n, place)
}

/** Cobble plaza disc — keeps waystone anchors clear (scatter skips cobble). */
function plaza(ctx: Ctx, cx: number, cz: number): void {
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      if (dx * dx + dz * dz <= 20) setSurface(ctx, cx + dx, cz + dz, S_COBBLE)
    }
  }
}

/** Stone-rimmed still pool. Blocks rim + water cells (no drowning on duty). */
function pool(
  ctx: Ctx,
  x0: number,
  z0: number,
  w: number,
  d: number,
  rim: readonly number[],
  water: number
): void {
  const { rng, batches, grid } = ctx
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) {
      const edge = ix === x0 || ix === x0 + w - 1 || iz === z0 || iz === z0 + d - 1
      if (edge) batches.stone.add(ix, 0, iz, 1, 0.5, 1, rng.pick(rim))
      else batches.misc.add(ix, 0, iz, 1, 0.28, 1, water)
      grid.block(ix, iz)
    }
  }
}

/** Flat-top acacia — tall thin trunk, two stacked canopy slabs. Blocks. */
function kitAcacia(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 3 + rng.int(2)
  batches.wood.add(ix + 0.28, 0, iz + 0.28, 0.44, h, 0.44, rng.pick(WOOD))
  batches.wood.add(ix + 0.1 + rng.range(-0.3, 0.3), h - 1, iz + 0.1, 0.4, 1, 0.4, rng.pick(WOOD))
  batches.leaf.add(ix - 2, h, iz - 2, 5, 0.5, 5, rng.pick(LEAF))
  batches.leaf.add(ix - 1, h + 0.5, iz - 1, 3, 0.4, 3, rng.pick(LEAF))
  grid.block(ix, iz)
}

/** Dry savanna grass tuft — tiny paired blades, no collision. */
function tuft(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  const c = rng.next() < 0.5 ? rng.pick(CROP) : 0xc2b36a
  batches.leaf.add(ix + 0.2, 0, iz + 0.3, 0.26, 0.5 + rng.range(0, 0.3), 0.26, c)
  batches.leaf.add(ix + 0.55, 0, iz + 0.45, 0.22, 0.35, 0.22, c)
}

/** Layered red mesa butte — shrinking strata tiers with pale sand bands. */
function kitMesa(ctx: Ctx, x0: number, z0: number, w: number, d: number, tiers: number): void {
  const { rng, batches, grid } = ctx
  for (let t = 0; t < tiers; t++) {
    const c = t % 2 === 1 ? rng.pick(SAND) : rng.pick(CANYON_GROUND)
    batches.stone.add(x0 + t, t * 1.1, z0 + t, w - t * 2, 1.1, d - t * 2, c)
  }
  grid.blockRect(x0, z0, w, d)
}

/** Balanced hoodoo spire — stacked shrinking boxes + a too-big cap. Blocks. */
function kitHoodoo(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 1 + rng.range(0, 0.8)
  batches.stone.add(ix, 0, iz, 1.1, h, 1.1, rng.pick(CANYON_GROUND))
  batches.stone.add(ix + 0.18, h, iz + 0.18, 0.74, h * 0.8, 0.74, rng.pick(SAND))
  batches.stone.add(ix + 0.3, h * 1.8, iz + 0.3, 0.5, h * 0.7, 0.5, rng.pick(CANYON_GROUND))
  batches.stone.add(ix - 0.05, h * 2.5, iz - 0.05, 1.2, 0.45, 1.2, rng.pick(CANYON_GROUND)) // smug cap
  grid.block(ix, iz)
}

// ---------------------------------------------------------------------------
// blushing_orchard — The Blushing Orchard (cherry, 45-58, waystone 540,-160)
// ---------------------------------------------------------------------------

function buildBlushingOrchard(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // path: up from the south edge (E arterial side) to the waystone plaza,
  // then on west to the altar and east to Grandma
  kitPath(ctx, [[536, -84], [538, -104], [534, -124], [540, -144], [540, -158]])
  kitPath(ctx, [[540, -162], [536, -176], [532, -186], [529, -192]])
  kitPath(ctx, [[544, -164], [552, -176], [558, -186]])
  plaza(ctx, 540, -160) // waystone anchor stays clear + reachable
  streamGroundPass(ctx, zone)

  // LANDMARK: "Grandma Blossom" — the oldest cherry tree in the realm. She
  // remembers when all this was meadow, and she WILL tell you about it.
  {
    const cx = 560
    const cz = -190
    batches.wood.add(cx - 1.5, 0, cz - 1.5, 3, 8, 3, WOOD_DARK) // great trunk
    batches.wood.add(cx - 2.3, 0, cz - 0.6, 1, 1.4, 1.4, rng.pick(WOOD)) // root knuckles
    batches.wood.add(cx + 1.4, 0, cz - 2.2, 1.4, 1.1, 1, rng.pick(WOOD))
    batches.wood.add(cx - 0.6, 0, cz + 1.4, 1.2, 1.6, 1, rng.pick(WOOD))
    batches.leaf.add(cx - 5, 7, cz - 5, 10, 1, 10, rng.pick(CHERRY_LEAF)) // canopy decks
    batches.leaf.add(cx - 6, 8, cz - 6, 12, 1.1, 12, rng.pick(CHERRY_LEAF))
    batches.leaf.add(cx - 4.5, 9.1, cz - 4.5, 9, 1, 9, rng.pick(CHERRY_LEAF))
    batches.leaf.add(cx - 3, 10.1, cz - 3, 6, 1, 6, rng.pick(CHERRY_LEAF))
    batches.leaf.add(cx - 1.5, 11.1, cz - 1.5, 3, 0.9, 3, rng.pick(CHERRY_LEAF))
    for (let i = 0; i < 26; i++) {
      // dappled bloom lumps around the canopy rim
      const a = rng.range(0, Math.PI * 2)
      const r = 5 + rng.range(0, 1.8)
      batches.leaf.voxel(Math.round(cx + Math.cos(a) * r), 7 + rng.int(3), Math.round(cz + Math.sin(a) * r), rng.pick(CHERRY_LEAF))
    }
    for (let i = 0; i < 22; i++) {
      // a permanent petal carpet
      batches.misc.add(cx + rng.range(-8, 8), 0, cz + rng.range(-8, 8), 0.24, 0.08, 0.24, rng.pick(CHERRY_LEAF))
    }
    grid.blockRect(cx - 2, cz - 2, 4, 4)
  }

  // LANDMARK: "The Altar of Cold Feet" — a fully decorated wedding nobody
  // attended. The cake is still out there. Nature is healing; the groom isn't.
  {
    batches.wood.add(526, 0, -198, 0.5, 3, 0.5, WOOD_DARK) // arch posts
    batches.wood.add(531, 0, -198, 0.5, 3, 0.5, WOOD_DARK)
    batches.leaf.add(525.6, 3, -198.4, 6.2, 0.8, 1.3, rng.pick(CHERRY_LEAF)) // bloom arch
    batches.leaf.add(527, 3.8, -198.2, 3.6, 0.5, 0.9, rng.pick(CHERRY_LEAF))
    grid.block(526, -198)
    grid.block(531, -198)
    for (let row = 0; row < 3; row++) {
      // the pews, seating for everyone who didn't come
      const pz = -192 + row * 3
      batches.wood.add(524, 0.2, pz, 3.4, 0.45, 0.9, rng.pick(WOOD))
      batches.wood.add(530.5, 0.2, pz, 3.4, 0.45, 0.9, rng.pick(WOOD))
      grid.blockRect(524, pz, 4, 1)
      grid.blockRect(530, pz, 4, 1)
    }
    batches.plaster.add(535, 0, -196, 1.3, 0.9, 1.3, rng.pick(PLASTER)) // the cake,
    batches.plaster.add(535.2, 0.9, -195.8, 0.9, 0.7, 0.9, rng.pick(PLASTER)) // three tiers,
    batches.plaster.add(535.9, 0.2, -194.7, 0.7, 0.5, 0.7, rng.pick(PLASTER)) // one fallen
    batches.misc.add(535.4, 1.6, -195.6, 0.3, 0.3, 0.3, FLOWER[0]!) // topper, alone
    grid.blockRect(535, -196, 2, 2)
  }

  // the orchard proper: polite planted ranks west of the waystone
  for (let gx = 490; gx <= 522; gx += 5) {
    for (let gz = -148; gz <= -98; gz += 6) {
      if (rng.next() < 0.72) {
        const jx = gx + rng.int(2)
        const jz = gz + rng.int(2)
        if (!ctx.grid.isBlocked(jx + 0.5, jz + 0.5) && surfaceAt(ctx, jx, jz) === S_GRASS) {
          kitCherryTree(ctx, jx, jz)
        }
      }
    }
  }
  // wilder blossom drifts around the landmarks + the rest of the hills
  cluster(ctx, 560, -190, 16, 10, (x, z) => kitCherryTree(ctx, x, z))
  cluster(ctx, 528, -194, 12, 6, (x, z) => kitCherryTree(ctx, x, z))
  scatter(ctx, 484, -236, 596, -84, 34, (x, z) =>
    rng.next() < 0.8 ? kitCherryTree(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
}

// ---------------------------------------------------------------------------
// elderbark — The Elderbark (forest, 47-60)
// ---------------------------------------------------------------------------

function buildElderbark(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // spur north off the E arterial (which runs straight through this zone)
  kitPath(ctx, [[520, 6], [526, -10], [534, -24], [540, -36]])
  kitPath(ctx, [[516, 10], [512, 20], [510, 28]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Elder Himself" — the tree that stopped pretending to be
  // asleep. Has eyes, has opinions, has a door he insists is a mouth.
  {
    const ex = 540
    const ez = -46
    batches.wood.add(ex - 2, 0, ez - 2, 4, 9, 4, WOOD_DARK) // great bole
    batches.wood.add(ex - 3, 0, ez - 1, 1.2, 2.4, 2, rng.pick(WOOD)) // buttress roots
    batches.wood.add(ex + 1.8, 0, ez - 1.2, 1.2, 2, 2.2, rng.pick(WOOD))
    batches.wood.add(ex - 1.2, 0, ez + 1.8, 2.2, 1.7, 1.2, rng.pick(WOOD))
    batches.wood.add(ex - 1, 0, ez - 3, 1.8, 2.8, 1.1, rng.pick(WOOD))
    batches.wood.add(ex - 2.6, 4.5, ez - 0.4, 1, 0.8, 0.9, rng.pick(DEAD_WOOD)) // brow knot
    batches.window.voxel(ex - 2, 5, ez - 1, WINDOW_GLOW) // the eyes (awake, judging)
    batches.window.voxel(ex - 2, 5, ez + 0.4, WINDOW_GLOW)
    batches.wood.add(ex - 1.4, 0, ez + 1.95, 1.6, 2.2, 0.3, 0x2d1f10) // the "mouth" door
    batches.leaf.add(ex - 6, 8, ez - 6, 12, 1.2, 12, rng.pick(LEAF)) // canopy decks
    batches.leaf.add(ex - 7, 9.2, ez - 7, 14, 1.2, 14, rng.pick(LEAF))
    batches.leaf.add(ex - 5, 10.4, ez - 5, 10, 1.1, 10, FOREST_MOSS)
    batches.leaf.add(ex - 3, 11.5, ez - 3, 6, 1, 6, rng.pick(LEAF))
    batches.leaf.add(ex - 1.5, 12.5, ez - 1.5, 3, 0.9, 3, rng.pick(LEAF))
    for (let i = 0; i < 20; i++) {
      const a = rng.range(0, Math.PI * 2)
      const r = 6 + rng.range(0, 2)
      batches.leaf.voxel(Math.round(ex + Math.cos(a) * r), 8 + rng.int(4), Math.round(ez + Math.sin(a) * r), rng.pick(LEAF))
    }
    grid.blockRect(ex - 3, ez - 3, 6, 6)
  }

  // LANDMARK: "The Moot Ring" — where the forest holds its meetings. Minutes
  // are kept in rings; motions pass at one per century.
  {
    const mx = 510
    const mz = 32
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const sx = Math.round(mx + Math.cos(a) * 7)
      const sz = Math.round(mz + Math.sin(a) * 7)
      batches.stone.add(sx, 0, sz, 1, 1.6 + rng.range(0, 1.1), 1, rng.pick(STONE))
      batches.leaf.add(sx - 0.1, 0, sz - 0.1, 1.2, 0.5, 1.2, FOREST_MOSS) // mossy socks
      grid.block(sx, sz)
    }
    batches.stone.add(mx - 1, 0, mz - 1, 2, 0.7, 2, rng.pick(RUIN_STONE)) // the speaker's stone
    grid.blockRect(mx - 1, mz - 1, 2, 2)
    for (let i = 0; i < 4; i++) {
      // stump seating for saplings and other juniors
      const sx = Math.round(mx + rng.range(-4, 4))
      const sz = Math.round(mz + rng.range(-4, 4))
      if (!grid.isBlocked(sx + 0.5, sz + 0.5)) {
        batches.wood.add(sx + 0.2, 0, sz + 0.2, 0.7, 0.5, 0.7, rng.pick(WOOD))
        grid.block(sx, sz)
      }
    }
  }

  // old growth: huge trees crowd the Elder, thin out toward the zone edges
  cluster(ctx, 540, -46, 22, 26, (x, z) => kitTree(ctx, x, z, { big: true }))
  cluster(ctx, 510, 32, 16, 12, (x, z) => kitTree(ctx, x, z, { big: true }))
  scatter(ctx, 484, -76, 596, 76, 56, (x, z) => {
    if (z > -12 && z < 12) return // keep the arterial corridor breathable
    if (rng.next() < 0.78) kitTree(ctx, x, z, rng.next() < 0.5 ? { big: true } : {})
    else kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1)
  })
  scatter(ctx, 484, -76, 596, 76, 24, (x, z) => {
    batches.leaf.add(x + 0.2, 0, z + 0.2, 0.7, 0.26, 0.7, FOREST_MOSS) // moss shags
  })
}

// ---------------------------------------------------------------------------
// lions_share — The Lion's Share (savanna, 46-60)
// ---------------------------------------------------------------------------

function buildLionsShare(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // spur south off the E arterial (north edge) to Gloat Rock, then the hole
  kitPath(ctx, [[520, 84], [516, 100], [520, 118], [526, 134]])
  kitPath(ctx, [[532, 146], [542, 160], [552, 176], [559, 188]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "Gloat Rock" — the tiered sun-rock every big cat poses on.
  // The ledge exists purely so someone can look down on you from it.
  {
    const gx = 526
    const gz = 138
    batches.stone.add(gx, 0, gz, 10, 1.2, 8, rng.pick(STONE))
    batches.stone.add(gx + 1, 1.2, gz + 1, 8, 1.2, 6, rng.pick(CANYON_GROUND))
    batches.stone.add(gx + 2.4, 2.4, gz + 2, 5.6, 1.2, 4, rng.pick(STONE))
    batches.stone.add(gx + 5.4, 3.6, gz + 2.8, 4.6, 0.8, 2.4, rng.pick(CANYON_GROUND)) // the gloating ledge
    grid.blockRect(gx, gz, 10, 8)
    cluster(ctx, gx + 5, gz + 12, 8, 4, (x, z) => kitBone(ctx, x, z)) // leftovers, unshared
  }

  // LANDMARK: "The Watering Hole of Uneasy Truces" — everybody drinks,
  // nobody blinks, and the mud remembers every grudge.
  {
    pool(ctx, 556, 190, 9, 7, STONE, SWAMP_MURK)
    batches.misc.add(557, 0, 198, 7, 0.14, 2.2, 0x6b4e2e) // trampled mud apron
    cluster(ctx, 560, 193, 11, 12, (x, z) => kitAcacia(ctx, x, z))
    cluster(ctx, 560, 200, 9, 5, (x, z) => kitBone(ctx, x, z))
  }

  // golden grass to the horizon, every blade pre-claimed
  scatter(ctx, 484, 84, 596, 236, 44, (x, z) => tuft(ctx, x, z))
  scatter(ctx, 484, 88, 596, 236, 26, (x, z) =>
    rng.next() < 0.7 ? kitAcacia(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
  scatter(ctx, 490, 96, 590, 232, 6, (x, z) => kitDeadTree(ctx, x, z))
}

// ---------------------------------------------------------------------------
// gorge_yourself — Gorge Yourself (canyon, 35-50, waystone 420,300)
// ---------------------------------------------------------------------------

function buildGorgeYourself(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // in from the SE arterial at the SW corner, to the waystone, to the rim
  kitPath(ctx, [[364, 352], [378, 340], [394, 326], [408, 312], [420, 302]])
  kitPath(ctx, [[424, 298], [434, 290], [442, 284]])
  plaza(ctx, 420, 300) // waystone anchor stays clear + reachable
  streamGroundPass(ctx, zone)

  // LANDMARK: "The All-You-Can-Eat Overlook" — a rickety viewing deck and
  // snack shack on the rim. The gorge compliments the chef; you're the dish.
  {
    const dx = 444
    const dz = 278
    batches.wood.add(dx, 0.5, dz, 6, 0.4, 5, rng.pick(WOOD)) // the deck
    batches.wood.add(dx + 0.2, 0, dz + 0.2, 0.5, 0.5, 0.5, WOOD_DARK) // stubby piles
    batches.wood.add(dx + 5.3, 0, dz + 0.2, 0.5, 0.5, 0.5, WOOD_DARK)
    batches.wood.add(dx + 0.2, 0, dz + 4.3, 0.5, 0.5, 0.5, WOOD_DARK)
    batches.wood.add(dx + 5.3, 0, dz + 4.3, 0.5, 0.5, 0.5, WOOD_DARK)
    grid.blockRect(dx, dz, 6, 5)
    kitFenceRun(ctx, dx + 6, dz, 5, false) // railing on the drop side
    kitFenceRun(ctx, dx, dz - 1, 6, true)
    // the sign: ALL-YOU-CAN-EAT OVERLOOK (fine print: you are the buffet)
    batches.wood.add(dx - 1.6, 0, dz + 1.8, 0.4, 2.6, 0.4, WOOD_DARK)
    batches.plaster.add(dx - 2.7, 2.6, dz + 1.5, 2.6, 1, 0.25, rng.pick(PLASTER))
    grid.block(Math.floor(dx - 2), Math.floor(dz + 1))
    kitHut(ctx, 450, 268) // the snack shack, menu suspiciously vague
    kitCampfire(ctx, 448, 274) // the grill (ember use 1/2)
  }

  // LANDMARK: "The Red Buffet" — a field of layered mesa buttes, plated and
  // stacked like the world's least edible dessert course.
  kitMesa(ctx, 378, 256, 10, 8, 4)
  kitMesa(ctx, 398, 328, 12, 9, 4)
  kitMesa(ctx, 370, 298, 9, 7, 3)
  kitMesa(ctx, 452, 330, 8, 7, 3)
  cluster(ctx, 390, 262, 14, 8, (x, z) => kitHoodoo(ctx, x, z))

  // rim country scatter: hoodoos, scorched scrub, old lunches
  scatter(ctx, 364, 244, 476, 356, 34, (x, z) => {
    const roll = rng.next()
    if (roll < 0.4) kitHoodoo(ctx, x, z)
    else if (roll < 0.65) kitRock(ctx, x, z, rng.next() < 0.4 ? 2 : 1)
    else if (roll < 0.85) kitDeadTree(ctx, x, z)
    else kitCactus(ctx, x, z)
  })
  scatter(ctx, 370, 250, 470, 350, 8, (x, z) => kitBone(ctx, x, z))
}

// ---------------------------------------------------------------------------
// prideful_plains — Prideful Plains (savanna, 47-61)
// ---------------------------------------------------------------------------

function buildPridefulPlains(ctx: Ctx, scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // in from the SE arterial side (west edge) to the arena, then the monument
  kitPath(ctx, [[484, 348], [498, 338], [512, 326], [524, 316], [530, 310], [534, 307]])
  kitPath(ctx, [[541, 304], [548, 314], [555, 320], [558, 323]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Mane Event" — the strut-off arena. Duels are settled by
  // combat, posture, and whose mane catches the light best at golden hour.
  {
    kitFenceRun(ctx, 528, 296, 14, true) // north rail
    kitFenceRun(ctx, 528, 305, 5, true) // south rails (gap = the grand entrance)
    kitFenceRun(ctx, 537, 305, 5, true)
    kitFenceRun(ctx, 528, 297, 8, false) // west rail
    kitFenceRun(ctx, 541, 297, 8, false) // east rail
    const corners: ReadonlyArray<readonly [number, number]> = [[527, 295], [542, 295], [527, 306], [542, 306]]
    for (const [bx, bz] of corners) {
      batches.wood.add(bx + 0.3, 0, bz + 0.3, 0.4, 3.4, 0.4, WOOD_DARK) // banner poles
      batches.misc.add(bx + 0.7, 2.4, bz + 0.25, 0.9, 1, 0.14, rng.pick(FLOWER))
      grid.block(bx, bz)
    }
    batches.wood.add(532, 0, 291, 5, 0.6, 3, rng.pick(WOOD)) // judges' box
    batches.misc.add(531.6, 2.4, 290.6, 5.8, 0.4, 3.8, STRAW) // with sun awning
    batches.wood.add(532.2, 0.6, 291.2, 0.3, 1.8, 0.3, WOOD_DARK)
    batches.wood.add(536.5, 0.6, 291.2, 0.3, 1.8, 0.3, WOOD_DARK)
    grid.blockRect(532, 291, 5, 3)
    kitLantern(ctx, scene, 539, 308) // the lone lantern (evening strut-offs)
  }

  // LANDMARK: "His Majesty, Probably" — a colossus commissioned by its own
  // subject, approached down a totem avenue of lesser (i.e. all other) kings.
  kitTotem(ctx, 548, 318)
  kitTotem(ctx, 548, 328)
  kitTotem(ctx, 554, 316)
  kitTotem(ctx, 554, 330)
  kitStatue(ctx, 559, 322)
  batches.plaster.add(558.4, 0, 326.4, 2.2, 1.1, 0.3, rng.pick(PLASTER)) // plaque: "DEFINITELY EARNED"
  cluster(ctx, 560, 324, 10, 6, (x, z) => tuft(ctx, x, z))

  // the plains: big manes, bigger egos, golden grass all the way out
  scatter(ctx, 484, 244, 596, 356, 40, (x, z) => tuft(ctx, x, z))
  scatter(ctx, 484, 244, 596, 356, 24, (x, z) =>
    rng.next() < 0.72 ? kitAcacia(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
  scatter(ctx, 490, 250, 590, 350, 5, (x, z) => kitBone(ctx, x, z))
}

// ---------------------------------------------------------------------------
// sirens_karaoke_cove — Siren's Karaoke Cove (lagoon, 52-67)
// ---------------------------------------------------------------------------

function buildSirensKaraokeCove(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // down from the north edge (Shallow End's boardwalk country) to the stage
  kitPath(ctx, [[650, 244], [654, 262], [657, 278], [658, 292]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Clamshell" — the open-air karaoke stage. Tonight's set
  // list: three love ballads, one sea shanty, zero survivors.
  {
    const sx = 648
    const sz = 300
    batches.stone.add(sx, 0, sz, 12, 0.6, 7, rng.pick(RUIN_STONE)) // the stage
    const arcH = [2.6, 4.2, 5.4, 4.2, 2.6] as const
    for (let i = 0; i < 5; i++) {
      // the shell: a rising arc of pearly columns behind the performer
      batches.plaster.add(sx + 0.4 + i * 2.3, 0.6, sz + 5.6, 2.1, arcH[i]!, 1.1, rng.pick(PLASTER))
    }
    batches.plaster.add(sx + 1.6, 6, sz + 5.7, 8.8, 0.7, 1, rng.pick(PLASTER)) // crest
    batches.wood.add(sx + 5.6, 0.6, sz + 1.2, 0.26, 1.5, 0.26, WOOD_DARK) // driftwood mic stand
    batches.misc.add(sx + 5.5, 2.1, sz + 1.1, 0.45, 0.4, 0.45, 0x2d2d33) // the mic (cursed)
    for (let i = 0; i < 5; i++) {
      batches.window.add(sx + 1.2 + i * 2.4, 0.6, sz + 0.2, 0.5, 0.3, 0.5, WINDOW_GLOW) // footlights
    }
    grid.blockRect(sx, sz, 12, 7)
    // the soak pit: front-row seating, three feet of water, zero refunds
    pool(ctx, 645, 288, 10, 7, SAND, LAGOON_WATER)
    kitCampfire(ctx, 652, 318) // after-party bonfire (ember use 1/2)
  }

  // LANDMARK: "The Encore" — a fan's sloop beached mid-standing-ovation.
  // Her crew gave the performance five stars and the ship zero steering.
  {
    const wx = 670
    const wz = 324
    batches.wood.add(wx, 0, wz, 9, 1, 4, rng.pick(DEAD_WOOD)) // hull courses
    batches.wood.add(wx + 0.5, 1, wz + 0.3, 8, 0.9, 3.4, rng.pick(WOOD))
    batches.wood.add(wx + 8.6, 0.3, wz + 1, 1.8, 2, 2, rng.pick(DEAD_WOOD)) // crumpled bow
    batches.wood.add(wx + 3.6, 1.9, wz + 1.8, 0.6, 3, 0.6, WOOD_DARK) // snapped mast
    batches.plaster.add(wx + 2.9, 4.4, wz + 1.7, 2.2, 1.3, 0.24, rng.pick(PLASTER)) // ragged sail
    grid.blockRect(wx, wz, 10, 4)
    // the judges' table — three stone thrones, three verdicts, no appeals
    batches.stone.add(666, 0, 296, 5, 0.9, 1.4, rng.pick(STONE))
    for (let i = 0; i < 3; i++) {
      batches.stone.add(666.3 + i * 1.7, 0, 297.7, 1, 1.5, 1, rng.pick(RUIN_STONE))
      batches.wood.add(666.5 + i * 1.7, 0.9, 295.2, 0.25, 1.6, 0.25, WOOD_DARK) // scorecard posts
      batches.plaster.add(666.1 + i * 1.7, 2.5, 295.1, 1.1, 0.9, 0.18, rng.pick(PLASTER)) // "10" "10" "SHARK"
    }
    grid.blockRect(665, 295, 7, 4)
  }

  // cove fringe: palms packed around the amphitheater, shells on the strand
  cluster(ctx, 654, 306, 17, 16, (x, z) => kitPalm(ctx, x, z))
  scatter(ctx, 604, 244, 688, 356, 24, (x, z) =>
    rng.next() < 0.68 ? kitPalm(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
  scatter(ctx, 610, 250, 688, 352, 14, (x, z) => {
    batches.misc.add(x + 0.3, 0, z + 0.3, 0.3, 0.15, 0.3, rng.pick(BONE_WHITE)) // shells
  })
}

// ---------------------------------------------------------------------------
// Registration — the zones/index barrel calls this once at boot.
// ---------------------------------------------------------------------------

export function registerBatch10(): void {
  registerZoneBuilder('blushing_orchard', buildBlushingOrchard)
  registerZoneBuilder('elderbark', buildElderbark)
  registerZoneBuilder('lions_share', buildLionsShare)
  registerZoneBuilder('gorge_yourself', buildGorgeYourself)
  registerZoneBuilder('prideful_plains', buildPridefulPlains)
  registerZoneBuilder('sirens_karaoke_cove', buildSirensKaraokeCove)
}

// The stream also eager-globs zone batch files; registering at import time
// keeps the zones live even before the barrel wires up.
registerBatch10()
