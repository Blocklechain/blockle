// screens/exchange/sections/trade_section.dart — the book, the tape, the ticket.
//
// THE LADDER IS THE DEPTH CHART. Each level carries a background bar sized by
// the CUMULATIVE size from the best price outwards, scaled to the deepest side,
// so the shape of the book is readable without a second widget and without a
// chart library. Asks are drawn reversed — best ask at the bottom of its block —
// so the best ask abuts the best bid across the spread row, which is the way a
// book is read everywhere else.
//
// AND EVERY LEVEL IS TAPPABLE: a tap fills the limit price. It does NOT change
// the side. Hitting an ask is a buy and hitting a bid is a sell, so a ladder
// that set the side too would turn one misplaced thumb on a price into a
// reversed order, and the side is the one field on the ticket nobody should
// change without meaning to.
//
// `priceDecimals` IS THE TRAP ON THIS SCREEN. A price is quote base units per
// whole unit of base times 10^priceDecimals, and `priceDecimals` is per market
// — 0 on the twenty-four USDT/BLOCK markets and 1, 2, 4, 5 or 8 on the BTC- and
// USDC-quoted ones. Format or parse one with the quote's decimals alone and the
// figure is wrong by that power of ten in opposite directions on the way in and
// the way out. So no price, size, order value or fee on this screen is computed
// in a `double`: every one of them goes through [ExTicketQuote], which is the
// venue's own integer arithmetic ported field for field.
//
// LIMIT ORDERS ONLY. The venue has no market order — POST /v1/orders takes
// market/side/price/amount and nothing else — so there is no order-type picker,
// and the ticket says so rather than leaving a user looking for one.
//
// A CLOSED MARKET STILL OPENS HERE. The book, the tape and the cancels are
// intact on a closed market; what is refused is a NEW ORDER, with the venue's
// own sentence saying why. The ticket is replaced by that sentence instead of
// offering a button that answers 409.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../services/exchange_amount.dart';
import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../exchange_ui.dart';
import 'price_chart.dart';

class TradeSection extends StatefulWidget {
  const TradeSection({super.key, required this.c, required this.onPickMarket});
  final ExchangeController c;
  final VoidCallback onPickMarket;

  @override
  State<TradeSection> createState() => _TradeSectionState();
}

class _TradeSectionState extends State<TradeSection> {
  /// THE TICKET'S FIELDS LIVE HERE, not in the ticket widget, because the
  /// LADDER writes to the price field. Two widgets that both own a
  /// TextEditingController for the same value is how a tapped level ends up
  /// filling a field the submit button cannot see.
  final _price = TextEditingController();
  final _amount = TextEditingController();
  String _side = 'buy';

