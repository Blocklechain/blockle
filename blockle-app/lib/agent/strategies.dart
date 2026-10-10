// agent/strategies.dart — the five trading STRATEGIES (Dart implementation of
// docs/AGENT-STRATEGIES.md sections 1-3). One spec, three langs, identical
// names/params/defaults/decisions.
//
// NON-NEGOTIABLE: a strategy is a PLANNER, not an executor. plan() is READ-ONLY —
// it reads market/balance data through [StrategyContext] and returns a list of
// [StrategyIntent]. It NEVER signs, broadcasts, touches keys, routes fees, or
// records spend. Every Intent it returns is dispatched by the [StrategyRunner]
// through the EXISTING value-moving pipeline (prepare -> assessValue ->
// gateConfirm -> commit -> recordSpend), so caps/confirm/allowlist/kill/audit/fee
// all still apply and cannot be bypassed.
//
// All amounts are BASE-UNIT decimal strings; money math is exact BigInt. now() is
// injected via the context (pure logic never calls the wall clock directly). bps
// params are integers.

import 'dart:math' as math;

/// The REAL, non-bypassable per-leg agent fee (0.05% = 5 bps). This is the same
/// fixed rate the `swap` tool / venue `buildSwap` charges on-chain. The arbitrage
/// edge math must count TWO of these legs; a caller may never configure the fee
/// term below this floor (that would let it propose a loss-making arb). See
/// docs/AGENT-STRATEGIES.md section 5.
const int AGENT_FEE_BPS = 5;

/// A conservative non-zero slippage floor (bps). A caller may raise slippage but
/// never configure it below this — understating slippage would under-count cost.
const int kSlippageFloorBps = 5;

// ===========================================================================
// Intent + context
// ===========================================================================

/// A planned action. Shape mirrors AGENT-STRATEGIES.md section 1.
class StrategyIntent {
  /// One of: swap | buy_block | sell_block | place_order | cancel_order | send.
  final String tool;

  /// Exactly the args the named tool's prepare() expects.
  final Map<String, dynamic> args;

  /// Human-readable "why" (shown in confirm + audit).
  final String rationale;

  /// Best-effort USD notional for the cap USD path (null when unknown).
  final num? estUsd;

  /// The strategy name that produced it.
  final String strategy;

  /// Stable id, e.g. 'arb:BLOCK/USDC:blockle->evmdex'.
  final String tag;

  /// Group tag for all-or-nothing legs (arbitrage pairs). When any member of a
  /// group is dropped (not allowlisted), the runner drops the whole group.
  final String? pair;

  /// Routes through a mainnet venue — the runner refuses it unless the host
  /// enabled mainnet. Default false (testnet/dry).
  final bool mainnet;

  const StrategyIntent({
    required this.tool,
    required this.args,
    required this.rationale,
    required this.strategy,
    required this.tag,
    this.estUsd,
    this.pair,
    this.mainnet = false,
  });

  Map<String, dynamic> toJson() => {
        'tool': tool,
        'args': args,
        'rationale': rationale,
        'estUsd': estUsd,
        'strategy': strategy,
        'tag': tag,
        if (pair != null) 'pair': pair,
        'mainnet': mainnet,
      };
}

/// READ-ONLY accessors a strategy may use. Every field is an injected closure so
/// the strategies stay pure + testable; there is NO commit path here.
class StrategyContext {
  /// Monotonic wall-clock in ms. Injected/mockable — pure logic must use this,
  /// never DateTime.now() directly.
  final int Function() now;

  /// The resolved chain network for this run, e.g. 'mainnet' | 'testnet' | 'dry'.
  /// CHAIN-LEVEL mainnet backstop (docs/AGENT-STRATEGIES.md section 0 + FIX-3):
  /// when this reports 'mainnet', EVERY strategy's Intent is treated as mainnet —
  /// even the venue-less auto-routed swaps from dca/grid/rebalance/momentum — so
  /// the runner refuses it unless the host set mainnetEnabled=true. Independent of
  /// any caller `mainnet` param and of venue descriptors.
  final String Function()? network;

  /// listVenues(pair) -> [{id, chain, mainnet, ask, bid, feeBps, depthBase?}].
  /// ask/bid are quote-per-base decimal strings; feeBps is the venue trade fee.
  final Future<List<Map<String, dynamic>>> Function(String pair)? listVenues;

  /// A single venue's executable quote (optional alt to the ask/bid snapshot).
  final Future<Map<String, dynamic>> Function(
      String venue, String from, String to, String amountBase)? venueQuote;

  /// getBook(market) -> { bids:[{price,size}...], asks:[...] } (best first).
  final Future<Map<String, dynamic>?> Function(String market)? getBook;

  /// Recent fills for a market.
  final Future<List<Map<String, dynamic>>> Function(String market)? getTrades;

  /// Exchange markets.
  final Future<List<Map<String, dynamic>>> Function()? getMarkets;

  /// Balances for a chain (pass '*' for the whole portfolio).
  /// Rows: [{asset:{symbol,decimals,chain}, confirmed}].
  final Future<List<Map<String, dynamic>>> Function(String chain, [dynamic tokens])?
      getBalance;

  /// USD unit prices for symbols (whole-token price). Stablecoins default to 1.
  final Future<Map<String, num>> Function(List<String> symbols)? prices;

  /// Remaining policy headroom: { sessionUsd: num?|null, perAsset: {...} }.
  final Map<String, dynamic> Function()? policyRemaining;

