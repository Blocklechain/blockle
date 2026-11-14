/**
 * Blocklings — voxel character builder + animation rig.
 *
 * Shared by the local player (src/player) and remote players (src/net):
 * a compact, big-headed voxel hero built from boxes, with a retro 8x8
 * pixel-art face painted onto a CanvasTexture (NearestFilter so every
 * pixel stays crunchy), a voxel hair cap, colorful tunic, and a simple
 * sword in the right hand.
 *
 * All sizes are in world units (1 unit = 1 voxel block). The rig's
 * group origin is at the character's FEET, facing +Z at rotation 0 —
 * matching the PlayerState contract (facing 0 = +Z).
 */
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Palette helpers
// ---------------------------------------------------------------------------

/** Deterministic 0..359 hue from a name (djb2). Used for remote tunics. */
export function hueFromName(name: string): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}

const HAIR_COLORS = [0x4a2f1b, 0x1d1a17, 0x8a5a2b, 0xb8863b, 0x6e3a24, 0x3b3f8c]

export interface CharacterOptions {
  /** Tunic hue in degrees (default 210 — a friendly adventurer blue). */
  tunicHue?: number
}

// ---------------------------------------------------------------------------
// Pixel-art face (8x8 CanvasTexture)
// ---------------------------------------------------------------------------

function makeFaceTexture(skinCss: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 8
  const g = c.getContext('2d')
  if (g) {
    // skin base
    g.fillStyle = skinCss
    g.fillRect(0, 0, 8, 8)
    // eyes — 1px dark with a white sparkle above-left
    g.fillStyle = '#ffffff'
    g.fillRect(1, 2, 2, 2)
    g.fillRect(5, 2, 2, 2)
    g.fillStyle = '#20242e'
    g.fillRect(2, 3, 1, 1)
    g.fillRect(5, 3, 1, 1)
    // rosy cheeks
    g.fillStyle = 'rgba(235,120,110,0.65)'
    g.fillRect(0, 5, 1, 1)
    g.fillRect(7, 5, 1, 1)
    // little smile
    g.fillStyle = '#7a4a33'
    g.fillRect(3, 5, 2, 1)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

// ---------------------------------------------------------------------------
// Name label sprite (CanvasTexture)
// ---------------------------------------------------------------------------

/** Floating name label. Re-usable for remote players; renders crisply at 2x. */
export function makeNameSprite(text: string): THREE.Sprite {
  const pad = 14
  const fontPx = 30
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  let w = 160
  const h = fontPx + pad * 2
  if (ctx) {
    ctx.font = `bold ${fontPx}px "Courier New", monospace`
    w = Math.ceil(ctx.measureText(text).width) + pad * 2
  }
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (g) {
    g.font = `bold ${fontPx}px "Courier New", monospace`
    g.fillStyle = 'rgba(10, 14, 22, 0.55)'
    const r = 10
    g.beginPath()
    g.moveTo(r, 0)
    g.arcTo(w, 0, w, h, r)
    g.arcTo(w, h, 0, h, r)
    g.arcTo(0, h, 0, 0, r)
    g.arcTo(0, 0, w, 0, r)
    g.fill()
    g.fillStyle = '#f2f6ff'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, w / 2, h / 2 + 1)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  const H = 0.34
  sprite.scale.set((w / h) * H, H, 1)
  sprite.position.y = 2.05
  return sprite
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material | THREE.Material[]
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.castShadow = true
  return m
}

function lambert(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color })
}

/**
 * A voxel character with idle-breathe + walk animations.
 *
 * Call `update(dt, moving, speed01)` every frame; `speed01` is current
 * speed normalized 0..1 and scales the walk-cycle energy.
 */
export class CharacterRig {
  /** Add this to the scene; position = feet, rotation.y = facing. */
  readonly group: THREE.Group

