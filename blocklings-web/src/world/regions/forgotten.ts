/**
 * THE FORGOTTEN LANDS — region builder.
 *
 * Bounds x in [0, 240], z in [120, 240]; level band 20-40; biome wastes.
 * A purple-grey blasted plain where a kingdom of giants fell over and nobody
 * ever bothered to clean up. Landmarks:
 *   - Gate of the Vanquished — ruined arch pillars flanking the road in from
 *     SOUTH_BRIDGE (the cobble corridor itself stays clear).
 *   - The Fallen King — toppled colossus: broken pedestal, torso slabs, a
 *     crowned head knocked clean off, and an arm still reaching for the crown.
 *   - The Oathbreaker's Rest — a severed stone fist and a giant sword stuck
 *     in a rubble mound. Very legendary. Probably tetanus.
 *   - Grukkmaw war-camp — palisade ring, mud-and-hide huts, war totems with
 *     glowing eyes, skull gateposts, a bonfire (Warchief Grukk's place).
 *   - Waystone Hollow — leaning rune-lit monolith ring around the Forgotten
 *     Waystone anchor (110, 150); the anchor + road approach stay open.
 *   - Hermit Vex's hovel near his anchor (120, 180) — anchor kept walkable.
 *     (He keeps the roof green. It's the one thing he still waters.)
 *   - Crystal scars + stray shards — purple crystals on ONE extra emissive
 *     InstancedMesh; the floating ones slow-bob via onBeforeRender. No new
 *     lights beyond 3 points (bonfire, hollow lantern, hermit lantern).
 * Everything else is a scatter pass: dead trees, rubble, bones, grim tufts.
 *
 * All solids register their cells in the collision grid. The river band
 * (x 44-52), coast sand, roads (+2-cell margin) and both NPC/waystone
 * anchors are left open. kitPath stamps (camp trail, hovel spur) run first
 * so the ground pass renders them as cobble.
 */
import * as THREE from 'three'
import {
  S_BRIDGE,
  S_COBBLE,
  S_GRASS,
  surfaceAt,
  type Ctx
} from '../layout'
import {
  STONE,
  WASTES_GROUND,
  WINDOW_GLOW,
  WOOD,
  WOOD_DARK,
  isLand,
  kitDeadTree,
  kitFenceRun,
  kitHouseShell,
  kitLantern,
  kitPath,
  kitRock
} from '../kit'

// --- region interior (margins keep us off the border props + coast sand)
const X0 = 6
const X1 = 234
const Z0 = 126
const Z1 = 232

// --- local palette (flat colors only, wastes-weathered)
const RUIN_STONE = [0x7d7488, 0x6f6678, 0x8a8094, 0x655c72] as const
const MOSS_PATCH = [0x6f7a52, 0x5f6c4a, 0x77825c] as const
const BONE = [0xd8d2c2, 0xcfc6b2] as const
const HIDE_ROOF = [0x5a4232, 0x4e3a2c, 0x66503c] as const
const MUD_WALL = [0x8a7355, 0x7c6749] as const
const WAR_PAINT = 0xa33b2e
const GOLD = 0xc9a84c
const STEEL = 0x9fa6b2
const SOCKET = 0x2e2838
const TUFT = [0x7b8468, 0x8a7f92, 0x6e765e] as const
const CRYSTAL = [0xb08cff, 0x9a6ff0, 0xc9a8ff, 0x8fd8e8] as const

const WAYSTONE_ANCHOR: readonly [number, number] = [110, 150]
const HERMIT_ANCHOR: readonly [number, number] = [120, 180]
const CAMP: readonly [number, number] = [165, 205]
const CAMP_R = 18

// ---------------------------------------------------------------------------
// Crystal shards — one emissive InstancedMesh; floaters bob in onBeforeRender
// ---------------------------------------------------------------------------

interface Shard {
  /** CENTER x/z (unlike the batches' min-corner convention), base y. */
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  yaw: number
  color: number
  floats: boolean
  phase: number
}

