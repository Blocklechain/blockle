// statemachine.js — the replay-safe BLOCK <-> wBLOCK transfer state machine.
//
// TRUST MODEL: CUSTODIAL. This engine is the accounting brain; it records state
// and enforces the asset-safety rules. It does NOT itself move money or deploy
// anything — the actual BLOCK release (reserve-signer POST) and wBLOCK mint
// (operator-keyed Solana signer) are performed by sibling execution adapters that
// MUST be gated OFF/dry-run by default. This engine only verifies evidence and
// records the finalized result those adapters report back.
//
// IDEMPOTENCY / REPLAY SAFETY (the whole point):
//   - A transfer is identified by a canonical id derived from (direction,
//     source-tx-hash): depositId = id('deposit', blockTxid); burnId =
//     id('redeem', solBurnSig). Submitting the SAME source tx twice maps to the
//     SAME record — so one deposit can authorize AT MOST one mint, and one burn
//     AT MOST one release.
//   - Every transition is idempotent: applying the same event twice is a no-op.
//     Transitions guard on the current state and return the existing record
//     unchanged when the work is already done, so a crashed-and-retried worker,
//     a duplicated webhook, or a double-click can never double-issue.
//   - The FINALIZED ledgers (mints/releases) are written put-if-absent keyed by
//     depositId/burnId, a second structural guard against double issuance even if
//     a transition guard were ever bypassed.
//
// STATES:
//   awaiting_wallet      intent created; waiting for the user to send the source tx
//   submitted            a source tx hash has been attached
//   confirming_source    waiting for confirmationDepth confirmations on the source
//   awaiting_verification source buried deep enough; verifying amount + recipient
//   minting              (deposit) verified; wBLOCK mint authorized/executing
//   releasing            (redeem) verified; BLOCK release authorized/executing
//   completed            output tx recorded; finalized ledger row written
//   failed               terminal failure (bad amount, verification failed, …)
//   refund_pending       a failed/undeliverable transfer is queued for refund
//   refunded             refund recorded (terminal)

import crypto from 'node:crypto';
import {
  toBase,
  fromBase,
  asBase,
  applyFee,
  reserves,
  outstanding,
  canRelease,
  reconcile,
} from './accounting.js';

export const STATES = Object.freeze({
  AWAITING_WALLET: 'awaiting_wallet',
  SUBMITTED: 'submitted',
  CONFIRMING_SOURCE: 'confirming_source',
  AWAITING_VERIFICATION: 'awaiting_verification',
  MINTING: 'minting',
  RELEASING: 'releasing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REFUND_PENDING: 'refund_pending',
  REFUNDED: 'refunded',
});

const TERMINAL = new Set([STATES.COMPLETED, STATES.REFUNDED]);

export const DIRECTIONS = Object.freeze({
  DEPOSIT: 'deposit', // BLOCK in  -> wBLOCK minted
  REDEEM: 'redeem',   // wBLOCK burned -> BLOCK released
});

/** Namespace a direction's transfer records live in. */
function nsFor(direction) {
  return direction === DIRECTIONS.DEPOSIT ? 'deposits' : 'burns';
}

/** Normalize a source tx hash for dedup. BLOCK txids are hex (case-insensitive);
 *  Solana signatures are base58 (CASE-SENSITIVE) so we must NOT lowercase those. */
export function normalizeSourceTx(sourceTx) {
  const s = String(sourceTx || '').trim();
  if (/^0x?[0-9a-fA-F]{64,66}$/.test(s) || /^[0-9a-fA-F]{64}$/.test(s)) {
    return s.replace(/^0x/i, '').toLowerCase();
  }
  return s; // base58 (Solana) — leave as-is
}

/** Canonical transfer id derived from (direction, source-tx-hash). */
export function deriveId(direction, sourceTx) {
  const norm = normalizeSourceTx(sourceTx);
  if (!norm) throw new Error('sourceTx required to derive transfer id');
  const h = crypto.createHash('sha256').update(`${direction}:${norm}`).digest('hex');
  return `${direction === DIRECTIONS.DEPOSIT ? 'dep' : 'brn'}_${h.slice(0, 48)}`;
}

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

export class BridgeEngine {
  /**
   * @param {object} opts
   * @param {import('./store.js').BridgeStore} opts.store
   * @param {object} opts.config  from loadConfig()
   * @param {() => number} [opts.now]  injectable clock (tests)
   */
  constructor({ store, config, now = () => Date.now() }) {
    this.store = store;
    this.cfg = config;
    this.now = now;
  }

  // ---- read helpers ----

  _getTransfer(direction, id) {
    return this.store.get(nsFor(direction), id);
  }

