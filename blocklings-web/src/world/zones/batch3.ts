/**
 * src/world/zones/batch3.ts — ZONE BATCH 3: TRUE NORTH
 * (the polar cap + the road north of the Capital)
 *
 *   deepfreeze          — The Deepfreeze (dungeon, 75-92)
 *   zero_chill          — Absolute Zero Chill (glacier, 80-99, waystone)
 *   permafrost_parade   — Permafrost Parade (tundra, 47-59)
 *   north_roads_end     — The North Road's End (tundra, 45-56, waystone)
 *   bracing_pines       — The Bracing Pines (forest, 10-16)
 *   kings_back_lawn     — The King's Back Lawn (meadow, 10-15, waystone)
 *
 * Contract: stamp surfaces FIRST (kitPath/setSurface), then streamGroundPass,
 * then props (kit builders mark collision themselves). Deterministic: every
 * random call goes through ctx.rng, which the stream seeds from the zone id —
 * re-entry rebuilds the identical zone. Glow discipline per zone: <=2 ember
 * cubes on the shared window batch, 0-1 kitLantern.
 */
import { registerZoneBuilder, streamGroundPass } from '../stream'
import { S_GRASS, S_SOIL, setSurface, surfaceAt, type Ctx } from '../layout'
import {
  CROP,
  DEAD_WOOD,
  EMBER,
  FLOWER,
  ICE,
  PLASTER,
  ROOF,
  RUIN_STONE,
  SNOW,
  STONE,
  STRAW,
  WOOD,
  WOOD_DARK,
  isLand,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitHouseShell,
  kitHut,
  kitIceSpike,
  kitLantern,
  kitPath,
  kitPine,
  kitRock,
  kitStatue,
  kitTree
} from '../kit'
import type { ZoneDef } from './registry'

// ---------------------------------------------------------------------------
// Local helpers (deterministic — all randomness via ctx.rng)
// ---------------------------------------------------------------------------

/** [x, z, radius] keep-out circles (waystones, landmark pads, road mouths). */
type Avoid = ReadonlyArray<readonly [number, number, number]>

function cellOpen(ctx: Ctx, ix: number, iz: number, avoid: Avoid): boolean {
  if (!isLand(ix + 0.5, iz + 0.5)) return false
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  for (const [ax, az, ar] of avoid) {
    const dx = ix - ax
    const dz = iz - az
    if (dx * dx + dz * dz < ar * ar) return false
  }
  return true
}

/** `tries` random placements across the zone rect (inset 3). Sparse filler. */
function scatterZone(
  ctx: Ctx,
  zone: ZoneDef,
  tries: number,
  avoid: Avoid,
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < tries; i++) {
    const ix = Math.floor(rng.range(zone.x0 + 3, zone.x1 - 3))
    const iz = Math.floor(rng.range(zone.z0 + 3, zone.z1 - 3))
    if (cellOpen(ctx, ix, iz, avoid)) place(ix, iz)
  }
}

/** `tries` random placements inside a circle — cozy-dense landmark rings. */
function scatterRing(
  ctx: Ctx,
  cx: number,
  cz: number,
  r: number,
  tries: number,
  avoid: Avoid,
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < tries; i++) {
    const a = rng.range(0, Math.PI * 2)
    const d = r * Math.sqrt(rng.next())
    const ix = Math.floor(cx + Math.cos(a) * d)
    const iz = Math.floor(cz + Math.sin(a) * d)
    if (cellOpen(ctx, ix, iz, avoid)) place(ix, iz)
  }
}

/** Low cosmetic snowdrift — does NOT block (players wade through). */
function drift(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  batches.misc.add(
    ix + rng.range(-0.2, 0.2), 0, iz + rng.range(-0.2, 0.2),
    rng.range(0.8, 1.6), rng.range(0.12, 0.2), rng.range(0.7, 1.3), SNOW
  )
}

/** Short pine wearing a snow cap. Blocks via kitPine. */
function snowPine(ctx: Ctx, ix: number, iz: number, tall = false): void {
  kitPine(ctx, ix, iz, { tall })
  const h = tall ? 6 : 5 // cap safely above any rolled canopy
  ctx.batches.misc.add(ix + 0.14, h, iz + 0.14, 0.72, 0.22, 0.72, SNOW)
}