function bakeShards(scene: THREE.Scene, shards: readonly Shard[]): void {
  if (shards.length === 0) return
  const geo = new THREE.BoxGeometry(1, 1, 1)
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: 0x8a5cff,
    emissiveIntensity: 0.55
  })
  const mesh = new THREE.InstancedMesh(geo, mat, shards.length)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const c = new THREE.Color()
  const up = new THREE.Vector3(0, 1, 0)
  const compose = (sh: Shard, t: number): void => {
    const bob = sh.floats ? Math.sin(t * 0.8 + sh.phase) * 0.35 : 0
    const sway = sh.floats ? Math.sin(t * 0.35 + sh.phase) * 0.25 : 0
    q.setFromAxisAngle(up, sh.yaw + sway)
    p.set(sh.x, sh.y + sh.sy / 2 + bob, sh.z)
    s.set(sh.sx, sh.sy, sh.sz)
    m.compose(p, q, s)
  }
  for (let i = 0; i < shards.length; i++) {
    const sh = shards[i]!
    compose(sh, 0)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.setHex(sh.color))
  }
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = false // tiny unit-box bounds would mis-cull the field
  mesh.onBeforeRender = () => {
    const t = performance.now() * 0.001
    for (let i = 0; i < shards.length; i++) {
      const sh = shards[i]!
      if (!sh.floats) continue
      compose(sh, t)
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
  }
  scene.add(mesh)
}

// ---------------------------------------------------------------------------
// Placement guards
// ---------------------------------------------------------------------------

function nearRoad(ctx: Ctx, ix: number, iz: number, margin: number): boolean {
  for (let dx = -margin; dx <= margin; dx++) {
    for (let dz = -margin; dz <= margin; dz++) {
      const s = surfaceAt(ctx, ix + dx, iz + dz)
      if (s === S_COBBLE || s === S_BRIDGE) return true
    }
  }
  return false
}

/** Open wastes ground: in-bounds, on land, plain grass, unblocked, off-road,
 *  off the river band and clear of the hand-built landmark circles. */
function openGround(ctx: Ctx, ix: number, iz: number): boolean {
  if (ix < X0 || ix > X1 || iz < Z0 || iz > Z1) return false
  if (ix >= 40 && ix <= 56) return false // river + banks
  if (!isLand(ix + 0.5, iz + 0.5)) return false
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  if (nearRoad(ctx, ix, iz, 2)) return false
  const clear: ReadonlyArray<readonly [number, number, number]> = [
    [WAYSTONE_ANCHOR[0], WAYSTONE_ANCHOR[1], 11],
    [HERMIT_ANCHOR[0] - 2, HERMIT_ANCHOR[1] - 2, 8],
    [CAMP[0], CAMP[1], CAMP_R + 2],
    [198, 150, 9] // the Oathbreaker vista sightline
  ]
  for (const [cx, cz, r] of clear) {
    const dx = ix - cx
    const dz = iz - cz
    if (dx * dx + dz * dz < r * r) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

/** Weathering: thin moss/dust patches sprinkled on top of a slab. */
function mossTop(ctx: Ctx, x0: number, z0: number, w: number, d: number, topY: number, n: number): void {
  const { rng, batches } = ctx
  for (let i = 0; i < n; i++) {
    const px = x0 + rng.range(0, w - 0.7)
    const pz = z0 + rng.range(0, d - 0.7)
    const col = rng.next() < 0.6 ? rng.pick(MOSS_PATCH) : rng.pick(WASTES_GROUND)
    batches.leaf.add(px, topY, pz, rng.range(0.5, 0.9), 0.14, rng.range(0.5, 0.9), col)
  }
}

/** A blocking masonry slab with dappled edge course + moss. */
function ruinSlab(ctx: Ctx, x0: number, y: number, z0: number, w: number, h: number, d: number): void {
  const { rng, batches, grid } = ctx
  batches.stone.add(x0, y, z0, w, h, d, rng.pick(RUIN_STONE))
  // a couple of proud edge stones so it reads hand-laid, not extruded
  for (let i = 0; i < Math.max(2, Math.floor((w + d) / 3)); i++) {
    const alongX = rng.next() < 0.5
    const ex = alongX ? x0 + rng.range(0, w - 1) : rng.next() < 0.5 ? x0 - 0.25 : x0 + w - 0.75
    const ez = alongX ? (rng.next() < 0.5 ? z0 - 0.25 : z0 + d - 0.75) : z0 + rng.range(0, d - 1)
    batches.stone.add(ex, y, ez, 1, h * rng.range(0.5, 0.9), 1, rng.pick(RUIN_STONE))
  }
  mossTop(ctx, x0, z0, w, d, y + h, Math.ceil((w * d) / 14))
  grid.blockRect(Math.floor(x0) - 1, Math.floor(z0) - 1, Math.ceil(w) + 2, Math.ceil(d) + 2)
}

/** Pile of rubble chunks (blocks its cell). */
function rubble(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const n = 2 + rng.int(3)
  for (let i = 0; i < n; i++) {
    const s = rng.range(0.4, 0.95)
    batches.stone.add(ix + rng.range(-0.3, 0.9), 0, iz + rng.range(-0.3, 0.9), s, rng.range(0.3, 0.8), s, rng.pick(RUIN_STONE))
  }
  grid.block(ix, iz)
}

/** Ribcage + skull of something that lost an argument. */
function bonePile(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  for (let i = 0; i < 3; i++) {
    batches.plaster.add(ix + i * 0.55, 0, iz + 0.2, 0.22, rng.range(0.7, 1.1), 1.1, rng.pick(BONE))
  }
  batches.plaster.add(ix - 0.6, 0, iz + 0.3, 0.75, 0.7, 0.8, rng.pick(BONE)) // skull
  batches.wood.add(ix - 0.52, 0.32, iz + 0.42, 0.14, 0.2, 0.2, SOCKET)
  batches.wood.add(ix - 0.52, 0.32, iz + 0.78, 0.14, 0.2, 0.2, SOCKET)
  grid.block(ix, iz)
}

/** Grim grass tuft (non-blocking). */
function tuft(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches } = ctx
  const n = 2 + rng.int(2)
  for (let i = 0; i < n; i++) {
    batches.leaf.add(ix + rng.range(0.05, 0.6), 0, iz + rng.range(0.05, 0.6), 0.3, rng.range(0.3, 0.7), 0.3, rng.pick(TUFT))
  }
}

/** Sharpened palisade post (blocks its cell). */
function palisadePost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const h = rng.range(2.6, 3.5)
  batches.wood.add(ix + 0.1, 0, iz + 0.1, 0.8, h, 0.8, rng.pick(WOOD))
  batches.wood.add(ix + 0.3, h, iz + 0.3, 0.4, 0.55, 0.4, WOOD_DARK) // sharpened tip
  grid.block(ix, iz)
}

