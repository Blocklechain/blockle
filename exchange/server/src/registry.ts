// Asset REGISTRY + market derivation. Markets are config-driven off the
// registry — NOT a hardcoded pair list. The live /markets set is:
//
//   (built-in base markets among active base assets)
//     +  (per active listing: the mandatory BLOCK/<asset> pair + its extras)
//
// Testnet addresses are the DEFAULT; mainnet addresses are GATED behind
// cfg.mainnetEnabled. A listing that omits its BLOCK pair is impossible to
// represent here — marketsForListing always prepends BLOCK/<asset>.

import type { DB } from "./db";
import type { Config } from "./config";

export interface AssetSpec {
  chain: string;
  kind: "native" | "erc20" | "spl" | "block20" | string;
  addr?: string;
  decimals: number;
  symbol?: string;
}

export interface Market {
  market: string;
  base: string;
  quote: string;
  baseAsset: AssetSpec;
  quoteAsset: AssetSpec;
}

interface BaseAssetDef {
  symbol: string;
  chain: string;
  kind: AssetSpec["kind"];
  decimals: number;
  testnetAddr?: string;
  mainnetAddr?: string;
}

// Built-in base assets. Addresses are config-overridable via treasury/registry
// files in a real deployment; defaults are testnet. erc20/spl addresses are
// resolved per-network and only the mainnet variant is exposed when gated on.
const BASE_ASSETS: BaseAssetDef[] = [
  { symbol: "BLOCK", chain: "block", kind: "native", decimals: 8 },
  { symbol: "ETH", chain: "ethereum", kind: "native", decimals: 18 },
  { symbol: "SOL", chain: "solana", kind: "native", decimals: 9 },
  // BTC — native Bitcoin Script HTLC leg (testnet/signet by default). 8 dp (sats).
  { symbol: "BTC", chain: "bitcoin", kind: "native", decimals: 8 },
  // SUI — Move HTLC shared-object leg (Sui testnet by default). 9 dp (MIST).
  { symbol: "SUI", chain: "sui", kind: "native", decimals: 9 },
  {
    symbol: "USDC",
    chain: "base",
    kind: "erc20",
    decimals: 6,
    // Base Sepolia USDC (Circle testnet) / Base mainnet USDC
    testnetAddr: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    mainnetAddr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    symbol: "USDT",
    chain: "ethereum",
    kind: "erc20",
    decimals: 6,
    // Sepolia test USDT (placeholder; override in config) / ETH mainnet USDT
    testnetAddr: "0x7169d38820dfd117c3fa1f22a697dba58d90ba06",
    mainnetAddr: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  },
];

// Built-in base markets — config-driven list, not pair-by-pair hardcoding in
// the matching/listing logic. Edit this to change the base market set.
const BASE_MARKETS: Array<[string, string]> = [
  ["BLOCK", "ETH"],
  ["BLOCK", "SOL"],
  ["BLOCK", "USDC"],
  ["BLOCK", "USDT"],
  ["ETH", "USDC"],
  ["SOL", "USDC"],
  // BTC + SUI full trading legs
  ["BLOCK", "BTC"],
  ["BLOCK", "SUI"],
  ["BTC", "USDC"],
  ["SUI", "USDC"],
  ["BTC", "SUI"],
];

export class Registry {
  constructor(
    private db: DB,
    private cfg: Config,
  ) {}

  private resolveBase(def: BaseAssetDef): AssetSpec {
    const addr =
      def.kind === "native"
        ? undefined
        : this.cfg.mainnetEnabled
          ? def.mainnetAddr
          : def.testnetAddr;
    return { symbol: def.symbol, chain: def.chain, kind: def.kind, addr, decimals: def.decimals };
  }

  /** All assets the relay currently trades: base assets + ACTIVE listed ones. */
  assets(): AssetSpec[] {
    const base = BASE_ASSETS.map((d) => this.resolveBase(d));
    const rows = this.db
      .prepare("SELECT symbol, chain, kind, addr, decimals FROM assets WHERE active=1")
      .all() as any[];
    const listed: AssetSpec[] = rows.map((r) => ({
      symbol: r.symbol,
      chain: r.chain,
      kind: r.kind,
      addr: r.addr ?? undefined,
      decimals: r.decimals,
    }));
    return [...base, ...listed];
  }

  asset(symbol: string): AssetSpec | undefined {
    return this.assets().find((a) => a.symbol === symbol);
  }

  isBaseAsset(symbol: string): boolean {
    return BASE_ASSETS.some((d) => d.symbol === symbol);
  }

  private makeMarket(base: string, quote: string): Market | null {
    const b = this.asset(base);
    const q = this.asset(quote);
    if (!b || !q) return null;
    return { market: `${base}/${quote}`, base, quote, baseAsset: b, quoteAsset: q };
  }

  /** Full live market list derived from the registry + active listings. */
  markets(): Market[] {
    const out = new Map<string, Market>();
    for (const [base, quote] of BASE_MARKETS) {
      const m = this.makeMarket(base, quote);
      if (m) out.set(m.market, m);
    }
    // per active listing: BLOCK/<asset> (mandatory) + its recorded extra markets
    const listings = this.db.prepare("SELECT markets FROM listings WHERE active=1").all() as any[];
    for (const row of listings) {
      for (const name of JSON.parse(row.markets) as string[]) {
        const [base, quote] = name.split("/");
        const m = this.makeMarket(base, quote);
        if (m) out.set(m.market, m);
      }
    }
    return [...out.values()];
  }

  market(name: string): Market | undefined {
    return this.markets().find((m) => m.market === name);
  }

  /** The market names a listing creates. ALWAYS includes BLOCK/<symbol> first
   *  (the mandatory pair) regardless of extras. */
  marketsForListing(symbol: string, extraPairs: string[]): string[] {
    const names = new Set<string>();
    names.add(`BLOCK/${symbol}`); // mandatory, non-removable
    for (const other of extraPairs) {
      if (other === symbol || other === "BLOCK") continue;
      names.add(`${symbol}/${other}`);
    }
    return [...names];
  }
}
