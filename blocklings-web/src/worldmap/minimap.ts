/**
 * Mini-map — a 140px circle in the top-right corner, now a DETAILED layered
 * view of the world around the player. North-fixed, player-centered.
 *
 * Three stacked canvases:
 *   1. terrain    — real ground sampled from the world's surface map (actual
 *                   stamped roads / river / bridges / soil / sand / coast)
 *                   plus biome ground colors, cached per 64-unit tile and
 *                   re-composed as the player moves or zooms.
 *   2. structures — village building footprints as blocks, seeded tree
 *                   clusters as soft blobs, waystone obelisk icons (lit when
 *                   attuned), boss-lair skulls. Redrawn with the terrain.
 *   3. live       — every tick: mobs red, NPCs gold, nodes green, players
 *                   blue, boss skulls, the active pet's paw, and the player
 *                   arrow with a facing cone. Rim + compass N on top.
 *
 * Chrome: current zone name pill at the bottom of the circle, +/- zoom
 * buttons (2 steps, persisted per device). Tapping the circle opens the
 * full map. Self-drives at ~10 Hz while visible.
 */
import type { GameAPI } from '../types'
import { NPCS, regionAt as heartRegionAt } from '../ids'
import { zoneAt } from '../world/zones/registry'
import { surfaceTypeAt, S_GRASS, S_COBBLE, S_RIVER, S_BANK, S_SOIL, S_BRIDGE, S_SAND } from '../world/surface'
import { BUILDINGS, STALL, WELL } from '../world/layout'
import { BIOME_MINI, ALL_WAYSTONES, BOSS_SPOTS } from './data'
import { drawPlayerArrow, drawWaystone, drawSkull, drawPaw, hashStr, rng } from './draw'

/** A dynamic blip supplied by the integrator (world coords). */
export interface WorldmapEntity {
  x: number
  z: number
  kind: 'mob' | 'npc' | 'node' | 'stone' | 'player' | 'boss' | 'pet'
}

export interface Minimap {
  el: HTMLElement
  setVisible(v: boolean): void
  visible(): boolean
}

const SIZE = 140 // css px
const TICK_MS = 100
const ZOOMS = [36, 72] as const // world units from center to rim (in / out)
const ZOOM_KEY = 'blocklings.minimap.zoom'

const TILE = 64 // world units per cached terrain tile
const TILE_CAP = 48 // LRU cap
const TILE_TTL = 6000 // ms before a tile may re-render (zones stream in)
const MOVE_EPS = 2 // world units moved before terrain re-composes
const COMPOSE_MS = 2500 // …or this much time passed (catches streamed zones)

const SEA = '#1f3947'
const SURF_COLOR: Readonly<Record<number, string>> = {
  [S_COBBLE]: '#7d6e52',
  [S_RIVER]: '#2f5d75',
  [S_BANK]: '#4e5a3a',
  [S_SOIL]: '#5a4630',
  [S_BRIDGE]: '#7a5634',
  [S_SAND]: '#6e6448'
}

const DOT: Readonly<Record<string, string>> = {
  mob: '#ff5a4a',
  npc: '#e8c15a',
  node: '#7ed957',
  stone: '#59e0f0',
  player: '#58a6ff'
}

/** Soft tree-blob fills per biome (clusters drawn on the structures layer). */
const BLOB_FILL: Readonly<Record<string, string>> = {
  forest: 'rgba(24, 44, 20, 0.5)',
  cherry: 'rgba(110, 60, 84, 0.5)',
  mushroom: 'rgba(94, 65, 82, 0.5)',
  swamp: 'rgba(30, 42, 24, 0.5)',
  meadow: 'rgba(32, 54, 26, 0.4)',
  savanna: 'rgba(70, 64, 30, 0.4)',
  tundra: 'rgba(48, 64, 54, 0.45)'
}
const BLOB_COUNT: Readonly<Record<string, number>> = {
  forest: 8,
  cherry: 6,
  mushroom: 5,
  swamp: 5,
  meadow: 2,
  savanna: 2,
  tundra: 1
}

interface BiomeRect {
  x0: number
  z0: number
  x1: number
  z1: number
  biome: string
  name: string
}

