// Self-serve "super exchange" listing. ANYONE (human or agent) can
// permissionlessly list a new tradeable asset for a small fee:
//
//   base fee  $5  -> the asset + its MANDATORY BLOCK/<asset> pair
//   per extra $1  -> each additional pair (<asset>/ETH, /USDC, …)
//
// EVERY listing MUST include the BLOCK pair — it is auto-included and cannot be
// removed; a listing without it is impossible to express. Fees are paid
// NON-CUSTODIALLY to the treasury; the relay verifies payment (on-chain txid OR
// x402 "listing-paid" receipt) BEFORE flipping the listing live. Real fee
// collection is gated by mainnetEnabled; dev/testnet fees settle on testnet.

import * as crypto from "crypto";
import type { DB } from "./db";
import { audit, claimIdempotencyKey } from "./db";
import type { Config } from "./config";
import { treasuryAddress } from "./config";
import type { Registry, AssetSpec } from "./registry";
import type { FeeVerifier } from "./feeverify";
import type { ComplianceProvider } from "./compliance";
import { Seeder, type SeedResult } from "./seed";
import type { OrderBook, SeedPlacement } from "./orders";

export interface ListingQuoteItem {
  item: string;
  usd: number;
}
export interface ListingQuote {
  totalUsd: number;
  breakdown: ListingQuoteItem[];
  payTo: string;
  payAsset: AssetSpec;
  /** exact base-unit amount to pay in payAsset (so agents can pay precisely) */
  payAmount: string;
  markets: string[];
}
export interface ListingResult {
  listingId: string;
  markets: string[];
  /** premine-funded BLOCK liquidity seed applied at activation (#37). */
  seed: SeedResult;
  /** placement of the seed into the BLOCK/<symbol> order book (#37): a live
   *  resting protocol order on a real dispense, or a recorded intent on a
   *  dry-run. Absent when no order book was wired in. */
  seedPlacement?: SeedPlacement;
}

export class ListingError extends Error {}

export class Listings {
  private seeder: Seeder;
  constructor(
    private db: DB,
    private cfg: Config,
    private registry: Registry,
    private feeVerifier: FeeVerifier,
    private compliance: ComplianceProvider,
    private onChange?: () => void,
    seeder?: Seeder,
    private book?: OrderBook,
  ) {
    this.seeder = seeder ?? new Seeder(db, cfg);
  }

  private validateAsset(asset: AssetSpec & { symbol?: string }): string {
    const symbol = (asset.symbol ?? "").trim().toUpperCase();
    if (!symbol || !/^[A-Z0-9]{2,12}$/.test(symbol)) {
      throw new ListingError("asset symbol must be 2-12 chars [A-Z0-9]");
    }
    if (symbol === "BLOCK") throw new ListingError("BLOCK is a base asset and cannot be re-listed");
    if (this.registry.isBaseAsset(symbol)) {
      throw new ListingError(`${symbol} is a built-in base asset`);
    }
    if (typeof asset.decimals !== "number" || asset.decimals < 0 || asset.decimals > 36) {
      throw new ListingError("asset decimals out of range");
    }
    if (!["native", "erc20", "spl", "block20"].includes(asset.kind)) {
      throw new ListingError(`unknown asset kind "${asset.kind}"`);
    }
    if (asset.kind !== "native" && !asset.addr) {
      throw new ListingError(`${asset.kind} asset needs a contract/mint address`);
    }
    return symbol;
  }

  private payAmountFor(payChain: string, totalUsd: number): { asset: AssetSpec; amount: string } {
    if (payChain === "block") {
      const amt = BigInt(Math.round((totalUsd / this.cfg.blockPriceUsd) * 1e8));
      return {
        asset: { symbol: "BLOCK", chain: "block", kind: "native", decimals: 8 },
        amount: amt.toString(),
      };
    }
    // default: settle in USDC (6 dp)
    const usdc = this.registry.asset("USDC")!;
    const amt = BigInt(Math.round(totalUsd * 10 ** this.cfg.usdStableDecimals));
    return { asset: usdc, amount: amt.toString() };
  }

  quote(
    asset: AssetSpec & { symbol?: string },
    extraPairs: string[] = [],
    payWith = "block",
  ): ListingQuote {
    const symbol = this.validateAsset(asset);
    const clean = (extraPairs ?? []).map((p) => p.trim().toUpperCase()).filter((p) => p && p !== "BLOCK" && p !== symbol);
    const unknown = clean.filter((p) => !this.registry.asset(p));
    if (unknown.length) throw new ListingError(`unknown pair asset(s): ${unknown.join(", ")}`);

    const breakdown: ListingQuoteItem[] = [
      { item: `listing ${symbol} + mandatory BLOCK/${symbol} pair`, usd: this.cfg.fees.listingFeeUsd },
      ...clean.map((p) => ({ item: `extra pair ${symbol}/${p}`, usd: this.cfg.fees.perPairFeeUsd })),
    ];
    const totalUsd = breakdown.reduce((s, b) => s + b.usd, 0);
    const markets = this.registry.marketsForListing(symbol, clean);

    const payChain = payWith === "block" ? "block" : payWith;
    const payTo = treasuryAddress(this.cfg, payChain) ?? treasuryAddress(this.cfg, "block") ?? "";
    const { asset: payAsset, amount } = this.payAmountFor(payChain, totalUsd);

    return { totalUsd, breakdown, payTo, payAsset, payAmount: amount, markets };
  }

