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
// ---- vendored, dependency-light multi-chain crypto -------------------------
// This service deploys as JUST services/agent-gateway/ (no access to the repo's
// blockle-extension/), so the real signature primitives are vendored here —
// ported verbatim from blockle-extension/crypto-core.js (keccak256 + base58)
// and blockle-extension/secp256k1.js (public-key recovery / ecrecover). They
// let a wallet PROVE control of an address; they never touch any wallet key and
// are identity-only (never a spend). Keep them byte-for-byte compatible with the
// extension so a signature the wallet makes verifies here.

// -- Keccak-256 (Ethereum) — from crypto-core.js --
const KECCAK_RC = [
  [0x00000000, 0x00000001], [0x00000000, 0x00008082], [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
  [0x00000000, 0x0000808b], [0x00000000, 0x80000001], [0x80000000, 0x80008081], [0x80000000, 0x00008009],
  [0x00000000, 0x0000008a], [0x00000000, 0x00000088], [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
  [0x00000000, 0x8000808b], [0x80000000, 0x0000008b], [0x80000000, 0x00008089], [0x80000000, 0x00008003],
  [0x80000000, 0x00008002], [0x80000000, 0x00000080], [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
  [0x80000000, 0x80008081], [0x80000000, 0x00008080], [0x00000000, 0x80000001], [0x80000000, 0x80008008]];
const KECCAK_ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
function keccak256(msgBytes) {
  const rate = 136; // 1088 bits for keccak-256
  const data = msgBytes;
  const s = [];
  for (let i = 0; i < 25; i++) s.push([0, 0]);
  function rotl(lane, n) {
    n %= 64;
    if (n === 0) return [lane[0], lane[1]];
    if (n < 32) return [((lane[0] << n) | (lane[1] >>> (32 - n))) >>> 0, ((lane[1] << n) | (lane[0] >>> (32 - n))) >>> 0];
    const m2 = n - 32;
    if (m2 === 0) return [lane[1], lane[0]];
    return [((lane[1] << m2) | (lane[0] >>> (32 - m2))) >>> 0, ((lane[0] << m2) | (lane[1] >>> (32 - m2))) >>> 0];
  }
  function keccakF() {
    for (let round = 0; round < 24; round++) {
      const C = [];
      for (let x = 0; x < 5; x++) {
        let hi = s[x][0], lo = s[x][1];
        for (let y = 1; y < 5; y++) { hi ^= s[x + 5 * y][0]; lo ^= s[x + 5 * y][1]; }
        C[x] = [hi >>> 0, lo >>> 0];
      }
      const D = [];
      for (let x = 0; x < 5; x++) {
        const r = rotl(C[(x + 1) % 5], 1);
        D[x] = [(C[(x + 4) % 5][0] ^ r[0]) >>> 0, (C[(x + 4) % 5][1] ^ r[1]) >>> 0];
      }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        s[x + 5 * y][0] ^= D[x][0]; s[x + 5 * y][1] ^= D[x][1];
      }
      const Bm = [];
      for (let i = 0; i < 25; i++) Bm.push([0, 0]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y;
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        Bm[nx + 5 * ny] = rotl(s[idx], KECCAK_ROT[idx]);
      }
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const b0 = Bm[i], b1 = Bm[((x + 1) % 5) + 5 * y], b2 = Bm[((x + 2) % 5) + 5 * y];
        s[i][0] = (b0[0] ^ ((~b1[0]) & b2[0])) >>> 0;
        s[i][1] = (b0[1] ^ ((~b1[1]) & b2[1])) >>> 0;
      }
      s[0][0] = (s[0][0] ^ KECCAK_RC[round][0]) >>> 0;
      s[0][1] = (s[0][1] ^ KECCAK_RC[round][1]) >>> 0;
    }
  }
  const padded = [];
  for (let i = 0; i < data.length; i++) padded.push(data[i]);
  const q = rate - (padded.length % rate);
  if (q === 1) { padded.push(0x81); }
  else { padded.push(0x01); for (let i = 0; i < q - 2; i++) padded.push(0x00); padded.push(0x80); }
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate; i += 8) {
      const laneIdx = (i / 8) | 0;
      const lo = (padded[off + i] | (padded[off + i + 1] << 8) | (padded[off + i + 2] << 16) | (padded[off + i + 3] << 24)) >>> 0;
      const hi = (padded[off + i + 4] | (padded[off + i + 5] << 8) | (padded[off + i + 6] << 16) | (padded[off + i + 7] << 24)) >>> 0;
      s[laneIdx][0] = (s[laneIdx][0] ^ hi) >>> 0;
      s[laneIdx][1] = (s[laneIdx][1] ^ lo) >>> 0;
    }
    keccakF();
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 8) {
    const laneIdx = (i / 8) | 0;
    const lo = s[laneIdx][1], hi = s[laneIdx][0];
    out[i] = lo & 0xff; out[i + 1] = (lo >>> 8) & 0xff; out[i + 2] = (lo >>> 16) & 0xff; out[i + 3] = (lo >>> 24) & 0xff;
    out[i + 4] = hi & 0xff; out[i + 5] = (hi >>> 8) & 0xff; out[i + 6] = (hi >>> 16) & 0xff; out[i + 7] = (hi >>> 24) & 0xff;
  }
  return out;
}

