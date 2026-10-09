// chains/custom_network.dart — a USER-ADDED EVM network (MetaMask-style "Add
// network"). These are CONFIG, never secrets: a network definition is a slug, a
// human name, a chainId, an RPC URL, the native coin symbol/decimals, an
// explorer base, and an OPTIONAL Alchemy-style token-indexer URL for ERC-20
// auto-detect. They are persisted in normal settings (NOT the vault) and
// instantiated with the SAME generic EvmAdapter + the SAME secp256k1 account as
// every built-in EVM chain.
//
// Nothing here is ever logged. The only "sensitive-looking" field is the
// indexer URL, which may embed a read-only key — it is handled exactly like the
// built-in Alchemy URL (stored, never printed).
import 'dart:convert';

/// A user-added EVM network definition.
class CustomNetwork {
  const CustomNetwork({
    required this.id,
    required this.name,
    required this.chainId,
    required this.rpcUrl,
    this.nativeSymbol = 'ETH',
    this.decimals = 18,
    this.explorerUrl = '',
    this.tokenIndexerUrl,
  });

  /// Stable slug used as the adapter key / display id (e.g. `custom-mychain`).
  final String id;

  /// Human-readable network name shown in the UI.
  final String name;

  /// EVM chain id (positive integer). Drives EIP-155 replay protection.
  final int chainId;

  /// JSON-RPC endpoint. CONFIG only.
  final String rpcUrl;

  /// Native coin ticker (ETH / BNB / …).
  final String nativeSymbol;

  /// Native coin decimals (EVM chains are 18; kept configurable, defaults 18).
  final int decimals;

  /// Explorer tx base, e.g. `https://etherscan.io/tx/`. Optional.
  final String explorerUrl;

  /// OPTIONAL Alchemy-style indexer URL (may embed a READ-ONLY key) enabling
  /// ERC-20 auto-detect. null/empty => auto-detect OFF for this network.
  final String? tokenIndexerUrl;

  CustomNetwork copyWith({
    String? id,
    String? name,
    int? chainId,
    String? rpcUrl,
    String? nativeSymbol,
    int? decimals,
    String? explorerUrl,
    Object? tokenIndexerUrl = _unset,
  }) =>
      CustomNetwork(
        id: id ?? this.id,
        name: name ?? this.name,
        chainId: chainId ?? this.chainId,
        rpcUrl: rpcUrl ?? this.rpcUrl,
        nativeSymbol: nativeSymbol ?? this.nativeSymbol,
        decimals: decimals ?? this.decimals,
        explorerUrl: explorerUrl ?? this.explorerUrl,
        tokenIndexerUrl: identical(tokenIndexerUrl, _unset)
            ? this.tokenIndexerUrl
            : tokenIndexerUrl as String?,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'chainId': chainId,
        'rpcUrl': rpcUrl,
        'nativeSymbol': nativeSymbol,
        'decimals': decimals,
        'explorerUrl': explorerUrl,
        if (tokenIndexerUrl != null && tokenIndexerUrl!.isNotEmpty)
          'tokenIndexerUrl': tokenIndexerUrl,
      };

  factory CustomNetwork.fromJson(Map<String, dynamic> j) {
    final indexer = (j['tokenIndexerUrl'] as String?)?.trim();
    return CustomNetwork(
      id: '${j['id']}',
      name: '${j['name']}',
      chainId: (j['chainId'] as num).toInt(),
      rpcUrl: '${j['rpcUrl']}',
      nativeSymbol:
          (j['nativeSymbol'] as String?)?.trim().isNotEmpty == true
              ? '${j['nativeSymbol']}'
              : 'ETH',
      decimals: (j['decimals'] as num?)?.toInt() ?? 18,
      explorerUrl: (j['explorerUrl'] as String?) ?? '',
      tokenIndexerUrl:
          (indexer != null && indexer.isNotEmpty) ? indexer : null,
    );
  }

  static const Object _unset = Object();
}

/// Slugify a network name into a stable, filesystem/key-safe id prefixed with
/// `custom-` so it can never collide with a built-in chain id.
String slugifyNetworkName(String name) {
  final base = name
      .trim()
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
  return 'custom-${base.isEmpty ? 'network' : base}';
}

/// Validate a would-be custom network. Returns null when OK, else a short
/// human-readable reason. Pure — no network. The optional [existing] list is
/// used to reject duplicate chainIds / ids (pass the current store, excluding
/// the row being edited).
String? validateCustomNetwork(
  CustomNetwork n, {
  List<CustomNetwork> existing = const [],
}) {
  if (n.name.trim().isEmpty) return 'Enter a network name.';
  if (n.chainId <= 0) return 'Chain ID must be a positive integer.';
  final uri = Uri.tryParse(n.rpcUrl.trim());
  if (uri == null ||
      !(uri.scheme == 'http' || uri.scheme == 'https') ||
      uri.host.isEmpty) {
    return 'RPC URL must be a valid http(s) URL.';
  }
  if (n.tokenIndexerUrl != null && n.tokenIndexerUrl!.trim().isNotEmpty) {
    final iu = Uri.tryParse(n.tokenIndexerUrl!.trim());
    if (iu == null ||
        !(iu.scheme == 'http' || iu.scheme == 'https') ||
        iu.host.isEmpty) {
      return 'Token indexer URL must be a valid http(s) URL.';
    }
  }
  if (n.decimals < 0 || n.decimals > 36) {
    return 'Decimals must be between 0 and 36.';
  }
  for (final e in existing) {
    if (e.id == n.id) return 'A network with this id already exists.';
    if (e.chainId == n.chainId) {
      return 'Chain ID ${n.chainId} is already configured (${e.name}).';
    }
  }
  return null;
}

/// Encode a list of custom networks to a JSON string for persistence.
String encodeCustomNetworks(List<CustomNetwork> nets) =>
    jsonEncode(nets.map((n) => n.toJson()).toList());

/// Decode a persisted JSON string back into a list of custom networks. Tolerant
/// of malformed rows (skips them) and of an empty/null payload.
List<CustomNetwork> decodeCustomNetworks(String? raw) {
  if (raw == null || raw.trim().isEmpty) return const [];
  try {
    final list = jsonDecode(raw);
    if (list is! List) return const [];
    final out = <CustomNetwork>[];
    for (final row in list) {
      if (row is Map) {
        try {
          out.add(CustomNetwork.fromJson(row.cast<String, dynamic>()));
        } catch (_) {
          // skip malformed row
        }
      }
    }
    return out;
  } catch (_) {
    return const [];
  }
}
