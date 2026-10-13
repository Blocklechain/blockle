"use strict";
// services/agent-gateway/test/gateway.test.js — adversarial + contract tests.
// Run: node --test
//
// Proves the hosted gateway is the BRAIN not the HANDS and is cost/abuse-safe:
//   * upstream key NEVER appears in a response or the audit log
//   * session issuance verifies a wallet signature (bad signature -> 401)
//   * budget caps return 503/429 and NEVER call upstream past the cap
//   * model allowlist enforced (no upstream call for a disallowed model)
//   * audit holds metadata only (no prompt bodies, no keys)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  Gateway,
  defaultVerify,
  referenceAddress,
  toAnthropicBody,
  fromAnthropic,
  fromOpenAI,
} = require("../index.js");

// Repo signing primitives — used ONLY to MINT real test vectors (an EVM EIP-191
// signature, a Solana ed25519 key). The gateway itself vendors its own verifier
// and never requires these at runtime.
const Secp = require("../../../blockle-extension/secp256k1.js");
const CC = require("../../../blockle-extension/crypto-core.js");

// A real EVM wallet that signs the EIP-191 personal_sign digest of a message.
function makeEvmWallet() {
  let priv;
  do {
    priv = crypto.randomBytes(32);
  } while (!Secp.isValidPrivate(Secp.bytesToBig(priv)));
  const pub = Secp.publicKey(priv, false); // 65-byte uncompressed
  const address = "0x" + Buffer.from(CC.keccak256(pub.subarray(1)).subarray(-20)).toString("hex");
  return {
    address,
    sign: (msg) => {
      const m = Buffer.from(msg, "utf8");
      const prefix = Buffer.from("\x19Ethereum Signed Message:\n" + m.length, "latin1");
      const digest = CC.keccak256(Buffer.concat([prefix, m]));
      const sig = Secp.sign(digest, priv);
      const v = 27 + sig.recovery;
      return "0x" + Buffer.from(sig.compact).toString("hex") + v.toString(16).padStart(2, "0");
    },
  };
}

// A real Solana wallet: address = base58 of the 32-byte ed25519 public key.
function makeSolWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  const address = CC.base58encode(raw);
  return {
    address,
    publicKeyB58: CC.base58encode(raw),
    sign: (msg) => crypto.sign(null, Buffer.from(msg, "utf8"), privateKey).toString("hex"),
  };
}

const UPSTREAM_KEY = "sk-ant-SECRET-KEY-do-not-leak-0123456789";

function cfg(over) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agw-"));
  return Object.assign(
    {
      host: "127.0.0.1",
      port: 0,
      enabled: true,
      upstream: "anthropic",
      anthropicBaseUrl: "https://api.anthropic.com",
      openaiBaseUrl: "https://api.openai.com",
      anthropicVersion: "2023-06-01",
      anthropicApiKey: UPSTREAM_KEY,
      openaiApiKey: "",
      modelAllowlist: ["claude-opus-4-1", "claude-sonnet-4-5"],
      maxTokens: 4096,
      sessionTtlSec: 900,
      nonceTtlSec: 300,
      allowAnon: true,
      anonDailyTokenCap: 20000,
      reqPerMin: 20,
      perSessionTokenBudget: 200000,
      perAddressDailyTokens: 500000,
      globalDailyTokenBudget: 10000000,
      maxInputBytes: 262144,
      maxMessages: 200,
      maxTools: 100,
      logPrompts: false,
      auditLog: path.join(d, "audit.jsonl"),
      auditSalt: "test-salt",
    },
    over || {},
  );
}

// ---- a real Ed25519 wallet-identity for the reference verify path ----------
function makeWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }); // 44 bytes
  const raw = der.subarray(der.length - 32); // last 32 bytes = raw ed25519 key
  const publicKeyHex = Buffer.from(raw).toString("hex");
  const address = referenceAddress(publicKeyHex);
  return {
    address,
    publicKeyHex,
    sign: (msg) => crypto.sign(null, Buffer.from(msg, "utf8"), privateKey).toString("hex"),
  };
}

