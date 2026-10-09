// chains/registry.js — the ChainRegistry: one ChainAdapter per ChainId, built
// from user config (endpoints + enabled chains + imported tokens). The UI, the
// exchange layer, and the AI agent talk to adapters only — never to a chain's
// RPC directly.
//
// Endpoints are CONFIG, resolved from the vault/settings with sane public
// defaults. No secret is ever hardcoded here.
//
// Global `ChainRegistry` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const Evm = inNode ? require('./evm.js') : global.EvmAdapter;
  const Utxo = inNode ? require('./utxo.js') : global.UtxoAdapter;
  const Discovery = inNode ? require('./discovery.js') : global.TokenDiscovery;
  // BlockAdapter is browser-only (wasm); optional in node.
  const Block = inNode ? safeRequire('./block.js') : global.BlockAdapter;
  function safeRequire(p) { try { return require(p); } catch { return null; } }

  // The EVM networks we support, ALL on the same secp256k1 account (m/44'/60')
  // through the SAME EVM adapter — one address across every EVM chain. Native
  // symbol differs (POL/BNB/AVAX); everything else is a config-driven entry.
  const EVM_CHAINS = {
    ethereum:  { chainId: 1,     symbol: 'ETH',  explorer: 'https://etherscan.io/tx/' },
    base:      { chainId: 8453,  symbol: 'ETH',  explorer: 'https://basescan.org/tx/' },
    arbitrum:  { chainId: 42161, symbol: 'ETH',  explorer: 'https://arbiscan.io/tx/' },
    optimism:  { chainId: 10,    symbol: 'ETH',  explorer: 'https://optimistic.etherscan.io/tx/' },
    polygon:   { chainId: 137,   symbol: 'POL',  explorer: 'https://polygonscan.com/tx/' },
    bnb:       { chainId: 56,    symbol: 'BNB',  explorer: 'https://bscscan.com/tx/' },
    avalanche: { chainId: 43114, symbol: 'AVAX', explorer: 'https://snowtrace.io/tx/' },
  };

  // Alchemy host templates (base URL, NO key) for the networks Alchemy's
  // getTokenBalances supports. The read-only indexer key is CONFIG and appended
  // at resolve time — never hardcoded, never logged. BNB + Avalanche are absent
  // on purpose (not on Alchemy's getTokenBalances) → known-list fallback.
  const ALCHEMY_HOSTS = {
    ethereum: 'https://eth-mainnet.g.alchemy.com/v2/',
    base:     'https://base-mainnet.g.alchemy.com/v2/',
    arbitrum: 'https://arb-mainnet.g.alchemy.com/v2/',
    optimism: 'https://opt-mainnet.g.alchemy.com/v2/',
    polygon:  'https://polygon-mainnet.g.alchemy.com/v2/',
  };

  // Default public endpoints — every one is overridable via config.
  const DEFAULT_ENDPOINTS = {
    ethereum:  { rpcUrl: 'https://ethereum-rpc.publicnode.com', chainId: 1 },
    base:      { rpcUrl: 'https://base-rpc.publicnode.com', chainId: 8453 },
    arbitrum:  { rpcUrl: 'https://arbitrum-one-rpc.publicnode.com', chainId: 42161 },
    optimism:  { rpcUrl: 'https://optimism-rpc.publicnode.com', chainId: 10 },
    polygon:   { rpcUrl: 'https://polygon-bor-rpc.publicnode.com', chainId: 137 },
    bnb:       { rpcUrl: 'https://bsc-rpc.publicnode.com', chainId: 56 },
    avalanche: { rpcUrl: 'https://avalanche-c-chain-rpc.publicnode.com', chainId: 43114 },
    bitcoin:   { esplora: 'https://blockstream.info/api' },
    litecoin:  { esplora: 'https://litecoinspace.org/api' },
    dogecoin:  { esplora: null }, // user must supply (no public Esplora default)
  };

  // Default first-class tokens (USDC/USDT, native issuances) per EVM chain.
  // Config-overridable. These are the known-list fallback when auto-detect is
  // off or a chain isn't Alchemy-backed.
  const DEFAULT_TOKENS = {
    ethereum: [
      { chain: 'ethereum', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
      { chain: 'ethereum', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    ],
    base: [
      { chain: 'base', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    ],
    arbitrum: [
      { chain: 'arbitrum', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
      { chain: 'arbitrum', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' },
    ],
    optimism: [
      { chain: 'optimism', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
      { chain: 'optimism', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58' },
    ],
    polygon: [
      { chain: 'polygon', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
      { chain: 'polygon', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
    ],
    bnb: [
      { chain: 'bnb', kind: 'erc20', symbol: 'USDC', decimals: 18, address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
      { chain: 'bnb', kind: 'erc20', symbol: 'USDT', decimals: 18, address: '0x55d398326f99059fF775485246999027B3197955' },
    ],
    avalanche: [
      { chain: 'avalanche', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
      { chain: 'avalanche', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7' },
    ],
  };

  // Resolve the Alchemy indexer URL for a network: a per-network override
  // (string url, or {url}/{apiKey}) wins; otherwise a shared `apiKey` is
  // appended to the known host. Returns null => auto-detect OFF for this chain.
  function resolveAlchemy(alchemyCfg, id) {
    const a = alchemyCfg || {};
    const e = a[id];
    if (typeof e === 'string' && e) return e;
    if (e && e.url) return e.url;
    const key = (e && e.apiKey) || a.apiKey;
    if (key && ALCHEMY_HOSTS[id]) return ALCHEMY_HOSTS[id] + key;
    return null;
  }

  function createRegistry(config) {
    config = config || {};
    const endpoints = Object.assign({}, DEFAULT_ENDPOINTS, config.endpoints || {});
    const tokens = Object.assign({}, DEFAULT_TOKENS, config.tokens || {});
    // Alchemy config may come top-level (config.alchemy) or under the endpoints
    // bag (endpoints.alchemy), e.g. settings.chainEndpoints.alchemy.{apiKey|net}.
    const alchemyCfg = config.alchemy || endpoints.alchemy || {};
    const defaultEnabled = ['block', ...Object.keys(EVM_CHAINS), 'bitcoin', 'litecoin', 'dogecoin'];
    const enabledSet = new Set(config.enabled || defaultEnabled);
    enabledSet.add('block'); // BLOCK is always enabled

    const adapters = {};
    // EVM chains — ALL via the same adapter + the same m/44'/60' secp256k1 key.
    for (const id of Object.keys(EVM_CHAINS)) {
      const meta = EVM_CHAINS[id];
      const ep = endpoints[id] || {};
      adapters[id] = Evm.createEvmAdapter({
        id, chainId: ep.chainId || meta.chainId, symbol: meta.symbol,
        rpcUrl: ep.rpcUrl, endpoint: ep.endpoint, explorer: meta.explorer,
        alchemy: resolveAlchemy(alchemyCfg, id), // null unless a key is configured
      });
    }
    // UTXO chains
    adapters.bitcoin  = Utxo.createUtxoAdapter('bitcoin',  { esplora: endpoints.bitcoin.esplora, endpoint: endpoints.bitcoin.endpoint });
    adapters.litecoin = Utxo.createUtxoAdapter('litecoin', { esplora: endpoints.litecoin.esplora, endpoint: endpoints.litecoin.endpoint });
    adapters.dogecoin = Utxo.createUtxoAdapter('dogecoin', { esplora: endpoints.dogecoin.esplora, endpoint: endpoints.dogecoin.endpoint });
    // BLOCK (native identity) — only when the wrapper is available (browser)
    if (Block && Block.createBlockAdapter) adapters.block = Block.createBlockAdapter(config.block || {});

    return {
      get(id) {
        const a = adapters[id];
        if (!a) throw new Error('no adapter for chain: ' + id);
        return a;
      },
      has(id) { return !!adapters[id]; },
      enabled() { return [...enabledSet].filter((id) => adapters[id]); },
      endpoints(id) { return endpoints[id]; },
      tokensFor(id) { return tokens[id] || []; },

      // Auto-detect the tokens `address` actually holds on chain `id` (the
      // adapter's native discovery), MERGED with the default list + deduped by
      // (chain, contract|mint), non-zero first. `opts.spamFilter` hides
      // zero-balance / obviously-spam non-default rows. Best-effort — a
      // discovery failure still yields the known list.
      async discoverTokens(id, address, opts) {
        const a = adapters[id];
        if (!a) return [];
        let found = [];
        try { if (typeof a.discoverTokens === 'function') found = (await a.discoverTokens(address)) || []; } catch { found = []; }
        if (!Discovery || !Discovery.mergeTokens) return (tokens[id] || []).concat(found);
        return Discovery.mergeTokens(tokens[id] || [], found, opts || {});
      },

      // Unlock every secp256k1 adapter with the HD root; BLOCK uses its own session.
      unlock(root) { for (const id of Object.keys(adapters)) { const a = adapters[id]; if (a.unlock) a.unlock(root); } },
      lock() { for (const id of Object.keys(adapters)) { const a = adapters[id]; if (a.lock) a.lock(); } },
      adapters,
    };
  }

  global.ChainRegistry = { createRegistry, DEFAULT_ENDPOINTS, DEFAULT_TOKENS, EVM_CHAINS, ALCHEMY_HOSTS, resolveAlchemy };
  if (inNode) module.exports = global.ChainRegistry;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
