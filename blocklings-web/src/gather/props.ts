/**
 * Voxel props for resource nodes, in the sacred house style: flat-color
 * Lambert boxes, no textures. Every box of every node across the whole
 * continent bakes into just TWO InstancedMeshes — one lit/solid batch and
 * one unlit "glow" batch (ore sparkle, crystal shards, herb shimmer, the
 * bobbing fish ring). Harvesting zero-scales a node's non-stump boxes;
 * respawn restores the stored matrices.
 */
import * as THREE from 'three'

// --- palette (matches the world's hand-built vocabulary) --------------------
const ROCK = [0x8b9197, 0x7e848b, 0x9aa0a6] as const
const ROCK_DARK = 0x6e737a
const COPPER = 0xe09a55
const IRON = 0xc3ccd8
const GOLD = 0xf2c94c
const CRYSTAL = 0x7fd4ff
const TRUNK = [0x6e4a2a, 0x7a5330, 0x5f4024] as const
const TRUNK_DARK = 0x4a3119
const CHOP = 0xc8a265
const LEAF_OAK = [0x55a449, 0x3f8f3d, 0x62b14f] as const
const LEAF_PINE = [0x2f6e3a, 0x285f33, 0x376f41] as const
const RING = 0xd9f2ff
const HERB = [0x62b14f, 0x4f9d3f] as const
const HERB_GLOW = 0xa5ffb0
const SOIL_TILLED = 0x59402a
const WHEAT = 0xd8b84a
const WHEAT_GLOW = 0xf5e08a
const WILT = 0x8a7a4a
const STUBBLE = 0xb09a55
const BUSH = [0x4f9d3f, 0x447f36] as const
const BERRY = 0xe05555
const MUSH_STEM = 0xe8e0cc
const MUSH_CAP = [0x9a6a3f, 0x8a5c33] as const
const MUSH_SPOT = 0xf0e6d2
const CLAY_MUD = 0x6b5a44
const CLAY = [0xb3876a, 0xa87c60] as const
const CLAY_HOLE = 0x4a3d2e

/** One axis-aligned box of a node prop, in node-local coords. */
export interface BoxSpec {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  color: number
  /** Goes into the unlit glow batch (sparkle/shimmer). */
  glow?: boolean
  /** Survives harvesting (rock base, tree stump, tilled soil). */
  keep?: boolean
  /** Bobs gently (fish ring). */
  bob?: boolean
  /** Only visible WHILE harvested (rubble piles, wilted stalks, stubble). */
  wreck?: boolean
}

type Rng = () => number

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)] as T
}

function range(rng: Rng, a: number, b: number): number {
  return a + rng() * (b - a)
}

/** Flat scattered rubble chunks, shown only after a rock-style harvest. */
function rubble(rng: Rng, accent: number): BoxSpec[] {
  const out: BoxSpec[] = []
  for (let i = 0; i < 4; i++) {
    const s = range(rng, 0.25, 0.45)
    out.push({
      x: range(rng, -0.8, 0.5),
      y: 0,
      z: range(rng, -0.75, 0.45),
      sx: s, sy: range(rng, 0.14, 0.22), sz: s,
      color: i === 3 ? accent : pick(rng, ROCK),
      wreck: true
    })
  }
  return out
}

/** Rock mound + 3 glowing nuggets; crumbles to rubble when mined out. */
function vein(rng: Rng, ore: number): BoxSpec[] {
  const out: BoxSpec[] = [
    { x: -0.7, y: 0, z: -0.6, sx: 1.4, sy: 0.6, sz: 1.2, color: pick(rng, ROCK) },
    { x: -0.4, y: 0.6, z: -0.35, sx: 0.9, sy: 0.45, sz: 0.75, color: ROCK_DARK }
  ]
  for (let i = 0; i < 3; i++) {
    const s = range(rng, 0.22, 0.34)
    out.push({
      x: range(rng, -0.6, 0.35),
      y: range(rng, 0.3, 0.85),
      z: range(rng, -0.5, 0.3),
      sx: s, sy: s, sz: s,
      color: ore,
      glow: true
    })
  }
  out.push(...rubble(rng, ROCK_DARK))
  return out
}

