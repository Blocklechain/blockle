// liquidity_block.test.js — the BLOCK (post-quantum, ML-DSA-44) leg: keypair
// provisioning + encryption, deposit verification, and a gated ML-DSA payout.
// Real wasm, fake store + injected fetch — no node, no network.

import assert from 'node:assert';
import { createRequire } from 'node:module';
import { ensureTreasuryWallet, verifyBlockDeposit, payoutBlock } from '../src/liquidity_block.js';

const require = createRequire(import.meta.url);
const wasm = require('../src/vendor/blockle_wasm.js');

let pass = 0;
const ok = (n, c) => { assert.ok(c, n); pass++; };
const SEED = 'f'.repeat(64);
const ON = { LIQUIDITY_MAINNET: '1' };

function fakeStore() {
  const m = new Map();
  const k = (c, key) => c + ' ' + key;
  return {
    get: (c, key) => (m.has(k(c, key)) ? structuredClone(m.get(k(c, key))) : null),
    put: async (c, key, v) => { m.set(k(c, key), structuredClone(v)); },
    _m: m,
  };
}

await (async () => {
  // wasm primitives round-trip (the signer we're trusting with real funds).
  const kp = JSON.parse(wasm.keygen());
  ok('address_from_pubkey matches keygen', wasm.address_from_pubkey(kp.publicKey) === kp.address);
  const sig = JSON.parse(wasm.sign_message(kp.secretKey, kp.publicKey, 'blockle'));
  ok('ML-DSA sign/verify round-trips', wasm.verify(kp.publicKey, 'blockle', sig.signature) === true);

  // Provision: generated once, stored ENCRYPTED (no plaintext secret at rest),
  // bech32m block1… address, idempotent.
  {
    const store = fakeStore();
    const w1 = await ensureTreasuryWallet(store, SEED);
    ok('treasury BLOCK addr is bech32m block1…', /^block1[0-9a-z]+$/.test(w1.address));
    const stored = store.get('liquidity', 'blockWallet');
    ok('secret stored encrypted (no raw secretKey field)', !stored.secretKey && stored.enc && stored.enc.data && stored.enc.tag);
    const raw = JSON.stringify(stored);
    ok('encrypted blob is not the plaintext secret', !raw.includes('secretKey'));
    const w2 = await ensureTreasuryWallet(store, SEED);
    ok('provisioning is idempotent', w2.address === w1.address);
  }

  // Deposit verification: an output to the treasury >= min passes; wrong/low fails.
  {
    const treasury = 'block1deadbeef';
    const fetchJson = (outs) => async () => ({ ok: true, json: async () => ({ outputs: outs }) });
    const good = await verifyBlockDeposit({ txid: '0xd', expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([{ address: treasury, amount: 100000000 }]) });
    ok('valid BLOCK deposit verifies (1 BLOCK = 1e8)', good.ok);
    const low = await verifyBlockDeposit({ txid: '0xd', expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([{ address: treasury, amount: 50000000 }]) });
    ok('under-amount deposit rejected', !low.ok);
    const wrong = await verifyBlockDeposit({ txid: '0xd', expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([{ address: 'block1other', amount: 100000000 }]) });
    ok('deposit to wrong address rejected', !wrong.ok);
  }

  // Payout: gate OFF refuses; gate ON builds an ML-DSA transfer from the treasury
  // UTXOs and broadcasts (both legs mocked).
  {
    const store = fakeStore();
    await ensureTreasuryWallet(store, SEED);
    let threw = false;
    try { await payoutBlock({ store, seedHex: SEED, toAddress: 'block1xyz', amountBlock: 1, chainBase: 'https://x', fetchFn: async () => ({ ok: true, json: async () => ({}) }), env: {} }); }
    catch (e) { threw = /disabled/.test(e.message); }
    ok('BLOCK payout refused when gate OFF', threw);

    const addr = store.get('liquidity', 'blockWallet').address;
    const fetchFn = async (url, init) => {
      if (String(url).includes('/utxos/')) {
        return { ok: true, json: async () => ({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, amount: 1000000000 }] }) };
      }
      if (String(url).includes('/api/submit')) {
        const body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ txid: 'broadcast-' + (body.rawtx ? 'ok' : 'no') }) };
      }
      return { ok: false, json: async () => ({}) };
    };
    const r = await payoutBlock({ store, seedHex: SEED, toAddress: addr, amountBlock: 2, chainBase: 'https://x', fetchFn, env: ON });
    ok('BLOCK payout builds+signs+broadcasts', r.txid === 'broadcast-ok' && !!r.raw);
  }

  console.log(`liquidity_block.test.js: ${pass} checks passed`);
})();