/** Skull-topped gatepost. Orcs call this "curb appeal". */
function skullPost(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  batches.wood.add(ix + 0.3, 0, iz + 0.3, 0.4, 2.6, 0.4, WOOD_DARK)
  batches.plaster.add(ix + 0.05, 2.6, iz + 0.05, 0.9, 0.8, 0.9, rng.pick(BONE))
  batches.wood.add(ix - 0.02, 2.85, iz + 0.2, 0.12, 0.25, 0.22, SOCKET)
  batches.wood.add(ix - 0.02, 2.85, iz + 0.6, 0.12, 0.25, 0.22, SOCKET)
  grid.block(ix, iz)
}

/** War totem: carved painted segments, glowing eyes, horns. Blocks its cell. */
function totem(ctx: Ctx, ix: number, iz: number): void {
  const { rng, batches, grid } = ctx
  const segs = 4 + rng.int(2)
  for (let y = 0; y < segs; y++) {
    const col = y % 2 === 0 ? rng.pick(WOOD) : rng.next() < 0.5 ? WAR_PAINT : WOOD_DARK
    batches.wood.add(ix + 0.08, y, iz + 0.08, 0.84, 1, 0.84, col)
    if (y === 1 || y === segs - 1) {
      // glowing eyes ride the window batch, so they flicker with the village
      batches.window.add(ix - 0.04, y + 0.45, iz + 0.16, 0.14, 0.22, 0.2, WINDOW_GLOW)
      batches.window.add(ix - 0.04, y + 0.45, iz + 0.64, 0.14, 0.22, 0.2, WINDOW_GLOW)
    }
  }
  // horns
  batches.wood.add(ix - 0.25, segs, iz + 0.3, 0.35, 0.9, 0.4, rng.pick(BONE))
  batches.wood.add(ix + 0.9, segs, iz + 0.3, 0.35, 0.9, 0.4, rng.pick(BONE))
  grid.block(ix, iz)
}

/** Tattered war banner. Blocks its cell. */
function banner(ctx: Ctx, ix: number, iz: number): void {
  const { batches, grid } = ctx
  batches.wood.add(ix + 0.38, 0, iz + 0.38, 0.24, 4.4, 0.24, WOOD_DARK)
  batches.misc.add(ix + 0.62, 3.1, iz + 0.32, 0.12, 1.2, 1.3, WAR_PAINT)
  batches.misc.add(ix + 0.62, 2.45, iz + 0.5, 0.12, 0.65, 0.55, WAR_PAINT) // tatter
  grid.block(ix, iz)
}

