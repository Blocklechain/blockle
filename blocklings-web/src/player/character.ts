/**
 * Blocklings — voxel character builder + animation rig.
 *
 * Shared by the local player (src/player), remote players (src/net) and the
 * character creator (src/creator): a compact, big-headed voxel hero built
 * from boxes, with a retro 8x8 pixel-art face painted onto a CanvasTexture
 * (NearestFilter so every pixel stays crunchy), a voxel hair cap, colorful
 * tunic, and a simple sword in the right hand.
 *
 * The whole body is parameterized by a CharacterLook (src/player/look.ts):
 * two body frames (broad/slender — same big head, same animation rig, same
 * equipment attach points), 8 hair styles, facial hair, curated color
 * palettes and an optional swaying cape. buildCharacterMesh(DEFAULT_LOOK)
 * produces exactly the beloved original hero, box for box.
 *
 * All sizes are in world units (1 unit = 1 voxel block). The rig's
 * group origin is at the character's FEET, facing +Z at rotation 0 —
 * matching the PlayerState contract (facing 0 = +Z).
 */
import * as THREE from 'three'
import {
  DEFAULT_LOOK,
  SKIN_TONES,
  HAIR_COLORS,
  TUNIC_COLORS,
  PANTS_COLORS,
  EYE_COLORS,
  CAPES,
  pick,
  type CharacterLook
} from './look'

// ---------------------------------------------------------------------------
// Palette helpers
// ---------------------------------------------------------------------------

/** Deterministic 0..359 hue from a name (djb2). Legacy remote-tunic hash. */
export function hueFromName(name: string): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0
  return ((h % 360) + 360) % 360
}

/** How the right hand holds the equipped weapon (ItemDef.gripStyle). */
export type GripStyle = 'upright' | 'forward' | 'bow' | 'shield'

/**
 * Weapon-anchor rest rotation per grip style (radians, applied to the
 * right-hand grip anchor). The weapon mesh itself is always built blade-up
 * (+Y) facing +Z, so:
 *   null      — legacy sword rest: blade up, slight tilt (the classic look)
 *   upright   — staff/torch: near-vertical in the fist
 *   forward   — sword/axe/pick/hatchet: blade 90° out from the fist, ahead
 *   bow       — two-point side grip: limbs vertical, face turned outward
 *   shield    — strapped flat to the forearm
 */
const GRIP_POSE: Record<GripStyle, readonly [number, number, number]> = {
  upright: [-0.18, 0, 0],
  forward: [1.3, 0, 0],
  bow: [-0.12, -0.55, 0.22],
  shield: [0, -Math.PI / 2, 0],
}
const GRIP_DEFAULT: readonly [number, number, number] = [-0.35, 0, 0]

/** Named special-attack animations (combat picks one per ability). */
export type SpecialAnim = 'spin' | 'lunge' | 'cast' | 'volley' | 'bash'

/** [duration seconds, strike point 0..1] per special animation. */
const SPECIAL_TIMING: Record<SpecialAnim, readonly [number, number]> = {
  spin: [0.5, 0.45],
  lunge: [0.4, 0.3],
  cast: [0.55, 0.5],
  volley: [0.45, 0.5],
  bash: [0.35, 0.4],
}

// ---------------------------------------------------------------------------
// Pixel-art face (8x8 CanvasTexture)
// ---------------------------------------------------------------------------

function makeFaceTexture(skinCss: string, eyeCss: string, smileCss: string): THREE.CanvasTexture {
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
    g.fillStyle = eyeCss
    g.fillRect(2, 3, 1, 1)
    g.fillRect(5, 3, 1, 1)
    // rosy cheeks
    g.fillStyle = 'rgba(235,120,110,0.65)'
    g.fillRect(0, 5, 1, 1)
    g.fillRect(7, 5, 1, 1)
    // little smile
    g.fillStyle = smileCss
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
// Box helpers
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

function lambert(color: number | THREE.Color): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color })
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
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

// ---------------------------------------------------------------------------
// The parameterized body builder
// ---------------------------------------------------------------------------

