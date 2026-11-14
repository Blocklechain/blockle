import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

// ---- harness: live server + per-user cookie jars (shape of gold.test.js, but with TWO
// independent sessions so buyer/seller flows are real) ---------------------------------------
function freshApp(configExtra = {}, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-acct-'));
  const clock = { t: 1_700_000_000_000 };
  const app = createApp({
    now: () => clock.t,
    // Fake Apple verifier (same shape as gold.test.js): test "receipts" are base64-encoded
    // verifyReceipt responses, so fund() can mint uniquely-transacted GOLD without the network.
    goldVerifier: async (receipt) => JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')),
    ...overrides,
    config: {
      dataDir, prod: false, cookieSecure: false, mailTransport: 'stub', paypalEnv: 'stub',
      publicOrigin: 'http://127.0.0.1', adminEmail: 'admin@example.test', adminPassword: 'test-admin-passphrase-123',
      planName: 'Blockle Pro', sessionSecret: 'test-secret', appleIapEnabled: true,
      ...configExtra,
    },
  });
  return { app, dataDir, clock };
}

async function withServer(fn, configExtra = {}, overrides = {}) {
  const { app, dataDir, clock } = freshApp(configExtra, overrides);
  await app.ensureAdmin();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  function makeClient() {
    const jar = {};
    const client = {
      csrf: null,
      async call(method, p, body, headers = {}) {
        const h = { ...headers };
        if (body) h['Content-Type'] = 'application/json';
        if (body && client.csrf && !h['X-CSRF-Token']) h['X-CSRF-Token'] = client.csrf;
        const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookie) h['Cookie'] = cookie;
        const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
        const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
        for (const c of setc) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (v === '' || /Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v; }
        let data = {}; try { data = await r.json(); } catch {}
        return { status: r.status, data };
      },
      async login(email) {
        await client.call('POST', '/account/api/register', { email, password: 'longenough1' });
        const token = app.mailer.sent.find((m) => m.to === email).text.match(/token=([^\s]+)/)[1];
        await client.call('GET', '/account/api/verify?token=' + token);
        const login = await client.call('POST', '/account/api/login', { email, password: 'longenough1' });
        client.csrf = login.data.csrf;
        return client;
      },
      async fund(gold) {
        // Credit via the IAP path (enabled in tests) — the only legitimate credit path. The
        // receipt is a base64 Apple response the injected goldVerifier decodes verbatim; a
        // unique transaction_id each time keeps the goldTxns replay guard happy.
        const skuFor = { 100: 'gold_100', 550: 'gold_550', 1200: 'gold_1200', 2600: 'gold_2600' };
        const sku = skuFor[gold] || 'gold_100';
        const receipt = Buffer.from(JSON.stringify({
          status: 0, environment: 'sandbox',
          receipt: { bundle_id: 'org.blockle.blocklings', in_app: [{ product_id: sku, transaction_id: 'TX-FUND-' + email_seq++ + '-' + Math.random() }] },
        })).toString('base64');
        const r = await client.call('POST', '/account/api/game/gold/iap', { receipt, sku });
        assert.equal(r.status, 200, 'funding failed: ' + JSON.stringify(r.data));
        return r.data.balance;
      },
      async gold() { return (await client.call('GET', '/account/api/game/gold')).data.balance; },
    };
    return client;
  }
  let email_seq = 0;

  try { await fn({ app, clock, base, makeClient }); }
  finally { await new Promise((r) => app.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); }
}

const SWORD = { defId: 'weapon.sword.iron', qty: 1, meta: { name: 'Iron Sword' } };
const MINTED_PET = {
  petId: 'slime.golden', uid: 'u-test-abcdef1234-01',
  mints: [{ chain: 'blockle', token: 'tok_deadbeef', tx: 'a'.repeat(64), t: 1 }],
  meta: { name: '24-Karat Goober' },
};

