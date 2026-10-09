// Config loading for the Blockle MCP server.
//
// Precedence (later wins): blockle.config.json → environment variables.
// URLs point at the same services the SDK talks to:
//   nodeUrl     — node aux-http JSON-RPC + explorer   (e.g. http://127.0.0.1:8445)
//   siteUrl     — blockle-biz site                     (e.g. http://127.0.0.1:8787)
//   exchangeUrl — non-custodial exchange relay         (e.g. http://127.0.0.1:8900)
//   x402Url     — x402 buy/listing facilitator service (e.g. http://127.0.0.1:8402)
//
// KEYS: the agent's own ML-DSA wallet may be supplied at startup via the env
// vars BLOCKLE_SECRET_HEX + BLOCKLE_PUBLIC_HEX (preferred), or the wallet_create
// / wallet_import tools at runtime. The server process IS the agent, so holding
// the agent's own key here is correct; reserve/hot-wallet keys never live here.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface McpConfig {
  nodeUrl: string;
  siteUrl: string;
  exchangeUrl?: string;
  x402Url?: string;
  networkId?: string;
  timeoutMs?: number;
  /** DEV ONLY: a wallet baked into the config file. Prefer the env vars. */
  wallet?: { secretHex: string; publicHex: string };
}

const DEFAULTS: McpConfig = {
  nodeUrl: "http://127.0.0.1:8445",
  siteUrl: "http://127.0.0.1:8787",
  exchangeUrl: "http://127.0.0.1:8900",
  x402Url: "http://127.0.0.1:8402",
  networkId: "devnet",
  timeoutMs: 30_000,
};

function configPath(explicit?: string): string | undefined {
  const p = explicit ?? process.env.BLOCKLE_CONFIG ?? "blockle.config.json";
  const abs = resolve(process.cwd(), p);
  return existsSync(abs) ? abs : undefined;
}

export function loadConfig(explicitPath?: string): McpConfig {
  const cfg: McpConfig = { ...DEFAULTS };

  const path = configPath(explicitPath);
  if (path) {
    const fromFile = JSON.parse(readFileSync(path, "utf8")) as Partial<McpConfig>;
    Object.assign(cfg, fromFile);
  }

  // env overrides
  if (process.env.BLOCKLE_NODE_URL) cfg.nodeUrl = process.env.BLOCKLE_NODE_URL;
  if (process.env.BLOCKLE_SITE_URL) cfg.siteUrl = process.env.BLOCKLE_SITE_URL;
  if (process.env.BLOCKLE_EXCHANGE_URL) cfg.exchangeUrl = process.env.BLOCKLE_EXCHANGE_URL;
  if (process.env.BLOCKLE_X402_URL) cfg.x402Url = process.env.BLOCKLE_X402_URL;
  if (process.env.BLOCKLE_NETWORK_ID) cfg.networkId = process.env.BLOCKLE_NETWORK_ID;
  if (process.env.BLOCKLE_TIMEOUT_MS) cfg.timeoutMs = Number(process.env.BLOCKLE_TIMEOUT_MS);

  // wallet from env takes precedence over anything in the file
  if (process.env.BLOCKLE_SECRET_HEX && process.env.BLOCKLE_PUBLIC_HEX) {
    cfg.wallet = {
      secretHex: process.env.BLOCKLE_SECRET_HEX,
      publicHex: process.env.BLOCKLE_PUBLIC_HEX,
    };
  }

  return cfg;
}
