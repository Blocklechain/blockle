// The business side: paste a link, correct what we read, publish.
//
// THE DESIGN PROBLEM. Seller onboarding fails at the form. A small business
// with forty products will not fill in twelve fields forty times, so the
// catalogue stays empty and the shopping app has nothing to sell. Pasting a
// link they already have is about as little work as can be asked of them.
//
// THE HONESTY PROBLEM, which pulls the other way. Everything the parser
// produces was inferred from someone's HTML, and a wrong price in a shop is
// worse than no listing. So the draft is ALWAYS shown for correction, never
// auto-published; every field says where it came from; and the fields the
// page did not state are listed explicitly as the seller's to fill in rather
// than being quietly left blank for them to discover later.
//
// This screen is for a seller listing their OWN products. It is not a way to
// add Amazon's catalogue to Blockle — see catalog.dart for why that needs an
// approved feed instead, and note the UI says so out loud rather than letting
// a seller paste a link they have no right to list.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../shop/catalog.dart';
import '../../shop/product.dart';
import '../../shop/ui.dart';
import '../../theme.dart';

class SellScreen extends StatefulWidget {
  const SellScreen({super.key});

  @override
  State<SellScreen> createState() => _SellScreenState();
}

class _SellScreenState extends State<SellScreen> {
  final _link = TextEditingController();

  @override
  void initState() {
    super.initState();
    context.read<MerchantStore>().load();
  }

  @override
  void dispose() {
    _link.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<MerchantStore>();
    final reading = store.state == DraftState.reading;

    return Scaffold(
      appBar: AppBar(title: const Text('Sell on Blockle')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            const ShopHeader('List a product',
                subtitle: 'Paste a link to one of your own product pages. '
                    'We fill in what the page states — you correct the rest.'),

            // --- the paste box ---
            TextField(
              controller: _link,
              enabled: !reading,
              keyboardType: TextInputType.url,
              autocorrect: false,
              textInputAction: TextInputAction.go,
              onSubmitted: (v) => store.readLink(v),
              decoration: InputDecoration(
                hintText: 'https://yourstore.com/products/…',
                prefixIcon: const Icon(Icons.link, color: Bk.faint),
                suffixIcon: _link.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.close, size: 18),
                        onPressed: () => setState(_link.clear),
                      ),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: reading || _link.text.trim().isEmpty
                  ? null
                  : () => store.readLink(_link.text),
              child: reading
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.white))
                  : const Text('Read my page'),
            ),

            const SizedBox(height: 12),
            // SAID BEFORE THEY WASTE THEIR TIME, not after a refusal. A seller
            // who pastes an Amazon link and gets a draft would reasonably
            // assume listing it was allowed.
            const ShopNote(
                'Only your own product pages. Listings for large retailers '
                'come from their official product feeds, not from links — '
                'pasting one here will not create a listing you can sell.',
                icon: Icons.gavel_outlined),

            if (store.error != null) ...[
              const SizedBox(height: 16),
              ShopNote(store.error!,
                  tone: PillTone.bad, icon: Icons.error_outline),
            ],

            if (store.draft != null) ...[
              const SizedBox(height: 24),
              _Draft(draft: store.draft!, readFrom: store.readFrom),
            ],

            if (store.listings.isNotEmpty) ...[
              const SizedBox(height: 28),
              ShopSection('Your listings (${store.listings.length})'),
              for (final p in store.listings)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _ListingRow(product: p),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The draft, with every gap named.
class _Draft extends StatelessWidget {
  const _Draft({required this.draft, this.readFrom});
  final Product draft;
  final String? readFrom;

  @override
  Widget build(BuildContext context) {
    final store = context.read<MerchantStore>();
    final t = Theme.of(context).textTheme;
    final missing = draft.missing;

    return ShopCard(
      highlight: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text('Draft listing', style: t.titleMedium),
          const Spacer(),
          if (readFrom != null)
            ShopPill('Read from $readFrom', tone: PillTone.accent),
        ]),
        const SizedBox(height: 14),

        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ProductImage(draft.imageUrl, size: 76),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(draft.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: t.titleSmall),
                  const SizedBox(height: 4),
                  Text(draft.merchant,
                      style: t.bodySmall?.copyWith(color: Bk.faint)),
                  const SizedBox(height: 8),
                  PriceText(draft),
                ]),
          ),
        ]),

        if (missing.isNotEmpty) ...[
          const SizedBox(height: 14),
          // NAMED, NOT HIDDEN. The seller finds out now, on one screen, rather
          // than after publishing something a shopper cannot buy.
          ShopNote(
              'Your page did not state the ${_list(missing)}. '
              '${missing.contains('price') ? 'A listing cannot go live '
                  'without a price. ' : ''}'
              'Add ${missing.length == 1 ? 'it' : 'them'} below.',
              tone: PillTone.warn,
              icon: Icons.edit_outlined),
        ],

        const SizedBox(height: 14),
        Row(children: [
          Expanded(
            child: OutlinedButton(
              onPressed: store.discard,
              child: const Text('Discard'),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: FilledButton(
              onPressed: () => _edit(context, draft),
              child: Text(missing.isEmpty ? 'Review' : 'Fill in details'),
            ),
          ),
        ]),
        if (draft.listable) ...[
          const SizedBox(height: 10),
          TextButton(
            onPressed: () {
              if (store.publish()) {
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Listing published.')));
              }
            },
            child: const Text('Publish listing'),
          ),
        ],
      ]),
    );
  }

  static String _list(List<String> xs) => xs.length == 1
      ? xs.single
      : '${xs.take(xs.length - 1).join(', ')} or ${xs.last}';

  void _edit(BuildContext context, Product p) => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (_) => Padding(
          padding: EdgeInsets.only(
              bottom: MediaQuery.of(context).viewInsets.bottom),
          child: _EditSheet(product: p, store: context.read<MerchantStore>()),
        ),
      );
}

