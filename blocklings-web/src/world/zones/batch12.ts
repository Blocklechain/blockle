/**
 * src/world/zones/batch12.ts — BATCH 12: SOUTH-CENTER-WEST (Ashen's dark
 * doorstep into the dry lands): catacombs_of_moist, gravely_serious,
 * dry_heat, needlepoint_nowhere, sunken_suburbs, shifting_sneaks.
 *
 * Same hand-built voxel vocabulary as the heart: VoxelBatch Lambert boxes,
 * no textures, glow only via the shared flickering window batch. Builders
 * are deterministic (ctx.rng seeded from the zone id by the stream) and
 * idempotent re collision. Surface stamps (paths) land BEFORE
 * streamGroundPass; props after. The SW arterial
 * [-236,236]→[-300,290]→[-360,360]→[-420,430]→[-500,500]→[-570,580] is the
 * spine every connecting spur hangs off.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import { S_COBBLE, S_GRASS, setSurface, surfaceAt, type Ctx } from '../layout'
import {
  BONE_WHITE,
  CACTUS_GREEN,
  DEAD_WOOD,
  DESERT_GROUND,
  LAGOON_WATER,
  RUIN_STONE,
  SAVANNA_GROUND,
  STONE,
  SWAMP_MURK,
  WOOD,
  WOOD_DARK,
  isLand,
  kitBone,
  kitCactus,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitGrave,
  kitLantern,
  kitPath,
  kitRock,
  kitRuinPillar,
  kitStatue
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

/** Flat-topped savanna acacia: tall bare trunk, wide pancake canopy. */
function kitAcacia(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = 3 + rng.int(2)
  batches.wood.add(ix + 0.25, 0, iz + 0.25, 0.5, h, 0.5, rng.pick(DEAD_WOOD))
  // one kinked bough near the top
  batches.wood.add(ix - 0.6, h - 0.8, iz + 0.25, 1, 0.3, 0.4, rng.pick(DEAD_WOOD))
  grid.block(ix, iz)
  const leaf = [0x7a8f3e, 0x6d8136, 0x879c48] as const
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue // round the slab
      batches.leaf.add(ix + dx, h, iz + dz, 1, 0.4, 1, rng.pick(leaf))
    }
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      batches.leaf.add(ix + dx, h + 0.4, iz + dz, 1, 0.35, 1, rng.pick(leaf))
    }
  }
}

/** Half-buried giant ribcage along +X — paired bone pillars with lintels,
 *  skull at the far end. Blocks its cells. */
function kitRibcage(ctx: Ctx, x0: number, z0: number, ribs: number): void {
  const { rng, batches, grid } = ctx
  for (let i = 0; i < ribs; i++) {
    const ix = x0 + i * 2
    const h = 1.5 + Math.sin((i / (ribs - 1)) * Math.PI) * 1.9 + rng.range(0, 0.3)
    const c = rng.pick(BONE_WHITE)
    batches.misc.add(ix, 0, z0, 0.5, h, 0.5, c)
    batches.misc.add(ix, 0, z0 + 4.5, 0.5, h, 0.5, rng.pick(BONE_WHITE))
    batches.misc.add(ix, h, z0 + 0.4, 0.45, 0.4, 4.4, c) // arching lintel
    grid.block(ix, z0)
    grid.block(ix, z0 + 4)
  }
  // the skull: one big weathered block + a snout block
  batches.misc.add(x0 + ribs * 2 + 0.5, 0, z0 + 0.8, 3, 2.3, 3.4, BONE_WHITE[0]!)
  batches.misc.add(x0 + ribs * 2 + 3.3, 0, z0 + 1.5, 1.4, 1.1, 2, BONE_WHITE[1]!)
  grid.blockRect(x0 + ribs * 2, z0, 5, 5)
}

/** Roofless ruined wall rectangle — crumbling stone courses with gaps and a
 *  doorway on the south side. Blocks the perimeter cells only. */
