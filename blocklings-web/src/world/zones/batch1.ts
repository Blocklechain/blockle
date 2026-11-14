/**
 * src/world/zones/batch1.ts — ZONE_BATCHES[0]: the Northwest corner.
 *
 *   nope_shelf        — glacier  (far NW pack ice)
 *   brainfreeze       — glacier  (hallucination country)
 *   coldshoulder      — glacier  (sulking west coast)
 *   longjohns         — tundra   (frozen flats, eponymous laundry)
 *   gooseflesh_shores — beach    (the coldest beach holiday ever sold)
 *   knucklerange      — mountain (four stubby peaks squaring up)
 *
 * Contract per zone: stamp surfaces first (kitPath / kitBridgePlank), then
 * streamGroundPass, then props (kit builders mark collision; custom shapes
 * mark it themselves). Everything is driven by ctx.rng (seeded per zone id)
 * so rebuilds are deterministic + collision-idempotent. All coordinates stay
 * inside each zone's own rect so cross-zone build order never matters.
 * Budget: <=2 ember-glow (kitCampfire) uses and 0-1 kitLantern per zone.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import type { ZoneDef } from './registry'
import { S_BRIDGE, S_COBBLE, S_SAND, setSurface, surfaceAt, type Ctx } from '../layout'
import {
  BONE_WHITE,
  DEAD_WOOD,
  isLand,
  kitBone,
  kitBridgePlank,
  kitCampfire,
  kitDeadTree,
  kitHut,
  kitIceSpike,
  kitLantern,
  kitPalm,
  kitPath,
  kitPine,
  kitRock,
  PLASTER,
  SAND,
  SNOW,
  STONE,
  STRAW,
  WOOD,
  WOOD_DARK
} from '../kit'

// ---------------------------------------------------------------------------
// Local palette accents (flat Lambert colors — same voxel vocabulary)
// ---------------------------------------------------------------------------

const DEEP_ICE = 0x5d84a6 // crevasse shadow blue
const UNION_RED = 0xc4574e // classic union-suit red (shared w/ mushroom caps)
const CANVAS = [0xcbb98f, 0xc0ae84] as const // expedition tent cloth
const PARASOL_RED = 0xd96459
const PARASOL_WHITE = 0xf3f3ef

// ---------------------------------------------------------------------------
// Tiny shared prop builders (each marks its own collision)
// ---------------------------------------------------------------------------

/** Supply crate with a slightly offset lid. Blocks the cell. */
function crate(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.08, 0, iz + 0.08, 0.84, 0.8, 0.84, rng.pick(WOOD))
  batches.wood.add(ix + 0.02, 0.8, iz + 0.14, 0.9, 0.14, 0.78, WOOD_DARK)
  grid.block(ix, iz)
}

/** Low snowdrift mound — decorative, walk-over (no collision). */
function drift(ctx: Ctx, x: number, z: number): void {
  const { rng, batches } = ctx
  const w = rng.range(1.2, 2.6)
  batches.misc.add(x, 0, z, w, rng.range(0.18, 0.34), w * rng.range(0.6, 0.9), SNOW)
  if (rng.next() < 0.6) {
    batches.misc.add(x + w * 0.3, 0, z - 0.5, w * 0.6, rng.range(0.12, 0.22), w * 0.5, SNOW)
  }
}

/** Canvas expedition tent (2x2 footprint + ridge). Blocks 2x2. */
function tent(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const c = rng.pick(CANVAS)
  batches.misc.add(ix, 0, iz, 2, 0.9, 2, c)
  batches.misc.add(ix + 0.3, 0.9, iz + 0.3, 1.4, 0.55, 1.4, c)
  batches.wood.add(ix + 0.85, 1.45, iz + 0.1, 0.3, 0.5, 1.8, WOOD_DARK) // ridge pole
  grid.blockRect(ix, iz, 2, 2)
}

/** Wooden signpost with a crossboard. Blocks the cell. */
function signPost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 1.9, 0.24, rng.pick(WOOD))
  batches.wood.add(ix - 0.35, 1.3, iz + 0.32, 1.7, 0.5, 0.18, WOOD_DARK)
  grid.block(ix, iz)
}

