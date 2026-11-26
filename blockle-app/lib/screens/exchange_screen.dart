// screens/exchange_screen.dart — the Blockle exchange, in the app.
//
// THE SAME VENUE AS exchange.blockle.org, CONDENSED ONTO ONE TAB. The web
// exchange is eleven screens behind a left rail; this is that whole surface
// inside the app's existing Exchange tab (nav index 9 — unchanged, nothing is
// renumbered), with a permanent 60pt icon rail up the left of the tab's body
// and the sections beside it.
//
// WHAT CHANGED FOR THE USER, CONCRETELY. This tab used to be ONE flat scrolling
// column: the gate banner, then a two-pots explainer, then a market chip strip,
// then the book, then the order form, then balances, then open orders. Placing
// an order meant scrolling past two explainers every single time, and
// withdrawing was not reachable at all. Now every destination is one tap from
// anywhere, at a fixed screen position, and the state that needs attention
// shows as a dot on the rail BEFORE you tap.
//
// THE CENTRAL IDEA THE UI STILL HAS TO CARRY. There are two pots of money and
// they are not the same pot. The Wallet tab holds coins this device has keys
// for; the exchange holds a balance for your Blockle account. To trade you SEND
// from the wallet to the exchange's deposit address — the app never moves it
// for you. That explainer now lives on the BALANCE section, which is what it
// explains, instead of being paid for on every visit.
//
// AND IT MUST NOT OVERSTATE THE VENUE. The environment badge fails closed: it
// reads TESTNET unless /public/status says live, and the order form stays
// disabled until the venue says every gate is open.
//
// NOTHING HERE OFFERS A PATH AROUND A SERVER GATE. Withdrawals need an enrolled
// authenticator and an allowlisted destination with a 24h cooling-off period;
// those are refusals the venue makes, and the app's job is to say so plainly,
// not to route around them.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../state/exchange_controller.dart';
import '../theme.dart';
import 'exchange/coin_names.dart';
import 'exchange/exchange_rail.dart';
import 'exchange/exchange_ui.dart';
import 'exchange/section_table.dart';
import 'exchange/sections/balance_section.dart';
import 'exchange/sections/deposit_section.dart';
import 'exchange/sections/markets_section.dart';
import 'exchange/sections/orders_section.dart';
import 'exchange/sections/pending_sections.dart';
import 'exchange/sections/trade_section.dart';

class ExchangeScreen extends StatefulWidget {
  const ExchangeScreen({super.key});

  @override
  State<ExchangeScreen> createState() => _ExchangeScreenState();
}

