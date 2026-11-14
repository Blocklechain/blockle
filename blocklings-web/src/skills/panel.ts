/**
 * Blocklings skills — HUD button + panel.
 *
 * Bottom-right crossed-swords button toggles a 13-row skills panel:
 * total-level flex at the top, then one row per skill with a glyph chip
 * (pure unicode text glyphs, no emoji), name, level badge and an XP
 * progress bar for the current bracket. Touch-friendly (≥40px targets),
 * scrolls on short screens, caps out in gold at 99.
 */
import { MAX_LEVEL } from './curve'
import { totalCaption } from './flavor'
import './panel.css'

export interface SkillsPanelDeps {
  skills: readonly string[]
  level(skill: string): number
  /** Progress inside the current level bracket. */
  progress(skill: string): { level: number; into: number; size: number }
  xp(skill: string): number
  total(): number
}

/** Text-presentation glyph + accent per skill (U+FE0E forces non-emoji). */
const GLYPHS: Record<string, { ch: string; color: string; flip?: boolean }> = {
  attack: { ch: '⚔︎', color: '#e08c4f' }, // crossed swords
  defense: { ch: '⬟', color: '#6cb8ff', flip: true }, // pentagon -> shield
  magic: { ch: '✦', color: '#b48cff' }, // four-point star
  vitality: { ch: '❤︎', color: '#ff6b6b' }, // heart
  mining: { ch: '⛏︎', color: '#c9a66b' }, // pick
  woodcutting: { ch: '♣︎', color: '#7ed957' }, // club (tiny tree)
  fishing: { ch: '⋈', color: '#5fd0c7' }, // bowtie (tiny fish)
  farming: { ch: '✻', color: '#d9c957' }, // teardrop flower
  herbalism: { ch: '✿', color: '#8fd957' }, // black flower
  blacksmithing: { ch: '⚒︎', color: '#d4af37' }, // hammer & pick
  cooking: { ch: '♨︎', color: '#ffb067' }, // steam
  alchemy: { ch: '⚗︎', color: '#57d9b8' }, // alembic
  tailoring: { ch: '✂︎', color: '#ff9ecb' } // scissors
}

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

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

interface Row {
  skill: string
  levelEl: HTMLElement
  fill: HTMLElement
  bar: HTMLElement
  row: HTMLElement
}

export function createSkillsPanel(deps: SkillsPanelDeps): { refresh(): void } {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const root = el('div', 'bl-skills-root')

  // -- toggle button (bottom-right) ----------------------------------------
  const btn = el('button', 'bl-skills-btn')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Skills')
  btn.appendChild(el('span', 'bl-skills-btn-glyph', '⚔︎'))
  btn.appendChild(el('span', 'bl-skills-btn-label', 'Skills'))

  // -- panel ----------------------------------------------------------------
  const panel = el('div', 'bl-skills')
  panel.style.display = 'none'

  const head = el('div', 'bl-skills-head')
  head.appendChild(el('span', 'bl-skills-title', 'Skills'))
  const closeBtn = el('button', 'bl-skills-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close skills')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  // total-level flex
  const flex = el('div', 'bl-skills-flex')
  const flexNum = el('div', 'bl-skills-flex-num', '13')
  const flexMeta = el('div', 'bl-skills-flex-meta')
  flexMeta.appendChild(el('div', 'bl-skills-flex-label', 'Total level'))
  const flexCap = el('div', 'bl-skills-flex-cap', '')
  flexMeta.appendChild(flexCap)
  flex.appendChild(flexNum)
  flex.appendChild(flexMeta)
  panel.appendChild(flex)

  // rows
  const list = el('div', 'bl-skills-list')
  const rows: Row[] = []
  for (const skill of deps.skills) {
    const g = GLYPHS[skill] ?? { ch: '✦', color: '#e8c15a' }
    const row = el('div', 'bl-skill-row')

    const chip = el('span', 'bl-skill-chip', g.ch)
    chip.style.color = g.color
    chip.style.borderColor = `${g.color}55`
    if (g.flip) chip.classList.add('bl-skill-chip-flip')
    row.appendChild(chip)

    const mid = el('div', 'bl-skill-mid')
    mid.appendChild(el('div', 'bl-skill-name', cap(skill)))
    const bar = el('div', 'bl-skill-bar')
    const fill = el('div', 'bl-skill-fill')
    fill.style.background = `linear-gradient(180deg, ${g.color} 0%, ${g.color}99 100%)`
    bar.appendChild(fill)
    mid.appendChild(bar)
    row.appendChild(mid)

    const levelEl = el('span', 'bl-skill-level', '1')
    row.appendChild(levelEl)

    list.appendChild(row)
    rows.push({ skill, levelEl, fill, bar, row })
  }
  panel.appendChild(list)

  // -- refresh --------------------------------------------------------------
  let cacheKey = ''
  function refresh(): void {
    if (panel.style.display === 'none') return
    const total = deps.total()
    let key = String(total)
    for (const r of rows) key += `|${deps.xp(r.skill)}`
    if (key === cacheKey) return
    cacheKey = key

    flexNum.textContent = String(total)
    flexCap.textContent = totalCaption(total)

    for (const r of rows) {
      const { level, into, size } = deps.progress(r.skill)
      const maxed = level >= MAX_LEVEL
      r.levelEl.textContent = String(level)
      r.levelEl.classList.toggle('bl-skill-level-max', maxed)
      r.fill.classList.toggle('bl-skill-fill-max', maxed)
      r.fill.style.width = maxed ? '100%' : `${size > 0 ? Math.min(100, (into / size) * 100) : 0}%`
      r.row.title = maxed
        ? `${cap(r.skill)} — level 99. There is nothing left to prove.`
        : `${cap(r.skill)} — ${into.toLocaleString()} / ${size.toLocaleString()} XP this level (${deps
            .xp(r.skill)
            .toLocaleString()} total)`
    }
  }

  // -- wiring ---------------------------------------------------------------
  function setOpen(open: boolean): void {
    panel.style.display = open ? '' : 'none'
    btn.classList.toggle('bl-skills-btn-open', open)
    if (open) {
      cacheKey = ''
      refresh()
    }
  }
  btn.addEventListener('click', () => setOpen(panel.style.display === 'none'))
  closeBtn.addEventListener('click', () => setOpen(false))

  root.appendChild(btn)
  root.appendChild(panel)
  uiMount.appendChild(root)

  return { refresh }
}
