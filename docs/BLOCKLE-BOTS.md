# Blockle Bots — a non-custodial "3Commas for DEXes"

A persistent **trading-bot platform** layered on the in-wallet agent + strategy engine
(`docs/AGENT-STRATEGIES.md`). Same hard rule: a bot is a PLANNER + state machine; every
**live** order is dispatched through the existing non-bypassable gate (caps → confirm →
commit → recordSpend, with the 0.05% fee + kill + allowlist + hash-chained audit +
mainnet gate). Bots default to **paper** + **disabled**. Implemented identically in all
three wallets: extension (JS), app (Dart), python/Qt (Python).

## 1. Bot model (persistent)

```
Bot = {
  id, name,
  type: 'dca' | 'grid' | 'smarttrade' | 'signal' | 'rebalance' | 'momentum',
  universe: { pairs:[...] } | { fromDiscovery:true, filter:{...} },   // §7 discovery feed
  chainPrefs, venuePrefs,
  config: { ...type-specific },
  allocationUsd,              // hard per-bot capital cap, layered ON TOP of policy caps (tighter wins)
  mode: 'paper' | 'live',     // default 'paper'
  enabled: false,             // default off
  pollSec, cooldownSec, createdAt,
  state: { deals:[...], cursor, realizedUsd, unrealizedUsd, ... }
}
```

`BotStore` persists bots + state per (wallet, channel), encrypted at rest alongside the
audit log — **never** any key/seed/LLM-cred. Survives restart; resumes open deals. A
`BotRunner` ticks enabled bots on their schedule and routes their Intents through the
same `StrategyRunner` dispatch (one commit path only).

## 2. Deal engine (the 3Commas core)

A **deal** is one open→manage→close lifecycle. State machine persisted in `bot.state`.

### 2.1 DCA bot (flagship)
Config: `baseOrderUsd`, `safetyOrderUsd`, `maxSafetyOrders` (default 3), `safetyStepPct`
(price drop to trigger next SO, default 2%), `safetyStepScale` (step multiplier, default
1.0), `safetyVolumeScale` (SO size multiplier / martingale, default 1.0, clamp ≤3),
`takeProfitPct` (from **average** entry, default 2%), `trailingTpPct` (optional), `stopLossPct`
(optional), `cooldownSec`, `startCondition` ('asap' | 'signal' | 'dip').

Per tick (prices from `ctx`, all money BigInt-exact):
- **No open deal** + start condition met → emit **base order** buy; open a deal (avgEntry,
  filledQty, nextSafetyTrigger = entry·(1−safetyStepPct)).
- **Open deal**, mark ≤ `nextSafetyTrigger` and safety orders remain → emit **safety order**
  buy sized `safetyOrderUsd·safetyVolumeScale^k`; recompute avgEntry + next trigger
  (step ·= safetyStepScale).
- **Open deal**, mark ≥ `avgEntry·(1+takeProfitPct)` → **take-profit**: emit sell of the whole
  position to the quote. With `trailingTpPct`: once TP is first reached, arm a trailing stop
  and sell on a `trailingTpPct` pullback from the peak instead.
- **Open deal**, mark ≤ `avgEntry·(1−stopLossPct)` (if set) → **stop-loss** sell.
- On close → deal complete, realized PnL booked (§P&L); if the close asset is a stablecoin,
  the realized-profit pop-up (`AGENT-STRATEGIES.md §8`) fires. Then cooldown, next deal.

Fills: **live** = from the committed tx result; **paper** = simulated at the current quote.

### 2.2 Grid bot
Config: `lowerPrice`, `upperPrice`, `gridCount` (2..50), `totalUsd`, optional
`takeProfitPct`/`stopLossPct` to exit the whole grid. Seeds a ladder of limit orders; when
a buy level fills it arms a sell one grid up (and vice-versa). State tracks each level's
open/filled status; survives restart. No market orders.