  /// Open resting orders for a market: [{side, price, size}].
  final List<Map<String, dynamic>> Function(String market)? openOrders;

  /// Optional note sink (skipped reasons etc.). The runner wires it to the audit.
  final void Function(Map<String, dynamic> note)? note;

  const StrategyContext({
    required this.now,
    this.network,
    this.listVenues,
    this.venueQuote,
    this.getBook,
    this.getTrades,
    this.getMarkets,
    this.getBalance,
    this.prices,
    this.policyRemaining,
    this.openOrders,
    this.note,
  });

  void skip(String tag, String reason, [Map<String, dynamic>? extra]) =>
      note?.call({'skipped': reason, 'tag': tag, ...?extra});
}

// ===========================================================================
// Strategy interface
// ===========================================================================

abstract class Strategy {
  String get name;
  String describe();
  Map<String, dynamic> get defaults;

  /// Validate + fill defaults + clamp ranges. Throws [ArgumentError] on bad input.
  Map<String, dynamic> validateParams(Map<String, dynamic>? params);

  /// READ-ONLY. Returns [] when no action is warranted.
  Future<List<StrategyIntent>> plan(StrategyContext ctx, Map<String, dynamic> params);
}

// ===========================================================================
// numeric helpers (exact where it affects money)
// ===========================================================================

const Set<String> _stables = {'USDC', 'USDT', 'DAI', 'USD', 'USDB', 'TUSD', 'PYUSD'};

bool _isStable(String sym) => _stables.contains(sym.toUpperCase());

/// CHAIN-LEVEL mainnet backstop. True when the run's resolved network is mainnet,
/// regardless of any venue descriptor or caller `mainnet` param. Fail-safe: any
/// error reading the network reports false (the runner's refusal still applies to
/// anything the strategy/venue flagged).
bool _ctxNetworkMainnet(StrategyContext ctx) {
  try {
    return ctx.network?.call() == 'mainnet';
  } catch (_) {
    return false;
  }
}

BigInt _pow10(int n) => BigInt.from(10).pow(n);

num _numOf(dynamic v) => v is num ? v : num.parse('$v');

/// Parse a decimal string into an integer scaled by 10^[scale] (floor toward 0).
BigInt _toScaled(String s, int scale) {
  s = s.trim();
  final neg = s.startsWith('-');
  if (neg) s = s.substring(1);
  final dot = s.indexOf('.');
  var intPart = dot < 0 ? s : s.substring(0, dot);
  var fracPart = dot < 0 ? '' : s.substring(dot + 1);
  if (intPart.isEmpty) intPart = '0';
  if (fracPart.length > scale) {
    fracPart = fracPart.substring(0, scale);
  } else {
    fracPart = fracPart.padRight(scale, '0');
  }
  final v = BigInt.parse(scale > 0 ? intPart + fracPart : intPart);
  return neg ? -v : v;
}

/// Format an integer scaled by 10^[scale] back into a trimmed decimal string.
String _fmtScaled(BigInt v, int scale) {
  final neg = v.isNegative;
  final s = v.abs().toString().padLeft(scale + 1, '0');
  final i = s.substring(0, s.length - scale);
  var f = scale > 0 ? s.substring(s.length - scale) : '';
  f = f.replaceFirst(RegExp(r'0+$'), '');
  final out = f.isEmpty ? i : '$i.$f';
  return neg ? '-$out' : out;
}

/// Gross edge in bps between a best ask and a best bid: (bid-ask)/ask*1e4, exact.
int _edgeBps(String ask, String bid) {
  final a = _toScaled(ask, 18);
  final b = _toScaled(bid, 18);
  if (a <= BigInt.zero) return 0;
  return (((b - a) * BigInt.from(10000)) ~/ a).toInt();
}

/// Decompose a (positive) number into an exact (mantissa, scale) pair such that
/// value == mantissa / 10^scale, using its shortest round-trip decimal string.
/// Expands any scientific notation so no low digits are silently dropped.
({BigInt mantissa, int scale}) _decompose(num v) {
  var s = v.toString();
  var exp = 0;
  final e = s.indexOf(RegExp(r'[eE]'));
  if (e >= 0) {
    exp = int.parse(s.substring(e + 1));
    s = s.substring(0, e);
  }
  final neg = s.startsWith('-');
  if (neg) s = s.substring(1);
  final dot = s.indexOf('.');
  var intPart = dot < 0 ? s : s.substring(0, dot);
  var fracPart = dot < 0 ? '' : s.substring(dot + 1);
  if (intPart.isEmpty) intPart = '0';
  var scale = fracPart.length;
  var mantissa = BigInt.parse(intPart + fracPart);
  // Fold the base-10 exponent into the scale (and pad when it goes positive).
  scale -= exp;
  if (scale < 0) {
    mantissa *= _pow10(-scale);
    scale = 0;
  }
  if (neg) mantissa = -mantissa;
  return (mantissa: mantissa, scale: scale);
}

