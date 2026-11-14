/**
 * wallet/index.ts — the in-game, NON-CUSTODIAL BLOCK wallet.
 *
 * Implements `WalletAPI` from the scaffold contract (src/types.ts) against:
 *   • the real Blockle post-quantum signer wasm (ML-DSA-44, consensus-correct
 *     keygen / address / tx-build — the same artifact the production web
 *     wallet ships), loaded from /vendor/ at runtime, and
 *   • the live public chain API on https://blockle.org (balance, UTXOs,
 *     tx submit).
 *
 * Keys NEVER leave the browser. The secret key is generated inside the wasm,
 * encrypted with PBKDF2(310k)+AES-GCM under the user's passphrase, and the
 * ciphertext alone is stored in localStorage. The game server is never
 * trusted with (or sent) any wallet data.
 */
import type { WalletAPI, WalletInfo } from '../types'
import {
  COIN,
  fetchBalanceBase,
  fetchUtxos,
  looksLikeBlockAddress,
  submitRaw
} from './chain'
import { open, seal, type SealedVault } from './crypto'
import { addressFromPubkey, buildTransfer, keygen, keypairMatches } from './wasm'

const STORE_KEY = 'blocklings_wallet_v1'
const BALANCE_CACHE_KEY = 'blocklings_wallet_balance_v1'
const BALANCE_TTL_MS = 30_000

/** Backup string format create() returns and restore() accepts. */
const BACKUP_PREFIX = 'blockling-key-v1'

// ML-DSA-44 key sizes (hex chars) — used to split a concatenated backup blob.
const SK_HEX_LEN = 2560 * 2
const PK_HEX_LEN = 1312 * 2

interface StoredWallet {
  v: 1
  scheme: 'ML-DSA-44'
  address: string
  publicKey: string
  vault: SealedVault
  createdAt: number
}

interface SecretPayload {
  secret: string
  public: string
}

function loadStored(): StoredWallet | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const w = JSON.parse(raw) as StoredWallet
    return w && w.v === 1 && w.vault && w.address ? w : null
  } catch {
    return null
  }
}

function saveStored(w: StoredWallet): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(w))
}

// --- in-memory unlock session (never persisted) -----------------------------

let session: { secret: string; public: string; address: string } | null = null

// --- 30s balance cache (offline-tolerant: falls back to last known) ---------

let balanceCache: { address: string; base: number; at: number } | null = null

function lastKnownBalance(address: string): number {
  if (balanceCache && balanceCache.address === address) return balanceCache.base
  try {
    const raw = localStorage.getItem(BALANCE_CACHE_KEY)
    if (!raw) return 0
    const j = JSON.parse(raw) as { address?: string; base?: number }
    return j.address === address && typeof j.base === 'number' ? j.base : 0
  } catch {
    return 0
  }
}

async function balanceBlock(address: string): Promise<number> {
  const now = Date.now()
  if (balanceCache && balanceCache.address === address && now - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.base / COIN
  }
  const base = await fetchBalanceBase(address)
  if (base === null) {
    // offline / API down → last known, don't thrash the endpoint
    const known = lastKnownBalance(address)
    balanceCache = { address, base: known, at: now }
    return known / COIN
  }
  balanceCache = { address, base, at: now }
  try {
    localStorage.setItem(BALANCE_CACHE_KEY, JSON.stringify({ address, base }))
  } catch {
    /* quota — cache is best-effort */
  }
  return base / COIN
}

/** Force the next info() to hit the chain (used by the UI after a send). */
export function invalidateBalanceCache(): void {
  balanceCache = null
}

// --- backup parsing (best effort over every format the ecosystem exports) ---

function parseBackup(input: string): { secret: string; public: string } {
  const text = input.trim()
  if (!text) throw new Error('empty backup')

  // 1) Our own backup string: blockling-key-v1:<secretHex>:<publicHex>
  if (text.startsWith(BACKUP_PREFIX)) {
    const parts = text.split(':')
    const secret = parts[1]
    const pub = parts[2]
    if (!secret || !pub) throw new Error('malformed blockling-key backup')
    return { secret: secret.toLowerCase(), public: pub.toLowerCase() }
  }

  // 2) JSON exports (desktop wallet.json: secret_hex/public_hex; generic
  //    {secret,public}; web-wallet backup payloads).
  if (text.startsWith('{')) {
    let j: Record<string, unknown>
    try {
      j = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new Error('not valid JSON')
    }
    if (j['format'] === 'blockle-wallet' && j['crypto'] && !j['secret']) {
      throw new Error(
        'this is a PASSWORD-SEALED Blockle wallet file — unlock it in the Blockle web wallet and export the raw key instead'
      )
    }
    const secret = firstHex(j, ['secret', 'secretKey', 'secret_hex', 'sk'])
    const pub = firstHex(j, ['public', 'publicKey', 'public_hex', 'pk'])
    if (secret && pub) return { secret, public: pub }
    throw new Error('no usable secret/public key found in this file')
  }

  // 3) Raw hex: either "secret public" (any whitespace) or one concatenated blob.
  const blobs = text.toLowerCase().split(/[\s,;]+/).filter(Boolean)
  if (blobs.length === 2 && blobs.every((b) => /^[0-9a-f]+$/.test(b))) {
    const [a, b] = blobs as [string, string]
    // the ML-DSA-44 secret key is the longer of the two
    return a.length >= b.length ? { secret: a, public: b } : { secret: b, public: a }
  }
  if (blobs.length === 1 && blobs[0] && /^[0-9a-f]+$/.test(blobs[0])) {
    const one = blobs[0]
    if (one.length === SK_HEX_LEN + PK_HEX_LEN) {
      return { secret: one.slice(0, SK_HEX_LEN), public: one.slice(SK_HEX_LEN) }
    }
    throw new Error(
      'a lone hex blob must be secret‖public (' +
        (SK_HEX_LEN + PK_HEX_LEN) +
        ' hex chars for ML-DSA-44); paste both keys or the blockling-key-v1 backup string'
    )
  }
  throw new Error('unrecognized backup format')
}

