// Blockle Inference Gateway — the x402-paid inference endpoint WE own, at
// blockle.org/api/inference/*. Buyers pay USDC; the gateway routes to a registered GPU
// MINER (who bears the GPU cost), keeps a protocol fee for the treasury (Alienbeing), and
// records the miner's earnings so the validator's demand signal reflects real paid traffic.
// A CPU bootstrap backend (the hosted model) answers while no GPU miners are online, clearly
// labeled — we never advertise the bootstrap model as competitive.
//
// Mainnet USDC is gated behind INFERENCE_MAINNET_OK=1 (operator sign-off), same as the beacon.
"use strict";
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { buildRequirements, buildChallengeV2, verifyAndSettle } = require("./x402");
const { route } = require("./gateway");
const { CATALOG } = require("./models");
const { createQueue } = require("./jobqueue");
const { buildOpenApi } = require("./openapi");

// Pull-based queue for BROWSER (WebGPU) miners — the web wallet serves directly from the tab.
const QUEUE = createQueue({ jobTimeoutMs: 25000 });
const browserMiners = {}; // address -> { ts, tier }
function activeBrowser() { const now = Date.now(); return Object.values(browserMiners).filter((m) => now - m.ts < 60000).length; }

const CFG = {
  port: Number(process.env.INFERENCE_PORT || 8822),
  publicBase: (process.env.INFERENCE_PUBLIC_BASE || "https://blockle.org/api/inference").replace(/\/+$/, ""),
  network: process.env.INFERENCE_NETWORK || "base-sepolia", // "base" mainnet gated below
  facilitatorUrl: process.env.INFERENCE_FACILITATOR || "https://x402.org/facilitator",
  payTo: process.env.INFERENCE_PAYTO || "0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c",
  mainnetOk: process.env.INFERENCE_MAINNET_OK === "1",
  feeBps: Number(process.env.INFERENCE_FEE_BPS || 2000), // treasury keeps 20%
  priceUsd: Number(process.env.INFERENCE_PRICE || 0.02),
  subnetId: Number(process.env.INFERENCE_SUBNET || 0),
  explorer: (process.env.INFERENCE_EXPLORER || "http://127.0.0.1:8445").replace(/\/+$/, ""),
  // CPU bootstrap backend (the hosted model). NOT advertised as competitive.
  ollama: (process.env.INFERENCE_OLLAMA || "http://127.0.0.1:11434").replace(/\/+$/, ""),
  bootstrapModel: process.env.INFERENCE_MODEL || "blockle-agent:latest",
  dataDir: process.env.INFERENCE_DATA || path.join(__dirname, "..", "data"),
  maxTimeoutSeconds: 300,
  latencyBudgetMs: Number(process.env.INFERENCE_LAT_MS || 60000),
  blockUsd: Number(process.env.INFERENCE_BLOCK_USD || 0.01), // operator BLOCK→USD rate for BLOCK-402 quotes
  chatPriceBlock: Math.round(Number(process.env.CHAT_PRICE_BLOCK || 0.1) * 1e8), // BLOCK per chat message (base units)
  depositAddr: process.env.CHAT_DEPOSIT_ADDR || "", // BLOCK address users top up credit to
};
const COIN = 100000000; // BLOCK base units
const usdcMicro = (usd) => String(Math.round(usd * 1e6));
fs.mkdirSync(CFG.dataDir, { recursive: true });
const MINERS_FILE = path.join(CFG.dataDir, "miners.json");     // uid -> {uid,address,url,ts}
const REVENUE_FILE = path.join(CFG.dataDir, "revenue.json");   // address -> {epochUsd,totalUsd,requests}
const RESULTS_FILE = path.join(CFG.dataDir, "results.json");   // paymentId -> result (idempotency)
const crypto = require("node:crypto");

function loadJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
function saveJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o)); } catch {} }
function sendJson(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { "content-type": "application/json", "content-length": b.length, "access-control-allow-origin": "*" }); res.end(b); }

function httpReq(method, urlStr, body, timeoutMs = 60000, headers = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch { return resolve(null); }
    const lib = u.protocol === "https:" ? https : http;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request(u, { method, timeout: timeoutMs, headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } },
      (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on("error", () => resolve(null)); req.on("timeout", () => { req.destroy(); resolve(null); });
    if (data) req.write(data); req.end();
  });
}
const explorerGet = (p) => httpReq("GET", CFG.explorer + p, null, 7000);