/** Grounded crystal cluster shard (optionally blocking). */
function groundShard(ctx: Ctx, shards: Shard[], x: number, z: number, big: boolean): void {
  const { rng } = ctx
  const h = big ? rng.range(1.6, 3.4) : rng.range(0.7, 1.5)
  const s = rng.range(0.35, big ? 0.85 : 0.6)
  shards.push({
    x,
    y: 0,
    z,
    sx: s,
    sy: h,
    sz: s,
    yaw: rng.range(0, Math.PI),
    color: rng.pick(CRYSTAL),
    floats: false,
    phase: 0
  })
  if (h > 1.4) ctx.grid.block(Math.floor(x), Math.floor(z))
}

function floatShard(ctx: Ctx, shards: Shard[], x: number, y: number, z: number): void {
  const { rng } = ctx
  const s = rng.range(0.28, 0.5)
  shards.push({
    x,
    y,
    z,
    sx: s,
    sy: rng.range(0.8, 1.7),
    sz: s,
    yaw: rng.range(0, Math.PI),
    color: rng.pick(CRYSTAL),
    floats: true,
    phase: rng.range(0, Math.PI * 2)
  })
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

/** Gate of the Vanquished — two ruined pillars astride the road near the
 *  region entrance; the taller one keeps a broken stub of the old span. */
function buildArchGate(ctx: Ctx, shards: Shard[]): void {
  const { rng, batches, grid } = ctx

  const pillar = (px: number, pz: number, h: number, span: boolean): void => {
    // base plinth
    batches.stone.add(px, 0, pz, 3, 1, 3, rng.pick(RUIN_STONE))
    // shaft courses, dappled
    for (let y = 1; y < h; y++) {
      batches.stone.add(px + 0.5, y, pz + 0.5, 2, 1, 2, rng.pick(RUIN_STONE))
    }
    if (span) {
      batches.stone.add(px + 0.25, h, pz + 0.25, 2.5, 0.7, 2.5, rng.pick(RUIN_STONE)) // capital
      // broken span stub cantilevering toward the road
      batches.stone.add(px - 1.6, h + 0.7, pz + 0.7, 2.2, 0.8, 1.6, rng.pick(RUIN_STONE))
      batches.stone.add(px - 3.1, h + 0.7, pz + 0.9, 1.5, 0.6, 1.2, rng.pick(RUIN_STONE))
    } else {
      // ragged broken top
      batches.stone.add(px + 0.5, h, pz + 0.5, 1, rng.range(0.4, 0.9), 2, rng.pick(RUIN_STONE))
      batches.stone.add(px + 1.5, h, pz + 1.3, 1, rng.range(0.2, 0.6), 1, rng.pick(RUIN_STONE))
    }
    // a glowing rune nobody can read anymore (purple shard mesh, static)
    shards.push({
      x: px + 1.5,
      y: 2.1,
      z: pz - 0.09,
      sx: 0.5,
      sy: 0.7,
      sz: 0.16,
      yaw: 0,
      color: rng.pick(CRYSTAL),
      floats: false,
      phase: 0
    })
    mossTop(ctx, px, pz, 3, 3, 1, 3)
    grid.blockRect(Math.floor(px), Math.floor(pz), 3, 3)
    // fallen rubble around the base (guarded off the cobble)
    for (let i = 0; i < 4; i++) {
      const bx = Math.floor(px + rng.range(-3, 5))
      const bz = Math.floor(pz + rng.range(-3, 5))
      if (openGround(ctx, bx, bz)) rubble(ctx, bx, bz)
    }
  }

  // the road runs ~(88,122)→(100,138); pillars sit 8 cells off its chord
  pillar(99, 123, 8, true)
  pillar(85, 133, 4, false)
}

/** The Fallen King — the toppled colossus. */
function buildFallenKing(ctx: Ctx, shards: Shard[]): void {
  const { rng, batches, grid } = ctx

  // Pedestal (stepped) with two sheared-off boot stumps still attached.
  ruinSlab(ctx, 84, 0, 198, 10, 1.2, 8)
  ruinSlab(ctx, 85, 1.2, 199, 8, 1, 6)
  batches.stone.add(86, 2.2, 200.5, 3, 2.6, 3, rng.pick(RUIN_STONE))
  batches.stone.add(90.5, 2.2, 201.5, 3, 2.2, 3, rng.pick(RUIN_STONE))
  mossTop(ctx, 86, 200.5, 3, 3, 4.8, 2)

  // Torso slabs, stepping down to the west where he face-planted.
  ruinSlab(ctx, 74, 0, 200, 9, 3.2, 6)
  ruinSlab(ctx, 70, 0, 201, 5, 2.4, 5)
  batches.stone.add(67, 0, 199.5, 3, 3, 3, rng.pick(RUIN_STONE)) // pauldron
  grid.blockRect(66, 198, 5, 5)

  // The head, knocked clean off. Face on the west side, judging everyone.
  batches.stone.add(59, 0, 201, 6, 4.6, 5.5, rng.pick(RUIN_STONE))
  batches.stone.add(58.6, 3.1, 201.6, 0.7, 0.9, 4.3, rng.pick(RUIN_STONE)) // brow
  batches.stone.add(58.5, 1.5, 203.2, 0.8, 1.3, 1, rng.pick(RUIN_STONE)) // nose
  batches.wood.add(58.8, 2.4, 202.1, 0.3, 0.7, 0.9, SOCKET) // eye sockets
  batches.wood.add(58.8, 2.4, 204.5, 0.3, 0.7, 0.9, SOCKET)
  batches.stone.add(58.8, 0.3, 202.6, 0.5, 0.6, 2.2, rng.pick(RUIN_STONE)) // chin
  mossTop(ctx, 59, 201, 6, 5.5, 4.6, 5)
  grid.blockRect(58, 200, 8, 8)

  // Arm reaching north out of the torso, hand grasping at the crown.
  ruinSlab(ctx, 74.5, 0, 193, 3, 2, 7)
  batches.stone.add(75, 0, 188, 2.2, 1.6, 5, rng.pick(RUIN_STONE)) // forearm
  batches.stone.add(74.8, 0, 185.2, 2.6, 1.5, 3, rng.pick(RUIN_STONE)) // palm
  for (let f = 0; f < 3; f++) {
    batches.stone.add(74.9 + f * 0.9, 0, 183.6, 0.7, 1.1, 1.7, rng.pick(RUIN_STONE))
    batches.stone.add(74.9 + f * 0.9, 1.1, 184.4, 0.7, 0.5, 0.9, rng.pick(RUIN_STONE)) // curl
  }
  batches.stone.add(77.4, 0, 185.6, 1.5, 1, 0.8, rng.pick(RUIN_STONE)) // thumb
  grid.blockRect(74, 183, 4, 8)

  // The crown, just out of reach for the rest of eternity.
  const crownX = 76
  const crownZ = 180.5
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const sx = crownX + Math.cos(a) * 1.5
    const sz = crownZ + Math.sin(a) * 1.5
    batches.misc.add(sx - 0.3, 0.55, sz - 0.3, 0.6, 1.3, 0.6, GOLD) // spikes
  }
  batches.misc.add(crownX - 1.9, 0, crownZ - 1.9, 3.8, 0.7, 3.8, GOLD) // band
  grid.blockRect(Math.floor(crownX) - 2, Math.floor(crownZ) - 2, 5, 5)

  // One mournful shard drifting over the king's chest.
  floatShard(ctx, shards, 78, 5, 203)
}

