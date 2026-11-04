# Buzz signals — online presence / traffic feed for the bots

**Question it answers:** "which tokens is the internet piling into *right now*, and is that
attention still turning into price?" The signals service gathers traffic/attention data
from free, keyless sources, merges it per `chain:token`, gates every candidate through the
SAME rug/liquidity/holder gate as `/discover`, and ranks by `buzz.quick`.

## Endpoints (signals service, nginx `/api/signals/*`)

- `GET /api/signals/buzz?mode=high&chain=solana&limit=12` — the board. `chain` optional
  (`solana` | `ethereum` | `bsc`), `mode` is the risk gate (`safe|medium|high|sniper`).
- `GET /api/signals/discover?rank=buzz&mode=…&chain=…` — the same rows in the discover
  shape the bots already consume (this is what a `rank:'buzz'` signal bot calls).

Row: `{ chain, token, symbol, name, safe, score, hype, flags, buzz: { attention, velocity,
quick, feasibility, safe, basis }, sources[], signals{…}, metrics{…} }`. The board also
returns `rejected[]` (top-attention tokens that FAILED the gate, with their flags) so the
UI can show why a loud token is not tradeable. Cached 90 s; CoinGecko coin lookups 6 h.

## Sources (all free, no API key)

| source | what it measures | fields |
|---|---|---|
| CoinGecko `/search/trending` | what people are **looking up** (24 h search traffic, top ~15) | `searchRank/searchTotal`, `chg24h`, via `/coins/{id}`: `watchlistUsers`, `sentimentUp`, `chg1h`, contract per chain |
| GeckoTerminal `/networks/{eth,bsc,solana}/trending_pools` | what people are **actually trading** | `poolRank/poolTotal`, `buyers1h/24h`, `buys1h/sells1h`, `vol1h/vol24h`, `chg5m/1h/6h/24h`, `liquidityUsd`, `poolAgeSec` |
| DexScreener `token-boosts/top+latest`, `token-profiles/latest` | what projects are **paying to promote** | `boosts`, `profile` |

Native coins in the search list map to the tradeable wrapped token (ETH→WETH, BNB→WBNB,
SOL→wSOL). Trending pools whose base is a major/stable are skipped (the pool is about its
other side). Reddit/X/Telegram engagement is NOT included: those APIs are paid or block
servers. Every row says so in `buzz.basis`.

## Scores (pure, `services/signals/src/buzz.js`, tested in `tests/signals-buzz.test.mjs`)

- **attention 0–100** — 30 search rank + 25 trending-pool rank + 20 log(buyers 1 h, full at
  500) + 10 log(buyers 24 h, full at 5 000) + ≤8 boosts (+3 profile; capped because it is
  bought) + 4 log(watchlist users) ± 3 sentiment.
- **velocity 0–100** — 30 volume acceleration (1 h pace ÷ 24 h pace, 0.5→3.5 range) + 15
  chg 5 m (±5 %) + 20 chg 1 h (±15 %) + 10 chg 6 h (±40 %) + 5 chg 24 h (±100 %) + 20 buyer
  dominance (buys/(buys+sells), 50 %→80 %). Penalties: an already-chased hour (> +60 %
  loses up to 30) and dumping (1 h < −10 % with a red 5 m: −10).
- **feasibility 0–1** — exit depth from liquidity: < $5k → 0.1, $1M+ → 1, log-scaled between.
- **quick 0–100** — `√(attention × velocity) × feasibility`, **0 when the safety gate
  fails**. Geometric: a watched coin that is not moving, or a mover nobody is talking
  about, both score low.

## How the bots use it

A `signal` bot with `config.rank = 'buzz'` asks discovery for `rank=buzz`, drops any row
without a positive `quick`, and fills its `maxConcurrent` slots best-`quick` first. The
risk preset's own liquidity/age/score checks still run on each row, the allocation ledger
and the 0.05 % fee still bound every order, and the bot starts in PAPER. The **🔥 Buzz
Hunter** preset (web + Flutter) pairs it with a tight smarttrade: 8 % / 20 % take-profits,
10 % trailing stop, 60 s candle exit. Web: Bots → New bot → Signal → "Rank candidates by".

**Full Auto** includes a 🔥 Buzz child by default (see BLOCKLE-BOTS.md §2.4 for the
regime priors); existing Full Auto bots pick it up on their next load.

Honest framing for users: attention is a leading indicator, not a promise. Most spikes
mean-revert; the preset's quick exits and the max-loss rail are the seatbelt.