class _ExchangeScreenState extends State<ExchangeScreen>
    with WidgetsBindingObserver {
  bool _started = false;

  @override
  void initState() {
    super.initState();
    // The poll is torn down when the app goes to the background: a phone in a
    // pocket hammering a venue every three seconds is someone's battery and
    // someone else's rate limit.
    WidgetsBinding.instance.addObserver(this);
  }

  /// The controller, captured while the element is still mounted.
  ///
  /// `dispose()` MUST NOT reach for an InheritedWidget: by then this element is
  /// deactivated and `context.read` throws "looking up a deactivated widget's
  /// ancestor is unsafe". The symptom is a screen that cannot be left — in a
  /// test it is a thrown exception during teardown, and in the app it is a red
  /// screen on tab change — and the fix is to hold the reference from the last
  /// point at which looking it up is legal.
  ExchangeController? _held;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final c = context.read<ExchangeController>();
    _held = c;
    if (_started) return;
    _started = true;
    // AFTER THE FRAME, not during it.
    //
    // Every one of these loaders calls notifyListeners() synchronously before
    // its first await — it has to, so the screen can show a spinner — and
    // didChangeDependencies runs INSIDE build. Calling them here directly
    // marks the provider's element dirty mid-build, which Flutter asserts on
    // ("setState() called during build"). One frame's delay costs nothing
    // visible and is the difference between a screen that opens and one that
    // throws on arrival.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // Fire-and-forget: every section renders its own loading and error states.
      c.loadMarkets();
      c.loadAccount();
      c.loadFees();
      c.loadBadges();
      c.startPolling();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final c = _held;
    if (c == null) return;
    if (state == AppLifecycleState.resumed) {
      c.startPolling();
      c.loadBadges();
    } else {
      c.stopPolling();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // The controller is app-wide; only this screen's polling stops. Read from
    // the captured reference, never from the context — see [_held].
    _held?.stopPolling();
    super.dispose();
  }

  /// Apply a `blockle://exchange/<section>[/<MARKET>]` arrival, once.
  ///
  /// A LINK IS UNTRUSTED INPUT. It can be fired at the app from any web page, a
  /// QR code or an iMessage, and the market it names is an arbitrary string.
  /// `blockle://exchange/trade/BLOCK-USDT` used to be honoured verbatim, which
  /// put "Last traded at 0.0412 USDT" in the TRADE header and `BLOCK/USDT
  /// 0.0412` in the persistent top strip of EVERY section — a US-dollar price
  /// for BLOCK, the one thing this app does not do, arriving through the single
  /// entry point that did not consult [exchangeMarketAllowed].
  ///
  /// So a market this app may not price does not open TRADE on something else
  /// either: it lands on MARKETS, which is a place the user can act from.
  void _consumeDeepLink(AppState app, ExchangeController c) {
    final want = app.pendingExchangeSection;
    if (want == null) return;
    final market = app.pendingExchangeMarket;
    app.consumedExchangeTarget();
    final sec = exchangeSectionById(want);
    if (sec == null) return;
    if (market != null && market.isNotEmpty) {
      if (!exchangeMarketAllowed(market)) {
        c.setSection('markets');
        return;
      }
      c.selectMarket(market);
    }
    c.setSection(sec.id);
  }

  void _go(ExchangeController c, String sectionId) => c.setSection(sectionId);

  void _tradeMarket(ExchangeController c, String market) {
    c.selectMarket(market);
    c.setSection('trade');
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    return Consumer<ExchangeController>(
      builder: (context, c, _) {
        // A deep link may land while this tab is already built, so it is
        // consumed after the frame rather than during it.
        if (app.pendingExchangeSection != null) {
          WidgetsBinding.instance
              .addPostFrameCallback((_) => _consumeDeepLink(app, c));
        }
        final section = exchangeSectionOrDefault(c.section);
        return Scaffold(
          appBar: AppBar(
            title: const Text('Exchange'),
            actions: [
              IconButton(
                tooltip: 'Refresh',
                icon: const Icon(Icons.refresh),
                onPressed: () {
                  c.loadMarkets();
                  c.loadAccount();
                  c.loadBadges();
                },
              ),
            ],
          ),
          body: LayoutBuilder(
            builder: (context, box) {
              // ONE BREAKPOINT. Below it the rail is 60pt of icons; at and
              // above it (iPad, Stage Manager) it expands to 200pt with the
              // full names and numeric badges — generated from the same table,
              // so there is no second implementation to keep in step.
              final expanded = box.maxWidth >= kExpandedRailMinWidth;
              return Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ExchangeRail(
                    selectedId: section.id,
                    badges: _badges(c),
                    expanded: expanded,
                    onSelect: (s) => _go(c, s.id),
                  ),
                  const VerticalDivider(width: 1, thickness: 1, color: Bk.line),
                  Expanded(
                    // The rail paid for the LEFT inset itself; the content pane
                    // picks up the right and bottom ones. The rail sits outside
                    // anything that reads viewInsets.bottom, so a raised
                    // keyboard shrinks this pane and leaves the rail at exactly
                    // the same pixel — the whole point of a persistent rail is
                    // that the tap target does not move.
                    child: SafeArea(
                      left: false,
                      top: false,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _TopStrip(c: c),
                          const Divider(height: 1, thickness: 1, color: Bk.line),
                          Expanded(child: _content(c, section)),
                        ],
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        );
      },
    );
  }

  /// Every dot on the rail, from the same reads the sections themselves use.
  static ExchangeBadgeState _badges(ExchangeController c) => ExchangeBadgeState(
        ordersWorking: c.ordersWorking,
        depositsConfirming: c.depositsWaiting,
        laddersResting: c.laddersOpen,
        liveApiKeys: c.apiKeysLive,
        twoFactorEnrolled: c.twoFactorOn,
        // The venue requires an allowlisted destination (WD_REQUIRE_ALLOWLIST
        // is true), and -1 means "not read yet" rather than "none".
        allowlistRequired: c.allowlistCount < 0 ? null : true,
        allowlistEntries: c.allowlistCount < 0 ? null : c.allowlistCount,
      );

  /// THE SWITCH AND THE RAIL READ THE SAME TABLE, so a section cannot exist in
  /// one and be missing from the other.
  Widget _content(ExchangeController c, ExchangeSection s) {
    // Signed-out treatment is PER SECTION, not the web's full-screen curtain,
    // precisely so the rail stays usable while signed out.
    if (s.authRequired && !c.signedIn) return ExAuthGate(section: s);

    return switch (s.id) {
      'markets' => MarketsSection(c: c, onTrade: (m) => _tradeMarket(c, m)),
      'trade' => TradeSection(
          c: c,
          onPickMarket: () => _go(c, 'markets'),
        ),
      'orders' => OrdersSection(c: c),
      'balances' => BalanceSection(
          c: c,
          onDeposit: () => _go(c, 'deposit'),
          onWithdraw: () => _go(c, 'withdraw'),
          onTrade: (m) => _tradeMarket(c, m),
        ),
      'deposit' => DepositSection(c: c),
      'withdraw' => const WithdrawPending(),
      'liquidity' => const LaddersPending(),
      'fees' => FeesPending(c: c),
      // Their own screens now, as on the web, instead of being buried inside
      // "The venue" and Account where nobody would find them.
      'listing' => ListingSection(c: c),
      'api' => ApiSection(c: c),
      'account' => AccountPending(c: c),
      // Unreachable while the table and this switch agree — and it is a
      // readable failure rather than a crash if they ever do not.
      _ => ExPlaceholder(
          title: s.name,
          summary: 'This section has no screen wired to it.',
        ),
    };
  }
}

/// The persistent line under the app bar.
///
/// The web keeps Market / Last / Bid / Ask / Spread / Environment / Fees /
/// identity visible from every screen. At 299pt of content width that is not a
/// row, so it compresses to one tappable 30pt line: the fail-closed environment
/// pill, the market, its last price, and the maker/taker figures. Bid and ask
/// drop out — they are two lines away on TRADE, and the spread is the figure
/// that actually says whether the book is worth hitting. The signed-in identity
/// moves to the ACCOUNT rail item, which is where anyone would look for it.
class _TopStrip extends StatelessWidget {
  const _TopStrip({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    final s = c.status;
    final live = s?.live == true; // FAIL CLOSED: unknown reads as not live.
    final m = c.selectedMarket;
    final f = c.fees;

    return InkWell(
      onTap: () => _switchMarket(context, c),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 7, 12, 7),
        // EVERY SIZING CHILD IS FLEXIBLE, and every figure can ellipsize.
        //
        // This row is drawn on every section of the tab, so one unbounded Text
        // in it breaks the whole tab at once — and it did: an eight-decimal
        // price on a BLOCK-quoted market is 17 monospace characters
        // (BTC-BLOCK's live last is 90123456.78901234), which overflowed a
        // 390pt phone by 123pt at DEFAULT text size. RenderFlex does not clip
        // in release, so there was no debug stripe to notice — the trailing
        // digits of a live price simply ran off the edge.
        child: Row(children: [
          ExPill(live ? 'LIVE' : 'TESTNET', tone: live ? ExTone.good : ExTone.warn),
          const SizedBox(width: 8),
          if (m == null)
            const Expanded(
              child: Text('No market selected',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: Bk.muted)),
            )
          else
            Expanded(
              child: Row(children: [
                Flexible(
                  child: Text(m.pair,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 12.5, fontWeight: FontWeight.w700)),
                ),
                const SizedBox(width: 8),
                Flexible(
                  // The venue's own decimal string, not the parsed double:
                  // `0.00000012` must not render as `1.2e-7`. See figStr.
                  child: Text(figStr(m.lastText, m.last),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: kMono.copyWith(fontSize: 12)),
                ),
              ]),
            ),
          if (f != null) ...[
            const SizedBox(width: 8),
            Text('${f.makerPct}/${f.takerPct}',
                style: const TextStyle(fontSize: 11, color: Bk.faint)),
          ],
          const SizedBox(width: 4),
          const Icon(Icons.unfold_more, size: 14, color: Bk.faint),
        ]),
      ),
    );
  }

  static void _switchMarket(BuildContext context, ExchangeController c) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _MarketSwitcher(c: c),
    );
  }
}

