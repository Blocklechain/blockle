// wiring-approve.test.js — the ERC-20 approve() leg of wiring.executeSwap is
// inspected on its OWN merits. The swap tool's prepare() inspects the ROUTER
// call; the SEPARATE approve sub-tx grants an allowance to a DEX-venue-supplied
// spender (externally influenced), so it MUST also be inspected: a denylisted /
// EOA / drainer spender HARD-BLOCKS the approve (fail closed). READ-ONLY — the
// suite never signs.
//
// Run: node --test wiring-approve.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const Wiring = require('./wiring.js');
const Security = require('./security.js');

const TOKEN = '0x' + 'a'.repeat(40);          // the ERC-20 being approved
const BAD_SPENDER = '0x000000000000000000000000000000000000dEaD';
const GOOD_SPENDER = '0x1111111111111111111111111111111111111111';

// An injected inspector that feeds the REAL approve calldata through the REAL
// WalletSecurity.inspectTransaction with a denylist — so the SPENDER encoded in
// the calldata (not just the `to` token) is decoded + denylist-checked, exactly
// as the live module `inspect` does in the browser.
function inspectorWithDenylist(list) {
  return async (chain, intent) =>
    Security.inspectTransaction(
      { chain, to: intent.to, data: intent.data, value: intent.value, asset: intent.asset },
      { config: { denylist: list } });
}

test('assertApproveSafe: a denylisted spender HARD-BLOCKS the approve (fail closed)', async () => {
  await assert.rejects(
    () => Wiring.assertApproveSafe('base', TOKEN, BAD_SPENDER, '1000', inspectorWithDenylist([BAD_SPENDER])),
    /blocked by security inspection/,
    'a denylisted approve spender must throw, not sign');
});

test('assertApproveSafe: it is the SPENDER (from calldata), not the token, that is denylisted', async () => {
  // token is clean; only the spender is on the denylist -> still blocks, proving
  // the approve calldata (spender) is decoded, not merely the `to` token address.
  await assert.rejects(
    () => Wiring.assertApproveSafe('base', TOKEN, BAD_SPENDER, '1000', inspectorWithDenylist([BAD_SPENDER])),
    /danger spender/);
});

test('assertApproveSafe: a clean spender is allowed through (no throw, not danger)', async () => {
  const ins = await Wiring.assertApproveSafe('base', TOKEN, GOOD_SPENDER, '1000', inspectorWithDenylist([BAD_SPENDER]));
  assert.ok(!ins || ins.severity !== 'danger', 'a clean spender returns a non-danger inspection');
});

test('assertApproveSafe: an EOA spender (no contract code) is a danger drainer pattern => blocks', async () => {
  // approval-to-eoa fires DANGER when the spender resolves to empty code. Inject a
  // getCode that returns empty for the spender (classic fake-router drainer).
  const inspector = async (chain, intent) =>
    Security.inspectTransaction(
      { chain, to: intent.to, data: intent.data, asset: intent.asset },
      { getCode: async () => '0x' }); // spender has NO code -> EOA
  await assert.rejects(
    () => Wiring.assertApproveSafe('base', TOKEN, GOOD_SPENDER, '1000', inspector),
    /blocked by security inspection/);
});

test('assertApproveSafe: a null/unavailable inspection does NOT block (best-effort, read-only)', async () => {
  const ins = await Wiring.assertApproveSafe('base', TOKEN, GOOD_SPENDER, '1000', async () => null);
  assert.equal(ins, null, 'suite unavailable => no fabricated danger, approve may proceed (router reverts if truly wrong)');
});

test('assertApproveSafe: missing token/spender is a no-op (nothing to inspect)', async () => {
  assert.equal(await Wiring.assertApproveSafe('base', null, GOOD_SPENDER, '1', inspectorWithDenylist([])), null);
  assert.equal(await Wiring.assertApproveSafe('base', TOKEN, null, '1', inspectorWithDenylist([])), null);
});