/** The Oathbreaker's Rest — severed fist + the giant sword in the mound. */
function buildOathbreaker(ctx: Ctx, shards: Shard[]): void {
  const { rng, batches, grid } = ctx

  // The fist, punching up out of the dirt.
  batches.stone.add(193, 0, 146, 4, 2.8, 4, rng.pick(RUIN_STONE)) // palm/knuckles
  for (let f = 0; f < 4; f++) {
    batches.stone.add(193.1 + f * 0.95, 2.8, 146, 0.75, 1.3, 1.6, rng.pick(RUIN_STONE))
  }
  batches.stone.add(197, 0.4, 147.2, 1.6, 1.6, 1.6, rng.pick(RUIN_STONE)) // thumb
  mossTop(ctx, 193, 146, 4, 4, 2.8, 3)
  grid.blockRect(192, 145, 7, 6)

  // Rubble mound + the sword nobody has managed to yank out.
  for (let i = 0; i < 7; i++) {
    const s = rng.range(0.7, 1.6)
    batches.stone.add(201.5 + rng.range(-1.2, 1.4), 0, 149.5 + rng.range(-1.2, 1.4), s, rng.range(0.4, 1.3), s, rng.pick([...RUIN_STONE, ...STONE]))
  }
  batches.stone.add(202.1, 0, 150.1, 0.9, 9, 0.38, STEEL) // blade
  batches.stone.add(202.25, 2.2, 150.2, 0.6, 6.8, 0.22, 0xb9c0cc) // edge highlight
  batches.misc.add(200.9, 9, 149.9, 3.3, 0.55, 0.8, GOLD) // crossguard
  batches.wood.add(202.3, 9.55, 150.08, 0.5, 1.5, 0.45, WOOD_DARK) // grip
  batches.misc.add(202.15, 11.05, 149.95, 0.8, 0.8, 0.75, GOLD) // pommel
  grid.blockRect(200, 148, 4, 4)

  // Two shards circling the blade like they know something we don't.
  floatShard(ctx, shards, 200, 6, 152.5)
  floatShard(ctx, shards, 204.5, 7.5, 148.5)
}

