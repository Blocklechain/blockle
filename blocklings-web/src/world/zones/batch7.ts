/**
 * src/world/zones/batch7.ts — ZONE BATCH 7: the west inner flank.
 *
 *   rumbling_foothills  The Rumbling Foothills   (mountain,  lv 10-17)
 *   ironvein_hollow     Ironvein Hollow          (mountain,  lv 12-20)
 *   tombstone_flats     Tombstone Flats          (graveyard, lv 16-26)
 *   boulderdash         Boulderdash Basin        (mountain,  lv 27-38)
 *   glimmer_gulch       The Glimmer Gulch        (crystal,   lv 30-44)
 *   funguy_hills        The Funguy Hills         (mushroom,  lv 32-46)
 *
 * Contract per the streaming core: stamp surfaces FIRST (kitPath etc.),
 * then streamGroundPass, then props (kit builders mark collision).
 * Deterministic — every placement flows from the zone-seeded ctx.rng or
 * hand-placed constants, so eviction + re-entry rebuilds bit-for-bit.
 */
import type * as THREE from 'three'
import { registerZoneBuilder, streamGroundPass } from '../stream'
import {
  EMBER,
  MUSHROOM_CAP,
  MUSHROOM_SPOT,
  MUSHROOM_STEM,
  RUIN_STONE,
  CRYSTAL_GLOW,
  STONE,
  WOOD,
  WOOD_DARK,
  STRAW,
  SOIL,
  kitCampfire,
  kitCrystalShard,
  kitDeadTree,
  kitFenceRun,
  kitGrave,
  kitHut,
  kitLantern,
  kitMushroomGiant,
  kitPath,
  kitPine,
  kitRock,
  kitRuinPillar
} from '../kit'
import { S_GRASS, S_SOIL, setSurface, surfaceAt, type Ctx } from '../layout'
import type { ZoneDef } from './registry'

// ---------------------------------------------------------------------------
// Shared placement helpers (deterministic: all randomness from ctx.rng)
// ---------------------------------------------------------------------------

/** [cx, cz, radius] prop keep-out circles (landmarks, waystones). */
type KeepOut = ReadonlyArray<readonly [number, number, number]>

function clearOf(ko: KeepOut, x: number, z: number): boolean {
  for (const [kx, kz, r] of ko) {
    const dx = x - kx
    const dz = z - kz
    if (dx * dx + dz * dz < r * r) return false
  }
  return true
}

/** True when (ix, iz) is open grass, unblocked, and outside every keep-out. */
function placeable(ctx: Ctx, ko: KeepOut, ix: number, iz: number): boolean {
  return (
    surfaceAt(ctx, ix, iz) === S_GRASS &&
    !ctx.grid.isBlocked(ix + 0.5, iz + 0.5) &&
    clearOf(ko, ix + 0.5, iz + 0.5)
  )
}

/** Sparse scatter across the zone rect (inset 4 from edges), n attempts. */
function scatter(
  ctx: Ctx,
  zone: ZoneDef,
  n: number,
  ko: KeepOut,
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < n; i++) {
    const ix = Math.floor(rng.range(zone.x0 + 4, zone.x1 - 4))
    const iz = Math.floor(rng.range(zone.z0 + 4, zone.z1 - 4))
    if (placeable(ctx, ko, ix, iz)) place(ix, iz)
  }
}

/** Cozy-dense ring scatter around a landmark, n attempts in [rMin, rMax]. */
function ring(
  ctx: Ctx,
  cx: number,
  cz: number,
  rMin: number,
  rMax: number,
  n: number,
  ko: KeepOut,
  place: (ix: number, iz: number) => void
): void {
  const { rng } = ctx
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2)
    const r = rng.range(rMin, rMax)
    const ix = Math.floor(cx + Math.cos(a) * r)
    const iz = Math.floor(cz + Math.sin(a) * r)
    if (placeable(ctx, ko, ix, iz)) place(ix, iz)
  }
}

// ---------------------------------------------------------------------------
// Bespoke landmark builders (voxel-box style, collision marked here)
// ---------------------------------------------------------------------------