/** Everything the rig animates/attaches to, freshly built from a look. */
interface BodyParts {
  body: THREE.Group
  headPivot: THREE.Group
  torso: THREE.Mesh
  armL: THREE.Group
  armR: THREE.Group
  legL: THREE.Group
  legR: THREE.Group
  /** Swaying cape pivot (null when look.cape === 0). */
  capePivot: THREE.Group | null
  anchors: Record<string, THREE.Group>
  bootAnchorR: THREE.Group
  defaultSword: THREE.Group
  defaultBoots: THREE.Mesh[]
}

/** Shared skeleton constants — identical for BOTH body frames (same rig). */
const HIP_Y = 0.45
const SHOULDER_Y = HIP_Y + 0.48
const NECK_Y = HIP_Y + 0.5
const HEAD_SIZE = 0.72

function buildBodyParts(look: CharacterLook): BodyParts {
  const broad = look.body !== 'slender'

  // Frame widths: slender narrows torso/shoulders a touch; heights, head,
  // pivots and equipment anchors stay identical so the one animation rig
  // (and every attach point) fits both frames.
  const torsoW = broad ? 0.62 : 0.52
  const torsoD = broad ? 0.36 : 0.32
  const shoulderX = broad ? 0.4 : 0.35
  const armW = broad ? 0.17 : 0.15
  const handW = broad ? 0.16 : 0.145
  const hipX = broad ? 0.14 : 0.125
  const legW = broad ? 0.2 : 0.18
  const bootW = broad ? 0.22 : 0.2

  const skin = new THREE.Color(pick(SKIN_TONES, look.skin).hex)
  const skinCss = `#${skin.getHexString()}`
  const darkSkin = look.skin >= 4 // deep tones get a lighter smile pixel
  const tunic = new THREE.Color().setHSL(pick(TUNIC_COLORS, look.tunicColor).hue / 360, 0.62, 0.52)
  const pants = pick(PANTS_COLORS, look.pantsColor).color
  const hairColor = pick(HAIR_COLORS, look.hairColor).hex
  const eyeCss = pick(EYE_COLORS, look.eyes).css
  const capeHex = pick(CAPES, look.cape).hex

  const skinMat = lambert(skin)
  const tunicMat = lambert(tunic)
  const pantsMat = lambert(pants)
  const hairMat = lambert(hairColor)
  const bootMat = lambert(0x5b4330)

  const body = new THREE.Group()
  const anchors: Record<string, THREE.Group> = {}
  const defaultBoots: THREE.Mesh[] = []

  // --- legs (pivot at hip, geometry hangs down) ---------------------------
  const makeLeg = (x: number): THREE.Group => {
    const pivot = new THREE.Group()
    pivot.position.set(x, HIP_Y, 0)
    const leg = box(legW, 0.45, 0.24, pantsMat)
    leg.position.y = -0.225
    const boot = box(bootW, 0.12, 0.28, bootMat)
    boot.position.set(0, -0.4, 0.02)
    defaultBoots.push(boot)
    pivot.add(leg, boot)
    return pivot
  }
  const legL = makeLeg(-hipX)
  const legR = makeLeg(hipX)
  body.add(legL, legR)

  // --- torso --------------------------------------------------------------
  const torso = box(torsoW, 0.52, torsoD, tunicMat)
  torso.position.y = HIP_Y + 0.26
  // belt
  const belt = box(torsoW + 0.02, 0.08, torsoD + 0.02, lambert(0x3a2a18))
  belt.position.y = HIP_Y + 0.04
  body.add(torso, belt)

  // --- arms (pivot at shoulder) -------------------------------------------
  const makeArm = (x: number): THREE.Group => {
    const pivot = new THREE.Group()
    pivot.position.set(x, SHOULDER_Y, 0)
    const sleeve = box(armW, 0.26, 0.21, tunicMat)
    sleeve.position.y = -0.11
    const hand = box(handW, 0.24, 0.2, skinMat)
    hand.position.y = -0.36
    pivot.add(sleeve, hand)
    return pivot
  }
  const armL = makeArm(-shoulderX)
  const armR = makeArm(shoulderX)
  body.add(armL, armR)

  // --- right-hand grip anchor + the default sword -------------------------
  // The anchor carries the exact transform the beloved sword always had
  // (resting tilt forward), so equipped weapons rest angled the same way
  // and arc naturally with the arm during attack swings.
  const gripAnchor = new THREE.Group()
  gripAnchor.position.set(0.02, -0.44, 0.08)
  gripAnchor.rotation.x = -0.35 // resting tilt forward
  armR.add(gripAnchor)
  anchors['weapon'] = gripAnchor

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

  // --- left-forearm shield anchor (face points outward, -X when facing +Z)
  const shieldAnchor = new THREE.Group()
  shieldAnchor.position.set(-0.13, -0.4, 0.03)
  shieldAnchor.rotation.y = -Math.PI / 2
  shieldAnchor.scale.setScalar(0.8)
  armL.add(shieldAnchor)
  anchors['shield'] = shieldAnchor

  // --- torso overlay anchor (origin at torso base, just above the belt) ---
  const chestAnchor = new THREE.Group()
  chestAnchor.position.set(0, 0.49, 0)
  chestAnchor.scale.setScalar(0.9)
  body.add(chestAnchor)
  anchors['chest'] = chestAnchor

  // --- boot anchors (one per foot; right side gets a clone) ---------------
  const makeBootAnchor = (pivot: THREE.Group): THREE.Group => {
    const a = new THREE.Group()
    a.position.set(0, -0.46, 0.02)
    a.scale.setScalar(0.45)
    pivot.add(a)
    return a
  }
  anchors['boots'] = makeBootAnchor(legL)
  const bootAnchorR = makeBootAnchor(legR)

  // --- cape (simple back-plane voxels; the rig sways the pivot) -----------
  let capePivot: THREE.Group | null = null
  if (capeHex !== null) {
    capePivot = new THREE.Group()
    capePivot.position.set(0, HIP_Y + 0.5, -(torsoD / 2 + 0.03))
    const capeMat = lambert(capeHex)
    const panel = box(torsoW - 0.06, 0.78, 0.05, capeMat)
    panel.position.y = -0.39
    panel.castShadow = true
    // little clasp bar across the shoulders
    const clasp = box(torsoW - 0.02, 0.07, 0.07, lambert(0xc9a24b))
    clasp.position.set(0, 0, 0.04)
    capePivot.add(panel, clasp)
    capePivot.rotation.x = 0.08 // rests just off the back
    body.add(capePivot)
  }

  // --- head (pivot at neck) + pixel face + hair + facial hair -------------
  const headPivot = new THREE.Group()
  headPivot.position.y = NECK_Y
  const smileCss = darkSkin ? '#e8c9a8' : '#7a4a33'
  const faceMat = new THREE.MeshLambertMaterial({ map: makeFaceTexture(skinCss, eyeCss, smileCss) })
  // box material order: +x, -x, +y, -y, +z, -z — face goes on +z
  const headMats = [skinMat, skinMat, skinMat, skinMat, faceMat, skinMat]
  const head = box(HEAD_SIZE, HEAD_SIZE, HEAD_SIZE, headMats)
  head.position.y = HEAD_SIZE / 2 + 0.02
  headPivot.add(head)

  addHair(headPivot, look.hairStyle, hairMat)
  addFacialHair(headPivot, look.facialHair, hairMat)
  body.add(headPivot)

  // --- head-top helm anchor (base sits above the eyes, covers the hair) ---
  const helmAnchor = new THREE.Group()
  helmAnchor.position.set(0, 0.62, 0)
  helmAnchor.scale.setScalar(0.85)
  headPivot.add(helmAnchor)
  anchors['helm'] = helmAnchor

  return {
    body,
    headPivot,
    torso,
    armL,
    armR,
    legL,
    legR,
    capePivot,
    anchors,
    bootAnchorR,
    defaultSword: sword,
    defaultBoots
  }
}

