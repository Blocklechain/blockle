// screens/exchange/sections/orders_section.dart — your orders, every market.
//
// The app only ever showed OPEN orders, and showed them with a size of zero:
// the client read `base` off GET /v1/orders where the venue returns `total`
// (publicapi.ts:779). That is fixed in the client, which is why this screen can
// show a size and a placed-at time at all.
//
// A later step widens this to the full history with its state filter; what is
// here is every order the venue currently reports for the account, newest
// first, with the cancel each open row needs.

import 'package:flutter/material.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../exchange_ui.dart';

class OrdersSection extends StatelessWidget {
  const OrdersSection({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    final rows = [...c.orders]..sort((a, b) {
      final x = _placedAt(a.createdAt), y = _placedAt(b.createdAt);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return y.compareTo(x); // newest first
    });
    final open = rows.where((o) => o.open).length;

    return ExBody(children: [
      ExHeader(
        title: 'Your orders',
        note: rows.isEmpty
            ? 'Nothing placed yet.'
            : '$open open of ${rows.length}.',
      ),
      if (c.accountError != null) ...[
        ExError(what: 'your orders', message: c.accountError!),
        const SizedBox(height: 12),
      ],
      if (c.accountError == null && rows.isEmpty)
        const ExCard(
          child: Text(
            'No orders. One you place on the trade screen appears here, on '
            'every market, until it fills or you cancel it.',
          ),
        ),
      for (final o in rows) ...[
        _OrderRow(c: c, o: o),
        const SizedBox(height: 6),
      ],
    ]);
  }

}

class _OrderRow extends StatelessWidget {
  const _OrderRow({required this.c, required this.o});
  final ExchangeController c;
  final OpenOrder o;

  @override
  Widget build(BuildContext context) {
    // `open` is the venue's own state, not a guess from the filled figure —
    // and it is the only state a Cancel button belongs on.
    final open = o.open;
    final s = (o.status ?? '').toLowerCase();
    final tone = open
        ? ExTone.warn
        : s == 'filled'
            ? ExTone.good
            : ExTone.plain;
    return ExCard(
      padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              // Flexible, with an ellipsis: a long pair plus a state pill is
              // wider than 269pt of card at this weight, and an overflow
              // paints a striped bar over an order the user is reading.
              Flexible(
                child: Text('${o.side.toUpperCase()} ${o.market}',
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontWeight: FontWeight.w700, fontSize: 13)),
              ),
              const SizedBox(width: 8),
              ExPill(o.status ?? (open ? 'open' : 'unknown'), tone: tone),
            ]),
            const SizedBox(height: 3),
            // The decimal strings the venue sent, not a round-tripped double.
            Text('${o.sizeText ?? o.size} at ${o.priceText ?? o.price}'
                '  ·  filled ${fig(o.filledText ?? o.filled)}', style: kMono),
            if (_placedAt(o.createdAt) != null)
              Text(_when(_placedAt(o.createdAt)!),
                  style: const TextStyle(fontSize: 11, color: Bk.faint)),
          ]),
        ),
        if (open)
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
    );
  }

  /// Local time, the way the tape renders it. A UTC timestamp on a phone is a
  /// small puzzle nobody asked to solve.
  static String _when(DateTime t) {
    final l = t.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return 'placed ${l.year}-${two(l.month)}-${two(l.day)} '
        '${two(l.hour)}:${two(l.minute)}';
  }
}

/// The venue's createdAt, whichever shape it arrives in: an ISO string or
/// epoch milliseconds. An unparseable value yields null and the row simply
/// omits the timestamp — a wrong date on an order is worse than no date.
DateTime? _placedAt(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  final iso = DateTime.tryParse(raw);
  if (iso != null) return iso;
  final ms = int.tryParse(raw);
  if (ms == null) return null;
  return DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
}
