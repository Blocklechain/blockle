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

export interface SeedConfig {
  /** USD worth of BLOCK — from the PREMINE/RESERVE, IN ADDITION to the listing
   *  fee — to seed each new asset's mandatory BLOCK market on activation. */
  seedBlockUsd: number;
  /** master switch for the premine liquidity subsidy. Default true. When false
   *  the seed is a no-op (still audit-logged). */
  enabled: boolean;
  /** Base URL of the NON-RELAY reserve signer (the node signer the x402 /
   *  settlement services use). The relay holds NO reserve key; a real mainnet
   *  dispense is requested from this signer. Absent => no real signer, so a
   *  gated mainnet seed fails CLOSED. */
  signerUrl?: string;
  /** BLOCK address the premine seed is dispensed TO — the protocol seed wallet
   *  that backs the resting seed-liquidity order (#37). The relay holds NO key
   *  for it; when a taker matches the seed order the BLOCK leg settles via the
   *  reserve signer. */
  seedDestination?: string;
  /** Indicative USD price of a freshly-listed asset, used to PRICE the resting
   *  seed-liquidity order (quote-per-BLOCK = blockPriceUsd / seedAssetPriceUsd).
   *  CONFIG — the launchpad/curve opening price; replace with the real curve
   *  price before mainnet. */
  seedAssetPriceUsd: number;
}

/** Per-network DEPLOYED HTLC addresses the relay coordinates settlement
 *  against. The relay holds NO keys; these are the public contract/program/
 *  package ids each party's wallet calls, plus the BTC broadcast endpoint.
 *
 *  Fail-closed: the swap engine REFUSES a leg whose address is unset for the
 *  active network (see `htlcTarget` + SwapEngine). Mainnet entries are only
 *  consulted when `mainnetEnabled` is true, so leaving them blank keeps a
 *  testnet deployment testnet-only by construction. */
