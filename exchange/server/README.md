# @blockle/exchange-server — non-custodial relay for exchange.blockle.org

A **non-custodial** atomic-swap **relay** + **super-exchange** listing registry.
It **holds NO user funds, ever** — not in escrow, not in transit, not at rest.
It only:

1. **authenticates** wallets by signature (MetaMask / Phantom / Blockle),
2. keeps a book of **signed swap intents** (orders),
3. **matches** crossing orders with price-time priority, and
4. **coordinates** the hashlock/preimage/timelock handshake of an atomic swap
   that the two parties execute themselves with their own keys.

There is **no deposit and no withdrawal** — there is nothing to withdraw,
because the relay never custodies anything. Keys and funds stay with their
owners at every step.

> ⚠️ **Operators must obtain legal / compliance sign-off before enabling
> mainnet.** Every fiat/USDC/on-chain fee path is **TESTNET-FIRST** and gated
> behind `mainnetEnabled`, which only takes effect once a completed legal
> review is recorded in config (`legalReview.completed=true`). Until then the
> relay runs on testnets (Base Sepolia, Solana devnet, ETH Sepolia).

## Shortest path — finish a trade end-to-end (agent, ≈10 lines)

Use the SDK (`sdk/`), which is a first-class client of this relay:

```ts
import { BlockleAgent } from "@blockle/agent-sdk";
const agent = new BlockleAgent({ nodeUrl: "...", siteUrl: "...", exchangeUrl: "http://127.0.0.1:8900" });
agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);
const swap = await agent.exchange.swap("BLOCK", "USDC", String(10n * 100_000_000n), { slippage: 1 });
console.log("done:", swap.swapId, swap.state);
```

## Shortest path — list an asset (BLOCK pair auto-included)

```ts
await agent.exchange.listAsset({
  asset: { symbol: "MYT", chain: "block", kind: "block20", addr: TOKEN, decimals: 8 },
  extraPairs: ["USDC"],   // $5 base (asset + mandatory BLOCK/MYT) + $1 per extra pair
});
```

## Run it

```bash
cd exchange/server
npm install          # builds better-sqlite3 + the blockle-wasm dep
npm run build
npm start            # :8900 by default, testnet mode
npm test             # signature verification (EVM+Solana+BLOCK), matching, swap FSM
```

Config precedence: built-in defaults < `config.json` (copy `config.example.json`)
< environment variables (`BLOCKLE_EXCHANGE_*`).

## Fee table

| What | Fee | Who pays / how |
| --- | --- | --- |
| **Protocol swap fee** | **0.1%** (`protocolFeeBps=10`, config) | Encoded into the swap **settlement** — **NOT collected by the relay**. |
| **Deposit** | **none** | There is no custody, so there is nothing to deposit. |
| **Withdrawal** | **none** | There is no custody, so there is nothing to withdraw. |
| **List an asset** | **$5** (`listingFeeUsd`) | Paid non-custodially to the treasury; covers the asset **+ its mandatory BLOCK pair**. |
| **Each extra pair** | **$1** (`perPairFeeUsd`) | `<asset>/ETH`, `/SOL`, `/USDC`, `/USDT`, or any registry asset. |

Listing fees are paid **non-custodially**: the lister pays the configured
treasury address on-chain (USDC or BLOCK-equivalent) **or** presents an x402
`listing-paid` receipt. The relay **verifies** the payment (txid + confirmations,
or the receipt) **before** activating — it never holds the fee and never routes
around it. Real fee collection is gated by `mainnetEnabled`; dev/testnet fees
settle on testnet.

## Assets & markets (config-driven)

A **registry** maps each symbol → `{chain, kind(native|erc20|spl|block20), addr, decimals}`
with **testnet addresses by default** and mainnet addresses **gated**. Built-in
base assets: **BLOCK, ETH, SOL, USDC, USDT**. The live `/markets` list is
**derived** from the registry + active listings — never a hardcoded pair list:

