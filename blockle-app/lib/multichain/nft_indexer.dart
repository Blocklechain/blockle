// nft_indexer.dart — WALLET NFT LIVE INDEXER (the Dart port of
// blockle-extension/nft-indexer.js). The injected `ctx.indexer` that nft.dart
// calls as getNFTsForOwner(chain, owner) -> raw items.
//
// nft.dart is PURE given this indexer: it normalizes the RAW items we return
// (never fabricating metadata). THIS module does the real network reads:
//   • EVM (ethereum/base/arbitrum/optimism/polygon/bnb/avalanche) via the Alchemy
//     NFT API v3 getNFTsForOwner (operator-configurable key + base url).
//   • Solana via a DAS indexer (Helius getAssetsByOwner).
//
// HONEST-OR-NOTHING: a missing key / unconfigured endpoint / HTTP or parse error
// returns `null` — so nft.dart records the account as `unavailable` and NEVER a
// fabricated empty inventory. We only ever return a LIST when a real indexer
// actually answered (that list may legitimately be empty).
//
// Behaviourally IDENTICAL to the JS reference, asserted against the SAME mock
// Alchemy / DAS responses (test/multichain/nft_indexer_test.dart).

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'nft.dart' show NftIndexer;

// CAIP-ish chain -> Alchemy NFT v3 network subdomain.
const Map<String, String> kAlchemyNet = {
  'ethereum': 'eth-mainnet',
  'base': 'base-mainnet',
  'arbitrum': 'arb-mainnet',
  'optimism': 'opt-mainnet',
  'polygon': 'polygon-mainnet',
  'bnb': 'bnb-mainnet',
  'avalanche': 'avax-mainnet',
};
const Set<String> kNftEvmChains = {
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'
};
const String kDefaultHeliusBase = 'https://mainnet.helius-rpc.com';

dynamic _firstNonEmpty(List<dynamic> vals) {
  for (final v in vals) {
    if (v != null && v != '') return v;
  }
  return null;
}

// ---- an injectable HTTP transport (real http in prod; a stub in tests) ------
class NftHttpResponse {
  NftHttpResponse(this.ok, this.status, this.body);
  final bool ok;
  final int status;
  final dynamic body; // parsed JSON
}

typedef NftFetch = Future<NftHttpResponse> Function(
  String url, {
  String method,
  Map<String, String>? headers,
  String? body,
});

Future<NftHttpResponse> _defaultFetch(
  String url, {
  String method = 'GET',
  Map<String, String>? headers,
  String? body,
}) async {
  final uri = Uri.parse(url);
  final res = method == 'POST'
      ? await http.post(uri, headers: headers, body: body)
      : await http.get(uri, headers: headers);
  dynamic parsed;
  try {
    parsed = res.body.isEmpty ? null : jsonDecode(res.body);
  } catch (_) {
    parsed = null;
  }
  return NftHttpResponse(res.statusCode >= 200 && res.statusCode < 300, res.statusCode, parsed);
}

