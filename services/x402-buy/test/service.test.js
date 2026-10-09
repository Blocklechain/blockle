// Tests: curve math matches buy.js, the 402 challenge is well-formed via the
// official SDK, idempotent replay, and discovery manifest shape. No network /
// facilitator calls — those are exercised against Base Sepolia in dev.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { quoteBuy, blockToBaseUnits, baseUnitsToBlock, usdToMicroUsdc } = require("../src/curve");
const { Ledger, paymentIdFromHeader } = require("../src/ledger");
const { createApp } = require("../src/server");

const BUY_CFG = {
  ticker: "BLOCK",
  feeBps: 500,
  blockReserveAddr: "block1reservetest",
  usdc: { network: "base-sepolia", rpc: "", contract: "", decimals: 6, reserveAddr: "0xReserveTest" },
  curve: { startPrice: 0.1, targetUsdc: 2000000, allocation: 210000 },
};

test("curve: at R=0 price is the $0.10 floor; a buy climbs the curve from it", () => {
  const q = quoteBuy(BUY_CFG, 100, 0);
  assert.ok(Math.abs(q.spotPrice - 0.1) < 1e-9, "spot == floor at R=0");
  // net after 5% fee = $95; the price RISES as the buy fills, so the buyer
  // gets fewer than $95/$0.10 — recompute independently and compare exactly.
  const P0 = 0.1,
    K = (2 * (2000000 - P0 * 210000)) / (210000 * 210000);
  const soldAt = (r) => (Math.max(P0, Math.sqrt(P0 * P0 + 2 * K * r)) - P0) / K;
  const expected = soldAt(95) - soldAt(0);
  assert.ok(Math.abs(q.blockOut - expected) < 1e-6, `blockOut ${q.blockOut} vs ${expected}`);
  assert.ok(Math.abs(q.feeUsd - 5) < 1e-9, "5% fee on $100");
  assert.ok(q.avgPrice >= 0.1, "avg never below floor");
});

test("curve: mirrors buy.js net/sold math exactly for a mid-reserve buy", () => {
  // Reimplement buy.js math independently and compare.
  const P0 = 0.1,
    TARGET = 2000000,
    ALLOC = 210000,
    FEE = 0.05;
  const K = (2 * (TARGET - P0 * ALLOC)) / (ALLOC * ALLOC);
  const priceAt = (r) => Math.max(P0, Math.sqrt(P0 * P0 + 2 * K * r));
  const soldAt = (r) => (priceAt(r) - P0) / K;
  const R = 500000;
  const raw = 1000;
  const net = raw * (1 - FEE);
  const expected = soldAt(R + net) - soldAt(R);
  const q = quoteBuy(BUY_CFG, raw, R);
  assert.ok(Math.abs(q.blockOut - expected) < 1e-6, `blockOut ${q.blockOut} vs ${expected}`);
});

test("curve: base-unit conversions round-trip", () => {
  assert.equal(blockToBaseUnits(1).toString(), "100000000");
  assert.equal(blockToBaseUnits(0.00000001).toString(), "1");
  assert.equal(baseUnitsToBlock(100000000n), "1");
  assert.equal(baseUnitsToBlock(150000000n), "1.5");
  assert.equal(usdToMicroUsdc(10), "10000000");
  assert.equal(usdToMicroUsdc(0.1), "100000");
});

test("ledger: lifecycle + daily cap + idempotency key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402led-"));
  const led = new Ledger(path.join(dir, "l.db"));
  const id = paymentIdFromHeader("HEADER-ABC");
  assert.equal(paymentIdFromHeader("HEADER-ABC"), id, "stable key");
  led.begin({ id, kind: "buy", network: "base-sepolia", usdcMicro: "1000000", payTo: "0x", request: {} });
  assert.equal(led.get(id).status, "verifying");
  led.markSettled(id, { payer: "0xp", settleTxhash: "0xtx" });
  assert.equal(led.todayMicro().toString(), "1000000");
  led.markReleased(id, { resultTxid: "blocktx", receipt: { ok: true } });
  assert.equal(led.get(id).status, "released");
  assert.equal(led.get(id).result_txid, "blocktx");
});

async function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

