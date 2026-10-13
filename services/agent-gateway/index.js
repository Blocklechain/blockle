// Blockle hosted agent GATEWAY — the BRAIN, never the HANDS.
//
// Lets the in-wallet agent/bots run with NO user LLM key: the wallet opens a
// session here (proving control of an address by signing a server nonce), then
// POSTs its agent conversation to /agent/turn. We inject the UPSTREAM LLM key
// server-side, call the upstream (Claude/Anthropic default, OpenAI shape too),
// normalize the tool-call format, and return ONLY `{ text?, toolCalls? }`.
//
// THE INVARIANT this service is built around:
//   The hosted LLM proposes; it NEVER acts. /agent/turn returns proposals only.
//   Every fund-moving action stays enforced CLIENT-SIDE by the wallet's policy
//   gate (caps/confirm/kill/allowlist/audit/fee/mainnet) + the security pre-sign
//   gate. This gateway holds NO wallet keys; the wallet sends NO private
//   keys/seeds — only system/messages/tool schemas. A malicious/buggy/compromised
//   gateway or upstream LLM CANNOT move a single unit: worst case it proposes a
//   toolCall the client gate rejects or the user declines.
//
// The UPSTREAM key comes from the ENVIRONMENT only (ANTHROPIC_API_KEY /
// OPENAI_API_KEY). It is NEVER returned in a response and NEVER logged. We bind
// 127.0.0.1 ONLY (nginx terminates TLS in front), enforce per-session rate +
// token budget, a per-address daily token cap, a GLOBAL daily budget + kill
// switch (503 when exceeded — we never call upstream past the cap), a model
// allowlist, and input/history/tools size caps. The audit records METADATA ONLY
// (no prompt bodies, no key material; logPrompts:false).
//
// Mirrors services/reserve-signer (loadConfig + createServer + pure helpers +
// node --test), but this process is non-custodial of BOTH wallet keys and (in a
// response) the upstream key.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- config (env overrides file overrides defaults) ------------------------
function loadConfig() {
  const cfgPath = process.env.AGENT_GATEWAY_CONFIG || path.join(__dirname, "config.json");
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    /* defaults */
  }
  const envBool = (k, d) => {
    const v = process.env[k];
    if (v == null || v === "") return d;
    return v === "1" || v.toLowerCase() === "true";
  };
  const envNum = (k, d) => {
    const v = process.env[k];
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const envStr = (k, d) => process.env[k] || d;

  // DEFAULT = 'local': a small self-hosted model (Ollama/llama.cpp, OpenAI-compatible)
  // on this box — fully KEYLESS, no cloud key from anyone (docs/HOSTED-AGENT.md §1a).
  // 'anthropic'/'openai' stay available as optional cloud backends.
  const upstream = (envStr("AGENT_UPSTREAM", file.upstream) || "local").toLowerCase();
  return {
    host: "127.0.0.1", // LOOPBACK ONLY — never 0.0.0.0; nginx proxies TLS in front
    port: envNum("AGENT_GATEWAY_PORT", file.port || 8796),
    enabled: envBool("AGENT_GATEWAY_ENABLED", file.enabled ?? true),

    // ---- upstream LLM -------------------------------------------------------
    upstream, // 'local' (default, keyless) | 'anthropic' | 'openai'
    // Local keyless backend: an OpenAI-compatible server on the box (Ollama/llama.cpp).
    // No API key is used for this backend.
    localBaseUrl: envStr("AGENT_LOCAL_BASE_URL", file.localBaseUrl) || "http://127.0.0.1:11434/v1",
    localModel: envStr("AGENT_LOCAL_MODEL", file.localModel) || "blockle-agent",
    anthropicBaseUrl: envStr("AGENT_ANTHROPIC_BASE_URL", file.anthropicBaseUrl) || "https://api.anthropic.com",
    openaiBaseUrl: envStr("AGENT_OPENAI_BASE_URL", file.openaiBaseUrl) || "https://api.openai.com",
    anthropicVersion: envStr("AGENT_ANTHROPIC_VERSION", file.anthropicVersion) || "2023-06-01",
    // The upstream key — ENV ONLY (never read from the config file, never logged,
    // never returned). Default upstream = latest Claude.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",

    // Model allowlist — the client cannot request an arbitrary/expensive model.
    // The first entry is the default when the client omits `model`.
    modelAllowlist:
      (file.modelAllowlist && file.modelAllowlist.length
        ? file.modelAllowlist
        : upstream === "openai"
        ? ["gpt-4.1", "gpt-4.1-mini"]
        : upstream === "local"
        ? ["blockle-agent"]
        : ["claude-opus-4-1", "claude-sonnet-4-5", "claude-3-5-haiku-latest"]),
    maxTokens: envNum("AGENT_MAX_TOKENS", file.maxTokens || 4096),

    // ---- session issuance ---------------------------------------------------
    sessionTtlSec: envNum("AGENT_SESSION_TTL_SEC", file.sessionTtlSec || 900), // 15 min, short-lived → refresh
    nonceTtlSec: envNum("AGENT_NONCE_TTL_SEC", file.nonceTtlSec || 300),
    allowAnon: envBool("AGENT_ALLOW_ANON", file.allowAnon ?? true), // rate-limited free tier
    anonDailyTokenCap: envNum("AGENT_ANON_DAILY_TOKENS", file.anonDailyTokenCap || 20000),

    // ---- abuse + cost control (all server-side, fail-safe) ------------------
    reqPerMin: envNum("AGENT_REQ_PER_MIN", file.reqPerMin || 20),
    perSessionTokenBudget: envNum("AGENT_SESSION_TOKEN_BUDGET", file.perSessionTokenBudget || 200000),
    perAddressDailyTokens: envNum("AGENT_ADDR_DAILY_TOKENS", file.perAddressDailyTokens || 500000),
    globalDailyTokenBudget: envNum("AGENT_GLOBAL_DAILY_TOKENS", file.globalDailyTokenBudget || 10000000),
    maxInputBytes: envNum("AGENT_MAX_INPUT_BYTES", file.maxInputBytes || 262144), // 256 KiB
    maxMessages: envNum("AGENT_MAX_MESSAGES", file.maxMessages || 200),
    maxTools: envNum("AGENT_MAX_TOOLS", file.maxTools || 100),

    // ---- audit (METADATA ONLY) ----------------------------------------------
    logPrompts: false, // HARD DEFAULT — never persist prompt bodies / key material
    auditLog: envStr("AGENT_AUDIT_LOG", file.auditLog) || "/var/lib/blockle-agent-gateway/audit.jsonl",
    auditSalt: process.env.AGENT_AUDIT_SALT || file.auditSalt || crypto.randomBytes(16).toString("hex"),
  };
}