/** Felled log bench (non-blocking, cosmetic — campfire seating). */
function logSeat(ctx: Ctx, ix: number, iz: number, alongX: boolean): void {
  const { rng, batches } = ctx
  if (alongX) batches.wood.add(ix, 0, iz, 1.7, 0.45, 0.5, rng.pick(WOOD))
  else batches.wood.add(ix, 0, iz, 0.5, 0.45, 1.7, rng.pick(WOOD))
}

// ---------------------------------------------------------------------------
// deepfreeze — The Deepfreeze (dungeon 75-92, x -240..-80, z -720..-520)
// ---------------------------------------------------------------------------

registerZoneBuilder('deepfreeze', (ctx, _scene, zone) => {
  const { rng, batches, grid } = ctx

  // Approach road in from the east edge (nearest the N arterial) to the gate.
  kitPath(ctx, [
    [-80, -600], [-104, -608], [-128, -604], [-148, -614], [-160, -626], [-165, -629]
  ])
  // Spur north to the Specimen pen.
  kitPath(ctx, [[-130, -606], [-128, -592], [-130, -582]], 1.2)

  streamGroundPass(ctx, zone)

  // LANDMARK 1 — "The Deepfreeze Vault": a professionally-run containment
  // gate set into a stone berm. Two huge pylons, iced lintel, a doorway of
  // pure uninviting darkness, and twin ember braziers so the night shift can
  // see the DO NOT THAW sign they are ignoring.
  {
    const gx = -168 // gate face runs along x = gx..gx+3, opening z -631..-628
    // pylons
    batches.stone.add(gx, 0, -636, 3, 7, 5, rng.pick(STONE))
    batches.stone.add(gx, 0, -628 + 5, 3, 7, 5, rng.pick(STONE)) // z -623..-618
    grid.blockRect(gx, -636, 3, 5)
    grid.blockRect(gx, -623, 3, 5)
    // berm shoulders behind the pylons
    batches.stone.add(gx - 5, 0, -638, 5, 5, 8, rng.pick(STONE))
    batches.stone.add(gx - 5, 0, -625, 5, 5, 8, rng.pick(STONE))
    grid.blockRect(gx - 5, -638, 5, 8)
    grid.blockRect(gx - 5, -625, 5, 8)
    // lintel + ice cornice
    batches.stone.add(gx, 7, -636, 3, 1.6, 18, rng.pick(STONE))
    batches.misc.add(gx + 0.3, 8.6, -634, 2.4, 0.5, 14, rng.pick(ICE))
    for (let i = 0; i < 5; i++) {
      kitIceSpike(ctx, gx - 4 + rng.int(3), -640 + rng.int(3))
      kitIceSpike(ctx, gx - 4 + rng.int(3), -620 + rng.int(3))
    }
    // the doorway: a slab of darkness, walled off (the dungeon interior is a
    // later agent's problem) — approach cells stay walkable
    batches.misc.add(gx + 0.5, 0, -631, 1.2, 6.8, 8, 0x14141c)
    grid.blockRect(gx, -631, 3, 8)
    // twin braziers (the zone's 2 ember-glow uses)
    batches.stone.add(gx + 3.2, 0, -634, 0.8, 1.1, 0.8, rng.pick(STONE))
    batches.window.add(gx + 3.35, 1.1, -633.85, 0.5, 0.45, 0.5, EMBER)
    grid.block(gx + 3, -634)
    batches.stone.add(gx + 3.2, 0, -621.8, 0.8, 1.1, 0.8, rng.pick(STONE))
    batches.window.add(gx + 3.35, 1.1, -621.65, 0.5, 0.45, 0.5, EMBER)
    grid.block(gx + 3, -622)
    // the sign: "DO NOT THAW. YES, THIS MEANS YOU, DAVE." (post + board)
    batches.wood.add(-159.6, 0, -624.6, 0.3, 1.9, 0.3, WOOD_DARK)
    batches.wood.add(-160.5, 1.5, -624.75, 2.1, 0.9, 0.18, rng.pick(WOOD))
    grid.block(-160, -625)
  }

  // LANDMARK 2 — "Specimen 0001": something very large frozen in a very
  // tidy ice cube, fenced, labeled, and absolutely fine. Probably.
  {
    const sx = -133
    const sz = -583
    batches.misc.add(sx + 0.6, 0, sz + 0.6, 2.8, 1.9, 2.8, 0x2b3038) // the occupant
    batches.misc.add(sx, 0, sz, 4, 4, 4, rng.pick(ICE)) // its cube
    batches.misc.add(sx + 0.9, 4, sz + 0.9, 2.2, 0.5, 2.2, SNOW) // snow toupee
    grid.blockRect(sx, sz, 4, 4)
    // regulation fence, gap on the south side where the path arrives
    kitFenceRun(ctx, sx - 3, sz - 3, 10, true) // north run
    kitFenceRun(ctx, sx - 3, sz + 7, 4, true) // south-west run
    kitFenceRun(ctx, sx + 4, sz + 7, 3, true) // south-east run (gap at door)
    kitFenceRun(ctx, sx - 3, sz - 2, 9, false) // west run
    kitFenceRun(ctx, sx + 6, sz - 2, 9, false) // east run
    // clipboard lectern for the professionals
    batches.wood.add(sx + 1.6, 0, sz + 8.2, 0.4, 1.1, 0.4, WOOD_DARK)
    batches.wood.add(sx + 1.3, 1.1, sz + 8, 1, 0.14, 0.8, rng.pick(WOOD))
    grid.block(sx + 1, sz + 8)
  }

  const avoid: Avoid = [[-166, -628, 16], [-131, -581, 10]]
  // frozen wastes scatter: spike fields, rocks, dead trees, drifts
  scatterRing(ctx, -166, -628, 26, 26, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatterZone(ctx, zone, 42, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatterZone(ctx, zone, 12, avoid, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1))
  scatterZone(ctx, zone, 10, avoid, (x, z) => kitDeadTree(ctx, x, z))
  scatterZone(ctx, zone, 40, avoid, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// zero_chill — Absolute Zero Chill (glacier 80-99, x -80..80, z -720..-520)
// waystone ws_zero_chill at (0, -620) — keep clear + reachable
// ---------------------------------------------------------------------------

registerZoneBuilder('zero_chill', (ctx, scene, zone) => {
  const { rng, batches, grid } = ctx

  // The N arterial already runs up this zone (x ~ 0..8). Spur west to the
  // waystone pad, east to the Frost Throne, and on north to the Pole.
  kitPath(ctx, [[7, -618], [3, -620], [0, -620]], 1.2) // waystone pad
  kitPath(ctx, [[8, -602], [20, -597], [32, -601], [41, -600]]) // throne spur
  kitPath(ctx, [[1, -656], [-1, -664], [-1, -669]], 1.2) // pole spur

  streamGroundPass(ctx, zone)

  // LANDMARK 1 — "The Actual Pole": a candy-striped pole on an ice dais at
  // the literal top of the world, with a sign reading "THE TOP. CONGRATS.
  // NOW WHAT?" Explorers' flags frozen mid-flap all around it.
  {
    const px = -2
    const pz = -672
    batches.misc.add(px - 2, 0, pz - 2, 5, 0.3, 5, rng.pick(ICE)) // dais (walkable)
    for (let y = 0; y < 5; y++) {
      batches.wood.add(px + 0.3, 0.3 + y * 0.7, pz + 0.3, 0.4, 0.7, 0.4, y % 2 === 0 ? 0xd94f4f : 0xf2f5f9)
    }
    batches.misc.add(px + 0.2, 3.8, pz + 0.2, 0.6, 0.5, 0.6, STRAW) // gold-ish knob
    grid.block(px, pz)
    // the sign
    batches.wood.add(px + 2.2, 0.3, pz + 1.2, 0.3, 1.7, 0.3, WOOD_DARK)
    batches.wood.add(px + 1.4, 1.5, pz + 1.1, 1.9, 0.8, 0.18, rng.pick(WOOD))
    grid.block(px + 2, pz + 1)
    // frozen expedition flags (posts + stiff little banners)
    for (let i = 0; i < 4; i++) {
      const fx = px + rng.int(9) - 4
      const fz = pz + rng.int(7) - 5
      if (!cellOpen(ctx, fx, fz, [[px, pz, 2]])) continue
      batches.wood.add(fx + 0.35, 0, fz + 0.35, 0.22, 2, 0.22, WOOD_DARK)
      batches.misc.add(fx + 0.55, 1.5, fz + 0.3, 0.9, 0.5, 0.12, rng.pick(FLOWER))
      grid.block(fx, fz)
    }
  }

  // LANDMARK 2 — "The Frost Throne": an empty oversized ice throne facing
  // south, waiting for anyone arrogant enough to sit on bare ice at -60.
  {
    const tx = 42
    const tz = -602
    batches.misc.add(tx - 2, 0, tz - 1, 6, 0.3, 5, rng.pick(ICE)) // dais
    batches.misc.add(tx - 1, 0.3, tz - 0.5, 4, 0.4, 3.4, rng.pick(ICE)) // step
    batches.misc.add(tx, 0.7, tz, 2, 1, 2, rng.pick(ICE)) // seat
    batches.misc.add(tx - 0.4, 0.7, tz + 0.2, 0.5, 2.1, 1.6, rng.pick(ICE)) // armrest
    batches.misc.add(tx + 1.9, 0.7, tz + 0.2, 0.5, 2.1, 1.6, rng.pick(ICE))
    batches.misc.add(tx - 0.2, 1.7, tz + 1.6, 2.4, 3.4, 0.7, rng.pick(ICE)) // back
    batches.misc.add(tx + 0.7, 5.1, tz + 1.7, 1, 0.9, 0.5, rng.pick(ICE)) // spike crown
    grid.blockRect(tx - 1, tz, 4, 3)
  }

  // The last warm thing on the continent: one campfire + log seats, just off
  // the waystone pad (zone's only ember use), and one lantern so the pad is
  // findable in a whiteout (zone's one PointLight).
  kitCampfire(ctx, 7, -613)
  logSeat(ctx, 5.2, -611.4, true)
  logSeat(ctx, 9.4, -614.6, false)
  kitLantern(ctx, scene, -4, -612)

  const avoid: Avoid = [[0, -620, 6], [-2, -672, 10], [42, -601, 8], [7, -613, 3]]
  // glacier spike forest — dense; this zone is 90% sharp ice and spite
  scatterZone(ctx, zone, 90, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatterRing(ctx, 20, -650, 22, 22, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatterZone(ctx, zone, 14, avoid, (x, z) => kitRock(ctx, x, z, rng.next() < 0.4 ? 2 : 1))
  scatterZone(ctx, zone, 55, avoid, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// permafrost_parade — Permafrost Parade (tundra 47-59, x -240..-80, z -520..-360)
// ---------------------------------------------------------------------------

registerZoneBuilder('permafrost_parade', (ctx, _scene, zone) => {
  const { rng, batches, grid } = ctx

  // The promenade itself: a grand frozen avenue from the east edge (toward
  // the N arterial) to a plaza at the west end.
  kitPath(ctx, [
    [-80, -440], [-110, -438], [-140, -442], [-170, -439], [-196, -441]
  ], 2.2)

  streamGroundPass(ctx, zone)

  // LANDMARK 1 — "The Parade of Probably-Statues": heroes flank the avenue.
  // Most are stone. Some are just very patient. Nobody checks anymore.
  const rows: ReadonlyArray<readonly [number, number]> = [
    [-105, -450], [-105, -433], [-125, -451], [-125, -432],
    [-145, -450], [-145, -433], [-165, -451], [-165, -432]
  ]
  for (const [sx, sz] of rows) kitStatue(ctx, sx, sz)
  // west-end plaza: dais + the founder, slightly bigger ego
  batches.stone.add(-203, 0, -445, 7, 0.4, 8, rng.pick(STONE))
  kitStatue(ctx, -201, -443)
  kitIceSpike(ctx, -204, -447)
  kitIceSpike(ctx, -197, -438)

  // LANDMARK 2 — "The Quitter": one hero face-down off the row, plinth
  // vacant, head rolled a polite distance away. Mid-parade resignation.
  {
    const qx = -135
    const qz = -458
    batches.stone.add(qx, 0, qz, 3, 0.5, 3, rng.pick(STONE)) // empty plinth
    grid.blockRect(qx, qz, 3, 3)
    batches.stone.add(qx + 3.6, 0, qz + 0.8, 3.4, 0.9, 1.6, rng.pick(RUIN_STONE)) // body, face-down
    batches.stone.add(qx + 4.2, 0.9, qz + 1, 1.2, 0.5, 1.2, rng.pick(RUIN_STONE)) // back
    grid.blockRect(qx + 3, qz, 4, 2)
    batches.stone.add(qx + 8.3, 0, qz + 2.4, 1.1, 1.1, 1.1, rng.pick(RUIN_STONE)) // the head
    grid.block(qx + 8, qz + 2)
    drift(ctx, qx + 5, qz + 1)
  }

  // statue-enthusiast camp (the zone's one ember use)
  kitCampfire(ctx, -112, -462)
  logSeat(ctx, -114.2, -460.6, true)
  logSeat(ctx, -110.2, -464.4, true)

  const avoid: Avoid = [[-140, -441, 4], [-201, -442, 9], [-135, -457, 8], [-112, -462, 4]]
  scatterZone(ctx, zone, 34, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatterZone(ctx, zone, 12, avoid, (x, z) => kitDeadTree(ctx, x, z))
  scatterZone(ctx, zone, 12, avoid, (x, z) => kitRock(ctx, x, z, 1))
  scatterZone(ctx, zone, 10, avoid, (x, z) => snowPine(ctx, x, z))
  scatterZone(ctx, zone, 45, avoid, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// north_roads_end — The North Road's End (tundra 45-56, x -80..80, z -520..-360)
// waystone ws_north_roads_end at (0, -440) — keep clear + reachable
// ---------------------------------------------------------------------------

registerZoneBuilder('north_roads_end', (ctx, scene, zone) => {
  const { rng, batches, grid } = ctx

  // The N arterial passes (10, -440). Pad to the waystone, spur to the spot
  // where the highway officially stops caring.
  kitPath(ctx, [[8, -440], [4, -440], [0, -440]], 1.2) // waystone pad
  kitPath(ctx, [[11, -444], [17, -448], [24, -452], [30, -453]]) // give-up spur

  streamGroundPass(ctx, zone)

  // LANDMARK 1 — "The Giving-Up Point": the King's last milestone — a big
  // smug obelisk — plus a signpost whose arms point everywhere, none of them
  // helpfully, and a snowed-in toll booth that has never collected a toll.
  {
    const ox = 31
    const oz = -455
    batches.stone.add(ox - 0.5, 0, oz - 0.5, 2, 0.5, 2, rng.pick(STONE)) // plinth
    batches.stone.add(ox - 0.1, 0.5, oz - 0.1, 1.2, 3.6, 1.2, rng.pick(STONE))
    batches.stone.add(ox + 0.1, 4.1, oz + 0.1, 0.8, 0.7, 0.8, rng.pick(STONE)) // cap
    batches.misc.add(ox - 0.2, 4.6, oz - 0.2, 1.4, 0.2, 1.4, SNOW)
    grid.blockRect(ox - 1, oz - 1, 3, 3)
    // the signpost of lies — four arms, four directions, zero accuracy
    const px = ox + 4
    const pz = oz + 3
    batches.wood.add(px + 0.35, 0, pz + 0.35, 0.3, 3.2, 0.3, WOOD_DARK)
    batches.wood.add(px - 0.8, 2.7, pz + 0.3, 1.9, 0.35, 0.16, rng.pick(WOOD))
    batches.wood.add(px + 0.4, 2.2, pz - 0.7, 0.16, 0.35, 1.8, rng.pick(WOOD))
    batches.wood.add(px - 0.1, 1.7, pz + 0.3, 1.4, 0.35, 0.16, rng.pick(WOOD))
    batches.wood.add(px + 0.4, 1.2, pz + 0.1, 0.16, 0.35, 1.2, rng.pick(WOOD))
    grid.block(px, pz)
    // the toll booth (staff: one hut, zero staff)
    kitHut(ctx, ox + 6, oz - 7)
    drift(ctx, ox + 6.5, oz - 3.2)
    drift(ctx, ox + 8.8, oz - 7.6)
  }

  // LANDMARK 2 — "The Optimist's Caravan": somebody read the milestone,
  // said "how bad can it be", and kept going. Wagon: abandoned. Cargo:
  // looted by reindeer. Fire: still going, suspiciously.
  {
    const wx = 20
    const wz = -464
    batches.wood.add(wx, 0.5, wz, 3.2, 1.1, 1.8, rng.pick(WOOD)) // tilted bed
    batches.wood.add(wx + 2.8, 0.2, wz + 0.1, 1.2, 0.9, 1.6, rng.pick(DEAD_WOOD)) // collapsed end
    batches.misc.add(wx + 0.2, 1.6, wz + 0.1, 2.6, 0.5, 1.6, SNOW) // snow cargo
    batches.wood.add(wx - 0.3, 0, wz - 0.3, 0.25, 1, 1, WOOD_DARK) // wheels
    batches.wood.add(wx - 0.3, 0, wz + 1.2, 0.25, 1, 1, WOOD_DARK)
    batches.wood.add(wx + 3.4, 0, wz - 0.2, 0.25, 0.8, 0.8, WOOD_DARK)
    grid.blockRect(wx, wz, 4, 2)
    batches.wood.add(wx + 4.6, 0, wz + 1.8, 0.7, 0.7, 0.7, rng.pick(WOOD)) // dropped crate
    grid.block(wx + 4, wz + 1)
    kitCampfire(ctx, wx - 3, wz + 1) // the zone's one ember use
    logSeat(ctx, wx - 4.4, wz - 0.6, true)
  }

  // one lantern marks where the road gives up (the zone's one PointLight)
  kitLantern(ctx, scene, 27, -450)

  const avoid: Avoid = [[0, -440, 6], [31, -453, 12], [20, -463, 8], [10, -440, 4]]
  scatterZone(ctx, zone, 26, avoid, (x, z) => snowPine(ctx, x, z, rng.next() < 0.3))
  scatterZone(ctx, zone, 14, avoid, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1))
  scatterZone(ctx, zone, 10, avoid, (x, z) => kitDeadTree(ctx, x, z))
  scatterZone(ctx, zone, 12, avoid, (x, z) => kitIceSpike(ctx, x, z))
  scatterZone(ctx, zone, 40, avoid, (x, z) => drift(ctx, x, z))
})

// ---------------------------------------------------------------------------
// bracing_pines — The Bracing Pines (forest 10-16, x -240..-80, z -360..-240)
// ---------------------------------------------------------------------------

registerZoneBuilder('bracing_pines', (ctx, scene, zone) => {
  const { rng, batches, grid } = ctx

  // Trail in from the east edge (toward the N arterial) to the Hoard, with
  // a spur to the warden's cottage door.
  kitPath(ctx, [
    [-80, -300], [-100, -305], [-120, -299], [-137, -306], [-148, -311]
  ])
  kitPath(ctx, [[-120, -299], [-124, -292], [-125, -290]], 1.2)

  streamGroundPass(ctx, zone)

  // LANDMARK 1 — "The Doomsday Hoard": the squirrels' strategic pinecone
  // reserve. A fenced mound of several winters' worth of cones, plus a
  // watchtower sized for a sentry that weighs half a pound.
  {
    const hx = -154
    const hz = -316
    // fence ring, gap on the east where the trail arrives
    kitFenceRun(ctx, hx - 1, hz - 1, 11, true)
    kitFenceRun(ctx, hx - 1, hz + 9, 11, true)
    kitFenceRun(ctx, hx - 1, hz, 4, false)
    kitFenceRun(ctx, hx - 1, hz + 6, 3, false)
    kitFenceRun(ctx, hx + 9, hz, 9, false)
    // the mound — pinecone-shaped nuggets heaped two layers deep
    for (let i = 0; i < 26; i++) {
      batches.wood.add(
        hx + 2 + rng.range(0, 4.6), 0, hz + 2 + rng.range(0, 4.6),
        0.55, rng.range(0.4, 0.6), 0.55, rng.next() < 0.5 ? WOOD_DARK : rng.pick(WOOD)
      )
    }
    for (let i = 0; i < 12; i++) {
      batches.wood.add(
        hx + 3 + rng.range(0, 2.6), 0.55, hz + 3 + rng.range(0, 2.6),
        0.5, 0.5, 0.5, rng.pick(DEAD_WOOD)
      )
    }
    batches.wood.add(hx + 4, 1.05, hz + 4, 0.5, 0.5, 0.5, WOOD_DARK) // crowning cone
    grid.blockRect(hx + 2, hz + 2, 5, 5)
    // the watchtower (tiny platform, tiny roof, huge responsibility)
    const tx = hx + 7
    const tz = hz + 7
    batches.wood.add(tx + 0.1, 0, tz + 0.1, 0.25, 3, 0.25, WOOD_DARK)
    batches.wood.add(tx + 1.1, 0, tz + 0.1, 0.25, 3, 0.25, WOOD_DARK)
    batches.wood.add(tx + 0.1, 0, tz + 1.1, 0.25, 3, 0.25, WOOD_DARK)
    batches.wood.add(tx + 1.1, 0, tz + 1.1, 0.25, 3, 0.25, WOOD_DARK)
    batches.wood.add(tx - 0.1, 3, tz - 0.1, 1.7, 0.2, 1.7, rng.pick(WOOD))
    batches.roof.add(tx - 0.2, 4.1, tz - 0.2, 1.9, 0.4, 1.9, rng.pick(ROOF))
    grid.blockRect(tx, tz, 2, 2)
  }

  // LANDMARK 2 — "The Warden's Cottage": home of the one park warden who
  // files annual reports about "organized rodent activity". Nobody reads them.
  kitHouseShell(ctx, { x0: -131, z0: -293, w: 6, d: 5, wallH: 3, door: 'E', chimney: true })
  kitFenceRun(ctx, -133, -295, 4, true) // a gesture of a garden fence
  kitLantern(ctx, scene, -124, -293) // porch light (the zone's one PointLight)

  const avoid: Avoid = [[-150, -311, 13], [-128, -291, 7]]
  // crisp evergreen woods — cozy-dense near the Hoard, breathable between
  scatterRing(ctx, -150, -312, 24, 42, avoid, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.4 }))
  scatterZone(ctx, zone, 85, avoid, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.25 }))
  scatterZone(ctx, zone, 16, avoid, (x, z) => kitTree(ctx, x, z))
  scatterZone(ctx, zone, 10, avoid, (x, z) => kitRock(ctx, x, z, 1))
  // hoard overflow: cones the squirrels dropped on the commute
  scatterRing(ctx, -150, -312, 18, 14, avoid, (x, z) => {
    batches.wood.add(x + 0.3, 0, z + 0.3, 0.4, 0.4, 0.4, WOOD_DARK)
  })
})

// ---------------------------------------------------------------------------
// kings_back_lawn — The King's Back Lawn (meadow 10-15, x -80..80, z -360..-240)
// waystone ws_kings_back_lawn at (0, -300) — keep clear + reachable
// ---------------------------------------------------------------------------

registerZoneBuilder('kings_back_lawn', (ctx, scene, zone) => {
  const { rng, batches, grid } = ctx

  // The N arterial passes (14, -300). Pad west to the waystone, lane on to
  // the pavilion, side-lane to the topiary garden.
  kitPath(ctx, [[12, -300], [6, -300], [0, -300]], 1.2) // waystone pad
  kitPath(ctx, [[12, -296], [-2, -289], [-16, -291], [-28, -289]]) // pavilion lane
  kitPath(ctx, [[14, -306], [20, -314], [25, -318]], 1.2) // topiary lane

  // royal farm plots — tilled, abandoned, thriving out of spite
  for (let ix = -46; ix < -36; ix++) {
    for (let iz = -334; iz < -327; iz++) setSurface(ctx, ix, iz, S_SOIL)
  }
  for (let ix = -32; ix < -22; ix++) {
    for (let iz = -336; iz < -329; iz++) setSurface(ctx, ix, iz, S_SOIL)
  }

  streamGroundPass(ctx, zone)

  // LANDMARK 1 — "The Royal Picnic Pavilion (Condemned)": six proud posts, a
  // sagging green roof, one overturned table, and crockery the crown never
  // sent anyone back to collect.
  {
    const vx = -34
    const vz = -292
    const posts: ReadonlyArray<readonly [number, number]> = [
      [vx, vz], [vx + 6, vz], [vx, vz + 5], [vx + 6, vz + 5], [vx + 3, vz], [vx + 3, vz + 5]
    ]
    for (const [px, pz] of posts) {
      batches.wood.add(px + 0.3, 0, pz + 0.3, 0.4, 3, 0.4, WOOD_DARK)
      grid.block(px, pz)
    }
    batches.roof.add(vx - 0.7, 3, vz - 0.7, 8.4, 0.5, 7.4, rng.pick(ROOF))
    batches.roof.add(vx + 0.6, 3.5, vz + 0.5, 5.8, 0.5, 5, rng.pick(ROOF))
    batches.roof.add(vx + 2, 4, vz + 1.6, 3, 0.5, 2.8, rng.pick(ROOF))
    // the overturned table + a loyal bench
    batches.wood.add(vx + 1.6, 0, vz + 1.8, 0.3, 1.9, 1.1, rng.pick(WOOD)) // table on its side
    batches.wood.add(vx + 1.1, 0.5, vz + 2.1, 0.5, 0.3, 0.5, WOOD_DARK) // a leg, skyward
    grid.block(vx + 1, vz + 2)
    batches.wood.add(vx + 4, 0, vz + 3.4, 1.8, 0.5, 0.5, rng.pick(WOOD))
    // scattered royal crockery
    for (let i = 0; i < 6; i++) {
      batches.misc.add(
        vx + rng.range(0.5, 6), 0, vz + rng.range(0.5, 4.6),
        0.3, 0.08, 0.3, rng.pick(PLASTER)
      )
    }
  }

  // LANDMARK 2 — "The Topiary Graveyard": the royal hedge-sculptures, unmown
  // for a decade. The swan is now a threat. The corgi is now a hill.
  {
    const gx = 22
    const gz = -324
    kitFenceRun(ctx, gx - 2, gz - 2, 12, true)
    kitFenceRun(ctx, gx - 2, gz + 8, 5, true)
    kitFenceRun(ctx, gx + 5, gz + 8, 5, true) // gap at the gate
    kitFenceRun(ctx, gx - 2, gz - 1, 9, false)
    kitFenceRun(ctx, gx + 9, gz - 1, 9, false)
    // the swan (now a threat): shaggy body + a neck with opinions
    batches.leaf.add(gx, 0, gz, 2.6, 1.8, 2, 0x3f8f3d)
    batches.leaf.add(gx + 0.4, 1.8, gz + 0.5, 1.6, 0.8, 1.2, 0x55a449)
    batches.leaf.add(gx + 2.3, 0.8, gz + 0.7, 0.7, 2.6, 0.7, 0x337c38) // neck
    batches.leaf.add(gx + 2.2, 3.4, gz + 0.55, 1.2, 0.7, 1, 0x55a449) // head
    grid.blockRect(gx, gz, 3, 2)
    // the corgi (now a hill)
    batches.leaf.add(gx + 5, 0, gz + 3, 3, 1.2, 2.2, 0x4f9d3f)
    batches.leaf.add(gx + 5.4, 1.2, gz + 3.4, 2.2, 0.6, 1.4, 0x55a449)
    grid.blockRect(gx + 5, gz + 3, 3, 2)
    // something that was once either a lion or the old king. nobody asks.
    batches.leaf.add(gx + 1, 0, gz + 5, 2, 2.6, 2, 0x337c38)
    batches.leaf.add(gx + 1.4, 2.6, gz + 5.4, 1.2, 1, 1.2, 0x3f8f3d)
    grid.blockRect(gx + 1, gz + 5, 2, 2)
    // one rusting shear, dropped mid-shift
    batches.misc.add(gx + 4, 0, gz + 0.6, 1.1, 0.12, 0.3, 0x8a6a4a)
  }

  // overgrown crop rows in the abandoned plots (non-blocking tufts)
  for (let i = 0; i < 24; i++) {
    const cx = -46 + rng.int(10)
    const cz = -334 + rng.int(7)
    batches.leaf.add(cx + 0.3, 0, cz + 0.3, 0.4, rng.range(0.4, 0.9), 0.4, rng.pick(CROP))
  }
  for (let i = 0; i < 24; i++) {
    const cx = -32 + rng.int(10)
    const cz = -336 + rng.int(7)
    batches.leaf.add(cx + 0.3, 0, cz + 0.3, 0.4, rng.range(0.4, 0.9), 0.4, rng.pick(CROP))
  }
  kitFenceRun(ctx, -47, -335, 12, true)
  kitFenceRun(ctx, -47, -326, 6, true)

  // pavilion porch light (the zone's one PointLight)
  kitLantern(ctx, scene, -26, -288)

  const avoid: Avoid = [[0, -300, 6], [-31, -290, 9], [26, -320, 10], [-36, -331, 10], [14, -300, 4]]
  // rolling lawn: sparse oaks, loud flowers, the occasional boulder the
  // groundskeeper mows around out of respect
  scatterZone(ctx, zone, 22, avoid, (x, z) => kitTree(ctx, x, z))
  scatterZone(ctx, zone, 6, avoid, (x, z) => kitRock(ctx, x, z, 1))
  scatterZone(ctx, zone, 90, avoid, (x, z) => {
    batches.misc.add(x + rng.range(0.1, 0.6), 0, z + rng.range(0.1, 0.6), 0.22, 0.3, 0.22, rng.pick(FLOWER))
  })
  scatterRing(ctx, -31, -290, 14, 20, avoid, (x, z) => {
    batches.misc.add(x + rng.range(0.1, 0.6), 0, z + rng.range(0.1, 0.6), 0.22, 0.3, 0.22, rng.pick(FLOWER))
  })
})

// ---------------------------------------------------------------------------
// Barrel hook
// ---------------------------------------------------------------------------

/**
 * Register the six True-North zone builders. Registration also runs at
 * import time (the stream auto-globs zone batch files); this call is
 * idempotent — the registry is last-write-wins with identical builders.
 */
export function registerBatch3(): void {
  // Builders above register at module scope; nothing further to do. The
  // function exists so the zones/index barrel has an explicit hook to call.
}
