# @blockle/agent-sdk

The TypeScript SDK for autonomous **agents** (and apps) on the Blockle L1.
Wallets, transfers, BLOCK-20 token launches, the native AMM, the USDC buy/sell
on-ramp, and a first-class client for the **non-custodial exchange** (trade +
permissionlessly list assets).

Signing is **byte-identical to consensus** — every signature and raw
transaction is produced by `blockle-wasm` (ML-DSA-44 + the same bincode tx
encoding the node validates). **Keys live in the agent's process and never
leave it.** All amounts are **base units** (`bigint`): `1 BLOCK = 100_000_000`;
a token uses `10^decimals`.

## Shortest path — finish a trade end-to-end (≈10 lines)

```ts
import { BlockleAgent } from "@blockle/agent-sdk";

const agent = new BlockleAgent({
  nodeUrl: "http://127.0.0.1:8445",
  siteUrl: "http://127.0.0.1:8787",
  exchangeUrl: "http://127.0.0.1:8900",
});
agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);

// signs in, finds/takes the best order, drives the atomic swap to completion
const swap = await agent.exchange.swap("BLOCK", "USDC", String(10n * 100_000_000n), { slippage: 1 });
console.log("done:", swap.swapId, swap.state);
```

## Shortest path — list an asset (BLOCK pair auto-included)

```ts
await agent.exchange.signIn("block");
const { listingId, markets } = await agent.exchange.listAsset({
  asset: { symbol: "MYT", chain: "block", kind: "block20", addr: TOKEN, decimals: 8 },
  extraPairs: ["USDC"],    // $5 base (asset + mandatory BLOCK/MYT) + $1 per extra pair
});
```

## Install

```bash
npm install            # builds blockle-wasm into pkg-node is NOT automatic; see below
npm run build
npm test               # unit test: the constant-product quote math
```

The SDK depends on `blockle-wasm` via `file:../blockle-wasm/pkg-node`. Build it
(byte-identical signing) with:

```bash
npm run build:wasm     # == cd ../blockle-wasm && wasm-pack build --target nodejs --out-dir pkg-node
```

(If `wasm-pack` isn't available, the browser build at `blockle-wasm/pkg` has the
same exports, but the `--target nodejs` build is what this SDK consumes.)

## The agent object

```ts
const agent = new BlockleAgent(config);
```

`config`: `{ nodeUrl, siteUrl, exchangeUrl?, x402Url?, networkId?, timeoutMs?, evm?, solana?, x402? }`.

### Wallet
- `createWallet()` → `{ address, publicKey, secretKey }` (fresh ML-DSA-44)
- `importWallet(secretHex, publicHex)` → `{ address }`
- `address()`

### Reads
- `getBalance()` → `bigint` (spendable base units)
- `getUtxos()` → `Utxo[]` (GET `/explorer/utxos/{addr}`)
- `getPools()`, `getPool(token)`, `getToken(id, holder?)`, `getAddressInfo(addr?)`

### Transact (returns a submitted txid)
- `send(to, amount, fee?)`
- `launchToken({ name, symbol, decimals, supply })` → `{ contractId, deployTxid, initTxid }`
  (build bytecode → deploy → wait for confirm → `init()` mints supply to you)
- `createPool(token, blockAmt, tokenAmt)`, `addLiquidity(token, blockAmt, tokenMax)`, `removeLiquidity(token, shares)`
- `quote(token, "buy" | "sell", amountIn, slippagePct?)` → `{ amountOut, minOut, priceX18 }`
  (exact consensus math, mirrored from `web/dex.js` — set `minOut` from a slippage %)
- `swapBuy(token, blockIn, { slippage?, minOut? })`, `swapSell(token, tokenIn, { slippage?, minOut? })`
- `waitForTx(txid, minConfs?)` (polls `/explorer/tx/{id}`)

### Money (USDC on-ramp)
- `buyBlock(usdcBaseUnits)` → buys BLOCK on the sqrt curve over **x402**
- `sellBlock(blockAmount, { userUsdcAddr?, fee?, minConfs? })` → sends BLOCK to the
  reserve, then the settlement service verifies it and pays USDC to your Base address

