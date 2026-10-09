// helpers.ts — test fixtures: a fake chain, a temp ledger, a configurable
// engine, all offline (no node, no EVM).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SettlementConfig, DEFAULT_CONFIG } from "../src/config";
import { ChainReader, InboundBlock } from "../src/chain";
import { MockUsdcReserve } from "../src/reserve";
import { NoOpScreener, ComplianceScreener } from "../src/compliance";
import { Ledger } from "../src/ledger";
import { SettlementEngine } from "../src/settle";

const RESERVE_BLOCK = "block1reserveaddressfortests";

export class FakeChain implements ChainReader {
  constructor(private byTxid: Record<string, InboundBlock>) {}
  async getInboundToReserve(blockTxid: string, _reserve: string): Promise<InboundBlock | null> {
    const id = blockTxid.toLowerCase().replace(/^0x/, "");
    return this.byTxid[id] ?? null;
  }
}

export function tmpLedgerPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "settle-")), "ledger.json");
}

export interface BuildOpts {
  reserveUsdc?: number; // whole USDC in the mock reserve
  confirmationDepth?: number;
  maxFraction?: number;
  dailyCapUsdc?: number;
  network?: string;
  mainnetEnabled?: boolean;
  legalReviewCompleted?: boolean;
  compliance?: ComplianceScreener;
  inbound?: Record<string, InboundBlock>;
  now?: () => number;
  ledger?: Ledger;
  reserve?: MockUsdcReserve;
}

export function buildEngine(opts: BuildOpts = {}) {
  const cfg: SettlementConfig = {
    ...DEFAULT_CONFIG,
    blockReserveAddr: RESERVE_BLOCK,
    confirmationDepth: opts.confirmationDepth ?? 10,
    maxReserveFractionPerRedemption: opts.maxFraction ?? 0.1,
    dailyCapUsdc: opts.dailyCapUsdc ?? 1_000_000,
    mainnetEnabled: opts.mainnetEnabled ?? false,
    legalReview: { completed: opts.legalReviewCompleted ?? false },
    usdc: {
      ...DEFAULT_CONFIG.usdc,
      network: opts.network ?? "base-sepolia",
      mode: "mock",
      mockBalanceUsdc: opts.reserveUsdc ?? 100_000,
    },
    ledgerPath: tmpLedgerPath(),
  };
  const reserve =
    opts.reserve ??
    new MockUsdcReserve(BigInt(Math.round((opts.reserveUsdc ?? 100_000) * 1e6)), cfg.usdc.explorerBase);
  const chain = new FakeChain(opts.inbound ?? {});
  const ledger = opts.ledger ?? new Ledger(cfg.ledgerPath);
  const compliance = opts.compliance ?? new NoOpScreener();
  const engine = new SettlementEngine({ config: cfg, chain, reserve, ledger, compliance, now: opts.now });
  return { engine, cfg, reserve, chain, ledger };
}

/** A confirmed inbound BLOCK tx paying `block` whole BLOCK to the reserve. */
export function inboundTx(txid: string, blockWhole: number, confirmations = 100): Record<string, InboundBlock> {
  return {
    [txid]: {
      amountBase: BigInt(Math.round(blockWhole * 1e8)),
      confirmations,
      displayTxid: txid,
    },
  };
}

export const RESERVE_BLOCK_ADDR = RESERVE_BLOCK;
