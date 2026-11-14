/**
 * PIXELATED BLOOD — chunky cube-particle bursts + ground-splat decals.
 *
 * One InstancedMesh for particles (gravity, one squishy bounce, shrink-out)
 * and one for flat splat decals (hold ~6s, shrink away by ~8s). Both are
 * fixed-capacity pools — zero allocation after construction, two draw
 * calls total, cartoon-over-the-top on kills (the fountain).
 *
 * The burst color is a knob, so the same pool also does gold loot sparkles.
 */
import * as THREE from 'three'

const MAX_PARTICLES = 320
const MAX_SPLATS = 56
const GRAVITY = -16

const RED_SHADES = [0xb3202a, 0x8f1620, 0xd8333c] as const
const SPLAT_SHADES = [0x7c1119, 0x66101c, 0x8f1620] as const

interface Particle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  size: number
  life: number
  ttl: number
  groundY: number
  bounced: boolean
  spin: number
}

interface Splat {
  x: number
  y: number
  z: number
  rot: number
  size: number
  life: number
}

const SPLAT_TTL = 8

export class BloodSystem {
  private readonly particles: Particle[] = []
  private readonly splats: Splat[] = []
  private readonly pMesh: THREE.InstancedMesh
  private readonly sMesh: THREE.InstancedMesh
  private readonly dummy = new THREE.Object3D()
  private readonly color = new THREE.Color()

  constructor(scene: THREE.Scene) {
    const pGeo = new THREE.BoxGeometry(1, 1, 1)
    const pMat = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.pMesh = new THREE.InstancedMesh(pGeo, pMat, MAX_PARTICLES)
    this.pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.pMesh.count = 0
    this.pMesh.frustumCulled = false
    scene.add(this.pMesh)

    const sGeo = new THREE.BoxGeometry(1, 0.02, 1)
    const sMat = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.sMesh = new THREE.InstancedMesh(sGeo, sMat, MAX_SPLATS)
    this.sMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.sMesh.count = 0
    this.sMesh.frustumCulled = false
    scene.add(this.sMesh)
  }

