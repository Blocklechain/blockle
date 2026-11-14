/**
 * Touch diagnostic monitor — TEMPORARY field instrument.
 *
 * Auto-enables ONLY inside the iOS shell (detected via the injected
 * window.blocklingsIAP bridge) or with ?debug=touch. Shows a live strip of
 * the last touch/pointer/click events with their deepest hit element, so a
 * single user screenshot tells us exactly where taps die.
 */
export function initTouchMonitor(): void {
  // The shell injects its bridge AFTER page load — poll briefly before deciding.
  const forced = location.search.includes('debug=touch')
  let tries = 0
  const gate = (): void => {
    if ('blocklingsIAP' in window || forced) {
      arm()
    } else if (++tries < 25) {
      setTimeout(gate, 250)
    }
  }
  gate()
}

function arm(): void {

  const strip = document.createElement('div')
  strip.style.cssText =
    'position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;z-index:99999;' +
    'background:rgba(0,0,0,.78);color:#8f8;font:10px/1.35 monospace;' +
    'padding:4px 6px;pointer-events:none;white-space:pre;max-height:112px;overflow:hidden'
  strip.textContent = 'touchmon armed — tap things'
  document.body.appendChild(strip)

  const lines: string[] = []
  const push = (s: string): void => {
    lines.unshift(s)
    if (lines.length > 7) lines.pop()
    strip.textContent = lines.join('\n')
  }

  const describe = (el: Element | null): string => {
    if (!el) return 'null'
    const cls = (el as HTMLElement).className
    const c = typeof cls === 'string' && cls ? '.' + cls.split(' ')[0] : ''
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${c}`
  }

  const log = (ev: Event): void => {
    let x = -1
    let y = -1
    if (ev instanceof PointerEvent || ev instanceof MouseEvent) {
      x = Math.round((ev as MouseEvent).clientX)
      y = Math.round((ev as MouseEvent).clientY)
    } else if (ev instanceof TouchEvent && ev.touches[0]) {
      x = Math.round(ev.touches[0].clientX)
      y = Math.round(ev.touches[0].clientY)
    }
    const hit = x >= 0 ? document.elementFromPoint(x, y) : null
    const pe = hit ? getComputedStyle(hit).pointerEvents : '-'
    push(
      `${ev.type} @${x},${y} tgt=${describe(ev.target as Element)} hit=${describe(hit)} pe=${pe}${ev.defaultPrevented ? ' PREVENTED' : ''}`
    )
  }

  for (const t of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) {
    window.addEventListener(t, log, { capture: true, passive: true })
  }
  push(`ua=${navigator.userAgent.slice(0, 70)}`)
  push(`coarse=${matchMedia('(pointer: coarse)').matches} touch=${'ontouchstart' in window}`)
}
