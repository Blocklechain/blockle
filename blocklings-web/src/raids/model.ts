/**
 * Giant voxel raid-boss builder + animation rig.
 *
 * These are the apex fights, so they are NOT the standard MobRig at a bigger
 * scale — each archetype gets its own hand-built flat-color Lambert voxel
 * silhouette (3-4x a normal boss), recognisable from across the zone:
 *
 *   'wyrm'     — a long undulating ice drake: tapering segmented body, swept
 *                wings, a horned frost head with glowing eyes.
 *   'colossus' — a mountainous golem: tree-trunk legs, a slab torso veined
 *                with glowing magma, boulder shoulders, a tiny grim head.
 *   'tyrant'   — a towering skeleton lord: stacked spine, a ribcage, long
 *                bony arms and a crowned skull with burning eye-sockets.
 *   'warlord'  — an ascended orc: broad tusked brute wreathed in an ethereal
 *                glow, hauling a cleaver the size of a door.
 *
 * Same voxel vocabulary + budget discipline as the rest of the game: cached
 * shared BoxGeometry, per-rig materials (so the hurt flash + telegraph pulse
 * never leak between rigs), and ZERO point lights — every glow is emissive, so
 * a boss adds nothing to the scarce light budget.
 */
import * as THREE from 'three'

export type RaidArchetype = 'wyrm' | 'colossus' | 'tyrant' | 'warlord'

