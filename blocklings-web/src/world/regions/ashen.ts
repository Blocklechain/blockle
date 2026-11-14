/**
 * ASHEN DUNGEONS — region builder (x -240..0, z 120..240, lv 12-25, biome
 * dungeon). Scorched surface ruins funneling into a sunken OPEN-AIR dungeon
 * crawl: a gatehouse ruin on the road in, Gravekeeper Sol's chapel +
 * graveyard, then descending walled trenches (walls get taller the deeper
 * you go — that's the "descent" on our flat ground), bone piles, ember
 * braziers, a rib-cage arch run, and the Skeleton King's throne arena at
 * the deepest point. Spooky, but still cozy-voxel: green roofs, warm(ish)
 * ember glow, cute skulls.
 *
 * Keeps clear: the road corridor from the village (waypoints mirrored from
 * ../roads.ts), the Ashen Waystone anchor (-110, 150) and Gravekeeper Sol's
 * cell (-120, 170) — see ../../ids. Lights: 4 point lights total (gatehouse,
 * dungeon mouth, two throne braziers).
 */
import * as THREE from 'three'
import {
  DEAD_WOOD,
  EMBER,
  isLand,
  kitDeadTree,
  kitFenceRun,
  kitHouseShell,
  kitLantern,
  kitPath,
  kitRock,
  STONE
} from '../kit'
import { S_COBBLE, setSurface, type Ctx } from '../layout'

// ---------------------------------------------------------------------------
// Region palette (flat colors only — same vocabulary, charred)
// ---------------------------------------------------------------------------

const CHAR_STONE = [0x6f6f76, 0x62626a, 0x7b7b82] as const
const ASH_PLASTER = [0x9a948a, 0x8d877d] as const
const BONE = [0xe8e2d0, 0xded6c2, 0xf0ead9] as const
const ASH_DRIFT = 0x8e8880
const EYE = 0x26262c

// ---------------------------------------------------------------------------
// Keep-clear geometry (mirrors ../roads.ts + ../../ids anchors)
// ---------------------------------------------------------------------------

const ROAD: ReadonlyArray<readonly [number, number]> = [
  [-52, 90],
  [-72, 108],
  [-88, 126],
  [-102, 140],
  [-110, 150]
]
const WAYSTONE: readonly [number, number] = [-110, 150]
const GRAVEKEEPER: readonly [number, number] = [-120, 170]

function segDist(x: number, z: number, a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  const len2 = dx * dx + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2))
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz))
}

/** True when (x, z) is safely away from the road, waystone and NPC anchors. */
function isClearSpot(x: number, z: number): boolean {
  for (let i = 0; i < ROAD.length - 1; i++) {
    if (segDist(x, z, ROAD[i]!, ROAD[i + 1]!) < 3.5) return false
  }
  if (Math.hypot(x - WAYSTONE[0], z - WAYSTONE[1]) < 5.5) return false
  if (Math.hypot(x - GRAVEKEEPER[0], z - GRAVEKEEPER[1]) < 2.5) return false
  return true
}

// ---------------------------------------------------------------------------
// Dungeon floorplan — trench rects + throne arena disc, as a cell set
// ---------------------------------------------------------------------------

interface TrenchRect {
  x0: number
  x1: number
  z0: number
  z1: number
}

/** Trench segments, shallow → deep (inclusive cell ranges). */
const TRENCHES: readonly TrenchRect[] = [
  { x0: -112, x1: -109, z0: 162, z1: 181 }, // A: south from the mouth
  { x0: -141, x1: -109, z0: 178, z1: 181 }, // B: west
  { x0: -141, x1: -138, z0: 178, z1: 203 }, // C: south (rib-cage run)
  { x0: -163, x1: -138, z0: 200, z1: 203 }, // D: west to the arena
  { x0: -165, x1: -164, z0: 200, z1: 203 } // arena doorway bridge
]

const ARENA_CX = -179
const ARENA_CZ = 202
const ARENA_R = 15

