// multichain/activity.dart — WALLET ACTIVITY: one time-sorted cross-chain
// history feed (docs/WALLET-PORTFOLIO.md §2).
//
// Dart port of blockle-extension/activity.js (the JS reference). Behaviourally
// IDENTICAL; asserted against the authoritative docs/portfolio-vectors.json.
//
// READ-ONLY. `activity(accounts, ctx, opts)` pulls per-chain history from the
// indexers injected via ctx (EVM getAssetTransfers/logs, Solana
// signatures-for-address, UTXO esplora address txs, BLOCK node history), merges
// them into ONE feed sorted newest-first, and pages it with a STABLE cursor.
//
// An indexer that is unavailable contributes NOTHING plus an audited note —
// never a fabricated empty "no activity" (which would read as a safety claim).
//
// It DECODES each item's `kind` by REUSING the wallet security suite's decoder
// (security.dart inspectTransaction) so the label matches the pre-sign preview
// EXACTLY, and marks any item whose counterparty the security suite would flag
// (so past interactions with a flagged address stay visible in history too).
//
// PURE given the injected indexers + security ctx; no network here, no clock.

import 'chains/evm.dart' show erc20TransferData;
import 'security.dart' as sec;

const Set<String> _evmChains = {
  'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'
};
const Set<String> _utxoChains = {'bitcoin', 'litecoin', 'dogecoin'};

// security-decoder kind -> Activity kind (docs §2). Never fabricates a meaning
// the decoder didn't produce: an unknown selector decodes to contract.
const Map<String, String> kKindMap = {
  'native-transfer': 'transfer',
  'block-send': 'transfer',
  'utxo-send': 'transfer',
  'token-transfer': 'token-transfer',
  'token-approval': 'approval',
  'contract-call': 'contract',
  'unknown': 'contract',
};

// warning codes that flag the COUNTERPARTY (not merely the shape of the tx).
const Set<String> kCounterpartyFlags = {
  'send-to-flagged', 'known-drainer', 'approval-to-eoa', 'setApprovalForAll-true'
};

String? norm(dynamic a) {
  if (a == null) return null;
  final s = '$a';
  return RegExp(r'^0x[0-9a-fA-F]*$').hasMatch(s) ? s.toLowerCase() : s;
}

bool eq(dynamic a, dynamic b) => a != null && b != null && norm(a) == norm(b);

/// The injected read ctx. `history`/`indexers` supply per-chain raw rows;
/// `securityConfig` is the SAME config the pre-sign uses (denylist /
/// knownSpenders / thresholds); `inspect` optionally overrides the decoder;
/// `explorerTx` builds an explorer URL.
class ActivityCtx {
  final Map<String, dynamic>? securityConfig;
  final Future<dynamic> Function(String chain, String address)? history;
  final Map<String, Future<dynamic> Function(String address)>? indexers;
  final Future<dynamic> Function(String chain, Map<String, dynamic> tx)? inspect;
  final Future<String?> Function(String chain, dynamic txid)? explorerTx;
  const ActivityCtx({
    this.securityConfig,
    this.history,
    this.indexers,
    this.inspect,
    this.explorerTx,
  });
}

class ActivityOpts {
  final String? cursor;
  final int? limit;
  const ActivityOpts({this.cursor, this.limit});
}

// Build the tx shape the security decoder understands from a raw indexer row,
// RECONSTRUCTING the same calldata the pre-sign path would see (so the decoded
// kind/label is identical). Never invents fields the row didn't carry.
Map<String, dynamic> buildTx(String chain, Map row) {
  final asset = row['asset'];
  final value = row['value'] ?? row['amount'];
  if (_evmChains.contains(chain)) {
    if (row['data'] != null && row['data'] != '0x') {
      return {'chain': chain, 'to': row['to'], 'data': row['data'], 'value': row['value'], 'asset': asset};
    }
    if (asset is Map && asset['kind'] == 'erc20' && asset['address'] != null) {
      return {
        'chain': chain,
        'to': asset['address'],
        'data': erc20TransferData('${row['to']}', value ?? 0),
        'asset': asset
      };
    }
    return {'chain': chain, 'to': row['to'], 'value': value ?? 0, 'asset': asset};
  }
  if (chain == 'block') {
    return {'chain': chain, 'to': row['to'], 'amount': value ?? 0, 'asset': asset};
  }
  if (chain == 'solana') {
    if (row['instructions'] is List) {
      return {'chain': chain, 'instructions': row['instructions'], 'asset': asset};
    }
    return {
      'chain': chain,
      'instructions': [
        {
          'program': 'system',
          'type': 'transfer',
          'info': {'destination': row['to'], 'lamports': '${value ?? 0}'}
        }
      ],
      'asset': asset
    };
  }
  if (_utxoChains.contains(chain)) {
    if (row['outputs'] is List) {
      return {
        'chain': chain,
        'inputs': row['inputs'],
        'outputs': row['outputs'],
        'ownAddresses': row['ownAddresses'],
        'changeAddress': row['changeAddress'],
        'asset': asset
      };
    }
    return {
      'chain': chain,
      'outputs': [
        {'address': row['to'], 'value': '${value ?? 0}'}
      ],
      'ownAddresses': row['ownAddresses'],
      'asset': asset
    };
  }
  return {'chain': chain, 'to': row['to'], 'value': value ?? 0, 'asset': asset};
}

