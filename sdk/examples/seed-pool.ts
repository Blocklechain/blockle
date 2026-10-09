// Seed the native AMM pool for a token: create the (single) pool with an
// initial BLOCK + token deposit. Amounts are BASE UNITS.
//
// Env: NODE_URL, SITE_URL, SECRET_HEX, PUBLIC_HEX, TOKEN (contract id hex).

import { BlockleAgent } from "../src";

async function main() {
  const token = process.env.TOKEN;
  if (!token) throw new Error("set TOKEN=<64-hex contract id>");

  const agent = new BlockleAgent({
    nodeUrl: process.env.NODE_URL ?? "http://127.0.0.1:8445",
    siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:8787",
  });
  agent.importWallet(process.env.SECRET_HEX!, process.env.PUBLIC_HEX!);

  // 100 BLOCK (1e8 base units each) paired with 100_000 whole tokens (8 dp).
  const blockAmt = 100n * 100_000_000n;
  const tokenAmt = 100_000n * 100_000_000n;

  const res = await agent.createPool(token, blockAmt, tokenAmt);
  console.log("pool created, txid:", res.txid, "fee:", res.fee?.toString());

  await agent.waitForTx(res.txid, 1);
  const pool = await agent.getPool(token);
  console.log("pool reserves — BLOCK:", pool.blockReserve, "TOKEN:", pool.tokenReserve, "LP:", pool.lpTotal);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