// --- shared geometry cache (never disposed per-rig) --------------------------
const geoCache = new Map<string, THREE.BoxGeometry>()
function geo(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w}|${h}|${d}`
  let g = geoCache.get(key)
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d)
    geoCache.set(key, g)
  }
  return g
}

export interface RaidModelSpec {
  archetype: RaidArchetype
  /** Primary body color. */
  color: number
  /** Secondary/darker structural color. */
  dark: number
  /** Emissive accent (eyes, cracks, aura). */
  glow: number
}

export class RaidBossRig {
  readonly group = new THREE.Group()
  /** Top-of-silhouette height (world units) — HP-bar / label anchor. */
  readonly height: number
  /** Melee + hit-test radius (world units) — these things are large. */
  readonly radius: number

  private readonly body = new THREE.Group()
  private readonly headPivot = new THREE.Group()
  private readonly wings: THREE.Group[] = []
  private readonly arms: THREE.Group[] = []
  private readonly segments: THREE.Group[] = []

  private readonly mats: THREE.MeshLambertMaterial[] = []
  private readonly baseEmissive: number[] = []
  /** Materials that carry the archetype glow (pulse up on phase change). */
  private readonly glowMats: THREE.MeshLambertMaterial[] = []
  private readonly glowBase: number

  private readonly archetype: RaidArchetype
  private t = Math.random() * 10
  private hurtT = -1
  private telegraphP = -1
  private strikeT = -1
  private phaseBoost = 0
  private mode: 'alive' | 'dying' | 'dead' = 'alive'
  private dieT = 0
  private dieCb: (() => void) | null = null

  constructor(spec: RaidModelSpec) {
    this.archetype = spec.archetype
    this.glowBase = spec.glow
    this.group.add(this.body)

    const m = (c: number, emissive = 0): THREE.MeshLambertMaterial => {
      const mat = new THREE.MeshLambertMaterial({ color: c })
      if (emissive) mat.emissive.setHex(emissive)
      this.mats.push(mat)
      this.baseEmissive.push(emissive)
      if (emissive === spec.glow) this.glowMats.push(mat)
      return mat
    }
    const box = (
      x: number, y: number, z: number,
      w: number, h: number, d: number,
      mat: THREE.MeshLambertMaterial,
      parent: THREE.Group = this.body
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo(w, h, d), mat)
      mesh.position.set(x, y, z)
      mesh.castShadow = true
      parent.add(mesh)
      return mesh
    }

    const base = m(spec.color)
    const dark = m(spec.dark)
    const glow = m(spec.glow, spec.glow)

    let height = 8
    let radius = 2.4

    switch (spec.archetype) {
      case 'wyrm': {
        // undulating segmented ice drake arcing up from the ground
        const segN = 6
        for (let i = 0; i < segN; i++) {
          const seg = new THREE.Group()
          const s = 1.4 - i * 0.13
          box(0, 0, 0, s, s, 1.4, i % 2 ? dark : base, seg)
          // dorsal frost spike
          box(0, s * 0.5 + 0.2, 0, 0.3, 0.7 - i * 0.07, 0.3, glow, seg)
          seg.position.set(0, 2.2 + Math.sin(i * 0.6) * 0.5, -i * 1.25)
          this.segments.push(seg)
          this.body.add(seg)
        }
        // head at the front (+Z), horned, glowing eyes
        this.headPivot.position.set(0, 3.0, 1.1)
        box(0, 0, 0.2, 1.7, 1.5, 1.8, base, this.headPivot)
        box(0, -0.2, 1.3, 1.1, 0.7, 0.8, dark, this.headPivot) // snout
        box(-0.5, 0.3, -0.7, 0.35, 1.3, 0.35, dark, this.headPivot) // horns
        box(0.5, 0.3, -0.7, 0.35, 1.3, 0.35, dark, this.headPivot)
        box(-0.42, 0.25, 0.95, 0.3, 0.3, 0.2, glow, this.headPivot) // eyes
        box(0.42, 0.25, 0.95, 0.3, 0.3, 0.2, glow, this.headPivot)
        this.body.add(this.headPivot)
        // swept wings mid-body
        for (const side of [-1, 1] as const) {
          const w = new THREE.Group()
          w.position.set(side * 0.8, 3.1, -1.2)
          box(side * 1.6, 0.2, -0.6, 3.0, 0.2, 2.0, dark, w)
          box(side * 1.4, 0.5, 0.3, 2.4, 0.2, 1.2, base, w)
          this.wings.push(w)
          this.body.add(w)
        }
        height = 6.5
        radius = 3.0
        break
      }

      case 'colossus': {
        // mountainous magma golem
        for (const lx of [-1.25, 1.25]) {
          box(lx, 1.4, 0, 1.3, 2.8, 1.4, dark) // legs
          box(lx, 0.25, 0.3, 1.5, 0.5, 1.6, dark) // feet
        }
        const torso = box(0, 4.6, 0, 3.8, 3.4, 2.6, base) // slab torso
        torso.name = 'torso'
        // glowing magma veins across the torso
        box(-0.9, 4.9, 1.35, 0.5, 1.8, 0.1, glow)
        box(0.7, 4.2, 1.35, 0.4, 2.2, 0.1, glow)
        box(0, 5.6, 1.35, 1.6, 0.4, 0.1, glow)
        // boulder shoulders
        for (const side of [-1, 1] as const) {
          const arm = new THREE.Group()
          arm.position.set(side * 2.3, 5.9, 0)
          box(0, 0, 0, 1.6, 1.6, 1.8, dark, arm) // shoulder
          box(0, -2.1, 0.1, 1.2, 2.8, 1.2, base, arm) // upper arm
          box(0, -3.6, 0.3, 1.5, 1.3, 1.5, dark, arm) // fist
          box(0, -2.4, 0.75, 0.25, 1.6, 0.1, glow, arm) // vein
          this.arms.push(arm)
          this.body.add(arm)
        }
        // small grim head sunk between the shoulders
        this.headPivot.position.set(0, 6.6, 0.2)
        box(0, 0, 0, 1.4, 1.3, 1.4, dark, this.headPivot)
        box(-0.35, 0.05, 0.75, 0.3, 0.2, 0.1, glow, this.headPivot) // eyes
        box(0.35, 0.05, 0.75, 0.3, 0.2, 0.1, glow, this.headPivot)
        this.body.add(this.headPivot)
        height = 7.8
        radius = 3.2
        break
      }

      case 'tyrant': {
        // towering crowned skeleton lord
        box(0, 1.1, 0, 2.2, 0.8, 1.6, base) // pelvis
        // stacked spine
        for (let i = 0; i < 4; i++) box(0, 2.0 + i * 0.7, 0, 0.7, 0.55, 0.7, base)
        // ribcage
        const chest = box(0, 5.2, 0, 2.6, 2.4, 1.8, base)
        chest.name = 'chest'
        for (let i = 0; i < 4; i++) {
          const ry = 4.4 + i * 0.55
          box(-1.25, ry, 0.5, 0.25, 0.3, 0.9, dark)
          box(1.25, ry, 0.5, 0.25, 0.3, 0.9, dark)
        }
        // long bony arms
        for (const side of [-1, 1] as const) {
          const arm = new THREE.Group()
          arm.position.set(side * 1.6, 6.2, 0)
          box(0, -1.4, 0, 0.45, 2.8, 0.45, base, arm)
          box(0, -3.1, 0.2, 0.7, 0.9, 0.7, dark, arm) // claw hand
          this.arms.push(arm)
          this.body.add(arm)
        }
        // crowned skull with burning sockets
        this.headPivot.position.set(0, 7.3, 0)
        box(0, 0, 0, 1.6, 1.6, 1.5, base, this.headPivot)
        box(0, -0.2, 0.85, 1.0, 0.6, 0.5, dark, this.headPivot) // jaw
        box(-0.4, 0.1, 0.78, 0.35, 0.35, 0.2, glow, this.headPivot) // sockets
        box(0.4, 0.1, 0.78, 0.35, 0.35, 0.2, glow, this.headPivot)
        // crown
        const gold = m(0xf2c43d)
        box(0, 0.95, 0, 1.4, 0.3, 1.4, gold, this.headPivot)
        for (const [cx, cz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, 0]] as const) {
          box(cx, 1.3, cz, 0.22, 0.5, 0.22, gold, this.headPivot)
        }
        this.body.add(this.headPivot)
        height = 8.6
        radius = 2.8
        break
      }

      case 'warlord': {
        // ascended orc brute wreathed in glow, hauling a cleaver
        for (const lx of [-0.95, 0.95]) {
          box(lx, 1.3, 0, 1.1, 2.6, 1.2, dark) // legs
          box(lx, 0.2, 0.2, 1.3, 0.4, 1.4, dark)
        }
        box(0, 4.4, 0, 3.4, 3.2, 2.2, base) // broad torso
        box(0, 3.3, 1.15, 2.4, 1.6, 0.3, dark) // belt/plate
        // ethereal aura slabs (emissive, floating around the chest)
        box(-2.0, 4.8, 0, 0.3, 2.4, 1.6, glow)
        box(2.0, 4.8, 0, 0.3, 2.4, 1.6, glow)
        box(0, 6.4, -1.3, 1.8, 1.4, 0.3, glow)
        // shoulders + arms
        for (const side of [-1, 1] as const) {
          const arm = new THREE.Group()
          arm.position.set(side * 2.1, 5.7, 0)
          box(0, 0, 0, 1.5, 1.4, 1.6, dark, arm) // pauldron
          box(0, -2.0, 0.1, 1.0, 2.6, 1.0, base, arm) // arm
          this.arms.push(arm)
          this.body.add(arm)
        }
        // right hand hefts a giant cleaver (built into the right arm group)
        const right = this.arms[1]
        if (right) {
          const steel = m(0x9aa2ad)
          const wood = m(0x5a3a22)
          box(0, -3.6, 0.2, 0.4, 2.6, 0.4, wood, right) // haft
          box(0, -5.0, 0.4, 2.4, 1.8, 0.4, steel, right) // blade
          box(0.9, -4.6, 0.4, 0.8, 2.6, 0.45, steel, right)
        }
        // tusked head
        this.headPivot.position.set(0, 6.5, 0.1)
        box(0, 0, 0, 1.7, 1.6, 1.6, base, this.headPivot)
        box(-0.45, -0.55, 0.8, 0.22, 0.6, 0.22, m(0xe8e2d2), this.headPivot) // tusks
        box(0.45, -0.55, 0.8, 0.22, 0.6, 0.22, m(0xe8e2d2), this.headPivot)
        box(-0.42, 0.15, 0.82, 0.32, 0.28, 0.2, glow, this.headPivot) // eyes
        box(0.42, 0.15, 0.82, 0.32, 0.28, 0.2, glow, this.headPivot)
        this.body.add(this.headPivot)
        height = 8.0
        radius = 3.0
        break
      }
    }

    this.height = height
    this.radius = radius
  }

  // --- animation API ---------------------------------------------------------

  /** Boss telegraph tell: 0..1 glow pulse while winding up a big move; -1 clears. */
  telegraph(p: number): void {
    if (p < 0 && this.telegraphP >= 0 && this.hurtT < 0) this.restoreEmissive()
    this.telegraphP = p
  }

  /** Quick forward strike snap. */
  strike(): void {
    this.strikeT = 0
    this.telegraphP = -1
  }

  /** Red hurt flash. */
  flashHurt(): void {
    this.hurtT = 0
    for (const mat of this.mats) mat.emissive.setHex(0x8a1f1f)
  }

  /** Phase 0..n — raises the resting glow intensity each phase (meaner look). */
  setPhase(phase: number): void {
    this.phaseBoost = Math.max(0, phase) * 0.35
  }

  /** Comedic giant topple; `onDone` fires when flat. */
  die(onDone?: () => void): void {
    if (this.mode !== 'alive') return
    this.mode = 'dying'
    this.dieT = 0
    this.dieCb = onDone ?? null
    this.telegraphP = -1
  }

  get alive(): boolean {
    return this.mode === 'alive'
  }

  private restoreEmissive(): void {
    for (let i = 0; i < this.mats.length; i++) {
      this.mats[i]!.emissive.setHex(this.baseEmissive[i] ?? 0)
    }
    this.applyPhaseGlow()
  }

  private applyPhaseGlow(): void {
    if (this.phaseBoost <= 0) return
    const c = new THREE.Color(this.glowBase).multiplyScalar(1 + this.phaseBoost)
    for (const g of this.glowMats) g.emissive.copy(c)
  }

  update(dt: number): void {
    this.t += dt

    if (this.hurtT >= 0) {
      this.hurtT += dt
      if (this.hurtT > 0.14) {
        this.hurtT = -1
        this.restoreEmissive()
      }
    }

    if (this.mode !== 'alive') {
      if (this.mode === 'dying') {
        this.dieT += dt
        const k = Math.min(1, this.dieT / 0.9)
        const e = 1 - (1 - k) ** 3
        this.body.rotation.z = e * (Math.PI / 2) * 0.85
        this.body.position.y = Math.sin(k * Math.PI) * 0.5
        this.body.scale.y = 1 - e * 0.4
        if (k >= 1) {
          this.mode = 'dead'
          const cb = this.dieCb
          this.dieCb = null
          cb?.()
        }
      }
      return
    }

    // idle presence: slow breathing bob + archetype flourish
    const bob = Math.sin(this.t * 1.4) * 0.12
    this.body.position.y = bob
    switch (this.archetype) {
      case 'wyrm':
        for (let i = 0; i < this.segments.length; i++) {
          const s = this.segments[i]!
          s.position.y = 2.2 + Math.sin(this.t * 2 + i * 0.6) * 0.5
          s.rotation.x = Math.sin(this.t * 2 + i * 0.6) * 0.12
        }
        for (let i = 0; i < this.wings.length; i++) {
          this.wings[i]!.rotation.z = (i === 0 ? 1 : -1) * Math.sin(this.t * 2.4) * 0.45
        }
        this.headPivot.rotation.x = Math.sin(this.t * 1.6) * 0.12
        break
      case 'colossus':
        this.body.rotation.z = Math.sin(this.t * 0.8) * 0.02
        for (let i = 0; i < this.arms.length; i++) {
          this.arms[i]!.rotation.x = Math.sin(this.t * 0.9 + i) * 0.08
        }
        break
      case 'tyrant':
        this.body.rotation.y = Math.sin(this.t * 0.5) * 0.08
        for (let i = 0; i < this.arms.length; i++) {
          this.arms[i]!.rotation.z = (i === 0 ? 1 : -1) * (0.1 + Math.sin(this.t * 1.1) * 0.1)
        }
        break
      case 'warlord':
        this.body.rotation.z = Math.sin(this.t * 1.0) * 0.03
        this.headPivot.rotation.y = Math.sin(this.t * 0.7) * 0.12
        break
    }

    // telegraph tell: lean back + emissive blink in the last third
    if (this.telegraphP >= 0) {
      const p = this.telegraphP
      this.body.rotation.x = -0.35 * p
      if (this.hurtT < 0) {
        const blink = p > 0.5 && Math.sin(this.t * 26) > 0
        for (let i = 0; i < this.mats.length; i++) {
          this.mats[i]!.emissive.setHex(blink ? 0x6e1414 : (this.baseEmissive[i] ?? 0))
        }
        if (blink) this.applyPhaseGlow()
      }
    } else if (this.strikeT < 0) {
      this.body.rotation.x *= 1 - Math.min(1, dt * 8)
    }

    // strike snap
    if (this.strikeT >= 0) {
      this.strikeT += dt
      const k = Math.min(1, this.strikeT / 0.3)
      this.body.rotation.x = 0.6 * Math.sin(k * Math.PI)
      for (const a of this.arms) a.rotation.x = -0.9 * Math.sin(k * Math.PI)
      if (k >= 1) {
        this.strikeT = -1
        for (const a of this.arms) a.rotation.x = 0
        if (this.hurtT < 0) this.restoreEmissive()
      }
    }
  }

  dispose(): void {
    for (const mat of this.mats) mat.dispose()
    this.mats.length = 0
    this.glowMats.length = 0
  }
}
