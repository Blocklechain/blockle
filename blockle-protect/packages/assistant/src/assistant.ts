/**
 * The Blockle Intelligence security assistant orchestrator. It runs the hardened
 * message build → LLM call → safe parse pipeline from harden.ts. The LLM client
 * is injected so the whole flow is testable without a network / model.
 *
 * By default it talks to the self-hosted Blockle LLM (`blockle-agent`, a
 * Qwen2.5-3B Ollama model) via its OpenAI-compatible endpoint on the box —
 * keyless, loopback-only. No cloud, no API key, nothing leaves the box.
 */
import {
  buildMessages, parseResponse, detectInjection,
  type AssistantInput, type AssistantResult, type ChatMessage,
} from './harden.js'

export interface LlmClient {
  /** Return the model's raw text for a hardened message array. */
  chat(messages: ChatMessage[], signal?: AbortSignal): Promise<string>
}

export interface OllamaConfig {
  /** OpenAI-compatible base, e.g. http://127.0.0.1:11434/v1 */
  baseUrl: string
  /** Allowlisted local model id, e.g. "blockle-agent". */
  model: string
  /** Per-request timeout (ms). */
  timeoutMs?: number
}

/** LLM client for the local Ollama (`blockle-agent`) OpenAI endpoint. */
export function ollamaClient(cfg: OllamaConfig): LlmClient {
  return {
    async chat(messages, signal) {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 55000)
      // chain an external abort signal if provided
      if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true })
      try {
        const r = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: cfg.model,
            messages,
            stream: false,
            temperature: 0.2,
            // Keep the model terse + deterministic-ish for a security advisor.
            max_tokens: 400,
          }),
          signal: ctl.signal,
        })
        if (!r.ok) throw new Error(`llm upstream ${r.status}`)
        const b = await r.json() as any
        return b?.choices?.[0]?.message?.content ?? ''
      } finally {
        clearTimeout(t)
      }
    },
  }
}

/**
 * Run the assistant end-to-end. `input.checkup` MUST be the server-recomputed
 * deterministic Checkup (never a client-supplied one), so the posture the model
 * sees — and the fixes any suggestion maps to — are authoritative.
 */
export async function ask(input: AssistantInput, llm: LlmClient, signal?: AbortSignal): Promise<AssistantResult> {
  const messages = buildMessages(input)
  let raw: string
  try {
    raw = await llm.chat(messages, signal)
  } catch (e) {
    // Fail safe + honest: never fabricate advice. Point the user at their scan.
    return {
      answer: "I couldn't reach the security model just now. Your device scan results above are still accurate — address the highest-severity items first.",
      suggestions: [],
      injectionSuspected: detectInjection(input.untrusted),
    }
  }
  const result = parseResponse(raw, input.checkup)
  result.injectionSuspected = detectInjection(input.untrusted)
  return result
}
