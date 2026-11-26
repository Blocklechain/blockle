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

import '../multichain/denomination.dart';
import '../services/exchange_client.dart';

/// Whether a market that quotes a BLOCK-denominated asset in a USD stablecoin
/// is hidden from the app.
///
/// FALSE. The never-price-BLOCK-in-USD rule is satisfied by HOW the figure is
/// rendered, not by withholding the market: a BLOCK-USDT price is shown
/// strictly in its own quote unit — "0.0412 USDT", no dollar sign, no
/// conversion, and no USD column anywhere in the tab — which states a fact
/// about an order book rather than a dollar valuation of BLOCK. Hiding it
/// instead cost twelve of the venue's forty markets, including the one most
/// visitors come for, and told them nothing true in exchange.
///
/// The flag and the predicate below stay because the rule they encode is real
/// and the moment anything in this tab starts converting a quote figure into
/// dollars — a portfolio total, a sort key, a "≈ $" hint — flipping this back
/// to true is the one-line defence.
const bool kHideUsdQuotedBlockMarkets = false;

/// The stablecoins whose price IS a dollar price. USDB is here because it is a
/// BLOCK-20S pegged to the dollar: quoting BLOCK in USDB is quoting BLOCK in
/// dollars with extra steps.
const Set<String> kUsdStablecoins = {'USDT', 'USDC', 'USDB', 'DAI', 'TUSD', 'PYUSD'};

/// True when one leg of [m] must be priced only in BLOCK and the other leg is
/// a dollar stablecoin — i.e. the pair's price is a USD price for BLOCK.
bool isUsdQuotedBlockMarket(ExchangeMarket m) =>
    _usdQuotedBlock(m.base, m.quote);

/// The same rule applied to a BARE MARKET ID, before the market list exists.
///
/// THIS IS THE ONE THE DEEP LINK NEEDS. `blockle://exchange/trade/BLOCK-USDT`
/// can arrive from any web page, QR code or iMessage link, and it can arrive
/// BEFORE /public/markets has answered — so a check that needs the loaded
/// market list cannot defend the rule. The venue's ids are `BASE-QUOTE`
/// (publicapi.ts `symbol`), which is all this needs.
bool isUsdQuotedBlockMarketId(String id) {
  final parts = id.toUpperCase().split('-');
  if (parts.length != 2) return false;
  return _usdQuotedBlock(parts[0], parts[1]);
}

bool _usdQuotedBlock(String base, String quote) {
  final baseIsBlock = isBlockDenominated(symbol: base);
  final quoteIsBlock = isBlockDenominated(symbol: quote);
  final baseIsUsd = kUsdStablecoins.contains(base.toUpperCase());
  final quoteIsUsd = kUsdStablecoins.contains(quote.toUpperCase());
  return (baseIsBlock && quoteIsUsd) || (quoteIsBlock && baseIsUsd);
}

/// Whether this app may select [marketId] at all.
///
/// Every entry point goes through here — the rail, the market list, the
/// switcher sheet, a balance row's Trade link, and a deep link — so there is
/// one answer rather than five.
bool exchangeMarketAllowed(String marketId) =>
    !kHideUsdQuotedBlockMarkets || !isUsdQuotedBlockMarketId(marketId);

/// What the venue did with an order, in its own terms.
///
/// NOT A BOOLEAN. `POST /v1/orders` answers with a state and a filled-of-total,
/// and "filled 5 of 5" versus "resting on the book, 1 of 5 filled" are
/// different outcomes: in one the user holds the coin, in the other they hold a
/// claim that may never fill. A single "Order placed." hides which one they
/// got. [error] non-null means nothing was placed at all.
class PlaceOrderResult {
  const PlaceOrderResult({this.state, this.filled, this.total, this.error});
  final String? state;
  final String? filled;
  final String? total;
  final String? error;

  bool get ok => error == null;

  /// True when the order is wholly done. Anything else is resting.
  bool get complete => state == 'filled';

