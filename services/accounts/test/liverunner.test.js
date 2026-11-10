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

  // ---- SNIPER plan (Solana autopilot): pick from discovery + buy via Jupiter --
  {
    const solana = (await import('../src/vendor/solana.js')).default;
    const seed = Buffer.alloc(32, 7);
    const solAddr = solana.addressFromSeed(seed);
    const solPub = solana.publicKey(seed);
    // A minimal serialized tx with our pubkey as fee payer (passes the sender gate).
    const unsignedTx = Buffer.concat([
      Buffer.from([0x01]), Buffer.alloc(64, 0),               // 1 sig slot
      Buffer.from([0x01, 0x00, 0x00]), Buffer.from([0x01]),   // msg header + 1 key
      Buffer.from(solPub), Buffer.alloc(40, 0),
    ]).toString('base64');
    const jupFetch = async (url) => {
      const u = String(url);
      if (u.includes('/v6/quote')) return { json: async () => ({ outAmount: '999' }) };
      if (u.includes('/v6/swap')) return { json: async () => ({ swapTransaction: unsignedTx }) };
      throw new Error('unexpected ' + u);
    };
    const solRpc = async (m) => (m === 'sendTransaction' ? 'SoLtxid123' : null);
    const discover = async () => [
      { chain: 'solana', token: 'DUMPmint', safe: true, score: 90, metrics: { priceChange1hPct: -4 } }, // dumping → skip
      { chain: 'solana', token: 'HOTmint', safe: true, score: 82, metrics: { priceChange1hPct: 6 } },   // winner
      { chain: 'solana', token: 'LOWmint', safe: true, score: 30, metrics: { priceChange1hPct: 9 } },   // low score → skip
    ];
    let tS = 5_000_000;
    const d4 = makeBotDelegations({ now: () => tS });
    d4.put('u4', {
      botId: 'bsnipe', chain: 'solana', capUsd: 50, address: solAddr, key: seed.toString('hex'),
      plan: { type: 'sniper', perTradeUsd: 20, sniperMinScore: 0.6, slippageBps: 100, intervalMs: 1 },
    });
    const sr = await runOnce({
      delegations: d4, prices: async () => 1, rpcFor: () => mockRpc(),
      discover, solRpc, fetchFn: jupFetch, env: { BLOCKLE_BOT_MAINNET: '1' }, now: () => tS,
    });
    ok('sniper picked the highest-score non-dumping token + bought', sr[0].type === 'sniper' && sr[0].pick === 'HOTmint' && sr[0].txid === 'SoLtxid123');
    ok('sniper recorded spend (notional+fee)', d4.get('u4', 'bsnipe').spentUsd === 20.2);

    // Mainnet OFF → executeTrade refuses; the pass surfaces an error, no spend.
    let tOff = 6_000_000;
    const d5 = makeBotDelegations({ now: () => tOff });
    d5.put('u5', {
      botId: 'bsoff', chain: 'solana', capUsd: 50, address: solAddr, key: seed.toString('hex'),
      plan: { type: 'sniper', perTradeUsd: 20, intervalMs: 1 },
    });
    const sr2 = await runOnce({
      delegations: d5, prices: async () => 1, rpcFor: () => mockRpc(),
      discover, solRpc, fetchFn: jupFetch, env: {}, now: () => tOff,
    });
    ok('sniper refused when mainnet off (error, no spend)', sr2[0].error && /mainnet/.test(sr2[0].error) && d5.get('u5', 'bsoff').spentUsd === 0);
  }

  // ---- REAL fee collection: 5 bps accrues per trade; flushes ON-CHAIN to the
  // treasury once past the chain minimum; ledger credited only after broadcast.
  {
    let tF = 7_000_000;
    const dF = makeBotDelegations({ now: () => tF });
    dF.put('u6', {
      botId: 'bfee', chain: 'base', chainId: 84532, capUsd: 1000, address: addr, key: privHex,
      plan: { type: 'dca', to: '0x' + '35'.repeat(20), sym: 'ETH', perTradeUsd: 100, intervalMs: 1 },
    });
    const collected = [];
    const feeDeps = {
      delegations: dF, prices, rpcFor: () => mockRpc(), env: {}, now: () => tF,
      feeTreasury: { evm: '0x' + 'fe'.repeat(20), solana: 'T' },
      onFeeCollected: async (f) => collected.push(f),
    };
    // Below the $1 EVM minimum → accrues, nothing flushes, ledger untouched.
    let fr = await runOnce({ ...feeDeps, feeFlushMinUsd: { evm: 1.0 } });
    ok('fee accrues 5 bps of notional (no flush below min)',
      fr.filter((e) => e.type === 'fee').length === 0 && collected.length === 0);
    // Low minimum → the ACCUMULATED owed (2 trades × $0.05) flushes: a fee
    // event with a txid appears and the ledger callback fires with that USD.
    tF += 10;
    fr = await runOnce({ ...feeDeps, feeFlushMinUsd: { evm: 0.01 } });
    const feeEv = fr.find((e) => e.type === 'fee');
    ok('fee flushed on-chain once past the minimum (accrual carried over)',
      feeEv && /^0x[0-9a-f]{64}$/.test(feeEv.feeTxid) && Math.abs(feeEv.feeUsd - 0.1) < 1e-9);
    ok('ledger credited ONLY after broadcast, with the flushed USD',
      collected.length === 1 && collected[0].coin === 'ETH' && Math.abs(collected[0].feeUsd - 0.1) < 1e-9 && collected[0].coinUsd === 2000);
    // Next pass flushes ONLY the fresh $0.05 — proof the owed total reset.
    tF += 10;
    fr = await runOnce({ ...feeDeps, feeFlushMinUsd: { evm: 0.01 } });
    const feeEv2 = fr.find((e) => e.type === 'fee');
    ok('owed resets after a successful flush (next flush is the fresh 5 bps only)',
      feeEv2 && Math.abs(feeEv2.feeUsd - 0.05) < 1e-9 && collected.length === 2);
    // A failing fee broadcast DEFERS the owed amount: the TRADE (1st send)
    // succeeds, the FLUSH (2nd send) dies → no fee event, no ledger credit,
    // and the deferred amount rides along into the next successful flush.
    tF += 10;
    let sends = 0;
    const flakyRpc = () => async (method) => {
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_gasPrice') return '0x3b9aca00';
      if (method === 'eth_sendRawTransaction') {
        if (++sends > 1) throw new Error('rpc down');
        return '0x' + 'cd'.repeat(32);
      }
      return null;
    };
    fr = await runOnce({ ...feeDeps, rpcFor: () => flakyRpc(), feeFlushMinUsd: { evm: 0.01 } });
    ok('failed flush is fail-soft: trade recorded, no fee event, no ledger credit',
      fr.find((e) => e.txid) && !fr.find((e) => e.type === 'fee') && collected.length === 2);
    tF += 10;
    fr = await runOnce({ ...feeDeps, feeFlushMinUsd: { evm: 0.01 } });
    const feeEv3 = fr.find((e) => e.type === 'fee');
    ok('deferred fee rides into the next flush (0.05 deferred + 0.05 fresh)',
      feeEv3 && Math.abs(feeEv3.feeUsd - 0.1) < 1e-9 && collected.length === 3);
  }

  console.log(`liverunner.test.js: ${pass} checks passed`);
})();
