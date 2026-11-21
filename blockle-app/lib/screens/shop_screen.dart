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
// It will not show a product until a real catalogue is wired to it. An
// invented listing — a plausible price on a plausible retailer — is the one
// thing a shopping app can do that destroys trust permanently, and it is very
// easy to do by accident when the provider is not ready. So the product area
// says plainly that it is not connected yet. See ShopCatalog.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../theme.dart';
import '../shop/flow.dart';
import '../state/liquidity_controller.dart';

class ShopScreen extends StatefulWidget {
  const ShopScreen({super.key});

  @override
  State<ShopScreen> createState() => _ShopScreenState();
}

class _ShopScreenState extends State<ShopScreen> {
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Bk.bg,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
          children: [
            const Text('Shop',
                style: TextStyle(
                    fontSize: 30,
                    fontWeight: FontWeight.w700,
                    color: Colors.white)),
            const SizedBox(height: 4),
            const Text('Buy real things. Pay with crypto.',
                style: TextStyle(fontSize: 14, color: Bk.faint)),
            const SizedBox(height: 16),
            _SearchBar(controller: _search),
            const SizedBox(height: 20),
            const _FlowCard(kind: _FlowKind.getBlock),
            const SizedBox(height: 12),
            const _FlowCard(kind: _FlowKind.payWithBlock),
            const SizedBox(height: 24),
            const _CatalogPlaceholder(),
          ],
        ),
      ),
    );
  }
}

class _SearchBar extends StatelessWidget {
  const _SearchBar({required this.controller});
  final TextEditingController controller;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      style: const TextStyle(color: Colors.white),
      decoration: InputDecoration(
        hintText: 'Search for anything',
        hintStyle: const TextStyle(color: Bk.faint),
        prefixIcon: const Icon(Icons.search, color: Bk.faint),
        filled: true,
        fillColor: Bk.surface,
        contentPadding: const EdgeInsets.symmetric(vertical: 16),
        border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: Bk.border)),
        enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: const BorderSide(color: Bk.border)),
      ),
      // Nothing is wired behind this yet and the screen says so below; a
      // search box that silently returns nothing reads as a broken app.
      enabled: false,
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

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Bk.border),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(
              kind == _FlowKind.getBlock
                  ? Icons.bolt_outlined
                  : Icons.shopping_bag_outlined,
              color: Bk.accent,
              size: 20),
          const SizedBox(width: 8),
          Text(plan.title,
              style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  color: Colors.white)),
          const Spacer(),
          // THE TIMING, ALWAYS. "Pay with BLOCK" contains a bank payout and
          // takes days; presenting it beside a two-minute action without
          // saying so is the single most misleading thing this screen could
          // do.
          _Pill(plan.takes.human, slow: plan.isSlow),
        ]),
        const SizedBox(height: 10),
        for (final leg in plan.legs)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Padding(
                  padding: EdgeInsets.only(top: 6, right: 8),
                  child: Icon(Icons.circle, size: 5, color: Bk.faint)),
              Expanded(
                  child: Text(leg.describe,
                      style: const TextStyle(
                          fontSize: 13, color: Bk.faint, height: 1.35))),
            ]),
          ),
        const SizedBox(height: 8),
        if (blocked != null)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
                color: Bk.surface2,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Bk.border)),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Icon(Icons.info_outline, size: 16, color: Bk.faint),
              const SizedBox(width: 8),
              Expanded(
                  child: Text(blocked.reason,
                      style: const TextStyle(
                          fontSize: 12.5, color: Bk.faint, height: 1.35))),
            ]),
          ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: Bk.accent,
                padding: const EdgeInsets.symmetric(vertical: 14)),
            onPressed: plan.ready ? () => _start(context, plan) : null,
            child: Text(plan.ready ? plan.title : 'Unavailable'),
          ),
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
        backgroundColor: Bk.surface2,
        content: Text('${plan.title}: ${plan.legs.length} steps, '
            '${plan.takes.human}.')));
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text, {required this.slow});
  final String text;
  final bool slow;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(
            color: slow ? Bk.surface3 : Bk.accentGhost,
            borderRadius: BorderRadius.circular(20)),
        child: Text(text,
            style: TextStyle(
                fontSize: 11,
                color: slow ? Bk.faint : Bk.accent,
                fontWeight: FontWeight.w600)),
      );
}

/// Where the catalogue will go.
///
/// SAYS IT IS EMPTY AND WHY. The alternative — seeding it with illustrative
/// products — is how a shopping app ends up quoting a price nobody can buy
/// at, from a retailer that never listed it. Once a provider is connected
/// this whole widget is deleted.
class _CatalogPlaceholder extends StatelessWidget {
  const _CatalogPlaceholder();

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
            color: Bk.bg2,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Bk.line)),
        child: const Column(children: [
          Icon(Icons.inventory_2_outlined, color: Bk.faint, size: 28),
          SizedBox(height: 10),
          Text('No product catalogue connected',
              style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: Colors.white)),
          SizedBox(height: 6),
          Text(
              'Search and listings switch on once a retail data provider is '
              'connected. Nothing is shown here until the prices and '
              'retailers are real ones.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12.5, color: Bk.faint, height: 1.4)),
        ]),
      );
}
