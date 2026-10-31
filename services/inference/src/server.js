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
};
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

  const miners = await liveMiners();
  const r = await route({
    request: { prompt: body.prompt || "", temperature: body.temperature, max_tokens: body.max_tokens },
    miners, priceUsd: CFG.priceUsd, feeBps: CFG.feeBps, call: callMiner,
    wholesale: { costUsd: 0, call: callBootstrap }, // CPU bootstrap: our marginal cost ≈ 0
  });
  if (!r.ok) return sendJson(res, 503, { error: "no miner or bootstrap backend available" });

  // Credit the serving miner's epoch revenue (the validator's demand signal).
  if (r.servedBy.kind === "miner") {
    const m = miners.find((x) => x.uid === r.servedBy.uid);
    if (m) recordEarning(m.address, r.accounting.minerEarnsUsd);
  }
  const out = {
    answer: r.answer, servedBy: r.servedBy, model: r.model || null,
    accounting: r.accounting, tier: 2, payer: vs.payer, txHash: vs.txHash,
    note: r.servedBy.kind === "wholesale" ? "served by CPU bootstrap model (not competitive) — no GPU miners online yet" : undefined,
  };
  results[pid] = out; saveJson(RESULTS_FILE, results);
  return sendJson(res, 200, out);
}

// ---- server -----------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-payment", "access-control-allow-methods": "GET,POST,OPTIONS" }); return res.end(); }
  const u = new URL(req.url, "http://x");
  const parts = u.pathname.replace(/^\/api\/inference/, "").split("/").filter(Boolean);
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    const body = b ? (() => { try { return JSON.parse(b); } catch { return {}; } })() : {};
    try {
      if (!parts.length || parts[0] === "health") return sendJson(res, 200, { ok: true, network: CFG.network, mainnetOk: CFG.mainnetOk, subnet: CFG.subnetId, priceUsd: CFG.priceUsd, feeBps: CFG.feeBps, miners: (await liveMiners()).length });
      if (parts[0] === "infer" && req.method === "POST") return handleInfer(req, res, body);
      if (parts[0] === "miners") return sendJson(res, 200, { miners: (await liveMiners()).map((m) => ({ uid: m.uid, address: m.address, epochUsd: m.revenueUsd })) });
      if (parts[0] === "earnings") { // /earnings/<address>  (read-only; what a miner watches)
        const addr = parts[1] || u.searchParams.get("address") || "";
        const e = loadJson(REVENUE_FILE)[addr] || { epochUsd: 0, totalUsd: 0, requests: 0 };
        return sendJson(res, 200, { address: addr, ...e });
      }
      if (parts[0] === "announce" && req.method === "POST") { // miner posts its serving URL
        if (!body.uid || !body.url || !body.address) return sendJson(res, 400, { error: "need {uid,address,url}" });
        const m = loadJson(MINERS_FILE); m[String(body.uid)] = { uid: Number(body.uid), address: body.address, url: body.url, ts: Date.now() }; saveJson(MINERS_FILE, m);
        return sendJson(res, 200, { ok: true, registered: m[String(body.uid)] });
      }
      if (parts[0] === ".well-known" && parts[1] === "x402") {
        return sendJson(res, 200, { x402Version: 2, name: "Blockle Inference", description: "Tier-2 inference subnet. Paid requests route to community GPU miners; a small hosted CPU model is the labeled bootstrap fallback. Emission is capped (subjective tier).", network: CFG.network, facilitator: CFG.facilitatorUrl, accepts: [{ resource: `${CFG.publicBase}/infer`, method: "POST", price: `$${CFG.priceUsd}`, description: "Inference. Response includes servedBy + model so you see exactly what produced it.", input: { prompt: "string", temperature: "optional", max_tokens: "optional" } }] });
      }
      return sendJson(res, 404, { error: "not found", try: ["/api/inference/infer (x402 POST)", "/api/inference/miners", "/api/inference/earnings/<addr>", "/api/inference/health", "/api/inference/.well-known/x402"] });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  });
});
server.listen(CFG.port, "127.0.0.1", () => console.log(`[inference-gateway] :${CFG.port} network=${CFG.network} mainnetOk=${CFG.mainnetOk} subnet=${CFG.subnetId} fee=${CFG.feeBps}bps price=$${CFG.priceUsd}`));
