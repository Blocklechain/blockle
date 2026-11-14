/**
 * src/world/zones/batch9.ts — ZONE BATCH 9: east inner flank (wild forests +
 * wastes east of the heart). Six zones, ZONE_BATCHES[8]:
 *
 *   tanglewilds        forest 11-18  (240..360, -240..-80)
 *   oakzilla_grove     forest 29-42  (360..480, -240..-80)
 *   heartwood_hollow   forest 13-21  (240..360,  -80..80)   * waystone (300, 0)
 *   overgrown_opus     ruins  31-45  (360..480,  -80..80)
 *   forgottener_lands  wastes 18-28  (240..360,   80..240)
 *   dustbowl_diner     wastes 33-48  (360..480,   80..240)
 *
 * Builder contract per the streaming core: stamp surfaces FIRST (kitPath),
 * then streamGroundPass, then props (kit builders mark their own collision).
 * Everything is deterministic off ctx.rng (seeded from the zone id by the
 * stream), so re-entry rebuilds the identical zone and the permanent
 * collision marks always line up.
 *
 * Budget notes: lights — exactly 2 kitLanterns across all six zones
 * (heartwood_hollow + dustbowl_diner); ember glow — at most 1 kitCampfire
 * per zone; every zone lands well under 10k instances.
 *
 * Nearby arterials: NE crosses tanglewilds ((240,-100)→(310,-160)→(370,-240))
 * and clips oakzilla's NW corner; E runs straight through heartwood_hollow
 * and overgrown_opus ((240,8)→(300,-6)→(370,10)→(440,-8)); SE kisses
 * forgottener's SW corner at (236,236). Dustbowl connects via its north edge
 * toward the E arterial. Spur paths below hook into those.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import type { ZoneDef } from './registry'
import { S_GRASS, surfaceAt, type Ctx } from '../layout'
import {
  BONE_WHITE,
  isLand,
  kitBone,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitGrave,
  kitHouseShell,
  kitLantern,
  kitPath,
  kitRock,
  kitRuinPillar,
  kitTotem,
  kitTree,
  ROOF,
  RUIN_STONE,
  STONE,
  STRAW,
  WINDOW_GLOW,
  WOOD,
  WOOD_DARK
} from '../kit'

// ---------------------------------------------------------------------------
// Local flavor colors (flat-color voxel vocabulary, village-harmonious)
// ---------------------------------------------------------------------------

const VINE_GREEN = [0x3a7a38, 0x2f6b31, 0x44843c] as const
const MOSS_LEAF = [0x5a9150, 0x4e8448, 0x679c5b] as const
const HEART_RED = [0xe14b4b, 0xd43e45, 0xef5f5a] as const
const HEART_PINK = 0xe88bc1
const RUST = 0x8a4a2a
const CANVAS = [0xd9cfae, 0xcfc4a0] as const

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
// tanglewilds — "The vines have opinions, grip strength, and your schedule."
// ===========================================================================
// LANDMARK 1: The Chokehold — an old border watchtower the vines got hold of
//   and simply never let go of. Still standing. Technically. The vines are
//   winning a very slow argument with the masonry.
// LANDMARK 2: The Grip Gym — a tug-of-war pit where travelers test their
//   pull against a vine that has never lost. The scoreboard totem does not
//   bother tracking the other column anymore.
// ~2.9k props + ~5k ground ≈ 7.9k instances.
function buildTanglewilds(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx
  void scene

  // --- 1. surfaces: spurs off the NE arterial (passes (240,-100)→(310,-160))
  kitPath(ctx, [
    [308, -158],
    [296, -172],
    [284, -184] // the Chokehold
  ])
  kitPath(ctx, [
    [296, -144],
    [312, -134],
    [326, -124] // the Grip Gym
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Chokehold (~ (280, -192))
  const tx = 279
  const tz = -194
  batches.stone.add(tx, 0, tz, 3, 2.6, 3, rng.pick(STONE)) // base course
  batches.stone.add(tx + 0.15, 2.6, tz + 0.1, 2.8, 2.4, 2.8, rng.pick(STONE)) // mid, shoved
  batches.stone.add(tx + 0.35, 5, tz + 0.25, 2.5, 2.2, 2.5, rng.pick(RUIN_STONE)) // top, losing
  batches.stone.add(tx + 0.1, 7.2, tz, 0.7, 0.9, 0.7, rng.pick(RUIN_STONE)) // broken merlons
  batches.stone.add(tx + 2.4, 7.2, tz + 2.3, 0.7, 0.9, 0.7, rng.pick(RUIN_STONE))
  batches.wood.add(tx + 1.1, 2.8, tz - 0.25, 1, 1.4, 0.3, WOOD_DARK) // dark doorway arch
  // the vines: a fat green spiral with a grip
  batches.leaf.add(tx - 0.6, 0, tz + 0.8, 0.8, 3.4, 0.8, rng.pick(VINE_GREEN))
  batches.leaf.add(tx - 0.4, 3.4, tz - 0.5, 0.7, 0.7, 2.4, rng.pick(VINE_GREEN))
  batches.leaf.add(tx + 1.2, 3.8, tz - 0.6, 2.4, 0.7, 0.7, rng.pick(VINE_GREEN))
  batches.leaf.add(tx + 3, 4.2, tz + 0.6, 0.7, 0.7, 2.4, rng.pick(VINE_GREEN))
  batches.leaf.add(tx + 1, 5.6, tz + 2.9, 2.4, 0.7, 0.7, rng.pick(VINE_GREEN))
  batches.leaf.add(tx - 0.3, 6, tz + 0.4, 0.7, 2.6, 0.7, rng.pick(VINE_GREEN))
  batches.leaf.add(tx + 0.3, 8.1, tz + 0.6, 2.2, 1, 2.2, rng.pick(VINE_GREEN)) // canopy crown
  grid.blockRect(tx, tz, 3, 3)
  // collapsed masonry the vines spat out
  kitRock(ctx, tx - 3, tz + 3, 1)
  kitRock(ctx, tx + 4, tz - 2, 1)

  // --- landmark 2: The Grip Gym (~ (330, -120))
  const gx = 330
  const gz = -122
  // challengers' post, rope, and the undefeated vine
  batches.wood.add(gx + 0.3, 0, gz + 0.3, 0.4, 1.6, 0.4, rng.pick(WOOD)) // pull post
  grid.block(gx, gz)
  batches.misc.add(gx + 0.7, 1.1, gz + 0.32, 4.6, 0.18, 0.18, STRAW) // the taut rope
  batches.leaf.add(gx + 5.3, 0, gz, 1, 2.8, 1, rng.pick(VINE_GREEN)) // the vine itself
  batches.leaf.add(gx + 5.1, 2.8, gz - 0.2, 1.4, 0.8, 1.4, rng.pick(VINE_GREEN))
  batches.leaf.add(gx + 5.2, 1, gz + 0.25, 0.8, 0.5, 0.6, rng.pick(VINE_GREEN)) // the "hand"
  grid.block(gx + 5, gz)
  // scuffed challenger trench — generations of heels dug in and lost
  batches.misc.add(gx - 2.5, 0, gz + 0.1, 2.6, 0.12, 0.9, 0x6b532f)
  kitTotem(ctx, gx - 1, gz - 4) // scoreboard totem: VINES: lots. YOU: no.
  batches.wood.add(gx - 3, 0, gz + 3, 2.2, 0.5, 0.8, rng.pick(WOOD)) // spectator log
  grid.blockRect(gx - 3, gz + 3, 2, 1)
  kitBone(ctx, gx + 2, gz + 4) // a challenger who would not let go

  // --- 4. scatter: grabby forest, densest around the tower
  const keepOut: Spot[] = [[280, -192, 8], [332, -121, 9]]
  // vine-wrapped trees: village tree + a green coil hugging the trunk
  const vineTree = (x: number, z: number): void => {
    kitTree(ctx, x, z, { big: rng.next() < 0.5 })
    batches.leaf.add(x - 0.1, 0.2 + rng.range(0, 0.8), z + 0.15, 1.1, 0.5, 0.8, rng.pick(VINE_GREEN))
  }
  scatter(ctx, zone, 22, vineTree, { around: [282, -190, 24], keepOut })
  scatter(ctx, zone, 14, vineTree, { around: [328, -124, 20], keepOut })
  scatter(ctx, zone, 46, (x, z) => kitTree(ctx, x, z), { keepOut })
  scatter(ctx, zone, 12, vineTree, { keepOut })
  scatter(ctx, zone, 10, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1), { keepOut })
}

// ===========================================================================
// oakzilla_grove — "The biggest oak alive, and every rival tree knows it."
// ===========================================================================
// LANDMARK 1: Oakzilla — the single largest oak in existence, with a scowl
//   carved by weather and a polite viewing fence for its fan club. It did
//   not ask for the fence. It has simply accepted the worship.
// LANDMARK 2: The Runner-Up — a felled rival with the axe still in the
//   stump and a memorial headstone nobody chips in to finish. Second place
//   is just first loser, even in dendrology.
// ~2.6k props + ~5k ground ≈ 7.6k instances.
function buildOakzillaGrove(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx
  void scene

  // --- 1. surfaces: pilgrim trail in from the NW corner (NE arterial side)
  kitPath(ctx, [
    [372, -234],
    [388, -206],
    [404, -182],
    [414, -168] // Oakzilla's viewing fence
  ])
  kitPath(ctx, [
    [404, -182],
    [394, -160],
    [387, -136],
    [386, -126] // the Runner-Up
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: Oakzilla (~ (418, -160))
  const ox = 416
  const oz = -162
  batches.wood.add(ox, 0, oz, 4, 12, 4, rng.pick(WOOD)) // the trunk
  batches.wood.add(ox - 1, 0, oz + 0.6, 1.2, 1.8, 2.8, WOOD_DARK) // root buttresses
  batches.wood.add(ox + 3.8, 0, oz + 0.6, 1.2, 1.5, 2.8, WOOD_DARK)
  batches.wood.add(ox + 0.6, 0, oz - 1, 2.8, 1.6, 1.2, WOOD_DARK)
  batches.wood.add(ox + 0.6, 0, oz + 3.8, 2.8, 1.3, 1.2, WOOD_DARK)
  // the weathered scowl (it has seen your little fence, and it is unmoved)
  batches.wood.add(ox + 0.7, 8.6, oz - 0.25, 1, 0.4, 0.3, WOOD_DARK) // brows
  batches.wood.add(ox + 2.3, 8.6, oz - 0.25, 1, 0.4, 0.3, WOOD_DARK)
  batches.wood.add(ox + 0.9, 7.6, oz - 0.25, 0.6, 0.6, 0.3, 0x2e1c0e) // knot eyes
  batches.wood.add(ox + 2.5, 7.6, oz - 0.25, 0.6, 0.6, 0.3, 0x2e1c0e)
  batches.wood.add(ox + 1.3, 6.2, oz - 0.25, 1.4, 0.4, 0.3, 0x2e1c0e) // flat unimpressed mouth
  // the canopy: a stacked green thunderhead
  batches.leaf.add(ox - 7, 12, oz - 7, 18, 2.4, 18, 0x3a7a38)
  batches.leaf.add(ox - 5, 14.4, oz - 5, 14, 2.2, 14, 0x44843c)
  batches.leaf.add(ox - 2.5, 16.6, oz - 2.5, 9, 2, 9, 0x2f6b31)
  batches.leaf.add(ox + 0.2, 18.6, oz + 0.2, 3.6, 1.6, 3.6, 0x356f3d)
  grid.blockRect(ox, oz, 4, 4)
  // fan-club viewing fence (west side, where the trail arrives) + offerings
  kitFenceRun(ctx, ox - 5, oz - 3, 10, false)
  batches.misc.add(ox - 4, 0, oz + 1, 0.5, 0.4, 0.5, 0xe14b4b) // left offerings
  batches.misc.add(ox - 4.2, 0, oz + 2.1, 0.4, 0.3, 0.4, 0xf5d547)
  batches.misc.add(ox - 3.8, 0, oz + 3, 0.45, 0.35, 0.45, 0xe88bc1)

  // --- landmark 2: The Runner-Up (~ (386, -122))
  const rx = 384
  const rz = -124
  batches.wood.add(rx, 0, rz, 2, 1.4, 2, rng.pick(WOOD)) // the stump
  grid.blockRect(rx, rz, 2, 2)
  batches.wood.add(rx + 2.4, 0, rz + 0.3, 9, 1.4, 1.6, rng.pick(WOOD)) // the fallen trunk
  batches.wood.add(rx + 11.4, 0, rz + 0.1, 2.2, 1.8, 2, rng.pick(WOOD)) // crown wad
  batches.leaf.add(rx + 10.8, 1.6, rz - 0.6, 3.6, 1, 3.4, rng.pick(MOSS_LEAF)) // going mossy
  grid.blockRect(rx + 2, rz, 10, 2)
  grid.blockRect(rx + 11, rz, 3, 2)
  // the axe, still in the stump; the lumberjack is long gone, so is his nerve
  batches.wood.add(rx + 0.8, 1.4, rz + 0.8, 0.22, 1.7, 0.22, WOOD_DARK)
  batches.stone.add(rx + 0.55, 2.8, rz + 0.72, 0.8, 0.5, 0.35, rng.pick(STONE))
  kitGrave(ctx, rx - 2, rz + 1) // "HERE LIES: SECOND PLACE" — fund stalled at 40%

  // --- 4. scatter: the insecure rivals — big oaks posturing at a distance
  const keepOut: Spot[] = [[418, -160, 13], [390, -123, 10]]
  scatter(ctx, zone, 20, (x, z) => kitTree(ctx, x, z, { big: true }), { around: [418, -160, 30], keepOut })
  scatter(ctx, zone, 40, (x, z) => kitTree(ctx, x, z, { big: rng.next() < 0.6 }), { keepOut })
  scatter(ctx, zone, 14, (x, z) => kitTree(ctx, x, z), { keepOut })
  scatter(ctx, zone, 10, (x, z) => kitRock(ctx, x, z, rng.next() < 0.25 ? 2 : 1), { keepOut })
}

// ===========================================================================
// heartwood_hollow — "The trees lean in when you talk. Choose topics wisely."
// ===========================================================================
// LANDMARK 1: The Eavesdroppers' Circle — a ring of enormous trees leaning
//   toward a lone confession stump. Say anything out loud here and the whole
//   forest knows by sundown. The SHHH totem has never once worked.
// LANDMARK 2: The Heartwood — the hollow's namesake: one old tree whose
//   canopy grew into a lopsided red heart. Nobody pruned it into shape; the
//   locals maintain it is "just very sincere". (1 kitLantern at its foot.)
// Waystone ws_heartwood_hollow anchor (300, 0) kept clear + on the arterial.
// ~2.8k props + ~4.6k ground ≈ 7.4k instances.
function buildHeartwoodHollow(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx

  // --- 1. surfaces: spurs off the E arterial ((240,8)→(300,-6)→(370,10))
  kitPath(ctx, [
    [314, 2],
    [324, 18],
    [331, 34] // the Eavesdroppers' Circle
  ])
  kitPath(ctx, [
    [286, -4],
    [278, -20],
    [272, -36] // the Heartwood
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Eavesdroppers' Circle (~ (332, 42))
  const cx = 332
  const cz = 42
  for (let i = 0; i < 8; i++) {
    // the ring: big trees planted deliberately, all "leaning" in via an
    // inward-shifted extra canopy slab (flat-color gossip posture)
    const a = (i / 8) * Math.PI * 2 + 0.3
    const txi = Math.floor(cx + Math.cos(a) * 9)
    const tzi = Math.floor(cz + Math.sin(a) * 9)
    kitTree(ctx, txi, tzi, { big: true })
    batches.leaf.add(
      txi + 0.5 - Math.cos(a) * 2.2 - 1.25, 4.6,
      tzi + 0.5 - Math.sin(a) * 2.2 - 1.25,
      2.5, 1, 2.5, 0x3a7a38
    )
  }
  batches.wood.add(cx - 0.7, 0, cz - 0.7, 1.4, 0.7, 1.4, rng.pick(WOOD)) // confession stump
  grid.block(cx - 1, cz - 1)
  grid.block(cx, cz)
  kitTotem(ctx, cx - 2, cz + 6) // the SHHH totem (0% effective since install)
  batches.wood.add(cx + 2, 0, cz + 4, 2.2, 0.5, 0.8, rng.pick(WOOD)) // listeners' log
  grid.blockRect(cx + 2, cz + 4, 2, 1)

  // --- landmark 2: The Heartwood (~ (270, -42))
  const hx = 270
  const hz = -44
  batches.wood.add(hx, 0, hz, 2, 6, 2, rng.pick(WOOD)) // trunk
  batches.wood.add(hx - 0.5, 0, hz + 0.3, 0.6, 1.2, 1.4, WOOD_DARK) // root flares
  batches.wood.add(hx + 1.9, 0, hz + 0.3, 0.6, 1.2, 1.4, WOOD_DARK)
  // the heart: two red lobes + a dropped point, charmingly off-center
  batches.leaf.add(hx - 2.4, 7.6, hz - 1.6, 3.2, 2.6, 3.4, rng.pick(HEART_RED)) // left lobe
  batches.leaf.add(hx + 1.2, 7.8, hz - 1.5, 3.1, 2.5, 3.3, rng.pick(HEART_RED)) // right lobe
  batches.leaf.add(hx - 1.2, 5.6, hz - 0.9, 4.4, 2.2, 2.4, rng.pick(HEART_RED)) // waist
  batches.leaf.add(hx + 0.2, 4.2, hz - 0.4, 1.6, 1.5, 1.5, HEART_PINK) // the point
  batches.leaf.add(hx - 0.4, 10.2, hz - 1.1, 2, 0.9, 2.2, HEART_PINK) // blush on top
  grid.blockRect(hx, hz, 2, 2)
  kitLantern(ctx, scene, hx - 2, hz + 3) // LIGHT 1/2 — for evening confessions
  // fallen red petals drifting from the heart (non-blocking confetti)
  for (let i = 0; i < 10; i++) {
    batches.misc.add(
      hx - 3 + rng.range(0, 7), 0, hz - 2 + rng.range(0, 7),
      0.3, 0.1, 0.3, rng.next() < 0.5 ? HEART_PINK : 0xe14b4b
    )
  }

  // --- 4. scatter: deep cozy dell — close-planted, clears near the waystone
  const keepOut: Spot[] = [[332, 42, 13], [270, -43, 7], [300, 0, 8]] // last = waystone anchor
  scatter(ctx, zone, 22, (x, z) => kitTree(ctx, x, z, { big: rng.next() < 0.5 }), { around: [332, 42, 26], keepOut })
  scatter(ctx, zone, 16, (x, z) => kitTree(ctx, x, z), { around: [271, -42, 20], keepOut })
  scatter(ctx, zone, 50, (x, z) => kitTree(ctx, x, z, { big: rng.next() < 0.35 }), { keepOut })
  scatter(ctx, zone, 10, (x, z) => kitRock(ctx, x, z, 1), { keepOut })
}

// ===========================================================================
// overgrown_opus — "The show closed centuries ago. The reviews did not."
// ===========================================================================
// LANDMARK 1: The Opus — the ruined amphitheater itself: three mossy terrace
//   arcs, a cracked stage, and the colonnade backdrop mid-collapse. The
//   acoustics are still perfect, which the local monsters abuse nightly.
// LANDMARK 2: The Critics' Box — front row center: three headstones for the
//   critics who died mid-boo and were buried exactly where they sat, still
//   facing the stage. Attendance has never been better.
// ~900 props + ~5k ground ≈ 5.9k instances.
function buildOvergrownOpus(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx
  void scene

  // --- 1. surfaces: spur off the E arterial ((370,10)→(440,-8))
  kitPath(ctx, [
    [408, 2],
    [418, 16],
    [426, 30],
    [430, 40] // stage door, loosely speaking
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Opus — stage ~ (432, 44), seating arcs south
  const ax = 432 // center of the orchestra
  const az = 48
  batches.stone.add(ax - 5, 0, az - 10, 10, 0.5, 5, rng.pick(RUIN_STONE)) // the stage
  grid.blockRect(ax - 5, az - 10, 10, 5)
  batches.stone.add(ax - 2, 0.5, az - 9, 2.4, 0.4, 1.6, rng.pick(STONE)) // cracked riser
  // colonnade backdrop: standing + fallen pillars behind the stage
  kitRuinPillar(ctx, ax - 6, az - 13)
  kitRuinPillar(ctx, ax - 2, az - 14)
  kitRuinPillar(ctx, ax + 2, az - 14)
  kitRuinPillar(ctx, ax + 5, az - 13)
  batches.stone.add(ax - 1.5, 0, az - 11.6, 4.4, 0.6, 0.7, rng.pick(RUIN_STONE)) // fallen lintel
  grid.blockRect(ax - 1, az - 12, 4, 1)
  // three terrace arcs (southern half-circle), each higher + mossier
  for (let row = 0; row < 3; row++) {
    const r = 7 + row * 3
    const h = 0.6 + row * 0.5
    const seats = 10 + row * 4
    for (let s = 0; s <= seats; s++) {
      const a = (s / seats) * Math.PI // 0..π sweeps the south side
      const sx = Math.floor(ax + Math.cos(a) * r)
      const sz = Math.floor(az + Math.sin(a) * r * 0.8)
      if (surfaceAt(ctx, sx, sz) !== S_GRASS) continue
      batches.stone.add(sx + 0.1, 0, sz + 0.1, 0.85, h, 0.85, rng.pick(RUIN_STONE))
      if ((s + row) % 3 === 0) {
        batches.leaf.add(sx + 0.15, h, sz + 0.15, 0.75, 0.25, 0.75, rng.pick(MOSS_LEAF)) // moss cushions
      }
      grid.block(sx, sz)
    }
  }

  // --- landmark 2: The Critics' Box (~ (432, 52)) — front row center
  kitGrave(ctx, ax - 3, az + 3)
  kitGrave(ctx, ax - 1, az + 4)
  kitGrave(ctx, ax + 2, az + 3)
  kitBone(ctx, ax + 4, az + 5) // one critic made a break for the exit

  // --- 4. scatter: the forest reclaiming the venue, pillar stubs beyond
  const keepOut: Spot[] = [[432, 44, 22]]
  scatter(ctx, zone, 10, (x, z) => kitRuinPillar(ctx, x, z), { around: [432, 44, 34], keepOut })
  scatter(ctx, zone, 16, (x, z) => kitTree(ctx, x, z, { leaves: MOSS_LEAF, big: rng.next() < 0.4 }), { around: [432, 44, 30], keepOut })
  scatter(ctx, zone, 14, (x, z) => kitRuinPillar(ctx, x, z), { keepOut })
  scatter(ctx, zone, 26, (x, z) => kitTree(ctx, x, z, { leaves: MOSS_LEAF }), { keepOut })
  scatter(ctx, zone, 12, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1), { keepOut })
  scatter(ctx, zone, 6, (x, z) => kitGrave(ctx, x, z), { keepOut })
}

// ===========================================================================
// forgottener_lands — "The maps gave up. Then the backup maps gave up."
// ===========================================================================
// LANDMARK 1: The Cartographer's Last Stand — a surveyor camp abandoned mid-
//   shrug: a signpost whose arrows all point somewhere called "???", a map
//   table with the map scribbled out, and a campfire that outlived the
//   expedition's optimism.
// LANDMARK 2: Big Boned — a colossal skeleton half-buried in the waste,
//   ribs like a fence for giants. Whatever it was, it skipped leg day never.
// ~700 props + ~5.5k ground ≈ 6.2k instances.
function buildForgottenerLands(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx
  void scene

  // --- 1. surfaces: trail in from the SW corner (SE arterial leaves (236,236))
  kitPath(ctx, [
    [242, 232],
    [254, 202],
    [266, 170],
    [276, 148] // the camp
  ])
  kitPath(ctx, [
    [276, 148],
    [296, 162],
    [314, 180],
    [322, 190] // Big Boned
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Cartographer's Last Stand (~ (278, 142))
  const sx = 278
  const sz = 142
  // the signpost of surrender: five arrows, zero consensus
  batches.wood.add(sx + 0.3, 0, sz + 0.3, 0.4, 4.4, 0.4, WOOD_DARK)
  grid.block(sx, sz)
  batches.wood.add(sx - 1.1, 3.8, sz + 0.28, 1.5, 0.45, 0.2, rng.pick(WOOD)) // "???"
  batches.wood.add(sx + 0.7, 3.2, sz + 0.28, 1.5, 0.45, 0.2, rng.pick(WOOD)) // "ALSO ???"
  batches.wood.add(sx + 0.32, 2.6, sz - 0.9, 0.2, 0.45, 1.4, rng.pick(WOOD)) // "SEA(?)"
  batches.wood.add(sx - 1.3, 2, sz + 0.28, 1.6, 0.45, 0.2, rng.pick(WOOD)) // "HOME (DOUBTFUL)"
  batches.wood.add(sx + 0.32, 1.4, sz + 0.6, 0.2, 0.45, 1.3, rng.pick(WOOD)) // points straight down
  // the map table: the map is 80% crossed out, 20% sketch of a rude gesture
  batches.wood.add(sx + 2.5, 0, sz - 1.5, 2, 0.9, 1.4, rng.pick(WOOD))
  batches.plaster.add(sx + 2.65, 0.9, sz - 1.35, 1.7, 0.08, 1.1, rng.pick(CANVAS))
  batches.misc.add(sx + 2.9, 0.98, sz - 1.1, 1, 0.04, 0.6, RUST) // the scribbles
  grid.blockRect(sx + 2, sz - 2, 2, 2)
  // collapsed canvas tent + bedroll — they left in a hurry, or a huff
  batches.misc.add(sx - 3.5, 0, sz + 1, 2.6, 1, 2.2, rng.pick(CANVAS))
  batches.misc.add(sx - 3.2, 1, sz + 1.4, 1.8, 0.5, 1.4, rng.pick(CANVAS))
  grid.blockRect(sx - 4, sz + 1, 3, 2)
  batches.misc.add(sx - 1, 0, sz + 2.6, 1.8, 0.25, 0.8, RUST) // abandoned bedroll
  kitCampfire(ctx, sx + 1, sz + 2) // EMBER use 1 of 1 — morale died first

  // --- landmark 2: Big Boned (~ (322, 194))
  const bx = 320
  const bz = 194
  const bone = (): number => rng.pick(BONE_WHITE)
  batches.misc.add(bx - 4, 0, bz - 1, 3, 2.2, 3, bone()) // the skull, half sunk
  batches.misc.add(bx - 4.6, 0, bz - 0.4, 0.7, 1.1, 1.8, bone()) // jaw shelf
  batches.stone.add(bx - 3.4, 1.2, bz - 0.6, 0.7, 0.6, 0.5, 0x2d2d33) // eye socket
  batches.stone.add(bx - 3.4, 1.2, bz + 1.1, 0.7, 0.6, 0.5, 0x2d2d33)
  grid.blockRect(bx - 5, bz - 1, 4, 3)
  for (let i = 0; i < 5; i++) {
    // the ribcage: arches marching away from the skull, sinking as they go
    const rxi = bx + i * 3
    const h = 3.4 - i * 0.45
    batches.misc.add(rxi, 0, bz - 2.2, 0.8, h, 0.8, bone())
    batches.misc.add(rxi, 0, bz + 2.4, 0.8, h, 0.8, bone())
    batches.misc.add(rxi - 0.1, h, bz - 2.2, 1, 0.7, 5.4, bone()) // the arch top
    grid.block(rxi, bz - 2)
    grid.block(rxi, bz + 2)
  }
  batches.misc.add(bx + 15, 0, bz - 0.4, 2.6, 0.9, 1.1, bone()) // tailbone, trailing off
  grid.blockRect(bx + 15, bz - 1, 3, 1)
  kitBone(ctx, bx + 6, bz + 5)
  kitBone(ctx, bx - 2, bz - 5)

  // --- 4. scatter: proper wastes — dead trees, graves nobody visits
  const keepOut: Spot[] = [[278, 142, 9], [322, 194, 16]]
  scatter(ctx, zone, 12, (x, z) => kitDeadTree(ctx, x, z), { around: [322, 194, 26], keepOut })
  scatter(ctx, zone, 8, (x, z) => kitBone(ctx, x, z), { around: [322, 194, 24], keepOut })
  scatter(ctx, zone, 26, (x, z) => kitDeadTree(ctx, x, z), { keepOut })
  scatter(ctx, zone, 16, (x, z) => kitRock(ctx, x, z, rng.next() < 0.3 ? 2 : 1), { keepOut })
  scatter(ctx, zone, 5, (x, z) => kitGrave(ctx, x, z), { keepOut })
  scatter(ctx, zone, 4, (x, z) => kitBone(ctx, x, z), { keepOut })
}

// ===========================================================================
// dustbowl_diner — "Last food for 200 clicks. Also first food. Also: run."
// ===========================================================================
// LANDMARK 1: The Dustbowl Diner — the only roadside diner in the wastes,
//   still open out of pure spite: flickering sign, menu board (today's
//   special: YOU), grill out back. The proprietor survives because even the
//   monsters respect a good breakfast. (1 kitLantern by the door.)
// LANDMARK 2: The Queue — a line of wrecked carts that pulled up for a bite
//   and became one. Some customers are still waiting. They're in no hurry;
//   they're skeletons.
// ~900 props + ~5.5k ground ≈ 6.4k instances.
function buildDustbowlDiner(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  const { rng, batches, grid } = ctx

  // --- 1. surfaces: drive in from the north edge (E arterial side) + queue
  kitPath(ctx, [
    [428, 82],
    [424, 100],
    [421, 116],
    [420, 124] // the diner's front step
  ])
  kitPath(ctx, [
    [421, 120],
    [428, 134],
    [432, 148],
    [433, 158] // the back of the queue
  ])

  // --- 2. ground
  streamGroundPass(ctx, zone)

  // --- 3. landmark 1: The Dustbowl Diner (house ~ (414..423, 126..131))
  kitHouseShell(
    ctx,
    { x0: 414, z0: 126, w: 10, d: 6, wallH: 3, door: 'S', chimney: true },
    { plaster: CANVAS, timber: 0x3a2a14 } // dust-bleached walls, sun-dried timber
  )
  kitLantern(ctx, scene, 412, 125) // LIGHT 2/2 — the porch light, always on
  // the roadside sign: tall pole, big board, glow letters that flicker
  // (shared window batch = free neon sputter)
  batches.wood.add(426.3, 0, 120.3, 0.5, 6.5, 0.5, WOOD_DARK)
  grid.block(426, 120)
  batches.roof.add(424.9, 4.6, 120.15, 3.3, 1.9, 0.5, rng.pick(ROOF)) // the board
  batches.window.add(425.2, 5.4, 120.05, 2.7, 0.7, 0.3, WINDOW_GLOW) // "DINER"
  batches.window.add(425.5, 4.8, 120.05, 1.3, 0.4, 0.3, 0xff6a2a) // "EAT" (sputtering)
  // menu board by the door — today's special in confident chalk
  batches.wood.add(417, 0, 124, 0.3, 1.7, 1.2, WOOD_DARK)
  batches.plaster.add(417.06, 0.5, 124.15, 0.2, 1, 0.9, 0x2d2d33) // the chalkboard
  grid.block(417, 124)
  // picnic table out front, optimistically set for four
  batches.wood.add(419, 0, 134, 2.4, 0.8, 1.2, rng.pick(WOOD))
  batches.wood.add(419.2, 0, 133.4, 2, 0.45, 0.5, WOOD_DARK)
  batches.wood.add(419.2, 0, 135.3, 2, 0.45, 0.5, WOOD_DARK)
  grid.blockRect(419, 133, 3, 3)
  kitCampfire(ctx, 426, 130) // the grill out back (EMBER use 1 of 1)
  kitFenceRun(ctx, 413, 136, 7, true) // keeps the queue orderly-ish

  // --- landmark 2: The Queue (~ (430, 140..158))
  for (let i = 0; i < 3; i++) {
    const qx = 429 + (i % 2)
    const qz = 140 + i * 7
    batches.wood.add(qx, 0.5, qz, 2.6, 0.9, 1.6, rng.pick(WOOD)) // cart bed
    batches.wood.add(qx - 0.3, 0.9, qz + 0.5, 0.4, 0.2, 0.6, WOOD_DARK) // snapped shaft
    batches.wood.add(qx + 0.1, 0, qz - 0.25, 0.9, 0.9, 0.35, WOOD_DARK) // wheels (what's left)
    batches.wood.add(qx + 1.7, 0, qz + 1.5, 0.9, 0.9, 0.35, WOOD_DARK)
    if (i === 1) batches.wood.add(qx + 1.7, 0, qz - 0.25, 0.9, 0.9, 0.35, WOOD_DARK) // lucky cart: 3 wheels
    grid.blockRect(qx, qz, 3, 2)
    kitBone(ctx, qx - 2, qz + 1) // the patient customer
  }
  // one skeleton reached the window; the tray is still balanced. respect.
  batches.misc.add(433, 0, 162, 0.5, 1.3, 0.5, rng.pick(BONE_WHITE))
  batches.wood.add(432.6, 1.3, 161.9, 1.3, 0.12, 0.7, WOOD_DARK) // the tray
  grid.block(433, 162)

  // --- 4. scatter: hungry wastes, huddled loosely around the lights
  const keepOut: Spot[] = [[419, 129, 14], [430, 148, 12], [426, 120, 5]]
  scatter(ctx, zone, 10, (x, z) => kitDeadTree(ctx, x, z), { around: [420, 130, 28], keepOut })
  scatter(ctx, zone, 24, (x, z) => kitDeadTree(ctx, x, z), { keepOut })
  scatter(ctx, zone, 16, (x, z) => kitRock(ctx, x, z, rng.next() < 0.35 ? 2 : 1), { keepOut })
  scatter(ctx, zone, 8, (x, z) => kitBone(ctx, x, z), { keepOut })
  scatter(ctx, zone, 4, (x, z) => kitGrave(ctx, x, z), { keepOut })
}

// ---------------------------------------------------------------------------
// Registration — the zones/index barrel calls this once at boot.
// ---------------------------------------------------------------------------

/** Register the six batch-9 (east inner flank) zone builders. */
export function registerBatch9(): void {
  registerZoneBuilder('tanglewilds', buildTanglewilds)
  registerZoneBuilder('oakzilla_grove', buildOakzillaGrove)
  registerZoneBuilder('heartwood_hollow', buildHeartwoodHollow)
  registerZoneBuilder('overgrown_opus', buildOvergrownOpus)
  registerZoneBuilder('forgottener_lands', buildForgottenerLands)
  registerZoneBuilder('dustbowl_diner', buildDustbowlDiner)
}
