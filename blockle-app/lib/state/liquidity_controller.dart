// state/liquidity_controller.dart — the host for the Blockle Liquidity treasury.
//
// A single app-wide service that owns the [LiquidityPool], persists it, feeds it
// live coin prices, takes the 0.05% bot fees (via the bot event stream), and
// exposes quote/swap for the Liquidity screen. ChangeNotifier so the screen
// repaints as fees arrive and prices refresh. Fail-soft throughout — the money
// paths (bots, wallet) never depend on it.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

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
  static const _serverBase = 'https://blockle.org';
  final _store = const FlutterSecureStorage();
  final PriceService _priceSvc = PriceService(serverBase: _serverBase);

  /// True once the SERVER treasury (authoritative, shared) has answered — its
  /// reserves then replace the local preview. Custodial addresses + the on-chain
  /// settlement gate come from the server too.
  bool serverBacked = false;
  Map<String, dynamic> custodial = const {};
  String settlement = 'accounting'; // 'onchain' when the server gate is live

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
    unawaited(_syncFromServer());
  }

  /// Adopt the SERVER's authoritative treasury state (shared across all wallets).
  /// Best-effort: on any failure the local preview stays. Never throws.
  Future<void> _syncFromServer() async {
    try {
      final r = await http
          .get(Uri.parse('$_serverBase/account/api/liquidity/state'))
          .timeout(const Duration(seconds: 10));
      if (r.statusCode != 200) return;
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      if (j['blockTreasury'] == null) return;
      _pool = LiquidityPool(
        blockTreasury: (j['blockTreasury'] as num).toDouble(),
        reserves: ((j['reserves'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k'.toUpperCase(), (v as num).toDouble())),
        feesUsd: ((j['fees'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k'.toUpperCase(), (v as num).toDouble())),
      );
      custodial = (j['custodial'] as Map?)?.cast<String, dynamic>() ?? const {};
      settlement = '${j['settlement'] ?? 'accounting'}';
      serverBacked = true;
      notifyListeners();
    } catch (_) {/* keep the local preview */}
  }

  double priceOf(String coin) {
    final c = coin.toUpperCase();
    if (_stable.contains(c)) return 1.0;
    return _coinUsd[c] ?? 0;
  }

  /// THE single BLOCK price in USD — identical across every currency.
  double get blockPriceUsd => _pool.blockPriceUsd;

  /// Total USD value held by the treasury: every coin reserve + the BLOCK it holds.
  double get tvlUsd {
    var usd = _pool.blockTreasury * _pool.blockPriceUsd;
    _pool.reserves.forEach((coin, units) => usd += units * priceOf(coin));
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
      _postFee(c, feeUsd, px); // grow the shared server treasury too
    } else {
      unawaited(_accrueWhenPriced(c, feeUsd));
    }
  }

  // Record the fee into the SERVER treasury (best-effort, rate-limited server-side).
  void _postFee(String coin, double feeUsd, double coinUsd) {
    if (!serverBacked) return;
    unawaited(http
        .post(Uri.parse('$_serverBase/account/api/liquidity/fee'),
            headers: const {'content-type': 'application/json'},
            body: jsonEncode({'coin': coin, 'feeUsd': feeUsd, 'coinUsd': coinUsd}))
        .timeout(const Duration(seconds: 8))
        .catchError((_) => http.Response('', 599)));
  }

  Future<void> _accrueWhenPriced(String coin, double feeUsd) async {
    await _fetchPrices([coin]);
    final px = priceOf(coin);
    if (px > 0) {
      _pool.accrueFee(coin, feeUsd, px);
      _touch();
      _postFee(coin, feeUsd, px);
    }
  }

  // ---- quote / swap ---------------------------------------------------------
  SwapQuote quote(String from, String to, double amountIn) {
    final coin = (from.toUpperCase() == 'BLOCK' ? to : from);
    return _pool.quote(from, to, amountIn, priceOf(coin));
  }

  /// Execute a swap. When the server treasury is authoritative the swap runs
  /// SERVER-SIDE (shared reserves, gated settlement) and the returned state is
  /// adopted; otherwise it runs against the local preview. Fail-soft to local.
  Future<SwapQuote> swap(String from, String to, double amountIn) async {
    final coin = (from.toUpperCase() == 'BLOCK' ? to : from);
    if (serverBacked) {
      try {
        final r = await http
            .post(Uri.parse('$_serverBase/account/api/liquidity/swap'),
                headers: const {'content-type': 'application/json'},
                body: jsonEncode({'from': from, 'to': to, 'amountIn': amountIn, 'coinUsd': priceOf(coin)}))
            .timeout(const Duration(seconds: 12));
        final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
        if (j['ok'] == true) {
          unawaited(_syncFromServer()); // refresh reserves after the move
          return SwapQuote(
            ok: true,
            amountIn: (j['amountIn'] as num?)?.toDouble() ?? amountIn,
            amountOut: (j['amountOut'] as num?)?.toDouble() ?? 0,
            assetIn: from.toUpperCase(), assetOut: to.toUpperCase(),
            blockPriceUsd: (j['blockPriceUsd'] as num?)?.toDouble() ?? _pool.blockPriceUsd,
          );
        }
        return SwapQuote(ok: false, reason: '${j['reason'] ?? 'Swap unavailable'}');
      } catch (_) {/* fall through to local */}
    }
    final q = _pool.swap(from, to, amountIn, priceOf(coin));
    if (q.ok) _touch();
    return q;
  }

  double availableLiquidityUsd(String coin) =>
      _pool.availableLiquidityUsd(coin, priceOf(coin));

  /// Coins that currently have real swap liquidity (a non-dust coin reserve).
  List<String> get liquidCoins => _pool.reserves.entries
      .where((e) => e.value > 1e-4)
      .map((e) => e.key)
      .toList()
    ..sort((a, b) => availableLiquidityUsd(b).compareTo(availableLiquidityUsd(a)));

  // ---- prices ---------------------------------------------------------------
  Future<void> refreshPrices() async {
    // Price the MoonPay set + any coin that already has a reserve.
    final want = {...kMoonPayCoins, ..._pool.reserves.keys}.where((c) => !_stable.contains(c)).toList();
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