export interface HtlcConfig {
  /** Deployed EVM HTLC address keyed by network name
   *  (testnet: `sepolia`, `baseSepolia`; mainnet: `base`, `ethereum`). */
  evm: Record<string, string>;
  /** Deployed Solana HTLC program id keyed by cluster (`devnet`, `mainnet`). */
  solana: Record<string, string>;
  /** Published Sui HTLC package id keyed by network (`testnet`, `mainnet`). */
  sui: Record<string, string>;
  /** BTC has NO deployed contract (per-swap P2WSH). What a live spend needs is
   *  a funded hot wallet to fund/refund from and an Esplora base URL to fetch
   *  UTXOs + broadcast (`POST /tx`). `esploraUrl` is the enabling resource the
   *  fail-closed check requires. */
  btc: { hotWallet: string; esploraUrl: string };
  /** Deployed BLOCK-VM HTLC contract id (hex), from our reserve/node deploy
   *  (`blockle-chain contract deploy …`). The one leg WE can deploy. */
  block: { contractId: string };
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
  /** premine-funded listing liquidity seed (#37). */
  seed: SeedConfig;
  /** per-network DEPLOYED HTLC addresses the swap engine settles each leg
   *  against (fail-closed when a leg's address is unset). */
  htlc: HtlcConfig;
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
  // testnet-only dev placeholders (bech32 testnet / zero Sui address)
  bitcoin: "tb1qdevtreasury00000000000000000000000000",
  sui: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

function withDevTreasury(t: any): Record<string, Record<string, string>> {
  const out = { mainnet: { ...(t?.mainnet ?? {}) }, testnet: { ...(t?.testnet ?? {}) } };
  for (const [chain, addr] of Object.entries(DEV_TREASURY)) {
    if (!out.testnet[chain] || out.testnet[chain].startsWith("_")) out.testnet[chain] = addr;
  }
  delete (out.testnet as any)._todo;
  return out;
}

// Dev/testnet placeholder HTLC addresses so the swap flow is exercisable
// offline, mirroring DEV_TREASURY. These are NOT real deployments; a real
// testnet/mainnet deployment sets config.json → htlc (or the env overrides).
// Only TESTNET-family keys are seeded here — mainnet keys stay blank so a
// mainnet leg fails CLOSED until a real deployed address is configured.
const DEV_HTLC: HtlcConfig = {
  evm: {
    sepolia: "0x000000000000000000000000000000000000dEaD",
    baseSepolia: "0x000000000000000000000000000000000000dEaD",
  },
  solana: { devnet: "11111111111111111111111111111111" },
  sui: { testnet: "0x" + "0".repeat(64) },
  btc: {
    hotWallet: "tb1qdevhotwallet00000000000000000000000000",
    esploraUrl: "https://blockstream.info/testnet/api",
  },
  block: { contractId: "00".repeat(32) },
};

function mergeHtlc(file: any): HtlcConfig {
  const f = file ?? {};
  return {
    // DEV defaults fill only blanks; file config wins. DEV has no mainnet keys,
    // so a mainnet leg has no placeholder and fails closed until deployed.
    evm: { ...DEV_HTLC.evm, ...(f.evm ?? {}) },
    solana: { ...DEV_HTLC.solana, ...(f.solana ?? {}) },
    sui: { ...DEV_HTLC.sui, ...(f.sui ?? {}) },
    btc: {
      hotWallet:
        process.env.BLOCKLE_EXCHANGE_HTLC_BTC_HOTWALLET ??
        f.btc?.hotWallet ??
        DEV_HTLC.btc.hotWallet,
      esploraUrl:
        process.env.BLOCKLE_EXCHANGE_HTLC_BTC_ESPLORA ??
        f.btc?.esploraUrl ??
        DEV_HTLC.btc.esploraUrl,
    },
    block: {
      contractId:
        process.env.BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT ??
        f.block?.contractId ??
        DEV_HTLC.block.contractId,
    },
  };
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
    seed: {
      seedBlockUsd: envNum("BLOCKLE_EXCHANGE_SEED_BLOCK_USD", fileCfg.seed?.seedBlockUsd ?? 5),
      enabled: envBool("BLOCKLE_EXCHANGE_SEED_ENABLED", fileCfg.seed?.enabled ?? true),
      signerUrl: process.env.BLOCKLE_EXCHANGE_RESERVE_SIGNER_URL ?? fileCfg.seed?.signerUrl,
      seedDestination:
        process.env.BLOCKLE_EXCHANGE_SEED_DESTINATION ??
        fileCfg.seed?.seedDestination ??
        // dev/testnet placeholder protocol seed wallet (NOT a real funded key;
        // overridden in a real deployment). The relay never holds its key.
        "block1seedliquidityreserve000000000000000000",
      seedAssetPriceUsd: envNum(
        "BLOCKLE_EXCHANGE_SEED_ASSET_USD",
        fileCfg.seed?.seedAssetPriceUsd ?? 0.1,
      ),
    },
    htlc: mergeHtlc(fileCfg.htlc),
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

export interface HtlcTarget {
  /** the (lowercased) leg chain that was resolved. */
  chain: string;
  family: "evm" | "solana" | "sui" | "btc" | "block" | "unknown";
  /** the concrete network/cluster the address belongs to, respecting the
   *  mainnet gate (e.g. ethereum→sepolia on testnet). */
  network: string;
  /** deployed contract/program/package id (or, for BTC, the Esplora endpoint);
   *  "" when nothing is configured for the active network => fail closed. */
  address: string;
  /** extra per-family settlement context handed to the client's wallet. */
  extra?: Record<string, string>;
}

const EVM_CHAINS = new Set(["ethereum", "eth", "base", "arbitrum", "optimism", "polygon"]);

/** Map a logical EVM chain to the concrete network key under htlc.evm, honoring
 *  the mainnet gate (testnet uses the *Sepolia networks). */
function evmNetworkKey(chain: string, mainnet: boolean): string {
  switch (chain) {
    case "ethereum":
    case "eth":
      return mainnet ? "ethereum" : "sepolia";
    case "base":
      return mainnet ? "base" : "baseSepolia";
    default:
      return chain; // any other EVM network is named directly in config
  }
}

/**
 * Resolve the DEPLOYED HTLC target a given swap leg must settle against, for
 * the currently-active network. A blank `address` means the leg is NOT
 * configured and the swap engine must refuse it (fail-closed). This never
 * throws — the caller decides what an empty address means.
 */
export function htlcTarget(cfg: Config, chainRaw: string): HtlcTarget {
  const chain = (chainRaw || "").toLowerCase();
  const mainnet = cfg.mainnetEnabled;
  const h = cfg.htlc;

  if (chain === "block") {
    return {
      chain,
      family: "block",
      network: mainnet ? "mainnet" : "testnet",
      address: h?.block?.contractId ?? "",
    };
  }
  if (chain === "bitcoin" || chain === "btc") {
    // No deployed contract (per-swap P2WSH). The enabling resource for a live
    // spend is the Esplora endpoint (UTXO fetch + POST /tx broadcast); the
    // funded hot wallet rides along as settlement context.
    return {
      chain,
      family: "btc",
      network: mainnet ? "mainnet" : "testnet",
      address: h?.btc?.esploraUrl ?? "",
      extra: { hotWallet: h?.btc?.hotWallet ?? "", esploraUrl: h?.btc?.esploraUrl ?? "" },
    };
  }
  if (chain === "sui") {
    const network = mainnet ? "mainnet" : "testnet";
    return { chain, family: "sui", network, address: h?.sui?.[network] ?? "" };
  }
  if (chain === "solana" || chain === "sol") {
    const network = mainnet ? "mainnet" : "devnet";
    return { chain, family: "solana", network, address: h?.solana?.[network] ?? "" };
  }
  if (EVM_CHAINS.has(chain)) {
    const network = evmNetworkKey(chain, mainnet);
    return { chain, family: "evm", network, address: h?.evm?.[network] ?? "" };
  }
  // unknown chain family: no mapping => unconfigured => fail-closed upstream.
  return { chain, family: "unknown", network: mainnet ? "mainnet" : "testnet", address: "" };
}
