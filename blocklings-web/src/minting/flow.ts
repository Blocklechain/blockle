/**
 * Minting — the shared mint dialog (same flow language as the pets panel):
 * chain picker with badges lit per existing MintRecord, re-mint of the SAME
 * uid on other chains allowed, mint state permanent. Calls wallet.mintNft via
 * the integrator-wired setter; a MintRecord is only ever written from a REAL
 * {ok, token, tx} wallet response. Errors are shown verbatim — never dressed
 * up, never fabricated.
 */
import type { ChainId, InventoryAPI, ItemDef, MintRecord, WalletAPI2 } from '../types'
import { events } from '../events'
import { newUid } from '../uid'
import { MintStore, type NftInstance } from './store'
import './minting.css'

export const CHAIN_BADGES: readonly { chain: ChainId; glyph: string; label: string }[] = [
  { chain: 'blockle', glyph: 'B', label: 'Blockle' },
  { chain: 'ethereum', glyph: 'Ξ', label: 'Ethereum' },
  { chain: 'solana', glyph: '◎', label: 'Solana' }
]

/** Rarity colors (same values as the inventory module — kept local so the
 *  module boundary stays clean; the pair must not drift visually). */
const RARITY_COLORS = ['#9aa0a6', '#7ed957', '#6cb8ff', '#b07df2', '#ffb04f', '#ff5c8a'] as const