// ---- tiny helpers ----------------------------------------------------------
function sha256hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
function stripHex(s) {
  s = String(s || "");
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}
function dayKey(ts) {
  const d = new Date((ts || Date.now()));
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// ---- signature verification (identity, NOT a spend) ------------------------
// Proves control of `address` by signing a server nonce. In PRODUCTION this is
// wired to the project's multi-chain verifier (the SAME primitive the exchange
// uses in exchange/server/src/sigverify.ts: EVM EIP-191, Solana ed25519, BLOCK
// ML-DSA via blockle-wasm) by passing `verify` into createServer, or setting
// cfg.verifierModule to a module that exports verifySignature(). The built-in
// below is a real, dependency-free Ed25519 verifier (Node's native crypto) used
// by the anonymous/reference path and the tests: `publicKey` is a raw 32-byte
// Ed25519 key (hex) and the address is its sha256 (hex), so the signature proves
// control of that derived address. It NEVER has access to any wallet key.
function ed25519PubFromRawHex(hex) {
  const raw = Buffer.from(stripHex(hex), "hex");
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  // SPKI DER prefix for Ed25519 + the 32-byte raw key.
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}
function defaultVerify({ chain, message, signature, address, publicKey }) {
  try {
    const c = String(chain || "ed25519").toLowerCase();
    if (c === "ed25519" || c === "reference") {
      if (!publicKey) return false;
      // address MUST be derived from the presented public key (no impersonation).
      const derived = sha256hex(Buffer.from(stripHex(publicKey), "hex"));
      if (derived !== String(address).toLowerCase()) return false;
      const key = ed25519PubFromRawHex(publicKey);
      return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(stripHex(signature), "hex"));
    }
    // Any other chain requires the project verifier to be injected.
    return false;
  } catch {
    return false;
  }
}
// Address derived from an Ed25519 public key under the reference scheme — the
// value a client binds its session to. Exported so tests/clients agree on it.
function referenceAddress(publicKeyHex) {
  return sha256hex(Buffer.from(stripHex(publicKeyHex), "hex"));
}