### Exchange — `agent.exchange`
See [Exchange](#exchange) below. Everything the web UI can do is reachable here.

Every write method returns the submitted txid; gas/fees follow the consensus
schedule exactly (`deploy 300000`, `init 120000`, `poolCreate 250000`,
`swap/call 200000`, `gas_price 10`).

## Exchange

`agent.exchange` is a full client of the **shared exchange relay contract**. The
relay only coordinates the hashlock + preimage + timelocks; **the client
performs every on-chain HTLC leg with its own signer.** The relay never holds
funds or keys.

- `signIn(chain?)` — fetch a nonce, sign it with the right key (ML-DSA for
  `block`), verify → session
- `getMarkets()`, `getBook(market)`, `getTrades(market)`
- `placeOrder({ market, side, type?, price?, amount, expiry? })` — builds + signs
  the swap intent and POSTs it (server verifies the signature)
- `cancelOrder(id)`, `getMyOrders()`, `getMySwaps()`
- `executeSwap(swapId)` — drives the atomic-swap state machine to completion
- `swap(from, to, amount, { slippage? })` — **one call**: sign in, take/post the
  best order, complete the swap
- `listingQuote(asset, extraPairs?)`, `getListings()`
- `listAsset({ asset, extraPairs?, payWith? })` — quote → pay the fee
  non-custodially to the relay's treasury → register with the payment txid. The
  mandatory `BLOCK/<asset>` pair is always included; the relay rejects a listing
  without it.

### Pluggable signers (keys stay with the agent)

The BLOCK signer is always present (blockle-wasm). To settle ETH/BASE/SOL/USDC/
USDT legs, inject your own HTLC signer via `config.evm` / `config.solana`:

```ts
const agent = new BlockleAgent({
  nodeUrl, siteUrl, exchangeUrl,
  evm: { chain: "base", signer: myEthersHtlcSigner },   // implements HtlcSigner
});
```

An `HtlcSigner` implements `address()`, `signNonce(nonce)`, and
`htlcLock/htlcWithdraw/htlcRefund`. The SDK depends on **neither** ethers nor
`@solana/web3.js` — you bring your own, so the SDK stays dependency-light and
your keys never touch it.

## x402

x402 is the agent payment rail. `buyBlock()` and `listAsset()` settle over x402
by default. The x402 service exposes `/x402/buy`, `/x402/list`, `/x402/pay`;
discover them with `agent.x402.resources()`. A real USDC payment is produced by
an injected `X402Payer` (`config.x402.payer`) backed by your own EVM/USDC signer
— in dev a free/mock service needs none.

## Compliance & safety (read before mainnet)

> **Operators MUST obtain legal/compliance sign-off before enabling mainnet.**

- **Testnet-first.** Every fiat/USDC/SOL/ETH money path is **disabled by
  default** behind a server-side `mainnet_enabled` flag that only flips true
  once an operator records a completed legal review. Dev uses testnets (Base
  Sepolia, Solana devnet, ETH Sepolia) and testnet facilitators.
- **KYC/geo hooks** exist at every fiat/custody boundary (no-op in dev). Nothing
  here is designed to evade KYC/sanctions/geo.
- **Non-custodial.** The SDK holds only the agent's own keys. The buy/sell/
  settlement and exchange-relay services own their reserve keys; this SDK never
  sees them.
- **Idempotency + reorg safety** (dedupe by txid, confirmation depth, daily
  caps) are enforced by those services, which are config-driven, not hardcoded.
- Amounts are base units everywhere; convert only at display edges.

## Examples

`examples/` — run with `npx tsx examples/<file>.ts` (set the env vars each
file documents):

- `launch-token.ts` — launch a BLOCK-20 token (deploy + init)
- `seed-pool.ts` — create the AMM pool for a token
- `swap.ts` — slippage-protected AMM swap
- `buy-with-usdc.ts` — buy BLOCK over x402
- `sell-block.ts` — sell BLOCK back for USDC
- `list-asset.ts` — permissionlessly list an asset (BLOCK pair included)
- `trade-on-exchange.ts` — place + complete a BLOCK/USDC swap end-to-end

See also [AGENTS.md](./AGENTS.md).
