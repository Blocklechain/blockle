#!/usr/bin/env node
// blockle-inference — reference daemon for the Tier-2 INFERENCE subnet.
//
//   miner      run next to your own GPU model server; serves /infer (see miner.js).
//   validator  each epoch, probe miners with a beacon-selected prompt, score them
//              (demand + quality + liveness, validator.js), drive commit→reveal→validate
//              via the `blockle intel` CLI.
//   gateway    the paid x402 endpoint WE own; routes to miners, takes the protocol fee,
//              falls back to wholesale. (Live gateway wiring reuses the beacon x402 glue;
//              this reference exposes the routing/fee core via gateway.js.)
//
// `--self-test` proves the money + scoring logic offline (no chain, no network, no model):
//   • gateway routes to a healthy miner and splits the fee correctly (treasury earns, we pay no GPU)
//   • gateway falls back to wholesale priced below our price → still net-positive (never a loss)
//   • validator ranks a paying, quality miner far above a garbage/offline one
"use strict";
const { route } = require("./gateway");
const validator = require("./validator");

function has(k) { return process.argv.includes("--" + k); }
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

async function selfTest() {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };

  // 1) gateway routes to a healthy miner; treasury keeps the fee, miner is owed the rest.
  const miners = [
    { uid: 1, url: "http://down", healthy: false },           // unhealthy → skipped
    { uid: 2, url: "http://good", healthy: true },            // serves
  ];
  const call = async (m, reqst) => {
    if (m.uid === 2) return { answer: `answer to: ${reqst.prompt}`, ms: 120 };
    throw new Error("down");
  };
  const r1 = await route({ request: { prompt: "hi" }, miners, priceUsd: 0.05, feeBps: 2000, call });
  ok(r1.ok && r1.servedBy.kind === "miner" && r1.servedBy.uid === 2, "served by healthy miner 2");
  ok(r1.accounting.protocolFeeUsd === 0.01, `fee 20% of $0.05 = $0.01 (got ${r1.accounting.protocolFeeUsd})`);
  ok(r1.accounting.minerEarnsUsd === 0.04, `miner owed $0.04 (got ${r1.accounting.minerEarnsUsd})`);
  ok(r1.accounting.netToTreasuryUsd === 0.01 && r1.accounting.wholesaleCostUsd === 0, "treasury nets fee, we paid no GPU");

  // 2) all miners fail → wholesale fallback priced BELOW our price → still net-positive.
  const r2 = await route({
    request: { prompt: "hi" }, miners: [{ uid: 1, url: "http://down", healthy: true }], priceUsd: 0.05, feeBps: 2000,
    call: async () => { throw new Error("down"); },
    wholesale: { costUsd: 0.02, call: async () => ({ answer: "wholesale answer", ms: 300 }) },
  });
  ok(r2.ok && r2.servedBy.kind === "wholesale", "fell back to wholesale");
  ok(r2.accounting.netToTreasuryUsd === 0.03, `wholesale nets $0.05-$0.02=$0.03 (got ${r2.accounting.netToTreasuryUsd})`);

  // 3) validator ranks a paying + quality miner far above a garbage/offline one.
  const probe = { prompt: "What is 2+2?", challengeHex: "ab".repeat(32) };
  const vMiners = [
    { uid: 10, url: "http://good", revenueUsd: 4.0 },  // earns real x402 + good answer
    { uid: 11, url: "http://bad", revenueUsd: 0.0 },   // no demand, garbage answer
    { uid: 12, url: null, revenueUsd: 0.0 },           // offline, no demand
  ];
  const ask = async (m, _p) => {
    if (m.uid === 10) return { answer: "4", ms: 200 };
    if (m.uid === 11) return { answer: "banana", ms: 150 };
    return null;
  };
  const judge = async (_p, a) => (a === "4" ? 1.0 : 0.0);
  const vr = await validator.score(probe, vMiners, ask, judge);
  const w = Object.fromEntries(vr.uids.map((u, i) => [u, vr.weights[i]]));
  ok(w[10] > 900_000, `paying+quality miner dominates (got ${w[10]})`);
  ok(w[11] >= 0 && w[11] < 50_000, `garbage miner near-zero (got ${w[11]})`);
  ok(w[12] === 0, `offline+no-demand miner is zero (got ${w[12]})`);
  ok(vr.weights.reduce((s, x) => s + x, 0) === validator.SCALE, "weights sum to SCALE");

  if (fails.length) { console.error("FAIL:\n - " + fails.join("\n - ")); process.exit(1); }
  console.log("PASS: gateway fee-split (miner + wholesale paths) + inference scoring all correct");
  console.log(`  routed: miner uid${r1.servedBy.uid} earns $${r1.accounting.minerEarnsUsd}, treasury $${r1.accounting.netToTreasuryUsd}; wholesale net $${r2.accounting.netToTreasuryUsd}`);
  console.log(`  weights: ${validator.weightsArg(vr.uids, vr.weights)}`);
  process.exit(0);
}

if (require.main === module) {
  (async () => {
    if (has("self-test")) return selfTest();
    const role = arg("role", "miner");
    if (role === "miner") return require("./miner").serve();
    console.log(`[inference:${role}] reference daemon. Live gateway/validator wiring needs the x402 rail + a running node (see README).`);
  })();
}

module.exports = { route, validator };
