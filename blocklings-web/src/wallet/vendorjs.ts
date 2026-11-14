/**
 * vendorjs.ts — runtime loader + typings for the vendored classic-script
 * signer modules in /vendor/ (the SAME self-contained crypto the production
 * Blockle web wallet ships: crypto-core, secp256k1, ed25519, BIP32 HD,
 * EVM + Solana chain adapters). They attach globals (BLKCrypto, Secp256k1,
 * Ed25519, HD, Addr, EvmAdapter, SolanaAdapter); we inject them in
 * dependency order, once, and hand back typed facades.
 *
 * No key material ever leaves these modules — they build + sign locally and
 * only ever emit signed raw transactions.
 */

export interface BLKCryptoAPI {
  toBytes(x: Uint8Array | string | number[]): Uint8Array
  hexToBytes(hex: string): Uint8Array
  bytesToHex(b: Uint8Array): string
  concatBytes(...parts: Uint8Array[]): Uint8Array
  utf8(s: string): Uint8Array
  sha256(b: Uint8Array): Uint8Array
  base58encode(b: Uint8Array): string
  base58decode(s: string): Uint8Array
}

export interface Ed25519API {
  publicKey(seed: Uint8Array): Uint8Array
  sign(msg: Uint8Array, seed: Uint8Array): Uint8Array
}

export interface HDNode {
  privateKey: Uint8Array
  publicKey: Uint8Array
}

export interface HDAPI {
  derivePath(seed: Uint8Array, path: string): HDNode
}

export interface AddrAPI {
  evmAddress(pub: Uint8Array): string
}

export interface ChainAccount {
  chain: string
  index: number
  address: string
  publicKey: string
  scheme: string
  path: string | null
}

export interface BalanceRow {
  asset: { symbol: string; decimals: number }
  confirmed: string
  display: string
  error?: string
}

export interface BuiltChainTx {
  chain: string
  raw: string
  txid: string
  fee?: string
}

export interface EvmAdapterInstance {
  id: string
  chainId: number
  unlock(root: Uint8Array): void
  lock(): void
  deriveAccount(root: Uint8Array, index: number): Promise<ChainAccount>
  getBalance(address: string, tokens?: unknown[]): Promise<BalanceRow[]>
  buildSend(
    account: { index: number; address: string },
    req: { to: string; amount: string; max?: boolean }
  ): Promise<BuiltChainTx>
  signArbitraryTx(
    account: { index: number; address: string },
    req: { to: string; data?: string; value?: string | number; gasLimit?: string }
  ): Promise<BuiltChainTx>
  broadcast(tx: { raw: string }): Promise<{ txid: string; accepted: boolean }>
}

export interface EvmAdapterAPI {
  createEvmAdapter(opts: {
    id: string
    chainId: number
    rpcUrl: string
    explorer?: string
  }): EvmAdapterInstance
  erc721SafeTransferFromData(from: string, to: string, tokenId: string): string
}

export interface SolanaInstruction {
  programId: Uint8Array
  keys: { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }[]
  data: Uint8Array
}

export interface SolanaAdapterInstance {
  id: string
  unlock(root: Uint8Array): void
  lock(): void
  deriveAccount(root: Uint8Array, index: number): Promise<ChainAccount>
  getBalance(address: string, tokens?: unknown[]): Promise<BalanceRow[]>
  signTx(
    account: { index: number; address?: string },
    tx: { raw: string } | string
  ): Promise<{ chain: string; raw: string; txid: string }>
  buildNftTransfer(
    account: { index: number; address: string },
    req: { mint: string; to: string; amount?: string; decimals?: number }
  ): Promise<{ raw: string; needsSign: boolean }>
  broadcast(tx: { raw: string } | string): Promise<{ txid: string; accepted: boolean }>
}

export interface SolanaAdapterAPI {
  createSolanaAdapter(opts: { rpcUrl: string; explorer?: string }): SolanaAdapterInstance
  compileMessage(
    feePayer: Uint8Array,
    instructions: SolanaInstruction[],
    recentBlockhash: Uint8Array
  ): Uint8Array
  encodeShortVec(n: number): Uint8Array
  signSerializedTx(tx: Uint8Array | string, seedKey: Uint8Array, pubkey: Uint8Array): Uint8Array
  findProgramAddress(
    seeds: Uint8Array[],
    programId: Uint8Array
  ): { address: Uint8Array; bump: number }
  associatedTokenAddress(owner: Uint8Array, mint: Uint8Array): Uint8Array
  createAtaIdempotentIx(
    payer: Uint8Array,
    ata: Uint8Array,
    owner: Uint8Array,
    mint: Uint8Array
  ): SolanaInstruction
  u64le(n: string | number | bigint): Uint8Array
  toBase64(b: Uint8Array): string
  deriveSlip10(seed: Uint8Array, path: string): { key: Uint8Array; chainCode: Uint8Array }
  DEFAULT_PATH: string
  TOKEN_PROGRAM: string
  METADATA_PROGRAM: string
  SYSTEM_PROGRAM: string
}

/** The globals the vendored scripts attach to window. */
interface VendorGlobals {
  BLKCrypto: BLKCryptoAPI
  Ed25519: Ed25519API
  HD: HDAPI
  Addr: AddrAPI
  EvmAdapter: EvmAdapterAPI
  SolanaAdapter: SolanaAdapterAPI
}

function vendorUrl(file: string): string {
  return new URL(`vendor/${file}`, document.baseURI).toString()
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = false // preserve dependency order
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(s)
  })
}

// Load order matters: crypto-core first, then curves, then HD/address, then
// the chain adapters that consume all of them.
const VENDOR_FILES = [
  'crypto-core.js',
  'secp256k1.js',
  'ed25519.js',
  'hd.js',
  'address.js',
  'chains-evm.js',
  'chains-solana.js'
]

let ready: Promise<VendorGlobals> | null = null

/**
 * Load the vendored signer scripts once and return the typed globals.
 * Throws loudly if any script fails to load/attach — callers surface that
 * honestly (no silent fallbacks, no fake crypto).
 */
export function vendorReady(): Promise<VendorGlobals> {
  if (ready) return ready
  ready = (async () => {
    const w = window as unknown as Partial<VendorGlobals>
    if (!w.SolanaAdapter || !w.EvmAdapter) {
      for (const f of VENDOR_FILES) await injectScript(vendorUrl(f))
    }
    const g = window as unknown as Partial<VendorGlobals>
    if (!g.BLKCrypto || !g.Ed25519 || !g.HD || !g.Addr || !g.EvmAdapter || !g.SolanaAdapter) {
      throw new Error('multichain signer modules failed to initialise (vendor/*.js)')
    }
    return g as VendorGlobals
  })()
  ready.catch(() => {
    ready = null // transient fetch failure must not poison the session
  })
  return ready
}
