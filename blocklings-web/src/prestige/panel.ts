/**
 * Blocklings prestige — the Mastery HUD panel (centered dialog).
 *
 * A bottom-right star button toggles a centered panel: the total-Mastery flex
 * (stars + current title) on top, then one row per skill showing its live
 * level, earned stars, a mastery-modifier readout, and a Prestige button that
 * only arms at level 99. Pressing Prestige opens a centered confirm dialog
 * with the three mastery-perk choices and the "the grind is the point" warning.
 *
 * Pointer footgun: the single full-screen root is `.bl-mastery-root`; it is in
 * the `#ui > .class { pointer-events:none }` override list in src/style.css so
 * it never eats in-world taps — only its armed children opt back in.
 * Touch targets ≥ 44px; the list scrolls on short screens.
 */
import {
  PERK_OPTIONS,
  SIGNATURE,
  XP_PERK_STEP,
  type PerkKind
} from './perks'
import './panel.css'

export interface MasteryPanelDeps {
  skills: readonly string[]
  level(skill: string): number
  stars(skill: string): number
  golden(skill: string): boolean
  perks(skill: string): PerkKind[]
  totalStars(): number
  title(): string
  prestige(skill: string, kind: PerkKind): boolean
}

export interface MasteryPanel {
  refresh(): void
}

