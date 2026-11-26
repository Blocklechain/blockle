// screens/exchange/sections/deposit_extras.dart — the three deposit panels the
// app has never had, and which the live WEB deposit screen does not actually
// show either.
//
// THE WEB BUG NOT TO PORT. `RENDER.deposit` calls `fillAssetSelect($('f-asset'))`
// (exchange.js:691) on a faucet element that was deleted from app.html when the
// faucet was removed. `fillAssetSelect` dereferences `sel.options` on null, so
// it throws on every deposit render — and the two statements after it,
// `depositNets()` and `drawInflight()`, never run. On the live site the
// per-chain picker and the deposits-in-flight table never initialise at all.
// The app is therefore the first surface where either works.
//
// THE NATIVE-CHAIN CALLING CONVENTION, which is the one thing here that is easy
// to get wrong and expensive when you do. `/v1/withdrawal-options` marks a
// single-chain asset's only entry `native: true`, and for that entry `network`
// is a LABEL, not a chain id. A caller that sends the label back as
// `network=<SYMBOL>` 400s every single-chain asset — which is exactly what
// broke deposit-address issuance for all of them. [ChainDepth.param] is empty
// for a native chain and the client omits the parameter.

import 'package:flutter/material.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../../../widgets/chain_icon.dart';
import '../coin_names.dart';
import '../exchange_ui.dart';
import 'panel_kit.dart';

/// EVERY asset × chain address this account has, provisioned on sight.
///
/// Loaded without being asked, because a customer should not have to discover
/// that their account HAS a Bitcoin address by finding the right dropdown.
/// Three row states, never collapsed into two: an address; `closed` with the
/// venue's full reason; or an error that names itself. A closed chain is
/// REPORTED rather than skipped — "no address shown" and "this chain is shut
/// until we can pay its network fee" look identical on a screen, and only one
/// of them is worth waiting out.
class DepositAddressBook extends StatelessWidget {
  const DepositAddressBook({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<DepositAddresses>(
      what: 'your deposit addresses',
      reloadOn: c.refreshTick,
      load: c.client.depositAddresses,
      builder: (context, v, reload) {
        final rows = v.rows;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ExHeader(
              title: 'Your deposit addresses',
              note: rows.isEmpty
                  ? 'The venue returned no chains for this account.'
                  : '${v.openCount} of ${rows.length} chains open. ${v.note}',
            ),
            ExDataRows(
              empty: 'No chains are open for this account yet.',
              rows: [
                for (final r in rows)
                  ExDataRow(
                    leading: ChainIcon(r.asset, symbol: r.asset, radius: 12),
                    title: r.asset,
                    subtitle: r.network == null
                        ? '${coinName(r.asset)} · native chain'
                        : '${coinName(r.asset)} · ${networkLabel(r.network!)}',
                    dim: !r.ready,
                    fields: [
                      (
                        'Address',
                        r.ready
                            ? Text(exShortAddress(r.address!), style: kMono)
                            : ExPill(r.open ? 'none yet' : 'closed',
                                tone: r.open ? ExTone.warn : ExTone.bad),
                      ),
                      (
                        'Memo',
                        r.memoRequired
                            // A memo that EXISTS is never optional: the chains
                            // that use one cannot credit a deposit without it.
                            ? const ExPill('REQUIRED', tone: ExTone.warn)
                            : const ExText(kEmDash),
                      ),
                    ],
                    // The reason gets a full-width line. A reason truncated into
                    // a table cell is a reason nobody reads.
                    footer: r.ready
                        ? null
                        : Text(
                            r.reason ??
                                'The venue did not say why there is no address '
                                    'here. It will not show one it is not '
                                    'certain of.',
                            style: const TextStyle(
                                fontSize: 12, color: Bk.muted, height: 1.35),
                          ),
                    onTap: r.ready ? () => _showAddress(context, r) : null,
                  ),
              ],
            ),
          ],
        );
      },
    );
  }

  void _showAddress(BuildContext context, DepositAddressRow r) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(
            20, 8, 20, 24 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Deposit ${r.asset}'
              '${r.network == null ? '' : ' on ${networkLabel(r.network!)}'}',
              style: Theme.of(ctx).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            ExAddressBox(r.address!, copyLabel: 'Copy address'),
            if (r.memoRequired) ...[
              const SizedBox(height: 12),
              const ExAdvice(
                'This chain REQUIRES the memo below. A transfer without it '
                'arrives with nothing to say whose it is, and crediting it '
                'then needs a human.',
                tone: ExTone.warn,
                icon: Icons.label_important_outline,
              ),
              if (r.memo != null) ...[
                const SizedBox(height: 10),
                ExAddressBox(r.memo!,
                    label: 'Memo / tag', copyLabel: 'Copy memo'),
              ],
            ],
            const SizedBox(height: 12),
            ExAdvice(
              'Only ${r.asset}'
              '${r.network == null ? '' : ' on ${networkLabel(r.network!)}'}. '
              'Anything else sent here is lost — not recoverable by us, not by '
              'the chain.',
              tone: ExTone.bad,
              icon: Icons.warning_amber_rounded,
            ),
          ],
        ),
      ),
    );
  }
}

