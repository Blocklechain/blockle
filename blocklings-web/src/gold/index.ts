/**
 * Blocklings — GOLD module (IAP-only premium currency).
 *
 * ECONOMY LAW: GOLD is never earned in-game, never cashed out, and there is
 * no gold->crypto bridge. The balance is SERVER-AUTHORITATIVE — it lives on
 * the Blockle account (`goldBalance`) and this module only mirrors it. We
 * never fabricate a number: no session => balance 0 and a hidden chip.
 *
 * Server endpoints (services/accounts):
 *   GET  /account/api/game/gold              -> { balance }
 *   POST /account/api/game/gold/iap          { receipt, sku } -> credit (gated
 *        behind APPLE_IAP_ENABLED server-side; 503 'IAP not configured' off)
 *   POST /account/api/game/gold/spend        { amount, reason } -> debit
 *
 * StoreKit bridge (window.blocklingsIAP) — the contract the iOS shell MUST
 * implement (WKWebView user-content injection):
 *
 *   window.blocklingsIAP = {
 *     // Start a StoreKit purchase for one product id (our GoldSku.sku).
 *     // Resolves ONLY after the App Store transaction completes, with the
 *     // receipt the server can verify:
 *     //   { receipt: string }  — base64 app receipt (SKReceiptRefreshRequest /
 *     //     Bundle.main.appStoreReceiptURL contents) or a StoreKit 2 signed
 *     //     transaction JWS (Transaction.jwsRepresentation).
 *     // Rejects (Promise rejection / thrown Error) on user cancel or any
 *     // StoreKit failure — message is shown to the player verbatim.
 *     purchase(req: { sku: string }): Promise<{ receipt: string }>
 *   }
 *
 * In a plain browser (no shell bridge) purchase() resolves
 * `{ ok: false, error: 'iOS only' }` — honest, no web checkout pretense.
 *
 * HUD: a top-right gold chip (coin icon + amount) that is visible ONLY while
 * signed in to a Blockle account. It joins the HUD's `.bl-topright` cluster
 * when present (DOM-level attach — no module import), else floats below it.
 */
import type { GameAPI, GoldAPI, GoldSku } from '../types'
import { events } from '../events'
import './gold.css'

// ---------------------------------------------------------------------------
// Catalog (must mirror services/accounts GOLD_SKUS — the server is canonical
// for crediting; this list only drives the App Store product ids + shop UI).
// ---------------------------------------------------------------------------

const SKUS: readonly GoldSku[] = [
  { sku: 'gold_100', gold: 100, usd: 0.99 },
  { sku: 'gold_550', gold: 550, usd: 4.99 },
  { sku: 'gold_1200', gold: 1200, usd: 9.99 },
  { sku: 'gold_2600', gold: 2600, usd: 19.99 }
]

const ORIGIN = 'https://blockle.org'
const POLL_MS = 60_000

/** StoreKit bridge injected by the iOS shell (see module doc above).
 *  The shell has historically shipped a `buy(sku)` method; the documented
 *  contract is `purchase({sku})`. Both are accepted so old and new shells work
 *  (see resolveNativeBuy). Both resolve to the base64 App Store receipt. */
export interface BlocklingsIAPBridge {
  purchase?(req: { sku: string }): Promise<{ receipt: string }>
  buy?(sku: string): Promise<{ receipt: string }>
  /**
   * Restore previous StoreKit purchases (Apple requires this for apps with
   * subscription / non-consumable IAP). The shell re-submits receipts to the
   * account server for re-entitlement. Resolves with how many were restored.
   */
  restore?(): Promise<{ restored: number }>
}

/** Normalize the shell's purchase method: prefer the documented `purchase({sku})`,
 *  fall back to the legacy `buy(sku)`. Returns null if neither exists. */
