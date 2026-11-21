// Where the parcels are.
//
// Blockle is not in the delivery path — it did not take the payment and has
// no carrier account — so this screen is honest about what it knows. It keeps
// the orders in one place, recognises a tracking number's carrier from its
// format, and links straight to that carrier's own page, which is
// authoritative and always current.
//
// IT SHOWS NO LIVE STATUS, and says so, because showing a plausible "In
// transit" that was never fetched is the delivery equivalent of inventing a
// price. The status chips here are the user's own notes and are labelled as
// such.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../shop/orders.dart';
import '../../shop/ui.dart';
import '../../state/app_state.dart';
import '../../theme.dart';

class OrdersScreen extends StatefulWidget {
  const OrdersScreen({super.key});

  @override
  State<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends State<OrdersScreen> {
  @override
  void initState() {
    super.initState();
    context.read<Orders>().load();
  }

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<Orders>();
    final list = orders.recent;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Orders'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            tooltip: 'Add an order',
            onPressed: () => _edit(context, null),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            if (list.isEmpty)
              ShopEmpty(
                icon: Icons.local_shipping_outlined,
                title: 'No orders yet',
                body: 'Add an order to keep its tracking in one place. '
                    'Blockle recognises the carrier from the tracking number '
                    'and links you straight to their page.',
                action: FilledButton.tonal(
                  onPressed: () => _edit(context, null),
                  child: const Text('Add an order'),
                ),
              )
            else ...[
              for (final o in list)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _OrderCard(order: o, onEdit: () => _edit(context, o)),
                ),
              const SizedBox(height: 10),
              // SAID ONCE, PLAINLY. Otherwise the chips above read as a
              // tracked status that nobody fetched.
              const ShopNote(
                  'Blockle does not track parcels itself — it links to the '
                  'carrier, who always has the current status. The labels '
                  'here are your own notes.',
                  icon: Icons.info_outline),
            ],
          ],
        ),
      ),
    );
  }

  void _edit(BuildContext context, Order? existing) =>
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (_) => Padding(
          padding:
              EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
          child: _OrderSheet(
              existing: existing, orders: context.read<Orders>()),
        ),
      );
}

class _OrderCard extends StatelessWidget {
  const _OrderCard({required this.order, required this.onEdit});
  final Order order;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final url = order.trackUrl;

    return ShopCard(
      onTap: onEdit,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
              child: Text(order.title ?? order.merchant, style: t.titleSmall)),
          ShopPill(order.state.label, tone: switch (order.state) {
            OrderState.delivered => PillTone.good,
            OrderState.cancelled => PillTone.bad,
            OrderState.shipped => PillTone.accent,
            OrderState.placed => PillTone.neutral,
          }),
        ]),
        const SizedBox(height: 4),
        Text(
            [
              order.merchant,
              if (order.orderRef != null) 'Order ${order.orderRef}',
              if (order.total != null)
                '${order.currency ?? ''} ${order.total!.toStringAsFixed(2)}'
                    .trim(),
            ].join(' · '),
            style: t.bodySmall?.copyWith(color: Bk.muted)),

        if (order.hasTracking) ...[
          const SizedBox(height: 12),
          Row(children: [
            const Icon(Icons.qr_code_2, size: 15, color: Bk.faint),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                  '${order.carrier?.name ?? 'Carrier not set'} · '
                  '${order.trackingNumber}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.bodySmall?.copyWith(color: Bk.muted)),
            ),
          ]),
          const SizedBox(height: 10),
          if (url != null)
            SizedBox(
              width: double.infinity,
              child: FilledButton.tonal(
                onPressed: () => context.read<AppState>().openBrowser(url),
                child: Text('Track with ${order.carrier!.name}'),
              ),
            )
          else
            // No carrier, so no link. Saying which piece is missing beats a
            // dead button or a search URL that finds nothing.
            const ShopNote(
                'Pick the carrier for this tracking number and Blockle can '
                'link you to it.',
                tone: PillTone.warn),
        ],
      ]),
    );
  }
}

class _OrderSheet extends StatefulWidget {
  const _OrderSheet({required this.existing, required this.orders});
  final Order? existing;
  final Orders orders;

  @override
  State<_OrderSheet> createState() => _OrderSheetState();
}

class _OrderSheetState extends State<_OrderSheet> {
  late final _merchant =
      TextEditingController(text: widget.existing?.merchant ?? '');
  late final _title = TextEditingController(text: widget.existing?.title ?? '');
  late final _ref =
      TextEditingController(text: widget.existing?.orderRef ?? '');
  late final _total = TextEditingController(
      text: widget.existing?.total?.toStringAsFixed(2) ?? '');
  late final _tracking =
      TextEditingController(text: widget.existing?.trackingNumber ?? '');

