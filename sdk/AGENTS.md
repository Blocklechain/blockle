# AGENTS.md — @blockle/agent-sdk

Guidance for autonomous agents (and the humans wiring them) using this SDK.

## One object, everything

```ts
import { BlockleAgent } from "@blockle/agent-sdk";
const agent = new BlockleAgent({ nodeUrl, siteUrl, exchangeUrl });
agent.importWallet(SECRET_HEX, PUBLIC_HEX);   // or agent.createWallet()
```

- Finish a **trade**: `await agent.exchange.swap("BLOCK", "USDC", amount, { slippage: 1 })`
- **List** an asset: `await agent.exchange.listAsset({ asset, extraPairs })`
- **Launch** a token: `await agent.launchToken({ name, symbol, decimals, supply })`
- **Swap** on the AMM: `await agent.swapBuy(token, blockIn, { slippage: 1 })`

Every write returns a submitted txid. `await agent.waitForTx(txid, 1)` to confirm.

## Rules an agent must respect

- **Amounts are base units (`bigint`).** `1 BLOCK = 100_000_000`. A token uses
  `10^decimals`. Never pass human/float amounts into SDK methods.
- **Set `minOut` from a quote.** `agent.quote(token, side, amountIn, slippagePct)`
  returns the exact consensus `amountOut` and a slippage-adjusted `minOut`.
  `swapBuy`/`swapSell` call it for you when you pass `{ slippage }`.
- **Keys are yours.** The SDK signs locally via blockle-wasm. For ETH/SOL/USDC
  legs, inject your own `HtlcSigner` via `config.evm` / `config.solana` — the SDK
  never imports ethers or web3.js and never takes custody of a key.
- **Gas/fees are fixed by consensus:** deploy `300000`, init `120000`, pool
  create `250000`, swap/call `200000`, `gas_price = 10`. The SDK applies these;
  don't override unless you know why.
- **Confirm before you depend on state.** `launchToken` already waits for the
  deploy to confirm before `init()`. For your own chains of actions, `waitForTx`.

## Money paths are gated — do not assume mainnet

`buyBlock`, `sellBlock`, `listAsset` fee collection, and any fiat/USDC leg are
**testnet-first** and disabled server-side until an operator records a completed
legal review (`mainnet_enabled`). In dev they settle on testnets. Treat a 402 or
a "disabled" response as expected, not an error to route around. **Never** build
a path that bypasses the listing fee, the mandatory BLOCK pair, or a KYC/geo
hook.

## x402

`agent.x402.resources()` lists the payable resource URLs (`/x402/buy`,
`/x402/list`, `/x402/pay`). `buyBlock()` and `listAsset()` settle over x402 by
default. Inject `config.x402.payer` (backed by your own EVM/USDC signer) to
produce the `X-PAYMENT` header; dev mock services need none.

## Operator notice

> Operators MUST obtain legal/compliance sign-off before enabling mainnet money
> paths. Until then, run against testnets and testnet facilitators only.
