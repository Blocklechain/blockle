// A reference TIER-0 (deterministic, checkable) subnet task: verifiable sequential
// compute. The challenge is derived from the public beacon; the answer is the input
// hashed `iters` times (a proof-of-sequential-work / lightweight VDF). It is "useful
// work" in the only honest sense available on-chain: its correctness is a PURE FUNCTION
// of public inputs, so a validator can VERIFY a miner's output by recomputing it — no
// subjective judgment, no oracle. Swap this module to define other Tier-0 tasks.
"use strict";
const crypto = require("node:crypto");

const DEFAULT_ITERS = Number(process.env.NEURON_ITERS || 50000);

/** Deterministic challenge for (beaconHex, round, minerUid). */
function challenge(beaconHex, round, minerUid) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(beaconHex, "hex"))
    .update(Buffer.from(String(round) + ":" + String(minerUid)))
    .digest("hex");
}

/** The task: iterate SHA-256 `iters` times over the challenge. Deterministic. */
function solve(challengeHex, iters = DEFAULT_ITERS) {
  let h = Buffer.from(challengeHex, "hex");
  for (let i = 0; i < iters; i++) h = crypto.createHash("sha256").update(h).digest();
  return h.toString("hex");
}

/** Verify a miner's answer by recomputing — the heart of Tier-0 scoring. */
function verify(challengeHex, answerHex, iters = DEFAULT_ITERS) {
  return solve(challengeHex, iters) === answerHex;
}

module.exports = { DEFAULT_ITERS, challenge, solve, verify };
