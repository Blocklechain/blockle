/**
 * src/world/zones/batch11.ts — ZONE_BATCHES[10]: the Southwest corner.
 *
 *   soggy_bottoms   — swamp    (the realm's lowest, wettest, proudest mud)
 *   leechfinger_fen — swamp    (the leeches have fingers and opinions)
 *   sporeburb       — mushroom (a suburb whose residents ARE the cottages)
 *   bogwater_deluxe — swamp    (premium stink, artisanal teeth)
 *   croakening      — swamp    (shed-sized frogs; grudge-holding tadpoles)
 *   mudflap_beach   — beach    (a gray shore; the tide never apologizes)
 *
 * Contract per zone: stamp surfaces first (kitPath / kitBridgePlank / pond
 * S_RIVER), then streamGroundPass, then props (kit builders mark collision;
 * custom shapes mark it themselves). Everything is driven by ctx.rng (seeded
 * per zone id) so rebuilds are deterministic + collision-idempotent. All
 * coordinates stay inside each zone's own rect so cross-zone build order
 * never matters. Budget: <=2 ember-glow (kitCampfire) uses and 0-1
 * kitLantern per zone.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import type { ZoneDef } from './registry'
import { S_BRIDGE, S_COBBLE, S_RIVER, setSurface, surfaceAt, type Ctx } from '../layout'
import {
  FLOWER,
  LAGOON_WATER,
  MUSHROOM_CAP,
  MUSHROOM_SPOT,
  MUSHROOM_STEM,
  SAND,
  STONE,
  SWAMP_MURK,
  isLand,
  kitBone,
  kitBridgePlank,
  kitCampfire,
  kitDeadTree,
  kitFenceRun,
  kitGrave,
  kitHut,
  kitLantern,
  kitMushroomGiant,
  kitPalm,
  kitPath,
  kitRock,
  kitStatue,
  kitTree,
  PLASTER,
  WOOD,
  WOOD_DARK
} from '../kit'

// ---------------------------------------------------------------------------
// Local palette accents (flat Lambert colors — same voxel vocabulary)
// ---------------------------------------------------------------------------

const MUD = [0x4e4434, 0x453c2e, 0x58503c] as const // proud swamp mud
const BOOT_LEATHER = [0x5a4632, 0x4e3c2a, 0x6a5540] as const
const FROG_GREEN = [0x5fae4a, 0x4c9a3e, 0x6cba57] as const
const FROG_BELLY = 0xd9e4b8
const EYE_WHITE = 0xf3e9d8
const PUPIL = 0x26262c
const FANG_STONE = [0xb8b4a2, 0xaaa694, 0xc6c2b0] as const // gator-grin teeth
const FOAM_BLUE = 0x6fb7d9 // flip-flop sole foam
const STRAP_RED = 0xd96459
const GNOME_RED = 0xc4574e
const LILY = [0x4c9a3e, 0x5fae4a] as const

// ---------------------------------------------------------------------------
// Tiny shared prop builders (each marks its own collision)
// ---------------------------------------------------------------------------

/** Wooden signpost with a crossboard. Blocks the cell. */
function signPost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 1.9, 0.24, rng.pick(WOOD))
  batches.wood.add(ix - 0.35, 1.3, iz + 0.32, 1.7, 0.5, 0.18, WOOD_DARK)
  grid.block(ix, iz)
}

/** Supply crate with a slightly offset lid. Blocks the cell. */
function crate(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.08, 0, iz + 0.08, 0.84, 0.8, 0.84, rng.pick(WOOD))
  batches.wood.add(ix + 0.02, 0.8, iz + 0.14, 0.9, 0.14, 0.78, WOOD_DARK)
  grid.block(ix, iz)
}

/** Rain barrel (in the swamps it is always, always full). Blocks the cell. */
function barrel(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.15, 0, iz + 0.15, 0.7, 0.9, 0.7, rng.pick(WOOD))
  batches.misc.add(ix + 0.25, 0.9, iz + 0.25, 0.5, 0.08, 0.5, SWAMP_MURK) // brimful
  grid.block(ix, iz)
}

/** A lost boot hoisted on a memorial post. Blocks the cell. */
function bootPost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const leather = rng.pick(BOOT_LEATHER)
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.22, 1.1 + rng.range(0, 0.5), 0.22, WOOD_DARK)
  const y = 1.1 + rng.range(0, 0.5)
  batches.misc.add(ix + 0.22, y, iz + 0.28, 0.52, 0.62, 0.44, leather) // shaft
  batches.misc.add(ix + 0.22, y, iz + 0.62, 0.52, 0.28, 0.5, leather) // toe
  grid.block(ix, iz)
}

