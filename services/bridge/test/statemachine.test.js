// statemachine.test.js — replay-safe transfer state machine + issuance safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { BridgeStore } from '../src/store.js';
import { BridgeEngine, STATES, DIRECTIONS, deriveId } from '../src/statemachine.js';
import { toBase, reconcile } from '../src/accounting.js';

// A fresh engine over a throwaway data dir, with test-friendly config overrides.
function makeEngine(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const cfg = loadConfig({
    dataDir: dir,
    confirmationDepth: 3,
    blockBridgeAddr: 'block1bridgereserveaddress00000000000000',
    solblockMint: 'So1b1ockMintPubkey1111111111111111111111111',
    perTxCapBase: toBase('100'),
    dailyCapBase: toBase('1000'),
    ...overrides,
  });
  const store = new BridgeStore(dir);
  const engine = new BridgeEngine({ store, config: cfg });
  return { engine, store, dir, cfg };
}

const DEP_TX = 'a'.repeat(64); // BLOCK txid (hex)
const DEP_TX2 = 'b'.repeat(64);
const BURN_SIG = '5Xp9Qw' + 'Z'.repeat(80); // Solana-ish base58 signature (case-sensitive)

// Drive a deposit all the way to minting (verified).
async function depositToMinting(engine, { sourceTx = DEP_TX, amount = '10', dest = 'So1Recipient11111111111111111111111111111111' } = {}) {
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx, destination: dest });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx, confirmations: 1 });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx, confirmations: 3, amountBase: toBase(amount).toString() });
  return engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx });
}

test('valid deposit -> mint: completes and credits backing', async () => {
  const { engine, store } = makeEngine();
  await depositToMinting(engine, { amount: '10' });
  const t = await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'solmint111' });
  assert.equal(t.state, STATES.COMPLETED);

  const mint = store.get('mints', deriveId(DIRECTIONS.DEPOSIT, DEP_TX));
  assert.ok(mint, 'finalized mint row written');
  assert.equal(mint.blockInBase, toBase('10').toString());
  assert.equal(mint.solblockOutBase, toBase('10').toString()); // fee 0 default

  const snap = engine.snapshot();
  assert.equal(snap.backingBase, toBase('10').toString());
  assert.equal(snap.outstandingBase, toBase('10').toString());
  assert.equal(snap.reconcile.ok, true);
});

test('valid burn -> release: draws down backing, release row written', async () => {
  const { engine, store } = makeEngine();
  // seed custody with a 20-BLOCK deposit
  await depositToMinting(engine, { sourceTx: DEP_TX, amount: '20' });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });

  // now a redeem: burn 5 wBLOCK
  await engine.submitSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, destination: 'block1userpayout000000000000000000000000' });
  await engine.observeSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, confirmations: 3, amountBase: toBase('5').toString() });
  const v = await engine.verify({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  assert.equal(v.state, STATES.RELEASING);
  const t = await engine.settle({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, outputTx: 'blockpayout_txid' });
  assert.equal(t.state, STATES.COMPLETED);

  const rel = store.get('releases', deriveId(DIRECTIONS.REDEEM, BURN_SIG));
  assert.equal(rel.solblockInBase, toBase('5').toString());
  assert.equal(rel.blockOutBase, toBase('5').toString());

  const snap = engine.snapshot();
  assert.equal(snap.backingBase, toBase('15').toString()); // 20 - 5
  assert.equal(snap.outstandingBase, toBase('15').toString());
});

test('DUPLICATE deposit: same source tx -> no second mint', async () => {
  const { engine, store } = makeEngine();
  await depositToMinting(engine, { amount: '10' });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });

  // resubmit the SAME deposit tx + replay the whole flow
  const resubmit = await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  assert.equal(resubmit.state, STATES.COMPLETED); // mapped to the existing record
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3 });
  await engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm2-should-not-happen' });

  assert.equal(store.all('mints').length, 1, 'exactly one mint row');
  assert.equal(engine.snapshot().outstandingBase, toBase('10').toString());
});

