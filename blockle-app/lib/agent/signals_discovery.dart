// agent/signals_discovery.dart — a READ-ONLY, lane/mode-aware candidate feed
// powered by the cross-chain signals service (/api/signals/discover). Dart port
// of the browser wiring in web/wallet/vendor/wiring.js (_signalsDiscovery).
//
// The signal bot / scanner passes its { lane, mode } and this client fetches
// same-chain, same-mode candidates that already cleared the rug/holder/liquidity
// gate, mapped to the discovery-row shape the BotRunner expects. It NEVER trades
// and NEVER auto-allowlists — approval + the full value-moving gate still apply at
// dispatch. Returns [] on any error (a flaky feed degrades to "no candidates").

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'bots.dart' as b;

class SignalsDiscovery {
  /// Absolute origin for the mobile/desktop app (the web wallet uses a relative
  /// '/api/...'; here we need the full host).
  final String origin;
  final http.Client _client;

  SignalsDiscovery({this.origin = 'https://blockle.org', http.Client? client})
      : _client = client ?? http.Client();

  /// Lane + mode aware scan. [opts] carries {lane, mode}; both optional.
  Future<List<Map<String, dynamic>>> scan([Map<String, dynamic>? opts]) async {
    opts = opts ?? const {};
    final lane = b.validateLane(opts['lane']);
    final mode = b.validateRiskMode(opts['mode']) ?? 'medium';
    final chain = lane != null ? b.laneChain(lane) : (opts['chain'] as String?);
    final base = lane != null ? b.laneBase(lane) : (opts['base'] as String? ?? 'USDC');

    final qs = {
      'mode': mode,
      if (chain != null && chain.isNotEmpty) 'chain': chain,
      'limit': '15',
    };
    final uri = Uri.parse('$origin/api/signals/discover').replace(queryParameters: qs);

    Map<String, dynamic>? j;
    try {
      final r = await _client.get(uri, headers: const {'accept': 'application/json'});
      if (r.statusCode >= 200 && r.statusCode < 300) {
        final decoded = jsonDecode(r.body);
        if (decoded is Map) j = decoded.cast<String, dynamic>();
      }
    } catch (_) {
      j = null;
    }

    final cands = (j != null && j['candidates'] is List) ? (j['candidates'] as List) : const [];
    final quote = (base ?? 'USDC').toUpperCase();
    final rows = <Map<String, dynamic>>[];
    for (final raw in cands) {
      if (raw is! Map) continue;
      final c = raw.cast<String, dynamic>();
      final m = (c['metrics'] is Map) ? (c['metrics'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
      final sym = ((m['symbol'] as String?) ?? '${c['token']}'.padRight(6).substring(0, 6)).toUpperCase();
      final scoreNum = (c['score'] is num) ? (c['score'] as num).toDouble() : (num.tryParse('${c['score']}')?.toDouble() ?? 0);
      final score = (scoreNum / 100).clamp(0.0, 1.0); // discovery uses 0..1
      final lpLockedPct = m['lpLockedPct'];
      rows.add({
        'pair': '$sym/$quote',
        'token': c['token'], 'chain': c['chain'], 'symbol': sym, 'lane': lane,
        'approved': c['safe'] == true,
        'score': score,
        'hype': c['hype'],
        // enriched slots the discovery/scanner evaluators read:
        'liquidityUsd': m['liquidityUsd'], 'volume24hUsd': m['volume24hUsd'],
        'marketCapUsd': m['marketCapUsd'], 'ageSec': m['ageSec'],
        'topHolderPct': m['topHolderPct'], 'honeypot': m['honeypot'] == true,
        'liquidityLocked': lpLockedPct != null ? (lpLockedPct as num) >= 50 : null,
        'mintAuthorityRenounced': m['mintRenounced'],
        'flags': c['flags'] ?? const [],
      });
    }
    return rows;
  }
}
