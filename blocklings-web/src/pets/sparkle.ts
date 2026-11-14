/**
 * Sparkle bursts — the celebratory golden pop when a pet drops (and a softer
 * one when a pet is minted on-chain). Tiny unlit voxel motes that fountain
 * up, drift, fade and die. Shared geometry, per-particle materials (opacity).
 */
import * as THREE from 'three'

interface Mote {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  vx: number
  vy: number
  vz: number
  life: number
  ttl: number
  spin: number
}

const MAX_MOTES = 140

export class Sparkles {
  private readonly scene: THREE.Scene
  private readonly geo = new THREE.BoxGeometry(0.09, 0.09, 0.09)
  private motes: Mote[] = []

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  burst(pos: THREE.Vector3, color = 0xf2c43d, count = 22): void {
    for (let i = 0; i < count; i++) {
      if (this.motes.length >= MAX_MOTES) break
      const mat = new THREE.MeshBasicMaterial({
        color: Math.random() < 0.3 ? 0xffffff : color,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(this.geo, mat)
      mesh.position.copy(pos)
      const a = Math.random() * Math.PI * 2
      const r = 0.6 + Math.random() * 2.2
      this.scene.add(mesh)
      this.motes.push({
        mesh,
        mat,
        vx: Math.cos(a) * r,
        vy: 2.2 + Math.random() * 2.6,
        vz: Math.sin(a) * r,
        life: 0,
        ttl: 0.7 + Math.random() * 0.5,
        spin: (Math.random() - 0.5) * 10,
      })
    }
  }

  update(dt: number): void {
    for (const m of [...this.motes]) {
      m.life += dt
      if (m.life >= m.ttl) {
        this.remove(m)
        continue
      }
      m.vy -= 6.5 * dt
      m.mesh.position.x += m.vx * dt
      m.mesh.position.y += m.vy * dt
      m.mesh.position.z += m.vz * dt
      m.mesh.rotation.y += m.spin * dt
      m.mesh.rotation.x += m.spin * 0.6 * dt
      const k = 1 - m.life / m.ttl
      m.mat.opacity = k
      m.mesh.scale.setScalar(0.5 + k * 0.8)
    }
  }

  private remove(m: Mote): void {
    m.mesh.removeFromParent()
    m.mat.dispose()
    const i = this.motes.indexOf(m)
    if (i >= 0) this.motes.splice(i, 1)
  }

  dispose(): void {
    for (const m of [...this.motes]) this.remove(m)
    this.geo.dispose()
  }
}