/** The 8 voxel hair styles. Style 1 ('The Bob') is the original hero hair. */
function addHair(headPivot: THREE.Group, styleIdx: number, hairMat: THREE.Material): void {
  const hs = HEAD_SIZE
  const style = ((Math.floor(styleIdx) % 8) + 8) % 8
  const add = (...meshes: THREE.Mesh[]): void => {
    for (const m of meshes) headPivot.add(m)
  }
  const cap = (h = 0.16): THREE.Mesh => {
    const c = box(hs + 0.06, h, hs + 0.06, hairMat)
    c.position.y = hs + 0.06
    return c
  }
  const fringe = (): THREE.Mesh => {
    const f = box(hs + 0.06, 0.1, 0.1, hairMat)
    f.position.set(0, hs - 0.07, hs / 2 + 0.03)
    return f
  }
  const backPanel = (h = 0.34): THREE.Mesh => {
    const b = box(hs + 0.06, h, 0.12, hairMat)
    b.position.set(0, hs + 0.14 - 0.06 - h / 2 + 0.01, -(hs / 2 + 0.04))
    return b
  }

  switch (style) {
    case 0: {
      // spiky: thin cap + a crown of chunky spikes
      add(cap(0.12), fringe())
      const spots: Array<[number, number, number]> = [
        [-0.22, 0.2, -0.18],
        [0.05, 0.26, -0.02],
        [0.24, 0.2, 0.14],
        [-0.12, 0.22, 0.18],
        [0.18, 0.22, -0.2]
      ]
      for (const [x, h, z] of spots) {
        const s = box(0.16, h, 0.16, hairMat)
        s.position.set(x, hs + 0.1 + h / 2, z)
        headPivot.add(s)
      }
      break
    }
    case 1: {
      // THE classic bob: cap + back panel + fringe (the original hero, exactly)
      const c = box(hs + 0.06, 0.16, hs + 0.06, hairMat)
      c.position.y = hs + 0.06
      const back = box(hs + 0.06, 0.34, 0.12, hairMat)
      back.position.set(0, hs - 0.19, -(hs / 2 + 0.04))
      add(c, back, fringe())
      break
    }
    case 2: {
      // long & flowing: cap + fringe + shoulder-length back + side curtains
      add(cap(), fringe(), backPanel(0.88))
      for (const side of [-1, 1]) {
        const curtain = box(0.12, 0.62, hs + 0.04, hairMat)
        curtain.position.set(side * (hs / 2 + 0.05), hs - 0.26, -0.02)
        headPivot.add(curtain)
      }
      break
    }
    case 3: {
      // ponytail: cap + fringe + tie + a jaunty tail out the back
      add(cap(), fringe(), backPanel(0.3))
      const tie = box(0.2, 0.1, 0.12, lambert(0xc9a24b))
      tie.position.set(0, hs - 0.02, -(hs / 2 + 0.12))
      const tail = box(0.16, 0.52, 0.16, hairMat)
      tail.position.set(0, hs - 0.32, -(hs / 2 + 0.16))
      add(tie, tail)
      break
    }
    case 4: {
      // mohawk: a proud stepped crest, nothing else — commitment
      const heights: Array<[number, number]> = [
        [0.3, 0.2], // [z, h]
        [0.1, 0.3],
        [-0.1, 0.3],
        [-0.3, 0.22]
      ]
      for (const [z, h] of heights) {
        const crest = box(0.16, h, 0.2, hairMat)
        crest.position.set(0, hs + 0.1 + h / 2, z)
        headPivot.add(crest)
      }
      break
    }
    case 5:
      // gloriously bald: the head speaks for itself
      break
    case 6: {
      // braids: cap + fringe + two side braids with tie knobs
      add(cap(), fringe(), backPanel(0.3))
      for (const side of [-1, 1]) {
        const braid = box(0.14, 0.56, 0.14, hairMat)
        braid.position.set(side * (hs / 2 + 0.04), hs - 0.24, -0.1)
        const knob = box(0.17, 0.1, 0.17, lambert(0xc9a24b))
        knob.position.set(side * (hs / 2 + 0.04), hs - 0.54, -0.1)
        headPivot.add(braid, knob)
      }
      break
    }
    default: {
      // topknot: slim cap + tie + a disciplined bun on top
      add(cap(0.12), fringe())
      const tie = box(0.22, 0.07, 0.22, lambert(0xc9a24b))
      tie.position.y = hs + 0.15
      const bun = box(0.28, 0.2, 0.28, hairMat)
      bun.position.y = hs + 0.28
      add(tie, bun)
      break
    }
  }
}

