// multichain/autoimport.dart — AUTO-DETECT + AUTO-IMPORT held tokens on EVERY
// chain (Dart port of blockle-extension/chains/autoimport.js — the REFERENCE).
//
// On unlock / account-switch / manual refresh the wallet runs per-chain token
// discovery for EVERY enabled chain + custom network and AUTO-IMPORTS (persists)
// any newly-found token that carries a REAL positive balance into the SAME
// persisted list a manual "import token" writes (the `chainTokens` map for EVM /
// Solana / custom nets; the `tokens` id array for BLOCK-20) — so it shows up with
// its balance + in the portfolio automatically, no manual add.
//
// NON-NEGOTIABLE RULES:
//   • NEVER fabricate — a token is imported ONLY with a real detected balance +
//     metadata from the adapter's discoverTokens (balance > 0).
//   • Dedupe by (chain, contract|mint) — re-running adds nothing new (idempotent).
//   • Honor the security suite: a token whose contract/mint is on the denylist, or
//     that trips the spam heuristic, or that carries a scam/honeypot/rug flag, is
//     NOT auto-imported — it is MARKED into a separate `flaggedTokens` list instead.
//   • Default first-class tokens (USDC/USDT/…) are already shown; never re-imported.
//
// PURE core (filterForImport) + an async orchestrator (autoImport) with every
// dependency injected, so it is fully testable with no network. Shared vector:
// docs/scan-vectors.json -> tokenImport.

/// The scam/danger flags that BLOCK an auto-import (fail-closed). A token carrying
/// ANY of these — from the adapter, the discovery feed, or our own checks — is
/// marked, never imported.
const Set<String> kDangerFlags = {
  'honeypot', 'scam', 'rug', 'denylist', 'malicious', 'blocklisted',
};

String _lc(dynamic x) => x == null ? '' : '$x'.toLowerCase();

/// Canonical identity of a token on a chain: (chain, contract|mint|id). Matches
/// the discovery/merge layer so dedupe stays consistent.
String tokenKey(Map<String, dynamic>? t) {
  if (t == null) return '';
  final id = _lc(t['address'] ?? t['mint'] ?? t['contract'] ?? t['id'] ?? t['symbol']);
  return '${_lc(t['chain'])}:$id';
}

/// The on-chain id a persisted entry is keyed by (what addToken writes).
dynamic tokenId(Map<String, dynamic> t) =>
    t['address'] ?? t['mint'] ?? t['contract'] ?? t['id'];

bool hasPositiveBalance(Map<String, dynamic>? t) {
  if (t == null || t['balance'] == null) return false;
  try {
    return BigInt.parse('${t['balance']}') > BigInt.zero;
  } catch (_) {
    return false;
  }
}

/// Spam heuristic — URLs/domains/claim-bait names + absurdly long names are the
/// overwhelming majority of airdrop spam. Mirrors the shared discovery filter.
bool looksSpam(Map<String, dynamic>? t) {
  final name = '${(t?['name'] ?? t?['symbol']) ?? ''}';
  if (name.isEmpty) return false;
  if (name.length > 48) return true;
  if (RegExp(r'https?:\/\/|www\.|\.(com|net|io|org|xyz|app|fi|co|vip|cash|gift)\b',
          caseSensitive: false)
      .hasMatch(name)) {
    return true;
  }
  if (RegExp(
          r'\b(airdrop|claim|voucher|reward|visit|redeem|bonus|free|giveaway|t\.me|telegram)\b',
          caseSensitive: false)
      .hasMatch(name)) {
    return true;
  }
  return false;
}

/// Strip transient balance/display fields — the persisted entry mirrors exactly
/// what addToken writes (chain, kind, symbol, decimals, address|mint). The live
/// balance is re-read by getHoldings; persisting it would go stale.
Map<String, dynamic> normalizeImport(Map<String, dynamic> t) {
  final out = <String, dynamic>{
    'chain': t['chain'],
    'kind': t['kind'] ?? 'erc20',
    'symbol': t['symbol'] ?? 'TOKEN',
    'decimals': t['decimals'] != null ? (num.tryParse('${t['decimals']}') ?? 18).toInt() : 18,
  };
  if (t['address'] != null) out['address'] = t['address'];
  if (t['mint'] != null) out['mint'] = t['mint'];
  if (t['name'] != null) out['name'] = t['name'];
  return out;
}

