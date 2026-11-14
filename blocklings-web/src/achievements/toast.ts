/**
 * Achievement toast — gold banner that slides down from the top, holds ~3s,
 * slides back out. Unlocks are queued so simultaneous achievements parade
 * one at a time instead of stacking into a wall of glory.
 *
 * Audio: the existing 'level-up' fanfare recipe (allowed leaf import
 * audio/engine) — triumphant, already shipped, zero new assets.
 */
import { audio } from '../audio/engine'
import type { AchDef } from './defs'

const HOLD_MS = 3000
const SLIDE_MS = 420

const TROPHY_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="currentColor">' +
  '<path d="M6 3h12v2h3v3c0 2.6-2 4.7-4.6 5-0.7 1.6-2 2.8-3.4 3.3V19h3.5v2h-9v-2H11v-2.7c-1.5-0.5-2.7-1.7-3.4-3.3C5 12.7 3 10.6 3 8V5h3V3Zm-1 4v1c0 1.3 0.8 2.4 2 2.8V7H5Zm14 0h-2v3.8c1.2-0.4 2-1.5 2-2.8V7Z"/></svg>'

export interface ToastHost {
  push(def: AchDef): void
}

export function createToasts(mount: HTMLElement): ToastHost {
  const queue: AchDef[] = []
  let busy = false

  function show(def: AchDef): void {
    busy = true
    const toast = document.createElement('div')
    toast.className = 'ach-toast'
    toast.setAttribute('role', 'status')
    toast.innerHTML =
      `<span class="ach-toast-cup">${TROPHY_SVG}</span>` +
      '<span class="ach-toast-body">' +
      '<span class="ach-toast-kicker">Achievement unlocked</span>' +
      `<span class="ach-toast-name"></span>` +
      '</span>'
    const nameEl = toast.querySelector('.ach-toast-name')
    if (nameEl) nameEl.textContent = def.name
    mount.appendChild(toast)

    audio.sfx.play('level-up', { vel: 0.85, pitch: 1.12 })

    // slide in (class on next frame so the transition runs)
    requestAnimationFrame(() => toast.classList.add('ach-toast-in'))

    window.setTimeout(() => {
      toast.classList.remove('ach-toast-in')
      window.setTimeout(() => {
        toast.remove()
        const next = queue.shift()
        if (next) show(next)
        else busy = false
      }, SLIDE_MS)
    }, HOLD_MS)
  }

  return {
    push(def: AchDef): void {
      if (busy) queue.push(def)
      else show(def)
    },
  }
}