/** Facial hair, in the wearer's hair color. 0 = baby smooth. */
function addFacialHair(headPivot: THREE.Group, idx: number, hairMat: THREE.Material): void {
  const hs = HEAD_SIZE
  const z = hs / 2 + 0.03
  const which = ((Math.floor(idx) % 5) + 5) % 5
  switch (which) {
    case 1: {
      // stubble: a thin shadow of regret along the jaw
      const stub = box(0.5, 0.1, 0.08, hairMat)
      stub.position.set(0, 0.1, z - 0.01)
      headPivot.add(stub)
      break
    }
    case 2: {
      // full lumberjack: chin curtain + jaw sides
      const beard = box(0.52, 0.2, 0.1, hairMat)
      beard.position.set(0, 0.14, z)
      const chops = box(hs + 0.04, 0.16, 0.1, hairMat)
      chops.position.set(0, 0.12, z - 0.09)
      headPivot.add(beard, chops)
      break
    }
    case 3: {
      // the diplomat: a stately mustache above the smile
      const stache = box(0.36, 0.08, 0.07, hairMat)
      stache.position.set(0, 0.3, z)
      headPivot.add(stache)
      break
    }
    case 4: {
      // suspicious goatee: chin puff + a whisper of mustache
      const goat = box(0.2, 0.16, 0.08, hairMat)
      goat.position.set(0, 0.1, z)
      const whisper = box(0.3, 0.06, 0.06, hairMat)
      whisper.position.set(0, 0.31, z)
      headPivot.add(goat, whisper)
      break
    }
    default:
      break
  }
}

