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
  // BlockAdapter is browser-only (wasm); optional in node.
  const Block = inNode ? safeRequire('./block.js') : global.BlockAdapter;
  function safeRequire(p) { try { return require(p); } catch { return null; } }

  // Default public endpoints — every one is overridable via config.
  const DEFAULT_ENDPOINTS = {
    ethereum: { rpcUrl: 'https://ethereum-rpc.publicnode.com', chainId: 1 },
    base:     { rpcUrl: 'https://base-rpc.publicnode.com', chainId: 8453 },
    bitcoin:  { esplora: 'https://blockstream.info/api' },
    litecoin: { esplora: 'https://litecoinspace.org/api' },
    dogecoin: { esplora: null }, // user must supply (no public Esplora default)
  };

  // Default first-class tokens (USDC/USDT) per EVM chain. Config-overridable.
  const DEFAULT_TOKENS = {
    ethereum: [
      { chain: 'ethereum', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
      { chain: 'ethereum', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    ],
    base: [
      { chain: 'base', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    ],
  };

  function createRegistry(config) {
    config = config || {};
    const endpoints = Object.assign({}, DEFAULT_ENDPOINTS, config.endpoints || {});
    const tokens = Object.assign({}, DEFAULT_TOKENS, config.tokens || {});
    const enabledSet = new Set(config.enabled || ['block', 'ethereum', 'base', 'bitcoin', 'litecoin', 'dogecoin']);
    enabledSet.add('block'); // BLOCK is always enabled

    const adapters = {};
    // EVM chains (share the same m/44'/60' key)
    adapters.ethereum = Evm.createEvmAdapter({ id: 'ethereum', chainId: endpoints.ethereum.chainId || 1, symbol: 'ETH', rpcUrl: endpoints.ethereum.rpcUrl, endpoint: endpoints.ethereum.endpoint, explorer: 'https://etherscan.io/tx/' });
    adapters.base = Evm.createEvmAdapter({ id: 'base', chainId: endpoints.base.chainId || 8453, symbol: 'ETH', rpcUrl: endpoints.base.rpcUrl, endpoint: endpoints.base.endpoint, explorer: 'https://basescan.org/tx/' });
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
      // Unlock every secp256k1 adapter with the HD root; BLOCK uses its own session.
      unlock(root) { for (const id of Object.keys(adapters)) { const a = adapters[id]; if (a.unlock) a.unlock(root); } },
      lock() { for (const id of Object.keys(adapters)) { const a = adapters[id]; if (a.lock) a.lock(); } },
      adapters,
    };
  }

  global.ChainRegistry = { createRegistry, DEFAULT_ENDPOINTS, DEFAULT_TOKENS };
  if (inNode) module.exports = global.ChainRegistry;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
