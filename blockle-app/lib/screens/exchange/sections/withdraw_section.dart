// screens/exchange/sections/withdraw_section.dart — crypto out, to a chain.
//
// THE WHOLE FLOW, AND THE ALLOWLIST, BECAUSE WITHOUT THE ALLOWLIST THERE IS NO
// FLOW. `WD_REQUIRE_ALLOWLIST` is true on the live venue (publicapi.ts:107) and
// `Withdrawals.request` refuses any destination that is not on the list, with a
// 24-hour cooling-off period before a newly added one can be used
// (withdrawals.ts:691-713). There is no allowlist UI anywhere in
// deploy/exchange/frontpage — grep for "allowlist" and nothing comes back. So
// withdrawals are impossible from every shipped surface today: every attempt
// fails with "is not an allowlisted <ASSET> destination" and no screen can add
// one. A withdrawal screen without the allowlist panel would reproduce that
// exactly, which is why the two ship together or not at all.
//
// THREE GATES, NONE OF WHICH THIS SCREEN MAY OFFER A WAY AROUND, and all three
// enforced by the server rather than by this file:
//
//   1. SESSION ONLY. An API key is refused outright with an explanatory 403.
//      The app sends a Bearer session and no `x-blockle-key`, which qualifies.
//   2. A SECOND FACTOR, ON THIS REQUEST. The code rides the `x-blockle-totp`
//      header and is SPENT server-side, so one code cannot buy a window in
//      which an unattended session keeps withdrawing. The field is therefore
//      per-request and is cleared on every return.
//   3. AN ALLOWLISTED DESTINATION, 24h old. The destination field offers the
//      allowlist as a PICKER, with free text as the exception rather than the
//      default — typing an address that will be refused is not a flow worth
//      making easy.
//
// THE QUOTE IS THE SERVER'S. The fee, the minimum and the you-receive figure
// all come from `/v1/withdrawal-quote`, computed by the same function that
// prices the real withdrawal. A preview computed by different code is a preview
// that will eventually disagree with the charge.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../../../widgets/chain_icon.dart';
import '../coin_names.dart';
import '../exchange_ui.dart';
import 'panel_kit.dart';

class WithdrawSection extends StatefulWidget {
  const WithdrawSection({super.key, required this.c});
  final ExchangeController c;

  @override
  State<WithdrawSection> createState() => _WithdrawSectionState();
}

class _WithdrawSectionState extends State<WithdrawSection> {
  String? _asset;

  @override
  Widget build(BuildContext context) {
    final assets = _withdrawableAssets(widget.c);
    final asset = _asset ?? (assets.isEmpty ? null : assets.first);

    return ExBody(children: [
      const ExHeader(
        title: 'Withdraw',
        note: 'The fee is withheld from the amount, so you receive the amount '
            'minus the fee. Both figures are shown before you confirm.',
      ),
      if (widget.c.twoFactorOn == false)
        const ExAdvice(
          'You have no authenticator enrolled, so the venue will refuse every '
          'withdrawal. Set one up under ACCOUNT first — it takes a minute and '
          'it is the control that stops someone who has your session from '
          'emptying the account.',
          tone: ExTone.bad,
          icon: Icons.lock_outline,
        ),
      if (widget.c.twoFactorOn == false) const SizedBox(height: 12),
      if (assets.isEmpty)
        ExCard(
          tone: widget.c.marketsError == null ? ExTone.plain : ExTone.bad,
          child: Text(widget.c.marketsError ??
              'The venue has not published its asset list yet.'),
        )
      else ...[
        DropdownButtonFormField<String>(
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
        if (asset != null)
          _WithdrawTicket(
              key: ValueKey('wd-$asset'), c: widget.c, asset: asset),
        const SizedBox(height: 22),
        if (asset != null)
          AllowlistPanel(key: ValueKey('al-$asset'), c: widget.c, asset: asset),
      ],
      const SizedBox(height: 22),
      WithdrawalsInProgress(c: widget.c),
    ]);
  }

  /// Every asset the venue trades, plus anything already held — a balance in an
  /// asset that has since been delisted still has to be able to leave.
  static List<String> _withdrawableAssets(ExchangeController c) {
    final out = <String>{};
    for (final m in c.markets) {
      if (m.base.isNotEmpty) out.add(m.base);
      if (m.quote.isNotEmpty) out.add(m.quote);
    }
    for (final b in c.balances) {
      if (b.asset.isNotEmpty) out.add(b.asset);
    }
    return out.toList()..sort();
  }
}

/// The request ticket: chain, amount, destination, code.
class _WithdrawTicket extends StatefulWidget {
  const _WithdrawTicket({super.key, required this.c, required this.asset});
  final ExchangeController c;
  final String asset;

