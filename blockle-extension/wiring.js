// wiring.js — the glue that assembles the Pass-1 library layer into one object
// the popup UI + the in-wallet agent drive. It builds (lazily, from the user's
// saved settings):
//
//   • a ChainRegistry  (BLOCK + ETH/Base + BTC/LTC/DOGE, all endpoints config)
//   • an Accounts layer (derives one account per chain from the vault HD seed)
//   • a Venues registry (native Blockle + evmdex + jupiter, 0.05% treasury fee)
//   • a Telemetry emitter (anonymized, default-OFF)
//   • the agent tool CTX (getAddress/getBalance/buildSend/broadcast/listAssets/
//     estimateUsd/explorerTx/exchange/venues) the runner's allowlisted tools use.
//
// Nothing here holds a secret: keys live in the Wallet session + the adapters'
// in-memory root seed (set via registry.unlock), wiped on lock. Endpoints are
// read from Store settings so a settings change takes effect after reset().
//
// Global `Wiring`. Browser layer (depends on the Pass-1 globals being loaded).
(function (global) {
  'use strict';

  // Default agent-fee treasury (mirrors exchange/treasury.json). Overridable via
  // settings.agentTreasury. No private key ever lives here — recipient only.
  const DEFAULT_TREASURY = {
    agentTradeFeeBps: 5,
    mainnet: {
      solana: 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j',
      ethereum: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
      base: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    },
  };

  const STABLES = { USDC: 1, USDT: 1, DAI: 1, USD: 1 };

  let _registry = null, _accounts = null, _venues = null, _telemetry = null, _settings = null;

  async function settings() {
    if (_settings) return _settings;
    const s = await Store.get(['chainEndpoints', 'chainTokens', 'enabledChains', 'agentSettings']);
    _settings = {
      endpoints: s.chainEndpoints || {},     // { ethereum:{rpcUrl}, bitcoin:{esplora}, ... }
      tokens: s.chainTokens || {},           // { ethereum:[{...erc20}], ... } user-added
      enabled: s.enabledChains || null,
      agent: s.agentSettings || {},          // { treasury?, venues?, priceUsd?, telemetry?, collectorUrl? }
    };
    return _settings;
  }

  // Merge saved per-chain endpoints over the registry defaults WITHOUT dropping
  // the default fields (chainId etc.) that the registry needs.
  function mergedEndpoints(saved) {
    const D = ChainRegistry.DEFAULT_ENDPOINTS;
    const out = {};
    for (const id of Object.keys(D)) out[id] = Object.assign({}, D[id], saved[id] || {});
    return out;
  }

  // Default first-class tokens PLUS any the user imported, per chain.
  function mergedTokens(saved) {
    const D = ChainRegistry.DEFAULT_TOKENS;
    const out = {};
    const chains = new Set([...Object.keys(D), ...Object.keys(saved || {})]);
    for (const id of chains) {
      const base = (D[id] || []).slice();
      for (const t of (saved[id] || [])) {
        if (!base.some((x) => (x.address || '').toLowerCase() === (t.address || '').toLowerCase())) base.push(t);
      }
      out[id] = base;
    }
    return out;
  }

  async function registry() {
    if (_registry) return _registry;
    const s = await settings();
    _registry = ChainRegistry.createRegistry({
      endpoints: mergedEndpoints(s.endpoints),
      tokens: mergedTokens(s.tokens),
      enabled: s.enabled || undefined,
      block: { wallet: Wallet, chain: global.Chain, explorer: 'https://blockle.org/tx/' },
    });
    return _registry;
  }

  async function accounts() {
    if (_accounts) return _accounts;
    _accounts = Accounts.createAccounts({
      wallet: Wallet, hd: global.HD, registry: await registry(), crypto: global.BLKCrypto,
    });
    return _accounts;
  }

  async function venues() {
    if (_venues) return _venues;
    const s = await settings();
    const a = s.agent || {};
    _venues = Venues.create({
      treasury: a.treasury || DEFAULT_TREASURY,
      blockle: { exchange: global.Exchange },
      // DEX aggregators are opt-in: only enabled once the user gives a baseUrl.
      evmdex: a.evmdex && a.evmdex.baseUrl ? a.evmdex : { enabled: false },
      jupiter: a.jupiter && a.jupiter.baseUrl ? a.jupiter : { enabled: false },
      fetchImpl: typeof fetch !== 'undefined' ? fetch.bind(global) : undefined,
    });
    return _venues;
  }

  async function telemetry() {
    if (_telemetry) return _telemetry;
    const s = await settings();
    const a = s.agent || {};
    _telemetry = AgentTelemetry.create({
      store: Store,
      enabled: false, // DEFAULT OFF; loadEnabled() + the UI toggle flip it
      collectorUrl: a.collectorUrl || undefined,
      fetchImpl: typeof fetch !== 'undefined' ? fetch.bind(global) : undefined,
    });
    await _telemetry.loadEnabled();
    return _telemetry;
  }

  // ---- per-chain account helpers (used by the UI + the agent ctx) -----------
  async function accountFor(chain) { return (await accounts()).accountFor(chain); }

  async function getBalance(chain, tokens) {
    const acc = await accounts();
    const reg = await registry();
    const acct = await acc.accountFor(chain);
    const list = tokens || reg.tokensFor(chain);
    return reg.get(chain).getBalance(acct.address, list);
  }

  async function buildSend(chain, req) {
    const acc = await accounts();
    const reg = await registry();
    const acct = await acc.accountFor(chain); // ensures seed -> unlocks adapters
    return reg.get(chain).buildSend(acct, req);
  }

  async function broadcast(chain, built) {
    const reg = await registry();
    return reg.get(chain).broadcast(built);
  }

  async function listAssets() {
    const acc = await accounts();
    const reg = await registry();
    const out = [];
    for (const id of reg.enabled()) {
      try {
        const acct = await acc.accountFor(id);
        const bals = await reg.get(id).getBalance(acct.address, reg.tokensFor(id));
        out.push({ chain: id, address: acct.address, balances: bals });
      } catch (e) {
        out.push({ chain: id, error: String(e.message || e) });
      }
    }
    return out;
  }

  async function explorerTx(chain, txid) {
    try { return (await registry()).get(chain).explorerTx(txid); } catch { return undefined; }
  }

  // Coarse USD estimate for the policy's session cap. Stablecoins are ~$1; other
  // assets come from an optional settings.agent.priceUsd map (symbol -> price).
  // Returns null when unknown — the policy then rejects session-USD-capped actions
  // it cannot price (safety over convenience), which is the intended behavior.
  async function estimateUsd(asset, amount) {
    const s = await settings();
    const sym = (typeof asset === 'string' ? asset : (asset && asset.symbol) || '').toUpperCase();
    const prices = (s.agent && s.agent.priceUsd) || {};
    let unit = null, dec = 6;
    if (STABLES[sym] != null) { unit = STABLES[sym]; dec = 6; }
    else if (prices[sym] != null) { unit = Number(prices[sym]); dec = prices[sym + '_decimals'] != null ? Number(prices[sym + '_decimals']) : 8; }
    if (unit == null) return null;
    try { return (Number(amount) / Math.pow(10, dec)) * unit; } catch { return null; }
  }

  // The agent tool CTX: exactly the capabilities tools.js wires to. Value-moving
  // tools still go through the runner's cap -> confirm -> commit rails.
  function agentCtx() {
    return {
      getAddress: async (chain) => (await accountFor(chain)).address,
      getBalance,
      buildSend,
      broadcast,
      listAssets,
      estimateUsd,
      explorerTx,
      exchange: global.Exchange,
      venues: _venues,            // populated by ensureAgentDeps()
    };
  }

  // Make sure venues + telemetry exist before building an agent ctx.
  async function ensureAgentDeps() {
    await venues();
    await telemetry();
    return { venues: _venues, telemetry: _telemetry };
  }

  // Drop every cached, settings-derived object + wipe any decrypted root seed in
  // the adapters. Call on: settings saved, wallet switched, lock, kill.
  function reset() {
    try { if (_registry) _registry.lock(); } catch {}
    _registry = null; _accounts = null; _venues = null; _telemetry = null; _settings = null;
  }

  global.Wiring = {
    DEFAULT_TREASURY,
    settings, registry, accounts, venues, telemetry,
    accountFor, getBalance, buildSend, broadcast, listAssets, explorerTx, estimateUsd,
    agentCtx, ensureAgentDeps, reset,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Wiring;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
