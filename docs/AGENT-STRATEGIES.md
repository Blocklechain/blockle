# Blockle In-Wallet Agent — Trading Strategies Spec

One spec, three implementations that must behave **identically** (same names, params,
defaults, and numeric decisions): `blockle-extension/agent` (JS), `blockle-app/lib/agent`
(Dart), `python/blockle/agent` (Python).

## 0. Non-negotiable safety model (unchanged)

Strategies are **planners, not executors**. A strategy NEVER signs, broadcasts, or
touches keys. It reads market/balance data and returns a list of **Intents**. Every
Intent is dispatched through the *existing* value-moving pipeline:

```
tool.prepare(args)  ->  policy.assessValue()  ->  policy.gateConfirm()  ->  tool.commit()  ->  policy.recordSpend()
                         (hard caps)             (default-on confirm)      (broadcast)        (audit around all)
```

This means the mandatory rails already in `policy.js` / `runner.js` apply **for free and
cannot be bypassed**: per-session + per-asset caps, confirm gate, tool allowlist, kill
switch, hash-chained audit, and the 0.05% agent fee leg (which the `swap`/`buy`/`sell`
tools already attach). Strategies must not re-implement signing, fee routing, or caps.

- **Dry-run / propose by default.** A strategy run defaults to `mode: "propose"` — it
  emits Intents and records them to the audit as `strategy_proposal`, but dispatches
  nothing until the host confirms (per-Intent, through the normal gate). `mode: "auto"`
  dispatches within the policy caps + `autoApproveUnderUsd`; it still honors confirm for
  anything above the auto threshold, still honors caps, still honors kill between Intents.
- **Mainnet gate.** A strategy that would route through a mainnet venue refuses unless the
  host context says `mainnetEnabled === true`. Default false. Testnet/dry otherwise.
- **Kill.** The StrategyRunner checks `policy.isKilled()` before each Intent and aborts the
  whole tick on kill. A kill mid-confirm still blocks the commit (policy already does this).
- **Allowlist.** Strategies may only produce Intents whose `tool` is on the channel's
  allowlist; an Intent for a non-allowed tool is dropped with an audited `blocked` note.
- **Never fabricate.** If a required price/quote is unavailable, the strategy emits NO
  Intent for that pair and records `skipped: reason`. No synthetic prices.

## 1. Intent shape

```
Intent = {
  tool:      'swap' | 'buy_block' | 'sell_block' | 'place_order' | 'cancel_order' | 'send',
  args:      { ... },          // exactly the args the named tool's prepare() expects
  rationale: string,           // human-readable "why" (shown in confirm + audit)
  estUsd:    number | null,    // best-effort USD notional for the cap USD path
  strategy:  string,           // strategy name that produced it
  tag:       string            // stable id e.g. 'arb:BLOCK/USDC:blockle->uniswap'
}
```

## 2. Strategy interface

```
Strategy = {
  name: string,
  describe(): string,                 // one-line human summary
  defaults: { ...params },            // sane defaults; all params optional at call time
  validateParams(params): params,     // throw on bad input; fills defaults; clamps ranges
  async plan(ctx, params): Intent[]   // READ-ONLY; returns [] when no action warranted
}
```

`ctx` exposes ONLY read accessors (no commit): `quote(market, side, amount)`,
`getBook(market)`, `getTrades(market)`, `getMarkets()`, `getBalance(chain, tokens)`,
`listVenues(pair)`, `venueQuote(venue, from, to, amountBase)`, `prices(symbols)` (USD),
`now()` (ms; injected/mockable — do NOT call Date.now directly in pure logic), and
`policyRemaining()`. All amounts are **base-unit decimal strings**; math is exact
BigInt where it affects money. Params that are bps are integers.

## 3. The five strategies

### 3.1 `arbitrage`  (headline)
Detect a profitable price gap for one pair across venues and capture it.

Params: `pair` (e.g. "BLOCK/USDC"), `venues` (default: all from `listVenues(pair)`),
`minEdgeBps` (default 30), `maxNotionalUsd` (default 50), `gasBufferUsd` (default 2).

plan():
1. For each venue, get the executable **buy** price and **sell** price for `pair` at a
   probe size = `min(maxNotionalUsd, policyRemaining.sessionUsd)`. Use `venueQuote` /
   `getBook` best bid/ask. Skip venues that can't quote.
2. Find `buyVenue` = lowest ask, `sellVenue` = highest bid. If same venue, no edge → [].
3. `grossEdgeBps = (bestBid - bestAsk) / bestAsk * 10000`.
4. Subtract costs: both venues' trade fees + **two** 0.05% agent-fee legs + slippage est
   + `gasBufferUsd` converted to bps of notional. `netEdgeBps = grossEdgeBps - costsBps`.