/// Resolve direction relative to the owning account address.
String directionOf(String chain, Map row, dynamic address, String activityKind) {
  if (activityKind == 'approval') return 'out';
  if (activityKind == 'contract') return 'contract';
  final from = row['from'], to = row['to'];
  final isFrom = address != null && eq(from, address);
  final isTo = address != null && eq(to, address);
  if (isFrom && isTo) return 'self';
  if (isFrom) return 'out';
  if (isTo) return 'in';
  if (row['direction'] != null) return '${row['direction']}';
  return 'out';
}

// Normalized decode result: kind + warning codes + summary + severity, drawn
// from either the Dart security Inspection or a caller-provided inspect() Map.
class _Decode {
  final String kind;
  final List<String> warnings;
  final String? summary;
  final String severity;
  _Decode(this.kind, this.warnings, this.summary, this.severity);
}

_Decode _normalizeInspection(dynamic insp) {
  if (insp == null) return _Decode('unknown', const [], null, 'none');
  if (insp is sec.Inspection) {
    return _Decode(
      insp.kind,
      insp.warnings.map((w) => w.code).toList(),
      insp.summary,
      insp.severity,
    );
  }
  if (insp is Map) {
    final kind = '${insp['kind'] ?? 'unknown'}';
    final rawW = insp['warnings'];
    final codes = <String>[];
    if (rawW is List) {
      for (final w in rawW) {
        if (w is String) {
          codes.add(w);
        } else if (w is Map && w['code'] != null) {
          codes.add('${w['code']}');
        }
      }
    }
    return _Decode(
      kind,
      codes,
      insp['summary'] == null ? null : '${insp['summary']}',
      '${insp['severity'] ?? 'none'}',
    );
  }
  return _Decode('unknown', const [], null, 'none');
}

Future<_Decode> _inspect(ActivityCtx ctx, Map<String, dynamic> tx) async {
  // allow a caller-provided inspector (wiring.inspect); else the suite directly.
  if (ctx.inspect != null) {
    try {
      final r = await ctx.inspect!('${tx['chain']}', tx);
      if (r != null) return _normalizeInspection(r);
    } catch (_) {/* fall through */}
  }
  try {
    final insp = await sec.inspectTransaction(
        tx, sec.SecCtx(config: ctx.securityConfig ?? const {}));
    return _normalizeInspection(insp);
  } catch (_) {
    return _Decode('unknown', const [], null, 'none');
  }
}

// Pull one chain's raw history via the injected indexer. Distinguishes
// UNAVAILABLE (null / throw -> audited note) from a real empty list ([]).
Future<Map<String, dynamic>> _pullHistory(
    ActivityCtx ctx, String chain, String address) async {
  final hasHistory = ctx.history != null;
  final idx = ctx.indexers != null ? ctx.indexers![chain] : null;
  if (!hasHistory && idx == null) {
    return {
      'rows': const [],
      'note': {
        'chain': chain,
        'note':
            'history unavailable: no indexer configured for $chain — not a claim of no activity.'
      }
    };
  }
  dynamic rows;
  try {
    rows = hasHistory ? await ctx.history!(chain, address) : await idx!(address);
  } catch (e) {
    return {
      'rows': const [],
      'note': {
        'chain': chain,
        'note':
            'history unavailable: indexer error ($e) for $chain — not a claim of no activity.'
      }
    };
  }
  if (rows == null) {
    return {
      'rows': const [],
      'note': {
        'chain': chain,
        'note':
            'history unavailable: indexer returned no result for $chain — not a claim of no activity.'
      }
    };
  }
  return {'rows': rows is List ? rows : const [], 'note': null};
}

