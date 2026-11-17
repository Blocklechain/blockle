/**
 * Blockle Intelligence security-assistant entrypoint.
 *
 * Env:
 *   ASSISTANT_PORT       listen port (default 8948, bound to 127.0.0.1)
 *   ASSISTANT_LLM_URL    OpenAI-compatible base (default http://127.0.0.1:11434/v1 — local Ollama)
 *   ASSISTANT_MODEL      allowlisted local model id (default "blockle-agent")
 */
import { startServer } from './server.js'

const port = Number(process.env.ASSISTANT_PORT ?? 8948)
const baseUrl = process.env.ASSISTANT_LLM_URL ?? 'http://127.0.0.1:11434/v1'
const model = process.env.ASSISTANT_MODEL ?? 'blockle-agent'
startServer(port, { baseUrl, model })
console.error(`[assistant] Blockle Intelligence security assistant on 127.0.0.1:${port} -> ${baseUrl} (${model})`)