/** Mouth opening — the walk-in gap at the top of trench A. */
const MOUTH_OPEN: ReadonlyArray<readonly [number, number]> = [
  [-112, 161],
  [-111, 161],
  [-110, 161],
  [-109, 161]
]

function key(ix: number, iz: number): number {
  return (ix + 240) * 480 + (iz + 240)
}

function inArena(ix: number, iz: number): boolean {
  const dx = ix + 0.5 - ARENA_CX
  const dz = iz + 0.5 - ARENA_CZ
  return dx * dx + dz * dz <= ARENA_R * ARENA_R
}

function buildFloorSet(): Set<number> {
  const floor = new Set<number>()
  for (const t of TRENCHES) {
    for (let ix = t.x0; ix <= t.x1; ix++) {
      for (let iz = t.z0; iz <= t.z1; iz++) floor.add(key(ix, iz))
    }
  }
  for (let ix = ARENA_CX - ARENA_R - 1; ix <= ARENA_CX + ARENA_R + 1; ix++) {
    for (let iz = ARENA_CZ - ARENA_R - 1; iz <= ARENA_CZ + ARENA_R + 1; iz++) {
      if (inArena(ix, iz)) floor.add(key(ix, iz))
    }
  }
  return floor
}

/** Nominal "depth" (wall height) at a floor cell — taller = deeper. */
function depthAt(ix: number, iz: number): number {
  if (inArena(ix, iz)) return 5
  if (ix <= -138 && iz >= 200) return 4.6 // D
  if (ix <= -137) return 4.2 // C
  if (iz >= 178) return 3.4 // B
  return 2.4 // A
}

// ---------------------------------------------------------------------------
// Small prop builders (region-local, same voxel vocabulary)
// ---------------------------------------------------------------------------

/** Cute skull: ivory cube, two dark eye sockets. ~3 instances. */
function skull(ctx: Ctx, x: number, y: number, z: number, s = 0.6): void {
  const { rng, batches } = ctx
  batches.stone.add(x, y, z, s, s, s, rng.pick(BONE))
  const e = s * 0.22
  batches.misc.add(x + s * 0.16, y + s * 0.45, z - 0.02, e, e, 0.08, EYE)
  batches.misc.add(x + s * 0.62, y + s * 0.45, z - 0.02, e, e, 0.08, EYE)
}

/** Heap of bones + optional skull on top. Blocks the cell. */
function bonePile(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const n = 2 + rng.int(3)
  for (let i = 0; i < n; i++) {
    const long = rng.next() < 0.5
    batches.stone.add(
      ix + rng.range(0, 0.55),
      i * 0.16,
      iz + rng.range(0, 0.55),
      long ? 0.9 : 0.35,
      0.22,
      long ? 0.3 : 0.9,
      rng.pick(BONE)
    )
  }
  if (rng.next() < 0.6) skull(ctx, ix + rng.range(0.05, 0.35), n * 0.16, iz + rng.range(0.05, 0.35), 0.55)
  grid.block(ix, iz)
}

/** Leaning headstone (or a collapsed one). Blocks the cell. */
function gravestone(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix + 0.15, 0, iz + 0.15, 0.8, 0.22, 0.6, rng.pick(STONE))
  if (rng.next() < 0.25) {
    // toppled slab — the dead get lazy too
    batches.stone.add(ix + 0.1, 0.22, iz + 0.1, 0.5, 0.2, 0.9, rng.pick(STONE))
  } else {
    batches.stone.add(ix + 0.3, 0.2, iz + 0.3, 0.5, rng.range(0.7, 1.1), 0.28, rng.pick(STONE))
  }
  grid.block(ix, iz)
}

/** Stone pedestal + flickering ember flame (window batch — NO light). */
function brazier(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix + 0.2, 0, iz + 0.2, 0.6, 0.9, 0.6, rng.pick(CHAR_STONE))
  batches.stone.add(ix + 0.12, 0.9, iz + 0.12, 0.76, 0.2, 0.76, rng.pick(CHAR_STONE))
  batches.window.add(ix + 0.3, 1.1, iz + 0.3, 0.4, 0.45, 0.4, EMBER)
  grid.block(ix, iz)
}

