#!/usr/bin/env node
// CLI entry for the Blockle MCP server.
//
//   blockle-mcp                 # stdio (default)
//   blockle-mcp --http [--port N]
//   blockle-mcp --config path/to/blockle.config.json
//
// Env: BLOCKLE_CONFIG, BLOCKLE_NODE_URL, BLOCKLE_SITE_URL, BLOCKLE_EXCHANGE_URL,
//      BLOCKLE_X402_URL, BLOCKLE_SECRET_HEX, BLOCKLE_PUBLIC_HEX, PORT.

import { runStdio } from "./stdio.js";
import { runHttp } from "./http.js";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const configPath = arg("--config");
  if (process.argv.includes("--http")) {
    const port = arg("--port");
    await runHttp(configPath, port ? Number(port) : undefined);
  } else {
    await runStdio(configPath);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
