/**
 * Achievements panel — HUD trophy button (bottom-right stack) + a centered
 * dialog: category sections, locked/unlocked cards, progress bars for the
 * counter achievements, unlock dates, and the legally-required disclosure
 * that the only reward is glory (economy law, but make it funny).
 */
import { ACHIEVEMENTS, CATEGORY_LABELS, type AchCategory, type AchDef } from './defs'
import type { AchEngine } from './engine'

const TROPHY_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">' +
  '<path d="M6 3h12v2h3v3c0 2.6-2 4.7-4.6 5-0.7 1.6-2 2.8-3.4 3.3V19h3.5v2h-9v-2H11v-2.7c-1.5-0.5-2.7-1.7-3.4-3.3C5 12.7 3 10.6 3 8V5h3V3Zm-1 4v1c0 1.3 0.8 2.4 2 2.8V7H5Zm14 0h-2v3.8c1.2-0.4 2-1.5 2-2.8V7Z"/></svg>'

const CATEGORY_ORDER: readonly AchCategory[] = [
  'combat', 'exploration', 'gathering', 'wealth', 'pets', 'social', 'quests',
]

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

export interface AchPanel {
  open(): void
  refresh(): void
  flashButton(): void
}

export function createPanel(mount: HTMLElement, engine: AchEngine): AchPanel {
  // -- trophy button (bottom-right stack; positions arbitrated in css) ------
  const btn = el('button', 'ach-btn')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Achievements')
  btn.innerHTML = TROPHY_SVG
  btn.appendChild(el('span', 'ach-btn-label', 'Feats'))

  // -- centered panel -------------------------------------------------------
  const panel = el('div', 'ach-panel')
  panel.style.display = 'none'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Achievements')

  const head = el('div', 'ach-head')
  head.appendChild(el('span', 'ach-title', 'Achievements'))
  const countEl = el('span', 'ach-count', '')
  head.appendChild(countEl)
  const closeBtn = el('button', 'ach-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close achievements')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  panel.appendChild(
    el('div', 'ach-lawyer',
      'Rewards: glory. Pure, uncut glory. The economy committee was very firm about this.')
  )

  const body = el('div', 'ach-body')
  panel.appendChild(body)

  // -------------------------------------------------------------------------

  function card(def: AchDef, progress: number, unlockedAt: number | undefined): HTMLElement {
    const done = unlockedAt !== undefined
    const c = el('div', `ach-card${done ? ' ach-card-done' : ''}`)

    const top = el('div', 'ach-card-top')
    const cup = el('span', 'ach-card-cup')
    cup.innerHTML = TROPHY_SVG
    top.appendChild(cup)
    const names = el('div', 'ach-card-names')
    names.appendChild(el('div', 'ach-card-name', def.name))
    names.appendChild(el('div', 'ach-card-desc', def.desc))
    top.appendChild(names)
    c.appendChild(top)

    if (done) {
      const when = new Date(unlockedAt)
      c.appendChild(
        el('div', 'ach-card-date', `Unlocked ${when.toLocaleDateString()} — still riding the high.`)
      )
    } else if (def.goal > 1) {
      const cur = Math.min(def.goal, Math.max(0, Math.floor(progress)))
      const bar = el('div', 'ach-bar')
      const fill = el('div', 'ach-bar-fill')
      fill.style.width = `${((cur / def.goal) * 100).toFixed(1)}%`
      bar.appendChild(fill)
      bar.appendChild(el('span', 'ach-bar-text', `${cur.toLocaleString()} / ${def.goal.toLocaleString()}`))
      c.appendChild(bar)
    } else {
      c.appendChild(el('div', 'ach-card-date ach-card-hint', 'Locked. The glory waits.'))
    }
    return c
  }

  function refresh(): void {
    if (panel.style.display === 'none') return
    const st = engine.stats()
    countEl.textContent = `${engine.unlockedCount()} / ${ACHIEVEMENTS.length}`
    body.textContent = ''
    for (const cat of CATEGORY_ORDER) {
      const defs = ACHIEVEMENTS.filter((a) => a.cat === cat)
      if (defs.length === 0) continue
      const unlockedHere = defs.filter((a) => engine.unlockedAt(a.id) !== undefined).length
      const sect = el('div', 'ach-sect')
      const sh = el('div', 'ach-sect-head')
      sh.appendChild(el('span', 'ach-sect-name', CATEGORY_LABELS[cat]))
      sh.appendChild(el('span', 'ach-sect-count', `${unlockedHere} / ${defs.length}`))
      sect.appendChild(sh)
      const grid = el('div', 'ach-grid')
      for (const def of defs) {
        grid.appendChild(card(def, def.progress(st), engine.unlockedAt(def.id)))
      }
      sect.appendChild(grid)
      body.appendChild(sect)
    }
  }

  function setOpen(open: boolean): void {
    panel.style.display = open ? '' : 'none'
    btn.classList.toggle('ach-btn-open', open)
    btn.classList.remove('ach-btn-flash')
    if (open) refresh()
  }
  btn.addEventListener('click', () => setOpen(panel.style.display === 'none'))
  closeBtn.addEventListener('click', () => setOpen(false))

  mount.appendChild(btn)
  mount.appendChild(panel)

  return {
    open: () => setOpen(true),
    refresh,
    /** Pulse the trophy when something unlocks while the panel is closed. */
    flashButton(): void {
      if (panel.style.display === 'none') {
        btn.classList.remove('ach-btn-flash')
        void btn.offsetWidth // restart the animation
        btn.classList.add('ach-btn-flash')
      }
    },
  }
}
