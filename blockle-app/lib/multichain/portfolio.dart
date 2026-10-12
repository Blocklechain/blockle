// multichain/portfolio.dart — WALLET PORTFOLIO: unified cross-chain NET WORTH
// (docs/WALLET-PORTFOLIO.md §1 + §2.1).
//
// Dart port of blockle-extension/portfolio.js (the JS reference). Behaviourally
// IDENTICAL; asserted against the authoritative docs/portfolio-vectors.json.
//
// READ-ONLY. No signing, no money path. `portfolio(accounts, ctx)` is PURE given
// an injected balance + price ctx: it aggregates the balances the EXISTING chain
// adapters already report (BLOCK, every EVM net + custom, BTC/LTC/DOGE, Solana)
// and prices them from the SHARED live mark source (exchange book mid/last + the
// configured USD price map — the same source the bots use), injected via ctx.
//
// NEVER fabricates a price or a balance: a holding with no resolvable price goes
// to `unpriced` (shown, NOT counted, NOT guessed as 0). All money math is
// integer/BigInt-exact in micro-dollars (uc = round(usd · 1e6), the §8
// convention shared with agent/pnl.dart). The clock is injected (ctx.asOf) —
// this module never calls the clock in its pure logic.
//
// Also a tiny append-only DAILY snapshot store ({ts, totalUsdMicro}, dedup by
// UTC day) that drives the net-worth sparkline (§2.1).

const int kDayMs = 86400000;

// ---- exact integer helpers (mirror agent/pnl + security.dart) --------------
BigInt toBig(dynamic v) {
  if (v is BigInt) return v;
  if (v == null || v == '') return BigInt.zero;
  final s = '$v'.trim();
  if (RegExp(r'^0x[0-9a-fA-F]+$').hasMatch(s)) {
    return BigInt.parse(s.substring(2), radix: 16);
  }
  if (!RegExp(r'^-?\d+$').hasMatch(s)) {
    throw ArgumentError('not a base-unit integer: $s');
  }
  return BigInt.parse(s);
}

/// round(usd · 1e6) as a BigInt of micro-dollars. Half-away-from-zero. A null /
/// non-finite price stays null (never 0) — the never-guess rule.
BigInt? microUsd(dynamic usd) {
  if (usd == null) return null;
  final n = usd is num ? usd : num.tryParse('$usd');
  if (n == null || !n.isFinite) return null;
  return BigInt.from((n * 1e6).round());
}

/// round(num / den) for BigInts, half-away-from-zero. den > 0 required.
BigInt divRound(BigInt num_, BigInt den) {
  if (den <= BigInt.zero) throw ArgumentError('divRound: denominator must be > 0');
  if (num_ >= BigInt.zero) return (num_ + den ~/ BigInt.two) ~/ den;
  return -(((-num_) + den ~/ BigInt.two) ~/ den);
}

/// micro-dollar value of `amountBase` base units of an asset priced at
/// `priceUsd` per WHOLE unit. Exact BigInt math, never a float. Null price
/// (unknown) returns null — never 0.
BigInt? holdingMicro(dynamic amountBase, dynamic decimals, dynamic priceUsd) {
  final pm = microUsd(priceUsd);
  if (pm == null) return null;
  final dec = decimals == null ? 0 : (decimals as num).toInt();
  return divRound(toBig(amountBase) * pm, BigInt.from(10).pow(dec));
}

double microToUsd(BigInt micro) => micro.toDouble() / 1e6;

/// The injected read ctx. `priceUsd` is the SHARED live mark source — either a
/// plain { SYMBOL: price } map or a function(asset)->FutureOr<num?> (the same
/// source the bots consume). `getHoldings`/`getBalance` are the existing chain
/// adapters' balance read. `asOf` is the injected timestamp (ms).
class PortfolioCtx {
  final int? asOf;
  final dynamic priceUsd; // Map<String, dynamic> OR Function(asset)->FutureOr<num?>
  final dynamic marks; // fallback alias for priceUsd
  final Future<dynamic> Function(String chain, String address)? getHoldings;
  final Future<dynamic> Function(String chain, String address)? getBalance;
  const PortfolioCtx({
    this.asOf,
    this.priceUsd,
    this.marks,
    this.getHoldings,
    this.getBalance,
  });
}

// ---- price lookup against the injected shared mark source -----------------
// Returns a finite positive number, or null (null => unpriced; a non-positive /
// NaN price is treated as unknown, never 0).
Future<num?> lookupPrice(PortfolioCtx ctx, dynamic asset) async {
  final sym = ('${(asset is Map ? asset['symbol'] : null) ?? ''}').toUpperCase();
  final src = ctx.priceUsd ?? ctx.marks;
  dynamic v;
  if (src is Function) {
    try {
      v = await src(asset);
    } catch (_) {
      v = null;
    }
  } else if (src is Map) {
    v = src[sym];
  }
  if (v == null) return null;
  final n = v is num ? v : num.tryParse('$v');
  return (n != null && n.isFinite && n > 0) ? n : null;
}