/** Fumarole crater: stone ring around a sunken ember vent (glow, no light). */
function buildVent(ctx: Ctx, cx: number, cz: number): void {
  const { rng, batches, grid } = ctx
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const rx = Math.floor(cx + Math.cos(a) * 2.6)
    const rz = Math.floor(cz + Math.sin(a) * 2.6)
    const s = rng.range(0.6, 1.1)
    batches.stone.add(rx, 0, rz, s, rng.range(0.5, 1.3), s, rng.pick(STONE))
    grid.block(rx, rz)
  }
  // the vent itself — sunken ember glow on the shared flicker batch
  batches.window.add(cx - 0.7, -0.45, cz - 0.7, 1.4, 0.5, 1.4, EMBER)
  batches.window.add(cx - 0.3, 0.05, cz - 0.3, 0.6, 0.25, 0.6, EMBER)
  grid.blockRect(Math.floor(cx) - 1, Math.floor(cz) - 1, 2, 2)
}

/** Straw lean-to shelter (2x2 footprint). */
function buildLeanTo(ctx: Ctx, x: number, z: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(x + 0.1, 0, z, 0.3, 1.6, 2, rng.pick(WOOD)) // back posts
  batches.misc.add(x, 1.4, z - 0.2, 2.4, 0.22, 2.4, STRAW) // roof slab
  batches.misc.add(x + 1.3, 0.9, z - 0.2, 1.2, 0.22, 2.4, STRAW) // slanted lip
  batches.wood.add(x + 0.3, 0.1, z + 0.3, 1.2, 0.35, 0.5, WOOD_DARK) // bedroll log
  grid.blockRect(Math.floor(x), Math.floor(z), 2, 2)
}

/** Mine mouth: rock mound, timber portal + dark opening (facing +x), rails
 *  and an ore cart. ~35 boxes. */
function buildMineMouth(ctx: Ctx, scene: THREE.Scene, mx: number, mz: number): void {
  const { rng, batches, grid } = ctx
  // the hill the Maw is dug into
  batches.stone.add(mx, 0, mz, 8, 2.2, 9, rng.pick(STONE))
  batches.stone.add(mx + 1, 2.2, mz + 1, 6, 1.5, 7, rng.pick(STONE))
  batches.stone.add(mx + 2, 3.7, mz + 2, 4, 1.1, 5, rng.pick(STONE))
  grid.blockRect(mx, mz, 8, 9)
  // dark opening panel + timber portal frame on the east face
  batches.stone.add(mx + 7.9, 0, mz + 3.6, 0.5, 2.3, 1.8, 0x1d1b22)
  batches.wood.add(mx + 8.1, 0, mz + 3.3, 0.45, 2.6, 0.45, WOOD_DARK)
  batches.wood.add(mx + 8.1, 0, mz + 5.25, 0.45, 2.6, 0.45, WOOD_DARK)
  batches.wood.add(mx + 7.95, 2.6, mz + 3.1, 0.8, 0.45, 2.9, WOOD_DARK)
  // rails heading out of the hole
  for (let i = 0; i < 5; i++) {
    batches.wood.add(mx + 8.6 + i, 0, mz + 3.7, 0.7, 0.1, 1.7, rng.pick(WOOD))
  }
  batches.stone.add(mx + 8.5, 0.1, mz + 3.95, 5.2, 0.12, 0.2, 0x55565e)
  batches.stone.add(mx + 8.5, 0.1, mz + 4.95, 5.2, 0.12, 0.2, 0x55565e)
  // the ore cart, parked forever
  batches.wood.add(mx + 11, 0.22, mz + 3.75, 1.7, 0.9, 1.6, WOOD_DARK)
  batches.stone.add(mx + 11.3, 1.1, mz + 4, 0.5, 0.35, 0.5, rng.pick(STONE))
  batches.stone.add(mx + 11.9, 1.1, mz + 4.4, 0.45, 0.3, 0.45, rng.pick(STONE))
  grid.blockRect(mx + 11, mz + 3, 2, 2)
  // the one lantern this zone gets — somebody still checks on the Maw
  kitLantern(ctx, scene, mx + 8, mz + 2)
}

