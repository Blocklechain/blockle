// liverunner.test.js — the server-side live loop (Stage 2c), with mock
// delegations/prices/rpc (no network, no real keys). Verifies: a due DCA plan
// executes + records spend + advances lastAt; not-due is skipped; the cap stops
// it; a dead price skips cleanly.

import assert from 'node:assert';
import { runOnce } from '../src/liverunner.js';
import { makeBotDelegations } from '../src/botdelegate.js';
import { evmAddressFromPrivate } from '../src/evmsign.js';

const privHex = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const addr = evmAddressFromPrivate(privHex);
let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };

const mockRpc = () => async (method) => {
  if (method === 'eth_getTransactionCount') return '0x0';
  if (method === 'eth_gasPrice') return '0x3b9aca00';
  if (method === 'eth_sendRawTransaction') return '0x' + 'cd'.repeat(32);
  return null;
};
const prices = async () => 2000; // $2000/ETH

await (async () => {
  let t = 1_000_000;
  const dels = makeBotDelegations({ now: () => t });
  dels.put('u1', {
    botId: 'b1', chain: 'base', chainId: 84532, capUsd: 50, address: addr, key: privHex,
    plan: { type: 'dca', to: '0x' + '35'.repeat(20), sym: 'ETH', perTradeUsd: 20, intervalMs: 60_000 },
  });

  // due → executes
  let r = await runOnce({ delegations: dels, prices, rpcFor: () => mockRpc(), env: {}, now: () => t });
  ok('executed once', r.length === 1 && r[0].txid && /^0x[0-9a-f]{64}$/.test(r[0].txid));
  ok('recorded spend (notional + fee)', dels.get('u1', 'b1').spentUsd === 20.2);

  // immediately again → not due (interval not elapsed)
  r = await runOnce({ delegations: dels, prices, rpcFor: () => mockRpc(), env: {}, now: () => t });
  ok('skipped: not due', r[0].skipped === 'not-due');
  ok('spend unchanged', dels.get('u1', 'b1').spentUsd === 20.2);

  // advance past the interval repeatedly → spends toward the cap then stops,
  // and NEVER exceeds it (notional + fee always fits remaining).
  for (let i = 0; i < 5; i++) {
    t += 70_000;
    await runOnce({ delegations: dels, prices, rpcFor: () => mockRpc(), env: {}, now: () => t });
  }
  ok('never exceeds the cap', dels.get('u1', 'b1').spentUsd <= 50 + 1e-9);

  t += 70_000;
  r = await runOnce({ delegations: dels, prices, rpcFor: () => mockRpc(), env: {}, now: () => t });
  ok('cap exhausted → skip', r[0].skipped === 'cap-exhausted');

  // dead price → clean skip
  const dels2 = makeBotDelegations({ now: () => t });
  dels2.put('u2', { botId: 'b2', chain: 'base', chainId: 84532, capUsd: 50, address: addr, key: privHex,
    plan: { type: 'dca', to: '0x' + '35'.repeat(20), sym: 'ETH', perTradeUsd: 20, intervalMs: 1 } });
  r = await runOnce({ delegations: dels2, prices: async () => null, rpcFor: () => mockRpc(), env: {}, now: () => t });
  ok('no price → skip (no fabricated trade)', r[0].skipped === 'no-price');

  // SWAP plan: native → token via the V3 router (prices both legs).
  {
    let t2 = 5_000_000;
    const d3 = makeBotDelegations({ now: () => t2 });
    d3.put('u3', {
      botId: 'bs', chain: 'base', chainId: 84532, capUsd: 50, address: addr, key: privHex,
      plan: {
        type: 'swap', tokenOut: '0x' + '77'.repeat(20), tokenOutSym: 'USDC', tokenOutDecimals: 6,
        feeTier: 3000, slippageBps: 100, perTradeUsd: 10, intervalMs: 1,
      },
    });
    // ETH $2000, USDC $1.
    const dualPrice = async (sym) => (sym === 'USDC' ? 1 : 2000);
    const rr = await runOnce({ delegations: d3, prices: dualPrice, rpcFor: () => mockRpc(), env: {}, now: () => t2 });
    ok('swap plan executed', rr[0].type === 'swap' && /^0x[0-9a-f]{64}$/.test(rr[0].txid));
    ok('swap recorded spend (notional+fee)', d3.get('u3', 'bs').spentUsd === 10.2);
  }

  console.log(`liverunner.test.js: ${pass} checks passed`);
})();