  /** Finalized ledgers drive all backing math (pending never counts). */
  _ledgers() {
    return { mints: this.store.all('mints'), releases: this.store.all('releases') };
  }

  snapshot() {
    const { mints, releases } = this._ledgers();
    const r = reconcile(mints, releases);
    return {
      backingBase: reserves(mints, releases).toString(),
      outstandingBase: outstanding(mints, releases).toString(),
      reconcile: r,
    };
  }

  _assertNotPaused() {
    if (this.cfg.paused) throw new Error('bridge is PAUSED — new issuance is blocked');
  }

  /** Validate a gross source amount against per-tx + rolling daily caps. */
  _assertWithinLimits(direction, grossBase) {
    const amt = BigInt(grossBase);
    const perTx = BigInt(this.cfg.perTxCapBase);
    if (perTx > 0n && amt > perTx) {
      throw new Error(`amount ${fromBase(amt)} exceeds per-tx cap ${fromBase(perTx)}`);
    }
    const daily = BigInt(this.cfg.dailyCapBase);
    if (daily > 0n) {
      const key = `day:${direction}:${utcDay(this.now())}`;
      const used = asBase(this.store.get('meta', key)?.base);
      if (used + amt > daily) {
        throw new Error(
          `daily cap ${fromBase(daily)} reached for ${direction} (used ${fromBase(used)}, +${fromBase(amt)})`,
        );
      }
    }
  }

  async _creditDaily(direction, grossBase, id) {
    const daily = BigInt(this.cfg.dailyCapBase);
    if (daily <= 0n) return;
    const day = utcDay(this.now());
    const key = `day:${direction}:${day}`;
    await this.store.update('meta', key, (cur) => {
      const rec = cur || { day, direction, base: '0', ids: [] };
      // idempotent: only count a given transfer id once toward the daily total
      if (rec.ids.includes(id)) return rec;
      rec.base = (asBase(rec.base) + BigInt(grossBase)).toString();
      rec.ids.push(id);
      return rec;
    });
  }

  // ------------------------------------------------------------------
  // 1. Intent (awaiting_wallet). Optional UX helper shown to the user before
  //    they send the source tx. Stored under meta; carries no money weight.
  // ------------------------------------------------------------------
  async openIntent(direction, { destination } = {}) {
    this._assertNotPaused();
    if (direction !== DIRECTIONS.DEPOSIT && direction !== DIRECTIONS.REDEEM) {
      throw new Error(`unknown direction "${direction}"`);
    }
    const intentId = `int_${crypto.randomBytes(12).toString('hex')}`;
    const intent = {
      intentId,
      direction,
      state: STATES.AWAITING_WALLET,
      destination: destination || null,
      // where the user sends funds
      instructions:
        direction === DIRECTIONS.DEPOSIT
          ? { sendBlockTo: this.cfg.blockBridgeAddr || null }
          : { burnSolblockMint: this.cfg.solblockMint || null },
      createdAt: this.now(),
    };
    await this.store.put('meta', `intent:${intentId}`, intent);
    return intent;
  }

  // ------------------------------------------------------------------
  // 2. Submit source tx -> canonical transfer (submitted). IDEMPOTENT by id.
  //    Second submission of the SAME source tx returns the existing record;
  //    it NEVER creates a parallel transfer, which is what prevents a second
  //    mint/release for a duplicate deposit/burn.
  // ------------------------------------------------------------------
  async submitSource({ direction, sourceTx, destination, intentId, grossAmountBase }) {
    this._assertNotPaused();
    if (direction !== DIRECTIONS.DEPOSIT && direction !== DIRECTIONS.REDEEM) {
      throw new Error(`unknown direction "${direction}"`);
    }
    const id = deriveId(direction, sourceTx);
    const existing = this._getTransfer(direction, id);
    if (existing) return existing; // duplicate submit -> no-op, same record

    const rec = {
      id,
      direction,
      state: STATES.SUBMITTED,
      sourceTx: normalizeSourceTx(sourceTx),
      sourceTxRaw: String(sourceTx).trim(),
      destination: destination || null,
      intentId: intentId || null,
      // amounts (base-unit strings); sourceAmountBase is filled/confirmed at verify
      sourceAmountBase: grossAmountBase != null ? BigInt(grossAmountBase).toString() : null,
      feeBase: null,
      outputAmountBase: null,
      sourceConfirmations: 0,
      outputTx: null,
      failReason: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      history: [{ state: STATES.SUBMITTED, at: this.now() }],
    };
    await this.store.put(nsFor(direction), id, rec);
    if (intentId) {
      await this.store.update('meta', `intent:${intentId}`, (cur) =>
        cur ? { ...cur, state: STATES.SUBMITTED, transferId: id } : cur,
      );
    }
    return rec;
  }