function resolveNativeBuy(
  bridge: BlocklingsIAPBridge | undefined
): ((sku: string) => Promise<{ receipt: string }>) | null {
  if (bridge && typeof bridge.purchase === 'function') return (sku) => bridge.purchase!({ sku })
  if (bridge && typeof bridge.buy === 'function') return (sku) => bridge.buy!(sku)
  return null
}

interface GoldGlobals {
  blocklingsIAP?: BlocklingsIAPBridge
}

export type GoldModule = GoldAPI

// ---------------------------------------------------------------------------
// Blockle account client (same idiom as save/core: bearer blk_token or the
// browser session cookie + CSRF from /account/api/me; never throws out).
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
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 15_000) : null
  try {
    const init: RequestInit = {
      method,
      headers,
      credentials: token ? 'omit' : 'include'
    }
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

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let signedIn = false
let cached = 0 // last server-confirmed balance (0 until a session answers)
let chipEl: HTMLElement | null = null
let chipAmtEl: HTMLElement | null = null
let inited = false

function setBalance(n: number): void {
  const v = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  if (v === cached) {
    refreshChip()
    return
  }
  cached = v
  events.emit('gold:changed', { balance: cached })
  refreshChip()
}

/** Pull the server balance; returns the fresh value or the cache on failure. */
async function fetchBalance(): Promise<number> {
  const r = await accountFetch('GET', '/account/api/game/gold')
  if (r && r.status === 200 && typeof r.data.balance === 'number') {
    setBalance(r.data.balance)
  } else if (r && r.status === 401) {
    // session gone — fail honest: zero + hidden chip until auth returns
    signedIn = false
    setBalance(0)
  }
  return cached
}

/** Probe the account session directly (covers boots before any auth module). */
async function probeSession(): Promise<void> {
  const r = await accountFetch('GET', '/account/api/me')
  if (r && r.status === 200 && r.data.user) {
    if (typeof r.data.csrf === 'string') csrf = r.data.csrf
    signedIn = true
    await fetchBalance()
  } else {
    signedIn = false
    setBalance(0)
  }
  refreshChip()
}

// ---------------------------------------------------------------------------
// HUD chip (coin icon + amount; visible only while signed in)
// ---------------------------------------------------------------------------

/** Flat-style gold-coin icon (custom SVG — no emoji, per product rule). */
const COIN_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10" fill="#e8c15a" stroke="#8a6508" stroke-width="2"/>' +
  '<circle cx="12" cy="12" r="6.2" fill="none" stroke="#b8860b" stroke-width="1.6"/>' +
  '<rect x="10.9" y="8.2" width="2.2" height="7.6" rx="1.1" fill="#b8860b"/>' +
  '</svg>'

function refreshChip(): void {
  if (!chipEl || !chipAmtEl) return
  // Always visible so GOLD is reachable (and reviewable): tap to open the store.
  // Balance stays honest — 0 until a signed-in session reports otherwise.
  chipEl.style.display = ''
  chipAmtEl.textContent = cached.toLocaleString()
}

// ---------------------------------------------------------------------------
// GOLD store — the "Get GOLD" sheet (the IAP surface Apple reviews, and the
// only place GOLD is bought). Lists the four packs; Buy routes through
// goldApi.purchase() — StoreKit on iOS, PayPal on web/Android.
// ---------------------------------------------------------------------------

let storeEl: HTMLElement | null = null

/** Small label under each pack (bonus framing — purely cosmetic copy). */
const PACK_NOTE: Record<string, string> = {
  gold_100: 'Starter pouch',
  gold_550: 'Best for most',
  gold_1200: 'Great value',
  gold_2600: 'Dragon hoard'
}

function closeStore(): void {
  storeEl?.remove()
  storeEl = null
}

function openStore(): void {
  if (storeEl) return
  const back = document.createElement('div')
  back.className = 'bl-gold-store-back'
  back.style.pointerEvents = 'auto'
  back.addEventListener('click', (e) => {
    if (e.target === back) closeStore()
  })

  const panel = document.createElement('div')
  panel.className = 'bl-gold-store'

  const head = document.createElement('div')
  head.className = 'bl-gold-store-head'
  head.innerHTML =
    '<span class="bl-gold-store-title">' + COIN_SVG + ' Get GOLD</span>'
  const x = document.createElement('button')
  x.className = 'bl-gold-store-x'
  x.type = 'button'
  x.textContent = '×'
  x.setAttribute('aria-label', 'Close')
  x.addEventListener('click', () => closeStore())
  head.appendChild(x)
  panel.appendChild(head)

  const sub = document.createElement('p')
  sub.className = 'bl-gold-store-sub'
  sub.textContent = signedIn
    ? 'GOLD is the premium currency for the Blockling marketplace. Balance: ' + cached.toLocaleString() + '.'
    : 'Sign in to a Blockle account to buy and hold GOLD.'
  panel.appendChild(sub)

  const grid = document.createElement('div')
  grid.className = 'bl-gold-store-grid'
  for (const s of SKUS) {
    const card = document.createElement('div')
    card.className = 'bl-gold-pack'
    const amt = document.createElement('div')
    amt.className = 'bl-gold-pack-amt'
    amt.innerHTML = COIN_SVG + '<b>' + s.gold.toLocaleString() + '</b>'
    const note = document.createElement('div')
    note.className = 'bl-gold-pack-note'
    note.textContent = PACK_NOTE[s.sku] ?? ''
    const buy = document.createElement('button')
    buy.className = 'bl-gold-pack-buy'
    buy.type = 'button'
    buy.textContent = '$' + s.usd.toFixed(2)
    buy.addEventListener('click', async () => {
      if (buy.disabled) return
      buy.disabled = true
      const label = buy.textContent
      buy.textContent = '…'
      const r = await goldApi.purchase(s.sku)
      if (r.ok) {
        buy.textContent = '✓'
        sub.textContent = 'Purchased ' + s.gold.toLocaleString() + ' GOLD. Balance: ' + cached.toLocaleString() + '.'
        setTimeout(() => closeStore(), 900)
      } else {
        buy.textContent = label
        buy.disabled = false
        sub.textContent =
          r.error === 'iOS only'
            ? 'GOLD purchases open in a secure checkout.'
            : r.error ?? 'Purchase could not be completed.'
      }
    })
    card.append(amt, note, buy)
    grid.appendChild(card)
  }
  panel.appendChild(grid)

  const fine = document.createElement('p')
  fine.className = 'bl-gold-store-fine'
  fine.textContent =
    'GOLD is a non-refundable in-game currency. It is never cashed out and has no real-world value.'
  panel.appendChild(fine)

  back.appendChild(panel)
  ;(document.getElementById('ui') ?? document.body).appendChild(back)
  storeEl = back
}


// ---------------------------------------------------------------------------
// Spend (server-authoritative debit — vendors, market, anything priced GOLD)
// ---------------------------------------------------------------------------

/**
 * Spend GOLD server-side: POST /account/api/game/gold/spend {amount, reason}.
 * The server is the only ledger — on ok we re-sync the mirrored balance
 * (emitting 'gold:changed'); on 401/insufficient-funds/network trouble we
 * return the failure honestly and nothing moves. Never fabricates a debit.
 */
export async function spendGold(
  amount: number,
  reason: string
): Promise<{ ok: boolean; error?: string }> {
  const amt = Math.floor(amount)
  if (!Number.isFinite(amt) || amt < 1) return { ok: false, error: 'Invalid GOLD amount.' }
  if (!signedIn) return { ok: false, error: 'Sign in to a Blockle account first.' }
  if (!csrf && !bearerToken()) await probeSession() // make sure we hold a CSRF token
  const r = await accountFetch('POST', '/account/api/game/gold/spend', { amount: amt, reason })
  if (!r) return { ok: false, error: 'Network error — no GOLD was spent.' }
  if (r.status === 200 && r.data.ok === true) {
    // fresh balance: trust the server's answer, else re-pull before reporting
    if (typeof r.data.balance === 'number') setBalance(r.data.balance)
    else await fetchBalance()
    return { ok: true }
  }
  if (r.status === 401) {
    // session gone mid-spend — fail honest and reset the mirror
    signedIn = false
    setBalance(0)
    refreshChip()
    return { ok: false, error: 'Signed out — sign back in to spend GOLD.' }
  }
  const error =
    typeof r.data.error === 'string' ? r.data.error : `GOLD spend failed (HTTP ${r.status}).`
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// GoldAPI
// ---------------------------------------------------------------------------

/**
 * PayPal GOLD top-up (web + sideloaded Android — anywhere without StoreKit).
 *
 * Flow: ask the server to mint a CAPTURE order for this SKU, open PayPal's
 * approval page (a popup in a browser; the external browser via the Android
 * shell's window.blocklingsOpenURL), and let the server's gold-return page do
 * the server-side capture + credit. We never credit client-side — we just
 * watch the server balance and resolve when it rises by the SKU's amount.
 *
 * Honest failure everywhere: if the account isn't signed in, PayPal isn't
 * configured (503), or the player closes PayPal without paying (timeout), we
 * report it plainly and nothing moves.
 */
async function purchaseViaPaypal(def: GoldSku): Promise<{ ok: boolean; error?: string }> {
  if (!csrf && !bearerToken()) await probeSession()
  const created = await accountFetch('POST', '/account/api/game/gold/paypal/create', { sku: def.sku })
  if (!created) return { ok: false, error: 'Network error — PayPal checkout did not start.' }
  if (created.status === 503) return { ok: false, error: 'PayPal is not available right now.' }
  if (created.status !== 200 || typeof created.data.approveUrl !== 'string') {
    const error = typeof created.data.error === 'string' ? created.data.error : 'Could not start PayPal checkout.'
    return { ok: false, error }
  }
  const approveUrl = created.data.approveUrl

  // Open PayPal. Native shell → external browser; plain web → a popup window
  // (falls back to same-tab navigation if the popup is blocked).
  const openExternal = (window as unknown as { blocklingsOpenURL?: (u: string) => void }).blocklingsOpenURL
  let popup: Window | null = null
  if (typeof openExternal === 'function') {
    openExternal(approveUrl)
  } else {
    popup = window.open(approveUrl, 'blk_gold_paypal', 'width=480,height=720')
    if (!popup) window.location.href = approveUrl
  }

  // Wait for the return page to capture + credit server-side: poll the balance
  // until it climbs by this SKU's gold (success) or we time out (~4 min).
  const start = cached
  const deadline = Date.now() + 4 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500))
    const bal = await fetchBalance()
    if (bal >= start + def.gold) {
      events.emit('chat:system', {
        text: `Purchased ${def.gold.toLocaleString()} GOLD. Your wallet feels heavier.`
      })
      try { popup?.close() } catch { /* cross-origin close may throw */ }
      return { ok: true }
    }
    if (popup && popup.closed) {
      // Popup gone and no credit landed — one last check, then give up honestly.
      const last = await fetchBalance()
      if (last >= start + def.gold) return { ok: true }
      return { ok: false, error: 'PayPal window closed before the payment completed.' }
    }
  }
  return { ok: false, error: 'Timed out waiting for PayPal. If you paid, your GOLD will appear shortly.' }
}