/** Rock base + jutting crystal shards; crumbles to shard-flecked rubble. */
function crystal(rng: Rng): BoxSpec[] {
  return [
    { x: -0.6, y: 0, z: -0.55, sx: 1.2, sy: 0.4, sz: 1.1, color: pick(rng, ROCK) },
    { x: -0.3, y: 0.4, z: -0.25, sx: 0.32, sy: range(rng, 1.0, 1.3), sz: 0.32, color: CRYSTAL, glow: true },
    { x: 0.1, y: 0.4, z: 0.05, sx: 0.24, sy: range(rng, 0.6, 0.85), sz: 0.24, color: CRYSTAL, glow: true },
    { x: -0.55, y: 0.4, z: 0.2, sx: 0.2, sy: range(rng, 0.45, 0.6), sz: 0.2, color: CRYSTAL, glow: true },
    ...rubble(rng, CRYSTAL)
  ]
}

/** Chop-marked oak: stump stays after harvest, trunk + canopy fall. */
function oak(rng: Rng): BoxSpec[] {
  const trunk = pick(rng, TRUNK)
  const h = range(rng, 2.0, 2.5)
  return [
    { x: -0.35, y: 0, z: -0.35, sx: 0.7, sy: 0.7, sz: 0.7, color: trunk, keep: true },
    { x: -0.3, y: 0.7, z: -0.3, sx: 0.6, sy: h - 0.7, sz: 0.6, color: trunk },
    // the chop notch — pale wound in the bark
    { x: 0.28, y: 0.35, z: -0.18, sx: 0.12, sy: 0.3, sz: 0.36, color: CHOP, keep: true },
    { x: -1.1, y: h, z: -1.1, sx: 2.2, sy: 1.0, sz: 2.2, color: pick(rng, LEAF_OAK) },
    { x: -0.8, y: h + 1.0, z: -0.8, sx: 1.6, sy: 0.8, sz: 1.6, color: pick(rng, LEAF_OAK) },
    { x: -0.45, y: h + 1.8, z: -0.45, sx: 0.9, sy: 0.5, sz: 0.9, color: pick(rng, LEAF_OAK) }
  ]
}

/** Taller pine: stacked shrinking skirts of dark needles. */
function pine(rng: Rng): BoxSpec[] {
  const trunk = pick(rng, TRUNK)
  const h = range(rng, 2.6, 3.2)
  return [
    { x: -0.3, y: 0, z: -0.3, sx: 0.6, sy: 0.7, sz: 0.6, color: trunk, keep: true },
    { x: -0.25, y: 0.7, z: -0.25, sx: 0.5, sy: h - 0.7, sz: 0.5, color: trunk },
    { x: 0.24, y: 0.3, z: -0.16, sx: 0.12, sy: 0.28, sz: 0.32, color: CHOP, keep: true },
    { x: -1.0, y: h - 0.9, z: -1.0, sx: 2.0, sy: 0.7, sz: 2.0, color: pick(rng, LEAF_PINE) },
    { x: -0.7, y: h - 0.1, z: -0.7, sx: 1.4, sy: 0.7, sz: 1.4, color: pick(rng, LEAF_PINE) },
    { x: -0.4, y: h + 0.7, z: -0.4, sx: 0.8, sy: 0.7, sz: 0.8, color: pick(rng, LEAF_PINE) },
    { x: -0.15, y: h + 1.4, z: -0.15, sx: 0.3, sy: 0.4, sz: 0.3, color: TRUNK_DARK }
  ]
}

/** Bobbing square ring floating on the water. */
function fishRing(): BoxSpec[] {
  const t = 0.14
  const w = 1.5
  return [
    { x: -w / 2, y: 0, z: -w / 2, sx: w, sy: t, sz: t, color: RING, glow: true, bob: true },
    { x: -w / 2, y: 0, z: w / 2 - t, sx: w, sy: t, sz: t, color: RING, glow: true, bob: true },
    { x: -w / 2, y: 0, z: -w / 2 + t, sx: t, sy: t, sz: w - 2 * t, color: RING, glow: true, bob: true },
    { x: w / 2 - t, y: 0, z: -w / 2 + t, sx: t, sy: t, sz: w - 2 * t, color: RING, glow: true, bob: true }
  ]
}

/** Small drooping wilted sprigs, shown only while a plant is picked bare. */
function wilted(rng: Rng, n: number): BoxSpec[] {
  const out: BoxSpec[] = []
  for (let i = 0; i < n; i++) {
    const s = range(rng, 0.14, 0.22)
    out.push({
      x: range(rng, -0.45, 0.3),
      y: 0,
      z: range(rng, -0.45, 0.3),
      sx: s, sy: range(rng, 0.12, 0.2), sz: s,
      color: WILT,
      wreck: true
    })
  }
  return out
}