  private readonly body: THREE.Group
  private readonly headPivot: THREE.Group
  private readonly torso: THREE.Mesh
  private readonly armL: THREE.Group
  private readonly armR: THREE.Group
  private readonly legL: THREE.Group
  private readonly legR: THREE.Group

  private readonly neckY: number
  private t = Math.random() * 10 // desync idle cycles between characters
  private phase = 0

  // --- equipment attach points (anchors scale/orient gear for the rig) ----
  private readonly anchors: Record<string, THREE.Group> = {}
  private readonly bootAnchorR: THREE.Group
  private readonly equipped = new Map<string, THREE.Object3D[]>()
  private readonly defaultSword: THREE.Group
  private readonly defaultBoots: THREE.Mesh[] = []

  // --- combat animation state ---------------------------------------------
  private attackT = -1 // <0 = not attacking; else seconds elapsed
  private strikeFired = false
  private strikeCb: (() => void) | null = null
  private hurtT = -1
  private mode: 'alive' | 'dying' | 'dead' = 'alive'
  private dieT = 0
  private dieCb: (() => void) | null = null

  constructor(opts: CharacterOptions = {}) {
    const hue = opts.tunicHue ?? 210
    const tunic = new THREE.Color().setHSL(hue / 360, 0.62, 0.52)
    const tunicDark = tunic.clone().multiplyScalar(0.75)
    const skin = new THREE.Color(0xf0c49a)
    const skinCss = `#${skin.getHexString()}`
    const hairColor = HAIR_COLORS[Math.abs(Math.round(hue * 7)) % HAIR_COLORS.length] ?? 0x4a2f1b

    this.group = new THREE.Group()
    this.body = new THREE.Group()
    this.group.add(this.body)

    const skinMat = lambert(skin.getHex())
    const tunicMat = lambert(tunic.getHex())
    const tunicDarkMat = lambert(tunicDark.getHex())
    const hairMat = lambert(hairColor)
    const bootMat = lambert(0x5b4330)

    // --- legs (pivot at hip, geometry hangs down) -------------------------
    const hipY = 0.45
    const makeLeg = (x: number): THREE.Group => {
      const pivot = new THREE.Group()
      pivot.position.set(x, hipY, 0)
      const leg = box(0.2, 0.45, 0.24, tunicDarkMat)
      leg.position.y = -0.225
      const boot = box(0.22, 0.12, 0.28, bootMat)
      boot.position.set(0, -0.4, 0.02)
      this.defaultBoots.push(boot)
      pivot.add(leg, boot)
      return pivot
    }
    this.legL = makeLeg(-0.14)
    this.legR = makeLeg(0.14)
    this.body.add(this.legL, this.legR)

    // --- torso ------------------------------------------------------------
    this.torso = box(0.62, 0.52, 0.36, tunicMat)
    this.torso.position.y = hipY + 0.26
    // belt
    const belt = box(0.64, 0.08, 0.38, lambert(0x3a2a18))
    belt.position.y = hipY + 0.04
    this.body.add(this.torso, belt)

    // --- arms (pivot at shoulder) ----------------------------------------
    const shoulderY = hipY + 0.48
    const makeArm = (x: number): THREE.Group => {
      const pivot = new THREE.Group()
      pivot.position.set(x, shoulderY, 0)
      const sleeve = box(0.17, 0.26, 0.21, tunicMat)
      sleeve.position.y = -0.11
      const hand = box(0.16, 0.24, 0.2, skinMat)
      hand.position.y = -0.36
      pivot.add(sleeve, hand)
      return pivot
    }
    this.armL = makeArm(-0.4)
    this.armR = makeArm(0.4)
    this.body.add(this.armL, this.armR)

    // --- right-hand grip anchor + the default sword -----------------------
    // The anchor carries the exact transform the beloved sword always had
    // (resting tilt forward), so equipped weapons rest angled the same way
    // and arc naturally with the arm during attack swings.
    const gripAnchor = new THREE.Group()
    gripAnchor.position.set(0.02, -0.44, 0.08)
    gripAnchor.rotation.x = -0.35 // resting tilt forward
    this.armR.add(gripAnchor)
    this.anchors['weapon'] = gripAnchor

    const sword = new THREE.Group()
    const grip = box(0.06, 0.16, 0.06, lambert(0x5a3a22))
    const guard = box(0.2, 0.05, 0.07, lambert(0xc9a24b))
    guard.position.y = 0.1
    const blade = box(0.07, 0.52, 0.035, lambert(0xd8dde6))
    blade.position.y = 0.38
    const tip = box(0.05, 0.08, 0.035, lambert(0xd8dde6))
    tip.position.y = 0.68
    sword.add(grip, guard, blade, tip)
    gripAnchor.add(sword)
    this.defaultSword = sword

    // --- left-forearm shield anchor (face points outward, -X when facing +Z)
    const shieldAnchor = new THREE.Group()
    shieldAnchor.position.set(-0.13, -0.4, 0.03)
    shieldAnchor.rotation.y = -Math.PI / 2
    shieldAnchor.scale.setScalar(0.8)
    this.armL.add(shieldAnchor)
    this.anchors['shield'] = shieldAnchor

    // --- torso overlay anchor (origin at torso base, just above the belt) -
    const chestAnchor = new THREE.Group()
    chestAnchor.position.set(0, 0.49, 0)
    chestAnchor.scale.setScalar(0.9)
    this.body.add(chestAnchor)
    this.anchors['chest'] = chestAnchor

    // --- boot anchors (one per foot; right side gets a clone) -------------
    const makeBootAnchor = (pivot: THREE.Group): THREE.Group => {
      const a = new THREE.Group()
      a.position.set(0, -0.46, 0.02)
      a.scale.setScalar(0.45)
      pivot.add(a)
      return a
    }
    this.anchors['boots'] = makeBootAnchor(this.legL)
    this.bootAnchorR = makeBootAnchor(this.legR)

    // --- head (pivot at neck) + pixel face + hair cap ---------------------
    this.neckY = hipY + 0.5
    this.headPivot = new THREE.Group()
    this.headPivot.position.y = this.neckY
    const headSize = 0.72
    const faceMat = new THREE.MeshLambertMaterial({ map: makeFaceTexture(skinCss) })
    // box material order: +x, -x, +y, -y, +z, -z — face goes on +z
    const headMats = [skinMat, skinMat, skinMat, skinMat, faceMat, skinMat]
    const head = box(headSize, headSize, headSize, headMats)
    head.position.y = headSize / 2 + 0.02
    // hair: top cap + back panel + little fringe over the forehead
    const cap = box(headSize + 0.06, 0.16, headSize + 0.06, hairMat)
    cap.position.y = headSize + 0.06
    const back = box(headSize + 0.06, 0.34, 0.12, hairMat)
    back.position.set(0, headSize - 0.19, -(headSize / 2 + 0.04))
    const fringe = box(headSize + 0.06, 0.1, 0.1, hairMat)
    fringe.position.set(0, headSize - 0.07, headSize / 2 + 0.03)
    this.headPivot.add(head, cap, back, fringe)
    this.body.add(this.headPivot)

    // --- head-top helm anchor (base sits above the eyes, covers the hair) -
    const helmAnchor = new THREE.Group()
    helmAnchor.position.set(0, 0.62, 0)
    helmAnchor.scale.setScalar(0.85)
    this.headPivot.add(helmAnchor)
    this.anchors['helm'] = helmAnchor
  }

