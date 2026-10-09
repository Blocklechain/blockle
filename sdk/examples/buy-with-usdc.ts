// Buy BLOCK with USDC over x402 (the agent payment rail). TESTNET-FIRST: the
// x402 buy service (deliverable C) defaults to disabled and settles on Base
// Sepolia until an operator records a completed legal review. In dev it may
// run in a free/mock mode needing no payer; for a real USDC payment inject an
// X402Payer backed by your OWN EVM/USDC signer (keys stay with you).
//
// Env: NODE_URL, SITE_URL, X402_URL, SECRET_HEX, PUBLIC_HEX, [USDC_BASE_UNITS].

import { BlockleAgent } from "../src";

async function main() {
  const agent = new BlockleAgent({
    nodeUrl: process.env.NODE_URL ?? "http://127.0.0.1:8445",
    siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:8787",
    x402Url: process.env.X402_URL ?? "http://127.0.0.1:8402",
    // x402: { payer: myX402Payer }, // inject for a real USDC payment
  });
  agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);

  console.log("x402 resources:", agent.x402.resources());

  const usdc = BigInt(process.env.USDC_BASE_UNITS ?? "10000000"); // 10 USDC (6 dp)
  const receipt = await agent.buyBlock(usdc);
  console.log("bought BLOCK:", receipt);
  if (receipt.blockTxid) {
    await agent.waitForTx(receipt.blockTxid, 1);
    console.log("delivery confirmed. balance:", (await agent.getBalance()).toString());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