/** Decorative murk puddle — walk-over, no collision. */
function puddle(ctx: Ctx, x: number, z: number): void {
  const { rng, batches } = ctx
  const w = rng.range(1, 2.4)
  batches.misc.add(x, 0, z, w, 0.07, w * rng.range(0.5, 0.9), SWAMP_MURK)
}

/** Lily pad floating on a pond slab — decorative, no collision. */
function lilyPad(ctx: Ctx, x: number, z: number, y: number): void {
  const { rng, batches } = ctx
  const w = rng.range(0.6, 1.1)
  batches.leaf.add(x, y, z, w, 0.08, w * 0.9, rng.pick(LILY))
  if (rng.next() < 0.3) {
    batches.misc.add(x + w * 0.3, y + 0.08, z + w * 0.3, 0.22, 0.18, 0.22, rng.pick(FLOWER))
  }
}

/**
 * Stamp an elliptical murk pond (S_RIVER) BEFORE the ground pass. Returns
 * nothing; pair with murkSlab AFTER the pass for the water surface.
 */
function pondStamp(ctx: Ctx, cx: number, cz: number, rx: number, rz: number): void {
  for (let ix = cx - rx; ix <= cx + rx; ix++) {
    for (let iz = cz - rz; iz <= cz + rz; iz++) {
      const nx = (ix - cx) / rx
      const nz = (iz - cz) / rz
      if (nx * nx + nz * nz <= 1) setSurface(ctx, ix, iz, S_RIVER)
    }
  }
}

/** One murk-water slab over a stamped pond (call AFTER streamGroundPass). */
function murkSlab(ctx: Ctx, cx: number, cz: number, rx: number, rz: number): void {
  ctx.batches.misc.add(cx - rx, -0.6, cz - rz, rx * 2 + 1, 0.26, rz * 2 + 1, SWAMP_MURK)
}

/** Sitting frog, knee-high, mid-grudge. Blocks the cell. */
function frog(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const g = rng.pick(FROG_GREEN)
  batches.leaf.add(ix + 0.1, 0, iz + 0.15, 0.8, 0.55, 0.75, g)
  batches.leaf.add(ix + 0.18, 0.55, iz + 0.1, 0.64, 0.42, 0.55, g)
  batches.misc.add(ix + 0.2, 0.92, iz + 0.08, 0.16, 0.16, 0.16, EYE_WHITE)
  batches.misc.add(ix + 0.64, 0.92, iz + 0.08, 0.16, 0.16, 0.16, EYE_WHITE)
  grid.block(ix, iz)
}

/**
 * Half-sunk pirate wreck: listing hull, snapped mast, spilled cargo.
 * ~9x4 footprint along +X. Blocks the hull rect.
 */
function shipWreck(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0, iz, 8, 1.1, 4, rng.pick(WOOD))
  batches.wood.add(ix - 0.6, 1.1, iz - 0.3, 8.6, 0.8, 4.6, rng.pick(WOOD))
  batches.wood.add(ix - 1.4, 0.2, iz + 1.2, 1.6, 1.4, 1.6, WOOD_DARK) // smashed bow
  batches.wood.add(ix + 2.6, 1.9, iz + 0.4, 2.6, 0.3, 3.2, WOOD_DARK) // caved deck
  batches.wood.add(ix + 4.2, 1.9, iz + 1.7, 0.5, 2.1, 0.5, rng.pick(WOOD)) // mast stump
  batches.wood.add(ix + 4.6, 1.9, iz + 2.1, 6, 0.45, 0.45, rng.pick(WOOD)) // fallen mast
  batches.misc.add(ix + 8.6, 1.6, iz + 1.3, 1.6, 0.25, 2, rng.pick(PLASTER)) // sailcloth
  grid.blockRect(ix - 1, iz, 10, 4)
}

/**
 * Mushroom cottage — a solid toadstool somebody fitted with a door, a glow
 * window and (because the resident IS the cottage) a pair of eyes above the
 * lintel. 3x3 stem under a 5x5 cap; blocks the 5x5 overhang.
 */
