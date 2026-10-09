// chains/registry.dart — the ChainRegistry: one ChainAdapter per ChainId, built
// from user config (endpoints + enabled chains + imported tokens). The UI, the
// exchange layer, and the AI agent talk to adapters only — never to a chain's
// RPC directly.
//
// Endpoints are CONFIG, resolved from the vault/settings with sane public
// defaults. No secret is ever hardcoded here.
import 'block.dart';
import 'chain_adapter.dart';
import 'custom_network.dart';
import 'evm.dart';
import 'solana.dart';
import 'utxo.dart';

export 'custom_network.dart';

/// Per-chain endpoint configuration.
class EndpointCfg {
  const EndpointCfg({this.rpcUrl, this.esplora, this.chainId, this.alchemyUrl});
  final String? rpcUrl;
  final String? esplora;
  final int? chainId;

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
];

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
  'bitcoin': EndpointCfg(esplora: 'https://blockstream.info/api'),
  'litecoin': EndpointCfg(esplora: 'https://litecoinspace.org/api'),
  'dogecoin': EndpointCfg(), // user must supply (no public Esplora default)
  'solana': EndpointCfg(rpcUrl: 'https://api.mainnet-beta.solana.com'),
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
  ],
  'base': const [
    AssetRef(
        chain: 'base',
        kind: 'erc20',
        symbol: 'USDC',
        decimals: 6,
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
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
            'solana'
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
        alchemyUrl: n.alchemy ? cfg?.alchemyUrl : null,
        alchemyRpc: n.alchemy ? alchemyFor(cfg?.alchemyUrl) : null,
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
    adapters['solana'] = SolanaAdapter(
      rpcUrl: ep['solana']?.rpcUrl,
      rpc: rpcFor(ep['solana']?.rpcUrl),
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
