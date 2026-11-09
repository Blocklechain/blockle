// liquidity/liquidity_pool.dart — the Blockle Liquidity treasury.
//
// ONE BLOCK PRICE across every currency. BLOCK has a single USD price (starts at
// $0.001) used for ALL pairs, so a BLOCK costs exactly the same whether you pay in
// USDC, SOL, or ETH — the price never diverges per pool. As the 0.05% bot fees
// accumulate, that one price rises uniformly across the board.
//
// Per-coin RESERVES (the "hot wallets") hold however much of each coin the fees
// have deposited. A swap converts at the global BLOCK price (adjusted by the
// coin's live USD price), limited by that coin's reserve. BLOCK the treasury can
// pay out is bounded by its 50,000-BLOCK supply.
//
// Pure + deterministic; the host (LiquidityService) persists it and, when the
// server treasury is reachable, mirrors the SERVER's authoritative state.

import 'dart:convert';
import 'dart:math' as math;

/// Total BLOCK the treasury can deploy as liquidity.
const double kBlockSeedSupply = 50000.0;

/// BLOCK's opening price in USD — the single price every pair starts at.
const double kBlockSeedPriceUsd = 0.001;

/// How much accumulated fee value (USD) lifts the BLOCK price by one seed-unit
/// ($0.001). With 50,000 BLOCK backing, every $50 of fees adds $0.001 uniformly.
const double kFeeAppreciationDivisor = kBlockSeedSupply; // $/BLOCK per $ fee / supply

/// BONDING CURVE: buys of BLOCK push the price UP, sells push it back DOWN
/// (symmetric), on top of the fee-funded floor. `d = SEED - treasury` is the net
/// BLOCK bought out; spot = floor × (1 + C·d). STEEP: a 500-BLOCK buy (1% of the
/// seed) lifts the price ~10%. MUST match services/accounts/src/liquidity.js.
const double kCurveSteepness = 0.0002;
const double kCurveMinMult = 0.1;

class SwapQuote {
  final bool ok;
  final String? reason;
  final double amountIn;
  final double amountOut;
  final String assetIn;
  final String assetOut;
  final double blockPriceUsd;
  const SwapQuote({
    required this.ok,
    this.reason,
    this.amountIn = 0,
    this.amountOut = 0,
    this.assetIn = '',
    this.assetOut = '',
    this.blockPriceUsd = 0,
  });
}

class LiquidityPool {
  /// BLOCK still held by the treasury (bounds coin→BLOCK payouts).
  double blockTreasury;

  /// Coin reserves: coin symbol → whole units held (grown by fees).
  final Map<String, double> reserves;

  /// Cumulative fee value deposited per coin (USD), for display.
  final Map<String, double> feesUsd;

  LiquidityPool({double? blockTreasury, Map<String, double>? reserves, Map<String, double>? feesUsd})
      : blockTreasury = blockTreasury ?? kBlockSeedSupply,
        reserves = reserves ?? {},
        feesUsd = feesUsd ?? {};

  /// Total fee value collected across every coin (USD).
  double get totalFeesUsd => feesUsd.values.fold(0.0, (s, v) => s + v);

  /// The fee-funded FLOOR price in USD — rises only as fees accumulate ("fees
  /// just add liquidity"), identical for every currency.
  double get priceFloorUsd =>
      kBlockSeedPriceUsd + totalFeesUsd / kFeeAppreciationDivisor;

  /// THE single SPOT BLOCK price in USD — the floor times the bonding-curve
  /// multiplier, so it moves UP as BLOCK is bought out of the treasury. Still one
  /// price across every currency (never per-pool).
  double get blockPriceUsd {
    final mult = 1 + kCurveSteepness * (kBlockSeedSupply - blockTreasury);
    return priceFloorUsd * (mult < kCurveMinMult ? kCurveMinMult : mult);
  }

  bool hasReserve(String coin) => (reserves[coin.toUpperCase()] ?? 0) > 0;

  /// Deposit a bot fee: [feeUsd] worth of [coin] joins that coin's reserve.
  /// [coinUsd] is the coin's live USD price (stablecoins = 1).
  void accrueFee(String coin, double feeUsd, double coinUsd) {
    if (feeUsd <= 0) return;
    final c = coin.toUpperCase();
    final cu = coinUsd > 0 ? coinUsd : 1.0;
    reserves[c] = (reserves[c] ?? 0) + feeUsd / cu;
    feesUsd[c] = (feesUsd[c] ?? 0) + feeUsd;
  }

  /// Coin reserve of [coin] expressed in USD — the liquidity available to receive
  /// when swapping BLOCK → coin.
  double availableLiquidityUsd(String coin, double coinUsd) =>
      (reserves[coin.toUpperCase()] ?? 0) * (coinUsd > 0 ? coinUsd : 1.0);

