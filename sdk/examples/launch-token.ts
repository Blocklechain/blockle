// Launch a BLOCK-20 token end-to-end: deploy + init (mint) in one call.
//
//   npm run build && node ../dist/examples/... (or: npx tsx examples/launch-token.ts)
//
// Env: NODE_URL, SITE_URL, SECRET_HEX, PUBLIC_HEX (or a fresh wallet).

import { BlockleAgent } from "../src";

async function main() {
  const agent = new BlockleAgent({
    nodeUrl: process.env.NODE_URL ?? "http://127.0.0.1:8445",
    siteUrl: process.env.SITE_URL ?? "http://127.0.0.1:8787",
  });

  if (process.env.SECRET_HEX && process.env.PUBLIC_HEX) {
    agent.importWallet(process.env.SECRET_HEX, process.env.PUBLIC_HEX);
  } else {
    const w = agent.createWallet();
    console.log("fresh wallet — fund it before launching:", w.address);
    console.log("secret (save this!):", w.secretKey.slice(0, 16) + "…");
  }
  console.log("address:", agent.address(), "balance:", (await agent.getBalance()).toString());

  const res = await agent.launchToken({ name: "Demo Token", symbol: "DEMO", decimals: 8, supply: 1_000_000 });
  console.log("launched:");
  console.log("  contractId:", res.contractId);
  console.log("  deployTxid:", res.deployTxid);
  console.log("  initTxid:  ", res.initTxid);

  const info = await agent.getToken(res.contractId, agent.address());
  console.log("token:", info.name, info.symbol, "supply", info.totalSupply, "your balance", info.balance);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