function firstHex(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v)) return v.toLowerCase()
  }
  return null
}

// --- store a verified keypair under a passphrase ----------------------------

async function sealAndStore(
  secret: string,
  pub: string,
  address: string,
  passphrase: string
): Promise<void> {
  const payload: SecretPayload = { secret, public: pub }
  const vault = await seal(payload, passphrase)
  saveStored({
    v: 1,
    scheme: 'ML-DSA-44',
    address,
    publicKey: pub,
    vault,
    createdAt: Date.now()
  })
}

function requirePassphrase(passphrase: string): void {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters')
  }
}

// --- WalletAPI ---------------------------------------------------------------

export const wallet: WalletAPI = {
  exists(): boolean {
    return loadStored() !== null
  },

  async info(): Promise<WalletInfo> {
    const stored = loadStored()
    if (!stored) return { address: '', balance: 0, locked: false }
    const balance = await balanceBlock(stored.address)
    return { address: stored.address, balance, locked: session === null }
  },

  async create(passphrase: string): Promise<string> {
    requirePassphrase(passphrase)
    if (loadStored()) {
      throw new Error('a wallet already exists on this device — restore/unlock it, or clear it first')
    }
    const kp = await keygen() // real ML-DSA-44 keygen inside the consensus wasm
    await sealAndStore(kp.secretKey, kp.publicKey, kp.address, passphrase)
    session = { secret: kp.secretKey, public: kp.publicKey, address: kp.address }
    // The backup "phrase": ML-DSA-44 has no mnemonic form — this string IS the
    // key and restores the wallet anywhere (web wallet raw-key import too).
    return `${BACKUP_PREFIX}:${kp.secretKey}:${kp.publicKey}`
  },

  async restore(mnemonicOrKey: string, passphrase: string): Promise<string> {
    requirePassphrase(passphrase)
    const { secret, public: pub } = parseBackup(mnemonicOrKey)
    const address = await addressFromPubkey(pub) // throws on a bad public key
    if (!(await keypairMatches(secret, pub))) {
      throw new Error('secret and public key do not match — check the backup')
    }
    await sealAndStore(secret, pub, address, passphrase)
    session = { secret, public: pub, address }
    invalidateBalanceCache()
    return address
  },

  async unlock(passphrase: string): Promise<boolean> {
    const stored = loadStored()
    if (!stored) return false
    try {
      const pt = await open<SecretPayload>(stored.vault, passphrase)
      if (!pt || !pt.secret || !pt.public) return false
      // integrity: the sealed key must still commit to the stored address
      const addr = await addressFromPubkey(pt.public)
      if (addr !== stored.address) return false
      session = { secret: pt.secret, public: pt.public, address: stored.address }
      return true
    } catch {
      return false
    }
  },

  async send(to: string, amount: number): Promise<{ ok: boolean; tx?: string; error?: string }> {
    try {
      const stored = loadStored()
      if (!stored) return { ok: false, error: 'no wallet on this device' }
      if (!session) return { ok: false, error: 'wallet is locked — unlock it first' }
      const dest = to.trim()
      if (!looksLikeBlockAddress(dest)) {
        return { ok: false, error: 'invalid BLOCK address (must start with block1…)' }
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: 'amount must be greater than zero' }
      }
      const amountBase = BigInt(Math.round(amount * COIN))
      if (amountBase <= 0n) return { ok: false, error: 'amount too small' }
      const feeBase = 10_000n // 0.0001 BLOCK — the standard web-wallet fee

      const u = await fetchUtxos(stored.address)
      if (!u) return { ok: false, error: 'chain API unreachable — try again' }
      if (!u.utxos.length) {
        return { ok: false, error: 'no spendable funds (mined coins mature after 100 blocks)' }
      }
      if (BigInt(u.spendable || 0) < amountBase + feeBase) {
        return { ok: false, error: 'insufficient spendable balance (amount + 0.0001 BLOCK fee)' }
      }

      const built = await buildTransfer(
        session.secret,
        session.public,
        u.utxos,
        dest,
        amountBase,
        feeBase
      )
      const txid = await submitRaw(built.raw)
      invalidateBalanceCache()
      return { ok: true, tx: txid }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}

/** Re-lock: wipe the in-memory session (strings are GC'd; nothing persisted). */
export function lock(): void {
  session = null
}

/** True while the secret is decrypted in memory. */
export function isUnlocked(): boolean {
  return session !== null
}

export default wallet
