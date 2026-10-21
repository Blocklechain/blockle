// Blockle GAS SPONSOR — paid users never need to hold BLOCK to swap.
//
// BLOCK's VM funds a transaction's gas from the tx's OWN inputs (there is no
// separate fee-payer field), so a relayer cannot pay gas for a user's signed
// swap. Instead we DRIP a small BLOCK gas allowance to an entitled user's own
// address; the user then signs + broadcasts their swap normally. This keeps the
// wallet NON-CUSTODIAL (we never touch their keys or sign their swap) — we only
// sponsor the gas.
//
// Entitlement: the caller must be a signed-in Blockle account on a PAID tier
// (pro / copilot / copilot_pro — all PayPal subscriptions). Verified by calling
// the accounts service /account/api/me with the caller's forwarded cookie. Free
// users are refused (they can buy a little BLOCK or upgrade).
//
// Safety: fail-closed. Small per-grant cap, one grant per address per day, a
// global daily cap, and we DO NOT sponsor an address that already holds enough
// BLOCK for gas. The gas comes from the operator hot wallet (the same pooled
// wallet the WORLD game already gas-sponsors from); we never read the premine.
// Binds 127.0.0.1 only; nginx terminates TLS + proxies /api/gas/ in front.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---- config (env overrides) ------------------------------------------------
const cfg = {
  host: "127.0.0.1",
  port: Number(process.env.GAS_PORT || 8802),
  enabled: process.env.GAS_ENABLED !== "0",
  node: process.env.GAS_CHAIN_API || "http://127.0.0.1:8445",
  accounts: (process.env.GAS_ACCOUNTS_URL || "http://127.0.0.1:8930").replace(/\/+$/, ""),
  hotWalletFile: process.env.GAS_HOT_WALLET || "/var/lib/blockle-pool/wallet.json",
  wasmPkg: process.env.GAS_WASM_NODE || "/opt/world/app/packages/blockle-wasm-node",
  // amounts in BLOCK base units (1 BLOCK = 1e8)
  grantBase: BigInt(process.env.GAS_GRANT_BASE || "20000000"),      // 0.20 BLOCK ≈ ~10 swaps of gas
  skipAboveBase: BigInt(process.env.GAS_SKIP_ABOVE_BASE || "5000000"), // already has ≥0.05 BLOCK → no grant
  txFee: 100000n,                                                    // 0.001 BLOCK native-transfer fee
  perAddrPerDay: Number(process.env.GAS_PER_ADDR_PER_DAY || "1"),
  globalPerDay: Number(process.env.GAS_GLOBAL_PER_DAY || "2000"),
  statePath: process.env.GAS_STATE || "/var/lib/blockle-gas-sponsor/state.json",
};

const PAID_TIERS = new Set(["pro", "copilot", "copilot_pro"]);
const ADDR_RE = /^block1[0-9a-z]{20,100}$/;

// ---- BLOCK signer (same node-wasm the WORLD server uses) + node RPC ---------
const wasm = require(cfg.wasmPkg);
let _hot = null;
function hotWallet() {
  if (!_hot) {
    const j = JSON.parse(fs.readFileSync(cfg.hotWalletFile, "utf8"));
    _hot = { secret_hex: j.secret_hex, public_hex: j.public_hex, address: j.address };
  }
  return _hot;
}
async function nodeGet(p) {
  const r = await fetch(cfg.node + p, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("node " + r.status + " " + p);
  return r.json();
}
async function nodeRpc(method, params) {
  const r = await fetch(cfg.node + "/", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "gas", method, params: params || [] }),
  });
  const j = await r.json().catch(() => ({}));
  if (j && j.error) throw new Error("rpc " + method + ": " + JSON.stringify(j.error));
  return j.result;
}
async function spendableBase(addr) {
  const u = await nodeGet("/explorer/utxos/" + encodeURIComponent(addr)).catch(() => null);
  return u ? BigInt(Math.round(Number(u.spendable || 0))) : 0n;
}
async function sendBlock(to, amountBase) {
  const hot = hotWallet();
  const u = await nodeGet("/explorer/utxos/" + encodeURIComponent(hot.address));
  const utxos = (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }));
  const built = JSON.parse(wasm.build_transfer(hot.secret_hex, hot.public_hex, JSON.stringify(utxos), to, amountBase, cfg.txFee));
  if (!built.raw) throw new Error("build_transfer produced no tx");
  await nodeRpc("submitrawtransaction", [built.raw]);
  return built.txid;
}

