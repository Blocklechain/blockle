// Blockle Beacon — a NEW x402 product suite served at blockle.org/api/beacon/*
// (separate from the exchange). Two products, both paid over the x402 USDC rail:
//
//   1. RANDOM  — a VERIFIABLE randomness beacon. Commit-reveal anchored to BLOCK
//      proof-of-work: on payment we commit (roundId + 32-byte salt) to a FUTURE
//      block height; once that block is mined, randomness = sha256(salt ‖ [clientSeed]
//      ‖ blockHash). Fully trustless + reproducible: the salt is published before the
//      block exists (operator can't grind), the block hash is PoW-fixed (requester
//      can't grind), and anyone recomputes the sha256 from public inputs.
//
//   2. INFER   — paid inference on the hosted model (Ollama `blockle-agent`), with a
//      beacon value injected as a PUBLIC, tamper-proof seed so the operator can't
//      cherry-pick the randomness going in. HONEST LIMITATION: CPU inference is NOT
//      bit-reproducible, so the OUTPUT is not cryptographically verifiable — only the
//      seed is. We label it exactly that; we never claim verifiable output.
//
// Reuses the proven x402 glue from services/x402-buy (copied src/x402.js); the x402
// npm SDK is resolved via NODE_PATH to that service's node_modules (see beacon.service).

"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const { buildRequirements, buildChallengeV2, verifyAndSettle, paymentRequiredHeader } = require("./x402");

// ---- config (env-driven; safe testnet defaults) -----------------------------
const CFG = {
  port: Number(process.env.BEACON_PORT || 8811),
  publicBase: (process.env.BEACON_PUBLIC_BASE || "https://blockle.org/api/beacon").replace(/\/+$/, ""),
  network: process.env.BEACON_NETWORK || "base-sepolia", // mainnet "base" gated below
  facilitatorUrl: process.env.BEACON_FACILITATOR || "https://x402.org/facilitator",
  payTo: process.env.BEACON_PAYTO || "0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c",
  mainnetOk: process.env.BEACON_MAINNET_OK === "1",
  explorer: (process.env.BEACON_EXPLORER || "http://127.0.0.1:8445").replace(/\/+$/, ""),
  ollama: (process.env.BEACON_OLLAMA || "http://127.0.0.1:11434").replace(/\/+$/, ""),
  model: process.env.BEACON_MODEL || "blockle-agent:latest",
  confirmDelay: Math.max(1, Number(process.env.BEACON_CONFIRM_DELAY || 1)), // target = tip + N
  priceRandomUsd: Number(process.env.BEACON_PRICE_RANDOM || 0.01),
  priceInferUsd: Number(process.env.BEACON_PRICE_INFER || 0.03),
  dataDir: process.env.BEACON_DATA || path.join(__dirname, "..", "data"),
  maxTimeoutSeconds: 300,
};
const usdcMicro = (usd) => String(Math.round(usd * 1e6));
fs.mkdirSync(CFG.dataDir, { recursive: true });
const ROUNDS_FILE = path.join(CFG.dataDir, "rounds.json");
const RESULTS_FILE = path.join(CFG.dataDir, "results.json"); // paymentId -> stored result (idempotency)

function loadJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
function saveJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch {} }

// ---- tiny HTTP helpers (no deps) --------------------------------------------
function httpJson(method, urlStr, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch { return resolve(null); }
    const lib = u.protocol === "https:" ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request(u, {
      method,
      timeout: timeoutMs,
      headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) },
    }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
const explorerGet = (p) => httpJson("GET", CFG.explorer + p, null, 7000);
async function chainTip() { const s = await explorerGet("/explorer/stats"); const h = s && Number(s.height); return Number.isFinite(h) ? h : null; }
async function blockHashAt(height) { const b = await explorerGet(`/explorer/block/${height}`); return (b && (b.hash || (b.block && b.block.hash))) || null; }

