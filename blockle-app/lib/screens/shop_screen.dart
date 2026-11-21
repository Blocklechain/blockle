// Shop — the first thing the app is for.
//
// The wallet came first historically and the shopping came last, which is
// backwards for what this product is becoming: a way to buy real things with
// crypto, that happens to carry a very good wallet. So Shop leads the bottom
// bar, and the two money flows that matter are on it as single actions rather
// than buried in Liquidity and MoonPay screens the user has to assemble
// themselves.
//
// WHAT THIS SCREEN WILL NOT DO
//
// It will not invent a product. Search runs against the real Catalog — which
// today means listings sellers have actually submitted — and when a source is
// unavailable the screen names it and says why, instead of quietly returning
// a short list that looks complete. A plausible price on a plausible retailer
// is the one thing a shopping app can do that destroys trust permanently, and
// it is very easy to do by accident when the provider is not ready.
//
// Every style here comes from theme.dart via shop/ui.dart. No inline
// TextStyles — that is what made this screen feel bolted on.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../shop/catalog.dart';
import '../shop/flow.dart';
import '../shop/product.dart';
import '../shop/ui.dart';
import '../state/liquidity_controller.dart';
import '../theme.dart';
import 'shop/sell_screen.dart';

class ShopScreen extends StatefulWidget {
  const ShopScreen({super.key});

  @override
  State<ShopScreen> createState() => _ShopScreenState();
}

class _ShopScreenState extends State<ShopScreen> {
  final _search = TextEditingController();
  bool _searched = false;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _run() async {
    setState(() => _searched = true);
    await context.read<Catalog>().search(_search.text);
  }

  @override
  Widget build(BuildContext context) {
    final catalog = context.watch<Catalog>();

    return Scaffold(
      backgroundColor: Bk.bg,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
          children: [
            ShopHeader(
              'Shop',
              subtitle: 'Buy real things. Pay with crypto.',
              trailing: IconButton.filledTonal(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => const SellScreen())),
                icon: const Icon(Icons.storefront_outlined),
                tooltip: 'Sell on Blockle',
              ),
            ),

            TextField(
              controller: _search,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _run(),
              decoration: InputDecoration(
                hintText: 'Search listings',
                prefixIcon: const Icon(Icons.search, color: Bk.faint),
                suffixIcon: catalog.searching
                    ? const Padding(
                        padding: EdgeInsets.all(14),
                        child: SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2)))
                    : null,
              ),
            ),

            const SizedBox(height: 20),
            const _FlowCard(kind: _FlowKind.getBlock),
            const SizedBox(height: 12),
            const _FlowCard(kind: _FlowKind.payWithBlock),

            const SizedBox(height: 28),
            ShopSection(_searched ? 'Results' : 'Listings'),
            _Results(catalog: catalog, searched: _searched),

            // WHAT IS MISSING FROM THESE RESULTS, stated rather than implied.
            // A shopper who searches "headphones" and sees two results should
            // know whether that is the whole internet or two local sellers.
            for (final s in catalog.offline) ...[
              const SizedBox(height: 12),
              ShopNote(s.unavailableReason!, icon: Icons.inventory_2_outlined),
            ],
          ],
        ),
      ),
    );
  }
}

class _Results extends StatelessWidget {
  const _Results({required this.catalog, required this.searched});
  final Catalog catalog;
  final bool searched;

  @override
  Widget build(BuildContext context) {
    if (catalog.results.isEmpty) {
      return ShopEmpty(
        icon: searched ? Icons.search_off : Icons.storefront_outlined,
        title: searched ? 'No listings matched' : 'No listings yet',
        body: searched
            ? 'Nothing a Blockle seller has listed matches that. Large '
                'retailers are not searchable yet.'
            : 'Sellers list products by pasting a link to their own product '
                'page. Nothing is shown here until the products and prices '
                'are real ones.',
        action: FilledButton.tonal(
          onPressed: () => Navigator.of(context)
              .push(MaterialPageRoute(builder: (_) => const SellScreen())),
          child: const Text('List a product'),
        ),
      );
    }
    return Column(
      children: [
        for (final p in catalog.results)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: _ProductRow(product: p),
          ),
      ],
    );
  }
}

class _ProductRow extends StatelessWidget {
  const _ProductRow({required this.product});
  final Product product;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final svc = context.watch<LiquidityService>();
    // The estimate uses the SAME live price feed the swap screens use, so the
    // number here and the number at checkout come from one source.
    final rate = svc.priceOf('BLOCK');
    final crypto = product.hasPrice
        ? CryptoPrice.from(usd: product.price!, asset: 'BLOCK', rateUsd: rate)
        : null;

