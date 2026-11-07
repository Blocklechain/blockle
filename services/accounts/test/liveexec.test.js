// liveexec.test.js — the gated server-side EVM execute (Stage 2b). Proves the
// fund-critical gates fire BEFORE signing and the broadcast path is correct,
// all with a mock RPC (no network).

import assert from 'node:assert';
import { executeTrade } from '../src/liveexec.js';
import { evmAddressFromPrivate } from '../src/evmsign.js';

const privHex = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const addr = evmAddressFromPrivate(privHex);
let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };

// A mock RPC that records the broadcast and returns a fake txid.
function mockRpc() {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_sendRawTransaction') return '0x' + 'ab'.repeat(32);
    return null;
  };
  return { rpc, calls };
}

const del = (over = {}) => ({
  botId: 'b1', chain: 'base', chainId: 84532, // base sepolia (testnet)
  capUsd: 100, spentUsd: 0, address: addr, key: privHex, ...over,
});

await (async () => {
  // native testnet trade broadcasts
  {
    const { rpc, calls } = mockRpc();
    const r = await executeTrade({
      delegation: del(),
      action: { kind: 'native', to: '0x' + '35'.repeat(20), amountBase: '1000000000000000', notionalUsd: 3, feeUsd: 0.5, chainId: 84532 },
      rpc, env: {},
    });
    ok('returns a txid', /^0x[0-9a-f]{64}$/.test(r.txid));
    ok('from is the delegated address', r.from.toLowerCase() === addr.toLowerCase());
    ok('broadcast via eth_sendRawTransaction', calls.some((c) => c.method === 'eth_sendRawTransaction'));
    ok('raw is a type-2 tx', calls.find((c) => c.method === 'eth_sendRawTransaction').params[0].startsWith('0x02'));
  }

  // erc20 testnet trade
  {
    const { rpc } = mockRpc();
    const r = await executeTrade({
      delegation: del(),
      action: { kind: 'erc20', token: '0x' + '22'.repeat(20), to: '0x' + '35'.repeat(20), amountBase: '1000000', notionalUsd: 1, chainId: 84532 },
      rpc, env: {},
    });
    ok('erc20 trade broadcasts', /^0x[0-9a-f]{64}$/.test(r.txid));
  }

  // MAINNET refused by default
  await assert.rejects(
    () => executeTrade({ delegation: del({ chainId: 8453 }), action: { kind: 'native', to: '0x' + '35'.repeat(20), amountBase: '1', notionalUsd: 1, chainId: 8453 }, rpc: mockRpc().rpc, env: {} }),
    /mainnet trading is disabled/, 'mainnet refused without the flag');
  pass++;

  // MAINNET allowed with the operator flag
  {
    const { rpc } = mockRpc();
    const r = await executeTrade({
      delegation: del({ chainId: 8453 }),
      action: { kind: 'native', to: '0x' + '35'.repeat(20), amountBase: '1', notionalUsd: 1, chainId: 8453 },
      rpc, env: { BLOCKLE_BOT_MAINNET: '1' },
    });
    ok('mainnet allowed with BLOCKLE_BOT_MAINNET=1', /^0x[0-9a-f]{64}$/.test(r.txid));
  }

  // OVER CAP refused (notional + fee > remaining)
  await assert.rejects(
    () => executeTrade({ delegation: del({ capUsd: 10, spentUsd: 9 }), action: { kind: 'native', to: '0x' + '35'.repeat(20), amountBase: '1', notionalUsd: 5, chainId: 84532 }, rpc: mockRpc().rpc, env: {} }),
    /over cap/, 'over-cap refused');
  pass++;

  // SENDER GATE: key not controlling the delegation address → refused
  await assert.rejects(
    () => executeTrade({ delegation: del({ address: '0x' + '99'.repeat(20) }), action: { kind: 'native', to: '0x' + '35'.repeat(20), amountBase: '1', notionalUsd: 1, chainId: 84532 }, rpc: mockRpc().rpc, env: {} }),
    /does not control/, 'sender-gate mismatch refused');
  pass++;

  // unsupported chain refused
  await assert.rejects(
    () => executeTrade({ delegation: del({ chainId: 999999 }), action: { kind: 'native', to: '0x' + '35'.repeat(20), amountBase: '1', notionalUsd: 1, chainId: 999999 }, rpc: mockRpc().rpc, env: {} }),
    /unsupported chainId/, 'unknown chain refused');
  pass++;

  console.log(`liveexec.test.js: ${pass} checks passed`);
})();
