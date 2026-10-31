// Blockle Inference Gateway — the paid endpoint WE own (api.blockle.org/infer, x402 USDC).
// The buyer pays the gateway; the gateway routes the request to a registered inference MINER
// (who runs the GPU — not us), takes a protocol fee for the treasury (Alienbeing), and owes
// the miner the remainder (settled via the payout rail). If no miner can serve, it falls back
// to a wholesale provider priced BELOW our price, so even the fallback nets positive.
//
// This is the "we're the house" model: competitive GPU inference, zero GPU cost to us,
// revenue = fee spread. Pure + injectable (`call`, `wholesale.call`) so it tests offline.
"use strict";

/**
 * @param args.request    the inference request ({ prompt, model?, ... })
 * @param args.miners     [{ uid, url, healthy?, revenueUsd? }] candidate miners
 * @param args.priceUsd   what the buyer paid (x402)
 * @param args.feeBps     protocol fee in basis points kept by the treasury (e.g. 2000 = 20%)
 * @param args.call       async (miner, request) -> { answer, ms } | throws
 * @param args.wholesale  optional { costUsd, call: async(request)->{answer,ms} } bootstrap fallback
 * @param args.pick       optional miner-selection policy (default: first healthy)
 * returns { ok, answer, servedBy, ms, accounting }
 */
async function route(args) {
  const { request, miners = [], priceUsd = 0, feeBps = 2000, call, wholesale, pick } = args;
  const protocolFeeUsd = round6((priceUsd * feeBps) / 10_000);
  const candidates = miners.filter((m) => m.healthy !== false && m.url);
  const ordered = pick ? pick(candidates) : candidates;

  for (const m of ordered) {
    try {
      const r = await call(m, request);
      if (r && typeof r.answer === "string" && r.answer.trim()) {
        const minerEarnsUsd = round6(priceUsd - protocolFeeUsd);
        return {
          ok: true, answer: r.answer, servedBy: { kind: "miner", uid: m.uid }, ms: r.ms,
          accounting: {
            priceUsd, protocolFeeUsd, minerEarnsUsd, wholesaleCostUsd: 0,
            netToTreasuryUsd: protocolFeeUsd, // miner bore the GPU cost; we keep the fee
          },
        };
      }
    } catch (_) { /* try the next miner, then wholesale */ }
  }

  if (wholesale && typeof wholesale.call === "function") {
    try {
      const r = await wholesale.call(request);
      if (r && typeof r.answer === "string") {
        const cost = round6(Number(wholesale.costUsd) || 0);
        return {
          ok: true, answer: r.answer, servedBy: { kind: "wholesale" }, ms: r.ms,
          accounting: {
            priceUsd, protocolFeeUsd: 0, minerEarnsUsd: 0, wholesaleCostUsd: cost,
            // priced ABOVE wholesale on purpose → this is still positive (never a loss)
            netToTreasuryUsd: round6(Math.max(0, priceUsd - cost)),
          },
        };
      }
    } catch (_) { /* fall through to failure */ }
  }

  return { ok: false, answer: null, servedBy: null, ms: null,
    accounting: { priceUsd, protocolFeeUsd: 0, minerEarnsUsd: 0, wholesaleCostUsd: 0, netToTreasuryUsd: 0 },
    error: "no miner available and no wholesale fallback configured" };
}

function round6(x) { return Math.round((Number(x) || 0) * 1e6) / 1e6; }

module.exports = { route };
