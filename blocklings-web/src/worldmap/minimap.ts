/**
 * Mini-map — a ~140px circle in the top-right corner showing the 60-unit
 * slice of the world around the player. North-fixed (never rotates),
 * player-centered; the gold arrow in the middle shows facing.
 *
 * Markers: mobs red, NPCs gold, resource nodes green, waystones cyan.
 * Static markers (NPC anchors, waystones) come from ids.ts; dynamic ones
 * (live mobs, gather nodes) from an integrator-wired entity source.
 *
 * Self-drives at ~10 Hz while visible; tapping the circle opens the full map.
 */
import type { GameAPI } from '../types'
import { NPCS, WAYSTONES, REGIONS, regionAt } from '../ids'
import { ROUTES, BIOME_MINI, RIVER_CENTER_X, RIVER_WIDTH } from './data'
import { smoothPath, drawPlayerArrow } from './draw'

/** A dynamic blip supplied by the integrator (world coords). */
export interface WorldmapEntity {
  x: number
  z: number
  kind: 'mob' | 'npc' | 'node' | 'stone'
}

export interface Minimap {
  el: HTMLElement
  setVisible(v: boolean): void
  visible(): boolean
}

const SIZE = 140 // css px
const RANGE = 60 // world units shown from center to rim
const TICK_MS = 100

const DOT: Readonly<Record<WorldmapEntity['kind'], string>> = {
  mob: '#ff5a4a',
  npc: '#e8c15a',
  node: '#7ed957',
  stone: '#59e0f0'
}

export function createMinimap(
  api: GameAPI,
  deps: {
    getEntities: () => readonly WorldmapEntity[]
    onTap: () => void
  }
): Minimap {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'wm-mini'
  el.setAttribute('aria-label', 'Open world map')
  el.title = 'World map (M)'
  el.addEventListener('click', deps.onTap)

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const canvas = document.createElement('canvas')
  canvas.width = SIZE * dpr
  canvas.height = SIZE * dpr
  el.appendChild(canvas)

  const C = SIZE / 2
  const R = C - 3
  const s = (R - 4) / RANGE // css px per world unit

  function draw(): void {
    const g = canvas.getContext('2d')
    if (!g) return
    const p = api.player
    const px = p.pos.x
    const pz = p.pos.z
    const toX = (wx: number): number => C + (wx - px) * s
    const toY = (wz: number): number => C + (wz - pz) * s

    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, SIZE, SIZE)

    // Clip everything to the circle.
    g.save()
    g.beginPath()
    g.arc(C, C, R, 0, Math.PI * 2)
    g.clip()

    // Ground: current region's biome shade as the base, then nearby region
    // rects on top so borders show when standing near one.
    const here = regionAt(px, pz)
    g.fillStyle = here ? (BIOME_MINI[here.biome] ?? '#2c2f26') : '#1a1c22'
    g.fillRect(0, 0, SIZE, SIZE)
    for (const reg of REGIONS) {
      if (reg === here) continue
      const x0 = toX(reg.x0)
      const y0 = toY(reg.z0)
      const x1 = toX(reg.x1)
      const y1 = toY(reg.z1)
      if (x1 < 0 || x0 > SIZE || y1 < 0 || y0 > SIZE) continue
      g.fillStyle = BIOME_MINI[reg.biome] ?? '#2c2f26'
      g.fillRect(x0, y0, x1 - x0, y1 - y0)
    }

    // River band (vertical, centered on RIVER_CENTER_X).
    const rx0 = toX(RIVER_CENTER_X - RIVER_WIDTH / 2)
    const rx1 = toX(RIVER_CENTER_X + RIVER_WIDTH / 2)
    if (rx1 > 0 && rx0 < SIZE) {
      g.fillStyle = '#2f5d75'
      g.fillRect(rx0, 0, rx1 - rx0, SIZE)
    }

    // Roads: thin dashed parchment-colored threads.
    g.strokeStyle = 'rgba(201, 178, 122, 0.55)'
    g.lineWidth = 1.5
    g.setLineDash([2, 3])
    for (const route of ROUTES) {
      const pts = smoothPath(route, 4)
      g.beginPath()
      let started = false
      for (const pt of pts) {
        if (Math.hypot(pt.x - px, pt.z - pz) > RANGE + 10) {
          started = false
          continue
        }
        const x = toX(pt.x)
        const y = toY(pt.z)
        if (!started) {
          g.moveTo(x, y)
          started = true
        } else g.lineTo(x, y)
      }
      g.stroke()
    }
    g.setLineDash([])

    // Markers.
    const dot = (wx: number, wz: number, color: string, r = 2.6): void => {
      if (Math.hypot(wx - px, wz - pz) > RANGE) return
      g.fillStyle = color
      g.beginPath()
      g.arc(toX(wx), toY(wz), r, 0, Math.PI * 2)
      g.fill()
    }
    // Static anchors from ids.ts.
    for (const n of NPCS) dot(n.x, n.z, DOT.npc)
    for (const w of WAYSTONES) dot(w.x, w.z, DOT.stone, 3.4)
    // Live entities from the wired source.
    for (const e of deps.getEntities()) dot(e.x, e.z, DOT[e.kind])

    // Player: centered gold-edged arrow showing facing (map stays north-up).
    drawPlayerArrow(g, C, C, 6, api.player.facing)
    g.restore()

    // Rim + north marker.
    g.strokeStyle = 'rgba(212, 175, 55, 0.55)'
    g.lineWidth = 2
    g.beginPath()
    g.arc(C, C, R, 0, Math.PI * 2)
    g.stroke()
    g.strokeStyle = 'rgba(13, 15, 22, 0.8)'
    g.lineWidth = 1
    g.beginPath()
    g.arc(C, C, R - 1.8, 0, Math.PI * 2)
    g.stroke()
    g.fillStyle = '#e8c15a'
    g.font = '700 10px "Trebuchet MS", Verdana, sans-serif'
    g.textAlign = 'center'
    g.fillText('N', C, 12)
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