  // -------------------------------------------------------------------------
  // Equipment
  // -------------------------------------------------------------------------

  /**
   * Attach (or clear, with null) an equipment mesh on a slot:
   * 'weapon' | 'shield' | 'helm' | 'chest' | 'boots'. Meshes come from
   * ItemsAPI.buildMesh (origin at grip/base, facing +Z); the anchors
   * scale/orient them to sit right on the little guy. A weapon replaces
   * the default sword; boots hide the default boots and are mirrored
   * onto both feet. Unknown slots are ignored.
   */
  setEquipmentMesh(slot: string, mesh: THREE.Group | null): void {
    const anchor = this.anchors[slot]
    if (!anchor) return

    // clear whatever was equipped there
    const prev = this.equipped.get(slot)
    if (prev) {
      for (const obj of prev) obj.removeFromParent()
      this.equipped.delete(slot)
    }
    if (slot === 'weapon') this.defaultSword.visible = mesh === null
    if (slot === 'boots') {
      for (const b of this.defaultBoots) b.visible = mesh === null
    }
    if (!mesh) return

    const added: THREE.Object3D[] = [mesh]
    anchor.add(mesh)
    if (slot === 'boots') {
      const clone = mesh.clone()
      this.bootAnchorR.add(clone)
      added.push(clone)
    }
    this.equipped.set(slot, added)
  }