test('DUPLICATE burn: same source sig -> no second release', async () => {
  const { engine, store } = makeEngine();
  await depositToMinting(engine, { sourceTx: DEP_TX, amount: '20' });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });

  await engine.submitSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, destination: 'block1payout00000000000000000000000000000' });
  await engine.observeSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, confirmations: 3, amountBase: toBase('5').toString() });
  await engine.verify({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  await engine.settle({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, outputTx: 'rel1' });

  // replay the burn
  await engine.submitSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  await engine.observeSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, confirmations: 3 });
  await engine.verify({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  await engine.settle({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, outputTx: 'rel2-should-not-happen' });

  assert.equal(store.all('releases').length, 1, 'exactly one release row');
  assert.equal(engine.snapshot().backingBase, toBase('15').toString());
});

test('replay of the SAME event is a no-op (observe/verify/settle idempotent)', async () => {
  const { engine, store } = makeEngine();
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  const a = await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('10').toString() });
  const b = await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('10').toString() });
  assert.equal(a.state, b.state);
  assert.equal(a.state, STATES.AWAITING_VERIFICATION);

  const v1 = await engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  const v2 = await engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  assert.equal(v1.state, STATES.MINTING);
  assert.equal(v2.state, STATES.MINTING);

  const s1 = await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });
  const s2 = await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });
  assert.equal(s1.state, STATES.COMPLETED);
  assert.equal(s2.state, STATES.COMPLETED);
  assert.equal(store.all('mints').length, 1);
});

test('mint-without-verified-backing rejected (not confirmed to depth)', async () => {
  const { engine } = makeEngine();
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 2, amountBase: toBase('10').toString() }); // < depth 3
  await assert.rejects(
    () => engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX }),
    /source not confirmed to depth/,
  );
  // and settle can't be forced from confirming_source
  await assert.rejects(
    () => engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'x' }),
    /cannot settle/,
  );
});

test('release-without-verified-burn rejected', async () => {
  const { engine } = makeEngine();
  await depositToMinting(engine, { sourceTx: DEP_TX, amount: '20' });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });
  await engine.submitSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  await engine.observeSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, confirmations: 1, amountBase: toBase('5').toString() }); // < depth
  await assert.rejects(
    () => engine.verify({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG }),
    /source not confirmed to depth/,
  );
});

test('insufficient reserves: redeem bigger than finalized custody -> refund_pending, no release', async () => {
  const { engine, store } = makeEngine();
  await depositToMinting(engine, { sourceTx: DEP_TX, amount: '5' });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });

  await engine.submitSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  await engine.observeSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, confirmations: 3, amountBase: toBase('10').toString() });
  const v = await engine.verify({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  assert.equal(v.state, STATES.REFUND_PENDING);
  assert.match(v.failReason, /insufficient reserves/);
  // no release ever written
  assert.equal(store.all('releases').length, 0);
  assert.equal(engine.snapshot().backingBase, toBase('5').toString());
});

test('pending deposit does NOT count as backing for a redeem', async () => {
  const { engine } = makeEngine();
  // a large deposit that is only confirming (NOT finalized/settled)
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('100').toString() });
  // custody from FINALIZED ledger is still 0
  assert.equal(engine.snapshot().backingBase, '0');
  // so a redeem cannot draw on it
  await engine.submitSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  await engine.observeSource({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG, confirmations: 3, amountBase: toBase('1').toString() });
  const v = await engine.verify({ direction: DIRECTIONS.REDEEM, sourceTx: BURN_SIG });
  assert.equal(v.state, STATES.REFUND_PENDING);
});

test('zero/negative verified amount -> failed', async () => {
  const { engine } = makeEngine();
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: '0' });
  const v = await engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, verifiedAmountBase: '0' });
  assert.equal(v.state, STATES.FAILED);
});

