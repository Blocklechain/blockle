// chains/token-discovery.test.js — LAYER A of the owned-token auto-import work:
// each new-chain adapter's discoverTokens(address) maps a MOCKED indexer JSON
// response to the canonical discovered-token row shape the auto-import gate
// consumes { chain, kind, symbol, decimals, address, balance, display, ... }.
// Proves the JSON→row mapping for TRON (TRC-20) / TON (jettons) / STELLAR
// (trustlines) / CARDANO (native-assets), plus the best-effort contract
// (empty response → [], network throw → []). No network.
//
//   node --test blockle-extension/chains/

const { test } = require('node:test');
const assert = require('node:assert');

const TronAdapter = require('./tron.js');
const TonAdapter = require('./ton.js');
const StellarAdapter = require('./stellar.js');
const CardanoAdapter = require('./cardano.js');

// Install a global.fetch stub for the duration of `fn`, restoring the original.
async function withFetch(stub, fn) {
  const prev = global.fetch;
  global.fetch = stub;
  try { return await fn(); } finally { global.fetch = prev; }
}
function jsonResp(obj) { return { ok: true, async json() { return obj; }, async text() { return JSON.stringify(obj); } }; }

// ===========================================================================
// TRON — GET /v1/accounts/{addr}/trc20 → { data:[ {<contract>:<balance>} ] }
// ===========================================================================
test('tron.discoverTokens maps TRC-20 balances (known USDT symbol/decimals)', async () => {
  await withFetch(async (url) => {
    if (String(url).includes('/trc20')) return jsonResp({ data: [{ 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': '5000000' }] });
    return jsonResp({});
  }, async () => {
    const a = TronAdapter.createTronAdapter({ api: 'http://x' });
    const rows = await a.discoverTokens('TXYZ');
    assert.deepEqual(rows, [{
      chain: 'tron', kind: 'trc20', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      symbol: 'USDT', decimals: 6, balance: '5000000', display: '5',
    }]);
  });
});

test('tron.discoverTokens drops zero balances and tolerates an empty response', async () => {
  await withFetch(async () => jsonResp({ data: [{ 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': '0' }] }), async () => {
    const a = TronAdapter.createTronAdapter({ api: 'http://x' });
    assert.deepEqual(await a.discoverTokens('TXYZ'), []);
  });
  await withFetch(async () => jsonResp({ data: [] }), async () => {
    assert.deepEqual(await TronAdapter.createTronAdapter({ api: 'http://x' }).discoverTokens('TXYZ'), []);
  });
});

test('tron.discoverTokens returns [] on a network throw (best-effort)', async () => {
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.deepEqual(await TronAdapter.createTronAdapter({ api: 'http://x' }).discoverTokens('TXYZ'), []);
  });
});

// ===========================================================================
// TON — jetton index → tonapi { balances:[ { balance, jetton:{address,symbol,decimals} } ] }
// ===========================================================================
test('ton.discoverTokens maps jetton balances keyed by master address', async () => {
  await withFetch(async () => jsonResp({
    balances: [{ balance: '3000000', jetton: { address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', symbol: 'USDT', decimals: 6 } }],
  }), async () => {
    const a = TonAdapter.createTonAdapter({ api: 'http://x/api/v2' });
    const rows = await a.discoverTokens('EQowner');
    assert.deepEqual(rows, [{
      chain: 'ton', kind: 'jetton', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
      symbol: 'USDT', decimals: 6, balance: '3000000', display: '3',
    }]);
  });
});

test('ton.discoverTokens also maps the toncenter v3 shape + drops zero', async () => {
  await withFetch(async () => jsonResp({
    jetton_wallets: [
      { balance: '0', jetton: 'EQzero' },
      { balance: '42', jetton: 'EQmaster2' },
    ],
    metadata: { EQmaster2: { token_info: [{ symbol: 'JUSD', decimals: 2, name: 'Jetton USD' }] } },
  }), async () => {
    const rows = await TonAdapter.createTonAdapter({ api: 'http://x/api/v2' }).discoverTokens('EQowner');
    assert.deepEqual(rows, [{
      chain: 'ton', kind: 'jetton', address: 'EQmaster2', symbol: 'JUSD', decimals: 2,
      balance: '42', display: '0.42', name: 'Jetton USD',
    }]);
  });
});

test('ton.discoverTokens returns [] on a network throw', async () => {
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.deepEqual(await TonAdapter.createTonAdapter({ api: 'http://x/api/v2' }).discoverTokens('EQowner'), []);
  });
});

// ===========================================================================
// STELLAR — Horizon GET /accounts/{G...} → balances[] (non-native trustlines)
// ===========================================================================
test('stellar.discoverTokens maps non-native trustlines to stroops', async () => {
  await withFetch(async () => jsonResp({
    balances: [
      { asset_type: 'native', balance: '10.0000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM33SE2FUVWC3RUWX7VZITXS2TZDN', balance: '12.5000000' },
      { asset_type: 'credit_alphanum4', asset_code: 'ZERO', asset_issuer: 'GAZERO', balance: '0.0000000' },
    ],
  }), async () => {
    const rows = await StellarAdapter.createStellarAdapter({ horizon: 'http://x' }).discoverTokens('GABC');
    assert.deepEqual(rows, [{
      chain: 'stellar', kind: 'stellar-asset',
      address: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM33SE2FUVWC3RUWX7VZITXS2TZDN',
      symbol: 'USDC', decimals: 7, balance: '125000000', display: '12.5',
    }]);
  });
});

test('stellar.discoverTokens returns [] on a network throw', async () => {
  await withFetch(async () => { throw new Error('offline'); }, async () => {
    assert.deepEqual(await StellarAdapter.createStellarAdapter({ horizon: 'http://x' }).discoverTokens('GABC'), []);
  });
});

// ===========================================================================
// CARDANO — Koios POST /address_utxos → utxos[].asset_list[] (native-assets)
// ===========================================================================
test('cardano.discoverTokens aggregates native-assets (display-only)', async () => {
  const httpPost = async () => JSON.stringify([
    { tx_hash: 'aa', tx_index: 0, value: '2000000', asset_list: [{ policy_id: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234', asset_name: '54455354', quantity: '4' }] },
    { tx_hash: 'bb', tx_index: 1, value: '2000000', asset_list: [{ policy_id: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234', asset_name: '54455354', quantity: '3' }] },
  ]);
  const a = CardanoAdapter.createCardanoAdapter({ koios: 'http://x', httpPost });
  const rows = await a.discoverTokens('addr1xyz');
  assert.deepEqual(rows, [{
    chain: 'cardano', kind: 'native-asset',
    address: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd123454455354',
    symbol: 'TEST', decimals: 0, balance: '7', display: '7', displayOnly: true,
  }]);
});

test('cardano.discoverTokens returns [] when there are no native-assets / on error', async () => {
  const a = CardanoAdapter.createCardanoAdapter({ koios: 'http://x', httpPost: async () => JSON.stringify([{ tx_hash: 'aa', tx_index: 0, value: '2000000', asset_list: [] }]) });
  assert.deepEqual(await a.discoverTokens('addr1xyz'), []);
  const b = CardanoAdapter.createCardanoAdapter({ koios: 'http://x', httpPost: async () => { throw new Error('offline'); } });
  assert.deepEqual(await b.discoverTokens('addr1xyz'), []);
});
