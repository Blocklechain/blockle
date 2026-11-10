// devtools.js — Developer mode + Developer Tools for the web wallet, mirroring
// the Flutter app's DevSettings (state/dev_settings.dart) + Developer screen
// (screens/developer_screen.dart) + kTestnetEndpoints (multichain/chains/
// registry.dart).
//
// Developer mode is OFF by default (Store key 'devmode'). When on, it unlocks
// the Developer Tools UI (per-chain testnet switch, JSON-RPC console, price
// probe, address inspector, liquidity inspector, feature flags). Everything
// here is a DEVELOPER affordance — none of it bypasses the money gates
// (approvals, allocation caps, the one signer). Turning Developer mode OFF
// returns every testnet-switched chain to mainnet, so a normal user is never
// left on a testnet.
//
// Testnet switching integrates with the EXISTING endpoint-override mechanism:
// overrides live under the Store key 'chainEndpoints' (per-chain objects) and
// Wiring.mergedEndpoints() merges them over ChainRegistry.DEFAULT_ENDPOINTS at
// registry build time. We write/remove per-chain entries in that same bag and
// call Wiring.reset() so the next registry() picks them up. No parallel
// endpoint store is invented here.
//
// Global `DevTools`; module.exports for the node test harness (Store / fetch /
// wiring / registry / price feed are all injectable via create()).
(function (global) {
  'use strict';

  const inNode = (typeof module !== 'undefined' && module.exports);
  function safeReq(p) { try { return require(p); } catch (_) { return null; } }
  const Registry = inNode ? safeReq('./chains/registry.js') : global.ChainRegistry;
  const PriceFeedMod = inNode ? safeReq('./prices.js') : global.PriceFeed;

  const KEY_DEVMODE = 'devmode';        // boolean, default FALSE
  const KEY_FLAGS = 'devflags';         // { name: bool } — only meaningful while devMode is on
  const KEY_ENDPOINTS = 'chainEndpoints'; // the SAME bag wiring.js/settings read

  // Public testnet endpoints per chain — mirrors Flutter kTestnetEndpoints for
  // the chains the web registry supports, using the WEB endpoint field names
  // (rpcUrl / esplora / horizon / api / rpc / koios — see DEFAULT_ENDPOINTS in
  // chains/registry.js). All keyless public infrastructure; config, not secrets.
  const TESTNETS = {
    ethereum:    { rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', chainId: 11155111 },
    base:        { rpcUrl: 'https://sepolia.base.org', chainId: 84532 },
    arbitrum:    { rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc', chainId: 421614 },
    optimism:    { rpcUrl: 'https://sepolia.optimism.io', chainId: 11155420 },
    polygon:     { rpcUrl: 'https://rpc-amoy.polygon.technology', chainId: 80002 },
    bnb:         { rpcUrl: 'https://bsc-testnet-rpc.publicnode.com', chainId: 97 },
    avalanche:   { rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc', chainId: 43113 },
    solana:      { rpcUrl: 'https://api.devnet.solana.com' },
    bitcoin:     { esplora: 'https://blockstream.info/testnet/api' },
    litecoin:    { esplora: 'https://litecoinspace.org/testnet/api' },
    bitcoincash: { esplora: 'https://api.haskoin.com/bchtest' },
    xrp:         { rpc: 'https://s.altnet.rippletest.net:51234' },
    stellar:     { horizon: 'https://horizon-testnet.stellar.org' },
    tron:        { api: 'https://nile.trongrid.io' },
    // the TON adapter POSTs to {api}/jsonRPC — base WITHOUT the /jsonRPC suffix.
    ton:         { api: 'https://testnet.toncenter.com/api/v2' },
    tezos:       { rpc: 'https://rpc.ghostnet.teztnets.com' },
    cardano:     { koios: 'https://preprod.koios.rest/api/v1' },
  };

  // The experimental feature flags the Developer screen exposes (mirrors
  // kDevFlags in dev_settings.dart). Each is OFF unless toggled AND devMode on.
  const FLAGS = [
    { key: 'verboseLogs', label: 'Verbose logging', desc: 'Extra console output for bot ticks + RPC.' },
    { key: 'showRawJson', label: 'Raw JSON everywhere', desc: 'Expose raw payloads in detail views.' },
    { key: 'unlockAllStrategies', label: 'Unlock all strategies', desc: 'Show experimental/unlisted bot strategies.' },
    { key: 'fakeFees', label: 'Simulate bot fees', desc: 'Seed the liquidity treasury with sample fees for testing.' },
  ];

  // Endpoint fields a testnet override can carry (used for the "is this chain
  // on its testnet" comparison — same semantics as Flutter isChainTestnet).
  const EP_FIELDS = ['rpcUrl', 'esplora', 'horizon', 'api', 'rpc', 'koios'];

  // Symbols the price-probe UI offers one tap away (Flutter's probe defaults to
  // SOL; the web list covers every native coin the registry ships).
  const PRICE_PRESETS = ['SOL', 'ETH', 'BTC', 'USDC', 'USDT', 'DOGE', 'LTC', 'BCH', 'BNB', 'AVAX', 'POL', 'TRX', 'TON', 'XRP', 'XLM', 'XTZ', 'ADA'];

  function msg(e) { return String((e && e.message) || e); }
  function up(s) { return String(s == null ? '' : s).toUpperCase(); }

  // create(deps) — build a DevTools instance. Every dependency is resolved
  // LAZILY from the live globals unless injected, so load order never matters
  // and node tests can fake Store / fetch / wiring / registry / price feed.
  // deps: { store, fetchImpl, wiring, registry, priceFeed, liquidity }
  function create(deps) {
    deps = deps || {};
    const store = () => deps.store || global.Store;
    const wiring = () => (deps.wiring !== undefined ? deps.wiring : global.Wiring);
    const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);

    async function registry() {
      if (deps.registry) return typeof deps.registry === 'function' ? deps.registry() : deps.registry;
      const w = wiring();
      if (w && typeof w.registry === 'function') return w.registry();
      if (Registry && Registry.createRegistry) return Registry.createRegistry({ endpoints: await effectiveEndpoints() });
      throw new Error('chain registry unavailable');
    }

    function priceFeed() {
      if (deps.priceFeed) return deps.priceFeed;
      const w = wiring();
      if (w && typeof w.prices === 'function') { const pf = w.prices(); if (pf) return pf; }
      if (PriceFeedMod && typeof PriceFeedMod.create === 'function') {
        deps.priceFeed = PriceFeedMod.create({ fetchImpl: fetchImpl || undefined, cacheMs: 20000 });
        return deps.priceFeed;
      }
      return null;
    }

    // After any endpoint change the settings-derived registry must be rebuilt —
    // the SAME invalidation every settings save uses. Best-effort.
    function resetWiring() { try { const w = wiring(); if (w && typeof w.reset === 'function') w.reset(); } catch (_) {} }

    // ---- Developer mode -----------------------------------------------------
    async function enabled() {
      try {
        const g = await store().get([KEY_DEVMODE]);
        const v = g && g[KEY_DEVMODE];
        return v === true || v === '1' || v === 1;
      } catch (_) { return false; } // default OFF, always
    }

    // Disabling MUST return every testnet-switched chain to mainnet.
    async function setEnabled(on) {
      on = !!on;
      if (!on) await clearAll();
      await store().set({ [KEY_DEVMODE]: on });
      return on;
    }

    // ---- Feature flags (only meaningful while devMode is on) ----------------
    async function flags() {
      try { const g = await store().get([KEY_FLAGS]); return (g && g[KEY_FLAGS]) || {}; } catch (_) { return {}; }
    }
    async function flag(name) {
      if (!(await enabled())) return false;
      const f = await flags();
      return f[name] === true;
    }
    async function setFlag(name, on) {
      const f = await flags();
      f[name] = !!on;
      await store().set({ [KEY_FLAGS]: f });
      return f;
    }

    // ---- Testnet switching (via the chainEndpoints override bag) ------------
    async function endpointOverrides() {
      try { const g = await store().get([KEY_ENDPOINTS]); return Object.assign({}, (g && g[KEY_ENDPOINTS]) || {}); } catch (_) { return {}; }
    }
    // Merged view (defaults + overrides) — what the registry actually uses.
    async function effectiveEndpoints() {
      const D = (Registry && Registry.DEFAULT_ENDPOINTS) || {};
      const saved = await endpointOverrides();
      const out = {};
      for (const id of Object.keys(D)) out[id] = Object.assign({}, D[id], saved[id] || {});
      for (const id of Object.keys(saved)) if (!out[id] && id !== 'alchemy') out[id] = Object.assign({}, saved[id]);
      return out;
    }

    function matchesTestnet(chain, override) {
      const t = TESTNETS[chain];
      if (!t || !override) return false;
      for (const f of EP_FIELDS) if (t[f] != null && override[f] === t[f]) return true;
      return false;
    }

    async function isTestnet(chain) {
      const saved = await endpointOverrides();
      return matchesTestnet(chain, saved[chain]);
    }

    // Chains that have a supported testnet AND exist in the web registry.
    function testnetCapableChains() {
      const D = (Registry && Registry.DEFAULT_ENDPOINTS) || null;
      return Object.keys(TESTNETS).filter((c) => !D || !!D[c]);
    }

    // Switch a chain to its public testnet (true) or back to mainnet (false).
    // Mirrors Flutter setChainTestnet: ON applies the full testnet endpoint as
    // the chain's override; OFF removes the chain's override entirely (back to
    // the built-in mainnet default). Returns false when no testnet is known.
    async function setTestnet(chain, on) {
      const saved = await endpointOverrides();
      if (!on) {
        if (saved[chain] === undefined) return true; // already mainnet default
        delete saved[chain];
        await store().set({ [KEY_ENDPOINTS]: saved });
        resetWiring();
        return true;
      }
      const cfg = TESTNETS[chain];
      if (!cfg) return false;
      saved[chain] = Object.assign({}, cfg);
      await store().set({ [KEY_ENDPOINTS]: saved });
      resetWiring();
      return true;
    }

    // Return EVERY testnet-switched chain to mainnet (called when Developer
    // mode turns off). Leaves non-testnet user overrides (custom RPCs) alone.
    async function clearAll() {
      const saved = await endpointOverrides();
      let changed = false;
      for (const chain of Object.keys(TESTNETS)) {
        if (matchesTestnet(chain, saved[chain])) { delete saved[chain]; changed = true; }
      }
      if (changed) {
        await store().set({ [KEY_ENDPOINTS]: saved });
        resetWiring();
      }
      return changed;
    }

    // ---- JSON-RPC / REST console -------------------------------------------
    // Run a raw call against the chain's EFFECTIVE endpoint (override-aware).
    // JSON-RPC chains (EVM / Solana / XRP / Tezos / TON) POST a 2.0 envelope;
    // REST chains (esplora / horizon / koios / trongrid) treat `method` as a
    // GET path. Returns pretty-printed JSON, or an 'Error: …' string.
    async function rpcProbe(chain, method, paramsJson) {
      if (!fetchImpl) return 'Error: fetch unavailable';
      try {
        const eps = await effectiveEndpoints();
        const ep = eps[chain];
        if (!ep) return 'Error: unknown chain ' + chain;
        const restBase = ep.esplora || ep.horizon || ep.koios || (chain === 'tron' ? ep.api : null);
        if (restBase) {
          const path = String(method || '').replace(/^GET\s+/i, '').trim();
          const url = restBase.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
          const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
          return pretty(await r.text());
        }
        let url = ep.rpcUrl || ep.rpc || null;
        if (!url && ep.api) url = ep.api.replace(/\/+$/, '') + '/jsonRPC'; // TON (toncenter v2)
        if (!url) return 'Error: no endpoint configured for ' + chain;
        let params;
        try {
          const raw = paramsJson == null ? '' : String(paramsJson).trim();
          params = raw === '' ? [] : JSON.parse(raw);
        } catch (e) { return 'Error: bad params JSON: ' + msg(e); }
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: String(method || '').trim(), params }),
        });
        return pretty(await r.text());
      } catch (e) { return 'Error: ' + msg(e); }
    }
    function pretty(text) {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return String(text); }
    }

    // ---- Price probe --------------------------------------------------------
    // BLOCK is NEVER priced in USD (no BLOCK/USD oracle) — the feed enforces it,
    // and we state it explicitly so the dev UI shows an honest note, not "no price".
    async function priceProbe(symbol) {
      const sym = up(symbol).trim();
      if (!sym) return { symbol: '', usd: null, note: 'no symbol' };
      const pf = priceFeed();
      if (!pf) return { symbol: sym, usd: null, note: 'price feed unavailable' };
      if (pf.isBlockDenominated && pf.isBlockDenominated(sym)) {
        return { symbol: sym, usd: null, note: 'BLOCK-denominated — never priced in USD' };
      }
      try {
        const usd = await pf.priceOf(sym);
        const change = pf.change24h ? pf.change24h(sym) : null;
        return usd != null ? { symbol: sym, usd, change24h: change } : { symbol: sym, usd: null, note: 'no price' };
      } catch (e) { return { symbol: sym, usd: null, note: 'Error: ' + msg(e) }; }
    }

    // ---- Address inspector --------------------------------------------------
    // Syntactic validity (per-chain shape check — public info only) + the live
    // native balance via the registry adapter. Never touches keys.
    function looksValid(chain, address) {
      const a = String(address || '').trim();
      if (!a) return false;
      const evm = Registry && Registry.isEvm ? Registry.isEvm(chain) : /^0x[0-9a-fA-F]{40}$/.test(a);
      if (evm || chain === 'ethereum') return /^0x[0-9a-fA-F]{40}$/.test(a);
      switch (chain) {
        case 'solana': return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
        case 'bitcoin': return /^(bc1[0-9a-z]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);
        case 'litecoin': return /^(ltc1[0-9a-z]{8,87}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);
        case 'dogecoin': return /^[DA9][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a);
        case 'bitcoincash': return /^((bitcoincash:)?[qp][0-9a-z]{41}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);
        case 'tron': return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
        case 'ton': return /^[EU]Q[A-Za-z0-9_-]{46}$/.test(a) || /^-?\d+:[0-9a-fA-F]{64}$/.test(a);
        case 'xrp': return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
        case 'stellar': return /^G[A-Z2-7]{55}$/.test(a);
        case 'tezos': return /^(tz[1-3]|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
        case 'cardano': return /^(addr1[0-9a-z]{20,120}|Ae2[1-9A-HJ-NP-Za-km-z]{20,120}|DdzFF[1-9A-HJ-NP-Za-km-z]{20,120})$/.test(a);
        case 'block': return /^block1[0-9a-z]{8,120}$/.test(a);
        default: return /^0x[0-9a-fA-F]{40}$/.test(a); // custom EVM networks
      }
    }

    async function inspectAddress(chain, address) {
      const addr = String(address || '').trim();
      const out = { chain, address: addr, valid: looksValid(chain, addr) };
      if (!out.valid) return out;
      try {
        const reg = await registry();
        const a = reg.get(chain);
        if (typeof a.addressBalance === 'function') {
          out.balance = String(await a.addressBalance(addr)); // base units
        } else {
          const rows = await a.getBalance(addr, []);
          const nb = (rows && rows[0]) || {};
          if (nb.error) out.error = String(nb.error);
          else { out.balance = String(nb.confirmed || '0'); if (nb.display != null) out.display = nb.display; }
        }
      } catch (e) { out.error = msg(e); }
      return out;
    }

    // ---- Liquidity inspector ------------------------------------------------
    // Proxy the Liquidity module's force-refreshed server state (treasury,
    // reserves, fees). Read-only.
    async function liquidityInfo() {
      const L = deps.liquidity !== undefined ? deps.liquidity : global.Liquidity;
      if (!L || typeof L.loadState !== 'function') return { error: 'liquidity module unavailable' };
      try { return await L.loadState(true); } catch (e) { return { error: msg(e) }; }
    }

    // ---- Diagnostics (mirrors the Flutter "Copy diagnostics" card) ----------
    async function diagnostics() {
      const tn = {};
      for (const c of testnetCapableChains()) tn[c] = await isTestnet(c);
      return {
        devMode: await enabled(),
        flags: await flags(),
        testnets: tn,
        testnetsAvailable: Object.keys(TESTNETS).length,
      };
    }

    return {
      TESTNETS, FLAGS, PRICE_PRESETS,
      pricePresets: PRICE_PRESETS,
      enabled, setEnabled,
      flags, flag, setFlag,
      testnetCapableChains, isTestnet, setTestnet, clearAll,
      effectiveEndpoints,
      rpcProbe, priceProbe, inspectAddress, liquidityInfo, diagnostics,
      create, // build an isolated instance (tests / previews)
    };
  }

  const API = create({});
  global.DevTools = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