  /// A sentence for the user. Falls back to the plain claim when the venue did
  /// not report the detail, rather than inventing a figure.
  String get summary {
    if (error != null) return error!;
    final f = filled, t = total;
    if (f == null || t == null) return complete ? 'Filled.' : 'Resting on the book.';
    return complete
        ? 'Filled $f of $t.'
        : 'Resting on the book: $f of $t filled.';
  }
}

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

  /// THE 503-vs-401 DISCRIMINATOR, kept apart from [accountError] on purpose.
  ///
  /// The venue answers 503 when the ACCOUNTS service behind it is unreachable
  /// (exchange_client.me's doc note). That is a different instruction to the
  /// customer than "sign in": offering a sign-in button for a service that is
  /// down is a loop that cannot succeed, and the web says so explicitly rather
  /// than flattening the two. Null until an authenticated read has answered.
  bool get accountServiceDown => _accountServiceDown;
  bool _accountServiceDown = false;

  bool get signedIn => _client.signedIn;

  // ------------------------------------------------------ the section + its tick

  /// The Exchange tab's open sub-section. Drives both the rail's selection and
  /// the poll interval — see [startPolling].
  String _section = 'markets';
  String get section => _section;

  /// Bumped every time the open section's data should be re-read.
  ///
  /// Sections subscribe to THIS rather than to the controller itself, so a
  /// poll tick reloads only the section on screen. A `ChangeNotifier` listener
  /// would fire on every unrelated `notifyListeners()` and re-request six
  /// endpoints because a market was selected.
  final ValueNotifier<int> refreshTick = ValueNotifier<int>(0);

  void setSection(String s) {
    if (_section == s) return;
    _section = s;
    notifyListeners();
    // The cadence belongs to the section, so changing section re-times it.
    if (_poll != null) startPolling();
  }

  // ------------------------------------------------------------ rail badges
  //
  // A dot on the rail is how a user learns their withdrawal will fail BEFORE
  // they fill the form in. Every count here comes from the same route the
  // section itself reads, so a dot can never disagree with the screen behind
  // it.

  int _depositsWaiting = 0;
  int _ordersWorking = 0;
  int _laddersOpen = 0;
  int _apiKeysLive = 0;

  /// NULL = we could not check. Never rendered as "off": "we do not know
  /// whether your money is behind a second factor" is not the same claim as
  /// "it is not", and only one of them is safe to show.
  bool? _twoFactorOn;

  /// -1 = not read yet. 0 is a REAL and dangerous answer — with the allowlist
  /// required, zero destinations means no withdrawal can succeed.
  int _allowlistCount = -1;

  ExchangeFees? _fees;

  int get depositsWaiting => _depositsWaiting;
  int get ordersWorking => _ordersWorking;
  int get laddersOpen => _laddersOpen;
  int get apiKeysLive => _apiKeysLive;
  bool? get twoFactorOn => _twoFactorOn;
  int get allowlistCount => _allowlistCount;

  /// The venue's fee schedule, once read. Needed by the order ticket (the
  /// estimated fee), the ladder builder (the break-even) and the fee screen.
  ExchangeFees? get fees => _fees;

  /// True when a withdrawal CANNOT succeed as things stand: no authenticator,
  /// or no allowlisted destination while the allowlist is required. Both are
  /// server refusals, so saying so up front is the honest thing.
  bool get withdrawalBlocked =>
      _twoFactorOn == false || _allowlistCount == 0;

  Future<void> loadFees() async {
    if (_fees != null) return;
    try {
      _fees = await _client.fees();
      notifyListeners();
    } catch (_) {
      // A missing fee figure degrades the ticket's estimate to "—"; it is not
      // worth an error banner on a screen that is otherwise working.
    }
  }

  /// Refresh the counts behind the rail's dots. Every read is independent so
  /// one failure cannot blank the rest, and a failed read leaves the previous
  /// count rather than reporting zero — "0 orders working" because a request
  /// timed out would hide a resting order.
  Future<void> loadBadges() async {
    if (!_client.signedIn) {
      _depositsWaiting = 0;
      _ordersWorking = 0;
      _laddersOpen = 0;
      _apiKeysLive = 0;
      _twoFactorOn = null;
      _allowlistCount = -1;
      notifyListeners();
      return;
    }
    await Future.wait<void>([
      _client.deposits().then((d) {
        _depositsWaiting = d.where((x) => x.waiting).length;
      }).catchError((_) {}),
      _client.getOpenOrders().then((o) {
        _ordersWorking = o.where((x) => x.open).length;
      }).catchError((_) {}),
      _client.ladders().then((l) {
        _laddersOpen = l.where((x) => x.open).length;
      }).catchError((_) {}),
      _client.apiKeys().then((k) {
        _apiKeysLive = k.liveCount;
      }).catchError((_) {}),
      _client.twoFactorEnrolled().then((on) {
        _twoFactorOn = on;
      }).catchError((_) {
        _twoFactorOn = null; // unknown, NOT off
      }),
      _client.allowlist().then((a) {
        _allowlistCount = a.entries.length;
      }).catchError((_) {}),
    ]);
    notifyListeners();
  }

  /// The venue's own answer to "can anyone trade here yet".
  ///
  /// Defaults to FALSE until /status has been read. An unknown gate must never
  /// present as open.
  bool get tradable => _status?.tradable ?? false;

  /// The markets the UI may show.
  ///
  /// EVERY LISTED MARKET, as things stand — see [kHideUsdQuotedBlockMarkets]
  /// for the rule this used to enforce by subtraction and now enforces by
  /// rendering every price in its own quote unit.
  ///
  /// It stays a derived getter rather than becoming `markets` at every call
  /// site because it is the single seam the rule is applied at: one assignment
  /// re-withholds a quote currency across the market list, the switcher sheet,
  /// the balance rows' Trade links, the ladder builder and the deep link,
  /// without any of them having to remember.
  List<ExchangeMarket> get visibleMarkets => kHideUsdQuotedBlockMarkets
      ? _markets.where((m) => !isUsdQuotedBlockMarket(m)).toList()
      : _markets;

  /// The selected market, resolved against [visibleMarkets] — NOT against the
  /// full list.
  ///
  /// The distinction is the whole defence. This used to search `_markets`, so
  /// anything that managed to put a withheld id into `_selected` got a USD
  /// price for BLOCK into the persistent top strip and the order ticket, on
  /// every section of the tab, while the market list and every other surface
  /// correctly refused to show it. [selectMarket] now refuses such an id
  /// outright; this is the second line, so that a future caller setting the
  /// field some other way still cannot render the pair.
  ExchangeMarket? get selectedMarket {
    final s = _selected;
    if (s == null) return null;
    for (final m in visibleMarkets) {
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
      // From the VISIBLE list: defaulting to a market the UI then refuses to
      // show would open the trade view on a blank ticket.
      final shown = visibleMarkets;
      _selected ??= shown.isEmpty ? null : shown.first.id;
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

  /// Select a market and read its book and tape.
  ///
  /// REFUSES A MARKET THIS APP MAY NOT PRICE. A caller with an arbitrary string
  /// — a deep link is exactly that — cannot put BLOCK-USDT on screen through
  /// here. The refusal is silent and leaves the previous selection alone
  /// because the caller is a URL, not a person who can be told; the screen that
  /// handles the link sends the user to MARKETS instead, which is a place they
  /// can act from.
  Future<void> selectMarket(String market) async {
    if (!exchangeMarketAllowed(market)) return;
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
      _accountServiceDown = false;
    } catch (e) {
      _accountError = _say(e);
      _accountServiceDown = e is ExchangeException && e.status == 503;
      // DELIBERATELY NOT CLEARED. Showing an empty balance list because a
      // request failed tells the customer their money is gone.
    }
    _loadingAccount = false;
    notifyListeners();
  }

  Future<DepositTarget> depositAddress(String asset, {String? network}) =>
      _client.depositAddress(asset, network: network);

  /// Place an order, then refresh so the book and the account agree.
  ///
  /// RETURNS WHAT THE VENUE SAID, not a boolean. `POST /v1/orders` answers with
  /// `state` and `filled`/`total`, and the difference between "filled 5 of 5"
  /// and "resting on the book, 1 of 5 filled" is the difference between holding
  /// the coin and holding a claim that may never fill. This used to discard the
  /// response body and the ticket told the user to go and look at another
  /// screen to find out which one they got.
  Future<PlaceOrderResult> placeOrder({
    required String market,
    required String side,
    required String type,
    required String size,
    String? price,
  }) async {
    Map<String, dynamic> reply;
    try {
      reply = await _client.placeOrder(
        market: market,
        side: side,
        type: type,
        size: size,
        price: price,
      );
    } catch (e) {
      return PlaceOrderResult(error: _say(e));
    }
    await Future.wait([selectMarket(market), loadAccount()]);
    return PlaceOrderResult(
      state: reply['state']?.toString(),
      filled: reply['filled']?.toString(),
      total: reply['total']?.toString(),
    );
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

  /// Poll the OPEN SECTION, at the cadence that section deserves.
  ///
  /// The web does exactly this (3s on the trading screen, 8s everywhere else)
  /// and it is strictly better than the blanket 15s this used to run: a ladder
  /// moves between ticks on a trading view, and nothing on the fee schedule
  /// does. [every] overrides both, for tests.
  void startPolling({Duration? every}) {
    _poll?.cancel();
    final period = every ??
        (_section == 'trade'
            ? const Duration(seconds: 3)
            : const Duration(seconds: 8));
    _poll = Timer.periodic(period, (_) {
      // The book and tape only matter while TRADE or MARKETS is open; every
      // other section re-reads its own endpoints off the tick.
      if (_section == 'trade' || _section == 'markets') {
        final s = _selected;
        if (s != null) selectMarket(s);
      }
      refreshTick.value++;
      loadBadges();
    });
  }

  void stopPolling() {
    _poll?.cancel();
    _poll = null;
  }

  @override
  void dispose() {
    _poll?.cancel();
    refreshTick.dispose();
    super.dispose();
  }

  /// A message worth showing a person.
  static String _say(Object e) {
    if (e is ExchangeException) return e.message;
    return e.toString();
  }
}