test('decimal/rounding exactness end-to-end (8dp)', async () => {
  const { engine, store } = makeEngine();
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('1.23456789').toString() });
  await engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });
  const mint = store.get('mints', deriveId(DIRECTIONS.DEPOSIT, DEP_TX));
  assert.equal(mint.solblockOutBase, '123456789');
  assert.equal(engine.snapshot().outstandingBase, '123456789');
});

test('fee is applied on output, custody exceeds issued by the fee', async () => {
  const { engine, store } = makeEngine({ feeBps: 100 }); // 1%
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('10').toString() });
  await engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });
  const snap = engine.snapshot();
  assert.equal(snap.backingBase, toBase('10').toString());
  assert.equal(snap.outstandingBase, toBase('9.9').toString()); // 10 - 1%
  assert.equal(snap.reconcile.surplus, '0.1');
  assert.equal(snap.reconcile.ok, true);
});

test('reconcile over the LIVE engine ledgers stays ok through a full cycle', async () => {
  const { engine, store } = makeEngine();
  await depositToMinting(engine, { sourceTx: DEP_TX, amount: '10' });
  await engine.settle({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, outputTx: 'm1' });
  const r = reconcile(store.all('mints'), store.all('releases'));
  assert.equal(r.ok, true);
  assert.equal(r.violations.length, 0);
});

test('paused blocks new issuance (submit + verify)', async () => {
  const { engine } = makeEngine({ paused: true });
  await assert.rejects(
    () => engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX }),
    /PAUSED/,
  );
  // even an in-flight transfer can't be verified while paused
  const { engine: e2 } = makeEngine();
  await e2.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await e2.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('1').toString() });
  e2.cfg.paused = true;
  await assert.rejects(() => e2.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX }), /PAUSED/);
});

test('per-tx cap enforced at verify', async () => {
  const { engine } = makeEngine({ perTxCapBase: toBase('5') });
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('6').toString() });
  await assert.rejects(
    () => engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX }),
    /per-tx cap/,
  );
});

test('daily cap enforced across transfers and counted once', async () => {
  const { engine } = makeEngine({ perTxCapBase: toBase('100'), dailyCapBase: toBase('12') });
  // first deposit of 10 -> ok, counts toward daily
  await depositToMinting(engine, { sourceTx: DEP_TX, amount: '10' });
  // verify again (replay) must NOT double-count
  await engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  // second deposit of 5 -> would make 15 > 12 -> rejected
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX2 });
  await engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX2, confirmations: 3, amountBase: toBase('5').toString() });
  await assert.rejects(
    () => engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX2 }),
    /daily cap/,
  );
});

test('illegal transition rejected (verify before any confirmation)', async () => {
  const { engine } = makeEngine();
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  // state is submitted, not awaiting_verification
  await assert.rejects(
    () => engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX }),
    /source not confirmed/,
  );
});

test('fail -> refund_pending -> refunded terminal path', async () => {
  const { engine } = makeEngine();
  await engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  await engine.fail({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, reason: 'bad recipient' });
  const rp = await engine.requestRefund({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  assert.equal(rp.state, STATES.REFUND_PENDING);
  const rf = await engine.completeRefund({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, refundTx: 'refund_tx' });
  assert.equal(rf.state, STATES.REFUNDED);
  // replay refund -> no-op
  const rf2 = await engine.completeRefund({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, refundTx: 'refund_tx' });
  assert.equal(rf2.state, STATES.REFUNDED);
});

test('deriveId is stable and direction-scoped', () => {
  assert.equal(deriveId(DIRECTIONS.DEPOSIT, DEP_TX), deriveId(DIRECTIONS.DEPOSIT, DEP_TX.toUpperCase()));
  assert.notEqual(deriveId(DIRECTIONS.DEPOSIT, DEP_TX), deriveId(DIRECTIONS.REDEEM, DEP_TX));
});
