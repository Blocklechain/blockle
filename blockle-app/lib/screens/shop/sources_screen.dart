// Where the shop's products come from, and what is switched off.
//
// This screen exists because the honest answer to "why is my shop empty" is
// a list of sources with their real status, not a spinner. Each row says
// whether it is on, and if not, exactly what to do about it.
//
// It also states the Amazon position plainly, because that is the question
// everyone asks: Amazon cannot be auto-populated, and no amount of
// configuration here changes that until the sales gate is cleared.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../shop/feeds/retail_feed.dart';
import '../../shop/ui.dart';
import '../../state/app_state.dart';
import '../../theme.dart';

class SourcesScreen extends StatefulWidget {
  const SourcesScreen({super.key});

  @override
  State<SourcesScreen> createState() => _SourcesScreenState();
}

class _SourcesScreenState extends State<SourcesScreen> {
  final _bestBuy = TextEditingController();
  final _bbAffiliate = TextEditingController();
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final f = context.read<FeedSettings>();
    await f.load();
    _bestBuy.text = f.keyFor('bestbuy') ?? '';
    _bbAffiliate.text = f.keys['bestbuy.affiliate'] ?? '';
    if (mounted) setState(() => _loaded = true);
  }

  @override
  void dispose() {
    _bestBuy.dispose();
    _bbAffiliate.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final feeds = context.watch<FeedSettings>();
    final on = feeds.keyFor('bestbuy') != null;

    return Scaffold(
      appBar: AppBar(title: const Text('Product sources')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            const ShopHeader('Where products come from',
                subtitle: 'Connect a retailer catalogue and the shop fills '
                    'with real products at live prices.'),

            ShopSection('Live catalogues'),
            ShopCard(
              highlight: !on,
              child:
                  Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  const Icon(Icons.storefront, size: 18, color: Bk.accent),
                  const SizedBox(width: 8),
                  Text('Best Buy',
                      style: Theme.of(context).textTheme.titleMedium),
                  const Spacer(),
                  ShopPill(on ? 'Connected' : 'Not connected',
                      tone: on ? PillTone.good : PillTone.warn),
                ]),
                const SizedBox(height: 6),
                Text(
                    'About a million products with live prices, sale prices '
                    'and stock. The key is free, read-only, and has no sales '
                    'requirement — this is the fastest way to a populated '
                    'shop.',
                    style: Theme.of(context)
                        .textTheme
                        .bodySmall
                        ?.copyWith(color: Bk.muted)),
                const SizedBox(height: 12),
                TextField(
                  controller: _bestBuy,
                  autocorrect: false,
                  obscureText: true,
                  decoration: const InputDecoration(
                    labelText: 'API key',
                    hintText: 'from developer.bestbuy.com',
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _bbAffiliate,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Affiliate link template (optional)',
                    hintText: 'https://goto.bestbuy.com/c/…?u={url}',
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                    feeds.templateFor('bestbuy') == null
                        ? 'Not set — these listings work, but earn nothing '
                            'yet. Paste your Impact tracking link with {url} '
                            'where the product address goes.'
                        : 'Set — listings now earn commission.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: feeds.templateFor('bestbuy') == null
                            ? Bk.warn
                            : Bk.good)),
                const SizedBox(height: 10),
                Row(children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => context
                          .read<AppState>()
                          .openBrowser('https://developer.bestbuy.com/'),
                      child: const Text('Get a key'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: FilledButton(
                      onPressed: () async {
                        await feeds.setKey('bestbuy', _bestBuy.text);
                        await feeds.setKey(
                            'bestbuy.affiliate', _bbAffiliate.text);
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                            content: Text(_bestBuy.text.trim().isEmpty
                                ? 'Best Buy disconnected.'
                                : 'Connected. Search the shop to see it.')));
                      },
                      child: const Text('Save'),
                    ),
                  ),
                ]),
              ]),
            ),

            const SizedBox(height: 22),
            ShopSection('Not available yet'),

            // STATED PLAINLY. This is the question everyone asks, and the
            // answer is a rule of Amazon's, not a setting we have hidden.
            const ShopCard(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Icon(Icons.inventory_2_outlined,
                          size: 18, color: Bk.faint),
                      SizedBox(width: 8),
                      Text('Amazon',
                          style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: Bk.text)),
                      Spacer(),
                      ShopPill('Links only', tone: PillTone.neutral),
                    ]),
                    SizedBox(height: 8),
                    Text(
                        'Amazon cannot be loaded automatically. Their old '
                        'product API is retired, and the Creators API that '
                        'replaced it is only issued after 10 qualifying '
                        'sales in a 30-day window. Until then Amazon items '
                        'are added as individual links and show their price '
                        'on Amazon — their terms do not allow us to display '
                        'it here.\n\n'
                        'Those links still earn commission, and they are how '
                        'the 10 sales get made.',
                        style: TextStyle(
                            fontSize: 12.5, color: Bk.muted, height: 1.45)),
                  ]),
            ),

            const SizedBox(height: 10),
            const ShopCard(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Icon(Icons.hub_outlined, size: 18, color: Bk.faint),
                      SizedBox(width: 8),
                      Text('Affiliate networks',
                          style: TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: Bk.text)),
                      Spacer(),
                      ShopPill('Needs an account', tone: PillTone.neutral),
                    ]),
                    SizedBox(height: 8),
                    Text(
                        'Impact, CJ, Awin and Rakuten publish product '
                        'datafeeds for thousands of brand-name retailers, '
                        'with real prices and commission. Signing up is free '
                        'and most advertisers approve automatically — this '
                        'is the route to Walmart, Target and similar.',
                        style: TextStyle(
                            fontSize: 12.5, color: Bk.muted, height: 1.45)),
                  ]),
            ),

            const SizedBox(height: 18),
            const ShopNote(
                'Blockle never invents a product or a price. A source that '
                'is off returns nothing and says so, rather than filling the '
                'shop with examples you cannot actually buy.',
                icon: Icons.verified_outlined),
          ],
        ),
      ),
    );
  }
}