/// USD -> base units of an asset priced at [unitUsd] USD/whole-token, [dec] dp.
/// Floors toward zero. FULLY INTEGER/BigInt-exact (FIX-4): no float multiply, so
/// 18-decimal (1e18) assets lose no low digits and the result is deterministic
/// across the JS / Dart / Python wallets.
///   base = floor( usd / unitUsd * 10^dec )
BigInt _usdToBase(num usd, num unitUsd, int dec) {
  if (unitUsd <= 0 || usd <= 0) return BigInt.zero;
  final u = _decompose(usd); // usd  = u.mantissa / 10^u.scale
  final p = _decompose(unitUsd); // unit = p.mantissa / 10^p.scale
  // base = (u.m/10^u.s) / (p.m/10^p.s) * 10^dec
  //      = u.m * 10^p.s * 10^dec / (p.m * 10^u.s)   (all exact integers)
  final numer = u.mantissa * _pow10(p.scale) * _pow10(dec);
  final denom = p.mantissa * _pow10(u.scale);
  if (denom <= BigInt.zero) return BigInt.zero;
  return numer ~/ denom; // floor (both operands positive here)
}

/// Public BigInt-exact USD->base-unit conversion (FIX-4), argument order matching
/// the JS/Python wallets: usdToBase(usd, decimals, unitUsd). Exposed so the
/// cross-language vectors can be checked directly.
BigInt usdToBase(num usd, int decimals, num unitUsd) =>
    _usdToBase(usd, unitUsd, decimals);

List<String> _splitPair(String pair) {
  final parts = pair.split(RegExp(r'[\/\-_:]'));
  if (parts.length < 2) throw ArgumentError('pair must be BASE/QUOTE: $pair');
  return [parts[0].toUpperCase(), parts[1].toUpperCase()];
}

int _clampInt(dynamic v, int lo, int hi, int dflt) {
  if (v == null) return dflt;
  final n = (v is num ? v : num.tryParse('$v'))?.round() ?? dflt;
  return n < lo ? lo : (n > hi ? hi : n);
}

num _numParam(dynamic v, num dflt) {
  if (v == null) return dflt;
  return v is num ? v : (num.tryParse('$v') ?? dflt);
}

double _unitUsd(String sym, Map<String, num> px) {
  final v = px[sym] ?? px[sym.toUpperCase()];
  if (v != null) return v.toDouble();
  if (_isStable(sym)) return 1.0;
  return 0.0; // unknown -> caller must skip (never fabricate a price)
}

// ===========================================================================
// 3.1 arbitrage (headline)
// ===========================================================================