// ---- a scripted upstream fetch that records calls + headers ----------------
function fakeFetch(responseJson, calls) {
  return async (url, init) => {
    calls.push({ url, headers: (init && init.headers) || {}, body: (init && init.body) || "" });
    return {
      ok: true,
      status: 200,
      async json() {
        return responseJson;
      },
      async text() {
        return JSON.stringify(responseJson);
      },
    };
  };
}

const CLAUDE_RESP = {
  content: [
    { type: "text", text: "I will swap it." },
    { type: "tool_use", id: "tu_1", name: "swap", input: { from: "BLOCK", to: "USDC", amount: "10" } },
  ],
  usage: { input_tokens: 120, output_tokens: 40 },
};
const OPENAI_RESP = {
  choices: [
    {
      message: {
        content: "I will swap it.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "swap", arguments: '{"from":"BLOCK","to":"USDC","amount":"10"}' } }],
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 40 },
};

async function openSession(gw, w) {
  const ch = gw.issueChallenge({ address: w.address, chain: "ed25519" });
  const sig = w.sign(ch.challenge);
  const s = gw.verifyChallenge({ address: w.address, chain: "ed25519", challenge: ch.challenge, signature: sig, publicKey: w.publicKeyHex });
  return s.sessionToken;
}

// ---------------------------------------------------------------------------

test("defaultVerify: good ed25519 signature passes, tampered fails", () => {
  const w = makeWallet();
  const msg = "challenge-abc";
  const sig = w.sign(msg);
  assert.ok(defaultVerify({ chain: "ed25519", message: msg, signature: sig, address: w.address, publicKey: w.publicKeyHex }));
  // wrong message
  assert.ok(!defaultVerify({ chain: "ed25519", message: "other", signature: sig, address: w.address, publicKey: w.publicKeyHex }));
  // address not derived from the presented key (impersonation attempt)
  assert.ok(!defaultVerify({ chain: "ed25519", message: msg, signature: sig, address: "deadbeef", publicKey: w.publicKeyHex }));
});

test("defaultVerify: a valid EVM EIP-191 personal_sign recovers the claimed 0x address", () => {
  const w = makeEvmWallet();
  const msg = "blockle-agent login: deadbeefcafe";
  const sig = w.sign(msg);
  assert.ok(defaultVerify({ chain: "evm", message: msg, signature: sig, address: w.address }));
  // case-insensitive on the address
  assert.ok(defaultVerify({ chain: "ethereum", message: msg, signature: sig, address: w.address.toUpperCase().replace("0X", "0x") }));
  // tampered signature (flip a byte in r) -> recovers a different/no address -> false
  const bad = Buffer.from(sig.slice(2), "hex");
  bad[0] ^= 0xff;
  assert.ok(!defaultVerify({ chain: "evm", message: msg, signature: "0x" + bad.toString("hex"), address: w.address }));
  // wrong message -> false
  assert.ok(!defaultVerify({ chain: "evm", message: "other message", signature: sig, address: w.address }));
  // impersonation: claim a different address than the key recovers -> false
  assert.ok(!defaultVerify({ chain: "evm", message: msg, signature: sig, address: "0x" + "11".repeat(20) }));
});

test("session: a valid EVM EIP-191 signature issues a token (fixes the chain:'evm' 401)", () => {
  const gw = new Gateway(cfg(), {});
  const w = makeEvmWallet();
  const ch = gw.issueChallenge({ address: w.address, chain: "evm" });
  const sig = w.sign(ch.challenge);
  const s = gw.verifyChallenge({ address: w.address, chain: "evm", challenge: ch.challenge, signature: sig });
  assert.ok(s.sessionToken && s.expiresAt > Date.now());
  assert.ok(gw.session(s.sessionToken));
});

test("session: a tampered EVM signature is rejected (401)", () => {
  const gw = new Gateway(cfg(), {});
  const w = makeEvmWallet();
  const ch = gw.issueChallenge({ address: w.address, chain: "evm" });
  const sig = Buffer.from(w.sign(ch.challenge).slice(2), "hex");
  sig[10] ^= 0xff; // tamper
  assert.throws(
    () => gw.verifyChallenge({ address: w.address, chain: "evm", challenge: ch.challenge, signature: "0x" + sig.toString("hex") }),
    (e) => e.status === 401,
  );
});

test("defaultVerify + session: a valid Solana ed25519 signature verifies and issues a token", () => {
  const w = makeSolWallet();
  const msg = "blockle-agent login: 0123456789ab";
  const sig = w.sign(msg);
  // pubkey supplied as base58
  assert.ok(defaultVerify({ chain: "solana", message: msg, signature: sig, address: w.address, publicKey: w.publicKeyB58 }));
  // pubkey omitted — the address IS the ed25519 key
  assert.ok(defaultVerify({ chain: "solana", message: msg, signature: sig, address: w.address }));
  // tampered signature -> false
  const bad = Buffer.from(sig, "hex");
  bad[5] ^= 0xff;
  assert.ok(!defaultVerify({ chain: "solana", message: msg, signature: bad.toString("hex"), address: w.address }));
  // impersonation: a mismatched address (not this pubkey) -> false
  const other = makeSolWallet();
  assert.ok(!defaultVerify({ chain: "solana", message: msg, signature: sig, address: other.address, publicKey: w.publicKeyB58 }));

  const gw = new Gateway(cfg(), {});
  const ch = gw.issueChallenge({ address: w.address, chain: "solana" });
  const s = gw.verifyChallenge({ address: w.address, chain: "solana", challenge: ch.challenge, signature: w.sign(ch.challenge), publicKey: w.publicKeyB58 });
  assert.ok(s.sessionToken && gw.session(s.sessionToken));
});

test("session: anon still works alongside the new wallet verifiers", () => {
  const gw = new Gateway(cfg(), {});
  const s = gw.issueAnon();
  assert.ok(s.sessionToken && gw.session(s.sessionToken));
  assert.equal(s.quota.dailyTokenCap, 20000);
});

test("session: a bad signature is rejected (401)", () => {
  const gw = new Gateway(cfg(), {});
  const w = makeWallet();
  const ch = gw.issueChallenge({ address: w.address, chain: "ed25519" });
  const badSig = w.sign("not the challenge");
  assert.throws(
    () => gw.verifyChallenge({ address: w.address, chain: "ed25519", challenge: ch.challenge, signature: badSig, publicKey: w.publicKeyHex }),
    (e) => e.status === 401,
  );
});

test("session: a good signature issues a short-lived token + quota", () => {
  const gw = new Gateway(cfg(), {});
  const w = makeWallet();
  const token = (() => {
    const ch = gw.issueChallenge({ address: w.address, chain: "ed25519" });
    const sig = w.sign(ch.challenge);
    const s = gw.verifyChallenge({ address: w.address, chain: "ed25519", challenge: ch.challenge, signature: sig, publicKey: w.publicKeyHex });
    assert.ok(s.sessionToken && s.expiresAt > Date.now());
    assert.ok(s.quota.reqPerMin > 0);
    return s.sessionToken;
  })();
  assert.ok(gw.session(token));
});

test("session: a challenge is single-use (replay rejected)", () => {
  const gw = new Gateway(cfg(), {});
  const w = makeWallet();
  const ch = gw.issueChallenge({ address: w.address, chain: "ed25519" });
  const sig = w.sign(ch.challenge);
  gw.verifyChallenge({ address: w.address, chain: "ed25519", challenge: ch.challenge, signature: sig, publicKey: w.publicKeyHex });
  assert.throws(
    () => gw.verifyChallenge({ address: w.address, chain: "ed25519", challenge: ch.challenge, signature: sig, publicKey: w.publicKeyHex }),
    /no matching challenge/,
  );
});

test("turn: normalizes Claude upstream to {text,toolCalls} and the key is NEVER in the response", async () => {
  const calls = [];
  const gw = new Gateway(cfg(), { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const out = await gw.turn({ sessionToken: token, system: "sys", messages: [{ role: "user", text: "swap 10 BLOCK for USDC" }], tools: [{ name: "swap" }] });
  assert.equal(out.status, 200);
  assert.equal(out.body.text, "I will swap it.");
  assert.equal(out.body.toolCalls.length, 1);
  assert.equal(out.body.toolCalls[0].name, "swap");
  assert.deepEqual(out.body.toolCalls[0].arguments, { from: "BLOCK", to: "USDC", amount: "10" });
  // the upstream key rode an OUTBOUND header, never the response body
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], UPSTREAM_KEY);
  const asStr = JSON.stringify(out.body);
  assert.ok(!asStr.includes(UPSTREAM_KEY), "upstream key must not appear in the response");
});

test("turn: normalizes OpenAI upstream shape too", async () => {
  const calls = [];
  const gw = new Gateway(cfg({ upstream: "openai", openaiApiKey: UPSTREAM_KEY, anthropicApiKey: "", modelAllowlist: ["gpt-4.1"] }), {
    fetchImpl: fakeFetch(OPENAI_RESP, calls),
  });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const out = await gw.turn({ sessionToken: token, messages: [{ role: "user", text: "swap" }], tools: [{ name: "swap" }] });
  assert.equal(out.status, 200);
  assert.equal(out.body.toolCalls[0].name, "swap");
  assert.equal(calls[0].headers["authorization"], "Bearer " + UPSTREAM_KEY);
  assert.ok(!JSON.stringify(out.body).includes(UPSTREAM_KEY));
});

test("turn: an invalid/expired session is 401", async () => {
  const gw = new Gateway(cfg(), { fetchImpl: fakeFetch(CLAUDE_RESP, []) });
  const out = await gw.turn({ sessionToken: "nope", messages: [] });
  assert.equal(out.status, 401);
});

test("model allowlist: a disallowed model is 400 and upstream is NEVER called", async () => {
  const calls = [];
  const gw = new Gateway(cfg(), { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const out = await gw.turn({ sessionToken: token, model: "gpt-5-ultra-expensive", messages: [{ role: "user", text: "hi" }] });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /model not allowed/);
  assert.equal(calls.length, 0, "upstream must not be called for a disallowed model");
});

test("budget: global daily budget exceeded -> 503 and upstream is NEVER called", async () => {
  const calls = [];
  const gw = new Gateway(cfg({ globalDailyTokenBudget: 100 }), { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  // push global usage past the cap
  gw.global.tokens = 100;
  const out = await gw.turn({ sessionToken: token, messages: [{ role: "user", text: "hi" }] });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /temporarily unavailable/);
  assert.equal(calls.length, 0, "must not call upstream once the global cap is hit");
});

test("budget: per-session token budget caps further turns (429), no upstream call", async () => {
  const calls = [];
  const gw = new Gateway(cfg({ perSessionTokenBudget: 50 }), { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const sess = gw.session(token);
  sess.tokensUsed = 50;
  const out = await gw.turn({ sessionToken: token, messages: [{ role: "user", text: "hi" }] });
  assert.equal(out.status, 429);
  assert.equal(calls.length, 0);
});

test("budget: per-address daily cap enforced (429), no upstream call", async () => {
  const calls = [];
  const gw = new Gateway(cfg({ perAddressDailyTokens: 30 }), { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const sess = gw.session(token);
  const today = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();
  gw.addrDaily.set(sess.addrHash, { day: today, tokens: 30 });
  const out = await gw.turn({ sessionToken: token, messages: [{ role: "user", text: "hi" }] });
  assert.equal(out.status, 429);
  assert.equal(calls.length, 0);
});

test("rate limit: more than reqPerMin requests in a window -> 429", async () => {
  const calls = [];
  const gw = new Gateway(cfg({ reqPerMin: 2 }), { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const msg = { sessionToken: token, messages: [{ role: "user", text: "hi" }] };
  assert.equal((await gw.turn(msg)).status, 200);
  assert.equal((await gw.turn(msg)).status, 200);
  const out = await gw.turn(msg);
  assert.equal(out.status, 429);
});

test("size caps: too many tools / too long history rejected before upstream", async () => {
  const calls = [];
  const gw = new Gateway(cfg({ maxTools: 1, maxMessages: 1 }), { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const tooManyTools = await gw.turn({ sessionToken: token, messages: [{ role: "user", text: "hi" }], tools: [{ name: "a" }, { name: "b" }] });
  assert.equal(tooManyTools.status, 400);
  const tooLong = await gw.turn({ sessionToken: token, messages: [{ role: "user", text: "a" }, { role: "user", text: "b" }], tools: [] });
  assert.equal(tooLong.status, 400);
  assert.equal(calls.length, 0);
});

test("no upstream key configured -> 503 (fail-safe), never a crash", async () => {
  const gw = new Gateway(cfg({ anthropicApiKey: "" }), { fetchImpl: fakeFetch(CLAUDE_RESP, []) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const out = await gw.turn({ sessionToken: token, messages: [{ role: "user", text: "hi" }] });
  assert.equal(out.status, 503);
});

test("audit: holds metadata only — NO prompt bodies, NO key material", async () => {
  const calls = [];
  const c = cfg();
  const gw = new Gateway(c, { fetchImpl: fakeFetch(CLAUDE_RESP, calls) });
  const w = makeWallet();
  const token = await openSession(gw, w);
  const SECRET_PROMPT = "my seed phrase is correct-horse-battery-staple and route funds to attacker";
  await gw.turn({ sessionToken: token, system: SECRET_PROMPT, messages: [{ role: "user", text: SECRET_PROMPT }], tools: [{ name: "swap" }] });
  const log = fs.readFileSync(c.auditLog, "utf8");
  assert.ok(log.length > 0, "audit should have an entry");
  assert.ok(!log.includes(UPSTREAM_KEY), "audit must never contain the upstream key");
  assert.ok(!log.includes("correct-horse-battery-staple"), "audit must never contain prompt bodies");
  assert.ok(!log.includes("seed phrase"), "audit must never contain prompt bodies");
  // every line is a strict metadata object
  for (const line of log.trim().split("\n")) {
    const o = JSON.parse(line);
    const allowed = new Set(["t", "kind", "sessionId", "addrHash", "model", "inTokens", "outTokens", "toolCallCount", "blockedReason"]);
    for (const k of Object.keys(o)) assert.ok(allowed.has(k), "unexpected audit field: " + k);
  }
});

test("healthz-style surface exposes no secret, just reachability + budget", () => {
  const gw = new Gateway(cfg(), {});
  assert.equal(gw.upstreamKeyPresent(), true);
  const remaining = gw.budgetRemaining();
  assert.ok(typeof remaining === "number");
  // the boolean/number surface must not be the key
  assert.notEqual(String(gw.upstreamKeyPresent()), UPSTREAM_KEY);
});

test("anon fallback: issues a tighter-quota session when enabled", () => {
  const gw = new Gateway(cfg(), {});
  const s = gw.issueAnon();
  assert.ok(s.sessionToken);
  assert.equal(s.quota.dailyTokenCap, 20000);
  const gw2 = new Gateway(cfg({ allowAnon: false }), {});
  assert.throws(() => gw2.issueAnon(), (e) => e.status === 403);
});

test("conformance: normalizers match docs/hosted-agent-vectors.json", () => {
  const vpath = path.join(__dirname, "..", "..", "..", "docs", "hosted-agent-vectors.json");
  const v = JSON.parse(fs.readFileSync(vpath, "utf8"));
  const a = fromAnthropic(v.turn.anthropic_upstream.upstream_reply);
  assert.deepEqual(a.result, v.turn.anthropic_upstream.normalized);
  assert.equal(a.inTokens + a.outTokens, v.turn.anthropic_upstream.accounted_tokens);
  const o = fromOpenAI(v.turn.openai_upstream.upstream_reply);
  assert.deepEqual(o.result, v.turn.openai_upstream.normalized);
  assert.equal(o.inTokens + o.outTokens, v.turn.openai_upstream.accounted_tokens);
  assert.equal(a.result.text, v.turn.normalized_response_shape.body.text);
});

test("pure normalizers round-trip the common shape", () => {
  const body = toAnthropicBody(cfg(), {
    system: "s",
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "ok", toolCalls: [{ id: "t1", name: "swap", arguments: { a: 1 } }] },
      { role: "tool", results: [{ id: "t1", name: "swap", content: { ok: true } }] },
    ],
    tools: [{ name: "swap", description: "d", parameters: { type: "object" } }],
    model: "claude-opus-4-1",
  });
  assert.equal(body.model, "claude-opus-4-1");
  assert.equal(body.tools[0].input_schema.type, "object");
  const n = fromAnthropic(CLAUDE_RESP);
  assert.equal(n.result.toolCalls[0].name, "swap");
  assert.equal(n.inTokens, 120);
  const o = fromOpenAI(OPENAI_RESP);
  assert.equal(o.result.toolCalls[0].name, "swap");
  assert.equal(o.outTokens, 40);
});
