/**
 * Blockle Intelligence security-assistant HTTP API.
 *
 *   POST /api/assistant/ask
 *     { question: string,
 *       signals: PostureSignals,          // raw device-scan signals
 *       untrusted?: {label,text}[] }      // file names / scan output (attacker-influenceable)
 *   -> { answer, suggestions:[{findingId,title,fix}], injectionSuspected, score, grade }
 *
 *   GET /api/assistant/health -> { ok, model }
 *
 * The Checkup is RECOMPUTED here from `signals` with the deterministic core, so
 * the posture the model sees and the gated fixes any suggestion maps to are
 * server-authoritative — a client cannot forge findings, and the model cannot
 * invent an action. Input is strictly bounded; the LLM runs loopback-only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { runCheckup, type PostureSignals } from '../../core/src/index.js'
import { ask, ollamaClient, type LlmClient } from './assistant.js'
import { MAX_QUESTION, MAX_UNTRUSTED } from './harden.js'

const MAX_BODY = 256 * 1024
const MAX_UNTRUSTED_ITEMS = 16

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

/** Validate + clamp the untrusted array (strings only, bounded count + length). */
function sanitizeUntrusted(v: unknown): { label: string; text: string }[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, MAX_UNTRUSTED_ITEMS)
    .filter((x): x is { label: unknown; text: unknown } => !!x && typeof x === 'object')
    .map(x => ({
      label: String((x as any).label ?? '').slice(0, 120),
      text: String((x as any).text ?? '').slice(0, MAX_UNTRUSTED),
    }))
}

export interface ServerDeps { llm: LlmClient; model: string }

export function makeHandler(deps: ServerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/api/assistant/health') {
        return json(res, 200, { ok: true, model: deps.model })
      }
      if (req.method === 'POST' && url.pathname === '/api/assistant/ask') {
        const raw = await readBody(req)
        let parsed: any
        try { parsed = JSON.parse(raw) } catch { return json(res, 400, { error: 'invalid JSON' }) }
        const question = typeof parsed?.question === 'string' ? parsed.question.slice(0, MAX_QUESTION) : ''
        if (!question.trim()) return json(res, 400, { error: 'question is required' })
        const signals: PostureSignals = (parsed?.signals && typeof parsed.signals === 'object') ? parsed.signals : {}
        const untrusted = sanitizeUntrusted(parsed?.untrusted)

        // Recompute the posture deterministically — do NOT trust a client checkup.
        const checkup = runCheckup(signals)
        const result = await ask({ question, checkup, untrusted }, deps.llm)
        return json(res, 200, {
          answer: result.answer,
          suggestions: result.suggestions,
          injectionSuspected: result.injectionSuspected,
          score: checkup.score,
          grade: checkup.grade,
        })
      }
      json(res, 404, { error: 'not found' })
    } catch (e) {
      json(res, (e as Error).message === 'body too large' ? 413 : 500, { error: (e as Error).message })
    }
  }
}

export function startServer(port: number, cfg: { baseUrl: string; model: string }) {
  const llm = ollamaClient({ baseUrl: cfg.baseUrl, model: cfg.model })
  const handler = makeHandler({ llm, model: cfg.model })
  const server = createServer((req, res) => { void handler(req, res) })
  server.listen(port, '127.0.0.1')
  return server
}
