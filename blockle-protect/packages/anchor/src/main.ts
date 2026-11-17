/**
 * Blockle Protect anchoring service entrypoint.
 *
 * Config via env (all optional except the node URL has a sane default):
 *   ANCHOR_NODE_URL     Blockle node JSON-RPC + explorer (default http://127.0.0.1:8445)
 *   ANCHOR_CONTRACT_ID  64-hex anchor-registry contract id (set once deployed)
 *   ANCHOR_WALLET       path to the hot wallet JSON (default /var/lib/blockle-anchor/wallet.json)
 *   ANCHOR_WASM         path to the built blockle_wasm commonjs module
 *   ANCHOR_PORT         listen port (default 8790, bound to 127.0.0.1)
 *
 * Fails CLOSED: with no wallet/contract/wasm, read endpoints still work and
 * /submit returns batch proofs with anchored:false — it never fakes an anchor.
 */
import { createRequire } from 'node:module'
import { AnchorChain, type ChainConfig, type WasmBuildCall } from './chain.js'
import { makeHandler } from './server.js'
import { createServer } from 'node:http'

function loadWasm(path: string | undefined): WasmBuildCall | undefined {
  if (!path) return undefined
  try {
    const require = createRequire(import.meta.url)
    const mod = require(path)
    if (typeof mod?.build_call === 'function') return mod as WasmBuildCall
    console.error(`[anchor] ${path} has no build_call export; submit disabled`)
  } catch (e) {
    console.error(`[anchor] failed to load wasm at ${path}: ${(e as Error).message}; submit disabled`)
  }
  return undefined
}

const cfg: ChainConfig = {
  nodeUrl: process.env.ANCHOR_NODE_URL ?? 'http://127.0.0.1:8445',
  ...(process.env.ANCHOR_CONTRACT_ID ? { contractId: process.env.ANCHOR_CONTRACT_ID } : {}),
  walletFile: process.env.ANCHOR_WALLET ?? '/var/lib/blockle-anchor/wallet.json',
  ...(() => { const w = loadWasm(process.env.ANCHOR_WASM); return w ? { wasm: w } : {} })(),
}

const chain = new AnchorChain(cfg)
const handler = makeHandler({ chain })
const port = Number(process.env.ANCHOR_PORT ?? 8790)
createServer((req, res) => { void handler(req, res) }).listen(port, '127.0.0.1', () => {
  console.error(`[anchor] listening on 127.0.0.1:${port} — anchoring ${chain.configured ? 'CONFIGURED' : 'NOT configured (read-only / proofs-only)'}`)
})
