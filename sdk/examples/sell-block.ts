// Sell BLOCK back for USDC (non-custodial, two steps): the agent sends BLOCK
// to the reserve with its own signer, then the settlement service (deliverable
// D) verifies that txid on-chain and pays USDC to your Base address. Gated by
// mainnet_enabled server-side; dev settles on testnet.
//
// Env: NODE_URL, SITE_URL, SECRET_HEX, PUBLIC_HEX, USDC_ADDR (Base 0x…),
//      [BLOCK_AMOUNT].

import { BlockleAgent } from "../src";

async function main() {
  const usdcAddr = process.env.USDC_ADDR;
  if (!usdcAddr) throw new Error("set USDC_ADDR=<your Base 0x… payout address>");

  const agent = new BlockleAgent({
    nodeUrl: process.env.NODE_URL ?? "http://127.0.0.1:8445",
    siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:8787",
  });
  agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);

  const blockAmount = BigInt(process.env.BLOCK_AMOUNT ?? String(5n * 100_000_000n)); // 5 BLOCK
  const { blockTxid, settlement } = await agent.sellBlock(blockAmount, { userUsdcAddr: usdcAddr });
  console.log("sent BLOCK to reserve, txid:", blockTxid);
  console.log("settlement:", settlement);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
