# Blockle for Agents

Blockle is an Equihash-PoW L1 (ticker **BLOCK**, 600s blocks, Bitcoin tokenomics
+ 210k premine) with a **native AMM in consensus**, a **BLOCK-20** token standard,
a sqrt **buy-curve** primary sale, and a **non-custodial cross-chain exchange**.
This file is the entry point for autonomous agents.

> `1 BLOCK = 100,000,000 base units (1e8)`. Everything below is in **base units**.
> Convert to human amounts only at display edges.

---

## Install

### TypeScript SDK — `@blockle/agent-sdk` (`sdk/`)
Signing is byte-identical to consensus (ML-DSA-44 via `blockle-wasm`). Never
hand-roll ML-DSA or tx encoding — the SDK wraps the wasm signer.

```bash
# 1. build the wasm signer the SDK links against
cd blockle-wasm && wasm-pack build --target nodejs --out-dir pkg-node
# 2. build the SDK
cd ../sdk && npm install && npm run build && npm test
```

### MCP server — `@blockle/mcp` (`mcp/`)
Exposes every SDK capability as MCP tools over **stdio** or **streamable-HTTP**,
so any MCP-capable agent can drive a wallet.

```bash
cd mcp && npm install && npm run build
node dist/src/index.js            # stdio
node dist/src/index.js --http     # streamable-HTTP
```

Register the `blockle-mcp` binary with your MCP client. See `mcp/README.md`,
`mcp/blockle.config.example.json`, and `sdk/AGENTS.md` for the tool catalog.

---

## The full loop: buy → launch → pool → trade → sell

Each step is a single SDK call (and a single MCP tool). The SDK returns
`{ txid, raw }`; submit `raw` (hex bincode tx) to the node.

1. **Buy BLOCK** — primary sale over the sqrt buy-curve, paid via the x402 rail
   (`services/x402-buy`). Curve math mirrors `web/buy.js` exactly (sqrt primary
   sale, $0.10 floor, $2,000,000 target, 210,000 BLOCK allocation). **5% buy fee.**
2. **Launch a token** — `build_block20_token` deploys a BLOCK-20 token.
   Selectors: `0 init, 1 balanceOf, 2 transfer, 3 totalSupply, 4 decimals, 5 name, 6 symbol`.
3. **Create a pool** — `build_pool_create` then `build_pool_add`. Constant-product,
   one pool per token, **LP locked 1008 blocks**.
4. **Trade** — `build_pool_swap_buy` / `build_pool_swap_sell`. **0.30% swap fee**
   (`SWAP_FEE_BPS = 30`). Quote / slippage / `min_out` math lives in `web/dex.js`.
5. **Sell BLOCK → USDC** — redemption through `services/settlement`
   (reorg-safe confirmation depth, daily cap, idempotent persistent ledger).
6. **Cross-chain** — non-custodial atomic swaps (HTLC on EVM + Solana + BLOCK)
   and permissionless listings at **exchange.blockle.org**
   (`exchange/contracts`, `exchange/server`, `exchange/web`).

### Submitting a signed tx
- Node aux-http JSON-RPC (`http://127.0.0.1:8445/`):
  `{"jsonrpc":"1.0","id":"x","method":"submitrawtransaction","params":["<raw hex>"]}`
- or site `/api/submit`: `{"raw":"<hex>"}`

### Reading chain state (node aux-http GET)
`/explorer/stats`, `/explorer/address/{block1…}`, `/explorer/tx/{txid}`,
`/explorer/block/{…}`; JSON-RPC `callcontract`, `tokeninfo`, `listpools`, `poolinfo`.

---

## Base-unit & gas conventions

| Thing | Value |
|---|---|
| Unit | `1 BLOCK = 1e8` base units |
| Gas price | `10` base units / gas |
| Fee | `gas_limit * 10` (inputs must also cover `block_amt`/`block_in`) |
| Gas: deploy | `300000` |
| Gas: init | `120000` |
| Gas: pool create | `250000` |
| Gas: swap / call | `200000` |

---

## Fee table

| Action | Fee | Charged by |
|---|---|---|
| AMM swap (native pools) | **0.30%** (`SWAP_FEE_BPS=30`) | protocol → LPs |
| Buy-curve primary sale | **5%** | buy curve |
| Cross-chain atomic swap | **0.1%** protocol fee | non-custodial exchange |
| Exchange deposit / withdrawal | **none** | — the exchange holds no funds |
| Self-serve listing | **$5 / asset** (includes the mandatory BLOCK pair) | exchange |
| Extra trading pair | **$1 / extra pair** | exchange |

Tradable assets: **BLOCK / ETH / SOL / USDC / USDT** + anything listed.

The exchange is **non-custodial** — it relays signed intents and runs the HTLC
state machine but never holds user funds, which is why there are no deposit or
withdrawal fees.

---

## Keys & safety

- Agent keys stay in the **SDK** (the agent's own process). Reserve / hot-wallet
  keys stay in the **service / signer processes** (`services/*`). **Never** in
  `blockle-biz` or the MCP server.
- Idempotent, write-before-send ledgers on anything that moves value (dedupe by
  txid); reorg-safe confirmation depth + daily caps are **config, not constants**.
- KYC / geo-screening hooks exist at every fiat/custody boundary — pluggable,
  **no-op in dev**. Nothing here is designed to evade KYC / sanctions / geo.

---

## ⚠️ COMPLIANCE NOTICE — READ BEFORE ENABLING MAINNET

**Every fiat / USDC / SOL / ETH money path is DISABLED BY DEFAULT behind a
`mainnet_enabled` flag that defaults to `false`.** In development everything runs
on testnets (Base Sepolia, Solana devnet, ETH Sepolia) with testnet facilitators
and no-op compliance hooks.

**An operator MUST obtain and record a completed legal / compliance review in
configuration before `mainnet_enabled` can be set to `true`.** Do not enable any
money path on mainnet without that recorded sign-off. This requirement is
repeated in each module's README and `AGENTS.md`.

---

## Where things live

| Path | What |
|---|---|
| `sdk/` | `@blockle/agent-sdk` — TS SDK, ML-DSA signing |
| `mcp/` | `@blockle/mcp` — MCP server wrapping the SDK |
| `services/x402-buy/` | x402 payment-rail buy service |
| `services/settlement/` | BLOCK → USDC sell / redemption service |
| `exchange/contracts/` | HTLC atomic-swap contracts (EVM + Solana + BLOCK), `PROTOCOL.md` |
| `exchange/server/` | non-custodial relay + listing registry |
| `exchange/web/` | exchange frontend |
| `chain/` | the L1 (cargo workspace, `blockle-chain`) |
| `blockle-wasm/` | ML-DSA signer + tx encoder (wasm) |
| `src/biz.rs` | site server `blockle-biz` (serves `/agents`, `/dex`, `/launch`, `/buy`) |

Live agent docs are served at **`/agents`** by `blockle-biz`.
