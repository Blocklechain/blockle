/**
 * Market — in-game storefront panel (HUD button + browse / my-listings / sell).
 *
 * Medieval-dark plates matching hud.css/inventory.css. Listing cards show the
 * live spinning 3D model of the goods (CardSpinner: one shared WebGL context
 * blitted to every card). Buy flows confirm before touching anything:
 *   GOLD   -> one tap-through confirm, settled atomically server-side.
 *   CRYPTO -> explicit confirm naming the exact amount, chain and the seller's
 *             address; the payment is REAL and wallet-signed (sendOn), and the
 *             completion status is shown honestly ('verified on-chain' for
 *             BLOCK, 'payment attested' for ETH/SOL).
 * Sell flow: pick goods from your bag or your pets; GOLD pricing for anything,
 * crypto pricing ONLY for goods minted on the price chain (NFT law) — the UI
 * greys the rail out and says why instead of pretending.
 */
import type { ChainId, ItemInstance, ListingFilters, PetInstance } from '../types'
import { petDef } from '../ids'
import type { MarketInternal, WireListing } from './index'
import { CardSpinner, placeholderMesh } from './viewer'
import './market.css'

const CHAIN_LABEL: Record<ChainId, string> = { blockle: 'BLOCK', ethereum: 'ETH', solana: 'SOL' }

/** Flat market-stall icon (custom SVG — no emoji, per product rule). */
const STALL_SVG =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3.5 9 5 4.5h14L20.5 9"/>' +
  '<path d="M3.5 9c0 1.2 1 2.2 2.3 2.2S8 10.2 8 9c0 1.2 1 2.2 2.3 2.2S12.5 10.2 12.5 9c0 1.2 1 2.2 2.3 2.2S17 10.2 17 9c0 1.2 1 2.2 2.3 2.2.7 0 1.2-.3 1.2-.3"/>' +
  '<path d="M5 11.5V19.5h14v-8"/><path d="M9 19.5v-5h6v5"/>' +
  '</svg>'

const COIN_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10" fill="#e8c15a" stroke="#8a6508" stroke-width="2"/>' +
  '<rect x="10.9" y="7.8" width="2.2" height="8.4" rx="1.1" fill="#b8860b"/></svg>'

type Tab = 'browse' | 'mine' | 'sell'