/** Leafy clump with a glowy shimmer; wilts to sad brown sprigs. */
function herb(rng: Rng): BoxSpec[] {
  const out: BoxSpec[] = []
  for (let i = 0; i < 4; i++) {
    const s = range(rng, 0.3, 0.45)
    out.push({
      x: range(rng, -0.55, 0.2),
      y: 0,
      z: range(rng, -0.55, 0.2),
      sx: s, sy: range(rng, 0.35, 0.6), sz: s,
      color: pick(rng, HERB)
    })
  }
  for (let i = 0; i < 3; i++) {
    const s = 0.14
    out.push({
      x: range(rng, -0.45, 0.35),
      y: range(rng, 0.45, 0.7),
      z: range(rng, -0.45, 0.35),
      sx: s, sy: s, sz: s,
      color: HERB_GLOW,
      glow: true
    })
  }
  out.push(...wilted(rng, 3))
  return out
}

/** Tilled mound (stays) + ripe wheat; harvest leaves pale stubble. */
function farmPlot(rng: Rng): BoxSpec[] {
  const out: BoxSpec[] = [
    { x: -0.65, y: 0, z: -0.65, sx: 1.3, sy: 0.22, sz: 1.3, color: SOIL_TILLED, keep: true }
  ]
  for (let i = 0; i < 4; i++) {
    const h = range(rng, 0.55, 0.8)
    const bx = -0.5 + (i % 2) * 0.62 + range(rng, 0, 0.1)
    const bz = -0.5 + Math.floor(i / 2) * 0.62 + range(rng, 0, 0.1)
    out.push({ x: bx, y: 0.22, z: bz, sx: 0.26, sy: h, sz: 0.26, color: WHEAT })
    out.push({ x: bx + 0.02, y: 0.22 + h, z: bz + 0.02, sx: 0.22, sy: 0.16, sz: 0.22, color: WHEAT_GLOW, glow: true })
    out.push({ x: bx + 0.02, y: 0.22, z: bz + 0.02, sx: 0.2, sy: 0.14, sz: 0.2, color: STUBBLE, wreck: true })
  }
  return out
}

/** Round leafy bush (stays) studded with glowing berries that get picked. */
function berryBush(rng: Rng): BoxSpec[] {
  const out: BoxSpec[] = [
    { x: -0.65, y: 0, z: -0.65, sx: 1.3, sy: 0.8, sz: 1.3, color: pick(rng, BUSH), keep: true },
    { x: -0.45, y: 0.8, z: -0.45, sx: 0.9, sy: 0.4, sz: 0.9, color: pick(rng, BUSH), keep: true }
  ]
  for (let i = 0; i < 5; i++) {
    const s = range(rng, 0.16, 0.22)
    out.push({
      x: range(rng, -0.6, 0.4),
      y: range(rng, 0.25, 0.95),
      z: range(rng, -0.6, 0.4),
      sx: s, sy: s, sz: s,
      color: BERRY,
      glow: true
    })
  }
  return out
}

/** Cluster of fat spotted toadstools; foraged down to pale stubs. */
function mushroomCluster(rng: Rng): BoxSpec[] {
  const out: BoxSpec[] = []
  for (let i = 0; i < 3; i++) {
    const stemH = range(rng, 0.3, 0.55)
    const capW = range(rng, 0.4, 0.6)
    const bx = range(rng, -0.6, 0.25)
    const bz = range(rng, -0.6, 0.25)
    out.push({ x: bx, y: 0, z: bz, sx: 0.22, sy: stemH, sz: 0.22, color: MUSH_STEM })
    out.push({
      x: bx - (capW - 0.22) / 2, y: stemH, z: bz - (capW - 0.22) / 2,
      sx: capW, sy: 0.24, sz: capW,
      color: pick(rng, MUSH_CAP)
    })
    out.push({ x: bx + 0.02, y: stemH + 0.24, z: bz + 0.02, sx: 0.14, sy: 0.08, sz: 0.14, color: MUSH_SPOT, glow: true })
    // post-forage stub
    out.push({ x: bx, y: 0, z: bz, sx: 0.2, sy: 0.12, sz: 0.2, color: MUSH_STEM, wreck: true })
  }
  return out
}