Future<List> _holdingsFor(PortfolioCtx ctx, String chain, String address) async {
  final fn = ctx.getHoldings ?? ctx.getBalance;
  if (fn == null) return const [];
  dynamic rows;
  try {
    rows = await fn(chain, address);
  } catch (_) {
    rows = const [];
  }
  return rows is List ? rows : const [];
}

int _cmpBig(dynamic a, dynamic b) {
  final x = toBig(a), y = toBig(b);
  return x < y ? -1 : (x > y ? 1 : 0);
}

int _cmpStr(dynamic a, dynamic b) {
  final x = '${a ?? ''}', y = '${b ?? ''}';
  return x.compareTo(y) < 0 ? -1 : (x.compareTo(y) > 0 ? 1 : 0);
}

/// The aggregated net worth. `totalUsdMicro` is BigInt-exact as a decimal
/// string; byChain/holdings carry usdMicro strings; `unpriced` is shown but
/// never counted.
class Portfolio {
  final String totalUsdMicro;
  final double totalUsd;
  final List<Map<String, dynamic>> byChain;
  final List<Map<String, dynamic>> holdings;
  final List<Map<String, dynamic>> unpriced;
  final int? asOf;
  Portfolio({
    required this.totalUsdMicro,
    required this.totalUsd,
    required this.byChain,
    required this.holdings,
    required this.unpriced,
    required this.asOf,
  });

  Map<String, dynamic> toMap() => {
        'totalUsdMicro': totalUsdMicro,
        'totalUsd': totalUsd,
        'byChain': byChain,
        'holdings': holdings,
        'unpriced': unpriced,
        'asOf': asOf,
      };
}

// ===========================================================================
// portfolio(accounts, ctx) -> Portfolio
//   accounts: [{ chain, address }]   (one per configured chain + account)
// ===========================================================================
Future<Portfolio> portfolio(List? accounts, PortfolioCtx? ctx) async {
  ctx = ctx ?? const PortfolioCtx();
  accounts = accounts ?? const [];

  final holdings = <Map<String, dynamic>>[];
  final unpriced = <Map<String, dynamic>>[];
  final byChainMicro = <String, BigInt>{};
  var totalMicro = BigInt.zero;

  for (final acc in accounts) {
    final chain = acc is Map ? acc['chain'] : null;
    final address = acc is Map ? acc['address'] : null;
    if (chain == null) continue;
    final rows = await _holdingsFor(ctx, '$chain', '${address ?? ''}');
    for (final row in rows) {
      final asset = (row is Map ? row['asset'] : null) ?? const {};
      final rawAmt = row is Map ? (row['confirmed'] ?? row['balance'] ?? '0') : '0';
      final amountBase = '${rawAmt ?? '0'}';
      BigInt amt;
      try {
        amt = toBig(amountBase);
      } catch (_) {
        continue;
      }
      if (amt <= BigInt.zero) continue; // omit dust/zero — contributes nothing
      final decimals = (asset is Map && asset['decimals'] != null)
          ? (asset['decimals'] as num).toInt()
          : 0;
      final symbol = (asset is Map ? asset['symbol'] : null) ?? '?';
      final price = await lookupPrice(ctx, asset);
      if (price == null) {
        unpriced.add({
          'chain': chain,
          'symbol': symbol,
          'amountBase': amt.toString(),
          'decimals': decimals,
          'asset': asset,
        });
        holdings.add({
          'chain': chain,
          'asset': asset,
          'symbol': symbol,
          'amountBase': amt.toString(),
          'decimals': decimals,
          'priceUsd': null,
          'usdMicro': null,
          'usd': null,
          'pricedOk': false,
        });
        continue;
      }
      final micro = holdingMicro(amt, decimals, price)!;
      totalMicro += micro;
      byChainMicro['$chain'] = (byChainMicro['$chain'] ?? BigInt.zero) + micro;
      holdings.add({
        'chain': chain,
        'asset': asset,
        'symbol': symbol,
        'amountBase': amt.toString(),
        'decimals': decimals,
        'priceUsd': price,
        'usdMicro': micro.toString(),
        'usd': microToUsd(micro),
        'pricedOk': true,
      });
    }
  }

  // byChain with BigInt-exact pct (basis points) using LARGEST-REMAINDER
  // apportionment so the bps ALWAYS sum to exactly 10000 (independent rounding
  // can drift to 9999/10001). floor(micro*10000/total) each; the leftover bps go
  // to the largest remainders, tie-broken by chain asc for determinism.
  final byChain = <Map<String, dynamic>>[];
  final parts = <Map<String, dynamic>>[];
  byChainMicro.forEach((chain, micro) {
    if (totalMicro > BigInt.zero) {
      final scaled = micro * BigInt.from(10000);
      parts.add({'chain': chain, 'micro': micro, 'bps': scaled ~/ totalMicro, 'rem': scaled % totalMicro});
    } else {
      parts.add({'chain': chain, 'micro': micro, 'bps': BigInt.zero, 'rem': BigInt.zero});
    }
  });
  if (totalMicro > BigInt.zero && parts.isNotEmpty) {
    var assigned = BigInt.zero;
    for (final p in parts) {
      assigned += p['bps'] as BigInt;
    }
    var leftover = BigInt.from(10000) - assigned; // in [0, nChains)
    final order = List<Map<String, dynamic>>.from(parts)
      ..sort((a, b) {
        final r = _cmpBig((b['rem'] as BigInt).toString(), (a['rem'] as BigInt).toString());
        return r != 0 ? r : _cmpStr(a['chain'], b['chain']);
      });
    for (var i = 0; i < order.length && leftover > BigInt.zero; i++) {
      order[i]['bps'] = (order[i]['bps'] as BigInt) + BigInt.one;
      leftover -= BigInt.one;
    }
  }
  for (final p in parts) {
    final pctBps = (p['bps'] as BigInt).toInt();
    final micro = p['micro'] as BigInt;
    byChain.add({
      'chain': p['chain'],
      'usdMicro': micro.toString(),
      'usd': microToUsd(micro),
      'pctBps': pctBps,
      'pct': pctBps / 100,
    });
  }

  // deterministic ordering: priced holdings by value desc then chain/symbol;
  // byChain by value desc then chain.
  byChain.sort((a, b) {
    final v = _cmpBig(b['usdMicro'], a['usdMicro']);
    return v != 0 ? v : _cmpStr(a['chain'], b['chain']);
  });
  holdings.sort((a, b) {
    final av = a['pricedOk'] == true ? 1 : 0, bv = b['pricedOk'] == true ? 1 : 0;
    if (av != bv) return bv - av; // priced first
    final byVal = _cmpBig(b['usdMicro'] ?? '0', a['usdMicro'] ?? '0');
    if (byVal != 0) return byVal;
    final byChainCmp = _cmpStr(a['chain'], b['chain']);
    return byChainCmp != 0 ? byChainCmp : _cmpStr(a['symbol'], b['symbol']);
  });
  unpriced.sort((a, b) {
    final c = _cmpStr(a['chain'], b['chain']);
    return c != 0 ? c : _cmpStr(a['symbol'], b['symbol']);
  });

  return Portfolio(
    totalUsdMicro: totalMicro.toString(),
    totalUsd: microToUsd(totalMicro),
    byChain: byChain,
    holdings: holdings,
    unpriced: unpriced,
    asOf: ctx.asOf,
  );
}

