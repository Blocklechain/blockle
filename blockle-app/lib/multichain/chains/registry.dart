// chains/registry.dart — the ChainRegistry: one ChainAdapter per ChainId, built
// from user config (endpoints + enabled chains + imported tokens). The UI, the
// exchange layer, and the AI agent talk to adapters only — never to a chain's
// RPC directly.
//
// Endpoints are CONFIG, resolved from the vault/settings with sane public
// defaults. No secret is ever hardcoded here.
import 'block.dart';
import 'cardano.dart';
import 'chain_adapter.dart';
import 'custom_network.dart';
import 'evm.dart';
import 'solana.dart';
import 'stellar.dart';
import 'tezos.dart';
import 'ton.dart';
import 'tron.dart';
import 'utxo.dart';
import 'xrp.dart';

export 'custom_network.dart';

/// Per-chain endpoint configuration.
class EndpointCfg {
  const EndpointCfg(
      {this.rpcUrl,
      this.esplora,
      this.chainId,
      this.alchemyUrl,
      this.api,
      this.apiKey,
      this.horizon,
      this.koios,
      this.blockfrostUrl,
      this.blockfrostProjectId,
      this.jettonIndex});
  final String? rpcUrl;
  final String? esplora;
  final int? chainId;

  /// Cardano provider config. `koios` = keyless Koios REST base (default
  /// https://api.koios.rest/api/v1). Blockfrost is an ALT provider used only
  /// when `blockfrostProjectId` is set — `blockfrostUrl` is its base and
  /// `blockfrostProjectId` the project key (CONFIG, never hardcoded/logged).
  final String? koios;
  final String? blockfrostUrl;
  final String? blockfrostProjectId;

  /// Stellar Horizon REST base (e.g. https://horizon.stellar.org). CONFIG only;
  /// used solely by the Stellar adapter. Never a secret here. (XRP reuses
  /// [rpcUrl] for its rippled JSON-RPC endpoint.)
  final String? horizon;

  /// TronGrid REST base (e.g. https://api.trongrid.io) + optional read-only API
  /// key. CONFIG only; used solely by the Tron adapter. Never a secret here.
  final String? api;
  final String? apiKey;

  /// Config-overridable jetton-index REST base for TON held-token auto-detect
  /// (e.g. a TON API host, or a toncenter v3 host). CONFIG only, no secret; null
  /// => jetton auto-detect OFF (curated-list fallback). Used only by the TON
  /// adapter's discoverTokens.
  final String? jettonIndex;

  /// Alchemy indexer base URL *including* the read-only API key, used for EVM
  /// ERC-20 auto-detect. CONFIG only; null => auto-detect OFF (known-list
  /// fallback). Never hardcoded, never logged.
  final String? alchemyUrl;
}

/// The EVM networks this wallet supports — all driven by the SAME EvmAdapter and
/// the SAME secp256k1 account (one address across every EVM chain, m/44'/60').
/// `alchemy` = whether Alchemy's getTokenBalances enhanced API covers the chain
/// (ethereum/base/arbitrum/optimism/polygon). BNB + Avalanche are not, so they
/// fall back to native + the curated default token list.
class EvmNet {
  const EvmNet(this.id, this.chainId, this.symbol, this.explorer,
      {this.alchemy = false});
  final String id;
  final int chainId;
  final String symbol;
  final String explorer;
  final bool alchemy;
}

const List<EvmNet> evmNets = [
  EvmNet('ethereum', 1, 'ETH', 'https://etherscan.io/tx/', alchemy: true),
  EvmNet('base', 8453, 'ETH', 'https://basescan.org/tx/', alchemy: true),
  EvmNet('arbitrum', 42161, 'ETH', 'https://arbiscan.io/tx/', alchemy: true),
  EvmNet('optimism', 10, 'ETH', 'https://optimistic.etherscan.io/tx/',
      alchemy: true),
  EvmNet('polygon', 137, 'POL', 'https://polygonscan.com/tx/', alchemy: true),
  EvmNet('bnb', 56, 'BNB', 'https://bscscan.com/tx/'),
  EvmNet('avalanche', 43114, 'AVAX', 'https://snowtrace.io/tx/'),
  // HyperEVM (Hyperliquid L1 EVM). Not on Alchemy → native + curated tokens.
  EvmNet('hyperevm', 999, 'HYPE', 'https://hyperevmscan.io/tx/'),
];

