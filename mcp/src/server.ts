// Build a configured McpServer with every Blockle tool registered.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type McpConfig } from "./config.js";
import { AgentHolder } from "./agent.js";
import { registerTools } from "./tools.js";

export interface BuiltServer {
  server: McpServer;
  toolNames: string[];
  config: McpConfig;
}

export function buildServer(configPath?: string): BuiltServer {
  const config = loadConfig(configPath);
  const holder = new AgentHolder(config);

  const server = new McpServer(
    { name: "blockle-mcp", version: "0.1.0" },
    {
      instructions:
        "Blockle L1 agent tools. Amounts are BASE UNITS passed as strings (1 BLOCK = 100000000). " +
        "Start with wallet_create or wallet_import (or set BLOCKLE_SECRET_HEX/BLOCKLE_PUBLIC_HEX). " +
        "Launch a token with launch_token, pool it with create_pool, buy BLOCK with buy_block, and " +
        "trade cross-chain with exchange_signin + exchange_swap (or place/execute orders manually). " +
        "List a new asset permissionlessly with exchange_list_asset (the BLOCK pair is always included). " +
        "Money paths are testnet-first and gated server-side by mainnet_enabled.",
    },
  );

  const toolNames = registerTools(server, holder);
  return { server, toolNames, config };
}
