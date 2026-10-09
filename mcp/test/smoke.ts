// Smoke test: boot the server, connect an in-memory MCP client, list the tools,
// and assert the full agent workflow is reachable (launch a token, pool it, buy
// BLOCK, and place/complete a cross-chain swap + list an asset) — all via tools.
//
// Pure wiring check: no node/exchange services are contacted. Run with
//   npm test        (builds first, then: node dist/test/smoke.js)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";

const REQUIRED = [
  // wallet + reads
  "wallet_create",
  "wallet_import",
  "wallet_address",
  "get_balance",
  "get_utxos",
  "get_address_info",
  "get_pools",
  "get_pool",
  "get_token",
  "quote",
  // transact
  "send",
  "launch_token",
  "create_pool",
  "add_liquidity",
  "remove_liquidity",
  "swap_buy",
  "swap_sell",
  "wait_for_tx",
  "submit_raw",
  // money
  "buy_block",
  "sell_block",
  "x402_resources",
  // exchange (mandated set)
  "exchange_signin",
  "exchange_markets",
  "exchange_book",
  "exchange_place_order",
  "exchange_cancel_order",
  "exchange_my_orders",
  "exchange_my_swaps",
  "exchange_execute_swap",
  // extra exchange + listing
  "exchange_trades",
  "exchange_swap",
  "exchange_listing_quote",
  "exchange_listings",
  "exchange_list_asset",
];

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { server } = buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  console.log(`listed ${tools.length} tools:`);
  for (const t of tools) console.log(`  - ${t.name}`);

  const missing = REQUIRED.filter((n) => !names.has(n));
  assert(missing.length === 0, `missing required tools: ${missing.join(", ")}`);

  // Every tool must carry a description and an input schema (strict JSON schema).
  for (const t of tools) {
    assert(typeof t.description === "string" && t.description.length > 0, `${t.name} has no description`);
    assert(t.inputSchema && t.inputSchema.type === "object", `${t.name} has no object input schema`);
  }

  // Exercise a no-arg read tool end-to-end over the transport (no wallet, no
  // network needed): x402_resources returns a summary + structured resources.
  const res: any = await client.callTool({ name: "x402_resources", arguments: {} });
  assert(Array.isArray(res.content) && res.content[0]?.type === "text", "x402_resources returned no text content");
  assert(res.structuredContent?.summary, "x402_resources returned no summary");
  assert(res.structuredContent?.resources?.buy, "x402_resources missing resource URLs");

  // wallet_create must mint a block1… identity through the tool path.
  const wc: any = await client.callTool({ name: "wallet_create", arguments: {} });
  assert(
    typeof wc.structuredContent?.address === "string" && wc.structuredContent.address.startsWith("block1"),
    "wallet_create did not return a block1… address",
  );

  await client.close();
  await server.close();
  console.log(`\nOK — ${tools.length} tools, all ${REQUIRED.length} required present, tool calls work.`);
}

main().catch((err) => {
  console.error("smoke test error:", err);
  process.exit(1);
});
