// exchange_screen.dart — the EXCHANGE screen (PASS 2 #2). Non-custodial sign-in
// (sign a server nonce with the local BLOCK key), markets + order book, place /
// cancel orders, and a buy / sell BLOCK panel — all through the Dart
// ExchangeClient against exchange.blockle.org.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/exchange_client.dart';
import '../state/app_state.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';

class ExchangeScreen extends StatefulWidget {
  const ExchangeScreen({super.key});
  @override
  State<ExchangeScreen> createState() => _ExchangeScreenState();
}

class _ExchangeScreenState extends State<ExchangeScreen> {
  bool _busy = false;
  String? _error;
  List<ExchangeMarket> _markets = [];
  ExchangeMarket? _selected;
  OrderBook? _book;
  List<OpenOrder> _orders = [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadMarkets());
  }

  Future<void> _loadMarkets() async {
    setState(() => _busy = true);
    final c = context.read<MultichainController>();
    final m = await c.exchange.getMarkets();
    if (!mounted) return;
    setState(() {
      _markets = m;
      _selected ??= m.isNotEmpty ? m.first : null;
      _busy = false;
      _error = c.exchange.lastError;
    });
    if (_selected != null) _loadBook(_selected!);
    if (c.exchange.signedIn) _loadOrders();
  }

  Future<void> _loadBook(ExchangeMarket m) async {
    final c = context.read<MultichainController>();
    final b = await c.exchange.getBook(m.id);
    if (!mounted) return;
    setState(() => _book = b);
  }

  Future<void> _loadOrders() async {
    final c = context.read<MultichainController>();
    final o = await c.exchange.getOpenOrders();
    if (!mounted) return;
    setState(() => _orders = o);
  }

  Future<void> _signIn() async {
    final app = context.read<AppState>();
    final c = context.read<MultichainController>();
    if (!app.store.isUnlocked) {
      _snack('Unlock your BLOCK wallet first.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await c.exchange.signIn(app.store.address ?? '', c.signForExchange);
      await _loadOrders();
      _snack('Signed in to the exchange');
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.watch<MultichainController>();
    final signedIn = c.exchange.signedIn;
    return SafeArea(
      child: RefreshIndicator(
        color: Bk.accent,
        backgroundColor: Bk.surface,
        onRefresh: _loadMarkets,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 28),
          children: [
            Row(
              children: [
                const Text('Exchange',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                const Spacer(),
                if (signedIn)
                  TextButton.icon(
                    onPressed: () {
                      c.exchange.signOut();
                      setState(() => _orders = []);
                    },
                    icon: const Icon(Icons.logout, size: 16),
                    label: const Text('Sign out'),
                  )
                else
                  FilledButton(
                    onPressed: _busy ? null : _signIn,
                    style: FilledButton.styleFrom(
                        minimumSize: const Size(110, 40)),
                    child: const Text('Sign in'),
                  ),
              ],
            ),
            const Text('exchange.blockle.org · non-custodial',
                style: TextStyle(color: Bk.muted, fontSize: 12)),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: const TextStyle(color: Bk.bad, fontSize: 12)),
            ],
            const SizedBox(height: 16),
            _buySellCard(c, signedIn),
            const SizedBox(height: 18),
            const Text('Markets',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 6),
            if (_busy && _markets.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_markets.isEmpty)
              const Text('No markets available right now.',
                  style: TextStyle(color: Bk.muted, fontSize: 13))
            else
              ..._markets.map((m) => _marketTile(m)),
            if (_selected != null) ...[
              const SizedBox(height: 18),
              _bookCard(),
            ],
            if (signedIn) ...[
              const SizedBox(height: 18),
              _ordersCard(c),
            ],
          ],
        ),
      ),
    );
  }

  Widget _marketTile(ExchangeMarket m) {
    final sel = _selected?.id == m.id;
    return InkWell(
      onTap: () {
        setState(() => _selected = m);
        _loadBook(m);
      },
      borderRadius: BorderRadius.circular(12),
      child: Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: sel ? Bk.surface2 : Bk.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: sel ? Bk.accent : Bk.border),
        ),
        child: Row(
          children: [
            Text(m.id.isNotEmpty ? m.id : '${m.base}/${m.quote}',
                style: const TextStyle(fontWeight: FontWeight.w700)),
            const Spacer(),
            if (m.last != null)
              Text(m.last.toString(), style: kMono.copyWith(fontSize: 13)),
            if (m.change24h != null) ...[
              const SizedBox(width: 8),
              Text('${m.change24h! >= 0 ? '+' : ''}${m.change24h}%',
                  style: TextStyle(
                      color: m.change24h! >= 0 ? Bk.good : Bk.bad,
                      fontSize: 12)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _bookCard() {
    final b = _book;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Bk.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Order book · ${_selected!.id}',
                  style: const TextStyle(fontWeight: FontWeight.w700)),
              const Spacer(),
              TextButton(
                onPressed: () => _placeOrderDialog(),
                child: const Text('Place order'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (b == null)
            const Text('Order book unavailable.',
                style: TextStyle(color: Bk.muted, fontSize: 12))
          else
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: _levels('Bids', b.bids, Bk.good)),
                Expanded(child: _levels('Asks', b.asks, Bk.bad)),
              ],
            ),
        ],
      ),
    );
  }

  Widget _levels(String title, List<OrderLevel> levels, Color color) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        if (levels.isEmpty)
          const Text('—', style: TextStyle(color: Bk.muted, fontSize: 12))
        else
          ...levels.take(8).map((l) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    Text(l.price.toString(), style: kMono.copyWith(fontSize: 11)),
                    const Spacer(),
                    Text(l.size.toString(),
                        style: kMono.copyWith(fontSize: 11, color: Bk.muted)),
                  ],
                ),
              )),
      ],
    );
  }

  Widget _ordersCard(MultichainController c) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Bk.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text('Open orders',
                  style: TextStyle(fontWeight: FontWeight.w700)),
              const Spacer(),
              IconButton(
                  onPressed: _loadOrders,
                  icon: const Icon(Icons.refresh, size: 18, color: Bk.muted)),
            ],
          ),
          if (_orders.isEmpty)
            const Text('No open orders.',
                style: TextStyle(color: Bk.muted, fontSize: 12))
          else
            ..._orders.map((o) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Row(
                    children: [
                      Text(o.side.toUpperCase(),
                          style: TextStyle(
                              color: o.side == 'buy' ? Bk.good : Bk.bad,
                              fontSize: 12,
                              fontWeight: FontWeight.w700)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text('${o.market}  ${o.size} @ ${o.price}',
                            style: kMono.copyWith(fontSize: 12)),
                      ),
                      TextButton(
                        onPressed: () async {
                          try {
                            await c.exchange.cancelOrder(o.id);
                            _loadOrders();
                          } catch (e) {
                            _snack(e.toString().replaceFirst('Exception: ', ''));
                          }
                        },
                        child: const Text('Cancel',
                            style: TextStyle(color: Bk.bad)),
                      ),
                    ],
                  ),
                )),
        ],
      ),
    );
  }

  Widget _buySellCard(MultichainController c, bool signedIn) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [Bk.surface, Bk.surface2]),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Bk.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Buy / Sell BLOCK',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: signedIn ? () => _tradeDialog(c, true) : null,
                  child: const Text('Buy'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton(
                  onPressed: signedIn ? () => _tradeDialog(c, false) : null,
                  child: const Text('Sell'),
                ),
              ),
            ],
          ),
          if (!signedIn) ...[
            const SizedBox(height: 8),
            const Text('Sign in to trade.',
                style: TextStyle(color: Bk.muted, fontSize: 12)),
          ],
        ],
      ),
    );
  }

  Future<void> _tradeDialog(MultichainController c, bool buy) async {
    final amt = TextEditingController();
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: Text(buy ? 'Buy BLOCK' : 'Sell BLOCK'),
        content: TextField(
          controller: amt,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(
              labelText: buy ? 'Amount (USDC)' : 'Amount (BLOCK)'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(buy ? 'Buy' : 'Sell')),
        ],
      ),
    );
    if (res != true) return;
    try {
      if (buy) {
        await c.exchange.buyBlock(amt.text.trim());
      } else {
        await c.exchange.sellBlock(amt.text.trim());
      }
      _snack(buy ? 'Buy order submitted' : 'Sell order submitted');
      _loadOrders();
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _placeOrderDialog() async {
    final c = context.read<MultichainController>();
    if (!c.exchange.signedIn) {
      _snack('Sign in to place orders.');
      return;
    }
    final market = _selected!;
    final price = TextEditingController();
    final size = TextEditingController();
    String side = 'buy';
    String type = 'limit';
    final res = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(
        builder: (dctx, setLocal) => AlertDialog(
          backgroundColor: Bk.surface,
          title: Text('Order · ${market.id}'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: SegmentedButton<String>(
                      segments: const [
                        ButtonSegment(value: 'buy', label: Text('Buy')),
                        ButtonSegment(value: 'sell', label: Text('Sell')),
                      ],
                      selected: {side},
                      onSelectionChanged: (s) => setLocal(() => side = s.first),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: SegmentedButton<String>(
                      segments: const [
                        ButtonSegment(value: 'limit', label: Text('Limit')),
                        ButtonSegment(value: 'market', label: Text('Market')),
                      ],
                      selected: {type},
                      onSelectionChanged: (s) => setLocal(() => type = s.first),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              if (type == 'limit')
                TextField(
                  controller: price,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Price'),
                ),
              const SizedBox(height: 10),
              TextField(
                controller: size,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Size'),
              ),
            ],
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(dctx, false),
                child: const Text('Cancel')),
            FilledButton(
                onPressed: () => Navigator.pop(dctx, true),
                child: const Text('Place')),
          ],
        ),
      ),
    );
    if (res != true) return;
    try {
      await c.exchange.placeOrder(
        market: market.id,
        side: side,
        type: type,
        size: size.text.trim(),
        price: type == 'limit' ? price.text.trim() : null,
      );
      _snack('Order placed');
      _loadOrders();
      _loadBook(market);
    } catch (e) {
      _snack(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  void _snack(String m) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
    }
  }
}