  // -------------------------------------------------------------------------
  // Combat animation API (local player; remote rigs simply never call these)
  // -------------------------------------------------------------------------

  /**
   * Play the snappy 250ms arm-swing. `onStrike` fires once at the strike
   * frame (~125ms in, as the weapon whips through the front arc).
   * Ignored while a swing is in flight or while dead.
   */
  startAttack(onStrike?: () => void): boolean {
    if (this.mode !== 'alive' || this.attackT >= 0) return false
    this.attackT = 0
    this.strikeFired = false
    this.strikeCb = onStrike ?? null
    return true
  }

  /** Brief red damage flash (all voxels glow red for ~150ms). */
  flashHurt(): void {
    this.hurtT = 0
    this.setEmissive(0x8a1f1f)
  }

  /** Dramatic backward topple (~0.7s). `onDone` fires when he's down. */
  die(onDone?: () => void): void {
    if (this.mode !== 'alive') return
    this.mode = 'dying'
    this.dieT = 0
    this.dieCb = onDone ?? null
    this.attackT = -1 // cancel any mid-swing
  }

  /** Reset the rig to its feet after a death (respawn). */
  revive(): void {
    this.mode = 'alive'
    this.dieT = 0
    this.dieCb = null
    this.body.rotation.set(0, 0, 0)
    this.body.position.y = 0
    this.armL.rotation.set(0, 0, 0.06)
    this.armR.rotation.set(0, 0, -0.06)
    this.legL.rotation.x = 0
    this.legR.rotation.x = 0
    if (this.hurtT >= 0) {
      this.hurtT = -1
      this.setEmissive(0x000000)
    }
  }

  /** True unless mid-topple or down. */
  get alive(): boolean {
    return this.mode === 'alive'
  }

