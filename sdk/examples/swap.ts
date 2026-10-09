// Swap on the native AMM with a slippage-protected minOut (computed from the
// live pool using the exact consensus math).
//
// Env: NODE_URL, SITE_URL, SECRET_HEX, PUBLIC_HEX, TOKEN, [BLOCK_IN].

import { BlockleAgent } from "../src";

async function main() {
  const token = process.env.TOKEN;
  if (!token) throw new Error("set TOKEN=<64-hex contract id>");

  const agent = new BlockleAgent({
    nodeUrl: process.env.NODE_URL ?? "http://127.0.0.1:8445",
    siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:8787",
  });
  agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);

  const blockIn = BigInt(process.env.BLOCK_IN ?? String(1n * 100_000_000n)); // 1 BLOCK

  const q = await agent.quote(token, "buy", blockIn, 1); // 1% slippage
  console.log(`quote: ${blockIn} BLOCK -> ${q.amountOut} token (minOut ${q.minOut} at 1% slippage)`);

  const res = await agent.swapBuy(token, blockIn, { slippage: 1 });
  console.log("swap submitted, txid:", res.txid);
  await agent.waitForTx(res.txid, 1);
  console.log("confirmed. token balance:", (await agent.getToken(token, agent.address())).balance);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
