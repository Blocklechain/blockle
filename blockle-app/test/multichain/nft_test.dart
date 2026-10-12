// multichain/nft_test.dart — WALLET NFT SUPPORT (nft.dart), Dart port of
// blockle-extension/nft.js. Asserts, byte-for-byte, against the AUTHORITATIVE
// shared fixture docs/nft-vectors.json (consumed, never edited) — the SAME §5
// vectors the JS + Python ports reproduce. Proves:
//   • inventory grouping (erc721 + erc1155 balance>1 + metaplex + a
//     metadata-unavailable item), never a fabricated name / empty inventory;
//   • ipfs:// → configured gateway normalization (non-ipfs passes through);
//   • EXACT ERC-721 + ERC-1155 safeTransferFrom calldata (module never signs);
//   • the overdraw / wrong-from / missing-ownedBalance fail-closed guards;
//   • conservative spam FLAGGING (never a safety/value claim);
//   • surfaceApprovals reuses the security approval manager (operator rows
//     danger/revocable; a sized ERC-20 allowance is NOT an operator approval);
//   • a built send routes through the SAME security.inspectTransaction gate as a
//     normal send (nft-transfer decode + send-to-flagged on a denylisted to).

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:blockle_app/multichain/nft.dart' as nft;
import 'package:blockle_app/multichain/security.dart' as sec;
import 'package:blockle_app/multichain/chains/evm.dart' as evm;

Map<String, dynamic> _loadVectors() {
  for (final p in const [
    '../docs/nft-vectors.json',
    'docs/nft-vectors.json',
    '../../docs/nft-vectors.json',
  ]) {
    final f = File(p);
    if (f.existsSync()) {
      return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
    }
  }
  throw StateError('nft-vectors.json not found');
}

// An injected indexer built from the PLAIN vector `raw` map (no functions).
class _RawIndexer implements nft.NftIndexer {
  _RawIndexer(this.rawMap);
  final Map<String, dynamic> rawMap;
  @override
  Future<List<dynamic>?> getNFTsForOwner(String chain, String owner) async {
    final key = '$chain:$owner';
    if (!rawMap.containsKey(key)) return const [];
    return (rawMap[key] as List);
  }
}

class _ThrowingIndexer implements nft.NftIndexer {
  @override
  Future<List<dynamic>?> getNFTsForOwner(String chain, String owner) async {
    throw StateError('boom');
  }
}

// An approval indexer built from the vector's plain rawApprovals list.
class _ApprovalIndexer implements sec.ApprovalIndexer {
  _ApprovalIndexer(this.raw);
  final List<dynamic> raw;
  @override
  Future<List<Map<String, dynamic>>> getApprovals(String chain, String owner) async =>
      [for (final a in raw) (a as Map).cast<String, dynamic>()];
}

Map<String, List<Map<String, dynamic>>> _byContract(List items) {
  final m = <String, List<Map<String, dynamic>>>{};
  for (final it in items) {
    final k = '${it['contract']}'.toLowerCase();
    (m[k] ??= []).add((it as Map).cast<String, dynamic>());
  }
  return m;
}

List<String> _sorted(Iterable<dynamic> xs) =>
    [for (final x in xs) '$x']..sort();