// -- Base58 decode (Solana addresses) — from crypto-core.js --
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58decode(str) {
  const bytes = [0];
  for (const ch of String(str)) {
    const val = B58_ALPHABET.indexOf(ch);
    if (val < 0) throw new Error("invalid base58 char");
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  for (const ch of String(str)) { if (ch === "1") zeros++; else break; }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// -- secp256k1 public-key recovery (ecrecover) — from secp256k1.js --
const SECP = (() => {
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const B = 7n;
  const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
  const G = [Gx, Gy];
  const ZERO = null;
  function mod(a, m = P) { const r = a % m; return r >= 0n ? r : r + m; }
  function invMod(a, m = P) {
    a = mod(a, m);
    let old_r = a, r = m, old_s = 1n, s = 0n;
    while (r !== 0n) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
    return mod(old_s, m);
  }
  function pointAdd(p1, p2) {
    if (p1 === ZERO) return p2;
    if (p2 === ZERO) return p1;
    const [x1, y1] = p1, [x2, y2] = p2;
    if (x1 === x2 && mod(y1 + y2) === 0n) return ZERO;
    let m;
    if (x1 === x2 && y1 === y2) m = mod(3n * x1 * x1 * invMod(2n * y1));
    else m = mod((y2 - y1) * invMod(x2 - x1));
    const x3 = mod(m * m - x1 - x2);
    const y3 = mod(m * (x1 - x3) - y1);
    return [x3, y3];
  }
  function pointMul(k, point) {
    k = mod(k, N);
    let result = ZERO, addend = point;
    while (k > 0n) { if (k & 1n) result = pointAdd(result, addend); addend = pointAdd(addend, addend); k >>= 1n; }
    return result;
  }
  function powMod(base, exp, m) {
    base = mod(base, m); let result = 1n;
    while (exp > 0n) { if (exp & 1n) result = mod(result * base, m); base = mod(base * base, m); exp >>= 1n; }
    return result;
  }
  function bytesToBig(b) { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; }
  function bigTo32(x) { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; }
  function encodeUncompressed(Q) {
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(bigTo32(Q[0]), 1);
    out.set(bigTo32(Q[1]), 33);
    return out;
  }
  // Recover the UNCOMPRESSED public key (0x04|X|Y, 65 bytes) from a 32-byte
  // digest + compact (r,s) + recovery id. Returns null on any invalid input so
  // a bad/tampered signature simply yields no (or a different) key — never a throw.
  function recover(digest, rBytes, sBytes, recovery) {
    const rBig = bytesToBig(rBytes), sBig = bytesToBig(sBytes);
    if (rBig <= 0n || rBig >= N || sBig <= 0n || sBig >= N) return null;
    const z = mod(bytesToBig(digest), N);
    const x = (recovery & 2) ? rBig + N : rBig;
    if (x >= P) return null;
    const ySq = mod(x * x * x + B);
    let y = powMod(ySq, (P + 1n) / 4n, P);
    if ((y & 1n) !== BigInt(recovery & 1)) y = mod(-y);
    if (mod(y * y) !== ySq) return null; // point not on the curve
    const R = [x, y];
    const rInv = invMod(rBig, N);
    const sR = pointMul(sBig, R);
    const zG = pointMul(z, G);
    const Q = pointMul(rInv, pointAdd(sR, [zG[0], mod(-zG[1])]));
    if (Q === ZERO) return null;
    return encodeUncompressed(Q);
  }
  return { recover };
})();

// -- EVM EIP-191 personal_sign: recover the signer and require it to equal the
//    claimed 0x address (case-insensitive). A tampered signature recovers a
//    different (or no) address -> false. No impersonation: the address is
//    DERIVED from the recovered key, never trusted from the request.
function verifyEvmPersonalSign({ message, signature, address }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address || ""))) return false;
  const sig = Buffer.from(stripHex(signature), "hex");
  if (sig.length !== 65) return false;
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return false;
  const r = sig.subarray(0, 32);
  const s = sig.subarray(32, 64);
  const msg = Buffer.from(String(message), "utf8");
  const prefix = Buffer.from("\x19Ethereum Signed Message:\n" + msg.length, "latin1");
  const digest = keccak256(Buffer.concat([prefix, msg]));
  const pub = SECP.recover(digest, r, s, v); // 65-byte uncompressed, or null
  if (!pub || pub.length !== 65) return false;
  const recovered = "0x" + Buffer.from(keccak256(pub.subarray(1)).subarray(-20)).toString("hex");
  return recovered.toLowerCase() === String(address).toLowerCase();
}

