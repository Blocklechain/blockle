// Curating retailer products — the Amazon path that works today.
//
// Paste a product link, type what it is, save. The shopper taps through and
// buys on Amazon; Blockle earns the commission.
//
// WHY THE CURATOR TYPES THE TITLE instead of Blockle reading it off the page:
// the Associates agreement prohibits scraping, and permits displaying a price
// only when Amazon serves the link showing it or it came from the Creators
// API. Reading the page would breach the first rule and tempt us into
// breaching the second. So the one thing we take from Amazon is the ASIN out
// of the URL the curator already had.
//
// AND WHY THERE IS NO PRICE FIELD: same clause. The card says "See price on
// Amazon", which is also the honest thing for the shopper, since Amazon
// prices move hourly and a cached one would be wrong by the time they tapped.
//
// The Creators API would let us show prices, but it requires 10 qualifying
// sales in a rolling 30 days — which this screen is how you get.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../shop/affiliate.dart';
import '../../shop/product.dart';
import '../../shop/ui.dart';
import '../../state/app_state.dart';
import '../../theme.dart';

class PicksScreen extends StatefulWidget {
  const PicksScreen({super.key});

  @override
  State<PicksScreen> createState() => _PicksScreenState();
}

class _PicksScreenState extends State<PicksScreen> {
  final _link = TextEditingController();
  final _title = TextEditingController();

  AffiliateRef? _ref;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    context.read<AffiliateStore>().load();
    _link.addListener(_peek);
  }

  @override
  void dispose() {
    _link.dispose();
    _title.dispose();
    super.dispose();
  }

  /// Parse as they type, but only the pure path — a short link is not
  /// followed until they commit, so typing does not fire requests.
  void _peek() {
    final r = Affiliate.parse(_link.text);
    if (r?.asin != _ref?.asin || r?.marketplace.host != _ref?.marketplace.host) {
      setState(() {
        _ref = r;
        if (r != null) _error = null;
      });
    }
  }

  Future<void> _check() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final res = await context.read<AffiliateStore>().resolve(_link.text);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _ref = res.ref;
      _error = res.error;
    });
  }

  Future<void> _save() async {
    final ref = _ref;
    if (ref == null || _title.text.trim().isEmpty) return;
    final store = context.read<AffiliateStore>();
    await store.add(ref: ref, title: _title.text.trim());
    if (!mounted) return;
    _link.clear();
    _title.clear();
    setState(() => _ref = null);
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Added to the shop.')));
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AffiliateStore>();
    final canSave = _ref != null && _title.text.trim().isNotEmpty;

    return Scaffold(
      appBar: const _PicksBar(),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            const ShopHeader('Add a retailer product',
                subtitle: 'Paste an Amazon product link. Shoppers buy on '
                    'Amazon; Blockle earns the commission.'),

            TextField(
              controller: _link,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                hintText: 'https://www.amazon.com/dp/…',
                prefixIcon: Icon(Icons.link, color: Bk.faint),
              ),
            ),
            const SizedBox(height: 10),

            if (_ref == null)
              FilledButton.tonal(
                onPressed: _busy || _link.text.trim().isEmpty ? null : _check,
                child: _busy
                    ? const SizedBox(
                        height: 18,
                        width: 18,
                        child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Check link'),
              ),

            if (_error != null) ...[
              const SizedBox(height: 10),
              ShopNote(_error!, tone: PillTone.bad, icon: Icons.error_outline),
            ],

            if (_ref != null) ...[
              const SizedBox(height: 6),
              ShopNote(
                  '${_ref!.marketplace.label} · ${_ref!.asin}'
                  '${store.settings.tagFor(_ref!.marketplace) == null
                      ? ' · no associate tag for this marketplace, so this '
                          'link will earn nothing'
                      : ''}',
                  tone: store.settings.tagFor(_ref!.marketplace) == null
                      ? PillTone.warn
                      : PillTone.good,
                  icon: Icons.check_circle_outline),
              const SizedBox(height: 14),
              TextField(
                controller: _title,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  labelText: 'What is it?',
                  hintText: 'Echo Dot (5th Gen) smart speaker',
                ),
              ),
              const SizedBox(height: 10),
              // Said at the point of confusion — a curator looking for the
              // price field needs to know it is absent on purpose.
              const ShopNote(
                  'There is no price field. Amazon only permits showing '
                  'their prices through their own API, which needs 10 sales '
                  'in 30 days first. Shoppers see the live price when they '
                  'tap through, which is the accurate one anyway.',
                  icon: Icons.info_outline),
              const SizedBox(height: 14),
              FilledButton(
                onPressed: canSave ? _save : null,
                child: const Text('Add to shop'),
              ),
            ],

            if (store.untagged.isNotEmpty) ...[
              const SizedBox(height: 18),
              ShopNote(
                  '${store.untagged.length} listing'
                  '${store.untagged.length == 1 ? '' : 's'} have no associate '
                  'tag and earn nothing. Set the tag for that marketplace, '
                  'then re-stamp them.',
                  tone: PillTone.warn,
                  icon: Icons.warning_amber_outlined),
              const SizedBox(height: 8),
              FilledButton.tonal(
                onPressed: () async {
                  final n = await store.retagAll();
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                      content: Text(n == 0
                          ? 'Nothing to re-stamp — set a tag for that '
                              'marketplace first.'
                          : 'Re-stamped $n listing${n == 1 ? '' : 's'}.')));
                },
                child: const Text('Re-stamp with current tags'),
              ),
            ],

            if (store.listings.isNotEmpty) ...[
              const SizedBox(height: 26),
              ShopSection('Your picks (${store.listings.length})'),
              for (final p in store.listings)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _PickRow(product: p),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PicksBar extends StatelessWidget implements PreferredSizeWidget {
  const _PicksBar();
  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);
  @override
  Widget build(BuildContext context) => AppBar(
        title: const Text('Retailer picks'),
        actions: [
          IconButton(
            icon: const Icon(Icons.sell_outlined),
            tooltip: 'Associate tags',
            onPressed: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const TagsScreen())),
          ),
        ],
      );
}