/// The classification of a discovered batch for one chain.
class ImportFilterResult {
  final List<Map<String, dynamic>> toImport; // each { token }
  final List<Map<String, dynamic>> flagged; // each { token, reason }
  final List<Map<String, dynamic>> skipped; // each { token, reason }
  const ImportFilterResult(this.toImport, this.flagged, this.skipped);
}

/// PURE: classify a batch of DISCOVERED tokens for ONE chain against the
/// already-persisted list + the security denylist. Deterministic, no I/O.
ImportFilterResult filterForImport(
  List<dynamic> discovered,
  List<dynamic> existing, {
  List<String>? denylist,
  bool spamFilter = true,
}) {
  final deny = {for (final d in (denylist ?? const [])) _lc(d)};
  final existingKeys = <String>{
    for (final e in existing)
      if (e is Map) tokenKey(e.cast<String, dynamic>())
  };
  final toImport = <Map<String, dynamic>>[];
  final flagged = <Map<String, dynamic>>[];
  final skipped = <Map<String, dynamic>>[];

  for (final raw in discovered) {
    if (raw is! Map) continue;
    final t = raw.cast<String, dynamic>();
    final key = tokenKey(t);
    if (key.isEmpty || key.endsWith(':')) {
      skipped.add({'token': t, 'reason': 'no-identity'});
      continue;
    }
    // default (first-class) rows are already displayed — never re-imported.
    if (t['isDefault'] == true) {
      skipped.add({'token': t, 'reason': 'default'});
      continue;
    }
    // NEVER fabricate: only a real, strictly-positive detected balance qualifies.
    if (!hasPositiveBalance(t)) {
      skipped.add({'token': t, 'reason': 'zero-balance'});
      continue;
    }
    // idempotent: already persisted -> nothing to do.
    if (existingKeys.contains(key)) {
      skipped.add({'token': t, 'reason': 'already-imported'});
      continue;
    }

    // ---- security gate: denylist / scam flags / spam -> MARK, do not import ----
    final flags = ((t['flags'] is List) ? t['flags'] as List : const []).map(_lc).toList();
    final id = _lc(tokenId(t));
    if (id.isNotEmpty && deny.contains(id)) {
      flagged.add({'token': t, 'reason': 'denylist'});
      continue;
    }
    final danger = flags.firstWhere(kDangerFlags.contains, orElse: () => '');
    if (danger.isNotEmpty) {
      flagged.add({'token': t, 'reason': danger});
      continue;
    }
    if (spamFilter && looksSpam(t)) {
      flagged.add({'token': t, 'reason': 'spam'});
      continue;
    }

    toImport.add({'token': normalizeImport(t)});
  }
  return ImportFilterResult(toImport, flagged, skipped);
}