// ===========================================================================
// §2.1 DAILY SNAPSHOT STORE — append-only, dedup by UTC day. Pure: the caller
// injects `ts` (never a clock call here). An entry carries the net-worth total
// in micro-dollars (BigInt-exact string) so the sparkline is lossless.
// ===========================================================================
int dayOf(dynamic ts) {
  final n = ts is num ? ts : num.parse('$ts');
  return (n / kDayMs).floor();
}

/// Append {ts, totalUsdMicro} to `history` (array, oldest→newest). Dedup by day:
/// a second write for a day REPLACES that day's point (latest total for the day
/// wins). Returns a NEW sorted list; never mutates the input.
List<Map<String, dynamic>> recordSnapshot(List? history, Map entry) {
  final list = <Map<String, dynamic>>[
    for (final p in (history ?? const [])) Map<String, dynamic>.from(p as Map)
  ];
  final tsRaw = entry['ts'];
  final ts = tsRaw is num ? tsRaw : num.tryParse('$tsRaw');
  if (ts == null || !ts.isFinite) {
    throw ArgumentError('recordSnapshot: ts (ms) is required');
  }
  final totalUsdMicro = '${entry['totalUsdMicro'] ?? entry['totalUsd'] ?? '0'}';
  final day = dayOf(ts);
  final point = {'ts': ts, 'day': day, 'totalUsdMicro': totalUsdMicro};
  final i = list.indexWhere((p) => p['day'] == day);
  if (i >= 0) {
    list[i] = point;
  } else {
    list.add(point);
  }
  list.sort((a, b) => (a['ts'] as num).compareTo(b['ts'] as num));
  return list;
}

/// The last `n` points (default 30) as {ts, totalUsdMicro, usd} for the sparkline.
List<Map<String, dynamic>> sparkline(List? history, [int? n]) {
  final list = history ?? const [];
  final take = n ?? 30;
  final start = list.length - take;
  return [
    for (final p in list.sublist(start < 0 ? 0 : start))
      {
        'ts': (p as Map)['ts'],
        'totalUsdMicro': '${p['totalUsdMicro']}',
        'usd': microToUsd(toBig(p['totalUsdMicro'])),
      }
  ];
}
