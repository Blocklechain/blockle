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
  /// Coins whose legs settle on-chain, as reported by the server (`settleable`
  /// on /state). Falls back to the built-in set when the server predates it.
  List<String> settleable = const [];
  /// Live on-chain BLOCK balance of the custodial treasury wallet (null = not
  /// provisioned / unreadable). Distinct from [pool.blockTreasury] (accounting).
  double? blockOnchainBalance;
  String? blockOnchainAddress;

  /// REAL on-chain balance + spendable (balance − payout floor) per hot-wallet
  /// coin, from the server's `onchain` map. The server caps quotes by these —
  /// the ledger can never promise coins the wallet doesn't actually hold.
  Map<String, double> onchainBalance = const {};
  Map<String, double> onchainSpendable = const {};

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
    await _loadPending();
    _ready = true;
    notifyListeners();
    unawaited(refreshPrices());
    unawaited(_syncFromServer().then((_) => resumePendingSettlements()));
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
      _serverPriceUsd = (j['blockPriceUsd'] as num?)?.toDouble();
      _pool = LiquidityPool(
        blockTreasury: (j['blockTreasury'] as num).toDouble(),
        reserves: ((j['reserves'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k'.toUpperCase(), (v as num).toDouble())),
        feesUsd: ((j['fees'] as Map?) ?? const {})
            .map((k, v) => MapEntry('$k'.toUpperCase(), (v as num).toDouble())),
      );
      custodial = (j['custodial'] as Map?)?.cast<String, dynamic>() ?? const {};
      settlement = '${j['settlement'] ?? 'accounting'}';
      settleable = ((j['settleable'] as List?) ?? const [])
          .map((e) => '$e'.toUpperCase())
          .toList();
      blockOnchainBalance = (j['blockOnchainBalance'] as num?)?.toDouble();
      blockOnchainAddress = j['blockOnchainAddress'] as String?;
      final oc = (j['onchain'] as Map?)?.cast<String, dynamic>();
      if (oc != null) {
        final bal = <String, double>{};
        final spend = <String, double>{};
        oc.forEach((coin, v) {
          if (v is Map) {
            final b = (v['balance'] as num?)?.toDouble();
            final s = (v['spendable'] as num?)?.toDouble();
            if (b != null) bal[coin.toUpperCase()] = b;
            if (s != null) spend[coin.toUpperCase()] = s;
          }
        });
        onchainBalance = bal;
        onchainSpendable = spend;
      }
      serverBacked = true;
      notifyListeners();
    } catch (_) {/* keep the local preview */}
  }

  double priceOf(String coin) {
    final c = coin.toUpperCase();
    if (_stable.contains(c)) return 1.0;
    return _coinUsd[c] ?? 0;
  }

  /// The server's authoritative BLOCK price (its bonding curve is the ONE
  /// source of truth — curve changes ship server-side, never in the app).
  double? _serverPriceUsd;

  /// THE single BLOCK price in USD — identical across every currency. Prefers
  /// the SERVER's curve when server-backed; the local pool is offline-only.
  double get blockPriceUsd =>
      (serverBacked && _serverPriceUsd != null && _serverPriceUsd! > 0)
          ? _serverPriceUsd!
          : _pool.blockPriceUsd;

  /// Total USD value held by the treasury: every coin reserve + the BLOCK it holds.
  double get tvlUsd {
    var usd = _pool.blockTreasury * blockPriceUsd;
    _pool.reserves.forEach((coin, units) => usd += units * priceOf(coin));
    return usd;
  }

  /// TAKE A BOT FEE from a LIVE fill: deposit [feeUsd] worth of [coin] into that
  /// coin's pool. The server credits only posts marked mode:'live' — paper fills
  /// move no real money and must never inflate the ledger. Non-stable coins need
  /// a USD price — if we don't have one yet, fetch it then accrue.
  void takeFee(String coin, double feeUsd, {String mode = 'live'}) {
    if (feeUsd <= 0 || mode != 'live') return;
    final c = coin.toUpperCase();
    final px = priceOf(c);
    if (px > 0) {
      _pool.accrueFee(c, feeUsd, px);
      _touch();
      _postFee(c, feeUsd, px, mode); // grow the shared server treasury too
    } else {
      unawaited(_accrueWhenPriced(c, feeUsd, mode));
    }
  }

  // Record the fee into the SERVER treasury (best-effort, rate-limited server-side).
  void _postFee(String coin, double feeUsd, double coinUsd, String mode) {
    if (!serverBacked) return;
    unawaited(http
        .post(Uri.parse('$_serverBase/account/api/liquidity/fee'),
            headers: const {'content-type': 'application/json'},
            body: jsonEncode(
                {'coin': coin, 'feeUsd': feeUsd, 'coinUsd': coinUsd, 'mode': mode}))
        .timeout(const Duration(seconds: 8))
        .catchError((_) => http.Response('', 599)));
  }

  Future<void> _accrueWhenPriced(String coin, double feeUsd, String mode) async {
    await _fetchPrices([coin]);
    final px = priceOf(coin);
    if (px > 0) {
      _pool.accrueFee(coin, feeUsd, px);
      _touch();
      _postFee(coin, feeUsd, px, mode);
    }
  }

  // ---- quote / swap ---------------------------------------------------------
  // SERVER-BACKED QUOTES: the server's bonding curve is authoritative (it is
  // what a swap actually settles at), so previews come from /liquidity/quote.
  // The call is async but the screen's quote() is sync — so quote() returns the
  // cached server quote when it matches the requested (from,to,amount), and
  // otherwise kicks off a background fetch that notifyListeners() when it
  // lands (the screen rebuilds into the server numbers a beat later). The
  // local pool only answers when signed-off/offline — a preview, never truth.
  SwapQuote? _srvQuote;
  String _srvQuoteKey = '';
  String _srvQuoteInflight = '';
  int _srvQuoteSeq = 0;

  SwapQuote quote(String from, String to, double amountIn) {
    final coin = (from.toUpperCase() == 'BLOCK' ? to : from);
    if (serverBacked) {
      final key = '${from.toUpperCase()}>${to.toUpperCase()}>$amountIn';
      if (_srvQuoteKey == key && _srvQuote != null) return _srvQuote!;
      if (_srvQuoteInflight != key) {
        _srvQuoteInflight = key;
        unawaited(_fetchServerQuote(from, to, amountIn, coin, key));
      }
    }
    return _pool.quote(from, to, amountIn, priceOf(coin));
  }

  Future<void> _fetchServerQuote(
      String from, String to, double amountIn, String coin, String key) async {
    final seq = ++_srvQuoteSeq;
    try {
      final r = await http
          .post(Uri.parse('$_serverBase/account/api/liquidity/quote'),
              headers: const {'content-type': 'application/json'},
              body: jsonEncode({
                'from': from,
                'to': to,
                'amountIn': amountIn,
                'coinUsd': priceOf(coin),
              }))
          .timeout(const Duration(seconds: 8));
      if (seq != _srvQuoteSeq || r.statusCode != 200) return; // stale / failed
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      _srvQuote = SwapQuote(
        ok: j['ok'] == true,
        reason: j['reason'] as String?,
        amountIn: (j['amountIn'] as num?)?.toDouble() ?? amountIn,
        amountOut: (j['amountOut'] as num?)?.toDouble() ?? 0,
        assetIn: (j['assetIn'] as String?) ?? from.toUpperCase(),
        assetOut: (j['assetOut'] as String?) ?? to.toUpperCase(),
        blockPriceUsd:
            (j['blockPriceUsd'] as num?)?.toDouble() ?? blockPriceUsd,
      );
      _srvQuoteKey = key;
      _serverPriceUsd =
          (j['blockPriceUsd'] as num?)?.toDouble() ?? _serverPriceUsd;
      notifyListeners();
    } catch (_) {/* local preview stays */} finally {
      if (_srvQuoteInflight == key) _srvQuoteInflight = '';
    }
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

  // ---- on-chain settlement (gated server flow) ------------------------------
  // Coin families sharing a custodial hot wallet — MUST match the server
  // (liquidity.js). Only these settle on-chain today; everything else is
  // authoritative accounting until its chain's relayer leg is wired.
  static const Set<String> _evmCoins = {'USDC', 'USDT', 'DAI', 'ETH', 'BNB', 'MATIC', 'AVAX'};
  static const Set<String> _solCoins = {'SOL'};

  /// True when the server's on-chain settlement gate (LIQUIDITY_MAINNET) is live.
  bool get onchainSettlement => settlement == 'onchain';

  /// Whether [coin]'s leg can settle on-chain today. The server is the
  /// authority (its relayer legs: BLOCK ML-DSA, the EVM family, and SOL —
  /// liquidity_sol.js); when it does not advertise the list, mirror that set.
  bool coinSettlesOnchain(String coin) {
    final c = coin.toUpperCase();
    if (settleable.isNotEmpty) return settleable.contains(c);
    return c == 'BLOCK' || _evmCoins.contains(c) || _solCoins.contains(c);
  }

  /// Human list of the coins that settle on-chain (for the UI).
  String get settleableLabel {
    final list = settleable.isNotEmpty
        ? settleable
        : ['BLOCK', ..._evmCoins, ..._solCoins];
    return list.where((c) => c != 'BLOCK').join('/');
  }

  /// The treasury DEPOSIT address a user sends [coin] to, from the server's
  /// custodial set. null until the gate is live / the family is unwired.
  String? depositAddressFor(String coin) {
    final c = coin.toUpperCase();
    if (c == 'BLOCK') return custodial['block'] as String?;
    if (_solCoins.contains(c)) return custodial['solana'] as String?;
    if (_evmCoins.contains(c)) return custodial['evm'] as String?;
    return null;
  }

  /// Start a REAL on-chain swap: records the swap server-side and returns the
  /// settlement record ({id, depositAddress, amountIn, amountOut, status}).
  /// [receiveAddress] is where the PAYOUT (the `to` asset) is sent. null when
  /// offline/not server-backed. The user then deposits `amountIn` of `from` to
  /// depositAddress and calls [settle] with that txid.
  Future<Map<String, dynamic>?> startOnchainSwap(
      String from, String to, double amount, String receiveAddress) async {
    if (!serverBacked) return null;
    final coin = from.toUpperCase() == 'BLOCK' ? to : from;
    try {
      final r = await http
          .post(Uri.parse('$_serverBase/account/api/liquidity/swap'),
              headers: const {'content-type': 'application/json'},
              body: jsonEncode({
                'from': from,
                'to': to,
                'amountIn': amount,
                'coinUsd': priceOf(coin),
                'userAddress': receiveAddress,
              }))
          .timeout(const Duration(seconds: 12));
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      unawaited(_syncFromServer());
      return j;
    } catch (_) {
      return null;
    }
  }

  /// Settle a swap: post the user's deposit txid; the server verifies it and
  /// pays out the output asset. Returns the updated record (status 'settled' +
  /// payoutTxid on success, else a reason). Never throws.
  Future<Map<String, dynamic>> settle(String id, String depositTxid) async {
    try {
      final r = await http
          .post(Uri.parse('$_serverBase/account/api/liquidity/settle'),
              headers: const {'content-type': 'application/json'},
              body: jsonEncode({'id': id, 'depositTxid': depositTxid}))
          .timeout(const Duration(seconds: 25));
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      unawaited(_syncFromServer());
      return j;
    } catch (e) {
      return {'ok': false, 'error': '$e'};
    }
  }

  // ---- pending on-chain settlements (auto-resume) ---------------------------
  // Once a deposit is broadcast, the swap can finalize only after it confirms —
  // which for BLOCK is a ~10-minute block. We persist the (id, depositTxid) so
  // the payout completes automatically later, even if the user leaves the screen
  // or closes the app. The server settle is idempotent, so re-posting is safe.
  static const _pendingKey = 'blockle_liq_pending_v1';
  List<Map<String, dynamic>> _pending = [];
  List<Map<String, dynamic>> get pendingSettlements => List.unmodifiable(_pending);

  Future<void> _loadPending() async {
    try {
      final s = await _store.read(key: _pendingKey);
      if (s != null && s.isNotEmpty) {
        _pending = (jsonDecode(s) as List)
            .map((e) => (e as Map).cast<String, dynamic>())
            .toList();
      }
    } catch (_) {/* best-effort */}
  }

  Future<void> _savePending() async {
    try {
      await _store.write(key: _pendingKey, value: jsonEncode(_pending));
    } catch (_) {/* best-effort */}
  }

  /// Register a broadcast-but-not-yet-settled swap for automatic completion.
  Future<void> addPendingSettlement(Map<String, dynamic> rec) async {
    _pending.removeWhere((e) => e['id'] == rec['id']);
    _pending.add(rec);
    await _savePending();
    notifyListeners();
  }

  Future<void> _removePending(String id) async {
    final before = _pending.length;
    _pending.removeWhere((e) => e['id'] == id);
    if (_pending.length != before) {
      await _savePending();
      notifyListeners();
    }
  }

  /// Retry every pending settlement. A settled / terminally-failed / unknown swap
  /// is dropped; a still-confirming one is kept for the next pass. Best-effort,
  /// safe to call repeatedly (idempotent server-side).
  Future<void> resumePendingSettlements() async {
    if (_pending.isEmpty) return;
    for (final rec in [..._pending]) {
      final r = await settle('${rec['id']}', '${rec['depositTxid']}');
      final st = '${r['status'] ?? ''}';
      final err = '${r['error'] ?? ''}';
      // 'refunded' is final too (deposit returned, swap reverted); a
      // 'refund-pending' swap keeps retrying — the server finishes the refund.
      final terminal = st == 'settled' ||
          st == 'refunded' ||
          st == 'unsupported' ||
          st == 'failed' ||
          err.contains('unknown swap');
      if (terminal) await _removePending('${rec['id']}');
    }
  }

  /// USD liquidity actually AVAILABLE for [coin]: the accounting reserve capped
  /// by the hot wallet's REAL on-chain spendable balance (when the server
  /// reports one + settlement is live). What the ledger says means nothing if
  /// the wallet doesn't hold the coins.
  double availableLiquidityUsd(String coin) {
    final acct = _pool.availableLiquidityUsd(coin, priceOf(coin));
    if (!onchainSettlement) return acct;
    final spend = onchainSpendable[coin.toUpperCase()];
    if (spend == null) return acct;
    final px = priceOf(coin);
    final real = spend * (px > 0 ? px : 1.0);
    return acct < real ? acct : real;
  }

  /// REAL on-chain balance of [coin]'s hot wallet (null = not reported).
  double? onchainBalanceOf(String coin) => onchainBalance[coin.toUpperCase()];

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