function kitRuinShell(ctx: Ctx, x0: number, z0: number, w: number, d: number): void {
  const { rng, batches, grid } = ctx
  const x1 = x0 + w - 1
  const z1 = z0 + d - 1
  const doorLo = x0 + Math.floor(w / 2) - 1
  for (let ix = x0; ix <= x1; ix++) {
    for (let iz = z0; iz <= z1; iz++) {
      const wall = ix === x0 || ix === x1 || iz === z0 || iz === z1
      if (!wall) continue
      if (iz === z0 && (ix === doorLo || ix === doorLo + 1)) continue // doorway
      if (rng.next() < 0.22) continue // collapsed gap
      const h = 0.6 + rng.range(0, 1.8)
      batches.stone.add(ix, 0, iz, 1, h, 1, rng.pick(RUIN_STONE))
      grid.block(ix, iz)
    }
  }
}

/** Soft dune mound — 2-3 shrinking sand-colored slabs. Blocks footprint. */
function kitDune(ctx: Ctx, ix: number, iz: number, big = false): void {
  const { rng, batches, grid } = ctx
  const w = big ? 5 + rng.int(3) : 3 + rng.int(2)
  const d = big ? 4 + rng.int(3) : 2 + rng.int(2)
  batches.misc.add(ix, 0, iz, w, 0.6, d, rng.pick(DESERT_GROUND))
  batches.misc.add(ix + 0.8, 0.6, iz + 0.6, w - 1.6, 0.55, d - 1.2, rng.pick(DESERT_GROUND))
  if (big) batches.misc.add(ix + 1.7, 1.15, iz + 1.2, w - 3.4, 0.5, d - 2.4, rng.pick(DESERT_GROUND))
  grid.blockRect(ix, iz, w, d)
}

/** A wrecked merchant wagon — plank bed, wheels, tilted cargo. Blocks 4x3. */
function kitWreckedWagon(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0.5, iz, 3.6, 0.4, 2.2, rng.pick(WOOD)) // bed
  batches.wood.add(ix + 0.1, 0.9, iz - 0.1, 0.3, 0.9, 2.4, rng.pick(DEAD_WOOD)) // headboard
  // wheels: dark squat cubes, one popped off and lying nearby
  batches.wood.add(ix + 0.3, 0, iz - 0.25, 0.9, 0.9, 0.3, WOOD_DARK)
  batches.wood.add(ix + 2.5, 0, iz - 0.25, 0.9, 0.9, 0.3, WOOD_DARK)
  batches.wood.add(ix + 0.3, 0, iz + 2.1, 0.9, 0.9, 0.3, WOOD_DARK)
  batches.wood.add(ix + 3.6, 0, iz + 2.6, 0.9, 0.3, 0.9, WOOD_DARK) // the quitter
  // spilled cargo
  for (let i = 0; i < 3; i++) {
    const s = rng.range(0.5, 0.9)
    batches.wood.add(ix + rng.range(0.4, 3), 0.9, iz + rng.range(0.1, 1.4), s, s, s, rng.pick(WOOD))
  }
  grid.blockRect(ix, iz, 4, 3)
}

type Zone = Parameters<typeof streamGroundPass>[1]

// ---------------------------------------------------------------------------
// catacombs_of_moist — The Catacombs of Moist (dungeon, 20-30)
// ---------------------------------------------------------------------------