/** Grukkmaw war-camp — Warchief Grukk's home turf. */
function buildWarCamp(ctx: Ctx, scene: THREE.Scene): void {
  const { rng, batches, grid } = ctx
  const [cx, cz] = CAMP

  // Palisade ring with a south gate and a NW gate (toward the waystone trail).
  const gates: readonly number[] = [Math.PI / 2, (Math.PI * 5) / 4] // 90°, 225°
  const placed = new Set<string>()
  const steps = 64
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    let gated = false
    for (const g of gates) {
      const d = Math.atan2(Math.sin(a - g), Math.cos(a - g))
      if (Math.abs(d) < 0.22) gated = true
    }
    if (gated) continue
    const ix = Math.round(cx + Math.cos(a) * CAMP_R)
    const iz = Math.round(cz + Math.sin(a) * CAMP_R)
    const key = `${ix},${iz}`
    if (placed.has(key)) continue
    placed.add(key)
    if (surfaceAt(ctx, ix, iz) !== S_GRASS || !isLand(ix + 0.5, iz + 0.5)) continue
    palisadePost(ctx, ix, iz)
  }

  // Skull posts flanking both gates. Welcome!
  skullPost(ctx, cx - 3, cz + CAMP_R)
  skullPost(ctx, cx + 3, cz + CAMP_R)
  skullPost(ctx, cx - 15, cz - 10)
  skullPost(ctx, cx - 10, cz - 15)
  banner(ctx, cx - 5, cz + CAMP_R - 2)
  banner(ctx, cx + 5, cz + CAMP_R - 2)
  banner(ctx, cx - 12, cz - 12)

  // Chief's longhouse + three mud huts, hide roofs (sorry, not green here —
  // Grukk ate the gardener).
  kitHouseShell(
    ctx,
    { x0: 159, z0: 193, w: 10, d: 7, wallH: 4, door: 'N', chimney: true },
    { stone: RUIN_STONE, plaster: MUD_WALL, roof: HIDE_ROOF, timber: WOOD_DARK }
  )
  kitHouseShell(
    ctx,
    { x0: 150, z0: 204, w: 6, d: 5, wallH: 3, door: 'E' },
    { stone: RUIN_STONE, plaster: MUD_WALL, roof: HIDE_ROOF, timber: WOOD_DARK }
  )
  kitHouseShell(
    ctx,
    { x0: 174, z0: 201, w: 6, d: 5, wallH: 3, door: 'W' },
    { stone: RUIN_STONE, plaster: MUD_WALL, roof: HIDE_ROOF, timber: WOOD_DARK }
  )
  kitHouseShell(
    ctx,
    { x0: 168, z0: 213, w: 5, d: 4, wallH: 3, door: 'S' },
    { stone: RUIN_STONE, plaster: MUD_WALL, roof: HIDE_ROOF, timber: WOOD_DARK }
  )

  // Bonfire — stone ring, charred logs, pulsing embers, ONE orange light.
  const fx = 164
  const fz = 205
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    batches.stone.add(fx + 0.5 + Math.cos(a) * 1.5 - 0.3, 0, fz + 0.5 + Math.sin(a) * 1.5 - 0.3, 0.6, rng.range(0.35, 0.55), 0.6, rng.pick(STONE))
  }
  batches.wood.add(fx - 0.4, 0.1, fz + 0.3, 1.8, 0.35, 0.35, WOOD_DARK)
  batches.wood.add(fx + 0.3, 0.1, fz - 0.4, 0.35, 0.35, 1.8, WOOD_DARK)
  batches.window.add(fx + 0.15, 0.3, fz + 0.15, 0.7, 0.55, 0.7, 0xffb066) // embers (flicker w/ windows)
  batches.window.add(fx + 0.32, 0.85, fz + 0.32, 0.36, 0.4, 0.36, 0xffd27e)
  const fire = new THREE.PointLight(0xff7a3c, 16, 14, 1.8)
  fire.position.set(fx + 0.5, 1.4, fz + 0.5)
  scene.add(fire)
  grid.blockRect(fx - 1, fz - 1, 3, 3)

  // War totems + the odd pile of "trophies".
  totem(ctx, 157, 212)
  totem(ctx, 176, 196)
  totem(ctx, 171, 208)
  bonePile(ctx, 160, 209)
  bonePile(ctx, 173, 212)
  rubble(ctx, 155, 199)
}

