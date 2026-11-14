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
}

type Rng = () => number

function pick<T>(rng: Rng, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)] as T
}

function range(rng: Rng, a: number, b: number): number {
  return a + rng() * (b - a)
}

/** Rock mound + 3 glowing nuggets of the given ore color. */
function vein(rng: Rng, ore: number): BoxSpec[] {
  const out: BoxSpec[] = [
    { x: -0.7, y: 0, z: -0.6, sx: 1.4, sy: 0.6, sz: 1.2, color: pick(rng, ROCK), keep: true },
    { x: -0.4, y: 0.6, z: -0.35, sx: 0.9, sy: 0.45, sz: 0.75, color: ROCK_DARK, keep: true }
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
  return out
}

/** Rock base + jutting crystal shards. */
function crystal(rng: Rng): BoxSpec[] {
  return [
    { x: -0.6, y: 0, z: -0.55, sx: 1.2, sy: 0.4, sz: 1.1, color: pick(rng, ROCK), keep: true },
    { x: -0.3, y: 0.4, z: -0.25, sx: 0.32, sy: range(rng, 1.0, 1.3), sz: 0.32, color: CRYSTAL, glow: true },
    { x: 0.1, y: 0.4, z: 0.05, sx: 0.24, sy: range(rng, 0.6, 0.85), sz: 0.24, color: CRYSTAL, glow: true },
    { x: -0.55, y: 0.4, z: 0.2, sx: 0.2, sy: range(rng, 0.45, 0.6), sz: 0.2, color: CRYSTAL, glow: true }
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

/** Leafy clump with a glowy shimmer — all of it gets picked. */
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
  return out
}

/** Tilled mound (stays) + ripe wheat stalks with glowing tips. */
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
  }
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
  /** World-space center (bob animation recomposes around it). */
  cx: number
  cy: number
  cz: number
  sx: number
  sy: number
  sz: number
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

/**
 * Collects every node's boxes, then bakes two InstancedMeshes. Returned
 * node handles let the gameplay layer hide/show nodes and the ticker
 * animate bobbing rings + the glow pulse with two draw calls total.
 */
export class NodeProps {
  private solids: { m: THREE.Matrix4; color: number }[] = []
  private glows: { m: THREE.Matrix4; color: number }[] = []
  private nodes: PlacedBox[][] = []
  private solidMesh: THREE.InstancedMesh | null = null
  private glowMesh: THREE.InstancedMesh | null = null
  private glowMat: THREE.MeshBasicMaterial | null = null
  private bobs: PlacedBox[] = []

  /** Add one node's prop at world (wx, wy, wz). Returns its handle index. */
  addNode(boxes: BoxSpec[], wx: number, wy: number, wz: number): number {
    const placed: PlacedBox[] = []
    for (const b of boxes) {
      const cx = wx + b.x + b.sx / 2
      const cy = wy + b.y + b.sy / 2
      const cz = wz + b.z + b.sz / 2
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
        cx, cy, cz,
        sx: b.sx, sy: b.sy, sz: b.sz
      }
      list.push({ m, color: b.color })
      placed.push(rec)
      if (rec.bob) this.bobs.push(rec)
    }
    this.nodes.push(placed)
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

  /** Hide (harvest) or restore a node's non-`keep` boxes. */
  setHarvested(node: number, harvested: boolean): void {
    const placed = this.nodes[node]
    if (!placed) return
    for (const b of placed) {
      if (b.keep) continue
      const mesh = b.glow ? this.glowMesh : this.solidMesh
      if (!mesh) continue
      mesh.setMatrixAt(b.idx, harvested ? ZERO : b.matrix)
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  private tmpM = new THREE.Matrix4()
  private tmpP = new THREE.Vector3()
  private tmpQ = new THREE.Quaternion()
  private tmpS = new THREE.Vector3()

  /** Per-frame: bob the fish rings, pulse the sparkle. Cheap by design. */
  update(t: number, isHarvested: (node: number) => boolean): void {
    void isHarvested
    if (this.glowMat) this.glowMat.opacity = 0.78 + Math.sin(t * 3.1) * 0.18
    if (!this.glowMesh) return
    let dirty = false
    for (const b of this.bobs) {
      // zero-scaled (harvested) rings stay hidden — check the live matrix
      this.glowMesh.getMatrixAt(b.idx, this.tmpM)
      this.tmpM.decompose(this.tmpP, this.tmpQ, this.tmpS)
      if (this.tmpS.x === 0) continue
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
