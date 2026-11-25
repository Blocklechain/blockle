// screens/exchange_screen.dart — the Blockle exchange, in the app.
//
// The same venue as exchange.blockle.org and the same order books: markets,
// depth, the trade tape, your orders and your exchange balance.
//
// THE CENTRAL IDEA THE UI HAS TO CARRY. There are two pots of money here and
// they are not the same pot. The Wallet tab holds coins this device has keys
// for. The exchange holds a balance for your Blockle account. To trade, you
// SEND from the wallet to the exchange's deposit address — the app never moves
// it for you. Every balance figure on this screen is therefore labelled as
// exchange-held, and the deposit sheet is the only bridge.
//
// AND IT MUST NOT OVERSTATE THE VENUE. The exchange publishes its own gate
// (live / mainnetEnabled / legalReviewCompleted). Until all three are true the
// order form is disabled and the screen says so plainly, because a trading UI
// that looks operational on a venue which is not is the kind of thing people
// lose money to.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/exchange_client.dart';
import '../state/exchange_controller.dart';
import '../widgets/chain_icon.dart';

class ExchangeScreen extends StatefulWidget {
  const ExchangeScreen({super.key});

  @override
  State<ExchangeScreen> createState() => _ExchangeScreenState();
}

class _ExchangeScreenState extends State<ExchangeScreen> {
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    final c = context.read<ExchangeController>();
    // Fire-and-forget: the screen renders its loading and error states.
    c.loadMarkets();
    c.loadAccount();
    c.startPolling();
  }

  @override
  void dispose() {
    // The controller is app-wide; only this screen's polling stops.
    context.read<ExchangeController>().stopPolling();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<ExchangeController>(
      builder: (context, c, _) {
        return Scaffold(
          appBar: AppBar(
            title: const Text('Exchange'),
            actions: [
              IconButton(
                tooltip: 'Refresh',
                icon: const Icon(Icons.refresh),
                onPressed: () {
                  c.loadMarkets();
                  c.loadAccount();
                },
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 40),
            children: [
              _GateBanner(c: c),
              const SizedBox(height: 12),
              const _TwoPotsNote(),
              const SizedBox(height: 16),
              _MarketPicker(c: c),
              const SizedBox(height: 16),
              if (c.selected != null) ...[
                _BookAndTape(c: c),
                const SizedBox(height: 16),
                _OrderForm(c: c),
                const SizedBox(height: 16),
              ],
              _Balances(c: c),
              const SizedBox(height: 16),
              _OpenOrders(c: c),
            ],
          ),
        );
      },
    );
  }
}

/// What the venue says about itself, verbatim.
class _GateBanner extends StatelessWidget {
  const _GateBanner({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    final s = c.status;
    if (s == null) {
      final err = c.marketsError;
      if (err == null) return const SizedBox.shrink();
      return _Card(
        tone: _Tone.bad,
        child: Text('The exchange could not be reached: $err'),
      );
    }
    if (s.tradable) {
      return _Card(
        tone: _Tone.good,
        child: Text('Live on ${s.network}.'),
      );
    }
    // Name the specific gates that are shut. "Coming soon" tells nobody
    // anything; a list of what is outstanding is checkable.
    final shut = <String>[
      if (!s.live) 'the venue is not open',
      if (!s.mainnetEnabled) 'mainnet is not enabled',
      if (!s.legalReviewCompleted) 'legal review is not complete',
    ];
    return _Card(
      tone: _Tone.warn,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Not open for trading yet (${s.network}).',
              style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text('Outstanding: ${shut.join('; ')}.'),
          const SizedBox(height: 4),
          const Text(
            'You can look at the markets and the order books. Placing an '
            'order is disabled until the venue is open.',
          ),
        ],
      ),
    );
  }
}

class _TwoPotsNote extends StatelessWidget {
  const _TwoPotsNote();