export interface MarketUI {
  refreshIfOpen(): void
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function btn(cls: string, label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = label
  return b
}

function priceLabel(w: WireListing): string {
  if (typeof w.price.gold === 'number') return `${w.price.gold.toLocaleString()} GOLD`
  return `${w.price.amount} ${CHAIN_LABEL[(w.price.chain as ChainId) ?? 'blockle']}`
}

export function createMarketUI(mk: MarketInternal): MarketUI {
  const root = el('div', 'mk-root')
  ;(document.getElementById('ui') ?? document.body).appendChild(root)

  // ---- open button (joins the HUD top-right cluster like the gold chip) ----
  const openBtn = document.createElement('button')
  openBtn.type = 'button'
  openBtn.className = 'mk-btn'
  openBtn.title = 'Marketplace'
  openBtn.setAttribute('aria-label', 'Marketplace')
  openBtn.innerHTML = STALL_SVG
  openBtn.addEventListener('click', () => toggle())
  root.appendChild(openBtn)

  // ---- panel ---------------------------------------------------------------
  const panel = el('div', 'mk-panel')
  panel.style.display = 'none'
  root.appendChild(panel)

  const head = el('div', 'mk-head')
  head.appendChild(el('div', 'mk-title', 'Marketplace'))
  const tabs = el('div', 'mk-tabs')
  const tabBtns: Record<Tab, HTMLButtonElement> = {
    browse: btn('mk-tab', 'Browse'),
    mine: btn('mk-tab', 'My listings'),
    sell: btn('mk-tab', 'Sell')
  }
  for (const t of Object.keys(tabBtns) as Tab[]) {
    tabBtns[t].addEventListener('click', () => setTab(t))
    tabs.appendChild(tabBtns[t])
  }
  head.appendChild(tabs)
  const closeBtn = btn('mk-close', '×')
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.addEventListener('click', () => toggle(false))
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const body = el('div', 'mk-body')
  panel.appendChild(body)

  const status = el('div', 'mk-status')
  panel.appendChild(status)

  const spinner = new CardSpinner()
  let open = false
  let tab: Tab = 'browse'
  let busy = false

  function say(text: string, bad = false): void {
    status.textContent = text
    status.classList.toggle('mk-status-bad', bad)
  }

  function toggle(v = !open): void {
    open = v
    panel.style.display = open ? '' : 'none'
    if (open) {
      void render()
    } else {
      spinner.stop()
      spinner.clear()
    }
  }

  function setTab(t: Tab): void {
    tab = t
    void render()
  }

  // ---- card helpers --------------------------------------------------------
  function goodsCard(w: WireListing): HTMLElement {
    const card = el('div', 'mk-card')
    const canvas = document.createElement('canvas')
    canvas.className = 'mk-card-viewer'
    card.appendChild(canvas)
    spinner.add(canvas, mk.mesh(w) ?? placeholderMesh())

    const name = el('div', 'mk-card-name', mk.goodsName(w))
    if (w.kind === 'item' && w.item?.defId) {
      const d = mk.def(w.item.defId)
      if (d) name.classList.add('mk-r' + d.rarity)
    }
    card.appendChild(name)
    card.appendChild(el('div', 'mk-card-seller', w.seller))

    const mints = (w.kind === 'item' ? w.item?.mints : w.pet?.mints) ?? []
    if (mints.length) {
      const badges = el('div', 'mk-badges')
      for (const m of mints) badges.appendChild(el('span', 'mk-badge mk-badge-' + m.chain, CHAIN_LABEL[m.chain]))
      card.appendChild(badges)
    }

    const price = el('div', 'mk-price')
    if (typeof w.price.gold === 'number') price.innerHTML = COIN_SVG + ' '
    price.appendChild(document.createTextNode(priceLabel(w)))
    card.appendChild(price)
    return card
  }

  // ---- confirm overlay -----------------------------------------------------
  function confirmBox(lines: string[], okLabel: string): Promise<boolean> {
    return new Promise((resolve) => {
      const veil = el('div', 'mk-veil')
      const box = el('div', 'mk-confirm')
      for (const l of lines) box.appendChild(el('p', 'mk-confirm-line', l))
      const row = el('div', 'mk-confirm-row')
      const no = btn('mk-b mk-b-ghost', 'Cancel')
      const yes = btn('mk-b mk-b-gold', okLabel)
      no.addEventListener('click', () => {
        veil.remove()
        resolve(false)
      })
      yes.addEventListener('click', () => {
        veil.remove()
        resolve(true)
      })
      row.appendChild(no)
      row.appendChild(yes)
      box.appendChild(row)
      veil.appendChild(box)
      panel.appendChild(veil)
    })
  }

  // ---- browse tab ----------------------------------------------------------
  const filters: ListingFilters = {}
  function browseView(): void {
    const bar = el('div', 'mk-filters')

    const kindSel = document.createElement('select')
    kindSel.className = 'mk-sel'
    for (const [v, l] of [['', 'Everything'], ['item', 'Items'], ['pet', 'Pets']] as const) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = l
      kindSel.appendChild(o)
    }
    kindSel.value = filters.kind ?? ''

    const railSel = document.createElement('select')
    railSel.className = 'mk-sel'
    for (const [v, l] of [['', 'Any price'], ['gold', 'GOLD only'], ['blockle', 'BLOCK'], ['ethereum', 'ETH'], ['solana', 'SOL']] as const) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = l
      railSel.appendChild(o)
    }
    railSel.value = filters.gold ? 'gold' : filters.chain ?? ''

    const text = document.createElement('input')
    text.className = 'mk-input'
    text.placeholder = 'Search…'
    text.value = filters.text ?? ''

    const go = btn('mk-b mk-b-gold', 'Filter')
    go.addEventListener('click', () => {
      const kind = kindSel.value
      if (kind === 'item' || kind === 'pet') filters.kind = kind
      else delete filters.kind
      if (railSel.value === 'gold') filters.gold = true
      else delete filters.gold
      if (railSel.value && railSel.value !== 'gold') filters.chain = railSel.value as ChainId
      else delete filters.chain
      const q = text.value.trim()
      if (q) filters.text = q
      else delete filters.text
      void render()
    })
    bar.appendChild(kindSel)
    bar.appendChild(railSel)
    bar.appendChild(text)
    bar.appendChild(go)
    body.appendChild(bar)