/**
 * Beached/ice-locked ship wreck: broken hull, snapped tilted mast, spilled
 * cargo. ~8x4 footprint along +X. Blocks the hull rect.
 */
function shipWreck(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  // hull — two stepped strakes, listing to one side
  batches.wood.add(ix, 0, iz, 8, 1.1, 4, rng.pick(WOOD))
  batches.wood.add(ix - 0.6, 1.1, iz - 0.3, 8.6, 0.8, 4.6, rng.pick(WOOD))
  batches.wood.add(ix - 1.4, 0.2, iz + 1.2, 1.6, 1.4, 1.6, WOOD_DARK) // smashed bow
  // deck break — the middle has given up
  batches.wood.add(ix + 2.6, 1.9, iz + 0.4, 2.6, 0.3, 3.2, WOOD_DARK)
  // snapped mast: stump + fallen length
  batches.wood.add(ix + 4.2, 1.9, iz + 1.7, 0.5, 2.1, 0.5, rng.pick(WOOD))
  batches.wood.add(ix + 4.6, 1.9, iz + 2.1, 6, 0.45, 0.45, rng.pick(WOOD))
  batches.misc.add(ix + 8.6, 1.6, iz + 1.3, 1.6, 0.25, 2, rng.pick(PLASTER)) // dropped sailcloth
  grid.blockRect(ix - 1, iz, 10, 4)
}

/** Tipped supply cart with two spoke-less wheels. Blocks 3x2. */
function cartWreck(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0.5, iz, 2.6, 0.3, 1.8, rng.pick(WOOD)) // tipped bed
  batches.wood.add(ix + 0.2, 0.8, iz + 0.1, 2.2, 0.8, 0.25, rng.pick(WOOD)) // side rail
  batches.wood.add(ix - 0.5, 0, iz + 0.4, 0.4, 1.1, 1.1, WOOD_DARK) // wheel (on)
  batches.wood.add(ix + 3, 0, iz + 1.4, 1.1, 0.4, 1.1, WOOD_DARK) // wheel (off, flat)
  batches.wood.add(ix + 2.6, 0.35, iz - 0.6, 1.9, 0.26, 0.26, rng.pick(DEAD_WOOD)) // snapped shaft
  grid.blockRect(ix, iz, 3, 2)
}

/** One stubby "knuckle" peak — stepped stone tiers + snow cap. Blocks base. */
function knucklePeak(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix, 0, iz, 9, 2.4, 9, rng.pick(STONE))
  batches.stone.add(ix + 1.4, 2.4, iz + 1.4, 6.2, 2.4, 6.2, rng.pick(STONE))
  batches.stone.add(ix + 2.8, 4.8, iz + 2.8, 3.4, 2.2, 3.4, rng.pick(STONE))
  batches.misc.add(ix + 2.6, 7, iz + 2.6, 3.8, 0.5, 3.8, SNOW) // snow cap
  batches.stone.add(ix + 3.6, 7.5, iz + 3.6, 1.8, 1.2, 1.8, rng.pick(STONE)) // top knuckle
  // a shoulder boulder or two at the skirt
  for (let i = 0; i < 2; i++) {
    batches.stone.add(
      ix + rng.range(-1, 8.6), 0, iz + rng.range(-1, 8.6),
      rng.range(0.8, 1.6), rng.range(0.5, 1.3), rng.range(0.8, 1.6), rng.pick(STONE)
    )
  }
  grid.blockRect(ix - 1, iz - 1, 11, 11)
}

/** Striped beach parasol over nothing worth shading. Blocks the pole cell. */
function parasol(ctx: Ctx, ix: number, iz: number): void {
  const { batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 2.6, 0.24, WOOD_DARK)
  batches.misc.add(ix - 1, 2.6, iz - 1, 3, 0.3, 3, PARASOL_RED)
  batches.misc.add(ix - 0.4, 2.9, iz - 0.4, 1.8, 0.3, 1.8, PARASOL_WHITE)
  batches.misc.add(ix + 0.25, 3.2, iz + 0.25, 0.5, 0.35, 0.5, PARASOL_RED)
  grid.block(ix, iz)
}