  @override
  void dispose() {
    _price.dispose();
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final m = c.selectedMarket;
    if (m == null) {
      return ExBody(children: [
        const ExHeader(title: 'Trade'),
        ExCard(
          tone: c.marketsError == null ? ExTone.plain : ExTone.bad,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(c.marketsError == null
                ? 'Pick a market to trade.'
                : 'The market list could not be read: ${c.marketsError}'),
            const SizedBox(height: 12),
            OutlinedButton(
                onPressed: widget.onPickMarket,
                child: const Text('Choose a market')),
          ]),
        ),
      ]);
    }

    return ExBody(children: [
      ExHeader(
        title: m.pair,
        // IN ITS OWN QUOTE UNIT. No dollar sign and no conversion, which is
        // what lets a BLOCK market show a live price at all.
        note: m.last == null
            ? 'No trades yet on this market.'
            : 'Last traded at ${figStr(m.lastText, m.last)} ${m.quote}.',
        trailing: OutlinedButton(
          onPressed: widget.onPickMarket,
          style: OutlinedButton.styleFrom(
              minimumSize: const Size(0, 36),
              padding: const EdgeInsets.symmetric(horizontal: 12)),
          child: const Text('Switch'),
        ),
      ),
      _MarketState(m: m),
      // THE PRICE LINE, above the ladder — matching the web's Trade page,
      // which had a chart here while the app had only the ladder. Same
      // source (/public/trades), same sentence when there is nothing to draw.
      PriceChart(market: m, trades: c.trades),
      _Book(c: c, m: m, onPickPrice: _fillPrice),
      const SizedBox(height: 16),
      _Tape(c: c, m: m),
      const SizedBox(height: 16),
      _OrderTicket(
        c: c,
        m: m,
        price: _price,
        amount: _amount,
        side: _side,
        onSide: (s) => setState(() => _side = s),
      ),
      const SizedBox(height: 16),
      _OrdersHere(c: c),
    ]);
  }

  /// A tapped level fills the price, as the venue would render it — so what
  /// lands in the field is at the market's own [ExchangeMarket.priceScale] and
  /// not a reformatted double.
  void _fillPrice(ExchangeMarket m, OrderLevel l) {
    // The venue's string when it sent one; otherwise the parsed figure at this
    // market's OWN scale — never a bare `num.toString()`, which goes
    // exponential below 1e-6 and would put "1.2e-7" in the price field.
    final text = (l.priceText != null && l.priceText!.trim().isNotEmpty)
        ? l.priceText!.trim()
        : exFixed(l.price, m.priceScale);
    _price.text = text;
    _price.selection = TextSelection.collapsed(offset: text.length);
    setState(() {});
  }
}

/// The venue's own sentence about this market's state. Shown in full here —
/// MARKETS clamps it to keep a 40-row list scannable, and this is where the
/// whole thing belongs, next to the ticket it governs.
class _MarketState extends StatelessWidget {
  const _MarketState({required this.m});
  final ExchangeMarket m;

  @override
  Widget build(BuildContext context) {
    final closed = m.closed;
    final caveat = m.caveat;
    if (closed == null && caveat == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(children: [
        if (closed != null)
          ExCard(
            tone: ExTone.bad,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Row(children: [
                ExPill('CLOSED TO NEW ORDERS', tone: ExTone.bad),
              ]),
              const SizedBox(height: 8),
              Text(closed, style: const TextStyle(fontSize: 13, height: 1.4)),
              const SizedBox(height: 8),
              const Text(
                'The book, the trade history and cancelling an order you '
                'already have are all unaffected.',
                style: TextStyle(fontSize: 12, color: Bk.muted, height: 1.35),
              ),
            ]),
          ),
        if (closed != null && caveat != null) const SizedBox(height: 10),
        if (caveat != null)
          ExCard(
            tone: ExTone.warn,
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Row(children: [ExPill('KNOWN GAP', tone: ExTone.warn)]),
              const SizedBox(height: 8),
              Text(caveat, style: const TextStyle(fontSize: 13, height: 1.4)),
            ]),
          ),
      ]),
    );
  }
}

class _Book extends StatelessWidget {
  const _Book({required this.c, required this.m, required this.onPickPrice});
  final ExchangeController c;
  final ExchangeMarket m;
  final void Function(ExchangeMarket m, OrderLevel l) onPickPrice;

  /// How many levels a side shows. The venue publishes more; eight a side is
  /// what fits above the ticket without the ticket leaving the screen.
  static const int _depth = 8;

  @override
  Widget build(BuildContext context) {
    // A SPINNER ONLY WHILE A REQUEST IS ACTUALLY OUT. `loadingMarket` is
    // cleared on both paths out of selectMarket, so this cannot outlive it, and
    // it is never drawn over a book we already have — a 3s poll tick must not
    // blink the ladder.
    if (c.loadingMarket && c.book == null) {
      return const Center(
          child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()));
    }
    final err = c.marketError;
    if (err != null) return ExError(what: 'the order book', message: err);

    final b = c.book;
    if (b == null || b.isEmpty) {
      return ExCard(
        child: Text(
          'No orders on ${m.pair} yet. An empty book is not a price — nothing '
          'here is quoting.',
        ),
      );
    }

