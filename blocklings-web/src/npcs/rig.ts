/**
 * NPCs — voxel rig, built in the SAME beloved vocabulary as the player hero:
 * flat-color Lambert boxes, big head with a crunchy 8x8 pixel face
 * (NearestFilter CanvasTexture), voxel hair cap, idle-breathe + bouncy walk.
 * Role flavor is layered on top as a few extra boxes: robes, aprons, helmets,
 * headbands, straw hats, beards, and a held staff/spear.
 *
 * (Deliberately self-contained — modules never import each other, so the tiny
 * box/face/name-sprite helpers are re-stated here rather than imported from
 * the player module.)
 *
 * Group origin at the FEET, facing +Z at rotation 0 (same as PlayerState).
 */
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

export interface NpcLook {
  /** Tunic hue in degrees. */
  tunicHue: number
  /** Index into the shared hair palette. */
  hairIdx: number
  beard?: boolean
  robe?: boolean
  apron?: boolean
  helmet?: boolean
  headband?: boolean
  hat?: boolean
  held?: 'staff' | 'spear'
}

const HAIR_COLORS = [0x4a2f1b, 0x1d1a17, 0x8a5a2b, 0xb8863b, 0x6e3a24, 0x3b3f8c] as const
const STEEL = 0x9aa2ad
const STRAW = 0xc9a85a
const APRON = 0xd9d2c0
const BEARD = 0xd8d4c8
const SKIN = 0xf0c49a

function lambert(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color })
}

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

// ---------------------------------------------------------------------------
// Pixel-art face (8x8, crunchy)
// ---------------------------------------------------------------------------