/** Half-buried spoil heap with an upturned cart wheel-side-up. */
function buildSpoilHeap(ctx: Ctx, cx: number, cz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(cx, 0, cz, 4, 1, 4, rng.pick(RUIN_STONE))
  batches.stone.add(cx + 0.7, 1, cz + 0.7, 2.6, 0.8, 2.6, rng.pick(RUIN_STONE))
  batches.stone.add(cx + 1.3, 1.8, cz + 1.3, 1.3, 0.6, 1.3, rng.pick(STONE))
  batches.wood.add(cx + 3.2, 0.4, cz + 3.1, 1.6, 0.5, 1.3, WOOD_DARK) // upturned cart
  batches.wood.add(cx + 3.4, 0.9, cz + 3.0, 0.7, 0.7, 0.2, rng.pick(WOOD)) // wheel
  batches.wood.add(cx + 4.2, 0.9, cz + 4.0, 0.7, 0.7, 0.2, rng.pick(WOOD))
  grid.blockRect(Math.floor(cx), Math.floor(cz), 5, 5)
}

/** Mausoleum: stone crypt, dark doorway facing +x, stepped slab roof. */
function buildCrypt(ctx: Ctx, scene: THREE.Scene, x0: number, z0: number): void {
  const { rng, batches, grid } = ctx
  const w = 7
  const d = 5
  const h = 2.6
  for (let ix = x0; ix < x0 + w; ix++) {
    for (let iz = z0; iz < z0 + d; iz++) {
      const wall = ix === x0 || ix === x0 + w - 1 || iz === z0 || iz === z0 + d - 1
      if (!wall) continue
      const door = ix === x0 + w - 1 && iz === z0 + 2
      if (door) continue // the doorway void
      batches.stone.add(ix, 0, iz, 1, h, 1, rng.pick(RUIN_STONE))
    }
  }
  batches.stone.add(x0 + w - 1.2, 0, z0 + 2.1, 0.5, 2.2, 0.8, 0x1f2320) // dark door
  batches.stone.add(x0 - 0.4, h, z0 - 0.4, w + 0.8, 0.55, d + 0.8, rng.pick(STONE))
  batches.stone.add(x0 + 0.6, h + 0.55, z0 + 0.6, w - 1.2, 0.5, d - 1.2, rng.pick(RUIN_STONE))
  batches.stone.add(x0 + 2, h + 1.05, z0 + 1.6, w - 4, 0.45, d - 3.2, rng.pick(STONE))
  grid.blockRect(x0, z0, w, d)
  kitRuinPillar(ctx, x0 + w + 1, z0 - 1)
  kitRuinPillar(ctx, x0 + w + 1, z0 + d)
  // one pale, deeply unwelcoming lantern by the door
  kitLantern(ctx, scene, x0 + w + 1, z0 + 2, 0xaef0c0)
}

/** Open grave: soil patch (pre-stamped), dirt mound, abandoned shovel. */
function stampOpenGraveSurface(ctx: Ctx, gx: number, gz: number): void {
  for (let ix = gx; ix < gx + 2; ix++) {
    for (let iz = gz; iz < gz + 3; iz++) setSurface(ctx, ix, iz, S_SOIL)
  }
}
function buildOpenGrave(ctx: Ctx, gx: number, gz: number): void {
  const { batches, grid } = ctx
  batches.misc.add(gx + 2.1, 0, gz + 0.4, 1.3, 0.8, 2.2, SOIL) // the spoil mound
  batches.wood.add(gx + 2.3, 0.8, gz + 1.1, 0.16, 1.5, 0.16, WOOD_DARK) // shovel haft
  batches.misc.add(gx + 2.22, 2.3, gz + 1.02, 0.32, 0.3, 0.32, 0x8a8f96) // blade up
  grid.blockRect(gx + 2, gz, 2, 3)
  kitGrave(ctx, gx - 1, gz + 1)
}

