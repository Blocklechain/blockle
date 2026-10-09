# AGENTS.md — services/settlement

What this is: the BLOCK→USDC sell/redemption service (deliverable D), the
`http://127.0.0.1:8790` that `blockle-biz` `/api/buy/settle` forwards to.

## Rules for anyone (human or agent) touching this module

- **Operator must obtain legal/compliance sign-off before enabling mainnet.**
  `mainnetEnabled` defaults false and is only honoured when
  `legalReview.completed === true`. Do not weaken this gate.
- **Keys stay here.** The reserve hot-wallet private key lives only in this
  process (`usdc.privateKey` / `SETTLEMENT_RESERVE_KEY`). Never move it into
  `blockle-biz`, the MCP server, the SDK, or logs.
- **Never double-pay.** Payouts go through the `Ledger` with write-before-send.
  Preserve `begin() → pay() → settle()`; a `pending` row must never be
  auto-re-paid. If you add a payout path, add an idempotency test.
- **Never drain the reserve.** Every payout is clamped to a fraction of the
  live USDC balance and the daily cap. Keep the clamp; it is the core safety
  property. If you change it, update `test/clamp.test.ts`.
- **Mirror `web/buy.js`, don't invent numbers.** `src/curve.ts` is a
  byte-for-byte mirror of the buy page's sell math. Treat live config values
  (reserve addresses, curve params) as source of truth; never hardcode
  addresses.
- **Base units everywhere**; convert to whole units only at display edges.
- **Field names on `/settle` are fixed** (`blockTxid`, `userUsdcAddr`) by
  `src/biz.rs`. Do not rename.
- **KYC/geo** is a pluggable hook (`ComplianceScreener`), NO-OP in dev. Never
  add a feature whose purpose is to evade KYC/sanctions/geo.

## Layout

- `src/config.ts` — config + mainnet gate + testnet defaults.
- `src/curve.ts` — sqrt curve, mirror of `web/buy.js`.
- `src/chain.ts` — inbound-BLOCK verification via node aux-http explorer.
- `src/reserve.ts` — USDC reserve: `MockUsdcReserve` (dev) / `EthersUsdcReserve`
  (real Base payouts; `ethers` lazy-required).
- `src/ledger.ts` — persistent idempotency/dedupe + payout ledger.
- `src/compliance.ts` — pluggable KYC/geo screener (NO-OP default).
- `src/settle.ts` — the engine (verify → quote → clamp → screen → pay).
- `src/server.ts` / `src/index.ts` — HTTP + wiring.
- `test/` — idempotency, availability clamp, mainnet/confirmation/compliance gating.

## Build / test

`npm run build` then `npm test`. Tests are offline (fakes for chain + reserve);
they must stay green and must not require a live node or EVM.
