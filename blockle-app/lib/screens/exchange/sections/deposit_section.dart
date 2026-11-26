// screens/exchange/sections/deposit_section.dart — where to send coins.
//
// THE ONLY BRIDGE between the two pots, and the user drives it: the app shows
// the address and they send to it from their wallet exactly as they would to
// any other venue. Nothing here moves anything.
//
// THREE PANELS LIVE IN deposit_extras.dart, and the reason they are not here is
// that each is a whole screen's worth of rules: the whole-account "your deposit
// addresses" table (every asset x chain, provisioned on sight, with
// open / closed-with-reason / errored row states and the memo-REQUIRED line),
// the per-chain picker enumerated from /v1/withdrawal-options honouring the
// native-chain convention (a single-chain asset must OMIT the network param —
// sending the symbol back as a chain id 400s every one of them), and "deposits
// in flight" with its N-of-M-confirmations detail. None of those three routes
// was called by the app before.
//
// WHAT WILL NEVER BE ADDED: a faucet. It was deleted server-side (not gated)
// after an authenticated scanner minted 1.39e12 base units of USDT the venue
// did not hold, and /public/status reports faucetAvailable:false permanently.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../coin_names.dart';
import '../exchange_ui.dart';
import 'deposit_extras.dart';
import 'panel_kit.dart';

/// Every asset the venue trades, from the live market list — base AND quote, so
/// a quote-only asset (USDT today, BTC/ETH/SOL tomorrow) is still depositable.
List<String> depositableAssets(ExchangeController c) {
  final out = <String>{};
  for (final m in c.markets) {
    if (m.base.isNotEmpty) out.add(m.base);
    if (m.quote.isNotEmpty) out.add(m.quote);
  }
  for (final b in c.balances) {
    if (b.asset.isNotEmpty) out.add(b.asset);
  }
  final list = out.toList()..sort();
  return list;
}

class DepositSection extends StatefulWidget {
  const DepositSection({super.key, required this.c});
  final ExchangeController c;

  @override
  State<DepositSection> createState() => _DepositSectionState();
}

class _DepositSectionState extends State<DepositSection> {
  String? _asset;

  @override
  Widget build(BuildContext context) {
    final assets = depositableAssets(widget.c);
    final asset = _asset ?? (assets.isEmpty ? null : assets.first);

    return ExBody(children: [
      const ExHeader(
        title: 'Deposit',
        note: 'Send the coin from your wallet to the address below. A deposit '
            'to the wrong address or the wrong chain cannot be recovered by '
            'anyone — not by us, not by the chain.',
      ),
      if (assets.isEmpty)
        ExCard(
          tone: widget.c.marketsError == null ? ExTone.plain : ExTone.bad,
          child: Text(widget.c.marketsError ??
              'The venue has not published its asset list yet.'),
        )
      else ...[
        DropdownButtonFormField<String>(
          // "USDT — Tether" is wider than 299pt of content width allows at
          // this font, and a dropdown that overflows paints a striped bar
          // across the screen instead of ellipsizing.
          isExpanded: true,
          initialValue: asset,
          decoration: const InputDecoration(labelText: 'Asset', isDense: true),
          items: [
            for (final a in assets)
              DropdownMenuItem(value: a, child: Text('$a — ${coinName(a)}')),
          ],
          onChanged: (v) => setState(() => _asset = v),
        ),
        const SizedBox(height: 14),
        if (asset != null) _AddressCard(key: ValueKey(asset), c: widget.c, asset: asset),
        const SizedBox(height: 14),
        // THE PER-CHAIN CHOICE the single-asset card above cannot offer: the
        // same coin on a different chain is a different deposit, and
        // /v1/withdrawal-options is the only route that enumerates them.
        if (asset != null)
          DepositChainPicker(key: ValueKey('nets-$asset'), c: widget.c, asset: asset),
      ],
      const SizedBox(height: 14),
      const ExCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('A deposit address is yours forever',
              style: TextStyle(fontWeight: FontWeight.w700)),
          SizedBox(height: 6),
          Text(
            'Reuse it as often as you like. It credits the Blockle account you '
            'are signed in to, and only the asset it was issued for — anything '
            'else sent to it is lost.',
            style: TextStyle(color: Bk.muted, fontSize: 13, height: 1.4),
          ),
        ]),
      ),
      const SizedBox(height: 22),
      // EVERY chain this account has an address on, asked for without being
      // prompted. A closed chain is reported with its reason rather than
      // skipped — see deposit_extras.dart.
      DepositAddressBook(c: widget.c),
      const SizedBox(height: 22),
      // "Where is my deposit", answered without a support ticket.
      DepositsInFlight(c: widget.c),
    ]);
  }
}