// ---- map ONE Alchemy NFT v3 ownedNfts entry -> a raw nft.dart item ----------
Map<String, dynamic> mapAlchemyItem(String chain, Map<String, dynamic> nft) {
  final contractM = (nft['contract'] as Map?)?.cast<String, dynamic>();
  final contract = contractM?['address'] ?? nft['contractAddress'];
  final idM = (nft['id'] as Map?)?.cast<String, dynamic>();
  final idTokenMeta = (idM?['tokenMetadata'] as Map?)?.cast<String, dynamic>();
  final tokenTypeRaw = (contractM?['tokenType']) ??
      nft['tokenType'] ??
      idTokenMeta?['tokenType'] ??
      '';
  final tokenType = '$tokenTypeRaw'.toLowerCase();
  final standard = tokenType == 'erc1155'
      ? 'erc1155'
      : (tokenType == 'erc721' ? 'erc721' : null);
  final rawObj = (nft['raw'] as Map?)?.cast<String, dynamic>();
  final rawMeta = (rawObj?['metadata'] as Map?)?.cast<String, dynamic>() ??
      (nft['metadata'] as Map?)?.cast<String, dynamic>() ??
      const {};
  final img = (nft['image'] as Map?)?.cast<String, dynamic>() ?? const {};
  final image = _firstNonEmpty([
    img['cachedUrl'],
    img['originalUrl'],
    img['pngUrl'],
    img['thumbnailUrl'],
    rawMeta['image'],
    rawMeta['image_url'],
  ]);
  final animObj = (nft['animation'] as Map?)?.cast<String, dynamic>();
  final animation = _firstNonEmpty([
    rawMeta['animation_url'],
    animObj?['cachedUrl'],
  ]);
  final collObj = (nft['collection'] as Map?)?.cast<String, dynamic>();
  final contractMeta = (nft['contractMetadata'] as Map?)?.cast<String, dynamic>();
  final collection = _firstNonEmpty([
    collObj?['name'],
    contractMeta?['name'],
    contractM?['name'],
  ]);
  final name = _firstNonEmpty([nft['name'], nft['title'], rawMeta['name']]);
  final metadataUri = _firstNonEmpty([
    nft['tokenUri'] is Map ? (nft['tokenUri'] as Map)['raw'] : nft['tokenUri'],
    rawObj?['tokenUri'],
  ]);
  final metadataOk = name != null || image != null;

  final tokenId = nft['tokenId'] != null
      ? '${nft['tokenId']}'
      : (idM?['tokenId'] != null ? '${idM!['tokenId']}' : null);

  final out = <String, dynamic>{
    'chain': chain,
    'contract': contract,
    if (tokenId != null) 'tokenId': tokenId,
    'standard': standard,
    'balance': nft['balance'] != null ? '${nft['balance']}' : '1',
    'metadataOk': metadataOk,
  };
  if (name != null) out['name'] = name;
  if (collection != null) out['collection'] = collection;
  if (image != null) out['image'] = image;
  if (animation != null) out['animation'] = animation;
  if (metadataUri != null) out['metadataUri'] = metadataUri;
  if (rawMeta['attributes'] is List) out['attributes'] = rawMeta['attributes'];
  return out;
}

// ---- map ONE DAS (Helius getAssetsByOwner) asset -> a raw nft.dart item -----
Map<String, dynamic> mapDasItem(Map<String, dynamic> asset) {
  final content = (asset['content'] as Map?)?.cast<String, dynamic>() ?? const {};
  final meta = (content['metadata'] as Map?)?.cast<String, dynamic>() ?? const {};
  final links = (content['links'] as Map?)?.cast<String, dynamic>() ?? const {};
  dynamic collection;
  for (final g in (asset['grouping'] as List? ?? const [])) {
    if (g is Map && g['group_key'] == 'collection') {
      final cm = (g['collection_metadata'] as Map?)?.cast<String, dynamic>();
      collection = cm?['name'] ?? g['group_value'];
      break;
    }
  }
  collection ??= meta['symbol'];
  final files = content['files'] as List?;
  final file0 = (files != null && files.isNotEmpty && files[0] is Map)
      ? (files[0] as Map).cast<String, dynamic>()
      : null;
  final image = _firstNonEmpty([
    links['image'],
    meta['image'],
    file0?['cdn_uri'] ?? file0?['uri'],
  ]);
  final name = _firstNonEmpty([meta['name']]);
  final metadataUri = _firstNonEmpty([content['json_uri'], asset['json_uri']]);
  final metadataOk = name != null || image != null;

  final out = <String, dynamic>{
    'chain': 'solana',
    'contract': asset['id'],
    'standard': 'metaplex',
    'balance': '1',
    'metadataOk': metadataOk,
  };
  if (name != null) out['name'] = name;
  if (collection != null) out['collection'] = collection;
  if (image != null) out['image'] = image;
  if (metadataUri != null) out['metadataUri'] = metadataUri;
  if (meta['attributes'] is List) out['attributes'] = meta['attributes'];
  return out;
}