// ---- listing validation --------------------------------------------------------------------
test('market: listing validation enforces the economy + NFT laws', async () => {
  await withServer(async ({ makeClient }) => {
    const s = await makeClient().login('seller@t.test');

    // auth required to list; browse is public
    assert.equal((await makeClient().call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price: { gold: 10 } })).status, 401); // no session
    assert.equal((await makeClient().call('GET', '/account/api/game/market')).status, 200);

    // gold listing needs no mint
    const ok = await s.call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price: { gold: 25 } });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.listingId);

    // crypto listing REQUIRES minted-on-that-chain goods
    const noMint = await s.call('POST', '/account/api/game/market/list', { kind: 'item', payload: { ...SWORD, uid: 'u-x-y-01' }, price: { chain: 'blockle', amount: 1, address: 'block1' + 'q'.repeat(58) } });
    assert.equal(noMint.status, 400);
    assert.match(noMint.data.error, /minted/);

    const wrongChain = await s.call('POST', '/account/api/game/market/list', { kind: 'pet', payload: MINTED_PET, price: { chain: 'ethereum', amount: 0.1, address: '0x' + 'a'.repeat(40) } });
    assert.equal(wrongChain.status, 400, 'minted on blockle, priced in ethereum must fail');

    const okCrypto = await s.call('POST', '/account/api/game/market/list', { kind: 'pet', payload: MINTED_PET, price: { chain: 'blockle', amount: 2.5, address: 'block1' + 'q'.repeat(58) } });
    assert.equal(okCrypto.status, 200);

    // same uid can't be live in two listings
    const dup = await s.call('POST', '/account/api/game/market/list', { kind: 'pet', payload: MINTED_PET, price: { gold: 5 } });
    assert.equal(dup.status, 409);

    // bad prices
    for (const price of [{ gold: 0 }, { gold: -5 }, { gold: 1.5 }, { chain: 'dogecoin', amount: 1, address: 'x' }, { chain: 'blockle', amount: -1, address: 'block1' + 'q'.repeat(58) }]) {
      const r = await s.call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price });
      assert.equal(r.status, 400, JSON.stringify(price));
    }
  });
});

// ---- GOLD settlement: the atomicity suite ---------------------------------------------------
test('market: gold buy settles atomically — ledger conservation + listing flip', async () => {
  await withServer(async ({ makeClient }) => {
    const seller = await makeClient().login('s1@t.test');
    const buyer = await makeClient().login('b1@t.test');
    await buyer.fund(550);

    const lst = await seller.call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price: { gold: 150 } });
    const id = lst.data.listingId;

    const buy = await buyer.call('POST', '/account/api/game/market/buy', { id });
    assert.equal(buy.status, 200);
    assert.equal(buy.data.balance, 400);
    assert.equal(buy.data.listing.status, 'sold');
    assert.deepEqual(buy.data.listing.item, SWORD, 'buy response delivers the escrowed goods payload');

    // conservation: buyer -150, seller +150, nothing minted/destroyed
    assert.equal(await buyer.gold(), 400);
    assert.equal(await seller.gold(), 150);

    // the sale shows up for the seller (sellerAck false until acked)
    const mine = await seller.call('GET', '/account/api/game/market/mine');
    const sold = mine.data.listings.find((l) => l.id === id);
    assert.equal(sold.status, 'sold');
    assert.equal(sold.sellerAck, false);
    assert.equal((await seller.call('POST', '/account/api/game/market/ack', { id })).status, 200);
    const mine2 = await seller.call('GET', '/account/api/game/market/mine');
    assert.equal(mine2.data.listings.find((l) => l.id === id).sellerAck, true);

    // sold listings leave the public board
    const browse = await buyer.call('GET', '/account/api/game/market');
    assert.ok(!browse.data.listings.some((l) => l.id === id));
  });
});

test('market: underfunded buy changes NOTHING (no debit, no credit, listing stays open)', async () => {
  await withServer(async ({ makeClient }) => {
    const seller = await makeClient().login('s2@t.test');
    const buyer = await makeClient().login('b2@t.test');
    await buyer.fund(100);

    const id = (await seller.call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price: { gold: 101 } })).data.listingId;
    const buy = await buyer.call('POST', '/account/api/game/market/buy', { id });
    assert.equal(buy.status, 400);
    assert.match(buy.data.error, /Insufficient GOLD/);

    assert.equal(await buyer.gold(), 100, 'buyer not debited');
    assert.equal(await seller.gold(), 0, 'seller not credited');
    const browse = await buyer.call('GET', '/account/api/game/market');
    assert.equal(browse.data.listings.find((l) => l.id === id).status, 'open');
  });
});