class ArbitrageStrategy extends Strategy {
  @override
  String get name => 'arbitrage';
  @override
  String describe() =>
      'Capture a cross-venue price gap on one pair, net of both venues\' fees, two '
      '0.05% agent-fee legs, slippage and a gas buffer.';
  @override
  Map<String, dynamic> get defaults => {
        'minEdgeBps': 30,
        'maxNotionalUsd': 50,
        'gasBufferUsd': 2,
        'slippageBps': 10,
        'agentFeeBps': AGENT_FEE_BPS,
      };

  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) {
    final p = {...defaults, ...?params};
    if (p['pair'] == null || '${p['pair']}'.isEmpty) {
      throw ArgumentError('arbitrage: `pair` is required (e.g. "BLOCK/USDC")');
    }
    p['pair'] = '${p['pair']}'.toUpperCase();
    p['minEdgeBps'] = _clampInt(p['minEdgeBps'], 0, 100000, 30);
    p['maxNotionalUsd'] = _numParam(p['maxNotionalUsd'], 50);
    p['gasBufferUsd'] = _numParam(p['gasBufferUsd'], 2);
    // FIX-2: slippage has a conservative non-zero floor so it can never be
    // configured to understate cost, and the agent-fee term is PINNED at the real
    // on-chain fee (AGENT_FEE_BPS per leg) — a caller may raise it but never drop
    // it below the fee the swap tool actually charges, which would let the edge
    // math clear on a loss-making arb.
    p['slippageBps'] = _clampInt(p['slippageBps'], kSlippageFloorBps, 100000, 10);
    p['agentFeeBps'] =
        _clampInt(p['agentFeeBps'], AGENT_FEE_BPS, 100000, AGENT_FEE_BPS);
    if (p['venues'] != null && p['venues'] is! List) {
      throw ArgumentError('arbitrage: `venues` must be a list of venue ids');
    }
    return p;
  }

  @override
  Future<List<StrategyIntent>> plan(
      StrategyContext ctx, Map<String, dynamic> params) async {
    final pair = params['pair'] as String;
    final parts = _splitPair(pair);
    final base = parts[0], quote = parts[1];
    final minEdgeBps = params['minEdgeBps'] as int;
    final maxNotionalUsd = params['maxNotionalUsd'] as num;
    final gasBufferUsd = params['gasBufferUsd'] as num;
    final slippageBps = params['slippageBps'] as int;
    final agentFeeBps = params['agentFeeBps'] as int;

    if (ctx.listVenues == null) {
      ctx.skip('arb:$pair', 'no venue source');
      return const [];
    }
    var snaps = await ctx.listVenues!(pair);
    if (params['venues'] is List) {
      final want = (params['venues'] as List).map((e) => '$e').toSet();
      snaps = snaps.where((v) => want.contains('${v['id']}')).toList();
    }
    // Keep only venues that can quote both sides (never fabricate a price).
    final q = snaps
        .where((v) => v['ask'] != null && v['bid'] != null)
        .toList();
    if (q.length < 2) {
      ctx.skip('arb:$pair', 'need >=2 quotable venues, have ${q.length}');
      return const [];
    }

    Map<String, dynamic> buy = q.first, sell = q.first;
    for (final v in q) {
      if (_toScaled('${v['ask']}', 18) < _toScaled('${buy['ask']}', 18)) buy = v;
      if (_toScaled('${v['bid']}', 18) > _toScaled('${sell['bid']}', 18)) sell = v;
    }
    if (buy['id'] == sell['id']) {
      ctx.skip('arb:$pair', 'same venue is best bid and ask — no edge');
      return const [];
    }

    final grossEdgeBps = _edgeBps('${buy['ask']}', '${sell['bid']}');

    // notional sizing (USD): probe vs depth-at-both vs policy remaining.
    final px = ctx.prices != null ? await ctx.prices!([quote]) : <String, num>{};
    final quoteUsd = _unitUsd(quote, px);
    final effQuoteUsd = quoteUsd == 0 && _isStable(quote) ? 1.0 : quoteUsd;
    if (effQuoteUsd <= 0) {
      ctx.skip('arb:$pair', 'no USD price for quote $quote');
      return const [];
    }

    final remaining = ctx.policyRemaining?.call();
    final sessionUsd = remaining == null ? null : remaining['sessionUsd'] as num?;
    var notionalUsd = maxNotionalUsd.toDouble();
    if (sessionUsd != null) notionalUsd = math.min(notionalUsd, sessionUsd.toDouble());
    notionalUsd = math.min(notionalUsd, _depthUsd(buy, 'ask', base, effQuoteUsd));
    notionalUsd = math.min(notionalUsd, _depthUsd(sell, 'bid', base, effQuoteUsd));
    if (notionalUsd <= 0) {
      ctx.skip('arb:$pair', 'no notional headroom (depth/cap)');
      return const [];
    }

    final gasBps = (gasBufferUsd / notionalUsd * 10000).ceil();
    final buyFee = _clampInt(buy['feeBps'], 0, 100000, 0);
    final sellFee = _clampInt(sell['feeBps'], 0, 100000, 0);
    final costsBps = buyFee + sellFee + 2 * agentFeeBps + slippageBps + gasBps;
    final netEdgeBps = grossEdgeBps - costsBps;

    if (netEdgeBps < minEdgeBps) {
      ctx.skip('arb:$pair', 'net edge ${netEdgeBps}bps < min ${minEdgeBps}bps',
          {'grossEdgeBps': grossEdgeBps, 'costsBps': costsBps});
      return const [];
    }

    // Size a BALANCED pair in exact base units.
    final baseDecs = _decOf(base, 8);
    final quoteDecs = _decOf(quote, 6);
    final buyAskUsd = double.parse('${buy['ask']}') * effQuoteUsd;
    final baseQty = _usdToBase(notionalUsd, buyAskUsd, baseDecs); // base units bought
    if (baseQty <= BigInt.zero) {
      ctx.skip('arb:$pair', 'sized base qty rounds to zero');
      return const [];
    }
    // quote spent on the buy leg = baseQty * ask (exact), in quote base units.
    final askScaled = _toScaled('${buy['ask']}', 18);
    final quoteIn =
        (baseQty * askScaled * _pow10(quoteDecs)) ~/ (_pow10(baseDecs) * _pow10(18));

    // FIX-3: mainnet if EITHER venue is mainnet OR the resolved chain network is
    // mainnet (chain-level backstop — never trust only the venue descriptors).
    final mainnet = (buy['mainnet'] == true) ||
        (sell['mainnet'] == true) ||
        _ctxNetworkMainnet(ctx);
    final pairTag = 'arb:$pair:${buy['id']}->${sell['id']}';
    final nativeBase = base == 'BLOCK' && _isStable(quote);

    final rationale =
        'net edge ${netEdgeBps}bps (gross ${grossEdgeBps}bps - costs ${costsBps}bps) '
        '>= min ${minEdgeBps}bps: buy $base on ${buy['id']} @ ${buy['ask']} $quote, '
        'sell on ${sell['id']} @ ${sell['bid']} $quote, ~\$${notionalUsd.toStringAsFixed(2)} notional.';

    // Buy leg.
    final StrategyIntent buyLeg;
    if (nativeBase && buy['id'] == 'blockle') {
      buyLeg = StrategyIntent(
        tool: 'buy_block',
        args: {'usdc': quoteIn.toString()},
        rationale: rationale,
        estUsd: notionalUsd,
        strategy: name,
        tag: '$pairTag:buy',
        pair: pairTag,
        mainnet: mainnet,
      );
    } else {
      buyLeg = StrategyIntent(
        tool: 'swap',
        args: {
          'from': quote,
          'to': base,
          'amount': quoteIn.toString(),
          'venue': buy['id'],
          'chain': buy['chain'],
          if (params['slippage'] != null) 'slippage': params['slippage'],
        },
        rationale: rationale,
        estUsd: notionalUsd,
        strategy: name,
        tag: '$pairTag:buy',
        pair: pairTag,
        mainnet: mainnet,
      );
    }

    // Sell leg.
    final StrategyIntent sellLeg;
    if (nativeBase && sell['id'] == 'blockle') {
      sellLeg = StrategyIntent(
        tool: 'sell_block',
        args: {'blockAmount': baseQty.toString()},
        rationale: rationale,
        estUsd: notionalUsd,
        strategy: name,
        tag: '$pairTag:sell',
        pair: pairTag,
        mainnet: mainnet,
      );
    } else {
      sellLeg = StrategyIntent(
        tool: 'swap',
        args: {
          'from': base,
          'to': quote,
          'amount': baseQty.toString(),
          'venue': sell['id'],
          'chain': sell['chain'],
          if (params['slippage'] != null) 'slippage': params['slippage'],
        },
        rationale: rationale,
        estUsd: notionalUsd,
        strategy: name,
        tag: '$pairTag:sell',
        pair: pairTag,
        mainnet: mainnet,
      );
    }

    return [buyLeg, sellLeg];
  }

  double _depthUsd(Map<String, dynamic> v, String priceKey, String base, double quoteUsd) {
    final depthBase = v['depthBase'];
    if (depthBase == null) return double.infinity;
    final dec = _decOf(base, 8);
    final whole = double.parse('$depthBase') / math.pow(10, dec);
    final price = double.parse('${v[priceKey]}') * quoteUsd;
    return whole * price;
  }
}

