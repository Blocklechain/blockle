# @blockle/mcp

A **Model Context Protocol** server for the Blockle L1. It wraps
[`@blockle/agent-sdk`](../sdk) one tool per SDK method, so **any** MCP-capable
agent — with zero Blockle code — can run a wallet, launch BLOCK-20 tokens,
seed/trade the native AMM, buy/sell BLOCK over x402, and **place + complete
cross-chain swaps and permissionless listings on the non-custodial exchange**.

- **Transports:** stdio (default) and streamable-HTTP (`--http`).
- **35 tools**, strict JSON input schemas, every amount documented in **base
  units** (passed as strings so JSON never loses precision).
- Every tool returns a human `summary`; chain writes also return a `txid`.
- **Keys stay here, with the agent.** This process holds only the agent's own
  ML-DSA wallet; it never sees reserve/hot-wallet keys. Signing is
  byte-identical to consensus (via the SDK's `blockle-wasm`).

## Shortest path — end-to-end with a handful of MCP calls

Start the wallet, then four tool calls cover the whole flow:

```jsonc
// 1. identity (or set BLOCKLE_SECRET_HEX/BLOCKLE_PUBLIC_HEX and skip this)
wallet_create            {}
// 2. launch a BLOCK-20 token (deploy + init, supply in WHOLE tokens)
launch_token             { "name": "My Token", "symbol": "MYT", "decimals": 8, "supply": "1000000" }
// 3. seed its AMM pool (amounts in base units)
create_pool              { "token": "<contractId>", "blockAmt": "1000000000", "tokenAmt": "100000000000000" }
// 4. buy BLOCK with USDC over x402 (USDC base units, 6 dp)
buy_block                { "usdc": "5000000" }
// 5. trade cross-chain in ONE call — signs in, takes/posts best order, runs the atomic swap
exchange_swap            { "from": "BLOCK", "to": "USDC", "amount": "1000000000", "slippage": 1 }
```

List a new asset permissionlessly (the mandatory `BLOCK/<asset>` pair is always
included — $5 base + $1 per extra pair):

```jsonc
exchange_list_asset      { "asset": { "symbol": "MYT", "chain": "block", "kind": "block20", "addr": "<contractId>", "decimals": 8 }, "extraPairs": ["USDC"] }
```

## Install & run

```bash
npm install        # also builds (prepare); depends on ../sdk (file:) which depends on blockle-wasm
npm run build
npm test           # smoke test: boots the server, lists tools, calls a couple

# stdio (default) — for Claude Desktop, Cursor, MCP Inspector, agent runtimes
npm start
# or: node dist/src/index.js --config ./blockle.config.json

# streamable-HTTP on :8820/mcp (health at /health)
npm run start:http
# or: node dist/src/index.js --http --port 8820
```

> The SDK consumes `blockle-wasm` via `file:../blockle-wasm/pkg-node`. If that
> package isn't built yet: `cd ../blockle-wasm && wasm-pack build --target nodejs --out-dir pkg-node`.

## Configuration

Copy `blockle.config.example.json` → `blockle.config.json` (or point at one with
`--config` / `BLOCKLE_CONFIG`). Env vars override the file:

| Field / env | Default | Meaning |
|---|---|---|
| `nodeUrl` / `BLOCKLE_NODE_URL` | `http://127.0.0.1:8445` | node aux-http JSON-RPC + explorer |
| `siteUrl` / `BLOCKLE_SITE_URL` | `http://127.0.0.1:8787` | blockle-biz site (`/api/submit`, buy/sell) |
| `exchangeUrl` / `BLOCKLE_EXCHANGE_URL` | `http://127.0.0.1:8900` | non-custodial exchange relay |
| `x402Url` / `BLOCKLE_X402_URL` | `http://127.0.0.1:8402` | x402 buy/listing facilitator |
| `timeoutMs` / `BLOCKLE_TIMEOUT_MS` | `30000` | per-request timeout |
| wallet | — | `BLOCKLE_SECRET_HEX` + `BLOCKLE_PUBLIC_HEX` (preferred) or `wallet` block (dev only) |

### Claude Desktop / MCP client config

```jsonc
{
  "mcpServers": {
    "blockle": {
      "command": "node",
      "args": ["/absolute/path/to/blockle/mcp/dist/src/index.js"],
      "env": {
        "BLOCKLE_NODE_URL": "http://127.0.0.1:8445",
        "BLOCKLE_SITE_URL": "http://127.0.0.1:8787",
        "BLOCKLE_EXCHANGE_URL": "http://127.0.0.1:8900",
        "BLOCKLE_X402_URL": "http://127.0.0.1:8402",
        "BLOCKLE_SECRET_HEX": "…",
        "BLOCKLE_PUBLIC_HEX": "…"
      }
    }
  }
}
```

## Tools

Amounts are **base units**, passed as strings. `1 BLOCK = 100_000_000`; a
BLOCK-20 token uses `10^decimals`; USDC on Base uses 6 dp.

**Wallet** — `wallet_create`, `wallet_import`, `wallet_address`
**Reads** — `get_balance`, `get_utxos`, `get_address_info`, `get_pools`, `get_pool`, `get_token`, `quote`
**Transact** — `send`, `launch_token`, `create_pool`, `add_liquidity`, `remove_liquidity`, `swap_buy`, `swap_sell`, `wait_for_tx`, `submit_raw`
**Money (x402)** — `buy_block`, `sell_block`, `x402_resources`
**Exchange** — `exchange_signin`, `exchange_markets`, `exchange_book`, `exchange_trades`, `exchange_place_order`, `exchange_cancel_order`, `exchange_my_orders`, `exchange_my_swaps`, `exchange_execute_swap`, `exchange_swap`
**Self-serve listing** — `exchange_listing_quote`, `exchange_listings`, `exchange_list_asset`

Gas/fees follow consensus exactly (deploy 300000, init 120000, poolCreate
250000, swap/call 200000, gas_price 10) — the SDK applies them; tools only
expose the amounts.

### Non-custodial exchange & swaps

`exchange_*` tools are a client of the shared exchange relay contract. The relay
only coordinates the hashlock + preimage + timelocks; **the agent performs every
on-chain HTLC leg with its own signer.** The BLOCK leg is built in. To settle
ETH/BASE/SOL/USDC/USDT legs, the SDK needs an injected EVM/Solana HTLC signer —
not configurable through MCP JSON today, so cross-chain legs on non-BLOCK chains
require running the SDK directly with those signers. BLOCK-side swaps,
order placement/cancel, book reads, and listings are fully reachable via MCP.

## Compliance & safety

> **Operators MUST obtain legal/compliance sign-off before enabling mainnet.**

- **Testnet-first.** `buy_block`, `sell_block`, and listing-fee payment are
  disabled by default behind each service's server-side `mainnet_enabled` flag
  and settle on testnets (Base Sepolia, Solana devnet, ETH Sepolia) in dev.
- **KYC/geo** screening and **idempotency / reorg-depth / daily caps** are
  enforced by the buy/sell/settlement and exchange-relay services (config, not
  constants) — this server forwards to them and never bypasses a fee, the
  mandatory BLOCK pair, or a screening boundary.
- **Non-custodial.** This server holds only the agent's own key. Reserve/hot
  keys live in the services. Every listing fee is paid on-chain to a
  relay-published treasury and verified before activation.

See [AGENTS.md](./AGENTS.md).
