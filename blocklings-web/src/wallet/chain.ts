/**
 * chain.ts — read/submit client for the live BLOCK chain via the public
 * blockle.org API (same endpoints the production web wallet uses):
 *
 *   GET  https://blockle.org/api/explorer/address/<block1…>  → { balance, … }   (base units)
 *   GET  https://blockle.org/api/explorer/utxos/<block1…>    → { utxos: [{txid,vout,amount}], spendable }
 *   POST https://blockle.org/api/submit  { raw: <bincode-hex> } → { txid } | { error }
 *
 * Everything read-only is best-effort (null on failure) so the game stays
 * playable offline; submit throws with a human-readable reason.
 */
import type { Utxo } from './wasm'

const EXPLORER = 'https://blockle.org/api/explorer'
const SUBMIT = 'https://blockle.org/api/submit'

/** Base units per BLOCK. */
export const COIN = 100_000_000

async function getJson(path: string): Promise<unknown> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 7000)
  try {
    const r = await fetch(EXPLORER + path, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' }
    })
    if (!r.ok) return null
    return (await r.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** Confirmed balance in base units, or null when unreachable. */
export async function fetchBalanceBase(address: string): Promise<number | null> {
  if (!address) return null
  const a = (await getJson('/address/' + encodeURIComponent(address))) as {
    balance?: number
    confirmed?: number
    final_balance?: number
    error?: string
  } | null
  if (!a || a.error) return null
  return a.balance ?? a.confirmed ?? a.final_balance ?? 0
}

/** Spendable (mature) UTXOs for building a transfer, or null when unreachable. */
export async function fetchUtxos(
  address: string
): Promise<{ utxos: Utxo[]; spendable: number } | null> {
  const u = (await getJson('/utxos/' + encodeURIComponent(address))) as {
    utxos?: Utxo[]
    spendable?: number
  } | null
  if (!u) return null
  return { utxos: u.utxos ?? [], spendable: u.spendable ?? 0 }
}

/**
 * The node (and the wasm builder) spell a txid as the raw hash bytes; the
 * explorer displays the byte-REVERSED form. Convert between them.
 */
export function flipTxid(txid: string): string {
  const t = String(txid || '')
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(t)) return txid
  let out = ''
  for (let i = t.length - 2; i >= 0; i -= 2) out += t.slice(i, i + 2)
  return out
}

/**
 * Broadcast a signed bincode-hex transaction. Resolves the txid in the
 * explorer's (display) spelling; throws with the node's reason on rejection.
 */
export async function submitRaw(rawHex: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(SUBMIT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw: rawHex }),
      signal: ctrl.signal
    })
    const j = (await r.json().catch(() => ({}))) as {
      error?: { message?: string } | string
      result?: { txid?: string }
      txid?: string
    }
    if (!r.ok || j.error) {
      const e = j.error
      throw new Error(
        (typeof e === 'object' && e && e.message) || (typeof e === 'string' && e) || 'submit failed'
      )
    }
    const txid = j.result?.txid ?? j.txid
    if (!txid) throw new Error('node accepted the tx but returned no txid')
    return flipTxid(txid)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'network error')
  } finally {
    clearTimeout(t)
  }
}

/** Loose bech32m sanity check for a BLOCK address (charset + prefix). */
export function looksLikeBlockAddress(addr: string): boolean {
  return /^block1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8,}$/.test(addr.trim().toLowerCase())
}