// ===========================================================================
// 3.2 dca
// ===========================================================================

class DcaStrategy extends Strategy {
  @override
  String get name => 'dca';
  @override
  String describe() => 'Buy a fixed USD amount of an asset once per interval.';
  @override
  Map<String, dynamic> get defaults => {
        'quote': 'USDC',
        'usdPerBuy': 10,
        'intervalSec': 86400,
        'lastRunAt': 0,
      };

  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) {
    final p = {...defaults, ...?params};
    if (p['asset'] == null || '${p['asset']}'.isEmpty) {
      throw ArgumentError('dca: `asset` is required');
    }
    p['asset'] = '${p['asset']}'.toUpperCase();
    p['quote'] = '${p['quote']}'.toUpperCase();
    p['usdPerBuy'] = _numParam(p['usdPerBuy'], 10);
    p['intervalSec'] = _numParam(p['intervalSec'], 86400);
    p['lastRunAt'] = _numParam(p['lastRunAt'], 0);
    p['mainnet'] = p['mainnet'] == true;
    return p;
  }

  @override
  Future<List<StrategyIntent>> plan(
      StrategyContext ctx, Map<String, dynamic> params) async {
    final asset = params['asset'] as String;
    final quote = params['quote'] as String;
    final usdPerBuy = params['usdPerBuy'] as num;
    final intervalMs = (params['intervalSec'] as num) * 1000;
    final lastRunAt = (params['lastRunAt'] as num);
    final elapsed = ctx.now() - lastRunAt;
    if (elapsed < intervalMs) {
      ctx.skip('dca:$asset', 'interval not elapsed (${elapsed}ms < ${intervalMs}ms)');
      return const [];
    }
    final px = ctx.prices != null ? await ctx.prices!([quote]) : <String, num>{};
    final quoteUsd = _unitUsd(quote, px);
    final effQuoteUsd = quoteUsd == 0 && _isStable(quote) ? 1.0 : quoteUsd;
    if (effQuoteUsd <= 0) {
      ctx.skip('dca:$asset', 'no USD price for quote $quote');
      return const [];
    }
    final quoteDecs = _decOf(quote, 6);
    final amount = _usdToBase(usdPerBuy, effQuoteUsd, quoteDecs);
    if (amount <= BigInt.zero) return const [];
    return [
      StrategyIntent(
        tool: 'swap',
        args: {
          'from': quote,
          'to': asset,
          'amount': amount.toString(),
          if (params['slippage'] != null) 'slippage': params['slippage'],
        },
        rationale:
            'DCA: buy \$$usdPerBuy of $asset with $quote (interval ${params['intervalSec']}s elapsed).',
        estUsd: usdPerBuy,
        strategy: name,
        tag: 'dca:$asset',
        mainnet: (params['mainnet'] == true) || _ctxNetworkMainnet(ctx),
      ),
    ];
  }
}

// ===========================================================================
// 3.3 grid
// ===========================================================================