// ---- miner registry: on-chain neurons (role 0) ∩ announced serving URLs ------
async function liveMiners() {
  const announced = loadJson(MINERS_FILE); // uid -> {address,url}
  const sub = await explorerGet(`/explorer/intel/subnet/${CFG.subnetId}`);
  const onchain = (sub && sub.neurons ? sub.neurons : []).filter((n) => n.role === 0);
  const rev = loadJson(REVENUE_FILE);
  // Only miners that are BOTH registered on-chain AND have announced a URL can serve.
  return onchain
    .map((n) => {
      const a = announced[String(n.uid)];
      if (!a || !a.url) return null;
      return { uid: n.uid, address: n.owner, url: a.url, healthy: true, revenueUsd: (rev[n.owner] || {}).epochUsd || 0 };
    })
    .filter(Boolean);
}

async function callMiner(m, request) {
  const r = await httpReq("POST", `${m.url.replace(/\/$/, "")}/infer`, request, CFG.latencyBudgetMs);
  if (!r || typeof r.answer !== "string") throw new Error("miner no answer");
  return { answer: r.answer, ms: r.ms, model: r.model };
}
// Bootstrap backend: the hosted CPU model (labeled dev/bootstrap, never "competitive").
async function callBootstrap(request) {
  const r = await httpReq("POST", `${CFG.ollama}/api/generate`, { model: CFG.bootstrapModel, prompt: String(request.prompt || ""), stream: false }, CFG.latencyBudgetMs);
  if (!r || typeof r.response !== "string") throw new Error("bootstrap model unavailable");
  return { answer: r.response, ms: 0, model: `${CFG.bootstrapModel} (CPU bootstrap)` };
}

function recordEarning(address, usd) {
  if (!address || !(usd > 0)) return;
  const rev = loadJson(REVENUE_FILE);
  const e = rev[address] || { epochUsd: 0, totalUsd: 0, requests: 0 };
  e.epochUsd = round6(e.epochUsd + usd); e.totalUsd = round6(e.totalUsd + usd); e.requests += 1;
  rev[address] = e; saveJson(REVENUE_FILE, rev);
}
function round6(x) { return Math.round((Number(x) || 0) * 1e6) / 1e6; }

// ---- miner USDC payout ledger (Base) -----------------------------------------
// The x402 USDC path pays the buyer's USDC to the treasury (payTo). The treasury keeps its
// skim (feeBps); the miner's share is accrued here as USDC OWED and later disbursed to the
// miner's registered Base address by the gated payout service (payout.js). BLOCK-credit chat
// traffic is NOT accrued here (that settles in BLOCK).
const OWED_FILE = path.join(CFG.dataDir, "owed-usdc.json");       // blockAddr -> { owed, paid } (USDC, 6dp)
const PAYADDR_FILE = path.join(CFG.dataDir, "payout-addrs.json"); // blockAddr -> base (0x…) payout address
function accrueUsdc(addr, usd) {
  if (!addr || !(usd > 0)) return;
  const o = loadJson(OWED_FILE); const e = o[addr] || { owed: 0, paid: 0 };
  e.owed = round6(e.owed + usd); o[addr] = e; saveJson(OWED_FILE, o);
}
function setPayoutAddr(blockAddr, baseAddr) {
  if (!blockAddr || !/^0x[0-9a-fA-F]{40}$/.test(String(baseAddr || ""))) return false;
  const p = loadJson(PAYADDR_FILE); p[blockAddr] = baseAddr; saveJson(PAYADDR_FILE, p); return true;
}

// ---- x402 priced core (verify → settle → perform), mirrors the beacon --------
function assertNetworkAllowed() {
  const mainnet = CFG.network === "base" || CFG.network === "eip155:8453";
  if (mainnet && !CFG.mainnetOk) throw new Error("mainnet x402 disabled — set INFERENCE_MAINNET_OK=1 after operator sign-off");
}
const paymentId = (xp) => crypto.createHash("sha256").update(String(xp)).digest("hex").slice(0, 32);

