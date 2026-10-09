// venues.test.js — unit tests for the agent VENUE registry (venues.js).
//
//   node --test blockle-extension/venues.test.js
//   (also runs under plain `node blockle-extension/venues.test.js`)
//
// Covers:
//   • fee math — exact 0.05% (5 bps) skim, BigInt floor, edge cases
//   • treasury routing per chain — Solana EJiC…, EVM/Base 0x2eCC…, fail-closed
//   • constant-product AMM quote math + slippage minimum
//   • uniform quote()/buildSwap() across blockle / evmdex / jupiter
//   • buildSwap never auto-sends and always carries the fee transfer
//
// Treasury addresses are the REAL mainnet values from exchange/treasury.json so
// routing is asserted against the shipped config, not a fixture.

const { test } = require('node:test');
const assert = require('node:assert');

const V = require('./venues.js');

// mirror exchange/treasury.json (agentTradeFeeBps + mainnet address map)
const TREASURY = {
  agentTradeFeeBps: 5,
  mainnet: {
    solana: 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j',
    ethereum: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    base: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    btc: 'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm',
  },
};

// ---------------------------------------------------------------------------
// fee math (pure)
// ---------------------------------------------------------------------------

test('fee: 5 bps = 0.05% of the input amount (exact)', () => {
  assert.equal(V.feeAmount('1000000', 5), 500n);        // 1,000,000 * 0.0005
  assert.equal(V.feeAmount('20000', 5), 10n);           // 20,000 * 0.0005
  assert.equal(V.feeAmount('1000000000000000000', 5), 500000000000000n); // 1 ETH
});

test('fee: floors to whole base units (no rounding up)', () => {
  assert.equal(V.feeAmount('1999', 5), 0n);   // 0.9995 -> 0
  assert.equal(V.feeAmount('19999', 5), 9n);  // 9.9995 -> 9
  assert.equal(V.feeAmount('0', 5), 0n);
});

test('fee: default feeBps is 5 when treasury omits it', () => {
  const t = V.makeTreasury({ mainnet: { solana: 'EJiC' } });
  assert.equal(t.feeBps, 5);
});

// ---------------------------------------------------------------------------
// treasury routing per chain
// ---------------------------------------------------------------------------