// ---- upstream request/response NORMALIZATION -------------------------------
// The client speaks ONE internal shape (same as providers.js):
//   messages: [{role:'user',text} | {role:'assistant',text?,toolCalls?} |
//              {role:'tool',results:[{id,name,content,isError}]}]
//   tools:    [{ name, description, parameters }]
//   result:   { text?, toolCalls:[{id,name,arguments}] }
// We convert to/from each upstream wire format here, injecting the key only into
// the OUTBOUND request headers (never into the returned object).

function toAnthropicBody(cfg, { system, messages, tools, model, maxTokens }) {
  const content = [];
  const out = [];
  for (const m of messages || []) {
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.text || "" }] });
    } else if (m.role === "assistant") {
      const c = [];
      if (m.text) c.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls || []) c.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments || {} });
      out.push({ role: "assistant", content: c });
    } else if (m.role === "tool") {
      const c = (m.results || []).map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
        is_error: !!r.isError,
      }));
      out.push({ role: "user", content: c });
    }
  }
  const body = { model, max_tokens: maxTokens || cfg.maxTokens, messages: out };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters || { type: "object", properties: {} },
    }));
  }
  void content;
  return body;
}
function fromAnthropic(j) {
  let text = "";
  const toolCalls = [];
  for (const b of (j && j.content) || []) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, arguments: b.input || {} });
  }
  const usage = j && j.usage ? j.usage : {};
  return {
    result: { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined },
    inTokens: Number(usage.input_tokens || 0),
    outTokens: Number(usage.output_tokens || 0),
  };
}