  @override
  State<_WithdrawTicket> createState() => _WithdrawTicketState();
}

class _WithdrawTicketState extends State<_WithdrawTicket> {
  final _amount = TextEditingController();
  final _address = TextEditingController();
  final _code = TextEditingController();

  String? _chain;
  WithdrawalQuote? _quote;
  String? _quoteError;
  Timer? _debounce;

  /// SEQUENCE GUARD. A quote for 10 and a quote for 100 are in flight at once
  /// when someone types a digit; without this the slower answer lands last and
  /// the ticket shows a fee for an amount that is no longer in the field.
  int _quoteSeq = 0;

  bool _busy = false;
  String? _error;
  WithdrawalRow? _done;

  /// THE IDEMPOTENCY KEY, HELD ACROSS RETRIES — which is the whole point of
  /// having one.
  ///
  /// This used to be minted inside the submit handler, one per tap. `_busy`
  /// does stop a double-tap, so that looked fine; the case it does not cover
  /// is the one that matters. A request that times out, or dies mid-reply,
  /// may already have created the withdrawal. `_busy` clears, the error says
  /// try again, the user taps — and a FRESH key makes the venue treat it as a
  /// new instruction. The server honours the key properly (it answers with
  /// the row it already made), so the dedupe existed and only the client
  /// defeated it. Two real withdrawals, and the only unrecoverable direction.
  ///
  /// So: minted once for a given set of withdrawal terms and reused for every
  /// retry of those terms. Change the asset, network, amount or destination
  /// and it is a different instruction, which earns a new key. Reuse is
  /// always the safe side of this — the venue only returns an existing
  /// withdrawal if one was actually made.
  ///
  /// NOT keyed on the TOTP code: that rotates every 30 seconds, so including
  /// it would mint a new key on exactly the retry this exists to protect.
  String? _requestId;
  String? _requestIdFor;

  /// The terms a request id belongs to. See [_requestId].
  String _termsKey(String amount, String address, String? network) =>
      '${widget.asset}|${network ?? ''}|$amount|$address';

  /// Free-typed destination instead of the allowlist picker. Off by default:
  /// an address that is not on the list is refused by the venue, so making it
  /// the easy path would mostly produce refusals.
  bool _manualAddress = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _amount.dispose();
    _address.dispose();
    _code.dispose();
    super.dispose();
  }