/** Muddy pit rim (stays) + glistening clay lumps; digs down to a dark hole. */
function clayPit(rng: Rng): BoxSpec[] {
  const out: BoxSpec[] = [
    { x: -0.8, y: 0, z: -0.8, sx: 1.6, sy: 0.18, sz: 1.6, color: CLAY_MUD, keep: true },
    { x: -0.55, y: 0.18, z: -0.55, sx: 1.1, sy: 0.1, sz: 1.1, color: CLAY_HOLE, wreck: true }
  ]
  for (let i = 0; i < 4; i++) {
    const s = range(rng, 0.26, 0.4)
    out.push({
      x: range(rng, -0.6, 0.3),
      y: 0.18,
      z: range(rng, -0.6, 0.3),
      sx: s, sy: range(rng, 0.2, 0.32), sz: s,
      color: pick(rng, CLAY)
    })
  }
  out.push({ x: -0.1, y: 0.42, z: -0.12, sx: 0.16, sy: 0.16, sz: 0.16, color: 0xd9c7b4, glow: true })
  return out
}

/** Build the local-space boxes for one node of `kind`. */
export function buildKindBoxes(kind: string, rng: Rng): BoxSpec[] {
  switch (kind) {
    case 'copper_vein': return vein(rng, COPPER)
    case 'iron_vein': return vein(rng, IRON)
    case 'gold_vein': return vein(rng, GOLD)
    case 'crystal_node': return crystal(rng)
    case 'oak_tree': return oak(rng)
    case 'pine_tree': return pine(rng)
    case 'fishing_spot': return fishRing()
    case 'herb_patch': return herb(rng)
    case 'farm_plot': return farmPlot(rng)
    case 'berry_bush': return berryBush(rng)
    case 'mushroom_cluster': return mushroomCluster(rng)
    case 'clay_pit': return clayPit(rng)
    default: return vein(rng, COPPER)
  }
}

// ---------------------------------------------------------------------------
// Instanced batches
// ---------------------------------------------------------------------------

interface PlacedBox {
  glow: boolean
  idx: number
  /** Composed world matrix (restored on respawn). */
  matrix: THREE.Matrix4
  keep: boolean
  bob: boolean
  wreck: boolean
  /** World-space center (bob animation recomposes around it). */
  cx: number
  cy: number
  cz: number
  sx: number
  sy: number
  sz: number
}

/** Depletion animation styles (mirrors data.ts DepleteStyle). */
export type PropDepleteStyle = 'topple' | 'crumble' | 'pause' | 'wilt'

interface NodeAnim {
  phase: 'deplete' | 'restore'
  style: PropDepleteStyle
  start: number
}

interface NodeRec {
  boxes: PlacedBox[]
  /** World origin the prop was placed at (topple pivot sits here). */
  ox: number
  oy: number
  oz: number
  depleted: boolean
  anim: NodeAnim | null
  /** Deterministic topple direction (radians around Y). */
  fallDir: number
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

const DUR: Record<PropDepleteStyle, number> = {
  topple: 1.0,
  crumble: 0.45,
  pause: 0.35,
  wilt: 0.5
}
const RESTORE_DUR = 0.5

/** Paused-ring residual scale. */
const PAUSE_SCALE = 0.55

/**
 * Collects every node's boxes, then bakes two InstancedMeshes (one lit,
 * one glow). Node handles let the gameplay layer play full depletion
 * animations — trees TOPPLE about their stump, ore CRUMBLES into rubble,
 * fish rings PAUSE + shrink, plants WILT into brown sprigs — and pop back
 * on respawn, all by rewriting instance matrices (still two draw calls
 * per NodeProps). One instance serves the heart; streamed zones get one
 * small instance each (toggled by distance, disposable).
 */
export class NodeProps {
  private solids: { m: THREE.Matrix4; color: number }[] = []
  private glows: { m: THREE.Matrix4; color: number }[] = []
  private nodes: NodeRec[] = []
  private solidMesh: THREE.InstancedMesh | null = null
  private glowMesh: THREE.InstancedMesh | null = null
  private glowMat: THREE.MeshBasicMaterial | null = null
  private bobs: { node: NodeRec; box: PlacedBox }[] = []
  /** Nodes with a running deplete/restore animation. */
  private animating = new Set<NodeRec>()

