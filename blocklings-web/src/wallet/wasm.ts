/**
 * wasm.ts — runtime loader for the Blockle post-quantum signer.
 *
 * The signer is the SAME consensus-correct wasm the production web wallet
 * uses (built from blockle-core, ML-DSA-44, bech32m `block1…` addresses).
 * It is a wasm-pack `--target no-modules` build: `blockle_wasm.js` is a
 * CLASSIC script that declares a top-level `let wasm_bindgen` — a lexical
 * global reachable by bare name (NOT a window property). We inject the
 * script at runtime from /vendor/ and init it against the .wasm next to it.
 *
 * Keys only ever flow wasm <-> this module's memory. Nothing here talks to
 * the network.
 */

/** JSON shape returned by `wasm_bindgen.keygen()`. */
export interface Keypair {
  address: string
  publicKey: string
  secretKey: string
}

/** JSON shape returned by `wasm_bindgen.build_transfer(...)`. */
export interface BuiltTx {
  /** bincode-hex raw transaction, ready for the submit endpoint. */
  raw: string
  /** txid in the node's (raw-hash) spelling. */
  txid: string
}

interface WasmBindgen {
  (opts?: { module_or_path: string | URL }): Promise<unknown>
  keygen(): string
  address_from_pubkey(publicHex: string): string
  sign_message(secretHex: string, publicHex: string, msg: string): string
  verify(publicHex: string, msg: string, signatureHex: string): boolean
  build_transfer(
    secretHex: string,
    publicHex: string,
    utxosJson: string,
    to: string,
    amount: bigint,
    fee: bigint
  ): string
}

declare global {
  /** Lexical global declared by the classic no-modules wasm-bindgen glue. */
  // eslint-disable-next-line no-var
  const wasm_bindgen: WasmBindgen | undefined
}

function vendorUrl(file: string): string {
  // Vite `base: './'` → vendor/ sits next to index.html wherever it's hosted.
  return new URL(`vendor/${file}`, document.baseURI).toString()
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(s)
  })
}

let ready: Promise<WasmBindgen> | null = null

/**
 * Load + initialise the signer once. Throws loudly (and allows a retry on
 * the next call) if the wasm cannot be fetched/instantiated — callers must
 * surface that error, never fake crypto.
 */
export function signerReady(): Promise<WasmBindgen> {
  if (ready) return ready
  ready = (async () => {
    if (typeof wasm_bindgen === 'undefined') {
      await injectScript(vendorUrl('blockle_wasm.js'))
    }
    const wb = typeof wasm_bindgen !== 'undefined' ? wasm_bindgen : undefined
    if (!wb) {
      throw new Error(
        'Blockle signer unavailable: vendor/blockle_wasm.js did not define wasm_bindgen'
      )
    }
    await wb({ module_or_path: vendorUrl('blockle_wasm_bg.wasm') })
    return wb
  })()
  // A failed init must not poison the session forever (e.g. transient fetch
  // failure on flaky mobile) — drop the cached promise so a retry can work.
  ready.catch(() => {
    ready = null
  })
  return ready
}

export async function keygen(): Promise<Keypair> {
  const wb = await signerReady()
  return JSON.parse(wb.keygen()) as Keypair
}

export async function addressFromPubkey(publicHex: string): Promise<string> {
  const wb = await signerReady()
  return wb.address_from_pubkey(publicHex)
}

/** Prove a secret/public pair actually match (sign + verify roundtrip). */
export async function keypairMatches(secretHex: string, publicHex: string): Promise<boolean> {
  const wb = await signerReady()
  try {
    const probe = 'blocklings-key-check'
    const signed = JSON.parse(wb.sign_message(secretHex, publicHex, probe)) as {
      signature: string
    }
    return wb.verify(publicHex, probe, signed.signature)
  } catch {
    return false
  }
}

export interface Utxo {
  txid: string
  vout: number
  amount: number
}

/**
 * Build + sign a BLOCK transfer. Amount/fee in base units (1 BLOCK = 1e8).
 * Throws with the wasm's human-readable error on insufficient funds, bad
 * address, etc.
 */
export async function buildTransfer(
  secretHex: string,
  publicHex: string,
  utxos: Utxo[],
  to: string,
  amountBase: bigint,
  feeBase: bigint
): Promise<BuiltTx> {
  const wb = await signerReady()
  assertInputCap(utxos, amountBase, feeBase)
  return JSON.parse(
    wb.build_transfer(secretHex, publicHex, JSON.stringify(utxos), to, amountBase, feeBase)
  ) as BuiltTx
}

/**
 * Post-quantum signatures are ~13KB each; past ~140 inputs a tx exceeds the
 * 2MB block size and can never mine. Same guard the production wallet uses.
 */
const MAX_TX_INPUTS = 140

function assertInputCap(utxos: Utxo[], amountBase: bigint, feeBase: bigint): void {
  const need = amountBase + feeBase
  const sorted = utxos
    .slice()
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0))
  let got = 0n
  let count = 0
  for (const u of sorted) {
    got += BigInt(u.amount)
    count++
    if (got >= need) break
  }
  if (got >= need && count > MAX_TX_INPUTS) {
    throw new Error(
      'Too many small BLOCK coins to send this amount in one transaction — it would exceed the network block size. Consolidate by sending to yourself in smaller batches first.'
    )
  }
}
