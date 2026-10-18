// accounting.js — PURE bridge accounting + the asset-safety invariants.
//
// These functions take plain snapshots (arrays of ledger rows) and return
// numbers/booleans. No I/O, no clock, no randomness — so they are exhaustively
// unit-testable and can be re-run as an auditor's reconciliation at any time.
//
// TRUST MODEL: CUSTODIAL. "Backing" = BLOCK held in the operator reserve wallet.
// "Issued" = outstanding wBLOCK (an SPL mint) in circulation. Our #1 job is the
// invariant: every outstanding wBLOCK is backed by FINALIZED BLOCK in custody.
//
// FINALIZED-ONLY BACKING: backing/issued are computed EXCLUSIVELY from the
// finalized ledgers (mints = completed deposits, releases = completed burns).
// Pending/in-flight transfers are NEVER counted as spendable backing. This is the
// whole point — a deposit that hasn't buried `confirmationDepth` blocks must not
// let anyone mint against it, and an unconfirmed burn must not release BLOCK.
//
// 1 BLOCK and 1 wBLOCK are both 1e8 base units; the peg is 1:1 at the base-unit
// level, so all conversions are identity on base units. Fees (base units) are the
// only thing that makes custody and issued diverge, and they can only make custody
// EXCEED issued (fee surplus), never the reverse.

export const DECIMALS = 8;
export const COIN = 100000000n; // 1e8

// ---------------------------------------------------------------------------
// Exact 8-decimal conversions (BigInt; no float ever touches money).
// ---------------------------------------------------------------------------

