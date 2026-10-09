// index.ts — wire config -> deps -> engine -> server and listen on :8790.
//
// TESTNET-FIRST: with no config file the service comes up in mock-reserve,
// Base Sepolia, mainnet-disabled mode — safe to run anywhere. An operator
// supplies /etc/blockle-settlement/config.json (see config.example.json) and,
// only after a recorded legal review, flips the mainnet gate.

import { loadConfig, mainnetActive, isMainnetNetwork } from "./config";
import { NodeChainReader } from "./chain";
import { createReserve } from "./reserve";
import { createScreener } from "./compliance";
import { Ledger } from "./ledger";
import { SettlementEngine } from "./settle";
import { createServer } from "./server";

export { loadConfig } from "./config";
export { SettlementEngine } from "./settle";
export { createServer } from "./server";
export { Ledger } from "./ledger";
export { Curve } from "./curve";
export { MockUsdcReserve } from "./reserve";

export function buildEngine(configPath?: string) {
  const cfg = loadConfig(configPath);
  const chain = new NodeChainReader(cfg.nodeUrl);
  const reserve = createReserve(cfg.usdc);
  const compliance = createScreener(cfg.compliance);
  const ledger = new Ledger(cfg.ledgerPath);
  const engine = new SettlementEngine({ config: cfg, chain, reserve, ledger, compliance });
  return { cfg, engine };
}

function main() {
  const { cfg, engine } = buildEngine();
  const server = createServer(engine, cfg);
  server.listen(cfg.port, cfg.host, () => {
    const gated = isMainnetNetwork(cfg.usdc.network) && !mainnetActive(cfg);
    console.log(
      `[settlement] listening on http://${cfg.host}:${cfg.port}  ` +
        `network=${cfg.usdc.network} reserve=${cfg.usdc.mode} ` +
        `mainnetActive=${mainnetActive(cfg)}${gated ? " (mainnet payouts GATED — legal review required)" : ""}`,
    );
    if (cfg.usdc.mode === "mock") {
      console.log("[settlement] MOCK reserve — no real USDC will move. Configure usdc.mode=ethers for live payouts.");
    }
  });
}

if (require.main === module) main();
