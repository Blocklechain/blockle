// Integration test for the validator's real loop WITHOUT a chain:
// a mock HTTP node serves /explorer/intel + /subnet/0, two real miner HTTP servers answer
// challenges (one honest, one cheating), and validatorPass() fetches -> scores (by recomputing)
// -> emits the on-chain command plan. Proves the HTTP fetch/parse/round/beacon path + that a
// cheating miner over real HTTP scores 0, which the offline self-test can't cover.
"use strict";
const http = require("node:http");
const assert = require("node:assert");
const task = require("../src/task");
const { validatorPass } = require("../src/index");

const ITERS = 1000; // keep the test fast
const BEACON = "cd".repeat(32);
const EPOCH_LEN = 4;
const HEIGHT = 20; // round = 20/4 = 5

function listen(srv) { return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port))); }
function getJson(url) {
  return new Promise((res) => {
    http.get(url, (resp) => { let b = ""; resp.on("data", (c) => (b += c)); resp.on("end", () => { try { res(JSON.parse(b)); } catch { res(null); } }); })
      .on("error", () => res(null));
  });
}
function minerServer(honest) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname !== "/solve") { res.statusCode = 404; return res.end("{}"); }
    const c = u.searchParams.get("c");
    const answer = honest ? task.solve(c, ITERS) : "00".repeat(32); // cheater returns garbage
    res.end(JSON.stringify({ answer, ms: honest ? 15 : 2 }));
  });
}

(async () => {
  const honestSrv = minerServer(true), cheatSrv = minerServer(false);
  const honestPort = await listen(honestSrv), cheatPort = await listen(cheatSrv);
  const honestUrl = `http://127.0.0.1:${honestPort}`, cheatUrl = `http://127.0.0.1:${cheatPort}`;

  // mock node RPC: owners are the miner URLs so resolveUrl is identity
  const rpcSrv = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/explorer/intel") {
      return res.end(JSON.stringify({ active: true, activation_height: 0, height: HEIGHT,
        last_epoch_seed: BEACON, alpha_bps: 1000, epoch_len: EPOCH_LEN, pool: 123, subnet_count: 1, neuron_count: 3 }));
    }
    if (req.url === "/explorer/intel/subnet/0") {
      return res.end(JSON.stringify({ id: 0, tier: 0, neurons: [
        { uid: 0, role: 0, owner: honestUrl, bond: 1 },   // miner (honest)
        { uid: 1, role: 0, owner: cheatUrl, bond: 1 },    // miner (cheater)
        { uid: 9, role: 1, owner: "block1validator", bond: 10 }, // validator — must be ignored
      ] }));
    }
    res.statusCode = 404; res.end("{}");
  });
  const rpcPort = await listen(rpcSrv);
  const rpc = `http://127.0.0.1:${rpcPort}`;

  const ask = async (m, c) => {
    if (!m.url) return null;
    const j = await getJson(`${m.url}/solve?c=${c}`);
    return j && j.answer ? { answer: j.answer, ms: j.ms } : null;
  };
  const r = await validatorPass({ rpc, subnet: 0, iters: ITERS, getJson, ask, resolveUrl: (owner) => owner });

  try {
    assert.strictEqual(r.round, 5, "round = height/epoch_len");
    assert.strictEqual(r.beacon, BEACON, "beacon = last_epoch_seed from RPC");
    assert.strictEqual(r.minerCount, 2, "only role==0 neurons are scored (validator ignored)");
    const w = Object.fromEntries(r.scored.uids.map((u, i) => [u, r.scored.weights[i]]));
    assert.strictEqual(w[0], 1_000_000, "honest miner gets all weight");
    assert.strictEqual(w[1], 0, "cheating miner (real HTTP, wrong answer) gets 0");
    assert.strictEqual(r.plan.length, 3, "plan = commit, reveal, validate");
    assert.strictEqual(r.plan[0][0], "commit-weights");
    assert.strictEqual(r.plan[0][4], "0:1000000,1:0", "committed weight vector");
    assert.strictEqual(r.plan[1][0], "reveal-weights");
    assert.strictEqual(r.plan[2][0], "validate");
    console.log("PASS: fetched RPC, scored over real HTTP (honest=1e6, cheater=0), plan =", r.plan.map((p) => p[0]).join(" -> "));
    process.exit(0);
  } catch (e) {
    console.error("FAIL:", e.message);
    process.exit(1);
  } finally {
    honestSrv.close(); cheatSrv.close(); rpcSrv.close();
  }
})();
