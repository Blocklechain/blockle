/**
 * Blocklings — player marketplace module (contract MarketAPI + storefront UI).
 *
 * Server: services/accounts /account/api/game/market* — listings live on the
 * Blockle account. Settlement truth:
 *   GOLD  -> settles ATOMICALLY server-side (one ledger txn debits buyer,
 *            credits seller, flips the listing). Goods escrow INTO the listing
 *            at list time (removed from this save) and the buy response hands
 *            them to the buyer's save.
 *   CRYPTO-> real, wallet-signed: the buyer pays the seller's own address via
 *            WalletAPI2.sendOn, then posts the txid. BLOCK payments are
 *            verified on-chain by the server (explorer) before completing;
 *            ETH/SOL complete with an HONEST 'payment attested by buyer'
 *            status. We never fabricate balances/txids/receipts.
 *
 * ECONOMY LAW: a crypto-priced listing REQUIRES minted goods (uid + a
 * MintRecord on the price chain); gold listings need no mint.
 *
 * Module wiring (integrator):
 *   const market = initMarket(api)
 *   market.setGold(gold)                       // GoldAPI (balance for buy checks)
 *   market.setWallet(wallet2)                  // WalletAPI2 (crypto rail)
 *   market.setInventory(inv)                   // escrow/restore/deliver items
 *   market.setPets({ list, remove, add })      // escrow/restore/deliver pets
 *   market.setMeshSource((id) => items.buildMesh(id))      // spinning item cards
 *   market.setPetMeshSource((petId) => pets.buildMesh(petId)) // spinning pet cards
 *   market.setDefSource((id) => items.def(id))
 */
import type * as THREE from 'three'
import type {
  ChainId, GameAPI, GoldAPI, InventoryAPI, ItemDef, ItemInstance, Listing,
  ListingFilters, ListingPrice, MarketAPI, PetInstance, WalletAPI2
} from '../types'
import { events } from '../events'
import { petDef } from '../ids'
import { createMarketUI } from './ui'

const ORIGIN = 'https://blockle.org'
const POLL_MS = 30_000
const PAID_RETRIES = 8
const PAID_RETRY_MS = 5_000

// ---------------------------------------------------------------------------
// Wire shapes (what the accounts service speaks)
// ---------------------------------------------------------------------------

/** Server listing payloads: items are {defId,qty,...}, pets are {petId,...}. */
interface WireGoods {
  defId?: string
  petId?: string
  qty?: number
  uid?: string
  mints?: { chain: ChainId; token: string; tx: string; t: number }[]
  nickname?: string
  meta?: { name?: string }
}
interface WirePrice {
  gold?: number
  chain?: ChainId
  amount?: number
  address?: string
}
export interface WireListing {
  id: string
  seller: string
  kind: 'item' | 'pet'
  item?: WireGoods
  pet?: WireGoods
  price: WirePrice
  t: number
  status: 'open' | 'sold' | 'cancelled' | 'pending-verify'
  payment: 'gold' | 'verified' | 'attested' | null
  mineAs?: 'seller' | 'buyer'
  sellerAck?: boolean
  tx?: string
}

/** Hooks into whoever owns the player's pets (wired by the integrator). */
export interface PetsHooks {
  list(): readonly PetInstance[]
  /** Remove (escrow) the pet with this uid; false if not owned. */
  remove(uid: string): boolean
  /** Deliver a bought/restored pet into the player's collection. */
  add(p: PetInstance): void
}

export interface MarketModule extends MarketAPI {
  setGold(g: GoldAPI): void
  setWallet(w: WalletAPI2): void
  setInventory(inv: InventoryAPI): void
  setPets(hooks: PetsHooks): void
  setMeshSource(fn: (defId: string) => THREE.Group): void
  setPetMeshSource(fn: (petId: string) => THREE.Group): void
  setDefSource(fn: (id: string) => ItemDef | undefined): void
  /** Live minted item instances (uid + mints) — enables crypto rails in Sell.
   *  Integrator: market.setMintedSource(() => minting.mintedItems()) */
  setMintedSource(fn: () => readonly ItemInstance[]): void
  /** NFT LAW: minted-item ledger hooks so mint state TRAVELS on trade —
   *  escrowed goods drop their local ledger row (take), delivered/restored
   *  goods re-enter it with their uid + mint records intact (receive).
   *  Integrator: market.setMintHooks({ take: minting.takeByUid, receive: minting.receive }) */
  setMintHooks(h: { take(uid: string): boolean; receive(inst: ItemInstance): boolean }): void
}