/** Whole-unit decimal string/number -> integer base units (bigint). Rejects >8dp. */
export function toBase(whole) {
  const s = String(whole).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount "${whole}"`);
  const neg = s.startsWith('-');
  const [intPart, fracPart = ''] = (neg ? s.slice(1) : s).split('.');
  if (fracPart.length > DECIMALS) throw new Error(`amount "${whole}" exceeds ${DECIMALS} decimals`);
  const base = BigInt(intPart) * COIN + BigInt(fracPart.padEnd(DECIMALS, '0') || '0');
  return neg ? -base : base;
}

/** Integer base units -> canonical whole-unit decimal string (trimmed, exact). */
export function fromBase(base) {
  const n = BigInt(base);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / COIN;
  const frac = (abs % COIN).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

/** Coerce a persisted amount (string base units) to bigint, defaulting 0. */
export function asBase(v) {
  if (v == null || v === '') return 0n;
  return BigInt(v);
}

// ---------------------------------------------------------------------------
// Fees — charged on the OUTPUT. fee = flat + ceil(amount * bps / 10000).
// Charging on the output guarantees custody >= issued (fee stays in custody).
// ---------------------------------------------------------------------------

export function computeFee(amountBase, { feeFlatBase = 0n, feeBps = 0 } = {}) {
  const amt = BigInt(amountBase);
  if (amt <= 0n) return 0n;
  const flat = BigInt(feeFlatBase);
  const bps = BigInt(Math.trunc(feeBps));
  // ceil division so the operator never under-collects a fraction of a base unit.
  const pct = bps > 0n ? (amt * bps + 9999n) / 10000n : 0n;
  let fee = flat + pct;
  if (fee < 0n) fee = 0n;
  return fee;
}

/** Split a gross amount into { feeBase, netBase }. Throws if the fee would eat it all. */
export function applyFee(amountBase, feeCfg = {}) {
  const amt = BigInt(amountBase);
  if (amt <= 0n) throw new Error('amount must be positive');
  const feeBase = computeFee(amt, feeCfg);
  const netBase = amt - feeBase;
  if (netBase <= 0n) throw new Error('fee exceeds or equals amount — nothing left to deliver');
  return { feeBase, netBase };
}

// ---------------------------------------------------------------------------
// Ledger aggregation. A `mint` row: { depositId, blockInBase, solblockOutBase }.
// A `release` row: { burnId, solblockInBase, blockOutBase }. (All base-unit strings.)
// ---------------------------------------------------------------------------

/** BLOCK currently in custody backing wBLOCK = Σ(BLOCK deposited) − Σ(BLOCK released). */
export function reserves(mints = [], releases = []) {
  let c = 0n;
  for (const m of mints) c += asBase(m.blockInBase);
  for (const r of releases) c -= asBase(r.blockOutBase);
  return c;
}

/** Outstanding wBLOCK supply = Σ(wBLOCK minted) − Σ(wBLOCK burned-and-released). */
export function outstanding(mints = [], releases = []) {
  let s = 0n;
  for (const m of mints) s += asBase(m.solblockOutBase);
  for (const r of releases) s -= asBase(r.solblockInBase);
  return s;
}

/**
 * Pending vs completed view over the in-flight transfer records (deposits+burns).
 * `completed` are those whose finalized ledger row exists; everything else that
 * isn't terminal-failed/refunded is pending. Pending NEVER counts as backing.
 */
export function pendingVsCompleted(transfers = []) {
  const bucket = { pending: 0, completed: 0, failed: 0, refunded: 0 };
  let pendingSourceBase = 0n;
  for (const t of transfers) {
    if (t.state === 'completed') bucket.completed++;
    else if (t.state === 'refunded') bucket.refunded++;
    else if (t.state === 'failed') bucket.failed++;
    else {
      bucket.pending++;
      pendingSourceBase += asBase(t.sourceAmountBase);
    }
  }
  return { ...bucket, pendingSourceBase: pendingSourceBase.toString() };
}

// ---------------------------------------------------------------------------
// INVARIANTS — each returns a boolean (assert-able). The one-to-one guarantees
// are enforced structurally (ledgers keyed by depositId/burnId) but we re-verify
// here so a reconciliation pass can detect any corruption or double-entry.
// ---------------------------------------------------------------------------

/** Every outstanding wBLOCK is backed by finalized BLOCK in custody. */
export function everyOutstandingBacked(mints = [], releases = []) {
  return outstanding(mints, releases) <= reserves(mints, releases);
}

/** No deposit produced more than one mint (unique depositId across the mint ledger). */
export function oneDepositOneMint(mints = []) {
  const seen = new Set();
  for (const m of mints) {
    if (seen.has(m.depositId)) return false;
    seen.add(m.depositId);
  }
  return true;
}

/** No burn produced more than one release (unique burnId across the release ledger). */
export function oneBurnOneRelease(releases = []) {
  const seen = new Set();
  for (const r of releases) {
    if (seen.has(r.burnId)) return false;
    seen.add(r.burnId);
  }
  return true;
}

/** Custody is never negative — we have never released more BLOCK than we took in. */
export function neverReleasedMoreThanCustody(mints = [], releases = []) {
  return reserves(mints, releases) >= 0n;
}

/**
 * Prospective guard: can we release `blockOutBase` right now WITHOUT touching
 * pending deposits? Uses finalized custody only.
 */
export function canRelease(blockOutBase, mints = [], releases = []) {
  const want = BigInt(blockOutBase);
  if (want <= 0n) return false;
  return reserves(mints, releases) >= want;
}

/**
 * Full reconciliation of issued vs backing. The operator/monitor calls this on a
 * schedule; a discrepancy (issued > backing, or any negative) MUST raise an alert
 * and should trip the pause kill-switch. `surplusBase` is fee revenue sitting in
 * custody above what's needed to redeem every wBLOCK.
 */
export function reconcile(mints = [], releases = []) {
  const backingBase = reserves(mints, releases);
  const issuedBase = outstanding(mints, releases);
  const surplusBase = backingBase - issuedBase;
  const violations = [];
  if (issuedBase < 0n) violations.push('issued-negative');
  if (backingBase < 0n) violations.push('backing-negative');
  if (issuedBase > backingBase) violations.push('undercollateralized');
  if (!oneDepositOneMint(mints)) violations.push('duplicate-mint');
  if (!oneBurnOneRelease(releases)) violations.push('duplicate-release');
  const ok = violations.length === 0;
  return {
    ok,
    backingBase: backingBase.toString(),
    issuedBase: issuedBase.toString(),
    surplusBase: surplusBase.toString(),
    backing: fromBase(backingBase),
    issued: fromBase(issuedBase),
    surplus: fromBase(surplusBase),
    violations,
    // The signal a monitor acts on: a discrepancy means pause + alert.
    shouldPause: !ok,
  };
}

/** Throwing wrapper for tests/startup self-checks. */
export function assertInvariants(mints = [], releases = []) {
  const r = reconcile(mints, releases);
  if (!r.ok) throw new Error(`bridge invariant violation: ${r.violations.join(', ')}`);
  return r;
}