function buildCatacombsOfMoist(ctx: Ctx, _scene: THREE.Scene, zone: Zone): void {
  const { rng, batches, grid } = ctx
  // spurs off the SW arterial (it cuts this zone corner to corner)
  kitPath(ctx, [[-302, 288], [-312, 292], [-322, 296], [-330, 298]]) // to the crypt mouth
  kitPath(ctx, [[-296, 294], [-288, 308], [-282, 320], [-278, 328]]) // to the mausoleum
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Grand Damp Staircase" — the catacombs' front door: a
  // dripping stone portal with steps descending into municipal darkness.
  // The welcome mat drowned years ago; nobody has replaced it.
  {
    const px = -340
    const pz = 294
    batches.stone.add(px, 0, pz, 1.6, 4.4, 1.6, rng.pick(STONE)) // left pier
    batches.stone.add(px + 5.4, 0, pz, 1.6, 4.4, 1.6, rng.pick(STONE)) // right pier
    batches.stone.add(px - 0.4, 4.4, pz - 0.2, 7.8, 1, 2, rng.pick(RUIN_STONE)) // lintel
    batches.stone.add(px + 1.6, 0, pz + 0.2, 3.8, 3.6, 0.4, 0x1c1c22) // the maw
    // descending steps spilling out toward the path
    for (let i = 0; i < 4; i++) {
      batches.stone.add(px + 1.4 + i * 0.25, 0, pz + 1.6 + i * 1.1, 4.2 - i * 0.5, 0.9 - i * 0.2, 1.1, rng.pick(STONE))
    }
    grid.blockRect(px, pz, 7, 2)
    kitCampfire(ctx, px - 2, pz + 3) // gatekeeper's brazier (ember 1/2)
    kitCampfire(ctx, px + 8, pz + 3) // its anxious twin (ember 2/2)
  }

  // LANDMARK: "The Mausoleum of Mild Inconvenience" — a grand tomb for
  // someone whose curse, per the plaque, is merely "damp socks forever."
  {
    const mx = -280
    const mz = 332
    batches.stone.add(mx, 0, mz, 8, 3, 6, rng.pick(RUIN_STONE)) // tomb block
    batches.stone.add(mx - 0.5, 3, mz - 0.5, 9, 0.7, 7, rng.pick(STONE)) // cap slab
    batches.stone.add(mx + 1, 3.7, mz + 1, 6, 0.6, 4, rng.pick(RUIN_STONE)) // stepped top
    batches.stone.add(mx + 3, 0, mz - 0.4, 2, 2.4, 0.5, 0x1c1c22) // doorway
    grid.blockRect(mx, mz, 8, 6)
    kitRuinPillar(ctx, mx - 2, mz - 2)
    kitRuinPillar(ctx, mx + 9, mz - 2)
  }

  // crypt sprawl: graves and pillars thick near the landmarks, thinning out
  cluster(ctx, -336, 300, 14, 16, (x, z) => (rng.next() < 0.6 ? kitGrave(ctx, x, z) : kitRuinPillar(ctx, x, z)))
  cluster(ctx, -276, 330, 12, 12, (x, z) => (rng.next() < 0.55 ? kitGrave(ctx, x, z) : kitDeadTree(ctx, x, z)))
  scatter(ctx, -356, 244, -244, 356, 40, (x, z) => {
    const r = rng.next()
    if (r < 0.4) kitDeadTree(ctx, x, z)
    else if (r < 0.7) kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1)
    else kitGrave(ctx, x, z)
  })
}

// ---------------------------------------------------------------------------
// gravely_serious — Gravely Serious (graveyard, 17-27, waystone -160,300)
// ---------------------------------------------------------------------------

