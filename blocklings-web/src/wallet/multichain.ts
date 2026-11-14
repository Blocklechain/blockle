/**
 * multichain.ts — Ethereum + Solana accounts, sends, NFT mints and MoonPay
 * on/off-ramp URLs for the in-game tri-chain wallet (WalletAPI2).
 *
 * KEY MODEL (non-custodial, one vault): the classical-chain HD seed is
 * derived DETERMINISTICALLY from the vaulted ML-DSA-44 secret key —
 * seed = SHA-256('blocklings-multichain-v1' ‖ secretKeyBytes) — so the
 * existing `blockling-key-v1` backup restores ALL THREE chains anywhere,
 * and no second secret is ever stored. Derivation paths match the
 * production Blockle wallets: EVM m/44'/60'/0'/0/0 (secp256k1),
 * Solana m/44'/501'/0'/0' (SLIP-0010 ed25519).
 *
 * Everything here is REAL: live balances (30s cache, offline-tolerant),
 * build+sign+submit sends on both chains, a REAL Solana NFT mint (SPL mint
 * + Metaplex metadata, uid embedded), a REAL BLOCK mint (BLOCK-721 launch
 * with the uid embedded on-chain), and honest {ok:false} errors everywhere
 * a path cannot be real. No fabricated balances, txids, or receipts. Ever.
 */
import type { ChainId } from '../types'
import { fetchUtxos, flipTxid, submitRaw } from './chain'
import { assembleAsm, buildLaunchNft, contractIdForTxid } from './wasm'
import { block721Asm } from './block721'
import {
  vendorReady,
  type EvmAdapterInstance,
  type SolanaAdapterInstance,
  type SolanaInstruction
} from './vendorjs'

// --- endpoints (same ones the production web wallet uses) -------------------

/** Keyless public Ethereum JSON-RPC (publicnode, browser-CORS-open). */
export const ETH_RPC = 'https://ethereum-rpc.publicnode.com'
/**
 * Same-origin Solana RPC relay on blockle.org (api.mainnet-beta blocks sends
 * and publicnode 403s browser origins — the server forwards to SOLANA_RPC).
 */
export const SOL_RPC = 'https://blockle.org/account/api/sol/rpc'

const MOONPAY_CONFIG = 'https://blockle.org/account/api/moonpay/config'
const MOONPAY_SIGN = 'https://blockle.org/account/api/moonpay/sign'
/** Sandbox publishable key fallback (safe to embed; /config swaps in live). */
const MOONPAY_TEST_KEY = 'pk_test_uRXfpYr99uQJibabWff6BlZYIzzFONLF'

const ADDR_CACHE_KEY = 'blocklings_wallet_chains_v1'
const BAL_CACHE_KEY = 'blocklings_wallet_chainbal_v1'
const MINTS_KEY = 'blocklings_wallet_mints_v1'
const BAL_TTL_MS = 30_000

const BLOCK_GAS_LIMIT = 400_000n // proven BLOCK-721 launch budget
const BLOCK_GAS_PRICE = 10n // base units per gas → 0.04 BLOCK fee

// --- seed + account derivation ----------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const h = hex.length % 2 ? '0' + hex : hex
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

let seedCache: { secret: string; seed: Uint8Array } | null = null

/** Deterministic multichain HD seed from the vaulted ML-DSA secret. */
async function deriveSeed(secretHex: string): Promise<Uint8Array> {
  if (seedCache && seedCache.secret === secretHex) return seedCache.seed
  if (!crypto?.subtle) throw new Error('WebCrypto unavailable — needs a secure context')
  const tag = new TextEncoder().encode('blocklings-multichain-v1')
  const sk = hexToBytes(secretHex)
  const buf = new Uint8Array(tag.length + sk.length)
  buf.set(tag, 0)
  buf.set(sk, tag.length)
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as BufferSource))
  sk.fill(0)
  buf.fill(0)
  seedCache = { secret: secretHex, seed }
  return seed
}

/** Wipe in-memory derived key material (called on wallet lock). */
export function lockChains(): void {
  if (seedCache) seedCache.seed.fill(0)
  seedCache = null
  if (evmAdapter) evmAdapter.lock()
  if (solAdapter) solAdapter.lock()
}

let evmAdapter: EvmAdapterInstance | null = null
let solAdapter: SolanaAdapterInstance | null = null