test('market: concurrent buys of one listing — exactly ONE succeeds, gold conserved', async () => {
  await withServer(async ({ makeClient }) => {
    const seller = await makeClient().login('s3@t.test');
    const b1 = await makeClient().login('b3a@t.test');
    const b2 = await makeClient().login('b3b@t.test');
    await b1.fund(550);
    await b2.fund(550);

    const id = (await seller.call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price: { gold: 500 } })).data.listingId;

    // fire both buys at once — the store queue must serialize them into one winner
    const [r1, r2] = await Promise.all([
      b1.call('POST', '/account/api/game/market/buy', { id }),
      b2.call('POST', '/account/api/game/market/buy', { id }),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 200);
    const fails = [r1, r2].filter((r) => r.status !== 200);
    assert.equal(oks.length, 1, `exactly one winner: ${r1.status}/${r2.status}`);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].status, 410, 'the loser sees listing-gone, not an error that implies a charge');

    // conservation across all three ledgers: 550+550+0 before, must be 1600 after too
    const total = (await b1.gold()) + (await b2.gold()) + (await seller.gold());
    assert.equal(total, 1100, 'no gold minted or destroyed by the race');
    assert.equal(await seller.gold(), 500, 'seller credited exactly once');
  });
});

test('market: self-buy, double-buy and crypto-listing-via-gold-rail are rejected', async () => {
  await withServer(async ({ makeClient }) => {
    const seller = await makeClient().login('s4@t.test');
    const buyer = await makeClient().login('b4@t.test');
    await seller.fund(550);
    await buyer.fund(550);

    const id = (await seller.call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price: { gold: 10 } })).data.listingId;
    assert.equal((await seller.call('POST', '/account/api/game/market/buy', { id })).status, 400, 'self-buy');

    assert.equal((await buyer.call('POST', '/account/api/game/market/buy', { id })).status, 200);
    assert.equal((await buyer.call('POST', '/account/api/game/market/buy', { id })).status, 410, 'double-buy');
    assert.equal(await seller.gold(), 560, 'credited once');

    const cid = (await seller.call('POST', '/account/api/game/market/list', { kind: 'pet', payload: MINTED_PET, price: { chain: 'blockle', amount: 1, address: 'block1' + 'q'.repeat(58) } })).data.listingId;
    const wrongRail = await buyer.call('POST', '/account/api/game/market/buy', { id: cid });
    assert.equal(wrongRail.status, 400, 'crypto listing cannot settle with gold');
  });
});

test('market: cancel returns the goods payload and closes the listing', async () => {
  await withServer(async ({ makeClient }) => {
    const seller = await makeClient().login('s5@t.test');
    const other = await makeClient().login('b5@t.test');
    const id = (await seller.call('POST', '/account/api/game/market/list', { kind: 'item', payload: SWORD, price: { gold: 10 } })).data.listingId;

    assert.equal((await other.call('POST', '/account/api/game/market/cancel', { id })).status, 404, "can't cancel someone else's");
    const c = await seller.call('POST', '/account/api/game/market/cancel', { id });
    assert.equal(c.status, 200);
    assert.deepEqual(c.data.listing.item, SWORD, 'payload travels back for the save restore');
    assert.equal((await seller.call('POST', '/account/api/game/market/cancel', { id })).status, 409, 'cancel is terminal');
    await other.fund(100);
    assert.equal((await other.call('POST', '/account/api/game/market/buy', { id })).status, 410, 'cancelled listing unbuyable');
  });
});

// ---- CRYPTO rail truth table ---------------------------------------------------------------
const SELLER_ADDR = 'block1' + 'q'.repeat(58);
const PRICE_BLOCK = 2.5;