/// The market switcher, as a sheet.
///
/// A sheet rather than the old horizontal chip strip because the list is about
/// to get much longer — the venue's quote set is being expanded, and a chip
/// strip hides entries off BOTH edges with no cue anyone obeys. It is also a
/// horizontal gesture directly above a chart and a ladder that both want
/// horizontal gestures.
class _MarketSwitcher extends StatefulWidget {
  const _MarketSwitcher({required this.c});
  final ExchangeController c;

  @override
  State<_MarketSwitcher> createState() => _MarketSwitcherState();
}

class _MarketSwitcherState extends State<_MarketSwitcher> {
  final _q = TextEditingController();

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final needle = _q.text.trim().toUpperCase();
    final rows = widget.c.visibleMarkets.where((m) {
      if (needle.isEmpty) return true;
      return m.id.toUpperCase().contains(needle) ||
          coinName(m.base).toUpperCase().contains(needle);
    }).toList();

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
            child: TextField(
              controller: _q,
              autofocus: false,
              textCapitalization: TextCapitalization.characters,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                isDense: true,
                prefixIcon: Icon(Icons.search, size: 20),
                hintText: 'Pair or coin name',
              ),
            ),
          ),
          Expanded(
            child: rows.isEmpty
                ? const Center(child: Text('No market matches that.'))
                : ListView.builder(
                    itemCount: rows.length,
                    itemBuilder: (ctx, i) {
                      final m = rows[i];
                      return ListTile(
                        title: Text(m.pair),
                        subtitle: Text(
                          m.last == null
                              ? 'no trades yet'
                              : 'last ${figStr(m.lastText, m.last)} ${m.quote}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: m.id == widget.c.selected
                            ? const Icon(Icons.check, color: Bk.accent)
                            : null,
                        onTap: () {
                          widget.c.selectMarket(m.id);
                          Navigator.of(ctx).pop();
                        },
                      );
                    },
                  ),
          ),
        ]),
      ),
    );
  }
}
