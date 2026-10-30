#!/usr/bin/env node
// blockle-neuron — the reference Tier-0 subnet daemon.
//
//   miner:     serves the verifiable task over HTTP (answers beacon-derived challenges).
//   validator: each epoch, fetches the subnet's miners + beacon from the node HTTP RPC, scores
//              them by RECOMPUTING their answers (proof-of-correctness), and drives the
//              on-chain commit -> reveal -> validate flow via the `blockle intel` CLI (shelled;
//              dry-run by default so nothing is submitted without --submit).
//
// Two node endpoints, deliberately distinct:
//   --rpc  http://host:8445   the HTTP explorer RPC (read miners + epoch beacon)
//   --p2p  host:18444         the node's P2P listen addr (the CLI's `--node`, for submitting)
//
// This is the honest "useful work" loop: the task is Tier-0 (checkable), so emission tracks
// provably-correct output. It needs a running node to submit on-chain; `--self-test` proves
// the task + scoring loop end-to-end WITHOUT a chain or network.
"use strict";
const http = require("node:http");
const https = require("node:https");
const { execFileSync } = require("node:child_process");
const task = require("./task");
const validator = require("./validator");

const CFG = {
  role: arg("role", "validator"),
  subnet: Number(arg("subnet", "0")),
  port: Number(arg("port", process.env.NEURON_PORT || 8812)),
  rpc: arg("rpc", process.env.NEURON_RPC || "http://127.0.0.1:8445"),
  p2p: arg("p2p", process.env.NEURON_P2P || "127.0.0.1:18444"),
  bin: arg("bin", process.env.NEURON_BIN || "blockle-chain"),
  network: arg("network", "testnet"),
  datadir: arg("datadir", ".blockle"),
  iters: Number(arg("iters", String(task.DEFAULT_ITERS))),
  submit: has("submit"), // without this, on-chain ops are printed (dry-run), not executed
};
function arg(k, d) { const i = process.argv.indexOf("--" + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
function has(k) { return process.argv.includes("--" + k); }

function httpGetJson(url) {
  return new Promise((res) => {
    const lib = url.startsWith("https") ? https : http;
    const r = lib.get(url, { timeout: 8000 }, (resp) => { let b = ""; resp.on("data", (c) => (b += c)); resp.on("end", () => { try { res(JSON.parse(b)); } catch { res(null); } }); });
    r.on("error", () => res(null)); r.on("timeout", () => { r.destroy(); res(null); });
  });
}

// ---- miner: serve the task ----
function runMiner() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/health") { res.end(JSON.stringify({ ok: true, role: "miner", iters: CFG.iters })); return; }
    if (u.pathname === "/solve") {
      const c = u.searchParams.get("c") || "";
      const t0 = Date.now();
      const answer = task.solve(c, CFG.iters);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answer, ms: Date.now() - t0 }));
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  srv.listen(CFG.port, () => console.log(`[neuron:miner] serving the Tier-0 task on :${CFG.port} (iters=${CFG.iters})`));
  return srv;
}

// ---- validator core: fetch -> score -> emit the on-chain command plan ----
// Pure-ish and injectable: pass getJson/ask/resolveUrl so it tests without a chain or network.
// Returns { scored, plan: [[cliArgs...], ...] }. plan is what SHOULD be submitted this pass.
async function validatorPass(opts) {
  const { rpc, subnet, iters, getJson, ask, resolveUrl } = opts;
  const info = await getJson(`${rpc}/explorer/intel`);
  if (!info || info.alpha_bps === undefined) throw new Error("node has no intel RPC (testnet node not up / RPC unreachable?)");
  const beacon = info.last_epoch_seed || "00".repeat(32);
  const round = Math.floor((info.height || 0) / (info.epoch_len || 360));
  const sub = await getJson(`${rpc}/explorer/intel/subnet/${subnet}`);
  const miners = ((sub && sub.neurons) || []).filter((n) => n.role === 0)
    .map((n) => ({ uid: n.uid, url: resolveUrl(n.owner) }));
  if (!miners.length) return { scored: null, plan: [], round, beacon, minerCount: 0 };
  const scored = await validator.score(beacon, round, miners, ask, iters);
  const w = validator.weightsArg(scored.uids, scored.weights);
  const plan = [
    ["commit-weights", "--subnet", String(subnet), "--weights", w],
    ["reveal-weights", "--subnet", String(subnet)],
    ["validate", "--subnet", String(subnet)],
  ];
  return { scored, plan, round, beacon, minerCount: miners.length };
}

// miner discovery: owner (base58 address string from the RPC) -> HTTP serving URL.
// Deployment-specific — wire a registry/DNS/announce here. Returns null if unknown.
function resolveMinerUrl(_owner) { return null; }

async function askHttp(miner, challengeHex) {
  if (!miner.url) return null;
  const j = await httpGetJson(`${miner.url.replace(/\/$/, "")}/solve?c=${challengeHex}`);
  return j && j.answer ? { answer: j.answer, ms: j.ms } : null;
}

function execCli(args) {
  const full = ["--network", CFG.network, "--datadir", CFG.datadir, "intel", ...args, "--node", CFG.p2p];
  if (!CFG.submit) { console.log(`  [dry-run] ${CFG.bin} ${full.join(" ")}`); return; }
  try { execFileSync(CFG.bin, full, { stdio: "inherit" }); } catch (e) { console.error("  CLI failed:", e.message); }
}

async function runValidatorOnce() {
  let r;
  try {
    r = await validatorPass({ rpc: CFG.rpc, subnet: CFG.subnet, iters: CFG.iters, getJson: httpGetJson, ask: askHttp, resolveUrl: resolveMinerUrl });
  } catch (e) { console.error("[neuron:validator]", e.message); return; }
  if (!r.minerCount) { console.log("[neuron:validator] no miners in subnet", CFG.subnet); return; }
  console.log(`[neuron:validator] round ${r.round} scored ${r.minerCount} miners:`,
    r.scored.detail.map((d) => `uid${d.uid}:${d.correct ? "✓" : "✗"}`).join(" "));
  for (const step of r.plan) execCli(step);
}

// ---- self-test: prove the loop with no chain/network ----
async function selfTest() {
  const beacon = "ab".repeat(32);
  const round = 7;
  const miners = [{ uid: 0, kind: "honest" }, { uid: 1, kind: "cheater" }, { uid: 2, kind: "offline" }];
  const ask = async (m, c) => {
    if (m.kind === "offline") return null;
    if (m.kind === "cheater") return { answer: "00".repeat(32), ms: 5 };
    return { answer: task.solve(c, task.DEFAULT_ITERS), ms: 20 }; // honest recompute
  };
  const r = await validator.score(beacon, round, miners, ask);
  console.log("self-test weights (uid:weight):", validator.weightsArg(r.uids, r.weights));
  const w = Object.fromEntries(r.uids.map((u, i) => [u, r.weights[i]]));
  const ok = w[0] === validator.SCALE && w[1] === 0 && w[2] === 0;
  if (ok) { console.log("PASS: honest miner gets all weight; cheater + offline get 0"); process.exit(0); }
  console.error("FAIL:", w); process.exit(1);
}

module.exports = { validatorPass, resolveMinerUrl };

if (require.main === module) {
  (async () => {
    if (has("self-test")) return selfTest();
    if (CFG.role === "miner") return runMiner();
    console.log(`[neuron:validator] subnet ${CFG.subnet}, rpc ${CFG.rpc}, p2p ${CFG.p2p}, submit=${CFG.submit}`);
    await runValidatorOnce();
  })();
}
