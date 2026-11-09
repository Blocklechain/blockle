// liquidity_block.test.js — the BLOCK (post-quantum, ML-DSA-44) leg: keypair
// provisioning + encryption, deposit verification, and a gated ML-DSA payout.
// Real wasm, fake store + injected fetch — no node, no network.

import assert from 'node:assert';
import { createRequire } from 'node:module';
import { ensureTreasuryWallet, verifyBlockDeposit, payoutBlock, flipTxid } from '../src/liquidity_block.js';

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

  // Deposit verification against the REAL explorer shape ({block_hash, tx:{outputs}}):
  // a mined output to the treasury >= min passes; wrong/low/unconfirmed/bad-txid fail.
  {
    const treasury = 'block1deadbeef';
    const TXID = 'ab'.repeat(32);
    const fetchJson = (outs, blockHash = 'ff'.repeat(32)) => async () => ({ ok: true, json: async () => ({ block_hash: blockHash, tx: { outputs: outs, block_height: blockHash ? 100 : undefined } }) });
    const good = await verifyBlockDeposit({ txid: TXID, expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([{ address: treasury, amount: 100000000 }]) });
    ok('valid BLOCK deposit verifies (1 BLOCK = 1e8)', good.ok && good.creditedBase === '100000000');
    const low = await verifyBlockDeposit({ txid: TXID, expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([{ address: treasury, amount: 50000000 }]) });
    ok('under-amount deposit rejected', !low.ok);
    const wrong = await verifyBlockDeposit({ txid: TXID, expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([{ address: 'block1other', amount: 100000000 }]) });
    ok('deposit to wrong address rejected', !wrong.ok);
    const mempool = await verifyBlockDeposit({ txid: TXID, expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([{ address: treasury, amount: 100000000 }], null) });
    ok('unconfirmed (mempool) deposit is not yet accepted', !mempool.ok && /not confirmed/.test(mempool.reason));
    const bare = await verifyBlockDeposit({ txid: TXID, expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: async () => ({ ok: true, json: async () => ({ outputs: [{ address: treasury, amount: 100000000 }] }) }) });
    ok('bare {outputs} explorer shape still accepted', bare.ok);
    const bad = await verifyBlockDeposit({ txid: '0xd', expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: fetchJson([]) });
    ok('non-txid deposit id rejected without a lookup', !bad.ok && /bad deposit txid/.test(bad.reason));
    // The wallet posts the node's raw-order txid; the explorer only knows the
    // reversed (display) spelling — the lookup must try both.
    const RAW = 'dbd7e866f378ed8c0a02d9286037f1a53b638ce3f3e45db48ad91336f7462ff0';
    const DISPLAY = 'f02f46f73613d98ab45de4f3e38c633ba5f1376028d9020a8ced78f366e8d7db';
    ok('flipTxid reverses byte order', flipTxid(RAW) === DISPLAY && flipTxid(DISPLAY) === RAW && flipTxid('zz') === 'zz');
    const onlyDisplay = async (url) => String(url).endsWith('/tx/' + DISPLAY)
      ? { ok: true, json: async () => ({ block_hash: 'ff'.repeat(32), tx: { block_height: 5, outputs: [{ address: treasury, amount: 100000000 }] } }) }
      : { ok: false, json: async () => ({ error: 'no such transaction' }) };
    const flipped = await verifyBlockDeposit({ txid: RAW, expectTo: treasury, minBlock: 1, chainBase: 'https://x', fetchFn: onlyDisplay });
    ok('deposit posted in raw txid order is found under the explorer spelling', flipped.ok);
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
        // biz /api/submit reads the signed tx from `raw` (a `rawtx` body is a 400).
        const body = JSON.parse(init.body);
        if (!body.raw) return { ok: false, status: 400, json: async () => ({ error: 'missing raw transaction' }) };
        return { ok: true, json: async () => ({ error: null, result: { accepted: true, txid: 'dbd7e866f378ed8c0a02d9286037f1a53b638ce3f3e45db48ad91336f7462ff0' } }) };
      }
      return { ok: false, json: async () => ({}) };
    };
    const r = await payoutBlock({ store, seedHex: SEED, toAddress: addr, amountBlock: 2, chainBase: 'https://x', fetchFn, env: ON });
    ok('BLOCK payout builds+signs+broadcasts (submit body uses `raw`)', !!r.raw && r.txidRpc === 'dbd7e866f378ed8c0a02d9286037f1a53b638ce3f3e45db48ad91336f7462ff0');
    ok('payout txid is reported in the explorer (display) spelling', r.txid === 'f02f46f73613d98ab45de4f3e38c633ba5f1376028d9020a8ced78f366e8d7db');

    // A rejected broadcast must THROW (never a phantom txid / phantom 'settled').
    const rejectFetch = async (url) => String(url).includes('/utxos/')
      ? { ok: true, json: async () => ({ utxos: [{ txid: 'ab'.repeat(32), vout: 0, amount: 1000000000 }] }) }
      : { ok: true, json: async () => ({ error: { code: -26, message: 'input spends unknown or already-spent output' }, result: null }) };
    let rejected = false;
    try { await payoutBlock({ store, seedHex: SEED, toAddress: addr, amountBlock: 2, chainBase: 'https://x', fetchFn: rejectFetch, env: ON }); }
    catch (e) { rejected = /broadcast rejected/.test(e.message) && /already-spent/.test(e.message); }
    ok('rejected broadcast throws with the node reason', rejected);
  }

  console.log(`liquidity_block.test.js: ${pass} checks passed`);
})();