class GridStrategy extends Strategy {
  @override
  String get name => 'grid';
  @override
  String describe() =>
      'Place a symmetric ladder of buy/sell limit orders around the mid price.';
  @override
  Map<String, dynamic> get defaults => {
        'levels': 6,
        'stepBps': 50,
        'sizeUsdPerLevel': 10,
        'recenter': false,
      };

  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) {
    final p = {...defaults, ...?params};
    if (p['market'] == null || '${p['market']}'.isEmpty) {
      throw ArgumentError('grid: `market` is required (e.g. "BLOCK/USDC")');
    }
    p['market'] = '${p['market']}'.toUpperCase();
    p['levels'] = _clampInt(p['levels'], 2, 20, 6);
    p['stepBps'] = _clampInt(p['stepBps'], 1, 100000, 50);
    p['sizeUsdPerLevel'] = _numParam(p['sizeUsdPerLevel'], 10);
    p['recenter'] = p['recenter'] == true;
    p['mainnet'] = p['mainnet'] == true;
    return p;
  }

  @override
  Future<List<StrategyIntent>> plan(
      StrategyContext ctx, Map<String, dynamic> params) async {
    final market = params['market'] as String;
    final parts = _splitPair(market);
    final base = parts[0], quote = parts[1];
    final levels = params['levels'] as int;
    final stepBps = params['stepBps'] as int;
    final sizeUsd = params['sizeUsdPerLevel'] as num;

    if (ctx.getBook == null) {
      ctx.skip('grid:$market', 'no order book source');
      return const [];
    }
    final book = await ctx.getBook!(market);
    final bestBid = _bestPrice(book?['bids']);
    final bestAsk = _bestPrice(book?['asks']);
    if (bestBid == null || bestAsk == null) {
      ctx.skip('grid:$market', 'order book missing a side');
      return const [];
    }
    // mid = (bid+ask)/2, scaled by 1e18.
    final mid = (_toScaled(bestBid, 18) + _toScaled(bestAsk, 18)) ~/ BigInt.two;
    if (mid <= BigInt.zero) {
      ctx.skip('grid:$market', 'non-positive mid');
      return const [];
    }

    final px = ctx.prices != null ? await ctx.prices!([quote]) : <String, num>{};
    final quoteUsd = _unitUsd(quote, px);
    final effQuoteUsd = quoteUsd == 0 && _isStable(quote) ? 1.0 : quoteUsd;
    if (effQuoteUsd <= 0) {
      ctx.skip('grid:$market', 'no USD price for quote $quote');
      return const [];
    }
    final baseDecs = _decOf(base, 8);
    final open = ctx.openOrders?.call(market) ?? const [];
    final halfStep = (mid * BigInt.from(stepBps)) ~/ (BigInt.from(10000) * BigInt.two);

    final half = levels ~/ 2;
    final out = <StrategyIntent>[];

    BigInt priceAt(int k, bool up) {
      final f = BigInt.from(10000 + (up ? 1 : -1) * k * stepBps);
      return (mid * f) ~/ BigInt.from(10000);
    }

    bool occupied(String side, BigInt priceScaled) {
      for (final o in open) {
        if ('${o['side']}'.toLowerCase() != side) continue;
        final op = _toScaled('${o['price']}', 18);
        if ((op - priceScaled).abs() <= halfStep) return true;
      }
      return false;
    }

    StrategyIntent? level(int k, String side) {
      final up = side == 'sell';
      final priceScaled = priceAt(k, up);
      if (priceScaled <= BigInt.zero) return null;
      if (occupied(side, priceScaled)) {
        ctx.skip('grid:$market:$side:$k', 'level occupied by an open order');
        return null;
      }
      final priceStr = _fmtScaled(priceScaled, 18);
      final priceUsd = double.parse(priceStr) * effQuoteUsd;
      final amount = _usdToBase(sizeUsd, priceUsd, baseDecs);
      if (amount <= BigInt.zero) return null;
      return StrategyIntent(
        tool: 'place_order',
        args: {
          'market': market,
          'side': side,
          'type': 'limit',
          'amount': amount.toString(),
          'price': priceStr,
        },
        rationale:
            'Grid $side level $k @ $priceStr $quote (${stepBps}bps step), ~\$$sizeUsd.',
        estUsd: sizeUsd,
        strategy: name,
        tag: 'grid:$market:$side:$k',
        mainnet: (params['mainnet'] == true) || _ctxNetworkMainnet(ctx),
      );
    }

    for (var k = 1; k <= half; k++) {
      final b = level(k, 'buy');
      if (b != null) out.add(b);
    }
    for (var k = 1; k <= half; k++) {
      final s = level(k, 'sell');
      if (s != null) out.add(s);
    }
    return out;
  }

  String? _bestPrice(dynamic side) {
    if (side is! List || side.isEmpty) return null;
    final lvl = side.first;
    if (lvl is Map) return '${lvl['price']}';
    if (lvl is List && lvl.isNotEmpty) return '${lvl[0]}';
    return '$lvl';
  }
}

// ===========================================================================
// 3.4 rebalance
// ===========================================================================

