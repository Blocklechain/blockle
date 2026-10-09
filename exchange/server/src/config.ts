// Relay configuration. COMPLIANCE-FIRST + TESTNET-FIRST:
//
//   * `mainnetEnabled` defaults to FALSE and may only flip true once an
//     operator records a completed legal/compliance review in config
//     (`legalReview.completed=true` + a reviewer + date). Every real
//     fiat/USDC/on-chain fee path is gated behind it. In dev everything
//     settles on testnets (Base Sepolia, Solana devnet, ETH Sepolia).
//   * Confirmation depth and the daily payout/listing cap are CONFIG, not
//     constants, so an operator can harden them per network.
//   * The relay holds NO keys and NO funds. Treasury addresses here are PUBLIC
//     receiving addresses only, read from ../treasury.json.
//
// Precedence: defaults < exchange/server/config.json (if present) < env vars.

import * as fs from "fs";
import * as path from "path";

export interface LegalReview {
  completed: boolean;
  reviewer?: string;
  date?: string;
  note?: string;
}

export interface FeeConfig {
  /** protocol swap fee in basis points (0.1% = 10). Encoded into settlement,
   *  NOT collected by the relay. */
  protocolFeeBps: number;
  /** base listing fee (asset + mandatory BLOCK pair), USD. */
  listingFeeUsd: number;
  /** per extra trading pair, USD. */
  perPairFeeUsd: number;
}

export interface Config {
  port: number;
  /** sqlite file path, or ":memory:" for tests. */
  dbPath: string;
  /** "testnet" | "mainnet" — display/label only; gating is `mainnetEnabled`. */
  network: string;
  mainnetEnabled: boolean;
  legalReview: LegalReview;
  /** confirmations required before a fee/payment txid is accepted. */
  confirmationDepth: number;
  /** configurable daily cap, USD, across listing-fee verification. */
  dailyCapUsd: number;
  fees: FeeConfig;
  /** indicative BLOCK price in USD, used only to quote the BLOCK-settled
   *  listing fee. CONFIG — replace with a real oracle before mainnet. */
  blockPriceUsd: number;
  /** decimals of the USD stablecoin used for USDC-settled fees (6). */
  usdStableDecimals: number;
  /** public treasury receiving addresses by network, from ../treasury.json. */
  treasury: Record<string, Record<string, string>>;
  /** base public URL used in discovery manifests. */
  publicBaseUrl: string;
  /** x402 facilitator + buy/list service base, for listing-fee receipts. */
  x402: {
    facilitator: string;
    serviceUrl?: string;
  };
  /** session lifetime, seconds. */
  sessionTtlSec: number;
  /** nonce lifetime, seconds. */
  nonceTtlSec: number;
}

function readJsonIfExists(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function envBool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v == null) return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function envNum(name: string, dflt: number): number {
  const v = process.env[name];
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Dev-only placeholder testnet treasury addresses so the listing-fee flow is
// exercisable offline. These are NOT real funded addresses; a testnet/mainnet
// deployment overrides treasury.json. Fee verification in dev is a no-op, so
// the exact value only needs to round-trip between quote and payment.
const DEV_TREASURY: Record<string, string> = {
  block: "block1devtreasury000000000000000000000000",
  base: "0x000000000000000000000000000000000000dEaD",
  ethereum: "0x000000000000000000000000000000000000dEaD",
  solana: "11111111111111111111111111111111",
};

function withDevTreasury(t: any): Record<string, Record<string, string>> {
  const out = { mainnet: { ...(t?.mainnet ?? {}) }, testnet: { ...(t?.testnet ?? {}) } };
  for (const [chain, addr] of Object.entries(DEV_TREASURY)) {
    if (!out.testnet[chain] || out.testnet[chain].startsWith("_")) out.testnet[chain] = addr;
  }
  delete (out.testnet as any)._todo;
  return out;
}

/** Resolve a path relative to the exchange/ directory (one up from server/). */
function exchangeDir(): string {
  // dist/src/config.js -> ../../.. = exchange/server; one more up = exchange/
  return path.resolve(__dirname, "..", "..", "..");
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const exDir = exchangeDir();
  const fileCfg = readJsonIfExists(path.join(exDir, "server", "config.json")) ?? {};
  const treasuryFile =
    readJsonIfExists(path.join(exDir, "treasury.json")) ?? { mainnet: {}, testnet: {} };

  const legalReview: LegalReview = {
    completed: false,
    ...(fileCfg.legalReview ?? {}),
  };

  // HARD GATE: mainnet is only enabled when BOTH the flag is set AND a legal
  // review is recorded as completed. Either missing => testnet-only.
  const flag = envBool("BLOCKLE_EXCHANGE_MAINNET", fileCfg.mainnetEnabled ?? false);
  const mainnetEnabled = flag && legalReview.completed === true;

  const cfg: Config = {
    port: envNum("BLOCKLE_EXCHANGE_PORT", fileCfg.port ?? 8900),
    dbPath:
      process.env.BLOCKLE_EXCHANGE_DB ??
      fileCfg.dbPath ??
      path.join(exDir, "server", "data", "exchange.db"),
    network: mainnetEnabled ? "mainnet" : "testnet",
    mainnetEnabled,
    legalReview,
    confirmationDepth: envNum("BLOCKLE_EXCHANGE_CONF_DEPTH", fileCfg.confirmationDepth ?? 6),
    dailyCapUsd: envNum("BLOCKLE_EXCHANGE_DAILY_CAP_USD", fileCfg.dailyCapUsd ?? 100_000),
    fees: {
      protocolFeeBps: fileCfg.fees?.protocolFeeBps ?? 10, // 0.1%
      listingFeeUsd: fileCfg.fees?.listingFeeUsd ?? 5,
      perPairFeeUsd: fileCfg.fees?.perPairFeeUsd ?? 1,
    },
    blockPriceUsd: envNum("BLOCKLE_EXCHANGE_BLOCK_USD", fileCfg.blockPriceUsd ?? 1),
    usdStableDecimals: fileCfg.usdStableDecimals ?? 6,
    treasury: withDevTreasury(treasuryFile),
    publicBaseUrl:
      process.env.BLOCKLE_EXCHANGE_PUBLIC_URL ??
      fileCfg.publicBaseUrl ??
      "https://exchange.blockle.org",
    x402: {
      facilitator:
        fileCfg.x402?.facilitator ??
        (mainnetEnabled ? "" : "https://x402.org/facilitator"),
      serviceUrl: fileCfg.x402?.serviceUrl,
    },
    sessionTtlSec: fileCfg.sessionTtlSec ?? 24 * 3600,
    nonceTtlSec: fileCfg.nonceTtlSec ?? 300,
    ...overrides,
  };
  return cfg;
}

/** The on-chain treasury address a fee must be paid to, for a given chain,
 *  respecting the mainnet gate. */
export function treasuryAddress(cfg: Config, chain: string): string | undefined {
  const net = cfg.mainnetEnabled ? "mainnet" : "testnet";
  return cfg.treasury?.[net]?.[chain];
}