  void _requote(ChainDepth? chain) {
    _debounce?.cancel();
    final amt = _amount.text.trim();
    if (amt.isEmpty || num.tryParse(amt) == null) {
      setState(() {
        _quote = null;
        _quoteError = null;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 250), () async {
      final seq = ++_quoteSeq;
      try {
        final q = await widget.c.client.withdrawalQuote(
          asset: widget.asset,
          network: (chain == null || chain.param.isEmpty) ? null : chain.param,
          amount: amt,
        );
        if (!mounted || seq != _quoteSeq) return;
        setState(() {
          _quote = q;
          _quoteError = null;
        });
      } catch (e) {
        if (!mounted || seq != _quoteSeq) return;
        setState(() {
          // SHOWN, not swallowed: "below the minimum" and "this chain cannot be
          // priced" are the two most useful things the venue can say here.
          _quoteError = exSay(e);
          _quote = null;
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<AssetDepth>(
      what: 'the chains ${widget.asset} can leave on',
      load: () => widget.c.client.withdrawalOptions(widget.asset),
      builder: (context, d, reload) {
        final nets = d.networks;
        // The first OPEN chain, not the first chain: pre-selecting one that
        // cannot pay makes the user discover the closure by being refused.
        final fallback = d.firstOpen ?? (nets.isEmpty ? null : nets.first);
        final selected = _chain ?? fallback?.param;
        final chosen = nets.isEmpty
            ? null
            : nets.firstWhere((n) => n.param == selected,
                orElse: () => fallback ?? nets.first);

        return ExCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (nets.isEmpty)
                Text(
                  'The venue did not list a chain ${widget.asset} can leave '
                  'on. That is its answer, not a blank screen.',
                  style: const TextStyle(
                      fontSize: 13, color: Bk.muted, height: 1.4),
                )
              else ...[
                DropdownButtonFormField<String>(
                  isExpanded: true,
                  initialValue: selected,
                  decoration: const InputDecoration(
                      labelText: 'Network', isDense: true),
                  items: [
                    for (final n in nets)
                      DropdownMenuItem(
                        value: n.param,
                        // A closed chain is DISABLED, not hidden, and says so
                        // in its own option text with its availability.
                        enabled: n.open,
                        child: Text(
                          n.native
                              ? '${widget.asset} (native chain)'
                                  '${n.open ? ' — ${n.available} available' : ' — unavailable'}'
                              : '${networkLabel(n.network)}'
                                  '${n.open ? ' — ${n.available} available' : ' — unavailable'}',
                          style: TextStyle(color: n.open ? Bk.text : Bk.faint),
                        ),
                      ),
                  ],
                  onChanged: (v) {
                    if (v == null) return;
                    setState(() => _chain = v);
                    _requote(nets.firstWhere((n) => n.param == v,
                        orElse: () => nets.first));
                  },
                ),
                const SizedBox(height: 8),
                ExField(
                  'Available here',
                  ExText(chosen == null
                      ? kEmDash
                      : chosen.open
                          ? '${chosen.available} ${widget.asset}'
                          // Falls back to the venue's single-withdrawal cap
                          // rather than printing a zero that looks like "you
                          // have nothing".
                          : 'chain closed · cap ${d.maxSingleWithdrawal}'),
                ),
                if (chosen != null && !chosen.open) ...[
                  const SizedBox(height: 8),
                  ExAdvice(
                    chosen.note ??
                        'This chain cannot pay right now. Another chain for the '
                            'same asset may be open.',
                    tone: ExTone.warn,
                    icon: Icons.block,
                  ),
                ],
                const SizedBox(height: 12),
                TextField(
                  controller: _amount,
                  keyboardType:
                      const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))
                  ],
                  decoration: InputDecoration(
                    labelText: 'Amount (${widget.asset})',
                    isDense: true,
                    helperText:
                        _quote == null ? null : 'minimum ${_quote!.minimum}',
                  ),
                  // A STRING all the way to the wire. A figure that has been
                  // through a double has already lost its last digits.
                  onChanged: (_) => _requote(chosen),
                ),
                const SizedBox(height: 12),
                _DestinationField(
                  c: widget.c,
                  asset: widget.asset,
                  controller: _address,
                  manual: _manualAddress,
                  onManualChanged: (v) => setState(() => _manualAddress = v),
                ),
                const SizedBox(height: 12),
                if (_quoteError != null)
                  ExAdvice(_quoteError!,
                      tone: ExTone.warn, icon: Icons.info_outline),
                if (_quote != null)
                  _QuoteBlock(q: _quote!, asset: widget.asset),
                const SizedBox(height: 12),
                // LAST, immediately above the button, so the keyboard never
                // covers the one field that is typed from another device.
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  autofillHints: const [AutofillHints.oneTimeCode],
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: const InputDecoration(
                    labelText: 'Authenticator code',
                    isDense: true,
                    counterText: '',
                    helperText: 'Six digits, for this one withdrawal. The code '
                        'is spent when it is used.',
                    helperMaxLines: 3,
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  ExAdvice(_error!,
                      tone: ExTone.bad, icon: Icons.error_outline),
                ],
                if (_done != null) ...[
                  const SizedBox(height: 10),
                  ExAdvice(
                    'Requested: ${_done!.amount} ${_done!.asset}'
                    '${_done!.network == null ? '' : ' on ${networkLabel(_done!.network!)}'}, '
                    'fee ${_done!.fee}, you receive ${_done!.youReceive}. '
                    'State: ${_done!.state}.',
                    tone: ExTone.good,
                    icon: Icons.check_circle_outline,
                  ),
                ],
                const SizedBox(height: 14),
                FilledButton(
                  onPressed: _busy || chosen == null || !chosen.open
                      ? null
                      : () => _submit(chosen),
                  child:
                      Text(_busy ? 'Requesting…' : 'Withdraw ${widget.asset}'),
                ),
              ],
            ],
          ),
        );
      },
    );
  }

