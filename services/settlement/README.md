# @blockle/settlement — sell / redemption service (deliverable D)

The missing `http://127.0.0.1:8790` that `blockle-biz` (`src/biz.rs`,
`/api/buy/settle`) forwards sell requests to. It lets a holder redeem BLOCK for
USDC: they send BLOCK to the reserve on the BLOCK chain, then tell this service
the BLOCK txid and their Base USDC address; the service **verifies the inbound
BLOCK on-chain**, prices it on the same sqrt curve the `/buy` page uses, clamps
the payout so the reserve can never be drained, and **pays USDC on Base** from
the reserve hot wallet.

> ⚠️ **Operator must obtain legal/compliance sign-off before enabling mainnet.**
> Every USDC money path is disabled by default. Mainnet payouts require BOTH
> `mainnetEnabled: true` AND `legalReview.completed: true` in config. Until then
> the service runs on Base Sepolia (testnet) with a mock reserve and moves no
> real funds.

## HTTP API

Bind: loopback only (`127.0.0.1:8790`) — it is reached through `blockle-biz`.

### `POST /settle`  — redeem BLOCK for USDC
Body (field names fixed by `src/biz.rs`, do not rename):
```json
{ "blockTxid": "<64-hex BLOCK txid>", "userUsdcAddr": "0x… (Base)" }
```
Success `200`:
```json
{
  "usdcOut": 912.34,
  "usdcOutBase": "912340000",
  "txHash": "0x…",
  "explorer": "https://sepolia.basescan.org/tx/0x…",
  "partial": false,
  "blockIn": 1000,
  "quote": { "...": "full quote detail" }
}
```
Error `400`:
```json
{ "error": "human message", "code": "MACHINE_CODE" }
```
`usdcOut`, `txHash`, `explorer` are exactly what `web/buy.js` renders.

### `POST /quote`  — read-only price (no payout)
Body: `{ "block": "100000000000" }` — base units (integer string) **or** a whole
BLOCK number. Returns the curve quote plus the clamped payable amount and which
guard bound it (`boundBy`).

### `GET /health`
Liveness + posture (network, reserve mode, whether mainnet is active, the
configured confirmation depth / daily cap / clamp fraction).

## How a redemption is priced (availability pricing)

1. **Verify inbound BLOCK.** Read the node aux-http explorer
   (`GET /explorer/tx/{id}`, same contract the SDK's `NodeClient` uses). The tx
   must pay `blockReserveAddr` and have `>= confirmationDepth` confirmations
   (reorg safety — depth is config, default 100). The redeemed amount is taken
   from the tx's outputs to the reserve, not from anything the caller claims.
2. **Read the LIVE reserve USDC balance on Base** (`balanceOf`, exactly as
   `web/buy.js` does). This single number drives price.
3. **Curve quote.** Price the redeemed BLOCK on the sell side of the sqrt
   primary-sale curve — a byte-for-byte mirror of `web/buy.js`
   (`price(R) = max($0.10, sqrt(p0² + 2kR))`, 5% fee). `$0.10` is the treasury
   **floor** only.
4. **Availability clamp.** The payout is
   `min(curveQuote, maxReserveFractionPerRedemption × liveBalance, dailyCapRemaining, liveBalance)`.
   A low reserve therefore yields a **partial fill / lower effective price**
   (`partial: true`, `boundBy` tells you which guard bound it). The reserve can
   never be drained by a single redemption.

## Safety properties

- **Idempotent payouts.** One `blockTxid` → at most one USDC payout. The ledger
  (`ledgerPath`, a JSON file rewritten atomically) uses *write-before-send*: a
  `pending` row is persisted **before** any USDC moves and rewritten `settled`
  after. A duplicate/concurrent request for the same txid is refused
  (`IN_PROGRESS`); a settled txid replays its receipt without re-paying. A crash
  between send and settle leaves the row `pending`, which is **never re-paid**
  (safe direction; operator reconciles). Covered by `test/idempotency.test.ts`.
- **Reorg safety.** `confirmationDepth` confirmations required before payout;
  configurable.
- **Daily cap.** `dailyCapUsdc` rolling-24h ceiling on total payouts.
- **Keys stay here.** The reserve hot-wallet key lives only in this process
  (`usdc.privateKey` or `SETTLEMENT_RESERVE_KEY`), never in `blockle-biz`.
- **KYC / geo hook.** Pluggable `ComplianceScreener` at the payout boundary,
  NO-OP in dev. Wire a real screener via `compliance.module` before mainnet.
  It is never a mechanism for evading KYC/sanctions/geo.
- **Base units everywhere**; conversion to whole units only at display edges.
- **Testnet-first.** Defaults to Base Sepolia + a mock reserve.

## Config

See `config.example.json`. Load order: built-in defaults ← JSON file
(`SETTLEMENT_CONFIG`, default `/etc/blockle-settlement/config.json`) ← env
(`SETTLEMENT_RESERVE_KEY`, `SETTLEMENT_PORT`). A config with `usdc.mode:"ethers"`
but no key is forced back to `mock` so it can never half-arm.

Key fields: `blockReserveAddr`, `confirmationDepth`, `maxReserveFractionPerRedemption`,
`dailyCapUsdc`, `usdc.{network,rpc,contract,reserveAddr,explorerBase,mode}`,
`curve.{startPrice,targetUsdc,allocation,feeBps}`, `legalReview`, `mainnetEnabled`.

## Reserve modes

- `mock` (default): no EVM, a configurable `mockBalanceUsdc`, deterministic fake
  tx hashes. Dev + tests.
- `ethers`: real reads + ERC-20 `transfer` on Base via a lazily-required
  `ethers` v6 signer. `npm install ethers` to enable; the service builds and
  tests without it.

## Build / run / test

```bash
npm install
npm run build
npm test          # idempotency + availability clamp + gating (offline, no node/EVM)
npm start         # listens on 127.0.0.1:8790
```

## Relationship to the rest of the repo

- `src/biz.rs` `/api/buy/settle` → forwards `{blockTxid,userUsdcAddr}` here.
- `web/buy.js` → the curve this service mirrors and the UI that calls it.
- node aux-http `/explorer/tx/{id}` → inbound BLOCK verification.
- The curve math and clamp are validated against `web/buy.js` in `test/clamp.test.ts`.