  /// Quote a swap along the bonding curve (one side must be BLOCK). A BUY
  /// (coin→BLOCK) walks the price UP, a SELL (BLOCK→coin) walks it DOWN; a larger
  /// order integrates along the curve instead of filling at the start price.
  /// MUST match the server (services/accounts/src/liquidity.js).
  SwapQuote quote(String from, String to, double amountIn, double coinUsd) {
    from = from.toUpperCase();
    to = to.toUpperCase();
    final bp = blockPriceUsd; // spot (pre-trade), for display
    if (amountIn <= 0) return SwapQuote(ok: false, reason: 'Enter an amount', blockPriceUsd: bp);
    if ((from == 'BLOCK') == (to == 'BLOCK')) {
      return SwapQuote(ok: false, reason: 'One side must be BLOCK', blockPriceUsd: bp);
    }
    final cu = coinUsd > 0 ? coinUsd : 1.0;
    final f = priceFloorUsd;
    final d0 = kBlockSeedSupply - blockTreasury;
    if (from == 'BLOCK') {
      // SELL BLOCK → coin: usdOut = ∫ p dd over the BLOCK returned.
      final coin = to;
      final x = amountIn;
      final usdOut = f * (x + kCurveSteepness * x * (d0 - x / 2));
      final out = usdOut / cu;
      final have = reserves[coin] ?? 0;
      if (out <= 0) return SwapQuote(ok: false, reason: 'Amount too small', assetIn: from, assetOut: to, blockPriceUsd: bp);
      if (out > have) {
        return SwapQuote(
            ok: false,
            reason: have <= 0
                ? 'No liquidity for $coin yet — bot fees fund it'
                : 'Only ${_trim(have)} $coin available',
            assetIn: from, assetOut: to, blockPriceUsd: bp);
      }
      return SwapQuote(ok: true, amountIn: amountIn, amountOut: out, assetIn: from, assetOut: to, blockPriceUsd: bp);
    } else {
      // BUY coin → BLOCK: solve (C/2)x² + (1+C·d0)x − usdIn/F = 0 for x BLOCK out.
      final usdIn = amountIn * cu;
      final a = f * kCurveSteepness / 2;
      final b = f * (1 + kCurveSteepness * d0);
      final out = a <= 0 ? usdIn / b : (-b + math.sqrt(b * b + 4 * a * usdIn)) / (2 * a);
      if (out <= 0) return SwapQuote(ok: false, reason: 'Amount too small', assetIn: from, assetOut: to, blockPriceUsd: bp);
      if (out > blockTreasury) {
        return SwapQuote(ok: false, reason: 'Treasury BLOCK exhausted', assetIn: from, assetOut: to, blockPriceUsd: bp);
      }
      return SwapQuote(ok: true, amountIn: amountIn, amountOut: out, assetIn: from, assetOut: to, blockPriceUsd: bp);
    }
  }

  /// Execute a swap: re-quotes, then applies the reserve move. The curve is baked
  /// into the quote, so a round-trip pays the spread (a real market, not a free
  /// loop). ok=false leaves state untouched.
  SwapQuote swap(String from, String to, double amountIn, double coinUsd) {
    final q = quote(from, to, amountIn, coinUsd);
    if (!q.ok) return q;
    if (from.toUpperCase() == 'BLOCK') {
      final coin = to.toUpperCase();
      blockTreasury += q.amountIn; // BLOCK paid in
      reserves[coin] = (reserves[coin] ?? 0) - q.amountOut; // coin paid out
    } else {
      final coin = from.toUpperCase();
      reserves[coin] = (reserves[coin] ?? 0) + q.amountIn; // coin paid in
      blockTreasury -= q.amountOut; // BLOCK paid out
    }
    return q;
  }

  static String _trim(double v) =>
      v >= 1 ? v.toStringAsFixed(4) : v.toStringAsFixed(6);

  // ---- persistence ----------------------------------------------------------
  Map<String, dynamic> toJson() => {
        'treasury': blockTreasury,
        'reserves': reserves,
        'fees': feesUsd,
      };
  String encode() => jsonEncode(toJson());

  static LiquidityPool fromJson(Map j) => LiquidityPool(
        blockTreasury: (j['treasury'] as num?)?.toDouble() ?? kBlockSeedSupply,
        reserves: ((j['reserves'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k'.toUpperCase(), (v as num).toDouble())),
        feesUsd: ((j['fees'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k'.toUpperCase(), (v as num).toDouble())),
      );

  static LiquidityPool decode(String? s) {
    if (s == null || s.isEmpty) return LiquidityPool();
    try {
      return fromJson(jsonDecode(s) as Map);
    } catch (_) {
      return LiquidityPool();
    }
  }
}
