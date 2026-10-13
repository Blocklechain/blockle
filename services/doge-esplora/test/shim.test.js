"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { handle } = require("../index.js");

// A fake address-indexed dogecoind.
function fakeRpc(responses) {
  return async (method, params) => {
    if (!(method in responses)) throw new Error("unexpected rpc " + method);
    const v = responses[method];
    return typeof v === "function" ? v(params) : v;
  };
}

test("GET /address/:a maps getaddressbalance -> esplora chain_stats", async () => {
  const rpc = fakeRpc({
    getaddressbalance: { balance: 300000000, received: 500000000 }, // funded 5 DOGE, spent 2
    getaddresstxids: ["a", "b", "c"],
  });
  const out = await handle("GET", "/address/DABC", "", rpc);
  assert.equal(out.status, 200);
  assert.equal(out.json.chain_stats.funded_txo_sum, 500000000);
  assert.equal(out.json.chain_stats.spent_txo_sum, 200000000); // received - balance
  assert.equal(out.json.chain_stats.tx_count, 3);
});

test("GET /address/:a/utxo maps getaddressutxos -> {txid,vout,value}", async () => {
  const rpc = fakeRpc({
    getaddressutxos: [{ txid: "deadbeef", outputIndex: 1, satoshis: 123456, height: 42 }],
  });
  const out = await handle("GET", "/address/DABC/utxo", "", rpc);
  assert.equal(out.status, 200);
  assert.deepEqual(out.json[0], { txid: "deadbeef", vout: 1, value: 123456, status: { confirmed: true, block_height: 42 } });
});

test("POST /tx relays a signed raw tx via sendrawtransaction", async () => {
  let sent = null;
  const rpc = fakeRpc({ sendrawtransaction: (p) => { sent = p[0]; return "txid123"; } });
  const out = await handle("POST", "/tx", "0100000001aabb", rpc);
  assert.equal(out.status, 200);
  assert.equal(out.text, "txid123");
  assert.equal(sent, "0100000001aabb");
});

test("POST /tx rejects a non-hex body (never hits the node)", async () => {
  let called = false;
  const rpc = fakeRpc({ sendrawtransaction: () => { called = true; return "x"; } });
  const out = await handle("POST", "/tx", "not-hex!!", rpc);
  assert.equal(out.status, 400);
  assert.equal(called, false);
});

test("the /api prefix convention + unknown path 404", async () => {
  const rpc = fakeRpc({ getaddressbalance: { balance: 0, received: 0 }, getaddresstxids: [] });
  // handle() receives the already-stripped path; assert 404 on an unknown one.
  const out = await handle("GET", "/nope", "", rpc);
  assert.equal(out.status, 404);
});

test("GET /healthz reports synced only when blocks==headers and IBD false", async () => {
  const out = await handle("GET", "/healthz", "", fakeRpc({
    getblockchaininfo: { chain: "main", blocks: 100, headers: 100, initialblockdownload: false },
  }));
  assert.equal(out.json.synced, true);
  const out2 = await handle("GET", "/healthz", "", fakeRpc({
    getblockchaininfo: { chain: "main", blocks: 50, headers: 100, initialblockdownload: true },
  }));
  assert.equal(out2.json.synced, false);
});
