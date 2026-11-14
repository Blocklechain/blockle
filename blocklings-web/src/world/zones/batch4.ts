/**
 * src/world/zones/batch4.ts — ZONE BATCH 4: north-center-east (taiga above
 * Greenwood). Six zones, ZONE_BATCHES[3]:
 *
 *   yeti_pastures      tundra  60-75  (80..240,  -720..-520)
 *   slip_n_slayed      glacier 64-79  (240..360, -720..-520)
 *   pinecone_gauntlet  forest  46-58  (80..240,  -520..-360)
 *   frostbitten_fields tundra  48-60  (240..360, -520..-360)
 *   whistlewood        forest  12-18  (80..240,  -360..-240)
 *   greenwood_heights  forest  15-24  (240..360, -360..-240)
 *
 * Builder contract per the streaming core: stamp surfaces FIRST (kitPath /
 * setSurface), then streamGroundPass, then props (kit builders mark their
 * own collision). Everything is deterministic off ctx.rng (seeded from the
 * zone id by the stream), so re-entry rebuilds the identical zone and the
 * permanent collision marks always line up.
 *
 * Budget notes: lights — exactly 3 kitLanterns across all six zones (0-1
 * each); ember glow — one kitCampfire per zone max; every zone lands well
 * under 10k instances (ground macro-tiling dominates).
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import type { ZoneDef } from './registry'
import { S_GRASS, S_SOIL, setSurface, surfaceAt, type Ctx } from '../layout'
import {
  BONE_WHITE,
  ICE,
  isLand,
  kitBone,
  kitCampfire,
  kitFenceRun,
  kitGrave,
  kitHouseShell,
  kitIceSpike,
  kitLantern,
  kitPath,
  kitPine,
  kitRock,
  kitTotem,
  kitTree,
  PINE_LEAF,
  ROOF,
  STONE,
  STRAW,
  WINDOW_GLOW,
  WOOD,
  WOOD_DARK
} from '../kit'

// ---------------------------------------------------------------------------
// Local flavor colors (flat-color voxel vocabulary, village-harmonious)
// ---------------------------------------------------------------------------

const SNOW_WHITE = 0xeef3f6
const WOOL = [0xe9edf0, 0xdde4e8, 0xf2f5f7] as const
const CARROT = 0xd97b35
const TURNIP_SKIN = [0xead9e4, 0xf4ece9] as const
const TURNIP_TOP = 0xb867a8

// ---------------------------------------------------------------------------
// Shared scatter helper — deterministic rejection sampling inside the zone
// rect (or a cluster disc), skipping ocean, stamped surfaces and keep-outs.
// ---------------------------------------------------------------------------

/** Keep-out disc: [x, z, radius]. */
type Spot = readonly [number, number, number]

interface ScatterOpts {
  /** Cluster center + radius — omit to scatter across the whole rect. */
  around?: readonly [number, number, number]
  keepOut?: readonly Spot[]
  pad?: number
}

function scatter(
  ctx: Ctx,
  zone: ZoneDef,
  n: number,
  place: (ix: number, iz: number) => void,
  opts: ScatterOpts = {}
): void {
  const { rng } = ctx
  const pad = opts.pad ?? 5
  const keepOut = opts.keepOut ?? []
  let placed = 0
  for (let tries = 0; placed < n && tries < n * 7; tries++) {
    let ix: number
    let iz: number
    if (opts.around) {
      const [cx, cz, cr] = opts.around
      const a = rng.range(0, Math.PI * 2)
      const r = Math.sqrt(rng.next()) * cr
      ix = Math.floor(cx + Math.cos(a) * r)
      iz = Math.floor(cz + Math.sin(a) * r)
    } else {
      ix = Math.floor(rng.range(zone.x0 + pad, zone.x1 - pad))
      iz = Math.floor(rng.range(zone.z0 + pad, zone.z1 - pad))
    }
    if (ix < zone.x0 + pad || ix >= zone.x1 - pad || iz < zone.z0 + pad || iz >= zone.z1 - pad) continue
    // stay off the ocean (with prop-sized elbow room) and off stamped surfaces
    if (!isLand(ix + 0.5, iz + 0.5) || !isLand(ix + 3.5, iz + 0.5) || !isLand(ix + 0.5, iz - 3.5)) continue
    if (surfaceAt(ctx, ix, iz) !== S_GRASS) continue
    let bad = false
    for (const [kx, kz, kr] of keepOut) {
      const dx = ix - kx
      const dz = iz - kz
      if (dx * dx + dz * dz < kr * kr) {
        bad = true
        break
      }
    }
    if (bad) continue
    place(ix, iz)
    placed++
  }
}

