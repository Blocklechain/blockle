# BLOCK ↔ wBLOCK bridge — fees & economic model

**Nothing here is a promise of profit, appreciation, or guaranteed liquidity.** wBLOCK is a
custodial claim on operator-held BLOCK (see [`ARCHITECTURE.md §1`](./ARCHITECTURE.md)). Prices
below are **pool rates**, not fair value, and are illustrative only. No real token, pool, or
liquidity exists yet.

---

## 1. Bridge fee model

The bridge fee is **configurable and defaults to 0** (`BRIDGE_FEE_BPS=0`). Minting against a
verified deposit and releasing against a verified burn are, by default, 1:1 in base units
(1 BLOCK base unit ↔ 1 wBLOCK base unit), minus only unavoidable on-chain network fees paid by
whoever submits the transaction.

Alternative fee structures the operator may enable (all gated, all off by default):

| Model                     | Config knob                   | Notes                                                        |
|---------------------------|-------------------------------|--------------------------------------------------------------|
| **No fee (default)**      | `BRIDGE_FEE_BPS=0`            | 1:1 backing, operator eats network fees or recovers them below |
| **Fixed minimum**         | `BRIDGE_FEE_MIN_BASE`        | Flat floor per bridge op; protects against dust-spam economics |
| **Percentage**            | `BRIDGE_FEE_BPS` (basis pts)  | e.g. `10` = 0.10%; mirrors the exchange's 0.1% settlement fee |
| **Network-fee recovery**  | `BRIDGE_RECOVER_NETWORK_FEE`  | Deduct the actual SOL mint/ATA + BLOCK send fee from the amount |
| **Treasury share**        | `BRIDGE_TREASURY_BPS`        | Portion of the fee routed to the treasury bucket (bucket 5)   |

Any fee is taken transparently and shown in the quote **before** the user acts; it is never
applied silently. Fees never touch the 1:1 **backing** invariant — a fee reduces what the user
receives, it does not let the operator mint wBLOCK the reserve does not back.

---

## 2. Indicative pool price (a pool rate, NOT fair value)

If and when the operator seeds a wBLOCK/SOL trading pool, the **initial indicative rate** is:

> **$100 of SOL in reserve paired with 1,000 wBLOCK ⇒ $0.10 per wBLOCK.**

This is purely the **arithmetic of the seeded pool** (reserve value ÷ paired token count). It is:

- **NOT** a valuation of BLOCK or wBLOCK,
- **NOT** a floor, peg, or redemption guarantee,
- **NOT** a price the operator commits to maintain.

It is the spot rate a constant-product pool starts at with that seeding. The moment anyone trades,
the rate moves. The backing promise is "1 wBLOCK is redeemable for the BLOCK it was minted
against" — **not** "1 wBLOCK is worth $0.10".

### Why spot × supply ≠ realizable proceeds
A pool quotes the price of the **next marginal unit**, not the average price of selling the whole
supply. In a constant-product (x·y=k) pool, selling into the pool walks the price **down** the
curve: each unit sold gets less than the last. So:

- `spot price × outstanding supply` is a **notional** number ("market cap"), not cash anyone can
  realize.
- Trying to sell a large fraction of supply into a thin pool realizes **far less** than
  notional, because of slippage (next section).

Never present `spot × supply` as money that exists.

### Why low liquidity → high slippage
Slippage is the gap between the spot quote and the average fill price, and it grows with
`trade size ÷ pool depth`. A pool seeded with only ~$100 of SOL is **extremely thin**: even a
small sell consumes a large fraction of the SOL side, so the price drops steeply within a single
trade. Thin liquidity means large trades are effectively impossible to exit near spot. This is a
property of AMMs, not a bug, and it is the single most important thing a holder must understand.

---

## 3. The 8 scenarios

Each walks through what actually happens. "Pool" means a hypothetical wBLOCK/SOL AMM seeded per
§2; "redeem" means burn wBLOCK → operator releases backing BLOCK via `reserve-signer`.

1. **No trading.** Pool sits at the seeded rate ($0.10). No fills, no price discovery. Redemption
   path is independent of the pool: a holder can still burn wBLOCK and receive the backing
   BLOCK 1:1 (minus any configured fee), regardless of pool price.

2. **Small buy.** A buyer swaps a little SOL for wBLOCK. Price ticks up slightly; slippage is
   small because the trade is small relative to depth. Pool now holds more SOL, less wBLOCK.

3. **Small sell.** A holder swaps a little wBLOCK for SOL. Price ticks down slightly; small
   slippage. Alternatively they redeem 1:1 for BLOCK instead of selling into the pool — often the
   better path when the pool is thin.

4. **Large sell vs depth.** A holder dumps a large fraction of supply into the thin pool. Price
   **collapses** along the curve; realized average price is a small fraction of the $0.10 spot.
   This is the slippage scenario: the holder gets far less than notional. Redeeming 1:1 for BLOCK
   is the alternative, but is bounded by the reserve-signer caps (it may take multiple days under
   the daily cap).

5. **Full redemption.** Every holder burns all wBLOCK and claims backing BLOCK. Because backing
   is 1:1 and the invariant (bucket 1 ≥ bucket 2) holds, all claims are honorable **in principle**
   — but releases are rate-limited by the daily/per-dispense caps, so a mass redemption is paid
   out over time, not instantly. The SOL pool (buckets 3–4) is separate and does **not** back
   redemptions.

6. **LP withdrawal.** The operator (or any LP) withdraws liquidity from the pool. Remaining
   depth drops, so slippage for everyone else rises; in the limit, removing all liquidity leaves
   the pool untradeable. LP withdrawal does **not** affect the 1:1 BLOCK backing — it only affects
   tradeability and pool price. LPs are exposed to impermanent loss independent of backing.

7. **Sudden SOL price move.** SOL's USD price swings. The pool's wBLOCK/SOL ratio is unchanged by
   this, but the **USD-denominated** indicative price of wBLOCK moves with SOL. The BLOCK backing
   is denominated in BLOCK, not USD or SOL, so a SOL move changes the pool's dollar optics without
   changing how much BLOCK a wBLOCK redeems for. Do not conflate the two.

8. **Bridge suspension with pending redemptions.** The operator pauses (see
   [`INCIDENT-RESPONSE.md`](./INCIDENT-RESPONSE.md)). New mints and releases stop. Pending
   redemptions are **queued, not lost** — their state rows persist in the durable store and resume
   when the bridge un-pauses. During suspension the pool may still trade (it is on-chain and
   permissionless), so pool price and redemption availability can diverge; holders may see a pool
   price while being unable to redeem until the pause lifts. This gap is disclosed, not hidden.

---

## 4. What we never say
- We never promise wBLOCK will appreciate, hold a price, or stay liquid.
- We never present `spot × supply` as realizable value.
- We never describe the off-chain reserve ledger as an on-chain vault.
- We never guarantee instant redemption at scale — caps rate-limit releases by design.