/**
 * Build a standalone character mesh for a look (origin at feet, facing +Z).
 * Static — no animation wiring; for previews, pedestals, and other agents.
 * buildCharacterMesh(DEFAULT_LOOK) is the original hard-coded hero, box for
 * box. For a living, animated character use CharacterRig.
 */
export function buildCharacterMesh(look: CharacterLook = DEFAULT_LOOK): THREE.Group {
  const root = new THREE.Group()
  root.add(buildBodyParts(look).body)
  return root
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

/**
 * A voxel character with idle-breathe + walk animations.
 *
 * Call `update(dt, moving, speed01)` every frame; `speed01` is current
 * speed normalized 0..1 and scales the walk-cycle energy.
 *
 * `applyLook(look)` rebuilds the body IN PLACE: position/facing, the group
 * node (including externally-added children like name labels) and every
 * equipped item mesh all survive the swap.
 */
export class CharacterRig {
  /** Add this to the scene; position = feet, rotation.y = facing. */
  readonly group: THREE.Group

  private body!: THREE.Group
  private headPivot!: THREE.Group
  private torso!: THREE.Mesh
  private armL!: THREE.Group
  private armR!: THREE.Group
  private legL!: THREE.Group
  private legR!: THREE.Group
  private capePivot: THREE.Group | null = null

  private readonly neckY = NECK_Y
  private t = Math.random() * 10 // desync idle cycles between characters
  private phase = 0
  private lookNow: CharacterLook

  // --- equipment attach points (anchors scale/orient gear for the rig) ----
  private anchors: Record<string, THREE.Group> = {}
  private bootAnchorR!: THREE.Group
  private readonly equipped = new Map<string, THREE.Object3D[]>()
  private defaultSword!: THREE.Group
  private defaultBoots: THREE.Mesh[] = []
  private gripStyle: GripStyle | null = null

  // --- combat animation state ---------------------------------------------
  private attackT = -1 // <0 = not attacking; else seconds elapsed
  private strikeFired = false
  private strikeCb: (() => void) | null = null
  private hurtT = -1
  private mode: 'alive' | 'dying' | 'dead' = 'alive'
  private dieT = 0
  private dieCb: (() => void) | null = null

  // --- special-attack animation state --------------------------------------
  private specialT = -1 // <0 = idle; else seconds elapsed
  private specialKind: SpecialAnim = 'spin'
  private specialStrikeFired = false
  private specialCb: (() => void) | null = null

  constructor(look: CharacterLook = DEFAULT_LOOK) {
    this.group = new THREE.Group()
    this.lookNow = { ...look }
    this.buildBody(this.lookNow)
  }

  /** The look this rig is currently wearing (copy). */
  currentLook(): CharacterLook {
    return { ...this.lookNow }
  }

  private buildBody(look: CharacterLook): void {
    const parts = buildBodyParts(look)
    this.body = parts.body
    this.headPivot = parts.headPivot
    this.torso = parts.torso
    this.armL = parts.armL
    this.armR = parts.armR
    this.legL = parts.legL
    this.legR = parts.legR
    this.capePivot = parts.capePivot
    this.anchors = parts.anchors
    this.bootAnchorR = parts.bootAnchorR
    this.defaultSword = parts.defaultSword
    this.defaultBoots = parts.defaultBoots
    this.armL.rotation.z = 0.06
    this.armR.rotation.z = -0.06
    this.group.add(this.body)
  }

  /**
   * Swap the whole body for a new look, in place. Position, facing, any
   * externally-added group children (name labels) and all equipped item
   * meshes are preserved; combat/animation state keeps ticking.
   */
  applyLook(look: CharacterLook): void {
    // 1) lift equipped meshes off the old body (clones are rebuilt fresh)
    const keep = new Map<string, THREE.Group>()
    for (const [slot, objs] of this.equipped) {
      const primary = objs[0]
      if (primary instanceof THREE.Group) {
        primary.removeFromParent()
        keep.set(slot, primary)
      }
      for (let i = 1; i < objs.length; i++) {
        const extra = objs[i]
        if (extra) {
          extra.removeFromParent()
          disposeObject(extra)
        }
      }
    }
    this.equipped.clear()

    // 2) tear down the old body (group-level children stay put)
    this.group.remove(this.body)
    disposeObject(this.body)

    // 3) rebuild + re-hang the gear and grip pose
    this.lookNow = { ...look }
    this.buildBody(this.lookNow)
    for (const [slot, mesh] of keep) this.setEquipmentMesh(slot, mesh)
    this.setGripStyle(this.gripStyle)
    if (this.hurtT >= 0) this.setEmissive(0x8a1f1f) // mid-flash: keep glowing
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

  /**
   * Point the right-hand weapon per the equipped item's grip style
   * (ItemDef.gripStyle): null restores the classic blade-up sword rest.
   * The anchor rotates; attack swings arc the whole arm as before.
   */
  setGripStyle(style: GripStyle | null): void {
    this.gripStyle = style
    const anchor = this.anchors['weapon']
    if (!anchor) return
    const [rx, ry, rz] = style ? GRIP_POSE[style] : GRIP_DEFAULT
    anchor.rotation.set(rx, ry, rz)
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
    if (this.mode !== 'alive' || this.attackT >= 0 || this.specialT >= 0) return false
    this.attackT = 0
    this.strikeFired = false
    this.strikeCb = onStrike ?? null
    return true
  }

  /**
   * Play a special-attack animation ('spin' whirlwind, 'lunge' dash-pierce,
   * 'cast' staff raise, 'volley' bow fan, 'bash' shield shove). `onStrike`
   * fires once at the ability's strike frame. Ignored while a swing or
   * another special is in flight, or while dead.
   */
  startSpecial(kind: SpecialAnim, onStrike?: () => void): boolean {
    if (this.mode !== 'alive' || this.attackT >= 0 || this.specialT >= 0) return false
    this.specialT = 0
    this.specialKind = kind
    this.specialStrikeFired = false
    this.specialCb = onStrike ?? null
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
    this.specialT = -1 // cancel any mid-special
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

  private updateSpecial(dt: number): void {
    if (this.specialT < 0) return
    this.specialT += dt
    const [dur, strikeAt] = SPECIAL_TIMING[this.specialKind]
    const p = Math.min(1, this.specialT / dur)
    // bell curve 0->1->0 over the move (smooth commit + recover)
    const bell = Math.sin(p * Math.PI)

    switch (this.specialKind) {
      case 'spin': {
        // whirlwind: full 360 body spin, weapon arm out level, slight crouch
        const e = p * p * (3 - 2 * p) // smoothstep
        this.body.rotation.y = Math.PI * 2 * e
        this.armR.rotation.x = -Math.PI / 2 * bell
        this.armR.rotation.z = -0.9 * bell
        this.armL.rotation.z = 0.7 * bell
        this.body.position.y = -0.06 * bell
        break
      }
      case 'lunge': {
        // dash-pierce: deep forward lean, blade rammed out ahead
        this.body.rotation.x = 0.45 * bell
        this.armR.rotation.x = -Math.PI / 2 * Math.min(1, p * 3)
        this.armL.rotation.x = 0.8 * bell // trailing arm back
        this.legL.rotation.x = -0.9 * bell
        this.legR.rotation.x = 0.9 * bell
        break
      }
      case 'cast': {
        // staff raise: both arms up, head back, little hop at release
        const up = Math.min(1, p * 2.2)
        this.armR.rotation.x = -2.7 * up * (p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1)
        this.armL.rotation.x = -2.2 * up * (p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1)
        this.headPivot.rotation.x = -0.22 * bell
        this.body.position.y = p > 0.4 && p < 0.7 ? 0.07 : 0
        break
      }
      case 'volley': {
        // bow fan: bow arm swings up ~45°, draw arm pulls, lean back
        const up = Math.min(1, p * 2.5)
        const rel = p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1
        this.armR.rotation.x = -1.9 * up * rel
        this.armL.rotation.x = -1.5 * up * rel
        this.armL.rotation.z = 0.5 * bell // draw hand across the chest
        this.body.rotation.x = -0.16 * bell
        break
      }
      case 'bash': {
        // shield shove: left arm rams forward, shoulders twist into it
        this.armL.rotation.x = -1.5 * Math.min(1, p * 3) * (p > 0.6 ? 1 - (p - 0.6) / 0.4 : 1)
        this.body.rotation.y = 0.35 * bell
        this.body.rotation.x = 0.18 * bell
        this.legL.rotation.x = -0.5 * bell
        this.legR.rotation.x = 0.5 * bell
        break
      }
    }

    if (!this.specialStrikeFired && p >= strikeAt) {
      this.specialStrikeFired = true
      const cb = this.specialCb
      this.specialCb = null
      cb?.()
    }
    if (p >= 1) {
      this.specialT = -1
      this.body.rotation.set(0, 0, 0)
      this.headPivot.rotation.x = 0
      this.armR.rotation.z = -0.06
      this.armL.rotation.z = 0.06
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
      // cape: lifts with speed and flutters with the step bounce
      if (this.capePivot) {
        const want = 0.16 + 0.3 * energy + Math.sin(this.phase) * 0.06 * energy
        this.capePivot.rotation.x += (want - this.capePivot.rotation.x) * damp
      }
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
      // cape settles to a gentle breeze-sway
      if (this.capePivot) {
        const want = 0.08 + Math.sin(this.t * 1.6) * 0.03
        this.capePivot.rotation.x += (want - this.capePivot.rotation.x) * damp
      }
    }

    // layered on top: the attack swing stomps the right arm, specials stomp
    // whatever they need, hurt flash fades
    this.updateAttack(dt)
    this.updateSpecial(dt)
    this.updateHurt(dt)
  }

  /** Free GPU resources (geometries, materials, textures). */
  dispose(): void {
    disposeObject(this.group)
  }
}