const goldApi: GoldAPI = {
  async balance(): Promise<number> {
    if (!signedIn) return 0
    return fetchBalance()
  },

  buySkus(): GoldSku[] {
    return SKUS.map((s) => ({ ...s }))
  },

  async purchase(sku: string): Promise<{ ok: boolean; error?: string }> {
    const def = SKUS.find((s) => s.sku === sku)
    if (!def) return { ok: false, error: 'Unknown SKU.' }
    if (!signedIn) return { ok: false, error: 'Sign in to a Blockle account first.' }
    const bridge = (window as unknown as GoldGlobals).blocklingsIAP
    const nativeBuy = resolveNativeBuy(bridge)
    if (!nativeBuy) {
      // Apple REQUIRES StoreKit IAP for digital goods inside the iOS app — PayPal
      // there is a rejection. The iOS shell is a WKWebView (window.webkit.
      // messageHandlers present) and injects the bridge at document start, so a
      // missing bridge in that context is a transient error, NEVER a PayPal fall-
      // back. Web browsers + sideloaded Android (no WKWebView) keep PayPal.
      const inIosShell =
        (window as unknown as { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers != null
      if (inIosShell) {
        return { ok: false, error: 'In-app purchases are still loading — reopen the app and try again.' }
      }
      return purchaseViaPaypal(def)
    }

    // 1) Native StoreKit purchase via the shell bridge (purchase({sku}) or buy(sku)).
    let receipt: string
    try {
      const out = await nativeBuy(sku)
      receipt = typeof out?.receipt === 'string' ? out.receipt : ''
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Purchase failed.' }
    }
    if (!receipt) return { ok: false, error: 'Purchase returned no receipt.' }

    // 2) Server-side grant — the ONLY place GOLD is ever credited.
    if (!csrf && !bearerToken()) await probeSession() // make sure we hold a CSRF token
    const r = await accountFetch('POST', '/account/api/game/gold/iap', { receipt, sku })
    if (!r) return { ok: false, error: 'Network error — your purchase will be restorable from the App Store.' }
    if (r.status === 200 && r.data.ok === true) {
      if (typeof r.data.balance === 'number') setBalance(r.data.balance)
      else void fetchBalance()
      events.emit('chat:system', { text: `Purchased ${def.gold.toLocaleString()} GOLD. Your wallet feels heavier.` })
      return { ok: true }
    }
    const error = typeof r.data.error === 'string' ? r.data.error : `Purchase could not be credited (HTTP ${r.status}).`
    return { ok: false, error }
  },

  openStore(): void {
    openStore()
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * Initialize the GOLD module: HUD chip + server-balance mirror + GoldAPI.
 * The integrator wires the returned GoldAPI to whoever needs it (market, shop).
 */
/**
 * Apple "Restore Purchases": ask the iOS shell to replay StoreKit receipts to
 * the account server for re-entitlement, then re-pull the server GOLD balance.
 * No-op (with a friendly message) outside the iOS app.
 */
export async function restorePurchases(): Promise<{ ok: boolean; restored?: number; error?: string }> {
  const bridge = (window as unknown as GoldGlobals).blocklingsIAP
  if (!bridge?.restore) return { ok: false, error: 'Restore Purchases is only available in the iOS app.' }
  try {
    const r = await bridge.restore()
    await fetchBalance() // re-pull server-confirmed GOLD + entitlement
    return { ok: true, restored: r?.restored ?? 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Restore failed — please try again.' }
  }
}

export function initGold(api: GameAPI): GoldModule {
  void api // GOLD renders pure DOM; the GameAPI is accepted per module convention
  if (inited) return goldApi
  inited = true

  // The HUD now owns GOLD display inside its 2x2 balances grid (which opens the
  // store via goldApi.openStore()), so we no longer mount a standalone chip.
  // Balance/server/store logic below is unchanged; refreshChip() null-guards.

  // Auth module drives visibility; we also self-probe once for early boots.
  events.on('auth:changed', ({ signedIn: s }) => {
    signedIn = s
    if (s) {
      csrf = null // session changed — refresh the CSRF token on next POST
      void probeSession()
    } else {
      setBalance(0)
      refreshChip()
    }
  })
  void probeSession()

  // Balance can change server-side (market sales/spends) — re-pull on market
  // events and on a slow poll while signed in and visible.
  events.on('market:sold', () => {
    if (signedIn) void fetchBalance()
  })
  setInterval(() => {
    if (signedIn && document.visibilityState === 'visible') void fetchBalance()
  }, POLL_MS)

  return goldApi
}
