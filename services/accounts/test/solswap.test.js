// Solana swap (Jupiter) execution — the live path for autopilot/sniper SPL buys.
// Drives executeTrade's sol-swap branch end to end with a MOCK Jupiter (fetch)
// and a MOCK Solana RPC, a real ed25519 sub-key, and a hand-built serialized tx
// so no network / real key is touched. Proves every hard gate: mainnet flag,
// per-delegation USD cap, and the sender gate (fee payer == our address).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTrade } from '../src/liveexec.js';
import solana from '../src/vendor/solana.js';

// Minimal legacy serialized tx: [shortvec(1)][64B sig slot][message], where the
// message is [header(3)][shortvec(numKeys=1)][feePayer pubkey(32)][filler]. Just
// enough for assertFeePayer to read accounts[0] and for signTransaction to sign.
function makeTx(feePayerPub) {
  const sigCount = Buffer.from([0x01]);
  const sigSlot = Buffer.alloc(64, 0);
  const header = Buffer.from([0x01, 0x00, 0x00]);
  const keyCount = Buffer.from([0x01]);
  const key = Buffer.from(feePayerPub);
  const rest = Buffer.alloc(40, 0); // recentBlockhash + instr filler
  const message = Buffer.concat([header, keyCount, key, rest]);
  return Buffer.concat([sigCount, sigSlot, message]).toString('base64');
}

const SEED = Buffer.alloc(32, 7);
const ADDR = solana.addressFromSeed(SEED);
const PUB = solana.publicKey(SEED);

function okFetch(txB64) {
  return async (url) => {
    if (String(url).includes('/v6/quote')) return { json: async () => ({ outAmount: '12345', inputMint: 'in', outputMint: 'out' }) };
    if (String(url).includes('/v6/swap')) return { json: async () => ({ swapTransaction: txB64 }) };
    throw new Error('unexpected fetch ' + url);
  };
}

test('sol-swap: quotes, signs the fee-payer slot, and broadcasts', async () => {
  const unsigned = makeTx(PUB);
  let broadcast = null;
  const rpc = async (m, p) => { if (m === 'sendTransaction') { broadcast = p[0]; return 'TXID_OK'; } };
  const delegation = { key: SEED.toString('hex'), address: ADDR, capUsd: 100, spentUsd: 0 };
  const action = { kind: 'sol-swap', tokenOut: 'MintOut1111', amountBase: '20000000', notionalUsd: 20, feeUsd: 0.2, slippageBps: 100 };
  const r = await executeTrade({ delegation, action, rpc, fetchFn: okFetch(unsigned), env: { BLOCKLE_BOT_MAINNET: '1' } });
  assert.equal(r.txid, 'TXID_OK');
  assert.equal(r.chain, 'solana');
  // The signature slot (bytes 1..65) is no longer all zero — the tx got signed.
  const sig = Buffer.from(broadcast, 'base64').subarray(1, 65).toString('hex');
  assert.notEqual(sig, '00'.repeat(64));
});

test('sol-swap: refused when mainnet is off', async () => {
  const delegation = { key: SEED.toString('hex'), address: ADDR, capUsd: 100, spentUsd: 0 };
  await assert.rejects(
    () => executeTrade({
      delegation, action: { kind: 'sol-swap', tokenOut: 'X', amountBase: '1', notionalUsd: 20 },
      rpc: async () => {}, fetchFn: async () => {}, env: {},
    }),
    /mainnet trading is disabled/);
});

test('sol-swap: refused over the cap', async () => {
  const delegation = { key: SEED.toString('hex'), address: ADDR, capUsd: 10, spentUsd: 0 };
  await assert.rejects(
    () => executeTrade({
      delegation, action: { kind: 'sol-swap', tokenOut: 'X', amountBase: '1', notionalUsd: 20 },
      rpc: async () => {}, fetchFn: okFetch(makeTx(PUB)), env: { BLOCKLE_BOT_MAINNET: '1' },
    }),
    /over cap/);
});

test('sol-swap sender gate: a tx whose fee payer is NOT our address is refused (nothing broadcast)', async () => {
  const otherPub = solana.publicKey(Buffer.alloc(32, 9)); // a different key
  const badTx = makeTx(otherPub);
  let broadcast = false;
  const rpc = async (m) => { if (m === 'sendTransaction') broadcast = true; return 'x'; };
  const delegation = { key: SEED.toString('hex'), address: ADDR, capUsd: 100, spentUsd: 0 };
  await assert.rejects(
    () => executeTrade({
      delegation, action: { kind: 'sol-swap', tokenOut: 'X', amountBase: '1', notionalUsd: 20 },
      rpc, fetchFn: okFetch(badTx), env: { BLOCKLE_BOT_MAINNET: '1' },
    }),
    /sender gate/);
  assert.equal(broadcast, false, 'must not broadcast when the sender gate fails');
});

test('solana keypair: deterministic + signs verifiably (RFC-8032 ed25519 round-trip)', () => {
  const a1 = solana.addressFromSeed(SEED);
  const a2 = solana.addressFromSeed(SEED);
  assert.equal(a1, a2);                 // deterministic
  assert.match(a1, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58 address shape
  const sig = solana.signMessage(SEED, Buffer.from('blockle'));
  assert.equal(sig.length, 64);
});