/** Low walkable ash drift — soft grey mound, purely cosmetic. */
function ashDrift(ctx: Ctx, x: number, z: number): void {
  const { rng, batches } = ctx
  batches.path.add(x - 0.2, 0, z - 0.2, 1.4, 0.14, 1.4, ASH_DRIFT)
  if (rng.next() < 0.6) batches.path.add(x + 0.1, 0.14, z + 0.1, 0.8, 0.12, 0.8, ASH_DRIFT)
}

/** Charred boulder with a glowing ember seam. Blocks the cell. */
function emberStone(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(ix, 0, iz, 1, rng.range(0.5, 0.9), 1, 0x44444b)
  batches.window.add(ix + 0.3, 0.5, iz + 0.3, 0.38, 0.16, 0.38, EMBER)
  grid.block(ix, iz)
}

/**
 * Roofless burnt-out building shell: ragged perimeter wall stubs, charred
 * fallen beams, rubble inside. Gaps in the wall stay walkable.
 */
function ruinShell(ctx: Ctx, x0: number, z0: number, w: number, d: number): void {
  const { rng, batches, grid } = ctx
  const x1 = x0 + w - 1
  const z1 = z0 + d - 1
  for (let ix = x0; ix <= x1; ix++) {
    for (let iz = z0; iz <= z1; iz++) {
      const isWall = ix === x0 || ix === x1 || iz === z0 || iz === z1
      if (!isWall) continue
      if (rng.next() < 0.22) continue // collapsed gap — walk right in
      const corner = (ix === x0 || ix === x1) && (iz === z0 || iz === z1)
      const h = corner ? rng.range(1.6, 2.8) : rng.range(0.4, 2.2)
      batches.stone.add(ix, 0, iz, 1, h, 1, rng.pick(CHAR_STONE))
      if (!corner && rng.next() < 0.18) {
        batches.wood.add(ix + 0.3, h, iz + 0.3, 0.4, rng.range(0.4, 0.9), 0.4, rng.pick(DEAD_WOOD))
      }
      grid.block(ix, iz)
    }
  }
  // fallen charred roof beam across the inside
  batches.wood.add(x0 + 1, 0.1, z0 + 1 + rng.int(Math.max(1, d - 3)), w - 2, 0.3, 0.4, rng.pick(DEAD_WOOD))
  if (rng.next() < 0.7) bonePile(ctx, x0 + 1 + rng.int(w - 2), z0 + 1 + rng.int(d - 2))
}

