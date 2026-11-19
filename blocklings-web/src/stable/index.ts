/**
 * The Stable — spend GOLD (server-authoritative IAP currency) on ULTRA-RARE
 * mounts (+40% move speed). Mounts also drop at 1/8000 and are NFT-mintable +
 * sellable like any item; this is the gold-purchase path.
 *
 * ECONOMY LAW: GOLD is debited SERVER-SIDE via spendGold(); the item is only
 * granted on {ok:true}. Balances are always read live — never fabricated.
 */
import type { GameAPI, GoldAPI, InventoryAPI, ItemDef } from '../types'
import { events } from '../events'
import { PURCHASABLE_MOUNTS } from '../items/catalog'
import { RARITY_COLORS, RARITY_NAMES } from '../inventory/defs'
import { ItemViewer } from '../inventory/viewer'
import './stable.css'


export interface MountShopModule {
  setGold(g: GoldAPI): void
  setSpend(fn: (amount: number, reason: string) => Promise<{ ok: boolean; error?: string }>): void
  setInventory(inv: InventoryAPI): void
  setDefSource(fn: (id: string) => ItemDef | undefined): void
  setMeshSource(fn: (id: string) => import('three').Group): void
  open(): void
  dispose(): void
}

type SpendFn = (amount: number, reason: string) => Promise<{ ok: boolean; error?: string }>

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const HOOF_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M7 3c-2 0-3.5 2-3.5 5 0 2.4 1 4 1 6.5 0 2 1.2 3.5 2.8 3.5 1.3 0 1.9-1 1.9-2.4 0-1.8-.7-2.6-.7-4.6 0-2 .7-3 .7-4.6C9.9 4.3 8.8 3 7 3Zm10 0c-1.8 0-2.9 1.3-2.9 3.4 0 1.6.7 2.6.7 4.6 0 2-.7 2.8-.7 4.6 0 1.4.6 2.4 1.9 2.4 1.6 0 2.8-1.5 2.8-3.5 0-2.5 1-4.1 1-6.5 0-3-1.5-5-3.5-5Z"/></svg>'

