// Validator scoring for the Tier-2 INFERENCE subnet. Inference is NOT bit-reproducible,
// so unlike the Tier-0 task (services/neuron) we cannot verify by recomputation. We score
// miners on three honest signals and combine them — then the result is emission-CAPPED at
// the chain level because this is subjective work (spec §4, tier 2):
//
//   1. demand   — real x402 USDC revenue the miner earned serving paid traffic this epoch.
//                 This is the HARD-to-game signal and our edge over Bittensor: paying
//                 customers, not validator opinion, drive most of the weight.
//   2. quality  — a reference judge scores the miner's answer to a beacon-selected probe
//                 (0..1). Subjective, so it's the SMALLER weight and only a sanity gate.
//   3. liveness — did the miner answer the probe at all, within latency budget.
//
// Pure + injectable: inject `ask` (probe the miner) and `judge` (score an answer) so it
// unit-tests with no network, no chain, no model.
"use strict";
const SCALE = 1_000_000;

const DEFAULTS = { wDemand: 0.7, wQuality: 0.25, wLiveness: 0.05, latencyBudgetMs: 60_000 };

/**
 * @param probe    { prompt, challengeHex } beacon-selected probe for this epoch
 * @param miners   [{ uid, url?, revenueUsd? }]   revenueUsd = x402 earned this epoch
 * @param ask      async (miner, prompt) -> { answer, ms } | null
 * @param judge    async (prompt, answer) -> number in [0,1]   (reference/judge quality)
 * @param opts     weights + latency budget
 * returns { uids, weights:[u32…], detail:[{uid, live, ms, quality, demand, raw}] }
 */
async function score(probe, miners, ask, judge, opts = {}) {
  const { wDemand, wQuality, wLiveness, latencyBudgetMs } = { ...DEFAULTS, ...opts };
  const maxRev = Math.max(1e-9, ...miners.map((m) => Number(m.revenueUsd) || 0));
  const detail = [];
  for (const m of miners) {
    let live = false, ms = null, quality = 0;
    try {
      const r = await ask(m, probe.prompt);
      if (r && typeof r.answer === "string" && r.answer.trim()) {
        ms = Number(r.ms);
        live = ms != null && ms <= latencyBudgetMs;
        if (live) quality = clamp01(await judge(probe.prompt, r.answer));
      }
    } catch (_) { /* unreachable miner => scores on demand only, if any */ }
    const demand = (Number(m.revenueUsd) || 0) / maxRev; // 0..1, normalized to top earner
    // A miner with real paid demand still earns even if it missed this one probe; a miner
    // with neither demand nor a live/quality answer earns 0.
    const raw = wDemand * demand + wQuality * quality + wLiveness * (live ? 1 : 0);
    detail.push({ uid: m.uid, live, ms, quality, demand, raw });
  }
  const uids = detail.map((d) => d.uid);
  const total = detail.reduce((s, d) => s + d.raw, 0);
  if (total <= 0) return { uids, weights: uids.map(() => 0), detail };
  const weights = detail.map((d) => Math.round((d.raw / total) * SCALE));
  const diff = SCALE - weights.reduce((s, w) => s + w, 0);
  let top = 0;
  for (let i = 1; i < detail.length; i++) if (detail[i].raw > detail[top].raw) top = i;
  weights[top] += diff;
  return { uids, weights, detail };
}

function clamp01(x) { x = Number(x); return isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; }
function weightsArg(uids, weights) { return uids.map((u, i) => `${u}:${weights[i]}`).join(","); }

module.exports = { score, weightsArg, SCALE, DEFAULTS };
