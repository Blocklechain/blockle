/**
 * Weapon-special VFX — the flashy half of src/combat/specials.ts.
 *
 * Same fixed-capacity InstancedMesh philosophy as BloodSystem (blood.ts):
 * one pool of gravity-free fading voxel cubes drives motion trails, nova
 * rings, shockwaves and cast sparkles — zero allocation after construction,
 * one draw call. Projectiles (fireballs, arrows) are tiny voxel Groups
 * built here and flown by the combat tick.
 */
import * as THREE from 'three'

const MAX_BOXES = 360

interface FadeBox {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  size: number
  life: number
  ttl: number
  /** Scale multiplier growth per second (rings expand, trails shrink). */
  grow: number
  spin: number
}

export class SpecialFx {
  private readonly boxes: FadeBox[] = []
  private readonly mesh: THREE.InstancedMesh
  private readonly dummy = new THREE.Object3D()
  private readonly color = new THREE.Color()

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x444444 })
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_BOXES)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
  }

  /** One fading cube. Velocity optional; grow >0 expands, <0 shrinks faster. */
  add(
    x: number, y: number, z: number,
    size: number, colorHex: number, ttl: number,
    vx = 0, vy = 0, vz = 0, grow = 0
  ): void {
    if (this.boxes.length >= MAX_BOXES) {
      // drop the oldest (swap-remove keeps colors aligned)
      const last = this.boxes.length - 1
      if (last > 0) {
        this.boxes[0] = this.boxes[last]!
        this.copyColor(last, 0)
      }
      this.boxes.pop()
    }
    this.boxes.push({ x, y, z, vx, vy, vz, size, life: 0, ttl, grow, spin: Math.random() * Math.PI })
    this.mesh.setColorAt(this.boxes.length - 1, this.color.setHex(colorHex))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** A short motion-trail puff (lunge dash, projectile wake). */
  trail(x: number, y: number, z: number, colorHex: number, size = 0.16): void {
    this.add(
      x + (Math.random() - 0.5) * 0.25,
      y + (Math.random() - 0.5) * 0.25,
      z + (Math.random() - 0.5) * 0.25,
      size * (0.8 + Math.random() * 0.5), colorHex, 0.3 + Math.random() * 0.2
    )
  }

  /** Expanding flat ring of cubes (whirlwind sweep, bash shockwave). */
  ring(x: number, y: number, z: number, colorHex: number, maxR: number, n = 18): void {
    const speed = maxR / 0.38
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      this.add(
        x + Math.cos(a) * 0.3, y + 0.12, z + Math.sin(a) * 0.3,
        0.17, colorHex, 0.42,
        Math.cos(a) * speed, 0, Math.sin(a) * speed
      )
    }
  }

  /** Upward nova fountain + ring (crystal/mythic finishers). */
  nova(x: number, y: number, z: number, colorHex: number, maxR: number): void {
    this.ring(x, y, z, colorHex, maxR, 22)
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 0.6
      this.add(
        x + Math.cos(a) * r, y + 0.3, z + Math.sin(a) * r,
        0.14 + Math.random() * 0.1, colorHex, 0.5 + Math.random() * 0.25,
        Math.cos(a) * 1.2, 3.5 + Math.random() * 3, Math.sin(a) * 1.2
      )
    }
  }

  /** Cone of cubes thrown out ahead (shield bash). */
  cone(x: number, y: number, z: number, facing: number, colorHex: number, range: number): void {
    for (let i = 0; i < 14; i++) {
      const a = facing + (Math.random() - 0.5) * 1.7
      const sp = (range / 0.35) * (0.6 + Math.random() * 0.5)
      this.add(
        x, y + 0.25 + Math.random() * 0.4, z,
        0.15, colorHex, 0.38,
        Math.sin(a) * sp, 0.4, Math.cos(a) * sp
      )
    }
  }

  update(dt: number): void {
    const bs = this.boxes
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i]!
      b.life += dt
      if (b.life >= b.ttl) {
        const last = bs.length - 1
        if (i !== last) {
          bs[i] = bs[last]!
          this.copyColor(last, i)
        }
        bs.pop()
      }
    }
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i]!
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.z += b.vz * dt
      const k = b.life / b.ttl
      const fade = 1 - k * k
      const s = Math.max(0.02, b.size * (1 + b.grow * b.life) * fade)
      this.dummy.position.set(b.x, b.y, b.z)
      this.dummy.rotation.set(b.spin + b.life * 5, b.spin, 0)
      this.dummy.scale.setScalar(s)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.mesh.count = bs.length
    this.mesh.instanceMatrix.needsUpdate = true
  }

  private copyColor(from: number, to: number): void {
    if (!this.mesh.instanceColor) return
    this.mesh.getColorAt(from, this.color)
    this.mesh.setColorAt(to, this.color)
    this.mesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
  }
}

// ---------------------------------------------------------------------------
// Projectile visuals (flown + disposed by the combat tick)
// ---------------------------------------------------------------------------

function pbox(
  g: THREE.Group,
  x: number, y: number, z: number,
  sx: number, sy: number, sz: number,
  color: number, emissive: number
): void {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(sx, sy, sz),
    new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: 0.8 })
  )
  m.position.set(x, y, z)
  g.add(m)
}

/** A chunky glowing fire/mana orb. Spin it a little every frame. */
export function makeOrb(color: number, core: number): THREE.Group {
  const g = new THREE.Group()
  pbox(g, 0, 0, 0, 0.3, 0.3, 0.3, color, color)
  pbox(g, 0, 0, 0, 0.42, 0.18, 0.18, core, core)
  pbox(g, 0, 0, 0, 0.18, 0.42, 0.18, core, core)
  return g
}

/** A voxel arrow pointing +Z; rotate .rotation.y = atan2(dx, dz) to aim. */
export function makeArrow(color: number): THREE.Group {
  const g = new THREE.Group()
  pbox(g, 0, 0, 0, 0.05, 0.05, 0.5, 0x8a5a2b, 0x000000) // shaft
  pbox(g, 0, 0, 0.3, 0.09, 0.09, 0.12, color, color) // head
  pbox(g, 0, 0, -0.26, 0.11, 0.03, 0.1, 0xe8e4da, 0x000000) // fletching
  return g
}

/** Free a projectile group's GPU resources. */
export function disposeProjectile(g: THREE.Group): void {
  g.removeFromParent()
  g.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const m of mats) m.dispose()
    }
  })
}