  /**
   * Chunky cube burst. `power` scales count/velocity: ~1 normal hit,
   * ~1.6 crit, ~3 kill fountain. `colorHex` defaults to blood red
   * (pass gold for loot-pickup sparkles).
   */
  burst(pos: THREE.Vector3, groundY: number, power: number, colorHex?: number): void {
    const count = Math.min(Math.round(7 * power), 40)
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.evict(this.particles, this.pMesh)
      const a = Math.random() * Math.PI * 2
      const r = 0.6 + Math.random() * 2.2 * Math.min(power, 2)
      const up = power >= 2.4 // kill fountain: mostly straight up, then rain
      this.particles.push({
        x: pos.x + (Math.random() - 0.5) * 0.3,
        y: pos.y + 0.4 + Math.random() * 0.5,
        z: pos.z + (Math.random() - 0.5) * 0.3,
        vx: Math.cos(a) * r * (up ? 0.55 : 1),
        vy: (up ? 5.5 : 2.2) + Math.random() * (up ? 4.5 : 2.5),
        vz: Math.sin(a) * r * (up ? 0.55 : 1),
        size: 0.07 + Math.random() * 0.08 * Math.min(power, 2),
        life: 0,
        ttl: 0.7 + Math.random() * 0.6,
        groundY,
        bounced: false,
        spin: Math.random() * Math.PI,
      })
      const shade =
        colorHex ?? RED_SHADES[Math.floor(Math.random() * RED_SHADES.length)] ?? 0xb3202a
      const idx = this.particles.length - 1
      this.pMesh.setColorAt(idx, this.color.setHex(shade))
    }
    if (this.pMesh.instanceColor) this.pMesh.instanceColor.needsUpdate = true
  }

  /** Red ground splat under a hit/corpse; fades out by ~8s. */
  splat(x: number, groundY: number, z: number, big: boolean): void {
    if (this.splats.length >= MAX_SPLATS) this.evict(this.splats, this.sMesh)
    this.splats.push({
      x: x + (Math.random() - 0.5) * 0.4,
      // tiny per-splat lift avoids z-fighting between overlapping splats
      y: groundY + 0.015 + Math.random() * 0.012,
      z: z + (Math.random() - 0.5) * 0.4,
      rot: Math.random() * Math.PI,
      size: (big ? 0.7 : 0.35) + Math.random() * (big ? 0.6 : 0.3),
      life: 0,
    })
    const shade = SPLAT_SHADES[Math.floor(Math.random() * SPLAT_SHADES.length)] ?? 0x7c1119
    this.sMesh.setColorAt(this.splats.length - 1, this.color.setHex(shade))
    if (this.sMesh.instanceColor) this.sMesh.instanceColor.needsUpdate = true
  }

  update(dt: number): void {
    // --- particles ---------------------------------------------------------
    const ps = this.particles
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]!
      p.life += dt
      if (p.life >= p.ttl) {
        const last = ps.length - 1
        if (i !== last) {
          ps[i] = ps[last]!
          this.copyInstanceColor(this.pMesh, last, i)
        }
        ps.pop()
        continue
      }
      p.vy += GRAVITY * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      if (p.y < p.groundY + p.size * 0.5) {
        p.y = p.groundY + p.size * 0.5
        if (!p.bounced && p.vy < -2) {
          p.vy *= -0.3
          p.vx *= 0.5
          p.vz *= 0.5
          p.bounced = true
        } else {
          p.vy = 0
          p.vx *= 0.8
          p.vz *= 0.8
        }
      }
    }
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!
      const fade = 1 - Math.max(0, (p.life - p.ttl * 0.6) / (p.ttl * 0.4))
      const s = p.size * Math.max(0.05, fade)
      this.dummy.position.set(p.x, p.y, p.z)
      this.dummy.rotation.set(p.spin + p.life * 4, p.spin, 0)
      this.dummy.scale.setScalar(s)
      this.dummy.updateMatrix()
      this.pMesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.pMesh.count = ps.length
    this.pMesh.instanceMatrix.needsUpdate = true

    // --- splats ------------------------------------------------------------
    const ss = this.splats
    for (let i = ss.length - 1; i >= 0; i--) {
      const sp = ss[i]!
      sp.life += dt
      if (sp.life >= SPLAT_TTL) {
        const last = ss.length - 1
        if (i !== last) {
          ss[i] = ss[last]!
          this.copyInstanceColor(this.sMesh, last, i)
        }
        ss.pop()
      }
    }
    for (let i = 0; i < ss.length; i++) {
      const sp = ss[i]!
      // hold ~6s, then shrink away over the last 2s
      const shrink = sp.life < 6 ? 1 : Math.max(0, 1 - (sp.life - 6) / 2)
      this.dummy.position.set(sp.x, sp.y, sp.z)
      this.dummy.rotation.set(0, sp.rot, 0)
      this.dummy.scale.set(sp.size * shrink, 1, sp.size * 0.8 * shrink)
      this.dummy.updateMatrix()
      this.sMesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.sMesh.count = ss.length
    this.sMesh.instanceMatrix.needsUpdate = true
  }

  /** Drop the oldest entry (index 0) via swap-remove, keeping colors aligned. */
  private evict(list: { length: number }[] | unknown[], mesh: THREE.InstancedMesh): void {
    const arr = list as unknown[]
    const last = arr.length - 1
    if (last < 0) return
    if (last > 0) {
      arr[0] = arr[last]
      this.copyInstanceColor(mesh, last, 0)
    }
    arr.pop()
  }

  private copyInstanceColor(mesh: THREE.InstancedMesh, from: number, to: number): void {
    if (!mesh.instanceColor) return
    mesh.getColorAt(from, this.color)
    mesh.setColorAt(to, this.color)
    mesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.pMesh.removeFromParent()
    this.pMesh.geometry.dispose()
    ;(this.pMesh.material as THREE.Material).dispose()
    this.pMesh.dispose()
    this.sMesh.removeFromParent()
    this.sMesh.geometry.dispose()
    ;(this.sMesh.material as THREE.Material).dispose()
    this.sMesh.dispose()
  }
}