/** Broken round-ish tower: ring of jagged wall columns + rubble. */
function ruinTower(ctx: Ctx, x0: number, z0: number, size: number, hBase: number): void {
  const { rng, batches, grid } = ctx
  for (let ix = x0; ix < x0 + size; ix++) {
    for (let iz = z0; iz < z0 + size; iz++) {
      const ring = ix === x0 || ix === x0 + size - 1 || iz === z0 || iz === z0 + size - 1
      if (!ring) continue
      const h = Math.max(0.4, hBase + rng.range(-1.6, 1.2))
      batches.stone.add(ix, 0, iz, 1, h, 1, rng.pick(CHAR_STONE))
    }
  }
  grid.blockRect(x0, z0, size, size)
  kitRock(ctx, x0 + size, z0 - 1, 1)
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/** Two crumbled towers flanking the road where it enters the ashlands. */
function buildGatehouse(ctx: Ctx, scene: THREE.Scene): void {
  ruinTower(ctx, -95, 122, 3, 3.2)
  ruinTower(ctx, -84, 130, 3, 3.2)
  skull(ctx, -93.8, 3.4, 123, 0.7) // doorman
  kitLantern(ctx, scene, -83, 133, EMBER) // light 1 of 4
}

/** Gravekeeper Sol's chapel + fenced graveyard (NPC anchor kept clear). */
function buildChapelAndGraveyard(ctx: Ctx): void {
  const { rng } = ctx
  kitHouseShell(
    ctx,
    { x0: -135, z0: 157, w: 6, d: 6, wallH: 3, door: 'E', chimney: true },
    { stone: CHAR_STONE, plaster: ASH_PLASTER, timber: DEAD_WOOD[0] as number }
  )
  // paths: waystone → chapel door → graveyard gate
  kitPath(ctx, [
    [-111, 153],
    [-118, 158],
    [-126, 161]
  ])
  kitPath(ctx, [
    [-128, 160],
    [-124, 163],
    [-122, 166]
  ])

  // ragged fence ring (gaps = gates; the dead don't file complaints).
  // Sits ENTIRELY north of trench B (z >= 178) — the plots end at z 176.
  kitFenceRun(ctx, -133, 163, 14, false) // west side
  kitFenceRun(ctx, -119, 163, 5, false) // east, upper
  kitFenceRun(ctx, -119, 171, 6, false) // east, lower (gap = Sol's gate)
  kitFenceRun(ctx, -133, 176, 9, true) // south, west half
  kitFenceRun(ctx, -123, 176, 5, true) // south, east half
  kitFenceRun(ctx, -132, 163, 7, true) // north, west half (gate x -125..-121)

  // grave rows — aisles kept open, Sol's spot (-120, 170) untouched
  for (let gx = -131; gx <= -121; gx += 2) {
    for (let gz = 166; gz <= 175; gz += 3) {
      if (Math.abs(gx - GRAVEKEEPER[0]) <= 1 && Math.abs(gz - GRAVEKEEPER[1]) <= 1) continue
      if (rng.next() < 0.18) continue // unsold plot
      gravestone(ctx, gx, gz)
    }
  }
  // mourning trees
  kitDeadTree(ctx, -136, 168)
  kitDeadTree(ctx, -136, 175)
  kitDeadTree(ctx, -116, 164)
}

/** Burnt hamlet, a lone still-lived-in outpost, and a broken watchtower. */
function buildRuinField(ctx: Ctx): void {
  ruinShell(ctx, -60, 134, 8, 6)
  ruinShell(ctx, -42, 150, 6, 5)
  ruinShell(ctx, -24, 130, 7, 5)
  ruinShell(ctx, -70, 165, 6, 6)
  ruinTower(ctx, -30, 200, 4, 4.5)
  // one stubborn resident — glowing windows, green roof, zero self-awareness
  kitHouseShell(
    ctx,
    { x0: -52, z0: 188, w: 7, d: 6, wallH: 3, door: 'N', chimney: true },
    { stone: CHAR_STONE, plaster: ASH_PLASTER, timber: DEAD_WOOD[0] as number }
  )
}

/** Walled trench crawl: floors stamped cobble, walls rise as you descend. */
function buildTrenches(ctx: Ctx, floor: Set<number>): void {
  const { rng, batches, grid } = ctx

  // trench floors become laid flagstone (arena keeps raw charcoal + embers)
  for (const t of TRENCHES) {
    for (let ix = t.x0; ix <= t.x1; ix++) {
      for (let iz = t.z0; iz <= t.z1; iz++) setSurface(ctx, ix, iz, S_COBBLE)
    }
  }

  const open = new Set<number>(MOUTH_OPEN.map(([x, z]) => key(x, z)))
  const wall = new Set<number>()

  // mouth jambs — fixed height so the gate dresses them exactly
  const jambs: ReadonlyArray<readonly [number, number]> = [
    [-113, 161],
    [-108, 161]
  ]
  for (const [jx, jz] of jambs) {
    wall.add(key(jx, jz))
    batches.stone.add(jx, 0, jz, 1, 3, 1, rng.pick(CHAR_STONE))
    skull(ctx, jx + 0.2, 3.5, jz + 0.2, 0.6)
    grid.block(jx, jz)
  }
  batches.stone.add(-113, 3, 161, 6, 0.5, 1, rng.pick(CHAR_STONE)) // lintel

  // every cell hugging the floor (8-neighborhood) becomes a wall column
  for (const k of floor) {
    const ix = Math.floor(k / 480) - 240
    const iz = (k % 480) - 240
    const depth = depthAt(ix, iz)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue
        const wx = ix + dx
        const wz = iz + dz
        const wk = key(wx, wz)
        if (floor.has(wk) || wall.has(wk) || open.has(wk)) continue
        wall.add(wk)
        const h = Math.max(1.2, depth + rng.range(-0.4, 0.5))
        batches.stone.add(wx, 0, wz, 1, h, 1, rng.pick(CHAR_STONE))
        if (rng.next() < 0.22) {
          batches.stone.add(wx + 0.25, h, wz + 0.25, 0.5, 0.5, 0.5, rng.pick(CHAR_STONE)) // crenel stub
        }
        grid.block(wx, wz)
      }
    }
  }

  // corner braziers (flame only — no lights down here, embers do the work)
  brazier(ctx, -141, 178)
  brazier(ctx, -109, 181)
  brazier(ctx, -141, 203)

  // bone piles tucked against the trench walls
  const piles: ReadonlyArray<readonly [number, number]> = [
    [-112, 168],
    [-109, 175],
    [-135, 179],
    [-120, 178],
    [-140, 190],
    [-139, 198],
    [-150, 200],
    [-160, 203]
  ]
  for (const [px, pz] of piles) bonePile(ctx, px, pz)

  // rib-cage arches over the deep run (segment C) — somebody BIG died here
  for (const rz of [186, 190, 194, 198]) {
    batches.stone.add(-141.7, 4.1, rz + 0.3, 0.4, 1.4, 0.4, rng.pick(BONE))
    batches.stone.add(-136.7, 4.1, rz + 0.3, 0.4, 1.4, 0.4, rng.pick(BONE))
    batches.stone.add(-142, 5.4, rz + 0.3, 6, 0.4, 0.5, rng.pick(BONE))
  }
}

