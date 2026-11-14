/**
 * Inventory — bag button, bag panel, equipment doll and the item detail
 * card with its live rotating 3D viewer. Medieval-dark styling matching
 * hud.css; every control works; everything is finger-sized.
 */
import type { GameAPI, ItemDef } from '../types'
import { events } from '../events'
import { GEAR_SLOTS, RARITY_COLORS, RARITY_NAMES, isGearSlot } from './defs'
import type { InventoryCore } from './core'
import { ItemViewer } from './viewer'
import './inventory.css'

/**
 * Integrator-wired bridge to the minting module (null until wired): the card
 * gets one Mint button + chain badges + a 'Minted' flair, the grid gets
 * minted-chain dots and the minted-bundle pseudo-cells. Styling for these
 * hook elements lives in src/minting/minting.css.
 */
export interface MintHooks {
  /** Open the shared mint dialog for this catalog id. */
  open(id: string, def: ItemDef): void
  /** Chains any minted instance of `id` lives on (empty = unminted). */
  chainsOf(id: string): readonly string[]
  /** Minted quantity-bundles (escrowed stackables) to show in the grid. */
  bundles(): readonly { id: string; qty: number; chains: readonly string[] }[]
}

/** Chain badge glyphs — the same visual language as the pets panel. */
const MINT_BADGES: readonly { chain: string; glyph: string; label: string }[] = [
  { chain: 'blockle', glyph: 'B', label: 'Blockle' },
  { chain: 'ethereum', glyph: 'Ξ', label: 'Ethereum' },
  { chain: 'solana', glyph: '◎', label: 'Solana' }
]

const SLOT_LABELS: Record<string, string> = {
  weapon: 'Weapon',
  shield: 'Shield',
  helm: 'Helm',
  chest: 'Chest',
  boots: 'Boots',
  accessory: 'Trinket',
  tool: 'Tool'
}

const STAT_LABELS = [
  ['atk', 'ATK'],
  ['def', 'DEF'],
  ['str', 'STR'],
  ['int', 'INT'],
  ['agi', 'AGI']
] as const

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

function rarityColor(def: ItemDef): string {
  return RARITY_COLORS[def.rarity] ?? RARITY_COLORS[0]
}

function sys(text: string): void {
  events.emit('chat:system', { text })
}

export interface InventoryUI {
  viewer: ItemViewer
  setMintHooks(hooks: MintHooks): void
}

