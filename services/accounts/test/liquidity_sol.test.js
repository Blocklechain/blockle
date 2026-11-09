// liquidity_sol.test.js — the SOL leg: treasury key derivation matches
// liquidity.js, transfer message wire format, deposit verification by balance
// delta, and a gated ed25519 payout over a canned RPC. No network, test seed.
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  solTreasuryAddress, lamports, buildTransferMessage, decodeTransferMessage,
  verifySolDeposit, payoutSol, solRpcSender,
} from '../src/liquidity_sol.js';
import { settleSwap } from '../src/liquidity_relayer.js';

const require = createRequire(import.meta.url);
const sol = require('../src/vendor/solana.js');
const C = require('../src/vendor/crypto-core.js');

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };
const SEED = 'b'.repeat(64);
const ON = { LIQUIDITY_MAINNET: '1' };
const USER = C.base58encode(crypto.createHash('sha256').update('user').digest());
const BLOCKHASH = C.base58encode(crypto.createHash('sha256').update('bh').digest());

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
  const treasury = solTreasuryAddress(SEED);
  // Same derivation liquidity.js uses for the public custodial address.
  const expect = sol.addressFromSeed(crypto.createHash('sha256').update('sol:' + SEED).digest());
  ok('treasury SOL address matches liquidity.js derivation', treasury === expect && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(treasury));
  ok('lamports exact to 9 dp', lamports('1.5') === 1500000000n && lamports(0.000000001) === 1n && lamports('2') === 2000000000n);
  ok('scientific-notation JS numbers (real swap amounts) convert exactly', lamports(4.684828183926354e-06) === 4684n && lamports(1e-9) === 1n);

  // Wire format: header 1/0/1, keys [from,to,system], blockhash, one transfer ix.
  {
    const msg = buildTransferMessage({ from: treasury, to: USER, lamports: 123456789n, recentBlockhash: BLOCKHASH });
    const d = decodeTransferMessage(msg);
    ok('transfer message header + keys', msg[0] === 1 && msg[1] === 0 && msg[2] === 1 && d.keys.length === 3 && d.from === treasury && d.to === USER);
    ok('transfer message program + data', d.program === '11111111111111111111111111111111' && d.ix === 2 && d.lamports === 123456789n && d.blockhash === BLOCKHASH && d.nIx === 1);
    let selfRefused = false;
    try { buildTransferMessage({ from: treasury, to: treasury, lamports: 1n, recentBlockhash: BLOCKHASH }); } catch (e) { selfRefused = /self-transfer/.test(e.message); }
    ok('self-transfer refused', selfRefused);
  }

  // Deposit verification by balance delta on a confirmed, successful tx.
  {
    const SIG = C.base58encode(Buffer.alloc(64, 7));
    const mk = (pre, post, err = null, keys = [USER, treasury, '11111111111111111111111111111111']) => async (m) =>
      m === 'getTransaction' ? { meta: { err, preBalances: pre, postBalances: post }, transaction: { message: { accountKeys: keys } } } : null;
    const good = await verifySolDeposit({ rpc: mk([5e9, 1e9, 1], [4e9 - 5000, 2e9, 1]), signature: SIG, expectTo: treasury, minSol: 1 });
    ok('confirmed deposit raising the treasury balance verifies', good.ok && good.creditedLamports === '1000000000');
    const low = await verifySolDeposit({ rpc: mk([5e9, 1e9, 1], [4.5e9, 1.5e9, 1]), signature: SIG, expectTo: treasury, minSol: 1 });
    ok('under-amount deposit rejected', !low.ok && /too low/.test(low.reason));
    const failed = await verifySolDeposit({ rpc: mk([5e9, 1e9, 1], [5e9, 1e9, 1], { InstructionError: [0, 'Custom'] }), signature: SIG, expectTo: treasury, minSol: 1 });
    ok('failed on-chain tx rejected', !failed.ok && /failed/.test(failed.reason));
    const notyet = await verifySolDeposit({ rpc: async () => null, signature: SIG, expectTo: treasury, minSol: 1 });
    ok('unknown/unconfirmed signature → not confirmed yet', !notyet.ok && /not confirmed/.test(notyet.reason));
    const elsewhere = await verifySolDeposit({ rpc: mk([5e9, 1e9], [4e9, 2e9], null, [USER, 'SomeOtherAddr1111111111111111111111111111111']), signature: SIG, expectTo: treasury, minSol: 1 });
    ok('deposit to another address rejected', !elsewhere.ok && /not to treasury/.test(elsewhere.reason));
    const parsed = await verifySolDeposit({ rpc: mk([1e9, 1e9], [0, 2e9], null, [{ pubkey: USER }, { pubkey: treasury }]), signature: SIG, expectTo: treasury, minSol: 1 });
    ok('jsonParsed accountKeys shape accepted', parsed.ok);
    const bad = await verifySolDeposit({ rpc: mk([], []), signature: '0xnotbase58', expectTo: treasury, minSol: 1 });
    ok('non-signature id rejected before the lookup', !bad.ok && /bad deposit signature/.test(bad.reason));
  }

  // Payout: gate OFF refuses; gate ON builds + signs a transfer the treasury key
  // actually signed (ed25519 verify over the message) and broadcasts it.
  {
    let threw = false;
    try { await payoutSol({ seedHex: SEED, toAddress: USER, amountSol: 1, rpc: async () => null, env: {} }); } catch (e) { threw = /disabled/.test(e.message); }
    ok('SOL payout refused when gate OFF', threw);
    let sent = null;
    const rpc = async (m, p) => {
      if (m === 'getLatestBlockhash') return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } };
      if (m === 'getBalance') return { value: 5_000_000_000 };
      if (m === 'getMinimumBalanceForRentExemption') return 890880;
      if (m === 'sendTransaction') { sent = p; return 'SIG_OK'; }
      return null;
    };
    const r = await payoutSol({ seedHex: SEED, toAddress: USER, amountSol: '0.25', rpc, env: ON });
    ok('payout broadcasts and returns the rpc signature', r.txid === 'SIG_OK' && sent && sent[1].encoding === 'base64');
    const tx = Buffer.from(sent[0], 'base64');
    ok('one signature slot', tx[0] === 1);
    const sig = tx.subarray(1, 65), msg = tx.subarray(65);
    const d = decodeTransferMessage(msg);
    ok('signed message pays USER 0.25 SOL from the treasury', d.from === treasury && d.to === USER && d.lamports === 250000000n);
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(C.base58decode(treasury))]), format: 'der', type: 'spki' });
    ok('ed25519 signature verifies under the treasury key', crypto.verify(null, msg, pub, sig) === true);
  }

  // Underfunded / rent-trapped treasury fails BEFORE broadcasting, with a reason
  // that names the wallet to fund (the live case: 0.001 SOL in, 0.00093 out).
  {
    const mk = (balance) => async (m) => {
      if (m === 'getBalance') return { value: balance };
      if (m === 'getMinimumBalanceForRentExemption') return 890880;
      if (m === 'getLatestBlockhash') return { value: { blockhash: BLOCKHASH } };
      if (m === 'sendTransaction') throw new Error('must not broadcast');
      return null;
    };
    let under = '';
    try { await payoutSol({ seedHex: SEED, toAddress: USER, amountSol: 0.5, rpc: mk(1_000_000), env: ON }); } catch (e) { under = e.message; }
    ok('underfunded treasury refuses with a fund-me reason', /underfunded/.test(under) && under.includes(treasury));
    let rentMsg = '';
    try { await payoutSol({ seedHex: SEED, toAddress: USER, amountSol: '0.000926964', rpc: mk(1_000_000), env: ON }); } catch (e) { rentMsg = e.message; }
    ok('payout that would strand the wallet below rent-exempt minimum refuses', /rent-exempt/.test(rentMsg));
    const exact = await payoutSol({ seedHex: SEED, toAddress: USER, amountSol: '0.000995', rpc: Object.assign(async (m, p) => m === 'sendTransaction' ? 'EMPTIED' : mk(1_000_000)(m, p)), env: ON });
    ok('emptying the wallet completely (0 left) is allowed', exact.txid === 'EMPTIED');
  }

  // rpc sender unwraps result / throws on rpc error
  {
    const send = solRpcSender('http://x', async () => ({ json: async () => ({ result: 42 }) }));
    ok('rpc sender unwraps result', (await send('m', [])) === 42);
    const bad = solRpcSender('http://x', async () => ({ json: async () => ({ error: { message: 'boom' } }) }));
    let t = false; try { await bad('m', []); } catch (e) { t = /boom/.test(e.message); }
    ok('rpc sender throws on rpc error', t);
  }

  // End-to-end through the relayer: SOL -> BLOCK deposit verify (balance delta)
  // and BLOCK -> SOL payout, both via rpcFor('solana').
  {
    const store = fakeStore();
    const SIG = C.base58encode(Buffer.alloc(64, 9));
    const solRpc = async (m, p) => {
      if (m === 'getTransaction') return { meta: { err: null, preBalances: [3e9, 1e9], postBalances: [2e9 - 5000, 2e9] }, transaction: { message: { accountKeys: [USER, treasury] } } };
      if (m === 'getLatestBlockhash') return { value: { blockhash: BLOCKHASH } };
      if (m === 'sendTransaction') return 'PAYOUT_SIG';
      return null;
    };
    const rpcFor = (id) => (id === 'solana' ? solRpc : async () => null);
    // BLOCK -> SOL: the BLOCK deposit is verified by liquidity_block over the explorer (mocked fetch)
    await store.put('liquidity', 'swap:s1', { id: 's1', from: 'BLOCK', to: 'SOL', amountIn: 10, amountOut: 0.01, userAddress: USER, depositAddress: 'block1treasury', status: 'awaiting-deposit' });
    const fetchFn = async () => ({ ok: true, json: async () => ({ block_hash: 'ff'.repeat(32), tx: { block_height: 1, outputs: [{ address: 'block1treasury', amount: 1000000000 }] } }) });
    const out = await settleSwap('s1', 'ab'.repeat(32), { store, rpcFor, seedHex: SEED, env: ON, chainBase: 'https://x', fetchFn });
    ok('BLOCK→SOL settles with a SOL payout', out.status === 'settled' && out.payoutTxid === 'PAYOUT_SIG');
    // SOL -> BLOCK: the SOL deposit is verified over rpcFor('solana'); the BLOCK leg pays out (mocked wasm path needs a treasury wallet, so we stop at verification by making the BLOCK wallet absent → the payout error is surfaced, not a phantom settle)
    await store.put('liquidity', 'swap:s2', { id: 's2', from: 'SOL', to: 'BLOCK', amountIn: 1, amountOut: 100, userAddress: 'block1user', depositAddress: treasury, status: 'awaiting-deposit' });
    const reverted = [];
    const out2 = await settleSwap('s2', SIG, { store, rpcFor, seedHex: SEED, env: ON, chainBase: 'https://x', fetchFn, onRefund: async (r) => reverted.push(r.id) });
    ok('SOL deposit verified; a truly failed BLOCK payout REFUNDS the SOL to the depositor', out2.status === 'refunded' && out2.refundAddress === USER && out2.refundTxid === 'PAYOUT_SIG' && /not provisioned/.test(out2.lastPayoutError) && reverted[0] === 's2');
  }

  console.log(`liquidity_sol.test.js: ${pass} checks passed`);
})();
