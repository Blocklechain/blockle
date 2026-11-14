/**
 * src/world/zones/batch8.ts — ZONE_BATCHES[7]: the WEST OUTER FLANK.
 *
 *   worldsedge_cliffs  mountain 55-70  sea cliffs + a lookout for quitters
 *   craggfather        mountain 48-62  one enormous, very judgmental mountain
 *   smugglers_armpit   beach    50-65  pirates with admirably low standards
 *   prism_break        crystal  52-68  weaponized sunlight (waystone zone)
 *   drizzlemire        swamp    48-62  light rain, heavy disappointment
 *   shardlight_hollow  crystal  55-72  the deep crystal heart
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
  CRYSTAL_GLOW,
  PLASTER,
  RUIN_STONE,
  STONE,
  SWAMP_MURK,
  WOOD,
  WOOD_DARK,
  isLand,
  kitBridgePlank,
  kitCampfire,
  kitCrystalShard,
  kitDeadTree,
  kitFenceRun,
  kitHut,
  kitLantern,
  kitMushroomGiant,
  kitPalm,
  kitPath,
  kitPine,
  kitRock,
  kitStatue,
  kitTotem,
  kitTree
} from '../kit'
import { S_GRASS, S_RIVER, setSurface, surfaceAt, type Ctx } from '../layout'

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

/** Stack of smuggler crates + a barrel. Blocks the cell. */
function crateStack(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix, 0, iz, 0.9, 0.9, 0.9, rng.pick(WOOD))
  batches.wood.add(ix + 0.12, 0.9, iz + 0.12, 0.66, 0.66, 0.66, rng.pick(WOOD))
  if (rng.next() < 0.6) {
    batches.wood.add(ix + 0.95, 0, iz + 0.15, 0.6, 0.8, 0.6, WOOD_DARK)
  }
  grid.block(ix, iz)
}