/** Waystone Hollow — monolith ring around the waystone anchor (kept open). */
function buildWaystoneHollow(ctx: Ctx, scene: THREE.Scene, shards: Shard[]): void {
  const { rng, batches, grid } = ctx
  const [wx, wz] = WAYSTONE_ANCHOR
  const approach = Math.atan2(138 - wz, 100 - wx) // road comes in from the NW

  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.17
    const d = Math.atan2(Math.sin(a - approach), Math.cos(a - approach))
    if (Math.abs(d) < 0.6) continue // open approach from the road
    const ix = Math.round(wx + Math.cos(a) * 7.5)
    const iz = Math.round(wz + Math.sin(a) * 7.5)
    if (nearRoad(ctx, ix, iz, 1) || surfaceAt(ctx, ix, iz) !== S_GRASS) continue
    const h = rng.range(3.4, 5)
    batches.stone.add(ix, 0, iz, 1, h, 1, rng.pick(RUIN_STONE))
    batches.stone.add(ix + rng.range(-0.3, 0.3), h, iz + rng.range(-0.3, 0.3), 1, rng.range(0.3, 0.7), 1, rng.pick(RUIN_STONE))
    // inward-facing rune
    const nx = wx - ix
    const nz = wz - iz
    const nl = Math.hypot(nx, nz)
    shards.push({
      x: ix + 0.5 + (nx / nl) * 0.56,
      y: 1.6,
      z: iz + 0.5 + (nz / nl) * 0.56,
      sx: 0.4,
      sy: 0.6,
      sz: 0.4,
      yaw: Math.atan2(nx, nz),
      color: rng.pick(CRYSTAL),
      floats: false,
      phase: 0
    })
    grid.block(ix, iz)
  }

  // Three shards drifting over the ring. Spooky. Load-bearing, probably.
  floatShard(ctx, shards, wx - 3, 3.8, wz + 2.5)
  floatShard(ctx, shards, wx + 3.2, 4.6, wz + 1)
  floatShard(ctx, shards, wx + 0.5, 5.4, wz - 3.5)

  // One cool-violet lantern at the hollow's edge.
  kitLantern(ctx, scene, wx + 7, wz - 5, 0xb48ae0)
}

/** Hermit Vex's hovel — anchor (120, 180) stays walkable. */
function buildHermitHovel(ctx: Ctx, scene: THREE.Scene): void {
  const { rng, batches, grid } = ctx
  // He kept the green roof. It's the last green thing for miles.
  kitHouseShell(
    ctx,
    { x0: 112, z0: 174, w: 5, d: 4, wallH: 3, door: 'E' },
    { stone: RUIN_STONE, plaster: [0xcbbfa8, 0xbfae92], timber: WOOD_DARK }
  )
  // Scrappy fence that gave up halfway. Relatable.
  kitFenceRun(ctx, 112, 172, 3, true)
  kitFenceRun(ctx, 110, 174, 3, false)
  // Junk: crates + a cook pot + firewood.
  batches.misc.add(112.1, 0, 179.1, 0.9, 0.9, 0.9, rng.pick(WOOD))
  batches.misc.add(113.1, 0, 179.2, 0.7, 0.7, 0.7, rng.pick(WOOD))
  grid.block(112, 179)
  batches.stone.add(117.2, 0, 173.2, 0.7, 0.5, 0.7, 0x4a4a52)
  grid.block(117, 173)
  kitDeadTree(ctx, 109, 179)
  kitLantern(ctx, scene, 116, 183, 0x9fd4b0)
}

/** A crystal scar — grounded cluster + floaters bobbing above it. */
function buildCrystalScar(ctx: Ctx, shards: Shard[], cx: number, cz: number, r: number): void {
  const { rng } = ctx
  const n = 14 + rng.int(8)
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2)
    const d = rng.range(0, r)
    const x = cx + Math.cos(a) * d
    const z = cz + Math.sin(a) * d
    const ix = Math.floor(x)
    const iz = Math.floor(z)
    if (!isLand(x, z) || surfaceAt(ctx, ix, iz) !== S_GRASS) continue
    if (nearRoad(ctx, ix, iz, 1)) continue
    groundShard(ctx, shards, x, z, d < r * 0.45)
  }
  const m = 7 + rng.int(5)
  for (let i = 0; i < m; i++) {
    const a = rng.range(0, Math.PI * 2)
    const d = rng.range(0.5, r * 0.8)
    floatShard(ctx, shards, cx + Math.cos(a) * d, rng.range(2.4, 5), cz + Math.sin(a) * d)
  }
  // scorched rubble lip
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, Math.PI * 2)
    const ix = Math.floor(cx + Math.cos(a) * (r + 1.5))
    const iz = Math.floor(cz + Math.sin(a) * (r + 1.5))
    if (openGround(ctx, ix, iz)) rubble(ctx, ix, iz)
  }
}

