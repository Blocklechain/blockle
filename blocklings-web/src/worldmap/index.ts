/**
 * Worldmap module root — wires the full-screen map panel + mini-map into #ui.
 *
 * Integrator wiring after init:
 *   const map = initWorldmap(api)
 *   map.setAttuned(saveStones)              // initial attuned waystones
 *   map.setRequestTravel(ws.travelTo)       // waystones module's travel flow
 *   map.setEntitySource(() => blips)        // live mob/node blips (mini-map)
 *
 * Listens: 'waystone:attuned' (lights icons), 'waystone:traveled' (closes
 * the panel after a successful hop). Opens via the HUD map button, tapping
 * the mini-map, or the M key; Esc closes. Mini-map visibility is a device
 * preference (localStorage) exposed through setMinimapVisible for the
 * settings panel — also published as window.blocklingsSetMinimap so the HUD
 * can discover it the same way it discovers the quality hook.
 */
import type { GameAPI } from '../types'
import { events } from '../events'
import { createMapPanel } from './panel'
import { createMinimap, type WorldmapEntity } from './minimap'
import './style.css'

export type { WorldmapEntity }

export interface WorldmapModule {
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
  /** Seed the attuned-waystone set from the loaded save. */
  setAttuned(stoneIds: readonly string[]): void
  /** Wire the teleport flow: called with a stone id when a lit icon is tapped. */
  setRequestTravel(fn: (stoneId: string) => void): void
  /** Wire live mini-map blips (mobs, gather nodes...). */
  setEntitySource(fn: () => readonly WorldmapEntity[]): void
  /** Settings hook: show/hide the mini-map (persisted per device). */
  setMinimapVisible(v: boolean): void
  minimapVisible(): boolean
}

/** Window-global hook published for the HUD settings panel (duck-typed). */
interface WmGlobals {
  blocklingsSetMinimap?: (visible: boolean) => void
}

const MINI_KEY = 'blocklings.minimap.on'

/** Folded-map glyph for the HUD button (flat SVG, no emoji). */
const MAP_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
  '<path fill="currentColor" d="M9 3 3.6 4.8a1 1 0 0 0-.6.9v13.6a.7.7 0 0 0 .9.7L9 18.3l6 2.7 5.4-1.8a1 1 0 0 0 .6-.9V4.7a.7.7 0 0 0-.9-.7L15 5.7 9 3Zm0 2.2 6 2.7v10.9l-6-2.7V5.2Z"/></svg>'

export function initWorldmap(api: GameAPI): WorldmapModule {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  // ---- wired state --------------------------------------------------------
  const attuned = new Set<string>()
  let requestTravel: (stoneId: string) => void = () => {
    events.emit('chat:system', { text: 'The waystone hums, but nothing happens. Spooky.' })
  }
  let entitySource: () => readonly WorldmapEntity[] = () => []

  // ---- DOM ----------------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'wm-root'

  const panel = createMapPanel(api, {
    isAttuned: (id) => attuned.has(id),
    requestTravel: (id) => requestTravel(id)
  })

  const mini = createMinimap(api, {
    getEntities: () => entitySource(),
    onTap: () => panel.open(),
    isAttuned: (id) => attuned.has(id)
  })

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'wm-btn'
  btn.setAttribute('aria-label', 'World map')
  btn.title = 'World map (M)'
  btn.innerHTML = MAP_SVG
  btn.addEventListener('click', () => panel.toggle())

  root.appendChild(mini.el)
  root.appendChild(btn)
  root.appendChild(panel.el)
  uiMount.appendChild(root)

  // ---- mini-map visibility preference ------------------------------------
  function applyMini(v: boolean): void {
    mini.setVisible(v)
    root.classList.toggle('wm-nomini', !v)
    try {
      localStorage.setItem(MINI_KEY, v ? '1' : '0')
    } catch {
      /* non-fatal */
    }
  }
  let miniOn = true
  try {
    miniOn = localStorage.getItem(MINI_KEY) !== '0'
  } catch {
    /* non-fatal */
  }
  applyMini(miniOn)
  ;(window as unknown as WmGlobals).blocklingsSetMinimap = (v) => applyMini(v)

  // ---- keyboard -----------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    const typing =
      !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (typing || e.defaultPrevented) return
    if (e.key === 'm' || e.key === 'M') {
      panel.toggle()
      e.preventDefault()
    } else if (e.key === 'Escape' && panel.isOpen()) {
      panel.close()
      e.preventDefault()
    }
  })

  // ---- bus ----------------------------------------------------------------
  events.on('waystone:attuned', ({ stoneId }) => {
    attuned.add(stoneId)
  })
  events.on('waystone:traveled', () => panel.close())

  return {
    open: panel.open,
    close: panel.close,
    toggle: panel.toggle,
    isOpen: panel.isOpen,
    setAttuned(stoneIds: readonly string[]): void {
      attuned.clear()
      for (const id of stoneIds) attuned.add(id)
    },
    setRequestTravel(fn: (stoneId: string) => void): void {
      requestTravel = fn
    },
    setEntitySource(fn: () => readonly WorldmapEntity[]): void {
      entitySource = fn
    },
    setMinimapVisible(v: boolean): void {
      applyMini(v)
    },
    minimapVisible: () => mini.visible()
  }
}