/// async orchestrator: run discovery for every chain + auto-import.
///
/// deps:
///   registry   — exposes `discoverTokens(chain, addr, opts)` and (optionally)
///                `enabled()`; duck-typed.
///   addressFor(chain) — async -> the account address for a chain
///   store      — { get(keys), set(obj) } chrome.storage-shaped shim
///   chains     — optional explicit chain id list; else registry.enabled()
///   denylist   — optional security denylist (contract/mint strings)
///   spamFilter — default true
///
/// Writes newly-found non-flagged tokens into `chainTokens[chain]` (BLOCK-20 ids
/// into `tokens`), MARKS flagged ones into `flaggedTokens[chain]`, persists, and
/// returns a per-chain summary. Incremental + idempotent.
Future<Map<String, dynamic>> autoImport({
  required dynamic registry,
  dynamic store,
  Future<dynamic> Function(String chain)? addressFor,
  List<String>? chains,
  List<String>? denylist,
  bool spamFilter = true,
}) async {
  if (registry == null) throw ArgumentError('autoImport requires a registry');

  final chainList = chains ??
      (() {
        try {
          final e = registry.enabled();
          return (e is List) ? List<String>.from(e.map((x) => '$x')) : <String>[];
        } catch (_) {
          return <String>[];
        }
      })();

  // load the persisted lists (the SAME keys manual import writes).
  Map<String, dynamic> got = {};
  if (store != null) {
    try {
      final g = await store.get(['chainTokens', 'tokens', 'flaggedTokens']);
      if (g is Map) got = g.cast<String, dynamic>();
    } catch (_) {}
  }
  final chainTokens = <String, dynamic>{
    ...((got['chainTokens'] as Map?)?.cast<String, dynamic>() ?? {})
  };
  final blockIds = <dynamic>[...((got['tokens'] as List?) ?? const [])];
  final flaggedTokens = <String, dynamic>{
    ...((got['flaggedTokens'] as Map?)?.cast<String, dynamic>() ?? {})
  };

  final summary = <String, dynamic>{
    'imported': <Map<String, dynamic>>[],
    'flagged': <Map<String, dynamic>>[],
    'perChain': <String, dynamic>{},
  };
  var changed = false;

  for (final chain in chainList) {
    dynamic address;
    try {
      address = addressFor != null ? await addressFor(chain) : null;
    } catch (_) {
      address = null;
    }
    if (address == null) {
      (summary['perChain'] as Map)[chain] = {'error': 'no-address'};
      continue;
    }

    List<dynamic> discovered = const [];
    try {
      final d = await registry.discoverTokens(chain, address, {'spamFilter': false});
      if (d is List) discovered = d;
    } catch (_) {
      discovered = const [];
    }

    final existing = chain == 'block'
        ? blockIds.map((id) => {'chain': 'block', 'id': id}).toList()
        : ((chainTokens[chain] as List?) ?? const []);

    final res = filterForImport(discovered, existing,
        denylist: denylist, spamFilter: spamFilter);

    // persist the imports into the SAME list a manual import writes.
    if (res.toImport.isNotEmpty) {
      if (chain == 'block') {
        for (final x in res.toImport) {
          final id = tokenId((x['token'] as Map).cast<String, dynamic>());
          if (id != null && !blockIds.contains(id)) {
            blockIds.add(id);
            changed = true;
          }
        }
      } else {
        final list = <dynamic>[...((chainTokens[chain] as List?) ?? const [])];
        final keys = <String>{
          for (final e in list)
            if (e is Map) tokenKey(e.cast<String, dynamic>())
        };
        for (final x in res.toImport) {
          final token = (x['token'] as Map).cast<String, dynamic>();
          final k = tokenKey(token);
          if (!keys.contains(k)) {
            list.add(token);
            keys.add(k);
            changed = true;
          }
        }
        chainTokens[chain] = list;
      }
      for (final x in res.toImport) {
        (summary['imported'] as List).add(x['token']);
      }
    }

    // MARK flagged tokens (deduped) — surfaced in the UI, never auto-imported.
    if (res.flagged.isNotEmpty) {
      final flist = <dynamic>[...((flaggedTokens[chain] as List?) ?? const [])];
      final fkeys = <String>{
        for (final e in flist)
          if (e is Map) tokenKey(e.cast<String, dynamic>())
      };
      for (final f in res.flagged) {
        final token = (f['token'] as Map).cast<String, dynamic>();
        final reason = f['reason'];
        final k = tokenKey(token);
        if (!fkeys.contains(k)) {
          flist.add({...normalizeImport(token), 'reason': reason});
          fkeys.add(k);
          changed = true;
        }
        (summary['flagged'] as List)
            .add({'token': normalizeImport(token), 'reason': reason});
      }
      flaggedTokens[chain] = flist;
    }

    (summary['perChain'] as Map)[chain] = {
      'imported': res.toImport.length,
      'flagged': res.flagged.length,
      'skipped': res.skipped.length,
    };
  }

  if (changed && store != null) {
    try {
      await store.set({
        'chainTokens': chainTokens,
        'tokens': blockIds,
        'flaggedTokens': flaggedTokens,
      });
    } catch (_) {}
  }
  summary['changed'] = changed;
  summary['chainTokens'] = chainTokens;
  summary['tokens'] = blockIds;
  summary['flaggedTokens'] = flaggedTokens;
  return summary;
}