async function handleInfer(req, res, body) {
  try { assertNetworkAllowed(); } catch (e) { return sendJson(res, 503, { error: e.message }); }
  const resource = `${CFG.publicBase}/infer`;
  const amt = usdcMicro(CFG.priceUsd);
  const description = "Inference routed to community GPU miners (Blockle Intelligence tier-2). Bootstrap fallback is a small hosted CPU model, labeled as such.";
  const xPayment = req.headers["x-payment"];
  if (!xPayment) {
    const ch = buildChallengeV2({ network: CFG.network, payTo: CFG.payTo, amountAtomic: amt, resource, method: "POST", description, serviceName: "Blockle Inference", maxTimeoutSeconds: CFG.maxTimeoutSeconds });
    res.setHeader("PAYMENT-REQUIRED", ch.header);
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, X-PAYMENT-RESPONSE");
    return sendJson(res, 402, ch.body);
  }
  const pid = paymentId(xPayment);
  const results = loadJson(RESULTS_FILE);
  if (results[pid]) return sendJson(res, 200, { ...results[pid], idempotentReplay: true });

  const requirements = [buildRequirements({ network: CFG.network, payTo: CFG.payTo, maxAmountRequired: amt, resource, description, maxTimeoutSeconds: CFG.maxTimeoutSeconds })];
  let vs;
  try { vs = await verifyAndSettle({ facilitatorUrl: CFG.facilitatorUrl, xPaymentHeader: xPayment, requirements }); }
  catch (e) { return sendJson(res, 502, { error: `facilitator error: ${e.message}` }); }
  if (!vs.ok) {
    const ch = buildChallengeV2({ network: CFG.network, payTo: CFG.payTo, amountAtomic: amt, resource, method: "POST", description, maxTimeoutSeconds: CFG.maxTimeoutSeconds });
    res.setHeader("PAYMENT-REQUIRED", ch.header);
    return sendJson(res, 402, ch.body);
  }
  if (vs.responseHeader) res.setHeader("X-PAYMENT-RESPONSE", vs.responseHeader);

  const out = await performInference(body, CFG.priceUsd);
  if (!out) return sendJson(res, 503, { error: "no miner or bootstrap backend available" });
  // x402 USDC path: the miner's share is now owed in USDC (treasury kept its skim).
  if (out.minerAddress) accrueUsdc(out.minerAddress, out.accounting.minerEarnsUsd);
  out.payer = vs.payer; out.txHash = vs.txHash;
  results[pid] = out; saveJson(RESULTS_FILE, results);
  return sendJson(res, 200, out);
}

// Produce an answer + credit the serving miner's demand (USD-equivalent). Shared by the x402
// /infer path and the BLOCK-credit /chat path. priceUsd sizes the miner earning / fee split.
// Prefers a live browser (WebGPU) miner, then push miners, then the labeled CPU bootstrap.
async function performInference(body, priceUsd) {
  const request = { prompt: body.prompt || "", temperature: body.temperature, max_tokens: body.max_tokens };
  if (activeBrowser() > 0) {
    try {
      const br = await QUEUE.enqueue(request);
      if (br && typeof br.answer === "string" && br.answer.trim()) {
        const protocolFeeUsd = round6(priceUsd * CFG.feeBps / 10000);
        const minerEarnsUsd = round6(priceUsd - protocolFeeUsd);
        recordEarning(br.address, minerEarnsUsd);
        return { answer: br.answer, servedBy: { kind: "browser", address: br.address }, minerAddress: br.address, model: "webgpu-miner", tier: 2,
          accounting: { priceUsd, protocolFeeUsd, minerEarnsUsd, netToTreasuryUsd: protocolFeeUsd } };
      }
    } catch (_) { /* fall through */ }
  }
  const miners = await liveMiners();
  const r = await route({ request, miners, priceUsd, feeBps: CFG.feeBps, call: callMiner, wholesale: { costUsd: 0, call: callBootstrap } });
  if (!r.ok) return null;
  let minerAddress = null;
  if (r.servedBy.kind === "miner") { const m = miners.find((x) => x.uid === r.servedBy.uid); if (m) { recordEarning(m.address, r.accounting.minerEarnsUsd); minerAddress = m.address; } }
  return { answer: r.answer, servedBy: r.servedBy, minerAddress, model: r.model || null, accounting: r.accounting, tier: 2,
    note: r.servedBy.kind === "wholesale" ? "served by CPU bootstrap model (not competitive) — no GPU miners online yet" : undefined };
}