  // Internal: guarded, idempotent state write.
  async _advance(direction, id, from, to, patch = {}) {
    let result = null;
    await this.store.update(nsFor(direction), id, (cur) => {
      if (!cur) throw new Error(`transfer ${id} not found`);
      // replay / idempotency: already at (or past) the target -> no-op
      if (cur.state === to) { result = cur; return undefined; }
      const allowed = Array.isArray(from) ? from : [from];
      if (!allowed.includes(cur.state)) {
        // not an error for terminal replays; otherwise an illegal transition
        if (TERMINAL.has(cur.state)) { result = cur; return undefined; }
        throw new Error(`illegal transition ${cur.state} -> ${to} for ${id}`);
      }
      const next = {
        ...cur,
        ...patch,
        state: to,
        updatedAt: this.now(),
        history: [...(cur.history || []), { state: to, at: this.now() }],
      };
      result = next;
      return next;
    });
    return result;
  }

  // ------------------------------------------------------------------
  // 3. Observe source confirmations + amount. Idempotent (absolute values).
  //    < confirmationDepth -> confirming_source; >= -> awaiting_verification.
  // ------------------------------------------------------------------
  async observeSource({ direction, sourceTx, confirmations, amountBase }) {
    const id = deriveId(direction, sourceTx);
    const cur = this._getTransfer(direction, id);
    if (!cur) throw new Error(`transfer ${id} not submitted`);
    if (TERMINAL.has(cur.state) || cur.state === STATES.MINTING || cur.state === STATES.RELEASING) {
      return cur; // already moved past confirmation — replay no-op
    }
    const confs = Math.max(0, Math.trunc(Number(confirmations) || 0));
    const deep = confs >= this.cfg.confirmationDepth;
    const patch = { sourceConfirmations: confs };
    if (amountBase != null) patch.sourceAmountBase = BigInt(amountBase).toString();
    const to = deep ? STATES.AWAITING_VERIFICATION : STATES.CONFIRMING_SOURCE;
    return this._advance(
      direction,
      id,
      [STATES.SUBMITTED, STATES.CONFIRMING_SOURCE, STATES.AWAITING_VERIFICATION],
      to,
      patch,
    );
  }

  // ------------------------------------------------------------------
  // 4. Verify + authorize issuance. This is the gate that computes the fee and
  //    output, enforces caps/pause, and for a REDEEM refuses to authorize a
  //    release that would draw on pending (unfinalized) backing.
  //
  //    A DEPOSIT cannot reach minting without verified (deep-confirmed) BLOCK:
  //    that is "mint-without-verified-backing rejected".
  //    A REDEEM cannot reach releasing without a verified (deep-confirmed) burn:
  //    that is "release-without-verified-burn rejected".
  // ------------------------------------------------------------------
  async verify({ direction, sourceTx, verifiedAmountBase, recipientOk = true }) {
    this._assertNotPaused();
    const id = deriveId(direction, sourceTx);
    const cur = this._getTransfer(direction, id);
    if (!cur) throw new Error(`transfer ${id} not submitted`);

    // replay: already authorized/finalized -> no-op
    if (cur.state === STATES.MINTING || cur.state === STATES.RELEASING || TERMINAL.has(cur.state)) {
      return cur;
    }
    if (cur.state !== STATES.AWAITING_VERIFICATION) {
      throw new Error(
        `cannot verify ${id} from ${cur.state}: source not confirmed to depth ${this.cfg.confirmationDepth}`,
      );
    }
    if (!recipientOk) {
      return this._advance(direction, id, STATES.AWAITING_VERIFICATION, STATES.FAILED, {
        failReason: 'recipient/address check failed',
      });
    }

    const gross =
      verifiedAmountBase != null ? BigInt(verifiedAmountBase) : asBase(cur.sourceAmountBase);
    if (gross <= 0n) {
      return this._advance(direction, id, STATES.AWAITING_VERIFICATION, STATES.FAILED, {
        failReason: 'non-positive verified amount',
      });
    }
    this._assertWithinLimits(direction, gross);

    // fee on the output; net is what we deliver
    const { feeBase, netBase } = applyFee(gross, this.cfg);

    if (direction === DIRECTIONS.REDEEM) {
      // never release more BLOCK than FINALIZED custody (pending excluded)
      const { mints, releases } = this._ledgers();
      if (!canRelease(netBase, mints, releases)) {
        return this._advance(direction, id, STATES.AWAITING_VERIFICATION, STATES.REFUND_PENDING, {
          failReason: `insufficient reserves to release ${fromBase(netBase)} BLOCK`,
          sourceAmountBase: gross.toString(),
          feeBase: feeBase.toString(),
          outputAmountBase: netBase.toString(),
        });
      }
    }

    const to = direction === DIRECTIONS.DEPOSIT ? STATES.MINTING : STATES.RELEASING;
    const patch = {
      sourceAmountBase: gross.toString(),
      feeBase: feeBase.toString(),
      outputAmountBase: netBase.toString(),
    };
    const next = await this._advance(direction, id, STATES.AWAITING_VERIFICATION, to, patch);
    // count toward the daily cap exactly once, at authorization time
    await this._creditDaily(direction, gross, id);
    return next;
  }