/** The Uphill Boulder — a huge round(ish) rock mid-slope, plus scree. */
function buildBoulder(ctx: Ctx, bx: number, bz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(bx, 0, bz, 4, 1.1, 4, rng.pick(STONE))
  batches.stone.add(bx + 0.4, 1.1, bz + 0.4, 3.2, 1.1, 3.2, rng.pick(STONE))
  batches.stone.add(bx + 0.9, 2.2, bz + 0.9, 2.2, 1, 2.2, rng.pick(STONE))
  batches.stone.add(bx + 1.4, 3.2, bz + 1.4, 1.2, 0.7, 1.2, rng.pick(STONE))
  batches.stone.add(bx - 0.5, 0, bz + 1.2, 0.9, 0.7, 0.9, rng.pick(STONE)) // shoulder
  grid.blockRect(bx, bz, 4, 4)
  // scree trail it (allegedly) rolled up along
  for (let i = 0; i < 9; i++) {
    const sx = bx + 2 + rng.range(0, 3) + i * 1.3
    const sz = bz + 4 + rng.range(0, 2.5) + i * 0.9
    const s = rng.range(0.3, 0.7)
    batches.stone.add(sx, 0, sz, s, s * 0.8, s, rng.pick(STONE))
  }
}

/** Wrecked prospector caravan: tilted cart, spilled crates, looted crystal. */
function buildWreckedCaravan(ctx: Ctx, cx: number, cz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(cx, 0.5, cz, 2.4, 0.4, 1.5, rng.pick(WOOD)) // tilted bed
  batches.wood.add(cx + 0.2, 0.9, cz + 0.05, 2, 0.8, 0.25, rng.pick(WOOD)) // side rail
  batches.wood.add(cx - 0.3, 0, cz + 0.3, 0.9, 0.9, 0.22, WOOD_DARK) // wheel on
  batches.wood.add(cx + 2.6, 0, cz + 1.9, 0.9, 0.22, 0.9, WOOD_DARK) // wheel off, flat
  batches.wood.add(cx + 2.9, 0, cz - 0.9, 0.8, 0.8, 0.8, rng.pick(WOOD)) // crates
  batches.wood.add(cx + 3.7, 0, cz - 0.5, 0.7, 0.7, 0.7, rng.pick(WOOD))
  batches.wood.add(cx + 3.2, 0.8, cz - 0.7, 0.6, 0.6, 0.6, WOOD_DARK)
  // the cargo they died rich holding
  batches.window.add(cx + 2.4, 0, cz + 0.9, 0.3, 0.7, 0.3, CRYSTAL_GLOW)
  batches.window.add(cx + 4.1, 0, cz + 0.3, 0.26, 0.5, 0.26, CRYSTAL_GLOW)
  grid.blockRect(Math.floor(cx), Math.floor(cz) - 1, 5, 3)
}

/** Cap'n Portobello — one colossal mushroom you can walk beneath. */
function buildColossalShroom(ctx: Ctx, sx: number, sz: number): void {
  const { rng, batches, grid } = ctx
  batches.plaster.add(sx, 0, sz, 2, 5, 2, rng.pick(MUSHROOM_STEM)) // trunk-stem
  batches.plaster.add(sx - 0.3, 0, sz - 0.3, 2.6, 0.8, 2.6, rng.pick(MUSHROOM_STEM))
  const cap = rng.pick(MUSHROOM_CAP)
  batches.plaster.add(sx - 2.5, 4.6, sz - 2.5, 7, 0.4, 7, rng.pick(MUSHROOM_STEM)) // gills
  batches.roof.add(sx - 3, 5, sz - 3, 8, 1.2, 8, cap)
  batches.roof.add(sx - 2, 6.2, sz - 2, 6, 1, 6, rng.pick(MUSHROOM_CAP))
  batches.roof.add(sx - 0.5, 7.2, sz - 0.5, 3, 0.9, 3, cap)
  for (let i = 0; i < 9; i++) {
    batches.misc.add(
      sx + rng.range(-2.8, 3.6), 6.2 + rng.range(0, 1.6), sz + rng.range(-2.8, 3.6),
      0.5, 0.18, 0.5, MUSHROOM_SPOT
    )
  }
  grid.blockRect(sx, sz, 2, 2) // only the stem blocks — stroll under the cap
}

// ---------------------------------------------------------------------------
// 1. THE RUMBLING FOOTHILLS — friendly hills, indigestion, magma far below
// ---------------------------------------------------------------------------

