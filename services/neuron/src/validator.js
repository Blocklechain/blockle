// Validator scoring for the reference Tier-0 subnet. Pure + injectable so it unit-tests
// without a chain or network: `score(beacon, round, miners, ask)` asks each miner for its
// answer (via the injected `ask`), VERIFIES it by recomputing (task.verify), and assigns a
// weight — correct + fast => high, wrong/absent => 0. This is proof-of-CORRECTNESS, not
// just liveness: a miner that fakes answers scores 0 because the validator recomputes.
"use strict";
const task = require("./task");
const SCALE = 1_000_000;

/**
 * @param beaconHex  the current epoch beacon (hex)
 * @param round      integer round/epoch
 * @param miners     [{uid, url?}]
 * @param ask        async (miner, challengeHex) -> { answer, ms } | null
 * @param iters      task difficulty
 * returns { uids:[...], weights:[u32...], detail:[{uid,correct,ms,raw}] }
 */
async function score(beaconHex, round, miners, ask, iters = task.DEFAULT_ITERS) {
  const detail = [];
  for (const m of miners) {
    const c = task.challenge(beaconHex, round, m.uid);
    let correct = false;
    let ms = null;
    try {
      const r = await ask(m, c);
      if (r && typeof r.answer === "string") {
        correct = task.verify(c, r.answer, iters);
        ms = Number(r.ms);
      }
    } catch (_) {
      /* unreachable miner => scores 0 */
    }
    // raw score: correct earns 1.0, scaled down by latency (fast miners earn more).
    // A wrong or absent answer earns exactly 0 — the anti-fake guarantee.
    const raw = correct ? 1 / (1 + Math.max(0, (ms || 0)) / 1000) : 0;
    detail.push({ uid: m.uid, correct, ms, raw });
  }
  const total = detail.reduce((s, d) => s + d.raw, 0) || 1;
  const uids = detail.map((d) => d.uid);
  const weights = detail.map((d) => Math.round((d.raw / total) * SCALE));
  // fix rounding so the vector sums to exactly SCALE (deterministic on-chain match)
  const diff = SCALE - weights.reduce((s, w) => s + w, 0);
  if (weights.length) {
    let top = 0;
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[top]) top = i;
    weights[top] += diff;
  }
  return { uids, weights, detail };
}

/** Format weights for the `blockle intel commit-weights --weights` arg. */
function weightsArg(uids, weights) {
  return uids.map((u, i) => `${u}:${weights[i]}`).join(",");
}

module.exports = { score, weightsArg, SCALE };
