/**
 * Blockle chain client for the anchor registry.
 *
 * Submits a 32-byte Merkle-root commitment to the on-chain anchor-registry
 * contract and reads anchors back. Uses the EXACT node surface the other
 * Blockle services use (`services/stablecoin`, `services/gas-sponsor`):
 *   - build + sign via the `blockle_wasm` `build_call` binding (ML-DSA signing
 *     happens inside wasm; we never hand-roll a transaction),
 *   - submit via JSON-RPC 1.0 `submitrawtransaction` to the localhost node,
 *   - read via the read-only `callcontract` view (no trust in this service).
 *
 * HONEST GATING: if the hot wallet or the contract id is not configured, submit
 * throws `AnchorNotConfigured` — it NEVER returns a fabricated txid. A caller
 * (the HTTP server) surfaces that as 503, so the system fails closed rather than
 * simulating a successful on-chain anchor.
 */
import { readFileSync } from 'node:fs'

// Selectors — must match chain/crates/chain/src/anchor_registry.rs
export const SEL_ANCHOR = 0x00
export const SEL_ANCHORED = 0x01

const GAS_LIMIT = 120000n
const GAS_PRICE = 10n

export class AnchorNotConfigured extends Error {
  constructor(msg: string) { super(msg); this.name = 'AnchorNotConfigured' }
}

export interface ChainConfig {
  /** Node JSON-RPC + explorer base, e.g. http://127.0.0.1:8445 */
  nodeUrl: string
  /** 64-hex anchor-registry contract id (set once deployed). */
  contractId?: string
  /** Path to the hot wallet JSON { address, publicKey/public_hex, secretKey/secret_hex }. */
  walletFile?: string
  /** The built wasm module (require('blockle_wasm')); injected so tests can stub it. */
  wasm?: WasmBuildCall
}

export interface WasmBuildCall {
  build_call(
    secretHex: string, publicHex: string, utxosJson: string,
    contractHex: string, inputHex: string, value: bigint,
    gasLimit: bigint, gasPrice: bigint,
  ): string
}

interface HotWallet { address: string; publicKey: string; secretKey: string }

function loadWallet(path: string): HotWallet {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  // Two key-name conventions exist across Blockle services; accept both.
  const address = raw.address
  const publicKey = raw.publicKey ?? raw.public_hex
  const secretKey = raw.secretKey ?? raw.secret_hex
  if (!address || !publicKey || !secretKey) {
    throw new AnchorNotConfigured(`wallet ${path} missing address/publicKey/secretKey`)
  }
  return { address, publicKey, secretKey }
}

export class AnchorChain {
  constructor(private cfg: ChainConfig) {}

  get configured(): boolean { return !!(this.cfg.contractId && this.cfg.walletFile && this.cfg.wasm) }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    const r = await fetch(this.cfg.nodeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'protect-anchor', method, params }),
    })
    const b = await r.json() as any
    if (b.error) throw new Error(`${method}: ${b.error.message ?? JSON.stringify(b.error)}`)
    return b.result
  }

  private async utxos(address: string): Promise<{ txid: string; vout: number; amount: number }[]> {
    const r = await fetch(`${this.cfg.nodeUrl}/explorer/utxos/${encodeURIComponent(address)}`)
    const b = await r.json() as any
    return (b.utxos ?? []).map((x: any) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }))
  }

  /** calldata = selector byte ‖ 32-byte root, hex-encoded (no 0x). */
  private calldata(selector: number, root32Hex: string): string {
    if (!/^[0-9a-fA-F]{64}$/.test(root32Hex)) throw new Error('root must be 32 bytes (64 hex)')
    return selector.toString(16).padStart(2, '0') + root32Hex.toLowerCase()
  }

  /**
   * Anchor a 32-byte root on-chain. Returns the submitted txid. Throws
   * AnchorNotConfigured when the wallet/contract/wasm aren't present — never a
   * fake txid.
   */
  async anchor(root32Hex: string): Promise<{ txid: string; fee: number }> {
    if (!this.cfg.contractId) throw new AnchorNotConfigured('anchor-registry contractId not set (contract not deployed yet)')
    if (!this.cfg.walletFile) throw new AnchorNotConfigured('hot wallet not configured')
    if (!this.cfg.wasm) throw new AnchorNotConfigured('blockle_wasm module not loaded')
    const w = loadWallet(this.cfg.walletFile)
    const utxos = await this.utxos(w.address)
    if (!utxos.length) throw new Error('hot wallet has no spendable UTXOs to pay the anchor fee')
    const input = this.calldata(SEL_ANCHOR, root32Hex)
    const built = JSON.parse(this.cfg.wasm.build_call(
      w.secretKey, w.publicKey, JSON.stringify(utxos),
      this.cfg.contractId, input, 0n, GAS_LIMIT, GAS_PRICE,
    ))
    const txid = await this.rpc('submitrawtransaction', [built.raw])
    return { txid, fee: Number(built.fee ?? 0) }
  }

  /**
   * Read-only: returns the anchor block height for a root (0 = not anchored).
   * Independently verifiable — anyone can make this same call to any node.
   */
  async anchoredHeight(root32Hex: string): Promise<number> {
    if (!this.cfg.contractId) throw new AnchorNotConfigured('anchor-registry contractId not set')
    const calldata = this.calldata(SEL_ANCHORED, root32Hex)
    const res = await this.rpc('callcontract', [{ contract: this.cfg.contractId, calldata }])
    if (!res?.success) return 0
    // node returns a decoded u64 and/or returnHex (LE bytes)
    if (typeof res.u64 === 'number') return res.u64
    if (typeof res.returnHex === 'string' && res.returnHex.length >= 16) {
      const le = res.returnHex.slice(0, 16).match(/../g)!.reverse().join('')
      return parseInt(le, 16)
    }
    return 0
  }

  /** Confirmation status of an anchor tx by txid (uses getrawtransaction). */
  async txConfirmations(txid: string): Promise<{ found: boolean; confirmations: number }> {
    try {
      const tx = await this.rpc('getrawtransaction', [txid, true])
      return { found: !!tx, confirmations: Number(tx?.confirmations ?? 0) }
    } catch {
      return { found: false, confirmations: 0 }
    }
  }
}

/** Map a 48-byte SHA-384 Merkle root (base64url or hex) to the 32-byte on-chain key. */
export function onchainRoot32(rootHex: string): string {
  const clean = rootHex.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (clean.length < 64) throw new Error('root too short')
  return clean.slice(0, 64) // first 32 bytes of the SHA-384 root
}
