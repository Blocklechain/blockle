// config.ts — operator configuration for the settlement service.
//
// TESTNET-FIRST + COMPLIANCE:
//   - Every USDC money path is DISABLED by default. `mainnetEnabled` defaults
//     false and is only honoured when `legalReview.completed === true` AND a
//     reviewer + date are recorded. Until then the service settles on Base
//     Sepolia (testnet) and refuses any Base mainnet payout.
//   - confirmationDepth (reorg safety) and dailyCapUsdc (blast radius) are
//     CONFIG, not constants, and default conservative (deep + capped).
//   - The reserve hot-wallet key lives ONLY here (this process). It is never
//     logged and never leaves the signer. blockle-biz forwards requests here
//     and never sees it.
//
// Amounts in this file that an operator types are in WHOLE units (USDC, BLOCK)
// for readability; the engine converts to base units internally.

import * as fs from "fs";
import { CurveParams, DEFAULT_CURVE } from "./curve";

export interface LegalReview {
  /** Set true ONLY after counsel completes the review. Gates mainnet. */
  completed: boolean;
  reviewer?: string;
  date?: string;
  notes?: string;
}

export interface UsdcConfig {
  /** "base-sepolia" (testnet, default) or "base" (mainnet, gated). */
  network: string;
  /** JSON-RPC endpoint for the Base network. */
  rpc: string;
  /** USDC ERC-20 contract on that network. */
  contract: string;
  /** USDC decimals (6 on Base). */
  decimals: number;
  /** Reserve hot-wallet address (0x…, Base) — holds USDC + pays sellers. */
  reserveAddr: string;
  /** Block explorer base for tx links, e.g. https://sepolia.basescan.org */
  explorerBase: string;
  /**
   * Reserve mode:
   *   "mock"   — no real EVM; balance from `mockBalanceUsdc`, fake tx hashes.
   *              The default in dev and whenever no signer key is present.
   *   "ethers" — real payouts via a lazily-required `ethers` signer.
   */
  mode: "mock" | "ethers";
  /** Mock reserve balance in whole USDC (mode === "mock" only). */
  mockBalanceUsdc?: number;
  /** Reserve hot-wallet private key (mode === "ethers" only). Keep it here and
   *  nowhere else. Prefer the SETTLEMENT_RESERVE_KEY env var over the file. */
  privateKey?: string;
}

export interface ComplianceConfig {
  /** Optional module path exporting `createScreener(cfg)` -> ComplianceScreener.
   *  Omitted in dev => the built-in NO-OP screener (never evades KYC/geo; it
   *  simply allows everything so testnet dev works). */
  module?: string;
  /** Opaque options handed to the external screener module. */
  options?: Record<string, unknown>;
}

export interface SettlementConfig {
  /** HTTP bind. Must stay loopback — biz forwards to 127.0.0.1:8790. */
  host: string;
  port: number;

  /** Mainnet master switch. Only effective with a completed legal review. */
  mainnetEnabled: boolean;
  legalReview: LegalReview;

  /** BLOCK node aux-http base (reads /explorer/*). */
  nodeUrl: string;
  /** BLOCK reserve address (block1…) sellers send BLOCK to. */
  blockReserveAddr: string;
  /** Confirmations required on the inbound BLOCK tx before any payout. */
  confirmationDepth: number;

  /** USDC reserve on Base. */
  usdc: UsdcConfig;

  /** Sqrt primary-sale curve params (mirror of web/buy.js). */
  curve: CurveParams;

  /** AVAILABILITY CLAMP: a single redemption may pay out at most this fraction
   *  of the live reserve USDC balance, so the reserve can never be drained and
   *  low balance => lower effective price / partial fill. */
  maxReserveFractionPerRedemption: number;
  /** Rolling 24h payout cap in whole USDC. */
  dailyCapUsdc: number;

  /** Persistent idempotency/dedupe + payout ledger (JSON file). */
  ledgerPath: string;

  compliance: ComplianceConfig;
}

export const DEFAULT_CONFIG: SettlementConfig = {
  host: "127.0.0.1",
  port: 8790,

  mainnetEnabled: false,
  legalReview: { completed: false },

  nodeUrl: "http://127.0.0.1:8445",
  blockReserveAddr: "",
  confirmationDepth: 100,

  usdc: {
    network: "base-sepolia",
    rpc: "https://sepolia.base.org",
    contract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
    decimals: 6,
    reserveAddr: "",
    explorerBase: "https://sepolia.basescan.org",
    mode: "mock",
    mockBalanceUsdc: 0,
  },

  curve: DEFAULT_CURVE,

  maxReserveFractionPerRedemption: 0.1,
  dailyCapUsdc: 25_000,

  ledgerPath: "/var/lib/blockle-settlement/ledger.json",

  compliance: {},
};

/** A network string that denotes Base MAINNET (gated). Everything else is
 *  treated as a testnet and allowed without the legal-review gate. */
export function isMainnetNetwork(network: string): boolean {
  const n = (network || "").toLowerCase();
  return n === "base" || n === "base-mainnet" || n === "mainnet";
}

/** Mainnet is only truly enabled when the switch is on AND a legal review is
 *  recorded complete. This is the single chokepoint the engine consults. */
export function mainnetActive(cfg: SettlementConfig): boolean {
  return cfg.mainnetEnabled === true && cfg.legalReview?.completed === true;
}

function deepMerge<T>(base: T, over: any): T {
  if (over == null) return base;
  if (typeof base !== "object" || Array.isArray(base) || base == null) return over as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(over)) {
    out[k] = deepMerge((base as any)[k], over[k]);
  }
  return out as T;
}

/**
 * Load config: defaults <- JSON file (SETTLEMENT_CONFIG or the given path) <-
 * a couple of env overrides. The reserve key is read from
 * SETTLEMENT_RESERVE_KEY if present so it never has to live in the file.
 */
export function loadConfig(path?: string): SettlementConfig {
  const file = path || process.env.SETTLEMENT_CONFIG || "/etc/blockle-settlement/config.json";
  let fromFile: any = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // honest default: mock reserve, testnet, nothing configured yet
    fromFile = {};
  }
  let cfg = deepMerge(DEFAULT_CONFIG, fromFile);

  const envKey = process.env.SETTLEMENT_RESERVE_KEY;
  if (envKey) cfg.usdc.privateKey = envKey;
  if (process.env.SETTLEMENT_PORT) cfg.port = Number(process.env.SETTLEMENT_PORT);

  // Safety normalisation: a reserve with no key can only run in mock mode.
  if (cfg.usdc.mode === "ethers" && !cfg.usdc.privateKey) {
    cfg.usdc.mode = "mock";
  }
  return cfg;
}