function makeFaceTexture(skinCss: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 8
  c.height = 8
  const g = c.getContext('2d')
  if (g) {
    g.fillStyle = skinCss
    g.fillRect(0, 0, 8, 8)
    g.fillStyle = '#ffffff'
    g.fillRect(1, 2, 2, 2)
    g.fillRect(5, 2, 2, 2)
    g.fillStyle = '#20242e'
    g.fillRect(2, 3, 1, 1)
    g.fillRect(5, 3, 1, 1)
    g.fillStyle = 'rgba(235,120,110,0.65)'
    g.fillRect(0, 5, 1, 1)
    g.fillRect(7, 5, 1, 1)
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
// Dialog portrait (12x12 pixel bust — scale up with image-rendering:pixelated)
// ---------------------------------------------------------------------------

export function makePortrait(look: NpcLook): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 12
  c.height = 12
  const g = c.getContext('2d')
  if (!g) return c
  const tunic = new THREE.Color().setHSL(((look.tunicHue % 360) + 360) % 360 / 360, 0.62, 0.52)
  const hairHex = look.helmet ? STEEL : (HAIR_COLORS[look.hairIdx % HAIR_COLORS.length] ?? 0x4a2f1b)
  const hex = (n: number) => `#${new THREE.Color(n).getHexString()}`
  // face
  g.fillStyle = hex(SKIN)
  g.fillRect(1, 2, 10, 8)
  // hair / helmet cap
  g.fillStyle = hex(hairHex)
  g.fillRect(0, 0, 12, 3)
  if (look.hat) {
    g.fillStyle = hex(STRAW)
    g.fillRect(0, 2, 12, 1)
    g.fillRect(2, 0, 8, 2)
  }
  // eyes + sparkle
  g.fillStyle = '#ffffff'
  g.fillRect(2, 5, 3, 2)
  g.fillRect(7, 5, 3, 2)
  g.fillStyle = '#20242e'
  g.fillRect(3, 6, 1, 1)
  g.fillRect(8, 6, 1, 1)
  // cheeks + smile
  g.fillStyle = 'rgba(235,120,110,0.65)'
  g.fillRect(1, 7, 1, 1)
  g.fillRect(10, 7, 1, 1)
  g.fillStyle = '#7a4a33'
  g.fillRect(5, 8, 2, 1)
  if (look.beard) {
    g.fillStyle = hex(BEARD)
    g.fillRect(2, 9, 8, 2)
  }
  // shoulders
  g.fillStyle = `#${tunic.getHexString()}`
  g.fillRect(0, 10, 12, 2)
  if (look.apron) {
    g.fillStyle = hex(APRON)
    g.fillRect(3, 11, 6, 1)
  }
  return c
}

// ---------------------------------------------------------------------------
// Floating name label
// ---------------------------------------------------------------------------

function makeNameSprite(text: string): THREE.Sprite {
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
    g.fillStyle = '#ffe9a6' // warm gold — reads "friendly NPC" vs player white
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, w / 2, h / 2 + 1)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  const H = 0.32
  sprite.scale.set((w / h) * H, H, 1)
  sprite.position.y = 2.16
  return sprite
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

export class NpcRig {
  /** Add to the scene; position = feet, rotation.y = facing (+Z at 0). */
  readonly group: THREE.Group

  /** Invisible pick box for click/tap raycasts (material.visible = false). */
  readonly hit: THREE.Mesh

  private readonly body: THREE.Group
  private readonly headPivot: THREE.Group
  private readonly torso: THREE.Mesh
  private readonly armL: THREE.Group
  private readonly armR: THREE.Group
  private readonly legL: THREE.Group
  private readonly legR: THREE.Group
  private readonly neckY: number

  private t = Math.random() * 10 // desync idle cycles between NPCs
  private phase = 0

  constructor(name: string, look: NpcLook) {
    const hue = ((look.tunicHue % 360) + 360) % 360
    const tunic = new THREE.Color().setHSL(hue / 360, 0.62, 0.52)
    const tunicDark = tunic.clone().multiplyScalar(0.75)
    const skinCss = `#${new THREE.Color(SKIN).getHexString()}`
    const hairColor = HAIR_COLORS[look.hairIdx % HAIR_COLORS.length] ?? 0x4a2f1b

    this.group = new THREE.Group()
    this.body = new THREE.Group()
    this.group.add(this.body)

    const skinMat = lambert(SKIN)
    const tunicMat = lambert(tunic.getHex())
    const tunicDarkMat = lambert(tunicDark.getHex())
    const hairMat = lambert(hairColor)
    const bootMat = lambert(0x5b4330)

    // --- legs (pivot at hip) ----------------------------------------------
    const hipY = 0.45
    const makeLeg = (x: number): THREE.Group => {
      const pivot = new THREE.Group()
      pivot.position.set(x, hipY, 0)
      const leg = box(0.2, 0.45, 0.24, tunicDarkMat)
      leg.position.y = -0.225
      const boot = box(0.22, 0.12, 0.28, bootMat)
      boot.position.set(0, -0.4, 0.02)
      pivot.add(leg, boot)
      return pivot
    }
    this.legL = makeLeg(-0.14)
    this.legR = makeLeg(0.14)
    this.body.add(this.legL, this.legR)

    // --- torso + belt ------------------------------------------------------
    this.torso = box(0.62, 0.52, 0.36, tunicMat)
    this.torso.position.y = hipY + 0.26
    const belt = box(0.64, 0.08, 0.38, lambert(0x3a2a18))
    belt.position.y = hipY + 0.04
    this.body.add(this.torso, belt)

    // robe: a skirt that drapes over the upper legs
    if (look.robe) {
      const skirt = box(0.6, 0.36, 0.4, tunicDarkMat)
      skirt.position.y = hipY - 0.16
      this.body.add(skirt)
    }

    // apron: sturdy work panel over the front
    if (look.apron) {
      const panel = box(0.5, 0.4, 0.05, lambert(APRON))
      panel.position.set(0, hipY + 0.2, 0.2)
      this.body.add(panel)
    }

    // --- arms (pivot at shoulder) -----------------------------------------
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
    this.armL.rotation.z = 0.06
    this.armR.rotation.z = -0.06
    this.body.add(this.armL, this.armR)

    // held prop: staff (knobbed walking stick) or spear (guard duty)
    if (look.held) {
      const grip = new THREE.Group()
      grip.position.set(0.02, -0.44, 0.08)
      grip.rotation.x = -0.12
      const shaft = box(0.055, 1.35, 0.055, lambert(0x6b4a2c))
      shaft.position.y = 0.3
      grip.add(shaft)
      if (look.held === 'staff') {
        const knob = box(0.14, 0.14, 0.14, lambert(0x8fd4e8))
        knob.position.y = 1.02
        grip.add(knob)
      } else {
        const tip = box(0.08, 0.2, 0.045, lambert(STEEL))
        tip.position.y = 1.05
        grip.add(tip)
      }
      this.armR.add(grip)
    }

    // --- head (pivot at neck) + pixel face + hair cap ----------------------
    this.neckY = hipY + 0.5
    this.headPivot = new THREE.Group()
    this.headPivot.position.y = this.neckY
    const headSize = 0.72
    const faceMat = new THREE.MeshLambertMaterial({ map: makeFaceTexture(skinCss) })
    // box material order: +x, -x, +y, -y, +z, -z — face goes on +z
    const headMats = [skinMat, skinMat, skinMat, skinMat, faceMat, skinMat]
    const head = box(headSize, headSize, headSize, headMats)
    head.position.y = headSize / 2 + 0.02
    const cap = box(headSize + 0.06, 0.16, headSize + 0.06, hairMat)
    cap.position.y = headSize + 0.06
    const back = box(headSize + 0.06, 0.34, 0.12, hairMat)
    back.position.set(0, headSize - 0.19, -(headSize / 2 + 0.04))
    const fringe = box(headSize + 0.06, 0.1, 0.1, hairMat)
    fringe.position.set(0, headSize - 0.07, headSize / 2 + 0.03)
    this.headPivot.add(head, cap, back, fringe)

    if (look.beard) {
      const beard = box(0.52, 0.2, 0.1, lambert(BEARD))
      beard.position.set(0, 0.16, headSize / 2 + 0.03)
      this.headPivot.add(beard)
    }
    if (look.headband) {
      const accent = new THREE.Color().setHSL(((hue + 180) % 360) / 360, 0.55, 0.45)
      const band = box(headSize + 0.08, 0.09, headSize + 0.08, lambert(accent.getHex()))
      band.position.y = headSize - 0.12
      this.headPivot.add(band)
    }
    if (look.helmet) {
      const steelMat = lambert(STEEL)
      const dome = box(headSize + 0.1, 0.2, headSize + 0.1, steelMat)
      dome.position.y = headSize + 0.08
      const brim = box(headSize + 0.16, 0.08, headSize + 0.16, steelMat)
      brim.position.y = headSize - 0.04
      const nose = box(0.1, 0.22, 0.05, steelMat)
      nose.position.set(0, headSize - 0.22, headSize / 2 + 0.05)
      this.headPivot.add(dome, brim, nose)
    }
    if (look.hat) {
      const strawMat = lambert(STRAW)
      const brim = box(headSize + 0.34, 0.06, headSize + 0.34, strawMat)
      brim.position.y = headSize + 0.12
      const crown = box(0.5, 0.24, 0.5, strawMat)
      crown.position.y = headSize + 0.26
      this.headPivot.add(brim, crown)
    }
    this.body.add(this.headPivot)

    // --- name label + invisible pick box -----------------------------------
    this.group.add(makeNameSprite(name))

    this.hit = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 2.1, 1.15),
      new THREE.MeshBasicMaterial({ visible: false })
    )
    this.hit.position.y = 1.05
    this.group.add(this.hit)
  }

  /** Advance animations. `speed01` = current speed / max speed (0..1). */
  update(dt: number, moving: boolean, speed01: number): void {
    this.t += dt
    const damp = 1 - Math.exp(-dt * 10)

    if (moving) {
      const energy = 0.35 + 0.65 * Math.min(1, Math.max(0, speed01))
      this.phase += dt * 11 * energy
      const s = Math.sin(this.phase) * 0.75 * energy
      this.armL.rotation.x += (s - this.armL.rotation.x) * damp
      this.armR.rotation.x += (-s - this.armR.rotation.x) * damp
      this.legL.rotation.x += (-s * 0.85 - this.legL.rotation.x) * damp
      this.legR.rotation.x += (s * 0.85 - this.legR.rotation.x) * damp
      this.body.position.y = Math.abs(Math.sin(this.phase)) * 0.055 * energy
      this.torso.scale.y += (1 - this.torso.scale.y) * damp
      this.headPivot.position.y += (this.neckY - this.headPivot.position.y) * damp
      this.armL.rotation.z += (0.06 - this.armL.rotation.z) * damp
      this.armR.rotation.z += (-0.06 - this.armR.rotation.z) * damp
    } else {
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
      this.headPivot.rotation.y = Math.sin(this.t * 0.6) * 0.07
    }
  }

  /** Free GPU resources. */
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
