// screens/exchange/sections/markets_section.dart — the market list.
//
// NOTHING HERE KNOWS HOW MANY MARKETS THERE ARE. The venue went from 25 to 40
// between the design and this build, and the quote set went from two currencies
// to four (USDT 13, BLOCK 12, USDC 8, BTC 7) — all from one server-side list.
// So the count in the header is `rows.length`, and the quote filter chips are
// DERIVED AT RUNTIME from the distinct quotes in /public/markets: when the
// venue grows a quote currency the chip appears on its own, and when it closes
// one it disappears.
//
// THE SEARCH AND THE CHIPS ARE PINNED. At 25 markets a search box that scrolled
// away with the list was survivable; at 40 it is the control you reach for after
// you have already scrolled, which is exactly when a scrolling one is gone. The
// filters sit in a fixed header and only the rows scroll.
//
// THREE STATES, SAID OUT LOUD, because the venue now publishes them:
//
//   * OPEN — takes orders.
//   * OPEN, WITH A KNOWN GAP (`caveat`) — takes orders and settles them while
//     one leg of its plumbing is manual. Every BLOCK market carries one. It is
//     not a weaker form of closed and it is not a warning about the price; it
//     is the difference between this market and BTC-USDT, and hiding it would
//     present them as the same proposition.
//   * CLOSED (`closed`) — refuses NEW ORDERS, with the venue's own sentence
//     saying why. Six markets are closed right now. A closed market keeps its
//     book, its history and its cancels, so the row stays TAPPABLE: only
//     placing an order is refused, and the trade view says so there.
//
// The closed sentence is clamped to three lines in a row and shown in full on
// TRADE; the caveat sentence — which is the same long paragraph on all twelve
// BLOCK markets — is labelled here and shown in full on TRADE. Printing both
// paragraphs on every row would make a 40-row list unscannable, which is a
// different way of hiding them.
//
// NULL IS NOT ZERO. A market that has never traded shows an em dash for
// last/bid/ask, never 0 (/public/tickers returns null — publicapi.ts:1864-1865),
// and the header says so, because "no market yet" and "the market is at zero"
// are different claims and only one of them is true.
//
// NO 24h CHANGE OR VOLUME COLUMN. /public/tickers hardcodes both to null; a
// column with no data behind it is furniture.
//
// AND NO DOLLAR SIGN, ANYWHERE. A price is rendered strictly in its own quote
// unit — "0.0412 USDT" — with no conversion and no USD column, which is what
// lets the twelve BLOCK markets stay visible without pricing BLOCK in dollars.

import 'package:flutter/material.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../../../widgets/chain_icon.dart';
import '../coin_names.dart';
import '../exchange_ui.dart';

class MarketsSection extends StatefulWidget {
  const MarketsSection({super.key, required this.c, required this.onTrade});
  final ExchangeController c;

  /// Whole-row tap: select the market AND move to the trade section, which is
  /// the only reason anyone opens this list. A CLOSED market goes there too —
  /// its book and its history are intact and the refusal belongs on the ticket,
  /// not on the row.
  final void Function(String market) onTrade;

  @override
  State<MarketsSection> createState() => _MarketsSectionState();
}

class _MarketsSectionState extends State<MarketsSection> {
  final _q = TextEditingController();
  String? _quote; // null = every quote

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final all = c.visibleMarkets;

    // DERIVED, never a literal list. Sorted by how many markets each quote
    // carries, so the chip order follows the venue's own weight rather than the
    // alphabet, with the name as the tie-break so it cannot flap between
    // builds.
    final counts = <String, int>{};
    for (final m in all) {
      counts[m.quote] = (counts[m.quote] ?? 0) + 1;
    }
    final quotes = counts.keys.toList()
      ..sort((a, b) {
        final byCount = counts[b]!.compareTo(counts[a]!);
        return byCount != 0 ? byCount : a.compareTo(b);
      });

    // A chip for a quote that no longer exists must not silently filter the
    // whole list to nothing.
    final quote = (_quote != null && counts.containsKey(_quote)) ? _quote : null;

    final needle = _q.text.trim().toUpperCase();
    final rows = all.where((m) {
      if (quote != null && m.quote != quote) return false;
      if (needle.isEmpty) return true;
      // EITHER THE PAIR SYMBOL OR THE FULL COIN NAME. "MEWC" tells a first-time
      // visitor nothing and "Meowcoin" is what they would type.
      return m.id.toUpperCase().contains(needle) ||
          m.base.toUpperCase().contains(needle) ||
          m.quote.toUpperCase().contains(needle) ||
          coinName(m.base).toUpperCase().contains(needle);
    }).toList();