/// The correction form. Pre-filled with what was read, so the seller is
/// editing rather than authoring.
class _EditSheet extends StatefulWidget {
  const _EditSheet({required this.product, required this.store});
  final Product product;
  final MerchantStore store;

  @override
  State<_EditSheet> createState() => _EditSheetState();
}

class _EditSheetState extends State<_EditSheet> {
  late final _title = TextEditingController(text: widget.product.title);
  late final _desc =
      TextEditingController(text: widget.product.description ?? '');
  late final _image =
      TextEditingController(text: widget.product.imageUrl ?? '');
  // Shown in MAJOR units because that is how a seller thinks about a price;
  // converted back to minor units on save, where the rest of the app keeps it.
  late final _price = TextEditingController(
      text: widget.product.price?.toStringAsFixed(2) ?? '');
  late String _currency = widget.product.currency ?? 'USD';
  late Availability _avail = widget.product.availability;

  String? _priceError;

  @override
  void dispose() {
    for (final c in [_title, _desc, _image, _price]) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 28),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Edit listing', style: t.titleLarge),
        const SizedBox(height: 4),
        Text(widget.product.url,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: t.bodySmall?.copyWith(color: Bk.faint)),
        const SizedBox(height: 20),

        _field('Title', _title),
        const SizedBox(height: 14),
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            flex: 2,
            child: _field('Price', _price,
                keyboard: const TextInputType.numberWithOptions(decimal: true),
                error: _priceError,
                formatters: [
                  // A price field that accepts letters produces a listing
                  // whose price silently fails to parse on save.
                  FilteringTextInputFormatter.allow(RegExp(r'[0-9.]')),
                ]),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Currency', style: t.labelMedium),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String>(
                    initialValue: _currency,
                    items: const ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY']
                        .map((c) =>
                            DropdownMenuItem(value: c, child: Text(c)))
                        .toList(),
                    onChanged: (v) => setState(() => _currency = v ?? 'USD'),
                  ),
                ]),
          ),
        ]),
        const SizedBox(height: 14),
        _field('Description', _desc, lines: 3),
        const SizedBox(height: 14),
        _field('Image URL', _image),
        const SizedBox(height: 16),

        Text('Availability', style: t.labelMedium),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: Availability.values
              .map((a) => ChoiceChip(
                    label: Text(switch (a) {
                      Availability.inStock => 'In stock',
                      Availability.outOfStock => 'Out of stock',
                      Availability.preorder => 'Pre-order',
                      Availability.unknown => 'Not stated',
                    }),
                    selected: _avail == a,
                    onSelected: (_) => setState(() => _avail = a),
                  ))
              .toList(),
        ),

        const SizedBox(height: 24),
        FilledButton(onPressed: _save, child: const Text('Save listing')),
      ]),
    );
  }

  Widget _field(String label, TextEditingController c,
      {int lines = 1,
      TextInputType? keyboard,
      String? error,
      List<TextInputFormatter>? formatters}) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: Theme.of(context).textTheme.labelMedium),
      const SizedBox(height: 6),
      TextField(
        controller: c,
        maxLines: lines,
        keyboardType: keyboard,
        inputFormatters: formatters,
        decoration: InputDecoration(errorText: error),
      ),
    ]);
  }

  void _save() {
    final raw = _price.text.trim();
    int? minor;
    if (raw.isNotEmpty) {
      final v = double.tryParse(raw);
      if (v == null || v < 0) {
        setState(() => _priceError = 'Enter a price like 24.99');
        return;
      }
      minor = (v * 100).round();
    }
    setState(() => _priceError = null);

    widget.store.edit(
      title: _title.text.trim(),
      priceMinor: minor,
      currency: minor == null ? null : _currency,
      description: _desc.text.trim().isEmpty ? null : _desc.text.trim(),
      imageUrl: _image.text.trim().isEmpty ? null : _image.text.trim(),
      availability: _avail,
    );
    Navigator.of(context).pop();
  }
}

class _ListingRow extends StatelessWidget {
  const _ListingRow({required this.product});
  final Product product;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return ShopCard(
      padding: const EdgeInsets.all(12),
      child: Row(children: [
        ProductImage(product.imageUrl, size: 52),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(product.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.titleSmall),
                const SizedBox(height: 4),
                PriceText(product),
              ]),
        ),
        IconButton(
          icon: const Icon(Icons.delete_outline, color: Bk.faint),
          onPressed: () => _confirmRemove(context),
        ),
      ]),
    );
  }

  void _confirmRemove(BuildContext context) {
    final store = context.read<MerchantStore>();
    showDialog<void>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Remove listing?'),
        content: Text('“${product.title}” will no longer appear in the shop. '
            'You can add it again by pasting the same link.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              store.remove(product.id);
              Navigator.pop(d);
            },
            child: const Text('Remove', style: TextStyle(color: Bk.bad)),
          ),
        ],
      ),
    );
  }
}