/// The per-asset, per-CHAIN picker.
///
/// The app's deposit flow could take a network string but could never list the
/// chains, so it could not offer the choice at all. `/v1/withdrawal-options` is
/// the only route that enumerates them — it is named for withdrawals but the
/// chain list is the same one — and it also carries `native`, which decides
/// whether the network parameter is sent or omitted.
class DepositChainPicker extends StatefulWidget {
  const DepositChainPicker({super.key, required this.c, required this.asset});
  final ExchangeController c;
  final String asset;

  @override
  State<DepositChainPicker> createState() => _DepositChainPickerState();
}

class _DepositChainPickerState extends State<DepositChainPicker> {
  String? _chain; // the chain id, or '' for a native (single-chain) asset
  DepositTarget? _target;
  String? _error;
  bool _busy = false;

  @override
  void didUpdateWidget(DepositChainPicker old) {
    super.didUpdateWidget(old);
    if (old.asset != widget.asset) {
      setState(() {
        _chain = null;
        _target = null;
        _error = null;
      });
    }
  }

  Future<void> _fetch(ChainDepth n) async {
    setState(() {
      _busy = true;
      _error = null;
      _target = null;
    });
    try {
      // `param` is EMPTY for a native chain, and the client omits the
      // parameter entirely in that case. See the file header.
      final t = await widget.c.client.depositAddress(
        widget.asset,
        network: n.param.isEmpty ? null : n.param,
      );
      if (!mounted) return;
      setState(() {
        _target = t;
        _busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<AssetDepth>(
      key: ValueKey('chains-${widget.asset}'),
      what: 'the chains ${widget.asset} can arrive on',
      load: () => widget.c.client.withdrawalOptions(widget.asset),
      builder: (context, d, reload) {
        final nets = d.networks;
        if (nets.isEmpty) {
          return ExCard(
            child: Text(
              'The venue did not list a chain for ${widget.asset}. That is its '
              'answer, not a blank screen — nothing is being hidden.',
              style:
                  const TextStyle(fontSize: 13, color: Bk.muted, height: 1.4),
            ),
          );
        }
        final selected = _chain ?? nets.first.param;
        final chosen = nets.firstWhere((n) => n.param == selected,
            orElse: () => nets.first);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const ExHeader(
              title: 'Pick a chain',
              note:
                  'The same coin on a different chain is a different deposit. '
                  'Send on the chain you pick here and no other.',
            ),
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: selected,
              decoration:
                  const InputDecoration(labelText: 'Network', isDense: true),
              items: [
                for (final n in nets)
                  DropdownMenuItem(
                    value: n.param,
                    // Availability in the OPTION TEXT, because the honest
                    // moment to say a chain is shut is before it is picked.
                    child: Text(n.native
                        ? '${widget.asset} (native chain)'
                        : '${networkLabel(n.network)}'
                            '${n.open ? '' : ' — closed'}'),
                  ),
              ],
              onChanged: (v) {
                if (v == null) return;
                setState(() => _chain = v);
              },
            ),
            const SizedBox(height: 10),
            if (!chosen.open)
              ExAdvice(
                chosen.note ??
                    'This chain is closed. The venue will not take coins it '
                        'cannot send back.',
                tone: ExTone.warn,
                icon: Icons.block,
              ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _busy ? null : () => _fetch(chosen),
              icon: const Icon(Icons.call_received, size: 18),
              label: Text(_busy
                  ? 'Asking the venue…'
                  : 'Show my ${widget.asset} address'
                      '${chosen.native ? '' : ' on ${networkLabel(chosen.network)}'}'),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              ExError(
                  what: 'your ${widget.asset} address on that chain',
                  message: _error!),
            ],
            if (_target != null) ...[
              const SizedBox(height: 12),
              if (!_target!.ready)
                // THE VENUE'S REASON, never a fabricated address.
                ExAdvice(
                  _target!.reason ??
                      'No address is provisioned here, and the venue will not '
                          'show one it is not certain of.',
                  tone: ExTone.warn,
                  icon: Icons.info_outline,
                )
              else
                ExCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      ExAddressBox(_target!.address!,
                          copyLabel: 'Copy address'),
                      // THE MEMO, ON THE CHAINS THAT CANNOT CREDIT WITHOUT IT.
                      // Same rule as the whole-account table above: a memo that
                      // exists is never optional, and a transfer sent without
                      // one is not recoverable by anyone.
                      if (_target!.memoRequired) ...[
                        const SizedBox(height: 8),
                        const Text(
                          'This chain REQUIRES the memo below. A transfer '
                          'without it cannot be credited.',
                          style: TextStyle(
                              fontSize: 12, color: Bk.warn, height: 1.35),
                        ),
                        if (_target!.memo != null) ...[
                          const SizedBox(height: 8),
                          ExAddressBox(_target!.memo!,
                              label: 'Memo / tag', copyLabel: 'Copy memo'),
                        ],
                      ],
                      const SizedBox(height: 8),
                      Text(
                        'Only ${widget.asset}'
                        '${chosen.native ? '' : ' on ${networkLabel(chosen.network)}'}. '
                        'Anything else sent here is lost.',
                        style: const TextStyle(
                            fontSize: 12, color: Bk.muted, height: 1.35),
                      ),
                    ],
                  ),
                ),
            ],
          ],
        );
      },
    );
  }
}