    const grid = el('div', 'mk-grid')
    body.appendChild(grid)
    void (async () => {
      const rows = await mk.wireRows(false, filters)
      if (!rows.length) {
        grid.appendChild(el('div', 'mk-empty', 'Nothing for sale right now. The economy awaits your contribution.'))
        return
      }
      for (const w of rows) {
        const card = goodsCard(w)
        const buy = btn('mk-b mk-b-gold mk-card-buy', typeof w.price.gold === 'number' ? 'Buy' : 'Buy (wallet)')
        buy.addEventListener('click', () => void doBuy(w))
        card.appendChild(buy)
        grid.appendChild(card)
      }
    })()
  }

  async function doBuy(w: WireListing): Promise<void> {
    if (busy) return
    const name = mk.goodsName(w)
    let okGo: boolean
    if (typeof w.price.gold === 'number') {
      okGo = await confirmBox([`Buy ${name} for ${w.price.gold.toLocaleString()} GOLD?`, 'GOLD settles instantly and is non-refundable.'], 'Buy')
    } else {
      const chain = (w.price.chain as ChainId) ?? 'blockle'
      okGo = await confirmBox(
        [
          `Buy ${name} for ${w.price.amount} ${CHAIN_LABEL[chain]}?`,
          `This sends a REAL, wallet-signed payment on ${chain} to the seller's address:`,
          w.price.address ?? '',
          chain === 'blockle'
            ? 'The sale completes once the payment is verified on-chain.'
            : 'The sale completes as "payment attested" — keep your tx id.'
        ],
        'Pay & buy'
      )
    }
    if (!okGo) return
    busy = true
    say('Buying…')
    const r = await mk.api.buy(w.id)
    busy = false
    if (r.ok) {
      say(`Bought ${name}.`)
      void render()
    } else {
      say(r.error ?? 'Purchase failed.', true)
    }
  }

  // ---- my listings tab -----------------------------------------------------
  function mineView(): void {
    const listEl = el('div', 'mk-rows')
    body.appendChild(listEl)
    void (async () => {
      if (!mk.signedIn()) {
        listEl.appendChild(el('div', 'mk-empty', 'Sign in to a Blockle account to see your listings.'))
        return
      }
      const rows = await mk.wireRows(true)
      if (!rows.length) {
        listEl.appendChild(el('div', 'mk-empty', 'No listings yet. The Sell tab beckons.'))
        return
      }
      for (const w of rows) {
        const row = el('div', 'mk-row')
        row.appendChild(el('span', 'mk-row-name', mk.goodsName(w)))
        row.appendChild(el('span', 'mk-row-price', priceLabel(w)))
        const st =
          w.status === 'sold'
            ? w.payment === 'verified'
              ? 'sold · verified on-chain'
              : w.payment === 'attested'
                ? 'sold · payment attested by buyer'
                : 'sold'
            : w.status
        row.appendChild(el('span', 'mk-row-status mk-st-' + w.status, st + (w.mineAs === 'buyer' ? ' (bought)' : '')))
        if (w.mineAs === 'seller' && w.status === 'open') {
          const c = btn('mk-b mk-b-ghost', 'Cancel')
          c.addEventListener('click', () => {
            void (async () => {
              const r = await mk.cancel(w.id)
              say(r.ok ? 'Listing cancelled.' : r.error ?? 'Cancel failed.', !r.ok)
              void render()
            })()
          })
          row.appendChild(c)
        }
        listEl.appendChild(row)
      }
    })()
  }

  // ---- sell tab ------------------------------------------------------------
  function sellView(): void {
    if (!mk.signedIn()) {
      body.appendChild(el('div', 'mk-empty', 'Sign in to a Blockle account to sell.'))
      return
    }
    const wrap = el('div', 'mk-sell')
    body.appendChild(wrap)

    const pick = el('div', 'mk-sell-pick')
    wrap.appendChild(el('div', 'mk-sub', 'Pick goods to sell'))
    wrap.appendChild(pick)

    const inv = mk.inventory()
    const equipped = new Set(Object.values(inv?.equipment() ?? {}).filter(Boolean))
    const minted = mk.minted()
    const stacks = (inv?.items() ?? []).filter((s) => s.qty > 0)
    const petList = mk.pets()?.list() ?? []

    let chosen: { item: ItemInstance } | { pet: PetInstance } | null = null
    let chosenEl: HTMLElement | null = null
    const form = el('div', 'mk-sell-form')

    function choose(goods: { item: ItemInstance } | { pet: PetInstance }, elBtn: HTMLElement): void {
      chosen = goods
      chosenEl?.classList.remove('mk-chip-on')
      chosenEl = elBtn
      elBtn.classList.add('mk-chip-on')
      buildForm()
    }

    if (!stacks.length && !petList.length && !minted.length) {
      pick.appendChild(el('div', 'mk-empty', 'Nothing sellable yet — go earn something.'))
    }
    // Minted instances first (uid + mints travel with the goods => crypto rails).
    for (const m of minted) {
      if (!inv || inv.count(m.id) < 1) continue // escrow goes through the bag
      const d = mk.def(m.id)
      const chains = (m.mints ?? []).map((x) => CHAIN_LABEL[x.chain]).join('/')
      const chip = btn('mk-chip', `${d?.name ?? m.id} · NFT${chains ? ' (' + chains + ')' : ''}`)
      chip.addEventListener('click', () => choose({ item: m }, chip))
      pick.appendChild(chip)
    }
    for (const s of stacks) {
      const d = mk.def(s.id)
      const chip = btn('mk-chip', `${d?.name ?? s.id} ×${s.qty}${equipped.has(s.id) ? ' (equipped)' : ''}`)
      chip.addEventListener('click', () => choose({ item: { id: s.id } }, chip))
      pick.appendChild(chip)
    }
    for (const p of petList) {
      const d = petDef(p.petId)
      const chip = btn('mk-chip mk-chip-pet', p.nickname || d?.name || p.petId)
      chip.addEventListener('click', () => choose({ pet: p }, chip))
      pick.appendChild(chip)
    }
    wrap.appendChild(form)

    function buildForm(): void {
      form.textContent = ''
      if (!chosen) return
      const inst = 'item' in chosen ? chosen.item : chosen.pet
      const mints = inst.mints ?? []

      form.appendChild(el('div', 'mk-sub', 'Price'))
      const railSel = document.createElement('select')
      railSel.className = 'mk-sel'
      const goldOpt = document.createElement('option')
      goldOpt.value = 'gold'
      goldOpt.textContent = 'GOLD'
      railSel.appendChild(goldOpt)
      for (const c of ['blockle', 'ethereum', 'solana'] as ChainId[]) {
        const o = document.createElement('option')
        o.value = c
        o.textContent = CHAIN_LABEL[c] + ' (crypto)'
        o.disabled = !inst.uid || !mints.some((m) => m.chain === c)
        railSel.appendChild(o)
      }
      const amount = document.createElement('input')
      amount.className = 'mk-input'
      amount.type = 'number'
      amount.min = '0'
      amount.placeholder = 'Amount'

      const note = el('div', 'mk-note')
      function syncNote(): void {
        if (railSel.value === 'gold') {
          note.textContent = 'GOLD sales settle instantly to your account balance.'
        } else {
          note.textContent = `Paid straight to YOUR ${railSel.value} wallet address — non-custodial.`
        }
      }
      railSel.addEventListener('change', syncNote)
      syncNote()
      if (!inst.uid || !mints.length) {
        form.appendChild(el('div', 'mk-note mk-note-dim', 'Crypto pricing needs this minted as an NFT first (gold sales need no mint).'))
      }

      const go = btn('mk-b mk-b-gold', 'List it')
      go.addEventListener('click', () => {
        void (async () => {
          if (busy || !chosen) return
          const v = Number(amount.value)
          if (!Number.isFinite(v) || v <= 0) {
            say('Enter a price.', true)
            return
          }
          busy = true
          say('Listing…')
          const price =
            railSel.value === 'gold'
              ? { gold: Math.floor(v) }
              : { chain: railSel.value as ChainId, amount: v }
          const r = await mk.api.list(chosen, price)
          busy = false
          if (r.ok) {
            say('Listed. Good luck out there.')
            setTab('mine')
          } else {
            say(r.error ?? 'Listing failed.', true)
          }
        })()
      })

      form.appendChild(railSel)
      form.appendChild(amount)
      form.appendChild(note)
      form.appendChild(go)
    }
  }

  // ---- render --------------------------------------------------------------
  async function render(): Promise<void> {
    spinner.clear()
    body.textContent = ''
    say('')
    for (const t of Object.keys(tabBtns) as Tab[]) tabBtns[t].classList.toggle('mk-tab-on', t === tab)
    if (tab === 'browse') browseView()
    else if (tab === 'mine') mineView()
    else sellView()
  }

  return {
    refreshIfOpen(): void {
      if (open && tab === 'mine') void render()
    }
  }
}