class RebalanceStrategy extends Strategy {
  @override
  String get name => 'rebalance';
  @override
  String describe() =>
      'Trade assets back toward target weights when they drift outside a band.';
  @override
  Map<String, dynamic> get defaults => {
        'bandBps': 500,
        'baseQuote': 'USDC',
        'maxTradeUsd': 50,
      };

  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) {
    final p = {...defaults, ...?params};
    if (p['targets'] is! Map || (p['targets'] as Map).isEmpty) {
      throw ArgumentError('rebalance: `targets` (symbol->weight) is required');
    }
    final targets = <String, double>{};
    (p['targets'] as Map).forEach((k, v) {
      targets['$k'.toUpperCase()] = _numOf(v).toDouble();
    });
    final sum = targets.values.fold<double>(0, (a, b) => a + b);
    if (sum <= 0 || (sum - 1.0).abs() > 0.05) {
      throw ArgumentError('rebalance: target weights must sum to ~1.0 (got $sum)');
    }
    p['targets'] = targets;
    p['bandBps'] = _clampInt(p['bandBps'], 0, 100000, 500);
    p['baseQuote'] = '${p['baseQuote']}'.toUpperCase();
    p['maxTradeUsd'] = _numParam(p['maxTradeUsd'], 50);
    p['mainnet'] = p['mainnet'] == true;
    return p;
  }

  @override
  Future<List<StrategyIntent>> plan(
      StrategyContext ctx, Map<String, dynamic> params) async {
    final targets = (params['targets'] as Map).cast<String, double>();
    final bandBps = params['bandBps'] as int;
    final baseQuote = params['baseQuote'] as String;
    final maxTradeUsd = params['maxTradeUsd'] as num;

    if (ctx.getBalance == null || ctx.prices == null) {
      ctx.skip('rebal', 'no balance/price source');
      return const [];
    }
    final rows = await ctx.getBalance!('*');
    final syms = <String>{...targets.keys, baseQuote};
    final px = await ctx.prices!(syms.toList());

    // value every target holding in USD.
    final valueUsd = <String, double>{};
    final decs = <String, int>{};
    for (final r in rows) {
      final asset = r['asset'] is Map ? r['asset'] as Map : {'symbol': r['asset']};
      final sym = '${asset['symbol']}'.toUpperCase();
      if (!syms.contains(sym)) continue;
      final dec = (asset['decimals'] as num?)?.toInt() ?? _decOf(sym, 6);
      decs[sym] = dec;
      final unit = _unitUsd(sym, px);
      final eff = unit == 0 && _isStable(sym) ? 1.0 : unit;
      final whole = double.parse('${r['confirmed'] ?? '0'}') / math.pow(10, dec);
      valueUsd[sym] = (valueUsd[sym] ?? 0) + whole * eff;
    }
    final total = targets.keys.fold<double>(0, (a, s) => a + (valueUsd[s] ?? 0));
    if (total <= 0) {
      ctx.skip('rebal', 'portfolio value is zero');
      return const [];
    }

    final out = <StrategyIntent>[];
    final sortedTargets = targets.keys.toList()..sort();
    for (final sym in sortedTargets) {
      // The quote reserve is the settlement leg of every other trade — you can't
      // rebalance it against itself; its weight corrects as the others trade.
      if (sym == baseQuote) continue;
      final target = targets[sym]!;
      final value = valueUsd[sym] ?? 0;
      final actual = value / total;
      final driftBps = ((actual - target) * 10000).round();
      if (driftBps.abs() <= bandBps) continue;

      // Gap in USD computed from VALUES (not from the weight difference) to avoid
      // float drift — matching the JS/Python wallets. (0.7-0.5 in float is
      // 0.19999…, which the now-exact BigInt usd->base would floor a digit low;
      // value-70 minus target*total-50 is exactly 20.) Close HALF the gap.
      final gapUsd = (value - target * total).abs();
      var tradeUsd = gapUsd / 2;
      if (tradeUsd > maxTradeUsd) tradeUsd = maxTradeUsd.toDouble();
      if (tradeUsd <= 0) continue;

      final overweight = actual > target;
      if (overweight) {
        // sell `sym` -> baseQuote
        final unit = _unitUsd(sym, px);
        final eff = unit == 0 && _isStable(sym) ? 1.0 : unit;
        if (eff <= 0) {
          ctx.skip('rebal:$sym', 'no USD price to size a sell');
          continue;
        }
        final dec = decs[sym] ?? _decOf(sym, 6);
        final amount = _usdToBase(tradeUsd, eff, dec);
        if (amount <= BigInt.zero) continue;
        out.add(StrategyIntent(
          tool: 'swap',
          args: {'from': sym, 'to': baseQuote, 'amount': amount.toString()},
          rationale:
              'Rebalance: $sym overweight (${(actual * 100).toStringAsFixed(1)}% vs target '
              '${(target * 100).toStringAsFixed(1)}%, drift ${driftBps}bps > band ${bandBps}bps) — '
              'sell ~\$${tradeUsd.toStringAsFixed(2)} to $baseQuote.',
          estUsd: tradeUsd,
          strategy: name,
          tag: 'rebal:$sym',
          mainnet: (params['mainnet'] == true) || _ctxNetworkMainnet(ctx),
        ));
      } else {
        // buy `sym` from baseQuote
        final unitB = _unitUsd(baseQuote, px);
        final effB = unitB == 0 && _isStable(baseQuote) ? 1.0 : unitB;
        if (effB <= 0) {
          ctx.skip('rebal:$sym', 'no USD price for $baseQuote to size a buy');
          continue;
        }
        final decB = decs[baseQuote] ?? _decOf(baseQuote, 6);
        final amount = _usdToBase(tradeUsd, effB, decB);
        if (amount <= BigInt.zero) continue;
        out.add(StrategyIntent(
          tool: 'swap',
          args: {'from': baseQuote, 'to': sym, 'amount': amount.toString()},
          rationale:
              'Rebalance: $sym underweight (${(actual * 100).toStringAsFixed(1)}% vs target '
              '${(target * 100).toStringAsFixed(1)}%, drift ${driftBps}bps > band ${bandBps}bps) — '
              'buy ~\$${tradeUsd.toStringAsFixed(2)} from $baseQuote.',
          estUsd: tradeUsd,
          strategy: name,
          tag: 'rebal:$sym',
          mainnet: (params['mainnet'] == true) || _ctxNetworkMainnet(ctx),
        ));
      }
    }
    return out;
  }
}

// ===========================================================================
// 3.5 momentum (SMA crossover)
// ===========================================================================

class MomentumStrategy extends Strategy {
  @override
  String get name => 'momentum';
  @override
  String describe() =>
      'Buy on a short-over-long SMA golden cross, sell held on a death cross.';
  @override
  Map<String, dynamic> get defaults => {
        'shortN': 10,
        'longN': 30,
        'tradeUsd': 20,
      };

  @override
  Map<String, dynamic> validateParams(Map<String, dynamic>? params) {
    final p = {...defaults, ...?params};
    if (p['market'] == null || '${p['market']}'.isEmpty) {
      throw ArgumentError('momentum: `market` is required (e.g. "BLOCK/USDC")');
    }
    p['market'] = '${p['market']}'.toUpperCase();
    p['shortN'] = _clampInt(p['shortN'], 1, 100000, 10);
    p['longN'] = _clampInt(p['longN'], 2, 100000, 30);
    if ((p['shortN'] as int) >= (p['longN'] as int)) {
      throw ArgumentError('momentum: shortN must be < longN');
    }
    p['tradeUsd'] = _numParam(p['tradeUsd'], 20);
    p['history'] ??= const [];
    if (p['history'] is! List) {
      throw ArgumentError('momentum: `history` must be a list of prices');
    }
    p['mainnet'] = p['mainnet'] == true;
    return p;
  }