// ---------------------------------------------------------------------------
// Blockle-account client (same idiom as src/gold: bearer blk_token for the
// iOS shell, else browser session cookie + CSRF; never throws out)
// ---------------------------------------------------------------------------

function bearerToken(): string | null {
  try {
    return localStorage.getItem('blk_token')
  } catch {
    return null
  }
}

let csrf: string | null = null

async function accountFetch(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const headers: Record<string, string> = { 'x-blockle-client': 'blocklings' }
  const token = bearerToken()
  if (token) headers['Authorization'] = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && !token && csrf) headers['x-csrf-token'] = csrf
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 20_000) : null
  try {
    const init: RequestInit = { method, headers, credentials: token ? 'omit' : 'include' }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (ctrl) init.signal = ctrl.signal
    const r = await fetch(ORIGIN + path, init)
    let data: Record<string, unknown> = {}
    try {
      data = (await r.json()) as Record<string, unknown>
    } catch {
      /* non-JSON body */
    }
    return { status: r.status, data }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function probeSession(): Promise<boolean> {
  const r = await accountFetch('GET', '/account/api/me')
  if (r && r.status === 200 && r.data.user) {
    if (typeof r.data.csrf === 'string') csrf = r.data.csrf
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Wire <-> contract mapping
// ---------------------------------------------------------------------------

function toContractListing(w: WireListing): Listing {
  const price: ListingPrice =
    typeof w.price.gold === 'number'
      ? { gold: w.price.gold }
      : { chain: w.price.chain as ChainId, amount: w.price.amount ?? 0 }
  const l: Listing = { id: w.id, seller: w.seller, price, t: w.t }
  if (w.kind === 'item' && w.item) {
    const item: ItemInstance = { id: w.item.defId ?? '' }
    if (w.item.uid) item.uid = w.item.uid
    if (w.item.mints) item.mints = w.item.mints
    l.item = item
  } else if (w.kind === 'pet' && w.pet) {
    const pet: PetInstance = {
      petId: w.pet.petId ?? '',
      uid: w.pet.uid ?? '',
      mints: w.pet.mints ?? []
    }
    if (w.pet.nickname) pet.nickname = w.pet.nickname
    l.pet = pet
  }
  return l
}

/** Display name for a listing's goods (item def name / pet comedy name). */
export function goodsName(w: WireListing, def: (id: string) => ItemDef | undefined): string {
  if (w.kind === 'pet' && w.pet) {
    const d = petDef(w.pet.petId ?? '')
    return w.pet.nickname || d?.name || w.pet.petId || 'Pet'
  }
  const id = w.item?.defId ?? ''
  const metaName = w.item?.meta?.name
  return def(id)?.name || metaName || id || 'Item'
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export function initMarket(api: GameAPI): MarketModule {
  void api // DOM-only module; accepted per the module convention

  // --- wired collaborators (null until the integrator wires them) ----------
  let gold: GoldAPI | null = null
  let wallet: WalletAPI2 | null = null
  let inventory: InventoryAPI | null = null
  let pets: PetsHooks | null = null
  let meshSource: ((defId: string) => THREE.Group) | null = null
  let petMeshSource: ((petId: string) => THREE.Group) | null = null
  let defSource: (id: string) => ItemDef | undefined = () => undefined
  let mintedSource: () => readonly ItemInstance[] = () => []
  let mintHooks: { take(uid: string): boolean; receive(inst: ItemInstance): boolean } | null = null

  let signedIn = false
  /** Wire listings by id, refreshed on every browse/mine (buy needs prices). */
  const known = new Map<string, WireListing>()

  function remember(rows: WireListing[]): void {
    for (const w of rows) known.set(w.id, w)
  }

  // --- goods delivery / escrow ---------------------------------------------
  function deliver(w: WireListing): void {
    if (w.kind === 'item' && w.item?.defId) {
      inventory?.add(w.item.defId, w.item.qty ?? 1, 'vendor')
      // NFT LAW: mint state travels with the item — a minted instance re-enters
      // the local NFT ledger with its permanent uid + real mint records.
      if (w.item.uid && w.item.mints?.length && mintHooks) {
        mintHooks.receive({ id: w.item.defId, uid: w.item.uid, mints: w.item.mints.map((m) => ({ ...m })) })
      }
    } else if (w.kind === 'pet' && w.pet?.petId) {
      pets?.add({
        petId: w.pet.petId,
        uid: w.pet.uid ?? '',
        mints: w.pet.mints ?? [],
        ...(w.pet.nickname ? { nickname: w.pet.nickname } : {})
      })
    }
    events.emit('save:dirty', { why: 'market:delivered' })
  }

  /** Escrow goods out of the local save; returns an error string on failure. */
  function escrow(goods: { item: ItemInstance } | { pet: PetInstance }): string | null {
    if ('item' in goods) {
      if (!inventory) return 'Inventory not wired yet.'
      if (inventory.count(goods.item.id) < 1) return "You don't have that item."
      if (!inventory.remove(goods.item.id, 1)) return 'Could not take the item from your bag.'
      // NFT LAW: a minted copy leaves WITH its ledger row — the uid is never
      // claimable by this save while the goods sit in a listing (no double-list).
      if (goods.item.uid && mintHooks) mintHooks.take(goods.item.uid)
    } else {
      if (!pets) return 'Pets not wired yet.'
      if (!pets.remove(goods.pet.uid)) return "You don't have that pet."
    }
    events.emit('save:dirty', { why: 'market:escrow' })
    return null
  }

  function restore(w: WireListing): void {
    deliver(w) // same mechanics: payload goes back into the save
  }

  // --- MarketAPI -----------------------------------------------------------
  const marketApi: MarketAPI = {
    async list(goods, price): Promise<{ ok: boolean; listingId?: string; error?: string }> {
      if (!signedIn && !(signedIn = await probeSession()))
        return { ok: false, error: 'Sign in to a Blockle account to trade.' }

      // NFT LAW (client-side mirror of the server check): crypto => minted on that chain.
      const inst = 'item' in goods ? goods.item : goods.pet
      let wirePrice: WirePrice
      if ('gold' in price) {
        if (!Number.isInteger(price.gold) || price.gold < 1) return { ok: false, error: 'GOLD price must be a positive whole number.' }
        wirePrice = { gold: price.gold }
      } else {
        const mints = inst.mints ?? []
        if (!inst.uid || !mints.some((m) => m.chain === price.chain))
          return { ok: false, error: `Crypto listings need this minted on ${price.chain} first.` }
        if (!wallet) return { ok: false, error: 'Wallet not connected.' }
        const chains = await wallet.chains()
        const address = chains[price.chain]?.address
        if (!address) return { ok: false, error: `Set up your ${price.chain} wallet first (that's where the payment goes).` }
        wirePrice = { chain: price.chain, amount: price.amount, address }
      }

      const payload: WireGoods =
        'item' in goods
          ? {
              defId: goods.item.id,
              qty: 1,
              ...(goods.item.uid ? { uid: goods.item.uid } : {}),
              ...(goods.item.mints ? { mints: goods.item.mints } : {}),
              meta: { name: defSource(goods.item.id)?.name ?? goods.item.id }
            }
          : {
              petId: goods.pet.petId,
              uid: goods.pet.uid,
              mints: goods.pet.mints,
              ...(goods.pet.nickname ? { nickname: goods.pet.nickname } : {}),
              meta: { name: goods.pet.nickname || petDef(goods.pet.petId)?.name || goods.pet.petId }
            }

      // Escrow BEFORE the server call so the goods can't be duplicated by a
      // double-tap; restored honestly if the server rejects the listing.
      const escrowErr = escrow(goods)
      if (escrowErr) return { ok: false, error: escrowErr }

      const kind = 'item' in goods ? 'item' : 'pet'
      const r = await accountFetch('POST', '/account/api/game/market/list', { kind, payload, price: wirePrice })
      if (r && r.status === 200 && r.data.ok === true) {
        const w = r.data.listing as unknown as WireListing
        if (w) known.set(w.id, w)
        events.emit('chat:system', { text: 'Listed on the marketplace. Fingers crossed.' })
        return { ok: true, listingId: String(r.data.listingId) }
      }
      // Listing failed — the goods come straight back.
      const fake: WireListing = {
        id: '', seller: '', kind: kind as 'item' | 'pet', price: wirePrice,
        t: 0, status: 'cancelled', payment: null,
        ...(kind === 'item' ? { item: payload } : { pet: payload })
      }
      restore(fake)
      if (!r) return { ok: false, error: 'Network error — nothing was listed.' }
      return { ok: false, error: typeof r.data.error === 'string' ? r.data.error : `Listing failed (HTTP ${r.status}).` }
    },

    async browse(filters?: ListingFilters): Promise<readonly Listing[]> {
      const q = new URLSearchParams()
      if (filters?.kind) q.set('kind', filters.kind)
      if (filters?.chain) q.set('chain', filters.chain)
      if (filters?.gold) q.set('gold', '1')
      if (filters?.id) q.set('id', filters.id)
      if (filters?.text) q.set('text', filters.text)
      const qs = q.toString()
      const r = await accountFetch('GET', '/account/api/game/market' + (qs ? '?' + qs : ''))
      if (!r || r.status !== 200 || !Array.isArray(r.data.listings)) return []
      const rows = r.data.listings as unknown as WireListing[]
      remember(rows)
      return rows.map(toContractListing)
    },

    async buy(listingId: string): Promise<{ ok: boolean; tx?: string; error?: string }> {
      if (!signedIn && !(signedIn = await probeSession()))
        return { ok: false, error: 'Sign in to a Blockle account to trade.' }
      let w = known.get(listingId)
      if (!w) {
        await marketApi.browse()
        w = known.get(listingId)
      }
      if (!w) return { ok: false, error: 'Listing not found.' }

      // ---- GOLD rail: server-atomic settlement -----------------------------
      if (typeof w.price.gold === 'number') {
        if (gold) {
          const bal = await gold.balance()
          if (bal < w.price.gold) return { ok: false, error: `Not enough GOLD (${bal}/${w.price.gold}).` }
        }
        const r = await accountFetch('POST', '/account/api/game/market/buy', { id: listingId })
        if (!r) return { ok: false, error: 'Network error — nothing was charged.' }
        if (r.status === 200 && r.data.ok === true) {
          const sold = (r.data.listing as unknown as WireListing) ?? w
          deliver(sold)
          known.set(listingId, sold)
          events.emit('market:sold', { listingId })
          events.emit('chat:system', { text: `Bought ${goodsName(sold, defSource)} for ${w.price.gold} GOLD.` })
          return { ok: true }
        }
        return { ok: false, error: typeof r.data.error === 'string' ? r.data.error : `Purchase failed (HTTP ${r.status}).` }
      }

      // ---- CRYPTO rail: real wallet-signed payment to the seller -----------
      const chain = w.price.chain as ChainId
      const amount = w.price.amount ?? 0
      const address = w.price.address
      if (!chain || !amount || !address) return { ok: false, error: 'Listing has no valid crypto price.' }
      if (!wallet) return { ok: false, error: 'Connect your wallet to pay with crypto.' }

      const sent = await wallet.sendOn(chain, address, amount)
      if (!sent.ok || !sent.tx) return { ok: false, error: sent.error || 'Payment failed — nothing was sent.' }

      // Attest + (BLOCK) wait for on-chain verification. Retries are idempotent.
      for (let i = 0; i < PAID_RETRIES; i++) {
        const r = await accountFetch('POST', '/account/api/game/market/paid', { id: listingId, tx: sent.tx })
        if (r && r.status === 200 && r.data.ok === true) {
          const sold = (r.data.listing as unknown as WireListing) ?? w
          deliver(sold)
          known.set(listingId, sold)
          events.emit('market:sold', { listingId })
          const how = sold.payment === 'verified' ? 'verified on-chain' : 'payment attested'
          events.emit('chat:system', { text: `Bought ${goodsName(sold, defSource)} for ${amount} ${chain === 'blockle' ? 'BLOCK' : chain === 'ethereum' ? 'ETH' : 'SOL'} (${how}).` })
          return { ok: true, tx: sent.tx }
        }
        if (r && r.status === 202) {
          // honest: paid for real, not yet visible to the verifier — keep trying
          await new Promise((res) => setTimeout(res, PAID_RETRY_MS))
          continue
        }
        const error = r && typeof r.data.error === 'string' ? r.data.error : 'Could not record the payment.'
        return { ok: false, tx: sent.tx, error: `${error} Your payment tx is ${sent.tx} — keep it; the purchase can be retried from My Listings.` }
      }
      return {
        ok: false,
        tx: sent.tx,
        error: `Payment sent (tx ${sent.tx}) but not confirmed by the explorer yet. The purchase completes automatically once it confirms — check back shortly.`
      }
    },

    async myListings(): Promise<readonly Listing[]> {
      if (!signedIn && !(signedIn = await probeSession())) return []
      const r = await accountFetch('GET', '/account/api/game/market/mine')
      if (!r || r.status !== 200 || !Array.isArray(r.data.listings)) return []
      const rows = r.data.listings as unknown as WireListing[]
      remember(rows)
      return rows.map(toContractListing)
    }
  }

  // --- internal surface the UI uses (wire rows carry status/price.address) --
  const internal = {
    api: marketApi,
    wire: (id: string) => known.get(id),
    wireRows: async (mine: boolean, filters?: ListingFilters): Promise<WireListing[]> => {
      if (mine) {
        await marketApi.myListings()
        return [...known.values()].filter((w) => w.mineAs)
      }
      await marketApi.browse(filters)
      return [...known.values()].filter((w) => w.status === 'open')
    },
    cancel: async (id: string): Promise<{ ok: boolean; error?: string }> => {
      const r = await accountFetch('POST', '/account/api/game/market/cancel', { id })
      if (r && r.status === 200 && r.data.ok === true) {
        const w = r.data.listing as unknown as WireListing
        if (w) {
          known.set(id, w)
          restore(w) // the goods come home
        }
        events.emit('chat:system', { text: 'Listing cancelled — goods returned to you.' })
        return { ok: true }
      }
      return { ok: false, error: r && typeof r.data.error === 'string' ? r.data.error : 'Cancel failed.' }
    },
    goodsName: (w: WireListing) => goodsName(w, defSource),
    def: (id: string) => defSource(id),
    mesh: (w: WireListing): THREE.Group | null => {
      try {
        if (w.kind === 'item' && w.item?.defId && meshSource) return meshSource(w.item.defId)
        if (w.kind === 'pet' && w.pet?.petId && petMeshSource) return petMeshSource(w.pet.petId)
      } catch (e) {
        console.error('[market] mesh source threw', e)
      }
      return null
    },
    inventory: () => inventory,
    pets: () => pets,
    wallet: () => wallet,
    gold: () => gold,
    minted: () => mintedSource(),
    signedIn: () => signedIn
  }
  // --- storefront UI -------------------------------------------------------
  const ui = createMarketUI(internal)

  // --- seller sale watcher: poll /mine, announce + ack fresh sales ---------
  async function pollSales(): Promise<void> {
    if (!signedIn) return
    const r = await accountFetch('GET', '/account/api/game/market/mine')
    if (!r || r.status !== 200 || !Array.isArray(r.data.listings)) return
    const rows = r.data.listings as unknown as WireListing[]
    remember(rows)
    for (const w of rows) {
      if (w.mineAs === 'seller' && w.status === 'sold' && w.sellerAck === false) {
        events.emit('market:sold', { listingId: w.id })
        const price =
          typeof w.price.gold === 'number'
            ? `${w.price.gold} GOLD`
            : `${w.price.amount} ${w.price.chain === 'blockle' ? 'BLOCK' : w.price.chain === 'ethereum' ? 'ETH' : 'SOL'}${w.payment === 'attested' ? ' (payment attested by buyer)' : ''}`
        events.emit('chat:system', { text: `Your listing sold: ${goodsName(w, defSource)} for ${price}.` })
        void accountFetch('POST', '/account/api/game/market/ack', { id: w.id })
      }
    }
    ui.refreshIfOpen()
  }

  events.on('auth:changed', ({ signedIn: s }) => {
    signedIn = s
    if (s) {
      csrf = null
      void probeSession().then(() => pollSales())
    }
  })
  void probeSession().then((ok) => {
    signedIn = ok
    if (ok) void pollSales()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void pollSales()
  }, POLL_MS)

  return {
    ...marketApi,
    setGold: (g) => {
      gold = g
    },
    setWallet: (w) => {
      wallet = w
    },
    setInventory: (inv) => {
      inventory = inv
    },
    setPets: (h) => {
      pets = h
    },
    setMeshSource: (fn) => {
      meshSource = fn
    },
    setPetMeshSource: (fn) => {
      petMeshSource = fn
    },
    setDefSource: (fn) => {
      defSource = fn
    },
    setMintedSource: (fn) => {
      mintedSource = fn
    },
    setMintHooks: (h) => {
      mintHooks = h
    }
  }
}

/** The internal surface createMarketUI receives (exported for ui.ts typing). */
export interface MarketInternal {
  api: MarketAPI
  wire(id: string): WireListing | undefined
  wireRows(mine: boolean, filters?: ListingFilters): Promise<WireListing[]>
  cancel(id: string): Promise<{ ok: boolean; error?: string }>
  goodsName(w: WireListing): string
  def(id: string): ItemDef | undefined
  mesh(w: WireListing): THREE.Group | null
  inventory(): InventoryAPI | null
  pets(): PetsHooks | null
  wallet(): WalletAPI2 | null
  gold(): GoldAPI | null
  minted(): readonly ItemInstance[]
  signedIn(): boolean
}
