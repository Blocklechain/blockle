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
  const Custom = inNode ? require('./custom-networks.js') : global.CustomNetworks;
  // Solana (ed25519, SLIP-0010); pure JS, available in both node + browser.
  const Solana = inNode ? require('./solana.js') : global.SolanaAdapter;
  // Tron (secp256k1, m/44'/195'); TRX + TRC-20 via TronGrid REST. Pure JS.
  const Tron = inNode ? require('./tron.js') : global.TronAdapter;
  // TON (ed25519, SLIP-0010 m/44'/607'); native + jetton via toncenter v2. Pure JS.
  const Ton = inNode ? require('./ton.js') : global.TonAdapter;
  // XRP Ledger (secp256k1, m/44'/144'); native XRP via rippled JSON-RPC. Pure JS.
  const Xrp = inNode ? require('./xrp.js') : global.XrpAdapter;
  // Stellar (ed25519, SLIP-0010 m/44'/148'); native XLM via Horizon REST. Pure JS.
  const Stellar = inNode ? require('./stellar.js') : global.StellarAdapter;
  // Tezos (ed25519, SLIP-0010 m/44'/1729'/0'/0'); native XTZ via node RPC. Pure JS.
  const Tezos = inNode ? require('./tezos.js') : global.TezosAdapter;
  // Cardano (Icarus CIP-3 + CIP-1852 BIP32-Ed25519 m/1852'/1815'/0'); native ADA
  // via keyless Koios (Blockfrost opt-in). Pure JS.
  const Cardano = inNode ? require('./cardano.js') : global.CardanoAdapter;
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
    // Additional networks — same key, same adapter, keyless public RPCs.
    linea:     { chainId: 59144, symbol: 'ETH',  explorer: 'https://lineascan.build/tx/' },
    scroll:    { chainId: 534352, symbol: 'ETH', explorer: 'https://scrollscan.com/tx/' },
    unichain:  { chainId: 130,   symbol: 'ETH',  explorer: 'https://uniscan.xyz/tx/' },
    gnosis:    { chainId: 100,   symbol: 'XDAI', explorer: 'https://gnosisscan.io/tx/' },
    mantle:    { chainId: 5000,  symbol: 'MNT',  explorer: 'https://mantlescan.xyz/tx/' },
    celo:      { chainId: 42220, symbol: 'CELO', explorer: 'https://celoscan.io/tx/' },
    cronos:    { chainId: 25,    symbol: 'CRO',  explorer: 'https://cronoscan.com/tx/' },
    sonic:     { chainId: 146,   symbol: 'S',    explorer: 'https://sonicscan.org/tx/' },
    berachain: { chainId: 80094, symbol: 'BERA', explorer: 'https://berascan.com/tx/' },
    opbnb:     { chainId: 204,   symbol: 'BNB',  explorer: 'https://opbnbscan.com/tx/' },
    sei:       { chainId: 1329,  symbol: 'SEI',  explorer: 'https://seitrace.com/tx/' },
    hyperevm:  { chainId: 999,   symbol: 'HYPE', explorer: 'https://hyperevmscan.io/tx/' },
  };
  function isEvm(id) { return !!EVM_CHAINS[id]; }
  const NETWORK_NAMES = {
    block: 'BLOCK', bitcoin: 'Bitcoin', litecoin: 'Litecoin', dogecoin: 'Dogecoin', bitcoincash: 'Bitcoin Cash', solana: 'Solana', tron: 'Tron', ton: 'TON',
    ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', bnb: 'BNB Chain',
    avalanche: 'Avalanche', linea: 'Linea', scroll: 'Scroll', unichain: 'Unichain', gnosis: 'Gnosis', mantle: 'Mantle',
    celo: 'Celo', cronos: 'Cronos', sonic: 'Sonic', berachain: 'Berachain', opbnb: 'opBNB', sei: 'Sei',
    hyperevm: 'HyperEVM', tezos: 'Tezos',
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
    linea:    'https://linea-mainnet.g.alchemy.com/v2/',
    scroll:   'https://scroll-mainnet.g.alchemy.com/v2/',
    unichain: 'https://unichain-mainnet.g.alchemy.com/v2/',
    gnosis:   'https://gnosis-mainnet.g.alchemy.com/v2/',
    mantle:   'https://mantle-mainnet.g.alchemy.com/v2/',
    celo:     'https://celo-mainnet.g.alchemy.com/v2/',
    sonic:    'https://sonic-mainnet.g.alchemy.com/v2/',
    berachain: 'https://berachain-mainnet.g.alchemy.com/v2/',
    opbnb:    'https://opbnb-mainnet.g.alchemy.com/v2/',
    sei:      'https://sei-mainnet.g.alchemy.com/v2/',
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
    linea:     { rpcUrl: 'https://linea-rpc.publicnode.com', chainId: 59144 },
    scroll:    { rpcUrl: 'https://scroll-rpc.publicnode.com', chainId: 534352 },
    unichain:  { rpcUrl: 'https://unichain-rpc.publicnode.com', chainId: 130 },
    gnosis:    { rpcUrl: 'https://gnosis-rpc.publicnode.com', chainId: 100 },
    mantle:    { rpcUrl: 'https://mantle-rpc.publicnode.com', chainId: 5000 },
    celo:      { rpcUrl: 'https://celo-rpc.publicnode.com', chainId: 42220 },
    cronos:    { rpcUrl: 'https://cronos-evm-rpc.publicnode.com', chainId: 25 },
    sonic:     { rpcUrl: 'https://sonic-rpc.publicnode.com', chainId: 146 },
    berachain: { rpcUrl: 'https://berachain-rpc.publicnode.com', chainId: 80094 },
    opbnb:     { rpcUrl: 'https://opbnb-rpc.publicnode.com', chainId: 204 },
    sei:       { rpcUrl: 'https://sei-evm-rpc.publicnode.com', chainId: 1329 },
    hyperevm:  { rpcUrl: 'https://rpc.hyperliquid.xyz/evm', chainId: 999 },
    bitcoin:   { esplora: 'https://blockstream.info/api' },
    litecoin:  { esplora: 'https://litecoinspace.org/api' },
    dogecoin:  { esplora: 'https://doge-esplora.blockle.org' }, // Blockle DOGE Esplora shim (operator-overridable)
    bitcoincash: { esplora: 'https://bch.imaginary.cash/api' }, // BCH Fulcrum/Esplora-style REST (operator-overridable)
    // Solana mainnet JSON-RPC — public default, config-overridable. No key.
    // Same-origin Solana RPC relay — public RPCs 403/block the browser directly
    // (api.mainnet-beta blocks sends, publicnode 403s browser origins). The server
    // forwards to SOLANA_RPC. See POST /account/api/sol/rpc.
    solana:    { rpcUrl: 'https://blockle.org/account/api/sol/rpc' },
    // Tron mainnet TronGrid REST — public default, config-overridable. API key optional.
    tron:      { api: 'https://api.trongrid.io' },
    // TON mainnet toncenter v2 jsonRPC — public default, config-overridable. API key optional.
    ton:       { api: 'https://toncenter.com/api/v2' },
    // XRP Ledger mainnet rippled JSON-RPC — public default, config-overridable.
    xrp:       { rpc: 'https://xrplcluster.com' },
    // Stellar mainnet Horizon REST — public default, config-overridable.
    stellar:   { horizon: 'https://horizon.stellar.org' },
    // Tezos mainnet node RPC — public default, config-overridable (alt: https://rpc.tzkt.io/mainnet).
    tezos:     { rpc: 'https://mainnet.api.tez.ie' },
    // Cardano mainnet — KEYLESS Koios by default; Blockfrost only when a
    // { blockfrost: { projectId } } is configured. Config-overridable.
    cardano:   { koios: 'https://api.koios.rest/api/v1' },
  };

  // Default first-class tokens (USDC/USDT, native issuances) per EVM chain.
  // Config-overridable. These are the known-list fallback when auto-detect is
  // off or a chain isn't Alchemy-backed.
  const DEFAULT_TOKENS = {
    ethereum: [
      { chain: 'ethereum', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
      { chain: 'ethereum', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
      { chain: 'ethereum', kind: 'erc20', symbol: 'XAUT', decimals: 6, address: '0x68749665FF8D2d112Fa859AA293F07A622782F38' },
      { chain: 'ethereum', kind: 'erc20', symbol: 'LINK', decimals: 18, address: '0x514910771AF9Ca656af840dff83E8264EcF986CA' },
      { chain: 'ethereum', kind: 'erc20', symbol: 'POL', decimals: 18, address: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6' },
    ],
    base: [
      { chain: 'base', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
      { chain: 'base', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' },
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
    linea: [
      { chain: 'linea', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff' },
      { chain: 'linea', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xA219439258ca9da29E9Cc4cE5596924745e12B93' },
    ],
    scroll: [
      { chain: 'scroll', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4' },
      { chain: 'scroll', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df' },
    ],
    unichain: [
      { chain: 'unichain', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6' },
    ],
    gnosis: [
      { chain: 'gnosis', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83' },
      { chain: 'gnosis', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6' },
    ],
    mantle: [
      { chain: 'mantle', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9' },
      { chain: 'mantle', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE' },
    ],
    celo: [
      { chain: 'celo', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' },
      { chain: 'celo', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' },
    ],
    cronos: [
      { chain: 'cronos', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59' },
      { chain: 'cronos', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0x66e428c3f67a68878562e79A0234c1F83c208770' },
    ],
    sonic: [
      { chain: 'sonic', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894' },
    ],
    berachain: [
      { chain: 'berachain', kind: 'erc20', symbol: 'HONEY', decimals: 18, address: '0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce' },
    ],
    opbnb: [
      { chain: 'opbnb', kind: 'erc20', symbol: 'USDT', decimals: 18, address: '0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3' },
    ],
    sei: [
      { chain: 'sei', kind: 'erc20', symbol: 'USDC', decimals: 6, address: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1' },
      { chain: 'sei', kind: 'erc20', symbol: 'USDT', decimals: 6, address: '0xB75D0B03c06A926e488e2659DF1A861F860bD3d1' },
    ],
    solana: [
      { chain: 'solana', kind: 'spl', symbol: 'USDT', decimals: 6, mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
    ],
    tron: [
      { chain: 'tron', kind: 'trc20', symbol: 'USDT', decimals: 6, address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
    ],
    ton: [
      { chain: 'ton', kind: 'jetton', symbol: 'USDT', decimals: 6, master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' },
    ],
    // XRP + Stellar native-only to start (issued-currencies/assets can be added later).
    xrp: [],
    stellar: [],
    // Tezos native-only to start (FA1.2/FA2 tokens need an indexer; add later).
    tezos: [],
    // Cardano native-only (ADA). Native-assets (CNT) display-only in v1.
    cardano: [],
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
    const defaultEnabled = ['block', ...Object.keys(EVM_CHAINS), 'bitcoin', 'litecoin', 'dogecoin', 'bitcoincash', 'solana', 'tron', 'ton', 'xrp', 'stellar', 'tezos', 'cardano'];
    const enabledSet = new Set(config.enabled || defaultEnabled);
    enabledSet.add('block'); // BLOCK is always enabled

    const adapters = {};
    // EVM adapter specs (id -> createEvmAdapter opts) + a chainId -> id index, so
    // user custom networks can DEDUPE by chainId (override an existing net's RPC
    // rather than duplicate it) and new ones instantiate the SAME generic adapter.
    const evmSpecs = {};
    const byChainId = {};
    // Built-in EVM chains — ALL via the same adapter + the same m/44'/60' key.
    for (const id of Object.keys(EVM_CHAINS)) {
      const meta = EVM_CHAINS[id];
      const ep = endpoints[id] || {};
      const cid = ep.chainId || meta.chainId;
      evmSpecs[id] = {
        id, chainId: cid, symbol: meta.symbol,
        rpcUrl: ep.rpcUrl, endpoint: ep.endpoint, explorer: meta.explorer,
        alchemy: resolveAlchemy(alchemyCfg, id), // null unless a key is configured
        decimals: 18,
      };
      byChainId[cid] = id;
    }

    // User custom networks: { id, name, chainId, rpcUrl, nativeSymbol, decimals,
    // explorerUrl, tokenIndexerUrl? }. Validated/normalized here (defensively).
    // DEDUPE by chainId: a custom net whose chainId matches a built-in (or an
    // earlier custom) OVERRIDES that adapter's RPC + token indexer instead of
    // creating a duplicate; otherwise it instantiates a fresh EVM adapter.
    const customList = Custom && Custom.normalizeList
      ? Custom.normalizeList(config.custom || config.customNetworks || [])
      : [];
    const customMetaById = {};
    for (const net of customList) {
      const existingId = byChainId[net.chainId];
      if (existingId) {
        const spec = evmSpecs[existingId];
        if (net.rpcUrl) { spec.rpcUrl = net.rpcUrl; spec.endpoint = undefined; }
        if (net.tokenIndexerUrl) spec.alchemy = net.tokenIndexerUrl;
        continue;
      }
      // Avoid colliding with an existing adapter id (built-in EVM slug, or a
      // UTXO/BLOCK id) when the chainId is genuinely new.
      let id = net.id;
      if (evmSpecs[id] || id === 'bitcoin' || id === 'litecoin' || id === 'dogecoin' || id === 'bitcoincash' || id === 'block') id = id + '-' + net.chainId;
      evmSpecs[id] = {
        id, chainId: net.chainId, symbol: net.nativeSymbol,
        rpcUrl: net.rpcUrl, explorer: net.explorerUrl || '',
        alchemy: net.tokenIndexerUrl || null, decimals: net.decimals,
      };
      byChainId[net.chainId] = id;
      customMetaById[id] = { id, name: net.name, symbol: net.nativeSymbol, decimals: net.decimals, chainId: net.chainId, custom: true };
      enabledSet.add(id);
    }

    for (const id of Object.keys(evmSpecs)) adapters[id] = Evm.createEvmAdapter(evmSpecs[id]);
    // UTXO chains
    adapters.bitcoin  = Utxo.createUtxoAdapter('bitcoin',  { esplora: endpoints.bitcoin.esplora, endpoint: endpoints.bitcoin.endpoint });
    adapters.litecoin = Utxo.createUtxoAdapter('litecoin', { esplora: endpoints.litecoin.esplora, endpoint: endpoints.litecoin.endpoint });
    adapters.dogecoin = Utxo.createUtxoAdapter('dogecoin', { esplora: endpoints.dogecoin.esplora, endpoint: endpoints.dogecoin.endpoint });
    adapters.bitcoincash = Utxo.createUtxoAdapter('bitcoincash', { esplora: endpoints.bitcoincash.esplora, endpoint: endpoints.bitcoincash.endpoint });
    // Solana (SOL + SPL auto-detect) — ed25519/SLIP-0010, mainnet RPC is config.
    if (Solana && Solana.createSolanaAdapter) {
      const sep = endpoints.solana || {};
      adapters.solana = Solana.createSolanaAdapter({ rpcUrl: sep.rpcUrl, endpoint: sep.endpoint });
    }
    // Tron (TRX + TRC-20 auto-detect) — secp256k1 m/44'/195', TronGrid REST is config.
    if (Tron && Tron.createTronAdapter) {
      const tep = endpoints.tron || {};
      adapters.tron = Tron.createTronAdapter({ api: tep.api, apiKey: tep.apiKey, endpoint: tep.endpoint });
    }
    // TON (native + jetton) — ed25519 SLIP-0010 m/44'/607', toncenter v2 is config.
    if (Ton && Ton.createTonAdapter) {
      const tep = endpoints.ton || {};
      adapters.ton = Ton.createTonAdapter({ api: tep.api, apiKey: tep.apiKey, endpoint: tep.endpoint });
    }
    // XRP (native XRP) — secp256k1 m/44'/144', rippled JSON-RPC is config.
    if (Xrp && Xrp.createXrpAdapter) {
      const xep = endpoints.xrp || {};
      adapters.xrp = Xrp.createXrpAdapter({ rpc: xep.rpc, endpoint: xep.endpoint });
    }
    // Stellar (native XLM + issued assets) — ed25519 SLIP-0010 m/44'/148', Horizon is config.
    if (Stellar && Stellar.createStellarAdapter) {
      const sep = endpoints.stellar || {};
      adapters.stellar = Stellar.createStellarAdapter({ horizon: sep.horizon, endpoint: sep.endpoint });
    }
    // Tezos (native XTZ) — ed25519 SLIP-0010 m/44'/1729'/0'/0', node RPC is config.
    if (Tezos && Tezos.createTezosAdapter) {
      const zep = endpoints.tezos || {};
      adapters.tezos = Tezos.createTezosAdapter({ rpc: zep.rpc, endpoint: zep.endpoint });
    }
    // Cardano (native ADA) — Icarus CIP-3 + CIP-1852 BIP32-Ed25519, keyless Koios
    // by default (Blockfrost when a projectId is configured).
    if (Cardano && Cardano.createCardanoAdapter) {
      const cep = endpoints.cardano || {};
      adapters.cardano = Cardano.createCardanoAdapter({ koios: cep.koios, blockfrost: cep.blockfrost, endpoint: cep.endpoint });
    }
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
      // Every enabled network with its native symbol + display name — the lane
      // list for bots, the network picker, the price feed's native map.
      networks() {
        return [...enabledSet].filter((id) => adapters[id]).map((id) => {
          const a = adapters[id];
          const custom = customMetaById[id];
          const sym = (a && a.native && a.native.symbol) || (custom && custom.symbol) || id.toUpperCase();
          const name = custom ? custom.name : (NETWORK_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1));
          return { id, symbol: sym, name, evm: !!evmSpecs[id], chainId: evmSpecs[id] ? evmSpecs[id].chainId : undefined, custom: !!custom };
        });
      },
      endpoints(id) { return endpoints[id]; },
      tokensFor(id) { return tokens[id] || []; },

      // The user custom networks that produced their OWN adapter (not the ones
      // that merely overrode a built-in's RPC), each as { id, name, symbol,
      // decimals, chainId, custom:true }. Lets the UI label them properly.
      customNetworks() { return Object.keys(customMetaById).map((id) => customMetaById[id]); },
      // Display meta for any adapter id: custom entry, else undefined (the UI's
      // static table covers the built-ins).
      metaFor(id) { return customMetaById[id]; },

      // Auto-detect the tokens `address` actually holds on chain `id` (the
      // adapter's native discovery), MERGED with the default list + deduped by
      // (chain, contract|mint), non-zero first. `opts.spamFilter` hides
      // zero-balance / obviously-spam non-default rows. Best-effort — a
      // discovery failure still yields the known list.
      async discoverTokens(id, address, opts) {
        const a = adapters[id];
        if (!a) return [];
        let found = [];
        // the adapter also probes every token the wallet already knows about on
        // this chain (defaults + imports) so a keyless network still finds them.
        const hint = { knownTokens: (tokens[id] || []).concat((opts && opts.knownTokens) || []) };
        try { if (typeof a.discoverTokens === 'function') found = (await a.discoverTokens(address, hint)) || []; } catch { found = []; }
        if (!Discovery || !Discovery.mergeTokens) return (tokens[id] || []).concat(found);
        return Discovery.mergeTokens(tokens[id] || [], found, opts || {});
      },

      // Unlock every secp256k1 adapter with the HD root; BLOCK uses its own session.
      unlock(root) { for (const id of Object.keys(adapters)) { const a = adapters[id]; if (a.unlock) a.unlock(root); } },
      lock() { for (const id of Object.keys(adapters)) { const a = adapters[id]; if (a.lock) a.lock(); } },
      adapters,
    };
  }

  global.ChainRegistry = { createRegistry, DEFAULT_ENDPOINTS, DEFAULT_TOKENS, EVM_CHAINS, ALCHEMY_HOSTS, NETWORK_NAMES, resolveAlchemy, isEvm };
  if (inNode) module.exports = global.ChainRegistry;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
