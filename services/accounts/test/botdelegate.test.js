// botdelegate.test.js — the ephemeral server-side bot-delegation registry
// (Stage 1). Verifies the security guarantees: per-active-chain scope, revoke
// (one + all), expiry/sweep, the per-user cap, and that key material is never
// accepted or exposed.

import { makeBotDelegations } from '../src/botdelegate.js';
import assert from 'node:assert';

let t = 1000;
const now = () => t;
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; };

{
  const d = makeBotDelegations({ ttlMs: 10_000, now });

  // put + list (metadata only; no key field ever)
  const v = d.put('u1', { botId: 'b1', chain: 'ethereum', capUsd: 100, address: '0xabc' });
  ok('put returns a view', v.botId === 'b1' && v.chain === 'ethereum' && v.capUsd === 100);
  ok('view carries NO key material', !('key' in v) && !('keyBlob' in v) && !('privateKey' in v));
  ok('list shows the active delegation', d.list('u1').length === 1);

  // per-active-chain: a second bot on another chain is its own entry
  d.put('u1', { botId: 'b2', chain: 'solana', capUsd: 50 });
  ok('two chains → two delegations', d.list('u1').length === 2);
  ok('list items expose no key', d.list('u1').every((x) => !('key' in x)));

  // bad input rejected (never a zero/negative cap, never missing chain)
  assert.throws(() => d.put('u1', { botId: 'bx', chain: 'ethereum', capUsd: 0 }), 'cap>0 enforced');
  assert.throws(() => d.put('u1', { botId: 'bx', capUsd: 10 }), 'chain required');
  pass += 2;

  // revoke one (bot stopped)
  ok('revoke one returns true', d.revoke('u1', 'b1') === true);
  ok('revoke removed only that bot', d.list('u1').length === 1 && d.list('u1')[0].botId === 'b2');

  // revoke all (Kill-all)
  d.put('u1', { botId: 'b3', chain: 'base', capUsd: 20 });
  ok('revokeAll removes every delegation', d.revokeAll('u1') === 2 && d.list('u1').length === 0);

  // expiry / sweep: a delegation never outlives its TTL
  d.put('u2', { botId: 'bz', chain: 'tron', capUsd: 5, ttl: 5_000 });
  ok('present before expiry', d.get('u2', 'bz') !== null);
  t += 6_000;
  ok('get() past expiry is null (lazy sweep)', d.get('u2', 'bz') === null);
  ok('list() past expiry is empty', d.list('u2').length === 0);

  // ttl is clamped to the hard ceiling
  const v2 = d.put('u3', { botId: 'bc', chain: 'ethereum', capUsd: 1, ttl: 999_999_999 });
  ok('ttl clamped to ceiling', v2.expiresAt - t <= 10_000);

  // per-user cap
  const d2 = makeBotDelegations({ now });
  for (let i = 0; i < 25; i++) d2.put('cap', { botId: 'c' + i, chain: 'ethereum', capUsd: 1 });
  assert.throws(() => d2.put('cap', { botId: 'c99', chain: 'ethereum', capUsd: 1 }), 'cap limit');
  pass++;
  ok('refreshing an existing bot within cap is allowed', !!d2.put('cap', { botId: 'c0', chain: 'ethereum', capUsd: 2 }));
}

console.log(`botdelegate.test.js: ${pass} checks passed`);
