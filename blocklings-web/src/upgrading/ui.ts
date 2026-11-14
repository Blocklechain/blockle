/**
 * Upgrading UI — the interact pill + the centered "Anvil of Ascension" panel.
 *
 * A pure view: src/upgrading/index.ts computes a PanelVM and calls render();
 * the view emits intents (select/tab/upgrade/enchant/remove/reforge/close)
 * back. No game state lives here.
 *
 * FOOTGUN NOTE: the panel root (.bl-asc-root) is a modal backdrop kept at
 * display:none while closed, so it never becomes a full-screen transparent
 * pointer-events:none layer — it does NOT need a src/style.css override entry
 * (same shape as the crafting panel). The 3D viewer canvas is LENT by the
 * inventory module and mounted into the viewer host here.
 */
import './upgrading.css'

export type AscTab = 'upgrade' | 'enchant' | 'reforge'

export interface MatView { name: string; have: number; need: number; ok: boolean }

export interface ListItemView {
  id: string
  name: string
  plus: number
  enchantCount: number
  rarityColor: string
  selected: boolean
}

export interface StatLineView { label: string; base: number; eff: number }

export interface EnchantOptView {
  id: string
  name: string
  blurb: string
  effect: string
  cost: MatView[]
  affordable: boolean
  equipped: boolean
  canApply: boolean
}

export interface UpgradeTabView {
  maxed: boolean
  fromPlus: number
  toPlus: number
  chancePct: number
  risky: boolean
  cost: MatView[]
  affordable: boolean
  gain: string[]
}

export interface EnchantSlotView { slot: number; name: string; effect: string }

export interface EnchantTabView {
  slotsUsed: number
  maxSlots: number
  current: EnchantSlotView[]
  options: EnchantOptView[]
}

export interface ReforgeTabView {
  cost: MatView[]
  affordable: boolean
  current: StatLineView[]
}

export interface SelectedView {
  id: string
  name: string
  rarity: number
  rarityName: string
  rarityColor: string
  plus: number
  stats: StatLineView[]
  enchantNames: string[]
  glow: string | null
}

export interface PanelVM {
  list: ListItemView[]
  selected: SelectedView | null
  tab: AscTab
  upgrade: UpgradeTabView | null
  enchant: EnchantTabView | null
  reforge: ReforgeTabView | null
}

export interface UpgradingUI {
  showPrompt(label: string): void
  hidePrompt(): void
  onPromptActivate(fn: () => void): void

  open(vm: PanelVM): void
  render(vm: PanelVM): void
  close(): void
  isOpen(): boolean

  /** Host element the inventory viewer canvas is mounted into. */
  viewerHost(): HTMLElement