// ---- API keys + BLOCK credit (pay-per-call in native BLOCK) ------------------
// A KEY is a bearer credential holding a BLOCK credit balance. Chat UI + the public API both
// authenticate with it; spending requires the secret (claiming an address could never be
// trusted server-side, so credit is keyed by the key, not the address). The wallet tops a key
// up by sending BLOCK to the deposit address and calling /deposit — and auto-tops when low.
const CREDITS_FILE = path.join(CFG.dataDir, "credits.json");   // keyId -> balance (BLOCK base units)
const DEPOSITS_FILE = path.join(CFG.dataDir, "deposits.json"); // txid -> true (idempotency)
const KEYS_FILE = path.join(CFG.dataDir, "keys.json");         // keyId -> {prefix,address,created,label}
const keyId = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");
function creditOf(id) { return Number(loadJson(CREDITS_FILE)[id] || 0); }
function setCredit(id, bal) { const c = loadJson(CREDITS_FILE); c[id] = Math.max(0, Math.round(bal)); saveJson(CREDITS_FILE, c); }
function authKey(req, body) {
  const h = req.headers["authorization"] || "";
  const bearer = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  const key = bearer || (body && body.key) || "";
  if (!key) return null;
  const id = keyId(key);
  return loadJson(KEYS_FILE)[id] ? id : null;
}

function handleKeyCreate(res, body) {
  const key = "blk-" + crypto.randomBytes(24).toString("hex");
  const id = keyId(key);
  const keys = loadJson(KEYS_FILE);
  keys[id] = { prefix: key.slice(0, 12), address: String(body.address || ""), created: nowIso(), label: String(body.label || "") };
  saveJson(KEYS_FILE, keys);
  // The full key is returned ONCE; only its hash is stored. Fund it via /deposit.
  return sendJson(res, 200, { key, prefix: keys[id].prefix, depositAddr: CFG.depositAddr, priceBlock: CFG.chatPriceBlock / COIN, balanceBlock: 0 });
}
function nowIso() { try { return new Date().toISOString(); } catch { return ""; } }

// Verify a BLOCK deposit tx on-chain and credit the KEY (bearer — no sender check needed).
async function handleDeposit(req, res, body) {
  if (!CFG.depositAddr) return sendJson(res, 503, { error: "deposits not configured (CHAT_DEPOSIT_ADDR unset)" });
  const id = authKey(req, body);
  if (!id) return sendJson(res, 401, { error: "unknown or missing API key" });
  const txid = String(body.txid || "");
  if (!txid) return sendJson(res, 400, { error: "need {txid}" });
  const seen = loadJson(DEPOSITS_FILE);
  if (seen[txid]) return sendJson(res, 200, { ok: true, idempotent: true, balanceBlock: creditOf(id) / COIN });
  const tx = await explorerGet(`/explorer/tx/${txid}`);
  if (!tx || tx.error) return sendJson(res, 404, { error: "tx not found yet (wait for a confirmation)" });
  const toUs = (tx.outputs || []).filter((o) => o.address === CFG.depositAddr).reduce((s, o) => s + Number(o.amount || 0), 0);
  if (toUs <= 0) return sendJson(res, 400, { error: "tx has no output to the deposit address" });
  seen[txid] = true; saveJson(DEPOSITS_FILE, seen);
  setCredit(id, creditOf(id) + toUs);
  return sendJson(res, 200, { ok: true, creditedBlock: toUs / COIN, balanceBlock: creditOf(id) / COIN });
}

// Shared paid-inference core for the chat UI and the OpenAI-compatible API.
async function paidInfer(req, res, body, openaiShape) {
  const id = authKey(req, body);
  if (!id) return sendJson(res, 401, { error: "unknown or missing API key — create one in the wallet (Inference ▸ API key)" });
  if (!body.prompt && !(body.messages && body.messages.length)) return sendJson(res, 400, { error: "need {prompt} or {messages}" });
  const prompt = body.prompt || body.messages.map((m) => m.content).join("\n");
  const price = CFG.chatPriceBlock;
  if (creditOf(id) < price) return sendJson(res, 402, { error: "insufficient BLOCK credit", need: price / COIN, balanceBlock: creditOf(id) / COIN, priceBlock: price / COIN, depositAddr: CFG.depositAddr });
  const out = await performInference({ prompt, temperature: body.temperature, max_tokens: body.max_tokens }, (price / COIN) * CFG.blockUsd);
  if (!out) return sendJson(res, 503, { error: "no miner or bootstrap backend available (not charged)" });
  setCredit(id, creditOf(id) - price); // debit only on success
  if (openaiShape) {
    return sendJson(res, 200, { id: "blkinf-" + keyId(txRand()).slice(0, 16), object: "chat.completion", model: out.model || "blockle-intelligence",
      choices: [{ index: 0, message: { role: "assistant", content: out.answer }, finish_reason: "stop" }],
      blockle: { paidBlock: price / COIN, balanceBlock: creditOf(id) / COIN, servedBy: out.servedBy } });
  }
  return sendJson(res, 200, { answer: out.answer, servedBy: out.servedBy, model: out.model, note: out.note, paidBlock: price / COIN, balanceBlock: creditOf(id) / COIN });
}
function txRand() { return crypto.randomBytes(8).toString("hex"); }

