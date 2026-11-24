// -----------------------------------------------------------------------------
// RATE LIMITER TESTS.
//
// Written because this file had none and a user reported "too quick to say too
// many attempts". The cause was that the failure count only ever reset on a
// SUCCESSFUL login: in a process that stays up for weeks it accumulated for
// the lifetime of the process, so someone who had mistyped ten times over a
// month sat permanently one failure away from a sixteen-minute lockout.
//
// What is pinned here is the balance that makes the limiter useful at all: a
// burst still gets exponential backoff, and a person spacing attempts out does
// not get punished for typos they made weeks ago.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter } from '../src/ratelimit.js';

const WINDOW = 15 * 60 * 1000;
const BASE = 30 * 1000;

function limiter(over = {}) {
  let t = 1_700_000_000_000;
  const rl = new RateLimiter(
    { windowMs: WINDOW, max: 8, lockoutBaseMs: BASE, lockThreshold: 4, ...over },
    () => t,
  );
  return { rl, advance: (ms) => { t += ms; }, at: () => t };
}

test('failures below the threshold do not lock', () => {
  const { rl } = limiter();
  for (let i = 0; i < 4; i++) rl.recordFailure('acct:a');
  assert.equal(rl.lockedFor('acct:a'), 0, 'four is tolerated');
  rl.recordFailure('acct:a');
  assert.ok(rl.lockedFor('acct:a') > 0, 'the fifth locks');
});

test('a BURST still gets exponential backoff', () => {
  // The property that makes this worth having. Nothing below weakens it.
  const { rl } = limiter();
  for (let i = 0; i < 5; i++) rl.recordFailure('acct:a');
  const first = rl.lockedFor('acct:a');
  assert.equal(first, BASE, 'first lockout is the base delay');

  rl.recordFailure('acct:a');
  assert.equal(rl.lockedFor('acct:a'), BASE * 2);
  rl.recordFailure('acct:a');
  assert.equal(rl.lockedFor('acct:a'), BASE * 4);
});

test('the backoff is capped at an hour', () => {
  const { rl } = limiter();
  for (let i = 0; i < 30; i++) rl.recordFailure('acct:a');
  assert.equal(rl.lockedFor('acct:a'), 60 * 60 * 1000);
});

test('THE COUNT DECAYS once the window has passed', () => {
  // The bug. Previously the count only reset on success, so these two typos
  // stayed on the record for the life of the process and the next three
  // mistakes — weeks later — tripped the lockout immediately.
  const { rl, advance } = limiter();
  rl.recordFailure('acct:a');
  rl.recordFailure('acct:a');

  advance(WINDOW + 1000);

  // Four more fresh failures must still be tolerated, because the earlier two
  // are stale.
  for (let i = 0; i < 4; i++) rl.recordFailure('acct:a');
  assert.equal(rl.lockedFor('acct:a'), 0, 'stale failures were forgotten');

  rl.recordFailure('acct:a');
  assert.equal(rl.lockedFor('acct:a'), BASE, 'and the backoff restarts at base');
});

test('failures INSIDE the window still accumulate', () => {
  // The decay must not become an escape hatch: an attacker pacing attempts
  // just under the window would otherwise never be locked.
  const { rl, advance } = limiter();
  for (let i = 0; i < 4; i++) { rl.recordFailure('acct:a'); advance(WINDOW - 1000); }
  rl.recordFailure('acct:a');
  assert.ok(rl.lockedFor('acct:a') > 0, 'still locks when paced within the window');
});

test('a success clears the record outright', () => {
  const { rl } = limiter();
  for (let i = 0; i < 6; i++) rl.recordFailure('acct:a');
  assert.ok(rl.lockedFor('acct:a') > 0);
  rl.reset('acct:a');
  assert.equal(rl.lockedFor('acct:a'), 0);
});

test('keys are independent', () => {
  const { rl } = limiter();
  for (let i = 0; i < 6; i++) rl.recordFailure('acct:a');
  assert.equal(rl.lockedFor('acct:b'), 0, 'one account cannot lock another');
});

test('the window cap on hits is separate from the lockout', () => {
  const { rl, advance } = limiter();
  for (let i = 0; i < 8; i++) assert.equal(rl.allow('ip:1'), true, 'hit ' + i);
  assert.equal(rl.allow('ip:1'), false, 'the ninth is over the cap');
  advance(WINDOW + 1000);
  assert.equal(rl.allow('ip:1'), true, 'and the window slides');
});
