// Operational health + metrics for the relayer/bridge. Read-only, no secrets.
// Surfaces the figures the operator dashboard + alerting need. Every number
// comes from the durable store + accounting ledgers — nothing fabricated.

import { reserves, outstanding, reconcile, fromBase } from './accounting.js';
import { STATES } from './statemachine.js';

const countBy = (rows, pred) => rows.reduce((n, r) => n + (pred(r) ? 1 : 0), 0);

export function health(store, cfg, relayer) {
  const deposits = store.all('deposits') || [];
  const burns = store.all('burns') || [];
  const mints = store.all('mints') || [];
  const releases = store.all('releases') || [];

  const pendingMints = countBy(deposits, (r) => r.state === STATES.MINTING);
  const pendingReleases = countBy(burns, (r) => r.state === STATES.RELEASING);
  const unconfirmed = countBy(deposits, (r) => r.state === STATES.SUBMITTED || r.state === STATES.CONFIRMING_SOURCE);
  const refundPending = countBy([...deposits, ...burns], (r) => r.state === STATES.REFUND_PENDING);
  const failed = countBy([...deposits, ...burns], (r) => r.state === STATES.FAILED);

  const custodyBase = reserves(mints, releases);
  const issuedBase = outstanding(mints, releases);
  const recon = reconcile(mints, releases);

  const blockCursor = (store.get('meta', 'blockCursor') || {}).value ?? null;
  const solCursor = (store.get('meta', 'solCursor') || {}).value ?? null;

  return {
    ok: !recon.shouldPause && !cfg.paused,
    paused: !!cfg.paused,
    reconciliation: { ...recon, custody: fromBase(custodyBase), issued: fromBase(issuedBase) },
    lastProcessedBlockHeight: blockCursor,
    lastProcessedSolanaSlot: solCursor,
    queue: { unconfirmedDeposits: unconfirmed, pendingMints, pendingReleases, refundPending, failed },
    counts: { deposits: deposits.length, burns: burns.length, mints: mints.length, releases: releases.length },
    reserveBlock: fromBase(custodyBase),
    wblockOutstanding: fromBase(issuedBase),
    relayer: relayer ? { retries: relayer.retries, lastError: relayer.lastError } : null,
    // Alert conditions — the monitor flips these true; see docs/bridge/MONITORING.md.
    alerts: {
      reserveMismatch: recon.shouldPause,
      repeatedFailures: relayer ? relayer.retries >= 5 : false,
      refundsPending: refundPending > 0,
    },
    at: Date.now(),
  };
}

export default health;