  /** Add one node's prop at world (wx, wy, wz). Returns its handle index. */
  addNode(boxes: BoxSpec[], wx: number, wy: number, wz: number): number {
    const placed: PlacedBox[] = []
    for (const b of boxes) {
      const cx = wx + b.x + b.sx / 2
      const cy = wy + b.y + b.sy / 2
      const cz = wz + b.z + b.sz / 2
      const wreck = !!b.wreck
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(cx, cy, cz),
        new THREE.Quaternion(),
        new THREE.Vector3(b.sx, b.sy, b.sz)
      )
      const list = b.glow ? this.glows : this.solids
      const rec: PlacedBox = {
        glow: !!b.glow,
        idx: list.length,
        matrix: m,
        keep: !!b.keep,
        bob: !!b.bob,
        wreck,
        cx, cy, cz,
        sx: b.sx, sy: b.sy, sz: b.sz
      }
      // wreck boxes start hidden (they only show while depleted)
      list.push({ m: wreck ? ZERO.clone() : m, color: b.color })
      placed.push(rec)
    }
    const node: NodeRec = {
      boxes: placed,
      ox: wx, oy: wy, oz: wz,
      depleted: false,
      anim: null,
      fallDir: ((this.nodes.length * 2.39996323) % (Math.PI * 2))
    }
    for (const b of placed) if (b.bob) this.bobs.push({ node, box: b })
    this.nodes.push(node)
    return this.nodes.length - 1
  }