  @override
  Widget build(BuildContext context) {
    return const _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Your wallet and your exchange balance are separate',
              style: TextStyle(fontWeight: FontWeight.w600)),
          SizedBox(height: 6),
          Text(
            'The Wallet tab holds coins only you have the keys for. To trade a '
            'coin here, send it from your wallet to your exchange deposit '
            'address — tap a balance below to get it. Nothing is moved for you.',
          ),
        ],
      ),
    );
  }
}

class _MarketPicker extends StatelessWidget {
  const _MarketPicker({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    if (c.loadingMarkets && c.markets.isEmpty) {
      return const Center(child: Padding(
        padding: EdgeInsets.all(24), child: CircularProgressIndicator()));
    }
    if (c.markets.isEmpty) {
      return _Card(
        tone: c.marketsError == null ? _Tone.plain : _Tone.bad,
        child: Text(c.marketsError ?? 'No markets are listed yet.'),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Markets', style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        ...c.markets.map((m) {
          final sel = m.id == c.selected;
          return Card(
            margin: const EdgeInsets.only(bottom: 6),
            color: sel ? Theme.of(context).colorScheme.primaryContainer : null,
            child: ListTile(
              leading: ChainIcon(m.base, symbol: m.base, radius: 14),
              title: Text(m.pair),
              subtitle: Text(_priceLine(m)),
              trailing: sel ? const Icon(Icons.check) : null,
              onTap: () => c.selectMarket(m.id),
            ),
          );
        }),
      ],
    );
  }

  /// NULL IS NOT ZERO. A market that has never traded says so.
  static String _priceLine(ExchangeMarket m) {
    final parts = <String>[];
    parts.add(m.last == null ? 'no trades yet' : 'last ${m.last}');
    if (m.bid != null) parts.add('bid ${m.bid}');
    if (m.ask != null) parts.add('ask ${m.ask}');
    return parts.join('  ·  ');
  }
}

class _BookAndTape extends StatelessWidget {
  const _BookAndTape({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    if (c.loadingMarket && c.book == null) {
      return const Center(child: Padding(
        padding: EdgeInsets.all(16), child: CircularProgressIndicator()));
    }
    final err = c.marketError;
    if (err != null) {
      return _Card(tone: _Tone.bad, child: Text('Order book unavailable: $err'));
    }
    final b = c.book;
    if (b == null || b.isEmpty) {
      return _Card(
        child: Text(
          'No orders on ${c.selected} yet. An empty book is not a price — '
          'nothing here is quoting.',
        ),
      );
    }
    final rows = <Widget>[];
    final depth = b.asks.length > 8 ? 8 : b.asks.length;
    // Asks descending above, bids below, the way a book is read.
    for (var i = depth - 1; i >= 0; i--) {
      rows.add(_level(context, b.asks[i], isBid: false));
    }
    rows.add(Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Text(
        b.mid == null ? 'one-sided book — no mid' : 'mid ${b.mid}',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
    ));
    final bd = b.bids.length > 8 ? 8 : b.bids.length;
    for (var i = 0; i < bd; i++) {
      rows.add(_level(context, b.bids[i], isBid: true));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Order book — ${c.selected}',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        _Card(child: Column(children: rows)),
        const SizedBox(height: 12),
        const Text('Recent trades', style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        _Card(
          child: c.trades.isEmpty
              ? const Text('No trades yet.')
              : Column(
                  children: c.trades.take(10).map((t) {
                    final side = (t['takerSide'] ?? '').toString();
                    return Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text('${t['price']}',
                            style: TextStyle(
                                color: side == 'buy' ? Colors.green : Colors.red)),
                        Text('${t['base']}'),
                      ],
                    );
                  }).toList(),
                ),
        ),
      ],
    );
  }

  Widget _level(BuildContext context, OrderLevel l, {required bool isBid}) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text('${l.price}',
            style: TextStyle(color: isBid ? Colors.green : Colors.red)),
        Text('${l.size}'),
      ],
    );
  }
}

