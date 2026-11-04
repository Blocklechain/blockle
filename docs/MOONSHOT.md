# MOON — the Moonshot-style BLOCK-20 flow (web wallet + Flutter mobile wallet)

One tap from "I see a token" to "I own it", with BLOCK as the only currency the
user ever thinks about. This document is the SHARED CONTRACT: the web wallet
(`web/wallet/app.js` `VIEWS.moon` + `vendor/moon.js`) is the reference
implementation; the Flutter app (`blockle-app`) must render the same feed, the
same quotes and the same P&L from the same endpoints and the same math.

## 1. The experience

```
Moon tab
 ├─ header: "Your BLOCK  123.4 BLOCK ≈ $12.34"  [Get BLOCK] [Receive]
 ├─ tabs: Trending · New · Gainers · My bags
 └─ list rows: logo · SYMBOL name · liq / 🔒 / 🆕 / bag P&L · sparkline · $price · 24h%
      tap ─▶ token sheet
            ├─ price (USD + BLOCK) · 1h/24h/7d chips · 70px sparkline
            ├─ stats: liquidity, LP lock, age, contract (copy)
            ├─ warnings banner (thin liquidity / LP unlocked / brand-new / flagged)
            ├─ "Your bag": qty, value, unrealized P&L (only when held)
            ├─ BUY:  [$5] [$20] [$50] [$100]  custom USD → "Pay X BLOCK → get ≈ Y SYM · impact Z%" → [🚀 Buy SYM]
            └─ SELL: [25%] [50%] [75%] [100%] + slider → "Sell N SYM → ≈ X BLOCK ($)" → [Sell]
                  ─▶ confirm sheet (the ONE approval gate) ─▶ gas check ─▶ sign on device ─▶ broadcast
                  ─▶ ledger entry ─▶ toast "🚀 Bought SYM · txid…"
```

Rules of the flow (both wallets):

* **Amounts are in USD on the way in, BLOCK on the way out.** USD→BLOCK uses the
  feed's `blockUsd`. If `blockUsd` is null, buy presets are disabled ("BLOCK
  price unavailable") — never guess.
* **Slippage 1 %**, pool fee from the feed (`poolFeeBps`, default 30), gas in BLOCK.
* **Price-impact guard:** a buy or sell whose impact is above **15 %** is refused
  in the UI (`tooBig`). The user must lower the size.
* **Not enough BLOCK** → the buy button is disabled with "You need N more BLOCK"
  and the header's "Get BLOCK" leads to `/buy`.
* **Warnings are shown, never hidden.** A `danger` flag (honeypot/rug/scam/
  denylist) turns the confirm sheet into a danger confirm (checkbox ack).
* **Non-custodial:** the native-AMM swap is built + signed on the device
  (`Wallet.buildPoolSwapBuy/Sell`), exactly like the Swap tab. Nothing new touches keys.

## 2. Endpoints (served by the signals service behind `/api/signals/`)

### `GET /api/signals/moon/feed?tab=trending|new|gainers|liquid&limit=100`

```json
{
  "generatedAt": 1793725551972, "height": 23631, "blockUsd": 0.1, "count": 1, "tab": "trending",
  "tokens": [{
    "contract": "32a979…d00f", "poolId": "43bc9f…6b30", "symbol": "WORLD", "name": "World", "decimals": 8,
    "logo": "https://blockle.org/world-token.svg",
    "priceBlock": 0.0011857, "priceUsd": 0.000118,
    "blockReserve": "108905343402", "tokenReserve": "91846345958697", "poolFeeBps": 30,
    "liquidityBlock": 2178.1, "liquidityUsd": 217.8,
    "lpLocked": false, "lockDaysLeft": 0, "ageBlocks": 18242, "createdHeight": 5389,
    "change1hPct": null, "change24hPct": null, "change7dPct": null,
    "volume24hBlock": null, "snapshots": 1, "spark": [0.00118, …], "flags": ["lp-unlocked"], "score": 42.1
  }]
}
```

* `blockReserve` / `tokenReserve` are **base-unit strings** — the client quotes
  against them locally (§3) so the number shown is the number signed.
* `change*Pct` are null until enough 15-minute snapshots exist (`snapshots`).
* `spark` = last 48 snapshot prices in BLOCK (up to ~12 h).
* `score` is the server's trending score (§4). Cached 60 s.

### `GET /api/signals/moon/token/<contract>`

The feed row plus `history` (up to 500 `{t, price}` snapshots) and `diligence`
(the signals report for chain `block`, `mode=high`: `safe`, `flags`, `metrics`).

