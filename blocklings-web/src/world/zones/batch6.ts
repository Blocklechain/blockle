/**
 * src/world/zones/batch6.ts — BATCH 6: the EAST COAST STRIP (NE corner down
 * the sunrise seaboard): glacier_point, icicle_works, driftwood_dumps,
 * port_saltlick, mermaids_hot_tub, shallow_end.
 *
 * Same hand-built voxel vocabulary as the heart: VoxelBatch Lambert boxes,
 * no textures, warm glow only via the shared flickering window batch.
 * Builders are deterministic (ctx.rng is seeded from the zone id by the
 * stream) and idempotent re collision. Surface stamps (paths / plank decks)
 * happen BEFORE streamGroundPass; props after.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import { S_BRIDGE, S_COBBLE, S_GRASS, setSurface, surfaceAt, type Ctx } from '../layout'
import {
  BONE_WHITE,
  DEAD_WOOD,
  ICE,
  LAGOON_WATER,
  PLASTER,
  RUIN_STONE,
  SAND,
  STONE,
  STRAW,
  WOOD,
  WOOD_DARK,
  isLand,
  kitBone,
  kitBridgePlank,
  kitCampfire,
  kitFenceRun,
  kitHouseShell,
  kitHut,
  kitIceSpike,
  kitLantern,
  kitPalm,
  kitPath,
  kitRock,
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

/** Raised stone-rimmed pool of still water (lagoon turquoise). Blocks the
 *  water cells — strict no-drowning policy, loosely enforced. Cells already
 *  stamped S_BRIDGE (a plank boardwalk crossing the pool) are left alone:
 *  no rim, no water, no block — the deck stays walkable. */
function kitPool(
  ctx: Ctx,
  x0: number,
  z0: number,
  w: number,
  d: number,
  rim: readonly number[]
): void {
  const { rng, batches, grid } = ctx
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) {
      if (surfaceAt(ctx, ix, iz) === S_BRIDGE) continue
      const edge = ix === x0 || ix === x0 + w - 1 || iz === z0 || iz === z0 + d - 1
      if (edge) batches.stone.add(ix, 0, iz, 1, 0.55, 1, rng.pick(rim))
      else batches.misc.add(ix, 0, iz, 1, 0.3, 1, LAGOON_WATER)
      grid.block(ix, iz)
    }
  }
}

/** Lazy steam wisps over a pool — pale floating cubes, no light. */
function steam(ctx: Ctx, x0: number, z0: number, w: number, d: number, n: number): void {
  const { rng, batches } = ctx
  for (let i = 0; i < n; i++) {
    batches.plaster.add(
      x0 + rng.range(1, w - 1.4),
      0.7 + rng.range(0, 1.3),
      z0 + rng.range(1, d - 1.4),
      0.4, 0.3, 0.4,
      rng.pick(PLASTER)
    )
  }
}

/** Half-buried giant ribcage — paired bone pillars with lintels, along +X. */
function kitRibcage(ctx: Ctx, x0: number, z0: number, ribs: number): void {
  const { rng, batches, grid } = ctx
  for (let i = 0; i < ribs; i++) {
    const ix = x0 + i * 2
    const h = 1.6 + Math.sin((i / (ribs - 1)) * Math.PI) * 1.8 + rng.range(0, 0.3)
    const c = rng.pick(BONE_WHITE)
    batches.misc.add(ix, 0, z0, 0.5, h, 0.5, c)
    batches.misc.add(ix, 0, z0 + 4.5, 0.5, h, 0.5, rng.pick(BONE_WHITE))
    batches.misc.add(ix, h, z0 + 0.4, 0.45, 0.4, 4.4, c) // arching lintel
    grid.block(ix, z0)
    grid.block(ix, z0 + 4)
  }
  // the skull end: one big weathered block with eye pits
  batches.misc.add(x0 + ribs * 2 + 0.5, 0, z0 + 0.8, 3, 2.2, 3.4, BONE_WHITE[0]!)
  grid.blockRect(x0 + ribs * 2, z0, 4, 5)
}

// ---------------------------------------------------------------------------
// glacier_point — Glacier Point Blank (glacier, 68-84)
// ---------------------------------------------------------------------------

