/**
 * Raid FX — a self-contained pool of gravity-free fading voxel cubes, in the
 * same fixed-capacity InstancedMesh spirit as the combat blood/special pools
 * (zero allocation after construction, one draw call). Raids own their own FX
 * so the module stays leaf-free (no cross-module imports beyond three).
 *
 * Drives: telegraphed ground warning rings (the "move NOW" tell before a boss
 * AoE lands), the impact burst when it lands, expanding nova shockwaves on
 * phase transitions, and chunky voxel gibs so a slain apex boss ends with a
 * fountain, not a fade.
 */
import * as THREE from 'three'

const MAX_BOXES = 520

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
  /** Scale growth per second (rings/novas expand). */
  grow: number
  spin: number
  gravity: number
}

export class RaidFx {
  private readonly boxes: FadeBox[] = []
  private readonly mesh: THREE.InstancedMesh
  private readonly dummy = new THREE.Object3D()
  private readonly color = new THREE.Color()

  /** Live flat ground telegraphs (own geometry; drawn as thin glowing discs). */
  private readonly telegraphs: {
    mesh: THREE.Mesh
    mat: THREE.MeshBasicMaterial
    maxR: number
    life: number
    dur: number
  }[] = []

  private readonly scene: THREE.Scene

  constructor(scene: THREE.Scene) {
    this.scene = scene
    const geo = new THREE.BoxGeometry(1, 1, 1)
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x444444 })
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_BOXES)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
  }

  private add(
    x: number, y: number, z: number,
    size: number, colorHex: number, ttl: number,
    vx = 0, vy = 0, vz = 0, grow = 0, gravity = 0
  ): void {
    if (this.boxes.length >= MAX_BOXES) {
      const last = this.boxes.length - 1
      if (last > 0) {
        this.boxes[0] = this.boxes[last]!
        this.copyColor(last, 0)
      }
      this.boxes.pop()
    }
    this.boxes.push({
      x, y, z, vx, vy, vz, size, life: 0, ttl, grow,
      spin: Math.random() * Math.PI, gravity
    })
    this.mesh.setColorAt(this.boxes.length - 1, this.color.setHex(colorHex))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /**
   * Telegraph a ground AoE: a flat glowing disc that fills from faint to hot
   * over `dur` seconds, warning players to leave. Purely a tell — the damage
   * is applied by the caller when the timer elapses. `y` is the ground height.
   */
  warning(x: number, y: number, z: number, radius: number, colorHex: number, dur: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex,
      transparent: true,
      opacity: 0.15,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), mat)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x, y + 0.06, z)
    mesh.renderOrder = 2
    this.scene.add(mesh)
    this.telegraphs.push({ mesh, mat, maxR: radius, life: 0, dur })
  }

  /** The hit landing: a chunky upward burst of colored voxel gibs. */
  burst(x: number, y: number, z: number, colorHex: number, power = 1): void {
    const n = Math.round(14 * power)
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 1.5 + Math.random() * 3.5 * power
      this.add(
        x, y + 0.25, z,
        0.18 + Math.random() * 0.14, colorHex, 0.5 + Math.random() * 0.4,
        Math.cos(a) * sp * 0.4, 3 + Math.random() * 4 * power, Math.sin(a) * sp * 0.4,
        0, 9
      )
    }
  }

  /** Expanding flat ring of cubes (shockwave on a landed AoE / phase change). */
  ring(x: number, y: number, z: number, colorHex: number, maxR: number, n = 26): void {
    const speed = maxR / 0.42
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      this.add(
        x + Math.cos(a) * 0.4, y + 0.14, z + Math.sin(a) * 0.4,
        0.22, colorHex, 0.5,
        Math.cos(a) * speed, 0, Math.sin(a) * speed
      )
    }
  }

  /** Upward nova fountain + ring (phase transition drama). */
  nova(x: number, y: number, z: number, colorHex: number, maxR: number): void {
    this.ring(x, y, z, colorHex, maxR, 30)
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * 0.8
      this.add(
        x + Math.cos(a) * r, y + 0.3, z + Math.sin(a) * r,
        0.16 + Math.random() * 0.12, colorHex, 0.6 + Math.random() * 0.3,
        Math.cos(a) * 1.6, 4 + Math.random() * 4, Math.sin(a) * 1.6,
        0, 7
      )
    }
  }

  update(dt: number): void {
    // --- gib cubes ----------------------------------------------------------
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
      b.vy -= b.gravity * dt
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.z += b.vz * dt
      if (b.y < 0.05) {
        b.y = 0.05
        b.vy = 0
        b.vx *= 0.6
        b.vz *= 0.6
      }
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

    // --- telegraph discs ----------------------------------------------------
    for (let i = this.telegraphs.length - 1; i >= 0; i--) {
      const t = this.telegraphs[i]!
      t.life += dt
      const k = Math.min(1, t.life / t.dur)
      // fill + pulse toward the strike
      t.mat.opacity = 0.14 + k * 0.5 + (k > 0.6 ? Math.abs(Math.sin(t.life * 24)) * 0.3 : 0)
      t.mesh.scale.setScalar(0.3 + k * 0.7)
      if (t.life >= t.dur + 0.12) {
        this.scene.remove(t.mesh)
        t.mesh.geometry.dispose()
        t.mat.dispose()
        this.telegraphs.splice(i, 1)
      }
    }
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
    for (const t of this.telegraphs) {
      this.scene.remove(t.mesh)
      t.mesh.geometry.dispose()
      t.mat.dispose()
    }
    this.telegraphs.length = 0
    this.boxes.length = 0
  }
}
