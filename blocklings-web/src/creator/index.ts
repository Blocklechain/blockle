/**
 * Character creator — the full-screen "make your Blockling" overlay.
 *
 * Shown on first world entry (no saved look) and reusable later from
 * settings ("Change Appearance"). Cozy title-screen styling, a live
 * rotating 3D preview (the REAL CharacterRig, idle-breathing, so what you
 * see is exactly what walks), arrow rows for shapes, swatch strips for
 * colors, a body-frame toggle, a Surprise Me randomizer, and one comedy
 * flavor line per hair style because hair is a personality.
 *
 * Exports (wired by main.ts — see src/creator.ts shim):
 *   needsCreator()            — true when no saved look exists yet
 *   showCreator(onDone)       — first-entry flow; Enter World hands back the look
 *   openCreatorForEdit()      — settings flow; edits + applies the live look
 *   installAppearanceHook()   — publishes window.blocklingsChangeAppearance
 */
import * as THREE from 'three'
import './creator.css'
import { CharacterRig } from '../player/character'
import { applyLook, currentLook } from '../player/index'
import {
  BODY_FRAMES,
  SKIN_TONES,
  HAIR_STYLES,
  HAIR_COLORS,
  FACIAL_HAIR,
  TUNIC_COLORS,
  PANTS_COLORS,
  EYE_COLORS,
  CAPES,
  DEFAULT_LOOK,
  decodeLook,
  randomLook,
  pick,
  type CharacterLook
} from '../player/look'

declare global {
  interface Window {
    /** Settings hook: open the appearance editor (published by installAppearanceHook). */
    blocklingsChangeAppearance?: () => void
  }
}

const SAVE_KEY = 'blocklings_save_v1' // mirrors src/save/core.ts LOCAL_KEY

// ---------------------------------------------------------------------------
// Public gate
// ---------------------------------------------------------------------------

/** True when no decodable saved look exists on this device (first entry). */
export function needsCreator(): boolean {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return true
    const env = JSON.parse(raw) as { mods?: Record<string, unknown> } | null
    return decodeLook(env?.mods?.['look']) === null
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function btn(cls: string, text: string): HTMLButtonElement {
  const b = el('button', cls, text)
  b.type = 'button'
  return b
}

function cssOf(hex: number): string {
  return `#${new THREE.Color(hex).getHexString()}`
}

// ---------------------------------------------------------------------------
// Live 3D preview (the inventory mini-viewer pattern, but with the real rig)
// ---------------------------------------------------------------------------

class LookPreview {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer | null = null
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50)
  private readonly pivot = new THREE.Group()
  private rig: CharacterRig
  private raf = 0
  private last = 0

  constructor(initial: CharacterLook) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'bl-creator-canvas'
    this.scene.add(this.pivot)
    this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x5a6b4a, 1.1))
    const key = new THREE.DirectionalLight(0xfff3d6, 1.7)
    key.position.set(2.2, 3.5, 2.6)
    this.scene.add(key)

    // a little grass pedestal so our hero isn't floating in the void
    const sod = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.14, 1.7),
      new THREE.MeshLambertMaterial({ color: 0x7ed957 })
    )
    sod.position.y = -0.07
    const dirt = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.18, 1.7),
      new THREE.MeshLambertMaterial({ color: 0x8a6a45 })
    )
    dirt.position.y = -0.23
    this.pivot.add(sod, dirt)

    this.rig = new CharacterRig(initial)
    this.pivot.add(this.rig.group)

    this.camera.position.set(0, 1.35, 3.4)
    this.camera.lookAt(0, 0.95, 0)
  }

  setLook(look: CharacterLook): void {
    this.rig.applyLook(look)
  }

  start(): void {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true })
      this.renderer.outputColorSpace = THREE.SRGBColorSpace
    }
    this.resize()
    this.last = performance.now()
    if (!this.raf) this.raf = requestAnimationFrame(this.tick)
  }

  resize(): void {
    if (!this.renderer) return
    const w = this.canvas.clientWidth || 260
    const h = this.canvas.clientHeight || 300
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.rig.dispose()
    this.pivot.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) m.dispose()
      }
    })
    this.renderer?.dispose()
    this.renderer = null
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick)
    const dt = Math.min((now - this.last) / 1000, 0.1)
    this.last = now
    this.pivot.rotation.y += dt * 0.55 // slow runway spin
    this.rig.update(dt, false, 0) // idle breathe + the little look-around
    if (this.renderer) this.renderer.render(this.scene, this.camera)
  }
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