// ---- randomness derivation (pure function of PUBLIC inputs) ------------------
const isHex = (s) => typeof s === "string" && /^[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0;
function deriveRandomness(saltHex, blockHashHex, clientSeedHex) {
  const parts = [Buffer.from(saltHex, "hex")];
  if (clientSeedHex) parts.push(Buffer.from(clientSeedHex, "hex"));
  parts.push(Buffer.from(blockHashHex, "hex"));
  const digest = crypto.createHash("sha256").update(Buffer.concat(parts)).digest();
  const hex = digest.toString("hex");
  const uint256 = BigInt("0x" + hex).toString();
  // uniform float in [0,1): top 52 bits (13 hex chars) over 2^52
  const float = Number(BigInt("0x" + hex.slice(0, 13))) / 2 ** 52;
  return { hex, uint256, float };
}

// ---- x402 priced-request core (lean; verify → settle → perform) -------------
function assertNetworkAllowed() {
  const mainnet = CFG.network === "base" || CFG.network === "eip155:8453";
  if (mainnet && !CFG.mainnetOk) throw new Error("mainnet x402 disabled — set BEACON_MAINNET_OK=1 after operator sign-off");
}
const paymentId = (xp) => crypto.createHash("sha256").update(String(xp)).digest("hex").slice(0, 32);

async function handlePriced(req, res, spec, perform) {
  try { assertNetworkAllowed(); } catch (e) { return sendJson(res, 503, { error: e.message }); }
  const resource = spec.resource;
  const amt = usdcMicro(spec.usd);
  const xPayment = req.headers["x-payment"];
  if (!xPayment) {
    const ch = buildChallengeV2({
      network: CFG.network, payTo: CFG.payTo, amountAtomic: amt, resource,
      method: req.method, description: spec.description, serviceName: "Blockle Beacon",
      maxTimeoutSeconds: CFG.maxTimeoutSeconds,
    });
    res.setHeader("PAYMENT-REQUIRED", ch.header);
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, X-PAYMENT-RESPONSE");
    return sendJson(res, 402, ch.body);
  }
  const pid = paymentId(xPayment);
  const results = loadJson(RESULTS_FILE);
  if (results[pid]) return sendJson(res, 200, { ...results[pid], idempotentReplay: true }); // paid once → same result

  const requirements = [buildRequirements({
    network: CFG.network, payTo: CFG.payTo, maxAmountRequired: amt, resource,
    description: spec.description, maxTimeoutSeconds: CFG.maxTimeoutSeconds,
  })];
  let vs;
  try {
    vs = await verifyAndSettle({ facilitatorUrl: CFG.facilitatorUrl, xPaymentHeader: xPayment, requirements });
  } catch (e) { return sendJson(res, 502, { error: `facilitator error: ${e.message}` }); }
  if (!vs.ok) {
    const ch = buildChallengeV2({ network: CFG.network, payTo: CFG.payTo, amountAtomic: amt, resource, method: req.method, description: spec.description, maxTimeoutSeconds: CFG.maxTimeoutSeconds });
    res.setHeader("PAYMENT-REQUIRED", ch.header);
    return sendJson(res, 402, ch.body);
  }
  if (vs.responseHeader) res.setHeader("X-PAYMENT-RESPONSE", vs.responseHeader);

  let out;
  try { out = await perform({ pid, payer: vs.payer, txHash: vs.txHash }); }
  catch (e) { return sendJson(res, 500, { error: `payment settled but action failed: ${e.message}`, paymentId: pid, settleTxHash: vs.txHash }); }

  const stored = loadJson(RESULTS_FILE); stored[pid] = out; saveJson(RESULTS_FILE, stored);
  return sendJson(res, 200, out);
}

// ---- products ---------------------------------------------------------------
async function doRandom(req, body, ctx) {
  const clientSeed = isHex(body.clientSeed || "") && body.clientSeed ? body.clientSeed.toLowerCase() : null;
  const tip = await chainTip();
  if (tip == null) throw new Error("BLOCK node unreachable");
  const targetHeight = tip + CFG.confirmDelay;
  const salt = crypto.randomBytes(32).toString("hex");
  const roundId = crypto.randomBytes(12).toString("hex");
  const round = {
    kind: "randomness-beacon", roundId, status: "committed",
    committedAtHeight: tip, targetHeight, salt, clientSeed,
    derivation: "sha256( salt" + (clientSeed ? " ‖ clientSeed" : "") + " ‖ blockHash@targetHeight )",
    revealUrl: `${CFG.publicBase}/round/${roundId}`,
    payer: ctx.payer, settleTxHash: ctx.txHash, createdAt: Date.now(),
  };
  const rounds = loadJson(ROUNDS_FILE); rounds[roundId] = round; saveJson(ROUNDS_FILE, rounds);
  return { ...round, note: "Randomness reveals once BLOCK reaches targetHeight. GET revealUrl to fetch it; recompute the derivation from the public salt + block hash to verify." };
}

function revealRound(roundId) {
  const rounds = loadJson(ROUNDS_FILE);
  const r = rounds[roundId];
  if (!r) return { status: 404, body: { error: "unknown roundId" } };
  return { status: 200, pending: r };
}

async function doInfer(req, body, ctx) {
  const prompt = String(body.prompt || "").slice(0, 4000);
  if (!prompt) throw new Error("missing prompt");
  // Optional: bind a beacon round's randomness as a PUBLIC seed. The seed is
  // verifiable (anyone can recompute it); the OUTPUT is not (CPU inference isn't
  // bit-reproducible), so we disclose the seed, not claim a verifiable output.
  let seed = null, seedSource = null;
  if (body.seedRound) {
    const rounds = loadJson(ROUNDS_FILE); const r = rounds[body.seedRound];
    if (r) { const bh = await blockHashAt(r.targetHeight); if (bh) { seed = deriveRandomness(r.salt, bh, r.clientSeed); seedSource = { roundId: r.roundId, targetHeight: r.targetHeight, blockHash: bh }; } }
  }
  if (!seed && body.seedHex && isHex(body.seedHex)) { const d = crypto.createHash("sha256").update(Buffer.from(body.seedHex, "hex")).digest("hex"); seed = { hex: d, uint256: BigInt("0x" + d).toString() }; seedSource = { seedHex: body.seedHex }; }
  const ollamaSeed = seed ? Number(BigInt("0x" + seed.hex.slice(0, 8))) : undefined; // 32-bit seed for the sampler
  const sys = seed
    ? `You are a provably-seeded generator. Public random seed for this request: 0x${seed.hex}. Let it guide any random choices.`
    : null;
  const gen = await httpJson("POST", CFG.ollama + "/api/generate", {
    model: CFG.model, prompt, system: sys || undefined, stream: false,
    options: { temperature: Number(body.temperature ?? 0.8), ...(ollamaSeed != null ? { seed: ollamaSeed } : {}) },
  }, 60000);
  if (!gen || gen.response == null) throw new Error("inference backend unavailable");
  return {
    kind: "seeded-inference", model: CFG.model, prompt,
    output: gen.response,
    seed: seed ? { hex: seed.hex, uint256: seed.uint256, source: seedSource } : null,
    payer: ctx.payer, settleTxHash: ctx.txHash,
    verifiability: "The SEED is verifiable (recompute it from the public beacon round). The OUTPUT is NOT cryptographically verifiable — this CPU inference backend is not bit-reproducible, so a third party cannot replay the exact bytes. Treat it as provably-fair-seeded generation, not verifiable inference.",
  };
}

// ---- discovery manifest -----------------------------------------------------
function manifest() {
  return {
    x402Version: 2, name: "Blockle Beacon — verifiable randomness + seeded inference",
    description: "BLOCK proof-of-work secures a verifiable randomness beacon (commit-reveal, anchored to block hashes) and powers beacon-seeded inference — both paid over x402 USDC.",
    network: CFG.network, facilitator: CFG.facilitatorUrl,
    resources: [
      { resource: `${CFG.publicBase}/random`, method: "POST", price: `$${CFG.priceRandomUsd}`, description: "Commit a verifiable randomness round anchored to a future BLOCK block hash. Reveal via /round/:id.", output: { roundId: "string", targetHeight: "int", salt: "hex", revealUrl: "url", derivation: "formula" } },
      { resource: `${CFG.publicBase}/infer`, method: "POST", price: `$${CFG.priceInferUsd}`, description: "Beacon-seeded generation on the hosted model. Seed is verifiable; output is provably-fair-seeded (NOT bit-reproducible).", input: { prompt: "string", seedRound: "optional beacon roundId", seedHex: "optional hex seed", temperature: "optional" } },
    ],
  };
}

// ---- router -----------------------------------------------------------------
function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-payment", "access-control-expose-headers": "PAYMENT-REQUIRED, X-PAYMENT-RESPONSE" });
  res.end(JSON.stringify(obj));
}
function readBody(req) { return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); }); }

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.replace(/^\/api\/beacon\/?/, "").split("/").filter(Boolean);
  const body = (req.method === "POST") ? await readBody(req) : Object.fromEntries(u.searchParams);
  try {
    if (parts[0] === "health" || u.pathname === "/api/beacon") return sendJson(res, 200, { ok: true, network: CFG.network, priceRandomUsd: CFG.priceRandomUsd, priceInferUsd: CFG.priceInferUsd, confirmDelay: CFG.confirmDelay });
    if (parts[0] === ".well-known" || parts[0] === "resources") return sendJson(res, 200, manifest());
    if (parts[0] === "round" && parts[1]) { const r = revealRound(parts[1]); if (r.status === 404) return sendJson(res, 404, r.body);
      const pr = r.pending; const bh = await blockHashAt(pr.targetHeight);
      if (!bh) { const tip = await chainTip(); return sendJson(res, 200, { status: "pending", roundId: pr.roundId, targetHeight: pr.targetHeight, currentHeight: tip, blocksLeft: tip != null ? Math.max(0, pr.targetHeight - tip) : null, salt: pr.salt, derivation: pr.derivation }); }
      const rnd = deriveRandomness(pr.salt, bh, pr.clientSeed);
      return sendJson(res, 200, { status: "ready", roundId: pr.roundId, targetHeight: pr.targetHeight, blockHash: bh, salt: pr.salt, clientSeed: pr.clientSeed, randomness: rnd, derivation: pr.derivation, verify: `sha256( hex(salt)${pr.clientSeed ? " ++ hex(clientSeed)" : ""} ++ hex(blockHash) ) == randomness.hex` });
    }
    if (parts[0] === "random") return handlePriced(req, res, { resource: `${CFG.publicBase}/random`, usd: CFG.priceRandomUsd, description: "Verifiable randomness beacon round (commit-reveal, BLOCK-PoW anchored)." }, (ctx) => doRandom(req, body, ctx));
    if (parts[0] === "infer") return handlePriced(req, res, { resource: `${CFG.publicBase}/infer`, usd: CFG.priceInferUsd, description: "Beacon-seeded inference on the hosted model (seed verifiable; output not bit-reproducible)." }, (ctx) => doInfer(req, body, ctx));
    return sendJson(res, 404, { error: "not found", try: ["/api/beacon/random (x402)", "/api/beacon/round/:id", "/api/beacon/infer (x402)", "/api/beacon/health", "/api/beacon/.well-known/x402"] });
  } catch (e) { return sendJson(res, 500, { error: (e && e.message) || String(e) }); }
});
server.listen(CFG.port, "127.0.0.1", () => console.log(`[beacon] on 127.0.0.1:${CFG.port} network=${CFG.network} model=${CFG.model} explorer=${CFG.explorer}`));