5. If `netEdgeBps >= minEdgeBps`: size `notionalUsd = min(maxNotionalUsd, depth at both
   venues for that edge, policyRemaining)`. Emit **two** Intents, tagged as a pair:
   a `swap`/`buy` on `buyVenue` and a `swap`/`sell` on `sellVenue`, each with rationale
   citing the prices and the net edge. Else [] (record `skipped: edge <min`).
6. Never emit a single-leg arb (both legs or neither). If only one leg is allowlisted,
   drop both.

### 3.2 `dca` (dollar-cost averaging)
Params: `asset`, `quote` (default USDC), `usdPerBuy` (default 10), `intervalSec`
(default 86400), `lastRunAt` (ms, host-persisted).
plan(): if `now() - lastRunAt >= intervalSec*1000`, emit ONE buy Intent for `usdPerBuy`
of `asset` using `quote`. Else []. (Host persists `lastRunAt` on commit.)

### 3.3 `grid`
Params: `market`, `levels` (default 6, clamp 2..20), `stepBps` (default 50),
`sizeUsdPerLevel` (default 10), `recenter` (bool, default false).
plan(): read mid from `getBook`. Produce `place_order` Intents: `levels/2` buy limits at
`mid*(1 - k*stepBps/1e4)` and `levels/2` sell limits at `mid*(1 + k*stepBps/1e4)` for
k=1..levels/2, each sized `sizeUsdPerLevel`. Skip a level if an open order already sits
within half a step (host passes `openOrders` in ctx). No market orders.

### 3.4 `rebalance`
Params: `targets` (map symbol->weight summing ~1.0), `bandBps` (default 500),
`baseQuote` (default USDC), `maxTradeUsd` (default 50).
plan(): value the portfolio via `getBalance` + `prices`. For any asset whose actual
weight drifts from target by `> bandBps`, emit a `swap` Intent (overweight→sell to
baseQuote, underweight→buy from baseQuote) sized to close half the gap, clamped to
`maxTradeUsd`. Emit at most one Intent per asset per tick.