  double _sma(List<num> xs, int n, int endIndexInclusive) {
    var sum = 0.0;
    for (var i = endIndexInclusive - n + 1; i <= endIndexInclusive; i++) {
      sum += xs[i].toDouble();
    }
    return sum / n;
  }

  @override
  Future<List<StrategyIntent>> plan(
      StrategyContext ctx, Map<String, dynamic> params) async {
    final market = params['market'] as String;
    final parts = _splitPair(market);
    final base = parts[0], quote = parts[1];
    final shortN = params['shortN'] as int;
    final longN = params['longN'] as int;
    final tradeUsd = params['tradeUsd'] as num;
    final history = (params['history'] as List).map(_numOf).toList();

    if (history.length < longN) {
      ctx.skip('mom:$market', 'need >= longN ($longN) prices, have ${history.length}');
      return const [];
    }
    final last = history.length - 1;
    final prevShort = _sma(history, shortN, last - 1);
    final nowShort = _sma(history, shortN, last);
    final prevLong = _sma(history, longN, last - 1);
    final nowLong = _sma(history, longN, last);

    final golden = prevShort <= prevLong && nowShort > nowLong;
    final death = prevShort >= prevLong && nowShort < nowLong;

    final px = ctx.prices != null ? await ctx.prices!([quote, base]) : <String, num>{};

    if (golden) {
      final quoteUsd = _unitUsd(quote, px);
      final eff = quoteUsd == 0 && _isStable(quote) ? 1.0 : quoteUsd;
      if (eff <= 0) {
        ctx.skip('mom:$market', 'no USD price for quote $quote');
        return const [];
      }
      final amount = _usdToBase(tradeUsd, eff, _decOf(quote, 6));
      if (amount <= BigInt.zero) return const [];
      return [
        StrategyIntent(
          tool: 'swap',
          args: {'from': quote, 'to': base, 'amount': amount.toString()},
          rationale:
              'Momentum golden cross: SMA$shortN (${nowShort.toStringAsFixed(6)}) crossed above '
              'SMA$longN (${nowLong.toStringAsFixed(6)}) — buy \$$tradeUsd of $base.',
          estUsd: tradeUsd,
          strategy: name,
          tag: 'mom:$market:buy',
          mainnet: (params['mainnet'] == true) || _ctxNetworkMainnet(ctx),
        ),
      ];
    }

    if (death) {
      // sell only what's held.
      BigInt held = BigInt.zero;
      int baseDec = _decOf(base, 8);
      if (ctx.getBalance != null) {
        final rows = await ctx.getBalance!('*');
        for (final r in rows) {
          final asset = r['asset'] is Map ? r['asset'] as Map : {'symbol': r['asset']};
          if ('${asset['symbol']}'.toUpperCase() == base) {
            baseDec = (asset['decimals'] as num?)?.toInt() ?? baseDec;
            held = BigInt.parse('${r['confirmed'] ?? '0'}');
            break;
          }
        }
      }
      if (held <= BigInt.zero) {
        ctx.skip('mom:$market', 'death cross but no $base held');
        return const [];
      }
      final baseUsd = _unitUsd(base, px);
      final effB = baseUsd == 0 && _isStable(base) ? 1.0 : baseUsd;
      var sellAmt = held;
      if (effB > 0) {
        final want = _usdToBase(tradeUsd, effB, baseDec);
        if (want < held) sellAmt = want;
      }
      if (sellAmt <= BigInt.zero) return const [];
      return [
        StrategyIntent(
          tool: 'swap',
          args: {'from': base, 'to': quote, 'amount': sellAmt.toString()},
          rationale:
              'Momentum death cross: SMA$shortN (${nowShort.toStringAsFixed(6)}) crossed below '
              'SMA$longN (${nowLong.toStringAsFixed(6)}) — sell held $base.',
          estUsd: effB > 0
              ? (double.parse(sellAmt.toString()) / math.pow(10, baseDec) * effB)
              : null,
          strategy: name,
          tag: 'mom:$market:sell',
          mainnet: (params['mainnet'] == true) || _ctxNetworkMainnet(ctx),
        ),
      ];
    }

    ctx.skip('mom:$market', 'no SMA cross this tick');
    return const [];
  }
}

// Per-symbol default decimals when a snapshot/holding does not carry them.
int _decOf(String sym, int dflt) {
  switch (sym.toUpperCase()) {
    case 'USDC':
    case 'USDT':
    case 'USD':
    case 'DAI':
      return 6;
    case 'BTC':
      return 8;
    case 'ETH':
    case 'WETH':
      return 18;
    case 'BLOCK':
      return 8;
    case 'SOL':
      return 9;
    default:
      return dflt;
  }
}

/// The default registry: the five spec strategies keyed by name.
Map<String, Strategy> defaultStrategies() {
  final list = <Strategy>[
    ArbitrageStrategy(),
    DcaStrategy(),
    GridStrategy(),
    RebalanceStrategy(),
    MomentumStrategy(),
  ];
  return {for (final s in list) s.name: s};
}