registerZoneBuilder('rumbling_foothills', (ctx, _scene, zone) => {
  // LANDMARK A: "The Belching Vent" — a fumarole crater that erupts opinions.
  // LANDMARK B: "Gassy Pete's Base Camp" — the man who maps the burps.
  const vent: readonly [number, number] = [-298, -196]
  const camp: readonly [number, number] = [-270, -128]

  // path: NW arterial (passes ~(-310,-160)) up to the vent, plus a camp spur
  kitPath(ctx, [[-310, -158], [-303, -172], [-307, -184], [-298, -194]])
  kitPath(ctx, [[-276, -131], [-271, -128]], 1.1)
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[vent[0], vent[1], 5], [camp[0], camp[1], 4]]
  buildVent(ctx, vent[0], vent[1]) // ember-glow use 1
  kitCampfire(ctx, camp[0], camp[1]) // ember-glow use 2
  buildLeanTo(ctx, camp[0] - 4, camp[1] - 2)
  kitRock(ctx, camp[0] + 3, camp[1] + 2, 1)

  // cozy-dense pines near the landmarks, sparser foothills between
  ring(ctx, vent[0], vent[1], 6, 16, 26, ko, (x, z) => kitPine(ctx, x, z, { tall: true }))
  ring(ctx, camp[0], camp[1], 5, 12, 14, ko, (x, z) => kitPine(ctx, x, z))
  scatter(ctx, zone, 34, ko, (x, z) => kitPine(ctx, x, z))
  scatter(ctx, zone, 26, ko, (x, z) => kitRock(ctx, x, z, ctx.rng.next() < 0.3 ? 2 : 1))
})

// ---------------------------------------------------------------------------
// 2. IRONVEIN HOLLOW — every pickaxe swing is a gamble (waystone -300, 0)
// ---------------------------------------------------------------------------

registerZoneBuilder('ironvein_hollow', (ctx, scene, zone) => {
  // LANDMARK A: "The Maw" — the abandoned mine mouth nobody abandons politely.
  // LANDMARK B: "The Jackpot That Wasn't" — a spoil heap and an upturned cart.
  const maw: readonly [number, number] = [-344, -46] // mound rect corner
  const heap: readonly [number, number] = [-270, 42]

  // path: W arterial (~(-300, 16)) past the waystone to the Maw + a heap spur
  kitPath(ctx, [[-296, 14], [-302, 8], [-297, 1], [-306, -10], [-318, -24], [-332, -41]])
  kitPath(ctx, [[-262, 11], [-265, 26], [-269, 38], [-268, 43]], 1.1)
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [
    [-300, 0, 6], // waystone anchor stays clear + reachable
    [maw[0] + 6, maw[1] + 4, 12],
    [heap[0] + 2, heap[1] + 2, 6]
  ]
  buildMineMouth(ctx, scene, maw[0], maw[1]) // includes this zone's 1 lantern
  buildSpoilHeap(ctx, heap[0], heap[1])

  ring(ctx, maw[0] + 10, maw[1] + 4, 8, 18, 22, ko, (x, z) =>
    kitRock(ctx, x, z, ctx.rng.next() < 0.35 ? 2 : 1)
  )
  ring(ctx, heap[0], heap[1], 5, 12, 10, ko, (x, z) => kitRock(ctx, x, z, 1))
  scatter(ctx, zone, 24, ko, (x, z) => kitPine(ctx, x, z))
  scatter(ctx, zone, 22, ko, (x, z) => kitRock(ctx, x, z, ctx.rng.next() < 0.25 ? 3 : 1))
})

// ---------------------------------------------------------------------------
// 3. TOMBSTONE FLATS — cheap plots, wandering tenants
// ---------------------------------------------------------------------------