  Future<void> _submit(ChainDepth chain) async {
    final amount = _amount.text.trim();
    final address = _address.text.trim();
    final code = _code.text.trim();
    if (amount.isEmpty) {
      setState(() => _error = 'Enter an amount.');
      return;
    }
    if (address.isEmpty) {
      setState(() => _error = 'Pick or enter a destination address.');
      return;
    }
    if (code.length != 6) {
      setState(() => _error =
          'Enter the 6-digit code from your authenticator. Every withdrawal '
              'needs one; the venue refuses the request without it.');
      return;
    }
    final network = chain.param.isEmpty ? null : chain.param;
    // Reused if these exact terms were already submitted — see [_requestId].
    final terms = _termsKey(amount, address, network);
    if (_requestId == null || _requestIdFor != terms) {
      _requestId = ExchangeClient.newRequestId();
      _requestIdFor = terms;
    }
    final requestId = _requestId!;
    setState(() {
      _busy = true;
      _error = null;
      _done = null;
    });
    try {
      final r = await widget.c.client.requestWithdrawal(
        asset: widget.asset,
        network: network,
        amount: amount,
        address: address,
        totpCode: code,
        requestId: requestId,
      );
      if (!mounted) return;
      setState(() {
        _done = r;
        _busy = false;
      });
      // SPENT, SO IT IS RETIRED. The withdrawal exists; the next one the user
      // makes is a new instruction and must not collide with this key.
      _requestId = null;
      _requestIdFor = null;
      _amount.clear();
      // CLEARED BECAUSE IT IS SPENT. Leaving it in place invites a second
      // withdrawal with a code the venue has already consumed, which comes
      // back as "wrong or spent" and reads like a bug.
      _code.clear();
      widget.c.refreshTick.value++;
      await widget.c.loadAccount();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
        // The code is spent either way once the venue has seen it.
      });
      _code.clear();
    }
  }
}

/// The server's quote, as a key/value list rather than the web's four tiles —
/// four tiles in 299pt of content width are four unreadable tiles.
class _QuoteBlock extends StatelessWidget {
  const _QuoteBlock({required this.q, required this.asset});
  final WithdrawalQuote q;
  final String asset;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: Bk.bg2,
        borderRadius: BorderRadius.circular(Bk.rSm),
        border: Border.all(color: Bk.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ExField('Fee', ExText('${q.fee} $asset')),
          ExField('You receive', ExText('${q.youReceive} $asset', bold: true)),
          ExField('Minimum', ExText('${q.minimum} $asset')),
          // The gas asset is often NOT the asset being sent: an ERC-20 transfer
          // costs ETH, and that is why a USDT withdrawal can be closed while
          // the USDT balance is untouched.
          ExField('Network paid in', ExText(q.gasAsset)),
          if (q.note.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(q.note,
                style: const TextStyle(
                    fontSize: 12, color: Bk.muted, height: 1.35)),
          ],
          if (q.priceSource != null) ...[
            const SizedBox(height: 4),
            Text('Priced at ${fig(q.pricedAt)} (${q.priceSource}).',
                style: const TextStyle(fontSize: 11, color: Bk.faint)),
          ],
        ],
      ),
    );
  }
}

/// The destination: the allowlist as a picker, free text as the exception.
class _DestinationField extends StatelessWidget {
  const _DestinationField({
    required this.c,
    required this.asset,
    required this.controller,
    required this.manual,
    required this.onManualChanged,
  });