export function initStable(api: GameAPI): MountShopModule {
  void api
  let gold: GoldAPI | null = null
  let spend: SpendFn | null = null
  let inv: InventoryAPI | null = null
  let defSource: ((id: string) => ItemDef | undefined) | null = null
  const uiMount = document.getElementById('ui') ?? document.body

  // No HUD button: the Stable is opened by talking to Stablemaster Jeb in the
  // starting village (main.ts wires setStableOpener(stable.open)).

  // --- panel --------------------------------------------------------------
  const back = el('div', 'bl-stable-back')
  back.style.display = 'none'
  back.addEventListener('click', (e) => {
    if (e.target === back) close()
  })
  const panel = el('div', 'bl-stable')
  back.appendChild(panel)

  const head = el('div', 'bl-stable-head')
  head.innerHTML = '<span class="bl-stable-title">' + HOOF_SVG + ' The Stable</span>'
  const balEl = el('span', 'bl-stable-bal', '—')
  head.appendChild(balEl)
  const x = el('button', 'bl-stable-x', '×')
  x.type = 'button'
  x.addEventListener('click', () => close())
  head.appendChild(x)
  panel.appendChild(head)

  panel.appendChild(el('p', 'bl-stable-sub', 'Ultra-rare rides — +40% move speed. Slot one on your hotbar to mount up.'))

  // preview (one shared WebGL viewer) + selected mount detail
  const preview = el('div', 'bl-stable-preview')
  const viewer = new ItemViewer()
  viewer.canvas.classList.add('bl-stable-canvas')
  preview.appendChild(viewer.canvas)
  const selName = el('div', 'bl-stable-selname', '')
  const selDesc = el('div', 'bl-stable-seldesc', '')
  const selWrap = el('div', 'bl-stable-selwrap')
  selWrap.appendChild(selName)
  selWrap.appendChild(selDesc)
  preview.appendChild(selWrap)
  panel.appendChild(preview)

  const list = el('div', 'bl-stable-list')
  panel.appendChild(list)

  const foot = el('p', 'bl-stable-foot', '')
  const getGold = el('button', 'bl-stable-getgold', 'Get more GOLD')
  getGold.type = 'button'
  getGold.addEventListener('click', () => gold?.openStore())
  foot.appendChild(getGold)
  panel.appendChild(foot)

  uiMount.appendChild(back)

  let balance = 0
  let selected: string | null = null

  function selectMount(id: string): void {
    selected = id
    const d = defSource?.(id)
    selName.textContent = d?.name ?? id
    selName.style.color = RARITY_COLORS[(d?.rarity ?? 5) as number] ?? RARITY_COLORS[5]
    selDesc.textContent = d?.desc ?? ''
    viewer.show(id, (d?.rarity ?? 5) as 0 | 1 | 2 | 3 | 4 | 5)
  }

  function renderBalance(): void {
    balEl.textContent = `${balance.toLocaleString()} GOLD`
  }

  async function refreshBalance(): Promise<void> {
    if (!gold) return
    try {
      balance = await gold.balance()
    } catch {
      /* keep last known; never fabricate */
    }
    renderBalance()
  }

  async function buy(id: string, price: number, buyBtn: HTMLButtonElement): Promise<void> {
    if (!spend) return
    if (balance < price) {
      events.emit('chat:system', { text: `Not enough GOLD for that mount — you need ${price}.` })
      gold?.openStore()
      return
    }
    buyBtn.disabled = true
    buyBtn.textContent = '…'
    try {
      const r = await spend(price, 'mount:' + id)
      if (r.ok) {
        inv?.add(id, 1, 'vendor')
        const name = defSource?.(id)?.name ?? 'mount'
        events.emit('chat:system', { text: `Bought ${name}! Slot it on your hotbar to ride.` })
        await refreshBalance()
      } else {
        events.emit('chat:system', { text: r.error ?? 'Purchase failed — try again.' })
      }
    } catch {
      events.emit('chat:system', { text: 'Purchase failed — try again.' })
    } finally {
      render()
    }
  }

  function render(): void {
    list.innerHTML = ''
    for (const { id, price } of PURCHASABLE_MOUNTS) {
      const d = defSource?.(id)
      const owned = (inv?.count(id) ?? 0) > 0
      const row = el('div', 'bl-stable-row')
      row.addEventListener('click', () => selectMount(id))

      const info = el('div', 'bl-stable-info')
      const nameLine = el('div', 'bl-stable-name', d?.name ?? id)
      nameLine.style.color = RARITY_COLORS[(d?.rarity ?? 5) as number] ?? RARITY_COLORS[5]
      if (owned) {
        const badge = el('span', 'bl-stable-owned', 'Owned')
        nameLine.appendChild(badge)
      }
      info.appendChild(nameLine)
      info.appendChild(el('div', 'bl-stable-rarity', `${RARITY_NAMES[(d?.rarity ?? 5) as number] ?? 'Mythic'} · +40% speed`))
      row.appendChild(info)

      const priceEl = el('span', 'bl-stable-price', `${price.toLocaleString()} G`)
      row.appendChild(priceEl)

      const buyBtn = el('button', 'bl-stable-buy', owned ? 'Buy again' : 'Buy')
      buyBtn.type = 'button'
      buyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void buy(id, price, buyBtn)
      })
      row.appendChild(buyBtn)
      list.appendChild(row)
    }
  }

  function open(): void {
    render()
    if (!selected) selectMount(PURCHASABLE_MOUNTS[0]?.id ?? 'mount_direwolf')
    back.style.display = ''
    void refreshBalance()
  }
  function close(): void {
    back.style.display = 'none'
    viewer.stop()
  }

  events.on('gold:changed', ({ balance: b }) => {
    balance = b
    renderBalance()
  })

  return {
    setGold(g: GoldAPI): void {
      gold = g
      void refreshBalance()
    },
    setSpend(fn: SpendFn): void {
      spend = fn
    },
    setInventory(i: InventoryAPI): void {
      inv = i
    },
    setDefSource(fn: (id: string) => ItemDef | undefined): void {
      defSource = fn
    },
    setMeshSource(fn: (id: string) => import('three').Group): void {
      viewer.setMeshSource(fn)
    },
    open,
    dispose(): void {
      viewer.stop()
      back.remove()
    }
  }
}
