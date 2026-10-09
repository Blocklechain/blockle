// Permissionlessly list a new asset on the super-exchange. Every listing MUST
// include the mandatory BLOCK pair (auto-included in the $5 base fee); each
// extra pair is $1. The fee is paid NON-CUSTODIALLY to the relay's treasury
// (settled over x402 or a direct on-chain txid); the relay verifies payment
// before activating. Gated by mainnet_enabled; dev settles on testnet.
//
// Env: NODE_URL, SITE_URL, EXCHANGE_URL, SECRET_HEX, PUBLIC_HEX.

import { BlockleAgent } from "../src";

async function main() {
  const agent = new BlockleAgent({
    nodeUrl: process.env.NODE_URL ?? "http://127.0.0.1:8445",
    siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:8787",
    exchangeUrl: process.env.EXCHANGE_URL ?? "http://127.0.0.1:8900",
  });
  agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);

  const ex = agent.exchange;
  await ex.signIn("block");

  // Preview the price first ($5 base + $1/extra pair).
  const quote = await ex.listingQuote(
    { symbol: "MYT", chain: "block", kind: "block20", addr: process.env.TOKEN ?? "", decimals: 8 },
    ["USDC"],
  );
  console.log("listing quote:", quote.totalUsd, "USD", quote.breakdown, "payTo", quote.payTo);

  // One call: quote -> pay the fee to the treasury -> register with the txid.
  const res = await ex.listAsset({
    asset: { symbol: "MYT", chain: "block", kind: "block20", addr: process.env.TOKEN ?? "", decimals: 8 },
    extraPairs: ["USDC"], // BLOCK/MYT is always added for free and cannot be removed
    payWith: "block",
  });
  console.log("listed:", res.listingId, "markets:", res.markets);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
