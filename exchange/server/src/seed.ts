// seed.ts — #37 LISTING LIQUIDITY SEED.
//
// When a new asset listing is ACTIVATED (after its fee is verified), the
// protocol seeds the new asset's mandatory BLOCK market with `seedBlockUsd`
// (default $5) worth of BLOCK, FROM THE PREMINE/RESERVE — IN ADDITION to the
// $5 listing fee. The fee goes to the treasury; this $5 of BLOCK is a separate,
// premine-funded liquidity subsidy.
//
//   * For a BLOCK-20 asset the seed contributes into the native BLOCK/<asset>
//     AMM pool; for a cross-chain order-book market it posts a resting protocol
//     BLOCK order on BLOCK/<asset>.
//   * NON-CUSTODIAL: the relay holds NO reserve key. A real dispense is
//     REQUESTED from the non-relay reserve signer (the same node signer the
//     x402 / settlement services use), over HTTP to `seed.signerUrl`.
//   * GATED + TESTNET-FIRST: `mainnetEnabled` defaults false. Until it is on,
//     the seed is a DRY RUN — it records the dispense INTENT in the audit log
//     and sends nothing. A real premine dispense only happens on mainnet with a
//     reachable signer.
//   * FAIL-CLOSED: on mainnet, if the reserve signer is not configured or not
//     reachable, the seed throws and the listing is NOT activated — we never
//     activate a listing we could not seed, and we never silently skip the
//     subsidy.
//   * AUDIT-LOGGED: intent, dry-run, dispense, and failure are all recorded.

import * as crypto from "crypto";
import type { DB } from "./db";
import { audit } from "./db";
import type { Config } from "./config";

export class SeedError extends Error {}

/** Where the BLOCK seed is placed for a given listing. */
export type SeedVenue = "amm-pool" | "orderbook";

export interface SeedIntent {
  intentId: string;
  listingId: string;
  symbol: string;
  /** the mandatory BLOCK/<symbol> market being seeded */
  market: string;
  venue: SeedVenue;
  /** USD value of the seed */
  seedUsd: number;
  /** BLOCK to dispense, base units (8 dp), sized at the listing-time price */
  blockAmountBase: string;
  /** indicative BLOCK price used to size the seed */
  blockPriceUsd: number;
}

export interface SeedResult {
  intentId: string;
  market: string;
  venue: SeedVenue;
  seedUsd: number;
  blockAmountBase: string;
  /** true only when a REAL premine dispense happened (mainnet) */
  dispensed: boolean;
  /** true when this was a recorded intent with NO real send (testnet default) */
  dryRun: boolean;
  /** present only on a real dispense */
  txid?: string;
  detail: string;
}

/** The non-relay reserve signer. The relay never holds the key; it asks the
 *  signer to move premine BLOCK. */
export interface ReserveSigner {
  /** whether the signer + reserve are reachable/usable right now */
  available(): Promise<boolean>;
  /** perform a real premine dispense for the given intent */
  dispense(intent: SeedIntent): Promise<{ txid: string; detail?: string }>;
}

/** HTTP reserve signer: forwards the dispense to the node signer process over
 *  loopback/HTTP, exactly like the settlement service's reserve path — the key
 *  lives in THAT process, never in this relay. Any transport/HTTP error is
 *  treated as "unavailable" so the caller fails closed. */
export class HttpReserveSigner implements ReserveSigner {
  constructor(
    private baseUrl: string,
    private timeoutMs = 5000,
  ) {}