/// The live NFT indexer. Operator-configurable Alchemy key/baseUrl (EVM) + a DAS
/// endpoint (Helius apiKey/baseUrl or an explicit url) for Solana. [fetchImpl] is
/// injectable (the real http client by default; a stub in tests).
class LiveNftIndexer implements NftIndexer {
  LiveNftIndexer({
    Map<String, dynamic>? alchemy,
    Map<String, dynamic>? das,
    Map<String, dynamic>? helius,
    NftFetch? fetchImpl,
  })  : _alchemy = alchemy ?? const {},
        _das = das ?? helius ?? const {},
        _fetch = fetchImpl ?? _defaultFetch;

  final Map<String, dynamic> _alchemy;
  final Map<String, dynamic> _das;
  final NftFetch _fetch;

  String? _alchemyUrl(String chain) {
    final net = kAlchemyNet[chain];
    if (net == null) return null;
    final baseUrl = _alchemy['baseUrl'];
    if (baseUrl is String && baseUrl.isNotEmpty) {
      return '${baseUrl.replaceAll(RegExp(r'/+$'), '')}/getNFTsForOwner';
    }
    final apiKey = _alchemy['apiKey'];
    if (apiKey == null || '$apiKey'.isEmpty) return null;
    return 'https://$net.g.alchemy.com/nft/v3/${Uri.encodeComponent('$apiKey')}/getNFTsForOwner';
  }

  String? _dasUrl() {
    final url = _das['url'];
    if (url is String && url.isNotEmpty) return url;
    final apiKey = _das['apiKey'];
    if (apiKey == null || '$apiKey'.isEmpty) return null;
    final base = ('${_das['baseUrl'] ?? kDefaultHeliusBase}').replaceAll(RegExp(r'/+$'), '');
    return '$base/?api-key=${Uri.encodeComponent('$apiKey')}';
  }

  @override
  Future<List<dynamic>?> getNFTsForOwner(String chain, String owner) async {
    try {
      if (kNftEvmChains.contains(chain)) {
        final base = _alchemyUrl(chain);
        if (base == null) return null; // no key/endpoint -> unavailable
        final url = '$base?owner=${Uri.encodeComponent(owner)}&withMetadata=true&pageSize=100';
        final res = await _fetch(url, method: 'GET', headers: const {'accept': 'application/json'});
        if (!res.ok) return null;
        final body = res.body;
        if (body is! Map) return null;
        final list = body['ownedNfts'] ?? body['nfts'] ?? body['ownedNftsV3'] ?? const [];
        if (list is! List) return null;
        return [
          for (final n in list)
            if (n is Map) mapAlchemyItem(chain, n.cast<String, dynamic>())
        ];
      }
      if (chain == 'solana') {
        final url = _dasUrl();
        if (url == null) return null; // no key/endpoint -> unavailable
        final res = await _fetch(
          url,
          method: 'POST',
          headers: const {'content-type': 'application/json'},
          body: jsonEncode({
            'jsonrpc': '2.0',
            'id': 'nfts',
            'method': 'getAssetsByOwner',
            'params': {
              'ownerAddress': owner,
              'page': 1,
              'limit': 1000,
              'displayOptions': {'showCollectionMetadata': true},
            },
          }),
        );
        if (!res.ok) return null;
        final body = res.body;
        if (body is! Map) return null;
        if (body['error'] != null) return null;
        final result = (body['result'] as Map?)?.cast<String, dynamic>();
        final items = result?['items'];
        if (items is! List) return null;
        // non-fungible assets only (DAS also returns fungibles for some owners)
        return [
          for (final a in items)
            if (a is Map &&
                '${a['interface'] ?? ''}' != 'FungibleToken' &&
                '${a['interface'] ?? ''}' != 'FungibleAsset')
              mapDasItem(a.cast<String, dynamic>())
        ];
      }
      return null; // unsupported chain -> unavailable (honest)
    } catch (_) {
      return null; // any error -> unavailable (NEVER a fabricated empty inventory)
    }
  }
}
