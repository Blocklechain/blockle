// @blockle/agent-sdk — the TypeScript SDK for autonomous agents (and apps) on
// the Blockle L1. Wallets, transfers, BLOCK-20 token launches, the native AMM,
// the USDC buy/sell on-ramp, and a first-class non-custodial exchange client.
//
// Signing is byte-identical to consensus (ML-DSA-44 via blockle-wasm). Keys
// live in the agent's process and never leave it. All amounts are BASE UNITS
// (bigint): 1 BLOCK = 100_000_000; a token uses 10^decimals.
//
// Quick start:
//   const agent = new BlockleAgent({ nodeUrl, siteUrl });
//   agent.createWallet();
//   await agent.send("block1…", 100_000_000n);           // 1 BLOCK

export { BlockleAgent } from "./agent";
export type { LaunchTokenParams, SwapOptions, SellBlockOptions } from "./agent";

export { BlockSigner } from "./signer";
export type { Keys, BuiltTx } from "./signer";

export { NodeClient } from "./node";
export { X402Client, SettlementClient } from "./money";
export type { X402Payer, BuyReceipt, SellReceipt, X402Resource } from "./money";

export { ExchangeClient, canonical } from "./exchange";
export type { ExchangeOpts, ListAssetParams, SwapOpts } from "./exchange";

export { quote, amountOut, applySlippage, SWAP_FEE_BPS } from "./quote";
export { GAS, GAS_PRICE, feeFor } from "./gas";
export { HttpClient, HttpError, sleep } from "./http";
export { reverseHex, toDisplayTxid, toRawTxid, isHash32 } from "./hex";

export * from "./types";
export * from "./signers";