// Stable total order: ts DESC, then chain ASC, then txid ASC.
int cmp(Map a, Map b) {
  final at = (a['ts'] as num), bt = (b['ts'] as num);
  if (at != bt) return at > bt ? -1 : 1;
  final ac = '${a['chain']}', bc = '${b['chain']}';
  if (ac != bc) return ac.compareTo(bc) < 0 ? -1 : 1;
  final ax = '${a['txid']}', bx = '${b['txid']}';
  return ax.compareTo(bx) < 0 ? -1 : (ax.compareTo(bx) > 0 ? 1 : 0);
}

String cursorKey(Map it) => '${it['ts']}:${it['chain']}:${it['txid']}';

Map<String, dynamic>? parseCursor(String? c) {
  if (c == null || c.isEmpty) return null;
  final i = c.indexOf(':');
  final j = c.indexOf(':', i + 1);
  if (i < 0 || j < 0) return null;
  return {
    'ts': num.tryParse(c.substring(0, i)) ?? 0,
    'chain': c.substring(i + 1, j),
    'txid': c.substring(j + 1),
  };
}

/// The paged, merged feed.
class ActivityResult {
  final List<Map<String, dynamic>> items;
  final String? nextCursor;
  final List<Map<String, dynamic>> notes;
  ActivityResult({required this.items, this.nextCursor, required this.notes});

  Map<String, dynamic> toMap() => {
        'items': items,
        if (nextCursor != null) 'nextCursor': nextCursor,
        'notes': notes,
      };
}

// ===========================================================================
// activity(accounts, ctx, opts) -> { items, nextCursor?, notes }
// ===========================================================================
Future<ActivityResult> activity(
    List? accounts, ActivityCtx? ctx, ActivityOpts? opts) async {
  ctx = ctx ?? const ActivityCtx();
  opts = opts ?? const ActivityOpts();
  accounts = accounts ?? const [];
  final limit = opts.limit != null ? (opts.limit! < 1 ? 1 : opts.limit!) : 25;

  final items = <Map<String, dynamic>>[];
  final notes = <Map<String, dynamic>>[];
  for (final acc in accounts) {
    final chain = acc is Map ? acc['chain'] : null;
    final address = acc is Map ? acc['address'] : null;
    if (chain == null) continue;
    final pulled = await _pullHistory(ctx, '$chain', '${address ?? ''}');
    final note = pulled['note'];
    if (note != null) notes.add(note as Map<String, dynamic>);
    final rows = pulled['rows'] as List;
    for (final row in rows) {
      if (row is! Map) continue;
      final tx = buildTx('$chain', row);
      final insp = await _inspect(ctx, tx);
      final kind = kKindMap[insp.kind] ?? 'contract';
      final flagged = insp.warnings.any((c) => kCounterpartyFlags.contains(c));
      final direction = directionOf('$chain', row, address, kind);
      final amountBase = row['value'] ?? row['amount'];
      final it = <String, dynamic>{
        'chain': chain,
        'txid': '${row['txid']}',
        'ts': (row['ts'] as num),
        'direction': direction,
        'kind': kind,
        'status': row['status'] ?? 'confirmed',
        'account': address,
        'summary': insp.summary,
        'flagged': flagged,
        'warnings': insp.warnings,
        'severity': insp.severity,
      };
      if (row['asset'] != null) it['asset'] = row['asset'];
      if (amountBase != null) it['amountBase'] = '$amountBase';
      if (row['counterparty'] != null || row['from'] != null || row['to'] != null) {
        it['counterparty'] = row['counterparty'] ??
            (eq(row['from'], address) ? row['to'] : row['from']);
      }
      if (row['fee'] != null) it['feeBase'] = '${row['fee']}';
      if (row['memo'] != null) it['memo'] = row['memo'];
      if (ctx.explorerTx != null) {
        try {
          final u = await ctx.explorerTx!('$chain', row['txid']);
          if (u != null) it['explorerUrl'] = u;
        } catch (_) {}
      }
      items.add(it);
    }
  }

  items.sort(cmp);

  // stable paging: keep only items strictly AFTER the cursor in sort order.
  final cur = parseCursor(opts.cursor);
  var page = items;
  if (cur != null) {
    page = items.where((it) => cmp(cur, it) < 0).toList();
  }
  final slice = page.take(limit).toList();
  String? nextCursor;
  if (page.length > slice.length && slice.isNotEmpty) {
    nextCursor = cursorKey(slice[slice.length - 1]);
  }
  return ActivityResult(items: slice, nextCursor: nextCursor, notes: notes);
}