registerZoneBuilder('tombstone_flats', (ctx, scene, zone) => {
  // LANDMARK A: "The Overbooked Mausoleum" — standing room only, forever.
  // LANDMARK B: "The Self-Service Plot" — dig your own, shovel provided.
  const crypt: readonly [number, number] = [-318, 155] // rect corner, 7x5
  const plot: readonly [number, number] = [-278, 122]

  // path in from the SW arterial clipping the SE corner (~(-236, 236))
  kitPath(ctx, [[-243, 232], [-255, 220], [-269, 206], [-283, 192], [-297, 178], [-308, 164]])
  kitPath(ctx, [[-283, 192], [-279, 170], [-273, 146], [-276, 127]], 1.1)
  stampOpenGraveSurface(ctx, plot[0], plot[1])
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[crypt[0] + 3.5, crypt[1] + 2.5, 8], [plot[0] + 1.5, plot[1] + 1.5, 4]]
  buildCrypt(ctx, scene, crypt[0], crypt[1]) // includes the pale lantern
  buildOpenGrave(ctx, plot[0], plot[1])

  // the overflow: orderly-ish grave rows fanning out from the mausoleum
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 7; col++) {
      const gx = crypt[0] - 4 - row * 3
      const gz = crypt[1] - 7 + col * 4 + (row % 2) * 2
      if (placeable(ctx, [], gx, gz)) kitGrave(ctx, gx, gz)
    }
  }
  // broken fence that gave up partway around the yard
  kitFenceRun(ctx, crypt[0] - 8, crypt[1] - 10, 9, true)
  kitFenceRun(ctx, crypt[0] - 8, crypt[1] + 10, 6, true)
  kitFenceRun(ctx, crypt[0] - 8, crypt[1] - 9, 7, false)

  ring(ctx, crypt[0], crypt[1], 10, 20, 20, ko, (x, z) => kitGrave(ctx, x, z))
  ring(ctx, plot[0], plot[1], 4, 10, 8, ko, (x, z) => kitGrave(ctx, x, z))
  scatter(ctx, zone, 26, ko, (x, z) => kitGrave(ctx, x, z))
  scatter(ctx, zone, 18, ko, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, zone, 8, ko, (x, z) => kitRuinPillar(ctx, x, z))
})

// ---------------------------------------------------------------------------
// 4. BOULDERDASH BASIN — the rocks roll uphill, out of pure spite
// ---------------------------------------------------------------------------

registerZoneBuilder('boulderdash', (ctx, _scene, zone) => {
  // LANDMARK A: "The Uphill Boulder" — caught mid-climb, scree trail behind.
  // LANDMARK B: "Sisyphus's Smoke Break" — his campfire. He's due back.
  const boulder: readonly [number, number] = [-436, -172] // rect corner, 4x4
  const camp: readonly [number, number] = [-427, -164]

  // path in from the NW arterial clipping the NE corner (~(-365, -230))
  kitPath(ctx, [[-363, -228], [-377, -216], [-393, -204], [-409, -192], [-421, -181], [-429, -172]])
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[boulder[0] + 2, boulder[1] + 2, 7], [camp[0], camp[1], 4]]
  buildBoulder(ctx, boulder[0], boulder[1])
  kitCampfire(ctx, camp[0], camp[1]) // ember-glow use 1 (and only)
  buildLeanTo(ctx, camp[0] + 2, camp[1] + 2)

  // a basin absolutely lousy with rocks; denser around the big one
  ring(ctx, boulder[0] + 2, boulder[1] + 2, 7, 18, 30, ko, (x, z) =>
    kitRock(ctx, x, z, ctx.rng.next() < 0.4 ? 2 : 1)
  )
  scatter(ctx, zone, 52, ko, (x, z) =>
    kitRock(ctx, x, z, ctx.rng.next() < 0.18 ? 3 : ctx.rng.next() < 0.45 ? 2 : 1)
  )
  scatter(ctx, zone, 12, ko, (x, z) => kitPine(ctx, x, z, { tall: true }))
})

// ---------------------------------------------------------------------------
// 5. THE GLIMMER GULCH — singing crystals that know their own net worth
// ---------------------------------------------------------------------------