// ---- server -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-payment, authorization", "access-control-allow-methods": "GET,POST,OPTIONS" }); return res.end(); }
  // Point crawlers/agents at the OpenAPI discovery doc from every response.
  res.setHeader("Link", '</api/inference/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"');
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.replace(/^\/api\/inference/, "").split("/").filter(Boolean);
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    const body = b ? (() => { try { return JSON.parse(b); } catch { return {}; } })() : {};
    try {
      if (!parts.length || parts[0] === "health") return sendJson(res, 200, { ok: true, network: CFG.network, mainnetOk: CFG.mainnetOk, subnet: CFG.subnetId, priceUsd: CFG.priceUsd, feeBps: CFG.feeBps, miners: (await liveMiners()).length });
      if (parts[0] === "infer" && req.method === "POST") return handleInfer(req, res, body);
      // ---- API keys + BLOCK-credit chat/API (pay-per-call in native BLOCK) ----
      if (parts[0] === "keys" && parts[1] === "create" && req.method === "POST") return handleKeyCreate(res, body);
      if (parts[0] === "chat" && req.method === "POST") return paidInfer(req, res, body, false);
      if (parts[0] === "v1" && parts[1] === "chat" && parts[2] === "completions" && req.method === "POST") return paidInfer(req, res, body, true);
      if (parts[0] === "deposit" && req.method === "POST") return handleDeposit(req, res, body);
      if (parts[0] === "credit") { const id = authKey(req, body); return sendJson(res, 200, { authed: !!id, balanceBlock: id ? creditOf(id) / COIN : 0, priceBlock: CFG.chatPriceBlock / COIN, depositAddr: CFG.depositAddr }); }
      if (parts[0] === "models") return sendJson(res, 200, { note: "Recommended model per GPU class — anyone can mine, CPU to 80GB.", catalog: CATALOG });
      if (parts[0] === "quote") { // BLOCK-402: price a job in BLOCK so a contract can set max_fee
        const tierIdx = Math.max(0, Math.min(CATALOG.length - 1, Number(u.searchParams.get("tier") || 0)));
        const priceUsd = CFG.priceUsd; // flat per-call for now; could scale by tier
        const blockBase = Math.ceil((priceUsd / CFG.blockUsd) * COIN);
        return sendJson(res, 200, { standard: "BLOCK-402", tier: CATALOG[tierIdx].tier, priceUsd, blockUsd: CFG.blockUsd, feeBlockBaseUnits: blockBase, feeBlock: blockBase / COIN, note: "Set the contract's max_fee ≥ feeBlockBaseUnits. On-chain escrow pays this in BLOCK." });
      }
      if (parts[0] === "result") { // BLOCK-402: full result text by requestId (chains hold only the hash)
        const rid = parts[1] || u.searchParams.get("requestId") || "";
        const r = loadJson(path.join(CFG.dataDir, "oracle-results.json"))[rid];
        return r ? sendJson(res, 200, { requestId: rid, ...r }) : sendJson(res, 404, { requestId: rid, status: "pending-or-unknown", note: "result appears here once the fulfiller completes the request" });
      }
      if (parts[0] === "miners") return sendJson(res, 200, { miners: (await liveMiners()).map((m) => ({ uid: m.uid, address: m.address, epochUsd: m.revenueUsd })), browser: activeBrowser() });
      // ---- browser (WebGPU) miner job protocol ----
      if (parts[0] === "jobs" && parts[1] === "register" && req.method === "POST") {
        if (!body.address) return sendJson(res, 400, { error: "need {address}" });
        browserMiners[body.address] = { ts: Date.now(), tier: body.tier || "webgpu" };
        return sendJson(res, 200, { ok: true, pollMs: 1000 });
      }
      if (parts[0] === "jobs" && parts[1] === "next") { // browser miner long-polls for a job
        const address = u.searchParams.get("address") || "";
        if (address) browserMiners[address] = { ts: Date.now(), tier: (browserMiners[address] || {}).tier || "webgpu" };
        const c = QUEUE.claimNext();
        if (c.job) return sendJson(res, 200, { job: { jobId: c.job.jobId, prompt: c.job.request.prompt, temperature: c.job.request.temperature, max_tokens: c.job.request.max_tokens } });
        const t = setTimeout(() => { c.cancel(); if (!res.writableEnded) sendJson(res, 204, {}); }, 25000);
        c.wait.then((job) => { clearTimeout(t); if (res.writableEnded) return;
          if (job) sendJson(res, 200, { job: { jobId: job.jobId, prompt: job.request.prompt, temperature: job.request.temperature, max_tokens: job.request.max_tokens } });
          else sendJson(res, 204, {}); });
        return;
      }
      if (parts[0] === "jobs" && parts[1] === "result" && req.method === "POST") {
        if (!body.jobId || !body.address || typeof body.answer !== "string") return sendJson(res, 400, { error: "need {jobId,address,answer}" });
        browserMiners[body.address] = { ts: Date.now(), tier: (browserMiners[body.address] || {}).tier || "webgpu" };
        return sendJson(res, 200, { ok: QUEUE.submitResult(body.jobId, body.address, body.answer) });
      }
      if (parts[0] === "earnings") { // /earnings/<address>  (read-only; what a miner watches)
        const addr = parts[1] || u.searchParams.get("address") || "";
        const e = loadJson(REVENUE_FILE)[addr] || { epochUsd: 0, totalUsd: 0, requests: 0 };
        return sendJson(res, 200, { address: addr, ...e });
      }
      if (parts[0] === "announce" && req.method === "POST") { // miner posts its serving URL
        if (!body.uid || !body.url || !body.address) return sendJson(res, 400, { error: "need {uid,address,url}" });
        const m = loadJson(MINERS_FILE); m[String(body.uid)] = { uid: Number(body.uid), address: body.address, url: body.url, tier: body.tier || null, model: body.model || null, ts: Date.now() }; saveJson(MINERS_FILE, m);
        if (body.payoutBase) setPayoutAddr(body.address, body.payoutBase); // Base USDC payout address
        return sendJson(res, 200, { ok: true, registered: m[String(body.uid)] });
      }
      // Register a miner's Base (USDC) payout address — where the gateway disburses owed USDC.
      if (parts[0] === "payout-address" && req.method === "POST") {
        if (!setPayoutAddr(body.address, body.payoutBase)) return sendJson(res, 400, { error: "need {address (BLOCK), payoutBase (0x… Base address)}" });
        return sendJson(res, 200, { ok: true, address: body.address, payoutBase: body.payoutBase });
      }
      // What a miner is owed / has been paid in USDC (by BLOCK address).
      if (parts[0] === "owed") {
        const addr = parts[1] || u.searchParams.get("address") || "";
        const e = loadJson(OWED_FILE)[addr] || { owed: 0, paid: 0 };
        const payoutBase = loadJson(PAYADDR_FILE)[addr] || null;
        return sendJson(res, 200, { address: addr, owedUsdc: e.owed, paidUsdc: e.paid, payoutBase, asset: { symbol: "USDC", chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } });
      }
      // x402scan / agent discovery: OpenAPI 3.1 at both /openapi.json and /.well-known/x402.
      if (parts[0] === "openapi.json" || (parts[0] === ".well-known" && parts[1] === "x402")) {
        res.setHeader("Link", '</api/inference/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"');
        return sendJson(res, 200, buildOpenApi(CFG));
      }
      return sendJson(res, 404, { error: "not found", try: ["/api/inference/infer (x402 POST)", "/api/inference/miners", "/api/inference/earnings/<addr>", "/api/inference/health", "/api/inference/.well-known/x402"] });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  });
});
server.listen(CFG.port, "127.0.0.1", () => console.log(`[inference-gateway] :${CFG.port} network=${CFG.network} mainnetOk=${CFG.mainnetOk} subnet=${CFG.subnetId} fee=${CFG.feeBps}bps price=$${CFG.priceUsd}`));