const MINT_LINES = [
  (n: string, c: string) => `${n} is now an NFT on ${c}. Immortalized. Unlike you.`,
  (n: string, c: string) => `${n} minted on ${c}. The blockchain never forgets. Neither do we.`,
  (n: string, c: string) => `${n} lives on ${c} now. Same item, fancier passport.`,
  (n: string, c: string) => `Minted ${n} on ${c}. Your grandkids can inherit this. Legally murky!`
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

/** Fallback display name from the frozen id conventions (defs win when wired). */
function fallbackName(id: string): string {
  return id
    .split('_')
    .reverse()
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

function isStackSlot(slot: string | undefined): boolean {
  return slot === 'material' || slot === 'consumable'
}

export interface MintFlowDeps {
  store: MintStore
  wallet(): WalletAPI2 | null
  inventory(): InventoryAPI | null
}

export interface MintFlow {
  /** Open the dialog for one catalog item id (def optional — synth fallback). */
  open(id: string, def?: ItemDef): void
  close(): void
  dispose(): void
}

export function createMintFlow(deps: MintFlowDeps): MintFlow {
  const uiMount = document.getElementById('ui')
  if (!uiMount) throw new Error('missing #ui overlay mount')

  const root = el('div', 'bl-mintroot')
  root.style.display = 'none'
  const scrim = el('div', 'bl-mint-scrim')
  const panel = el('div', 'bl-mint')
  root.appendChild(scrim)
  root.appendChild(panel)
  uiMount.appendChild(root)

  let curId: string | null = null
  let curDef: ItemDef | null = null
  let busy = false
  let status: { text: string; ok: boolean } | null = null
  let bundleQty = 1

  function ownedCount(id: string, stackable: boolean): number {
    const inv = deps.inventory()
    if (!inv) return 0
    let n = inv.count(id)
    if (!stackable) {
      for (const eq of Object.values(inv.equipment())) if (eq === id) n++
    }
    return n
  }

  function close(): void {
    if (busy) return
    curId = null
    curDef = null
    status = null
    root.style.display = 'none'
  }

  function open(id: string, def?: ItemDef): void {
    curId = id
    curDef = def ?? null
    status = null
    const stackable = isStackSlot(def?.slot)
    bundleQty = stackable ? Math.max(1, ownedCount(id, true)) : 1
    root.style.display = ''
    render()
  }

  // --- the actual mint ------------------------------------------------------

  async function doMint(target: { kind: 'new'; qty: number } | { kind: 'uid'; uid: string }, chain: ChainId): Promise<void> {
    if (busy || !curId) return
    const id = curId
    const def = curDef
    const name = def?.name ?? fallbackName(id)
    const stackable = isStackSlot(def?.slot)

    const wallet = deps.wallet()
    if (!wallet) {
      status = { text: 'Wallet not connected. The blockchain refuses to take your call.', ok: false }
      render()
      return
    }

    // Resolve uid + qty, escrow bundle goods BEFORE the chain call.
    let uid: string
    let qty = 1
    let isNew = false
    if (target.kind === 'uid') {
      const inst = deps.store.byUid(target.uid)
      if (!inst) {
        status = { text: 'Unknown instance.', ok: false }
        render()
        return
      }
      if (inst.mints.some((m) => m.chain === chain)) {
        status = { text: `Already minted on ${chain} — same UID, one mint per chain.`, ok: false }
        render()
        return
      }
      uid = inst.uid
      qty = inst.qty
    } else {
      isNew = true
      qty = stackable ? Math.max(1, Math.floor(target.qty)) : 1
      const inv = deps.inventory()
      if (!inv) {
        status = { text: 'Inventory not available.', ok: false }
        render()
        return
      }
      if (stackable) {
        // Escrow the goods into the bundle-to-be. Returned loudly on failure.
        if (!inv.remove(id, qty)) {
          status = { text: `You don't have ${qty} × ${name} to bundle.`, ok: false }
          render()
          return
        }
      } else if (ownedCount(id, false) - deps.store.gearCount(id) < 1) {
        status = { text: `Every ${name} you own is already an NFT.`, ok: false }
        render()
        return
      }
      // Lazy canonical uid: assigned at first mint intent, embedded on-chain.
      uid = newUid()
    }

    busy = true
    status = { text: 'Minting… wallet-signed, on a real chain. Hold still.', ok: true }
    render()

    const attrs: Record<string, string | number> = { itemId: id, qty }
    if (def) {
      attrs['slot'] = def.slot
      attrs['rarity'] = def.rarity
    }
    const res = await wallet.mintNft(chain, uid, {
      name: qty > 1 ? `${name} ×${qty}` : name,
      desc:
        `Blocklings ${qty > 1 ? `bundle of ${qty}× ${name}` : name}. ` +
        `Canonical UID ${uid} — the same single item across every chain it is minted on.`,
      attrs
    })

    busy = false

    // NEVER fabricate: a MintRecord exists only on a real token + tx.
    if (!res.ok || !res.token || !res.tx) {
      if (isNew && stackable) {
        // Un-escrow the bundle goods — the mint did not happen.
        deps.inventory()?.add(id, qty, 'restore')
      }
      status = { text: res.error ?? 'Mint failed (wallet returned no token/tx).', ok: false }
      render()
      return
    }

    const rec: MintRecord = { chain, token: res.token, tx: res.tx, t: Date.now() }
    const stored = isNew ? deps.store.addMinted(id, uid, qty, rec) !== null : deps.store.recordMint(uid, rec)
    if (!stored) {
      // Should be unreachable; stay honest if it ever happens.
      status = { text: `Minted on ${chain} (tx ${res.tx}) but the local ledger refused the record — report this.`, ok: false }
      render()
      return
    }

    events.emit('item:minted', { uid, chain, token: res.token })
    const line = MINT_LINES[Math.floor(Math.random() * MINT_LINES.length)]!
    events.emit('chat:system', { text: line(qty > 1 ? `${name} ×${qty}` : name, chain) })
    status = { text: `Minted on ${chain} — tx ${res.tx.slice(0, 18)}…`, ok: true }
    render()
  }

  // --- rendering ------------------------------------------------------------

  function badgeRow(inst: NftInstance): HTMLElement {
    const row = el('div', 'bl-mint-badges')
    for (const b of CHAIN_BADGES) {
      const rec = inst.mints.find((m) => m.chain === b.chain)
      const btn = el('button', `bl-mint-badge${rec ? ' bl-mint-badge-lit' : ''}`, b.glyph)
      btn.type = 'button'
      if (rec) {
        btn.disabled = true
        btn.title = `Minted on ${b.label} — tx ${rec.tx}`
      } else {
        btn.disabled = busy
        btn.title = `Mint this same UID on ${b.label}`
        btn.addEventListener('click', () => {
          void doMint({ kind: 'uid', uid: inst.uid }, b.chain)
        })
      }
      row.appendChild(btn)
    }
    return row
  }

  function chainButtons(onPick: (chain: ChainId) => void): HTMLElement {
    const row = el('div', 'bl-mint-chains')
    for (const b of CHAIN_BADGES) {
      const btn = el('button', 'bl-mint-chain-btn', `${b.glyph} ${b.label}`)
      btn.type = 'button'
      btn.disabled = busy
      btn.addEventListener('click', () => onPick(b.chain))
      row.appendChild(btn)
    }
    return row
  }

  function render(): void {
    if (!curId) return
    const id = curId
    const def = curDef
    const name = def?.name ?? fallbackName(id)
    const stackable = isStackSlot(def?.slot)
    const instances = deps.store.of(id)
    const owned = ownedCount(id, stackable)

    panel.textContent = ''

    const head = el('div', 'bl-mint-head')
    head.appendChild(el('span', 'bl-mint-title', 'Mint as NFT'))
    const closeBtn = el('button', 'bl-mint-close', '×')
    closeBtn.type = 'button'
    closeBtn.setAttribute('aria-label', 'Close mint dialog')
    closeBtn.disabled = busy
    closeBtn.addEventListener('click', close)
    head.appendChild(closeBtn)
    panel.appendChild(head)

    const nameEl = el('div', 'bl-mint-item', name)
    nameEl.style.color = RARITY_COLORS[def?.rarity ?? 0] ?? RARITY_COLORS[0]
    panel.appendChild(nameEl)
    panel.appendChild(
      el(
        'div',
        'bl-mint-law',
        'One canonical UID per instance. Re-minting the same UID on another chain is allowed — still one item, extra chain badge. Mint state is permanent and travels on trade.'
      )
    )

    // -- existing minted instances -------------------------------------------
    if (instances.length > 0) {
      panel.appendChild(el('div', 'bl-mint-sect', stackable ? 'Your minted bundles' : 'Your minted copies'))
      for (const inst of instances) {
        const row = el('div', 'bl-mint-inst')
        const label = el('div', 'bl-mint-inst-label')
        label.appendChild(el('span', 'bl-mint-inst-name', inst.qty > 1 ? `Bundle ×${inst.qty}` : 'Copy'))
        const uidEl = el('span', 'bl-mint-inst-uid', inst.uid)
        uidEl.title = `Canonical UID ${inst.uid}`
        label.appendChild(uidEl)
        row.appendChild(label)
        row.appendChild(badgeRow(inst))
        panel.appendChild(row)
      }
    }

    // -- new mint -------------------------------------------------------------
    if (stackable) {
      if (owned > 0) {
        panel.appendChild(el('div', 'bl-mint-sect', 'Mint a new bundle'))
        const qtyRow = el('div', 'bl-mint-qtyrow')
        const minus = el('button', 'bl-mint-qty-btn', '−')
        minus.type = 'button'
        const plus = el('button', 'bl-mint-qty-btn', '+')
        plus.type = 'button'
        const qtyEl = el('span', 'bl-mint-qty', `×${Math.min(bundleQty, owned)}`)
        bundleQty = Math.min(Math.max(1, bundleQty), owned)
        minus.disabled = busy || bundleQty <= 1
        plus.disabled = busy || bundleQty >= owned
        minus.addEventListener('click', () => {
          bundleQty = Math.max(1, bundleQty - 1)
          render()
        })
        plus.addEventListener('click', () => {
          bundleQty = Math.min(owned, bundleQty + 1)
          render()
        })
        qtyRow.appendChild(minus)
        qtyRow.appendChild(qtyEl)
        qtyRow.appendChild(plus)
        qtyRow.appendChild(
          el('span', 'bl-mint-qty-hint', `of ${owned} in bag — the bundle leaves your stacks and becomes one unstackable NFT item`)
        )
        panel.appendChild(qtyRow)
        panel.appendChild(chainButtons((chain) => void doMint({ kind: 'new', qty: bundleQty }, chain)))
      } else if (instances.length === 0) {
        panel.appendChild(el('div', 'bl-mint-none', `No ${name} in the bag to bundle. Go earn some.`))
      }
    } else {
      const free = owned - deps.store.gearCount(id)
      if (free > 0) {
        panel.appendChild(el('div', 'bl-mint-sect', instances.length > 0 ? 'Mint another copy' : 'Mint this item'))
        panel.appendChild(
          el('div', 'bl-mint-qty-hint', `${free} unminted ${free === 1 ? 'copy' : 'copies'} owned — pick a chain:`)
        )
        panel.appendChild(chainButtons((chain) => void doMint({ kind: 'new', qty: 1 }, chain)))
      } else if (owned > 0) {
        panel.appendChild(el('div', 'bl-mint-none', 'Every copy you own is minted. A true cross-chain hoarder.'))
      }
    }

    // -- status ---------------------------------------------------------------
    if (status) {
      const st = el('div', `bl-mint-status${status.ok ? ' bl-mint-status-ok' : ' bl-mint-status-err'}`, status.text)
      panel.appendChild(st)
    }
  }

  scrim.addEventListener('click', close)
  deps.store.onChange(() => {
    if (curId) render()
  })

  return {
    open,
    close,
    dispose() {
      root.remove()
    }
  }
}