    final asks = b.asks.take(_depth).toList();
    final bids = b.bids.take(_depth).toList();

    // CUMULATIVE FROM THE BEST PRICE OUTWARDS, per side, and both bars scaled
    // to the deeper of the two totals — so the two blocks are comparable and a
    // thin side looks thin.
    final askCum = _cumulative(asks);
    final bidCum = _cumulative(bids);
    final scale = [
      if (askCum.isNotEmpty) askCum.last,
      if (bidCum.isNotEmpty) bidCum.last,
    ].fold<double>(0, (a, v) => v > a ? v : a);

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('Order book', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      ExCard(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
        child: Column(children: [
          // The columns are LABELLED WITH THEIR ASSETS. "Price" alone on a
          // PERBUG-BTC ladder is the field people misread.
          Row(children: [
            Expanded(flex: 4, child: _head('Price · ${m.quote}')),
            Expanded(flex: 4, child: _head('Amount · ${m.base}', right: true)),
            Expanded(flex: 3, child: _head('Total', right: true)),
          ]),
          const SizedBox(height: 4),
          for (var i = asks.length - 1; i >= 0; i--)
            _Level(
              m: m,
              l: asks[i],
              cumulative: askCum[i],
              scale: scale,
              isBid: false,
              onTap: () => onPickPrice(m, asks[i]),
            ),
          _Spread(b: b, m: m),
          for (var i = 0; i < bids.length; i++)
            _Level(
              m: m,
              l: bids[i],
              cumulative: bidCum[i],
              scale: scale,
              isBid: true,
              onTap: () => onPickPrice(m, bids[i]),
            ),
          const SizedBox(height: 6),
          const Text('Tap a level to use its price.',
              style: TextStyle(fontSize: 11, color: Bk.faint)),
        ]),
      ),
    ]);
  }

  static Widget _head(String t, {bool right = false}) => Text(
        t,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        textAlign: right ? TextAlign.right : TextAlign.left,
        style: const TextStyle(
            fontSize: 10.5, letterSpacing: 0.4, color: Bk.faint, fontWeight: FontWeight.w700),
      );

  /// Running totals, index-aligned with [levels].
  ///
  /// A `double` is honest HERE and nowhere else on this screen: this feeds a
  /// bar's width in logical pixels, which is a drawing instruction and not a
  /// claim about money. Every figure a user could act on goes through the
  /// integer path.
  static List<double> _cumulative(List<OrderLevel> levels) {
    final out = <double>[];
    var run = 0.0;
    for (final l in levels) {
      run += l.size.toDouble();
      out.add(run);
    }
    return out;
  }
}

class _Level extends StatelessWidget {
  const _Level({
    required this.m,
    required this.l,
    required this.cumulative,
    required this.scale,
    required this.isBid,
    required this.onTap,
  });
  final ExchangeMarket m;
  final OrderLevel l;
  final double cumulative;
  final double scale;
  final bool isBid;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tone = isBid ? Bk.good : Bk.bad;
    final factor = scale <= 0 ? 0.0 : (cumulative / scale).clamp(0.0, 1.0);
    return InkWell(
      onTap: onTap,
      child: Stack(children: [
        // THE DEPTH BAR. Grown from the right so the numbers stay legible over
        // their own side's wash and the two blocks read as one shape.
        Positioned.fill(
          child: Align(
            alignment: Alignment.centerRight,
            child: FractionallySizedBox(
              widthFactor: factor,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: tone.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(3),
                ),
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 2),
          child: Row(children: [
            Expanded(
              flex: 4,
              child: Text(
                // The venue's own decimal string for the level, which is
                // already at this market's price scale. Reformatting it through
                // a double is how `0.00000012` becomes `1.2e-7`.
                figStr(l.priceText, l.price),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: kMono.copyWith(fontSize: 11.5, color: tone),
              ),
            ),
            Expanded(
              flex: 4,
              child: Text(
                figStr(l.sizeText, l.size),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.right,
                style: kMono.copyWith(fontSize: 11.5),
              ),
            ),
            Expanded(
              flex: 3,
              child: Text(
                exFixed(cumulative, _cumDecimals(m)),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.right,
                style: kMono.copyWith(fontSize: 11, color: Bk.muted),
              ),
            ),
          ]),
        ),
      ]),
    );
  }

  /// A running total is a SUM OF SIZES, so it is shown at a human number of
  /// places rather than at an 18-decimal asset's full scale — which would not
  /// fit the column and which nobody trades on. It is a summary, and the exact
  /// figure per level is in the column beside it.
  static int _cumDecimals(ExchangeMarket m) => m.baseDecimals >= 8 ? 4 : 2;
}