registerZoneBuilder('glimmer_gulch', (ctx, _scene, zone) => {
  // LANDMARK A: "The Choir Stall" — a crystal amphitheater, always mid-encore.
  // LANDMARK B: "Prospector's Regret" — a wrecked caravan, cargo still glowing.
  const choir: readonly [number, number] = [-420, -40]
  const wreck: readonly [number, number] = [-398, 36]

  // spurs off the W arterial (passes ~(-440,10)→(-370,-4) through the zone);
  // the south spur runs on to the funguy_hills border to meet their trail
  kitPath(ctx, [[-420, 6], [-416, -8], [-422, -22], [-418, -34], [-420, -40]])
  kitPath(ctx, [[-400, 10], [-404, 24], [-399, 34], [-405, 48], [-413, 62], [-418, 74], [-420, 82]])
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[choir[0], choir[1], 7], [wreck[0] + 2, wreck[1], 6]]
  // the choir: a rough ring of big shards around a performance pit
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.4
    kitCrystalShard(ctx, Math.floor(choir[0] + Math.cos(a) * 4.5), Math.floor(choir[1] + Math.sin(a) * 4.5))
  }
  kitCrystalShard(ctx, choir[0], choir[1] - 1) // the soloist
  buildWreckedCaravan(ctx, wreck[0], wreck[1])

  ring(ctx, choir[0], choir[1], 8, 18, 14, ko, (x, z) => kitCrystalShard(ctx, x, z))
  ring(ctx, wreck[0], wreck[1], 6, 12, 6, ko, (x, z) => kitRock(ctx, x, z, 1))
  scatter(ctx, zone, 16, ko, (x, z) => kitCrystalShard(ctx, x, z))
  scatter(ctx, zone, 26, ko, (x, z) => kitRock(ctx, x, z, ctx.rng.next() < 0.3 ? 2 : 1))
  scatter(ctx, zone, 8, ko, (x, z) => kitDeadTree(ctx, x, z))
})

// ---------------------------------------------------------------------------
// 6. THE FUNGUY HILLS — some of those cap-headed giants ARE mushrooms
// ---------------------------------------------------------------------------

registerZoneBuilder('funguy_hills', (ctx, _scene, zone) => {
  // LANDMARK A: "Cap'n Portobello" — a colossal shroom with a loyal fairy ring.
  // LANDMARK B: "The Spore Loser's Hut" — a hermit who lost an argument with lunch.
  const shroom: readonly [number, number] = [-432, 151] // stem corner, 2x2
  const hut: readonly [number, number] = [-398, 167] // hut corner, 4x4

  // trail in from the north border (meets the glimmer_gulch spur) + hut fork
  kitPath(ctx, [[-420, 78], [-418, 90], [-424, 104], [-418, 118], [-426, 132], [-430, 144], [-431, 150]])
  kitPath(ctx, [[-426, 132], [-414, 146], [-404, 158], [-397, 166]], 1.1)
  streamGroundPass(ctx, zone)

  const ko: KeepOut = [[shroom[0] + 1, shroom[1] + 1, 9], [hut[0] + 2, hut[1] + 2, 6]]
  buildColossalShroom(ctx, shroom[0], shroom[1])
  // the fairy ring, in formation around the Cap'n
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.2
    const fx = Math.floor(shroom[0] + 1 + Math.cos(a) * 7)
    const fz = Math.floor(shroom[1] + 1 + Math.sin(a) * 7)
    if (surfaceAt(ctx, fx, fz) === S_GRASS) kitMushroomGiant(ctx, fx, fz)
  }
  kitHut(ctx, hut[0], hut[1])
  kitFenceRun(ctx, hut[0] - 2, hut[1] + 5, 7, true) // the hermit's "keep out" fence

  ring(ctx, shroom[0], shroom[1], 10, 20, 18, ko, (x, z) => kitMushroomGiant(ctx, x, z))
  ring(ctx, hut[0] + 2, hut[1] + 2, 7, 13, 8, ko, (x, z) => kitMushroomGiant(ctx, x, z))
  scatter(ctx, zone, 24, ko, (x, z) => kitMushroomGiant(ctx, x, z))
  scatter(ctx, zone, 10, ko, (x, z) => kitDeadTree(ctx, x, z))
  scatter(ctx, zone, 10, ko, (x, z) => kitRock(ctx, x, z, 1))
})

/**
 * Barrel hook — the zones/index barrel calls this. Registration actually
 * happens at module import (registerZoneBuilder calls above), so this is an
 * idempotent no-op that exists to give the barrel an explicit import edge.
 */
export function registerBatch7(): void {
  // builders registered at module scope; nothing further to do
}