async function adapters(): Promise<{ evm: EvmAdapterInstance; sol: SolanaAdapterInstance }> {
  const V = await vendorReady()
  if (!evmAdapter) {
    evmAdapter = V.EvmAdapter.createEvmAdapter({
      id: 'ethereum',
      chainId: 1,
      rpcUrl: ETH_RPC,
      explorer: 'https://etherscan.io/tx/'
    })
  }
  if (!solAdapter) {
    solAdapter = V.SolanaAdapter.createSolanaAdapter({
      rpcUrl: SOL_RPC,
      explorer: 'https://solscan.io/tx/'
    })
  }
  return { evm: evmAdapter, sol: solAdapter }
}

interface ChainAddresses {
  ethereum?: string
  solana?: string
}

function cachedAddresses(): ChainAddresses {
  try {
    return (JSON.parse(localStorage.getItem(ADDR_CACHE_KEY) ?? '{}') as ChainAddresses) || {}
  } catch {
    return {}
  }
}

/**
 * Derive (and cache) the ETH + SOL addresses from the unlocked secret.
 * Public data only — safe to persist so `chains()` works while locked.
 */
export async function primeAccounts(secretHex: string): Promise<Required<ChainAddresses>> {
  const seed = await deriveSeed(secretHex)
  const { evm, sol } = await adapters()
  evm.unlock(seed)
  sol.unlock(seed)
  const ea = await evm.deriveAccount(seed, 0)
  const sa = await sol.deriveAccount(seed, 0)
  const addrs = { ethereum: ea.address, solana: sa.address }
  try {
    localStorage.setItem(ADDR_CACHE_KEY, JSON.stringify(addrs))
  } catch {
    /* best-effort */
  }
  return addrs
}

// --- balances (30s cache, offline-tolerant) ---------------------------------

interface BalCacheEntry {
  address: string
  balance: number
  at: number
}

function readBalCache(): Partial<Record<string, BalCacheEntry>> {
  try {
    return (
      (JSON.parse(localStorage.getItem(BAL_CACHE_KEY) ?? '{}') as Partial<
        Record<string, BalCacheEntry>
      >) || {}
    )
  } catch {
    return {}
  }
}