/** The Skeleton King's throne arena — deepest point of the crawl. */
function buildArena(ctx: Ctx, scene: THREE.Scene): void {
  const { rng, batches, grid } = ctx

  // ember cracks radiating from the throne (shares the window flicker)
  for (let i = 0; i < 18; i++) {
    const ang = rng.range(0, Math.PI * 2)
    const r0 = rng.range(3, 10)
    const len = rng.range(1.2, 2.6)
    const x = ARENA_CX + Math.cos(ang) * r0
    const z = ARENA_CZ + Math.sin(ang) * r0
    batches.window.add(x, 0, z, Math.abs(Math.cos(ang)) * len + 0.3, 0.12, Math.abs(Math.sin(ang)) * len + 0.3, EMBER)
  }

  // bone-stake ring (gaps at the doorway east and the dais west)
  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2
    if (Math.abs(Math.cos(ang)) > 0.88) continue
    const sx = Math.floor(ARENA_CX + Math.cos(ang) * 12.5)
    const sz = Math.floor(ARENA_CZ + Math.sin(ang) * 12.5)
    batches.stone.add(sx + 0.3, 0, sz + 0.3, 0.4, rng.range(1, 1.6), 0.4, rng.pick(BONE))
    if (rng.next() < 0.4) skull(ctx, sx + 0.22, rng.range(1, 1.5), sz + 0.22, 0.55)
    grid.block(sx, sz)
  }
  bonePile(ctx, -175, 193)
  bonePile(ctx, -172, 211)
  bonePile(ctx, -186, 210)

  // dais — two stone steps up to the king's chair
  batches.stone.add(-192, 0, 198, 7, 0.5, 9, rng.pick(CHAR_STONE))
  batches.stone.add(-191, 0.5, 199.5, 5, 0.5, 6, rng.pick(CHAR_STONE))
  grid.blockRect(-192, 198, 7, 9)

  // the throne itself: high back, armrests, horns, a crown... of skulls
  batches.stone.add(-192, 1, 200.5, 1.2, 3.8, 4, rng.pick(CHAR_STONE)) // back
  batches.stone.add(-190.8, 1, 201.2, 1.6, 0.9, 2.6, rng.pick(CHAR_STONE)) // seat
  batches.stone.add(-190.8, 1, 200.4, 1.8, 1.6, 0.6, rng.pick(CHAR_STONE)) // arm N
  batches.stone.add(-190.8, 1, 204, 1.8, 1.6, 0.6, rng.pick(CHAR_STONE)) // arm S
  batches.stone.add(-191.9, 4.8, 200.6, 0.35, 1.1, 0.35, rng.pick(BONE)) // horn N
  batches.stone.add(-191.9, 4.8, 204.1, 0.35, 1.1, 0.35, rng.pick(BONE)) // horn S
  skull(ctx, -191.9, 4.8, 202.1, 0.8) // crown jewel
  skull(ctx, -190.6, 1.6, 200.5, 0.5) // armrest trophy

  // twin throne braziers — lights 3 + 4 of 4
  for (const bz of [197, 206]) {
    batches.stone.add(-187.3, 0, bz + 0.2, 0.7, 1.6, 0.7, rng.pick(CHAR_STONE))
    batches.window.add(-187.2, 1.6, bz + 0.3, 0.5, 0.5, 0.5, EMBER)
    const light = new THREE.PointLight(EMBER, 14, 12, 1.8)
    light.position.set(-187, 2.1, bz + 0.5)
    scene.add(light)
    grid.block(-187, bz)
  }
}