  private setEmissive(hex: number): void {
    this.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const m of mats) {
        if (m instanceof THREE.MeshLambertMaterial) m.emissive.setHex(hex)
      }
    })
  }

  private updateHurt(dt: number): void {
    if (this.hurtT < 0) return
    this.hurtT += dt
    if (this.hurtT > 0.15) {
      this.hurtT = -1
      this.setEmissive(0x000000)
    }
  }

  private updateAttack(dt: number): void {
    if (this.attackT < 0) return
    this.attackT += dt
    const p = Math.min(1, this.attackT / 0.25)
    let rx: number
    let twist: number
    if (p < 0.32) {
      // wind-up: arm whips up and back, shoulders coil
      const e = 1 - (1 - p / 0.32) ** 2
      rx = -2.0 * e
      twist = -0.18 * e
    } else if (p < 0.62) {
      // the slash: fast ease-in whip down through the front arc
      const k = (p - 0.32) / 0.3
      const e = k * k
      rx = -2.0 + 2.9 * e
      twist = -0.18 + 0.38 * e
    } else {
      // recover back to rest
      const e = 1 - (1 - (p - 0.62) / 0.38) ** 2
      rx = 0.9 * (1 - e)
      twist = 0.2 * (1 - e)
    }
    this.armR.rotation.x = rx
    this.armR.rotation.z = -0.15
    this.body.rotation.y = twist
    if (!this.strikeFired && p >= 0.5) {
      this.strikeFired = true
      this.strikeCb?.()
    }
    if (p >= 1) {
      this.attackT = -1
      this.body.rotation.y = 0
      this.armR.rotation.z = -0.06
    }
  }

  private updateDeath(dt: number): void {
    if (this.mode !== 'dying') return
    this.dieT += dt
    const k = Math.min(1, this.dieT / 0.7)
    const e = 1 - (1 - k) ** 3 // ease-out topple
    this.body.rotation.x = (-Math.PI / 2) * e
    this.body.rotation.z = Math.sin(k * Math.PI) * 0.18 // comedic lean
    this.armL.rotation.x = -2.4 * e // arms flail up on the way down
    this.armR.rotation.x = -2.4 * e
    this.body.position.y = Math.sin(Math.min(1, k * 1.15) * Math.PI) * 0.08 // little hop
    if (k >= 1) {
      this.mode = 'dead'
      this.body.position.y = 0
      const cb = this.dieCb
      this.dieCb = null
      cb?.()
    }
  }

  /** Advance animations. `speed01` = current speed / max speed (0..1). */
  update(dt: number, moving: boolean, speed01: number): void {
    this.t += dt
    if (this.mode !== 'alive') {
      // toppled (or toppling): hold the death pose, keep the flash ticking
      this.updateDeath(dt)
      this.updateHurt(dt)
      return
    }
    const damp = 1 - Math.exp(-dt * 10)

    if (moving) {
      const energy = 0.35 + 0.65 * Math.min(1, Math.max(0, speed01))
      this.phase += dt * 11 * energy
      const s = Math.sin(this.phase) * 0.75 * energy
      this.armL.rotation.x += (s - this.armL.rotation.x) * damp
      this.armR.rotation.x += (-s - this.armR.rotation.x) * damp
      this.legL.rotation.x += (-s * 0.85 - this.legL.rotation.x) * damp
      this.legR.rotation.x += (s * 0.85 - this.legR.rotation.x) * damp
      // bouncy step
      this.body.position.y = Math.abs(Math.sin(this.phase)) * 0.055 * energy
      // settle idle-only transforms
      this.torso.scale.y += (1 - this.torso.scale.y) * damp
      this.headPivot.position.y += (this.neckY - this.headPivot.position.y) * damp
      this.armL.rotation.z += (0.06 - this.armL.rotation.z) * damp
      this.armR.rotation.z += (-0.06 - this.armR.rotation.z) * damp
    } else {
      // ease limbs back to rest
      this.armL.rotation.x *= 1 - damp
      this.armR.rotation.x *= 1 - damp
      this.legL.rotation.x *= 1 - damp
      this.legR.rotation.x *= 1 - damp
      this.body.position.y *= 1 - damp
      // idle breathe: subtle torso swell + head bob + arm sway
      const b = Math.sin(this.t * 2.1)
      this.torso.scale.y = 1 + b * 0.016
      this.headPivot.position.y = this.neckY + b * 0.012
      this.armL.rotation.z = 0.06 + b * 0.025
      this.armR.rotation.z = -0.06 - b * 0.025
      this.headPivot.rotation.y = Math.sin(this.t * 0.6) * 0.07 // looks around a bit
    }

    // layered on top: the attack swing stomps the right arm, hurt flash fades
    this.updateAttack(dt)
    this.updateHurt(dt)
  }

  /** Free GPU resources (geometries, materials, textures). */
  dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of mats) {
          if (m instanceof THREE.MeshLambertMaterial && m.map) m.map.dispose()
          m.dispose()
        }
      }
      if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose()
        obj.material.dispose()
      }
    })
  }
}
