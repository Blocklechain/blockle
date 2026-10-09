# @blockle/x402-buy — the x402 payment rail

The agent payment rail for the whole Blockle super-exchange. It exposes three
[x402](https://x402.org)-gated HTTP resources — **buy BLOCK**, **pay a listing
fee**, and a **generic priced action** — plus discovery so agents (and
[x402scan.com](https://x402scan.com)) can find and pay them automatically.

> ⚠️ **COMPLIANCE — read before enabling mainnet.** Every fiat/USDC money path
> is **DISABLED by default**. Real USDC settlement on Base mainnet
> (`eip155:8453`) and a production facilitator are gated behind
> `mainnetEnabled=true` **AND** `legalReviewCompleted=true`, which an operator
> may set **only after recording a completed legal/compliance review**. In dev
> the service runs on **Base Sepolia** with the public `https://x402.org/facilitator`.
> KYC/geo screening runs at the settlement boundary. **No key ever lives in
> this service.**

## What it does

| Resource | Method | Price | Action |
|---|---|---|---|
| `/x402/buy` | GET, POST | the USDC you pass (`usdc`) | settle USDC → release BLOCK from the reserve to `to` on the sqrt primary-sale curve |
| `/x402/list` | POST | `$5` + `$1`/extra pair | settle USDC to the treasury → return a signed `listing-paid` receipt the relay accepts |
| `/x402/pay` | POST | `usd` you pass | settle USDC to the treasury → return a signed `action-paid` receipt |

Discovery:

- `GET /x402-resources.json` — the manifest submitted to x402scan.com (each
  resource's public URL, price, network, input/output schema).
- `GET /discovery/resources` — the x402 **Bazaar** discovery extension list
  (each resource wrapped in representative `PaymentRequirements`).

Ops: `GET /healthz`, `GET /ledger/recent`.

## The payment flow (every priced resource)

```
client → request without X-PAYMENT
service → 402 { x402Version, accepts:[PaymentRequirements], error }   (official SDK shape)
client → retry with X-PAYMENT header (produced by x402-fetch / the agent's EVM signer)
service → decode → verify → KYC/geo screen → settle USDC via the facilitator
        → perform the action (release BLOCK / sign a receipt)
        → 200 + X-PAYMENT-RESPONSE header
```

Wire format, header names, the 402 body, and the protocol version all come from
the official `x402` seller SDK (`x402/verify`, `x402/schemes`, `x402/shared`,
`x402/types`) — **nothing is hardcoded**.

### Pricing BLOCK

BLOCK is priced by the **exact** sqrt primary-sale curve in `web/buy.js`
(mirrored in `src/curve.js`):

```
price(R) = max(p0, sqrt(p0² + 2·k·R))        p0 = $0.10 floor
k        = 2·(targetUsdc − p0·allocation) / allocation²
blockOut = sold(R + net) − sold(R)           net = usdc·(1 − fee)
```

Curve params (`startPrice`, `targetUsdc`, `allocation`), the `feeBps` (5%
default), the USDC reserve address + Base RPC, and the BLOCK reserve address all
come from **`buy-config.json`** — the same file the site `/api/buy/config`
serves. The current reserve `R` is read live from Base (`eth_call balanceOf`),
exactly like `buy.js`. Numbers are never invented here.

### Releasing BLOCK (keys stay with the reserve)

Release shells the **reserve wallet CLI**, which holds the reserve key and signs
+ broadcasts itself — the key is never in this process:

```
blockle-chain --json --datadir <reserve> send \
    --to <block1…> --amount <N BLOCK> --node 127.0.0.1:18444
```

`command`, `reserveDatadir`, and `nodeAddr` are config. `release.dryRun`
defaults **true** so a box without the reserve wallet returns a deterministic
`dryrun-…` txid (and still records it in the ledger) rather than shelling a
missing binary. Flip it off in production.

## Safety properties

- **Idempotent + crash-safe.** Every payment is keyed by a stable hash of its
  `X-PAYMENT` header and written to a persistent SQLite ledger **before**
  settlement; it is only marked `released` after the action succeeds. Lifecycle:
  `verifying → settled → released`. A replay of the same header returns the
  stored result; a crash after settle-before-release resumes the release without
  re-settling. A settled-but-failed action is recorded for operator retry
  (never silently dropped, never double-paid).
- **Reorg / cap guards.** `confirmations` (inbound-fee verification depth) and a
  `dailyCapUsd` settlement cap are **config, not constants**.
- **KYC/geo hook.** `src/kyc.js` runs between verify and settle. NO-OP in dev;
  operators wire a real screener via `kycModule`. There is intentionally no path
  whose purpose is to evade KYC/sanctions/geo — the hook can only ALLOW or DENY.
- **Amounts in base units.** USDC in micro (6dp), BLOCK in base units (1e8);
  conversion happens only at the CLI/display edge.
- **Non-custodial.** The service holds no keys. USDC moves by the client's
  signed authorization through the facilitator; BLOCK moves via the reserve
  wallet CLI; receipts are HMAC-signed with a secret **shared with the relay**
  (not a wallet key).

## Config

Copy the samples and edit (env `X402_*` overrides any file value):

```
cp config/service.config.sample.json config/service.config.json
# operator's buy-config.json is read from /var/lib/blockle-biz/buy-config.json;
# config/buy-config.sample.json is the dev fallback.
# listing-fee treasury comes from ../../exchange/treasury.json
```

Key env vars: `X402_MAINNET_ENABLED`, `X402_LEGAL_REVIEW_COMPLETED`,
`X402_NETWORK`, `X402_FACILITATOR_URL`, `X402_PROD_FACILITATOR_URL`,
`X402_PUBLIC_BASE`, `X402_BUY_CONFIG`, `X402_TREASURY`, `X402_RECEIPT_SECRET`,
`X402_RESERVE_DATADIR`, `X402_RELEASE_DRYRUN`, `X402_DAILY_CAP_USD`,
`X402_CONFIRMATIONS`.

## Run

```
npm install
npm test          # curve math, 402 shape, idempotency, gating, discovery
npm start         # listens on :8402 (X402_PORT)
npm run manifest  # regenerate x402-resources.json from config
```

## SDK / MCP

The SDK's `X402Client` (`sdk/src/money.ts`) and `buyBlock()` / `listAsset()`
settle over these resources by default and expose the resource URLs for
discovery. See `../../sdk/README.md`.
