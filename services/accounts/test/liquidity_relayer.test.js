// liquidity_relayer.test.js — the on-chain payout relayer, fully gated + mocked.
// No real keys, no network: a test seed + a canned RPC. Proves the gate refuses
// when off, the payout signs + broadcasts, deposit verification is strict, and the
// settle state machine reaches 'settled' only after a valid deposit.

import assert from 'node:assert';
import {
  treasuryKeys, payoutEvm, verifyDepositEvm, settleSwap, liquidityMainnet, COIN_TOKEN,
} from '../src/liquidity_relayer.js';

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };
const SEED = 'a'.repeat(64);
const ON = { LIQUIDITY_MAINNET: '1' };

function fakeStore() {
  const m = new Map();
  const k = (c, key) => c + ' ' + key;
  return {
    get: (c, key) => (m.has(k(c, key)) ? structuredClone(m.get(k(c, key))) : null),
    put: async (c, key, v) => { m.set(k(c, key), structuredClone(v)); },
    entries: (c) => [...m.entries()].filter(([kk]) => kk.startsWith(c + ' ')).map(([kk, v]) => [kk.slice(c.length + 1), structuredClone(v)]),
  };
}

await (async () => {
  const keys = treasuryKeys(SEED);
  ok('treasury EVM address derives', /^0x[0-9a-fA-F]{40}$/.test(keys.evmAddress));
  ok('gate reads env', liquidityMainnet(ON) === true && liquidityMainnet({}) === false);

  // Payout REFUSED when the gate is off (no funds ever move without the switch).
  {
    let threw = false;
    try { await payoutEvm({ coin: 'USDC', toAddress: '0x' + '11'.repeat(20), amount: 5, rpc: async () => '0x0', seedHex: SEED, env: {} }); }
    catch (e) { threw = /disabled/.test(e.message); }
    ok('payout refused when gate OFF', threw);
  }

  // Payout signs + broadcasts when ON — native (ETH) and ERC-20 (USDC).
  {
    const rpc = async (m) => {
      if (m === 'eth_getTransactionCount') return '0x0';
      if (m === 'eth_gasPrice') return '0x3b9aca00';
      if (m === 'eth_sendRawTransaction') return '0x' + 'cd'.repeat(32);
      return null;
    };
    const nat = await payoutEvm({ coin: 'ETH', toAddress: '0x' + '22'.repeat(20), amount: 0.01, rpc, seedHex: SEED, env: ON });
    ok('native payout broadcasts', /^0x[0-9a-f]{64}$/.test(nat.txid) && nat.chainId === 1);
    const erc = await payoutEvm({ coin: 'USDC', toAddress: '0x' + '22'.repeat(20), amount: 25, rpc, seedHex: SEED, env: ON });
    ok('erc20 payout broadcasts', /^0x[0-9a-f]{64}$/.test(erc.txid) && erc.amountBase === '25000000');
  }

  // Deposit verification is strict: native to-treasury + amount; reject wrong dest.
  {
    const treasury = keys.evmAddress;
    const rpcOk = async (m) => (m === 'eth_getTransactionReceipt' ? { status: '0x1' }
      : m === 'eth_getTransactionByHash' ? { to: treasury, value: '0x' + (10n ** 18n).toString(16) } : null);
    const good = await verifyDepositEvm({ rpc: rpcOk, txid: '0xdead', expectTo: treasury, coin: 'ETH', minAmount: 0.5 });
    ok('valid native deposit verifies', good.ok);
    const lowRpc = async (m) => (m === 'eth_getTransactionReceipt' ? { status: '0x1' }
      : { to: treasury, value: '0x1' });
    const low = await verifyDepositEvm({ rpc: lowRpc, txid: '0xd', expectTo: treasury, coin: 'ETH', minAmount: 0.5 });
    ok('under-amount deposit rejected', !low.ok);
    const wrongRpc = async (m) => (m === 'eth_getTransactionReceipt' ? { status: '0x1' }
      : { to: '0x' + '99'.repeat(20), value: '0x' + (10n ** 18n).toString(16) });
    const wrong = await verifyDepositEvm({ rpc: wrongRpc, txid: '0xd', expectTo: treasury, coin: 'ETH', minAmount: 0.5 });
    ok('deposit to wrong address rejected', !wrong.ok);
    const revert = await verifyDepositEvm({ rpc: async () => ({ status: '0x0' }), txid: '0xd', expectTo: treasury, coin: 'ETH', minAmount: 0.5 });
    ok('reverted deposit rejected', !revert.ok);
  }

  // settleSwap: gate off throws; a valid ETH deposit → USDC payout → 'settled'.
  {
    const store = fakeStore();
    const treasury = keys.evmAddress;
    const rec = { id: 'sw1', from: 'ETH', to: 'USDC', amountIn: 1, amountOut: 2500, userAddress: '0x' + '33'.repeat(20), depositAddress: treasury, status: 'awaiting-deposit' };
    await store.put('liquidity', 'swap:sw1', rec);

    let threw = false;
    try { await settleSwap('sw1', '0xdep', { store, rpcFor: () => async () => null, seedHex: SEED, env: {} }); }
    catch (e) { threw = /disabled/.test(e.message); }
    ok('settle refused when gate OFF', threw);

    const rpcFor = () => async (m) => {
      if (m === 'eth_getTransactionReceipt') return { status: '0x1' };
      if (m === 'eth_getTransactionByHash') return { to: treasury, value: '0x' + (10n ** 18n).toString(16) }; // 1 ETH deposit
      if (m === 'eth_getTransactionCount') return '0x0';
      if (m === 'eth_gasPrice') return '0x3b9aca00';
      if (m === 'eth_sendRawTransaction') return '0x' + 'ab'.repeat(32);
      return null;
    };
    const out = await settleSwap('sw1', '0xdep', { store, rpcFor, seedHex: SEED, env: ON, now: () => 7 });
    ok('settled after valid deposit', out.status === 'settled' && /^0x[0-9a-f]{64}$/.test(out.payoutTxid) && out.depositTxid === '0xdep');
    // Idempotent: re-settling returns the settled record unchanged.
    const again = await settleSwap('sw1', '0xdep', { store, rpcFor, seedHex: SEED, env: ON });
    ok('settle is idempotent', again.status === 'settled' && again.payoutTxid === out.payoutTxid);
  }

  ok('USDC is an ERC-20 payout target', !!COIN_TOKEN.USDC);
  // A payout that THROWS (e.g. broadcast rejected) leaves the record retryable
  // ('awaiting-deposit' + reason), never a phantom 'settled'; and ONE deposit
  // txid can settle only ONE swap (replay across records is refused).
  {
    const store = fakeStore();
    const treasury = keys.evmAddress;
    const user = '0x' + '33'.repeat(20);
    const depositOk = async (m) => (m === 'eth_getTransactionReceipt' ? { status: '0x1' }
      : m === 'eth_getTransactionByHash' ? { to: treasury, value: '0x' + (10n ** 18n).toString(16) }
      : m === 'eth_getTransactionCount' ? '0x0' : m === 'eth_gasPrice' ? '0x3b9aca00'
      : m === 'eth_sendRawTransaction' ? (() => { throw new Error('nonce too low'); })() : null);
    await store.put('liquidity', 'swap:p1', { id: 'p1', from: 'ETH', to: 'ETH', amountIn: 0.5, amountOut: 0.4, userAddress: user, depositAddress: treasury, status: 'awaiting-deposit' });
    let threw = false;
    try { await settleSwap('p1', '0x' + 'ee'.repeat(32), { store, rpcFor: () => depositOk, seedHex: SEED, env: ON }); } catch (e) { threw = /nonce too low/.test(e.message); }
    const after = store.get('liquidity', 'swap:p1');
    ok('payout failure rethrows and leaves the swap retryable', threw && after.status === 'awaiting-deposit' && /payout failed/.test(after.reason) && after.payoutAttempts === 1);
    // now a working payout settles it…
    const rpcGood = async (m) => (m === 'eth_sendRawTransaction' ? '0x' + 'ab'.repeat(32) : depositOk(m));
    const done = await settleSwap('p1', '0x' + 'ee'.repeat(32), { store, rpcFor: () => rpcGood, seedHex: SEED, env: ON });
    ok('retry settles once the payout succeeds', done.status === 'settled' && done.depositTxid === '0x' + 'ee'.repeat(32));
    // …and the SAME deposit txid cannot settle a second swap.
    await store.put('liquidity', 'swap:p2', { id: 'p2', from: 'ETH', to: 'ETH', amountIn: 0.5, amountOut: 0.4, userAddress: user, depositAddress: treasury, status: 'awaiting-deposit' });
    const replay = await settleSwap('p2', '0x' + 'EE'.repeat(32), { store, rpcFor: () => rpcGood, seedHex: SEED, env: ON });
    ok('deposit txid replay across swaps is refused', replay.status === 'failed' && /already used by swap p1/.test(replay.reason));
  }

  console.log(`liquidity_relayer.test.js: ${pass} checks passed`);
})();