  final ExchangeController c;
  final String asset;
  final TextEditingController controller;
  final bool manual;
  final ValueChanged<bool> onManualChanged;

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<AllowlistView>(
      what: 'your withdrawal addresses',
      reloadOn: c.refreshTick,
      load: c.client.allowlist,
      builder: (context, v, reload) {
        final mine = v.forAsset(asset);
        final usable = mine.where((e) => e.usable).toList();
        if (manual || mine.isEmpty) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: controller,
                maxLength: 128,
                decoration: InputDecoration(
                  labelText: 'Destination address',
                  isDense: true,
                  counterText: '',
                  helperText: v.required
                      ? 'The venue only pays addresses on your allowlist, and '
                          'only ${v.cooldownHours}h after they are added.'
                      : null,
                  helperMaxLines: 3,
                ),
                style: kMono,
              ),
              if (mine.isNotEmpty)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: () => onManualChanged(false),
                    child: const Text('Pick from my allowlist instead'),
                  ),
                ),
            ],
          );
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: controller.text.isEmpty
                  ? (usable.isEmpty ? null : usable.first.address)
                  : controller.text,
              decoration: const InputDecoration(
                  labelText: 'Destination (allowlisted)', isDense: true),
              items: [
                for (final e in mine)
                  DropdownMenuItem(
                    value: e.address,
                    // A destination still inside its cooling-off period is
                    // shown and DISABLED, with how long is left: hiding it
                    // would look like the address was never added.
                    enabled: e.usable,
                    child: Text(
                      '${exShortAddress(e.address)}'
                      '${e.usable ? '' : ' — usable ${exUntil(e.usableAt)}'}',
                      style: TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12.5,
                          color: e.usable ? Bk.text : Bk.faint),
                    ),
                  ),
              ],
              onChanged: (val) {
                if (val != null) controller.text = val;
              },
            ),
            if (usable.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: ExAdvice(
                  'Every address you have added is still inside its '
                  'cooling-off period, so none of them can be paid yet. That '
                  'delay is the control, not a fault.',
                  tone: ExTone.warn,
                  icon: Icons.timer_outlined,
                ),
              ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () => onManualChanged(true),
                child: const Text('Type an address instead'),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// The withdrawal-address allowlist: list, add (with a code), remove (without).
///
/// REMOVE DELIBERATELY NEEDS NO CODE. Removal only ever narrows what can be
/// paid, and a control that is hard to loosen but easy to tighten is the right
/// way round — someone who suspects trouble should not be hunting for their
/// phone to take an address OFF the list.
class AllowlistPanel extends StatefulWidget {
  const AllowlistPanel({super.key, required this.c, required this.asset});
  final ExchangeController c;
  final String asset;

  @override
  State<AllowlistPanel> createState() => _AllowlistPanelState();
}

class _AllowlistPanelState extends State<AllowlistPanel> {
  final _address = TextEditingController();
  final _code = TextEditingController();
  bool _adding = false;
  bool _busy = false;
  String? _error;
  String? _notice;

  @override
  void dispose() {
    _address.dispose();
    _code.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<AllowlistView>(
      what: 'your withdrawal addresses',
      reloadOn: widget.c.refreshTick,
      load: widget.c.client.allowlist,
      builder: (context, v, reload) {
        final mine = v.forAsset(widget.asset);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ExHeader(
              title: 'Allowed destinations',
              note: v.note.isEmpty
                  ? 'A new address becomes usable ${v.cooldownHours} hours '
                      'after you add it.'
                  : v.note,
              trailing: v.required
                  ? const ExPill('REQUIRED', tone: ExTone.warn)
                  : null,
            ),
            if (mine.isEmpty && v.required)
              const ExAdvice(
                'You have no allowlisted destination for this asset, so the '
                'venue will refuse any withdrawal of it — whatever address you '
                'type. Add one below, then come back once its cooling-off '
                'period is over.',
                tone: ExTone.bad,
                icon: Icons.block,
              ),
            if (mine.isNotEmpty)
              ExDataRows(
                empty: 'None for ${widget.asset}.',
                rows: [
                  for (final e in mine)
                    ExDataRow(
                      leading: ChainIcon(e.asset, symbol: e.asset, radius: 12),
                      title: exShortAddress(e.address),
                      subtitle: '${e.asset} · added ${exWhen(e.addedAt)}',
                      fields: [
                        (
                          'Usable',
                          e.usable
                              ? const ExPill('now', tone: ExTone.good)
                              : ExPill(exUntil(e.usableAt), tone: ExTone.warn),
                        ),
                      ],
                      trailing: IconButton(
                        tooltip: 'Remove',
                        icon: const Icon(Icons.delete_outline, size: 18),
                        onPressed: _busy ? null : () => _remove(e, reload),
                      ),
                      footer: SelectableText(e.address,
                          style: kMono.copyWith(fontSize: 11, color: Bk.faint)),
                    ),
                ],
              ),
            const SizedBox(height: 10),
            if (!_adding)
              OutlinedButton.icon(
                onPressed: () => setState(() => _adding = true),
                icon: const Icon(Icons.add, size: 18),
                label: Text('Add a ${widget.asset} destination'),
              )
            else
              ExCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Add a ${widget.asset} destination',
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 8),
                    const ExAdvice(
                      'Adding a destination needs your authenticator code. If '
                      'a session alone could add one, somebody who had taken '
                      'over your session would add their own and the '
                      'allowlist would have cost them a single extra request.',
                      icon: Icons.lock_outline,
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _address,
                      maxLength: 128,
                      style: kMono,
                      decoration: const InputDecoration(
                        labelText: 'Address',
                        isDense: true,
                        counterText: '',
                      ),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: _code,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      autofillHints: const [AutofillHints.oneTimeCode],
                      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                      decoration: const InputDecoration(
                        labelText: 'Authenticator code',
                        isDense: true,
                        counterText: '',
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 10),
                      ExAdvice(_error!,
                          tone: ExTone.bad, icon: Icons.error_outline),
                    ],
                    if (_notice != null) ...[
                      const SizedBox(height: 10),
                      ExAdvice(_notice!,
                          tone: ExTone.good, icon: Icons.check_circle_outline),
                    ],
                    const SizedBox(height: 12),
                    Row(children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _busy
                              ? null
                              : () => setState(() {
                                    _adding = false;
                                    _error = null;
                                    _notice = null;
                                  }),
                          child: const Text('Cancel'),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: FilledButton(
                          onPressed: _busy ? null : () => _add(reload),
                          child: Text(_busy ? 'Adding…' : 'Add'),
                        ),
                      ),
                    ]),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }

  Future<void> _add(Future<void> Function() reload) async {
    final addr = _address.text.trim();
    final code = _code.text.trim();
    if (addr.isEmpty) {
      setState(() => _error = 'Enter the address.');
      return;
    }
    if (code.length != 6) {
      setState(
          () => _error = 'Enter the 6-digit code from your authenticator.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final e = await widget.c.client.addToAllowlist(
        asset: widget.asset,
        address: addr,
        totpCode: code,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _adding = false;
        _notice = 'Added. It becomes usable ${exUntil(e.usableAt)}.';
      });
      _address.clear();
      _code.clear();
      await reload();
      await widget.c.loadBadges();
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = exSay(err);
        _busy = false;
      });
      _code.clear();
    }
  }

  Future<void> _remove(AllowlistEntry e, Future<void> Function() reload) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.c.client
          .removeFromAllowlist(asset: e.asset, address: e.address);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _notice = 'Removed. Nothing can be paid to it now.';
      });
      await reload();
      await widget.c.loadBadges();
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = exSay(err);
        _busy = false;
      });
    }
  }
}