class _OrderForm extends StatefulWidget {
  const _OrderForm({required this.c});
  final ExchangeController c;
  @override
  State<_OrderForm> createState() => _OrderFormState();
}

class _OrderFormState extends State<_OrderForm> {
  final _size = TextEditingController();
  final _price = TextEditingController();
  String _side = 'buy';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _size.dispose();
    _price.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.c;
    final m = c.selectedMarket;
    if (m == null) return const SizedBox.shrink();

    // THREE SEPARATE REASONS the form can be unavailable, each said out loud.
    if (!c.tradable) {
      return _Card(
        child: Text('Trading on ${m.pair} opens when the venue does.'),
      );
    }
    if (!c.signedIn) {
      return const _Card(
        child: Text(
          'Sign in to your Blockle account to place an order. The exchange '
          'uses your Blockle account — it has no separate login.',
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Place an order — ${m.pair}',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        _Card(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'buy', label: Text('Buy')),
                  ButtonSegment(value: 'sell', label: Text('Sell')),
                ],
                selected: {_side},
                onSelectionChanged: (s) => setState(() => _side = s.first),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _size,
                // Decimal text, not a number field: the amount is sent as a
                // STRING and must never pass through a double.
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                decoration: InputDecoration(
                  labelText: 'Amount (${m.base})',
                  helperText: m.minBase == null ? null : 'minimum ${m.minBase}',
                ),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _price,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                decoration: InputDecoration(labelText: 'Limit price (${m.quote})'),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(_error!, style: const TextStyle(color: Colors.red)),
              ],
              const SizedBox(height: 12),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: Text(_busy
                    ? 'Placing…'
                    : '${_side == 'buy' ? 'Buy' : 'Sell'} ${m.base}'),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _submit() async {
    final c = widget.c;
    final m = c.selectedMarket!;
    final size = _size.text.trim();
    final price = _price.text.trim();
    if (size.isEmpty) {
      setState(() => _error = 'Enter an amount.');
      return;
    }
    if (price.isEmpty) {
      setState(() => _error = 'Enter a limit price.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await c.placeOrder(
      market: m.id,
      side: _side,
      type: 'limit',
      size: size,
      price: price,
    );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = err;
    });
    if (err == null) {
      _size.clear();
      _price.clear();
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Order placed.')));
    }
  }
}

class _Balances extends StatelessWidget {
  const _Balances({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    if (!c.signedIn) {
      return const _Card(
        child: Text(
          'Sign in to your Blockle account to see your exchange balance.',
        ),
      );
    }
    if (c.loadingAccount && c.balances.isEmpty && c.accountError == null) {
      return const Center(child: Padding(
        padding: EdgeInsets.all(16), child: CircularProgressIndicator()));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Held at the exchange',
            style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        const Text(
          'Not in your wallet. Tap a coin to get its deposit address.',
          style: TextStyle(fontSize: 12),
        ),
        const SizedBox(height: 8),
        // An error here NEVER renders as "you have nothing".
        if (c.accountError != null)
          _Card(
            tone: _Tone.bad,
            child: Text(
              'Could not read your balance: ${c.accountError}. '
              'This is a display problem — it says nothing about your funds.',
            ),
          ),
        if (c.accountError == null && c.balances.isEmpty)
          const _Card(
              child: Text(
                  'Nothing deposited yet. Send a coin from your wallet to start.')),
        ...c.balances.map((b) => Card(
              margin: const EdgeInsets.only(bottom: 6),
              child: ListTile(
                leading: ChainIcon(b.asset, symbol: b.asset, radius: 14),
                title: Text('${b.asset}  ${b.available}'),
                subtitle: Text(_sub(b)),
                trailing: const Icon(Icons.call_received),
                onTap: () => _showDeposit(context, b.asset),
              ),
            )),
      ],
    );
  }

