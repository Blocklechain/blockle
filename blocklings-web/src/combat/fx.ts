/**
 * Combat FX sprites: floating damage numbers (crits bigger + yellow),
 * per-mob HP bars, and boss name labels. All CanvasTexture sprites with
 * NearestFilter so they stay crunchy like the rest of the game.
 */
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Damage numbers — fixed pool of reusable sprites
// ---------------------------------------------------------------------------

const POOL_SIZE = 24

interface NumSlot {
  sprite: THREE.Sprite
  canvas: HTMLCanvasElement
  tex: THREE.CanvasTexture
  life: number
  ttl: number
  baseScale: number
  vy: number
  active: boolean
}

export class DamageNumbers {
  private readonly slots: NumSlot[] = []
  private next = 0

  constructor(private readonly scene: THREE.Scene) {}

  private makeSlot(): NumSlot {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 56
    const tex = new THREE.CanvasTexture(canvas)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.generateMipmaps = false
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, depthTest: false })
    const sprite = new THREE.Sprite(mat)
    sprite.visible = false
    sprite.renderOrder = 999
    this.scene.add(sprite)
    const slot: NumSlot = { sprite, canvas, tex, life: 0, ttl: 0.8, baseScale: 1, vy: 2.2, active: false }
    this.slots.push(slot)
    return slot
  }

  /** Pop a floating number at `pos`. Crits: bigger, yellow, punchier. */
  show(pos: THREE.Vector3, text: string, opts: { crit?: boolean; color?: string } = {}): void {
    const slot =
      this.slots.length < POOL_SIZE ? this.makeSlot() : this.slots[this.next++ % POOL_SIZE]!
    const g = slot.canvas.getContext('2d')
    if (g) {
      g.clearRect(0, 0, slot.canvas.width, slot.canvas.height)
      const fontPx = opts.crit ? 42 : 32
      g.font = `bold ${fontPx}px "Courier New", monospace`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.lineWidth = 6
      g.strokeStyle = 'rgba(16, 10, 8, 0.9)'
      g.strokeText(text, 64, 28)
      g.fillStyle = opts.color ?? (opts.crit ? '#ffd23e' : '#ff5349')
      g.fillText(text, 64, 28)
    }
    slot.tex.needsUpdate = true
    slot.baseScale = opts.crit ? 1.15 : 0.78
    slot.life = 0
    slot.ttl = opts.crit ? 0.95 : 0.75
    slot.vy = opts.crit ? 2.6 : 2.1
    slot.active = true
    slot.sprite.visible = true
    slot.sprite.position.set(
      pos.x + (Math.random() - 0.5) * 0.4,
      pos.y + 1.2,
      pos.z + (Math.random() - 0.5) * 0.4
    )
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue
      s.life += dt
      if (s.life >= s.ttl) {
        s.active = false
        s.sprite.visible = false
        continue
      }
      s.sprite.position.y += s.vy * dt
      const k = s.life / s.ttl
      // pop in fast, fade out at the end
      const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.4 : 1
      const fade = k > 0.65 ? 1 - (k - 0.65) / 0.35 : 1
      const sc = s.baseScale * pop
      s.sprite.scale.set(sc * (128 / 56), sc, 1)
      ;(s.sprite.material as THREE.SpriteMaterial).opacity = fade
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      s.sprite.removeFromParent()
      s.tex.dispose()
      ;(s.sprite.material as THREE.SpriteMaterial).dispose()
    }
    this.slots.length = 0
  }
}

// ---------------------------------------------------------------------------
// Per-mob HP bar sprite
// ---------------------------------------------------------------------------

export class HealthBar {
  readonly sprite: THREE.Sprite
  private readonly canvas: HTMLCanvasElement
  private readonly tex: THREE.CanvasTexture
  private lastPct = -1

  constructor(scale: number) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 40
    this.canvas.height = 6
    this.tex = new THREE.CanvasTexture(this.canvas)
    this.tex.magFilter = THREE.NearestFilter
    this.tex.minFilter = THREE.NearestFilter
    this.tex.generateMipmaps = false
    const mat = new THREE.SpriteMaterial({ map: this.tex, depthWrite: false })
    this.sprite = new THREE.Sprite(mat)
    this.sprite.scale.set(0.95 * scale, 0.14 * scale, 1)
    this.sprite.visible = false
    this.set(1)
  }

  /** Redraw only when the percentage actually changes. */
  set(pct: number): void {
    const p = Math.max(0, Math.min(1, pct))
    if (Math.abs(p - this.lastPct) < 0.01) return
    this.lastPct = p
    const g = this.canvas.getContext('2d')
    if (!g) return
    g.fillStyle = '#17141c'
    g.fillRect(0, 0, 40, 6)
    const w = Math.round(38 * p)
    if (w > 0) {
      g.fillStyle = p > 0.5 ? '#5fd45f' : p > 0.25 ? '#e8b63a' : '#e04040'
      g.fillRect(1, 1, w, 4)
    }
    this.tex.needsUpdate = true
  }

  dispose(): void {
    this.sprite.removeFromParent()
    this.tex.dispose()
    ;(this.sprite.material as THREE.SpriteMaterial).dispose()
  }
}

// ---------------------------------------------------------------------------
// Boss name label (gold, so everyone knows whose lawn this is)
// ---------------------------------------------------------------------------

export function makeBossLabel(text: string): THREE.Sprite {
  const pad = 12
  const fontPx = 26
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')
  let w = 180
  const h = fontPx + pad * 2
  if (measure) {
    measure.font = `bold ${fontPx}px "Courier New", monospace`
    w = Math.ceil(measure.measureText(text).width) + pad * 2
  }
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (g) {
    g.font = `bold ${fontPx}px "Courier New", monospace`
    g.fillStyle = 'rgba(28, 12, 8, 0.6)'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#ffd23e'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, w / 2, h / 2 + 1)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  const H = 0.42
  sprite.scale.set((w / h) * H, H, 1)
  return sprite
}
