// state/exchange_controller.dart — host for the in-app exchange screen.
//
// Owns one [ExchangeClient] and the screen's view of the venue: its gate
// status, the market list, the selected market's book and tape, and — when an
// account is linked — that account's balances and open orders.
//
// THE TWO POTS ARE NEVER MERGED HERE. Exchange balances are kept in their own
// field and never folded into the wallet's holdings. They are a claim on a
// custodial venue, not coins this device can spend, and a UI that added them
// to a self-custody total would be stating something false about what the user
// controls.
//
// FAIL-SOFT, LOUDLY. Every load records an error string instead of throwing
// into the widget tree, and an error NEVER degrades to a zero or an empty list
// that reads as "you have nothing" — the screen shows the reason. The wallet
// does not depend on this controller at all; if the venue is down, the rest of
// the app is unaffected.

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../services/exchange_client.dart';

class ExchangeController extends ChangeNotifier {
  ExchangeController({ExchangeClient? client, String? Function()? bearer})
      : _client = client ?? ExchangeClient(bearer: bearer);

  final ExchangeClient _client;

  ExchangeClient get client => _client;

  ExchangeStatus? _status;
  List<ExchangeMarket> _markets = const [];
  String? _selected;
  OrderBook? _book;
  List<Map<String, dynamic>> _trades = const [];
  List<ExchangeBalance> _balances = const [];
  List<OpenOrder> _orders = const [];

  bool _loadingMarkets = false;
  bool _loadingMarket = false;
  bool _loadingAccount = false;

  String? _marketsError;
  String? _marketError;
  String? _accountError;

  Timer? _poll;

  ExchangeStatus? get status => _status;
  List<ExchangeMarket> get markets => _markets;
  String? get selected => _selected;
  OrderBook? get book => _book;
  List<Map<String, dynamic>> get trades => _trades;

  /// Balances HELD BY THE VENUE. Not wallet holdings; see the header.
  List<ExchangeBalance> get balances => _balances;
  List<OpenOrder> get orders => _orders;

  bool get loadingMarkets => _loadingMarkets;
  bool get loadingMarket => _loadingMarket;
  bool get loadingAccount => _loadingAccount;

  String? get marketsError => _marketsError;
  String? get marketError => _marketError;
  String? get accountError => _accountError;

  bool get signedIn => _client.signedIn;

  /// The venue's own answer to "can anyone trade here yet".
  ///
  /// Defaults to FALSE until /status has been read. An unknown gate must never
  /// present as open.
  bool get tradable => _status?.tradable ?? false;

  ExchangeMarket? get selectedMarket {
    final s = _selected;
    if (s == null) return null;
    for (final m in _markets) {
      if (m.id == s) return m;
    }
    return null;
  }

  /// Load the gate and the market list. Safe to call repeatedly.
  Future<void> loadMarkets() async {
    _loadingMarkets = true;
    _marketsError = null;
    notifyListeners();
    // The gate is read separately from the list so that a venue which is up
    // but not yet open still shows WHY, rather than an empty screen.
    try {
      _status = await _client.status();
    } catch (e) {
      _status = null;
      _marketsError = _say(e);
    }
    try {
      _markets = await _client.getMarkets();
      _selected ??= _markets.isEmpty ? null : _markets.first.id;
    } catch (e) {
      // Keep whatever list was already on screen: replacing it with an empty
      // one on a transient failure reads as "every market was delisted".
      _marketsError = _say(e);
    }
    _loadingMarkets = false;
    notifyListeners();
    final s = _selected;
    if (s != null) await selectMarket(s);
  }

  Future<void> selectMarket(String market) async {
    _selected = market;
    _loadingMarket = true;
    _marketError = null;
    notifyListeners();
    try {
      final b = await _client.getBook(market);
      final t = await _client.getTrades(market);
      // Only commit once BOTH arrived, so the screen never shows one market's
      // book beside another's tape.
      if (_selected == market) {
        _book = b;
        _trades = t;
      }
    } catch (e) {
      if (_selected == market) {
        _book = null;
        _trades = const [];
        _marketError = _say(e);
      }
    }
    _loadingMarket = false;
    notifyListeners();
  }

  /// Balances + open orders. Does nothing without an account session.
  Future<void> loadAccount() async {
    if (!_client.signedIn) {
      _balances = const [];
      _orders = const [];
      _accountError = null; // not an error: simply not signed in
      notifyListeners();
      return;
    }
    _loadingAccount = true;
    _accountError = null;
    notifyListeners();
    try {
      _balances = await _client.getBalances();
      _orders = await _client.getOpenOrders();
    } catch (e) {
      _accountError = _say(e);
      // DELIBERATELY NOT CLEARED. Showing an empty balance list because a
      // request failed tells the customer their money is gone.
    }
    _loadingAccount = false;
    notifyListeners();
  }

  Future<DepositTarget> depositAddress(String asset, {String? network}) =>
      _client.depositAddress(asset, network: network);

  /// Place an order, then refresh so the book and the account agree.
  Future<String?> placeOrder({
    required String market,
    required String side,
    required String type,
    required String size,
    String? price,
  }) async {
    try {
      await _client.placeOrder(
        market: market,
        side: side,
        type: type,
        size: size,
        price: price,
      );
    } catch (e) {
      return _say(e);
    }
    await Future.wait([selectMarket(market), loadAccount()]);
    return null;
  }

  Future<String?> cancelOrder(String id) async {
    try {
      await _client.cancelOrder(id);
    } catch (e) {
      return _say(e);
    }
    await loadAccount();
    final s = _selected;
    if (s != null) await selectMarket(s);
    return null;
  }

  /// Refresh the open market every [every]. Stopped by [dispose].
  void startPolling({Duration every = const Duration(seconds: 15)}) {
    _poll?.cancel();
    _poll = Timer.periodic(every, (_) {
      final s = _selected;
      if (s != null) selectMarket(s);
    });
  }

  void stopPolling() {
    _poll?.cancel();
    _poll = null;
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  /// A message worth showing a person.
  static String _say(Object e) {
    if (e is ExchangeException) return e.message;
    return e.toString();
  }
}