/** A big crystal pillar (shared glow batch), with a stone root. Blocks 1x1. */
function crystalPillar(ctx: Ctx, ix: number, iz: number, h: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix - 0.15, 0, iz - 0.15, 1.3, 0.4, 1.3, rng.pick(STONE))
  batches.window.add(ix, 0.3, iz, 1, h, 1, CRYSTAL_GLOW)
  batches.window.add(ix + 0.25, 0.3 + h, iz + 0.25, 0.5, h * 0.3, 0.5, CRYSTAL_GLOW)
  grid.block(ix, iz)
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function registerBatch8(): void {
  // -------------------------------------------------------------------------
  // WORLDSEDGE CLIFFS (mountain 55-70, x -720..-600, z -240..-80)
  // -------------------------------------------------------------------------
  registerZoneBuilder('worldsedge_cliffs', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Path: continues the spur smugglers_armpit sends up from the W arterial
    // at (-640, -80), winding up to the lookout with a side trip to the statue.
    kitPath(ctx, [
      [-640, -80], [-650, -104], [-644, -128], [-656, -150], [-666, -164]
    ])
    kitPath(ctx, [[-656, -150], [-668, -142], [-676, -138]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Last Lookout": a crumbling cliff-edge watchtower
    // whose final log entry reads "sea still there. still wet." Campfire
    // inside for whoever's turn it is to watch nothing happen. (1 ember use)
    const tw = -670
    const tz = -170
    for (let dx = 0; dx < 5; dx++) {
      for (let dz = 0; dz < 5; dz++) {
        const wall = dx === 0 || dx === 4 || dz === 0 || dz === 4
        if (!wall) continue
        if (dx === 2 && dz === 4) continue // south doorway
        const corner = (dx === 0 || dx === 4) && (dz === 0 || dz === 4)
        // taller on the sea side, crumbled toward the land
        const h = (corner ? 3.4 : 2.6) + (dx < 2 ? 1.4 : 0) + rng.range(0, 1.2)
        batches.stone.add(tw + dx, 0, tz + dz, 1, h, 1, rng.pick(STONE))
        if (h > 4 && rng.next() < 0.6) {
          batches.stone.add(tw + dx + 0.25, h, tz + dz + 0.25, 0.5, 0.5, 0.5, rng.pick(STONE)) // crenel stub
        }
        grid.block(tw + dx, tz + dz)
      }
    }
    kitCampfire(ctx, tw + 2, tz + 2)
    // snapped flagpole + the rag that outranks everyone stationed here
    batches.wood.add(tw + 4.3, 0, tz - 0.6, 0.22, 4.6, 0.22, WOOD_DARK)
    batches.plaster.add(tw + 4.5, 3.6, tz - 0.5, 1.1, 0.8, 0.14, rng.pick(PLASTER))
    grid.block(tw + 4, tz - 1)

    // LANDMARK 2 — "The Overthinker": a colossus sat facing the open ocean,
    // fist raised mid-point, frozen forever one thought from turning back.
    kitStatue(ctx, -680, -140)
    kitRock(ctx, -676, -135, 2)
    kitRock(ctx, -683, -144, 1)

    const clears: Clear[] = [
      { x: -668, z: -168, r: 8 },
      { x: -679, z: -139, r: 6 }
    ]
    // cliff-lip rubble on the sea side, pines inland, rocks all over
    cluster(ctx, -668, -168, 14, 14, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, -716, -236, -688, -96, 26, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(3)) as 1 | 2 | 3))
    scatter(ctx, -688, -236, -604, -84, 30, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, -676, -232, -604, -88, 26, used, clears, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.4 }))
  })

  // -------------------------------------------------------------------------
  // THE CRAGGFATHER (mountain 48-62, x -600..-480, z -240..-80)
  // -------------------------------------------------------------------------
  registerZoneBuilder('craggfather', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Path: continues prism_break's spur from the waystone at (-540, -80)
    // up to the old man's viewing terrace.
    kitPath(ctx, [
      [-540, -80], [-548, -104], [-540, -128], [-550, -148], [-549, -160]
    ])

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Craggfather's Face": the mountain grew a face several
    // eras ago and has disapproved of absolutely everything since. Terraced
    // stone cone with a carved brow, nose, and a beard of old avalanches.
    const fx = -558 // mound west corner
    const fz = -184
    batches.stone.add(fx, 0, fz, 18, 3, 13, rng.pick(STONE)) // base terrace
    batches.stone.add(fx + 2, 3, fz + 1.5, 14, 3, 10, rng.pick(STONE))
    batches.stone.add(fx + 4, 6, fz + 3, 10, 3, 7, rng.pick(STONE))
    batches.stone.add(fx + 6, 9, fz + 4.2, 6, 2.4, 5, rng.pick(STONE))
    batches.stone.add(fx + 7, 11.4, fz + 5, 4, 1.8, 3.4, rng.pick(STONE)) // bald summit
    // the face lives on the south wall (toward the terrace + path)
    const faceZ = fz + 13 // front plane of the base terrace
    batches.stone.add(fx + 5.4, 7.6, faceZ - 2.6, 7.2, 1.1, 0.8, RUIN_STONE[0]!) // monobrow, furrowed
    batches.misc.add(fx + 5.8, 6.4, faceZ - 2.7, 1.8, 1.1, 0.5, BONE_WHITE[0]!) // left eye
    batches.misc.add(fx + 10.4, 6.4, faceZ - 2.7, 1.8, 1.1, 0.5, BONE_WHITE[0]!) // right eye
    batches.stone.add(fx + 6.4, 6.5, faceZ - 2.5, 0.6, 0.8, 0.45, WOOD_DARK) // pupils (judging you)
    batches.stone.add(fx + 11, 6.5, faceZ - 2.5, 0.6, 0.8, 0.45, WOOD_DARK)
    batches.stone.add(fx + 8.3, 4.6, faceZ - 1.6, 1.4, 2.4, 1.2, rng.pick(STONE)) // nose, load-bearing
    // beard: cascading pale rubble from lip to ground
    batches.misc.add(fx + 6.2, 2.6, faceZ - 0.8, 5.6, 1.6, 1, rng.pick(BONE_WHITE))
    batches.misc.add(fx + 5.4, 1.1, faceZ - 0.3, 7.2, 1.5, 1.2, rng.pick(BONE_WHITE))
    batches.misc.add(fx + 4.6, 0, faceZ + 0.4, 8.8, 1.1, 1.6, rng.pick(BONE_WHITE))
    grid.blockRect(fx - 1, fz - 1, 20, 16)

    // LANDMARK 2 — "Beard's End": boulders that rolled out of the beard and
    // kept going, uphill, out of spite (see zone next door). A loose trail.
    kitRock(ctx, -544, -150, 3)
    kitRock(ctx, -536, -138, 3)
    kitRock(ctx, -530, -124, 2)
    kitRock(ctx, -524, -112, 3)
    kitRock(ctx, -520, -98, 2)

    const clears: Clear[] = [
      { x: -549, z: -176, r: 14 },
      { x: -532, z: -124, r: 4 }
    ]
    cluster(ctx, -549, -176, 20, 16, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, -596, -236, -484, -84, 40, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(3)) as 1 | 2 | 3))
    scatter(ctx, -596, -236, -484, -84, 24, used, clears, (x, z) => kitPine(ctx, x, z, { tall: rng.next() < 0.3 }))
  })

  // -------------------------------------------------------------------------
  // SMUGGLER'S ARMPIT (beach 50-65, x -720..-600, z -80..80)
  // -------------------------------------------------------------------------
  registerZoneBuilder('smugglers_armpit', (ctx, scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Spurs off the W arterial (it ends in this cove at ~(-680, 0)):
    // north to Worldsedge Cliffs, south to the Drizzlemire, west to the wreck.
    kitPath(ctx, [[-644, 4], [-640, -28], [-643, -56], [-640, -80]])
    kitPath(ctx, [[-648, 4], [-653, 30], [-644, 56], [-646, 80]])
    kitPath(ctx, [[-660, 2], [-672, 12], [-682, 22]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Leaky Excuse": a smuggler sloop parked at 40 degrees
    // of nope, insurance claim pending since before the premine. Hull, raked
    // mast, torn sail, and the cargo nobody has come back for.
    const hx = -694
    const hz = 20
    batches.wood.add(hx, 0, hz, 10, 1.1, 5, rng.pick(WOOD)) // lower hull
    batches.wood.add(hx - 0.6, 1.1, hz - 0.5, 11.2, 0.9, 6, rng.pick(WOOD)) // flared strake
    batches.wood.add(hx + 10, 0.6, hz + 1.2, 1.6, 1.6, 2.6, WOOD_DARK) // bow jut
    batches.wood.add(hx - 1.2, 1.4, hz + 0.6, 2, 2, 3.8, rng.pick(WOOD)) // stern cabin
    batches.roof.add(hx - 1.5, 3.4, hz + 0.3, 2.6, 0.4, 4.4, WOOD_DARK) // cabin roof
    for (let y = 0; y < 6; y++) {
      batches.wood.add(hx + 5 + y * 0.28, 2 + y * 0.9, hz + 2.2, 0.5, 0.95, 0.5, WOOD_DARK) // raked mast
    }
    batches.wood.add(hx + 4.2, 6.6, hz + 2.3, 4.4, 0.3, 0.3, WOOD_DARK) // yard
    batches.plaster.add(hx + 4.4, 4.4, hz + 2.5, 1.7, 2.2, 0.14, rng.pick(PLASTER)) // torn sail,
    batches.plaster.add(hx + 6.8, 3.6, hz + 2.5, 1.5, 3, 0.14, rng.pick(PLASTER)) //  two sad halves
    batches.wood.add(hx + 6.4, 7.5, hz + 2.1, 0.7, 0.7, 0.7, rng.pick(WOOD)) // crow's nest bucket
    grid.blockRect(hx - 2, hz - 1, 14, 8)
    crateStack(ctx, hx + 12, hz + 6)
    crateStack(ctx, hx + 9, hz + 9)

    // LANDMARK 2 — "Camp Low Standards": the shore operation. One hut, one
    // fence that guards nothing, contraband in plain sight, and the cove's
    // only lantern — lit strictly so customers can find the till.
    // (1 ember use + the zone's 1 lantern)
    kitHut(ctx, -652, 10)
    kitCampfire(ctx, -656, 18)
    kitLantern(ctx, scene, -646, 16)
    kitFenceRun(ctx, -655, 7, 4, true)
    crateStack(ctx, -644, 22)
    crateStack(ctx, -656, 26)
    batches.wood.add(-643, 0, 19, 0.6, 0.8, 0.6, WOOD_DARK) // lone barrel, "SEIZED"
    grid.block(-643, 19)

    const clears: Clear[] = [
      { x: -688, z: 23, r: 10 },
      { x: -650, z: 16, r: 10 }
    ]
    cluster(ctx, -650, 16, 16, 10, used, clears, (x, z) => kitPalm(ctx, x, z))
    cluster(ctx, -686, 26, 13, 7, used, clears, (x, z) => kitPalm(ctx, x, z))
    scatter(ctx, -716, -76, -604, 76, 16, used, clears, (x, z) => kitPalm(ctx, x, z))
    scatter(ctx, -716, -76, -604, 76, 14, used, clears, (x, z) => kitRock(ctx, x, z, 1))
  })

  // -------------------------------------------------------------------------
  // PRISM BREAK (crystal 52-68, x -600..-480, z -80..80, waystone -540,0)
  // -------------------------------------------------------------------------
  registerZoneBuilder('prism_break', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Spurs off the W arterial (which runs right past the waystone):
    // north to the Craggfather, south to Shardlight Hollow, and the
    // escape-route path to the Refractor.
    kitPath(ctx, [[-534, -4], [-538, -28], [-536, -54], [-540, -80]])
    kitPath(ctx, [[-536, 6], [-532, 30], [-538, 56], [-536, 80]])
    kitPath(ctx, [[-522, -6], [-520, -18], [-517, -32], [-516, -42]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Great Refractor": a mega-shard in a broken ring of
    // six cellmate pillars. Turns honest sunlight into court evidence.
    const rx = -516
    const rz = -48
    batches.stone.add(rx - 2, 0, rz - 2, 5, 0.5, 5, rng.pick(STONE)) // dais
    batches.window.add(rx - 1, 0.5, rz - 1, 3, 4.2, 3, CRYSTAL_GLOW)
    batches.window.add(rx - 0.5, 4.7, rz - 0.5, 2, 3.6, 2, CRYSTAL_GLOW)
    batches.window.add(rx, 8.3, rz, 1.1, 2.8, 1.1, CRYSTAL_GLOW)
    batches.window.add(rx + 0.25, 11.1, rz + 0.25, 0.5, 1.4, 0.5, CRYSTAL_GLOW)
    grid.blockRect(rx - 2, rz - 2, 5, 5)
    for (let i = 0; i < 6; i++) {
      if (i === 2) continue // the one that escaped — hence the name
      const a = (i / 6) * Math.PI * 2
      const px = Math.round(rx + Math.cos(a) * 9)
      const pz = Math.round(rz + Math.sin(a) * 9)
      crystalPillar(ctx, px, pz, 2.6 + rng.range(0, 2))
    }
    batches.window.add(rx + 8, 0, rz + 10, 2.2, 0.8, 1.2, CRYSTAL_GLOW) // the escapee, tipped over mid-run
    grid.block(rx + 8, rz + 10)

    // LANDMARK 2 — "Visitation Arch": two leaning pillars straining to touch
    // over the path. Contact denied by the warden (gravity).
    const ax = -520
    const az = -20
    for (let y = 0; y < 4; y++) {
      batches.window.add(ax - 3 + y * 0.45, y * 1.1, az, 0.9, 1.2, 0.9, CRYSTAL_GLOW)
      batches.window.add(ax + 3 - y * 0.45 - 0.9, y * 1.1, az, 0.9, 1.2, 0.9, CRYSTAL_GLOW)
    }
    grid.block(ax - 3, az)
    grid.block(ax + 2, az)

    const clears: Clear[] = [
      { x: -540, z: 0, r: 7 }, // Prism Waystone stays clear + reachable
      { x: rx, z: rz, r: 12 },
      { x: ax, z: az, r: 5 }
    ]
    cluster(ctx, rx, rz, 20, 14, used, clears, (x, z) => kitCrystalShard(ctx, x, z))
    scatter(ctx, -596, -76, -484, 76, 24, used, clears, (x, z) => kitCrystalShard(ctx, x, z))
    scatter(ctx, -596, -76, -484, 76, 22, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
  })

  // -------------------------------------------------------------------------
  // THE DRIZZLEMIRE (swamp 48-62, x -720..-600, z 80..240)
  // -------------------------------------------------------------------------
  registerZoneBuilder('drizzlemire', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Surfaces first: the creek, the pond, the boardwalk, the path.
    // Winding murk creek across the top third of the mire.
    for (let ix = -716; ix <= -604; ix++) {
      const cz = 99 + Math.round(Math.sin(ix * 0.17) * 2)
      setSurface(ctx, ix, cz, S_RIVER)
      setSurface(ctx, ix, cz + 1, S_RIVER)
    }
    // Frog-choir pond (ellipse of murk)
    const px = -668
    const pz = 164
    for (let ix = px - 8; ix <= px + 8; ix++) {
      for (let iz = pz - 6; iz <= pz + 6; iz++) {
        const nx = (ix - px) / 8
        const nz = (iz - pz) / 6
        if (nx * nx + nz * nz <= 1) setSurface(ctx, ix, iz, S_RIVER)
      }
    }
    // Boardwalk over the creek (2 planks wide), then the path south.
    kitBridgePlank(ctx, -647, 94, 9, false)
    kitBridgePlank(ctx, -646, 94, 9, false)
    kitPath(ctx, [[-646, 80], [-647, 92]], 1.1)
    kitPath(ctx, [
      [-647, 104], [-644, 118], [-654, 136], [-662, 150], [-666, 156]
    ])

    streamGroundPass(ctx, zone)

    // murk water over the pond + creek beds (one slab each; hidden under land)
    batches.misc.add(px - 8, -0.6, pz - 6, 17, 0.26, 13, SWAMP_MURK)
    batches.misc.add(-716, -0.6, 96, 113, 0.22, 8, SWAMP_MURK)

    // LANDMARK 1 — "The Frog Choir": five croakers on log risers, one totem
    // conductor. Nightly performances of 'Ribbit in D Minor'. No refunds.
    kitTotem(ctx, px, pz - 9)
    batches.stone.add(px - 1, 0, pz - 9.5, 3, 0.4, 2, rng.pick(STONE)) // podium
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (0.18 + 0.16 * i) // arc around the south rim
      const fx2 = px + Math.cos(a) * 10.5
      const fz2 = pz + Math.sin(a) * 8
      const g = rng.next() < 0.5 ? 0x5fae4a : 0x4c9a3e
      batches.wood.add(fx2, 0, fz2, 0.9, 0.55, 0.9, rng.pick(WOOD)) // log riser
      batches.leaf.add(fx2 + 0.1, 0.55, fz2 + 0.15, 0.7, 0.5, 0.65, g) // frog, mid-note
      batches.leaf.add(fx2 + 0.18, 1.05, fz2 + 0.1, 0.54, 0.4, 0.5, g)
      batches.misc.add(fx2 + 0.2, 1.38, fz2 + 0.08, 0.14, 0.14, 0.14, 0xf3e9d8) // eyes
      batches.misc.add(fx2 + 0.46, 1.38, fz2 + 0.08, 0.14, 0.14, 0.14, 0xf3e9d8)
      grid.block(Math.floor(fx2), Math.floor(fz2))
    }

    // LANDMARK 2 — "Hermit's Damp Villa": one hut, one fire, zero regrets.
    // He moved here to get away from "all that", and by god it worked.
    // (1 ember use)
    kitHut(ctx, -644, 112)
    kitCampfire(ctx, -648, 120)
    batches.wood.add(-638, 0, 114, 0.6, 0.8, 0.6, WOOD_DARK) // rain barrel (decorative; it's always full)
    grid.block(-638, 114)

    const clears: Clear[] = [
      { x: px, z: pz, r: 14 },
      { x: -642, z: 114, r: 9 }
    ]
    cluster(ctx, px, pz, 19, 12, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    cluster(ctx, -642, 114, 14, 8, used, clears, (x, z) => kitMushroomGiant(ctx, x, z))
    scatter(ctx, -716, 84, -604, 236, 26, used, clears, (x, z) => kitDeadTree(ctx, x, z))
    scatter(ctx, -716, 84, -604, 236, 14, used, clears, (x, z) => kitTree(ctx, x, z))
    scatter(ctx, -716, 84, -604, 236, 8, used, clears, (x, z) => kitMushroomGiant(ctx, x, z))
    scatter(ctx, -716, 84, -604, 236, 10, used, clears, (x, z) => kitRock(ctx, x, z, 1))
  })

  // -------------------------------------------------------------------------
  // SHARDLIGHT HOLLOW (crystal 55-72, x -600..-480, z 80..240)
  // -------------------------------------------------------------------------
  registerZoneBuilder('shardlight_hollow', (ctx, _scene, zone) => {
    const { rng, batches, grid } = ctx
    const used = new Set<number>()

    // Path: continues prism_break's spur from (-536, 80) to the sundial,
    // with a branch to the mine.
    kitPath(ctx, [
      [-536, 80], [-532, 100], [-538, 118], [-534, 140], [-532, 152]
    ])
    kitPath(ctx, [[-538, 118], [-554, 122], [-566, 124]], 1.1)

    streamGroundPass(ctx, zone)

    // LANDMARK 1 — "The Contrarian Sundial": the gnomon leans west, the
    // shadow runs the wrong way, and the dial reads whatever time it feels
    // like. Locals set their watches by it anyway, out of respect.
    const sx = -532
    const sz = 160
    batches.stone.add(sx - 5, 0, sz - 5, 11, 0.4, 11, rng.pick(STONE)) // dial slab
    batches.stone.add(sx - 7, 0, sz - 3, 15, 0.25, 7, rng.pick(STONE)) // octagon-ish lips
    batches.stone.add(sx - 3, 0, sz - 7, 7, 0.25, 15, rng.pick(STONE))
    for (let y = 0; y < 4; y++) {
      batches.window.add(sx - y * 0.5, 0.4 + y * 1.0, sz, 1, 1.1, 1, CRYSTAL_GLOW) // gnomon, leaning west
    }
    grid.blockRect(sx - 1, sz - 1, 3, 3)
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      const mx = Math.round(sx + Math.cos(a) * 8)
      const mz = Math.round(sz + Math.sin(a) * 8)
      if (i % 2 === 0) {
        batches.window.add(mx + 0.25, 0, mz + 0.25, 0.5, 1.1 + rng.range(0, 0.5), 0.5, CRYSTAL_GLOW)
      } else {
        batches.stone.add(mx + 0.2, 0, mz + 0.2, 0.6, 0.8 + rng.range(0, 0.4), 0.6, rng.pick(RUIN_STONE))
      }
      grid.block(mx, mz)
    }

    // LANDMARK 2 — "The Glowhole": an abandoned mine mouth in a stone knoll.
    // The prospectors struck light, got rich, got weird, and left. The cart
    // still holds the last load nobody dared cash in.
    const gx = -578
    const gz = 112
    batches.stone.add(gx, 0, gz, 13, 5, 9, rng.pick(STONE)) // knoll
    batches.stone.add(gx + 2, 5, gz + 1.5, 9, 2.6, 6, rng.pick(STONE))
    batches.stone.add(gx + 4, 7.6, gz + 3, 5, 1.8, 3.6, rng.pick(STONE))
    const mz2 = gz + 9 // south face
    batches.misc.add(gx + 5.1, 0, mz2 - 0.6, 2.8, 2.7, 0.8, 0x15151c) // the dark doorway
    batches.wood.add(gx + 4.7, 0, mz2 - 0.3, 0.5, 3, 0.6, WOOD_DARK) // timber frame
    batches.wood.add(gx + 7.9, 0, mz2 - 0.3, 0.5, 3, 0.6, WOOD_DARK)
    batches.wood.add(gx + 4.5, 3, mz2 - 0.35, 4.2, 0.5, 0.7, WOOD_DARK) // lintel
    batches.wood.add(gx + 6.1, -0.05, mz2 + 0.2, 0.18, 0.12, 6, rng.pick(WOOD)) // rails south
    batches.wood.add(gx + 7.1, -0.05, mz2 + 0.2, 0.18, 0.12, 6, rng.pick(WOOD))
    batches.misc.add(gx + 6, 0.3, mz2 + 3, 1.5, 0.9, 1.1, 0x4d4f58) // ore cart
    batches.stone.add(gx + 6.1, 0, mz2 + 3.1, 0.35, 0.35, 0.35, WOOD_DARK) // wheels
    batches.stone.add(gx + 7.2, 0, mz2 + 3.8, 0.35, 0.35, 0.35, WOOD_DARK)
    batches.window.add(gx + 6.3, 1.2, mz2 + 3.3, 0.5, 0.4, 0.5, CRYSTAL_GLOW) // the load in question
    batches.window.add(gx + 6.8, 1.2, mz2 + 3.7, 0.35, 0.55, 0.35, CRYSTAL_GLOW)
    grid.blockRect(gx, gz, 13, 9)
    grid.block(gx + 6, mz2 + 3)
    crateStack(ctx, gx + 10, mz2 + 1)
    kitCrystalShard(ctx, gx + 3, mz2 + 2)
    kitCrystalShard(ctx, gx + 11, mz2 - 1)

    const clears: Clear[] = [
      { x: sx, z: sz, r: 12 },
      { x: gx + 6, z: gz + 5, r: 12 }
    ]
    cluster(ctx, sx, sz, 18, 12, used, clears, (x, z) => kitCrystalShard(ctx, x, z))
    scatter(ctx, -596, 84, -484, 236, 26, used, clears, (x, z) => kitCrystalShard(ctx, x, z))
    scatter(ctx, -596, 84, -484, 236, 24, used, clears, (x, z) => kitRock(ctx, x, z, (1 + rng.int(2)) as 1 | 2))
    scatter(ctx, -596, 84, -484, 236, 8, used, clears, (x, z) => kitDeadTree(ctx, x, z))
  })
}