### `GET /api/signals/prices?symbols=BLOCK,SOL&tokens=solana:<mint>`

Shared price cache (BLOCK, majors, any token by address) — used by the price feed
module, not by Moon directly.

### Writes

None. Execution is an ordinary on-chain swap through the node's `POST /api/submit`.

## 3. Math (mirror `vendor/moon.js` exactly)

Constant-product with the fee on the input, BigInt base units, floors everywhere:

```
inAfterFee = amountIn * (10000 - feeBps) / 10000
amountOut  = reserveOut * inAfterFee / (reserveIn + inAfterFee)
minOut     = amountOut * (10000 - round(slippage*10000)) / 10000      // slippage 0.01
```

* **Buy:** `blockIn = floor(usd / blockUsd * 1e8)`; `amountOut` with
  `reserveIn = blockReserve`, `reserveOut = tokenReserve`.
* **Sell:** `tokenIn = balance * pct / 100` (BigInt); `reserveIn = tokenReserve`,
  `reserveOut = blockReserve`.
* **Spot** = `(blockReserve/1e8) / (tokenReserve/10^decimals)` BLOCK per token.
* **Impact** = `effPrice/spot - 1` (buy) or `1 - effPrice/spot` (sell), in %.
  `tooBig` when impact > 15.
* The tx is built with the SAME `amountIn` / `minOut` strings the quote produced.

### Position ledger (per contract, stored locally; never on a server)

```
{ contract, symbol, decimals, qty: "base", costBlock: "base", costUsd: number,
  realizedUsd, realizedBlock, trades: [{side, qty, blockAmt, blockUsd, txid, at}] }
```

* BUY: `qty += out; costBlock += blockIn; costUsd += blockIn/1e8 * blockUsd`.
* SELL (average cost): `basisBlock = costBlock * sellQty / qty`;
  `realized += proceeds - basis`; subtract pro-rata from qty/cost.
* P&L marks the **live on-chain balance** (`/api/token/<id>?holder=`), scaling the
  basis to the fraction the ledger knows about; a balance with no ledger entry
  shows "bought outside Moon — no cost basis" instead of a fake P&L.

Flutter: persist the ledger in the app's existing encrypted preferences under
`moonPositions`; web uses the same key in `Store`.

## 4. Ranking (server + client agree; `Moon.trendingScore`)

```
liqScore  = min(40, log10(1 + liquidityBlock) * 10)
momentum  = clamp(change24h*0.5 + change1h*1.5, -20, 35)
fresh     = max(0, 15 - ageBlocks/48)           // new launches, fades over ~5 days
lock      = lpLocked ? 8 : 0
volScore  = min(12, log10(1 + volume24hBlock) * 4)
penalty   = any danger flag ? -100 : 0
score     = round2(liqScore + momentum + fresh + lock + volScore + penalty)
```

Tabs: trending = score desc · new = ageBlocks asc · gainers = change24h desc ·
liquid = liquidityBlock desc · **My bags** = feed rows filtered to ledger qty > 0
(client-side only).

## 5. Warnings (`Moon.warnings`)

| code | when | copy |
|---|---|---|
| thin | liquidityBlock < 50 | Very thin liquidity — even small buys move the price a lot. |
| lp-unlocked | !lpLocked | Liquidity is not locked — the creator can pull the pool. |
| new | ageBlocks < 144 (≈1 day) | Launched less than a day ago. No track record. |
| danger | flag matches honeypot/rug/scam/denylist | Flagged … — do not buy. |

## 6. Flutter implementation notes

* Screens: `MoonScreen` (tabs + list), `MoonTokenSheet` (modal bottom sheet),
  `MoonConfirmSheet` → reuse the app's existing approval sheet.
* Port `vendor/moon.js` 1:1 to Dart (`lib/moon/moon_core.dart`) — it is pure and
  BigInt-based; the unit tests in `scratchpad/wallet-tests.mjs` ("moon:") give
  the expected numbers for the WORLD pool fixture
  (`blockReserve 108905343402`, `tokenReserve 91846345958697`, decimals 8,
  $20 at blockUsd 0.1 → `amountIn 20000000000`).
* Execution: the app's existing native-AMM swap builder (same one as its Swap
  screen) with the quote's `amountIn`/`minOut`.
* Sparklines: `CustomPainter` over `spark`, green when last ≥ first.
* Refresh the feed every 60 s while the tab is visible; refresh the header
  balance + bag after a trade with a ~2.5 s delay (mempool → explorer lag).
