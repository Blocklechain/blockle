// drip.test.js — Blockle Drip: halving reward schedule, claim metering, and the
// gate/ledger ordering (ledger advances only after a real broadcast).

import assert from 'node:assert';
import { makeDrip, rewardFor, DRIP_SUPPLY } from '../src/drip.js';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };

function fakeStore() {
  const m = new Map();
  const k = (c, key) => c + ' ' + key;
  return {
    get: (c, key) => (m.has(k(c, key)) ? structuredClone(m.get(k(c, key))) : null),
    put: async (c, key, v) => { m.set(k(c, key), structuredClone(v)); },
  };
}

await (async () => {
  // ---- reward schedule: 1 → 0.5 at 25k → 0.25 at 37.5k → … converging on 50k.
  ok('opens at 1 BLOCK/day', rewardFor(0) === 1);
  ok('still 1 just under the first boundary', rewardFor(24999.999) === 1);
  ok('halves at 25,000', rewardFor(25000) === 0.5);
  ok('0.5 holds through the second tranche', rewardFor(37499.9) === 0.5);
  ok('quarters at 37,500', rewardFor(37500) === 0.25);
  ok('eighths at 43,750', rewardFor(43750) === 0.125);
  ok('sixteenths at 46,875', rewardFor(46875) === 0.0625);
  ok('reward hits 0 at/after full distribution', rewardFor(DRIP_SUPPLY) === 0);

  // ---- claim metering + gate ordering (no network: the mainnet gate refuses
  // BEFORE any broadcast, and the ledger must NOT advance on a refused claim).
  const store = fakeStore();
  let t = 1_000_000_000_000;
  const drip = makeDrip({ store, env: { LIQUIDITY_TREASURY_SEED: 'e'.repeat(64) }, chainBase: 'https://x', fetchFn: async () => ({ ok: false, json: async () => ({}) }), now: () => t });

  const addr = await drip.address();
  ok('drip wallet provisioned (block1…)', /^block1[0-9a-z]+$/.test(addr || ''));
  ok('drip wallet is SEPARATE from the liquidity treasury key', store.get('liquidity', 'dripWallet') && !store.get('liquidity', 'blockWallet'));

  const s0 = await drip.state('u1');
  ok('state: full pool, 1 BLOCK reward, claimable now', s0.remaining === DRIP_SUPPLY && s0.reward === 1 && s0.nextClaimAt === 0);
  ok('state: inactive while the mainnet gate is off', s0.active === false);

  let threw = null;
  try { await drip.claim({ uid: 'u1', toAddress: 'block1' + 'q'.repeat(38) }); } catch (e) { threw = e; }
  ok('claim refused while the gate is off (payout leg gated)', threw && /disabled/.test(threw.message));
  ok('ledger did NOT advance on the refused claim', (await drip.state('u1')).totalClaimed === 0);

  threw = null;
  try { await drip.claim({ uid: 'u1', toAddress: 'not-an-address' }); } catch (e) { threw = e; }
  ok('bad address refused', threw && /block1/.test(threw.message));
  threw = null;
  try { await drip.claim({ uid: null, toAddress: 'block1' + 'q'.repeat(38) }); } catch (e) { threw = e; }
  ok('anonymous claim refused', threw && /sign in/.test(threw.message));

  // Seed a successful claim record directly, then verify the 24h meters.
  await store.put('drip', 'state', {
    totalClaimed: 1, count: 1,
    claims: { u1: { lastAt: t, total: 1, address: 'block1' + 'q'.repeat(38) } },
    byAddress: { ['block1' + 'q'.repeat(38)]: t },
  });
  threw = null;
  try { await drip.claim({ uid: 'u1', toAddress: 'block1' + 'r'.repeat(38) }); } catch (e) { threw = e; }
  ok('same account within 24h refused (with nextClaimAt)', threw && /already claimed/.test(threw.message) && threw.nextClaimAt === t + 86400000);
  threw = null;
  try { await drip.claim({ uid: 'u2', toAddress: 'block1' + 'q'.repeat(38) }); } catch (e) { threw = e; }
  ok('same ADDRESS within 24h refused even from another account', threw && /address already claimed/.test(threw.message));

  t += 86400001; // a day passes — the account meter opens again (gate still blocks the send itself)
  threw = null;
  try { await drip.claim({ uid: 'u1', toAddress: 'block1' + 'q'.repeat(38) }); } catch (e) { threw = e; }
  ok('after 24h the meter opens (refusal is now the gate, not the meter)', threw && /disabled/.test(threw.message));

  const s1 = await drip.state('u1');
  ok('state reports your running total + claim count', s1.yourTotal === 1 && s1.claims === 1 && s1.totalClaimed === 1);

  console.log(`drip.test.js: ${pass} checks passed`);
})();
