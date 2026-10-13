# Agent Scan-&-Trade (Autopilot) — spec

A new autonomous mode: the agent **scans any and all pairs it can see, decides which are worth
trading for profit, and trades them autonomously** — entirely within the existing safety
envelope. Implemented identically across `blockle-extension/agent`, `blockle-app/lib/agent`,
`python/blockle/agent` as a new bot type / mode `scanner`. Shared vectors: `docs/scan-vectors.json`.

## Hard safety frame (unchanged, non-negotiable)

Autonomous does NOT mean ungated. Every trade the scanner makes is an Intent dispatched through
the ONE value-moving gate (prepare → policy.assessValue caps → confirm/auto-within-allocation →
commit → recordSpend) with the allowlist, kill switch, hash-chained audit, the 0.05% fee, the
mainnet gate, AND the security pre-sign (a danger forces an explicit confirm). It runs under a
hard per-scanner `allocationUsd` committed-spend ledger (fully-auto-within-allocation, exactly
like the bots). It defaults to **paper + disabled + testnet**. Kill stops it instantly. It
NEVER fabricates a price/edge — it acts only on real, computed, cost-positive opportunities.

## 1. The loop (per tick, on `pollSec`)

1. **Scan** — build the candidate universe from the §7 discovery feed (all enabled sources +
   chains) ∪ the exchange markets ∪ connected venue pairs, passing the discovery filters
   (minLiquidityUsd, minAgeSec, quoteAssets, requireVerified, allow/deny, rejectFlags). This is
   "any and all pairs" — bounded only by `maxCandidates` and the filters (a log line names what
   was dropped; no silent truncation).
2. **Evaluate** each candidate for profit using the EXISTING strategy signals, net of ALL costs
   (both venue fees + two 0.05% agent legs + slippage + gas), and score it:
   - cross-venue **arbitrage** net edge (bps) — only if strictly positive after costs;
   - **momentum** (SMA crossover) signal strength;
   - **spread / mean-reversion** (grid-able) when range-bound.
   `score` = risk-adjusted expected edge (bps), penalized by thinness/volatility/flags. Pin the
   formula + a canonical vector so all three langs agree. A candidate with no real edge scores ≤ 0.
3. **Decide** — a pair is "worthy" iff `score ≥ minProfitBps` (default 30) AND it clears the
   discovery filters AND (at dispatch) the allowlist. Rank worthy pairs by score; take the top
   `maxConcurrentPairs` (default 3) that fit remaining `allocationUsd`.
4. **Trade** — emit the chosen strategy's Intent(s) for each worthy pair (arb = balanced 2-leg,
   momentum = buy/sell, grid = ladder), each sized `perTradeUsd` (default 20) clamped to
   remaining allocation, dispatched through the gate. Record every decision (traded / skipped +
   reason) to the audit; realized-profit pop-ups fire on stablecoin exits.

## 2. Config

`minProfitBps` (30), `maxConcurrentPairs` (3), `perTradeUsd` (20), `allocationUsd` (hard cap,
required to arm live), `pollSec` (300), `strategies` (["arbitrage","momentum","grid"]),
`chains`/`quoteAssets`, discovery `sources`/`filters`, `mode` ("paper"|"live", default paper).
"Trade any pair it deems worthy" = broad discovery + the `minProfitBps`/filter/allowlist gate
decides worthiness; raise/lower `minProfitBps` to tune aggressiveness.

## 3. Wiring + UI

- A `scanner` bot type in the BotRunner (reuses discovery + the strategy planners + the deal
  dispatch). Its `plan()` returns the ranked worthy-pair Intents for the tick; the runner
  dispatches them through the same gate as every other bot. It respects the background scheduler
  + stop/kill (see the kill fix).
- UI: an **"Scan & trade (Autopilot)"** card in the Bots cockpit — a start/arm control (paper vs
  live with the allocation review sheet), the live scanned-candidate list with scores + why each
  is traded/skipped, the allocation-used bar, realized P&L, and the kill control.

## 4. Parity + tests

`docs/scan-vectors.json`: a scan snapshot (candidates with liquidity/venue prices/history) →
the exact ranked worthy set + per-pair score + the Intents emitted (and the sub-threshold ones
skipped), identical across all three langs. Tests: a cost-positive arb pair is traded; a
gross-positive-but-net-negative pair is NOT; a sub-`minProfitBps` pair is skipped; a danger /
cap / kill still blocks the scanner's trades exactly like any bot; paper never broadcasts;
unapproved discovered token → blocked audit note, never an ungated trade. No synthetic prices.