function shroomCottage(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const cap = rng.pick(MUSHROOM_CAP)
  batches.plaster.add(ix, 0, iz, 3, 2.3, 3, rng.pick(MUSHROOM_STEM)) // stem body
  // stepped spotted cap
  batches.roof.add(ix - 1, 2.3, iz - 1, 5, 0.9, 5, cap)
  batches.roof.add(ix - 0.3, 3.2, iz - 0.3, 3.6, 0.7, 3.6, cap)
  batches.roof.add(ix + 0.6, 3.9, iz + 0.6, 1.8, 0.6, 1.8, cap)
  for (let i = 0; i < 4; i++) {
    batches.misc.add(
      ix - 0.8 + rng.range(0, 4.2), 3.2, iz - 0.8 + rng.range(0, 4.2),
      0.38, 0.12, 0.38, MUSHROOM_SPOT
    )
  }
  // front door (south face) + lintel eyes + a glow window on the east side
  batches.wood.add(ix + 1.05, 0, iz - 0.12, 0.9, 1.6, 0.26, WOOD_DARK)
  batches.misc.add(ix + 0.95, 1.75, iz - 0.1, 0.26, 0.26, 0.2, EYE_WHITE)
  batches.misc.add(ix + 1.8, 1.75, iz - 0.1, 0.26, 0.26, 0.2, EYE_WHITE)
  batches.misc.add(ix + 1.03, 1.82, iz - 0.14, 0.12, 0.12, 0.12, PUPIL)
  batches.misc.add(ix + 1.88, 1.82, iz - 0.14, 0.12, 0.12, 0.12, PUPIL)
  batches.window.add(ix + 2.88, 1.1, iz + 1.1, 0.24, 0.7, 0.8, 0xffc772)
  grid.blockRect(ix - 1, iz - 1, 5, 5)
}

/** Lawn gnome: red cone hat, judgmental. Blocks the cell. */
function gnome(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.plaster.add(ix + 0.3, 0, iz + 0.3, 0.4, 0.5, 0.4, rng.pick(PLASTER))
  batches.misc.add(ix + 0.34, 0.5, iz + 0.34, 0.32, 0.5, 0.32, GNOME_RED)
  batches.misc.add(ix + 0.42, 1, iz + 0.42, 0.16, 0.3, 0.16, GNOME_RED)
  grid.block(ix, iz)
}

/** Post-box on a stick, flag permanently up. Blocks the cell. */
function mailbox(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.4, 0, iz + 0.4, 0.2, 1.1, 0.2, WOOD_DARK)
  batches.misc.add(ix + 0.18, 1.1, iz + 0.25, 0.64, 0.45, 0.5, rng.pick(STONE))
  batches.misc.add(ix + 0.82, 1.3, iz + 0.42, 0.1, 0.4, 0.14, STRAP_RED) // flag
  grid.block(ix, iz)
}

// ---------------------------------------------------------------------------
// Scatter helpers (cluster + whole-zone, rect-clamped, deterministic)
// ---------------------------------------------------------------------------

