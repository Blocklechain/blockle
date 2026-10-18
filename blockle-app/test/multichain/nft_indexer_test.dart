// nft_indexer_test.dart — WALLET NFT LIVE INDEXER (nft_indexer.dart).
//
// The Dart port of blockle-extension/nft-indexer.test.js. Verifies the live
// indexer maps a MOCK Alchemy NFT v3 response (EVM) and a MOCK DAS
// getAssetsByOwner response (Helius / Solana) to the RAW item shape nft.dart
// expects, that a MISSING key/endpoint (or an HTTP/parse error) returns no result
// -> `unavailable` (NEVER a fabricated empty inventory), and that the raw items
// feed nft.dart end-to-end into a correctly-normalized inventory.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:blockle_app/multichain/nft.dart' as nft;
import 'package:blockle_app/multichain/nft_indexer.dart' as ni;

class _Route {
  _Route(this.match, {this.ok = true, this.status = 200, this.body});
  final bool Function(String url, String? body) match;
  final bool ok;
  final int status;
  final dynamic body;
}

ni.NftFetch fetchStub(List<_Route> routes) {
  return (String url, {String method = 'GET', Map<String, String>? headers, String? body}) async {
    for (final r in routes) {
      if (r.match(url, body)) return ni.NftHttpResponse(r.ok, r.status, r.body);
    }
    return ni.NftHttpResponse(false, 404, const {});
  };
}

// ---- mock Alchemy NFT API v3 getNFTsForOwner response ----------------------
const alchemyBody = {
  'ownedNfts': [
    {
      'contract': {'address': '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', 'tokenType': 'ERC721'},
      'tokenId': '7777',
      'balance': '1',
      'name': 'Bored Ape #7777',
      'image': {'cachedUrl': 'https://cdn.alchemy.com/bayc/7777.png', 'originalUrl': 'ipfs://Qmbayc/7777.png'},
      'collection': {'name': 'Bored Ape Yacht Club'},
      'tokenUri': 'ipfs://Qmbayc/7777.json',
      'raw': {'metadata': {'name': 'Bored Ape #7777', 'image': 'ipfs://Qmbayc/7777.png', 'attributes': [{'trait_type': 'Fur', 'value': 'Gold'}]}},
    },
    {
      'contract': {'address': '0x495f947276749Ce646f68AC8c248420045cb7b5e', 'tokenType': 'ERC1155'},
      'tokenId': '42',
      'balance': '3',
      'name': 'Edition 42',
      'image': {'cachedUrl': 'https://cdn.alchemy.com/ed/42.png'},
      'collection': {'name': 'OpenSea Shared'},
      'raw': {'metadata': {'attributes': []}},
    },
    {
      // metadata-less item — the indexer must NOT fabricate a name/image
      'contract': {'address': '0x0000000000000000000000000000000000000abc', 'tokenType': 'ERC721'},
      'tokenId': '1',
      'balance': '1',
      'image': {},
      'raw': {'metadata': {}},
    },
  ],
};

// ---- mock DAS (Helius) getAssetsByOwner response ---------------------------
const dasBody = {
  'jsonrpc': '2.0',
  'id': 'nfts',
  'result': {
    'total': 2,
    'limit': 1000,
    'page': 1,
    'items': [
      {
        'interface': 'V1_NFT',
        'id': 'MintAddrSolana1111111111111111111111111111',
        'content': {
          'json_uri': 'https://arweave.net/abc.json',
          'metadata': {'name': 'DeGod #1234', 'symbol': 'DGOD', 'attributes': [{'trait_type': 'Background', 'value': 'Blue'}]},
          'links': {'image': 'https://arweave.net/degod-1234.png'},
        },
        'grouping': [{'group_key': 'collection', 'group_value': 'DeGodsColl1111111111111111111111111111111'}],
      },
      {
        // a fungible token the DAS endpoint may also return — must be filtered out
        'interface': 'FungibleToken',
        'id': 'UsdcMint1111111111111111111111111111111111',
        'content': {'metadata': {'name': 'USD Coin', 'symbol': 'USDC'}, 'links': {}},
      },
    ],
  },
};