/// Deposits the chain has shown but that are not necessarily credited yet.
///
/// This is the panel that makes "where is my deposit" answerable without a
/// support ticket: a row exists from the first time the custodian mentions the
/// transfer, carrying how many confirmations it still needs.
class DepositsInFlight extends StatelessWidget {
  const DepositsInFlight({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<List<DepositInFlight>>(
      what: 'your deposits in flight',
      reloadOn: c.refreshTick,
      load: c.client.deposits,
      builder: (context, rows, reload) {
        final waiting = rows.where((d) => d.waiting).length;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ExHeader(
              title: 'Deposits in flight',
              // The EXACT figure lives here. The rail only ever draws a dot.
              note: rows.isEmpty
                  ? 'Nothing arriving.'
                  : waiting == 0
                      ? 'All ${rows.length} accounted for.'
                      : '$waiting waiting to confirm.',
            ),
            ExDataRows(
              empty: 'Nothing arriving.',
              rows: [
                for (final d in rows)
                  ExDataRow(
                    leading: ChainIcon(d.asset, symbol: d.asset, radius: 12),
                    title: d.asset,
                    subtitle: d.network == null
                        ? 'native chain'
                        : networkLabel(d.network!),
                    fields: [
                      ('Amount', ExNum(d.amount)),
                      (
                        'Confirmations',
                        // The detail string carries "N of M", which is more use
                        // than the bare count.
                        ExText(d.waiting && d.detail != null
                            ? d.detail
                            : '${d.confirmations}'),
                      ),
                    ],
                    trailing: _pill(d.outcome),
                  ),
              ],
            ),
          ],
        );
      },
    );
  }

  /// The venue's outcomes are `credited` / `pending` / `unattributed` /
  /// `unreadable`. An outcome added later renders AS ITSELF rather than being
  /// bucketed into something it is not.
  static Widget _pill(String outcome) => switch (outcome) {
        'credited' => const ExPill('credited', tone: ExTone.good),
        'pending' => const ExPill('confirming'),
        'unattributed' => const ExPill('needs review', tone: ExTone.warn),
        'unreadable' => const ExPill('needs review', tone: ExTone.warn),
        _ => ExPill(outcome, tone: ExTone.warn),
      };
}