### 2.3 SmartTrade (managed position)
Config: `entry` ({kind:'market'|'limit'|'ladder', ...}), `takeProfits` (list of
`{pct, sharePct}` splitting the exit across targets), `stopLoss` ({pct, trailing?}). One
position; the bot manages the staged exits + SL/trailing. Manual-but-automated.

### 2.4 Signal bot
Config: `source` — the §7 **discovery feed** events and/or a **local signal inbox** the user
or the NL agent posts to; `onSignal` — a bot template (§6) to launch per matching signal,
with the discovered pair substituted. Keeps the platform fully on-device + non-custodial.
*(External TradingView-style webhooks + copy-trading/marketplace are explicitly a later
server-side phase — see §Deferred.)*

### 2.5 rebalance / momentum
The `rebalance` and `momentum` strategies (`AGENT-STRATEGIES.md §3.4/§3.5`) run as scheduled
bot types with persistence + the per-bot dashboard, no new logic.

## 3. Paper trading

`mode:'paper'` simulates fills at live `ctx` quotes: it does **not** broadcast and does **not**
call the gate's commit — but it records a simulated deal + PnL to the dashboard and audit
(tagged `paper`), so a user can forward-test a config risk-free. `mode:'live'` routes every
order through the full gate. Switching paper→live requires an explicit arm action (and
`mainnetEnabled` for a mainnet chain).

## 4. Per-bot dashboard + P&L

Each bot surfaces: status, active deal(s), safety orders used / remaining, average entry,
**unrealized** PnL (mark-to-market via `ctx.prices()`), **realized** PnL (from the §8 avg-cost
ledger), total deals, win rate, max drawdown. A **Bots** cockpit lists all bots with
aggregate P&L and quick start/pause/stop/clone/kill controls. (Stats panels follow the
dataviz method: validated palette, one-axis, hover, dark-mode, table fallback.)

## 5. Safety + the live-auto gate (operator decision)

A live, enabled bot runs **fully auto within its allocation**: it executes orders with **no
per-order human confirm** as long as each order stays inside BOTH the bot's `allocationUsd`
envelope AND the policy session/per-asset caps. This is the chosen gate mode (operator pick:
"fully auto within allocation") — it is what lets a DCA/grid bot run hands-free. The rails
that remain **always on** make the allocation cap the real bound:

- **`allocationUsd` is a hard, non-bypassable per-bot cap**, enforced by a per-bot committed-
  spend ledger IN ADDITION to the policy session/per-asset caps (the tighter bound wins).
  An order that would push the bot's cumulative live spend over `allocationUsd` is **not
  auto-approved and not prompted — it simply does not fire** (audited `skipped: allocation`).
  Accrual is base-unit/BigInt-exact and only counts orders that actually broadcast.
- **Arming a live bot REQUIRES `allocationUsd > 0` and `≤` the policy session USD cap.** A
  live bot with no finite allocation cannot be armed (fail-closed). Paper bots need none.
- The auto-approve path is the policy's existing `autoApproveUnderUsd` mechanism, which the
  BotRunner sets to the bot's remaining allocation each tick — so "auto within allocation"
  reuses the ONE gate, never a second path. If an order exceeds remaining allocation the
  policy falls back to its normal confirm (and with no confirm handler, fails closed).
- **Caps, allowlist, kill, hash-chained audit, the 0.05% fee, and the mainnet gate are never
  skipped.** Auto means "no manual tap," not "no checks." One commit path only.
- **Kill** stops ALL bots immediately, best-effort cancels their open orders, and locks the
  vault (wipes decrypted keys + LLM cred). A kill mid-tick blocks any in-flight commit.
- Bots default **paper + disabled + testnet**. paper→live and testnet→mainnet are each an
  explicit, separate arm; mainnet also needs `mainnetEnabled` (operator legal sign-off,
  default off). Importing a template never auto-arms (§6).
- No synthetic prices — a bot with missing market data skips the tick (audited `skipped`).
- Every live order still books realized PnL (§8 ledger) and fires the profit pop-up on a
  positive stablecoin exit.

## 5a. UX + visual design (easy-by-default, advanced-on-demand)