  onSelect(fn: (id: string) => void): void
  onTab(fn: (tab: AscTab) => void): void
  onUpgrade(fn: () => void): void
  onEnchant(fn: (enchantId: string) => void): void
  onRemoveEnchant(fn: (slot: number) => void): void
  onReforge(fn: () => void): void
  onClose(fn: () => void): void

  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function matRow(parent: HTMLElement, mats: MatView[]): void {
  const wrap = el('div', 'bl-asc-mats')
  for (const m of mats) {
    const chip = el('span', `bl-asc-mat${m.ok ? '' : ' bl-asc-mat-short'}`)
    chip.appendChild(el('span', 'bl-asc-mat-name', m.name))
    chip.appendChild(el('span', 'bl-asc-mat-ct', `${m.have}/${m.need}`))
    wrap.appendChild(chip)
  }
  parent.appendChild(wrap)
}

export function createUpgradingUI(mount: HTMLElement): UpgradingUI {
  // --- prompt pill ---------------------------------------------------------
  const prompt = el('button', 'bl-asc-prompt')
  prompt.type = 'button'
  prompt.style.display = 'none'
  const pkey = el('span', 'bl-asc-key', 'E')
  const plabel = el('span', 'bl-asc-promptlabel', '')
  prompt.appendChild(pkey)
  prompt.appendChild(plabel)
  mount.appendChild(prompt)
  let promptFn: (() => void) | null = null
  prompt.addEventListener('click', (e) => { e.preventDefault(); promptFn?.() })

  // --- panel ---------------------------------------------------------------
  const root = el('div', 'bl-asc-root')
  root.style.display = 'none'
  const panel = el('div', 'bl-asc-panel')
  root.appendChild(panel)

  const head = el('div', 'bl-asc-head')
  head.appendChild(el('span', 'bl-asc-title', 'Anvil of Ascension'))
  const closeBtn = el('button', 'bl-asc-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const body = el('div', 'bl-asc-body')
  panel.appendChild(body)

  // left: item list
  const listCol = el('div', 'bl-asc-list')
  body.appendChild(listCol)

  // right: detail (viewer + stats + tabs + tab content)
  const detail = el('div', 'bl-asc-detail')
  body.appendChild(detail)

  const vHost = el('div', 'bl-asc-viewer')
  detail.appendChild(vHost)
  const infoWrap = el('div', 'bl-asc-info')
  detail.appendChild(infoWrap)
  const tabBar = el('div', 'bl-asc-tabs')
  detail.appendChild(tabBar)
  const tabBody = el('div', 'bl-asc-tabbody')
  detail.appendChild(tabBody)

  mount.appendChild(root)

  // --- callbacks -----------------------------------------------------------
  let selFn: (id: string) => void = () => {}
  let tabFn: (t: AscTab) => void = () => {}
  let upFn: () => void = () => {}
  let enchFn: (id: string) => void = () => {}
  let remFn: (slot: number) => void = () => {}
  let refFn: () => void = () => {}
  let closeFn: () => void = () => {}

  closeBtn.addEventListener('click', () => closeFn())
  root.addEventListener('click', (e) => { if (e.target === root) closeFn() })

  let open = false

  // --- renderers -----------------------------------------------------------
  function renderList(vm: PanelVM): void {
    listCol.textContent = ''
    if (vm.list.length === 0) {
      listCol.appendChild(el('div', 'bl-asc-empty', 'No gear to ascend. Go find something pointy first.'))
      return
    }
    for (const it of vm.list) {
      const btn = el('button', `bl-asc-listitem${it.selected ? ' bl-asc-sel' : ''}`)
      btn.type = 'button'
      btn.style.borderColor = it.rarityColor
      const nm = el('span', 'bl-asc-li-name', it.name)
      nm.style.color = it.rarityColor
      btn.appendChild(nm)
      const tags = el('span', 'bl-asc-li-tags')
      if (it.plus > 0) tags.appendChild(el('span', 'bl-asc-plus', `+${it.plus}`))
      for (let i = 0; i < it.enchantCount; i++) tags.appendChild(el('span', 'bl-asc-rune', '✦'))
      btn.appendChild(tags)
      btn.addEventListener('click', () => selFn(it.id))
      listCol.appendChild(btn)
    }
  }

  function renderInfo(vm: PanelVM): void {
    infoWrap.textContent = ''
    const s = vm.selected
    vHost.classList.toggle('bl-asc-glowing', !!(s && s.glow))
    if (s && s.glow) vHost.style.setProperty('--asc-glow', s.glow)
    if (!s) {
      infoWrap.appendChild(el('div', 'bl-asc-hint', 'Pick a piece of gear on the left.'))
      return
    }
    const nameLine = el('div', 'bl-asc-itemname', s.name)
    if (s.plus > 0) {
      const p = el('span', 'bl-asc-plusbig', `+${s.plus}`)
      nameLine.appendChild(p)
    }
    infoWrap.appendChild(nameLine)
    const rar = el('div', 'bl-asc-rarity', s.rarityName)
    rar.style.color = s.rarityColor
    infoWrap.appendChild(rar)

    const statLine = el('div', 'bl-asc-statline')
    for (const st of s.stats) {
      const chip = el('span', 'bl-asc-stat')
      chip.appendChild(document.createTextNode(`${st.label} `))
      const b = el('b', '', String(st.eff))
      if (st.eff > st.base) b.classList.add('bl-asc-up')
      chip.appendChild(b)
      statLine.appendChild(chip)
    }
    if (s.stats.length) infoWrap.appendChild(statLine)

    if (s.enchantNames.length) {
      const ench = el('div', 'bl-asc-enchline')
      for (const en of s.enchantNames) ench.appendChild(el('span', 'bl-asc-enchtag', `✦ ${en}`))
      infoWrap.appendChild(ench)
    }
  }

  function renderTabs(vm: PanelVM): void {
    tabBar.textContent = ''
    const tabs: [AscTab, string][] = [['upgrade', 'Upgrade'], ['enchant', 'Enchant'], ['reforge', 'Reforge']]
    for (const [id, label] of tabs) {
      const b = el('button', `bl-asc-tab${vm.tab === id ? ' bl-asc-tab-on' : ''}`, label)
      b.type = 'button'
      b.disabled = !vm.selected
      b.addEventListener('click', () => tabFn(id))
      tabBar.appendChild(b)
    }
  }

  function renderUpgrade(v: UpgradeTabView): void {
    if (v.maxed) {
      tabBody.appendChild(el('div', 'bl-asc-maxed', 'Already +10. This is the summit. Breathe the thin air.'))
      return
    }
    const header = el('div', 'bl-asc-steprow')
    header.appendChild(el('span', 'bl-asc-step', `+${v.fromPlus}`))
    header.appendChild(el('span', 'bl-asc-arrow', '→'))
    header.appendChild(el('span', 'bl-asc-step bl-asc-step-next', `+${v.toPlus}`))
    tabBody.appendChild(header)

    if (v.gain.length) {
      const gain = el('div', 'bl-asc-gain')
      for (const g of v.gain) gain.appendChild(el('span', 'bl-asc-gainchip', g))
      tabBody.appendChild(gain)
    }

    const chance = el('div', `bl-asc-chance${v.risky ? ' bl-asc-chance-risky' : ''}`)
    chance.textContent = v.risky
      ? `Success chance: ${v.chancePct}%  ·  fail eats some mats, never the item`
      : 'Guaranteed success at this level.'
    tabBody.appendChild(chance)

    matRow(tabBody, v.cost)

    const btn = el('button', 'bl-asc-go bl-asc-primary', v.risky ? `Gamble the Upgrade (${v.chancePct}%)` : 'Upgrade')
    btn.type = 'button'
    btn.disabled = !v.affordable
    btn.addEventListener('click', () => upFn())
    tabBody.appendChild(btn)
    if (!v.affordable) tabBody.appendChild(el('div', 'bl-asc-short', 'Not enough materials.'))
  }

  function renderEnchant(v: EnchantTabView): void {
    const slots = el('div', 'bl-asc-slots')
    for (let i = 0; i < v.maxSlots; i++) {
      const cur = v.current.find((c) => c.slot === i)
      const slot = el('div', `bl-asc-slot${cur ? ' bl-asc-slot-full' : ''}`)
      if (cur) {
        slot.appendChild(el('span', 'bl-asc-slot-name', cur.name))
        slot.appendChild(el('span', 'bl-asc-slot-eff', cur.effect))
        const rm = el('button', 'bl-asc-slot-rm', 'Remove')
        rm.type = 'button'
        rm.addEventListener('click', () => remFn(cur.slot))
        slot.appendChild(rm)
      } else {
        slot.appendChild(el('span', 'bl-asc-slot-empty', `Empty socket ${i + 1}`))
      }
      slots.appendChild(slot)
    }
    tabBody.appendChild(slots)

    const list = el('div', 'bl-asc-enchlist')
    for (const o of v.options) {
      const card = el('div', `bl-asc-ench${o.equipped ? ' bl-asc-ench-on' : ''}`)
      const top = el('div', 'bl-asc-ench-top')
      top.appendChild(el('span', 'bl-asc-ench-name', o.name))
      top.appendChild(el('span', 'bl-asc-ench-eff', o.effect))
      card.appendChild(top)
      card.appendChild(el('div', 'bl-asc-ench-blurb', o.blurb))
      matRow(card, o.cost)
      const btn = el('button', 'bl-asc-go', o.equipped ? 'Already etched' : 'Etch')
      btn.type = 'button'
      btn.disabled = !o.canApply
      btn.addEventListener('click', () => enchFn(o.id))
      card.appendChild(btn)
      list.appendChild(card)
    }
    tabBody.appendChild(list)
  }

  function renderReforge(v: ReforgeTabView): void {
    tabBody.appendChild(el('div', 'bl-asc-reforge-note', 'Reroll the stat spread — same budget, new emphasis. The anvil does not do refunds.'))
    const cur = el('div', 'bl-asc-statline')
    for (const st of v.current) {
      const chip = el('span', 'bl-asc-stat')
      chip.appendChild(document.createTextNode(`${st.label} `))
      chip.appendChild(el('b', '', String(st.eff)))
      cur.appendChild(chip)
    }
    tabBody.appendChild(cur)
    matRow(tabBody, v.cost)
    const btn = el('button', 'bl-asc-go bl-asc-primary', 'Reforge')
    btn.type = 'button'
    btn.disabled = !v.affordable
    btn.addEventListener('click', () => refFn())
    tabBody.appendChild(btn)
    if (!v.affordable) tabBody.appendChild(el('div', 'bl-asc-short', 'Not enough materials.'))
  }

  function renderTabBody(vm: PanelVM): void {
    tabBody.textContent = ''
    if (!vm.selected) {
      tabBody.appendChild(el('div', 'bl-asc-hint', 'Select gear to upgrade, enchant, or reforge.'))
      return
    }
    if (vm.tab === 'upgrade' && vm.upgrade) renderUpgrade(vm.upgrade)
    else if (vm.tab === 'enchant' && vm.enchant) renderEnchant(vm.enchant)
    else if (vm.tab === 'reforge' && vm.reforge) renderReforge(vm.reforge)
  }

  function render(vm: PanelVM): void {
    renderList(vm)
    renderInfo(vm)
    renderTabs(vm)
    renderTabBody(vm)
  }

  return {
    showPrompt(label) {
      plabel.textContent = label
      prompt.style.display = ''
    },
    hidePrompt() { prompt.style.display = 'none' },
    onPromptActivate(fn) { promptFn = fn },
    open(vm) {
      open = true
      root.style.display = ''
      render(vm)
    },
    render(vm) { if (open) render(vm) },
    close() {
      open = false
      root.style.display = 'none'
      vHost.classList.remove('bl-asc-glowing')
    },
    isOpen() { return open },
    viewerHost() { return vHost },
    onSelect(fn) { selFn = fn },
    onTab(fn) { tabFn = fn },
    onUpgrade(fn) { upFn = fn },
    onEnchant(fn) { enchFn = fn },
    onRemoveEnchant(fn) { remFn = fn },
    onReforge(fn) { refFn = fn },
    onClose(fn) { closeFn = fn },
    dispose() {
      prompt.remove()
      root.remove()
    }
  }
}
