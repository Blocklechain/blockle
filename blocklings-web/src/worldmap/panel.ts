/**
 * Full-screen world map panel — a stylized "cartographer's parchment" canvas
 * render of the whole continent.
 *
 * Two layers:
 *   - BASE (offscreen canvas, re-rendered on open/resize): parchment, wobbly
 *     region shapes in biome colors, the great river + bridges, dotted roads,
 *     region names + level bands, village/capital icons, boss skulls,
 *     uncharted-corner snark.
 *   - DYNAMIC (every RAF while open): waystone icons (lit when attuned),
 *     the player blip + facing arrow.
 *
 * Tapping an ATTUNED waystone icon calls deps.requestTravel(stoneId) — the
 * integrator wires that to the waystones module's travel flow.
 */
import type { GameAPI } from '../types'
import { REGIONS, WAYSTONES, BOSSES } from '../ids'
import {
  ROUTES,
  BRIDGES,
  BOSS_SPOTS,
  BIOME_FILL,
  RIVER_CENTER_X,
  RIVER_WIDTH,
  MAP_MIN,
  MAP_MAX
} from './data'
import {
  rng,
  hashStr,
  wobblyRect,
  smoothPath,
  tracePoly,
  drawWaystone,
  drawSkull,
  drawHouse,
  drawCastle,
  drawPlayerArrow
} from './draw'

export interface PanelDeps {
  isAttuned(stoneId: string): boolean
  requestTravel(stoneId: string): void
}

export interface MapPanel {
  el: HTMLElement
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
}

const FONT = '"Trebuchet MS", Verdana, sans-serif'
const INK = '#3a2f22'
const HIT_R = 26 // css px tap radius around a waystone icon

interface StoneHit {
  x: number
  y: number
  stoneId: string
  attuned: boolean
}