The bar: a first-timer creates a working bot in **under 30 seconds**; a power user can tune
every safety-order parameter. Progressive disclosure, not two separate products.

**Create-a-bot = two tiers, one screen.**
- **Simple (default):** pick a **template card** (Conservative DCA, Wide Grid, BLOCK
  Accumulator, …) → choose the **pair** (searchable, with discovery suggestions) → set **one
  number: amount to allocate** → a plain-language preview ("Buys $X of SOL, adds up to 3 times
  if it dips, takes profit at +2%") → **Start in paper** (primary) / Go live (secondary). No
  jargon on this tier.
- **Advanced (one tap to expand, collapsed by default):** base order, safety-order count /
  step % / step scale / volume scale (martingale), take-profit %, trailing %, stop-loss,
  cooldown, start condition, venue/chain prefs. Each field has a one-line helper + sane
  default pre-filled from the chosen template. A **live deal-preview chart** shows where the
  base order, each safety order, and the take-profit land on the price ladder as you edit —
  so the math is visible, not imagined.

**Bots cockpit (home):** a clean card/list of bots, each showing name, type chip, pair,
mode badge (paper = outline, live = solid accent), status dot, allocation used (a slim
progress bar vs `allocationUsd`), and today's P&L (green/red, sign-explicit). Top: aggregate
P&L hero number + a sparkline, a prominent **Kill-all** control, and a Paper/Live filter.
Empty state = a friendly "Create your first bot" with the template gallery.

**Bot detail:** the deal timeline (base → safety fills → TP) as a vertical stepper, the
price-ladder chart with live mark, realized/unrealized P&L tiles, safety-orders used, win
rate, max drawdown, and the audit trail. Controls: pause / resume / clone / edit / stop /
archive, and a per-bot kill.

**Live-arming flow (the one moment that must feel deliberate):** going paper→live or
testnet→mainnet opens a focused review sheet that restates, in plain language, the
allocation cap, that orders run **auto within that allocation with no further taps**, the
kill switch, and (mainnet) the `mainnetEnabled` requirement. A single clear confirm. Never a
silent flip.

**Visual system (shared across all three wallets, so they look like one product):**
- A documented token set — color ramp, type scale, spacing, radius, elevation — in the
  design reference (`docs/design/bots/`), consumed by extension CSS vars, Flutter `ThemeData`,
  and Qt QSS. One source of truth; no per-wallet drift.
- **Theme-aware**: first-class light AND dark (dark is the default crypto context); never an
  automatic invert — dark is its own validated steps.
- **Charts follow the dataviz method**: validated colorblind-safe palette (run the validator,
  don't eyeball), one axis, thin marks, hover crosshair + tooltip, direct labels, legend for
  ≥2 series, and a table fallback. P&L uses the diverging gain/loss pair with a neutral zero;
  allocation uses a single sequential hue.
- Motion is subtle and purposeful (fill ticks, deal-step advance); respects
  `prefers-reduced-motion`. Hit targets ≥44px. Full keyboard nav + screen-reader labels;
  state never conveyed by color alone (badge text + icon too).
- Numbers are monospaced and aligned; every P&L shows its sign; amounts show the asset.

A single **design reference** (a polished HTML prototype + the token/component specs under
`docs/design/bots/`) is authored FIRST and is the contract the three UI implementations must
match pixel-for-intent. Each wallet's UI is reviewed against it before release.

## 6. Templates / presets

A bot config is exportable/importable JSON ("Blockle Bot template"). Starter set:
Conservative DCA, Aggressive DCA, Wide Grid, Scalp Grid, BLOCK Accumulator. Import **never**
auto-starts a live bot — it lands as `paper` + `disabled` until the user reviews + arms it.

## 7. Parity + tests

All three wallets implement identical bot types, config schema, deal state machine, and
paper-fill simulation. Shared `docs/bot-vectors.json` fixture drives the deal engine:
base order → N safety orders (avgEntry + martingale sizing) → TP close math; trailing-TP
arm/pullback; grid fill-flip; SmartTrade split-TP + trailing SL. Gate-integration tests: a
live bot order is still capped/confirmed/killable; paper never broadcasts; a mainnet bot is
refused when `mainnetEnabled=false`; `allocationUsd` is enforced on top of policy caps.

## 9. Arena — the gamified sandbox (play money, zero risk)

A dedicated **test/learn** mode where anyone designs and runs strategies with **fake funds**
against **simulated markets** — the easiest possible on-ramp, and a safe place to build
intuition before risking anything real. It reuses the exact bot create flow, deal engine,
deal-ladder, and dashboard; only the market feed + balance are simulated and a game layer
sits on top.

- **Play funds only.** Every Arena balance is virtual, labeled **PLAY** / **TEST** everywhere,
  starts at a fixed grant (default 🪙10,000 play), and **cannot be converted to, withdrawn as,
  or exchanged for anything real**. Arena touches **no keys, no vault, no gate, no broadcast** —
  it is pure simulation. This is structurally separate from `mode:'paper'` (which marks against
  live prices); Arena runs against its own scenario engine so it's fast, repeatable, and fair.
- **Simulated markets (seeded, deterministic).** Scenario generators — **Bull**, **Crab**
  (range), **Bear**, **Flash-crash**, **Pump-and-fade** — produce a price path from a seed so a
  run is reproducible, testable, and comparable across players. Replay compresses time (e.g. 90
  simulated days in ~60s) with play/pause/scrub. Optional historical replay of a real pair's
  past data may be added later; synthetic scenarios are the v1 core.
- **Design strategies.** The full two-tier create UI (§5a) + the live deal-ladder, so players
  tune base order / safety ladder / take-profit / trailing and immediately watch the bot act on
  the scenario — orders fill on the chart, play P&L updates live.
- **Game layer.**
  - **Score** = risk-adjusted performance (return penalized by max drawdown), not raw PnL, so
    reckless martingale doesn't top the board. Formula is documented + deterministic.
  - **XP + levels.** Running sims, completing missions, and beating scenarios grant XP; levels
    gently **unlock** advanced parameters and bot types — the same progressive disclosure as the
    real product, as a learning curve.
  - **Missions / challenges** ("Finish the Flash-crash in the green," "Beat +10% in a Crab
    market with a grid," "Build a 4-safety-order ladder that survives −40%"). Clear win
    condition + reward.
  - **Badges / achievements** for milestones.
  - **Leaderboard: local-first.** Personal bests + an on-device board in v1. A global/social
    leaderboard + shareable runs are **deferred** (need the server layer + anti-cheat + a
    fairness review) — see Deferred.
- **Honesty guardrails (hard).** Never imply simulated results predict real profit; show a
  persistent "simulation — not financial advice, past/para-simulated performance ≠ future
  results" line. Scenario seeds + the scoring formula are transparent. No dark patterns, no
  "buy more play funds," no path that nudges toward real money except the one honest CTA below.
- **On-ramp to the real product.** A winning Arena strategy exports as a **Bot template** (§6);
  "Use this for real" imports it as a **paper + disabled** bot (never auto-live), so the game
  feeds the real flow without ever skipping the arming + allocation + mainnet gates.
- **Parity + tests.** Arena uses the same bot config schema + deal engine across all three
  wallets; the scenario generators + scoring are seed-deterministic with shared vectors so a
  given (seed, config) yields identical fills + score in JS/Dart/Python. Tests assert: play
  funds never touch the gate/broadcast path; scenarios are reproducible from seed; score
  penalizes drawdown; "Use this for real" lands paper+disabled.

## Deferred (explicit, roadmap — need server infra + separate compliance review)

External TradingView/webhook signal ingestion, copy-trading, a public bot marketplace, and
cross-device bot sync are **not** in v1: they require a hosted relay + a different risk/KYC
posture. v1 is fully on-device + non-custodial. No feature whose purpose is to evade
KYC/sanctions/geo is in scope, ever.