function buildGlacierPoint(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // path: NE arterial ends at (660,-660) — spur up to the harpoon battery
  kitPath(ctx, [[660, -660], [655, -653], [650, -648], [647, -644]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Last Harpoon" — a whaler's ballista the size of a house,
  // still aimed at the sea, still waiting for the big one.
  {
    const bx = 644
    const bz = 648 // z = -648
    batches.stone.add(bx, 0, -bz, 7, 0.5, 7, rng.pick(STONE)) // firing platform
    batches.wood.add(bx + 1, 0.5, -bz + 2.4, 1, 1.6, 2.2, WOOD_DARK) // left truss
    batches.wood.add(bx + 4.6, 0.5, -bz + 2.4, 1, 1.6, 2.2, WOOD_DARK) // right truss
    batches.wood.add(bx + 0.4, 1.6, -bz + 2.9, 6, 0.6, 1.2, rng.pick(WOOD)) // crossbow arms
    // the harpoon itself — stepped shaft climbing east toward the water
    for (let i = 0; i < 6; i++) {
      batches.wood.add(bx + 1.6 + i * 1.1, 1.9 + i * 0.28, -bz + 3, 1.3, 0.34, 0.5, rng.pick(DEAD_WOOD))
    }
    batches.misc.add(bx + 8.2, 3.6, -bz + 2.9, 1, 0.6, 0.7, rng.pick(BONE_WHITE)) // bone barb
    batches.wood.add(bx + 0.8, 2.1, -bz + 1, 1.2, 1.2, 1.2, rng.pick(WOOD)) // winch drum
    grid.blockRect(bx, -bz, 7, 7)
    kitCampfire(ctx, bx - 2, -bz + 3) // the watchman's brazier (ember use 1/2)
  }

  // LANDMARK: "Moby's Last Laugh" — a whale skeleton beached in the ice,
  // grinning at the harpoon that clearly missed.
  kitRibcage(ctx, 626, -586, 6)
  cluster(ctx, 634, -590, 10, 8, (x, z) => kitBone(ctx, x, z))

  // ice fields: dense around the landmarks, sparser toward the tundra edge
  cluster(ctx, 648, -644, 16, 26, (x, z) => kitIceSpike(ctx, x, z))
  cluster(ctx, 634, -584, 14, 18, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, 604, -716, 690, -528, 46, (x, z) =>
    rng.next() < 0.72 ? kitIceSpike(ctx, x, z) : kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1)
  )
}

// ---------------------------------------------------------------------------
// icicle_works — The Icicle Works (glacier, 54-68)
// ---------------------------------------------------------------------------

function buildIcicleWorks(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // spur in from the west edge, where the NE arterial swings closest
  kitPath(ctx, [[600, -492], [612, -480], [626, -468], [638, -458], [644, -452]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Production Line" — nature's icicle factory floor: a stone
  // terrace with graduated mega-icicles racked tallest to smallest, quality
  // control strictly stab-based.
  {
    const tx = 640
    const tz = 456 // z = -456
    batches.stone.add(tx, 0, -tz, 16, 0.45, 6, rng.pick(STONE))
    for (let i = 0; i < 7; i++) {
      const ix = tx + 1.4 + i * 2
      const h = 5.2 - i * 0.55
      const c = rng.pick(ICE)
      batches.misc.add(ix, 0.45, -tz + 2, 1.1, h * 0.55, 1.1, c)
      batches.misc.add(ix + 0.2, 0.45 + h * 0.55, -tz + 2.2, 0.7, h * 0.3, 0.7, rng.pick(ICE))
      batches.misc.add(ix + 0.36, 0.45 + h * 0.85, -tz + 2.36, 0.38, h * 0.2, 0.38, c)
    }
    grid.blockRect(tx, -tz, 16, 6)
  }

  // LANDMARK: "The Foreman's Office" — an abandoned cutter's hut, door
  // frozen shut since the incident nobody talks about.
  kitHut(ctx, 622, -482)
  kitFenceRun(ctx, 620, -486, 9, true) // the yard fence, mostly decorative
  cluster(ctx, 624, -478, 8, 10, (x, z) => kitIceSpike(ctx, x, z))

  // the works themselves: icicle stands all over the cliff-coast
  cluster(ctx, 648, -452, 18, 30, (x, z) => kitIceSpike(ctx, x, z))
  scatter(ctx, 604, -516, 690, -366, 52, (x, z) =>
    rng.next() < 0.78 ? kitIceSpike(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
}

// ---------------------------------------------------------------------------
// driftwood_dumps — Driftwood Dumps (beach, 50-64)
// ---------------------------------------------------------------------------

function buildDriftwoodDumps(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  kitPath(ctx, [[600, -296], [614, -303], [628, -300], [640, -297], [648, -296]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The S.S. Regret" — a beached wreck, named by her captain
  // roughly four seconds after naming her.
  {
    const wx = 652
    const wz = 300 // z = -300
    // hull: stacked, shrinking plank courses with a tilt eastward
    batches.wood.add(wx, 0, -wz, 12, 1, 5, rng.pick(DEAD_WOOD))
    batches.wood.add(wx + 0.6, 1, -wz + 0.3, 11.4, 1, 4.4, rng.pick(WOOD))
    batches.wood.add(wx + 1.4, 2, -wz + 0.7, 10, 0.9, 3.6, rng.pick(DEAD_WOOD))
    batches.wood.add(wx + 11.4, 0.4, -wz + 1.4, 2.2, 2.4, 2.2, rng.pick(WOOD)) // crumpled bow
    // snapped mast + its fallen top, a polite distance away
    batches.wood.add(wx + 5, 2.9, -wz + 2.2, 0.7, 3.4, 0.7, WOOD_DARK)
    batches.wood.add(wx + 3, 0.2, -wz - 2.6, 5, 0.6, 0.7, WOOD_DARK)
    batches.plaster.add(wx + 4.4, 5.2, -wz + 2.1, 2.6, 1.6, 0.25, rng.pick(PLASTER)) // ragged sail
    grid.blockRect(wx, -wz, 14, 5)
    grid.blockRect(wx + 3, -wz - 3, 5, 1)
  }

  // LANDMARK: "Mount Flotsam" — the sea's personal junk drawer, curated by
  // one deeply territorial beachcomber.
  {
    const fx = 626
    const fz = 330 // z = -330
    for (let i = 0; i < 16; i++) {
      const s = rng.range(0.5, 1.6)
      batches.wood.add(
        fx + rng.range(0, 7 - s), rng.range(0, 1.6), -fz + rng.range(0, 6 - s),
        s, rng.range(0.3, 0.9), s, rng.pick(rng.next() < 0.5 ? DEAD_WOOD : WOOD)
      )
    }
    batches.misc.add(fx + 2.5, 2.2, -fz + 2.5, 1.2, 0.9, 1.2, rng.pick(BONE_WHITE)) // crowning trophy skull
    grid.blockRect(fx, -fz, 7, 6)
    kitHut(ctx, 616, -324) // the beachcomber's shack
    kitCampfire(ctx, 622, -317) // (ember use 1/2)
  }

  // driftwood logs strewn down the strand, palms up on the grassy lip
  scatter(ctx, 604, -356, 688, -244, 34, (x, z) => {
    batches.wood.add(x, 0, z + 0.3, 1.8 + rng.range(0, 1.2), 0.4, 0.5, rng.pick(DEAD_WOOD))
    grid.block(x, z)
  })
  scatter(ctx, 604, -356, 660, -244, 26, (x, z) => kitPalm(ctx, x, z))
  scatter(ctx, 610, -350, 686, -248, 10, (x, z) =>
    rng.next() < 0.5 ? kitBone(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
}

// ---------------------------------------------------------------------------
// port_saltlick — Port Saltlick (city, 48-64, waystone at 660,-160)
// ---------------------------------------------------------------------------

function buildPortSaltlick(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  const scene = _scene

  // streets first: high street up from the E arterial, cross lane to the quay
  kitPath(ctx, [[640, -80], [646, -104], [652, -128], [658, -148], [660, -160], [655, -182], [650, -204]], 1.8)
  kitPath(ctx, [[640, -158], [660, -160], [672, -152]], 1.6)
  // plaza cobbles around the waystone (kept CLEAR of props below)
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      if (dx * dx + dz * dz <= 27) setSurface(ctx, 660 + dx, -160 + dz, S_COBBLE)
    }
  }
  // the quay boardwalk, stamped before the ground pass (stays over land)
  kitBridgePlank(ctx, 672, -152, 12, true)
  kitBridgePlank(ctx, 672, -151, 12, true)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Saltlick Itself" — the municipal salt monolith, licked
  // smooth by generations of founders, sailors, and one very committed elk.
  {
    batches.misc.add(653, 0, -174, 2.4, 3.6, 2.4, BONE_WHITE[0]!)
    batches.misc.add(653.5, 3.6, -173.5, 1.4, 1.1, 1.4, BONE_WHITE[1]!)
    batches.misc.add(653.9, 4.7, -173.1, 0.6, 0.6, 0.6, BONE_WHITE[2]!) // the lickable summit
    batches.stone.add(652.5, 0, -174.5, 3.4, 0.25, 3.4, rng.pick(STONE))
    grid.blockRect(652, -175, 4, 4)
  }

  // LANDMARK: "The Harbor of Dubious Goods" — the dock quarter. Everything
  // is for sale; receipts are considered an insult.
  kitHouseShell(ctx, { x0: 640, z0: -178, w: 9, d: 7, wallH: 4, door: 'E', chimney: true }) // tavern: The Thirsty Barnacle
  kitHouseShell(ctx, { x0: 665, z0: -178, w: 7, d: 6, wallH: 3, door: 'W' }) // Chowder & Chums fishmongery
  kitHouseShell(ctx, { x0: 641, z0: -144, w: 7, d: 6, wallH: 3, door: 'E' }) // Harbormaster's office (bribes window around back)
  kitHouseShell(ctx, { x0: 666, z0: -140, w: 8, d: 6, wallH: 3, door: 'W', chimney: true }) // bonded(ish) warehouse
  // crate clutter on the quay
  for (let i = 0; i < 9; i++) {
    const cx = 673 + rng.range(0, 9)
    const cz = -149 + rng.range(0, 4)
    const s = rng.range(0.7, 1.2)
    batches.wood.add(cx, 0, cz, s, s * rng.range(0.7, 1.2), s, rng.pick(WOOD))
    grid.block(Math.floor(cx), Math.floor(cz))
  }
  // market stall off the plaza — two posts and a straw awning
  batches.wood.add(664.3, 0, -170.3, 0.4, 2.2, 0.4, WOOD_DARK)
  batches.wood.add(667.3, 0, -170.3, 0.4, 2.2, 0.4, WOOD_DARK)
  batches.misc.add(663.8, 2.2, -171.2, 4.4, 0.4, 2.6, STRAW)
  batches.wood.add(664, 0.7, -170.8, 4, 0.5, 1.4, rng.pick(WOOD)) // counter
  grid.blockRect(664, -171, 4, 2)

  // the town's one lantern, lighting the plaza (waystone stays clear)
  kitLantern(ctx, scene, 665, -156)

  // scrappy city greenery + rocks between the quarters
  scatter(ctx, 604, -236, 656, -84, 18, (x, z) => kitPalm(ctx, x, z))
  scatter(ctx, 604, -236, 688, -84, 12, (x, z) => kitRock(ctx, x, z, 1))
}

// ---------------------------------------------------------------------------
// mermaids_hot_tub — Mermaid's Hot Tub (lagoon, 50-66)
// ---------------------------------------------------------------------------

function buildMermaidsHotTub(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng } = ctx
  // spur south off the E arterial down to the tub
  kitPath(ctx, [[640, -2], [644, 10], [648, 20], [650, 26]])
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Hot Tub Itself" — a steaming stone soaking pool. House
  // rules: no splashing, no drowning, no asking where the heat comes from.
  kitPool(ctx, 646, 28, 11, 9, STONE)
  steam(ctx, 646, 28, 11, 9, 7)
  // towel rocks (flat warm stones for lounging)
  const { batches, grid } = ctx
  for (let i = 0; i < 4; i++) {
    const lx = 644 + rng.range(0, 14)
    const lz = 39 + rng.range(0, 2.5)
    batches.stone.add(lx, 0, lz, 1.6, 0.3, 1.1, rng.pick(RUIN_STONE))
    grid.block(Math.floor(lx), Math.floor(lz))
  }

  // LANDMARK: "Her Splendidness, Mid-Hair-Flip" — a colossal statue of the
  // proprietor, commissioned by the proprietor, approved by the proprietor.
  kitStatue(ctx, 661, 20)

  // palm fringe, dense around the tub, thinning toward the reef shelf
  cluster(ctx, 651, 33, 16, 18, (x, z) => kitPalm(ctx, x, z))
  scatter(ctx, 604, -76, 686, 76, 30, (x, z) => {
    if (z > -12 && z < 12) return // keep the arterial corridor open
    if (rng.next() < 0.6) kitPalm(ctx, x, z)
    else kitRock(ctx, x, z, 1)
  })
  // scattered shells (pale flecks on the sand)
  scatter(ctx, 620, -70, 686, 72, 14, (x, z) => {
    ctx.batches.misc.add(x + 0.3, 0, z + 0.3, 0.3, 0.14, 0.3, rng.pick(BONE_WHITE))
  })
}

// ---------------------------------------------------------------------------
// shallow_end — The Shallow End (lagoon, 48-62)
// ---------------------------------------------------------------------------

function buildShallowEnd(ctx: Ctx, _scene: THREE.Scene, zone: Parameters<typeof streamGroundPass>[1]): void {
  const { rng, batches, grid } = ctx
  // path south from the E arterial side (north edge) to the bar
  kitPath(ctx, [[640, 80], [643, 98], [646, 116], [648, 132]])
  // boardwalk out across the reef pool — stamped before the ground paints
  kitBridgePlank(ctx, 654, 146, 12, true)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Swim-Up Bar of Bad Decisions" — three feet of water,
  // unlimited regret, happy hour never ends because nobody owns a clock.
  kitHut(ctx, 645, 136) // the bar shack
  kitPool(ctx, 654, 142, 14, 10, SAND) // the reef pool the boardwalk crosses
  steam(ctx, 654, 142, 14, 10, 3) // sun-warmed shimmer
  // bar stools along the boardwalk's end
  for (let i = 0; i < 3; i++) {
    batches.wood.add(661 + i * 1.6, 0.3, 144.9, 0.5, 0.7, 0.5, WOOD_DARK)
  }
  kitCampfire(ctx, 650, 133) // the beach bonfire (ember use 1/2)

  // LANDMARK: "The Lifeguard Tower of Indifference" — staffed around the
  // clock by a chair, a hat, and a strongly worded sign.
  {
    const tx = 628
    const tz = 108
    batches.wood.add(tx, 0, tz, 0.5, 3, 0.5, WOOD_DARK)
    batches.wood.add(tx + 2.5, 0, tz, 0.5, 3, 0.5, WOOD_DARK)
    batches.wood.add(tx, 0, tz + 2.5, 0.5, 3, 0.5, WOOD_DARK)
    batches.wood.add(tx + 2.5, 0, tz + 2.5, 0.5, 3, 0.5, WOOD_DARK)
    batches.wood.add(tx - 0.3, 3, tz - 0.3, 3.6, 0.3, 3.6, rng.pick(WOOD)) // platform
    batches.misc.add(tx - 0.5, 4.6, tz - 0.5, 4, 0.45, 4, STRAW) // sun roof
    batches.wood.add(tx + 1, 3.3, tz + 1, 0.9, 0.8, 0.9, rng.pick(WOOD)) // the empty chair
    for (let y = 0; y < 3; y++) {
      batches.wood.add(tx + 1.2, y, tz - 0.4, 0.8, 0.15, 0.3, WOOD_DARK) // ladder rungs
    }
    grid.blockRect(tx, tz, 3, 3)
  }

  // reef-lagoon fringe: palms + coral-bright flowers on the sand
  cluster(ctx, 648, 140, 15, 14, (x, z) => kitPalm(ctx, x, z))
  scatter(ctx, 604, 84, 686, 236, 28, (x, z) =>
    rng.next() < 0.65 ? kitPalm(ctx, x, z) : kitRock(ctx, x, z, 1)
  )
  scatter(ctx, 610, 90, 686, 232, 16, (x, z) => {
    batches.misc.add(x + 0.3, 0, z + 0.3, 0.3, 0.16, 0.3, rng.pick(BONE_WHITE)) // shells
  })
}

// ---------------------------------------------------------------------------
// Registration — the zones/index barrel calls this once at boot.
// ---------------------------------------------------------------------------

export function registerBatch6(): void {
  registerZoneBuilder('glacier_point', buildGlacierPoint)
  registerZoneBuilder('icicle_works', buildIcicleWorks)
  registerZoneBuilder('driftwood_dumps', buildDriftwoodDumps)
  registerZoneBuilder('port_saltlick', buildPortSaltlick)
  registerZoneBuilder('mermaids_hot_tub', buildMermaidsHotTub)
  registerZoneBuilder('shallow_end', buildShallowEnd)
}

// The stream also eager-globs zone batch files; registering at import time
// keeps the zones live even before the barrel wires up.
registerBatch6()
