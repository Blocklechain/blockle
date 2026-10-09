// Place and complete a BLOCK/USDC swap end-to-end on the non-custodial
// exchange relay. The relay only coordinates the hashlock + preimage +
// timelocks; this agent performs every on-chain HTLC leg with its OWN signer.
// Keys never leave the agent.
//
// The single swap() convenience signs in if needed, finds/takes the best
// order (or posts one), and drives the atomic swap to completion with safe
// defaults. A BLOCK/USDC swap needs an injected EVM signer to settle the USDC
// leg; without one you can still trade BLOCK-settled markets.
//
// Env: NODE_URL, SITE_URL, EXCHANGE_URL, SECRET_HEX, PUBLIC_HEX.

import { BlockleAgent } from "../src";
// import { myEvmHtlcSigner } from "./my-evm-signer"; // your ethers-backed signer

async function main() {
  const agent = new BlockleAgent({
    nodeUrl: process.env.NODE_URL ?? "http://127.0.0.1:8445",
    siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:8787",
    exchangeUrl: process.env.EXCHANGE_URL ?? "http://127.0.0.1:8900",
    // evm: { chain: "base", signer: myEvmHtlcSigner }, // to settle the USDC leg
  });
  agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);

  const ex = agent.exchange;
  await ex.signIn("block"); // sign the auth nonce with the agent's ML-DSA key

  const markets = await ex.getMarkets();
  console.log(
    "markets:",
    markets.map((m) => m.market),
  );

  const book = await ex.getBook("BLOCK/USDC");
  console.log("top bid:", book.bids[0], "top ask:", book.asks[0]);

  // One call: swap 10 BLOCK into USDC with 1% slippage, completed end-to-end.
  const swap = await ex.swap("BLOCK", "USDC", String(10n * 100_000_000n), { slippage: 1 });
  console.log("swap complete:", swap.swapId, "state:", swap.state);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
