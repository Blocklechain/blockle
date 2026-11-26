// screens/exchange/sections/balance_section.dart — what the VENUE holds for you.
//
// THE TWO-POTS EXPLAINER LIVES HERE NOW, and that is the single clearest win
// from the rail. It used to sit at the top of the tab's one scrolling column,
// so every visit — including every order placement — paid for it. It is an
// explanation of THIS screen, so this is where it belongs.
//
// RESERVED IS SHOWN BESIDE AVAILABLE because "available" alone cannot explain
// why a visible balance will not place an order, and a customer who thinks
// their money has gone missing is a support ticket at best.

import 'package:flutter/material.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../../../widgets/chain_icon.dart';
import '../exchange_ui.dart';
import 'deposit_section.dart';

class BalanceSection extends StatelessWidget {
  const BalanceSection({
    super.key,
    required this.c,
    required this.onDeposit,
    required this.onWithdraw,
    required this.onTrade,
  });

  final ExchangeController c;
  final VoidCallback onDeposit;
  final VoidCallback onWithdraw;
  final void Function(String market) onTrade;

  @override
  Widget build(BuildContext context) {
    if (c.loadingAccount && c.balances.isEmpty && c.accountError == null) {
      return const Center(child: CircularProgressIndicator());
    }

    final held = c.balances.where((b) => _nz(b.total)).toList();

    return ExBody(children: [
      ExHeader(
        title: 'Exchange balance',
        note: c.balances.isEmpty
            ? 'Held by the venue for your Blockle account — not in your wallet.'
            : '${held.length} of ${c.balances.length} with a balance. Held by '
                'the venue for your Blockle account — not in your wallet.',
      ),
      Row(children: [
        Expanded(
          child: OutlinedButton.icon(
            onPressed: onDeposit,
            icon: const Icon(Icons.call_received, size: 18),
            label: const Text('Deposit'),
            style: OutlinedButton.styleFrom(minimumSize: const Size(0, 42)),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: OutlinedButton.icon(
            onPressed: onWithdraw,
            icon: const Icon(Icons.call_made, size: 18),
            label: const Text('Withdraw'),
            style: OutlinedButton.styleFrom(minimumSize: const Size(0, 42)),
          ),
        ),
      ]),
      const SizedBox(height: 12),

      // An error here NEVER renders as "you have nothing".
      if (c.accountError != null) ...[
        ExError(what: 'your balance', message: c.accountError!),
        const SizedBox(height: 12),
      ],
      if (c.accountError == null && c.balances.isEmpty)
        const ExCard(
            child: Text('Nothing deposited yet. Send a coin from your wallet to start.')),

      for (final b in c.balances) ...[
        _BalanceRow(b: b, c: c, onTrade: onTrade),
        const SizedBox(height: 6),
      ],

      const SizedBox(height: 10),
      const ExCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Reserved is committed to your resting orders',
              style: TextStyle(fontWeight: FontWeight.w700)),
          SizedBox(height: 6),
          Text(
            'It is still yours — cancel the order and it comes straight back — '
            'but a new order cannot use it.',
            style: TextStyle(color: Bk.muted, fontSize: 13, height: 1.4),
          ),
        ]),
      ),
      const SizedBox(height: 10),
      const ExCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Your wallet and your exchange balance are separate',
              style: TextStyle(fontWeight: FontWeight.w700)),
          SizedBox(height: 6),
          Text(
            'The Wallet tab holds coins only you have the keys for. To trade a '
            'coin here, send it from your wallet to your exchange deposit '
            'address. Nothing is moved for you.',
            style: TextStyle(color: Bk.muted, fontSize: 13, height: 1.4),
          ),
        ]),
      ),
    ]);
  }

  static bool _nz(String v) {
    final n = num.tryParse(v);
    return n != null && n > 0;
  }
}

class _BalanceRow extends StatelessWidget {
  const _BalanceRow({required this.b, required this.c, required this.onTrade});
  final ExchangeBalance b;
  final ExchangeController c;
  final void Function(String market) onTrade;

  @override
  Widget build(BuildContext context) {
    // The reserved figure renders an EM DASH when it is zero, so a row with
    // nothing reserved does not look like a row with a tiny reservation.
    final reserved = (num.tryParse(b.reserved) ?? 0) > 0 ? b.reserved : kEmDash;
    final market = _firstMarketFor(b.asset);
    return ExCard(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      child: Row(children: [
        ChainIcon(b.asset, symbol: b.asset, radius: 14),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(b.asset, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
            Text('available ${b.available}', style: kMono),
            Text('total ${b.total}  ·  reserved $reserved',
                style: const TextStyle(fontSize: 11.5, color: Bk.muted)),
          ]),
        ),
        if (market != null)
          TextButton(
            onPressed: () => onTrade(market),
            child: const Text('Trade'),
          ),
        IconButton(
          tooltip: 'Deposit ${b.asset}',
          icon: const Icon(Icons.call_received, size: 18),
          onPressed: () => showDepositSheet(context, c, b.asset),
        ),
      ]),
    );
  }

  /// The first LISTED market for the asset, taken from the live market list
  /// rather than assembled as "<ASSET>-USDT" — the web's guess breaks the
  /// moment an asset is listed against something else, and the quote set is
  /// being expanded.
  String? _firstMarketFor(String asset) {
    // visibleMarkets, so a Trade link can never land on the market the
    // never-price-BLOCK-in-USD rule withholds from every other surface.
    for (final m in c.visibleMarkets) {
      if (m.base == asset || m.quote == asset) return m.id;
    }
    return null;
  }
}