/** Pure region/zone lookup with a last-hit memo (tile fills are coherent). */
let lastDef: BiomeRect | null = null
function defAt(x: number, z: number): BiomeRect | null {
  const d = lastDef
  if (d && x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return d
  const hit = heartRegionAt(x, z) ?? zoneAt(x, z)
  lastDef = hit
  return hit
}

const rgbCache = new Map<string, readonly [number, number, number]>()
function rgb(hex: string): readonly [number, number, number] {
  let c = rgbCache.get(hex)
  if (!c) {
    c = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
    rgbCache.set(hex, c)
  }
  return c
}

export function createMinimap(
  api: GameAPI,
  deps: {
    getEntities: () => readonly WorldmapEntity[]
    onTap: () => void
    /** Lights waystone icons on the structures layer (wired by the module root). */
    isAttuned?: (stoneId: string) => boolean
  }
): Minimap {
  const el = document.createElement('div')
  el.className = 'wm-mini'

  const tap = document.createElement('button')
  tap.type = 'button'
  tap.className = 'wm-mini-tap'
  tap.setAttribute('aria-label', 'Open world map')
  tap.title = 'World map (M)'
  tap.addEventListener('click', deps.onTap)
  el.appendChild(tap)

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const mkCanvas = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas')
    c.width = SIZE * dpr
    c.height = SIZE * dpr
    tap.appendChild(c)
    const g = c.getContext('2d')
    if (!g) throw new Error('minimap: no 2d context')
    return [c, g]
  }
  const [terrainC, terrainG] = mkCanvas()
  const [structC, structG] = mkCanvas()
  const [, liveG] = mkCanvas()

  // --- zone name pill + zoom buttons ---------------------------------------
  const zoneLabel = document.createElement('div')
  zoneLabel.className = 'wm-mini-zone'
  el.appendChild(zoneLabel)

  let zoomIdx = 0
  try {
    const v = localStorage.getItem(ZOOM_KEY)
    if (v !== null) zoomIdx = Math.min(ZOOMS.length - 1, Math.max(0, parseInt(v, 10) || 0))
  } catch {
    /* non-fatal */
  }

  const zoomWrap = document.createElement('div')
  zoomWrap.className = 'wm-mini-zoom'
  const mkZoom = (txt: string, delta: number, label: string): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = txt
    b.setAttribute('aria-label', label)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      const next = Math.min(ZOOMS.length - 1, Math.max(0, zoomIdx + delta))
      if (next === zoomIdx) return
      zoomIdx = next
      try {
        localStorage.setItem(ZOOM_KEY, String(zoomIdx))
      } catch {
        /* non-fatal */
      }
      composedAt = null // force terrain/structures re-compose
      draw()
    })
    zoomWrap.appendChild(b)
  }
  mkZoom('+', -1, 'Zoom mini-map in')
  mkZoom('−', 1, 'Zoom mini-map out')
  el.appendChild(zoomWrap)

  const C = SIZE / 2
  const R = C - 3

  // ===== terrain tile cache ================================================
  const tiles = new Map<string, { canvas: HTMLCanvasElement; t: number }>()

  function renderTile(tx: number, tz: number): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = TILE
    c.height = TILE
    const g = c.getContext('2d')!
    const img = g.createImageData(TILE, TILE)
    const d = img.data
    const seaRgb = rgb(SEA)
    for (let j = 0; j < TILE; j++) {
      const wz = tz * TILE + j + 0.5
      for (let i = 0; i < TILE; i++) {
        const wx = tx * TILE + i + 0.5
        const s = surfaceTypeAt(wx, wz)
        let col: readonly [number, number, number]
        if (s < 0) {
          col = seaRgb
        } else if (s !== S_GRASS && SURF_COLOR[s]) {
          col = rgb(SURF_COLOR[s]!)
        } else {
          const def = defAt(wx, wz)
          col = rgb(def ? (BIOME_MINI[def.biome] ?? '#2c2f26') : '#2c2f26')
        }
        const o = (j * TILE + i) * 4
        d[o] = col[0]
        d[o + 1] = col[1]
        d[o + 2] = col[2]
        d[o + 3] = 255
      }
    }
    g.putImageData(img, 0, 0)
    return c
  }

  /** Get a tile; refresh stale ones within a small per-compose budget. */
  function getTile(tx: number, tz: number, budget: { n: number }): HTMLCanvasElement {
    const key = tx + ',' + tz
    const e = tiles.get(key)
    const now = performance.now()
    if (e && (now - e.t < TILE_TTL || budget.n <= 0)) {
      tiles.delete(key) // LRU refresh
      tiles.set(key, e)
      return e.canvas
    }
    if (e) budget.n--
    const canvas = renderTile(tx, tz)
    tiles.delete(key)
    tiles.set(key, { canvas, t: now })
    while (tiles.size > TILE_CAP) {
      const oldest = tiles.keys().next().value
      if (oldest === undefined) break
      tiles.delete(oldest)
    }
    return canvas
  }

  /**
   * The circle mask is CSS (border-radius + overflow hidden on the tap
   * button), so layers draw the full square and the cached terrain /
   * structures canvases can be shifted by CSS transform between composes
   * without revealing clipped-out crescents at the rim.
   */
  function clearLayer(g: CanvasRenderingContext2D): void {
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, SIZE, SIZE)
  }

  // ===== terrain + structures compose (on move / zoom / timer) =============
  let composedAt: { x: number; z: number; t: number } | null = null

  function compose(px: number, pz: number): void {
    const range = ZOOMS[zoomIdx]!
    const s = (R - 2) / range // css px per world unit
    // Cover the square (corners reach range*sqrt2) + a shift margin.
    const ext = range * 1.45 + MOVE_EPS * 2

    // --- terrain: blit cached tiles
    clearLayer(terrainG)
    terrainG.imageSmoothingEnabled = true
    const budget = { n: 2 }
    const tx0 = Math.floor((px - ext) / TILE)
    const tx1 = Math.floor((px + ext) / TILE)
    const tz0 = Math.floor((pz - ext) / TILE)
    const tz1 = Math.floor((pz + ext) / TILE)
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        terrainG.drawImage(
          getTile(tx, tz, budget),
          C + (tx * TILE - px) * s,
          C + (tz * TILE - pz) * s,
          TILE * s,
          TILE * s
        )
      }
    }
    // --- structures
    clearLayer(structG)
    const toX = (wx: number): number => C + (wx - px) * s
    const toY = (wz: number): number => C + (wz - pz) * s
    const inRange = (wx: number, wz: number, pad = 8): boolean =>
      Math.hypot(wx - px, wz - pz) <= ext + pad

    // tree clusters: seeded soft blobs per tile, biome-tinted, off-road only
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const cx = tx * TILE + TILE / 2
        const cz = tz * TILE + TILE / 2
        const def = defAt(cx, cz)
        if (!def) continue
        const count = BLOB_COUNT[def.biome] ?? 0
        if (!count) continue
        const fill = BLOB_FILL[def.biome] ?? 'rgba(24, 44, 20, 0.45)'
        const r = rng(hashStr(tx + 't' + tz))
        structG.fillStyle = fill
        for (let k = 0; k < count; k++) {
          const wx = tx * TILE + r() * TILE
          const wz = tz * TILE + r() * TILE
          const rad = (2 + r() * 2.5) * s
          if (!inRange(wx, wz)) continue
          if (surfaceTypeAt(wx, wz) !== S_GRASS) continue // keep roads/river clear
          const x = toX(wx)
          const y = toY(wz)
          structG.beginPath()
          structG.arc(x, y, rad, 0, Math.PI * 2)
          structG.arc(x + rad * 0.7, y + rad * 0.3, rad * 0.75, 0, Math.PI * 2)
          structG.arc(x - rad * 0.6, y + rad * 0.35, rad * 0.65, 0, Math.PI * 2)
          structG.fill()
        }
      }
    }

    // village building footprints as flat blocks with ink outlines
    structG.strokeStyle = '#2b2420'
    structG.lineWidth = 1
    const block = (x0: number, z0: number, w: number, dd: number, fill: string): void => {
      if (!inRange(x0 + w / 2, z0 + dd / 2)) return
      structG.fillStyle = fill
      const x = toX(x0)
      const y = toY(z0)
      structG.fillRect(x, y, w * s, dd * s)
      structG.strokeRect(x, y, w * s, dd * s)
    }
    for (const b of BUILDINGS) block(b.x0, b.z0, b.w, b.d, '#9b8b70')
    block(STALL.x0, STALL.z0, STALL.w, STALL.d, '#a6713f')
    block(WELL.x0, WELL.z0, WELL.w, WELL.d, '#8fa8b0')

    // boss lairs + waystone obelisks (lit when attuned)
    for (const id of Object.keys(BOSS_SPOTS)) {
      const p = BOSS_SPOTS[id]!
      if (inRange(p.x, p.z)) drawSkull(structG, toX(p.x), toY(p.z), 9)
    }
    for (const w of ALL_WAYSTONES) {
      if (inRange(w.x, w.z)) drawWaystone(structG, toX(w.x), toY(w.z), 9, deps.isAttuned?.(w.id) ?? false)
    }

    composedAt = { x: px, z: pz, t: performance.now() }
  }

  // ===== live layer (every tick) ===========================================
  let lastZone = ''

  function draw(): void {
    const p = api.player
    const px = p.pos.x
    const pz = p.pos.z
    const range = ZOOMS[zoomIdx]!
    const s = (R - 2) / range

    let c = composedAt
    if (!c || Math.hypot(px - c.x, pz - c.z) >= MOVE_EPS || performance.now() - c.t > COMPOSE_MS) {
      compose(px, pz)
      c = composedAt!
    }
    // Keep the cached layers pixel-aligned with the live blips between
    // composes by shifting their canvases (CSS circle mask hides edges).
    const shift = `translate(${((c.x - px) * s).toFixed(2)}px, ${((c.z - pz) * s).toFixed(2)}px)`
    terrainC.style.transform = shift
    structC.style.transform = shift

    clearLayer(liveG)
    const toX = (wx: number): number => C + (wx - px) * s
    const toY = (wz: number): number => C + (wz - pz) * s

    // facing cone (view direction wedge under the arrow)
    const ang = Math.atan2(Math.cos(p.facing), Math.sin(p.facing))
    liveG.fillStyle = 'rgba(232, 193, 90, 0.16)'
    liveG.beginPath()
    liveG.moveTo(C, C)
    liveG.arc(C, C, Math.min(26, R - 6), ang - 0.5, ang + 0.5)
    liveG.closePath()
    liveG.fill()

    // blips
    const dot = (wx: number, wz: number, color: string, r = 2.6): void => {
      if (Math.hypot(wx - px, wz - pz) > range) return
      liveG.fillStyle = color
      liveG.beginPath()
      liveG.arc(toX(wx), toY(wz), r, 0, Math.PI * 2)
      liveG.fill()
    }
    for (const n of NPCS) dot(n.x, n.z, DOT.npc!)
    for (const e of deps.getEntities()) {
      if (Math.hypot(e.x - px, e.z - pz) > range) continue
      if (e.kind === 'boss') drawSkull(liveG, toX(e.x), toY(e.z), 10)
      else if (e.kind === 'pet') drawPaw(liveG, toX(e.x), toY(e.z), 8)
      else if (e.kind === 'stone') dot(e.x, e.z, DOT.stone!, 3.4)
      else if (e.kind === 'player') dot(e.x, e.z, DOT.player!, 3)
      else dot(e.x, e.z, DOT[e.kind] ?? '#ffffff')
    }

    // player arrow (map stays north-up; arrow shows facing)
    drawPlayerArrow(liveG, C, C, 6, p.facing)

    // rim + compass N
    liveG.strokeStyle = 'rgba(212, 175, 55, 0.55)'
    liveG.lineWidth = 2
    liveG.beginPath()
    liveG.arc(C, C, R, 0, Math.PI * 2)
    liveG.stroke()
    liveG.strokeStyle = 'rgba(13, 15, 22, 0.8)'
    liveG.lineWidth = 1
    liveG.beginPath()
    liveG.arc(C, C, R - 1.8, 0, Math.PI * 2)
    liveG.stroke()
    liveG.fillStyle = '#e8c15a'
    liveG.font = '700 10px "Trebuchet MS", Verdana, sans-serif'
    liveG.textAlign = 'center'
    liveG.fillText('N', C, 12)

    // current zone name pill
    const def = defAt(px, pz)
    const name = def?.name ?? 'The Open Sea'
    if (name !== lastZone) {
      lastZone = name
      zoneLabel.textContent = name
    }
  }

  let vis = true
  const timer = window.setInterval(() => {
    if (vis) draw()
  }, TICK_MS)
  void timer // minimap lives for the page's lifetime
  draw()

  return {
    el,
    setVisible(v: boolean): void {
      vis = v
    },
    visible: () => vis
  }
}