class _Spread extends StatelessWidget {
  const _Spread({required this.b, required this.m});
  final OrderBook b;
  final ExchangeMarket m;

  @override
  Widget build(BuildContext context) {
    // IN INTEGERS, from the venue's own price strings. See [exBookMid]: the
    // double average is a float artefact on a 16-place market, and this row
    // prints its figure beside a quote ticker, where it reads as a price.
    final mid = exBookMid(m, b);
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
      decoration: BoxDecoration(
        color: Bk.surface2,
        borderRadius: BorderRadius.circular(6),
      ),
      // Flexible, and every figure ellipsizes: a 16-place mid plus "spread N%"
      // is wider than the ladder gets on a 390pt phone, and the spread row is
      // the one line in the book nobody should have to decode around an
      // overflow stripe.
      child: Row(children: [
        Flexible(
          child: Text(
            mid == null
                ? 'one-sided book — no mid'
                : 'mid ${exFormatPrice(m, mid)} ${m.quote}',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12),
          ),
        ),
        const Spacer(),
        if (_spread(b) != null)
          Text('spread ${_spread(b)}%',
              style: const TextStyle(fontSize: 11.5, color: Bk.muted)),
      ]),
    );
  }

  static String? _spread(OrderBook b) {
    if (b.bids.isEmpty || b.asks.isEmpty) return null;
    final bid = b.bids.first.price, ask = b.asks.first.price;
    final mid = (bid + ask) / 2;
    if (mid <= 0) return null;
    return ((ask - bid) / mid * 100).toStringAsFixed(2);
  }
}

class _Tape extends StatelessWidget {
  const _Tape({required this.c, required this.m});
  final ExchangeController c;
  final ExchangeMarket m;

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('Recent trades', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      ExCard(
        child: c.trades.isEmpty
            ? Text(c.marketError == null
                ? 'No trades yet on ${m.pair}.'
                : 'The trade history could not be read: ${c.marketError}')
            : Column(children: [
                Row(children: [
                  Expanded(flex: 5, child: _Book._head('Price · ${m.quote}')),
                  Expanded(
                      flex: 5,
                      child: _Book._head('Amount · ${m.base}', right: true)),
                ]),
                const SizedBox(height: 4),
                for (final t in c.trades.take(15))
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(children: [
                      Expanded(
                        flex: 5,
                        child: Text(
                          fig(t['price']),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: kMono.copyWith(
                            fontSize: 11.5,
                            color: (t['takerSide'] ?? '').toString() == 'buy'
                                ? Bk.good
                                : Bk.bad,
                          ),
                        ),
                      ),
                      Expanded(
                        flex: 5,
                        // `base`, the venue's key for a tape amount. The WEB
                        // reads `amount` here and renders nothing; that is not
                        // a bug to port.
                        child: Text(
                          fig(t['base']),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.right,
                          style: kMono.copyWith(fontSize: 11.5),
                        ),
                      ),
                    ]),
                  ),
              ]),
      ),
    ]);
  }
}

class _OrderTicket extends StatefulWidget {
  const _OrderTicket({
    required this.c,
    required this.m,
    required this.price,
    required this.amount,
    required this.side,
    required this.onSide,
  });
  final ExchangeController c;
  final ExchangeMarket m;
  final TextEditingController price;
  final TextEditingController amount;
  final String side;
  final ValueChanged<String> onSide;