test('treasury: routes EVM + Base fees to 0x2eCC…, Solana to EJiC…', () => {
  const t = V.makeTreasury(TREASURY);
  assert.equal(t.feeFor('ethereum', '1000000', 'USDC').treasury, '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
  assert.equal(t.feeFor('base', '1000000', 'USDC').treasury, '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
  assert.equal(t.feeFor('solana', '1000000000', 'SOL').treasury, 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j');
});

test('treasury: chain aliases + bitcoin->btc key resolve', () => {
  const t = V.makeTreasury(TREASURY);
  assert.equal(t.feeFor('eth', '1000000', 'ETH').treasury, '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
  assert.equal(t.feeFor('btc', '100000', 'BTC').treasury, 'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm');
  assert.equal(t.feeFor('bitcoin', '100000', 'BTC').treasury, 'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm');
});

test('treasury: fee descriptor carries bps, amount, chain, asset', () => {
  const t = V.makeTreasury(TREASURY);
  const f = t.feeFor('base', '2000000', 'USDC');
  assert.deepEqual(f, {
    bps: 5, chain: 'base', asset: 'USDC', amount: '1000',
    treasury: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
  });
});

test('treasury: FAIL-CLOSED — no address for a chain throws (never silent)', () => {
  const t = V.makeTreasury(TREASURY); // no 'block' address in the map
  assert.throws(() => t.feeFor('block', '1000000', 'BLOCK'), /no treasury address/);
});

test('feeTransfer: maps a fee descriptor to a buildSend request', () => {
  const t = V.makeTreasury(TREASURY);
  const tr = V.feeTransfer(t.feeFor('base', '2000000', 'USDC'));
  assert.deepEqual(tr, { chain: 'base', to: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c', amount: '1000', asset: 'USDC' });
});

// ---------------------------------------------------------------------------
// quote math (pure)
// ---------------------------------------------------------------------------

test('ammQuote: constant-product with 0.3% pool fee', () => {
  // reserves 1,000,000 in / 1,000,000 out, swap 1000 in:
  //   inAfterFee = 1000 * 9970/10000 = 997
  //   out = 1,000,000 * 997 / (1,000,000 + 997) = 996
  assert.equal(V.ammQuote('1000', '1000000', '1000000', 30), '996');
  assert.equal(V.ammQuote('0', '1000000', '1000000', 30), '0');
  assert.equal(V.ammQuote('1000', '0', '1000000', 30), '0');
});

test('applySlippage: slippage-adjusted minimum out', () => {
  assert.equal(V.applySlippage('1000', 0.01), '990');   // 1% off
  assert.equal(V.applySlippage('1000', 0.005), '995');  // 0.5% off
  assert.equal(V.applySlippage('1000', 0), '1000');     // none
});

// ---------------------------------------------------------------------------
// blockle (native) venue
// ---------------------------------------------------------------------------

test('blockle: quote uses wired exchange.quote and routes fee by input chain', async () => {
  const vx = V.create({
    treasury: TREASURY,
    blockle: {
      exchange: { quote: async (from, to, amt) => ({ amountOut: '4200', route: ['amm'] }) },
      // USDC input -> fee settles on base per default assetChain map
      assetChain: { USDC: 'base' },
    },
  });
  const q = await vx.get('blockle').quote('USDC', 'BLOCK', '1000000', { slippage: 0.01 });
  assert.equal(q.venue, 'blockle');
  assert.equal(q.amountOut, '4200');
  assert.equal(q.minOut, '4158'); // 4200 * 0.99
  assert.equal(q.chain, 'base');
  assert.equal(q.fee.amount, '500'); // 0.05% of 1,000,000
  assert.equal(q.fee.treasury, '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
});

test('blockle: buildSwap returns a swap INTENT, never a sent tx', async () => {
  const vx = V.create({
    treasury: TREASURY,
    blockle: { amm: { reserves: async () => ({ reserveIn: '1000000', reserveOut: '1000000', poolFeeBps: 30 }) }, assetChain: { USDC: 'base' } },
  });
  const built = await vx.get('blockle').buildSwap({ from: 'USDC', to: 'BLOCK', amount: '1000', slippage: 0.005 });
  assert.equal(built.autoSend, false);
  assert.equal(built.intent.kind, 'exchange-swap');
  assert.equal(built.amountOut, '996'); // from ammQuote
  assert.ok(built.feeTransfer && built.feeTransfer.to === '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
  assert.equal(built.fee.amount, '0'); // 0.05% of 1000 floors to 0
});

// ---------------------------------------------------------------------------
// evmdex (0x/1inch-style) venue
// ---------------------------------------------------------------------------

function fakeReq(map) {
  const calls = [];
  const request = async ({ method, url, body }) => { calls.push({ method, url, body }); return map(url, body, method); };
  return { request, calls };
}

test('evmdex: quote normalizes a 0x-style response and prices the fee on the EVM chain', async () => {
  const { request, calls } = fakeReq(() => ({
    buyAmount: '2500000', price: '2.5', sources: [{ name: 'Uniswap_V3', proportion: '1' }],
    to: '0xrouter', data: '0xdeadbeef', value: '0', allowanceTarget: '0xspender',
  }));
  const vx = V.create({ treasury: TREASURY, evmdex: { chains: ['ethereum', 'base'], baseUrl: 'https://api.example', request } });
  const q = await vx.get('evmdex').quote('0xUSDC', '0xWETH', '1000000', { chain: 'base', slippage: 0.01 });
  assert.equal(q.amountOut, '2500000');
  assert.equal(q.minOut, '2475000'); // 1% off
  assert.equal(q.chain, 'base');
  assert.equal(q.fee.amount, '500');
  assert.equal(q.fee.treasury, '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
  assert.match(calls[0].url, /sellAmount=1000000/);
  assert.match(calls[0].url, /sellToken=0xUSDC/);
});

test('evmdex: buildSwap returns a router-call tx {to,data,value}, unsigned, with fee', async () => {
  const { request } = fakeReq(() => ({ buyAmount: '990000', to: '0xRouter', data: '0xabcd', value: '0', allowanceTarget: '0xSpender' }));
  const vx = V.create({ treasury: TREASURY, evmdex: { chains: ['ethereum'], baseUrl: 'https://api.example', request } });
  const built = await vx.get('evmdex').buildSwap({ from: '0xUSDC', to: '0xWETH', amount: '1000000', chain: 'ethereum', slippage: 0.005 });
  assert.equal(built.autoSend, false);
  assert.deepEqual(built.tx, { chain: 'ethereum', to: '0xRouter', data: '0xabcd', value: '0' });
  assert.equal(built.allowanceTarget, '0xSpender');
  assert.equal(built.fee.treasury, '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
  assert.equal(built.feeTransfer.amount, '500');
});

test('evmdex: rejects an unsupported chain', async () => {
  const vx = V.create({ treasury: TREASURY, evmdex: { chains: ['ethereum'], baseUrl: 'https://x', request: async () => ({}) } });
  await assert.rejects(() => vx.get('evmdex').quote('a', 'b', '1', { chain: 'solana' }), /unsupported chain/);
});

// ---------------------------------------------------------------------------
// jupiter (Solana) venue
// ---------------------------------------------------------------------------

test('jupiter: quote normalizes outAmount + slippageBps and routes fee to the Solana treasury', async () => {
  const { request, calls } = fakeReq((url) => ({ outAmount: '98000000', routePlan: [{ swapInfo: {} }] }));
  const vx = V.create({ treasury: TREASURY, jupiter: { baseUrl: 'https://quote-api.jup.ag/v6', request } });
  const q = await vx.get('jupiter').quote('So111...', 'EPjF...', '100000000', { slippage: 0.01 });
  assert.equal(q.chain, 'solana');
  assert.equal(q.amountOut, '98000000');
  assert.equal(q.fee.amount, '50000'); // 0.05% of 100,000,000
  assert.equal(q.fee.treasury, 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j');
  assert.match(calls[0].url, /slippageBps=100/); // 0.01 -> 100 bps
  assert.match(calls[0].url, /amount=100000000/);
});

test('jupiter: buildSwap posts the quote + userPublicKey and returns the serialized tx, unsent', async () => {
  const { request, calls } = fakeReq((url, body, method) => {
    if (method === 'POST') { assert.equal(body.userPublicKey, 'MyWallet111'); return { swapTransaction: 'BASE64TX==' }; }
    return { outAmount: '98000000', routePlan: [] };
  });
  const vx = V.create({ treasury: TREASURY, jupiter: { baseUrl: 'https://quote-api.jup.ag/v6', request } });
  const built = await vx.get('jupiter').buildSwap({ from: 'So111', to: 'EPjF', amount: '100000000', account: { address: 'MyWallet111' }, slippage: 0.005 });
  assert.equal(built.autoSend, false);
  assert.equal(built.tx.swapTransaction, 'BASE64TX==');
  assert.equal(built.tx.chain, 'solana');
  assert.equal(built.feeTransfer.to, 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j');
  assert.equal(built.feeTransfer.amount, '50000');
  assert.equal(calls[1].method, 'POST'); // quote then swap
});

test('jupiter: buildSwap requires an account (userPublicKey)', async () => {
  const vx = V.create({ treasury: TREASURY, jupiter: { baseUrl: 'https://x', request: async () => ({ outAmount: '1' }) } });
  await assert.rejects(() => vx.get('jupiter').buildSwap({ from: 'a', to: 'b', amount: '1' }), /requires account/);
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('registry: lists venues, exposes feeBps, resolves by chain', () => {
  const vx = V.create({ treasury: TREASURY, evmdex: { chains: ['ethereum', 'base'], baseUrl: 'https://x' } });
  assert.equal(vx.feeBps, 5);
  assert.deepEqual(vx.ids().sort(), ['blockle', 'evmdex', 'jupiter']);
  assert.deepEqual(vx.forChain('base').map((v) => v.id).sort(), ['evmdex']);
  assert.deepEqual(vx.forChain('solana').map((v) => v.id), ['jupiter']);
  assert.deepEqual(vx.forChain('block').map((v) => v.id), ['blockle']);
});

test('registry: venues can be disabled', () => {
  const vx = V.create({ treasury: TREASURY, jupiter: { enabled: false }, evmdex: { enabled: false } });
  assert.deepEqual(vx.ids(), ['blockle']);
});
