/**
 * Blocklings — the consumable hotbar.
 *
 * Three quick-slots pinned bottom-centre (clear of the joystick and the
 * INTERACT button). Assign any consumable (potions / food) from your bag to a
 * slot, then tap it — or press 1 / 2 / 3 — to drink it mid-fight without opening
 * the inventory. Slot assignments persist (save registry 'hotbar'); a slot keeps
 * its item when the stack hits zero and lights back up when you restock.
 *
 * ECONOMY-SAFE: the hotbar only USES items you already own (removes 1 on use)
 * and applies their catalog `restores` (hp/mp) — it never mints anything.
 *
 * Footgun note: the bar root is a SMALL bottom-centre element (not a
 * full-screen overlay), so the `#ui > *` pointer-events:auto rule only makes
 * the slots themselves tappable and never shadows the game canvas.
 */
import type { GameAPI, InventoryAPI, ItemDef } from '../types'
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import './hotbar.css'

const SLOTS = 3

export interface HotbarModule {
  setInventory(inv: InventoryAPI): void
  setDefSource(fn: (id: string) => ItemDef | undefined): void
  /**
   * Pin a consumable to the hotbar (from the bag's "Pin to Hotbar" button).
   * Fills the first empty slot, else replaces slot 1; a dup already pinned just
   * stays put. Returns the 1-based slot it landed in, or null if not pinnable.
   */
  pin(id: string): number | null
  /** Wire the mounts controller: tapping a slotted mount toggles the ride. */
  setMountToggle(fn: (id: string) => void): void
  dispose(): void
}

let inited = false