interface CreatorOptions {
  title: string
  tag: string
  confirmLabel: string
  /** Show a "Never Mind" escape hatch (settings flow). */
  cancellable: boolean
  initial: CharacterLook
  onConfirm(look: CharacterLook): void
  onCancel?(): void
}

let openCount = 0

function mountPoint(): HTMLElement {
  return document.getElementById('ui') ?? document.body
}

function openCreator(opts: CreatorOptions): void {
  if (openCount > 0) return // one makeover at a time
  openCount++

  const look: CharacterLook = { ...opts.initial }
  const root = el('div', 'bl-creator')
  const refreshers: Array<() => void> = []
  const refresh = (): void => {
    for (const fn of refreshers) fn()
    preview.setLook(look)
  }

  // --- header ---------------------------------------------------------------
  root.appendChild(el('h1', 'bl-creator-logo', opts.title))
  root.appendChild(el('p', 'bl-creator-tag', opts.tag))

  // --- card: preview | options ---------------------------------------------
  const card = el('div', 'bl-creator-card')

  const previewWrap = el('div', 'bl-creator-preview')
  const preview = new LookPreview(look)
  previewWrap.appendChild(preview.canvas)
  const flavor = el('div', 'bl-creator-flavor')
  previewWrap.appendChild(flavor)
  refreshers.push(() => {
    flavor.textContent = pick(HAIR_STYLES, look.hairStyle).flavor
  })
  card.appendChild(previewWrap)

  const opts2 = el('div', 'bl-creator-opts')
  card.appendChild(opts2)

  // --- body frame toggle ----------------------------------------------------
  {
    const row = el('div', 'bl-creator-row')
    row.appendChild(el('div', 'bl-creator-label', 'Frame'))
    const seg = el('div', 'bl-creator-seg')
    const buttons = BODY_FRAMES.map((f) => {
      const b = btn('bl-creator-segbtn', f.name)
      b.title = f.flavor
      b.addEventListener('click', () => {
        look.body = f.id
        refresh()
      })
      seg.appendChild(b)
      return { b, f }
    })
    refreshers.push(() => {
      for (const { b, f } of buttons) {
        b.classList.toggle('bl-creator-segbtn--on', look.body === f.id)
      }
    })
    row.appendChild(seg)
    opts2.appendChild(row)
  }

  // --- arrow rows (style pickers) -------------------------------------------
  function arrowRow(
    label: string,
    count: number,
    get: () => number,
    set: (i: number) => void,
    nameOf: (i: number) => string
  ): void {
    const row = el('div', 'bl-creator-row')
    row.appendChild(el('div', 'bl-creator-label', label))
    const ctl = el('div', 'bl-creator-arrows')
    const left = btn('bl-creator-arrow', '◀')
    const value = el('div', 'bl-creator-value')
    const right = btn('bl-creator-arrow', '▶')
    const step = (d: number): void => {
      set((((get() + d) % count) + count) % count)
      refresh()
    }
    left.addEventListener('click', () => step(-1))
    right.addEventListener('click', () => step(1))
    refreshers.push(() => {
      value.textContent = nameOf(get())
    })
    ctl.appendChild(left)
    ctl.appendChild(value)
    ctl.appendChild(right)
    row.appendChild(ctl)
    opts2.appendChild(row)
  }

  arrowRow(
    'Hair',
    HAIR_STYLES.length,
    () => look.hairStyle,
    (i) => {
      look.hairStyle = i
    },
    (i) => pick(HAIR_STYLES, i).name
  )
  arrowRow(
    'Face Fuzz',
    FACIAL_HAIR.length,
    () => look.facialHair,
    (i) => {
      look.facialHair = i
    },
    (i) => pick(FACIAL_HAIR, i).name
  )

  // --- swatch rows (color pickers) ------------------------------------------
  function swatchRow(
    label: string,
    colors: readonly { name: string; css: string; none?: boolean }[],
    get: () => number,
    set: (i: number) => void
  ): void {
    const row = el('div', 'bl-creator-row bl-creator-row--swatch')
    const cap = el('div', 'bl-creator-label', label)
    const name = el('span', 'bl-creator-swatchname')
    cap.appendChild(name)
    row.appendChild(cap)
    const strip = el('div', 'bl-creator-swatches')
    const buttons = colors.map((c, i) => {
      const b = btn('bl-creator-swatch', '')
      b.title = c.name
      if (c.none) b.classList.add('bl-creator-swatch--none')
      else b.style.background = c.css
      b.addEventListener('click', () => {
        set(i)
        refresh()
      })
      strip.appendChild(b)
      return b
    })
    refreshers.push(() => {
      const sel = get()
      name.textContent = ` — ${colors[sel]?.name ?? ''}`
      buttons.forEach((b, i) => b.classList.toggle('bl-creator-swatch--on', i === sel))
    })
    row.appendChild(strip)
    opts2.appendChild(row)
  }

  swatchRow(
    'Skin',
    SKIN_TONES.map((s) => ({ name: s.name, css: cssOf(s.hex) })),
    () => look.skin,
    (i) => {
      look.skin = i
    }
  )
  swatchRow(
    'Hair Color',
    HAIR_COLORS.map((h) => ({ name: h.name, css: cssOf(h.hex) })),
    () => look.hairColor,
    (i) => {
      look.hairColor = i
    }
  )
  swatchRow(
    'Tunic',
    TUNIC_COLORS.map((t) => ({
      name: t.name,
      css: `#${new THREE.Color().setHSL(t.hue / 360, 0.62, 0.52).getHexString()}`
    })),
    () => look.tunicColor,
    (i) => {
      look.tunicColor = i
    }
  )
  swatchRow(
    'Pants',
    PANTS_COLORS.map((p) => ({ name: p.name, css: `#${p.color.getHexString()}` })),
    () => look.pantsColor,
    (i) => {
      look.pantsColor = i
    }
  )
  swatchRow(
    'Eyes',
    EYE_COLORS.map((e2) => ({ name: e2.name, css: e2.css })),
    () => look.eyes,
    (i) => {
      look.eyes = i
    }
  )
  swatchRow(
    'Cape',
    CAPES.map((c) => ({
      name: c.name,
      css: c.hex === null ? 'transparent' : cssOf(c.hex),
      none: c.hex === null
    })),
    () => look.cape,
    (i) => {
      look.cape = i
    }
  )

  root.appendChild(card)

  // --- actions --------------------------------------------------------------
  const actions = el('div', 'bl-creator-actions')
  const randomBtn = btn('bl-creator-random', 'Surprise Me')
  randomBtn.addEventListener('click', () => {
    Object.assign(look, randomLook())
    refresh()
  })
  const confirmBtn = btn('bl-creator-primary', opts.confirmLabel)
  actions.appendChild(randomBtn)
  actions.appendChild(confirmBtn)
  root.appendChild(actions)

  if (opts.cancellable) {
    const cancel = btn('bl-creator-cancel', 'Never mind, I looked great already')
    cancel.addEventListener('click', () => {
      close()
      opts.onCancel?.()
    })
    root.appendChild(cancel)
  }

  // --- lifecycle ------------------------------------------------------------
  const onResize = (): void => preview.resize()
  window.addEventListener('resize', onResize)

  function close(): void {
    window.removeEventListener('resize', onResize)
    root.classList.add('bl-creator--hidden')
    window.setTimeout(() => {
      preview.dispose()
      root.remove()
    }, 450) // after the fade
    openCount--
  }

  confirmBtn.addEventListener('click', () => {
    close()
    opts.onConfirm({ ...look })
  })

  mountPoint().appendChild(root)
  refresh()
  preview.start()
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * First-entry flow: full-screen creator starting from the classic hero.
 * `onDone(look)` fires once when Enter World is tapped — the integrator
 * applies the look (player applyLook) and proceeds into the world.
 */
export function showCreator(onDone: (look: CharacterLook) => void): void {
  openCreator({
    title: 'MAKE YOUR BLOCKLING',
    tag: 'The head stays enormous. Everything else is negotiable.',
    confirmLabel: 'Enter World',
    cancellable: false,
    initial: DEFAULT_LOOK,
    onConfirm: onDone
  })
}

/**
 * Settings flow ("Change Appearance"): edits the hero's live look and
 * applies it on save (rig rebuilds in place; equipment stays put).
 */
export function openCreatorForEdit(): void {
  openCreator({
    title: 'CHANGE OF HEART',
    tag: 'New look, same questionable decisions.',
    confirmLabel: 'Save Look',
    cancellable: true,
    initial: currentLook(),
    onConfirm: (look) => applyLook(look)
  })
}

/**
 * Settings hook: publish window.blocklingsChangeAppearance so the HUD
 * settings panel can offer a 'Change Appearance' entry without importing
 * this module (same pattern as blocklingsSignOut / blocklingsSetQuality).
 */
export function installAppearanceHook(): void {
  window.blocklingsChangeAppearance = () => openCreatorForEdit()
}
