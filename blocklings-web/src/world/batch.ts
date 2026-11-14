/**
 * VoxelBatch — collects axis-aligned colored boxes and bakes them into a
 * single THREE.InstancedMesh (one draw call per material group). All the
 * thousands of grass/roof/fence voxels in the village go through this.
 */
import * as THREE from 'three'

export interface BatchBuildOpts {
  emissive?: number
  emissiveIntensity?: number
  castShadow?: boolean
  receiveShadow?: boolean
  transparent?: boolean
  opacity?: number
}

interface Item {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  color: number
}

export class VoxelBatch {
  private items: Item[] = []

  /** Add a box; (x, y, z) is the MIN corner, (sx, sy, sz) the size. */
  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number): void {
    this.items.push({ x, y, z, sx, sy, sz, color })
  }

  /** Add a 1x1x1 voxel with min corner (x, y, z). */
  voxel(x: number, y: number, z: number, color: number): void {
    this.add(x, y, z, 1, 1, 1, color)
  }

  get count(): number {
    return this.items.length
  }

  /** Bake into one InstancedMesh. Returns null when nothing was added. */
  build(opts: BatchBuildOpts = {}): THREE.InstancedMesh | null {
    if (this.items.length === 0) return null

    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1
    })
    const mesh = new THREE.InstancedMesh(geo, mat, this.items.length)

    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const p = new THREE.Vector3()
    const s = new THREE.Vector3()
    const c = new THREE.Color()

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i] as Item
      p.set(it.x + it.sx / 2, it.y + it.sy / 2, it.z + it.sz / 2)
      s.set(it.sx, it.sy, it.sz)
      m.compose(p, q, s)
      mesh.setMatrixAt(i, m)
      mesh.setColorAt(i, c.setHex(it.color))
    }

    mesh.castShadow = opts.castShadow ?? false
    mesh.receiveShadow = opts.receiveShadow ?? true
    mesh.matrixAutoUpdate = false
    return mesh
  }
}