/** Slatted deckchair, permanently reserved. Blocks the cell. */
function deckChair(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const w = rng.pick(WOOD)
  batches.wood.add(ix, 0.35, iz, 1, 0.14, 1.3, w) // seat
  batches.wood.add(ix, 0.49, iz - 0.35, 1, 0.9, 0.16, w) // back
  batches.wood.add(ix + 0.05, 0, iz + 0.05, 0.16, 0.35, 0.16, WOOD_DARK)
  batches.wood.add(ix + 0.79, 0, iz + 0.05, 0.16, 0.35, 0.16, WOOD_DARK)
  batches.wood.add(ix + 0.05, 0, iz + 1.1, 0.16, 0.35, 0.16, WOOD_DARK)
  batches.wood.add(ix + 0.79, 0, iz + 1.1, 0.16, 0.35, 0.16, WOOD_DARK)
  grid.block(ix, iz)
}

/**
 * Clustered scatter helper: `n` attempts inside radius `r` of (cx, cz),
 * clamped to the zone rect (with margin), skipping water/roads/bridges and
 * already-blocked cells. `fn` gets integer cell coords.
 */
function scatter(
  ctx: Ctx,
  zone: ZoneDef,
  n: number,
  cx: number,
  cz: number,
  r: number,
  fn: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2)
    const d = r * Math.sqrt(rng.next())
    const ix = Math.floor(cx + Math.cos(a) * d)
    const iz = Math.floor(cz + Math.sin(a) * d)
    if (ix < zone.x0 + 3 || ix > zone.x1 - 3 || iz < zone.z0 + 3 || iz > zone.z1 - 3) continue
    if (!isLand(ix + 0.5, iz + 0.5) || !isLand(ix + 3, iz) || !isLand(ix - 3, iz)) continue
    const s = surfaceAt(ctx, ix, iz)
    if (s === S_COBBLE || s === S_BRIDGE) continue
    if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) continue
    fn(ix, iz)
  }
}

/** Sparse scatter across the whole zone rect. */
function scatterZone(ctx: Ctx, zone: ZoneDef, n: number, fn: (ix: number, iz: number) => void): void {
  const cx = (zone.x0 + zone.x1) / 2
  const cz = (zone.z0 + zone.z1) / 2
  const r = Math.max(zone.x1 - zone.x0, zone.z1 - zone.z0) / 2 + 20
  scatter(ctx, zone, n, cx, cz, r, fn)
}

// ---------------------------------------------------------------------------
// nope_shelf — The Nope Shelf (glacier, far NW corner, lv 72-88)
// ---------------------------------------------------------------------------

function buildNopeShelf(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Path spur: the NW arterial dead-ends at (-660,-660); walk it to the wreck.
  kitPath(ctx, [[-660, -660], [-657, -646], [-652, -636], [-650, -629]], 1.2)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Last Laugh" — a pirate ship frozen mid-sink into the pack
  // ice, impaled on the very spikes it was laughing at.
  shipWreck(ctx, -655, -628)
  kitIceSpike(ctx, -653, -627)
  kitIceSpike(ctx, -649, -626)
  crate(ctx, -646, -629)
  crate(ctx, -645, -627)
  signPost(ctx, -651, -634) // "TURN BACK. SERIOUSLY. — mgmt"

  // LANDMARK: "The Punchline" — a jagged crevasse where the shelf finally
  // cracked; deep-blue shadow, rimmed with spikes, absolutely not jumpable.
  const crack: ReadonlyArray<readonly [number, number]> = [
    [-692, -586], [-684, -592], [-676, -596], [-667, -594], [-658, -598], [-650, -604]
  ]
  for (let i = 0; i < crack.length - 1; i++) {
    const [ax, az] = crack[i]!
    const [bx, bz] = crack[i + 1]!
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const x = Math.floor(ax + (bx - ax) * t)
      const z = Math.floor(az + (bz - az) * t)
      const w = 1 + (i % 2) // 1-2 cells wide, jagged
      for (let d = 0; d < w; d++) {
        if (!isLand(x + 0.5, z + d + 0.5)) continue
        ctx.batches.misc.add(x, -0.95, z + d, 1, 0.55, 1, DEEP_ICE) // sunken floor
        ctx.grid.block(x, z + d)
      }
    }
  }
  scatter(ctx, zone, 14, -670, -596, 16, (ix, iz) => kitIceSpike(ctx, ix, iz))

  // Nature: spike forests thick near the landmarks, thinning out between.
  scatter(ctx, zone, 20, -652, -630, 22, (ix, iz) => kitIceSpike(ctx, ix, iz))
  scatterZone(ctx, zone, 26, (ix, iz) =>
    ctx.rng.next() < 0.7 ? kitIceSpike(ctx, ix, iz) : kitRock(ctx, ix, iz, 1)
  )
  scatterZone(ctx, zone, 22, (ix, iz) => drift(ctx, ix, iz))
}

