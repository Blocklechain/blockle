// stdio transport entry — the default for local MCP clients (Claude Desktop,
// Cursor, the MCP Inspector, agent runtimes that spawn a subprocess).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

export async function runStdio(configPath?: string): Promise<void> {
  const { server, toolNames, config } = buildServer(configPath);
  // Logs MUST go to stderr on stdio — stdout is the MCP byte stream.
  console.error(
    `blockle-mcp (stdio): ${toolNames.length} tools; node=${config.nodeUrl} site=${config.siteUrl} ` +
      `exchange=${config.exchangeUrl ?? "-"} x402=${config.x402Url ?? "-"}`,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