  async create(
    lister: string,
    body: {
      asset: AssetSpec & { symbol?: string };
      extraPairs?: string[];
      paymentTxid?: string;
      x402Receipt?: any;
      payWith?: string;
      ip?: string;
    },
  ): Promise<ListingResult> {
    const symbol = this.validateAsset(body.asset);
    const extraPairs = (body.extraPairs ?? []).map((p) => p.trim().toUpperCase()).filter((p) => p && p !== "BLOCK" && p !== symbol);
    const quote = this.quote(body.asset, extraPairs, body.payWith ?? "block");

    // mandatory BLOCK pair guard (defense-in-depth; marketsForListing enforces it)
    if (!quote.markets.includes(`BLOCK/${symbol}`)) {
      throw new ListingError("listing must include the mandatory BLOCK pair");
    }

    // compliance screen at the fee boundary (no-op in dev)
    const screen = await this.compliance.screen({
      boundary: "listing-fee",
      address: lister,
      chain: body.payWith ?? "block",
      ip: body.ip,
      context: { symbol, extraPairs },
    });
    if (!screen.allowed) throw new ListingError(`listing blocked by compliance screen: ${screen.reason ?? "denied"}`);

    // idempotency: a payment txid / receipt id may be used for ONE listing only
    const payRef = body.paymentTxid ?? (body.x402Receipt && (body.x402Receipt.receipt ?? body.x402Receipt.txid));
    if (!payRef) throw new ListingError("a paymentTxid or x402 listing-paid receipt is required");
    if (!claimIdempotencyKey(this.db, "listing-fee", `fee:${payRef}`)) {
      throw new ListingError("this payment has already been used for a listing");
    }

    const verify = await this.feeVerifier.verify({
      payTo: quote.payTo,
      chain: body.payWith ?? "block",
      paymentTxid: body.paymentTxid,
      x402Receipt: body.x402Receipt,
      expectedUsd: quote.totalUsd,
    });
    if (!verify.verified) {
      audit(this.db, "listing.fee.reject", lister, { symbol, detail: verify.detail });
      throw new ListingError(`listing fee not verified: ${verify.detail ?? "unknown"}`);
    }

    const listingId = "lst_" + crypto.randomBytes(10).toString("hex");

    // #37: premine-funded liquidity seed for the mandatory BLOCK/<symbol>
    // market — IN ADDITION to the fee (fee -> treasury; this BLOCK comes from
    // the reserve). Gated + testnet-first (dryRun default) + fail-closed: a
    // gated mainnet dispense that cannot be performed throws here and the
    // listing is NOT activated. Done BEFORE the activation write so we never
    // persist a listing we could not seed.
    const seed = await this.seeder.seedListing({
      listingId,
      symbol,
      assetKind: body.asset.kind,
      lister,
    });

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO assets (symbol, chain, kind, addr, decimals, logo, active, listing_id, created)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          symbol,
          body.asset.chain,
          body.asset.kind,
          body.asset.addr ?? null,
          body.asset.decimals,
          (body.asset as any).logo ?? null,
          1,
          listingId,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO listings (listing_id, symbol, extra_pairs, markets, total_usd, pay_to, payment_txid, payment_kind, active, lister, created)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          listingId,
          symbol,
          JSON.stringify(extraPairs),
          JSON.stringify(quote.markets),
          quote.totalUsd,
          quote.payTo,
          payRef,
          verify.kind,
          1,
          lister,
          now,
        );
    });
    tx();

    // #37 PLACEMENT: consume the SeedResult into the now-live BLOCK/<symbol>
    // order book. On a real dispense this posts a resting protocol SELL-BLOCK
    // order (non-custodial, backed by seedDestination, referencing the dispense
    // txid); on a dry-run it records the placement intent only. Done AFTER the
    // activation write so the market is live and the order is immediately
    // visible/matchable. Fail-closed on the dispense itself already happened
    // above (seedListing throws before this write when a gated dispense cannot
    // be performed), so reaching here means the seed is accounted for.
    let seedPlacement: SeedPlacement | undefined;
    if (this.book) {
      seedPlacement = this.book.placeSeedLiquidity(seed, { symbol, assetKind: body.asset.kind });
    }

    audit(this.db, "listing.activate", lister, {
      listingId,
      symbol,
      markets: quote.markets,
      payKind: verify.kind,
      seed: { intentId: seed.intentId, seedUsd: seed.seedUsd, dispensed: seed.dispensed, dryRun: seed.dryRun },
      seedPlacement: seedPlacement
        ? { placed: seedPlacement.placed, recordedIntent: seedPlacement.recordedIntent, orderId: seedPlacement.orderId, seedTxid: seedPlacement.seedTxid }
        : undefined,
    });
    this.onChange?.();
    return { listingId, markets: quote.markets, seed, seedPlacement };
  }

  list(): Array<{ listingId: string; asset: AssetSpec; markets: string[]; active: boolean }> {
    const rows = this.db.prepare("SELECT * FROM listings WHERE active=1 ORDER BY created DESC").all() as any[];
    return rows.map((r) => {
      const a = this.db.prepare("SELECT * FROM assets WHERE symbol=?").get(r.symbol) as any;
      return {
        listingId: r.listing_id,
        asset: a
          ? { symbol: a.symbol, chain: a.chain, kind: a.kind, addr: a.addr ?? undefined, decimals: a.decimals }
          : { symbol: r.symbol, chain: "", kind: "", decimals: 0 },
        markets: JSON.parse(r.markets),
        active: !!r.active,
      };
    });
  }
}
