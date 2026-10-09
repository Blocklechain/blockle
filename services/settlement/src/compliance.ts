// compliance.ts — KYC / sanctions / geo screening hook.
//
// This is a PLUGGABLE boundary, NO-OP in dev. It exists so an operator can wire
// a real screener at the custody edge before enabling mainnet. It is NEVER a
// feature for evading KYC/sanctions/geo — the only built-in behaviour is to
// allow (so testnet dev works); a deny decision can only come from a real
// screener the operator installs.

import { ComplianceConfig } from "./config";

export interface ScreenContext {
  /** the Base 0x… address the seller wants USDC paid to */
  userUsdcAddr: string;
  /** the inbound BLOCK txid being settled */
  blockTxid: string;
  /** payout size, USDC base units */
  usdcOutBase: bigint;
}

export interface ScreenResult {
  allowed: boolean;
  reason?: string;
}

export interface ComplianceScreener {
  screen(ctx: ScreenContext): Promise<ScreenResult>;
}

/** The dev default: allow everything. Deploying to mainnet without replacing
 *  this is an operator error — see the README + legal-review gate. */
export class NoOpScreener implements ComplianceScreener {
  async screen(_ctx: ScreenContext): Promise<ScreenResult> {
    return { allowed: true };
  }
}

/**
 * Load the screener the config points at. If `compliance.module` is set we
 * require it and call its `createScreener(options)` factory; otherwise we use
 * the built-in NO-OP. A broken module throws loudly rather than silently
 * falling back, so a mis-wired mainnet screener can never be mistaken for one
 * that is working.
 */
export function createScreener(cfg: ComplianceConfig): ComplianceScreener {
  if (!cfg || !cfg.module) return new NoOpScreener();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(cfg.module);
  const factory = mod.createScreener ?? mod.default;
  if (typeof factory !== "function") {
    throw new Error(`compliance.module ${cfg.module} must export createScreener(options)`);
  }
  const screener = factory(cfg.options ?? {});
  if (!screener || typeof screener.screen !== "function") {
    throw new Error(`compliance.module ${cfg.module} did not return a ComplianceScreener`);
  }
  return screener;
}