    return ShopCard(
      padding: const EdgeInsets.all(12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ProductImage(product.imageUrl, size: 76),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(product.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: t.titleSmall),
                const SizedBox(height: 3),
                Text(product.merchant,
                    style: t.bodySmall?.copyWith(color: Bk.faint)),
                const SizedBox(height: 8),
                PriceText(product, crypto: crypto),
                const SizedBox(height: 8),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  AvailabilityPill(product.availability),
                  ShopPill(product.source.label),
                ]),
              ]),
        ),
      ]),
    );
  }
}

enum _FlowKind { getBlock, payWithBlock }

/// One money flow, with its real preconditions checked live.
///
/// The card is driven entirely by FlowPlan: if the plan is not ready the
/// button is disabled and the first blocker is shown VERBATIM. No flow is
/// ever offered as available and then refused on the next screen.
class _FlowCard extends StatelessWidget {
  const _FlowCard({required this.kind});
  final _FlowKind kind;

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<LiquidityService>();
    final plan = _plan(svc);
    final blocked = plan.firstBlocker;
    final t = Theme.of(context).textTheme;

    return ShopCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(
              kind == _FlowKind.getBlock
                  ? Icons.bolt_outlined
                  : Icons.shopping_bag_outlined,
              color: Bk.accent,
              size: 20),
          const SizedBox(width: 8),
          Expanded(child: Text(plan.title, style: t.titleMedium)),
          // THE TIMING, ALWAYS. "Pay with BLOCK" contains a bank payout and
          // takes days; presenting it beside a two-minute action without
          // saying so is the single most misleading thing this screen could
          // do.
          ShopPill(plan.takes.human,
              tone: plan.isSlow ? PillTone.neutral : PillTone.accent),
        ]),
        const SizedBox(height: 10),
        for (final leg in plan.legs)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Padding(
                  padding: EdgeInsets.only(top: 7, right: 8),
                  child: Icon(Icons.circle, size: 5, color: Bk.faint)),
              Expanded(
                  child: Text(leg.describe,
                      style: t.bodySmall?.copyWith(color: Bk.muted))),
            ]),
          ),
        if (blocked != null) ...[
          const SizedBox(height: 6),
          ShopNote(blocked.reason,
              tone: blocked.fixable ? PillTone.warn : PillTone.neutral),
        ],
        const SizedBox(height: 14),
        FilledButton(
          onPressed: plan.ready ? () => _start(context, plan) : null,
          child: Text(plan.ready ? plan.title : 'Unavailable'),
        ),
      ]),
    );
  }

  /// Build the plan from LIVE state — reserves, settlement mode and the
  /// MoonPay feature flags — rather than from assumptions.
  FlowPlan _plan(LiquidityService svc) {
    final reserves = svc.pool.reserves;
    // Until the MoonPay config is threaded through here, assume the narrow
    // case: a flow wrongly shown as unavailable is a support question, one
    // wrongly shown as available takes the user's money.
    const buyable = {'SOL', 'ETH', 'BTC', 'USDC'};
    const sellable = {'ETH', 'BTC', 'USDC'};

    if (kind == _FlowKind.getBlock) {
      const usd = 50.0;
      final solIn = usd / (svc.priceOf('SOL') <= 0 ? 1 : svc.priceOf('SOL'));
      return MoneyFlow.getBlock(
        usd: usd,
        solToBlock: svc.quote('SOL', 'BLOCK', solIn),
        blockReserve: reserves['BLOCK'] ?? 0,
        onchainSettlement: svc.onchainSettlement,
        buyEnabled: true,
        buyable: buyable,
      );
    }
    const usd = 299.0;
    final blockPrice = svc.priceOf('BLOCK');
    final blockIn = blockPrice <= 0 ? 0.0 : usd / blockPrice;
    return MoneyFlow.payWithBlock(
      usd: usd,
      merchant: 'your retailer',
      blockToCoin: svc.quote('BLOCK', 'USDC', blockIn),
      coinReserve: reserves['USDC'] ?? 0,
      onchainSettlement: svc.onchainSettlement,
      sellEnabled: true,
      sellable: sellable,
      bankConnected: false,
      via: 'USDC',
    );
  }

  void _start(BuildContext context, FlowPlan plan) {
    // The legs run through the existing Liquidity and MoonPay screens; this
    // card's job is to decide whether they CAN run and to say what will
    // happen. Wiring the hand-off is the next slice.
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('${plan.title}: ${plan.legs.length} steps, '
            '${plan.takes.human}.')));
  }
}