function buildGravelySerious(ctx: Ctx, scene: THREE.Scene, zone: Zone): void {
  const { rng, batches, grid } = ctx
  // main drag: off the SW arterial's corner kink, east to the waystone green
  kitPath(ctx, [[-236, 240], [-220, 258], [-202, 274], [-182, 290], [-166, 298]])
  kitPath(ctx, [[-166, 298], [-146, 310], [-134, 322]]) // on to the corner office
  // cobble forecourt around the waystone (kept CLEAR of props below)
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      if (dx * dx + dz * dz <= 17) setSurface(ctx, -160 + dx, 300 + dz, S_COBBLE)
    }
  }
  streamGroundPass(ctx, zone)

  const nearWaystone = (x: number, z: number): boolean =>
    (x + 160) * (x + 160) + (z - 300) * (z - 300) < 49

  // LANDMARK: "The Skeleton King's Job Fair" — neat rows of headstones, each
  // one an open position. Benefits include dental (yours, repurposed).
  {
    const fx = -206
    const fz = 306
    // the recruitment arch: two posts, a beam, a hanging sign
    batches.wood.add(fx + 3, 0, fz - 2, 0.5, 3.4, 0.5, WOOD_DARK)
    batches.wood.add(fx + 8.5, 0, fz - 2, 0.5, 3.4, 0.5, WOOD_DARK)
    batches.wood.add(fx + 2.7, 3.4, fz - 2.1, 6.6, 0.5, 0.7, rng.pick(DEAD_WOOD))
    batches.wood.add(fx + 4.6, 2.2, fz - 2.05, 2.8, 1, 0.2, rng.pick(WOOD)) // the sign
    grid.block(fx + 3, fz - 2)
    grid.block(fx + 8, fz - 2)
    // the listings: a tidy 6x3 grid of graves
    for (let cx = 0; cx < 6; cx++) {
      for (let cz = 0; cz < 3; cz++) {
        kitGrave(ctx, fx + cx * 2, fz + cz * 3)
      }
    }
    kitFenceRun(ctx, fx - 2, fz - 4, 16, true)
    kitFenceRun(ctx, fx - 2, fz - 4, 15, false)
  }

  // LANDMARK: "The Corner Office" — the Skeleton King's regional HQ: a
  // mausoleum with a statue of Employee of the Eternity out front.
  {
    const mx = -134
    const mz = 328
    batches.stone.add(mx, 0, mz, 9, 3.4, 7, rng.pick(RUIN_STONE))
    batches.stone.add(mx - 0.5, 3.4, mz - 0.5, 10, 0.8, 8, rng.pick(STONE))
    batches.stone.add(mx + 1.2, 4.2, mz + 1, 6.6, 0.7, 5, rng.pick(RUIN_STONE))
    batches.stone.add(mx + 3.5, 0, mz - 0.4, 2, 2.6, 0.5, 0x1c1c22) // doorway
    grid.blockRect(mx, mz, 9, 7)
    kitStatue(ctx, mx - 5, mz + 2)
    kitRuinPillar(ctx, mx + 10, mz)
  }

  // the one lantern — lighting the waystone forecourt's edge
  kitLantern(ctx, scene, -166, 306)

  // the congregation: graves everywhere, dead trees leaning in to listen
  cluster(ctx, -200, 310, 16, 14, (x, z) => {
    if (nearWaystone(x, z)) return
    rng.next() < 0.7 ? kitGrave(ctx, x, z) : kitDeadTree(ctx, x, z)
  })
  scatter(ctx, -236, 244, -84, 356, 52, (x, z) => {
    if (nearWaystone(x, z)) return
    const r = rng.next()
    if (r < 0.5) kitGrave(ctx, x, z)
    else if (r < 0.8) kitDeadTree(ctx, x, z)
    else kitRock(ctx, x, z, 1)
  })
}

// ---------------------------------------------------------------------------
// dry_heat — The Dry Heat (savanna, 44-56)
// ---------------------------------------------------------------------------

