// settle.ts — the core sell/redemption engine.
//
// POST /settle {blockTxid, userUsdcAddr}:
//   1. validate inputs
//   2. verify the inbound BLOCK on the BLOCK chain: it must pay the reserve
//      BLOCK address, with >= confirmationDepth confirmations (reorg safety)
//   3. read the LIVE USDC reserve balance on Base (this drives price)
//   4. quote USDC on the curve sell side (mirror of web/buy.js)
//   5. AVAILABILITY CLAMP: pay at most maxReserveFractionPerRedemption of the
//      live balance (and within the rolling daily cap) — low balance => lower
//      effective price / partial fill, so the reserve can never be drained
//   6. compliance screen the payout
//   7. idempotency: begin() a pending ledger row BEFORE paying; pay; settle()
//   8. return {usdcOut, txHash, explorer} (+ clamp detail)
//
// Mainnet money paths are gated: if the USDC network is Base mainnet and the
// legal-review-backed switch is off, we refuse rather than pay.

import { SettlementConfig, mainnetActive, isMainnetNetwork } from "./config";
import { Curve } from "./curve";
import { ChainReader } from "./chain";
import { UsdcReserve } from "./reserve";
import { ComplianceScreener } from "./compliance";
import { Ledger, LedgerConflict } from "./ledger";

const BASE_ADDR = /^0x[0-9a-fA-F]{40}$/;
const BLOCK_TXID = /^(0x)?[0-9a-fA-F]{64}$/;

export interface SettleRequest {
  blockTxid: string;
  userUsdcAddr: string;
}

export interface QuoteResult {
  /** BLOCK being redeemed, base units */
  blockInBase: string;
  /** whole BLOCK (display) */
  blockIn: number;
  /** live reserve USDC balance, base units */
  reserveUsdcBase: string;
  /** unclamped curve proceeds, base units */
  quotedUsdcBase: string;
  /** actual payable USDC after the availability clamp + daily cap, base units */
  usdcOutBase: string;
  /** whole USDC that would be paid (display; matches buy.js resp.usdcOut) */
  usdcOut: number;
  /** true when the clamp/cap reduced the payout below the curve quote */
  partial: boolean;
  /** which guard bound the payout: "curve" | "reserve-fraction" | "daily-cap" */
  boundBy: string;
  /** curve spot price at the current reserve, USD/BLOCK */
  spotPrice: number;
}

export interface SettleOk {
  usdcOut: number;
  usdcOutBase: string;
  txHash: string;
  explorer: string;
  partial: boolean;
  blockIn: number;
  quote: QuoteResult;
}

export interface SettleErr {
  error: string;
  /** machine-readable code for the caller */
  code?: string;
  /** present when the tx is valid but not yet deep enough */
  confirmations?: number;
  needConfirmations?: number;
}

export interface EngineDeps {
  config: SettlementConfig;
  chain: ChainReader;
  reserve: UsdcReserve;
  ledger: Ledger;
  compliance: ComplianceScreener;
  /** injectable clock for tests (unix seconds) */
  now?: () => number;
}

export class SettlementEngine {
  private curve: Curve;
  private usdcScale: bigint;
  private now: () => number;

