# AGENTS — services/x402-buy

The x402 payment-rail service. Agents pay these resources with USDC; the
service settles via the x402 facilitator and performs the action.

## Resources

- `GET|POST /x402/buy?to=<block1…>&usdc=<dollars>` → buy BLOCK on the sqrt
  curve; returns `{ blockOut, blockTxid, usdcIn, avgPrice, receipt, … }`.
- `POST /x402/list { asset, extraPairs }` → pay the listing fee; returns a
  signed `listing-paid` receipt the exchange relay accepts to activate the
  asset + its mandatory `BLOCK/<symbol>` pair (+ extra pairs).
- `POST /x402/pay { actionId, usd }` → generic priced action; returns a signed
  `action-paid` receipt.
- `GET /x402-resources.json`, `GET /discovery/resources` → discovery.

From the SDK: `X402Client.buy()`, `X402Client.payListing()` (see
`sdk/src/money.ts`); the MCP exposes `exchange_list_asset` / buy tools.

## How to pay

1. Call the resource with no `X-PAYMENT` → you get a **402** with
   `accepts:[PaymentRequirements]` (official x402 shape, version in `x402Version`).
2. Produce the `X-PAYMENT` header from that challenge with your own EVM/USDC
   signer (e.g. `x402-fetch`). **Your key stays with you.**
3. Retry with the `X-PAYMENT` header → settlement happens and you get `200` +
   an `X-PAYMENT-RESPONSE` header (the settled tx).

## Rules for anyone editing this service

- **TESTNET-FIRST.** Do not enable a mainnet money path. `mainnetEnabled` +
  `legalReviewCompleted` must BOTH be true, set **only** after an operator
  records a completed legal/compliance review. Dev = Base Sepolia +
  `https://x402.org/facilitator`.
- **Never put a key here.** USDC moves by the payer's signed authorization via
  the facilitator; BLOCK moves via the reserve wallet CLI (`blockle-chain …
  --datadir <reserve> send`), which owns the reserve key. The receipt HMAC
  secret is shared with the relay, not a wallet key.
- **Never hardcode addresses.** Reserve + USDC come from `buy-config.json`;
  the listing-fee treasury comes from `exchange/treasury.json`. Read at runtime.
- **Mirror the curve exactly** from `web/buy.js` (`src/curve.js`). Do not invent
  numbers.
- **Idempotency is sacred.** Keep the write-before-settle, mark-released-after
  ledger discipline. A crash must never double-pay.
- Keep the required **BLOCK pair mandatory** on every listing and never add a
  path that bypasses the fee.

> Operators: obtain legal/compliance sign-off before enabling mainnet.
