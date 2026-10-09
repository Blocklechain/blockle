// chains/registry.dart — the ChainRegistry: one ChainAdapter per ChainId, built
// from user config (endpoints + enabled chains + imported tokens). The UI, the
// exchange layer, and the AI agent talk to adapters only — never to a chain's
// RPC directly.
//
// Endpoints are CONFIG, resolved from the vault/settings with sane public
// defaults. No secret is ever hardcoded here.
import 'block.dart';
import 'chain_adapter.dart';
import 'evm.dart';
import 'solana.dart';
import 'utxo.dart';

/// Per-chain endpoint configuration.
class EndpointCfg {
  const EndpointCfg({this.rpcUrl, this.esplora, this.chainId});
  final String? rpcUrl;
  final String? esplora;
  final int? chainId;
}

const Map<String, EndpointCfg> defaultEndpoints = {
  'ethereum':
      EndpointCfg(rpcUrl: 'https://ethereum-rpc.publicnode.com', chainId: 1),
  'base': EndpointCfg(rpcUrl: 'https://base-rpc.publicnode.com', chainId: 8453),
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
};

class ChainRegistry {
  ChainRegistry._(this._adapters, this._endpoints, this._tokens, this._enabled);

  final Map<String, ChainAdapter> _adapters;
  final Map<String, EndpointCfg> _endpoints;
  final Map<String, List<AssetRef>> _tokens;
  final Set<String> _enabled;

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
    BlockSignerBridge? block,
    JsonRpcFn Function(String url)? rpcBuilder,
    HttpGetFn Function(String base)? getBuilder,
    HttpPostFn Function(String base)? postBuilder,
  }) {
    final ep = {...defaultEndpoints, ...?endpoints};
    final tk = {...defaultTokens, ...?tokens};
    final enabledSet = {
      ...(enabled ??
          ['block', 'ethereum', 'base', 'bitcoin', 'litecoin', 'dogecoin', 'solana']),
      'block', // BLOCK is always enabled
    };

    JsonRpcFn? rpcFor(String? url) =>
        (rpcBuilder != null && url != null) ? rpcBuilder(url) : null;
    HttpGetFn? getFor(String? base) =>
        (getBuilder != null && base != null) ? getBuilder(base) : null;
    HttpPostFn? postFor(String? base) =>
        (postBuilder != null && base != null) ? postBuilder(base) : null;

    final adapters = <String, ChainAdapter>{};
    adapters['ethereum'] = EvmAdapter(
      id: 'ethereum',
      chainId: ep['ethereum']?.chainId ?? 1,
      symbol: 'ETH',
      rpcUrl: ep['ethereum']?.rpcUrl,
      rpc: rpcFor(ep['ethereum']?.rpcUrl),
      explorer: 'https://etherscan.io/tx/',
    );
    adapters['base'] = EvmAdapter(
      id: 'base',
      chainId: ep['base']?.chainId ?? 8453,
      symbol: 'ETH',
      rpcUrl: ep['base']?.rpcUrl,
      rpc: rpcFor(ep['base']?.rpcUrl),
      explorer: 'https://basescan.org/tx/',
    );
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

    return ChainRegistry._(adapters, ep, tk, enabledSet);
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
