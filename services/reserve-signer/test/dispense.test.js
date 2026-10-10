"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { dispense, baseToBlock, BLOCK_ADDR, parseTxid } = require("../index.js");

const RECV = "block1yyvhau7c2kwy4s60kqrysz6prf2k693kvyx94h9ve4qa8fulwy8q99vvdh";

function cfg(over) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  return Object.assign(
    {
      chainBin: "/bin/false", // never actually invoked in the dry-run tests
      reserveDatadir: d,
      nodeAddr: "127.0.0.1:18444",
      network: "mainnet",
      mainnetEnabled: false,
      legalReviewCompleted: false,
      dryRun: true,
      seedDestination: "",
      dailyCapBlock: 1000,
      maxAmountBlock: 200,
      feeBlock: "0.0001",
      authToken: "",
      auditLog: path.join(d, "a.jsonl"),
      ledger: path.join(d, "l.jsonl"),
    },
    over || {},
  );
}

test("baseToBlock conversions", () => {
  assert.equal(baseToBlock("100000000"), "1");
  assert.equal(baseToBlock("150000000"), "1.5");
  assert.equal(baseToBlock("1"), "0.00000001");
  assert.equal(baseToBlock("500000000000"), "5000");
});

test("BLOCK_ADDR validates", () => {
  assert.ok(BLOCK_ADDR.test(RECV));
  assert.ok(!BLOCK_ADDR.test("0xabc"));
  assert.ok(!BLOCK_ADDR.test("block1"));
});

test("parseTxid json + hex", () => {
  assert.equal(parseTxid('{"txid":"ab"}'), "ab");
  assert.equal(parseTxid("noise " + "a".repeat(64)), "a".repeat(64));
});

test("dry-run (not live) returns a dryrun txid and sends nothing", async () => {
  const r = await dispense(cfg(), { to: RECV, amountBase: "500000000", purpose: "listing-liquidity-seed" });
  assert.ok(r.dryRun);
  assert.match(r.txid, /^dryrun-/);
});

test("gated: mainnet+legal true but dryRun true still dry-runs", async () => {
  const r = await dispense(cfg({ mainnetEnabled: true, legalReviewCompleted: true, dryRun: true }), {
    to: RECV,
    amountBase: "100000000",
    purpose: "x",
  });
  assert.ok(r.dryRun);
});

test("rejects a bad recipient", async () => {
  await assert.rejects(dispense(cfg(), { to: "0xbad", amountBase: "1", purpose: "x" }));
});

test("rejects a non-positive amount", async () => {
  await assert.rejects(dispense(cfg(), { to: RECV, amountBase: "0", purpose: "x" }));
});

test("enforces the per-dispense cap", async () => {
  await assert.rejects(dispense(cfg({ maxAmountBlock: 10 }), { to: RECV, amountBase: "5000000000", purpose: "x" }));
});

test("enforces the daily cap from the ledger", async () => {
  const c = cfg({ dailyCapBlock: 5 });
  fs.mkdirSync(path.dirname(c.ledger), { recursive: true });
  fs.writeFileSync(c.ledger, JSON.stringify({ t: Math.floor(Date.now() / 1000), block: 4.9 }) + "\n");
  await assert.rejects(dispense(c, { to: RECV, amountBase: "100000000", purpose: "x" }), /daily dispense cap/);
});