/// Withdrawals the venue is working on.
///
/// Renders MORE than the web does: `GET /v1/withdrawals` returns the fee, the
/// destination, the reason and the created-at, and app.html ignores all four —
/// including the reason, which is the only field that explains a stalled payout.
class WithdrawalsInProgress extends StatelessWidget {
  const WithdrawalsInProgress({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<List<WithdrawalRow>>(
      what: 'your withdrawals',
      reloadOn: c.refreshTick,
      load: c.client.withdrawals,
      builder: (context, rows, reload) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ExHeader(
            title: 'In progress',
            note: rows.isEmpty
                ? 'Nothing on its way out.'
                : '${rows.length} in progress.',
          ),
          ExDataRows(
            empty: 'Nothing on its way out.',
            rows: [
              for (final w in rows)
                ExDataRow(
                  leading: ChainIcon(w.asset, symbol: w.asset, radius: 12),
                  title: w.asset,
                  subtitle: w.network == null
                      ? 'native chain · ${exWhen(w.createdAt)}'
                      : '${networkLabel(w.network!)} · ${exWhen(w.createdAt)}',
                  fields: [
                    ('Amount', ExNum(w.amount)),
                    ('Fee', ExNum(w.fee)),
                    ('You get', ExNum(w.youReceive)),
                  ],
                  trailing: _pill(w.state),
                  footer: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SelectableText(w.address,
                          style: kMono.copyWith(fontSize: 11, color: Bk.faint)),
                      if (w.reason != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Text(w.reason!,
                              style: const TextStyle(
                                  fontSize: 12, color: Bk.warn, height: 1.35)),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }

  static Widget _pill(String state) => switch (state) {
        'confirmed' => const ExPill('confirmed', tone: ExTone.good),
        'rejected' => const ExPill('rejected', tone: ExTone.bad),
        'failed' => const ExPill('failed', tone: ExTone.bad),
        _ => ExPill(state),
      };
}
