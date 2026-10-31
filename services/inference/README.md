# blockle-inference — the Tier-2 inference subnet

Serving inference the honest way — like Bittensor, but **demand-backed** and **not pretending
it's verifiable**. Inference is not bit-reproducible, so it's a **Tier-2 (subjective)** subnet:
emission-capped at the chain level, scored on real signals, never dressed up as Tier-0.

## The economic model — "we're the house"

We do **not** rent GPUs. The miners bring the GPUs; Blockle owns the paid endpoint and takes a cut.

```
buyer ──x402 USDC──▶ Blockle Inference Gateway (api.blockle.org/infer)   ← we own this (CPU only)
                         │  keeps a protocol fee → treasury (Alienbeing)
                         ▼
                   registered MINER  ← runs the GPU + competitive model (THEIR cost)
                         │  earns (price − fee) + BLOCK emission
                   (fallback: wholesale provider, priced below our price → still net-positive)
```

- **We are the endpoint**, competitive quality, **zero GPU cost to us** (miners pay for GPUs).
- **Earns Alienbeing LLC money**: a protocol fee on every paid call → treasury; plus BLOCK
  emission drives value into the premine. See `gateway.js` (`route()` returns the full
  `accounting` split; verified by the self-test).
- No owned GPUs and no "free competitive GPU inference" fiction — that's physically impossible;
  this is a marketplace where the compute cost sits with whoever earns from it.

## Scoring (`validator.js`) — our edge over Bittensor

`score(probe, miners, ask, judge)` combines three signals (then the chain caps Tier-2 emission):

1. **demand (70%)** — real x402 USDC revenue the miner earned from paying customers this epoch.
   The hard-to-game signal: buyers, not validator opinion, drive most of the weight.
2. **quality (25%)** — a reference judge scores the miner's answer to a beacon-selected probe.
3. **liveness (5%)** — did it answer within the latency budget.

A miner that fakes quality still needs paying customers to earn; a dead or demand-less miner → 0.

## Run

```bash
npm run self-test     # proves fee-split + scoring offline (no chain/model/network). PASS.

# Be a miner (next to YOUR model server — vLLM/llama.cpp/TGI/Ollama):
MINER_UPSTREAM=http://127.0.0.1:8000/v1 MINER_MODEL=qwen2.5-72b-instruct \
  node src/index.js --role miner --port 8821
```

## Going live (after mainnet activation at 18888)

1. Register the Tier-2 subnet on-chain: `blockle intel register-subnet --tier 2`.
2. Miners register (`register-neuron --role miner`) and run this daemon pointed at their GPU model.
3. Stand up the gateway as an x402 service (reuses the beacon x402 glue in
   `services/beacon/src/x402.js`; mainnet USDC is gated behind an explicit operator env flag,
   same as the beacon's `BEACON_MAINNET_OK`). Set the treasury payTo + `feeBps`.
4. The validator probes miners each epoch and drives commit→reveal→validate; x402 revenue per
   miner feeds the demand signal; emission (capped for Tier-2) follows.

Nothing here moves real money or runs a paid mainnet endpoint until that operator sign-off.
See `docs/BLOCKLE-INTELLIGENCE.md` §4 (tiers) and §6 (demand-weighting).