### 3.5 `momentum`  (SMA crossover)
Params: `market`, `shortN` (default 10), `longN` (default 30), `tradeUsd` (default 20),
`history` (host-supplied recent prices, oldest→newest).
plan(): need `>= longN` prices else []. Compute SMA(short), SMA(long) for the last two
points. **Golden cross** (short crosses above long) → one buy Intent. **Death cross**
(short crosses below long) → one sell Intent (sell only what's held). No cross → [].

## 4. StrategyRunner

A thin driver reusing the existing runner's value-moving path:

```
StrategyRunner(deps: { tools, policy, audit, ctx, mainnetEnabled })
  async tick(strategyName, params, { mode='propose' }):
    assertLive (kill)
    strat = registry.get(strategyName); params = strat.validateParams(params)
    intents = await strat.plan(ctx, params)
    record audit { type:'strategy_plan', strategy, count, mode }
    results = []
    for intent of intents:
       if policy.isKilled() break
       if !policy.allowlisted(intent.tool): record 'blocked'; continue
       if mode==='propose': record 'strategy_proposal' {intent}; results.push({proposed:intent}); continue
       // auto: reuse the SAME gated dispatch the runner uses
       dispatch(intent)  // prepare -> assessValue -> gateConfirm -> commit -> recordSpend, audited
    return results
```

`dispatch` must be the shared value-moving routine extracted from/matching `runner.js`
so there is exactly one commit path. No second broadcast path may exist.

## 5. Fees

The 0.05% non-bypassable agent fee is attached by the **`swap`** tool only: it is the
single path that routes through a VENUE, and the venue's `buildSwap` produces the fee +
its on-chain treasury transfer (fail-closed if the trade's chain has no treasury address).
The runner then broadcasts that fee as a second leg of the SAME confirmed action and
accrues it against caps (only when the fee actually broadcasts).

`buy_block` / `sell_block` do **not** attach a separate agent-fee leg: `buy_block` settles
over the x402 rail (the seller prices its own spread) and `sell_block` returns to the
non-custodial reserve; there is no venue `buildSwap` and therefore no fee transfer. All
three implementations are identical on this point. A strategy that wants the fee to apply
must route through `swap`.

`arbitrage` must still count **two** 0.05% agent-fee legs in its edge math (it is sized as
if both legs route through `swap`) so it never proposes a loss-making arb even when a leg
is later executed on a fee-free native rail.

## 6. Parity + tests

Add a shared fixture of market snapshots + expected decisions (`strategy-vectors.json`,
identical across all three langs) so the three implementations are checked against the
same numbers. Required tests per language:

- arbitrage: (a) detects a real edge above threshold and emits a balanced 2-leg pair;
  (b) **refuses** when gross edge is positive but net (after both fees + gas) < threshold;
  (c) drops both legs if one leg's tool is not allowlisted.
- dca: fires exactly once per interval; nothing before the interval elapses.
- grid: emits the right number of buy/sell levels at the right prices; skips occupied levels.
- rebalance: trades only assets outside the band; direction + half-gap sizing correct.
- momentum: buy on golden cross, sell on death cross, nothing otherwise; needs longN history.
- **gate integration (the important one):** a strategy Intent in `auto` mode is still
  (a) rejected by a per-asset/USD cap, (b) aborted by kill mid-tick, (c) requires confirm
  above `autoApproveUnderUsd`. Proves strategies cannot bypass the safety layer.
- mainnet gate: a mainnet-venue Intent is refused when `mainnetEnabled=false`.

All new money defaults OFF/propose/testnet. Keep every existing test green.

## 7. Token discovery (configurable candidate feed)

Strategies operate on a **candidate universe** of tokens/pairs. Discovery finds and ranks
candidates; it is **READ-ONLY** and never trades. A discovered token is only a *suggestion*
— it is NOT auto-added to the policy allowlist and NOT auto-traded. Any trade on a
discovered token still goes through the full gate (allowlist + caps + confirm). This keeps
the non-bypassable safety model intact.

`Discovery` module per wallet (`agent/discovery.{js,dart,py}`):

```
Discovery(deps: { ctx, config })
  async scan(): Candidate[]            // dedup + filter + score + rank, READ-ONLY
```

```
Candidate = {
  chain, symbol, address, pair,        // e.g. 'NEW/USDC'
  venue, source,                       // which source surfaced it
  liquidityUsd, volume24hUsd, ageSec,  // null when a source can't provide it
  score,                               // 0..1 rank (see scoring)
  flags: [ ... ],                      // e.g. 'low-liquidity','unverified','new','denylisted'
  approved: false                      // becomes true only by explicit user action
}
```

**Configurable sources** (each independently enable/disable-able):
- `blockLaunches` — new BLOCK-20 tokens from the launchpad / new AMM pools on the native chain.
- `exchangeListings` — new markets from `ctx.getMarkets()` not seen before.
- `venuePairs` — new pools/pairs on connected DEX venues (Uniswap/Jupiter/etc.) via each
  venue's read API (no key material; honor the venue's own rate limits).
- `tokenLists` — operator-configured token-list URLs (CoinGecko-style / Uniswap token-list
  JSON). URL + schema are config; nothing hardcoded. Fetch read-only; never send wallet data.
- `watchlist` — user-supplied symbols/addresses (incl. custom-network tokens). Always trusted
  as *candidates* (still not auto-traded).

**Configurable filters** (`config.filters`, conservative defaults):
`minLiquidityUsd` (default 10000), `minAgeSec` (default 3600 — avoid 0-block honeypots),
`maxAgeSec` (null), `chains` (allowed list), `quoteAssets` (default ['USDC','USDT','BLOCK']),
`requireVerified` (default true for external sources), `allowlist`/`denylist` (symbols or
addresses), `maxCandidates` (default 50). A candidate failing a hard filter is dropped;
soft concerns become `flags`.

**Rug/scam heuristics** (read-only, best-effort, flag not fabricate): low-liquidity,
liquidity-not-locked (when the source exposes it), mint-authority-not-renounced (Solana),
honeypot (sell disabled) when a venue read can tell, extreme holder concentration. Each adds
a `flag`; `config.rejectFlags` (default includes `honeypot`) hard-drops. Never claim a token
is safe — absence of flags ≠ safe; surface what was and wasn't checked.

**Scoring**: a transparent weighted sum of normalized features, minus flag penalties, clamped
to [0,1]. Pinned defaults (in config, tunable) so the three languages agree exactly:
`score = clamp01( 0.40·Ln + 0.30·Vn + 0.20·An + 0.10·Tn − 0.25·flagPenalty )` where
`Ln = min(1, liquidityUsd / 100000)`, `Vn = min(1, volume24hUsd / 50000)`,
`An = clamp01(1 − |ln(ageSec/86400)| / 3)` (age sweet-spot ≈ 1 day), `Tn` = source trust in
[0,1] (watchlist 1.0, exchangeListings 0.8, blockLaunches 0.7, venuePairs 0.5, tokenLists 0.4),
and `flagPenalty` = count of soft flags. A missing feature contributes 0 (never fabricated).
**Canonical vector** (assert exactly in all three): `liquidityUsd=100000, volume24hUsd=50000,
ageSec=86400, source=exchangeListings(0.8), 0 flags → 0.40+0.30+0.20+0.08 = 0.98`. Deterministic
given a snapshot; monotonic in liquidity + volume.

**Wiring**: `StrategyRunner` may take `discovery`; when a strategy's `pair`/`asset` param is
omitted and `config.useDiscovery` is on, it draws candidates from `discovery.scan()` filtered
to `approved===true` (default) — or, if `config.autoConsiderUnapproved` is explicitly enabled,
from all candidates but STILL subject to the allowlist at dispatch (so an unapproved token
simply produces a `blocked` audit note instead of a trade). Default: approved-only.

Tests: filters drop sub-threshold/denylisted/too-new candidates; `rejectFlags` hard-drops;
scoring is deterministic + monotonic in liquidity/volume; a discovered-but-unapproved token
never reaches commit (produces `blocked`); sources can be individually disabled.

## 8. Realized-profit notifications (stablecoin exits)

When a trade **sells an asset into a stablecoin** and realizes a gain, pop a notification
telling the user how much they earned and on what.

- **Cost basis**: maintain a per-(wallet, channel, asset) average-cost lots ledger
  (`agent/pnl.{js,dart,py}`), updated on every committed buy/sell the agent makes (base-unit
  BigInt quantities; USD basis from the trade's own executed price, never a guessed price).
  Persist alongside the audit log (not in plaintext with any key material).
- **Trigger**: in the post-commit hook (the one commit path in §4), if the trade's OUTPUT
  asset is a configured stablecoin (`config.stablecoins`, default USDC/USDT/DAI/USDbC/PYUSD)
  and `realizedUsd = proceedsUsd − costBasisUsd(soldQty) > minNotifyUsd` (default $0.01),
  emit a `realized_profit` event `{ asset, soldQty, proceedsUsd, basisUsd, realizedUsd,
  stable, venue, txid }` and record it to the audit.
- **Pop-up surface** (native per wallet, non-blocking, never exposes keys):
  extension → `chrome.notifications` (fallback in-page toast); Flutter →
  `flutter_local_notifications` (fallback in-app snackbar); Qt → tray `showMessage` /
  non-modal toast. Copy: `+$42.10 — sold 3.2 SOL → USDC` with a subtitle of basis→proceeds.
- **Honesty**: only fire on a POSITIVE realized gain (the user asked for "when trades make
  money"); losses update the ledger silently (optionally a neutral event, off by default).
  Never fabricate a number — if basis is unknown (asset not acquired via the agent), mark
  basis `unknown` and either skip the pop-up or show proceeds-only per `config.requireBasis`
  (default true = skip rather than show a misleading profit).
- Reuses the single commit path — no second execution path, no bypass of the gate.

**Avg-cost ledger (pinned semantics, assert exactly in all three):** quantities are base-unit
BigInt; basis is carried as integer USD micro-dollars (`uc = round(usd·1e6)`, i.e. 1e6 per $1, so $200 → 200000000) to stay exact and
language-identical. A BUY adds `qty` and `costUc` to the lot; average cost per base unit =
`costUc / qty`. A SELL of `sellQty` realizes `proceedsUc − round(avgCostPerUnit·sellQty)` and
removes that pro-rata share of basis (`costUc −= round(avgCostPerUnit·sellQty)`), leaving avg
cost unchanged. **Canonical vector:** buy 2·1e8 base @ $100 (costUc 200·1e6=200000000), buy
1·1e8 @ $160 (costUc +160000000 → 360000000; qty 3·1e8; avg = 360000000/3e8 = $1.20/base-unit…
i.e. $120/coin); sell 1.5·1e8 @ $150 → proceedsUc 225000000, basis removed round(1.2·1.5e8)=180000000,
realized = 225000000−180000000 = **+$45.00**; remaining qty 1.5e8, costUc 180000000 (avg $120/coin
unchanged). Fires one `+$45.00` pop-up (output = USDC, positive).

Tests: realized PnL math (avg-cost, partial sells, the canonical vector above, BigInt/integer-exact);
fires only on positive realized gain into a configured stablecoin; unknown-basis path respects
`requireBasis`; event shape stable; no notification on a non-stable output; losses update the
ledger silently.
