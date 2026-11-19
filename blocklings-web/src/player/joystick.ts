/**
 * Blocklings — mobile touch joystick.
 *
 * A fixed thumbstick in the bottom-left of the #ui overlay: press
 * anywhere on the base, drag the knob, release to stop. Pure pointer
 * events (works with mouse too, handy for testing). The overlay has
 * pointer-events: none, so the joystick opts itself back in.
 *
 * Handlers stopPropagation so the camera pinch-zoom tracker on window
 * never sees joystick touches.
 */
import { actionContext, type ActionIcon, type ActionOption } from '../action/context'

export interface Joystick {
  /** -1..1, screen-right positive. */
  readonly x: number
  /** -1..1, screen-up positive (push up = move away from camera). */
  readonly y: number
  /** True while a pointer is held on the stick. */
  readonly active: boolean
  dispose(): void
}

const BASE = 94 // px
const KNOB = 42 // px
const RANGE = (BASE - KNOB) / 2 // knob travel radius in px

export function createJoystick(root: HTMLElement): Joystick {
  const base = document.createElement('div')
  base.style.cssText = [
    'position:fixed',
    'left:max(18px, env(safe-area-inset-left))',
    'bottom:max(18px, env(safe-area-inset-bottom))',
    `width:${BASE}px`,
    `height:${BASE}px`,
    'border-radius:50%',
    'background:rgba(16,22,34,0.35)',
    'border:2px solid rgba(255,255,255,0.25)',
    'pointer-events:auto',
    'touch-action:none',
    'z-index:40',
    'user-select:none',
    '-webkit-user-select:none'
  ].join(';')

  const knob = document.createElement('div')
  knob.style.cssText = [
    'position:absolute',
    `left:${(BASE - KNOB) / 2 - 2}px`,
    `top:${(BASE - KNOB) / 2 - 2}px`,
    `width:${KNOB}px`,
    `height:${KNOB}px`,
    'border-radius:50%',
    'background:rgba(240,246,255,0.55)',
    'border:2px solid rgba(255,255,255,0.6)',
    'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
    'will-change:transform',
    'pointer-events:none'
  ].join(';')
  base.appendChild(knob)
  root.appendChild(base)

  let x = 0
  let y = 0
  let active = false
  let pointerId: number | null = null

  function setFromEvent(e: PointerEvent): void {
    const r = base.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    let dx = e.clientX - cx
    let dy = e.clientY - cy
    const len = Math.hypot(dx, dy)
    if (len > RANGE) {
      dx = (dx / len) * RANGE
      dy = (dy / len) * RANGE
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`
    x = dx / RANGE
    y = -dy / RANGE // screen up = +forward
  }

  function reset(): void {
    active = false
    pointerId = null
    x = 0
    y = 0
    knob.style.transform = 'translate(0px, 0px)'
  }

  const onDown = (e: PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    pointerId = e.pointerId
    active = true
    base.setPointerCapture(e.pointerId)
    setFromEvent(e)
  }
  const onMove = (e: PointerEvent): void => {
    if (!active || e.pointerId !== pointerId) return
    e.preventDefault()
    e.stopPropagation()
    setFromEvent(e)
  }
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    e.stopPropagation()
    reset()
  }

  base.addEventListener('pointerdown', onDown)
  base.addEventListener('pointermove', onMove)
  base.addEventListener('pointerup', onUp)
  base.addEventListener('pointercancel', onUp)

  return {
    get x() {
      return x
    },
    get y() {
      return y
    },
    get active() {
      return active
    },
    dispose() {
      base.remove()
    }
  }
}

// ---------------------------------------------------------------------------
// Mobile INTERACT button (bottom-right twin of the joystick)
// ---------------------------------------------------------------------------

export interface AttackButton {
  dispose(): void
}

const ATK = 68 // px

/**
 * Crisp white inline-SVG glyphs for each action icon. Simple geometric /
 * voxel-ish line art on a 24-grid; `currentColor` lets the button tint +
 * dim them. One <svg> string per ActionIcon, swapped into the button as the
 * nearest interactable changes.
 */
const svg = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" ` +
  `stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`

const ICON_SVG: Record<ActionIcon, string> = {
  // blade up-right, pointed tip corner, little crossguard + pommel
  sword: svg('<path d="M20 4l-9 9"/><path d="M15 4h5v5"/><path d="M4 20l5-5 2 2-5 5H4v-2z"/><path d="M9.5 14.5l2 2"/>'),
  // handle + rounded axe head
  axe: svg('<path d="M5 19L14.5 9.5"/><path d="M12.5 4a7 7 0 0 1 6 6l-4.3 1.2-2.9-2.9z" fill="currentColor" stroke="none"/>'),
  // vertical handle + curved double-point head across the top
  pick: svg('<path d="M12 8v13"/><path d="M3 9a18 18 0 0 1 18 0"/>'),
  // eyelet + J-curve + barb (a fishing hook)
  hook: svg('<circle cx="14" cy="4.5" r="1.3" fill="currentColor" stroke="none"/><path d="M14 6v7a4 4 0 0 1-8 0"/><path d="M6 13l-1.6 1.8M6 13l1.9 1"/>'),
  // short handle + crescent blade
  sickle: svg('<path d="M5 20l3.5-3.5"/><path d="M8.5 16.5A9 9 0 0 0 19 6 13 13 0 0 1 8.5 16.5z" fill="currentColor" stroke="none"/>'),
  // open grabbing hand
  hand: svg('<path d="M8 12V6.5a1.4 1.4 0 0 1 2.8 0V11m0 0V5a1.4 1.4 0 0 1 2.8 0v6m0-.5V6a1.4 1.4 0 0 1 2.8 0v6.5a6.5 6.5 0 0 1-6.5 6.5A5.5 5.5 0 0 1 6 16l-1.8-2.7a1.5 1.5 0 0 1 2.4-1.8L8 13"/>'),
  // speech bubble with a tail
  talk: svg('<path d="M4 5h16v10H9l-4 4v-4H4z"/>'),
  // swirl portal (two arcs spiralling in)
  portal: svg('<path d="M18 6.5A8 8 0 1 0 19.5 12"/><path d="M15 9.5A4 4 0 1 0 15.8 13"/>'),
  // anvil body + base + horn
  anvil: svg('<path d="M5 9h11a4 4 0 0 1-4 4H9l-1 3H6l1-3a3 3 0 0 1-2-4z" fill="currentColor" stroke="none"/><path d="M7 18h6" /><path d="M16.5 7.5v3"/>'),
  // doorway + knob
  door: svg('<rect x="6" y="3" width="12" height="18" rx="1"/><circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none"/>')
}

/**
 * A round context-aware INTERACT button in the bottom-right of the #ui
 * overlay, styled to match the joystick (same translucent slate + soft
 * white ring). Each frame it reads `actionContext.resolve()` and swaps in
 * that option's glyph; with nothing nearby it shows a DIMMED sword (tapping
 * still swings at air). Fires on pointerdown for zero-latency; the tapped
 * action is whatever's resolved at that instant, else the default attack.
 * stopPropagation keeps the camera pinch tracker out of it.
 */
export function createAttackButton(root: HTMLElement, fire: () => void): AttackButton {
  const btn = document.createElement('div')
  btn.style.cssText = [
    'position:fixed',
    'right:max(18px, env(safe-area-inset-right))',
    'bottom:max(32px, env(safe-area-inset-bottom))',
    `width:${ATK}px`,
    `height:${ATK}px`,
    'border-radius:50%',
    'background:rgba(16,22,34,0.35)',
    'border:2px solid rgba(255,255,255,0.25)',
    'color:#f0f6ff',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'pointer-events:auto',
    'touch-action:none',
    'z-index:40',
    'user-select:none',
    '-webkit-user-select:none',
    '-webkit-tap-highlight-color:transparent'
  ].join(';')

  /** Fallback when nothing is nearby: a dim sword that still attacks air. */
  const defaultAttackOption: ActionOption = {
    priority: 99,
    icon: 'sword',
    label: 'Attack',
    invoke: fire
  }

  let shownIcon: ActionIcon | null = null
  let shownDim: boolean | null = null
  const renderIcon = (icon: ActionIcon, dim: boolean): void => {
    if (icon !== shownIcon) {
      btn.innerHTML = ICON_SVG[icon]
      shownIcon = icon
    }
    if (dim !== shownDim) {
      btn.style.opacity = dim ? '0.5' : '1'
      shownDim = dim
    }
  }

  // Light self-driven rAF: re-read the resolved action + swap the glyph.
  let raf = 0
  const frame = (): void => {
    raf = requestAnimationFrame(frame)
    const opt = actionContext.resolve()
    if (opt) renderIcon(opt.icon, false)
    else renderIcon(defaultAttackOption.icon, true)
  }
  raf = requestAnimationFrame(frame)

  const onDown = (e: PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    btn.style.background = 'rgba(240,246,255,0.45)'
    btn.style.transform = 'scale(0.92)'
    ;(actionContext.resolve() ?? defaultAttackOption).invoke()
  }
  const onUp = (e: PointerEvent): void => {
    e.stopPropagation()
    btn.style.background = 'rgba(16,22,34,0.35)'
    btn.style.transform = 'scale(1)'
  }
  btn.addEventListener('pointerdown', onDown)
  btn.addEventListener('pointerup', onUp)
  btn.addEventListener('pointercancel', onUp)
  btn.addEventListener('pointerleave', onUp)
  root.appendChild(btn)

  return {
    dispose() {
      cancelAnimationFrame(raf)
      btn.remove()
    }
  }
}