void main() {
  final v = _loadVectors();
  final config = (v['config'] as Map).cast<String, dynamic>();

  // =========================================================================
  // 1. INVENTORY — grouping, balances, metadata-unavailable, ipfs normalization
  // =========================================================================
  test(
      'inventory: groups by collection; erc721/erc1155/metaplex; never fabricates metadata',
      () async {
    final inv = (v['inventory'] as Map).cast<String, dynamic>();
    final accounts = [
      for (final a in (inv['accounts'] as List)) (a as Map).cast<String, dynamic>()
    ];
    final ctx = nft.NftCtx(
      config: config,
      indexer: _RawIndexer((inv['raw'] as Map).cast<String, dynamic>()),
    );
    final res = await nft.nfts(accounts, ctx);
    final e = (inv['expect'] as Map).cast<String, dynamic>();

    expect(res['unavailable'], (e['unavailable'] as List),
        reason: 'no unavailable accounts');

    final groups = _byContract(res['items'] as List);
    for (final entry in (e['itemsByContract'] as Map).entries) {
      final contract = entry.key as String;
      final exp = (entry.value as Map).cast<String, dynamic>();
      final items = groups[contract];
      expect(items, isNotNull, reason: 'has items for $contract');
      expect(items!.length, exp['count'], reason: 'count for $contract');
      expect(items[0]['standard'], exp['standard'], reason: 'standard for $contract');
      final balances = [for (final i in items) i['balance']];
      expect(balances, (exp['balances'] as List), reason: 'balances for $contract');
      if (exp['tokenIds'] != null) {
        expect([for (final i in items) i['tokenId']], (exp['tokenIds'] as List),
            reason: 'tokenIds for $contract');
      }
      if (exp['collection'] != null) {
        expect(items[0]['collection'], exp['collection'],
            reason: 'collection name for $contract');
      }
      if (exp['metadataOk'] == false) {
        expect(items[0]['metadataOk'], false, reason: 'metadataOk false for $contract');
        expect(items[0]['metadataNote'], exp['metadataNote'],
            reason: 'metadata-unavailable note');
      }
      if (exp['hasName'] == false) {
        expect(items[0]['name'], isNull, reason: 'no fabricated name for $contract');
      }
    }

    // grouping object
    final keys = _sorted([for (final c in (res['collections'] as List)) c['key']]);
    expect(keys, _sorted(e['collectionKeys'] as List), reason: 'collection keys');
    final bayc = (res['collections'] as List).firstWhere((c) =>
        c['key'] == 'ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d');
    expect(bayc['count'], 2, reason: 'BAYC grouped count');
    expect((bayc['items'] as List).length, 2);

    // ipfs media normalized on the inventory items
    for (final entry in (e['normalizedImages'] as Map).entries) {
      final parts = (entry.key as String).split(':');
      final chain = parts[0], contract = parts[1], tokenId = parts[2];
      final it = (res['items'] as List).firstWhere((i) =>
          i['chain'] == chain &&
          '${i['contract']}'.toLowerCase() == contract &&
          i['tokenId'] == tokenId);
      expect(it['image'], entry.value, reason: 'normalized image for ${entry.key}');
    }
  });

  test('inventory: no indexer => account listed unavailable, NEVER a fake empty inventory',
      () async {
    final u = (v['unavailable'] as Map).cast<String, dynamic>();
    final accounts = [
      for (final a in (u['accounts'] as List)) (a as Map).cast<String, dynamic>()
    ];
    final res = await nft.nfts(accounts, nft.NftCtx(config: config)); // no indexer
    final e = (u['expect'] as Map).cast<String, dynamic>();
    expect((res['items'] as List).length, e['items']);
    expect((res['unavailable'] as List).length, e['unavailableCount']);
    expect('${(res['unavailable'] as List)[0]['reason']}', contains('NOT a claim'));
  });

  test('inventory: indexer error => unavailable (fails safe)', () async {
    final res = await nft.nfts([
      {'chain': 'ethereum', 'address': '0x1111111111111111111111111111111111111111'}
    ], nft.NftCtx(indexer: _ThrowingIndexer()));
    expect((res['items'] as List).length, 0);
    expect((res['unavailable'] as List).length, 1);
    expect('${(res['unavailable'] as List)[0]['reason']}', contains('indexer error'));
  });

  // =========================================================================
  // 2. ipfs:// normalization (gateway-configured; non-ipfs passes through)
  // =========================================================================
  test('ipfs:// normalization to the configured gateway', () {
    for (final c in (v['ipfs'] as List)) {
      final m = (c as Map).cast<String, dynamic>();
      expect(nft.normalizeUri(m['in'], config), m['out'], reason: '${m['in']}');
    }
    expect(nft.normalizeUri(null, config), isNull, reason: 'null passes through');
  });

  // =========================================================================
  // 3-4. SEND — exact ERC-721 + ERC-1155 calldata (routes through the signer)
  // =========================================================================
  for (final tv in (v['transfers'] as List)) {
    final m = (tv as Map).cast<String, dynamic>();
    test('transfer: ${m['name']}', () {
      final ctx = nft.NftCtx(
        accounts: [
          for (final a in ((m['ctx'] as Map)['accounts'] as List))
            (a as Map).cast<String, dynamic>()
        ],
      );
      final tx = nft.buildNftTransfer((m['req'] as Map).cast<String, dynamic>(), ctx);
      final e = (m['expect'] as Map).cast<String, dynamic>();
      expect(tx['kind'], e['kind'], reason: 'kind');
      expect(tx['standard'], e['standard'], reason: 'standard');
      expect(tx['to'], e['to'], reason: 'to (contract target)');
      expect(tx['value'], e['value'], reason: 'value');
      expect(tx['data'], e['data'], reason: 'EXACT calldata');
      // the module NEVER signs: no raw/txid/signature on the built tx
      expect(tx.containsKey('raw'), isFalse);
      expect(tx.containsKey('txid'), isFalse);
    });
  }

  // =========================================================================
  // GUARDS — fail-closed (overdraw / wrong-from / missing ownedBalance)
  // =========================================================================
  for (final g in (v['guards'] as List)) {
    final m = (g as Map).cast<String, dynamic>();
    test('guard: ${m['name']}', () {
      final ctx = nft.NftCtx(
        accounts: [
          for (final a in ((m['ctx'] as Map)['accounts'] as List))
            (a as Map).cast<String, dynamic>()
        ],
      );
      expect(
        () => nft.buildNftTransfer((m['req'] as Map).cast<String, dynamic>(), ctx),
        throwsA(predicate((e) => '$e'.contains(m['expectError'] as String))),
      );
    });
  }

  // =========================================================================
  // 3 (spec §3). SPAM — conservative FLAG only, never a safety/value claim
  // =========================================================================
  for (final s in (v['spam'] as List)) {
    final m = (s as Map).cast<String, dynamic>();
    test('spam: ${m['name']}', () {
      final item = nft.normalizeItem((m['raw'] as Map).cast<String, dynamic>(), config);
      final exp = (m['expect'] as Map).cast<String, dynamic>();
      if (exp['spam'] == true) {
        expect(item['spam'], true, reason: 'flagged');
        expect(_sorted((item['spamReasons'] as List? ?? const [])),
            _sorted(exp['reasons'] as List), reason: 'reasons');
      } else {
        expect(item['spam'] == true, isFalse, reason: 'not flagged');
      }
    });
  }

  // =========================================================================
  // 4 (spec §4). APPROVAL AWARENESS — reuse the security approval manager
  // =========================================================================
  test(
      'surfaceApprovals: operator (setApprovalForAll) rows flagged danger/revocable; erc20 allowance is not',
      () async {
    final a = (v['approvals'] as Map).cast<String, dynamic>();
    final ctx = sec.SecCtx(indexer: _ApprovalIndexer(a['rawApprovals'] as List));
    final res = await nft.surfaceApprovals(
        a['chain'] as String, a['owner'] as String, ctx);
    expect(res['available'], true);
    final expOps = ((a['expect'] as Map)['operatorApprovals'] as List);
    final gotOps = (res['operatorApprovals'] as List);
    expect(gotOps.length, expOps.length, reason: 'one operator approval surfaced');
    final op = (gotOps[0] as Map).cast<String, dynamic>();
    final exp = (expOps[0] as Map).cast<String, dynamic>();
    expect(op['collection'], exp['collection']);
    expect(op['operator'], exp['operator']);
    expect(op['severity'], 'danger');
    expect(op['revocable'], true);
  });

  test('surfaceApprovals: no indexer => unavailable, never a fake all-clear',
      () async {
    final res = await nft.surfaceApprovals(
        'ethereum', '0x1111111111111111111111111111111111111111',
        const sec.SecCtx());
    expect(res['available'], false);
    expect(res['operatorApprovals'], const []);
  });

  // =========================================================================
  // SEND ROUTES THROUGH THE SAME SECURITY GATE as a normal send
  // =========================================================================
  test(
      'built send is inspected by security.inspectTransaction (decodes nft-transfer + recipient)',
      () async {
    final s = ((v['inspect'] as Map)['safeRecipient'] as Map).cast<String, dynamic>();
    final insp = await sec.inspectTransaction(
        (s['tx'] as Map).cast<String, dynamic>(), const sec.SecCtx());
    final e = (s['expect'] as Map).cast<String, dynamic>();
    expect(insp.kind, e['kind'], reason: 'kind');
    expect(insp.severity, e['severity'], reason: 'severity');
    expect(insp.field('To')?['value'], e['to'], reason: 'recipient decoded');
    expect(insp.field('Token ID')?['value'], e['tokenId'], reason: 'tokenId decoded');
  });

  test(
      'built send to a denylisted recipient raises send-to-flagged (danger) — same gate as any send',
      () async {
    final s =
        ((v['inspect'] as Map)['flaggedRecipient'] as Map).cast<String, dynamic>();
    final insp = await sec.inspectTransaction(
        (s['tx'] as Map).cast<String, dynamic>(),
        sec.SecCtx(config: (s['config'] as Map).cast<String, dynamic>()));
    final e = (s['expect'] as Map).cast<String, dynamic>();
    expect(insp.kind, e['kind']);
    expect(insp.severity, e['severity']);
    expect(insp.warningCodes, _sorted(e['warnings'] as List));
  });

  // =========================================================================
  // end-to-end: a built ERC-1155 send and the EVM adapter builder agree exactly
  // =========================================================================
  test('end-to-end: buildNftTransfer calldata matches the EVM adapter builder exactly',
      () {
    final tx = nft.buildNftTransfer({
      'chain': 'ethereum',
      'standard': 'erc1155',
      'contract': '0x495f947276749Ce646f68AC8c248420045cb7b5e',
      'tokenId': '42',
      'amount': '3',
      'ownedBalance': '7',
      'from': '0x1111111111111111111111111111111111111111',
      'to': '0x2222222222222222222222222222222222222222',
    }, const nft.NftCtx(accounts: [
      {'chain': 'ethereum', 'address': '0x1111111111111111111111111111111111111111'}
    ]));
    final direct = evm.erc1155SafeTransferFromData(
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        '42',
        '3',
        '0x');
    expect(tx['data'], direct, reason: 'nft.dart reuses the EVM calldata builder');
  });
}