  /// `reserved` is shown because "available" alone cannot explain why a
  /// visible balance will not place an order.
  static String _sub(ExchangeBalance b) {
    if (b.reserved == '0' || b.reserved.isEmpty) return 'total ${b.total}';
    return 'total ${b.total}  ·  ${b.reserved} held by open orders';
  }

  Future<void> _showDeposit(BuildContext context, String asset) async {
    final c = context.read<ExchangeController>();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _DepositSheet(c: c, asset: asset),
    );
  }
}

/// The ONLY bridge between the wallet and the venue, and the user drives it.
class _DepositSheet extends StatefulWidget {
  const _DepositSheet({required this.c, required this.asset});
  final ExchangeController c;
  final String asset;
  @override
  State<_DepositSheet> createState() => _DepositSheetState();
}

class _DepositSheetState extends State<_DepositSheet> {
  DepositTarget? _target;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    widget.c.depositAddress(widget.asset).then((t) {
      if (!mounted) return;
      setState(() {
        _target = t;
        _loading = false;
      });
    }).catchError((Object e) {
      if (!mounted) return;
      setState(() {
        _error = e is ExchangeException ? e.message : e.toString();
        _loading = false;
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Deposit ${widget.asset}',
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          if (_loading) const Center(child: CircularProgressIndicator()),
          if (_error != null) Text(_error!, style: const TextStyle(color: Colors.red)),
          if (_target != null && !_target!.ready)
            // The venue explains rather than guessing; so does this.
            Text(_target!.reason ??
                'The exchange is not issuing ${widget.asset} deposit '
                    'addresses right now.'),
          if (_target != null && _target!.ready) ...[
            const Text(
              'Send only this coin, only to this address, on this network. '
              'A deposit to the wrong address or network cannot be recovered '
              'by anyone.',
            ),
            const SizedBox(height: 12),
            SelectableText(
              _target!.address!,
              style: const TextStyle(fontFamily: 'monospace'),
            ),
            if (_target!.network != null) ...[
              const SizedBox(height: 6),
              Text('Network: ${_target!.network}'),
            ],
            if (_target!.note != null) ...[
              const SizedBox(height: 6),
              Text(_target!.note!, style: const TextStyle(fontSize: 12)),
            ],
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () {
                Clipboard.setData(ClipboardData(text: _target!.address!));
                ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Address copied.')));
              },
              icon: const Icon(Icons.copy),
              label: const Text('Copy address'),
            ),
          ],
        ],
      ),
    );
  }
}

class _OpenOrders extends StatelessWidget {
  const _OpenOrders({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    if (!c.signedIn || c.orders.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Your open orders',
            style: TextStyle(fontWeight: FontWeight.w700)),
        const SizedBox(height: 8),
        ...c.orders.map((o) => Card(
              margin: const EdgeInsets.only(bottom: 6),
              child: ListTile(
                title: Text('${o.side.toUpperCase()} ${o.size} ${o.market}'),
                subtitle: Text(
                  'at ${o.price}'
                  '${o.filled == null ? '' : '  ·  filled ${o.filled}'}'
                  '${o.status == null ? '' : '  ·  ${o.status}'}',
                ),
                trailing: IconButton(
                  tooltip: 'Cancel',
                  icon: const Icon(Icons.close),
                  onPressed: () async {
                    final err = await c.cancelOrder(o.id);
                    if (err != null && context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Could not cancel: $err')));
                    }
                  },
                ),
              ),
            )),
      ],
    );
  }
}

enum _Tone { plain, good, warn, bad }

class _Card extends StatelessWidget {
  const _Card({required this.child, this.tone = _Tone.plain});
  final Widget child;
  final _Tone tone;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final bg = switch (tone) {
      _Tone.good => cs.primaryContainer,
      _Tone.warn => cs.tertiaryContainer,
      _Tone.bad => cs.errorContainer,
      _Tone.plain => cs.surfaceContainerHighest,
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: child,
    );
  }
}
