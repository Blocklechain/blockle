// state/liquidity_controller.dart — the host for the Blockle Liquidity treasury.
//
// A single app-wide service that owns the [LiquidityPool], persists it, feeds it
// live coin prices, takes the 0.05% bot fees (via the bot event stream), and
// exposes quote/swap for the Liquidity screen. ChangeNotifier so the screen
// repaints as fees arrive and prices refresh. Fail-soft throughout — the money
// paths (bots, wallet) never depend on it.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../liquidity/liquidity_pool.dart';
import '../multichain/prices.dart';
import '../multichain/chains/chain_adapter.dart' show AssetRef;

/// Base coins the treasury supplies liquidity for — the MoonPay-supported set, so
/// "swap BLOCK for any MoonPay currency" is covered. BLOCK pairs against each.
const List<String> kMoonPayCoins = [
  'USDC', 'USDT', 'DAI', 'ETH', 'BTC', 'SOL', 'BNB', 'MATIC', 'AVAX',
  'ADA', 'DOGE', 'LTC', 'TRX', 'XRP', 'DOT', 'BCH',
];

const Set<String> _stable = {'USDC', 'USDT', 'DAI', 'USD', 'USDB', 'PYUSD', 'TUSD'};

class LiquidityService extends ChangeNotifier {
  LiquidityService._();
  static final LiquidityService instance = LiquidityService._();

  static const _storeKey = 'blockle_liquidity_v1';
  final _store = const FlutterSecureStorage();
  final PriceService _priceSvc = PriceService(serverBase: 'https://blockle.org');

  LiquidityPool _pool = LiquidityPool();
  LiquidityPool get pool => _pool;

  /// Live coin→USD cache (stablecoins pinned to 1). Refreshed by [refreshPrices].
  final Map<String, double> _coinUsd = {for (final s in _stable) s: 1.0};
  Map<String, double> get coinUsd => Map.unmodifiable(_coinUsd);

  bool _ready = false;
  bool get ready => _ready;
  bool _dirty = false;
  Timer? _saveDebounce;

  /// Load persisted state + do a first price refresh. Idempotent.
  Future<void> init() async {
    if (_ready) return;
    try {
      _pool = LiquidityPool.decode(await _store.read(key: _storeKey));
    } catch (_) {
      _pool = LiquidityPool();
    }
    _ready = true;
    notifyListeners();
    unawaited(refreshPrices());
  }

  double priceOf(String coin) {
    final c = coin.toUpperCase();
    if (_stable.contains(c)) return 1.0;
    return _coinUsd[c] ?? 0;
  }

  /// BLOCK's price in USD (blended across pools); null until a pool exists.
  double? get blockPriceUsd => _pool.blockPriceUsdBlended(_coinUsd);

  /// Total USD value locked across every coin pool (both sides).
  double get tvlUsd {
    var usd = 0.0;
    final bp = blockPriceUsd ?? kBlockSeedPriceUsd;
    _pool.pools.forEach((coin, p) {
      usd += p.rBase * priceOf(coin) + p.rBlock * bp;
    });
    return usd;
  }

  /// TAKE A BOT FEE. Called from the bot event stream on every executed/paper
  /// trade: deposit [feeUsd] worth of [coin] into that coin's pool. Non-stable
  /// coins need a USD price — if we don't have one yet, fetch it then accrue.
  void takeFee(String coin, double feeUsd) {
    if (feeUsd <= 0) return;
    final c = coin.toUpperCase();
    final px = priceOf(c);
    if (px > 0) {
      _pool.accrueFee(c, feeUsd, px);
      _touch();
    } else {
      // price unknown → fetch, then accrue (never seed a pool at a wrong price).
      unawaited(_accrueWhenPriced(c, feeUsd));
    }
  }

  Future<void> _accrueWhenPriced(String coin, double feeUsd) async {
    await _fetchPrices([coin]);
    final px = priceOf(coin);
    if (px > 0) {
      _pool.accrueFee(coin, feeUsd, px);
      _touch();
    }
  }

  // ---- quote / swap ---------------------------------------------------------
  SwapQuote quote(String from, String to, double amountIn) {
    final coin = (from.toUpperCase() == 'BLOCK' ? to : from);
    return _pool.quote(from, to, amountIn, priceOf(coin));
  }

  /// Execute a swap against the treasury reserves (updates the pool + persists).
  /// Returns the applied quote. NOTE: this moves the TREASURY's reserves and
  /// records the user's swap; wiring the on-chain settlement of the user's own
  /// legs is gated (same posture as the bots' live mode).
  SwapQuote swap(String from, String to, double amountIn) {
    final coin = (from.toUpperCase() == 'BLOCK' ? to : from);
    final q = _pool.swap(from, to, amountIn, priceOf(coin));
    if (q.ok) _touch();
    return q;
  }

  double availableLiquidityUsd(String coin) =>
      _pool.availableLiquidityUsd(coin, priceOf(coin));

  /// Coins that currently have real swap liquidity (a non-dust coin reserve).
  List<String> get liquidCoins => _pool.pools.entries
      .where((e) => e.value.rBase > 1e-4)
      .map((e) => e.key)
      .toList()
    ..sort((a, b) => availableLiquidityUsd(b).compareTo(availableLiquidityUsd(a)));

  // ---- prices ---------------------------------------------------------------
  Future<void> refreshPrices() async {
    // Price the MoonPay set + any coin that already has a pool.
    final want = {...kMoonPayCoins, ..._pool.pools.keys}.where((c) => !_stable.contains(c)).toList();
    await _fetchPrices(want);
  }

  Future<void> _fetchPrices(Iterable<String> coins) async {
    final refs = <String, AssetRef>{};
    for (final c in coins) {
      final up = c.toUpperCase();
      if (_stable.contains(up)) continue;
      refs[up] = AssetRef(chain: '', kind: 'native', symbol: up, decimals: 18);
    }
    if (refs.isEmpty) return;
    try {
      final usd = await _priceSvc.fetchUsd(refs.values.toList());
      var changed = false;
      refs.forEach((sym, ref) {
        final p = usd[priceKey(ref)];
        if (p != null && p.isFinite && p > 0) {
          _coinUsd[sym] = p;
          changed = true;
        }
      });
      if (changed) notifyListeners();
    } catch (_) {/* best-effort */}
  }

  // ---- persistence ----------------------------------------------------------
  void _touch() {
    _dirty = true;
    notifyListeners();
    _saveDebounce?.cancel();
    _saveDebounce = Timer(const Duration(seconds: 2), _save);
  }

  Future<void> _save() async {
    if (!_dirty) return;
    _dirty = false;
    try {
      await _store.write(key: _storeKey, value: _pool.encode());
    } catch (_) {/* best-effort */}
  }

  /// Dev/debug: reset the treasury to its 50,000-BLOCK seed.
  Future<void> reset() async {
    _pool = LiquidityPool();
    _touch();
    await _save();
  }
}