class _PickRow extends StatelessWidget {
  const _PickRow({required this.product});
  final Product product;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final earns = product.url.contains('tag=');

    return ShopCard(
      padding: const EdgeInsets.all(12),
      child: Row(children: [
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(product.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: t.titleSmall),
                const SizedBox(height: 4),
                Row(children: [
                  Text(product.merchant,
                      style: t.bodySmall?.copyWith(color: Bk.faint)),
                  const SizedBox(width: 8),
                  if (!earns)
                    const ShopPill('Earns nothing', tone: PillTone.warn),
                ]),
                const SizedBox(height: 6),
                PriceText(product),
              ]),
        ),
        IconButton(
          icon: const Icon(Icons.open_in_new, size: 18, color: Bk.faint),
          onPressed: () => context.read<AppState>().openBrowser(product.url),
        ),
        IconButton(
          icon: const Icon(Icons.delete_outline, size: 18, color: Bk.faint),
          onPressed: () =>
              context.read<AffiliateStore>().remove(product.id),
        ),
      ]),
    );
  }
}

/// Associate tags, one per marketplace.
class TagsScreen extends StatelessWidget {
  const TagsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final store = context.watch<AffiliateStore>();
    return Scaffold(
      appBar: AppBar(title: const Text('Associate tags')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            const ShopHeader('Where the commission goes',
                subtitle: 'One tag per Amazon marketplace. A .com tag earns '
                    'nothing on .co.uk, and sales on one do not count '
                    'towards the other.'),
            for (final m in Marketplace.all)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: _TagRow(marketplace: m, store: store),
              ),
          ],
        ),
      ),
    );
  }
}

class _TagRow extends StatefulWidget {
  const _TagRow({required this.marketplace, required this.store});
  final Marketplace marketplace;
  final AffiliateStore store;

  @override
  State<_TagRow> createState() => _TagRowState();
}

class _TagRowState extends State<_TagRow> {
  late final _c = TextEditingController(
      text: widget.store.settings.tagFor(widget.marketplace) ?? '');

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ShopCard(
      padding: const EdgeInsets.all(12),
      child: Row(children: [
        SizedBox(
          width: 130,
          child: Text(widget.marketplace.label,
              style: Theme.of(context).textTheme.titleSmall),
        ),
        Expanded(
          child: TextField(
            controller: _c,
            autocorrect: false,
            decoration: const InputDecoration(
              hintText: 'tag-20',
              isDense: true,
              contentPadding:
                  EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            ),
            onSubmitted: (v) =>
                widget.store.settings.setTag(widget.marketplace, v),
          ),
        ),
      ]),
    );
  }
}