function toOpenAIBody(cfg, { system, messages, tools, model, maxTokens }) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages || []) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text || "" });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.text || null };
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool") {
      for (const r of m.results || []) {
        out.push({ role: "tool", tool_call_id: r.id, content: typeof r.content === "string" ? r.content : JSON.stringify(r.content) });
      }
    }
  }
  const body = { model, max_tokens: maxTokens || cfg.maxTokens, messages: out };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters || { type: "object", properties: {} } },
    }));
  }
  return body;
}
function fromOpenAI(j) {
  const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
  const toolCalls = [];
  for (const tc of msg.tool_calls || []) {
    let args = {};
    try {
      args = JSON.parse((tc.function && tc.function.arguments) || "{}");
    } catch {
      args = { _raw: tc.function && tc.function.arguments };
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
  }
  const usage = (j && j.usage) || {};
  return {
    result: { text: msg.content || undefined, toolCalls: toolCalls.length ? toolCalls : undefined },
    inTokens: Number(usage.prompt_tokens || 0),
    outTokens: Number(usage.completion_tokens || 0),
  };
}

// ---- the gateway engine ----------------------------------------------------
// All budget state is in-memory (a single process behind nginx). The audit log
// on disk is metadata-only and append-only.
class Gateway {
  constructor(cfg, deps) {
    deps = deps || {};
    this.cfg = cfg;
    this.fetch = deps.fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    this.verify = deps.verify || defaultVerify;
    this.now = deps.now || (() => Date.now());

    this.nonces = new Map(); // nonce -> { addrHash, chain, address, publicKey, expires }
    this.sessions = new Map(); // token -> { addrHash, chain, anon, createdAt, expiresAt, reqTimes:[], tokensUsed }
    this.addrDaily = new Map(); // addrHash -> { day, tokens }
    this.global = { day: dayKey(this.now()), tokens: 0 };
  }

  // ---- audit (metadata only; NEVER prompt bodies or key material) ----------
  audit(entry) {
    try {
      fs.mkdirSync(path.dirname(this.cfg.auditLog), { recursive: true });
      // Hard whitelist of fields — defense against ever logging a prompt/key.
      const safe = {
        t: Math.floor(this.now() / 1000),
        kind: entry.kind,
        sessionId: entry.sessionId,
        addrHash: entry.addrHash,
        model: entry.model,
        inTokens: entry.inTokens,
        outTokens: entry.outTokens,
        toolCallCount: entry.toolCallCount,
        blockedReason: entry.blockedReason,
      };
      for (const k of Object.keys(safe)) if (safe[k] === undefined) delete safe[k];
      fs.appendFileSync(this.cfg.auditLog, JSON.stringify(safe) + "\n");
    } catch {
      /* never block a turn on audit IO */
    }
  }

  upstreamKeyPresent() {
    // The local self-hosted backend needs NO key (it's an on-box OpenAI-compatible
    // server), so it is always "present". Cloud backends require their env key.
    if (this.cfg.upstream === "local") return true;
    return this.cfg.upstream === "openai" ? !!this.cfg.openaiApiKey : !!this.cfg.anthropicApiKey;
  }

  budgetRemaining() {
    this._rollGlobal();
    return Math.max(0, this.cfg.globalDailyTokenBudget - this.global.tokens);
  }

  _rollGlobal() {
    const d = dayKey(this.now());
    if (this.global.day !== d) this.global = { day: d, tokens: 0 };
  }

  // ---- session issuance ----------------------------------------------------
  issueChallenge({ address, chain }) {
    const nonce = "blockle-agent login: " + crypto.randomBytes(24).toString("hex");
    const expires = Math.floor(this.now() / 1000) + this.cfg.nonceTtlSec;
    this.nonces.set(nonce, { address: address || null, chain: chain || "ed25519", expires });
    return { challenge: nonce, expiresAt: expires };
  }

  verifyChallenge({ address, chain, challenge, signature, publicKey }) {
    const now = Math.floor(this.now() / 1000);
    const row = this.nonces.get(challenge);
    if (!row) throw new HttpError(400, "no matching challenge — request one via step:'challenge' first");
    if (row.expires < now) {
      this.nonces.delete(challenge);
      throw new HttpError(400, "challenge expired");
    }
    const ok = this.verify({ chain: chain || row.chain, message: challenge, signature, address, publicKey });
    if (!ok) {
      this.nonces.delete(challenge); // single-use even on failure
      throw new HttpError(401, "signature verification failed");
    }
    this.nonces.delete(challenge); // single-use
    return this._openSession({ address, chain: chain || row.chain, anon: false });
  }

  issueAnon() {
    if (!this.cfg.allowAnon) throw new HttpError(403, "anonymous sessions are disabled");
    // A salted-random anon identity; tighter per-address daily cap applies.
    const anonAddr = "anon:" + crypto.randomBytes(12).toString("hex");
    return this._openSession({ address: anonAddr, chain: "anon", anon: true });
  }

  _openSession({ address, chain, anon }) {
    const token = crypto.randomBytes(32).toString("hex");
    const addrHash = sha256hex(this.cfg.auditSalt + "|" + chain + "|" + address);
    const createdAt = this.now();
    const expiresAt = createdAt + this.cfg.sessionTtlSec * 1000;
    this.sessions.set(token, { addrHash, chain, anon, createdAt, expiresAt, reqTimes: [], tokensUsed: 0 });
    const dailyCap = anon ? this.cfg.anonDailyTokenCap : this.cfg.perAddressDailyTokens;
    return {
      sessionToken: token,
      expiresAt,
      quota: {
        reqPerMin: this.cfg.reqPerMin,
        perSessionTokenBudget: this.cfg.perSessionTokenBudget,
        dailyTokenCap: dailyCap,
      },
    };
  }

  session(token) {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  // ---- the one proposal path: /agent/turn ----------------------------------
  // Returns { status, body }. NEVER includes the upstream key. The upstream is
  // called at most once, and ONLY after every budget/cap check passes.
  async turn(body) {
    const cfg = this.cfg;
    if (!cfg.enabled) return this._blocked(null, 503, "hosted agent disabled");

    const sess = this.session(body && body.sessionToken);
    if (!sess) return { status: 401, body: { error: "invalid or expired session" } };
    const sessionId = sha256hex(cfg.auditSalt + "|sid|" + body.sessionToken);

    // --- rate limit (per-session req/min) ---
    const nowMs = this.now();
    sess.reqTimes = sess.reqTimes.filter((t) => nowMs - t < 60000);
    if (sess.reqTimes.length >= cfg.reqPerMin) {
      this.audit({ kind: "turn.blocked", sessionId, addrHash: sess.addrHash, blockedReason: "rate" });
      return { status: 429, body: { error: "rate limit: too many requests per minute" } };
    }

    // --- size caps (fail BEFORE any upstream work) ---
    const messages = (body && body.messages) || [];
    const tools = (body && body.tools) || [];
    if (!Array.isArray(messages) || messages.length > cfg.maxMessages) {
      return this._blocked(sessionId, 400, "history too long", sess);
    }
    if (!Array.isArray(tools) || tools.length > cfg.maxTools) {
      return this._blocked(sessionId, 400, "too many tools", sess);
    }

    // --- model allowlist (client cannot request an arbitrary/expensive model) ---
    const requested = (body && body.model) || null;
    const model = requested || cfg.modelAllowlist[0];
    if (!cfg.modelAllowlist.includes(model)) {
      return this._blocked(sessionId, 400, "model not allowed", sess);
    }

    // --- GLOBAL kill + per-address + per-session budget (503, no upstream) ---
    this._rollGlobal();
    if (this.global.tokens >= cfg.globalDailyTokenBudget) {
      this.audit({ kind: "turn.blocked", sessionId, addrHash: sess.addrHash, model, blockedReason: "global-budget" });
      return { status: 503, body: { error: "hosted agent temporarily unavailable" } };
    }
    const dayNow = dayKey(nowMs);
    let ad = this.addrDaily.get(sess.addrHash);
    if (!ad || ad.day !== dayNow) {
      ad = { day: dayNow, tokens: 0 };
      this.addrDaily.set(sess.addrHash, ad);
    }
    const addrCap = sess.anon ? cfg.anonDailyTokenCap : cfg.perAddressDailyTokens;
    if (ad.tokens >= addrCap) {
      return this._blocked(sessionId, 429, "per-address daily token cap reached", sess, model);
    }
    if (sess.tokensUsed >= cfg.perSessionTokenBudget) {
      return this._blocked(sessionId, 429, "per-session token budget reached", sess, model);
    }

    // --- upstream key must be present (ENV only) ---
    if (!this.upstreamKeyPresent()) {
      this.audit({ kind: "turn.blocked", sessionId, addrHash: sess.addrHash, model, blockedReason: "no-upstream-key" });
      return { status: 503, body: { error: "hosted agent temporarily unavailable" } };
    }

    // record the request slot only once we are actually going upstream
    sess.reqTimes.push(nowMs);

    // --- call upstream (the ONLY place the key is used; outbound header only) ---
    let norm;
    try {
      norm = await this._callUpstream({ system: body.system, messages, tools, model });
    } catch (e) {
      this.audit({ kind: "turn.error", sessionId, addrHash: sess.addrHash, model, blockedReason: "upstream" });
      // Never surface upstream error bodies verbatim (could echo the key in a
      // misconfigured proxy). A generic message only.
      return { status: 502, body: { error: "upstream error" } };
    }

    // --- account tokens AFTER the call ---
    const used = (norm.inTokens || 0) + (norm.outTokens || 0);
    sess.tokensUsed += used;
    ad.tokens += used;
    this.global.tokens += used;

    const toolCallCount = (norm.result.toolCalls && norm.result.toolCalls.length) || 0;
    this.audit({
      kind: "turn.ok",
      sessionId,
      addrHash: sess.addrHash,
      model,
      inTokens: norm.inTokens,
      outTokens: norm.outTokens,
      toolCallCount,
    });

    // RESPONSE IS PROPOSALS ONLY — { text?, toolCalls? }. No key, no usage echo
    // of anything sensitive, no passthrough of raw upstream fields.
    return { status: 200, body: norm.result };
  }

  _blocked(sessionId, status, reason, sess, model) {
    if (sessionId) this.audit({ kind: "turn.blocked", sessionId, addrHash: sess && sess.addrHash, model, blockedReason: reason });
    return { status, body: { error: reason } };
  }

  async _callUpstream({ system, messages, tools, model }) {
    const cfg = this.cfg;
    if (!this.fetch) throw new Error("no fetch available");
    if (cfg.upstream === "local") {
      // KEYLESS: on-box OpenAI-compatible server (Ollama/llama.cpp). NO auth header.
      const reqBody = toOpenAIBody(cfg, { system, messages, tools, model: cfg.localModel });
      const r = await this.fetch(cfg.localBaseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      if (!r.ok) throw new Error("local " + r.status);
      return fromOpenAI(await r.json());
    }
    if (cfg.upstream === "openai") {
      const reqBody = toOpenAIBody(cfg, { system, messages, tools, model });
      const r = await this.fetch(cfg.openaiBaseUrl.replace(/\/$/, "") + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + cfg.openaiApiKey },
        body: JSON.stringify(reqBody),
      });
      if (!r.ok) throw new Error("openai " + r.status);
      return fromOpenAI(await r.json());
    }
    // default: Anthropic / Claude
    const reqBody = toAnthropicBody(cfg, { system, messages, tools, model });
    const r = await this.fetch(cfg.anthropicBaseUrl.replace(/\/$/, "") + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.anthropicApiKey,
        "anthropic-version": cfg.anthropicVersion,
      },
      body: JSON.stringify(reqBody),
    });
    if (!r.ok) throw new Error("anthropic " + r.status);
    return fromAnthropic(await r.json());
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- HTTP (loopback only) --------------------------------------------------
function createServer(cfg, deps) {
  const gw = (deps && deps.gateway) || new Gateway(cfg, deps);
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      const bodyStr = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) });
      res.end(bodyStr);
    };

    if (req.method === "GET" && req.url.startsWith("/healthz")) {
      // NO SECRETS: report only reachability + remaining budget. upstreamKeyPresent
      // is a boolean, never the key itself.
      return send(200, {
        ok: true,
        upstream: cfg.upstream,
        keyConfigured: gw.upstreamKeyPresent(),
        enabled: cfg.enabled,
        budgetRemaining: gw.budgetRemaining(),
      });
    }

    if (req.method === "POST" && (req.url.startsWith("/agent/session") || req.url.startsWith("/agent/turn"))) {
      let raw = "";
      let tooBig = false;
      req.on("data", (c) => {
        raw += c;
        if (raw.length > cfg.maxInputBytes) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (tooBig) return send(413, { error: "request too large" });
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          return send(400, { error: "invalid JSON" });
        }
        try {
          if (req.url.startsWith("/agent/session")) {
            const step = body.step || (body.signature ? "verify" : "challenge");
            if (step === "challenge") {
              return send(200, gw.issueChallenge({ address: body.address, chain: body.chain }));
            }
            if (step === "anon") {
              return send(200, gw.issueAnon());
            }
            if (step === "verify") {
              return send(200, gw.verifyChallenge(body));
            }
            return send(400, { error: "unknown session step" });
          }
          // /agent/turn
          const out = await gw.turn(body);
          return send(out.status, out.body);
        } catch (e) {
          if (e instanceof HttpError) return send(e.status, { error: e.message });
          return send(500, { error: "internal error" });
        }
      });
      return;
    }

    send(404, { error: "not found" });
  });
  server._gateway = gw;
  return server;
}

module.exports = {
  loadConfig,
  createServer,
  Gateway,
  HttpError,
  defaultVerify,
  referenceAddress,
  toAnthropicBody,
  fromAnthropic,
  toOpenAIBody,
  fromOpenAI,
  sha256hex,
};

if (require.main === module) {
  const cfg = loadConfig();
  const server = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[agent-gateway] ${cfg.host}:${cfg.port} upstream=${cfg.upstream} ` +
        `key=${server._gateway.upstreamKeyPresent() ? "set" : "MISSING"} ` +
        `models=[${cfg.modelAllowlist.join(",")}] globalDailyTokens=${cfg.globalDailyTokenBudget}`,
    );
  });
}
