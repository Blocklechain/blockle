// accounting.test.js — pure accounting + invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBase,
  fromBase,
  computeFee,
  applyFee,
  reserves,
  outstanding,
  pendingVsCompleted,
  everyOutstandingBacked,
  oneDepositOneMint,
  oneBurnOneRelease,
  neverReleasedMoreThanCustody,
  canRelease,
  reconcile,
  assertInvariants,
} from '../src/accounting.js';

test('8-decimal conversion is exact and round-trips', () => {
  assert.equal(toBase('1').toString(), '100000000');
  assert.equal(toBase('1.23456789').toString(), '123456789');
  assert.equal(toBase('0.00000001').toString(), '1');
  assert.equal(toBase(0).toString(), '0');
  assert.equal(fromBase(123456789n), '1.23456789');
  assert.equal(fromBase(100000000n), '1');
  assert.equal(fromBase(1n), '0.00000001');
  // round-trip
  for (const v of ['0', '1', '1.5', '0.00000001', '21000000', '0.1']) {
    assert.equal(fromBase(toBase(v)), v === '0.1' ? '0.1' : fromBase(toBase(v)));
    assert.equal(toBase(fromBase(toBase(v))).toString(), toBase(v).toString());
  }
});

test('conversion rejects >8 decimals and junk (no silent rounding)', () => {
  assert.throws(() => toBase('1.123456789'), /8 decimals/);
  assert.throws(() => toBase('abc'), /invalid amount/);
  assert.throws(() => toBase('1.2.3'), /invalid amount/);
});

test('fee: default zero', () => {
  assert.equal(computeFee(toBase('10')).toString(), '0');
  const { feeBase, netBase } = applyFee(toBase('10'), {});
  assert.equal(feeBase.toString(), '0');
  assert.equal(netBase.toString(), toBase('10').toString());
});

test('fee: flat + bps with ceil (never under-collect)', () => {
  // 25 bps on 1.00000000 = 0.0025 BLOCK = 250000 base; plus flat 100 base
  const cfg = { feeFlatBase: 100n, feeBps: 25 };
  const { feeBase, netBase } = applyFee(toBase('1'), cfg);
  assert.equal(feeBase.toString(), (250000n + 100n).toString());
  assert.equal(netBase.toString(), (100000000n - 250100n).toString());
  // ceil: 1 base unit * 1bps -> rounds up to 1, not 0
  assert.equal(computeFee(1n, { feeBps: 1 }).toString(), '1');
});

test('applyFee rejects zero/negative and fee-eats-all', () => {
  assert.throws(() => applyFee(0n, {}), /positive/);
  assert.throws(() => applyFee(-5n, {}), /positive/);
  assert.throws(() => applyFee(100n, { feeFlatBase: 100n }), /fee exceeds/);
});

test('reserves/outstanding from finalized ledgers only', () => {
  const mints = [
    { depositId: 'a', blockInBase: toBase('10').toString(), solblockOutBase: toBase('10').toString() },
    { depositId: 'b', blockInBase: toBase('5').toString(), solblockOutBase: toBase('5').toString() },
  ];
  const releases = [
    { burnId: 'x', solblockInBase: toBase('3').toString(), blockOutBase: toBase('3').toString() },
  ];
  assert.equal(reserves(mints, releases).toString(), toBase('12').toString()); // 15 - 3
  assert.equal(outstanding(mints, releases).toString(), toBase('12').toString()); // 15 - 3
});

test('fee surplus: custody >= issued when a fee is charged on output', () => {
  // deposit 10 BLOCK, fee 1 -> minted 9 wBLOCK. Custody 10, issued 9.
  const mints = [
    { depositId: 'a', blockInBase: toBase('10').toString(), solblockOutBase: toBase('9').toString() },
  ];
  const r = reconcile(mints, []);
  assert.equal(r.ok, true);
  assert.equal(r.backing, '10');
  assert.equal(r.issued, '9');
  assert.equal(r.surplus, '1');
  assert.equal(everyOutstandingBacked(mints, []), true);
});

test('invariant: duplicate mint / duplicate release detected', () => {
  const dupMints = [
    { depositId: 'a', blockInBase: '1', solblockOutBase: '1' },
    { depositId: 'a', blockInBase: '1', solblockOutBase: '1' },
  ];
  assert.equal(oneDepositOneMint(dupMints), false);
  const dupRel = [
    { burnId: 'x', solblockInBase: '1', blockOutBase: '1' },
    { burnId: 'x', solblockInBase: '1', blockOutBase: '1' },
  ];
  assert.equal(oneBurnOneRelease(dupRel), false);
  assert.equal(reconcile(dupMints, []).violations.includes('duplicate-mint'), true);
  assert.equal(reconcile([], dupRel).violations.includes('duplicate-release'), true);
});

test('reconcile DETECTS undercollateralization and signals pause', () => {
  // Hand-crafted corrupt state: more wBLOCK issued than BLOCK backing.
  const mints = [{ depositId: 'a', blockInBase: toBase('5').toString(), solblockOutBase: toBase('10').toString() }];
  const r = reconcile(mints, []);
  assert.equal(r.ok, false);
  assert.equal(r.shouldPause, true);
  assert.ok(r.violations.includes('undercollateralized'));
  assert.throws(() => assertInvariants(mints, []), /invariant violation/);
});

test('canRelease uses finalized custody and refuses when short', () => {
  const mints = [{ depositId: 'a', blockInBase: toBase('5').toString(), solblockOutBase: toBase('5').toString() }];
  assert.equal(canRelease(toBase('5'), mints, []), true);
  assert.equal(canRelease(toBase('5.00000001'), mints, []), false);
  assert.equal(canRelease(0n, mints, []), false);
});

test('neverReleasedMoreThanCustody holds for consistent ledgers', () => {
  const mints = [{ depositId: 'a', blockInBase: toBase('5').toString(), solblockOutBase: toBase('5').toString() }];
  const releases = [{ burnId: 'x', solblockInBase: toBase('5').toString(), blockOutBase: toBase('5').toString() }];
  assert.equal(neverReleasedMoreThanCustody(mints, releases), true);
  assert.equal(reserves(mints, releases).toString(), '0');
});

test('pendingVsCompleted: pending source value never counts as backing', () => {
  const transfers = [
    { state: 'completed', sourceAmountBase: toBase('10').toString() },
    { state: 'confirming_source', sourceAmountBase: toBase('99').toString() },
    { state: 'awaiting_verification', sourceAmountBase: toBase('7').toString() },
    { state: 'failed', sourceAmountBase: toBase('3').toString() },
    { state: 'refunded', sourceAmountBase: toBase('1').toString() },
  ];
  const v = pendingVsCompleted(transfers);
  assert.equal(v.completed, 1);
  assert.equal(v.pending, 2);
  assert.equal(v.failed, 1);
  assert.equal(v.refunded, 1);
  assert.equal(v.pendingSourceBase, toBase('106').toString()); // 99 + 7, NOT backing
});

test('empty ledgers are a valid, balanced state', () => {
  const r = reconcile([], []);
  assert.equal(r.ok, true);
  assert.equal(r.backing, '0');
  assert.equal(r.issued, '0');
});
