/**
 * StoneRig — one teleport waystone as a handsome runed voxel monolith.
 *
 * Same hand-built flat-color Lambert voxel vocabulary as the rest of the
 * world: axis-aligned colored boxes, no textures. ~2.5 units tall stepped
 * monolith, carved rune chips on every face, a floating ring of rune cubes
 * orbiting the shaft, and a soft cyan glow disc on the plinth.
 *
 * States:
 *   unattuned — dim grey runes, ring barely turning, no glow disc.
 *   attuned   — cyan emissive runes + ring, gentle pulse, slow orbit.
 *
 * Geometry is instanced (3 InstancedMeshes per stone: body, runes, ring)
 * and all rigs share one unit BoxGeometry. Flash on attune is a transient
 * expanding flat ring.
 */
import * as THREE from 'three'

// --- palette ---------------------------------------------------------------

const BODY_GREYS = [0x7a7e89, 0x6c7079, 0x858a94, 0x61656f] as const
const RUNE_OFF = 0x565c66 // dim dead-rock grey
const RUNE_ON = 0xc9f6ff // pale cyan stone-light
const EMISSIVE_ON = 0x35dcff
const DISC_CYAN = 0x6ae8ff

// --- shared geometry -------------------------------------------------------

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)

// --- tiny local batcher (boxes -> one InstancedMesh) -----------------------

interface Box {
  cx: number
  y: number // min-y (bottom)
  cz: number
  sx: number
  sy: number
  sz: number
  color: number
}

function bake(boxes: Box[], mat: THREE.Material, shadows: boolean): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(UNIT_BOX, mat, boxes.length)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const c = new THREE.Color()
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i] as Box
    p.set(b.cx, b.y + b.sy / 2, b.cz)
    s.set(b.sx, b.sy, b.sz)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.setHex(b.color))
  }
  mesh.castShadow = shadows
  mesh.receiveShadow = true
  mesh.matrixAutoUpdate = false
  return mesh
}

// --- floating name label (restated pattern, gold swapped for stone-cyan) ---

function makeNameSprite(text: string): THREE.Sprite {
  const pad = 14
  const fontPx = 30
  const probe = document.createElement('canvas').getContext('2d')
  let w = 160
  const h = fontPx + pad * 2
  if (probe) {
    probe.font = `bold ${fontPx}px "Courier New", monospace`
    w = Math.ceil(probe.measureText(text).width) + pad * 2
  }
  const canvas = document.createElement('canvas')
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
    g.fillStyle = '#bdf0ff' // pale cyan — reads "magic infrastructure"
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, w / 2, h / 2 + 1)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  const H = 0.3
  sprite.scale.set((w / h) * H, H, 1)
  sprite.position.y = 2.95
  return sprite
}

// --- rune layout -----------------------------------------------------------

/** Shaft half-depth at a given height (the monolith tapers upward). */
function faceAt(y: number): number {
  if (y < 1.3) return 0.36
  if (y < 1.95) return 0.31
  return 0.25
}

function runeBoxes(color: number): Box[] {
  const out: Box[] = []
  // 3 carved rune chips per face, 4 faces, deterministic jitter per slot
  const heights = [0.82, 1.32, 1.82]
  for (let f = 0; f < 4; f++) {
    for (let i = 0; i < 3; i++) {
      const y = (heights[i] as number) + ((f * 7 + i * 13) % 5) * 0.03
      const off = faceAt(y) + 0.015
      const lat = (((f * 5 + i * 11) % 7) - 3) * 0.035 // sideways jitter
      const sy = 0.14 + ((f + i) % 3) * 0.03
      if (f === 0) out.push({ cx: lat, y, cz: off, sx: 0.11, sy, sz: 0.05, color })
      else if (f === 1) out.push({ cx: lat, y, cz: -off, sx: 0.11, sy, sz: 0.05, color })
      else if (f === 2) out.push({ cx: off, y, cz: lat, sx: 0.05, sy, sz: 0.11, color })
      else out.push({ cx: -off, y, cz: lat, sx: 0.05, sy, sz: 0.11, color })
    }
  }
  return out
}

// --- the rig ---------------------------------------------------------------

const RING_CUBES = 7
const RING_RADIUS = 0.82
const RING_Y = 1.55

export class StoneRig {
  /** Add to the scene; position = base center on the ground. */
  readonly group: THREE.Group

  /** Invisible pick box for click/tap raycasts. */
  readonly hit: THREE.Mesh

  private readonly runeMat: THREE.MeshLambertMaterial
  private readonly ring: THREE.InstancedMesh
  private readonly disc: THREE.Mesh
  private readonly discMat: THREE.MeshBasicMaterial
  private readonly flashMesh: THREE.Mesh
  private readonly flashMat: THREE.MeshBasicMaterial

  private attuned = false
  private t = Math.random() * 10 // desync pulses between stones
  private flashT = -1 // >= 0 while the attune flash plays