  /** Bake both batches and add them to the scene. Call once. */
  build(scene: THREE.Scene): void {
    const c = new THREE.Color()
    if (this.solids.length > 0) {
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshLambertMaterial({ color: 0xffffff }),
        this.solids.length
      )
      this.solids.forEach((s, i) => {
        mesh.setMatrixAt(i, s.m)
        mesh.setColorAt(i, c.setHex(s.color))
      })
      mesh.castShadow = true
      mesh.receiveShadow = true
      scene.add(mesh)
      this.solidMesh = mesh
    }
    if (this.glows.length > 0) {
      this.glowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95
      })
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        this.glowMat,
        this.glows.length
      )
      this.glows.forEach((g, i) => {
        mesh.setMatrixAt(i, g.m)
        mesh.setColorAt(i, c.setHex(g.color))
      })
      scene.add(mesh)
      this.glowMesh = mesh
    }
  }

  /** Start the harvest animation for a node (topple/crumble/pause/wilt). */
  deplete(node: number, style: PropDepleteStyle, now: number): void {
    const rec = this.nodes[node]
    if (!rec || rec.depleted) return
    rec.depleted = true
    rec.anim = { phase: 'deplete', style, start: now }
    this.animating.add(rec)
  }

  /** Pop a node back in (respawn): hide the wreck, regrow the boxes. */
  restore(node: number, style: PropDepleteStyle, now: number): void {
    const rec = this.nodes[node]
    if (!rec || !rec.depleted) return
    rec.depleted = false
    rec.anim = { phase: 'restore', style, start: now }
    this.animating.add(rec)
    // wreck boxes vanish the moment regrowth starts
    for (const b of rec.boxes) if (b.wreck) this.setBox(b, ZERO)
  }

  /** Show or hide this batch wholesale (zone props far from the player). */
  setVisible(v: boolean): void {
    if (this.solidMesh) this.solidMesh.visible = v
    if (this.glowMesh) this.glowMesh.visible = v
  }

  /** Remove meshes from the scene and free GPU resources. */
  dispose(scene: THREE.Scene): void {
    for (const mesh of [this.solidMesh, this.glowMesh]) {
      if (!mesh) continue
      scene.remove(mesh)
      mesh.geometry.dispose()
      const mat = mesh.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat.dispose()
    }
    this.solidMesh = null
    this.glowMesh = null
    this.glowMat = null
  }

  private tmpM = new THREE.Matrix4()
  private tmpP = new THREE.Vector3()
  private tmpQ = new THREE.Quaternion()
  private tmpS = new THREE.Vector3()
  private tmpAxis = new THREE.Vector3()

  private setBox(b: PlacedBox, m: THREE.Matrix4): void {
    const mesh = b.glow ? this.glowMesh : this.solidMesh
    if (!mesh) return
    mesh.setMatrixAt(b.idx, m)
    mesh.instanceMatrix.needsUpdate = true
  }

  /** Recompose box `b` scaled by `s` around its own center, sunk by `drop`. */
  private setScaled(b: PlacedBox, s: number, drop: number): void {
    if (s <= 0.001) {
      this.setBox(b, ZERO)
      return
    }
    this.tmpM.compose(
      this.tmpP.set(b.cx, b.cy - drop, b.cz),
      this.tmpQ.identity(),
      this.tmpS.set(b.sx * s, b.sy * s, b.sz * s)
    )
    this.setBox(b, this.tmpM)
  }

  /** Advance one node's deplete/restore animation; true = still running. */
  private stepAnim(rec: NodeRec, now: number): boolean {
    const anim = rec.anim
    if (!anim) return false
    const dur = anim.phase === 'restore' ? RESTORE_DUR : DUR[anim.style]
    const p = Math.min(1, (now - anim.start) / dur)

    if (anim.phase === 'restore') {
      // smooth regrow 0 -> 1 (rings regrow from their paused scale)
      const from = anim.style === 'pause' ? PAUSE_SCALE : 0
      const s = from + (1 - from) * (p * p * (3 - 2 * p))
      for (const b of rec.boxes) {
        if (b.keep || b.wreck) continue
        this.setScaled(b, s, 0)
      }
      if (p >= 1) {
        // settle on exact baked matrices
        for (const b of rec.boxes) if (!b.keep && !b.wreck) this.setBox(b, b.matrix)
        rec.anim = null
        return false
      }
      return true
    }

    switch (anim.style) {
      case 'topple': {
        // accelerate into the fall: angle eases 0 -> ~85 deg about a ground
        // pivot at the stump, then the felled tree fades out scale-wise
        const fall = Math.min(1, p / 0.8)
        const ang = fall * fall * 1.48
        const fade = p > 0.85 ? 1 - (p - 0.85) / 0.15 : 1
        this.tmpAxis.set(Math.cos(rec.fallDir + Math.PI / 2), 0, Math.sin(rec.fallDir + Math.PI / 2))
        this.tmpQ.setFromAxisAngle(this.tmpAxis, ang)
        for (const b of rec.boxes) {
          if (b.keep || b.wreck) continue
          this.tmpP.set(b.cx - rec.ox, b.cy - rec.oy, b.cz - rec.oz)
          this.tmpP.applyQuaternion(this.tmpQ)
          this.tmpM.compose(
            this.tmpP.set(rec.ox + this.tmpP.x, rec.oy + this.tmpP.y, rec.oz + this.tmpP.z),
            this.tmpQ,
            this.tmpS.set(b.sx * fade, b.sy * fade, b.sz * fade)
          )
          if (fade <= 0.02) this.setBox(b, ZERO)
          else this.setBox(b, this.tmpM)
        }
        break
      }
      case 'crumble': {
        // mound collapses straight down, then the rubble pops in
        const s = 1 - p
        for (const b of rec.boxes) {
          if (b.keep || b.wreck) continue
          this.setScaled(b, s, p * (b.cy - rec.oy) * 0.9)
        }
        break
      }
      case 'pause': {
        // ring shrinks to PAUSE_SCALE and STAYS (visible but dormant)
        const s = 1 - (1 - PAUSE_SCALE) * p
        for (const b of rec.boxes) {
          if (b.keep || b.wreck) continue
          this.setScaled(b, s, 0)
        }
        break
      }
      case 'wilt': {
        // plant shrivels toward the soil
        const s = 1 - p
        for (const b of rec.boxes) {
          if (b.keep || b.wreck) continue
          this.setScaled(b, s, p * 0.1)
        }
        break
      }
    }

    if (p >= 1) {
      // depleted end-state: hide the goods (rings keep their paused husk),
      // reveal the wreck layer (rubble / wilted sprigs / stubble / hole)
      for (const b of rec.boxes) {
        if (b.keep) continue
        if (b.wreck) this.setBox(b, b.matrix)
        else if (anim.style !== 'pause') this.setBox(b, ZERO)
      }
      rec.anim = null
      return false
    }
    return true
  }

  /** Per-frame: run animations, bob live fish rings, pulse the sparkle. */
  update(t: number): void {
    if (this.glowMat) this.glowMat.opacity = 0.78 + Math.sin(t * 3.1) * 0.18

    if (this.animating.size > 0) {
      for (const rec of this.animating) {
        if (!this.stepAnim(rec, t)) this.animating.delete(rec)
      }
    }

    if (!this.glowMesh) return
    let dirty = false
    for (const { node, box: b } of this.bobs) {
      if (node.depleted || node.anim) continue // paused rings hold still
      const y = b.cy + Math.sin(t * 2.0 + b.cx * 0.7 + b.cz * 0.5) * 0.06
      this.tmpM.compose(
        this.tmpP.set(b.cx, y, b.cz),
        this.tmpQ.identity(),
        this.tmpS.set(b.sx, b.sy, b.sz)
      )
      this.glowMesh.setMatrixAt(b.idx, this.tmpM)
      dirty = true
    }
    if (dirty) this.glowMesh.instanceMatrix.needsUpdate = true
  }
}