/// Blockle-provided Alchemy key, injected at build time via
/// --dart-define=BLOCKLE_ALCHEMY_KEY=… (a GitHub Actions secret), NOT committed.
/// Powers EVM token auto-discovery (and NFT reads) for EVERY user out of the box
/// — there is no user-supplied Alchemy key. Empty on local builds → off.
const String kAlchemyKey =
    String.fromEnvironment('BLOCKLE_ALCHEMY_KEY', defaultValue: '');

/// Alchemy network subdomain per built-in chain (only those Alchemy covers).
const Map<String, String> _alchemyNet = {
  'ethereum': 'eth-mainnet',
  'base': 'base-mainnet',
  'arbitrum': 'arb-mainnet',
  'optimism': 'opt-mainnet',
  'polygon': 'polygon-mainnet',
};

/// The Blockle Alchemy indexer URL for [chain], or null when no key is baked in
/// or the chain isn't on Alchemy. Ignores any user-supplied value by design.
String? ourAlchemyUrl(String chain) {
  if (kAlchemyKey.isEmpty) return null;
  final net = _alchemyNet[chain];
  if (net == null) return null;
  return 'https://$net.g.alchemy.com/v2/$kAlchemyKey';
}

const Map<String, EndpointCfg> defaultEndpoints = {
  'ethereum':
      EndpointCfg(rpcUrl: 'https://ethereum-rpc.publicnode.com', chainId: 1),
  'base': EndpointCfg(rpcUrl: 'https://base-rpc.publicnode.com', chainId: 8453),
  'arbitrum': EndpointCfg(
      rpcUrl: 'https://arbitrum-one-rpc.publicnode.com', chainId: 42161),
  'optimism':
      EndpointCfg(rpcUrl: 'https://optimism-rpc.publicnode.com', chainId: 10),
  'polygon': EndpointCfg(
      rpcUrl: 'https://polygon-bor-rpc.publicnode.com', chainId: 137),
  'bnb': EndpointCfg(rpcUrl: 'https://bsc-rpc.publicnode.com', chainId: 56),
  'avalanche': EndpointCfg(
      rpcUrl: 'https://avalanche-c-chain-rpc.publicnode.com', chainId: 43114),
  'hyperevm':
      EndpointCfg(rpcUrl: 'https://rpc.hyperliquid.xyz/evm', chainId: 999),
  'bitcoin': EndpointCfg(esplora: 'https://blockstream.info/api'),
  'litecoin': EndpointCfg(esplora: 'https://litecoinspace.org/api'),
  // Blockle-hosted Esplora shim for Dogecoin (operator-overridable, like the
  // other chains). The UTXO adapter is unchanged — just the endpoint config.
  'dogecoin': EndpointCfg(esplora: 'https://doge-esplora.blockle.org'),
  // Bitcoin Cash Fulcrum/Esplora-compatible REST (operator-overridable).
  'bitcoincash': EndpointCfg(esplora: 'https://bch.imaginary.cash/api'),
  'solana': EndpointCfg(rpcUrl: 'https://api.mainnet-beta.solana.com'),
  // TronGrid REST base (operator-overridable). The Tron adapter reads `api`
  // (+ optional `apiKey`); no secret is hardcoded here.
  'tron': EndpointCfg(api: 'https://api.trongrid.io'),
  // toncenter v2 base (operator-overridable). The TON adapter reads `api`
  // (+ optional `apiKey` → X-API-Key). The key is injected at build time via
  // --dart-define=TONCENTER_API_KEY=… (a GitHub Actions secret), NOT committed;
  // empty on local builds → keyless (rate-limited) fallback.
  'ton': EndpointCfg(
      api: 'https://toncenter.com/api/v2',
      apiKey: String.fromEnvironment('TONCENTER_API_KEY')),
  // rippled JSON-RPC base (operator-overridable; fallback
  // https://s1.ripple.com:51234). The XRP adapter reads `rpcUrl`.
  'xrp': EndpointCfg(rpcUrl: 'https://xrplcluster.com'),
  // Stellar Horizon REST base (operator-overridable). The Stellar adapter reads
  // `horizon`.
  'stellar': EndpointCfg(horizon: 'https://horizon.stellar.org'),
  // Tezos RPC base (operator-overridable; fallback https://rpc.tzkt.io/mainnet).
  // The Tezos adapter reads `rpcUrl`.
  'tezos': EndpointCfg(rpcUrl: 'https://mainnet.api.tez.ie'),
  // Cardano provider (operator-overridable). DEFAULT = KEYLESS Koios. Set
  // `blockfrostProjectId` to switch to Blockfrost. The adapter reads `koios` /
  // `blockfrost*`; no secret is hardcoded here.
  'cardano': EndpointCfg(
      koios: 'https://api.koios.rest/api/v1',
      blockfrostUrl: 'https://cardano-mainnet.blockfrost.io/api/v0',
      // Injected at build via --dart-define=BLOCKFROST_PROJECT_ID=… (CI secret),
      // NOT committed; empty on local builds → keyless Koios fallback.
      blockfrostProjectId: String.fromEnvironment('BLOCKFROST_PROJECT_ID')),
};

