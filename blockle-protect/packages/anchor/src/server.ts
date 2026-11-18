/**
 * Blockle Protect anchoring service — HTTP API.
 *
 * Endpoints (all JSON):
 *   POST /api/anchor/submit   { commitments: string[] (base64url SHA-384) }
 *       -> { root, onchainKey, txid|null, inclusions:[{commitment,proof}], anchored, reason? }
 *   GET  /api/anchor/root/<rootHexOrB64>   -> { onchainKey, height, anchored }
 *   GET  /api/anchor/tx/<txid>             -> { found, confirmations }
 *   GET  /api/anchor/health                -> { ok, configured, contractId?, node }
 *
 * Hardened per docs/AGENT-HARDENING.md: input is strictly validated and bounded,
 * the server performs NO privileged action from request content beyond anchoring
 * opaque 32-byte hashes, and it FAILS CLOSED — if the chain isn't configured it
 * returns the batch's inclusion proofs with `anchored:false` and an honest
 * reason, never a fabricated txid.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AnchorChain, onchainRoot32, type ChainConfig } from './chain.js'
import { buildAndAnchorBatch, type AnchorRecord } from './batcher.js'

const MAX_BATCH = 4096
const MAX_BODY = 8 * 1024 * 1024 // 8 MiB
const B64URL = /^[A-Za-z0-9_-]{43,86}$/ // SHA-384 (48B) base64url is 64 chars; allow a range

export interface ServerDeps {
  chain: AnchorChain
  /** persistence hook — store a completed batch record. Default: in-memory. */
  store?: (rec: AnchorRecord) => void
  /** monotonic clock injection for determinism/testing. */
  now?: () => number
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function makeHandler(deps: ServerDeps) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const records = new Map<string, AnchorRecord>()
  const store = deps.store ?? ((rec: AnchorRecord) => { records.set(rec.onchainKey, rec) })

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'GET' && path === '/api/anchor/health') {
        return json(res, 200, { ok: true, configured: deps.chain.configured, node: 'blockle' })
      }

      if (req.method === 'POST' && path === '/api/anchor/submit') {
        const raw = await readBody(req)
        let parsed: any
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'invalid JSON' }) }
        const commitments = parsed?.commitments
        if (!Array.isArray(commitments) || commitments.length === 0) {
          return json(res, 400, { error: 'commitments must be a non-empty array' })
        }
        if (commitments.length > MAX_BATCH) {
          return json(res, 413, { error: `batch exceeds ${MAX_BATCH} commitments` })
        }
        if (!commitments.every((c: unknown) => typeof c === 'string' && B64URL.test(c))) {
          return json(res, 400, { error: 'each commitment must be a base64url SHA-384 string' })
        }
        const { result, record } = await buildAndAnchorBatch(commitments, deps.chain, now())
        store(record)
        return json(res, result.anchored ? 200 : 202, result)
      }

      // Direct raw-hash anchor (used by the B2B notary layer): anchor an exact
      // 32-byte hash (64 hex) on-chain, no Merkle batching.
      if (req.method === 'POST' && path === '/api/anchor/hash') {
        const raw = await readBody(req)
        let parsed: any
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'invalid JSON' }) }
        const hex = typeof parsed?.hash === 'string' ? parsed.hash.toLowerCase() : ''
        if (!/^[0-9a-f]{64}$/.test(hex)) return json(res, 400, { error: 'hash must be 32 bytes (64 hex)' })
        try {
          const sub = await deps.chain.anchor(hex)
          return json(res, 200, { hash: hex, txid: sub.txid, anchored: true })
        } catch (e) {
          return json(res, 503, { error: `anchor not submitted — ${(e as Error).message}`, anchored: false })
        }
      }

      if (req.method === 'GET' && path.startsWith('/api/anchor/root/')) {
        const rootParam = decodeURIComponent(path.slice('/api/anchor/root/'.length))
        let key: string
        try { key = onchainRoot32(rootParam) } catch { return json(res, 400, { error: 'invalid root' }) }
        const height = await deps.chain.anchoredHeight(key)
        return json(res, 200, { onchainKey: key, height, anchored: height > 0 })
      }

      if (req.method === 'GET' && path.startsWith('/api/anchor/tx/')) {
        const txid = decodeURIComponent(path.slice('/api/anchor/tx/'.length))
        if (!/^[0-9a-fA-F]{64}$/.test(txid)) return json(res, 400, { error: 'invalid txid' })
        const conf = await deps.chain.txConfirmations(txid)
        return json(res, 200, conf)
      }

      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, 500, { error: (e as Error).message })
    }
  }
}

export function startServer(port: number, cfg: ChainConfig): ReturnType<typeof createServer> {
  const chain = new AnchorChain(cfg)
  const handler = makeHandler({ chain })
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(port, '127.0.0.1')
  return server
}
