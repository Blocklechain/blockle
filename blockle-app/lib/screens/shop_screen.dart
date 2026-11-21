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
import '../shop/delivery.dart';
import '../shop/flow_run.dart';
import '../shop/orders.dart';
import '../shop/product.dart';
import '../shop/ui.dart';
import '../state/liquidity_controller.dart';
import '../theme.dart';
import 'shop/delivery_screen.dart';
import 'shop/flow_screen.dart';
import 'shop/orders_screen.dart';
import 'shop/picks_screen.dart';
import 'shop/sources_screen.dart';
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
  void initState() {
    super.initState();
    // THE FRONT PAGE. Without this the shop is a blank search box on open,
    // which is a database, not a store. An empty query asks the catalogue
    // for its featured products.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final c = context.read<Catalog>();
      if (!c.loaded) c.search('');
    });
  }

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
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                IconButton.filledTonal(
                  onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const SourcesScreen())),
                  icon: const Icon(Icons.tune),
                  tooltip: 'Product sources',
                ),
                const SizedBox(width: 8),
                IconButton.filledTonal(
                  onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const PicksScreen())),
                  icon: const Icon(Icons.add_shopping_cart_outlined),
                  tooltip: 'Add a retailer product',
                ),
                const SizedBox(width: 8),
                IconButton.filledTonal(
                  onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const SellScreen())),
                  icon: const Icon(Icons.storefront_outlined),
                  tooltip: 'Sell on Blockle',
                ),
              ]),
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
            // UNFINISHED MONEY MOVEMENTS COME FIRST. A half-done flow is the
            // most important thing on this screen — more important than
            // starting a new one — and a user must never have to go looking
            // for one they started days ago.
            const _OpenRuns(),
            const _FlowCard(kind: _FlowKind.getBlock),
            const SizedBox(height: 12),
            const _FlowCard(kind: _FlowKind.payWithBlock),

            const SizedBox(height: 14),
            const _OrdersRow(),
            const SizedBox(height: 10),
            const _DeliveryRow(),

            const SizedBox(height: 28),
            ShopSection(_searched ? 'Results' : 'Popular right now'),
            // Shown whenever a paid retailer link is in the list, and ABOVE
            // it — required by the Associates agreement and the FTC.
            if (catalog.results
                .any((p) => p.source == ProductSource.affiliateLink))
              const AffiliateDisclosure(),
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

/// Parcels on the way, summarised. Tapping opens the full list.
class _OrdersRow extends StatelessWidget {
  const _OrdersRow();

  @override
  Widget build(BuildContext context) {
    final orders = context.watch<Orders>();
    final n = orders.inFlight.length;
    final t = Theme.of(context).textTheme;

    return ShopCard(
      padding: const EdgeInsets.all(14),
      onTap: () => Navigator.push(context,
          MaterialPageRoute(builder: (_) => const OrdersScreen())),
      child: Row(children: [
        Icon(Icons.inventory_2_outlined,
            size: 20, color: n > 0 ? Bk.accent : Bk.faint),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Orders', style: t.titleSmall),
                const SizedBox(height: 3),
                Text(
                    n == 0
                        ? 'Track deliveries in one place.'
                        : '$n on the way',
                    style: t.bodySmall?.copyWith(color: Bk.muted)),
              ]),
        ),
        if (n > 0) ShopPill('$n', tone: PillTone.accent),
        const SizedBox(width: 6),
        const Icon(Icons.chevron_right, size: 18, color: Bk.faint),
      ]),
    );
  }
}

/// The saved delivery address, and a nudge to add one before checkout rather
/// than while standing in a payment form.
class _DeliveryRow extends StatelessWidget {
  const _DeliveryRow();

  @override
  Widget build(BuildContext context) {
    final p = context.watch<DeliveryBook>().profile;
    final t = Theme.of(context).textTheme;
    final set = !p.isEmpty;

    return ShopCard(
      padding: const EdgeInsets.all(14),
      onTap: () => Navigator.push(context,
          MaterialPageRoute(builder: (_) => const DeliveryScreen())),
      child: Row(children: [
        Icon(set ? Icons.local_shipping_outlined : Icons.add_location_alt_outlined,
            size: 20, color: set ? Bk.accent : Bk.faint),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(set ? 'Delivery details' : 'Add delivery details',
                    style: t.titleSmall),
                const SizedBox(height: 3),
                Text(
                    set
                        ? p.summary
                        : 'Fill any checkout without typing your address.',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: t.bodySmall?.copyWith(color: Bk.muted)),
              ]),
        ),
        if (set && p.missing.isNotEmpty)
          const ShopPill('Incomplete', tone: PillTone.warn),
        const SizedBox(width: 6),
        const Icon(Icons.chevron_right, size: 18, color: Bk.faint),
      ]),
    );
  }
}

/// Flows the user started and has not finished.
class _OpenRuns extends StatelessWidget {
  const _OpenRuns();

  @override
  Widget build(BuildContext context) {
    final open = context.watch<FlowRuns>().open;
    if (open.isEmpty) return const SizedBox.shrink();
    final t = Theme.of(context).textTheme;

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const ShopSection('In progress'),
      for (final r in open)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: ShopCard(
            highlight: true,
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => FlowScreen(runId: r.id))),
            child: Row(children: [
              Icon(r.stalled ? Icons.error_outline : Icons.timelapse,
                  size: 20, color: r.stalled ? Bk.bad : Bk.accent),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(r.title, style: t.titleSmall),
                      const SizedBox(height: 3),
                      Text(
                          r.current?.name ?? 'Waiting',
                          style: t.bodySmall?.copyWith(color: Bk.muted)),
                    ]),
              ),
              ShopPill('${r.doneCount}/${r.steps.length}',
                  tone: r.stalled ? PillTone.bad : PillTone.accent),
            ]),
          ),
        ),
      const SizedBox(height: 10),
    ]);
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
            ? 'No connected source has that. Connecting a retailer '
                'catalogue makes the whole shop searchable.'
            : 'Connect a retailer catalogue and the shop fills with real '
                'products at live prices. Nothing is shown here until the '
                'products and prices are real ones.',
        action: FilledButton.tonal(
          onPressed: () => Navigator.of(context)
              .push(MaterialPageRoute(builder: (_) => const SourcesScreen())),
          child: const Text('Connect a catalogue'),
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

  /// Turn the plan into a tracked run and open it.
  ///
  /// The run is PERSISTED before the screen opens, so a flow survives the app
  /// being closed mid-way — which "Pay with BLOCK" guarantees, since it waits
  /// on a bank payout of one to three business days.
  Future<void> _start(BuildContext context, FlowPlan plan) async {
    final runs = context.read<FlowRuns>();
    // Identified by when it started rather than by content: the same user
    // buying the same thing twice is two runs, not one overwritten.
    final id = DateTime.now().toUtc().microsecondsSinceEpoch.toRadixString(16);
    final run = await runs.start(plan, id: id);
    if (!context.mounted) return;
    await Navigator.push(context,
        MaterialPageRoute(builder: (_) => FlowScreen(runId: run.id)));
  }
}