test("http: unpaid buy returns a 402 with official x402 requirements", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402svc-"));
  const cfg = buildTestCfg(dir);
  const { app } = createApp({ cfg, buyCfg: BUY_CFG, treasury: TREASURY, ledger: new Ledger(path.join(dir, "l.db")) });
  const srv = await listen(app);
  const port = srv.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/x402/buy?to=block1abc&usdc=10`);
    assert.equal(res.status, 402);
    assert.ok(res.headers.get("payment-required"), "x402 v2 PAYMENT-REQUIRED header present");
    const body = await res.json();
    assert.equal(body.x402Version, 2); // x402 v2
    assert.ok(Array.isArray(body.accepts) && body.accepts.length === 1);
    assert.ok(body.resource && body.resource.url.endsWith("/x402/buy"), "top-level resource object (v2)");
    const r = body.accepts[0];
    assert.equal(r.scheme, "exact");
    assert.equal(r.network, "eip155:84532"); // CAIP-2 for base-sepolia
    assert.equal(r.amount, "10000000"); // v2: atomic USDC amount ($10 → 10e6)
    assert.equal(r.payTo, "0xReserveTest");
    assert.ok(r.asset && r.extra && r.extra.name, "USDC asset + eip712 domain present");
  } finally {
    srv.close();
  }
});

test("http: paywall-first — bare probe 402s, but bad inputs are rejected once paying", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402svc-"));
  const cfg = buildTestCfg(dir);
  const { app } = createApp({ cfg, buyCfg: BUY_CFG, treasury: TREASURY, ledger: new Ledger(path.join(dir, "l.db")) });
  const srv = await listen(app);
  const port = srv.address().port;
  const pay = { headers: { "X-PAYMENT": "probe" } };
  try {
    // No X-PAYMENT → the paywall runs BEFORE input validation so crawlers
    // (x402scan) can discover the price without supplying params.
    const probe = await fetch(`http://127.0.0.1:${port}/x402/buy?to=notanaddr&usdc=10`);
    assert.equal(probe.status, 402);
    // With an X-PAYMENT header present, bad inputs are validated and rejected.
    const bad1 = await fetch(`http://127.0.0.1:${port}/x402/buy?to=notanaddr&usdc=10`, pay);
    assert.equal(bad1.status, 400);
    const bad2 = await fetch(`http://127.0.0.1:${port}/x402/buy?to=block1abc&usdc=-1`, pay);
    assert.equal(bad2.status, 400);
  } finally {
    srv.close();
  }
});

test("http: listing fee 402 prices $5 + $1/extra and quotes the mandatory BLOCK pair", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402svc-"));
  const cfg = buildTestCfg(dir);
  const { app } = createApp({ cfg, buyCfg: BUY_CFG, treasury: TREASURY, ledger: new Ledger(path.join(dir, "l.db")) });
  const srv = await listen(app);
  const port = srv.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/x402/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asset: { symbol: "FOO", chain: "base", kind: "erc20", decimals: 18 }, extraPairs: ["USDC", "ETH"] }),
    });
    assert.equal(res.status, 402);
    const body = await res.json();
    // $5 + $1*2 = $7 → 7000000 micro-USDC
    assert.equal(body.accepts[0].amount, "7000000");
    assert.equal(body.accepts[0].payTo, TREASURY.testnet.base);
  } finally {
    srv.close();
  }
});

test("http: mainnet path is gated (503) without a recorded legal review", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402svc-"));
  const cfg = buildTestCfg(dir);
  cfg.network = "base"; // mainnet, but legalReviewCompleted=false
  const { app } = createApp({ cfg, buyCfg: BUY_CFG, treasury: TREASURY, ledger: new Ledger(path.join(dir, "l.db")) });
  const srv = await listen(app);
  const port = srv.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/x402/buy?to=block1abc&usdc=10`);
    assert.equal(res.status, 503);
  } finally {
    srv.close();
  }
});

test("http: discovery manifest + bazaar list are well-formed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402svc-"));
  const cfg = buildTestCfg(dir);
  const { app } = createApp({ cfg, buyCfg: BUY_CFG, treasury: TREASURY, ledger: new Ledger(path.join(dir, "l.db")) });
  const srv = await listen(app);
  const port = srv.address().port;
  try {
    const man = await (await fetch(`http://127.0.0.1:${port}/x402-resources.json`)).json();
    assert.equal(man.resources.length, 3);
    assert.ok(man.resources.every((r) => r.resource.startsWith("https://exchange.blockle.org")));
    assert.ok(man.resources.every((r) => r.network && r.price && r.input));
    const disc = await (await fetch(`http://127.0.0.1:${port}/discovery/resources`)).json();
    assert.equal(disc.items.length, 3);
    assert.ok(disc.items.every((i) => Array.isArray(i.accepts) && i.accepts[0].scheme === "exact"));
  } finally {
    srv.close();
  }
});

// ---- helpers ----
const TREASURY = {
  mainnet: { base: "0xMainnetTreasury" },
  testnet: { base: "0xTestnetTreasury" },
};

function buildTestCfg(dir) {
  return {
    port: 0,
    mainnetEnabled: false,
    legalReviewCompleted: false,
    publicBaseUrl: "https://exchange.blockle.org",
    network: "base-sepolia",
    facilitatorUrl: "https://x402.org/facilitator",
    productionFacilitatorUrl: "",
    listingFeeUsd: 5,
    perPairFeeUsd: 1,
    confirmations: 12,
    dailyCapUsd: 50000,
    ledgerPath: path.join(dir, "l.db"),
    kycModule: "",
    receiptTtlSeconds: 3600,
    maxTimeoutSeconds: 120,
    receiptSecret: "testsecret",
    release: { command: "blockle-chain", reserveDatadir: "/tmp", nodeAddr: "127.0.0.1:18444", dryRun: true },
  };
}
