/**
 * Inventory — live rotating 3D item viewer for the detail card.
 *
 * Owns a small dedicated THREE renderer on its own canvas (transparent
 * background so the medieval-dark card shows through). Meshes come from the
 * wired mesh source (ItemsAPI.buildMesh); until the integrator wires one,
 * a cute flat-color voxel placeholder tinted by rarity keeps the card alive.
 * The RAF loop only runs while the card is visible.
 */
import * as THREE from 'three'
import { RARITY_COLORS } from './defs'
import type { Rarity } from '../types'

export type MeshSource = (id: string) => THREE.Group

/** Flat-Lambert voxel placeholder in the game's look (no textures, ever). */
function placeholderMesh(rarity: Rarity): THREE.Group {
  const g = new THREE.Group()
  const color = new THREE.Color(RARITY_COLORS[rarity] ?? RARITY_COLORS[0])
  const dark = color.clone().multiplyScalar(0.6)
  const boxes: Array<[number, number, number, number, number, number, THREE.Color]> = [
    [0, 0.12, 0, 0.5, 0.24, 0.5, dark], // base slab
    [0, 0.45, 0, 0.34, 0.42, 0.34, color], // body
    [0, 0.78, 0, 0.2, 0.2, 0.2, color] // cap
  ]
  for (const [x, y, z, w, h, d, c] of boxes) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: c, flatShading: true })
    )
    m.position.set(x, y, z)
    g.add(m)
  }
  return g
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry.dispose()
      const mat = mesh.material
      if (Array.isArray(mat)) for (const m of mat) m.dispose()
      else mat.dispose()
    }
  })
}

export class ItemViewer {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer | null = null
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50)
  private readonly pivot = new THREE.Group()
  private current: THREE.Group | null = null
  private raf = 0
  private last = 0
  private meshSource: MeshSource | null = null

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'bl-inv-viewer'
    this.scene.add(this.pivot)
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x5a6b4a, 1.1))
    const key = new THREE.DirectionalLight(0xfff3d6, 1.7)
    key.position.set(2.2, 3.5, 2.6)
    this.scene.add(key)
  }

  setMeshSource(fn: MeshSource): void {
    this.meshSource = fn
  }

  /** Swap in the mesh for `id` and start spinning. */
  show(id: string, rarity: Rarity): void {
    this.clear()
    let mesh: THREE.Group
    try {
      mesh = this.meshSource ? this.meshSource(id) : placeholderMesh(rarity)
    } catch (e) {
      console.error('[inventory] mesh source threw for', id, e)
      mesh = placeholderMesh(rarity)
    }
    this.current = mesh

    // Centre the model in the pivot and frame the camera on it.
    const box = new THREE.Box3().setFromObject(mesh)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    mesh.position.sub(center)
    this.pivot.add(mesh)
    const radius = Math.max(size.x, size.y, size.z, 0.3)
    this.camera.position.set(0, radius * 0.55, radius * 2.3)
    this.camera.lookAt(0, 0, 0)

    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true
      })
      this.renderer.outputColorSpace = THREE.SRGBColorSpace
    }
    this.resize()
    this.last = performance.now()
    if (!this.raf) this.raf = requestAnimationFrame(this.tick)
  }

  /** Stop rendering and free the current mesh (card closed). */
  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.clear()
  }

  private clear(): void {
    if (this.current) {
      this.pivot.remove(this.current)
      disposeGroup(this.current)
      this.current = null
    }
    this.pivot.rotation.set(0, 0, 0)
  }

  private resize(): void {
    if (!this.renderer) return
    const w = this.canvas.clientWidth || 220
    const h = this.canvas.clientHeight || 170
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick)
    const dt = Math.min((now - this.last) / 1000, 0.1)
    this.last = now
    this.pivot.rotation.y += dt * 1.4
    if (this.renderer) this.renderer.render(this.scene, this.camera)
  }
}