  constructor(name: string) {
    this.group = new THREE.Group()

    // --- body: stepped grey monolith + base pebbles ------------------------
    const G = BODY_GREYS
    const body: Box[] = [
      { cx: 0, y: 0, cz: 0, sx: 1.7, sy: 0.22, sz: 1.7, color: G[1] },
      { cx: 0, y: 0.22, cz: 0, sx: 1.2, sy: 0.2, sz: 1.2, color: G[2] },
      { cx: 0, y: 0.42, cz: 0, sx: 0.9, sy: 0.18, sz: 0.9, color: G[0] },
      // tapering shaft
      { cx: 0, y: 0.6, cz: 0, sx: 0.72, sy: 0.7, sz: 0.72, color: G[2] },
      { cx: 0, y: 1.3, cz: 0, sx: 0.62, sy: 0.65, sz: 0.62, color: G[0] },
      { cx: 0, y: 1.95, cz: 0, sx: 0.5, sy: 0.45, sz: 0.5, color: G[2] },
      { cx: 0, y: 2.4, cz: 0, sx: 0.34, sy: 0.16, sz: 0.3, color: G[3] },
      // weathered pebbles for charm
      { cx: 0.95, y: 0, cz: 0.55, sx: 0.26, sy: 0.18, sz: 0.26, color: G[3] },
      { cx: -0.8, y: 0, cz: -0.75, sx: 0.2, sy: 0.14, sz: 0.2, color: G[0] },
      { cx: 0.6, y: 0, cz: -0.95, sx: 0.16, sy: 0.12, sz: 0.16, color: G[1] }
    ]
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.group.add(bake(body, bodyMat, true))

    // --- runes (carved chips) + floating ring, one emissive material -------
    this.runeMat = new THREE.MeshLambertMaterial({
      color: RUNE_OFF,
      emissive: RUNE_OFF,
      emissiveIntensity: 0.15
    })
    this.group.add(bake(runeBoxes(0xffffff), this.runeMat, false))

    this.ring = new THREE.InstancedMesh(UNIT_BOX, this.runeMat, RING_CUBES)
    {
      const m = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const s = new THREE.Vector3(0.15, 0.15, 0.15)
      const p = new THREE.Vector3()
      for (let i = 0; i < RING_CUBES; i++) {
        const a = (i / RING_CUBES) * Math.PI * 2
        p.set(Math.cos(a) * RING_RADIUS, Math.sin(a * 3) * 0.05, Math.sin(a) * RING_RADIUS)
        m.compose(p, q, s)
        this.ring.setMatrixAt(i, m)
      }
    }
    this.ring.position.y = RING_Y
    this.ring.castShadow = false
    this.group.add(this.ring)

    // --- glow disc on the plinth (attuned only) ----------------------------
    this.discMat = new THREE.MeshBasicMaterial({
      color: DISC_CYAN,
      transparent: true,
      opacity: 0,
      depthWrite: false
    })
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(0.82, 24), this.discMat)
    this.disc.rotation.x = -Math.PI / 2
    this.disc.position.y = 0.235
    this.disc.visible = false
    this.group.add(this.disc)

    // --- attune flash (expanding flat ring, hidden until flash()) ----------
    this.flashMat = new THREE.MeshBasicMaterial({
      color: 0xdffbff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    this.flashMesh = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.0, 28), this.flashMat)
    this.flashMesh.rotation.x = -Math.PI / 2
    this.flashMesh.position.y = 0.3
    this.flashMesh.visible = false
    this.group.add(this.flashMesh)

    // --- name label + invisible pick box -----------------------------------
    this.group.add(makeNameSprite(name))
    this.hit = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 2.8, 1.5),
      new THREE.MeshBasicMaterial({ visible: false })
    )
    this.hit.position.y = 1.4
    this.group.add(this.hit)
  }

  get isAttuned(): boolean {
    return this.attuned
  }

  setAttuned(on: boolean): void {
    this.attuned = on
    if (on) {
      this.runeMat.color.setHex(RUNE_ON)
      this.runeMat.emissive.setHex(EMISSIVE_ON)
      this.runeMat.emissiveIntensity = 0.9
      this.disc.visible = true
    } else {
      this.runeMat.color.setHex(RUNE_OFF)
      this.runeMat.emissive.setHex(RUNE_OFF)
      this.runeMat.emissiveIntensity = 0.15
      this.disc.visible = false
      this.discMat.opacity = 0
    }
  }

  /** Attunement moment: kick off the expanding light ring + emissive spike. */
  flash(): void {
    this.flashT = 0
    this.flashMesh.visible = true
  }

  /** Per-frame animation. Cheap; caller distance-culls far stones. */
  update(dt: number): void {
    this.t += dt

    // ring orbit: dormant stones barely creep, attuned ones glide + bob
    this.ring.rotation.y += dt * (this.attuned ? 0.9 : 0.12)
    this.ring.position.y = RING_Y + (this.attuned ? Math.sin(this.t * 1.6) * 0.07 : 0)

    if (this.attuned) {
      // gentle pulse
      this.runeMat.emissiveIntensity = 0.85 + Math.sin(this.t * 2.2) * 0.3
      this.discMat.opacity = 0.16 + Math.sin(this.t * 2.2) * 0.05
    }

    // attune flash animation
    if (this.flashT >= 0) {
      this.flashT += dt
      const k = this.flashT / 0.6
      if (k >= 1) {
        this.flashT = -1
        this.flashMesh.visible = false
        this.flashMat.opacity = 0
      } else {
        const s = 0.6 + k * 2.4
        this.flashMesh.scale.set(s, s, s)
        this.flashMat.opacity = 0.85 * (1 - k)
        if (this.attuned) this.runeMat.emissiveIntensity = 2.4 * (1 - k) + 0.85
      }
    }
  }
}