export function createInventoryUI(api: GameAPI, core: InventoryCore): InventoryUI {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const root = el('div', 'bl-invroot')
  const viewer = new ItemViewer()
  let mintHooks: MintHooks | null = null

  // =========================================================================
  // Bag button
  // =========================================================================
  const bagBtn = el('button', 'bl-bagbtn')
  bagBtn.type = 'button'
  bagBtn.setAttribute('aria-label', 'Inventory')
  bagBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
    '<path fill="currentColor" d="M8 7V6a4 4 0 0 1 8 0v1h1.6c1 0 1.9.8 2 1.8l.9 10A2 2 0 0 1 18.5 21h-13a2 2 0 0 1-2-2.2l.9-10c.1-1 1-1.8 2-1.8H8Zm2 0h4V6a2 2 0 0 0-4 0v1Zm-2 4a1 1 0 1 0 2 0V9H8v2Zm6 0a1 1 0 1 0 2 0V9h-2v2Z"/></svg>'

  // =========================================================================
  // Panel scaffold
  // =========================================================================
  const panel = el('div', 'bl-inv')
  panel.style.display = 'none'

  const head = el('div', 'bl-inv-head')
  head.appendChild(el('span', 'bl-inv-title', 'Inventory'))
  const closeBtn = el('button', 'bl-inv-close', '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close inventory')
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const body = el('div', 'bl-inv-body')
  panel.appendChild(body)

  // Detail card overlays the whole panel below the header.
  const card = el('div', 'bl-inv-card')
  card.style.display = 'none'
  panel.appendChild(card)

  // --- body: equipment doll + stat chips + bag grid ------------------------
  body.appendChild(el('div', 'bl-inv-sect', 'Worn & Wielded'))
  const doll = el('div', 'bl-inv-doll')
  body.appendChild(doll)
  const statsRow = el('div', 'bl-inv-stats')
  body.appendChild(statsRow)
  const bagSect = el('div', 'bl-inv-sect', 'The Bag')
  body.appendChild(bagSect)
  const grid = el('div', 'bl-inv-grid')
  body.appendChild(grid)

  function renderDoll(): void {
    doll.textContent = ''
    const eq = core.equipment()
    for (const slot of GEAR_SLOTS) {
      const id = eq[slot] ?? null
      const cell = el('button', `bl-inv-slot${id ? '' : ' bl-empty'}`)
      cell.type = 'button'
      cell.style.gridArea = slot
      cell.appendChild(el('span', 'bl-inv-slot-name', SLOT_LABELS[slot] ?? slot))
      if (id) {
        const def = core.def(id)
        const nameEl = el('span', 'bl-inv-slot-item', def.name)
        nameEl.style.color = rarityColor(def)
        cell.appendChild(nameEl)
        cell.style.borderColor = rarityColor(def)
        cell.addEventListener('click', () => openDetail(id, slot))
      } else {
        cell.addEventListener('click', () =>
          sys(`Nothing in your ${(SLOT_LABELS[slot] ?? slot).toLowerCase()} slot. Bold strategy.`)
        )
      }
      doll.appendChild(cell)
    }
  }

  function renderStats(): void {
    statsRow.textContent = ''
    const totals = core.equippedStats()
    for (const [key, label] of STAT_LABELS) {
      const chip = el('span', 'bl-inv-stat')
      const b = el('b', '', String(totals[key]))
      chip.appendChild(document.createTextNode(`${label} `))
      chip.appendChild(b)
      statsRow.appendChild(chip)
    }
  }

  /** Minted-chain dots in a cell's top-left corner (mint hook, read-only). */
  function mintDots(cell: HTMLElement, chains: readonly string[]): void {
    if (chains.length === 0) return
    const dots = el('span', 'bl-inv-celldots')
    for (const c of chains) {
      const dot = el('span', 'bl-inv-celldot')
      dot.title = `Minted on ${c}`
      dots.appendChild(dot)
    }
    cell.appendChild(dots)
  }

  function renderGrid(): void {
    grid.textContent = ''
    const stacks = core.items()
    const bundles = mintHooks?.bundles() ?? []
    if (stacks.length === 0 && bundles.length === 0) {
      const empty = el('div', 'bl-inv-empty', 'Nothing but lint and broken dreams. Go hit something.')
      grid.appendChild(empty)
      return
    }
    for (const stack of stacks) {
      const def = core.def(stack.id)
      const cell = el('button', 'bl-inv-cell', def.name)
      cell.type = 'button'
      cell.style.borderColor = rarityColor(def)
      cell.style.color = rarityColor(def)
      if (stack.qty > 1) cell.appendChild(el('span', 'bl-inv-qty', `×${stack.qty}`))
      if (mintHooks) mintDots(cell, mintHooks.chainsOf(stack.id))
      cell.addEventListener('click', () => openDetail(stack.id, null))
      grid.appendChild(cell)
    }
    // Minted quantity-bundles: unstackable NFT items that left the stacks.
    for (const b of bundles) {
      const def = core.def(b.id)
      const cell = el('button', 'bl-inv-cell bl-inv-cell-bundle', def.name)
      cell.type = 'button'
      cell.style.borderColor = rarityColor(def)
      cell.style.color = rarityColor(def)
      cell.appendChild(el('span', 'bl-inv-qty', `×${b.qty}`))
      cell.appendChild(el('span', 'bl-inv-bundletag', 'NFT'))
      mintDots(cell, b.chains)
      cell.addEventListener('click', () => mintHooks?.open(b.id, def))
      grid.appendChild(cell)
    }
  }

  function renderAll(): void {
    renderDoll()
    renderStats()
    renderGrid()
  }

  // =========================================================================
  // Detail card (live rotating viewer + stats + actions)
  // =========================================================================
  let cardItem: string | null = null
  let cardSlot: string | null = null // non-null when opened from the doll

  function closeDetail(): void {
    cardItem = null
    cardSlot = null
    viewer.stop()
    card.style.display = 'none'
  }

  function actionBtn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const btn = el('button', `bl-inv-act ${cls}`.trim(), label)
    btn.type = 'button'
    btn.addEventListener('click', onClick)
    return btn
  }

  function useConsumable(def: ItemDef): void {
    const r = def.restores
    const p = api.player
    const hpGain = Math.min(r?.hp ?? 0, p.maxHp - p.hp)
    const mpGain = Math.min(r?.mp ?? 0, p.maxMp - p.mp)
    if (hpGain <= 0 && mpGain <= 0) {
      sys(`You're already topped up. Save the ${def.name} for when life hurts.`)
      return
    }
    if (!core.remove(def.id, 1)) return
    p.hp = Math.min(p.maxHp, p.hp + (r?.hp ?? 0))
    p.mp = Math.min(p.maxMp, p.mp + (r?.mp ?? 0))
    const bits: string[] = []
    if (hpGain > 0) bits.push(`+${Math.round(hpGain)} HP`)
    if (mpGain > 0) bits.push(`+${Math.round(mpGain)} MP`)
    sys(`${def.name} down the hatch. ${bits.join(', ')}. Zero regrets.`)
    events.emit('save:dirty', { why: 'inv:consume' })
  }

  function renderDetail(): void {
    if (!cardItem) return
    const id = cardItem
    const def = core.def(id)
    const equippedHere = cardSlot !== null && core.equipment()[cardSlot] === id
    const bagCount = core.count(id)

    // Item vanished (dropped elsewhere / consumed out) — bail out gracefully.
    if (!equippedHere && bagCount <= 0) {
      closeDetail()
      return
    }

    card.textContent = ''

    const back = el('button', 'bl-inv-back')
    back.type = 'button'
    back.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path fill="currentColor" d="M15.4 4.6 8 12l7.4 7.4 1.4-1.4-6-6 6-6-1.4-1.4Z"/></svg>' +
      '<span>Bag</span>'
    back.addEventListener('click', closeDetail)
    card.appendChild(back)

    const wrap = el('div', 'bl-inv-viewerwrap')
    wrap.appendChild(viewer.canvas)
    card.appendChild(wrap)

    card.appendChild(el('div', 'bl-inv-itemname', def.name))
    const rar = el('div', 'bl-inv-rarity', RARITY_NAMES[def.rarity] ?? 'Common')
    rar.style.color = rarityColor(def)
    const mintedChains = mintHooks?.chainsOf(id) ?? []
    if (mintedChains.length > 0) {
      // 'Minted' flair riding the rarity line (gold on the rarity border).
      rar.appendChild(el('span', 'bl-inv-mintflair', 'Minted'))
    }
    card.appendChild(rar)

    // Chain badges (B/Ξ/◎) lit per existing mint of any instance of this item.
    if (mintHooks) {
      const badges = el('div', 'bl-inv-mintbadges')
      for (const b of MINT_BADGES) {
        const lit = mintedChains.includes(b.chain)
        const badge = el('span', `bl-inv-mintbadge${lit ? ' bl-inv-mintbadge-lit' : ''}`, b.glyph)
        badge.title = lit ? `Minted on ${b.label}` : `Not minted on ${b.label}`
        badges.appendChild(badge)
      }
      card.appendChild(badges)
    }

    // Stat chips (only non-zero stats; restores for consumables).
    const line = el('div', 'bl-inv-statline')
    let anyStat = false
    if (def.stats) {
      for (const [key, label] of STAT_LABELS) {
        const v = def.stats[key]
        if (!v) continue
        anyStat = true
        const chip = el('span', 'bl-inv-stat')
        chip.appendChild(document.createTextNode(`${label} `))
        chip.appendChild(el('b', '', `+${v}`))
        line.appendChild(chip)
      }
    }
    if (def.restores?.hp) {
      anyStat = true
      const chip = el('span', 'bl-inv-stat')
      chip.appendChild(document.createTextNode('HEALS '))
      chip.appendChild(el('b', '', `${def.restores.hp} HP`))
      line.appendChild(chip)
    }
    if (def.restores?.mp) {
      anyStat = true
      const chip = el('span', 'bl-inv-stat')
      chip.appendChild(document.createTextNode('RESTORES '))
      chip.appendChild(el('b', '', `${def.restores.mp} MP`))
      line.appendChild(chip)
    }
    if (def.levelReq && def.levelReq > 1) {
      anyStat = true
      const chip = el('span', 'bl-inv-stat')
      chip.appendChild(document.createTextNode('REQ LV '))
      chip.appendChild(el('b', '', String(def.levelReq)))
      if (api.player.level < def.levelReq) chip.style.borderColor = 'rgba(198,47,34,0.65)'
      line.appendChild(chip)
    }
    if (anyStat) card.appendChild(line)

    if (def.desc) card.appendChild(el('div', 'bl-inv-desc', def.desc))

    const value = el('div', 'bl-inv-value')
    value.appendChild(document.createTextNode('Vendor value: '))
    value.appendChild(el('b', '', `${def.value}c BLOCK`))
    if (!equippedHere && bagCount > 1) {
      value.appendChild(document.createTextNode(`  ·  ×${bagCount} in bag`))
    }
    card.appendChild(value)

    // --- actions (contextual, all functional) -------------------------------
    const actions = el('div', 'bl-inv-actions')

    if (equippedHere && cardSlot) {
      const slot = cardSlot
      actions.appendChild(
        actionBtn('Unequip', 'bl-primary', () => {
          core.unequip(slot)
          sys(`${def.name} stuffed back in the bag. Enjoy being squishier.`)
          closeDetail()
        })
      )
    } else {
      if (isGearSlot(def.slot)) {
        actions.appendChild(
          actionBtn('Equip', 'bl-primary', () => {
            if (core.equip(id)) {
              sys(`${def.name} equipped. Looking almost competent.`)
              closeDetail()
            } else if ((def.levelReq ?? 1) > api.player.level) {
              sys(`You need level ${def.levelReq} for the ${def.name}. It can smell your inexperience.`)
            } else {
              sys(`The ${def.name} refuses to be equipped. Awkward.`)
            }
          })
        )
      }
      if (def.slot === 'consumable') {
        actions.appendChild(actionBtn('Use', 'bl-primary', () => useConsumable(def)))
      }
      actions.appendChild(
        actionBtn('Drop', 'bl-danger', () => {
          if (core.remove(id, 1)) {
            sys(`One ${def.name} abandoned on the ground. Litterbug.`)
          }
        })
      )
      if (bagCount > 1) {
        actions.appendChild(
          actionBtn(`Drop All (${bagCount})`, 'bl-danger', () => {
            if (core.remove(id, core.count(id))) {
              sys(`Every last ${def.name}, gone. That felt rash, didn't it?`)
            }
          })
        )
      }
    }
    // The one Mint button — hands off to the shared mint flow (chain picker,
    // lazy uid, bundles for stackables). Any item can become an NFT.
    if (mintHooks) {
      const hooks = mintHooks
      actions.appendChild(actionBtn('Mint NFT', 'bl-mint', () => hooks.open(id, def)))
    }
    card.appendChild(actions)
  }

  function openDetail(id: string, fromSlot: string | null): void {
    cardItem = id
    cardSlot = fromSlot
    card.style.display = ''
    renderDetail()
    viewer.show(id, core.def(id).rarity)
  }

  // =========================================================================
  // Open/close + live refresh
  // =========================================================================
  let open = false

  function setOpen(next: boolean): void {
    open = next
    panel.style.display = open ? '' : 'none'
    if (open) renderAll()
    else closeDetail()
  }

  bagBtn.addEventListener('click', () => setOpen(!open))
  closeBtn.addEventListener('click', () => setOpen(false))

  // 'B' / 'I' toggles the bag on keyboards (never while typing in an input).
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'b' || e.key === 'B' || e.key === 'i' || e.key === 'I') {
      setOpen(!open)
    } else if (e.key === 'Escape' && open) {
      if (cardItem) closeDetail()
      else setOpen(false)
    }
  })

  // Any inventory mutation re-renders whatever is visible.
  core.onChange(() => {
    if (!open) return
    renderAll()
    if (cardItem) renderDetail()
  })

  // A real mint landed (badge lit / bundle created) — refresh what's visible.
  events.on('item:minted', () => {
    if (!open) return
    renderAll()
    if (cardItem) renderDetail()
  })

  root.appendChild(bagBtn)
  root.appendChild(panel)
  uiMount.appendChild(root)

  return {
    viewer,
    setMintHooks(hooks) {
      mintHooks = hooks
      if (open) {
        renderAll()
        if (cardItem) renderDetail()
      }
    }
  }
}
