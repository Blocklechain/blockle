// liquidity/liquidity_pool.dart — the Blockle Liquidity treasury + AMM.
//
// The 0.05% fee every trading bot pays is auto-deposited here as the pair's
// QUOTE/base coin (USDC / SOL / ETH / …), deepening a per-coin constant-product
// pool paired against BLOCK. BLOCK is the common asset: the treasury starts with
// 50,000 BLOCK, and each pool is seeded so BLOCK opens at $0.001. Users swap
// BLOCK ↔ any coin against these reserves (x·y = k), limited by the liquidity the
// fees have accumulated. Pure + deterministic (no I/O, no clock) so it is unit-
// tested exactly; the host (LiquidityService) persists + wires the fee feed.
//
// Numbers are plain doubles (whole-unit reserves). This is a wallet-side treasury
// model for display + quoting — NOT consensus money — so float math is fine; the
// on-chain settlement of a swap is a gated follow-on (like the bots' live mode).

import 'dart:convert';
import 'dart:math' as math;

/// Total BLOCK the treasury starts with (seeds every coin pool).
const double kBlockSeedSupply = 50000.0;

/// BLOCK's opening price in USD — every new pool is seeded to this.
const double kBlockSeedPriceUsd = 0.001;

/// BLOCK taken from the treasury to seed each new coin pool (≤ treasury left).
const double kPerPoolSeedBlock = 2000.0;

/// A single BLOCK/<coin> constant-product reserve.
class Pool {
  double rBlock; // BLOCK side
  double rBase; // coin side
  double feesUsd; // cumulative fee value deposited into this pool
  Pool(this.rBlock, this.rBase, {this.feesUsd = 0});

  double get k => rBlock * rBase;
  Map<String, dynamic> toJson() => {'b': rBlock, 'q': rBase, 'f': feesUsd};
  static Pool fromJson(Map j) => Pool(
        (j['b'] as num?)?.toDouble() ?? 0,
        (j['q'] as num?)?.toDouble() ?? 0,
        feesUsd: (j['f'] as num?)?.toDouble() ?? 0,
      );
}

/// The outcome of a quote/swap.
class SwapQuote {
  final bool ok;
  final String? reason;
  final double amountIn;
  final double amountOut;
  final String assetIn;
  final String assetOut;
  final double priceImpactPct; // 0..100
  const SwapQuote({
    required this.ok,
    this.reason,
    this.amountIn = 0,
    this.amountOut = 0,
    this.assetIn = '',
    this.assetOut = '',
    this.priceImpactPct = 0,
  });
}

class LiquidityPool {
  double blockTreasury;
  final Map<String, Pool> pools;

  LiquidityPool({double? blockTreasury, Map<String, Pool>? pools})
      : blockTreasury = blockTreasury ?? kBlockSeedSupply,
        pools = pools ?? {};

  /// BLOCK already deployed into pools (treasury + deployed == 50,000 always).
  double get deployedBlock => pools.values.fold(0.0, (s, p) => s + p.rBlock);

  /// Total fee value collected across every pool (USD).
  double get totalFeesUsd => pools.values.fold(0.0, (s, p) => s + p.feesUsd);

  bool hasPool(String coin) => pools.containsKey(coin.toUpperCase());

  /// Ensure a pool exists for [coin] (a "hot wallet" reserve), seeding it from the
  /// treasury so BLOCK opens at $0.001. [coinUsd] is the coin's live USD price.
  Pool ensurePool(String coin, double coinUsd) {
    final k = coin.toUpperCase();
    final existing = pools[k];
    if (existing != null) return existing;
    final cu = coinUsd > 0 ? coinUsd : 1.0;
    final seedBlock = math.min(blockTreasury, kPerPoolSeedBlock);
    if (seedBlock <= 0) {
      // Treasury exhausted — a dust pool so pricing/quoting still works; it simply
      // can't source real swap liquidity until fees arrive.
      final p = Pool(1e-6, 1e-6 * kBlockSeedPriceUsd / cu);
      pools[k] = p;
      return p;
    }
    blockTreasury -= seedBlock;
    // rBase chosen so (rBase/rBlock)·coinUsd == $0.001  ⇒ BLOCK = $0.001.
    final base = seedBlock * kBlockSeedPriceUsd / cu;
    final p = Pool(seedBlock, base);
    pools[k] = p;
    return p;
  }

  /// Deposit a bot's fee: [feeUsd] worth of [coin] flows into that coin's pool
  /// (single-sided — it deepens liquidity and nudges BLOCK's price up). [coinUsd]
  /// is the coin's live USD price (stablecoins = 1).
  void accrueFee(String coin, double feeUsd, double coinUsd) {
    if (feeUsd <= 0) return;
    final cu = coinUsd > 0 ? coinUsd : 1.0;
    final p = ensurePool(coin, cu);
    p.rBase += feeUsd / cu;
    p.feesUsd += feeUsd;
  }