// ---------------------------------------------------------------------------
// brainfreeze — Brainfreeze Expanse (glacier, lv 66-80)
// ---------------------------------------------------------------------------

function buildBrainfreeze(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Path: off the arterial sliver in the SW corner, up to Camp Bad Idea.
  kitPath(ctx, [[-589, -528], [-572, -552], [-558, -578], [-546, -600]], 1.2)
  streamGroundPass(ctx, zone)

  // LANDMARK: "Camp Bad Idea" — a doomed expedition's last stand: three
  // tents, one dead fire, zero survivors' forwarding addresses.
  tent(ctx, -548, -608)
  tent(ctx, -540, -612)
  tent(ctx, -543, -602)
  kitCampfire(ctx, -544, -607) // ember use 1/2
  crate(ctx, -550, -604)
  crate(ctx, -538, -608)
  crate(ctx, -539, -606)
  signPost(ctx, -546, -599) // "CAMP BAD IDEA — pop. decreasing"
  kitBone(ctx, -552, -611)

  // LANDMARK: "The Big Brain" — a colossal frozen head buried to the chin,
  // wearing a crown of ice spikes and an expression of pure disappointment.
  {
    const { batches, grid, rng } = ctx
    const hx = -524
    const hz = -572
    batches.stone.add(hx, 0, hz, 6, 5, 6, rng.pick(STONE)) // skull
    batches.stone.add(hx + 1, 5, hz + 1, 4, 1, 4, rng.pick(STONE)) // dome
    batches.stone.add(hx + 2.2, 2.2, hz - 0.7, 1.6, 1.6, 0.8, rng.pick(STONE)) // nose
    batches.misc.add(hx + 0.8, 3.4, hz - 0.1, 1.2, 0.7, 0.3, DEEP_ICE) // frozen glare L
    batches.misc.add(hx + 4, 3.4, hz - 0.1, 1.2, 0.7, 0.3, DEEP_ICE) // frozen glare R
    batches.misc.add(hx - 0.4, 4.6, hz - 0.4, 6.8, 0.6, 6.8, SNOW) // snow toupee
    grid.blockRect(hx - 1, hz - 1, 8, 8)
  }
  scatter(ctx, zone, 12, -521, -569, 11, (ix, iz) => kitIceSpike(ctx, ix, iz))

  // Nature: spikes + frozen dead trees (the colors you taste), cozy near camp.
  scatter(ctx, zone, 16, -544, -607, 20, (ix, iz) =>
    ctx.rng.next() < 0.6 ? kitIceSpike(ctx, ix, iz) : drift(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 24, (ix, iz) =>
    ctx.rng.next() < 0.55 ? kitIceSpike(ctx, ix, iz) : kitDeadTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 20, (ix, iz) => drift(ctx, ix, iz))
  scatterZone(ctx, zone, 8, (ix, iz) => kitRock(ctx, ix, iz, 2))
}

// ---------------------------------------------------------------------------
// coldshoulder — Coldshoulder Coast (glacier coast, lv 52-66)
// ---------------------------------------------------------------------------

function buildColdshoulder(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  // Jetty planks stamp S_BRIDGE BEFORE the ground pass.
  kitBridgePlank(ctx, -702, -444, 24, true)
  // Path: in from the zone's east edge (nearest arterial bend sits just
  // beyond it in the Longjohns) and across to the hut.
  kitPath(ctx, [[-602, -470], [-622, -462], [-644, -452], [-662, -446]], 1.2)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Sulk Hut" — the one local who refuses to leave, plus the
  // jetty nobody has moored at since the seagulls unionized.
  kitHut(ctx, -670, -448)
  kitLantern(ctx, scene, -665, -447) // the zone's single lantern
  crate(ctx, -673, -443)
  crate(ctx, -672, -441)
  signPost(ctx, -666, -451) // "NO VISITORS. NO REFUNDS. NO SUN."
  { // rowboat sulking at the jetty's landward end
    const { rng, batches } = ctx
    batches.wood.add(-684, -0.05, -441.5, 3.2, 0.7, 1.4, rng.pick(WOOD))
    batches.wood.add(-683.6, 0.2, -441.2, 2.4, 0.25, 0.8, WOOD_DARK)
  }

  // LANDMARK: "Boris the Belly-Up" — a whale skeleton beached on the shore,
  // ribs like a cathedral for very pessimistic monks.
  {
    const { rng, batches, grid } = ctx
    const wx = -682
    const wz = -404
    batches.misc.add(wx + 0.2, 0, wz - 2.6, 2.4, 1.6, 2.6, rng.pick(BONE_WHITE)) // skull
    batches.misc.add(wx + 0.6, 0, wz - 3.6, 1.6, 0.8, 1.2, rng.pick(BONE_WHITE)) // jaw
    for (let i = 0; i < 12; i++) { // spine
      batches.misc.add(wx + 0.9, 0.2, wz + i * 1.1, 0.8, 0.6, 0.8, rng.pick(BONE_WHITE))
    }
    for (let i = 0; i < 5; i++) { // rib arches, shrinking toward the tail
      const rz = wz + 0.6 + i * 2.1
      const h = 2.6 - i * 0.35
      batches.misc.add(wx - 1.3, 0, rz, 0.5, h, 0.5, rng.pick(BONE_WHITE))
      batches.misc.add(wx + 2.4, 0, rz, 0.5, h, 0.5, rng.pick(BONE_WHITE))
      batches.misc.add(wx - 1.3, h, rz, 4.2, 0.45, 0.5, rng.pick(BONE_WHITE))
    }
    grid.blockRect(wx - 2, wz - 4, 6, 18)
  }
  kitBone(ctx, -676, -414)
  kitBone(ctx, -687, -390)

  // Nature: glacier spikes + rocks, cozy ring around the hut.
  scatter(ctx, zone, 14, -668, -446, 16, (ix, iz) =>
    ctx.rng.next() < 0.5 ? kitIceSpike(ctx, ix, iz) : drift(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 24, (ix, iz) =>
    ctx.rng.next() < 0.6 ? kitIceSpike(ctx, ix, iz) : kitRock(ctx, ix, iz, 1)
  )
  scatterZone(ctx, zone, 18, (ix, iz) => drift(ctx, ix, iz))
}

// ---------------------------------------------------------------------------
// longjohns — The Longjohns (tundra flats, lv 48-60)
// ---------------------------------------------------------------------------

function buildLongjohns(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Short spur west off the arterial (which cuts right through this zone).
  kitPath(ctx, [[-536, -456], [-543, -448], [-547, -441]], 1.2)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Eponymous Longjohns" — a giant's union suit frozen stiff
  // on a washing line. Nobody has claimed it. Nobody WANTS to claim it.
  {
    const { batches, grid } = ctx
    const lx = -552
    const lz = -438
    batches.wood.add(lx, 0, lz, 0.6, 7, 0.6, WOOD_DARK) // post A
    batches.wood.add(lx + 11, 0, lz, 0.6, 7, 0.6, WOOD_DARK) // post B
    batches.wood.add(lx + 0.3, 6.6, lz + 0.22, 11, 0.16, 0.16, WOOD_DARK) // line
    // the garment itself: waist + two heroic legs + button flap
    batches.misc.add(lx + 3.4, 3.6, lz - 0.2, 4.4, 3, 1, UNION_RED)
    batches.misc.add(lx + 3.4, 0.8, lz - 0.2, 1.7, 2.8, 1, UNION_RED)
    batches.misc.add(lx + 6.1, 0.8, lz - 0.2, 1.7, 2.8, 1, UNION_RED)
    batches.misc.add(lx + 5.2, 4.2, lz + 0.82, 0.8, 1.8, 0.14, PARASOL_WHITE) // buttons
    grid.blockRect(lx, lz, 1, 1)
    grid.blockRect(lx + 11, lz, 1, 1)
    grid.blockRect(lx + 3, lz, 5, 1)
  }
  signPost(ctx, -549, -441) // "LOST: dignity. REWARD: none."

  // LANDMARK: "The Cold Snap Caravan" — a supply cart that tipped on the
  // arterial; the drivers walked off mid-argument and froze mid-gesture.
  cartWreck(ctx, -528, -452)
  crate(ctx, -524, -452)
  crate(ctx, -525, -450)
  crate(ctx, -530, -449)
  kitCampfire(ctx, -527, -455) // ember use 1/2
  kitBone(ctx, -522, -455)

  // Nature: wind-bitten pines in huddles, rocks and drifts between.
  scatter(ctx, zone, 12, -550, -440, 18, (ix, iz) => kitPine(ctx, ix, iz))
  scatter(ctx, zone, 8, -527, -453, 14, (ix, iz) => drift(ctx, ix, iz))
  scatterZone(ctx, zone, 20, (ix, iz) =>
    ctx.rng.next() < 0.45 ? kitPine(ctx, ix, iz, { tall: ctx.rng.next() < 0.3 }) : drift(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 14, (ix, iz) => kitRock(ctx, ix, iz, ctx.rng.next() < 0.3 ? 2 : 1))
  scatterZone(ctx, zone, 5, (ix, iz) => kitBone(ctx, ix, iz))
}

// ---------------------------------------------------------------------------
// gooseflesh_shores — Gooseflesh Shores (cold beach, lv 58-72)
// ---------------------------------------------------------------------------

function buildGooseflesh(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // A sandy promenade pad under the resort, then the ground pass.
  for (let ix = -668; ix <= -652; ix++) {
    for (let iz = -312; iz <= -296; iz++) setSurface(ctx, ix, iz, S_SAND)
  }
  kitPath(ctx, [[-602, -302], [-620, -308], [-638, -304], [-654, -303]], 1.2)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Resort at the End of Reason" — a fully set-up beach club
  // on a beach where the water bites back. Shack, parasols, deckchairs, and
  // a firepit doing all the actual heavy lifting.
  kitHut(ctx, -668, -308) // the shuttered snack shack
  parasol(ctx, -660, -306)
  parasol(ctx, -655, -301)
  parasol(ctx, -661, -298)
  deckChair(ctx, -658, -305)
  deckChair(ctx, -656, -304)
  deckChair(ctx, -653, -299)
  deckChair(ctx, -659, -297)
  kitCampfire(ctx, -657, -300) // ember use 1/2 — the only warm thing here
  signPost(ctx, -652, -304) // "WATER TEMP: ABSOLUTELY NOT"
  { // frozen sandcastle, abandoned at the moment of hubris
    const { rng, batches, grid } = ctx
    batches.misc.add(-648, 0, -296, 2.4, 1, 2.4, rng.pick(SAND))
    batches.misc.add(-647.6, 1, -295.6, 1.6, 0.8, 1.6, rng.pick(SAND))
    batches.misc.add(-648.2, 1, -296.2, 0.6, 1.5, 0.6, rng.pick(SAND)) // turret
    batches.misc.add(-646, 1, -294.6, 0.6, 1.3, 0.6, rng.pick(SAND)) // turret
    grid.blockRect(-648, -296, 3, 3)
  }

  // LANDMARK: "The Goosebump" — a cargo ship that beached itself at full
  // confidence; the crew's deckchairs are still mid-argument over there.
  shipWreck(ctx, -684, -270)
  crate(ctx, -674, -270)
  crate(ctx, -673, -268)
  kitBone(ctx, -677, -264)

  // Nature: hardy palms hunch around the resort; driftwood + rocks beyond.
  scatter(ctx, zone, 9, -660, -302, 16, (ix, iz) => kitPalm(ctx, ix, iz))
  scatterZone(ctx, zone, 10, (ix, iz) =>
    ctx.rng.next() < 0.5 ? kitPalm(ctx, ix, iz) : kitDeadTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 16, (ix, iz) => kitRock(ctx, ix, iz, 1))
  scatterZone(ctx, zone, 10, (ix, iz) => drift(ctx, ix, iz)) // wind-piled cold sand
}

// ---------------------------------------------------------------------------
// knucklerange — The Knucklerange (mountain, lv 50-62)
// ---------------------------------------------------------------------------

function buildKnucklerange(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  // Path in from the SE corner (nearest arterial bend) up to the mine mouth.
  kitPath(ctx, [[-484, -352], [-498, -334], [-510, -316], [-519, -302]], 1.2)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Four Knuckles" — four stubby peaks in a row; the land
  // made a fist about something ages ago and never let it go.
  knucklePeak(ctx, -588, -308)
  knucklePeak(ctx, -560, -302)
  knucklePeak(ctx, -532, -306)
  knucklePeak(ctx, -504, -300)

  // LANDMARK: "The Knockout Mine" — an abandoned dig into the third knuckle;
  // timber portal, one lonely cart, and a sign that aged extremely well.
  {
    const { rng, batches, grid } = ctx
    const mx = -524
    const mz = -297
    batches.plaster.add(mx, 0, mz, 3, 2.6, 1, 0x26262c) // dark mouth
    batches.wood.add(mx - 0.5, 0, mz - 0.3, 0.6, 3, 1, WOOD_DARK) // post L
    batches.wood.add(mx + 2.9, 0, mz - 0.3, 0.6, 3, 1, WOOD_DARK) // post R
    batches.wood.add(mx - 0.7, 3, mz - 0.4, 4.4, 0.6, 1.2, rng.pick(WOOD)) // lintel
    grid.blockRect(mx - 1, mz, 5, 1)
    // short rail + cart
    batches.wood.add(mx + 0.6, 0, mz + 1, 0.22, 0.18, 6, WOOD_DARK)
    batches.wood.add(mx + 2.2, 0, mz + 1, 0.22, 0.18, 6, WOOD_DARK)
    batches.wood.add(mx + 0.4, 0.18, mz + 4, 2.2, 1, 1.6, rng.pick(WOOD)) // cart
    batches.stone.add(mx + 0.7, 1.18, mz + 4.3, 1.6, 0.5, 1, rng.pick(STONE)) // ore load
    grid.blockRect(mx, mz + 4, 3, 2)
  }
  kitLantern(ctx, scene, -520, -299) // the zone's single lantern, at the portal
  crate(ctx, -527, -294)
  crate(ctx, -526, -292)
  signPost(ctx, -521, -304) // "KNOCKOUT MINE: 0 days since last knockout"
  { // spoil heap
    const { rng, batches, grid } = ctx
    batches.stone.add(-529, 0, -291, 2.6, 0.9, 2.2, rng.pick(STONE))
    batches.misc.add(-528.4, 0.9, -290.6, 1.4, 0.5, 1.2, STRAW) // old haul sacks
    grid.blockRect(-529, -291, 3, 2)
  }

  // Nature: scree and boulders everywhere, pines where the wind allows.
  scatter(ctx, zone, 14, -524, -298, 18, (ix, iz) => kitRock(ctx, ix, iz, 1))
  scatterZone(ctx, zone, 26, (ix, iz) =>
    kitRock(ctx, ix, iz, ctx.rng.next() < 0.3 ? 3 : ctx.rng.next() < 0.5 ? 2 : 1)
  )
  scatterZone(ctx, zone, 16, (ix, iz) =>
    ctx.rng.next() < 0.6 ? kitPine(ctx, ix, iz) : kitDeadTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 10, (ix, iz) => drift(ctx, ix, iz))
}

// ---------------------------------------------------------------------------
// Registration — the zones/ barrel calls this (idempotent; last write wins).
// ---------------------------------------------------------------------------

export function registerBatch1(): void {
  registerZoneBuilder('nope_shelf', buildNopeShelf)
  registerZoneBuilder('brainfreeze', buildBrainfreeze)
  registerZoneBuilder('coldshoulder', buildColdshoulder)
  registerZoneBuilder('longjohns', buildLongjohns)
  registerZoneBuilder('gooseflesh_shores', buildGooseflesh)
  registerZoneBuilder('knucklerange', buildKnucklerange)
}

// Also register at import time: the world barrel eager-globs zone files, and
// double registration is harmless (same builders, last write wins).
registerBatch1()