  @override
  State<_OrderTicket> createState() => _OrderTicketState();
}

class _OrderTicketState extends State<_OrderTicket> {
  bool _busy = false;
  String? _error;
  String? _result;
  bool _resultOk = false;

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final m = widget.m;

    // FOUR SEPARATE REASONS THE TICKET CAN BE UNAVAILABLE, each said out loud,
    // because they need four different things from the user.
    if (!m.open) {
      // The sentence itself is already on screen in _MarketState; repeating it
      // here would be the same paragraph twice.
      return ExCard(
        tone: ExTone.bad,
        child: Text(
          'New orders on ${m.pair} are refused by the venue right now — the '
          'reason is above. Cancelling an order you already have still works.',
        ),
      );
    }
    if (!c.tradable) {
      return ExCard(
        tone: ExTone.warn,
        child: Text('Trading on ${m.pair} opens when the venue does. The '
            'venue reports it is not open for business yet, so an order placed '
            'now would be refused.'),
      );
    }
    if (!c.signedIn) {
      return const ExCard(
        child: Text(
          'Sign in to your Blockle account to place an order. The exchange '
          'uses your Blockle account — it has no separate login.',
        ),
      );
    }

    final buying = widget.side == 'buy';
    final fees = c.fees;
    final q = ExTicketQuote.of(
      market: m,
      buying: buying,
      priceText: widget.price.text,
      amountText: widget.amount.text,
      takerBps: fees?.takerBps,
    );

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('Place an order', style: TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      ExCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SegmentedButton<String>(
            segments: [
              ButtonSegment(value: 'buy', label: Text('Buy ${m.base}')),
              ButtonSegment(value: 'sell', label: Text('Sell ${m.base}')),
            ],
            selected: {widget.side},
            onSelectionChanged: (s) {
              setState(() {
                _error = null;
                _result = null;
              });
              widget.onSide(s.first);
            },
          ),
          const SizedBox(height: 6),
          const Text(
            'LIMIT ONLY — this venue has no market order, so an order sits on '
            'the book until it fills at your price or you cancel it.',
            style: TextStyle(fontSize: 11.5, color: Bk.muted, height: 1.35),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: widget.price,
            onChanged: (_) => setState(() {}),
            // Decimal TEXT, not a number field: a price is sent as a STRING and
            // must never pass through a double.
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
            decoration: InputDecoration(
              labelText: 'Limit price (${m.quote})',
              helperText: 'up to ${m.priceScale} decimal '
                  '${m.priceScale == 1 ? 'place' : 'places'} on this market',
              errorText: widget.price.text.trim().isEmpty ? null : q.priceError,
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: widget.amount,
            onChanged: (_) => setState(() {}),
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
            decoration: InputDecoration(
              labelText: 'Amount (${m.base})',
              errorText: widget.amount.text.trim().isEmpty ? null : q.amountError,
            ),
          ),
          const SizedBox(height: 12),
          _Minimums(m: m, q: q),
          const SizedBox(height: 10),
          _Economics(c: c, m: m, q: q),
          if (_error != null) ...[
            const SizedBox(height: 10),
            ExCard(
              tone: ExTone.bad,
              padding: const EdgeInsets.all(10),
              child: Text(_error!, style: const TextStyle(fontSize: 13)),
            ),
          ],
          if (_result != null) ...[
            const SizedBox(height: 10),
            ExCard(
              tone: _resultOk ? ExTone.good : ExTone.warn,
              padding: const EdgeInsets.all(10),
              child: Text(_result!, style: const TextStyle(fontSize: 13)),
            ),
          ],
          const SizedBox(height: 12),
          FilledButton(
            onPressed: _busy || !q.submittable ? null : () => _submit(q),
            child: Text(_busy
                ? 'Placing…'
                : '${buying ? 'Buy' : 'Sell'} ${m.base}'),
          ),
        ]),
      ),
    ]);
  }

  Future<void> _submit(ExTicketQuote q) async {
    final c = widget.c;
    final m = widget.m;
    setState(() {
      _busy = true;
      _error = null;
      _result = null;
    });
    // WHAT GOES ON THE WIRE IS WHAT WAS SHOWN. Both fields are re-rendered from
    // the parsed integers at the market's own scales, so a trailing dot, a
    // leading zero or an exponent in the text box cannot reach the venue, and
    // the price submitted is the price the ticket priced.
    final res = await c.placeOrder(
      market: m.id,
      side: widget.side,
      type: 'limit',
      size: exFormat(q.amount!, m.baseDecimals),
      price: exFormatPrice(m, q.price!),
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = res.ok ? null : res.summary;
      // THE VENUE'S OWN OUTCOME, not "order placed". "Filled 5 of 5" and
      // "resting on the book, 1 of 5 filled" are different things to hold.
      _result = res.ok ? res.summary : null;
      _resultOk = res.ok && res.complete;
    });
    if (res.ok) widget.amount.clear();
  }
}

