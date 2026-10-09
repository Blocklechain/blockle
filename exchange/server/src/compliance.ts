// Compliance hooks: KYC + geo/sanctions screening at every trade and fee
// boundary. PLUGGABLE interface, NO-OP in dev (always allows, logs only).
// There is deliberately NO feature whose purpose is to evade KYC, sanctions,
// or geo rules — this interface only ever ALLOWS or DENIES; it never hides or
// routes around a check. A real deployment injects a provider that calls its
// KYC/geo vendor.

import type { Config } from "./config";

export interface ScreenRequest {
  /** what boundary is being crossed */
  boundary: "trade" | "listing-fee" | "swap";
  /** the party's address + chain */
  address: string;
  chain: string;
  /** optional request IP for geo screening */
  ip?: string;
  /** free-form context (market, amount, listingId, …) */
  context?: Record<string, unknown>;
}

export interface ScreenResult {
  allowed: boolean;
  reason?: string;
}

export interface ComplianceProvider {
  screen(req: ScreenRequest): Promise<ScreenResult>;
}

/** Dev default: allow everything, record nothing beyond the audit log the
 *  caller writes. Mainnet operators MUST replace this with a real provider. */
export class NoopCompliance implements ComplianceProvider {
  async screen(_req: ScreenRequest): Promise<ScreenResult> {
    return { allowed: true };
  }
}

/** Factory. For now returns the no-op provider in all environments; a mainnet
 *  deployment wires a real provider here (and mainnetEnabled is itself gated
 *  on a recorded legal review, so this is never silently live in prod). */
export function makeCompliance(_cfg: Config): ComplianceProvider {
  return new NoopCompliance();
}