  private url(p: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${p}`;
  }

  async available(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url("/healthz"), { signal: ctl.signal });
        return res.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return false;
    }
  }

  async dispense(intent: SeedIntent): Promise<{ txid: string; detail?: string }> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url("/reserve/dispense"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "listing-liquidity-seed",
          intentId: intent.intentId,
          listingId: intent.listingId,
          symbol: intent.symbol,
          market: intent.market,
          venue: intent.venue,
          asset: "BLOCK",
          amountBase: intent.blockAmountBase,
        }),
        signal: ctl.signal,
      });
    } catch (e: any) {
      throw new SeedError(`reserve signer unreachable: ${e?.message ?? e}`);
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      throw new SeedError(`reserve signer rejected dispense (HTTP ${res.status})`);
    }
    const body: any = await res.json().catch(() => ({}));
    const txid = body?.txid ?? body?.txHash;
    if (!txid) throw new SeedError("reserve signer returned no txid for the dispense");
    return { txid: String(txid), detail: body?.detail };
  }
}

/** Build the reserve signer the config asks for, or undefined when none is
 *  configured (the relay then dry-runs on testnet / fails closed on mainnet). */
export function makeReserveSigner(cfg: Config): ReserveSigner | undefined {
  return cfg.seed.signerUrl ? new HttpReserveSigner(cfg.seed.signerUrl) : undefined;
}

export class Seeder {
  constructor(
    private db: DB,
    private cfg: Config,
    private signer?: ReserveSigner,
  ) {}

  /** BLOCK base-unit amount (8 dp) for `seedUsd` at the listing-time price. */
  seedAmountBase(seedUsd: number = this.cfg.seed.seedBlockUsd): bigint {
    const price = this.cfg.blockPriceUsd;
    if (!(price > 0)) throw new SeedError("blockPriceUsd must be > 0 to size the liquidity seed");
    if (!(seedUsd > 0)) return 0n;
    return BigInt(Math.round((seedUsd / price) * 1e8));
  }

  /** Venue the seed is placed into for an asset of the given kind. */
  venueFor(kind: string): SeedVenue {
    return kind === "block20" ? "amm-pool" : "orderbook";
  }

  /**
   * Seed the mandatory BLOCK/<symbol> market from the premine. Returns the
   * result (dry-run intent on testnet; real dispense on mainnet). Throws
   * SeedError when a gated mainnet dispense cannot be performed (fail-closed).
   */
  async seedListing(args: {
    listingId: string;
    symbol: string;
    assetKind: string;
    lister: string;
  }): Promise<SeedResult> {
    const seedUsd = this.cfg.seed.seedBlockUsd;
    const market = `BLOCK/${args.symbol}`;
    const venue = this.venueFor(args.assetKind);
    const intentId = "seed_" + crypto.randomBytes(10).toString("hex");

    // seeding disabled, or zero-valued => no-op, still audited.
    if (!this.cfg.seed.enabled || !(seedUsd > 0)) {
      const result: SeedResult = {
        intentId,
        market,
        venue,
        seedUsd,
        blockAmountBase: "0",
        dispensed: false,
        dryRun: !this.cfg.mainnetEnabled,
        detail: "liquidity seed disabled (seed.enabled=false or seedBlockUsd<=0) — no dispense",
      };
      audit(this.db, "listing.seed.skip", args.lister, result);
      return result;
    }

    const blockAmountBase = this.seedAmountBase(seedUsd).toString();
    const intent: SeedIntent = {
      intentId,
      listingId: args.listingId,
      symbol: args.symbol,
      market,
      venue,
      seedUsd,
      blockAmountBase,
      blockPriceUsd: this.cfg.blockPriceUsd,
    };

    // record the dispense INTENT before anything moves (write-before-send).
    audit(this.db, "listing.seed.intent", args.lister, intent);

    // TESTNET-FIRST: default is a DRY RUN — intent recorded, nothing sent.
    if (!this.cfg.mainnetEnabled) {
      const result: SeedResult = {
        intentId,
        market,
        venue,
        seedUsd,
        blockAmountBase,
        dispensed: false,
        dryRun: true,
        detail:
          "testnet/dryRun — premine liquidity seed intent recorded; NO real dispense (enable mainnet + a reserve signer to dispense)",
      };
      audit(this.db, "listing.seed.dryrun", args.lister, result);
      return result;
    }

    // MAINNET real dispense (gated). FAIL-CLOSED if the signer/reserve is
    // unavailable: we refuse to activate a listing we cannot seed.
    const signer = this.signer;
    if (!signer || !(await signer.available())) {
      audit(this.db, "listing.seed.fail", args.lister, {
        intentId,
        market,
        reason: "reserve signer unavailable",
      });
      throw new SeedError(
        "premine reserve signer unavailable — refusing to activate the listing without its liquidity seed (fail-closed)",
      );
    }

    let dispense: { txid: string; detail?: string };
    try {
      dispense = await signer.dispense(intent);
    } catch (e: any) {
      audit(this.db, "listing.seed.fail", args.lister, {
        intentId,
        market,
        reason: String(e?.message ?? e),
      });
      if (e instanceof SeedError) throw e;
      throw new SeedError(`premine liquidity seed dispense failed: ${e?.message ?? e}`);
    }

    const result: SeedResult = {
      intentId,
      market,
      venue,
      seedUsd,
      blockAmountBase,
      dispensed: true,
      dryRun: false,
      txid: dispense.txid,
      detail: dispense.detail ?? `premine liquidity seed dispensed into ${market} (${venue})`,
    };
    audit(this.db, "listing.seed.dispense", args.lister, result);
    return result;
  }
}