/** The Processional — a line of broken columns from the old gate toward the
 *  Fallen King. Giants loved a good driveway. */
function buildProcessional(ctx: Ctx): void {
  const { rng, batches, grid } = ctx
  const ax = 90
  const az = 134
  const bx = 66
  const bz = 196
  const steps = 9
  const dx = bx - ax
  const dz = bz - az
  const len = Math.hypot(dx, dz)
  const px = -dz / len // perpendicular
  const pz = dx / len
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const side = i % 2 === 0 ? 3 : -3
    const ix = Math.round(ax + dx * t + px * side + rng.range(-1, 1))
    const iz = Math.round(az + dz * t + pz * side + rng.range(-1, 1))
    if (!openGround(ctx, ix, iz)) continue
    // stump
    const h = rng.range(0.8, 2.8)
    batches.stone.add(ix, 0, iz, 1, h, 1, rng.pick(RUIN_STONE))
    batches.stone.add(ix - 0.12, 0, iz - 0.12, 1.24, 0.5, 1.24, rng.pick(RUIN_STONE)) // base
    grid.block(ix, iz)
    // fallen drums next to it
    const drums = rng.int(3)
    for (let d = 0; d < drums; d++) {
      const ox = ix + Math.round(rng.range(-2, 2.5))
      const oz = iz + Math.round(rng.range(-2, 2.5))
      if (!openGround(ctx, ox, oz)) continue
      batches.stone.add(ox, 0, oz, 1, rng.range(0.5, 0.9), 1, rng.pick(RUIN_STONE))
      grid.block(ox, oz)
    }
  }
}

/** The blasted-plain scatter pass: dead trees, rocks, rubble, bones, tufts. */
function scatterPlain(ctx: Ctx, shards: Shard[]): void {
  const { rng } = ctx
  for (let gx = X0; gx <= X1; gx += 3) {
    for (let gz = Z0; gz <= Z1; gz += 3) {
      if (rng.next() > 0.34) continue
      const ix = gx + Math.round(rng.range(-2, 2))
      const iz = gz + Math.round(rng.range(-2, 2))
      if (!openGround(ctx, ix, iz)) continue
      const roll = rng.next()
      if (roll < 0.3) kitDeadTree(ctx, ix, iz)
      else if (roll < 0.48) kitRock(ctx, ix, iz, rng.next() < 0.75 ? 1 : 2)
      else if (roll < 0.6) rubble(ctx, ix, iz)
      else if (roll < 0.68) bonePile(ctx, ix, iz)
      else if (roll < 0.76) groundShard(ctx, shards, ix + 0.5, iz + 0.5, rng.next() < 0.3)
      else tuft(ctx, ix, iz)
    }
  }
}

// ---------------------------------------------------------------------------

export function buildRegion(ctx: Ctx, scene: THREE.Scene): void {
  const shards: Shard[] = []

  // Trails first (pre-ground cobble stamps): hollow → war-camp NW gate,
  // with a spur to Vex's door.
  kitPath(
    ctx,
    [
      [112, 152],
      [120, 160],
      [130, 169],
      [141, 180],
      [152, 192]
    ],
    1.2
  )
  kitPath(
    ctx,
    [
      [118, 177],
      [122, 172],
      [126, 168]
    ],
    1.1
  )

  buildArchGate(ctx, shards)
  buildProcessional(ctx)
  buildFallenKing(ctx, shards)
  buildOathbreaker(ctx, shards)
  buildWarCamp(ctx, scene)
  buildWaystoneHollow(ctx, scene, shards)
  buildHermitHovel(ctx, scene)

  buildCrystalScar(ctx, shards, 24, 186, 6)
  buildCrystalScar(ctx, shards, 142, 226, 7)
  buildCrystalScar(ctx, shards, 210, 196, 5)

  scatterPlain(ctx, shards)
  bakeShards(scene, shards)
}
