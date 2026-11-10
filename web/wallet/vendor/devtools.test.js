// devtools.test.js — node tests for vendor/devtools.js (Developer mode + tools).
// Run: node vendor/devtools.test.js   (from web/wallet)  — no network, no DOM:
// Store / fetch / wiring / price feed are injected fakes.
'use strict';

const assert = require('assert');
const DevTools = require('./devtools.js');
const Registry = require('./chains/registry.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
}

// In-memory Store fake with the real Store API shape:
// get([keys]) -> {key: value}, set(obj), remove(keys).
function fakeStore(seed) {
  const data = Object.assign({}, seed || {});
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (data[k] !== undefined) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete data[k]; },
  };
}

function fakeWiring() {
  const w = { resets: 0, reset() { this.resets++; } };
  return w;
}

(async () => {
  // ---- devMode ---------------------------------------------------------------
  await test('devMode is OFF by default (empty store)', async () => {
    const dt = DevTools.create({ store: fakeStore(), wiring: null });
    assert.strictEqual(await dt.enabled(), false);
  });

  await test('devMode defaults OFF even when the store throws', async () => {
    const dt = DevTools.create({ store: { async get() { throw new Error('boom'); } }, wiring: null });
    assert.strictEqual(await dt.enabled(), false);
  });

  await test('setEnabled(true) persists and reads back', async () => {
    const store = fakeStore();
    const dt = DevTools.create({ store, wiring: null });
    await dt.setEnabled(true);
    assert.strictEqual(await dt.enabled(), true);
    assert.strictEqual(store.data.devmode, true);
    // a fresh instance over the same store sees it too
    const dt2 = DevTools.create({ store, wiring: null });
    assert.strictEqual(await dt2.enabled(), true);
  });

  await test("legacy '1' string counts as enabled", async () => {
    const dt = DevTools.create({ store: fakeStore({ devmode: '1' }), wiring: null });
    assert.strictEqual(await dt.enabled(), true);
  });

  // ---- testnets --------------------------------------------------------------
  await test('setTestnet(chain, true) writes the chainEndpoints override + resets wiring', async () => {
    const store = fakeStore();
    const wiring = fakeWiring();
    const dt = DevTools.create({ store, wiring });
    assert.strictEqual(await dt.isTestnet('ethereum'), false);
    assert.strictEqual(await dt.setTestnet('ethereum', true), true);
    assert.deepStrictEqual(store.data.chainEndpoints.ethereum, DevTools.TESTNETS.ethereum);
    assert.strictEqual(await dt.isTestnet('ethereum'), true);
    assert.strictEqual(wiring.resets, 1);
  });

  await test('setTestnet(chain, false) removes the override (back to mainnet default)', async () => {
    const store = fakeStore();
    const dt = DevTools.create({ store, wiring: null });
    await dt.setTestnet('solana', true);
    assert.strictEqual(await dt.isTestnet('solana'), true);
    await dt.setTestnet('solana', false);
    assert.strictEqual(await dt.isTestnet('solana'), false);
    assert.strictEqual(store.data.chainEndpoints.solana, undefined);
  });

  await test('setTestnet on an unknown chain returns false and writes nothing', async () => {
    const store = fakeStore();
    const dt = DevTools.create({ store, wiring: null });
    assert.strictEqual(await dt.setTestnet('nosuchchain', true), false);
    assert.strictEqual(store.data.chainEndpoints, undefined);
  });

  await test('disabling dev mode clears every testnet override but keeps custom RPC overrides', async () => {
    const store = fakeStore({
      chainEndpoints: {
        // a user's own custom RPC override — must survive
        base: { rpcUrl: 'https://my-own-base-node.example', chainId: 8453 },
        alchemy: { apiKey: 'readonly-key' },
      },
    });
    const dt = DevTools.create({ store, wiring: null });
    await dt.setEnabled(true);
    await dt.setTestnet('ethereum', true);
    await dt.setTestnet('bitcoin', true);
    await dt.setTestnet('stellar', true);
    assert.strictEqual(await dt.isTestnet('ethereum'), true);
    assert.strictEqual(await dt.isTestnet('bitcoin'), true);
    assert.strictEqual(await dt.isTestnet('stellar'), true);

    await dt.setEnabled(false);
    assert.strictEqual(await dt.enabled(), false);
    assert.strictEqual(await dt.isTestnet('ethereum'), false);
    assert.strictEqual(await dt.isTestnet('bitcoin'), false);
    assert.strictEqual(await dt.isTestnet('stellar'), false);
    const eps = store.data.chainEndpoints;
    assert.strictEqual(eps.ethereum, undefined);
    assert.strictEqual(eps.bitcoin, undefined);
    assert.strictEqual(eps.stellar, undefined);
    // untouched: the custom base RPC + the alchemy config bag
    assert.deepStrictEqual(eps.base, { rpcUrl: 'https://my-own-base-node.example', chainId: 8453 });
    assert.deepStrictEqual(eps.alchemy, { apiKey: 'readonly-key' });
  });

  await test('effectiveEndpoints merges testnet override over the registry default', async () => {
    const store = fakeStore();
    const dt = DevTools.create({ store, wiring: null });
    await dt.setTestnet('polygon', true);
    const eps = await dt.effectiveEndpoints();
    assert.strictEqual(eps.polygon.rpcUrl, DevTools.TESTNETS.polygon.rpcUrl);
    assert.strictEqual(eps.polygon.chainId, 80002);
    // untouched chains keep the mainnet default
    assert.strictEqual(eps.ethereum.rpcUrl, Registry.DEFAULT_ENDPOINTS.ethereum.rpcUrl);
  });

  // ---- TESTNETS shape --------------------------------------------------------
  await test('TESTNETS shape: every chain exists in the web registry with a usable endpoint field', async () => {
    const EP_FIELDS = ['rpcUrl', 'esplora', 'horizon', 'api', 'rpc', 'koios'];
    const chains = Object.keys(DevTools.TESTNETS);
    assert.ok(chains.length >= 15, 'expected a broad testnet map, got ' + chains.length);
    for (const c of chains) {
      const t = DevTools.TESTNETS[c];
      assert.ok(Registry.DEFAULT_ENDPOINTS[c], c + ' missing from web DEFAULT_ENDPOINTS');
      const fields = EP_FIELDS.filter((f) => typeof t[f] === 'string' && /^https?:\/\//.test(t[f]));
      assert.ok(fields.length >= 1, c + ' has no https endpoint field');
      if (Registry.EVM_CHAINS[c]) {
        assert.ok(Number.isInteger(t.chainId) && t.chainId > 0, c + ' (EVM) must carry a testnet chainId');
        assert.notStrictEqual(t.chainId, Registry.EVM_CHAINS[c].chainId, c + ' testnet chainId must differ from mainnet');
      }
      // the field name must be one the chain's web endpoint config actually uses
      const defFields = Object.keys(Registry.DEFAULT_ENDPOINTS[c]);
      for (const f of fields) assert.ok(defFields.includes(f), c + ': testnet field "' + f + '" not used by web default endpoint (' + defFields.join(',') + ')');
    }
    // and testnetCapableChains reports exactly the registry-supported set
    const dt = DevTools.create({ store: fakeStore(), wiring: null });
    assert.deepStrictEqual(dt.testnetCapableChains().sort(), chains.sort());
  });

  // ---- rpcProbe --------------------------------------------------------------
  await test('rpcProbe POSTs a JSON-RPC 2.0 envelope to the effective endpoint', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { async text() { return JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }); } };
    };
    const dt = DevTools.create({ store: fakeStore(), wiring: null, fetchImpl });
    const out = await dt.rpcProbe('ethereum', 'eth_blockNumber', '[]');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, Registry.DEFAULT_ENDPOINTS.ethereum.rpcUrl);
    const body = JSON.parse(calls[0].init.body);
    assert.deepStrictEqual(body, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    assert.ok(out.includes('"result": "0x10"'), 'pretty-printed result expected, got: ' + out);
  });

  await test('rpcProbe honors a testnet override + reports bad params JSON as an error string', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { async text() { return '{}'; } }; };
    const store = fakeStore();
    const dt = DevTools.create({ store, wiring: null, fetchImpl });
    await dt.setTestnet('ethereum', true);
    await dt.rpcProbe('ethereum', 'eth_chainId', '');
    assert.strictEqual(calls[0].url, DevTools.TESTNETS.ethereum.rpcUrl);
    const bad = await dt.rpcProbe('ethereum', 'eth_chainId', '{not json');
    assert.ok(/^Error: bad params JSON/.test(bad), bad);
    assert.strictEqual(calls.length, 1, 'bad JSON must not hit the network');
  });

  await test('rpcProbe treats esplora/REST chains as GET-by-path', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { async text() { return '{"height":1}'; } }; };
    const dt = DevTools.create({ store: fakeStore(), wiring: null, fetchImpl });
    await dt.rpcProbe('bitcoin', '/blocks/tip/height', '');
    assert.strictEqual(calls[0].url, Registry.DEFAULT_ENDPOINTS.bitcoin.esplora + '/blocks/tip/height');
    assert.ok(!calls[0].init.method, 'REST probe must be a GET');
  });

  // ---- priceProbe ------------------------------------------------------------
  await test('priceProbe returns usd from the feed and never prices BLOCK in USD', async () => {
    const pf = {
      async priceOf(sym) { return sym === 'SOL' ? 123.45 : null; },
      change24h() { return -1.2; },
      isBlockDenominated(a) { const s = typeof a === 'string' ? a : (a && a.symbol); return String(s).toUpperCase() === 'BLOCK'; },
    };
    const dt = DevTools.create({ store: fakeStore(), wiring: null, priceFeed: pf });
    const sol = await dt.priceProbe('sol');
    assert.strictEqual(sol.usd, 123.45);
    assert.strictEqual(sol.symbol, 'SOL');
    const block = await dt.priceProbe('BLOCK');
    assert.strictEqual(block.usd, null);
    assert.ok(/never priced in USD/.test(block.note), block.note);
    assert.ok(Array.isArray(dt.pricePresets) && dt.pricePresets.includes('SOL'));
  });

  // ---- inspectAddress --------------------------------------------------------
  await test('inspectAddress: validity gate + balance via the registry adapter', async () => {
    const registry = {
      get(chain) {
        assert.strictEqual(chain, 'ethereum');
        return { async getBalance(addr, tokens) { return [{ asset: { symbol: 'ETH' }, confirmed: '42', display: '0.000000000000000042' }]; } };
      },
    };
    const dt = DevTools.create({ store: fakeStore(), wiring: null, registry });
    const bad = await dt.inspectAddress('ethereum', 'not-an-address');
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(bad.balance, undefined);
    const ok = await dt.inspectAddress('ethereum', '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c');
    assert.strictEqual(ok.valid, true);
    assert.strictEqual(ok.balance, '42');
  });

  await test('inspectAddress prefers addressBalance when the adapter has one (utxo)', async () => {
    const registry = { get() { return { async addressBalance() { return 100000n; } }; } };
    const dt = DevTools.create({ store: fakeStore(), wiring: null, registry });
    const r = await dt.inspectAddress('bitcoin', 'bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.balance, '100000');
  });

  // ---- liquidityInfo ---------------------------------------------------------
  await test('liquidityInfo proxies Liquidity.loadState(true) and degrades without it', async () => {
    let forced = null;
    const liquidity = { async loadState(force) { forced = force; return { blockTreasury: 50000, totalFeesUsd: 0 }; } };
    const dt = DevTools.create({ store: fakeStore(), wiring: null, liquidity });
    const st = await dt.liquidityInfo();
    assert.strictEqual(forced, true);
    assert.strictEqual(st.blockTreasury, 50000);
    const dt2 = DevTools.create({ store: fakeStore(), wiring: null, liquidity: null });
    const miss = await dt2.liquidityInfo();
    assert.ok(/unavailable/.test(miss.error));
  });

  // ---- flags + diagnostics ---------------------------------------------------
  await test('flags only count while devMode is on (Flutter flag() semantics)', async () => {
    const store = fakeStore();
    const dt = DevTools.create({ store, wiring: null });
    await dt.setFlag('verboseLogs', true);
    assert.strictEqual(await dt.flag('verboseLogs'), false, 'devMode off -> flag off');
    await dt.setEnabled(true);
    assert.strictEqual(await dt.flag('verboseLogs'), true);
    const diag = await dt.diagnostics();
    assert.strictEqual(diag.devMode, true);
    assert.strictEqual(diag.flags.verboseLogs, true);
    assert.strictEqual(typeof diag.testnets, 'object');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