/** Text-presentation glyph + accent per skill (mirrors the Skills panel). */
const GLYPHS: Record<string, { ch: string; color: string; flip?: boolean }> = {
  attack: { ch: '⚔︎', color: '#e08c4f' },
  defense: { ch: '⬟', color: '#6cb8ff', flip: true },
  magic: { ch: '✦', color: '#b48cff' },
  vitality: { ch: '❤︎', color: '#ff6b6b' },
  mining: { ch: '⛏︎', color: '#c9a66b' },
  woodcutting: { ch: '♣︎', color: '#7ed957' },
  fishing: { ch: '⋈', color: '#5fd0c7' },
  farming: { ch: '✻', color: '#d9c957' },
  herbalism: { ch: '✿', color: '#8fd957' },
  blacksmithing: { ch: '⚒︎', color: '#d4af37' },
  cooking: { ch: '♨︎', color: '#ffb067' },
  alchemy: { ch: '⚗︎', color: '#57d9b8' },
  tailoring: { ch: '✂︎', color: '#ff9ecb' }
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

/** Render a skill's stars as a compact glyph run (caps the glyphs at 5). */
function starText(n: number): string {
  if (n <= 0) return ''
  if (n <= 5) return '★'.repeat(n)
  return '★★★★★ ×' + n
}

/** Human readout of a skill's active mastery perks ('' when none). */
function modReadout(skill: string, deps: MasteryPanelDeps): string {
  const list = deps.perks(skill)
  if (list.length === 0) return ''
  let xp = 0
  let mod = 0
  let gold = 0
  for (const k of list) {
    if (k === 'xp') xp++
    else if (k === 'mod') mod++
    else gold++
  }
  const parts: string[] = []
  if (xp > 0) parts.push(`+${Math.round(xp * XP_PERK_STEP * 100)}% XP`)
  if (mod > 0) {
    const sig = SIGNATURE[skill as keyof typeof SIGNATURE]
    if (sig) parts.push(`+${Math.round(mod * sig.step * 100)}% ${sig.label}`)
  }
  if (gold > 0) parts.push('gilded')
  return parts.join(' · ')
}

interface Row {
  skill: string
  levelEl: HTMLElement
  starsEl: HTMLElement
  modEl: HTMLElement
  btn: HTMLButtonElement
  chip: HTMLElement
}

export function createMasteryPanel(deps: MasteryPanelDeps): MasteryPanel {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const root = el('div', 'bl-mastery-root')

  // -- toggle button (bottom-right, left of the Skills button) --------------
  const btn = el('button', 'bl-mastery-btn')
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Mastery')
  btn.appendChild(el('span', 'bl-mastery-btn-glyph', '★'))
  btn.appendChild(el('span', 'bl-mastery-btn-label', 'Mastery'))

  // -- scrim + centered panel -----------------------------------------------
  const scrim = el('div', 'bl-mastery-scrim')
  scrim.style.display = 'none'

  const panel = el('div', 'bl-mastery')

  const head = el('div', 'bl-mastery-head')
  head.appendChild(el('span', 'bl-mastery-title', 'Mastery'))
  const closeBtn = el('button', 'bl-mastery-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close mastery')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  // total-mastery flex
  const flex = el('div', 'bl-mastery-flex')
  const flexNum = el('div', 'bl-mastery-flex-num', '0')
  const flexMeta = el('div', 'bl-mastery-flex-meta')
  flexMeta.appendChild(el('div', 'bl-mastery-flex-label', 'Mastery stars'))
  const flexTitle = el('div', 'bl-mastery-flex-cap', '')
  flexMeta.appendChild(flexTitle)
  flex.appendChild(flexNum)
  flex.appendChild(flexMeta)
  panel.appendChild(flex)

  const hint = el(
    'div',
    'bl-mastery-hint',
    'Hit 99, then prestige: reset to 1 for a permanent star. The grind is the point.'
  )
  panel.appendChild(hint)

  // rows
  const list = el('div', 'bl-mastery-list')
  const rows: Row[] = []
  for (const skill of deps.skills) {
    const g = GLYPHS[skill] ?? { ch: '✦', color: '#e8c15a' }
    const row = el('div', 'bl-mastery-row')

    const chip = el('span', 'bl-mastery-chip', g.ch)
    chip.style.color = g.color
    chip.style.borderColor = `${g.color}55`
    if (g.flip) chip.classList.add('bl-mastery-chip-flip')
    row.appendChild(chip)

    const mid = el('div', 'bl-mastery-mid')
    const nameRow = el('div', 'bl-mastery-namerow')
    nameRow.appendChild(el('span', 'bl-mastery-name', cap(skill)))
    const levelEl = el('span', 'bl-mastery-level', 'Lv 1')
    nameRow.appendChild(levelEl)
    const starsEl = el('span', 'bl-mastery-stars', '')
    nameRow.appendChild(starsEl)
    mid.appendChild(nameRow)
    const modEl = el('div', 'bl-mastery-mod', '')
    mid.appendChild(modEl)
    row.appendChild(mid)

    const pbtn = el('button', 'bl-mastery-prestige', 'Prestige')
    pbtn.type = 'button'
    pbtn.addEventListener('click', () => openConfirm(skill))
    row.appendChild(pbtn)

    list.appendChild(row)
    rows.push({ skill, levelEl, starsEl, modEl, btn: pbtn, chip })
  }
  panel.appendChild(list)
  scrim.appendChild(panel)

  // -- confirm sub-dialog (built lazily, reused) ----------------------------
  const confirmScrim = el('div', 'bl-mastery-confirm-scrim')
  confirmScrim.style.display = 'none'
  const confirm = el('div', 'bl-mastery-confirm')
  const confirmTitle = el('div', 'bl-mastery-confirm-title', '')
  const confirmBody = el('div', 'bl-mastery-confirm-body', '')
  const perkWrap = el('div', 'bl-mastery-perks')
  const perkBtns: HTMLButtonElement[] = []
  for (const opt of PERK_OPTIONS) {
    const p = el('button', 'bl-mastery-perk')
    p.type = 'button'
    p.appendChild(el('span', 'bl-mastery-perk-name', opt.name))
    const d = el('span', 'bl-mastery-perk-desc', '')
    p.appendChild(d)
    perkWrap.appendChild(p)
    perkBtns.push(p)
  }
  const cancelBtn = el('button', 'bl-mastery-cancel', 'Not yet')
  cancelBtn.type = 'button'
  confirm.appendChild(confirmTitle)
  confirm.appendChild(confirmBody)
  confirm.appendChild(perkWrap)
  confirm.appendChild(cancelBtn)
  confirmScrim.appendChild(confirm)

  let confirmSkill: string | null = null

  function closeConfirm(): void {
    confirmScrim.style.display = 'none'
    confirmSkill = null
  }

  function openConfirm(skill: string): void {
    if (deps.level(skill) < 99) return
    confirmSkill = skill
    const nextStar = deps.stars(skill) + 1
    confirmTitle.textContent = `Prestige ${cap(skill)}?`
    confirmBody.textContent =
      `Reset ${cap(skill)} to 1 for a Mastery star (this would be star ${nextStar})? ` +
      `The grind is the point. Pick your permanent perk:`
    for (let i = 0; i < PERK_OPTIONS.length; i++) {
      const opt = PERK_OPTIONS[i]!
      const d = perkBtns[i]!.querySelector('.bl-mastery-perk-desc')
      if (d) d.textContent = opt.desc(skill as keyof typeof SIGNATURE)
    }
    confirmScrim.style.display = 'flex'
  }

  for (let i = 0; i < perkBtns.length; i++) {
    perkBtns[i]!.addEventListener('click', () => {
      const opt = PERK_OPTIONS[i]!
      if (confirmSkill) deps.prestige(confirmSkill, opt.kind)
      closeConfirm()
      refresh()
    })
  }
  cancelBtn.addEventListener('click', closeConfirm)
  confirmScrim.addEventListener('click', (e) => {
    if (e.target === confirmScrim) closeConfirm()
  })

  // -- refresh --------------------------------------------------------------
  function refresh(): void {
    if (scrim.style.display === 'none') return
    const total = deps.totalStars()
    flexNum.textContent = String(total)
    flexTitle.textContent = deps.title()

    for (const r of rows) {
      const lvl = deps.level(r.skill)
      const stars = deps.stars(r.skill)
      const maxed = lvl >= 99
      r.levelEl.textContent = `Lv ${lvl}`
      r.levelEl.classList.toggle('bl-mastery-level-max', maxed)
      r.starsEl.textContent = starText(stars)
      r.modEl.textContent = modReadout(r.skill, deps) || 'no mastery yet'
      r.chip.classList.toggle('bl-mastery-chip-gold', deps.golden(r.skill))
      r.btn.disabled = !maxed
      r.btn.title = maxed
        ? `Reset ${cap(r.skill)} to level 1 for a Mastery star`
        : `Reach ${cap(r.skill)} level 99 to prestige (currently ${lvl})`
    }
  }

  // -- wiring ---------------------------------------------------------------
  function setOpen(open: boolean): void {
    scrim.style.display = open ? 'flex' : 'none'
    btn.classList.toggle('bl-mastery-btn-open', open)
    if (!open) closeConfirm()
    if (open) refresh()
  }
  btn.addEventListener('click', () => setOpen(scrim.style.display === 'none'))
  closeBtn.addEventListener('click', () => setOpen(false))
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) setOpen(false)
  })

  root.appendChild(btn)
  root.appendChild(scrim)
  root.appendChild(confirmScrim)
  uiMount.appendChild(root)

  return { refresh }
}