export function createMapPanel(api: GameAPI, deps: PanelDeps): MapPanel {
  // ---- DOM ----------------------------------------------------------------
  const el = document.createElement('div')
  el.className = 'wm-panel'

  const head = document.createElement('div')
  head.className = 'wm-head'
  const title = document.createElement('span')
  title.className = 'wm-title'
  title.textContent = 'World Map'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'wm-close'
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', 'Close map')
  head.appendChild(title)
  head.appendChild(closeBtn)

  const wrap = document.createElement('div')
  wrap.className = 'wm-canvas-wrap'
  const canvas = document.createElement('canvas')
  wrap.appendChild(canvas)

  const hint = document.createElement('div')
  hint.className = 'wm-hint'
  hint.textContent = 'Tap a glowing waystone to fast-travel. Walking is for people with time to kill.'

  el.appendChild(head)
  el.appendChild(wrap)
  el.appendChild(hint)

  // ---- transform ----------------------------------------------------------
  let cssW = 0
  let cssH = 0
  let dpr = 1
  let scale = 1 // css px per world unit
  let offX = 0
  let offY = 0

  const toX = (wx: number): number => offX + (wx - MAP_MIN) * scale
  const toY = (wz: number): number => offY + (wz - MAP_MIN) * scale

  // ---- base layer ---------------------------------------------------------
  const base = document.createElement('canvas')

  function renderBase(): void {
    const g = base.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    // Parchment.
    g.fillStyle = '#e8d9b0'
    g.fillRect(0, 0, cssW, cssH)
    // Seeded speckles so the blank sheet doesn't look sterile (still flat ink).
    const r = rng(0xb10c)
    g.fillStyle = 'rgba(122, 101, 68, 0.14)'
    for (let i = 0; i < 260; i++) {
      g.fillRect(r() * cssW, r() * cssH, 1.6, 1.6)
    }

    // Region fills with hand-inked wobble.
    for (const reg of REGIONS) {
      const poly = wobblyRect(reg.x0, reg.z0, reg.x1, reg.z1, hashStr(reg.id))
      tracePoly(g, poly, toX, toY)
      g.closePath()
      g.fillStyle = BIOME_FILL[reg.biome] ?? '#b9a97e'
      g.globalAlpha = 0.82
      g.fill()
      g.globalAlpha = 1
      g.strokeStyle = 'rgba(58, 47, 34, 0.75)'
      g.lineWidth = 2
      g.stroke()
    }

    // The great river (north→south band) + bridge decks.
    const half = RIVER_WIDTH / 2
    const riverPoly = wobblyRect(RIVER_CENTER_X - half, MAP_MIN, RIVER_CENTER_X + half, MAP_MAX, 0x11fe)
    tracePoly(g, riverPoly, toX, toY)
    g.closePath()
    g.fillStyle = '#5fa7c7'
    g.fill()
    g.strokeStyle = 'rgba(40, 62, 80, 0.7)'
    g.lineWidth = 1.5
    g.stroke()
    for (const b of BRIDGES) {
      const w = (RIVER_WIDTH + 4) * scale
      const h = Math.max(4, 4 * scale)
      g.fillStyle = '#8a6b43'
      g.strokeStyle = INK
      g.lineWidth = 1.5
      g.fillRect(toX(b.x) - w / 2, toY(b.z) - h / 2, w, h)
      g.strokeRect(toX(b.x) - w / 2, toY(b.z) - h / 2, w, h)
    }

    // Roads: smoothed, dotted ink lines.
    g.strokeStyle = 'rgba(74, 56, 38, 0.85)'
    g.lineWidth = 2
    g.setLineDash([3, 5])
    for (const route of ROUTES) {
      tracePoly(g, smoothPath(route), toX, toY)
      g.stroke()
    }
    g.setLineDash([])

    // Region names + level bands.
    g.textAlign = 'center'
    for (const reg of REGIONS) {
      const cx = toX((reg.x0 + reg.x1) / 2)
      // Beginnings keeps its label above the village icons at its center.
      const cz = reg.id === 'beginnings' ? reg.z0 + 24 : (reg.z0 + reg.z1) / 2
      const cy = toY(cz)
      const px = Math.max(12, Math.min(19, scale * 11))
      g.font = `700 ${px}px ${FONT}`
      g.fillStyle = INK
      g.fillText(reg.name, cx, cy)
      g.font = `600 ${px * 0.66}px ${FONT}`
      g.fillStyle = 'rgba(58, 47, 34, 0.75)'
      g.fillText(`Lv ${reg.minLevel}–${reg.maxLevel}`, cx, cy + px * 0.9)
    }

    // Uncharted corners get a cheeky cartographer's note.
    g.font = `italic 600 ${Math.max(10, scale * 7)}px ${FONT}`
    g.fillStyle = 'rgba(58, 47, 34, 0.5)'
    g.fillText('uncharted (nothing good here)', toX(-160), toY(-180))
    g.fillText('also uncharted. stop asking.', toX(160), toY(-180))
    g.textAlign = 'left'

    // Settlement icons + boss lairs (static).
    const s = Math.max(14, Math.min(24, scale * 14))
    drawHouse(g, toX(0), toY(8), s)
    drawCastle(g, toX(0), toY(-170), s * 1.4)
    g.textAlign = 'center'
    for (const boss of BOSSES) {
      const spot = BOSS_SPOTS[boss.id]
      if (!spot) continue
      drawSkull(g, toX(spot.x), toY(spot.z), s * 0.8)
      g.font = `700 ${Math.max(9, s * 0.52)}px ${FONT}`
      g.fillStyle = '#5c1f1a'
      g.fillText(boss.name, toX(spot.x), toY(spot.z) + s * 0.95)
    }
    g.textAlign = 'left'

    // Inked double frame.
    g.strokeStyle = INK
    g.lineWidth = 3
    g.strokeRect(6, 6, cssW - 12, cssH - 12)
    g.lineWidth = 1
    g.strokeRect(11, 11, cssW - 22, cssH - 22)
  }

  function resize(): void {
    const rect = wrap.getBoundingClientRect()
    cssW = Math.max(1, rect.width)
    cssH = Math.max(1, rect.height)
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    base.width = canvas.width
    base.height = canvas.height
    const pad = 18
    scale = Math.min((cssW - pad * 2) / (MAP_MAX - MAP_MIN), (cssH - pad * 2) / (MAP_MAX - MAP_MIN))
    offX = (cssW - (MAP_MAX - MAP_MIN) * scale) / 2
    offY = (cssH - (MAP_MAX - MAP_MIN) * scale) / 2
    renderBase()
  }

  // ---- dynamic layer ------------------------------------------------------
  let hits: StoneHit[] = []

  function drawDynamic(): void {
    const g = canvas.getContext('2d')
    if (!g) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, canvas.width, canvas.height)
    g.drawImage(base, 0, 0)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    const s = Math.max(14, Math.min(22, scale * 12))
    hits = []
    g.textAlign = 'center'
    for (const ws of WAYSTONES) {
      const x = toX(ws.x)
      const y = toY(ws.z)
      const attuned = deps.isAttuned(ws.id)
      drawWaystone(g, x, y, s, attuned)
      g.font = `700 ${Math.max(9, s * 0.5)}px ${FONT}`
      g.fillStyle = attuned ? '#1c5660' : 'rgba(58, 47, 34, 0.6)'
      g.fillText(ws.name.replace(' Waystone', ''), x, y + s * 0.95)
      hits.push({ x, y, stoneId: ws.id, attuned })
    }
    g.textAlign = 'left'

    // Player blip + facing arrow (white/gold, impossible to miss).
    const p = api.player
    drawPlayerArrow(g, toX(p.pos.x), toY(p.pos.z), 9, p.facing)
  }

  // ---- open/close + RAF ---------------------------------------------------
  let openFlag = false
  let raf = 0

  function loop(): void {
    if (!openFlag) return
    drawDynamic()
    raf = requestAnimationFrame(loop)
  }

  function open(): void {
    if (openFlag) return
    openFlag = true
    el.classList.add('wm-open')
    resize()
    raf = requestAnimationFrame(loop)
  }

  function close(): void {
    if (!openFlag) return
    openFlag = false
    el.classList.remove('wm-open')
    cancelAnimationFrame(raf)
  }

  closeBtn.addEventListener('click', close)
  window.addEventListener('resize', () => {
    if (openFlag) resize()
  })

  // ---- waystone taps ------------------------------------------------------
  function hitAt(cx: number, cy: number): StoneHit | null {
    let best: StoneHit | null = null
    let bestD = HIT_R
    for (const h of hits) {
      const d = Math.hypot(h.x - cx, h.y - cy)
      if (d < bestD) {
        bestD = d
        best = h
      }
    }
    return best
  }

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect()
    const h = hitAt(e.clientX - rect.left, e.clientY - rect.top)
    if (h?.attuned) deps.requestTravel(h.stoneId)
  })
  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect()
    const h = hitAt(e.clientX - rect.left, e.clientY - rect.top)
    canvas.style.cursor = h?.attuned ? 'pointer' : 'default'
  })

  return {
    el,
    open,
    close,
    toggle(): void {
      if (openFlag) close()
      else open()
    },
    isOpen: () => openFlag
  }
}
