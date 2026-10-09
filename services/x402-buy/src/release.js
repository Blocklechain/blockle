// Release BLOCK from the RESERVE wallet to the buyer. The reserve PRIVATE KEY
// lives in the node wallet / signer process — NEVER in this service. We only
// invoke the reserve wallet's CLI, which holds the key and signs + broadcasts:
//
//     blockle-chain --json --datadir <reserve> send \
//        --to <block1…> --amount <N BLOCK> --node 127.0.0.1:18444
//
// (--amount is a BLOCK decimal string; the CLI parses it to base units via the
// same parse_amount used by consensus.) The command, reserve datadir, and node
// address are all config, not constants. In dev, release.dryRun defaults true
// so a box without the reserve wallet never shells a missing binary — it
// returns a deterministic pseudo-txid instead, and the ledger records it so the
// idempotency/resume logic can still be exercised end to end.

"use strict";

const { execFile } = require("child_process");
const { baseUnitsToBlock } = require("./curve");

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${err.message} ${stderr || ""}`.trim()));
      resolve(String(stdout || ""));
    });
  });
}

function parseTxid(stdout) {
  // the CLI runs with --json; try to pull a txid out of its JSON, else trim.
  try {
    const j = JSON.parse(stdout);
    return j.txid || j.txId || j.hash || (j.result && j.result.txid) || null;
  } catch {
    const m = stdout.match(/[0-9a-fA-F]{64}/);
    return m ? m[0] : stdout.trim() || null;
  }
}

/**
 * Release `blockBaseUnits` (bigint) of BLOCK to `to`. Returns { txid, dryRun }.
 * Idempotency/ledger are the caller's responsibility — this only performs the
 * single release action.
 */
async function releaseBlock(cfg, to, blockBaseUnits, { idempotencyKey } = {}) {
  const amount = baseUnitsToBlock(blockBaseUnits);
  const rel = cfg.release;

  if (rel.dryRun) {
    const crypto = require("crypto");
    const seed = `${idempotencyKey || ""}:${to}:${blockBaseUnits}`;
    const txid = "dryrun-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 56);
    return { txid, dryRun: true, amount };
  }

  const args = [
    "--json",
    "--datadir",
    rel.reserveDatadir,
    "send",
    "--to",
    to,
    "--amount",
    amount,
    "--node",
    rel.nodeAddr,
  ];
  const stdout = await run(rel.command, args, (cfg.maxTimeoutSeconds || 120) * 1000);
  const txid = parseTxid(stdout);
  if (!txid) throw new Error(`release produced no txid; CLI output: ${stdout.slice(0, 200)}`);
  return { txid, dryRun: false, amount };
}

module.exports = { releaseBlock };