/**
 * `n` attempts inside radius `r` of (cx, cz), clamped to the zone rect (with
 * margin), skipping water/roads/bridges/ponds and already-blocked cells.
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
    if (s === S_COBBLE || s === S_BRIDGE || s === S_RIVER) continue
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
// soggy_bottoms — The Soggy Bottoms (swamp, lv 52-66, x -720..-600, z 240..360)
// ---------------------------------------------------------------------------

function buildSoggyBottoms(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Surfaces first: the Boot Pond, its boardwalk, and the path in from the
  // east edge (Leechfinger's spur hands over at x -600, z ~300).
  pondStamp(ctx, -660, 300, 9, 7)
  kitBridgePlank(ctx, -672, 299, 24, true)
  kitBridgePlank(ctx, -672, 300, 24, true)
  kitPath(ctx, [[-602, 300], [-616, 306], [-630, 298], [-641, 300], [-647, 300]], 1.2)
  streamGroundPass(ctx, zone)
  murkSlab(ctx, -660, 300, 9, 7)

  // LANDMARK: "The Boot Graveyard" — a pond ringed with hoisted boots, one
  // per victim. The mud keeps the boots; that was always the deal.
  bootPost(ctx, -652, 294)
  bootPost(ctx, -668, 293)
  bootPost(ctx, -672, 302)
  bootPost(ctx, -666, 309)
  bootPost(ctx, -653, 308)
  bootPost(ctx, -649, 303)
  bootPost(ctx, -671, 296)
  signPost(ctx, -648, 297) // "THE MUD TAKES A TOLL. THE TOLL IS BOOTS."
  lilyPad(ctx, -662, 298, -0.33)
  lilyPad(ctx, -657, 303, -0.33)
  lilyPad(ctx, -665, 304, -0.33)

  // LANDMARK: "Sir Squelchalot" — a colossus of some forgotten knight, sunk
  // to the plinth in proud mud, fist still raised at the scenic route.
  kitStatue(ctx, -634, 330)
  {
    const { rng, batches } = ctx
    for (let i = 0; i < 5; i++) { // mud lapping at the plinth
      batches.misc.add(
        -636 + rng.range(0, 6), 0, 328 + rng.range(0, 6),
        rng.range(1, 2.2), rng.range(0.15, 0.35), rng.range(1, 2.2), rng.pick(MUD)
      )
    }
  }
  signPost(ctx, -637, 335) // "HE CHOSE THE SCENIC ROUTE."

  // Nature: drowned trees thick around the pond, mushrooms + puddles beyond.
  scatter(ctx, zone, 16, -660, 300, 18, (ix, iz) => kitDeadTree(ctx, ix, iz))
  scatter(ctx, zone, 8, -634, 331, 12, (ix, iz) =>
    ctx.rng.next() < 0.6 ? kitDeadTree(ctx, ix, iz) : puddle(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 24, (ix, iz) =>
    ctx.rng.next() < 0.6 ? kitDeadTree(ctx, ix, iz) : kitTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 10, (ix, iz) => kitMushroomGiant(ctx, ix, iz))
  scatterZone(ctx, zone, 18, (ix, iz) => puddle(ctx, ix, iz))
  scatterZone(ctx, zone, 8, (ix, iz) => kitRock(ctx, ix, iz, 1))
}

// ---------------------------------------------------------------------------
// leechfinger_fen — Leechfinger Fen (swamp, lv 49-62, x -600..-480, z 240..360)
// ---------------------------------------------------------------------------

function buildLeechfinger(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Surfaces: the Hand's pool, the spa's plunge pool + jetty, the path in
  // from the east edge (Sporeburb's spur hands over at x -480, z ~300) with
  // a branch north to the spa, continuing west toward the Soggy Bottoms.
  pondStamp(ctx, -540, 300, 7, 6)
  pondStamp(ctx, -514, 276, 5, 4)
  kitBridgePlank(ctx, -514, 272, 9, false)
  kitPath(ctx, [[-482, 300], [-496, 294], [-512, 302], [-526, 296], [-532, 298]], 1.2)
  kitPath(ctx, [[-512, 302], [-510, 290], [-511, 282]], 1.1)
  kitPath(ctx, [[-548, 299], [-562, 304], [-578, 298], [-598, 300]], 1.2)
  streamGroundPass(ctx, zone)
  murkSlab(ctx, -540, 300, 7, 6)
  murkSlab(ctx, -514, 276, 5, 4)

  // LANDMARK: "The Grabby Hand" — five wooden fingers breaking the murk,
  // frozen mid-grab. The fen is reaching for YOUR fingers. It collects.
  {
    const { rng, batches, grid } = ctx
    const hx = -542
    const hz = 298
    const fingers: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 3.2], [1.3, -0.6, 4.4], [2.6, -0.8, 4.8], [3.9, -0.6, 4.2], [5, 1.2, 2.6] // thumb last
    ]
    for (const [dx, dz, h] of fingers) {
      batches.wood.add(hx + dx, -0.4, hz + dz, 0.9, h + 0.4, 0.9, rng.pick(WOOD))
      batches.wood.add(hx + dx + 0.08, h - 0.3, hz + dz - 0.3, 0.74, 0.74, 0.74, WOOD_DARK) // curled tip
    }
    batches.wood.add(hx + 0.4, -0.4, hz + 1.4, 4.6, 1.5, 1.6, WOOD_DARK) // knuckle ridge
    grid.blockRect(hx - 1, hz - 1, 8, 7)
  }
  signPost(ctx, -534, 294) // "DO NOT HIGH-FIVE THE FEN."

  // LANDMARK: "Madame Suckerpunch's Leech Spa" — treatments start at 'all
  // your blood'; the five-star reviews are all written in the same hand.
  kitHut(ctx, -520, 264)
  signPost(ctx, -515, 268) // "FULL-BODY EXFOLIATION (NON-NEGOTIABLE)"
  barrel(ctx, -522, 270)
  crate(ctx, -523, 262)
  kitCampfire(ctx, -518, 271) // ember use 1/2 — towel-warming fire
  frog(ctx, -510, 274) // regular customer, visibly lighter

  // Nature: drowned wood crowding the hand, cozy ring at the spa.
  scatter(ctx, zone, 14, -540, 300, 16, (ix, iz) => kitDeadTree(ctx, ix, iz))
  scatter(ctx, zone, 10, -518, 268, 13, (ix, iz) =>
    ctx.rng.next() < 0.5 ? kitMushroomGiant(ctx, ix, iz) : kitTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 22, (ix, iz) =>
    ctx.rng.next() < 0.65 ? kitDeadTree(ctx, ix, iz) : kitTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 16, (ix, iz) => puddle(ctx, ix, iz))
  scatterZone(ctx, zone, 6, (ix, iz) => frog(ctx, ix, iz))
  scatterZone(ctx, zone, 6, (ix, iz) => kitRock(ctx, ix, iz, 1))
}

// ---------------------------------------------------------------------------
// sporeburb — Sporeburb (mushroom, lv 34-47, x -480..-360, z 240..360)
// ---------------------------------------------------------------------------

function buildSporeburb(ctx: Ctx, scene: THREE.Scene, zone: ZoneDef): void {
  // Surfaces: the cul-de-sac plaza disc + the spur in from the SW arterial
  // (which clips this zone's SE corner at ~(-362, 356)), handing another
  // spur west toward Leechfinger.
  {
    const cx = -420
    const cz = 296
    for (let ix = cx - 5; ix <= cx + 5; ix++) {
      for (let iz = cz - 5; iz <= cz + 5; iz++) {
        if ((ix - cx) * (ix - cx) + (iz - cz) * (iz - cz) <= 25) setSurface(ctx, ix, iz, S_COBBLE)
      }
    }
  }
  kitPath(ctx, [[-363, 355], [-378, 342], [-396, 330], [-410, 312], [-417, 301]], 1.3)
  kitPath(ctx, [[-425, 296], [-444, 300], [-462, 296], [-478, 300]], 1.2)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Cul-de-Shroom" — four mushroom cottages around a cobble
  // circle. The cottages ARE the residents; wave at the windows, not into them.
  shroomCottage(ctx, -429, 288)
  shroomCottage(ctx, -414, 286)
  shroomCottage(ctx, -431, 301)
  shroomCottage(ctx, -412, 303)
  mailbox(ctx, -425, 292)
  mailbox(ctx, -416, 291)
  mailbox(ctx, -426, 300)
  kitLantern(ctx, scene, -420, 295) // the zone's single lantern, mid-circle
  signPost(ctx, -414, 298) // "SPOREBURB — QUIET HOURS: ALWAYS. SPORES: ALSO ALWAYS."

  // LANDMARK: "Lawn of the Month" — a fenced square of suspiciously perfect
  // grass. The gnome judges. The gnome has ALWAYS judged.
  kitFenceRun(ctx, -398, 320, 7, true)
  kitFenceRun(ctx, -398, 326, 7, true)
  kitFenceRun(ctx, -398, 321, 5, false)
  kitFenceRun(ctx, -392, 321, 5, false)
  gnome(ctx, -395, 323)
  signPost(ctx, -399, 318) // "LAWN OF THE MONTH: 214 CONSECUTIVE MONTHS"
  {
    const { rng, batches } = ctx
    for (let i = 0; i < 6; i++) { // prize flowers, militantly aligned
      batches.misc.add(-397 + i, 0, 322.4, 0.2, 0.42, 0.2, rng.pick(FLOWER))
      batches.misc.add(-397 + i, 0, 324.4, 0.2, 0.42, 0.2, rng.pick(FLOWER))
    }
  }

  // Nature: toadstool thickets hugging the burb, thinning to lone caps.
  scatter(ctx, zone, 18, -421, 295, 20, (ix, iz) => kitMushroomGiant(ctx, ix, iz))
  scatter(ctx, zone, 8, -395, 323, 12, (ix, iz) =>
    ctx.rng.next() < 0.5 ? kitMushroomGiant(ctx, ix, iz) : kitTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 22, (ix, iz) =>
    ctx.rng.next() < 0.55 ? kitMushroomGiant(ctx, ix, iz) : kitTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 10, (ix, iz) => kitRock(ctx, ix, iz, 1))
  scatterZone(ctx, zone, 8, (ix, iz) => puddle(ctx, ix, iz))
}

// ---------------------------------------------------------------------------
// bogwater_deluxe — Bogwater Deluxe (swamp, lv 56-70, x -720..-600, z 360..520)
// ---------------------------------------------------------------------------

function buildBogwaterDeluxe(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Surfaces: the Grin's pool, the resort promenade, the path in from the
  // east edge (the Croakening's spur hands over at x -600, z ~470).
  pondStamp(ctx, -662, 418, 8, 6)
  kitBridgePlank(ctx, -648, 472, 14, true)
  kitBridgePlank(ctx, -648, 473, 14, true)
  kitPath(ctx, [[-602, 470], [-614, 476], [-626, 470], [-633, 472]], 1.2)
  kitPath(ctx, [[-636, 466], [-644, 450], [-654, 434], [-659, 426]], 1.1)
  streamGroundPass(ctx, zone)
  murkSlab(ctx, -662, 418, 8, 6)

  // LANDMARK: "The Gator Grin" — a pool ringed with stone teeth. Thrice the
  // teeth, as advertised. The pool is smiling. Pools should not smile.
  {
    const { rng, batches, grid } = ctx
    const teeth = 11
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2
      const tx = Math.floor(-662 + Math.cos(a) * 9.6)
      const tz = Math.floor(418 + Math.sin(a) * 7.6)
      const h = 1.2 + rng.range(0, 1.4)
      const c = rng.pick(FANG_STONE)
      batches.stone.add(tx, 0, tz, 0.9, h * 0.55, 0.9, c)
      batches.stone.add(tx + 0.2, h * 0.55, tz + 0.2, 0.5, h * 0.45, 0.5, c) // tapered tip
      grid.block(tx, tz)
    }
  }
  lilyPad(ctx, -664, 416, -0.33)
  lilyPad(ctx, -659, 420, -0.33)
  signPost(ctx, -655, 428) // "SWIM AT OWN RISK. THE RISK IS TEETH."

  // LANDMARK: "The Bogwater Deluxe Resort & Spa" — one star, and they had to
  // steal that star. Promenade, lodge, firepit, complimentary damp.
  kitHut(ctx, -642, 476)
  signPost(ctx, -637, 480) // "RESORT & SPA ★ — 'the mud is local' — a review"
  barrel(ctx, -644, 482)
  crate(ctx, -637, 474)
  crate(ctx, -636, 476)
  kitCampfire(ctx, -646, 480) // ember use 1/2 — the 'heated pool'
  frog(ctx, -649, 475) // concierge

  // Nature: drowned trees crowding the grin, cozy clump at the resort.
  scatter(ctx, zone, 16, -662, 418, 17, (ix, iz) => kitDeadTree(ctx, ix, iz))
  scatter(ctx, zone, 10, -642, 478, 13, (ix, iz) =>
    ctx.rng.next() < 0.5 ? kitMushroomGiant(ctx, ix, iz) : kitDeadTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 26, (ix, iz) =>
    ctx.rng.next() < 0.7 ? kitDeadTree(ctx, ix, iz) : kitTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 18, (ix, iz) => puddle(ctx, ix, iz))
  scatterZone(ctx, zone, 8, (ix, iz) => kitBone(ctx, ix, iz)) // previous guests
  scatterZone(ctx, zone, 6, (ix, iz) => kitRock(ctx, ix, iz, 2))
}

// ---------------------------------------------------------------------------
// croakening — The Croakening (swamp, lv 58-74, x -600..-480, z 360..520)
// waystone ws_croakening at (-540, 440) — kept clear + reachable
// ---------------------------------------------------------------------------

function buildCroakening(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Surfaces: the nursery pond, then paths — the SW arterial crosses this
  // zone's SE corner (~(-500, 500)); spur from it to the waystone, branches
  // to Big Gerald and the nursery, and a hand-off west toward Bogwater.
  pondStamp(ctx, -516, 398, 7, 5)
  kitPath(ctx, [[-500, 500], [-512, 484], [-524, 466], [-534, 450], [-540, 441]], 1.3)
  kitPath(ctx, [[-540, 438], [-550, 426], [-558, 416]], 1.1)
  kitPath(ctx, [[-538, 436], [-528, 420], [-520, 406]], 1.1)
  kitPath(ctx, [[-543, 442], [-560, 452], [-580, 464], [-598, 470]], 1.2)
  streamGroundPass(ctx, zone)
  murkSlab(ctx, -516, 398, 7, 5)

  // LANDMARK: "Big Gerald" — a frog the size of a shed, because the frogs
  // here ARE the size of sheds. Gerald does not hop. Gerald WAITS.
  {
    const { rng, batches, grid } = ctx
    const gx = -566
    const gz = 404
    const g = rng.pick(FROG_GREEN)
    batches.leaf.add(gx, 0, gz, 6, 3.2, 5, g) // shed-grade body
    batches.leaf.add(gx + 0.6, 3.2, gz + 0.6, 4.8, 1.5, 3.6, g) // head hump
    batches.misc.add(gx + 0.6, 0.4, gz + 4.6, 4.8, 1.5, 0.5, FROG_BELLY) // belly front
    batches.misc.add(gx + 0.9, 1.9, gz + 4.5, 4.2, 0.5, 0.4, PUPIL) // the Mouth (closed, for now)
    batches.leaf.add(gx + 1, 4.7, gz + 3.4, 1.2, 1.1, 1.2, g) // eye stalks
    batches.leaf.add(gx + 3.8, 4.7, gz + 3.4, 1.2, 1.1, 1.2, g)
    batches.misc.add(gx + 1.2, 5.3, gz + 3.9, 0.8, 0.7, 0.7, EYE_WHITE)
    batches.misc.add(gx + 4, 5.3, gz + 3.9, 0.8, 0.7, 0.7, EYE_WHITE)
    batches.misc.add(gx + 1.4, 5.5, gz + 4.35, 0.4, 0.35, 0.3, PUPIL)
    batches.misc.add(gx + 4.2, 5.5, gz + 4.35, 0.4, 0.35, 0.3, PUPIL)
    batches.leaf.add(gx - 1, 0, gz + 3.2, 1.3, 1.7, 1.7, g) // haunches
    batches.leaf.add(gx + 5.7, 0, gz + 3.2, 1.3, 1.7, 1.7, g)
    grid.blockRect(gx - 2, gz - 1, 10, 8)
  }
  signPost(ctx, -558, 412) // "BIG GERALD: DO NOT FEED. DO NOT TAUNT. DO NOT LOSE."

  // LANDMARK: "The Grudge Nursery" — the tadpole pond, ringed with tiny
  // memorial stones for every slight ever committed against a tadpole.
  // They remember. Oh, they remember.
  kitGrave(ctx, -524, 392)
  kitGrave(ctx, -510, 391)
  kitGrave(ctx, -507, 400)
  kitGrave(ctx, -512, 405)
  kitGrave(ctx, -522, 404)
  signPost(ctx, -525, 397) // "GRUDGE NURSERY — 'splashed me, 3rd of Mudmonth' etc."
  lilyPad(ctx, -518, 396, -0.33)
  lilyPad(ctx, -513, 399, -0.33)
  lilyPad(ctx, -516, 401, -0.33)
  frog(ctx, -508, 396) // nursery warden
  frog(ctx, -521, 390)

  // Waystone anchor (-540, 440) stays prop-free: nothing below is placed
  // within ~7 cells of it, and scatters skip the circle explicitly.
  const wsClear = (ix: number, iz: number): boolean =>
    (ix + 540) * (ix + 540) + (iz - 440) * (iz - 440) > 49

  // Nature: a drowned forest with lurking extras.
  scatter(ctx, zone, 14, -566, 406, 16, (ix, iz) => {
    if (wsClear(ix, iz)) kitDeadTree(ctx, ix, iz)
  })
  scatter(ctx, zone, 10, -516, 398, 13, (ix, iz) => {
    if (wsClear(ix, iz)) kitDeadTree(ctx, ix, iz)
  })
  scatterZone(ctx, zone, 24, (ix, iz) => {
    if (wsClear(ix, iz)) (ctx.rng.next() < 0.65 ? kitDeadTree : kitTree)(ctx, ix, iz)
  })
  scatterZone(ctx, zone, 10, (ix, iz) => {
    if (wsClear(ix, iz)) kitMushroomGiant(ctx, ix, iz)
  })
  scatterZone(ctx, zone, 16, (ix, iz) => {
    if (wsClear(ix, iz)) puddle(ctx, ix, iz)
  })
  scatterZone(ctx, zone, 8, (ix, iz) => {
    if (wsClear(ix, iz)) frog(ctx, ix, iz)
  })
}

// ---------------------------------------------------------------------------
// mudflap_beach — Mudflap Beach (beach, lv 55-68, x -720..-600, z 520..720)
// The SW arterial terminates INSIDE this zone at (-650, 650).
// ---------------------------------------------------------------------------

function buildMudflapBeach(ctx: Ctx, _scene: THREE.Scene, zone: ZoneDef): void {
  // Surfaces: spurs off the arterial's dead end — north to the Flip-Flop,
  // west to the wreck.
  kitPath(ctx, [[-650, 650], [-646, 632], [-642, 614], [-641, 602]], 1.2)
  kitPath(ctx, [[-652, 652], [-662, 650], [-671, 650]], 1.1)
  streamGroundPass(ctx, zone)

  // LANDMARK: "The Lost Flip-Flop of Gorbo" — a giant's sandal, half-buried
  // heel-first. Somewhere out there, a giant is walking in circles.
  {
    const { rng, batches, grid } = ctx
    const fx = -646
    const fz = 592
    batches.misc.add(fx, 0, fz, 5, 0.9, 10, FOAM_BLUE) // the sole
    batches.misc.add(fx + 0.4, 0.9, fz + 0.4, 4.2, 0.3, 9.2, 0x8fcbe4) // footbed
    batches.misc.add(fx + 2.1, 0.9, fz + 2.2, 0.8, 1.1, 0.8, STRAP_RED) // toe post
    batches.misc.add(fx - 0.2, 1.3, fz + 3.1, 2.8, 0.5, 0.9, STRAP_RED) // strap L
    batches.misc.add(fx + 2.5, 1.3, fz + 3.1, 2.8, 0.5, 0.9, STRAP_RED) // strap R
    // the heel end swallowed by a dune
    batches.misc.add(fx - 1, 0, fz + 7.4, 7, 1.7, 3.6, rng.pick(SAND))
    batches.misc.add(fx - 0.2, 1.7, fz + 8.2, 5.4, 0.7, 2.4, rng.pick(SAND))
    grid.blockRect(fx - 1, fz - 1, 7, 12)
  }
  signPost(ctx, -640, 598) // "LOST: ONE (1) FLIP-FLOP. SENTIMENTAL VALUE: IMMENSE."

  // LANDMARK: "The Apology Owed" — a pirate wreck the tide dumped here and
  // never said sorry for. The crab has claimed salvage rights.
  shipWreck(ctx, -682, 644)
  crate(ctx, -671, 644)
  crate(ctx, -670, 646)
  kitCampfire(ctx, -673, 650) // ember use 1/2 — castaway fire, still going
  kitBone(ctx, -677, 653)
  {
    const { batches, grid } = ctx // Salvage Supervisor Pinchy (a crab)
    batches.misc.add(-668.6, 0, 648.2, 0.8, 0.45, 0.6, STRAP_RED)
    batches.misc.add(-669.1, 0.1, 648.1, 0.35, 0.3, 0.35, STRAP_RED) // claw
    batches.misc.add(-667.6, 0.1, 648.1, 0.35, 0.3, 0.35, STRAP_RED) // other claw
    batches.misc.add(-668.5, 0.45, 648.2, 0.14, 0.22, 0.14, EYE_WHITE)
    batches.misc.add(-668.2, 0.45, 648.2, 0.14, 0.22, 0.14, EYE_WHITE)
    grid.block(-669, 648)
  }
  { // tide pools that never apologize either (walk-over)
    const { rng, batches } = ctx
    for (let i = 0; i < 6; i++) {
      batches.misc.add(
        -700 + rng.range(0, 80), 0, 560 + rng.range(0, 120),
        rng.range(1.4, 3), 0.08, rng.range(1, 2.4), LAGOON_WATER
      )
    }
  }

  // Nature: hunched palms near the landmarks, driftwood + rocks between.
  scatter(ctx, zone, 10, -646, 596, 16, (ix, iz) => kitPalm(ctx, ix, iz))
  scatter(ctx, zone, 8, -676, 648, 14, (ix, iz) =>
    ctx.rng.next() < 0.5 ? kitPalm(ctx, ix, iz) : kitDeadTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 14, (ix, iz) =>
    ctx.rng.next() < 0.55 ? kitPalm(ctx, ix, iz) : kitDeadTree(ctx, ix, iz)
  )
  scatterZone(ctx, zone, 16, (ix, iz) => kitRock(ctx, ix, iz, 1))
  scatterZone(ctx, zone, 6, (ix, iz) => kitBone(ctx, ix, iz))
}

// ---------------------------------------------------------------------------
// Registration — the zones/ barrel calls this (idempotent; last write wins).
// ---------------------------------------------------------------------------

export function registerBatch11(): void {
  registerZoneBuilder('soggy_bottoms', buildSoggyBottoms)
  registerZoneBuilder('leechfinger_fen', buildLeechfinger)
  registerZoneBuilder('sporeburb', buildSporeburb)
  registerZoneBuilder('bogwater_deluxe', buildBogwaterDeluxe)
  registerZoneBuilder('croakening', buildCroakening)
  registerZoneBuilder('mudflap_beach', buildMudflapBeach)
}

// Also register at import time: the world barrel eager-globs zone files, and
// double registration is harmless (same builders, last write wins).
registerBatch11()
