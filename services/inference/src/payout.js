#!/usr/bin/env node
// Gated USDC payout — pay miners their accrued USDC on Base with ZERO gas to us.
//
// HOW (0 gas, ever): we pay each miner via an x402 gasless settlement. The treasury SIGNS an
// EIP-3009 `transferWithAuthorization` (just a signature — no on-chain tx, no gas) naming the
// miner's Base address as payTo, and the x402 FACILITATOR submits it on-chain and pays the gas.
// So the treasury needs USDC to pay out but needs NO ETH for gas — the facilitator eats it.
// Works for any miner with a Base address (daemon or browser). The treasury still keeps its
// skim (feeBps) from what the buyer paid.
//
// REAL MONEY: dry-run by default. A live payout requires INFERENCE_PAYOUT_OK=1 +
// INFERENCE_PAYOUT_KEY (treasury Base private key, from secrets). Never auto-run — operator runs it.
// Run from the service dir with NODE_PATH pointing at the x402 deps (x402 + viem).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DATA = process.env.INFERENCE_DATA || path.join(__dirname, "..", "data");
const FACILITATOR = process.env.INFERENCE_FACILITATOR || "https://x402.org/facilitator";
const NETWORK = process.env.INFERENCE_NETWORK || "base";
const MIN = Number(process.env.INFERENCE_PAYOUT_MIN_USD || 1); // skip dust (avoid spamming the facilitator)
const LIVE = process.env.INFERENCE_PAYOUT_OK === "1";

const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f))); } catch { return {}; } };
const save = (f, o) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(o));
const r6 = (x) => Math.round((Number(x) || 0) * 1e6) / 1e6;
const micro = (usd) => String(Math.floor(usd * 1e6)); // USDC has 6 decimals

async function main() {
  const owed = load("owed-usdc.json");
  const addrs = load("payout-addrs.json");
  const due = Object.entries(owed)
    .map(([blk, e]) => ({ blk, owed: r6(Number(e.owed || 0)), base: addrs[blk] }))
    .filter((x) => x.owed >= MIN && x.base);
  const noAddr = Object.entries(owed).filter(([blk, e]) => Number(e.owed || 0) >= MIN && !addrs[blk]).map(([blk]) => blk);
  if (noAddr.length) console.log(`(${noAddr.length} miner(s) owed ≥ $${MIN} but have no Base payout address — skipped)`);
  if (!due.length) { console.log("nothing to pay out."); return; }

  const total = r6(due.reduce((s, x) => s + x.owed, 0));
  console.log(`${due.length} miner(s) due, $${total} USDC total (min $${MIN}/miner), via gasless x402 settlement on ${NETWORK}:`);
  due.forEach((x) => console.log(`  ${x.blk.slice(0, 16)}… -> ${x.base}   $${x.owed} USDC`));
  if (!LIVE) { console.log("\nDRY RUN — set INFERENCE_PAYOUT_OK=1 + INFERENCE_PAYOUT_KEY to pay (0 gas; facilitator settles)."); return; }

  const key = process.env.INFERENCE_PAYOUT_KEY;
  if (!key) { console.error("INFERENCE_PAYOUT_KEY not set — refusing to pay."); process.exit(1); }
  const { buildRequirements, verifyAndSettle } = require("./x402");
  const { createPaymentHeader } = require("x402/client");
  const { privateKeyToAccount } = require("viem/accounts");
  const account = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);

  const log = load("payout-log.json"); if (!Array.isArray(log.entries)) log.entries = [];
  for (const x of due) {
    try {
      // Build the miner-as-payee requirements; the treasury signs the gasless authorization.
      const requirements = buildRequirements({
        network: NETWORK, payTo: x.base, maxAmountRequired: micro(x.owed),
        resource: `blockle:inference-payout:${x.blk}`, description: "Blockle inference miner payout",
        maxTimeoutSeconds: 600,
      });
      const header = await createPaymentHeader(account, 2, requirements); // EIP-3009 sign (no gas)
      const vs = await verifyAndSettle({ facilitatorUrl: FACILITATOR, xPaymentHeader: header, requirements });
      if (!vs || !vs.ok) { console.error(`  FAILED ${x.base}: ${(vs && vs.error) || "settle rejected"}`); continue; }
      const o = load("owed-usdc.json");
      const e = o[x.blk] || { owed: 0, paid: 0 };
      e.owed = Math.max(0, r6(e.owed - x.owed)); e.paid = r6((e.paid || 0) + x.owed);
      o[x.blk] = e; save("owed-usdc.json", o);
      log.entries.push({ blk: x.blk, base: x.base, usdc: x.owed, txHash: vs.txHash || null }); save("payout-log.json", log);
      console.log(`  PAID ${x.base}  $${x.owed} USDC  ${vs.txHash || "(settled)"}`);
    } catch (e) {
      console.error(`  FAILED ${x.base}: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