function explorerStub(byTxid) {
  // fetch stub for the gamemarket module: serves /api/explorer/tx/<id> from `byTxid`.
  return async (url) => {
    const m = /\/api\/explorer\/tx\/(.+)$/.exec(url);
    const tx = m && byTxid[decodeURIComponent(m[1])];
    if (!tx) return { ok: false, async json() { return { error: 'no such transaction' }; } };
    return { ok: true, async json() { return { block_hash: 'h', tx }; } };
  };
}

test('market: BLOCK crypto buy verifies on-chain via the explorer before completing', async () => {
  const goodTx = 'f'.repeat(64);
  const shortTx = 'e'.repeat(64);
  const explorer = explorerStub({
    [goodTx]: { txid: goodTx, confirmations: 1, outputs: [{ address: SELLER_ADDR, amount: Math.round(PRICE_BLOCK * 1e8), vout: 0 }] },
    [shortTx]: { txid: shortTx, confirmations: 1, outputs: [{ address: SELLER_ADDR, amount: 1, vout: 0 }] },
  });
  await withServer(async ({ makeClient }) => {
    const seller = await makeClient().login('s6@t.test');
    const buyer = await makeClient().login('b6@t.test');
    const list = await seller.call('POST', '/account/api/game/market/list', { kind: 'pet', payload: MINTED_PET, price: { chain: 'blockle', amount: PRICE_BLOCK, address: SELLER_ADDR } });
    const id = list.data.listingId;

    // a tx the explorer can't see yet -> pending-verify, retryable, never 'sold'
    const unseen = await buyer.call('POST', '/account/api/game/market/paid', { id, tx: 'a'.repeat(64) });
    assert.equal(unseen.status, 202);
    assert.equal(unseen.data.status, 'pending-verify');

    // an underpaying tx -> definitive 400 + the listing reopens (not wedged)
    const under = await buyer.call('POST', '/account/api/game/market/paid', { id, tx: shortTx });
    assert.equal(under.status, 400);

    // the real payment -> verified sale
    const ok = await buyer.call('POST', '/account/api/game/market/paid', { id, tx: goodTx });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.listing.status, 'sold');
    assert.equal(ok.data.listing.payment, 'verified');
    assert.deepEqual(ok.data.listing.pet, MINTED_PET);

    // idempotent replay by the same buyer+tx
    const replay = await buyer.call('POST', '/account/api/game/market/paid', { id, tx: goodTx });
    assert.equal(replay.status, 200);

    // the SAME txid cannot settle a second listing (payment replay across listings)
    const id2 = (await seller.call('POST', '/account/api/game/market/list', { kind: 'item', payload: { ...SWORD, uid: 'u-m-2-01', mints: MINTED_PET.mints }, price: { chain: 'blockle', amount: 0.1, address: SELLER_ADDR } })).data.listingId;
    const stolen = await buyer.call('POST', '/account/api/game/market/paid', { id: id2, tx: goodTx });
    assert.equal(stolen.status, 409);
  }, {}, { gameMarketFetch: explorer });
});

test('market: ETH/SOL crypto buys complete as ATTESTED, never fake-verified', async () => {
  const ethPet = { ...MINTED_PET, uid: 'u-eth-1-01', mints: [{ chain: 'ethereum', token: '0x' + 'b'.repeat(40) + ':1', tx: '0x' + 'c'.repeat(64), t: 1 }] };
  await withServer(async ({ makeClient }) => {
    const seller = await makeClient().login('s7@t.test');
    const buyer = await makeClient().login('b7@t.test');
    const id = (await seller.call('POST', '/account/api/game/market/list', { kind: 'pet', payload: ethPet, price: { chain: 'ethereum', amount: 0.05, address: '0x' + 'a'.repeat(40) } })).data.listingId;

    const ok = await buyer.call('POST', '/account/api/game/market/paid', { id, tx: '0x' + 'd'.repeat(64) });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.listing.status, 'sold');
    assert.equal(ok.data.listing.payment, 'attested', 'honest best-effort status — not "verified"');
  });
});