  late OrderState _state = widget.existing?.state ?? OrderState.placed;
  late String? _carrierId = widget.existing?.carrierId;

  /// Carriers whose format matches what has been typed so far.
  List<Carrier> _candidates = const [];

  @override
  void initState() {
    super.initState();
    _recheck();
    _tracking.addListener(_recheck);
  }

  /// Re-detect on every keystroke, and AUTO-SELECT ONLY WHEN UNAMBIGUOUS.
  /// With two or more candidates the user picks — guessing would link them to
  /// a carrier that has never seen the parcel.
  void _recheck() {
    final c = Carrier.detect(_tracking.text);
    setState(() {
      _candidates = c;
      if (c.length == 1) {
        _carrierId = c.single.id;
      } else if (c.isEmpty) {
        _carrierId = null;
      } else if (_carrierId != null && !c.any((x) => x.id == _carrierId)) {
        _carrierId = null;
      }
    });
  }

  @override
  void dispose() {
    for (final c in [_merchant, _title, _ref, _total, _tracking]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final typed = _tracking.text.trim().isNotEmpty;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(widget.existing == null ? 'Add an order' : 'Edit order',
            style: t.titleLarge),
        const SizedBox(height: 18),

        _f('Store', _merchant),
        _f('What you bought (optional)', _title),
        _f('Order number (optional)', _ref),
        _f('Total (optional)', _total,
            keyboard: const TextInputType.numberWithOptions(decimal: true)),
        _f('Tracking number (optional)', _tracking),

        if (typed && _candidates.isEmpty)
          const ShopNote(
              'That is not a tracking number format Blockle recognises. You '
              'can still save it — there just will not be a tracking link.',
              tone: PillTone.warn),
        if (_candidates.length == 1)
          ShopNote('Recognised as ${_candidates.single.name}.',
              tone: PillTone.good, icon: Icons.check_circle_outline),
        if (_candidates.length > 1) ...[
          // THE AMBIGUOUS CASE, asked rather than guessed.
          const ShopNote(
              'More than one carrier uses this number format. Which one '
              'shipped it?',
              tone: PillTone.warn),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: _candidates
                .map((c) => ChoiceChip(
                      label: Text(c.name),
                      selected: _carrierId == c.id,
                      onSelected: (_) => setState(() => _carrierId = c.id),
                    ))
                .toList(),
          ),
        ],

        const SizedBox(height: 16),
        Text('Status', style: t.labelMedium),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: OrderState.values
              .map((s) => ChoiceChip(
                    label: Text(s.label),
                    selected: _state == s,
                    onSelected: (_) => setState(() => _state = s),
                  ))
              .toList(),
        ),

        const SizedBox(height: 24),
        FilledButton(onPressed: _save, child: const Text('Save order')),
        if (widget.existing != null) ...[
          const SizedBox(height: 8),
          TextButton(
            onPressed: () async {
              await widget.orders.remove(widget.existing!.id);
              if (context.mounted) Navigator.pop(context);
            },
            child: const Text('Remove', style: TextStyle(color: Bk.bad)),
          ),
        ],
      ]),
    );
  }

  Widget _f(String label, TextEditingController c, {TextInputType? keyboard}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 6),
          TextField(controller: c, keyboardType: keyboard),
        ]),
      );

  Future<void> _save() async {
    final merchant = _merchant.text.trim();
    if (merchant.isEmpty) return;
    final totalText = _total.text.trim();
    final total = totalText.isEmpty ? null : double.tryParse(totalText);

    final o = Order(
      id: widget.existing?.id ??
          DateTime.now().toUtc().microsecondsSinceEpoch.toRadixString(16),
      merchant: merchant,
      placedAt: widget.existing?.placedAt ?? DateTime.now().toUtc(),
      title: _title.text.trim().isEmpty ? null : _title.text.trim(),
      totalMinor: total == null ? null : (total * 100).round(),
      currency: total == null ? null : (widget.existing?.currency ?? 'USD'),
      orderRef: _ref.text.trim().isEmpty ? null : _ref.text.trim(),
      trackingNumber:
          _tracking.text.trim().isEmpty ? null : _tracking.text.trim(),
      carrierId: _carrierId,
      state: _state,
      url: widget.existing?.url,
      flowRunId: widget.existing?.flowRunId,
    );
    await widget.orders.add(o);
    if (mounted) Navigator.pop(context);
  }
}
