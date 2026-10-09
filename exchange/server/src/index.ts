#!/usr/bin/env node
// Entrypoint. TESTNET-FIRST: the relay refuses to pretend it is on mainnet
// unless an operator has recorded a completed legal/compliance review in
// config (see README). Holds NO funds and NO keys.

import { loadConfig } from "./config";
import { buildServer } from "./server";

function main(): void {
  const cfg = loadConfig();
  const { listen } = buildServer(cfg);
  listen();
  // eslint-disable-next-line no-console
  console.log(
    `[blockle-exchange] non-custodial relay on :${cfg.port} — network=${cfg.network} mainnetEnabled=${cfg.mainnetEnabled}`,
  );
  if (!cfg.mainnetEnabled) {
    // eslint-disable-next-line no-console
    console.log(
      "[blockle-exchange] TESTNET MODE — fiat/USDC/on-chain fee paths settle on testnets. Enable mainnet only after a recorded legal review (see README).",
    );
  }
}

main();

export { buildServer } from "./server";
export { loadConfig } from "./config";