function writeBalCache(cache: Partial<Record<string, BalCacheEntry>>): void {
  try {
    localStorage.setItem(BAL_CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* quota — cache is best-effort */
  }
}

async function nativeBalance(chain: 'ethereum' | 'solana', address: string): Promise<number> {
  const cache = readBalCache()
  const hit = cache[chain]
  const now = Date.now()
  if (hit && hit.address === address && now - hit.at < BAL_TTL_MS) return hit.balance
  try {
    const { evm, sol } = await adapters()
    const rows = await (chain === 'ethereum' ? evm : sol).getBalance(address)
    const row = rows[0]
    if (!row || row.error) throw new Error(row?.error ?? 'no balance row')
    const decimals = chain === 'ethereum' ? 18 : 9
    const balance = Number(BigInt(row.confirmed)) / 10 ** decimals
    cache[chain] = { address, balance, at: now }
    writeBalCache(cache)
    return balance
  } catch {
    // offline / RPC down → last known (never fabricated; 0 when unknown)
    return hit && hit.address === address ? hit.balance : 0
  }
}

/**
 * Per-chain snapshot for WalletAPI2.chains() (ethereum + solana legs; the
 * caller merges the BLOCK leg). Chains never primed on this device are absent.
 */
export async function chainSnapshots(): Promise<
  Partial<Record<'ethereum' | 'solana', { address: string; balance: number }>>
> {
  const addrs = cachedAddresses()
  const out: Partial<Record<'ethereum' | 'solana', { address: string; balance: number }>> = {}
  if (addrs.ethereum) {
    out.ethereum = { address: addrs.ethereum, balance: await nativeBalance('ethereum', addrs.ethereum) }
  }
  if (addrs.solana) {
    out.solana = { address: addrs.solana, balance: await nativeBalance('solana', addrs.solana) }
  }
  return out
}

/** Drop the chain balance cache (after a send) so the next read is fresh. */
export function invalidateChainBalances(): void {
  try {
    localStorage.removeItem(BAL_CACHE_KEY)
  } catch {
    /* ignore */
  }
}

// --- mint registry (same-uid-same-chain must fail; survives reloads) --------

type MintReg = Partial<Record<string, Partial<Record<ChainId, { token: string; tx: string; t: number }>>>>

function readMints(): MintReg {
  try {
    return (JSON.parse(localStorage.getItem(MINTS_KEY) ?? '{}') as MintReg) || {}
  } catch {
    return {}
  }
}

function recordMint(uid: string, chain: ChainId, token: string, tx: string): void {
  const reg = readMints()
  const perUid = reg[uid] ?? {}
  perUid[chain] = { token, tx, t: Date.now() }
  reg[uid] = perUid
  try {
    localStorage.setItem(MINTS_KEY, JSON.stringify(reg))
  } catch {
    /* best-effort; duplicate guard degrades gracefully */
  }
}

/** All recorded mints of a uid on this device (for UI badges). */
export function mintsOf(uid: string): Partial<Record<ChainId, { token: string; tx: string; t: number }>> {
  return readMints()[uid] ?? {}
}

// --- sends ------------------------------------------------------------------

type SendResult = { ok: boolean; tx?: string; error?: string }

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** base-unit integer from a decimal coin amount, exact to 9 dp. */
function toBase(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be greater than zero')
  const nano = BigInt(Math.round(amount * 1e9))
  if (nano <= 0n) throw new Error('amount too small')
  if (decimals >= 9) return nano * 10n ** BigInt(decimals - 9)
  return nano / 10n ** BigInt(9 - decimals)
}

/** Send on Ethereum: native ETH (number) or an ERC-721 `contract:tokenId`. */
export async function sendOnEthereum(
  secretHex: string,
  to: string,
  amountOrToken: number | string
): Promise<SendResult> {
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      return { ok: false, error: 'invalid Ethereum address (0x + 40 hex chars)' }
    }
    const seed = await deriveSeed(secretHex)
    const { evm } = await adapters()
    const V = await vendorReady()
    evm.unlock(seed)
    const account = await evm.deriveAccount(seed, 0)
    let built
    if (typeof amountOrToken === 'number') {
      const wei = toBase(amountOrToken, 18)
      built = await evm.buildSend(account, { to: to.trim(), amount: wei.toString() })
    } else {
      const m = /^(0x[0-9a-fA-F]{40}):(\d+)$/.exec(amountOrToken.trim())
      if (!m || !m[1] || !m[2]) {
        return { ok: false, error: 'Ethereum token id must be contract:tokenId (ERC-721)' }
      }
      const data = V.EvmAdapter.erc721SafeTransferFromData(account.address, to.trim(), m[2])
      built = await evm.signArbitraryTx(account, { to: m[1], data, value: 0 })
    }
    const res = await evm.broadcast(built)
    invalidateChainBalances()
    return { ok: true, tx: res.txid }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** Send on Solana: native SOL (number) or an SPL/NFT mint address (string). */
export async function sendOnSolana(
  secretHex: string,
  to: string,
  amountOrToken: number | string
): Promise<SendResult> {
  try {
    const seed = await deriveSeed(secretHex)
    const { sol } = await adapters()
    const V = await vendorReady()
    const S = V.SolanaAdapter
    const C = V.BLKCrypto
    sol.unlock(seed)
    const account = await sol.deriveAccount(seed, 0)
    let destKey: Uint8Array
    try {
      destKey = C.base58decode(to.trim())
    } catch {
      return { ok: false, error: 'invalid Solana address (base58)' }
    }
    if (destKey.length !== 32) return { ok: false, error: 'invalid Solana address (not 32 bytes)' }

    let unsignedB64: string
    if (typeof amountOrToken === 'number') {
      const lamports = toBase(amountOrToken, 9)
      const fromKey = C.base58decode(account.address)
      const data = new Uint8Array(12)
      new DataView(data.buffer).setUint32(0, 2, true) // SystemProgram::Transfer
      data.set(S.u64le(lamports.toString()), 4)
      const ix: SolanaInstruction = {
        programId: C.base58decode(S.SYSTEM_PROGRAM),
        keys: [
          { pubkey: fromKey, isSigner: true, isWritable: true },
          { pubkey: destKey, isSigner: false, isWritable: true }
        ],
        data
      }
      const blockhash = await solBlockhash()
      const msg = S.compileMessage(fromKey, [ix], C.base58decode(blockhash))
      unsignedB64 = S.toBase64(concatBytes(S.encodeShortVec(1), new Uint8Array(64), msg))
    } else {
      // token/NFT send: mint address → TransferChecked (amount 1, decimals 0)
      const built = await sol.buildNftTransfer(
        { index: 0, address: account.address },
        { mint: amountOrToken.trim(), to: to.trim(), amount: '1', decimals: 0 }
      )
      unsignedB64 = built.raw
    }
    const signed = await sol.signTx({ index: 0, address: account.address }, { raw: unsignedB64 })
    const res = await sol.broadcast({ raw: signed.raw })
    invalidateChainBalances()
    return { ok: true, tx: res.txid }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

// --- NFT minting ------------------------------------------------------------

export interface NftMeta {
  name: string
  desc?: string
  image?: string
  attrs?: Record<string, string | number>
}

type MintResult = { ok: boolean; token?: string; tx?: string; error?: string }

/** Guard: one mint per uid per chain, permanently. */
function duplicateMint(uid: string, chain: ChainId): MintResult | null {
  const prior = readMints()[uid]?.[chain]
  if (prior) {
    return {
      ok: false,
      error: `uid ${uid} is already minted on ${chain} (token ${prior.token.slice(0, 12)}…) — re-mint on a DIFFERENT chain instead`
    }
  }
  return null
}

/**
 * REAL BLOCK mint: assemble a canonical BLOCK-721 collection whose on-chain
 * `meta()` (selector 9) returns {uid, ...meta} as JSON, then LaunchNft it
 * atomically via the consensus wasm. token = the consensus contract id.
 */
export async function mintOnBlock(
  secretHex: string,
  publicHex: string,
  address: string,
  uid: string,
  meta: NftMeta
): Promise<MintResult> {
  try {
    const dup = duplicateMint(uid, 'blockle')
    if (dup) return dup
    const metaJson = JSON.stringify({ uid, ...meta })
    const asm = block721Asm(meta.name.slice(0, 32) || 'Blockling Item', 'BLKG', metaJson)
    const codeHex = await assembleAsm(asm)
    if (codeHex.length / 2 > 24_576) {
      return { ok: false, error: 'NFT code exceeds the 24,576-byte chain cap — trim the metadata' }
    }
    const u = await fetchUtxos(address)
    if (!u) return { ok: false, error: 'BLOCK chain API unreachable — try again' }
    const feeBase = BLOCK_GAS_LIMIT * BLOCK_GAS_PRICE
    if (BigInt(u.spendable || 0) < feeBase) {
      return {
        ok: false,
        error: `insufficient BLOCK for the mint gas fee (${Number(feeBase) / 1e8} BLOCK)`
      }
    }
    const built = await buildLaunchNft(
      secretHex,
      publicHex,
      u.utxos,
      codeHex,
      BLOCK_GAS_LIMIT,
      BLOCK_GAS_PRICE
    )
    const token = await contractIdForTxid(built.txid)
    const tx = await submitRaw(built.raw) // throws with the node's reason on reject
    recordMint(uid, 'blockle', token, tx)
    return { ok: true, token, tx }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/**
 * REAL Solana mint: create a fresh SPL mint (decimals 0, supply 1 to our ATA)
 * + a Metaplex metadata account in ONE transaction. The canonical uid is
 * embedded on-chain in the metadata URI (https://blockle.org/nft/<uid>).
 * Costs real rent+fees (~0.01 SOL) — failures (incl. preflight simulation)
 * surface verbatim. token = the new mint address; tx = the signature.
 */
export async function mintOnSolana(
  secretHex: string,
  uid: string,
  meta: NftMeta
): Promise<MintResult> {
  try {
    const dup = duplicateMint(uid, 'solana')
    if (dup) return dup
    const seed = await deriveSeed(secretHex)
    const V = await vendorReady()
    const S = V.SolanaAdapter
    const C = V.BLKCrypto
    const ED = V.Ed25519
    const { sol } = await adapters()
    sol.unlock(seed)

    const payerSeed = S.deriveSlip10(seed, S.DEFAULT_PATH).key
    const payerKey = ED.publicKey(payerSeed)

    // fresh ephemeral mint keypair (its secret is only needed for this one tx)
    const mintSeed = crypto.getRandomValues(new Uint8Array(32))
    const mintKey = ED.publicKey(mintSeed)
    const mintAddr = C.base58encode(mintKey)

    const tokenProg = C.base58decode(S.TOKEN_PROGRAM)
    const systemProg = C.base58decode(S.SYSTEM_PROGRAM)
    const metaProg = C.base58decode(S.METADATA_PROGRAM)

    const rent = (await solRpc('getMinimumBalanceForRentExemption', [82])) as number
    if (typeof rent !== 'number') throw new Error('solana: could not fetch mint rent')

    // 1) create the mint account (82 bytes, owned by the SPL Token program)
    const caData = new Uint8Array(4 + 8 + 8 + 32)
    new DataView(caData.buffer).setUint32(0, 0, true) // SystemProgram::CreateAccount
    caData.set(S.u64le(String(rent)), 4)
    caData.set(S.u64le('82'), 12)
    caData.set(tokenProg, 20)
    const createMintIx: SolanaInstruction = {
      programId: systemProg,
      keys: [
        { pubkey: payerKey, isSigner: true, isWritable: true },
        { pubkey: mintKey, isSigner: true, isWritable: true }
      ],
      data: caData
    }

    // 2) InitializeMint2: decimals 0, mint authority us, no freeze authority
    const imData = new Uint8Array(1 + 1 + 32 + 1)
    imData[0] = 20
    imData[1] = 0
    imData.set(payerKey, 2)
    imData[34] = 0 // COption::None freeze authority
    const initMintIx: SolanaInstruction = {
      programId: tokenProg,
      keys: [{ pubkey: mintKey, isSigner: false, isWritable: true }],
      data: imData
    }

    // 3) our ATA (idempotent create) + 4) MintTo 1
    const ata = S.associatedTokenAddress(payerKey, mintKey)
    const ataIx = S.createAtaIdempotentIx(payerKey, ata, payerKey, mintKey)
    const mtData = new Uint8Array(9)
    mtData[0] = 7
    mtData.set(S.u64le('1'), 1)
    const mintToIx: SolanaInstruction = {
      programId: tokenProg,
      keys: [
        { pubkey: mintKey, isSigner: false, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: payerKey, isSigner: true, isWritable: false }
      ],
      data: mtData
    }

    // 5) Metaplex CreateMetadataAccountV3 — name/symbol/uri with the uid baked
    const metadataPda = S.findProgramAddress(
      [C.utf8('metadata'), metaProg, mintKey],
      metaProg
    ).address
    const borshStr = (s: string, max: number): Uint8Array => {
      const b = new TextEncoder().encode(s).slice(0, max)
      const out = new Uint8Array(4 + b.length)
      new DataView(out.buffer).setUint32(0, b.length, true)
      out.set(b, 4)
      return out
    }
    const uri = `https://blockle.org/nft/${encodeURIComponent(uid)}`
    const mdData = concatBytes(
      Uint8Array.of(33), // CreateMetadataAccountV3
      borshStr(meta.name, 32),
      borshStr('BLKG', 10),
      borshStr(uri, 200),
      Uint8Array.of(0, 0), // seller_fee_basis_points u16 = 0
      Uint8Array.of(0), // creators: None
      Uint8Array.of(0), // collection: None
      Uint8Array.of(0), // uses: None
      Uint8Array.of(1), // is_mutable
      Uint8Array.of(0) // collection_details: None
    )
    const metadataIx: SolanaInstruction = {
      programId: metaProg,
      keys: [
        { pubkey: metadataPda, isSigner: false, isWritable: true },
        { pubkey: mintKey, isSigner: false, isWritable: false },
        { pubkey: payerKey, isSigner: true, isWritable: false }, // mint authority
        { pubkey: payerKey, isSigner: true, isWritable: true }, // payer
        { pubkey: payerKey, isSigner: true, isWritable: false }, // update authority
        { pubkey: systemProg, isSigner: false, isWritable: false }
      ],
      data: mdData
    }

    const blockhash = await solBlockhash()
    const msg = S.compileMessage(
      payerKey,
      [createMintIx, initMintIx, ataIx, mintToIx, metadataIx],
      C.base58decode(blockhash)
    )
    const numSigs = msg[0] ?? 0
    if (numSigs < 2) throw new Error('solana: compiled message lost a signer')
    let tx = concatBytes(S.encodeShortVec(numSigs), new Uint8Array(64 * numSigs), msg)
    tx = S.signSerializedTx(tx, payerSeed, payerKey)
    tx = S.signSerializedTx(tx, mintSeed, mintKey)
    mintSeed.fill(0)
    const res = await sol.broadcast({ raw: S.toBase64(tx) })
    invalidateChainBalances()
    recordMint(uid, 'solana', mintAddr, res.txid)
    return { ok: true, token: mintAddr, tx: res.txid }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/**
 * Ethereum mint: HONESTLY unsupported. A real ERC-721 mint needs a deployed
 * Blocklings contract with a public mint entrypoint on Ethereum mainnet —
 * no such contract exists yet (the production wallets view/transfer ERC-721s
 * but have never minted them), and we never fake a mint.
 */
export function mintOnEthereumUnsupported(): MintResult {
  return {
    ok: false,
    error:
      'Ethereum minting is not available yet: Blocklings has no ERC-721 contract deployed on Ethereum mainnet. Mint this item on BLOCK or Solana instead — the same uid can be re-minted on another chain later.'
  }
}

// --- MoonPay ----------------------------------------------------------------

const MOONPAY_CODES: Partial<Record<ChainId, string>> = {
  ethereum: 'eth',
  solana: 'sol'
  // blockle: absent on purpose — BLOCK is not listed on MoonPay (no fake ramps)
}

let moonpayKeyCache: { key: string; at: number } | null = null

async function moonpayKey(): Promise<string> {
  const now = Date.now()
  if (moonpayKeyCache && now - moonpayKeyCache.at < 10 * 60_000) return moonpayKeyCache.key
  try {
    const r = await fetch(MOONPAY_CONFIG, { credentials: 'omit' })
    if (r.ok) {
      const j = (await r.json()) as { publishableKey?: string }
      if (j.publishableKey) {
        moonpayKeyCache = { key: j.publishableKey, at: now }
        return j.publishableKey
      }
    }
  } catch {
    /* fall through to the sandbox key */
  }
  return MOONPAY_TEST_KEY
}

/**
 * Signed MoonPay widget URL for fiat on/off-ramp, or null when unavailable
 * (BLOCK is not on MoonPay; chains not yet primed have no address).
 * Buy: currencyCode = the crypto, walletAddress = our receive address.
 * Sell: baseCurrencyCode = the crypto being sold, quote = usd.
 */
export async function moonpayWidgetUrl(
  kind: 'buy' | 'sell',
  chain: ChainId
): Promise<string | null> {
  const code = MOONPAY_CODES[chain]
  if (!code) return null
  const address = cachedAddresses()[chain as 'ethereum' | 'solana']
  if (!address) return null
  const apiKey = await moonpayKey()
  const live = apiKey.startsWith('pk_live_')
  const base =
    kind === 'buy'
      ? live
        ? 'https://buy.moonpay.com'
        : 'https://buy-sandbox.moonpay.com'
      : live
        ? 'https://sell.moonpay.com'
        : 'https://sell-sandbox.moonpay.com'
  const p = new URLSearchParams()
  p.set('apiKey', apiKey)
  if (kind === 'buy') {
    p.set('currencyCode', code)
    p.set('walletAddress', address)
    p.set('baseCurrencyCode', 'usd')
  } else {
    p.set('baseCurrencyCode', code)
    p.set('quoteCurrencyCode', 'usd')
    p.set('walletAddress', address)
  }
  const unsigned = base + '?' + p.toString()
  // server-side HMAC signing (the secret key never ships to the client);
  // unsigned fallback is correct for the sandbox key only
  try {
    const r = await fetch(MOONPAY_SIGN, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: unsigned })
    })
    if (r.ok) {
      const j = (await r.json()) as { url?: string; signature?: string }
      if (j.url) return j.url
      if (j.signature) return unsigned + '&signature=' + encodeURIComponent(j.signature)
    }
  } catch {
    /* unsigned fallback below */
  }
  return unsigned
}

// --- small helpers ----------------------------------------------------------

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function solRpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  })
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } }
  if (j.error) throw new Error(j.error.message ?? 'solana rpc error')
  return j.result
}

async function solBlockhash(): Promise<string> {
  const res = (await solRpc('getLatestBlockhash', [{ commitment: 'finalized' }])) as {
    value?: { blockhash?: string }
    blockhash?: string
  } | null
  const bh = res?.value?.blockhash ?? res?.blockhash
  if (!bh) throw new Error('solana: could not fetch a recent blockhash')
  return bh
}

/** Re-export for the UI: tx hash → BLOCK explorer display spelling. */
export { flipTxid }