/** Dungeon mouth dressing + the short path down from the waystone. */
function buildMouth(ctx: Ctx, scene: THREE.Scene): void {
  kitPath(ctx, [
    [-110, 152],
    [-111, 157],
    [-110, 162],
    [-110, 166]
  ])
  kitLantern(ctx, scene, -106, 160, EMBER) // light 2 of 4 — last light going down
  kitDeadTree(ctx, -115, 158)
  bonePile(ctx, -106, 163) // subtle foreshadowing. very subtle.
}

/** Ambient scatter across the scorched flats — everything checks clearance. */
function buildScatter(ctx: Ctx, floor: Set<number>): void {
  const { rng, grid } = ctx
  for (let i = 0; i < 520; i++) {
    const ix = Math.floor(rng.range(-234, -8))
    const iz = Math.floor(rng.range(125, 233))
    if (!isLand(ix, iz) || !isLand(ix + 4, iz) || !isLand(ix - 4, iz) || !isLand(ix, iz + 4) || !isLand(ix, iz - 4)) continue
    if (!isClearSpot(ix + 0.5, iz + 0.5)) continue
    if (floor.has(key(ix, iz)) || grid.isBlocked(ix + 0.5, iz + 0.5)) continue
    // keep a berm around the sunken works so walls stay readable
    if (Math.hypot(ix + 0.5 - ARENA_CX, iz + 0.5 - ARENA_CZ) < ARENA_R + 2.5) continue

    const r = rng.next()
    if (r < 0.3) kitDeadTree(ctx, ix, iz)
    else if (r < 0.5) kitRock(ctx, ix, iz, rng.next() < 0.3 ? 2 : 1)
    else if (r < 0.68) bonePile(ctx, ix, iz)
    else if (r < 0.88) ashDrift(ctx, ix + 0.5, iz + 0.5)
    else emberStone(ctx, ix, iz)
  }
}

// ---------------------------------------------------------------------------

export function buildRegion(ctx: Ctx, scene: THREE.Scene): void {
  buildGatehouse(ctx, scene)
  buildChapelAndGraveyard(ctx)
  buildRuinField(ctx)

  const floor = buildFloorSet()
  buildTrenches(ctx, floor)
  buildMouth(ctx, scene)
  buildArena(ctx, scene)

  buildScatter(ctx, floor)
}
