/**
 * Market — spinning 3D goods viewers for listing cards.
 *
 * Browsers cap live WebGL contexts (~8-16), so a grid of listing cards cannot
 * each own a renderer. Instead ONE shared offscreen WebGL renderer draws every
 * registered card's scene in turn each frame, and the result is blitted onto
 * the card's plain 2D canvas. All cards spin together for the cost of a single
 * context. Meshes come from the wired mesh sources (items.buildMesh /
 * pet mesh builder); a flat-color voxel placeholder keeps unwired cards alive.
 */
import * as THREE from 'three'

interface Entry {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  pivot: THREE.Group
}

const MAX_CARDS = 24

/** Flat-Lambert voxel placeholder in the game's look (no textures, ever). */
export function placeholderMesh(color = 0x9a8f78): THREE.Group {
  const g = new THREE.Group()
  const c = new THREE.Color(color)
  const dark = c.clone().multiplyScalar(0.6)
  const parts: Array<[number, number, number, number, number, number, THREE.Color]> = [
    [0, 0.12, 0, 0.5, 0.24, 0.5, dark],
    [0, 0.45, 0, 0.34, 0.42, 0.34, c],
    [0, 0.78, 0, 0.2, 0.2, 0.2, c]
  ]
  for (const [x, y, z, w, h, d, col] of parts) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color: col, flatShading: true })
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

export class CardSpinner {
  private renderer: THREE.WebGLRenderer | null = null
  private entries: Entry[] = []
  private raf = 0
  private last = 0

  /** Register a card canvas showing `mesh` spinning. Call clear() between fills. */
  add(canvas: HTMLCanvasElement, mesh: THREE.Group): void {
    if (this.entries.length >= MAX_CARDS) {
      disposeGroup(mesh)
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      disposeGroup(mesh)
      return
    }
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x5a6b4a, 1.1))
    const key = new THREE.DirectionalLight(0xfff3d6, 1.7)
    key.position.set(2.2, 3.5, 2.6)
    scene.add(key)
    const pivot = new THREE.Group()
    scene.add(pivot)

    // Centre + frame.
    const box = new THREE.Box3().setFromObject(mesh)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    mesh.position.sub(center)
    pivot.add(mesh)
    const radius = Math.max(size.x, size.y, size.z, 0.3)
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50)
    camera.position.set(0, radius * 0.55, radius * 2.3)
    camera.lookAt(0, 0, 0)

    this.entries.push({ canvas, ctx, scene, camera, pivot })
    this.start()
  }

  clear(): void {
    for (const e of this.entries) disposeGroup(e.pivot)
    this.entries = []
  }

  start(): void {
    if (!this.raf && this.entries.length) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(this.tick)
    }
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  dispose(): void {
    this.stop()
    this.clear()
    this.renderer?.dispose()
    this.renderer = null
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick)
    const dt = Math.min((now - this.last) / 1000, 0.1)
    this.last = now
    if (!this.entries.length) return
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
      this.renderer.outputColorSpace = THREE.SRGBColorSpace
    }
    const r = this.renderer
    for (const e of this.entries) {
      if (!e.canvas.isConnected) continue
      const w = e.canvas.clientWidth || 120
      const h = e.canvas.clientHeight || 100
      if (e.canvas.width !== w || e.canvas.height !== h) {
        e.canvas.width = w
        e.canvas.height = h
      }
      e.pivot.rotation.y += dt * 1.2
      r.setSize(w, h, false)
      e.camera.aspect = w / h
      e.camera.updateProjectionMatrix()
      r.render(e.scene, e.camera)
      e.ctx.clearRect(0, 0, w, h)
      e.ctx.drawImage(r.domElement, 0, 0, w, h)
    }
  }
}
