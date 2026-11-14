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

export interface Joystick {
  /** -1..1, screen-right positive. */
  readonly x: number
  /** -1..1, screen-up positive (push up = move away from camera). */
  readonly y: number
  /** True while a pointer is held on the stick. */
  readonly active: boolean
  dispose(): void
}

const BASE = 112 // px
const KNOB = 48 // px
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
// Mobile ATTACK button (bottom-right twin of the joystick)
// ---------------------------------------------------------------------------

export interface AttackButton {
  dispose(): void
}

const ATK = 84 // px

/**
 * A round ATTACK button in the bottom-right of the #ui overlay, styled to
 * match the joystick (same translucent slate + soft white ring). Fires on
 * pointerdown for zero-latency swings; stopPropagation keeps the camera
 * pinch tracker out of it.
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
    'color:rgba(240,246,255,0.85)',
    'font:bold 14px "Courier New", monospace',
    'letter-spacing:1px',
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
  btn.textContent = 'ATK'

  const onDown = (e: PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    btn.style.background = 'rgba(240,246,255,0.45)'
    btn.style.transform = 'scale(0.92)'
    fire()
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
      btn.remove()
    }
  }
}