/// BOTH FLOORS, ALWAYS BOTH.
///
/// The venue enforces a minimum SIZE (`minBase`) and a minimum ORDER VALUE
/// (`minNotional`) and they are independent: 1,000 RTM clears the size floor on
/// RTM-USDT and is still refused if it prices under 5 USDT. Showing one sends
/// someone to fix the wrong constraint — they raise the amount a little, get the
/// same refusal, and have no idea which number the venue is objecting to.
class _Minimums extends StatelessWidget {
  const _Minimums({required this.m, required this.q});
  final ExchangeMarket m;
  final ExTicketQuote q;

  @override
  Widget build(BuildContext context) {
    final minBase = m.minBase;
    final minNotional = m.minNotional;
    if ((minBase == null || minBase.isEmpty) &&
        (minNotional == null || minNotional.isEmpty)) {
      return const SizedBox.shrink();
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('BOTH MINIMUMS APPLY',
          style: TextStyle(
              fontSize: 10.5,
              letterSpacing: 0.5,
              fontWeight: FontWeight.w700,
              color: Bk.faint)),
      const SizedBox(height: 4),
      if (minBase != null && minBase.isNotEmpty)
        _row('Smallest size', '$minBase ${m.base}', q.belowMinBase),
      if (minNotional != null && minNotional.isNotEmpty)
        _row('Smallest order value', '$minNotional ${m.quote}',
            q.belowMinNotional),
    ]);
  }

  static Widget _row(String label, String value, bool failing) => Padding(
        padding: const EdgeInsets.only(bottom: 2),
        child: Row(children: [
          Icon(failing ? Icons.error_outline : Icons.check_circle_outline,
              size: 13, color: failing ? Bk.bad : Bk.faint),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              failing ? '$label $value — this order is under it' : '$label $value',
              style: TextStyle(
                  fontSize: 12,
                  height: 1.3,
                  color: failing ? Bk.bad : Bk.muted),
            ),
          ),
        ]),
      );
}

/// Available, order value, and the fee — in the assets they are actually in.
class _Economics extends StatelessWidget {
  const _Economics({required this.c, required this.m, required this.q});
  final ExchangeController c;
  final ExchangeMarket m;
  final ExTicketQuote q;

