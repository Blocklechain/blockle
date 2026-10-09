// A thin holder around a single BlockleAgent built from config. The agent is
// the SDK object the MCP tools wrap one-to-one. Keys live here (this process IS
// the agent). We never touch reserve/hot-wallet keys.

import * as sdk from "@blockle/agent-sdk";
import type { McpConfig } from "./config.js";

export class AgentHolder {
  readonly agent: sdk.BlockleAgent;
  private hasWallet = false;

  constructor(cfg: McpConfig) {
    this.agent = new sdk.BlockleAgent({
      nodeUrl: cfg.nodeUrl,
      siteUrl: cfg.siteUrl,
      exchangeUrl: cfg.exchangeUrl,
      x402Url: cfg.x402Url,
      networkId: cfg.networkId,
      timeoutMs: cfg.timeoutMs,
    });
    if (cfg.wallet?.secretHex && cfg.wallet?.publicHex) {
      this.agent.importWallet(cfg.wallet.secretHex, cfg.wallet.publicHex);
      this.hasWallet = true;
    }
  }

  markWallet(): void {
    this.hasWallet = true;
  }

  requireWallet(): void {
    if (!this.hasWallet) {
      throw new Error(
        "no wallet loaded — call wallet_create or wallet_import first, or start the server with BLOCKLE_SECRET_HEX + BLOCKLE_PUBLIC_HEX",
      );
    }
  }
}