// ===========================================================================
// yeti_pastures — "Free-range yetis roam here, and no, they are not cuddly."
// ===========================================================================
// LANDMARK 1: The Cuddle-Free Paddock — a yeti-wool ranching operation that
//   ended badly: fenced paddock, shed wool everywhere, an overturned trough,
//   a warning totem at the gate, and the rancher's cold little campfire.
// LANDMARK 2: Sir Snowman the Enormous — a towering snowman the yetis built
//   themselves. Nobody knows why. Nobody is asking them.
// ~700 props + ~7.5k ground ≈ 8.2k instances.
function buildYetiPastures(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx
  void scene

  // --- 1. surfaces: herder's trail in from the west edge (N arterial side)
  kitPath(ctx, [
    [80, -604],
    [102, -612],
    [124, -606],
    [140, -618] // paddock gate
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Cuddle-Free Paddock (centered ~ (152, -624))
  const px = 142
  const pz = -636
  const pw = 20
  const pd = 24
  // fence ring with a 3-cell gate on the west side at the path mouth
  kitFenceRun(ctx, px, pz, pw, true) // north run
  kitFenceRun(ctx, px, pz + pd - 1, pw, true) // south run
  kitFenceRun(ctx, px + pw - 1, pz, pd, false) // east run
  kitFenceRun(ctx, px, pz, 15, false) // west run, upper
  kitFenceRun(ctx, px, pz + 20, 4, false) // west run, lower (gate at z -619..-617)
  kitTotem(ctx, px - 2, pz + 15) // the warning totem: tiers say "NO HUGS"
  // shed yeti wool — big soft clumps inside the paddock
  for (let i = 0; i < 14; i++) {
    const wx = px + 2 + rng.range(0, pw - 5)
    const wz = pz + 2 + rng.range(0, pd - 5)
    batches.misc.add(wx, 0, wz, 0.9 + rng.range(0, 0.7), 0.4 + rng.range(0, 0.5), 0.9 + rng.range(0, 0.7), rng.pick(WOOL))
  }
  // the overturned feeding trough (yetis prefer ranchers, apparently)
  batches.wood.add(px + 8, 0, pz + 10, 3, 0.5, 1.2, rng.pick(WOOD))
  batches.wood.add(px + 8.2, 0.5, pz + 10.6, 2.6, 0.4, 0.3, WOOD_DARK)
  grid.blockRect(px + 8, pz + 10, 3, 1)
  kitBone(ctx, px + 5, pz + 6)
  kitBone(ctx, px + 13, pz + 17)
  // the rancher's last campfire, just outside the gate (EMBER use 1 of 1)
  kitCampfire(ctx, px - 4, pz + 17)

  // --- landmark 2: Sir Snowman the Enormous (~ (204, -572))
  const sx = 203
  const sz = -573
  batches.misc.add(sx, 0, sz, 3, 2.2, 3, SNOW_WHITE) // base boulder
  batches.misc.add(sx + 0.4, 2.2, sz + 0.4, 2.2, 1.8, 2.2, SNOW_WHITE) // torso
  batches.misc.add(sx + 0.8, 4, sz + 0.8, 1.4, 1.3, 1.4, SNOW_WHITE) // head
  batches.stone.add(sx + 1.05, 4.75, sz + 0.72, 0.25, 0.25, 0.2, 0x2d2d33) // eyes
  batches.stone.add(sx + 1.7, 4.75, sz + 0.72, 0.25, 0.25, 0.2, 0x2d2d33)
  batches.misc.add(sx + 1.35, 4.35, sz - 0.1, 0.3, 0.3, 1, CARROT) // carrot nose
  batches.wood.add(sx - 1.2, 3.1, sz + 1.35, 1.7, 0.22, 0.22, WOOD_DARK) // stick arms
  batches.wood.add(sx + 2.5, 3.1, sz + 1.35, 1.7, 0.22, 0.22, WOOD_DARK)
  batches.roof.add(sx + 0.95, 5.3, sz + 0.95, 1.1, 0.6, 1.1, rng.pick(ROOF)) // bucket hat
  grid.blockRect(sx, sz, 3, 3)

  // --- 4. scatter: cozy-dense near the landmarks, sparse elsewhere
  const keepOut: Spot[] = [[152, -624, 17], [204, -572, 5], [90, -606, 4]]
  scatter(ctx, zone, 12, (x, z) => kitIceSpike(ctx, x, z), { around: [152, -624, 26], keepOut })
  scatter(ctx, zone, 8, (x, z) => kitPine(ctx, x, z, { leaves: PINE_LEAF }), { around: [204, -572, 20], keepOut })
  scatter(ctx, zone, 26, (x, z) => kitIceSpike(ctx, x, z), { keepOut })
  scatter(ctx, zone, 18, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1), { keepOut })
  scatter(ctx, zone, 12, (x, z) => kitPine(ctx, x, z), { keepOut })
  scatter(ctx, zone, 6, (x, z) => kitBone(ctx, x, z), { keepOut })
}

// ===========================================================================
// slip_n_slayed — "An ice sheet with a kill count and a bit of an attitude."
// ===========================================================================
// LANDMARK 1: The Luge of Regret — a walled ice chute some genius built for
//   "fun", ending in a sled wreck and a debris field.
// LANDMARK 2: The Leaderboard — a tidy row of headstones at the crash site,
//   ranked by distance achieved. Management is very proud of the record.
// ~550 props + ~5.5k ground ≈ 6.1k instances.
function buildSlipNSlayed(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx
  void scene

  // --- 1. surfaces: spectator trail in from the SE corner (NE arterial side)
  kitPath(ctx, [
    [356, -524],
    [340, -546],
    [322, -568],
    [308, -596] // crash site
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Luge of Regret — chute runs north→south, x≈300
  const cx = 299 // chute west wall x
  for (let z = -676; z <= -618; z++) {
    if (!isLand(cx + 1.5, z + 0.5)) continue
    // polished deck (walkable low sheen) + low side walls (blocked)
    batches.misc.add(cx + 1, 0, z, 3, 0.14, 1, rng.pick(ICE))
    if (z % 2 === 0) {
      batches.misc.add(cx, 0, z, 1, 0.9, 1, rng.pick(ICE))
      batches.misc.add(cx + 4, 0, z, 1, 0.9, 1, rng.pick(ICE))
      grid.block(cx, z)
      grid.block(cx + 4, z)
    }
  }
  // launch platform at the top, with a flag nobody salutes anymore
  batches.stone.add(cx - 1, 0, -681, 7, 0.6, 4, rng.pick(STONE))
  grid.blockRect(cx - 1, -681, 1, 4)
  grid.blockRect(cx + 5, -681, 1, 4)
  batches.wood.add(cx + 5.3, 0.6, -680.7, 0.3, 3.4, 0.3, WOOD_DARK)
  batches.roof.add(cx + 5.6, 3.2, -680.6, 1.3, 0.8, 0.15, rng.pick(ROOF))
  // the wreck: a sled that found out, violently (~(306, -608))
  batches.wood.add(304, 0, -610, 2.6, 0.3, 1.2, rng.pick(WOOD))
  batches.wood.add(304.3, 0.3, -609.6, 2, 0.26, 0.4, WOOD_DARK)
  batches.wood.add(306.8, 0.1, -611.4, 1.4, 0.3, 0.9, rng.pick(WOOD)) // snapped-off half
  batches.misc.add(303.2, 0, -608.6, 0.8, 0.8, 0.8, rng.pick(WOOL)) // flung cargo
  batches.misc.add(307.6, 0, -607.8, 0.7, 0.6, 0.7, rng.pick(BONE_WHITE))
  grid.blockRect(304, -611, 4, 3)
  kitBone(ctx, 301, -606)

  // --- landmark 2: The Leaderboard — headstones ranked by distance
  for (let i = 0; i < 6; i++) {
    kitGrave(ctx, 311 + i * 2, -604)
  }
  kitGrave(ctx, 313, -600) // current record holder gets the front row

  // --- 4. scatter: the ice sheet bristles, denser around the chute
  const keepOut: Spot[] = [[301, -648, 8], [308, -605, 14]]
  scatter(ctx, zone, 20, (x, z) => kitIceSpike(ctx, x, z), { around: [301, -646, 30], keepOut })
  scatter(ctx, zone, 34, (x, z) => kitIceSpike(ctx, x, z), { keepOut })
  scatter(ctx, zone, 14, (x, z) => kitRock(ctx, x, z, rng.next() < 0.35 ? 2 : 1), { keepOut })
  scatter(ctx, zone, 5, (x, z) => kitBone(ctx, x, z), { keepOut })
}

// ===========================================================================
// pinecone_gauntlet — "Pines that drop their cones with malicious timing."
// ===========================================================================
// LANDMARK 1: The Mother Cone — a pinecone the size of a shed, enshrined on
//   a plinth and ringed with the dented helmets of the insufficiently agile.
// LANDMARK 2: Flinch Tower — a ranger lookout on stilts; the rangers watch
//   the canopy, never the horizon. (1 kitLantern at its base.)
// ~2.3k props + ~6.3k ground ≈ 8.6k instances.
function buildPineconeGauntlet(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx

  // --- 1. surfaces: trail in from the west edge (N arterial side) + spur
  kitPath(ctx, [
    [80, -442],
    [104, -450],
    [130, -444],
    [158, -441] // the Mother Cone
  ])
  kitPath(ctx, [
    [130, -444],
    [122, -466],
    [119, -477] // Flinch Tower
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Mother Cone (~ (160, -442))
  const mx = 158
  const mz = -444
  batches.stone.add(mx - 1, 0, mz - 1, 5, 0.5, 5, rng.pick(STONE)) // plinth
  // the cone itself: stacked scale rings, fat to tip
  const CONE = [0x5c452a, 0x6b522f, 0x4a3119] as const
  for (let layer = 0; layer < 5; layer++) {
    const half = 1.5 - layer * 0.28
    const y = 0.5 + layer * 0.75
    batches.wood.add(mx + 1.5 - half, y, mz + 1.5 - half, half * 2, 0.85, half * 2, rng.pick(CONE))
    // scale nubs poking out of each ring
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * Math.PI * 2 + layer * 0.6
      batches.wood.add(
        mx + 1.35 + Math.cos(a) * half, y + 0.1,
        mz + 1.35 + Math.sin(a) * half,
        0.4, 0.4, 0.4, rng.pick(CONE)
      )
    }
  }
  batches.wood.add(mx + 1.25, 4.2, mz + 1.25, 0.5, 0.7, 0.5, WOOD_DARK) // tip
  grid.blockRect(mx, mz, 3, 3)
  // ring of dented helmets left by pilgrims who looked up a moment too late
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2
    const hx = mx + 1.5 + Math.cos(a) * 4.5
    const hz = mz + 1.5 + Math.sin(a) * 4.5
    batches.stone.add(hx, 0, hz, 0.6, 0.45, 0.6, rng.pick(STONE))
    batches.stone.add(hx + 0.1, 0.45, hz + 0.1, 0.4, 0.14, 0.4, rng.pick(STONE))
  }

  // --- landmark 2: Flinch Tower (~ (118, -480)) — stilt lookout
  const tx = 116
  const tz = -482
  for (const [dx, dz] of [[0, 0], [3, 0], [0, 3], [3, 3]] as const) {
    batches.wood.add(tx + dx + 0.3, 0, tz + dz + 0.3, 0.4, 4, 0.4, rng.pick(WOOD))
    grid.block(tx + dx, tz + dz)
  }
  batches.wood.add(tx - 0.3, 4, tz - 0.3, 4.6, 0.3, 4.6, WOOD_DARK) // deck
  for (let i = 0; i < 4; i++) { // railing posts
    batches.wood.add(tx - 0.2 + (i % 2) * 4.2, 4.3, tz - 0.2 + Math.floor(i / 2) * 4.2, 0.25, 0.9, 0.25, rng.pick(WOOD))
  }
  batches.wood.add(tx - 0.3, 5, tz - 0.3, 4.6, 0.18, 0.25, WOOD_DARK) // rails
  batches.wood.add(tx - 0.3, 5, tz + 4.05, 4.6, 0.18, 0.25, WOOD_DARK)
  batches.wood.add(tx - 0.3, 5, tz - 0.05, 0.25, 0.18, 4.1, WOOD_DARK)
  batches.wood.add(tx + 4.05, 5, tz - 0.05, 0.25, 0.18, 4.1, WOOD_DARK)
  batches.misc.add(tx - 0.6, 5.4, tz - 0.6, 5.2, 0.5, 5.2, STRAW) // straw cap
  batches.misc.add(tx + 0.6, 5.9, tz + 0.6, 2.8, 0.5, 2.8, STRAW)
  kitLantern(ctx, scene, tx - 2, tz + 1) // LIGHT 1/3 for the batch
  kitCampfire(ctx, tx + 6, tz + 2) // rangers' brew fire (EMBER use 1 of 1)

  // --- 4. scatter: the gauntlet itself — pines crowd the trail
  const keepOut: Spot[] = [[160, -442, 8], [118, -480, 6]]
  scatter(ctx, zone, 26, (x, z) => kitPine(ctx, x, z, { tall: true }), { around: [132, -446, 24], keepOut })
  scatter(ctx, zone, 18, (x, z) => kitPine(ctx, x, z), { around: [160, -442, 22], keepOut })
  scatter(ctx, zone, 46, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.4 }), { keepOut })
  scatter(ctx, zone, 12, (x, z) => kitRock(ctx, x, z, 1), { keepOut })
  // fallen pinecones litter the floor (ankle-height menace, non-blocking)
  scatter(ctx, zone, 30, (x, z) => {
    batches.wood.add(x + rng.range(0, 0.5), 0, z + rng.range(0, 0.5), 0.45, 0.5, 0.45, 0x5c452a)
    batches.wood.add(x + rng.range(0.1, 0.4), 0.5, z + rng.range(0.1, 0.4), 0.28, 0.3, 0.28, 0x4a3119)
  }, { keepOut, pad: 6 })
}

// ===========================================================================
// frostbitten_fields — "Planted winter wheat and harvested regret."
// ===========================================================================
// LANDMARK 1: Last Harvest Farm — an abandoned farmstead: farmhouse, frozen
//   soil rows with crop stubble, a scarecrow flash-frozen mid-shrug, and a
//   firepit in the yard. (1 kitLantern by the door.)
// LANDMARK 2: The Last Turnip — a monstrous turnip half-dug from the earth.
//   The shovels are still there. The farmers are not.
// ~500 props + ~4.9k ground ≈ 5.4k instances.
function buildFrostbittenFields(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx

  // --- 1. surfaces: lane in from the SE corner (NE arterial side)
  kitPath(ctx, [
    [356, -364],
    [344, -382],
    [334, -404], // the Last Turnip
    [318, -428],
    [305, -439] // farm door
  ])
  // frozen field rows (stamped before the ground pass renders them as soil)
  for (let fz = -460; fz <= -448; fz += 2) {
    for (let fx = 282; fx <= 296; fx++) setSurface(ctx, fx, fz, S_SOIL)
  }
  for (let fz = -436; fz <= -426; fz += 2) {
    for (let fx = 310; fx <= 322; fx++) setSurface(ctx, fx, fz, S_SOIL)
  }

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: Last Harvest Farm (house ~ (298, -448))
  kitHouseShell(ctx, { x0: 296, z0: -448, w: 8, d: 6, wallH: 3, door: 'S', chimney: true })
  kitLantern(ctx, scene, 294, -446) // LIGHT 2/3 — still burning for nobody
  kitFenceRun(ctx, 280, -462, 26, true)
  kitFenceRun(ctx, 280, -462, 14, false)
  kitFenceRun(ctx, 305, -462, 14, false)
  // crop stubble poking through the frozen rows
  for (let i = 0; i < 16; i++) {
    const fx = 282 + rng.range(0, 14)
    const fz = -460 + Math.floor(rng.range(0, 7)) * 2
    batches.misc.add(fx, 0, fz, 0.2, 0.4 + rng.range(0, 0.4), 0.2, STRAW)
  }
  // the scarecrow, flash-frozen mid-shrug inside a block of ice
  batches.wood.add(288.3, 0, -455.3, 0.3, 2.6, 0.3, WOOD_DARK)
  batches.wood.add(287.3, 1.7, -455.35, 2.3, 0.25, 0.25, WOOD_DARK)
  batches.misc.add(288.1, 2.6, -455.45, 0.7, 0.7, 0.6, STRAW) // straw head
  batches.misc.add(287.6, 0.6, -455.8, 1.7, 1.6, 1.2, rng.pick(ICE)) // the ice
  grid.block(288, -456)
  kitCampfire(ctx, 300, -455) // yard firepit (EMBER use 1 of 1)

  // --- landmark 2: The Last Turnip (~ (332, -406))
  const ux = 330
  const uz = -408
  batches.plaster.add(ux, 0, uz, 3, 1.3, 3, rng.pick(TURNIP_SKIN)) // the bulge
  batches.plaster.add(ux + 0.5, 1.3, uz + 0.5, 2, 0.8, 2, rng.pick(TURNIP_SKIN))
  batches.plaster.add(ux + 1, 2.1, uz + 1, 1, 0.5, 1, TURNIP_TOP) // purple crown
  batches.leaf.add(ux + 1.1, 2.6, uz + 1.1, 0.35, 1.4, 0.35, 0x4e8f4a) // greens
  batches.leaf.add(ux + 1.6, 2.6, uz + 0.9, 0.3, 1.1, 0.3, 0x447f41)
  batches.leaf.add(ux + 0.7, 2.6, uz + 1.5, 0.3, 0.9, 0.3, 0x58a053)
  grid.blockRect(ux, uz, 3, 3)
  // abandoned dig: two shovels and a very reasonable amount of giving up
  batches.wood.add(ux - 1.2, 0, uz + 1.2, 0.2, 1.6, 0.2, WOOD_DARK)
  batches.stone.add(ux - 1.3, 1.6, uz + 1.1, 0.4, 0.5, 0.3, rng.pick(STONE))
  batches.wood.add(ux + 3.4, 0, uz + 0.6, 0.2, 1.4, 0.2, WOOD_DARK)
  batches.stone.add(ux + 3.3, 1.4, uz + 0.5, 0.4, 0.5, 0.3, rng.pick(STONE))
  kitFenceRun(ctx, ux - 3, uz - 3, 9, true) // polite spectator barrier
  kitFenceRun(ctx, ux - 3, uz - 3, 5, false)

  // --- 4. scatter: windswept and thin, huddled near the farm
  const keepOut: Spot[] = [[299, -450, 16], [331, -407, 8], [292, -454, 12]]
  scatter(ctx, zone, 8, (x, z) => kitPine(ctx, x, z), { around: [292, -470, 22], keepOut })
  scatter(ctx, zone, 14, (x, z) => kitPine(ctx, x, z), { keepOut })
  scatter(ctx, zone, 14, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1), { keepOut })
  scatter(ctx, zone, 14, (x, z) => kitIceSpike(ctx, x, z), { keepOut })
}