  constructor(private deps: EngineDeps) {
    this.curve = new Curve(deps.config.curve);
    this.usdcScale = 10n ** BigInt(deps.config.usdc.decimals);
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ---- unit helpers -------------------------------------------------------
  private blockBaseToWhole(base: bigint): number {
    return Number(base) / 1e8;
  }
  private usdcBaseToWhole(base: bigint): number {
    return Number(base) / Number(this.usdcScale);
  }
  private usdcWholeToBase(whole: number): bigint {
    return BigInt(Math.floor(whole * Number(this.usdcScale)));
  }

  /**
   * Price `blockInBase` BLOCK against the live reserve, apply the availability
   * clamp + daily cap. Pure read — never pays. Used by POST /quote and as the
   * first half of settle().
   */
  async quote(blockInBase: bigint): Promise<QuoteResult> {
    const cfg = this.deps.config;
    const reserveUsdcBase = await this.deps.reserve.balanceOfBase();
    const reserveWhole = this.usdcBaseToWhole(reserveUsdcBase);
    const blockIn = this.blockBaseToWhole(blockInBase);

    const q = this.curve.sellQuote(blockIn, reserveWhole);
    const quotedUsdcBase = this.usdcWholeToBase(q.out);

    // clamp 1: a single redemption <= fraction of the live reserve
    const frac = cfg.maxReserveFractionPerRedemption;
    const fracCapBase = BigInt(Math.floor(Number(reserveUsdcBase) * frac));

    // clamp 2: rolling daily cap
    const dayAgo = this.now() - 86_400;
    const spentTodayBase = this.deps.ledger.settledSince(dayAgo);
    const dailyCapBase = this.usdcWholeToBase(cfg.dailyCapUsdc);
    const dailyRemainingBase = dailyCapBase > spentTodayBase ? dailyCapBase - spentTodayBase : 0n;

    // final payable = min(curve, fraction cap, daily remaining, live balance)
    let usdcOutBase = quotedUsdcBase;
    let boundBy = "curve";
    if (fracCapBase < usdcOutBase) {
      usdcOutBase = fracCapBase;
      boundBy = "reserve-fraction";
    }
    if (dailyRemainingBase < usdcOutBase) {
      usdcOutBase = dailyRemainingBase;
      boundBy = "daily-cap";
    }
    if (reserveUsdcBase < usdcOutBase) {
      usdcOutBase = reserveUsdcBase;
      boundBy = "reserve-balance";
    }
    if (usdcOutBase < 0n) usdcOutBase = 0n;

    const partial = usdcOutBase < quotedUsdcBase;
    return {
      blockInBase: blockInBase.toString(),
      blockIn,
      reserveUsdcBase: reserveUsdcBase.toString(),
      quotedUsdcBase: quotedUsdcBase.toString(),
      usdcOutBase: usdcOutBase.toString(),
      usdcOut: this.usdcBaseToWhole(usdcOutBase),
      partial,
      boundBy: partial ? boundBy : "curve",
      spotPrice: this.curve.priceAt(reserveWhole),
    };
  }

  /** Full redemption. Returns a payout receipt or a structured error. */
  async settle(req: SettleRequest): Promise<SettleOk | SettleErr> {
    const cfg = this.deps.config;

    // ---- 0. gate mainnet money paths -------------------------------------
    if (isMainnetNetwork(cfg.usdc.network) && !mainnetActive(cfg)) {
      return {
        error:
          "mainnet USDC payouts are disabled: an operator must enable mainnet AND record a completed legal review in config before real funds move",
        code: "MAINNET_DISABLED",
      };
    }

    // ---- 1. validate ------------------------------------------------------
    const userUsdcAddr = (req.userUsdcAddr || "").trim();
    const blockTxid = (req.blockTxid || "").trim().toLowerCase().replace(/^0x/, "");
    if (!BASE_ADDR.test(userUsdcAddr)) {
      return { error: "userUsdcAddr must be a valid Base 0x… address", code: "BAD_ADDR" };
    }
    if (!BLOCK_TXID.test(blockTxid)) {
      return { error: "blockTxid must be a 64-hex BLOCK transaction id", code: "BAD_TXID" };
    }
    if (!cfg.blockReserveAddr) {
      return { error: "service not configured: blockReserveAddr is empty", code: "NOT_CONFIGURED" };
    }

    // ---- 2. idempotency fast path ----------------------------------------
    const prior = this.deps.ledger.get(blockTxid);
    if (prior) {
      if (prior.status === "settled") {
        return {
          usdcOut: this.usdcBaseToWhole(BigInt(prior.usdcOutBase ?? "0")),
          usdcOutBase: prior.usdcOutBase ?? "0",
          txHash: prior.txHash ?? "",
          explorer: prior.explorer ?? "",
          partial: false,
          blockIn: this.blockBaseToWhole(BigInt(prior.blockInBase ?? "0")),
          quote: {
            blockInBase: prior.blockInBase ?? "0",
            blockIn: this.blockBaseToWhole(BigInt(prior.blockInBase ?? "0")),
            reserveUsdcBase: "0",
            quotedUsdcBase: prior.usdcOutBase ?? "0",
            usdcOutBase: prior.usdcOutBase ?? "0",
            usdcOut: this.usdcBaseToWhole(BigInt(prior.usdcOutBase ?? "0")),
            partial: false,
            boundBy: "idempotent-replay",
            spotPrice: 0,
          },
        };
      }
      return {
        error: "this BLOCK txid is already being settled; a payout is in progress",
        code: "IN_PROGRESS",
      };
    }

    // ---- 3. verify inbound BLOCK on-chain --------------------------------
    let inbound;
    try {
      inbound = await this.deps.chain.getInboundToReserve(blockTxid, cfg.blockReserveAddr);
    } catch (e: any) {
      return { error: `chain read failed: ${e?.message ?? e}`, code: "CHAIN_ERROR" };
    }
    if (!inbound) {
      return { error: "no such BLOCK transaction found yet — wait for it to propagate", code: "TX_NOT_FOUND" };
    }
    if (inbound.amountBase <= 0n) {
      return {
        error: "that BLOCK transaction does not pay the reserve address",
        code: "NO_RESERVE_OUTPUT",
      };
    }
    if (inbound.confirmations < cfg.confirmationDepth) {
      return {
        error: `not enough confirmations yet (${inbound.confirmations}/${cfg.confirmationDepth}); try again once it matures`,
        code: "INSUFFICIENT_CONFIRMATIONS",
        confirmations: inbound.confirmations,
        needConfirmations: cfg.confirmationDepth,
      };
    }

    // ---- 4/5. quote + availability clamp ---------------------------------
    const q = await this.quote(inbound.amountBase);
    const usdcOutBase = BigInt(q.usdcOutBase);
    if (usdcOutBase <= 0n) {
      return {
        error:
          "the reserve has no USDC available for a payout right now — your BLOCK is safe; try again when the reserve is funded",
        code: "NO_AVAILABILITY",
      };
    }

    // ---- 6. compliance screen --------------------------------------------
    const screen = await this.deps.compliance.screen({ userUsdcAddr, blockTxid, usdcOutBase });
    if (!screen.allowed) {
      return { error: screen.reason || "payout blocked by compliance screening", code: "COMPLIANCE_BLOCK" };
    }

    // ---- 7. idempotent payout (write-before-send) ------------------------
    try {
      this.deps.ledger.begin(blockTxid, userUsdcAddr, inbound.amountBase);
    } catch (e) {
      if (e instanceof LedgerConflict) {
        if (e.status === "settled") {
          const done = this.deps.ledger.get(blockTxid)!;
          return {
            usdcOut: this.usdcBaseToWhole(BigInt(done.usdcOutBase ?? "0")),
            usdcOutBase: done.usdcOutBase ?? "0",
            txHash: done.txHash ?? "",
            explorer: done.explorer ?? "",
            partial: false,
            blockIn: this.blockBaseToWhole(BigInt(done.blockInBase ?? "0")),
            quote: q,
          };
        }
        return { error: e.message, code: "IN_PROGRESS" };
      }
      throw e;
    }

    let pay;
    try {
      pay = await this.deps.reserve.pay(userUsdcAddr, usdcOutBase);
    } catch (e: any) {
      // payout never left the building: release the claim so a retry is safe
      this.deps.ledger.fail(blockTxid, `payout failed: ${e?.message ?? e}`);
      return { error: `USDC payout failed: ${e?.message ?? e}`, code: "PAYOUT_FAILED" };
    }

    // ---- 8. mark settled + respond ---------------------------------------
    this.deps.ledger.settle(blockTxid, usdcOutBase, pay.txHash, pay.explorer);
    return {
      usdcOut: q.usdcOut,
      usdcOutBase: q.usdcOutBase,
      txHash: pay.txHash,
      explorer: pay.explorer,
      partial: q.partial,
      blockIn: q.blockIn,
      quote: q,
    };
  }
}