// -- Solana ed25519: verify the raw ed25519 signature over the challenge with
//    the given pubkey, and require the base58 address to BE that pubkey (no
//    impersonation). publicKey may be base58 or 32-byte hex; if omitted, the
//    address itself is the pubkey (Solana address = base58 of the ed25519 key).
function verifySolanaEd25519({ message, signature, address, publicKey }) {
  let pub;
  const pk = publicKey ? String(publicKey) : "";
  if (pk) {
    const hx = stripHex(pk);
    pub = /^[0-9a-fA-F]{64}$/.test(hx) ? Buffer.from(hx, "hex") : Buffer.from(base58decode(pk));
  } else {
    pub = Buffer.from(base58decode(String(address)));
  }
  if (pub.length !== 32) return false;
  // The base58 address MUST decode to exactly this pubkey (no impersonation).
  const addrBytes = Buffer.from(base58decode(String(address)));
  if (addrBytes.length !== 32 || !addrBytes.equals(pub)) return false;
  const key = ed25519PubFromRawHex(pub.toString("hex"));
  return crypto.verify(null, Buffer.from(String(message), "utf8"), key, Buffer.from(stripHex(signature), "hex"));
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
    if (c === "evm" || c === "ethereum" || c === "eip155" || c === "eth") {
      return verifyEvmPersonalSign({ message, signature, address });
    }
    if (c === "solana" || c === "sol") {
      return verifySolanaEd25519({ message, signature, address, publicKey });
    }
    // BLOCK (chain "block"): ML-DSA via blockle-wasm. TODO — the post-quantum
    // verifier must be injected (deps.verify / cfg.verifierModule) once the wasm
    // verify entrypoint is wired in. Until then a "block" session returns false.
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
  // CORS: the web wallet (a blockle.org page) calls this gateway cross-origin, so it
  // needs an Access-Control-Allow-Origin header + an OPTIONS preflight responder. The
  // extension/desktop/mobile clients are not web origins and are unaffected. Allowlist
  // blockle.org + any *.blockle.org subdomain (+ localhost for dev); never a bare "*".
  const corsOrigin = (origin) => {
    if (!origin) return null;
    if (/^https:\/\/([a-z0-9-]+\.)*blockle\.org$/i.test(origin)) return origin;
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin;
    return null;
  };
  const server = http.createServer((req, res) => {
    const allowed = corsOrigin(req.headers.origin);
    const cors = allowed
      ? {
          "access-control-allow-origin": allowed,
          "vary": "Origin",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        }
      : {};
    const send = (code, obj) => {
      const bodyStr = JSON.stringify(obj);
      res.writeHead(code, Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) }, cors));
      res.end(bodyStr);
    };

    // CORS preflight — browsers send this before a cross-origin POST with a JSON body.
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }

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
  verifyEvmPersonalSign,
  verifySolanaEd25519,
  keccak256,
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
