/**
 * Full-screen world map panel — a stylized "cartographer's parchment" canvas
 * render of the whole 1440x1440 continent: the 6-region heart plus the 90
 * wilderness zones out to the coast, ringed by sea.
 *
 * The camera pans (drag) and zooms (wheel / pinch), clamped to the map.
 * Two layers:
 *   - BASE (offscreen canvas, re-rendered when the camera moves or on
 *     open/resize): sea, wobbly coastline, zone + region shapes in biome
 *     colors, the great river + bridges, dotted roads, name labels + level
 *     bands (zones label in as you zoom), village/capital icons, boss
 *     skulls, uncharted-corner snark.
 *   - DYNAMIC (every RAF while open): waystone icons (lit when attuned),
 *     the player blip + facing arrow.
 *
 * Tapping an ATTUNED waystone icon calls deps.requestTravel(stoneId) — the
 * integrator wires that to the waystones module's travel flow. Drags never
 * count as taps.
 */
import type { GameAPI } from '../types'
import { REGIONS, BOSSES } from '../ids'
import { ZONES } from '../world/zones/registry'
import {
  ROUTES,
  BRIDGES,
  BOSS_SPOTS,
  BIOME_FILL,
  RIVER_CENTER_X,
  RIVER_WIDTH,
  RIVER_Z0,
  RIVER_Z1,
  WORLD_HALF,
  MAP_MIN,
  MAP_MAX,
  ALL_WAYSTONES,
  type Pt
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
const SEA = '#6aa3bd'
const HIT_R = 26 // css px tap radius around a waystone icon
const MAX_ZOOM = 3 // css px per world unit
const TAP_SLOP = 7 // css px of drift before a press becomes a drag
const ZONE_LABEL_ZOOM = 0.5 // px/unit at which zone names fade in

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
  canvas.style.touchAction = 'none' // we do our own pan/pinch
  wrap.appendChild(canvas)

  const hint = document.createElement('div')
  hint.className = 'wm-hint'
  hint.textContent =
    'Drag to pan, scroll or pinch to zoom. Tap a glowing waystone to fast-travel — walking is for people with time to kill.'

  el.appendChild(head)
  el.appendChild(wrap)
  el.appendChild(hint)

  // ---- camera -------------------------------------------------------------
  let cssW = 0
  let cssH = 0
  let dpr = 1
  let zoom = 1 // css px per world unit
  let minZoom = 0.1
  let camX = 0 // world coords at the canvas center
  let camZ = 0
  let camDirty = true

  const toX = (wx: number): number => cssW / 2 + (wx - camX) * zoom
  const toY = (wz: number): number => cssH / 2 + (wz - camZ) * zoom

  function clampCam(): void {
    camX = Math.max(MAP_MIN, Math.min(MAP_MAX, camX))
    camZ = Math.max(MAP_MIN, Math.min(MAP_MAX, camZ))
  }

  function setZoom(next: number, anchorCx: number, anchorCy: number): void {
    const z2 = Math.max(minZoom, Math.min(MAX_ZOOM, next))
    if (z2 === zoom) return
    // keep the world point under the anchor fixed
    const wx = camX + (anchorCx - cssW / 2) / zoom
    const wz = camZ + (anchorCy - cssH / 2) / zoom
    zoom = z2
    camX = wx - (anchorCx - cssW / 2) / zoom
    camZ = wz - (anchorCy - cssH / 2) / zoom
    clampCam()
    camDirty = true
  }

  // ---- cached geometry (deterministic, computed once) ---------------------
  const polyCache = new Map<string, Pt[]>()
  function poly(id: string, x0: number, z0: number, x1: number, z1: number): Pt[] {
    let p = polyCache.get(id)
    if (!p) {
      p = wobblyRect(x0, z0, x1, z1, hashStr(id))
      polyCache.set(id, p)
    }
    return p
  }
  const smoothRoutes = ROUTES.map((r) => smoothPath(r))

  // ---- base layer ---------------------------------------------------------
  const base = document.createElement('canvas')

  function onScreen(x0: number, z0: number, x1: number, z1: number, pad = 24): boolean {
    return !(toX(x1) < -pad || toX(x0) > cssW + pad || toY(z1) < -pad || toY(z0) > cssH + pad)
  }

  function renderBase(): void {
    const g = base.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    // The sea. It's big. It's wet. It's everywhere the land isn't.
    g.fillStyle = SEA
    g.fillRect(0, 0, cssW, cssH)

    // The continent: one parchment landmass with a wobbly hand-inked coast.
    const coast = poly('the_coastline', -WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF)
    tracePoly(g, coast, toX, toY)
    g.closePath()
    g.fillStyle = '#e8d9b0'
    g.fill()
    g.strokeStyle = 'rgba(40, 62, 80, 0.8)'
    g.lineWidth = 2.5
    g.stroke()

    // Seeded parchment speckles (screen-space; the blank sheet stays alive).
    const r = rng(0xb10c)
    g.fillStyle = 'rgba(122, 101, 68, 0.14)'
    for (let i = 0; i < 260; i++) {
      g.fillRect(r() * cssW, r() * cssH, 1.6, 1.6)
    }

    // Wilderness zones, then heart regions on top, all hand-inked wobble.
    const paint = (
      id: string,
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      biome: string
    ): void => {
      if (!onScreen(x0, z0, x1, z1)) return
      tracePoly(g, poly(id, x0, z0, x1, z1), toX, toY)
      g.closePath()
      g.fillStyle = BIOME_FILL[biome] ?? '#b9a97e'
      g.globalAlpha = 0.82
      g.fill()
      g.globalAlpha = 1
      g.strokeStyle = 'rgba(58, 47, 34, 0.75)'
      g.lineWidth = Math.max(1.2, Math.min(2, zoom * 2))
      g.stroke()
    }
    for (const zn of ZONES) paint(zn.id, zn.x0, zn.z0, zn.x1, zn.z1, zn.biome)
    for (const reg of REGIONS) paint(reg.id, reg.x0, reg.z0, reg.x1, reg.z1, reg.biome)

    // The great river (heart-only north→south band) + bridge decks.
    const half = RIVER_WIDTH / 2
    if (onScreen(RIVER_CENTER_X - half, RIVER_Z0, RIVER_CENTER_X + half, RIVER_Z1)) {
      const riverPoly = poly('the_river', RIVER_CENTER_X - half, RIVER_Z0, RIVER_CENTER_X + half, RIVER_Z1)
      tracePoly(g, riverPoly, toX, toY)
      g.closePath()
      g.fillStyle = '#5fa7c7'
      g.fill()
      g.strokeStyle = 'rgba(40, 62, 80, 0.7)'
      g.lineWidth = 1.5
      g.stroke()
      for (const b of BRIDGES) {
        const w = (RIVER_WIDTH + 4) * zoom
        const h = Math.max(4, 4 * zoom)
        g.fillStyle = '#8a6b43'
        g.strokeStyle = INK
        g.lineWidth = 1.5
        g.fillRect(toX(b.x) - w / 2, toY(b.z) - h / 2, w, h)
        g.strokeRect(toX(b.x) - w / 2, toY(b.z) - h / 2, w, h)
      }
    }

    // Roads: smoothed, dotted ink lines.
    g.strokeStyle = 'rgba(74, 56, 38, 0.85)'
    g.lineWidth = 2
    g.setLineDash([3, 5])
    for (const route of smoothRoutes) {
      tracePoly(g, route, toX, toY)
      g.stroke()
    }
    g.setLineDash([])

    // Labels: heart regions always; zones once you zoom in enough to care.
    g.textAlign = 'center'
    for (const reg of REGIONS) {
      if (!onScreen(reg.x0, reg.z0, reg.x1, reg.z1)) continue
      const cx = toX((reg.x0 + reg.x1) / 2)
      // Beginnings keeps its label above the village icons at its center.
      const cz = reg.id === 'beginnings' ? reg.z0 + 24 : (reg.z0 + reg.z1) / 2
      const cy = toY(cz)
      const px = Math.max(11, Math.min(19, zoom * 11))
      g.font = `700 ${px}px ${FONT}`
      g.fillStyle = INK
      g.fillText(reg.name, cx, cy)
      g.font = `600 ${px * 0.66}px ${FONT}`
      g.fillStyle = 'rgba(58, 47, 34, 0.75)'
      g.fillText(`Lv ${reg.minLevel}–${reg.maxLevel}`, cx, cy + px * 0.9)
    }
    if (zoom >= ZONE_LABEL_ZOOM) {
      const fade = Math.min(1, (zoom - ZONE_LABEL_ZOOM) / 0.25)
      for (const zn of ZONES) {
        if (!onScreen(zn.x0, zn.z0, zn.x1, zn.z1)) continue
        const cx = toX((zn.x0 + zn.x1) / 2)
        const cy = toY((zn.z0 + zn.z1) / 2)
        const px = Math.max(10, Math.min(17, zoom * 14))
        g.globalAlpha = fade
        g.font = `700 ${px}px ${FONT}`
        g.fillStyle = INK
        g.fillText(zn.name, cx, cy)
        g.font = `600 ${px * 0.66}px ${FONT}`
        g.fillStyle = 'rgba(58, 47, 34, 0.75)'
        g.fillText(`Lv ${zn.minLevel}–${zn.maxLevel}`, cx, cy + px * 0.9)
        g.globalAlpha = 1
      }
    }

    // The heart's unassigned corners keep their cheeky cartographer notes.
    g.font = `italic 600 ${Math.max(9, Math.min(13, zoom * 7))}px ${FONT}`
    g.fillStyle = 'rgba(58, 47, 34, 0.5)'
    g.fillText('uncharted (nothing good here)', toX(-160), toY(-180))
    g.fillText('also uncharted. stop asking.', toX(160), toY(-180))
    // ...and the sea gets one too.
    g.fillText('the sea (do not drink)', toX(0), toY(WORLD_HALF + 14))
    g.textAlign = 'left'

    // Settlement icons + boss lairs (static).
    const s = Math.max(12, Math.min(24, zoom * 14))
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
    minZoom = Math.min((cssW - pad * 2) / (MAP_MAX - MAP_MIN), (cssH - pad * 2) / (MAP_MAX - MAP_MIN))
    if (zoom < minZoom) zoom = minZoom
    clampCam()
    camDirty = true
  }

  // ---- dynamic layer ------------------------------------------------------
  let hits: StoneHit[] = []

  function drawDynamic(): void {
    const g = canvas.getContext('2d')
    if (!g) return
    if (camDirty) {
      renderBase()
      camDirty = false
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, canvas.width, canvas.height)
    g.drawImage(base, 0, 0)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    const s = Math.max(12, Math.min(22, zoom * 12))
    hits = []
    g.textAlign = 'center'
    for (const ws of ALL_WAYSTONES) {
      const x = toX(ws.x)
      const y = toY(ws.z)
      if (x < -30 || x > cssW + 30 || y < -30 || y > cssH + 30) continue
      const attuned = deps.isAttuned(ws.id)
      drawWaystone(g, x, y, s, attuned)
      if (zoom >= 0.42) {
        g.font = `700 ${Math.max(9, s * 0.5)}px ${FONT}`
        g.fillStyle = attuned ? '#1c5660' : 'rgba(58, 47, 34, 0.6)'
        g.fillText(ws.name.replace(' Waystone', ''), x, y + s * 0.95)
      }
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
    // Lift the whole worldmap root above every HUD cluster (gear/chips z<=46)
    // while open — otherwise the top-right buttons float OVER the map and
    // sit exactly on its close button on phones.
    el.parentElement?.classList.add('wm-root--open')
    resize()
    // Start framing the whole continent; the player can dive in from there.
    zoom = minZoom
    camX = 0
    camZ = 0
    camDirty = true
    raf = requestAnimationFrame(loop)
  }

  function close(): void {
    if (!openFlag) return
    openFlag = false
    el.classList.remove('wm-open')
    el.parentElement?.classList.remove('wm-root--open')
    cancelAnimationFrame(raf)
  }

  closeBtn.addEventListener('click', close)
  window.addEventListener('resize', () => {
    if (openFlag) resize()
  })

  // ---- pan / pinch / tap --------------------------------------------------
  interface Finger {
    x: number
    y: number
    startX: number
    startY: number
  }
  const fingers = new Map<number, Finger>()
  let pinchDist = 0
  let dragged = false

  function localXY(e: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId)
    const { x, y } = localXY(e)
    fingers.set(e.pointerId, { x, y, startX: x, startY: y })
    if (fingers.size === 1) dragged = false
    if (fingers.size === 2) {
      const [a, b] = [...fingers.values()]
      pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
    }
  })

  canvas.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId)
    if (!f) {
      // hover cursor (mouse, no button down)
      const { x, y } = localXY(e)
      const h = hitAt(x, y)
      canvas.style.cursor = h?.attuned ? 'pointer' : 'grab'
      return
    }
    const { x, y } = localXY(e)
    const dx = x - f.x
    const dy = y - f.y
    f.x = x
    f.y = y
    if (Math.hypot(x - f.startX, y - f.startY) > TAP_SLOP) dragged = true

    if (fingers.size === 1) {
      camX -= dx / zoom
      camZ -= dy / zoom
      clampCam()
      camDirty = true
    } else if (fingers.size === 2) {
      const [a, b] = [...fingers.values()]
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      const cx = (a!.x + b!.x) / 2
      const cy = (a!.y + b!.y) / 2
      if (pinchDist > 0 && d > 0) setZoom(zoom * (d / pinchDist), cx, cy)
      pinchDist = d
    }
  })

  function endPointer(e: PointerEvent): void {
    const f = fingers.get(e.pointerId)
    fingers.delete(e.pointerId)
    pinchDist = 0
    if (!f) return
    // Clean single-finger tap → waystone travel.
    if (!dragged && fingers.size === 0) {
      const h = hitAt(f.x, f.y)
      if (h?.attuned) deps.requestTravel(h.stoneId)
    }
  }
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      setZoom(zoom * Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top)
    },
    { passive: false }
  )

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
