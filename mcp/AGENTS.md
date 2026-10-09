# AGENTS.md — @blockle/mcp

This directory is **deliverable B**: an MCP server that exposes the Blockle
agent SDK (`../sdk`) as MCP tools over stdio and streamable-HTTP. It is a thin
wrapper — it adds no chain logic of its own.

## Rules for working here

- **Wrap, don't reimplement.** Every tool calls a `BlockleAgent` method. If you
  need new behavior, add it to the SDK (deliverable A) and expose it here. Never
  hand-roll ML-DSA signing, tx encoding, gas math, or curve/quote math — the SDK
  (and `blockle-wasm`) own those.
- **One tool per SDK method.** Keep names stable (`snake_case`), inputs minimal
  with safe defaults, descriptions explicit about **base units**.
- **Amounts are base units, as strings.** Parse with `toBaseUnits`. Never accept
  float BLOCK/token amounts. Convert only at display edges.
- **Every tool returns `{ summary, ... }`**; chain writes include `txid` (raw
  hex). Use `ok()` / `fail()` from `util.ts`; errors are reported to the model,
  not thrown out of the handler.
- **Keys stay with the agent.** This process holds only the agent's own ML-DSA
  wallet (env `BLOCKLE_SECRET_HEX`/`BLOCKLE_PUBLIC_HEX`, or `wallet_create` /
  `wallet_import`). Reserve/hot-wallet keys NEVER live here.

## Layout

- `src/config.ts` — load config (file + env), including the agent wallet.
- `src/agent.ts` — builds the one `BlockleAgent`; `requireWallet()` guard.
- `src/tools.ts` — all 35 tool registrations (the surface area).
- `src/server.ts` — `buildServer()`: `McpServer` + tool registration.
- `src/stdio.ts`, `src/http.ts`, `src/index.ts` — transports + CLI.
- `test/smoke.ts` — boots the server over an in-memory transport, lists tools,
  asserts the mandated set is present, and calls a couple end-to-end.

## Build / test

```bash
npm install && npm run build
npm test            # must stay green; lists tools + exercises a tool call
```

Output lands at `dist/src/*` (tsconfig `rootDir: "."`), so the entry is
`dist/src/index.js`.

## Compliance (do not skip)

Money paths (`buy_block`, `sell_block`, listing-fee payment) are **testnet-first**
and gated by each service's server-side `mainnet_enabled`. KYC/geo, idempotency,
reorg depth, and daily caps are enforced by those services. Never add a tool or
path that bypasses a fee, the mandatory `BLOCK/<asset>` listing pair, or a
screening boundary. **Operators must obtain legal/compliance sign-off before
enabling mainnet.**