export function initHotbar(api: GameAPI): HotbarModule {
  let inv: InventoryAPI | null = null
  let mountToggle: ((id: string) => void) | null = null
  let defSource: ((id: string) => ItemDef | undefined) | null = null
  const slots: (string | null)[] = [null, null, null]

  // --- persistence ---------------------------------------------------------
  saveRegistry.register('hotbar', {
    dump: () => slots.slice(),
    load: (data: unknown) => {
      if (!Array.isArray(data)) return
      for (let i = 0; i < SLOTS; i++) {
        const v = data[i]
        slots[i] = typeof v === 'string' ? v : null
      }
      render()
    }
  })

  const def = (id: string): ItemDef | undefined => defSource?.(id)
  const count = (id: string): number => inv?.count(id) ?? 0

  /** A flask glyph tinted by what it restores (hp→red, mp→blue, both→violet). */
  function flaskSvg(d: ItemDef | undefined): string {
    const r = d?.restores
    const col = r?.hp && r?.mp ? '#b56ad8' : r?.mp ? '#4d9bff' : '#ff5d6a'
    return (
      '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
      '<path d="M9 3h6v2l-1 1v3.5l4 7.5a2 2 0 0 1-1.8 3H7.8A2 2 0 0 1 6 17l4-7.5V6L9 5z" ' +
      `fill="${col}" stroke="#0c1420" stroke-width="1.3" stroke-linejoin="round"/>` +
      '<rect x="8.5" y="2" width="7" height="2.2" rx="1" fill="#d8e2f0"/>' +
      '</svg>'
    )
  }

  // --- DOM ------------------------------------------------------------------
  const root = document.createElement('div')
  root.className = 'bl-hotbar'

  let picker: HTMLElement | null = null

  const slotEls: HTMLElement[] = []
  for (let i = 0; i < SLOTS; i++) {
    const s = document.createElement('div')
    s.className = 'bl-hb-slot'
    s.dataset.i = String(i)
    s.setAttribute('role', 'button')
    s.setAttribute('aria-label', `Hotbar slot ${i + 1}`)
    const key = document.createElement('span')
    key.className = 'bl-hb-key'
    key.textContent = String(i + 1)
    const icon = document.createElement('span')
    icon.className = 'bl-hb-icon'
    const cnt = document.createElement('span')
    cnt.className = 'bl-hb-count'
    const clr = document.createElement('button')
    clr.className = 'bl-hb-clear'
    clr.type = 'button'
    clr.textContent = '×'
    clr.setAttribute('aria-label', 'Clear slot')
    s.append(key, icon, cnt, clr)
    s.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    s.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('bl-hb-clear')) {
        slots[i] = null
        closePicker()
        render()
        events.emit('save:dirty', { why: 'hotbar' })
        return
      }
      const id = slots[i]
      if (id && count(id) > 0) useSlot(i)
      else openPicker(i)
    })
    slotEls.push(s)
    root.appendChild(s)
  }
  ;(document.getElementById('ui') ?? document.body).appendChild(root)

  // --- use ------------------------------------------------------------------
  function useSlot(i: number): void {
    const id = slots[i]
    if (!id || !inv) return
    const d = def(id)
    if (!d) return
    // Mounts toggle a ride (never consumed) instead of being drunk.
    if (d.slot === 'mount') {
      mountToggle?.(id)
      render()
      return
    }
    if (d.slot !== 'consumable') return
    const p = api.player
    const r = d.restores
    const hpRoom = p.maxHp - p.hp
    const mpRoom = p.maxMp - p.mp
    const hpGain = Math.min(r?.hp ?? 0, hpRoom)
    const mpGain = Math.min(r?.mp ?? 0, mpRoom)
    if (hpGain <= 0 && mpGain <= 0) {
      events.emit('chat:system', { text: `Already topped up — the ${d.name} can wait.` })
      return
    }
    if (!inv.remove(id, 1)) return
    p.hp = Math.min(p.maxHp, p.hp + (r?.hp ?? 0))
    p.mp = Math.min(p.maxMp, p.mp + (r?.mp ?? 0))
    const bits: string[] = []
    if (hpGain > 0) bits.push(`+${Math.round(hpGain)} HP`)
    if (mpGain > 0) bits.push(`+${Math.round(mpGain)} MP`)
    events.emit('chat:system', { text: `${d.name}: ${bits.join(', ')}.` })
    render()
  }

  // --- picker (owned consumables) ------------------------------------------
  function ownedConsumables(): { id: string; d: ItemDef; n: number }[] {
    if (!inv) return []
    const out: { id: string; d: ItemDef; n: number }[] = []
    for (const stack of inv.items()) {
      const d = def(stack.id)
      // Consumables (food/potions) AND mounts can be slotted for quick access.
      if (d && (d.slot === 'consumable' || d.slot === 'mount') && stack.qty > 0) {
        out.push({ id: stack.id, d, n: stack.qty })
      }
    }
    return out
  }

  function closePicker(): void {
    picker?.remove()
    picker = null
  }

  function openPicker(slotIndex: number): void {
    closePicker()
    const list = ownedConsumables()
    const pk = document.createElement('div')
    pk.className = 'bl-hb-picker'
    const head = document.createElement('div')
    head.className = 'bl-hb-picker-head'
    head.textContent = list.length ? 'Assign to slot' : 'No consumables yet'
    const close = document.createElement('button')
    close.className = 'bl-hb-picker-x'
    close.type = 'button'
    close.textContent = '×'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      closePicker()
    })
    head.appendChild(close)
    pk.appendChild(head)

    if (!list.length) {
      const hint = document.createElement('div')
      hint.className = 'bl-hb-picker-hint'
      hint.textContent = 'Find or craft potions and food, then assign them here.'
      pk.appendChild(hint)
    }
    for (const { id, d, n } of list) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'bl-hb-picker-row'
      const ic = document.createElement('span')
      ic.className = 'bl-hb-icon'
      ic.innerHTML = flaskSvg(d)
      const nm = document.createElement('span')
      nm.className = 'bl-hb-picker-name'
      nm.textContent = d.name
      const q = document.createElement('span')
      q.className = 'bl-hb-picker-qty'
      q.textContent = `×${n}`
      row.append(ic, nm, q)
      row.addEventListener('click', (e) => {
        e.stopPropagation()
        // if this item sits in another slot, move it (no duplicate slots)
        for (let j = 0; j < SLOTS; j++) if (slots[j] === id) slots[j] = null
        slots[slotIndex] = id
        closePicker()
        render()
        events.emit('save:dirty', { why: 'hotbar' })
      })
      pk.appendChild(row)
    }
    pk.addEventListener('pointerdown', (e) => e.stopPropagation())
    root.appendChild(pk)
    picker = pk
  }

  // --- render ---------------------------------------------------------------
  function render(): void {
    for (let i = 0; i < SLOTS; i++) {
      const el = slotEls[i]!
      const id = slots[i]
      const icon = el.querySelector('.bl-hb-icon') as HTMLElement
      const cnt = el.querySelector('.bl-hb-count') as HTMLElement
      if (!id) {
        el.classList.add('bl-hb-empty')
        el.classList.remove('bl-hb-depleted')
        icon.innerHTML = '<span class="bl-hb-plus">+</span>'
        cnt.textContent = ''
        continue
      }
      const d = def(id)
      const n = count(id)
      el.classList.remove('bl-hb-empty')
      el.classList.toggle('bl-hb-depleted', n <= 0)
      icon.innerHTML = flaskSvg(d)
      cnt.textContent = n > 0 ? String(n) : '0'
    }
  }

  // live-update counts as the bag changes (pickups, crafting, other uses)
  const offGained = events.on('item:gained', () => render())
  const offChanged = events.on('save:dirty', ({ why }) => {
    if (why === 'inv:consume' || why === 'inv:remove' || why === 'loot') render()
  })

  // keyboard 1/2/3 (ignored while typing in chat etc.)
  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat) return
    const t = document.activeElement
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    ) {
      return
    }
    const i = ['1', '2', '3'].indexOf(e.key)
    if (i >= 0) {
      const id = slots[i]
      if (id && count(id) > 0) useSlot(i)
    }
  }
  window.addEventListener('keydown', onKey)

  render()

  return {
    setInventory(i: InventoryAPI): void {
      inv = i
      render()
    },
    setDefSource(fn: (id: string) => ItemDef | undefined): void {
      defSource = fn
      render()
    },
    pin(id: string): number | null {
      const d = def(id)
      if (!d || (d.slot !== 'consumable' && d.slot !== 'mount')) return null
      const existing = slots.indexOf(id)
      if (existing >= 0) {
        render()
        return existing + 1
      }
      let i = slots.indexOf(null)
      if (i < 0) i = 0 // all full → overwrite the first slot
      slots[i] = id
      render()
      events.emit('save:dirty', { why: 'hotbar' })
      events.emit('chat:system', { text: `${d.name} pinned to hotbar slot ${i + 1}.` })
      return i + 1
    },
    setMountToggle(fn: (id: string) => void): void {
      mountToggle = fn
    },
    dispose(): void {
      offGained()
      offChanged()
      window.removeEventListener('keydown', onKey)
      closePicker()
      root.remove()
    }
  }
}

/** Singleton guard mirroring the other HUD modules. */
export function initHotbarOnce(api: GameAPI): HotbarModule | null {
  if (inited) return null
  inited = true
  return initHotbar(api)
}