    final closed = all.where((m) => !m.open).length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // ---- the pinned header -------------------------------------------
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 16, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ExHeader(
                title: 'Markets',
                note: _note(all.length, closed),
              ),
              if (c.marketsError != null) ...[
                ExError(what: 'the market list', message: c.marketsError!),
                const SizedBox(height: 12),
              ],
              TextField(
                controller: _q,
                onChanged: (_) => setState(() {}),
                textCapitalization: TextCapitalization.characters,
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search, size: 20),
                  hintText: 'Pair or coin name',
                  isDense: true,
                  suffixIcon: _q.text.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.close, size: 18),
                          onPressed: () => setState(_q.clear),
                        ),
                ),
              ),
              if (quotes.length > 1) ...[
                const SizedBox(height: 10),
                SizedBox(
                  height: 36,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: [
                      _chip('All ${all.length}', quote == null,
                          () => setState(() => _quote = null)),
                      for (final q in quotes)
                        _chip('$q ${counts[q]}', quote == q,
                            () => setState(() => _quote = q)),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 10),
            ],
          ),
        ),
        const Divider(height: 1, thickness: 1, color: Bk.line),
        // ---- the rows ----------------------------------------------------
        Expanded(child: _rows(c, rows, all.isEmpty)),
      ],
    );
  }

  /// The one honest sentence about a list whose length the app does not know.
  static String _note(int listed, int closed) {
    if (listed == 0) return 'No market has answered yet.';
    final head = '$listed listed';
    final shut = closed == 0
        ? ''
        : closed == 1
            ? ', one closed to new orders'
            : ', $closed closed to new orders';
    return '$head$shut. A market that has never traded shows $kEmDash, '
        'not a zero — nothing is quoting there yet.';
  }

  Widget _rows(ExchangeController c, List<ExchangeMarket> rows, bool noneAtAll) {
    // A SPINNER ONLY WHILE A REQUEST IS ACTUALLY OUT, and never over a list we
    // already have: a poll tick must not blink the whole screen.
    if (noneAtAll && c.loadingMarkets) {
      return const Center(child: CircularProgressIndicator());
    }
    if (noneAtAll) {
      // Not an empty list — a statement. The error itself is printed above.
      return Padding(
        padding: const EdgeInsets.fromLTRB(14, 14, 16, 14),
        child: ExCard(
          tone: c.marketsError == null ? ExTone.plain : ExTone.bad,
          child: Text(c.marketsError == null
              ? 'The venue listed no markets. That is the venue\'s answer, not '
                  'a failed read.'
              : 'No market list to show — the read above is why.'),
        ),
      );
    }
    if (rows.isEmpty) {
      return const Padding(
        padding: EdgeInsets.fromLTRB(14, 14, 16, 14),
        child: ExCard(child: Text('No market matches that.')),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(14, 10, 16, 40),
      itemCount: rows.length,
      separatorBuilder: (_, __) => const SizedBox(height: 6),
      itemBuilder: (ctx, i) {
        final m = rows[i];
        return MarketRow(
          m: m,
          selected: m.id == c.selected,
          onTap: () => widget.onTrade(m.id),
        );
      },
    );
  }

  Widget _chip(String label, bool on, VoidCallback onTap) => Padding(
        padding: const EdgeInsets.only(right: 6),
        child: ChoiceChip(
          label: Text(label),
          selected: on,
          onSelected: (_) => onTap(),
        ),
      );
}

/// One market, with its state.
///
/// Public so a test can mount a single row and assert what it says about a
/// closed or caveated market without driving the whole tab to get there.
class MarketRow extends StatelessWidget {
  const MarketRow({
    super.key,
    required this.m,
    required this.selected,
    required this.onTap,
  });
  final ExchangeMarket m;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final spread = m.spreadPct;
    return Material(
      color: selected ? Bk.accentGhost : Bk.surface,
      borderRadius: BorderRadius.circular(Bk.rMd),
      child: InkWell(
        borderRadius: BorderRadius.circular(Bk.rMd),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                ChainIcon(m.base, symbol: m.base, radius: 14),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Flexible(
                          child: Text(m.pair,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  fontWeight: FontWeight.w700, fontSize: 14)),
                        ),
                        if (!m.open) ...[
                          const SizedBox(width: 6),
                          const ExPill('CLOSED', tone: ExTone.bad),
                        ] else if (m.caveat != null) ...[
                          const SizedBox(width: 6),
                          const ExPill('KNOWN GAP', tone: ExTone.warn),
                        ],
                      ]),
                      Text(coinName(m.base),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 11.5, color: Bk.faint)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                // THE PRICE, IN ITS OWN QUOTE UNIT AND NOTHING ELSE. No dollar
                // sign, no conversion, no second currency: `0.0412 USDT` is a
                // fact about this book.
                SizedBox(
                  width: 124,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        // The venue's own decimal string, not the parsed
                        // double: `0.00000012` must not render as `1.2e-7`.
                        figStr(m.lastText, m.last),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: kMono.copyWith(fontSize: 12.5),
                      ),
                      Text(
                        spread == null
                            ? m.quote
                            : '${m.quote} · ${spread.toStringAsFixed(2)}%',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11, color: Bk.muted),
                      ),
                    ],
                  ),
                ),
              ]),
              // The venue's reason, verbatim. Clamped rather than paraphrased —
              // a summary of a refusal is a new claim about someone's money.
              if (m.closed != null) ...[
                const SizedBox(height: 8),
                Text(
                  m.closed!,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11.5, color: Bk.muted, height: 1.35),
                ),
              ] else if (m.caveat != null) ...[
                const SizedBox(height: 6),
                const Text(
                  'Open, with a known gap — tap for the detail.',
                  style: TextStyle(fontSize: 11.5, color: Bk.warn),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
