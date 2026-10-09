// Listing-fee verification. Fees are paid NON-CUSTODIALLY: the lister pays the
// configured TREASURY address on-chain (USDC or BLOCK per config) OR presents
// an x402 "listing-paid" receipt. The relay VERIFIES the payment BEFORE
// activating the listing — it never custodies the fee, never routes around it,
// and never activates a listing without a confirmed payment.
//
// PLUGGABLE: a real deployment injects a verifier that checks the chain /
// facilitator. The dev verifier accepts a well-formed testnet payment and logs
// it; on MAINNET it REFUSES unless a real verifier is injected, so money never
// moves on an unverified claim.

import type { Config } from "./config";

export interface FeeVerifyRequest {
  /** on-chain treasury address the fee had to be paid to */
  payTo: string;
  /** chain the fee was paid on */
  chain: string;
  /** direct on-chain payment txid (one of txid / x402Receipt required) */
  paymentTxid?: string;
  /** x402 "listing-paid" receipt (JSON) */
  x402Receipt?: any;
  /** expected fee, USD */
  expectedUsd: number;
}

export interface FeeVerifyResult {
  verified: boolean;
  kind: "onchain" | "x402" | "none";
  detail?: string;
}

export interface FeeVerifier {
  verify(req: FeeVerifyRequest): Promise<FeeVerifyResult>;
}

/** Dev verifier: testnet-only, no custody, no real chain calls. Accepts a
 *  plausible txid or a structurally-valid x402 receipt. REFUSES on mainnet. */
export class DevFeeVerifier implements FeeVerifier {
  constructor(private cfg: Config) {}

  async verify(req: FeeVerifyRequest): Promise<FeeVerifyResult> {
    if (this.cfg.mainnetEnabled) {
      return {
        verified: false,
        kind: "none",
        detail:
          "mainnet fee verification requires a real FeeVerifier (chain/facilitator) — the dev verifier refuses to confirm real payments",
      };
    }
    if (req.x402Receipt) {
      const r = req.x402Receipt;
      const ok = !!(r && (r.receipt || r.settlement || r.txid) && (r.paid || r.status === "paid" || r.settled));
      return ok
        ? { verified: true, kind: "x402", detail: "dev-accepted x402 listing-paid receipt (testnet)" }
        : { verified: false, kind: "x402", detail: "x402 receipt missing paid/settled marker" };
    }
    if (req.paymentTxid && /^(0x)?[0-9a-fA-F]{16,100}$/.test(req.paymentTxid)) {
      return { verified: true, kind: "onchain", detail: "dev-accepted testnet fee txid (no chain call)" };
    }
    return { verified: false, kind: "none", detail: "no paymentTxid or x402 receipt presented" };
  }
}

export function makeFeeVerifier(cfg: Config): FeeVerifier {
  return new DevFeeVerifier(cfg);
}