// ---- rate-limit state (persisted so a restart can't reset the daily caps) ---
function utcDay() { const d = new Date(); return d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1) + "-" + d.getUTCDate(); }
let state = { day: utcDay(), global: 0, byAddr: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(cfg.statePath, "utf8"))); } catch { /* fresh */ }
function rollDay() { const d = utcDay(); if (state.day !== d) { state = { day: d, global: 0, byAddr: {} }; } }
function persist() { try { fs.mkdirSync(path.dirname(cfg.statePath), { recursive: true }); fs.writeFileSync(cfg.statePath, JSON.stringify(state)); } catch { /* best effort */ } }

// ---- entitlement: paid Blockle account? ------------------------------------
async function tierFromCookie(cookie) {
  if (!cookie) return "free";
  try {
    const r = await fetch(cfg.accounts + "/account/api/me", { headers: { cookie: cookie, accept: "application/json" } });
    if (!r.ok) return "free";
    const j = await r.json();
    const sub = j && j.user && j.user.sub;
    return sub && sub.active ? (sub.tier || "free") : "free";
  } catch { return "free"; }
}

// ---- HTTP -------------------------------------------------------------------
function corsOrigin(o) {
  if (!o) return null;
  if (/^https:\/\/([a-z0-9-]+\.)*blockle\.org$/i.test(o)) return o;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return o;
  return null;
}
const server = http.createServer((req, res) => {
  const allowed = corsOrigin(req.headers.origin);
  const cors = allowed ? {
    "access-control-allow-origin": allowed, "vary": "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-credentials": "true", "access-control-max-age": "600",
  } : {};
  const send = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(b) }, cors)); res.end(b); };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  if (req.method === "GET" && req.url.startsWith("/gas/info")) {
    return send(200, {
      enabled: cfg.enabled,
      grantBlock: Number(cfg.grantBase) / 1e8,
      perAddrPerDay: cfg.perAddrPerDay,
      note: "Paid tiers (pro/copilot) get sponsored BLOCK gas so they can swap without holding BLOCK.",
    });
  }

  if (req.method === "POST" && req.url.startsWith("/gas/sponsor")) {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
    req.on("end", async () => {
      try {
        if (!cfg.enabled) return send(503, { ok: false, error: "gas sponsorship disabled" });
        const body = JSON.parse(raw || "{}");
        const addr = String(body.address || "").trim();
        if (!ADDR_RE.test(addr)) return send(400, { ok: false, error: "invalid BLOCK address" });

        // entitlement — must be a signed-in PAID account
        const tier = await tierFromCookie(req.headers.cookie);
        if (!PAID_TIERS.has(tier)) return send(403, { ok: false, error: "gas sponsorship is a paid-plan perk", upgrade: "/copilot" });

        rollDay();
        if (state.global >= cfg.globalPerDay) return send(429, { ok: false, error: "daily sponsorship budget reached, try later" });
        if ((state.byAddr[addr] || 0) >= cfg.perAddrPerDay) return send(429, { ok: false, error: "already sponsored today", retryAfter: "tomorrow" });

        // don't over-fund — if they already have gas, no grant needed
        const have = await spendableBase(addr);
        if (have >= cfg.skipAboveBase) return send(200, { ok: true, skipped: "already-funded", haveBlock: Number(have) / 1e8 });

        const txid = await sendBlock(addr, cfg.grantBase);
        state.byAddr[addr] = (state.byAddr[addr] || 0) + 1; state.global += 1; persist();
        return send(200, { ok: true, txid: txid, amountBase: String(cfg.grantBase), amountBlock: Number(cfg.grantBase) / 1e8, tier: tier });
      } catch (e) {
        return send(502, { ok: false, error: "sponsor failed: " + (e && e.message || e) });
      }
    });
    return;
  }
  send(404, { error: "not found" });
});
server.listen(cfg.port, cfg.host, () => { console.log("gas-sponsor on " + cfg.host + ":" + cfg.port + " grant=" + (Number(cfg.grantBase) / 1e8) + " BLOCK enabled=" + cfg.enabled); });
module.exports = { server, cfg };