  // ------------------------------------------------------------------
  // 5. Settle: the execution adapter reports the finalized output tx. We write
  //    the FINALIZED ledger row put-if-absent (keyed by depositId/burnId) and
  //    mark completed. Replaying this is a no-op: the ledger row already exists
  //    and the state is already completed -> AT MOST ONE mint / ONE release.
  // ------------------------------------------------------------------
  async settle({ direction, sourceTx, outputTx }) {
    const id = deriveId(direction, sourceTx);
    const cur = this._getTransfer(direction, id);
    if (!cur) throw new Error(`transfer ${id} not found`);
    if (cur.state === STATES.COMPLETED) return cur; // replay no-op

    const expected = direction === DIRECTIONS.DEPOSIT ? STATES.MINTING : STATES.RELEASING;
    if (cur.state !== expected) {
      throw new Error(`cannot settle ${id} from ${cur.state} (expected ${expected})`);
    }

    // Write the immutable finalized ledger row FIRST, put-if-absent. If it
    // already exists (a racing/replayed settle) we do not write a second one.
    if (direction === DIRECTIONS.DEPOSIT) {
      await this.store.putIfAbsent('mints', id, {
        depositId: id,
        sourceTx: cur.sourceTx,
        blockInBase: asBase(cur.sourceAmountBase).toString(),
        solblockOutBase: asBase(cur.outputAmountBase).toString(),
        feeBase: asBase(cur.feeBase).toString(),
        solTx: outputTx || null,
        at: this.now(),
      });
    } else {
      await this.store.putIfAbsent('releases', id, {
        burnId: id,
        sourceTx: cur.sourceTx,
        solblockInBase: asBase(cur.sourceAmountBase).toString(),
        blockOutBase: asBase(cur.outputAmountBase).toString(),
        feeBase: asBase(cur.feeBase).toString(),
        blockTx: outputTx || null,
        at: this.now(),
      });
    }

    return this._advance(direction, id, expected, STATES.COMPLETED, {
      outputTx: outputTx || null,
    });
  }

  // ---- failure / refund path ----

  async fail({ direction, sourceTx, reason }) {
    const id = deriveId(direction, sourceTx);
    const cur = this._getTransfer(direction, id);
    if (!cur) throw new Error(`transfer ${id} not found`);
    if (cur.state === STATES.FAILED || cur.state === STATES.REFUND_PENDING) return cur;
    if (TERMINAL.has(cur.state)) {
      throw new Error(`cannot fail ${id} in terminal state ${cur.state}`);
    }
    return this._advance(
      direction,
      id,
      [
        STATES.SUBMITTED,
        STATES.CONFIRMING_SOURCE,
        STATES.AWAITING_VERIFICATION,
        STATES.MINTING,
        STATES.RELEASING,
      ],
      STATES.FAILED,
      { failReason: reason || 'failed' },
    );
  }

  async requestRefund({ direction, sourceTx, reason }) {
    const id = deriveId(direction, sourceTx);
    const cur = this._getTransfer(direction, id);
    if (!cur) throw new Error(`transfer ${id} not found`);
    if (cur.state === STATES.REFUND_PENDING) return cur;
    return this._advance(direction, id, [STATES.FAILED, STATES.AWAITING_VERIFICATION], STATES.REFUND_PENDING, {
      failReason: reason || cur.failReason || 'refund requested',
    });
  }

  async completeRefund({ direction, sourceTx, refundTx }) {
    const id = deriveId(direction, sourceTx);
    const cur = this._getTransfer(direction, id);
    if (!cur) throw new Error(`transfer ${id} not found`);
    if (cur.state === STATES.REFUNDED) return cur;
    return this._advance(direction, id, STATES.REFUND_PENDING, STATES.REFUNDED, {
      refundTx: refundTx || null,
    });
  }
}

export default BridgeEngine;