void main() {
  // =========================================================================
  // 1. EVM — Alchemy mapping
  // =========================================================================
  test('evm: maps the Alchemy getNFTsForOwner response to raw items (no fabrication)', () async {
    final idx = ni.LiveNftIndexer(
      alchemy: const {'apiKey': 'test-key'},
      fetchImpl: fetchStub([
        _Route((u, b) => RegExp(r'eth-mainnet\.g\.alchemy\.com/nft/v3/.*/getNFTsForOwner').hasMatch(u) && u.contains('owner=0xOWNER'), body: alchemyBody),
      ]),
    );
    final raw = await idx.getNFTsForOwner('ethereum', '0xOWNER');
    expect(raw, isA<List>());
    expect(raw!.length, 3);

    final bayc = (raw[0] as Map).cast<String, dynamic>();
    expect(bayc['chain'], 'ethereum');
    expect(bayc['contract'], '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');
    expect(bayc['standard'], 'erc721');
    expect(bayc['tokenId'], '7777');
    expect(bayc['balance'], '1');
    expect(bayc['name'], 'Bored Ape #7777');
    expect(bayc['collection'], 'Bored Ape Yacht Club');
    expect(bayc['image'], 'https://cdn.alchemy.com/bayc/7777.png');
    expect(bayc['metadataUri'], 'ipfs://Qmbayc/7777.json');
    expect(bayc['attributes'], [{'trait_type': 'Fur', 'value': 'Gold'}]);
    expect(bayc['metadataOk'], true);

    final ed = (raw[1] as Map).cast<String, dynamic>();
    expect(ed['standard'], 'erc1155');
    expect(ed['balance'], '3');

    final bare = (raw[2] as Map).cast<String, dynamic>();
    expect(bare['metadataOk'], false);
    expect(bare.containsKey('name'), false);
    expect(bare.containsKey('image'), false);
  });

  test('evm: the raw items feed nft.dart into a normalized, grouped inventory', () async {
    final idx = ni.LiveNftIndexer(alchemy: const {'apiKey': 'test-key'}, fetchImpl: fetchStub([_Route((u, b) => true, body: alchemyBody)]));
    final res = await nft.nfts([{'chain': 'ethereum', 'address': '0xOWNER'}], nft.NftCtx(indexer: idx, config: const {}));
    expect(res['unavailable'], const []);
    expect((res['items'] as List).length, 3);
    final items = (res['items'] as List).cast<Map<String, dynamic>>();
    final bayc = items.firstWhere((i) => i['tokenId'] == '7777');
    expect(bayc['metadataUri'], 'https://ipfs.io/ipfs/Qmbayc/7777.json');
    final bare = items.firstWhere((i) => i['metadataOk'] == false);
    expect(bare['metadataNote'], 'metadata-unavailable');
  });

  // =========================================================================
  // 2. Solana — DAS mapping (non-fungibles only)
  // =========================================================================
  test('solana: maps the DAS getAssetsByOwner response and filters fungibles', () async {
    Map<String, dynamic>? sawBody;
    final idx = ni.LiveNftIndexer(
      helius: const {'apiKey': 'helius-key'},
      fetchImpl: (url, {method = 'GET', headers, body}) async {
        sawBody = (jsonDecode(body!) as Map).cast<String, dynamic>();
        return ni.NftHttpResponse(true, 200, dasBody);
      },
    );
    final raw = await idx.getNFTsForOwner('solana', 'OwnerSolPubkey111');
    expect(sawBody!['method'], 'getAssetsByOwner');
    expect((sawBody!['params'] as Map)['ownerAddress'], 'OwnerSolPubkey111');
    expect(raw, isA<List>());
    expect(raw!.length, 1);
    final degod = (raw[0] as Map).cast<String, dynamic>();
    expect(degod['chain'], 'solana');
    expect(degod['standard'], 'metaplex');
    expect(degod['contract'], 'MintAddrSolana1111111111111111111111111111');
    expect(degod['name'], 'DeGod #1234');
    expect(degod['image'], 'https://arweave.net/degod-1234.png');
    expect(degod['metadataUri'], 'https://arweave.net/abc.json');
    expect(degod['attributes'], [{'trait_type': 'Background', 'value': 'Blue'}]);
    expect(degod['metadataOk'], true);
  });

  // =========================================================================
  // 3. HONEST-OR-NOTHING — missing key / error => null => `unavailable`
  // =========================================================================
  test('missing key => null (not a fake empty array)', () async {
    final idx = ni.LiveNftIndexer(alchemy: const {}, fetchImpl: fetchStub([_Route((u, b) => true, body: alchemyBody)]));
    expect(await idx.getNFTsForOwner('ethereum', '0xOWNER'), isNull);

    final idxSol = ni.LiveNftIndexer(fetchImpl: fetchStub([_Route((u, b) => true, body: dasBody)]));
    expect(await idxSol.getNFTsForOwner('solana', 'Owner'), isNull);
  });

  test('HTTP / parse error => null', () async {
    final idx = ni.LiveNftIndexer(alchemy: const {'apiKey': 'k'}, fetchImpl: fetchStub([_Route((u, b) => true, ok: false, status: 500, body: const {})]));
    expect(await idx.getNFTsForOwner('ethereum', '0xOWNER'), isNull);

    final idxThrow = ni.LiveNftIndexer(alchemy: const {'apiKey': 'k'}, fetchImpl: (url, {method = 'GET', headers, body}) async => throw Exception('network down'));
    expect(await idxThrow.getNFTsForOwner('ethereum', '0xOWNER'), isNull);

    final idxDasErr = ni.LiveNftIndexer(helius: const {'apiKey': 'k'}, fetchImpl: (url, {method = 'GET', headers, body}) async => ni.NftHttpResponse(true, 200, const {'error': {'code': -32000, 'message': 'bad'}}));
    expect(await idxDasErr.getNFTsForOwner('solana', 'Owner'), isNull);
  });

  test('missing key => nft.dart reports the account unavailable (NEVER a fake empty inventory)', () async {
    final idx = ni.LiveNftIndexer(alchemy: const {}, fetchImpl: fetchStub([_Route((u, b) => true, body: alchemyBody)]));
    final res = await nft.nfts([{'chain': 'ethereum', 'address': '0xOWNER'}], nft.NftCtx(indexer: idx, config: const {}));
    expect((res['items'] as List).length, 0);
    expect((res['unavailable'] as List).length, 1);
    expect('${(res['unavailable'] as List)[0]['reason']}', contains('NOT a claim'));
  });

  test('unsupported chain => null (honest)', () async {
    final idx = ni.LiveNftIndexer(alchemy: const {'apiKey': 'k'}, helius: const {'apiKey': 'k'}, fetchImpl: fetchStub([_Route((u, b) => true, body: const {})]));
    expect(await idx.getNFTsForOwner('bitcoin', 'bc1xyz'), isNull);
  });

  // ---- native BLOCK-721 — the node ownership index (no API key) ------------
  const blockNftsBody = {
    'address': 'block1owner', 'count': 2,
    'nfts': [
      {'contract': 'eba51266e429aa00', 'tokenId': '01'},
      {'contract': 'eba51266e429aa00', 'tokenId': '02'},
    ],
  };

  test('block: maps /api/explorer/nfts to raw block721 items (no key, no fabrication)', () async {
    final idx = ni.LiveNftIndexer(fetchImpl: fetchStub([
      _Route((u, b) => RegExp(r'/api/explorer/nfts/block1owner$').hasMatch(u), body: blockNftsBody),
    ]));
    final raw = await idx.getNFTsForOwner('block', 'block1owner');
    expect(raw, isNotNull);
    expect(raw!.length, 2);
    expect(raw[0]['chain'], 'block');
    expect(raw[0]['standard'], 'block721');
    expect(raw[0]['contract'], 'eba51266e429aa00');
    expect(raw[0]['tokenId'], '01');
    expect(raw[0]['metadataOk'], false);
    expect(raw[0]['name'], isNull);

    final res = await nft.nfts([{'chain': 'block', 'address': 'block1owner'}], nft.NftCtx(indexer: idx, config: const {}));
    expect((res['unavailable'] as List).length, 0);
    expect((res['items'] as List).length, 2);
    expect((res['items'] as List)[0]['balance'], '1');
    expect((res['collections'] as List).length, 1);
  });

  test('block: a node hiccup => null (honest unavailable)', () async {
    final idx = ni.LiveNftIndexer(fetchImpl: fetchStub([_Route((u, b) => true, ok: false, status: 502, body: const {})]));
    expect(await idx.getNFTsForOwner('block', 'block1owner'), isNull);
  });
}