// ===========================================================================
// whistlewood — "The trees whistle; nobody has told them it's creepy."
// ===========================================================================
// LANDMARK 1: The Old Whistler — the biggest, loudest tree in the wood, with
//   a glowing knothole and a bard's camp beneath it (the bard is losing the
//   duet and knows it).
// LANDMARK 2: The Chime Line — a wind-chime arch strung by locals trying to
//   drown the whistling out. It did not work. Now there are two noises.
// ~2.6k props + ~4.6k ground ≈ 7.2k instances.
function buildWhistlewood(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx
  void scene

  // --- 1. surfaces: path in from the west edge (N arterial side) + spur
  kitPath(ctx, [
    [80, -302],
    [106, -296],
    [132, -304],
    [156, -299] // the Old Whistler
  ])
  kitPath(ctx, [
    [156, -299],
    [178, -288],
    [198, -271] // the Chime Line
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Old Whistler (~ (161, -297))
  const wx = 160
  const wz = -298
  batches.wood.add(wx, 0, wz, 3, 7, 3, rng.pick(WOOD)) // great trunk
  batches.wood.add(wx - 0.5, 0, wz + 0.4, 0.6, 1.4, 2.2, WOOD_DARK) // root flares
  batches.wood.add(wx + 2.9, 0, wz + 0.4, 0.6, 1.1, 2.2, WOOD_DARK)
  batches.wood.add(wx + 0.4, 0, wz - 0.5, 2.2, 1.2, 0.6, WOOD_DARK)
  // the knothole: a dark mouth with a faint glow — the whistle itself
  batches.wood.add(wx + 0.9, 2.2, wz - 0.25, 1.2, 1.5, 0.3, WOOD_DARK)
  batches.window.add(wx + 1.2, 2.5, wz - 0.18, 0.6, 0.8, 0.2, WINDOW_GLOW)
  // vast layered canopy
  batches.leaf.add(wx - 3, 7, wz - 3, 9, 1.8, 9, 0x3a7a38)
  batches.leaf.add(wx - 2, 8.8, wz - 2, 7, 1.6, 7, 0x44843c)
  batches.leaf.add(wx - 0.5, 10.4, wz - 0.5, 4, 1.4, 4, 0x356f3d)
  batches.leaf.add(wx + 0.8, 11.8, wz + 0.8, 1.4, 1, 1.4, 0x2f6b31)
  grid.blockRect(wx, wz, 3, 3)
  // the bard's camp: log benches facing the knothole + a campfire duet
  kitCampfire(ctx, wx + 1, wz + 6) // EMBER use 1 of 1
  batches.wood.add(wx - 2, 0, wz + 5, 2.2, 0.5, 0.8, rng.pick(WOOD))
  batches.wood.add(wx + 3, 0, wz + 5, 2.2, 0.5, 0.8, rng.pick(WOOD))
  grid.blockRect(wx - 2, wz + 5, 2, 1)
  grid.blockRect(wx + 3, wz + 5, 2, 1)
  batches.misc.add(wx + 4.2, 0.5, wz + 5.2, 0.5, 1.1, 0.3, 0xb97a4e) // abandoned lute

  // --- landmark 2: The Chime Line (~ (199, -270))
  const cx = 196
  const cz = -270
  batches.wood.add(cx + 0.3, 0, cz + 0.3, 0.4, 4.2, 0.4, rng.pick(WOOD))
  batches.wood.add(cx + 6.3, 0, cz + 0.3, 0.4, 4.2, 0.4, rng.pick(WOOD))
  grid.block(cx, cz)
  grid.block(cx + 6, cz)
  batches.wood.add(cx + 0.2, 4.2, cz + 0.28, 6.6, 0.3, 0.44, WOOD_DARK) // crossbeam
  const CHIME = [0xbfe3f2, 0xe14b4b, 0xf5d547, 0xe88bc1, 0xaedaec] as const
  for (let i = 0; i < 5; i++) {
    const hx = cx + 1 + i * 1.2
    const len = 0.9 + ((i * 37) % 3) * 0.45
    batches.misc.add(hx, 4.2 - len, cz + 0.35, 0.14, len, 0.14, 0x4a3119) // cord
    batches.misc.add(hx - 0.12, 3.2 - len, cz + 0.22, 0.38, 1, 0.38, CHIME[i] as number)
  }

  // --- 4. scatter: a proper wood — big friendly canopies, denser mid-zone
  const keepOut: Spot[] = [[161, -297, 9], [199, -270, 5], [161, -292, 7]]
  scatter(ctx, zone, 30, (x, z) => kitTree(ctx, x, z, { big: rng.next() < 0.5 }), { around: [160, -300, 30], keepOut })
  scatter(ctx, zone, 55, (x, z) => kitTree(ctx, x, z), { keepOut })
  scatter(ctx, zone, 12, (x, z) => kitRock(ctx, x, z, 1), { keepOut })
}

// ===========================================================================
// greenwood_heights — "The old forest climbs uphill and gets full of itself."
// ===========================================================================
// LANDMARK 1: The Pompous Pines Country Club — a very exclusive clubhouse
//   with topiary, a members-only gate, and a lantern polished nightly.
// LANDMARK 2: The Satisfaction Lawn — a duelling circle where disputes about
//   hedge height are settled with steel, politely.
// ~2.4k props + ~3.5k ground ≈ 5.9k instances.
function buildGreenwoodHeights(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx

  // --- 1. surfaces: drive in from the SE corner (NE arterial side)
  kitPath(ctx, [
    [356, -246],
    [344, -260],
    [332, -272], // the Satisfaction Lawn
    [316, -292],
    [305, -306] // club gate
  ])
  // the duelling circle floor: stamped cobble disc (renders via ground pass)
  for (let dx = -5; dx <= 5; dx++) {
    for (let dz = -5; dz <= 5; dz++) {
      if (dx * dx + dz * dz <= 25) setSurface(ctx, 330 + dx, -272 + dz, 1) // S_COBBLE
    }
  }

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Pompous Pines Country Club (house ~ (296, -316))
  kitHouseShell(
    ctx,
    { x0: 294, z0: -318, w: 9, d: 7, wallH: 4, door: 'S', chimney: true },
    { timber: 0x3a2a14 } // darker timber — it's "heritage", darling
  )
  // members-only gate: twin stone posts + fence wings
  batches.stone.add(303, 0, -308, 1, 2.6, 1, rng.pick(STONE))
  batches.stone.add(306, 0, -308, 1, 2.6, 1, rng.pick(STONE))
  batches.stone.add(302.8, 2.6, -308.1, 1.4, 0.4, 1.2, rng.pick(STONE)) // caps
  batches.stone.add(305.8, 2.6, -308.1, 1.4, 0.4, 1.2, rng.pick(STONE))
  grid.block(303, -308)
  grid.block(306, -308)
  kitFenceRun(ctx, 292, -308, 11, true) // wings (gap at 303..306 is the gate)
  kitFenceRun(ctx, 307, -308, 8, true)
  kitFenceRun(ctx, 292, -322, 23, true) // back hedge-line fence
  kitFenceRun(ctx, 292, -322, 14, false)
  kitFenceRun(ctx, 314, -322, 14, false)
  kitLantern(ctx, scene, 305, -311) // LIGHT 3/3 — polished nightly
  // topiary avenue: immaculate little cubes on sticks, in a row, obviously
  for (let i = 0; i < 6; i++) {
    const tx = 296 + i * 3
    const tz = -306
    batches.wood.add(tx + 0.35, 0, tz + 0.35, 0.3, 1.1, 0.3, rng.pick(WOOD))
    batches.leaf.add(tx - 0.3, 1.1, tz - 0.3, 1.6, 1.6, 1.6, 0x2e6b46)
    grid.block(tx, tz)
  }

  // --- landmark 2: The Satisfaction Lawn (~ (330, -272))
  for (let i = 0; i < 10; i++) { // stone ring around the stamped cobble disc
    const a = (i / 10) * Math.PI * 2
    const rx = Math.floor(330 + Math.cos(a) * 7)
    const rz = Math.floor(-272 + Math.sin(a) * 7)
    if (surfaceAt(ctx, rx, rz) === S_GRASS) {
      batches.stone.add(rx + 0.15, 0, rz + 0.15, 0.7, 0.5 + rng.range(0, 0.3), 0.7, rng.pick(STONE))
      grid.block(rx, rz)
    }
  }
  // twin banner poles — house colors: "tasteful green" and "tasteful-er green"
  batches.wood.add(324.3, 0, -272.3, 0.35, 4.5, 0.35, WOOD_DARK)
  batches.roof.add(324.65, 3.1, -272.25, 1.3, 1, 0.15, rng.pick(ROOF))
  grid.block(324, -272)
  batches.wood.add(335.3, 0, -272.3, 0.35, 4.5, 0.35, WOOD_DARK)
  batches.roof.add(334.05, 3.1, -272.25, 1.3, 1, 0.15, rng.pick(ROOF))
  grid.block(335, -272)
  // weapon rack: for when the hedge dispute escalates, as it always does
  batches.wood.add(327, 0, -266.4, 0.25, 1.4, 0.25, WOOD_DARK)
  batches.wood.add(330, 0, -266.4, 0.25, 1.4, 0.25, WOOD_DARK)
  batches.wood.add(327, 1.4, -266.45, 3.2, 0.2, 0.3, WOOD_DARK)
  batches.misc.add(327.6, 0.2, -266.5, 0.14, 1.5, 0.14, 0xb9c4bb) // rapiers
  batches.misc.add(328.6, 0.2, -266.5, 0.14, 1.5, 0.14, 0xb9c4bb)
  batches.misc.add(329.4, 0.2, -266.5, 0.14, 1.5, 0.14, 0x9fada6)
  grid.blockRect(327, -267, 4, 1)

  // --- 4. scatter: stately old-growth, thickest behind the club
  const keepOut: Spot[] = [[298, -314, 15], [330, -272, 10], [305, -307, 7]]
  scatter(ctx, zone, 24, (x, z) => kitTree(ctx, x, z, { big: true }), { around: [300, -330, 24], keepOut })
  scatter(ctx, zone, 48, (x, z) => kitTree(ctx, x, z, { big: rng.next() < 0.45 }), { keepOut })
  scatter(ctx, zone, 10, (x, z) => kitRock(ctx, x, z, rng.next() < 0.25 ? 2 : 1), { keepOut })
}

// ---------------------------------------------------------------------------
// Registration — the zones/index barrel calls this once at boot.
// ---------------------------------------------------------------------------

/** Register the six batch-4 (north-center-east taiga) zone builders. */
export function registerBatch4(): void {
  registerZoneBuilder('yeti_pastures', buildYetiPastures)
  registerZoneBuilder('slip_n_slayed', buildSlipNSlayed)
  registerZoneBuilder('pinecone_gauntlet', buildPineconeGauntlet)
  registerZoneBuilder('frostbitten_fields', buildFrostbittenFields)
  registerZoneBuilder('whistlewood', buildWhistlewood)
  registerZoneBuilder('greenwood_heights', buildGreenwoodHeights)
}