- base markets: `BLOCK/ETH`, `BLOCK/SOL`, `BLOCK/USDC`, `BLOCK/USDT`, `ETH/USDC`, `SOL/USDC`
- per listing: the **mandatory** `BLOCK/<asset>` pair + any extra pairs

Every listing **must** include its BLOCK pair; a listing without it is rejected
(and is impossible to even represent — the BLOCK pair is auto-prepended).

## Shared API contract (this relay implements it exactly)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/nonce` | `{address, chain}` → `{nonce}` |
| POST | `/auth/verify` | `{address, chain, signature, publicKey?}` → `{token}` (EVM `personal_sign`; Solana ed25519; BLOCK ML-DSA — `publicKey` required for BLOCK) |
| GET | `/markets` | config-driven off the registry |
| GET | `/book/:market` | `{bids,asks}` |
| GET | `/trades/:market` | recent fills |
| POST | `/orders` | `{...intent, intent, signature}` — signed swap intent, verified server-side |
| DELETE | `/orders/:orderId` | signed cancel |
| GET | `/orders/mine` ; `/swaps/mine` | your orders / swap state machines |
| POST | `/swaps/:id/step` | `{action, payload}` — advance the HTLC handshake (client performs the on-chain leg) |
| POST | `/listings/quote` | `{asset, extraPairs}` → `{totalUsd, breakdown, payTo, payAsset, payAmount, markets}` |
| POST | `/listings` | `{asset, extraPairs, paymentTxid \| x402Receipt}` → verify fee, activate |
| GET | `/listings` | active listings |
| WS | `/stream?markets=` | `{type:'book'\|'trade'\|'swap', ...}` |

Agents are first-class: everything the web UI can do is reachable
programmatically via the SDK + MCP (sign in, read book, place/cancel signed
orders, run a swap to completion, list an asset).

## Atomic-swap state machine

```
proposed ─► makerLocked ─► takerLocked ─► makerWithdrew ─► claimed
     └────────────── (timelock expiry) ──────────────► refunded
```

The relay coordinates the hashlock `H` and releases the preimage to the maker
to claim, then to the taker; the **clients** perform every on-chain HTLC
lock/withdraw/refund with their **own** signers (SDK `HtlcSigner`). The relay
holds no funds and no keys, so even knowing the preimage never lets it move
value. See `src/swaps.ts`.

> Security note / documented followup: in this coordination model the relay
> generates the swap secret. A stronger variant where the **maker** owns the
> secret (relay only relays `H`) is a planned hardening; it does not change the
> non-custodial guarantee (no funds, no keys in the relay).

## Compliance & safety

- **KYC / geo-sanctions hooks** at every trade and fee boundary
  (`src/compliance.ts`) — a pluggable interface, **no-op in dev**. There is no
  feature whose purpose is to evade KYC/sanctions/geo.
- **Idempotency + persistent ledgers** (SQLite): orders dedupe by
  `(maker, nonce)`; listing fees dedupe by payment reference; a crash never
  double-activates or double-counts.
- **Reorg safety**: `confirmationDepth` and `dailyCapUsd` are **config**, not
  constants.
- **Audit log**: every consequential action is appended to `audit_log`.
- **Keys stay with their owner** — the relay process has none.
- **Amounts are base units** everywhere; conversion happens only at display
  edges.

## x402 discovery

`GET /x402-resources.json` publishes the x402 resource manifest (buy BLOCK,
pay a listing fee, generic pay) for submission to x402scan.com / the x402
Bazaar. The x402 **seller** endpoints live in the separate x402 service (keys
never here); this relay only advertises them and accepts `listing-paid`
receipts. Public base URL is configurable (`publicBaseUrl`).

## Persistence

SQLite (`better-sqlite3`, WAL). Tables: `nonces`, `sessions`, `assets`,
`listings`, `orders`, `trades`, `swaps`, `audit_log`, `idempotency`. Default
file `data/exchange.db`; tests use `:memory:`.
