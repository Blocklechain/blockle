// Config loader for the x402 payment-rail service.
//
// Three config sources, merged in this order (later wins for service knobs):
//   1. config/service.config.json   (service knobs; env vars override)
//   2. buy-config.json              (BLOCK reserve + Base USDC reserve + curve;
//                                    operator source of truth, same file the
//                                    site /api/buy/config serves)
//   3. exchange/treasury.json       (listing-fee treasury addresses)
//
// COMPLIANCE: every fiat/USDC money path is DISABLED unless mainnetEnabled is
// true AND legalReviewCompleted is true. In dev we stay on Base Sepolia with
// the public x402.org facilitator; mainnet (eip155:8453 / base) + a production
// facilitator are gated behind that flag pair. We NEVER hardcode reserve or
// treasury addresses — they come from the operator config files at runtime.

"use strict";

const fs = require("fs");
const path = require("path");

const SERVICE_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SERVICE_DIR, "..", "..");

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function envBool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === "") return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

function envStr(name, dflt) {
  const v = process.env[name];
  return v == null || v === "" ? dflt : v;
}

function envNum(name, dflt) {
  const v = process.env[name];
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// ---- service knobs ----------------------------------------------------------

function loadServiceConfig() {
  const p = envStr("X402_SERVICE_CONFIG", path.join(SERVICE_DIR, "config", "service.config.json"));
  const sample = path.join(SERVICE_DIR, "config", "service.config.sample.json");
  const base = readJson(p, null) || readJson(sample, {});

  // env overrides (env always wins over file)
  const cfg = {
    port: envNum("X402_PORT", base.port ?? 8402),
    mainnetEnabled: envBool("X402_MAINNET_ENABLED", base.mainnetEnabled ?? false),
    legalReviewCompleted: envBool("X402_LEGAL_REVIEW_COMPLETED", base.legalReviewCompleted ?? false),
    publicBaseUrl: envStr("X402_PUBLIC_BASE", base.publicBaseUrl ?? "https://exchange.blockle.org"),
    network: envStr("X402_NETWORK", base.network ?? "base-sepolia"),
    facilitatorUrl: envStr("X402_FACILITATOR_URL", base.facilitatorUrl ?? "https://x402.org/facilitator"),
    productionFacilitatorUrl: envStr("X402_PROD_FACILITATOR_URL", base.productionFacilitatorUrl ?? ""),
    listingFeeUsd: envNum("X402_LISTING_FEE_USD", base.listingFeeUsd ?? 5),
    perPairFeeUsd: envNum("X402_PER_PAIR_FEE_USD", base.perPairFeeUsd ?? 1),
    confirmations: envNum("X402_CONFIRMATIONS", base.confirmations ?? 12),
    dailyCapUsd: envNum("X402_DAILY_CAP_USD", base.dailyCapUsd ?? 50000),
    buyConfigPath: envStr("X402_BUY_CONFIG", base.buyConfigPath ?? "/var/lib/blockle-biz/buy-config.json"),
    treasuryPath: envStr("X402_TREASURY", base.treasuryPath ?? path.join(REPO_ROOT, "exchange", "treasury.json")),
    ledgerPath: envStr("X402_LEDGER", base.ledgerPath ?? path.join(SERVICE_DIR, "data", "ledger.db")),
    kycModule: envStr("X402_KYC_MODULE", base.kycModule ?? ""),
    receiptTtlSeconds: envNum("X402_RECEIPT_TTL", base.receiptTtlSeconds ?? 3600),
    maxTimeoutSeconds: envNum("X402_MAX_TIMEOUT", base.maxTimeoutSeconds ?? 120),
    release: Object.assign(
      {
        command: "blockle-chain",
        reserveDatadir: "/var/lib/blockle/reserve",
        nodeAddr: "127.0.0.1:18444",
        // dryRun defaults TRUE so a dev box without the reserve wallet never
        // tries to shell a missing binary. Operators flip it off in prod.
        dryRun: true,
      },
      base.release || {},
    ),
  };

  // env overrides for the release block
  cfg.release.command = envStr("X402_RELEASE_CMD", cfg.release.command);
  cfg.release.reserveDatadir = envStr("X402_RESERVE_DATADIR", cfg.release.reserveDatadir);
  cfg.release.nodeAddr = envStr("X402_NODE_ADDR", cfg.release.nodeAddr);
  cfg.release.dryRun = envBool("X402_RELEASE_DRYRUN", cfg.release.dryRun);

  // receipt-signing secret (NOT a custody key — a shared HMAC secret the relay
  // uses to verify 'listing-paid'/'action-paid' receipts this service issues).
  cfg.receiptSecret = envStr("X402_RECEIPT_SECRET", base.receiptSecret ?? "");

  return cfg;
}

// ---- buy-config (reserve + curve, operator source of truth) -----------------

function loadBuyConfig(cfg) {
  const sample = path.join(SERVICE_DIR, "config", "buy-config.sample.json");
  const bc = readJson(cfg.buyConfigPath, null) || readJson(sample, {});
  // Mirror web/buy.js defaults EXACTLY — never invent curve numbers.
  const curve = bc.curve || {};
  return {
    ticker: bc.ticker || "BLOCK",
    feeBps: bc.feeBps != null ? bc.feeBps : 500,
    blockReserveAddr: bc.blockReserveAddr || "",
    usdc: Object.assign(
      { network: "base", rpc: "https://mainnet.base.org", contract: "", decimals: 6, reserveAddr: "" },
      bc.usdc || {},
    ),
    curve: {
      startPrice: curve.startPrice != null ? curve.startPrice : 0.1,
      targetUsdc: curve.targetUsdc != null ? curve.targetUsdc : 2000000,
      allocation: curve.allocation != null ? curve.allocation : 210000,
    },
    raw: bc,
  };
}

// ---- treasury (listing-fee receiving addresses) -----------------------------

function loadTreasury(cfg) {
  const t = readJson(cfg.treasuryPath, { mainnet: {}, testnet: {} });
  return t;
}

/** The treasury payTo address for a given network, honouring mainnet gating. */
function treasuryPayTo(treasury, network, mainnet) {
  // Base Sepolia (dev) → testnet.base; Base mainnet → mainnet.base.
  const bucket = mainnet ? treasury.mainnet || {} : treasury.testnet || {};
  // treasury.json uses chain keys (base/ethereum/solana...). x402 fees are
  // USDC on an EVM network → use the "base" key.
  return bucket.base || bucket.ethereum || bucket.erc20 || "";
}

/**
 * Assert the money path is allowed for the requested network. Throws a
 * descriptive error the caller turns into a 503 when a mainnet path is used
 * without a recorded legal review.
 */
function assertMoneyAllowed(cfg, network) {
  const isMainnet = network === "base" || network === "ethereum" || network === "polygon" || network === "avalanche";
  if (isMainnet && !(cfg.mainnetEnabled && cfg.legalReviewCompleted)) {
    throw new Error(
      `mainnet money path for network "${network}" is DISABLED — set mainnetEnabled=true AND legalReviewCompleted=true in service config only after an operator records a completed legal/compliance review`,
    );
  }
}

/** Resolve the facilitator URL, gating the production facilitator. */
function facilitatorFor(cfg) {
  if (cfg.mainnetEnabled && cfg.legalReviewCompleted) {
    if (!cfg.productionFacilitatorUrl) {
      throw new Error("mainnet enabled but productionFacilitatorUrl is not set");
    }
    return cfg.productionFacilitatorUrl;
  }
  return cfg.facilitatorUrl;
}

module.exports = {
  SERVICE_DIR,
  REPO_ROOT,
  loadServiceConfig,
  loadBuyConfig,
  loadTreasury,
  treasuryPayTo,
  assertMoneyAllowed,
  facilitatorFor,
};
