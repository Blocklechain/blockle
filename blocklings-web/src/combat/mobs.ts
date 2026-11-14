/**
 * Voxel mob builder + animation rig for all 13 species in src/ids.ts.
 *
 * Same hand-built flat-color Lambert voxel vocabulary as the hero: boxes,
 * NO textures except the 8x8 pixel face (NearestFilter, big sparkly eyes),
 * and the same procedural animation charm — blobs jiggle and hop, quadrupeds
 * trot, bipeds waddle with tiny weapons, crawlers scuttle, flyers bob.
 *
 * Bosses: 2.2x scale + a little gold crown + a meaner telegraph.
 *
 * Geometry is cached module-wide (shared, never disposed per-rig); materials
 * are per-rig so the red hurt-flash never leaks onto siblings.
 */
import * as THREE from 'three'
import type { SpeciesDef } from '../ids'

// ---------------------------------------------------------------------------
// Shared caches
// ---------------------------------------------------------------------------

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

/** 8x8 pixel face per species — cached texture, shared across rigs. */
const faceCache = new Map<string, THREE.CanvasTexture>()

function makeFaceTexture(sp: SpeciesDef): THREE.CanvasTexture {
  const cached = faceCache.get(sp.id)
  if (cached) return cached

  const c = document.createElement('canvas')
  c.width = 8
  c.height = 8
  const g = c.getContext('2d')
  if (g) {
    // face background: a touch lighter than the body so the eyes pop
    const bg = new THREE.Color(sp.color).offsetHSL(0, 0, 0.06)
    g.fillStyle = `#${bg.getHexString()}`
    g.fillRect(0, 0, 8, 8)

    const mean = sp.tier >= 3 || sp.id === 'wolf' || sp.id === 'spider'
    const fangs = sp.id === 'wolf' || sp.id === 'spider' || sp.id === 'orc' || sp.id === 'imp'

    // big sparkly eyes (2x2 white, dark pupil)
    g.fillStyle = '#ffffff'
    g.fillRect(1, 2, 2, 2)
    g.fillRect(5, 2, 2, 2)
    g.fillStyle = sp.id === 'skeleton' || sp.id === 'wisp' ? '#35bfe8' : '#20242e'
    g.fillRect(2, 3, 1, 1)
    g.fillRect(5, 3, 1, 1)

    if (mean) {
      // angry slanted brows
      g.fillStyle = '#1c1820'
      g.fillRect(1, 1, 2, 1)
      g.fillRect(5, 1, 2, 1)
    } else {
      // rosy cheeks for the cuties
      g.fillStyle = 'rgba(235,120,110,0.6)'
      g.fillRect(0, 5, 1, 1)
      g.fillRect(7, 5, 1, 1)
    }

    // mouth
    if (fangs) {
      g.fillStyle = '#2a2026'
      g.fillRect(2, 5, 4, 1)
      g.fillStyle = '#ffffff'
      g.fillRect(2, 6, 1, 1)
      g.fillRect(5, 6, 1, 1)
    } else if (mean) {
      g.fillStyle = '#2a2026'
      g.fillRect(3, 5, 2, 1)
    } else {
      g.fillStyle = '#4a3328'
      g.fillRect(3, 5, 2, 1) // happy little smile
    }
  }
  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  faceCache.set(sp.id, tex)
  return tex
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

const BOSS_SCALE = 2.2

export class MobRig {
  /** Add to the scene; position = feet (ground), rotation.y = facing. */
  readonly group = new THREE.Group()
  /** Approximate top-of-head height in world units (HP bar anchor). */
  readonly height: number
  /** Flyers hover — their body is lifted and bobs. */
  readonly flying: boolean

  private readonly body = new THREE.Group()
  private readonly headPivot = new THREE.Group()
  private readonly legs: THREE.Group[] = []
  private readonly arms: THREE.Group[] = []
  private readonly wings: THREE.Group[] = []
  private tail: THREE.Object3D | null = null
  private crown: THREE.Group | null = null

  private readonly mats: THREE.MeshLambertMaterial[] = []
  private readonly baseEmissive: number[] = []

  private readonly shape: SpeciesDef['shape']
  private readonly boss: boolean
  private readonly bodyLift: number
  private t = Math.random() * 10
  private phase = Math.random() * Math.PI * 2
  private hurtT = -1
  private windupP = -1
  private lungeT = -1
  private mode: 'alive' | 'dying' | 'dead' = 'alive'
  private dieT = 0
  private dieCb: (() => void) | null = null

  constructor(sp: SpeciesDef, boss: boolean) {
    this.shape = sp.shape
    this.boss = boss
    this.flying = sp.shape === 'flyer'
    this.group.add(this.body)

    const base = new THREE.Color(sp.color)
    const dark = base.clone().multiplyScalar(0.72)
    const light = base.clone().offsetHSL(0, 0, 0.1)

    const m = (c: THREE.Color | number, emissive = 0): THREE.MeshLambertMaterial => {
      const mat = new THREE.MeshLambertMaterial({ color: c })
      if (emissive) mat.emissive.setHex(emissive)
      this.mats.push(mat)
      this.baseEmissive.push(emissive)
      return mat
    }
    const faceMat = new THREE.MeshLambertMaterial({ map: makeFaceTexture(sp) })
    this.mats.push(faceMat)
    this.baseEmissive.push(0)

    const box = (
      w: number,
      h: number,
      d: number,
      mat: THREE.Material | THREE.Material[]
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo(w, h, d), mat)
      mesh.castShadow = true
      return mesh
    }
    /** Head cube with the pixel face on +Z. */
    const faced = (size: number, bodyMat: THREE.MeshLambertMaterial): THREE.Mesh =>
      box(size, size, size, [bodyMat, bodyMat, bodyMat, bodyMat, faceMat, bodyMat])

    const baseMat = m(base)
    const darkMat = m(dark)
    const lightMat = m(light)

    let height = 1

    switch (sp.shape) {
      case 'blob': {
        // jiggling cube of joy, face on the body itself
        const s = sp.id === 'mushroom' ? 0.62 : 0.78
        const bodyBox = faced(s, baseMat)
        bodyBox.position.y = s / 2
        this.body.add(bodyBox)
        if (sp.id === 'mushroom') {
          // the beloved cap
          const cap = box(0.88, 0.16, 0.88, darkMat)
          cap.position.y = s + 0.08
          const dome = box(0.52, 0.14, 0.52, darkMat)
          dome.position.y = s + 0.22
          const spot = box(0.16, 0.02, 0.16, lightMat)
          spot.position.set(0.2, s + 0.17, 0.2)
          this.body.add(cap, dome, spot)
          height = s + 0.3
        } else {
          // slime: glossy lighter top blob
          const blob = box(0.4, 0.2, 0.4, lightMat)
          blob.position.set(-0.12, s + 0.06, -0.08)
          this.body.add(blob)
          height = s + 0.15
        }
        this.headPivot.position.y = s // unused pivot, keeps update() generic
        this.body.add(this.headPivot)
        break
      }

      case 'quadruped': {
        // trotting wolf: long body, head out front, ears, wagging tail
        const bodyBox = box(0.55, 0.45, 0.95, baseMat)
        bodyBox.position.y = 0.62
        this.body.add(bodyBox)
        this.headPivot.position.set(0, 0.78, 0.5)
        const head = faced(0.5, baseMat)
        head.position.set(0, 0.05, 0.12)
        const snout = box(0.24, 0.16, 0.18, lightMat)
        snout.position.set(0, -0.08, 0.42)
        const earL = box(0.12, 0.18, 0.08, darkMat)
        earL.position.set(-0.16, 0.36, 0.06)
        const earR = earL.clone()
        earR.position.x = 0.16
        this.headPivot.add(head, snout, earL, earR)
        this.body.add(this.headPivot)
        for (const [lx, lz] of [
          [-0.19, 0.33],
          [0.19, 0.33],
          [-0.19, -0.33],
          [0.19, -0.33],
        ] as const) {
          const pivot = new THREE.Group()
          pivot.position.set(lx, 0.45, lz)
          const leg = box(0.16, 0.42, 0.18, darkMat)
          leg.position.y = -0.22
          pivot.add(leg)
          this.legs.push(pivot)
          this.body.add(pivot)
        }
        const tail = box(0.12, 0.12, 0.34, darkMat)
        tail.position.set(0, 0.72, -0.6)
        tail.rotation.x = 0.5
        this.tail = tail
        this.body.add(tail)
        height = 1.15
        break
      }

      case 'biped': {
        // waddling mini-menace with a tiny weapon
        const chunky = sp.id === 'golem' || sp.id === 'orc'
        const torsoW = chunky ? 0.6 : 0.46
        const hipY = chunky ? 0.38 : 0.3
        for (const lx of [-torsoW * 0.28, torsoW * 0.28]) {
          const pivot = new THREE.Group()
          pivot.position.set(lx, hipY, 0)
          const leg = box(0.16, hipY, 0.2, darkMat)
          leg.position.y = -hipY / 2
          pivot.add(leg)
          this.legs.push(pivot)
          this.body.add(pivot)
        }
        const torsoH = chunky ? 0.52 : 0.4
        const torso = box(torsoW, torsoH, 0.32, baseMat)
        torso.position.y = hipY + torsoH / 2
        this.body.add(torso)
        const shoulderY = hipY + torsoH - 0.04
        for (const side of [-1, 1] as const) {
          const pivot = new THREE.Group()
          pivot.position.set(side * (torsoW / 2 + 0.09), shoulderY, 0)
          const arm = box(chunky ? 0.22 : 0.14, chunky ? 0.46 : 0.34, chunky ? 0.24 : 0.16, lightMat)
          arm.position.y = -(chunky ? 0.2 : 0.15)
          pivot.add(arm)
          if (side === 1) {
            const weapon = this.buildTinyWeapon(sp.id, box, m)
            if (weapon) {
              weapon.position.set(0.02, chunky ? -0.42 : -0.3, 0.1)
              weapon.rotation.x = -0.4
              pivot.add(weapon)
            }
          }
          this.arms.push(pivot)
          this.body.add(pivot)
        }
        this.headPivot.position.y = hipY + torsoH
        const headSize = chunky ? 0.56 : 0.5
        const head = faced(headSize, baseMat)
        head.position.y = headSize / 2 + 0.02
        this.headPivot.add(head)
        if (sp.id === 'goblin' || sp.id === 'imp') {
          // pointy little ears
          for (const side of [-1, 1] as const) {
            const ear = box(0.14, 0.1, 0.06, baseMat)
            ear.position.set(side * (headSize / 2 + 0.06), headSize * 0.6, 0)
            this.headPivot.add(ear)
          }
        }
        if (sp.id === 'imp') {
          for (const side of [-1, 1] as const) {
            const horn = box(0.08, 0.16, 0.08, darkMat)
            horn.position.set(side * headSize * 0.3, headSize + 0.08, 0)
            this.headPivot.add(horn)
          }
        }
        if (sp.id === 'golem') {
          // heavy stone brow + mossy shoulder slabs
          const brow = box(headSize + 0.1, 0.12, 0.14, darkMat)
          brow.position.set(0, headSize * 0.82, headSize / 2 - 0.02)
          this.headPivot.add(brow)
        }
        if (sp.id === 'bandit') {
          // shifty hood
          const hood = box(headSize + 0.08, 0.16, headSize + 0.08, darkMat)
          hood.position.y = headSize + 0.06
          this.headPivot.add(hood)
        }
        this.body.add(this.headPivot)
        height = hipY + torsoH + headSize + 0.15
        break
      }

      case 'crawler': {
        // low scuttler: wide flat body, legs out the sides
        const crab = sp.id === 'crab'
        const bodyBox = faced(0.5, baseMat)
        bodyBox.scale.set(1.6, 0.68, 1.2)
        bodyBox.position.y = 0.32
        this.body.add(bodyBox)
        if (!crab) {
          // spider abdomen
          const abd = box(0.5, 0.4, 0.5, darkMat)
          abd.position.set(0, 0.36, -0.5)
          this.body.add(abd)
        }
        const pairs = crab ? 3 : 3
        for (let i = 0; i < pairs; i++) {
          for (const side of [-1, 1] as const) {
            const pivot = new THREE.Group()
            pivot.position.set(side * 0.42, 0.3, 0.22 - i * 0.22)
            const leg = box(0.3, 0.08, 0.08, darkMat)
            leg.position.x = side * 0.17
            const foot = box(0.08, 0.22, 0.08, darkMat)
            foot.position.set(side * 0.3, -0.1, 0)
            pivot.add(leg, foot)
            this.legs.push(pivot)
            this.body.add(pivot)
          }
        }
        if (crab) {
          // claws up front, always ready to pinch
          for (const side of [-1, 1] as const) {
            const pivot = new THREE.Group()
            pivot.position.set(side * 0.36, 0.38, 0.32)
            const arm = box(0.1, 0.1, 0.2, darkMat)
            arm.position.z = 0.08
            const claw = box(0.2, 0.16, 0.2, lightMat)
            claw.position.z = 0.26
            pivot.add(arm, claw)
            this.arms.push(pivot)
            this.body.add(pivot)
          }
        }
        this.headPivot.position.y = 0.5
        this.body.add(this.headPivot)
        height = 0.75
        break
      }

      case 'flyer': {
        // hovering bobber with flappy wings
        this.bodyLiftInit = 1.05
        const head = faced(0.52, baseMat)
        head.position.y = 0
        this.headPivot.add(head)
        this.body.add(this.headPivot)
        if (sp.id === 'bat') {
          for (const side of [-1, 1] as const) {
            const ear = box(0.12, 0.18, 0.06, darkMat)
            ear.position.set(side * 0.15, 0.34, 0)
            this.headPivot.add(ear)
          }
          const feet = box(0.3, 0.1, 0.2, darkMat)
          feet.position.y = -0.32
          this.body.add(feet)
        }
        for (const side of [-1, 1] as const) {
          const pivot = new THREE.Group()
          pivot.position.set(side * 0.28, 0.05, 0)
          if (sp.id === 'wisp') {
            // ghostly drifting side-flames instead of wings
            const flame = box(0.16, 0.26, 0.16, m(light, (sp.color & 0xfefefe) >> 1))
            flame.position.x = side * 0.14
            pivot.add(flame)
          } else {
            const wing = box(0.5, 0.06, 0.26, darkMat)
            wing.position.x = side * 0.28
            pivot.add(wing)
          }
          this.wings.push(pivot)
          this.body.add(pivot)
        }
        if (sp.id === 'wisp') {
          // inner glow + a trailing tail-flame
          const bodyMats = this.mats
          const glowIdx = bodyMats.indexOf(baseMat)
          if (glowIdx >= 0) {
            const e = new THREE.Color(sp.color).multiplyScalar(0.55).getHex()
            baseMat.emissive.setHex(e)
            this.baseEmissive[glowIdx] = e
          }
          const tail = box(0.2, 0.2, 0.2, lightMat)
          tail.position.set(0, -0.18, -0.3)
          this.tail = tail
          this.body.add(tail)
        }
        height = 0.6 // + hover lift, added below for flyers
        break
      }
    }

    // --- boss flair: scale + crown ----------------------------------------
    if (boss) {
      this.group.scale.setScalar(BOSS_SCALE)
      const crown = new THREE.Group()
      const gold = m(0xf2c43d)
      const band = new THREE.Mesh(geo(0.4, 0.09, 0.4), gold)
      band.castShadow = true
      crown.add(band)
      for (const [px, pz] of [
        [-0.14, -0.14],
        [0.14, -0.14],
        [-0.14, 0.14],
        [0.14, 0.14],
        [0, 0],
      ] as const) {
        const spike = new THREE.Mesh(geo(0.08, 0.14, 0.08), gold)
        spike.castShadow = true
        spike.position.set(px, 0.1, pz)
        crown.add(spike)
      }
      // sit the crown on top of whatever head this species has
      crown.position.y =
        sp.shape === 'blob' ? height + 0.05 : sp.shape === 'flyer' ? 0.34 : height - 0.08
      if (sp.shape === 'flyer' || sp.shape === 'quadruped' || sp.shape === 'biped') {
        this.headPivot.add(crown)
        if (sp.shape === 'quadruped') crown.position.set(0, 0.42, 0.12)
        if (sp.shape === 'biped') crown.position.y = height - this.headPivot.position.y + 0.02
      } else {
        this.body.add(crown)
      }
      this.crown = crown
    }

    this.bodyLift = this.bodyLiftInit
    this.body.position.y = this.bodyLift
    this.height = (height + (this.flying ? this.bodyLift : 0)) * (boss ? BOSS_SCALE : 1)
  }

  /** Set before body placement for flyers (hover baseline). */
  private bodyLiftInit = 0

  // -------------------------------------------------------------------------
  // Tiny weapons for the bipeds
  // -------------------------------------------------------------------------

  private buildTinyWeapon(
    species: string,
    box: (w: number, h: number, d: number, mat: THREE.Material) => THREE.Mesh,
    m: (c: THREE.Color | number, emissive?: number) => THREE.MeshLambertMaterial
  ): THREE.Group | null {
    const grp = new THREE.Group()
    const wood = m(0x5a3a22)
    switch (species) {
      case 'goblin': {
        // rusty little shiv
        const grip = box(0.05, 0.1, 0.05, wood)
        const blade = box(0.05, 0.22, 0.03, m(0x9aa2ad))
        blade.position.y = 0.16
        grp.add(grip, blade)
        return grp
      }
      case 'bandit': {
        // club with a nail. The nail is load-bearing.
        const handle = box(0.06, 0.3, 0.06, wood)
        const head = box(0.14, 0.16, 0.14, m(0x6e4a2e))
        head.position.y = 0.22
        const nail = box(0.03, 0.1, 0.03, m(0xaab2bd))
        nail.position.set(0.07, 0.26, 0)
        nail.rotation.z = 0.9
        grp.add(handle, head, nail)
        return grp
      }
      case 'skeleton': {
        // rusted sword, held with zero joint pain
        const grip = box(0.05, 0.12, 0.05, wood)
        const guard = box(0.16, 0.04, 0.05, m(0x7c6a4a))
        guard.position.y = 0.08
        const blade = box(0.06, 0.34, 0.03, m(0x8d9087))
        blade.position.y = 0.28
        grp.add(grip, guard, blade)
        return grp
      }
      case 'imp': {
        // smoldering torch
        const stick = box(0.05, 0.26, 0.05, wood)
        const ember = box(0.1, 0.1, 0.1, m(0xff7a2b, 0x993311))
        ember.position.y = 0.2
        grp.add(stick, ember)
        return grp
      }
      case 'orc': {
        // oversized cleaver-axe, of course
        const handle = box(0.06, 0.4, 0.06, wood)
        const head = box(0.2, 0.18, 0.05, m(0x9aa2ad))
        head.position.set(0.1, 0.3, 0)
        grp.add(handle, head)
        return grp
      }
      default:
        return null // golems punch
    }
  }

  // -------------------------------------------------------------------------
  // Combat animation API
  // -------------------------------------------------------------------------

  /** Attack telegraph 0..1 while winding up; -1 clears (aborted swing). */
  setWindup(p: number): void {
    if (p < 0 && this.windupP >= 0 && this.hurtT < 0) this.restoreEmissive()
    this.windupP = p
  }

  /** The strike itself: quick forward lunge snap. */
  strikeLunge(): void {
    this.lungeT = 0
    this.windupP = -1
  }

  /** Brief red flash on every material. */
  flashHurt(): void {
    this.hurtT = 0
    for (const mat of this.mats) mat.emissive.setHex(0x8a1f1f)
  }

  /** Comedic squash-topple (~0.55s); `onDone` fires when it's pancake. */
  die(onDone?: () => void): void {
    if (this.mode !== 'alive') return
    this.mode = 'dying'
    this.dieT = 0
    this.dieCb = onDone ?? null
    this.windupP = -1
  }

  get alive(): boolean {
    return this.mode === 'alive'
  }

  private restoreEmissive(): void {
    for (let i = 0; i < this.mats.length; i++) {
      this.mats[i]!.emissive.setHex(this.baseEmissive[i] ?? 0)
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame animation
  // -------------------------------------------------------------------------

  update(dt: number, moving: boolean, speed01: number): void {
    this.t += dt

    // hurt flash fade
    if (this.hurtT >= 0) {
      this.hurtT += dt
      if (this.hurtT > 0.13) {
        this.hurtT = -1
        this.restoreEmissive()
      }
    }

    // death: squash flat with a sad little hop
    if (this.mode !== 'alive') {
      if (this.mode === 'dying') {
        this.dieT += dt
        const k = Math.min(1, this.dieT / 0.55)
        const e = 1 - (1 - k) ** 3
        this.body.rotation.z = e * (Math.PI / 2) * 0.9
        this.body.position.y = this.bodyLift * (1 - e) + Math.sin(k * Math.PI) * 0.12
        this.body.scale.y = 1 - e * 0.45
        if (k >= 1) {
          this.mode = 'dead'
          const cb = this.dieCb
          this.dieCb = null
          cb?.()
        }
      }
      return
    }

    const damp = 1 - Math.exp(-dt * 10)
    const energy = 0.4 + 0.6 * Math.min(1, Math.max(0, speed01))

    switch (this.shape) {
      case 'blob': {
        if (moving) {
          // hop-squash locomotion
          this.phase += dt * 9 * energy
          const hop = Math.abs(Math.sin(this.phase))
          this.body.position.y = this.bodyLift + hop * 0.22 * energy
          this.body.scale.y = 0.92 + hop * 0.16
          this.body.scale.x = 1.06 - hop * 0.1
          this.body.scale.z = 1.06 - hop * 0.1
        } else {
          // idle jiggle
          const j = Math.sin(this.t * 5.2)
          this.body.scale.y += (1 + j * 0.05 - this.body.scale.y) * damp
          this.body.scale.x += (1 - j * 0.035 - this.body.scale.x) * damp
          this.body.scale.z += (1 - j * 0.035 - this.body.scale.z) * damp
          this.body.position.y += (this.bodyLift - this.body.position.y) * damp
        }
        break
      }

      case 'quadruped': {
        if (moving) {
          // diagonal-pair trot
          this.phase += dt * 12 * energy
          const s = Math.sin(this.phase) * 0.7 * energy
          const pairs = [s, -s, -s, s]
          for (let i = 0; i < this.legs.length; i++) {
            const leg = this.legs[i]!
            leg.rotation.x += ((pairs[i] ?? 0) - leg.rotation.x) * damp
          }
          this.body.position.y = this.bodyLift + Math.abs(Math.sin(this.phase * 2)) * 0.035
          this.headPivot.rotation.x = Math.sin(this.phase) * 0.06
        } else {
          for (const leg of this.legs) leg.rotation.x *= 1 - damp
          this.body.position.y += (this.bodyLift - this.body.position.y) * damp
          // idle sniffing
          this.headPivot.rotation.x = Math.sin(this.t * 1.8) * 0.08
          this.headPivot.rotation.y = Math.sin(this.t * 0.7) * 0.15
        }
        if (this.tail) this.tail.rotation.y = Math.sin(this.t * 6) * 0.4
        break
      }

      case 'biped': {
        if (moving) {
          // the waddle: choppier than the hero, twice the attitude
          this.phase += dt * 12 * energy
          const s = Math.sin(this.phase) * 0.8 * energy
          this.legs[0]!.rotation.x += (-s - this.legs[0]!.rotation.x) * damp
          this.legs[1]!.rotation.x += (s - this.legs[1]!.rotation.x) * damp
          if (this.arms.length === 2) {
            this.arms[0]!.rotation.x += (s * 0.8 - this.arms[0]!.rotation.x) * damp
            this.arms[1]!.rotation.x += (-s * 0.8 - this.arms[1]!.rotation.x) * damp
          }
          this.body.rotation.z = Math.sin(this.phase) * 0.07
          this.body.position.y = this.bodyLift + Math.abs(Math.sin(this.phase)) * 0.05 * energy
        } else {
          for (const leg of this.legs) leg.rotation.x *= 1 - damp
          for (const arm of this.arms) arm.rotation.x *= 1 - damp
          this.body.rotation.z *= 1 - damp
          this.body.position.y += (this.bodyLift - this.body.position.y) * damp
          // idle breathe + shifty looks
          const b = Math.sin(this.t * 2.3)
          this.headPivot.rotation.y = Math.sin(this.t * 0.8) * 0.12
          this.body.scale.y = 1 + b * 0.012
        }
        break
      }

      case 'crawler': {
        if (moving) {
          // frantic scuttle
          this.phase += dt * 20 * energy
          for (let i = 0; i < this.legs.length; i++) {
            const leg = this.legs[i]!
            leg.rotation.z = Math.sin(this.phase + i * 1.7) * 0.35 * energy
          }
          this.body.position.y = this.bodyLift + Math.abs(Math.sin(this.phase * 0.5)) * 0.02
        } else {
          for (const leg of this.legs) leg.rotation.z *= 1 - damp
          this.body.position.y += (this.bodyLift - this.body.position.y) * damp
        }
        // claws snip at random intervals
        for (let i = 0; i < this.arms.length; i++) {
          this.arms[i]!.rotation.y = Math.sin(this.t * 5 + i * 2.1) * 0.2
        }
        break
      }

      case 'flyer': {
        // always flapping, always bobbing
        this.phase += dt * (moving ? 16 : 11)
        const flap = Math.sin(this.phase) * 0.6
        if (this.wings[0]) this.wings[0].rotation.z = -flap
        if (this.wings[1]) this.wings[1].rotation.z = flap
        this.body.position.y = this.bodyLift + Math.sin(this.t * 2.6) * 0.12
        this.body.rotation.z = Math.sin(this.t * 1.4) * 0.06
        if (this.tail) this.tail.position.z = -0.3 - Math.sin(this.t * 3.1) * 0.06
        break
      }
    }

    // --- attack telegraph: lean back + mean red pulse (boss: bigger drama) --
    if (this.windupP >= 0) {
      const p = this.windupP
      if (this.shape === 'blob') {
        this.body.scale.y = 1 + p * 0.3
        this.body.scale.x = 1 - p * 0.12
        this.body.scale.z = 1 - p * 0.12
      } else {
        this.body.rotation.x = -0.4 * p * (this.boss ? 1.3 : 1)
      }
      if (this.boss && this.crown) {
        this.crown.rotation.y += dt * 10 * p // the crown spins up. Rude.
      }
      // emissive blink in the last third — the "move NOW" tell
      if (this.hurtT < 0) {
        const blink = p > 0.55 && Math.sin(this.t * 26) > 0
        for (let i = 0; i < this.mats.length; i++) {
          this.mats[i]!.emissive.setHex(blink ? 0x6e1414 : (this.baseEmissive[i] ?? 0))
        }
      }
    } else if (this.lungeT < 0 && this.hurtT < 0 && this.shape !== 'blob') {
      this.body.rotation.x *= 1 - damp
    }

    // --- strike lunge snap --------------------------------------------------
    if (this.lungeT >= 0) {
      this.lungeT += dt
      const k = Math.min(1, this.lungeT / 0.22)
      this.body.rotation.x = 0.5 * Math.sin(k * Math.PI) * (this.shape === 'blob' ? 0 : 1)
      if (this.shape === 'blob') {
        this.body.scale.z = 1 + Math.sin(k * Math.PI) * 0.3
      }
      if (k >= 1) {
        this.lungeT = -1
        if (this.hurtT < 0) this.restoreEmissive()
      }
    }
  }

  dispose(): void {
    for (const mat of this.mats) mat.dispose() // textures are shared, kept
    this.mats.length = 0
  }
}
