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

/** StoreKit bridge injected by the iOS shell (see module doc above). */
export interface BlocklingsIAPBridge {
  purchase(req: { sku: string }): Promise<{ receipt: string }>
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
  chipEl.style.display = signedIn ? '' : 'none'
  chipAmtEl.textContent = cached.toLocaleString()
}

function mountChip(): void {
  const chip = document.createElement('div')
  chip.className = 'bl-gold-chip'
  chip.title = 'GOLD — premium currency (App Store only)'
  const icon = document.createElement('span')
  icon.className = 'bl-gold-icon'
  icon.innerHTML = COIN_SVG
  const amt = document.createElement('span')
  amt.className = 'bl-gold-amt'
  amt.textContent = '0'
  const cur = document.createElement('span')
  cur.className = 'bl-gold-cur'
  cur.textContent = 'GOLD'
  chip.appendChild(icon)
  chip.appendChild(amt)
  chip.appendChild(cur)
  chip.style.display = 'none'
  chipEl = chip
  chipAmtEl = amt

  // Join the HUD's top-right cluster when it exists (its old chip spot);
  // the HUD may mount after us, so retry briefly, then float standalone.
  let tries = 0
  const tryAttach = (): void => {
    const cluster = document.querySelector('.bl-topright')
    if (cluster) {
      cluster.insertBefore(chip, cluster.firstChild)
      refreshChip()
      return
    }
    if (++tries < 40) {
      setTimeout(tryAttach, 250)
      return
    }
    chip.classList.add('bl-gold-chip-floating')
    ;(document.getElementById('ui') ?? document.body).appendChild(chip)
    refreshChip()
  }
  tryAttach()
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
    if (!bridge || typeof bridge.purchase !== 'function') {
      return { ok: false, error: 'iOS only' }
    }

    // 1) Native StoreKit purchase via the shell bridge.
    let receipt: string
    try {
      const out = await bridge.purchase({ sku })
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
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/**
 * Initialize the GOLD module: HUD chip + server-balance mirror + GoldAPI.
 * The integrator wires the returned GoldAPI to whoever needs it (market, shop).
 */
export function initGold(api: GameAPI): GoldModule {
  void api // GOLD renders pure DOM; the GameAPI is accepted per module convention
  if (inited) return goldApi
  inited = true

  mountChip()

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