function buildDryHeat(ctx: Ctx, _scene: THREE.Scene, zone: Zone): void {
  const { rng, batches, grid } = ctx
  // spur off the SW arterial down to the watering hole
  kitPath(ctx, [[-420, 432], [-430, 442], [-438, 452], [-444, 460]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Watering Hole (Allegedly)" — the savanna's one puddle,
  // ringed by stones and lies. The water is real; the "crocodile-free"
  // signage is aspirational.
  {
    const wx = -452
    const wz = 462
    for (let ix = wx; ix < wx + 12; ix++) {
      for (let iz = wz; iz < wz + 9; iz++) {
        const edge = ix === wx || ix === wx + 11 || iz === wz || iz === wz + 8
        if (edge) {
          if (rng.next() < 0.75) batches.stone.add(ix, 0, iz, 1, 0.45, 1, rng.pick(STONE))
        } else {
          batches.misc.add(ix, 0, iz, 1, 0.26, 1, LAGOON_WATER)
        }
        grid.block(ix, iz)
      }
    }
    // the aspirational sign
    batches.wood.add(wx + 13, 0, wz + 3, 0.4, 1.8, 0.4, WOOD_DARK)
    batches.wood.add(wx + 12.4, 1.8, wz + 2.9, 1.8, 0.9, 0.2, rng.pick(WOOD))
    grid.block(wx + 13, wz + 3)
    cluster(ctx, wx + 6, wz + 4, 13, 10, (x, z) => kitAcacia(ctx, x, z))
  }

  // LANDMARK: "The Longest Nap" — something enormous lay down here a few
  // centuries ago and committed to the bit.
  kitRibcage(ctx, -422, 384, 6)
  cluster(ctx, -412, 388, 11, 9, (x, z) => kitBone(ctx, x, z))

  // golden grass tufts, lone acacias, sunburnt rocks
  scatter(ctx, -476, 364, -364, 516, 26, (x, z) => kitAcacia(ctx, x, z))
  scatter(ctx, -476, 364, -364, 516, 24, (x, z) =>
    rng.next() < 0.55 ? kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1) : kitBone(ctx, x, z)
  )
  scatter(ctx, -476, 364, -364, 516, 40, (x, z) => {
    // dry grass tuft — one squat golden wisp, non-blocking scenery
    batches.leaf.add(x + 0.25, 0, z + 0.25, 0.5, 0.5 + rng.range(0, 0.4), 0.5, rng.pick(SAVANNA_GROUND))
  })
}

// ---------------------------------------------------------------------------
// needlepoint_nowhere — Needlepoint Nowhere (desert, 40-54)
// ---------------------------------------------------------------------------

function buildNeedlepointNowhere(ctx: Ctx, _scene: THREE.Scene, zone: Zone): void {
  const { rng, batches, grid } = ctx
  // spur off the arterial's corner waypoint, down into the spines
  kitPath(ctx, [[-358, 362], [-342, 378], [-326, 396], [-314, 412], [-308, 422]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Duelling Garden" — a stone ring where disputes are
  // settled by shoving each other into the audience. The audience is cacti.
  // Attendance is always excellent; nobody in the front row ever leaves.
  {
    const cx = -302
    const cz = 430
    const r = 8
    for (let a = 0; a < 26; a++) {
      const ang = (a / 26) * Math.PI * 2
      // two gaps: the dignified entrance and the undignified exit
      if (Math.abs(ang - Math.PI * 1.5) < 0.3 || Math.abs(ang - Math.PI * 0.5) < 0.3) continue
      const ix = Math.round(cx + Math.cos(ang) * r)
      const iz = Math.round(cz + Math.sin(ang) * r)
      batches.stone.add(ix, 0, iz, 1, 0.9 + rng.range(0, 0.5), 1, rng.pick(STONE))
      grid.block(ix, iz)
    }
    batches.stone.add(cx - 0.5, 0, cz - 0.5, 2, 0.3, 2, rng.pick(RUIN_STONE)) // the shoving stone
    // front-row season ticket holders
    cluster(ctx, cx, cz, 14, 20, (x, z) => {
      const d = Math.hypot(x - cx, z - cz)
      if (d < r + 1.5) return // keep the ring floor fightable
      kitCactus(ctx, x, z)
    })
  }

  // LANDMARK: "The Pincushion Express" — a merchant caravan that took the
  // scenic shortcut. The cargo made it; the margins did not.
  {
    const px = -282
    const pz = 474
    kitWreckedWagon(ctx, px, pz)
    kitWreckedWagon(ctx, px + 7, pz + 4)
    // the wagon that found the biggest cactus in the province, the hard way
    batches.wood.add(px + 13, 1.3, pz + 8, 3.2, 0.4, 2, rng.pick(DEAD_WOOD)) // tipped bed
    const c = rng.pick(CACTUS_GREEN)
    batches.leaf.add(px + 14.2, 0, pz + 8.6, 0.8, 4.6, 0.8, c) // the culprit, through the floor
    batches.leaf.add(px + 13.4, 2.6, pz + 8.7, 0.7, 0.6, 0.6, c)
    batches.leaf.add(px + 15.1, 3.1, pz + 8.7, 0.7, 1.1, 0.6, c)
    grid.blockRect(px + 13, pz + 8, 4, 2)
    kitBone(ctx, px + 4, pz + 7) // the draft animal's professional opinion
  }

  // the lawsuit forest itself: cacti thick everywhere, rocks and bones between
  scatter(ctx, -356, 364, -244, 516, 64, (x, z) => kitCactus(ctx, x, z))
  scatter(ctx, -356, 364, -244, 516, 22, (x, z) =>
    rng.next() < 0.6 ? kitRock(ctx, x, z, 1) : kitBone(ctx, x, z)
  )
}

// ---------------------------------------------------------------------------
// sunken_suburbs — The Sunken Suburbs (ruins, 60-75)
// ---------------------------------------------------------------------------

function buildSunkenSuburbs(ctx: Ctx, _scene: THREE.Scene, zone: Zone): void {
  const { rng, batches, grid } = ctx
  // spur off the SW arterial (it passes right through) into the town square
  kitPath(ctx, [[-566, 578], [-556, 590], [-548, 602], [-544, 610]])
  // the old plaza cobbles, pre-stamped so the ground pass renders them
  for (let dx = -7; dx <= 7; dx++) {
    for (let dz = -7; dz <= 7; dz++) {
      if (dx * dx + dz * dz <= 44) setSurface(ctx, -544 + dx, 616 + dz, S_COBBLE)
    }
  }
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Town Square of the Politely Drowned" — the old civic
  // heart, ankle-deep in regret. The statues wave back. Slowly. Do not
  // wave first; they consider it an invitation.
  {
    const sx = -544
    const sz = 616
    // the fountain, still technically operational (the flood counts)
    batches.stone.add(sx - 2, 0, sz - 2, 5, 0.6, 5, rng.pick(RUIN_STONE))
    batches.misc.add(sx - 1, 0.3, sz - 1, 3, 0.4, 3, SWAMP_MURK)
    batches.stone.add(sx - 0.2, 0.3, sz - 0.2, 1.4, 2, 1.4, rng.pick(RUIN_STONE)) // snapped spire
    grid.blockRect(sx - 2, sz - 2, 5, 5)
    // the greeters, mid-wave since the incident
    kitStatue(ctx, sx - 11, sz - 4)
    kitStatue(ctx, sx + 7, sz + 3)
    // floodwater pooling in the low streets off the plaza
    for (let i = 0; i < 5; i++) {
      const px = sx - 14 + rng.range(0, 26)
      const pz = sz - 14 + rng.range(0, 26)
      if (Math.hypot(px - sx, pz - sz) < 8) continue // plaza stays shallow
      const w = 2 + rng.int(3)
      const d = 2 + rng.int(3)
      batches.misc.add(px, 0, pz, w, 0.22, d, SWAMP_MURK)
      grid.blockRect(Math.floor(px), Math.floor(pz), w, d)
    }
    // the suburbs: roofless shells with excellent natural light
    kitRuinShell(ctx, sx - 16, sz - 12, 7, 6)
    kitRuinShell(ctx, sx + 9, sz - 10, 6, 7)
    kitRuinShell(ctx, sx - 14, sz + 7, 6, 6)
    kitRuinShell(ctx, sx + 10, sz + 9, 7, 6)
  }

  // LANDMARK: "The Leaning Clocktower of Whenever" — still right twice a
  // day, which beats the rest of the town's infrastructure.
  {
    const tx = -516
    const tz = 652
    for (let y = 0; y < 5; y++) {
      // each storey drifts a little further off plumb
      batches.stone.add(tx + y * 0.22, y * 2, tz + y * 0.14, 3, 2, 3, rng.pick(RUIN_STONE))
    }
    batches.window.add(tx + 1.9, 8.6, tz + 0.6, 1.2, 1.2, 0.3, 0xffd9a0) // the face, glowing with misplaced confidence
    batches.stone.add(tx + 1.1, 10, tz + 0.7, 1.6, 0.9, 1.6, rng.pick(STONE)) // the broken crown
    grid.blockRect(tx, tz, 4, 4)
    kitRuinPillar(ctx, tx - 3, tz + 1)
    kitRuinPillar(ctx, tx + 5, tz - 2)
  }

  // drowned-town sprawl: pillars, rubble, trees that gave up on photosynthesis
  cluster(ctx, -544, 616, 20, 12, (x, z) => (rng.next() < 0.5 ? kitRuinPillar(ctx, x, z) : kitRock(ctx, x, z, 1)))
  scatter(ctx, -596, 524, -484, 676, 44, (x, z) => {
    const r = rng.next()
    if (r < 0.4) kitRuinPillar(ctx, x, z)
    else if (r < 0.7) kitDeadTree(ctx, x, z)
    else kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1)
  })
}

// ---------------------------------------------------------------------------
// shifting_sneaks — The Shifting Sneaks (desert, 58-72)
// ---------------------------------------------------------------------------

function buildShiftingSneaks(ctx: Ctx, _scene: THREE.Scene, zone: Zone): void {
  const { rng, batches, grid } = ctx
  // spur in from the arterial northwest of the zone, down to the caravanserai
  kitPath(ctx, [[-492, 498], [-484, 512], [-476, 526], [-468, 540], [-462, 548]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Half-Swallowed Caravanserai" — a trade rest-stop the
  // dunes are eating one wall at a time. Checkout time is whenever the sand
  // reaches your room.
  {
    const cx = -462
    const cz = 552
    kitRuinShell(ctx, cx, cz, 9, 7)
    // the dune doing the swallowing, mid-bite over the east wall
    kitDune(ctx, cx + 6, cz - 2, true)
    kitDune(ctx, cx + 8, cz + 4, true)
    // the gate arch still holding out
    batches.stone.add(cx + 3, 0, cz - 1, 0.9, 3.4, 0.9, rng.pick(RUIN_STONE))
    batches.stone.add(cx + 5.4, 0, cz - 1, 0.9, 3.4, 0.9, rng.pick(RUIN_STONE))
    batches.stone.add(cx + 2.7, 3.4, cz - 1.1, 4, 0.7, 1.1, rng.pick(STONE))
    grid.block(cx + 3, cz - 1)
    grid.block(cx + 5, cz - 1)
    kitWreckedWagon(ctx, cx - 5, cz + 2) // guest parking, long-term
    kitCampfire(ctx, cx + 3, cz + 9) // the last tenant's holdout fire (ember 1/2)
  }

  // LANDMARK: "The Big Fella's Commute" — colossal stone footprints striding
  // across the dunes, ending mid-step at absolutely nothing. Locals refuse
  // to discuss it; the dunes refuse to keep the prints in the same place.
  {
    let fx = -432
    let fz = 596
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 0 : 5 // left foot, right foot
      batches.stone.add(fx + side, 0, fz, 3, 0.35, 4.6, rng.pick(RUIN_STONE))
      batches.stone.add(fx + side + 0.5, 0, fz - 1, 2, 0.3, 1.2, rng.pick(RUIN_STONE)) // toes
      grid.blockRect(fx + side, fz - 1, 3, 6)
      fx += 4
      fz += 7
    }
    // ...and the single abandoned boot, size: municipal
    batches.wood.add(fx + 2, 0, fz, 3, 2.6, 4, WOOD_DARK)
    batches.wood.add(fx + 2, 0, fz + 4, 3, 1.1, 2, rng.pick(DEAD_WOOD)) // the toe box
    grid.blockRect(fx + 2, fz, 3, 6)
  }

  // the sneaks themselves: restless dunes, nervous cacti, editorial bones
  scatter(ctx, -476, 524, -364, 676, 26, (x, z) => kitDune(ctx, x, z, rng.next() < 0.25))
  scatter(ctx, -476, 524, -364, 676, 18, (x, z) => kitCactus(ctx, x, z))
  scatter(ctx, -476, 524, -364, 676, 16, (x, z) =>
    rng.next() < 0.55 ? kitBone(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
}

// ---------------------------------------------------------------------------
// Registration — the zones/index barrel calls this once at boot.
// ---------------------------------------------------------------------------

export function registerBatch12(): void {
  registerZoneBuilder('catacombs_of_moist', buildCatacombsOfMoist)
  registerZoneBuilder('gravely_serious', buildGravelySerious)
  registerZoneBuilder('dry_heat', buildDryHeat)
  registerZoneBuilder('needlepoint_nowhere', buildNeedlepointNowhere)
  registerZoneBuilder('sunken_suburbs', buildSunkenSuburbs)
  registerZoneBuilder('shifting_sneaks', buildShiftingSneaks)
}

// The stream also eager-globs zone batch files; registering at import time
// keeps the zones live even before the barrel wires up.
registerBatch12()
