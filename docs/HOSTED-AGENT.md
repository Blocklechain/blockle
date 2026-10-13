# Blockle Hosted Agent — keyless in-wallet trading bot

Lets the in-wallet agent/bots run with **no user LLM key**: the wallet connects to a
Blockle-hosted session on our server, and *we* hold the upstream LLM key server-side. One
server service (`services/agent-gateway`) + a new `hosted` provider in each wallet
(`blockle-extension/agent`, `blockle-app/lib/agent`, `python/blockle/agent`), behaving
identically. Shared contract: `docs/hosted-agent-vectors.json`.

## The one invariant that makes this safe

The hosted LLM is the **brain, not the hands.** It only returns `{text?, toolCalls?}`
proposals. **Every fund-moving action is still enforced entirely CLIENT-SIDE** by the
existing policy gate (per-session + per-asset caps, default-on confirm, allowlist, kill
switch, hash-chained audit, the 0.05% fee, mainnet gate) and the security pre-sign gate. A
malicious, buggy, or compromised gateway/LLM **cannot move a single unit** — the worst it can
do is propose a tool-call that the client gate rejects or the user declines. The gateway holds
**no wallet keys** and the wallet sends it **no private keys/seeds** — only the agent
conversation (system/messages/tool schemas). This property is tested adversarially.

## 1. Gateway service (`services/agent-gateway`, mirrors `reserve-signer`)

Node, loopback + nginx TLS, systemd unit. Upstream LLM key from the environment only
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), **never** sent to a client, **never** logged.
Default upstream = latest Claude.

Endpoints:
- `GET /healthz` → `{ ok, upstream, mainnetN/A, budgetRemaining }` (no secrets).
- `POST /agent/session` → issue a session token. Two auth modes (config-toggleable):
  - **wallet-signature (default):** client requests a `challenge`; signs it with its wallet
    address key (any supported chain — reuses the wallet signer, proves control of an
    address, NOT a spend); server verifies and returns `{ sessionToken, expiresAt, quota }`
    bound to that address with a per-address daily quota. Non-custodial identity; no accounts.
  - **anonymous fallback:** a rate-limited free-tier token (tighter quota; salted-IP limited).
- `POST /agent/turn` → body `{ sessionToken, system, messages, tools, model? }`; returns the
  SAME shape as `provider.turn`: `{ text?, toolCalls? }`. The server injects the upstream key,
  calls the upstream (normalizing Claude/OpenAI tool-call formats), and maps the result back.
  `model` is chosen from a server **allowlist** (client cannot request an arbitrary/expensive
  model or passthrough raw params).

Abuse + cost control (all enforced server-side, fail-safe):
- per-session requests/min + token budget; per-address daily token cap; a **global daily
  budget** with a kill switch → `503 {error:"hosted agent temporarily unavailable"}` when
  exceeded (never silently bills beyond the cap). Input size cap; max tools count; max
  messages/history length. A `mainnetEnabled`-style `enabled` flag (default on for the gateway,
  but the per-call budget gate is always active).
- append-only audit of metadata only: `{ ts, sessionId(salted), addrHash, model, inTokens,
  outTokens, toolCallCount, blockedReason? }`. **No prompt bodies, no key material, no raw
  wallet data** persisted by default (`logPrompts:false`).

## 1a. Backend: a SMALL LOCAL model on the box (default, keyless) — cloud optional

The gateway's upstream is a **configurable OpenAI-compatible base URL + OPTIONAL key**, so the
default backend is a small open instruct model served **locally on the VPS** (Ollama or
llama.cpp `server`, both expose `/v1/chat/completions` with tool-calls) at
`http://127.0.0.1:<port>` with **no API key at all** — truly keyless and self-contained; no
data leaves the box to a third party. A cloud upstream (Anthropic/OpenAI) stays supported as an
optional, operator-configured fallback for higher quality, but is NOT required.

- Gateway config: `backendBaseUrl` (default the local server), `backendKey` (optional/empty for
  local), `model` (allowlisted). Key is only read when non-empty; local = none.
- Model choice is sized to the box (see ops doc `services/agent-gateway/LOCAL-MODEL.md`): a
  CPU-friendly quantized instruct model with decent tool/JSON-following — e.g. Qwen2.5-3B/7B-
  Instruct or Llama-3.2-3B-Instruct in Q4_K_M via Ollama. Picked from the box's free RAM/CPU.
- Reliability vs. safety: a small model is weaker, but it only PROPOSES tool-calls — the
  client-side policy + security gates enforce every fund move, so a weak/odd proposal is
  harmless (rejected by caps/confirm/kill/allowlist or declined by the user). The gateway may
  additionally constrain output to the tool-call JSON shape and retry/validate for reliability.

In **hosted** mode the agent conversation — which can include balances/positions the agent is
shown — transits Blockle's server and the upstream LLM provider. **BYO-key** mode keeps it
between the user and their own provider. The connect UI states this plainly; hosted is opt-in.
The gateway does not store prompt bodies by default. No private keys/seeds are ever sent
(the client never puts them in the conversation).

## 3. Wallet `hosted` provider + connect (all 3 wallets)

- New provider type `hosted` in the providers layer: `turn({system,messages,tools})` POSTs to
  `${gatewayUrl}/agent/turn` with the `sessionToken` (NOT an apiKey) and returns the normalized
  `{text?,toolCalls?}`. Same interface the runner already uses — the runner/gate are unchanged.
- Connection record gains `provider:'hosted'` with `{ gatewayUrl, sessionToken, expiresAt,
  label }` instead of an `apiKey`; stored sealed in the vault like other connections. The
  `sessionToken` is short-lived and transparently refreshed (re-sign the challenge) on expiry.
- Connect flow: **"Use Blockle's hosted agent — no API key needed"** → the wallet signs the
  gateway challenge with its address key → stores the hosted connection → persists until the
  user disconnects. A one-line privacy notice is shown. Works across channels + all 3 wallets,
  alongside (not replacing) BYO-key providers.
- Default `gatewayUrl` ships in config (e.g. `https://agent.blockle.org`), operator-overridable.

## 4. Parity + tests

`docs/hosted-agent-vectors.json`: the session-challenge/verify handshake, the `/agent/turn`
request+response normalization (Claude + OpenAI upstream shapes → the common
`{text?,toolCalls?}`), model-allowlist enforcement, and the budget/rate 503.

Required tests:
- **Gateway:** upstream key never appears in any response or log; session issuance verifies the
  wallet signature (a bad signature is rejected); per-session + global budget caps return 503
  and never call the upstream beyond the cap; model allowlist enforced; audit has no prompt
  bodies/keys. BYO path untouched.
- **Each wallet:** the `hosted` provider yields a working `turn()` with only a session token
  (no apiKey); the connection persists + refreshes on expiry; and the **safety invariant** —
  a hosted provider returning a malicious `toolCall` (e.g. a huge send) is still blocked by the
  client gate (cap/confirm/kill/allowlist) exactly like a BYO provider, and the security
  pre-sign still forces a danger confirm. The gateway/LLM can never move funds.

All new money/compute defaults are safe/capped; keys stay server-side; the client-side gate is
never weakened. Keep all existing tests green.