  @override
  Widget build(BuildContext context) {
    final fees = c.fees;
    final spending = q.spendAsset;
    final bal = _balance(spending);

    // AVAILABLE, NOT TOTAL — and an unknown balance is an em dash, never a
    // zero. "You have 0 USDT" because a request failed is a claim about
    // someone's money that we have not got evidence for.
    final availText = bal?.available ?? (c.accountError == null ? null : kEmDash);

    final short = _short(bal, q);

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _line('Available to spend',
          availText == null ? kEmDash : '$availText $spending',
          note: c.accountError != null
              ? 'your balance could not be read: ${c.accountError}'
              : (bal == null ? 'the venue reports no $spending balance' : null),
          tone: short ? ExTone.warn : ExTone.plain),
      _line('Order value', q.notionalText == null
          ? kEmDash
          : '${q.notionalText} ${m.quote}'),
      _line(
        'Estimated fee',
        q.feeText == null ? kEmDash : '${q.feeText} ${q.feeAsset}',
        note: fees == null
            ? 'the venue\'s fee schedule has not been read, so this is not an '
                'estimate yet'
            : 'taker ${fees.takerPct}, taken from the ${q.feeAsset} you '
                'receive'
                '${fees.makerBps == fees.takerBps ? ' — maker is the same rate '
                    'today, so resting on the book costs the same' : ''}',
      ),
      _line('You receive',
          q.receiveText == null ? kEmDash : '${q.receiveText} ${q.receiveAsset}',
          note: 'if it fills in full at this price'),
      if (short)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            'That is more ${q.spendAsset} than you have available here. The '
            'venue will refuse it — deposit first, or lower the order.',
            style: const TextStyle(fontSize: 12, color: Bk.warn, height: 1.35),
          ),
        ),
    ]);
  }

  ExchangeBalance? _balance(String asset) {
    for (final b in c.balances) {
      if (b.asset.toUpperCase() == asset.toUpperCase()) return b;
    }
    return null;
  }

  /// True only when BOTH figures are known and the order is bigger. An unknown
  /// balance must not render as "you cannot afford this".
  static bool _short(ExchangeBalance? bal, ExTicketQuote q) {
    final spend = q.spendUnits;
    if (bal == null || spend == null) return false;
    try {
      final have = exParse(bal.available,
          symbol: bal.asset, decimals: q.spendDecimals);
      return spend > have;
    } on ExAmountError catch (_) {
      return false;
    }
  }

  static Widget _line(String label, String value,
          {String? note, ExTone tone = ExTone.plain}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Text(label,
                  style: const TextStyle(fontSize: 12.5, color: Bk.muted)),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(value,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: kMono.copyWith(
                      fontSize: 12.5,
                      color: tone == ExTone.plain ? null : toneColor(tone))),
            ),
          ]),
          if (note != null)
            Text(note,
                style: const TextStyle(fontSize: 11, color: Bk.faint, height: 1.3)),
        ]),
      );
}

/// Your orders ON THIS MARKET — the subset the trade view can act on.
class _OrdersHere extends StatelessWidget {
  const _OrdersHere({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    if (!c.signedIn) return const SizedBox.shrink();
    final mine = c.orders.where((o) => o.market == c.selected && o.open).toList();
    if (mine.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Your orders here — ${mine.length} working',
          style: const TextStyle(fontWeight: FontWeight.w700)),
      const SizedBox(height: 8),
      for (final o in mine) ...[
        ExCard(
          padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                // The venue's own strings. `o.size` used to read 0 on every
                // order because the client read the wrong key; it reads `total`
                // now, and this prints what the venue sent rather than a
                // reformatted double.
                Text(
                  '${o.side.toUpperCase()} ${figStr(o.sizeText, o.size)} '
                  'at ${figStr(o.priceText, o.price)}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: kMono.copyWith(fontSize: 12.5),
                ),
                Text(
                  'filled ${figStr(o.filledText, o.filled)}'
                  '${o.status == null ? '' : '  ·  ${o.status}'}',
                  style: const TextStyle(fontSize: 11.5, color: Bk.muted),
                ),
              ]),
            ),
            IconButton(
              tooltip: 'Cancel',
              icon: const Icon(Icons.close, size: 18),
              onPressed: () async {
                final err = await c.cancelOrder(o.id);
                if (err != null && context.mounted) {
                  ScaffoldMessenger.of(context)
                      .showSnackBar(SnackBar(content: Text('Could not cancel: $err')));
                }
              },
            ),
          ]),
        ),
        const SizedBox(height: 6),
      ],
    ]);
  }
}