/// Default first-class tokens (USDC/USDT) per EVM chain. Config-overridable.
final Map<String, List<AssetRef>> defaultTokens = {
  'ethereum': const [
    AssetRef(
        chain: 'ethereum',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 6,
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
    AssetRef(
        chain: 'ethereum',
        kind: 'erc20',
        symbol: 'USDT',
        decimals: 6,
        address: '0xdAC17F958D2ee523a2206206994597C13D831ec7'),
    AssetRef(
        chain: 'ethereum',
        kind: 'erc20',
        symbol: 'XAUT',
        decimals: 6,
        address: '0x68749665FF8D2d112Fa859AA293F07A622782F38'),
    AssetRef(
        chain: 'ethereum',
        kind: 'erc20',
        symbol: 'LINK',
        decimals: 18,
        address: '0x514910771AF9Ca656af840dff83E8264EcF986CA'),
    AssetRef(
        chain: 'ethereum',
        kind: 'erc20',
        symbol: 'POL',
        decimals: 18,
        address: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'),
  ],
  'base': const [
    AssetRef(
        chain: 'base',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 6,
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    AssetRef(
        chain: 'base',
        kind: 'erc20',
        symbol: 'USDT',
        decimals: 6,
        address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'),
  ],
  'arbitrum': const [
    AssetRef(
        chain: 'arbitrum',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 6,
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
    AssetRef(
        chain: 'arbitrum',
        kind: 'erc20',
        symbol: 'USDT',
        decimals: 6,
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
  ],
  'optimism': const [
    AssetRef(
        chain: 'optimism',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 6,
        address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
    AssetRef(
        chain: 'optimism',
        kind: 'erc20',
        symbol: 'USDT',
        decimals: 6,
        address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'),
  ],
  'polygon': const [
    AssetRef(
        chain: 'polygon',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 6,
        address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
    AssetRef(
        chain: 'polygon',
        kind: 'erc20',
        symbol: 'USDT',
        decimals: 6,
        address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'),
  ],
  'bnb': const [
    AssetRef(
        chain: 'bnb',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 18,
        address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'),
    AssetRef(
        chain: 'bnb',
        kind: 'erc20',
        symbol: 'USDT',
        decimals: 18,
        address: '0x55d398326f99059fF775485246999027B3197955'),
  ],
  'avalanche': const [
    AssetRef(
        chain: 'avalanche',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 6,
        address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
    AssetRef(
        chain: 'avalanche',
        kind: 'erc20',
        symbol: 'USDT',
        decimals: 6,
        address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7'),
  ],
  // Canonical USDT SPL on Solana. `address` carries the SPL mint (the Solana
  // adapter reads AssetRef.address as the mint). Config-overridable.
  'solana': const [
    AssetRef(
        chain: 'solana',
        kind: 'spl',
        symbol: 'USDT',
        decimals: 6,
        address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  ],
  // Canonical USDT TRC-20 on Tron. `address` carries the TRC-20 contract (the
  // Tron adapter reads AssetRef.address as the contract). Config-overridable.
  'tron': const [
    AssetRef(
        chain: 'tron',
        kind: 'trc20',
        symbol: 'USDT',
        decimals: 6,
        address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
  ],
  // Canonical USDT jetton on TON. `address` carries the jetton MASTER (the TON
  // adapter reads AssetRef.address as the master, mirroring Solana's mint /
  // Tron's contract). Config-overridable.
  'ton': const [
    AssetRef(
        chain: 'ton',
        kind: 'jetton',
        symbol: 'USDT',
        decimals: 6,
        address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'),
  ],
  // Tezos: native XTZ only to start (FA1.2/FA2 tokens not shipped by default).
  'tezos': const [],
  // Cardano: native ADA only in v1 (native-asset/CNT sending is a v2 follow-up;
  // held CNT amounts are surfaced for display by the adapter).
  'cardano': const [],
  // Official BLOCK-20 tokens on the Blockle L1. WORLD has an AMM pool (also
  // auto-discovered); USDB has no pool, so listing it here is the only way a
  // held balance surfaces. Zero balances show as 0 (curated tokens aren't hidden).
  'block': const [
    AssetRef(
        chain: 'block',
        kind: 'block20',
        symbol: 'WORLD',
        decimals: 8,
        address:
            '32a97972001bd895203c4bb5ac4645af02d81263438968ea32e35140f130d00f',
        name: 'World',
        logo: 'https://blockle.org/world-token.svg'),
    AssetRef(
        chain: 'block',
        kind: 'block20',
        symbol: 'USDB',
        decimals: 6,
        address:
            '2beadf6b409427aacca1030778671ead6b9cdc5e817f1b6743c6d931c0c7ae7a',
        name: 'Blockle USD',
        logo: 'https://blockle.org/usdb-token.svg'),
  ],
};

class ChainRegistry {
  ChainRegistry._(this._adapters, this._endpoints, this._tokens, this._enabled,
      this._customNets);

  final Map<String, ChainAdapter> _adapters;
  final Map<String, EndpointCfg> _endpoints;
  final Map<String, List<AssetRef>> _tokens;
  final Set<String> _enabled;

  /// Genuinely-new user-added networks keyed by slug id (a custom net whose
  /// chainId matched a built-in is NOT here — it merely overrode that built-in's
  /// RPC, see [ChainRegistry.create]).
  final Map<String, CustomNetwork> _customNets;

  /// Build a registry. `block` is the app's BLOCK signer bridge (optional — in
  /// pure-Dart tests it is omitted; the extension/app always supplies it).
  ///
  /// Transport builders are OPTIONAL and additive: when supplied, the EVM /
  /// Solana / UTXO adapters are wired with those explicit, injectable closures
  /// (see lib/services/transports.dart) instead of their built-in package:http
  /// default. A test build swaps in offline senders this way; left null, the
  /// adapters behave exactly as before.
  factory ChainRegistry.create({
    Map<String, EndpointCfg>? endpoints,
    Map<String, List<AssetRef>>? tokens,
    List<String>? enabled,
    List<CustomNetwork>? customNetworks,
    BlockSignerBridge? block,
    JsonRpcFn Function(String url)? rpcBuilder,
    JsonRpcFn Function(String url)? alchemyBuilder,
    HttpGetFn Function(String base)? getBuilder,
    HttpPostFn Function(String base)? postBuilder,
  }) {
    final ep = {...defaultEndpoints, ...?endpoints};
    final tk = {...defaultTokens, ...?tokens};
    final enabledSet = {
      ...(enabled ??
          [
            'block',
            for (final n in evmNets) n.id,
            'bitcoin',
            'litecoin',
            'dogecoin',
            'bitcoincash',
            'solana',
            'tron',
            'ton',
            'xrp',
            'stellar',
            'tezos',
            'cardano'
          ]),
      'block', // BLOCK is always enabled
    };

    JsonRpcFn? rpcFor(String? url) =>
        (rpcBuilder != null && url != null) ? rpcBuilder(url) : null;
    JsonRpcFn? alchemyFor(String? url) =>
        (alchemyBuilder != null && url != null) ? alchemyBuilder(url) : null;
    HttpGetFn? getFor(String? base) =>
        (getBuilder != null && base != null) ? getBuilder(base) : null;
    HttpPostFn? postFor(String? base) =>
        (postBuilder != null && base != null) ? postBuilder(base) : null;

    final adapters = <String, ChainAdapter>{};
    // effective chainId -> adapter id, so user-added custom networks can be
    // DEDUPED by chainId (a custom net with a built-in's chainId overrides that
    // built-in's RPC rather than adding a duplicate).
    final chainIdToId = <int, String>{};
    for (final n in evmNets) {
      final cfg = ep[n.id];
      final cid = cfg?.chainId ?? n.chainId;
      chainIdToId[cid] = n.id;
      adapters[n.id] = EvmAdapter(
        id: n.id,
        chainId: cid,
        symbol: n.symbol,
        rpcUrl: cfg?.rpcUrl,
        rpc: rpcFor(cfg?.rpcUrl),
        // Always the Blockle-provided Alchemy indexer (baked in at build) — never
        // a user-supplied key. Null on keyless local builds → discovery simply off.
        alchemyUrl: n.alchemy ? ourAlchemyUrl(n.id) : null,
        alchemyRpc: n.alchemy ? alchemyFor(ourAlchemyUrl(n.id)) : null,
        explorer: n.explorer,
      );
    }

    // User-added custom EVM networks: SAME generic EvmAdapter + SAME secp256k1
    // account (m/44'/60'). Merge + dedupe by chainId.
    final customNets = <String, CustomNetwork>{};
    for (final cn in customNetworks ?? const <CustomNetwork>[]) {
      final collideId = chainIdToId[cn.chainId];
      if (collideId != null) {
        // A built-in (or an earlier custom) already owns this chainId. Override
        // its RPC / indexer in place — never duplicate the chain.
        final prior = adapters[collideId];
        final symbol = prior is EvmAdapter ? prior.symbol : cn.nativeSymbol;
        final dec = prior is EvmAdapter ? prior.decimals : cn.decimals;
        final explorer = (prior is EvmAdapter && prior.explorer.isNotEmpty)
            ? prior.explorer
            : cn.explorerUrl;
        // Override the RPC; keep the built-in's existing auto-detect unless the
        // custom net supplies its own indexer URL (additive — never silently
        // disables a configured Alchemy key).
        final indexer = cn.tokenIndexerUrl ??
            (prior is EvmAdapter ? prior.alchemyUrl : null);
        adapters[collideId] = EvmAdapter(
          id: collideId,
          chainId: cn.chainId,
          symbol: symbol,
          decimals: dec,
          rpcUrl: cn.rpcUrl,
          rpc: rpcFor(cn.rpcUrl),
          alchemyUrl: indexer,
          alchemyRpc: alchemyFor(indexer),
          explorer: explorer,
        );
        continue;
      }
      chainIdToId[cn.chainId] = cn.id;
      customNets[cn.id] = cn;
      adapters[cn.id] = EvmAdapter(
        id: cn.id,
        chainId: cn.chainId,
        symbol: cn.nativeSymbol,
        decimals: cn.decimals,
        rpcUrl: cn.rpcUrl,
        rpc: rpcFor(cn.rpcUrl),
        alchemyUrl: cn.tokenIndexerUrl,
        alchemyRpc: alchemyFor(cn.tokenIndexerUrl),
        explorer: cn.explorerUrl,
      );
    }
    enabledSet.addAll(customNets.keys);
    adapters['bitcoin'] = UtxoAdapter('bitcoin',
        esplora: ep['bitcoin']?.esplora,
        httpGet: getFor(ep['bitcoin']?.esplora),
        httpPost: postFor(ep['bitcoin']?.esplora));
    adapters['litecoin'] = UtxoAdapter('litecoin',
        esplora: ep['litecoin']?.esplora,
        httpGet: getFor(ep['litecoin']?.esplora),
        httpPost: postFor(ep['litecoin']?.esplora));
    adapters['dogecoin'] = UtxoAdapter('dogecoin',
        esplora: ep['dogecoin']?.esplora,
        httpGet: getFor(ep['dogecoin']?.esplora),
        httpPost: postFor(ep['dogecoin']?.esplora));
    adapters['bitcoincash'] = UtxoAdapter('bitcoincash',
        esplora: ep['bitcoincash']?.esplora,
        httpGet: getFor(ep['bitcoincash']?.esplora),
        httpPost: postFor(ep['bitcoincash']?.esplora));
    adapters['solana'] = SolanaAdapter(
      rpcUrl: ep['solana']?.rpcUrl,
      rpc: rpcFor(ep['solana']?.rpcUrl),
    );
    // Tron (account-model secp256k1): own adapter + TronGrid REST transport.
    // Reuses the injectable HttpPostFn builder (base = the TronGrid `api` URL)
    // exactly like the UTXO chains, so tests can swap in an offline poster.
    adapters['tron'] = TronAdapter(
      api: ep['tron']?.api,
      apiKey: ep['tron']?.apiKey,
      post: postFor(ep['tron']?.api),
      // GET transport + curated list power TRC-20 auto-detect (symbol/decimals
      // resolution; TronGrid's /trc20 map carries balances only).
      get: getFor(ep['tron']?.api),
      knownTokens: tk['tron'] ?? const [],
    );
    // TON (account-model ed25519): own adapter + toncenter v2 jsonRPC transport.
    // Reuses the injectable HttpPostFn builder (base = the toncenter `api` URL)
    // exactly like Tron, so tests can swap in an offline poster.
    adapters['ton'] = TonAdapter(
      api: ep['ton']?.api,
      apiKey: ep['ton']?.apiKey,
      post: postFor(ep['ton']?.api),
      // Jetton auto-detect: config-overridable index base + GET transport. Null
      // index => discovery is a no-op (curated-list fallback), no new secret.
      jettonIndex: ep['ton']?.jettonIndex,
      get: getFor(ep['ton']?.jettonIndex),
    );
    // XRP (account-model secp256k1): own adapter + rippled JSON-RPC transport.
    // Reuses the injectable HttpPostFn builder (base = the rippled `rpcUrl`),
    // like Tron/TON, so tests can swap in an offline poster.
    adapters['xrp'] = XrpAdapter(
      rpc: ep['xrp']?.rpcUrl,
      post: postFor(ep['xrp']?.rpcUrl),
    );
    // Stellar (account-model ed25519): own adapter + Horizon REST transport.
    // Uses the injectable HttpGetFn (sequence/balance reads) + HttpPostFn
    // (POST /transactions) builders, base = the Horizon `horizon` URL.
    adapters['stellar'] = StellarAdapter(
      horizon: ep['stellar']?.horizon,
      get: getFor(ep['stellar']?.horizon),
      post: postFor(ep['stellar']?.horizon),
    );
    // Tezos (account-model ed25519): own adapter + RPC transport. Uses the
    // injectable HttpGetFn (branch/counter/balance reads) + HttpPostFn (POST
    // /injection/operation) builders, base = the Tezos `rpcUrl`. The whole
    // operation is forged + signed CLIENT-SIDE; the node supplies only the
    // verifiable branch + counter.
    adapters['tezos'] = TezosAdapter(
      rpc: ep['tezos']?.rpcUrl,
      get: getFor(ep['tezos']?.rpcUrl),
      post: postFor(ep['tezos']?.rpcUrl),
    );
    // Cardano (BIP32-Ed25519 / Icarus): own adapter. Default KEYLESS Koios REST
    // (GET /tip, POST /address_utxos, POST /submittx); Blockfrost is an alt when
    // a project id is configured. CLIENT-BUILT + CLIENT-SIGNED; the provider
    // supplies only UTXOs + tip. Reuses the injectable HttpGetFn/HttpPostFn
    // builders (base = the Koios `koios` URL) so tests stay offline.
    adapters['cardano'] = CardanoAdapter(
      koios: ep['cardano']?.koios,
      blockfrostUrl: ep['cardano']?.blockfrostUrl,
      blockfrostProjectId: ep['cardano']?.blockfrostProjectId,
      get: getFor(ep['cardano']?.koios),
      post: postFor(ep['cardano']?.koios),
    );
    if (block != null) adapters['block'] = BlockAdapter(block);

    return ChainRegistry._(adapters, ep, tk, enabledSet, customNets);
  }

  ChainAdapter get(String id) {
    final a = _adapters[id];
    if (a == null) throw StateError('no adapter for chain: $id');
    return a;
  }

  bool has(String id) => _adapters.containsKey(id);

  List<String> enabled() =>
      _enabled.where((id) => _adapters.containsKey(id)).toList();

  EndpointCfg? endpoints(String id) => _endpoints[id];

  List<AssetRef> tokensFor(String id) => _tokens[id] ?? const [];

  /// Slug ids of the genuinely-new user-added networks (those that did NOT
  /// collide with a built-in chainId), in insertion order.
  List<String> customNetworkIds() => _customNets.keys.toList();

  /// The definition for a user-added network, or null if [id] is a built-in /
  /// unknown chain.
  CustomNetwork? customNetwork(String id) => _customNets[id];

  /// Unlock every secp256k1 / ed25519 adapter with the HD root; BLOCK uses its
  /// own engine session.
  void unlock(RootSecret root) {
    for (final a in _adapters.values) {
      a.unlock(root);
    }
  }

  void lock() {
    for (final a in _adapters.values) {
      a.lock();
    }
  }

  Map<String, ChainAdapter> get adapters => Map.unmodifiable(_adapters);
}