/// One asset's deposit target: the address, or the venue's REASON there isn't
/// one. Never a fabricated address and never a blank.
class _AddressCard extends StatefulWidget {
  const _AddressCard({super.key, required this.c, required this.asset});
  final ExchangeController c;
  final String asset;

  @override
  State<_AddressCard> createState() => _AddressCardState();
}

class _AddressCardState extends State<_AddressCard> {
  DepositTarget? _target;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() {
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
    if (_loading) {
      return const ExCard(
        child: Center(
            child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator())),
      );
    }
    if (_error != null) {
      return ExError(what: 'your ${widget.asset} deposit address', message: _error!);
    }
    final t = _target;
    if (t == null || !t.ready) {
      return ExCard(
        tone: ExTone.warn,
        child: Text(t?.reason ??
            'The exchange is not issuing ${widget.asset} deposit addresses '
                'right now.'),
      );
    }

    return ExCard(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Text('Your ${widget.asset} address',
                style: const TextStyle(fontWeight: FontWeight.w700)),
          ),
          if (t.network != null) ExPill(networkLabel(t.network!)),
        ]),
        const SizedBox(height: 10),
        // Monospace, character-level wrapping: an address that is cut off is an
        // address someone will mistype.
        SelectableText(t.address!, style: kMono),
        // THE MEMO, WHEN THE CHAIN HAS ONE. On XRP the tag is what tells the
        // venue whose deposit this is: the pooled address is shared, and
        // `Deposits.ownerOfAddress` never looks at the memo, so a transfer
        // without it is unattributable. Shown as its own copyable field rather
        // than inline in a sentence, for the same reason the address is.
        if (t.memoRequired) ...[
          const SizedBox(height: 12),
          const ExAdvice(
            'This chain REQUIRES the memo below. A transfer without it arrives '
            'with nothing to say whose it is, and crediting it then needs a '
            'human.',
            tone: ExTone.warn,
            icon: Icons.label_important_outline,
          ),
          if (t.memo != null) ...[
            const SizedBox(height: 10),
            ExAddressBox(t.memo!, label: 'Memo / tag', copyLabel: 'Copy memo'),
          ],
        ],
        const SizedBox(height: 10),
        Text(
          'Only ${widget.asset}'
          '${t.network == null ? '' : ' on ${networkLabel(t.network!)}'}. '
          'Anything else sent here is lost.',
          style: const TextStyle(fontSize: 12, color: Bk.muted, height: 1.35),
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: () {
            Clipboard.setData(ClipboardData(text: t.address!));
            ScaffoldMessenger.of(context)
                .showSnackBar(const SnackBar(content: Text('Address copied.')));
          },
          icon: const Icon(Icons.copy, size: 18),
          label: const Text('Copy address'),
        ),
      ]),
    );
  }
}

/// The deposit sheet, raised from a balance row.
///
/// A FULL-BLEED BOTTOM SHEET, which is the app's established convention for
/// this flow and is also the answer to the rail's 60pt: at 390pt the sheet
/// covers the rail entirely, so the address gets the whole width exactly when
/// it is being read and copied.
Future<void> showDepositSheet(
    BuildContext context, ExchangeController c, String asset) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => Padding(
      padding: EdgeInsets.fromLTRB(
          20, 8, 20, 24 + MediaQuery.of(ctx).viewInsets.bottom),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Text('Deposit $asset',
              style: Theme.of(ctx).textTheme.titleLarge),
        ),
        const SizedBox(height: 12),
        _AddressCard(c: c, asset: asset),
      ]),
    ),
  );
}