  /// BLOCK's price in USD as implied by [coin]'s pool (needs the coin's USD price).
  double? blockPriceUsd(String coin, double coinUsd) {
    final p = pools[coin.toUpperCase()];
    if (p == null || p.rBlock <= 0) return null;
    return (p.rBase / p.rBlock) * (coinUsd > 0 ? coinUsd : 1.0);
  }

  /// A blended BLOCK/USD across all pools, weighted by each pool's coin-side USD
  /// depth (deeper pools dominate). null until at least one pool exists.
  double? blockPriceUsdBlended(Map<String, double> coinUsd) {
    double num = 0, den = 0;
    pools.forEach((coin, p) {
      final cu = coinUsd[coin] ?? (_isStable(coin) ? 1.0 : 0);
      if (cu <= 0 || p.rBlock <= 0) return;
      final depthUsd = p.rBase * cu;
      final price = (p.rBase / p.rBlock) * cu;
      num += price * depthUsd;
      den += depthUsd;
    });
    return den > 0 ? num / den : null;
  }

  /// Coin-side reserve of [coin] expressed in USD — the liquidity actually
  /// available to swap BLOCK → coin.
  double availableLiquidityUsd(String coin, double coinUsd) {
    final p = pools[coin.toUpperCase()];
    if (p == null) return 0;
    return p.rBase * (coinUsd > 0 ? coinUsd : 1.0);
  }

  /// Quote a swap WITHOUT mutating reserves. [from]/[to] is BLOCK and a coin (one
  /// side must be BLOCK). [coinUsd] is the coin's USD price (for seeding a pool if
  /// it doesn't exist yet). Constant-product; no swap fee (the bots already fund it).
  SwapQuote quote(String from, String to, double amountIn, double coinUsd) {
    from = from.toUpperCase();
    to = to.toUpperCase();
    if (amountIn <= 0) return const SwapQuote(ok: false, reason: 'Enter an amount');
    final blockToCoin = from == 'BLOCK';
    final coin = blockToCoin ? to : from;
    if ((from == 'BLOCK') == (to == 'BLOCK')) {
      return const SwapQuote(ok: false, reason: 'One side must be BLOCK');
    }
    final p = pools[coin];
    if (p == null) {
      return SwapQuote(
          ok: false, reason: 'No liquidity for $coin yet — bot fees fund it', assetIn: from, assetOut: to);
    }
    final k = p.k;
    double out, impact;
    if (blockToCoin) {
      final newBlock = p.rBlock + amountIn;
      out = p.rBase - k / newBlock;
      final mid = p.rBase / p.rBlock; // coin per BLOCK before
      final exec = out / amountIn;
      impact = mid > 0 ? ((mid - exec) / mid) * 100 : 0;
    } else {
      final newBase = p.rBase + amountIn;
      out = p.rBlock - k / newBase;
      final mid = p.rBlock / p.rBase;
      final exec = out / amountIn;
      impact = mid > 0 ? ((mid - exec) / mid) * 100 : 0;
    }
    if (!out.isFinite || out <= 0) {
      return SwapQuote(ok: false, reason: 'Not enough liquidity', assetIn: from, assetOut: to);
    }
    return SwapQuote(
      ok: true,
      amountIn: amountIn,
      amountOut: out,
      assetIn: from,
      assetOut: to,
      priceImpactPct: impact.clamp(0, 100).toDouble(),
    );
  }

  /// Execute a swap: re-quotes, then APPLIES the reserve change. Returns the quote
  /// (ok=false leaves reserves untouched). The caller settles the user's legs.
  SwapQuote swap(String from, String to, double amountIn, double coinUsd) {
    final q = quote(from, to, amountIn, coinUsd);
    if (!q.ok) return q;
    final coin = (from.toUpperCase() == 'BLOCK' ? to : from).toUpperCase();
    final p = pools[coin]!;
    if (from.toUpperCase() == 'BLOCK') {
      p.rBlock += q.amountIn; // BLOCK paid in deepens the BLOCK side
      p.rBase -= q.amountOut;
    } else {
      p.rBase += q.amountIn;
      p.rBlock -= q.amountOut;
    }
    return q;
  }

  static bool _isStable(String c) =>
      const {'USDC', 'USDT', 'DAI', 'USD', 'USDB', 'PYUSD', 'TUSD'}.contains(c.toUpperCase());

  // ---- persistence ----------------------------------------------------------
  Map<String, dynamic> toJson() => {
        'treasury': blockTreasury,
        'pools': pools.map((k, v) => MapEntry(k, v.toJson())),
      };
  String encode() => jsonEncode(toJson());

  static LiquidityPool fromJson(Map j) => LiquidityPool(
        blockTreasury: (j['treasury'] as num?)?.toDouble() ?? kBlockSeedSupply,
        pools: ((j['pools'] as Map?) ?? const {}).map(
          (k, v) => MapEntry('$k'.toUpperCase(), Pool.fromJson(v as Map)),
        ),
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
