// screens/exchange/sections/ladders_section.dart — maker ladders.
//
// "Adding liquidity" on an order book is a LADDER OF RESTING ORDERS, not a
// pool. Nothing is swapped against a reserve, nothing earns a share of fees,
// and there is no LP token. It is a set of limit orders placed in one go.
//
// AND THE MAKER PAYS THE SAME FEE AS THE TAKER. There is no rebate on this
// venue, so a round trip costs the maker fee twice and a spread tighter than
// maker bps x 2 loses money on every fill pair. The venue computes that
// break-even and reports `loses: true`; this screen shows it before the builder
// rather than after, and the acknowledgement is only ever ticked by the user —
// `acceptLoss` is never defaulted true.
//
// DELIBERATELY NOT CALLED "LIQUIDITY", and deliberately not given the water
// drop: that word and that glyph are the app's own top-level Blockle Liquidity
// tab (nav index 6), which is a different product — a fee-funded treasury AMM.
// Reusing either here would tell the user they were looking at the other one.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../services/exchange_client.dart';
import '../../../state/exchange_controller.dart';
import '../../../theme.dart';
import '../exchange_ui.dart';
import 'panel_kit.dart';

class LaddersSection extends StatelessWidget {
  const LaddersSection({super.key, required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    final f = c.fees;
    return ExBody(children: [
      const ExHeader(
        title: 'Maker ladders',
        note: 'Resting bids and asks either side of a price, placed in one go.',
      ),
      ExAdvice(
        f == null
            ? 'A maker here pays the same fee as a taker — there is no rebate '
                'for resting an order, so a tight spread loses money on every '
                'round trip. The venue prices the exact break-even when you '
                'build a ladder below.'
            : 'A maker pays the same ${f.makerPct} as a taker. There is no '
                'rebate, so a ladder only breaks even at ${f.breakEvenBps} bps '
                'of spread — anything tighter loses money on every round trip, '
                'whatever the ladder fills.',
        tone: ExTone.warn,
        icon: Icons.warning_amber_rounded,
      ),
      const SizedBox(height: 16),
      _LadderBuilder(c: c),
      const SizedBox(height: 22),
      _LadderPositions(c: c),
    ]);
  }
}

class _LadderBuilder extends StatefulWidget {
  const _LadderBuilder({required this.c});
  final ExchangeController c;

  @override
  State<_LadderBuilder> createState() => _LadderBuilderState();
}

class _LadderBuilderState extends State<_LadderBuilder> {
  final _mid = TextEditingController();
  final _base = TextEditingController(text: '0');
  final _quote = TextEditingController(text: '0');
  int _spreadBps = 100;
  int _rungs = 3;

  String? _market;
  LadderQuote? _preview;
  String? _quoteError;
  Timer? _debounce;
  int _seq = 0;

  bool _accepted = false;
  bool _busy = false;
  String? _error;
  String? _notice;

  @override
  void dispose() {
    _debounce?.cancel();
    _mid.dispose();
    _base.dispose();
    _quote.dispose();
    super.dispose();
  }

  void _requote(String market) {
    _debounce?.cancel();
    final mid = _mid.text.trim();
    if (mid.isEmpty || num.tryParse(mid) == null) {
      setState(() {
        _preview = null;
        _quoteError = null;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 250), () async {
      final seq = ++_seq;
      try {
        final q = await widget.c.client.ladderQuote(
          market: market,
          mid: mid,
          spreadBps: _spreadBps,
          rungs: _rungs,
          baseCapital: _base.text.trim().isEmpty ? '0' : _base.text.trim(),
          quoteCapital: _quote.text.trim().isEmpty ? '0' : _quote.text.trim(),
        );
        if (!mounted || seq != _seq) return;
        setState(() {
          _preview = q;
          _quoteError = null;
          // A NEW QUOTE RESETS THE ACKNOWLEDGEMENT. A box ticked against one
          // spread must not carry over to a tighter one the user has not read.
          _accepted = false;
        });
      } catch (e) {
        if (!mounted || seq != _seq) return;
        setState(() {
          _quoteError = exSay(e);
          _preview = null;
          _accepted = false;
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final markets = widget.c.visibleMarkets;
    if (markets.isEmpty) {
      return ExCard(
        tone: widget.c.marketsError == null ? ExTone.plain : ExTone.bad,
        child: Text(widget.c.marketsError ?? 'No markets are listed yet.'),
      );
    }
    final sel = _market ?? widget.c.selected ?? markets.first.id;
    final m =
        markets.firstWhere((x) => x.id == sel, orElse: () => markets.first);

    return ExCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Build a ladder',
              style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            isExpanded: true,
            initialValue: m.id,
            decoration:
                const InputDecoration(labelText: 'Market', isDense: true),
            items: [
              for (final x in markets)
                DropdownMenuItem(value: x.id, child: Text(x.pair)),
            ],
            onChanged: (v) {
              if (v == null) return;
              setState(() => _market = v);
              _requote(v);
            },
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _mid,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))
            ],
            decoration: InputDecoration(
              labelText: 'Centre price (${m.quote})',
              isDense: true,
              helperText: m.lastText == null
                  // NULL IS NOT ZERO. A market that has never traded has no
                  // price to suggest, and suggesting one would be an invention.
                  ? 'This market has never traded, so there is no last price to '
                      'centre on. Pick one deliberately.'
                  : 'last ${m.lastText}',
              helperMaxLines: 3,
            ),
            onChanged: (_) => _requote(m.id),
          ),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: _Stepper(
                label: 'Spread (bps)',
                value: _spreadBps,
                min: 1,
                max: 10000,
                step: 10,
                onChanged: (v) {
                  setState(() => _spreadBps = v);
                  _requote(m.id);
                },
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _Stepper(
                label: 'Rungs',
                value: _rungs,
                min: 1,
                max: 20,
                step: 1,
                onChanged: (v) {
                  setState(() => _rungs = v);
                  _requote(m.id);
                },
              ),
            ),
          ]),
          const SizedBox(height: 10),
          TextField(
            controller: _base,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))
            ],
            // The labels rename themselves to the pair's own assets: "base
            // capital" means nothing until it says which coin it is.
            decoration: InputDecoration(
                labelText: '${m.base} to sell (asks)', isDense: true),
            onChanged: (_) => _requote(m.id),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _quote,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [
              FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))
            ],
            decoration: InputDecoration(
                labelText: '${m.quote} to spend (bids)', isDense: true),
            onChanged: (_) => _requote(m.id),
          ),
          const SizedBox(height: 12),
          if (_quoteError != null)
            ExAdvice(_quoteError!, tone: ExTone.warn, icon: Icons.info_outline),
          if (_preview != null) _Preview(q: _preview!, market: m),
          if (_preview != null && _preview!.loses) ...[
            const SizedBox(height: 8),
            CheckboxListTile(
              value: _accepted,
              onChanged: (v) => setState(() => _accepted = v ?? false),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: const Text(
                'I understand this spread is below break-even and loses money '
                'on every round trip.',
                style: TextStyle(fontSize: 12.5, height: 1.35),
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            ExAdvice(_error!, tone: ExTone.bad, icon: Icons.error_outline),
          ],
          if (_notice != null) ...[
            const SizedBox(height: 10),
            ExAdvice(_notice!,
                tone: ExTone.good, icon: Icons.check_circle_outline),
          ],
          const SizedBox(height: 12),
          FilledButton(
            onPressed:
                _busy || _preview == null || (_preview!.loses && !_accepted)
                    ? null
                    : () => _place(m.id),
            child: Text(_busy ? 'Placing…' : 'Place the ladder'),
          ),
        ],
      ),
    );
  }

  Future<void> _place(String market) async {
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final r = await widget.c.client.openLadder(
        market: market,
        mid: _mid.text.trim(),
        spreadBps: _spreadBps,
        rungs: _rungs,
        baseCapital: _base.text.trim().isEmpty ? '0' : _base.text.trim(),
        quoteCapital: _quote.text.trim().isEmpty ? '0' : _quote.text.trim(),
        // ONLY ever the box the user ticked.
        acceptLoss: _accepted,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _notice = 'Placed ${fig(r['orders'])} orders.'
            '${r['loses'] == true ? ' The venue still reports this spread as below break-even.' : ''}'
            '${r['note'] == null ? '' : ' ${r['note']}'}';
      });
      widget.c.refreshTick.value++;
      await widget.c.loadAccount();
      await widget.c.loadBadges();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = exSay(e);
        _busy = false;
      });
    }
  }
}

class _Preview extends StatelessWidget {
  const _Preview({required this.q, required this.market});
  final LadderQuote q;
  final ExchangeMarket market;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: Bk.bg2,
        borderRadius: BorderRadius.circular(Bk.rSm),
        border: Border.all(color: q.loses ? Bk.bad : Bk.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ExField('Bids', ExText('${q.bidCount}')),
          ExField('Asks', ExText('${q.askCount}')),
          ExField('${market.base} committed', ExText(q.baseNeeded)),
          ExField('${market.quote} committed', ExText(q.quoteNeeded)),
          ExField('Break-even', ExText('${q.breakEvenBps} bps')),
          if (q.note.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(q.note,
                style: TextStyle(
                    fontSize: 12,
                    height: 1.35,
                    color: q.loses ? Bk.bad : Bk.muted)),
          ],
        ],
      ),
    );
  }
}

class _Stepper extends StatelessWidget {
  const _Stepper({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.step,
    required this.onChanged,
  });
  final String label;
  final int value;
  final int min;
  final int max;
  final int step;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Bk.surface2,
        borderRadius: BorderRadius.circular(Bk.rMd),
        border: Border.all(color: Bk.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 11.5, color: Bk.muted)),
          Row(children: [
            IconButton(
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.remove, size: 16),
              onPressed: value <= min
                  ? null
                  : () => onChanged((value - step).clamp(min, max)),
            ),
            Expanded(
              child: Text('$value',
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontWeight: FontWeight.w700)),
            ),
            IconButton(
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.add, size: 16),
              onPressed: value >= max
                  ? null
                  : () => onChanged((value + step).clamp(min, max)),
            ),
          ]),
        ],
      ),
    );
  }
}

class _LadderPositions extends StatelessWidget {
  const _LadderPositions({required this.c});
  final ExchangeController c;

  @override
  Widget build(BuildContext context) {
    return ExAsyncPanel<List<LadderPosition>>(
      what: 'your ladders',
      reloadOn: c.refreshTick,
      load: c.client.ladders,
      builder: (context, rows, reload) {
        final open = rows.where((p) => p.open).length;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ExHeader(
              title: 'Your ladders',
              note: rows.isEmpty
                  ? 'None placed.'
                  : '$open open of ${rows.length}.',
            ),
            ExDataRows(
              empty: 'None placed.',
              rows: [
                for (final p in rows)
                  ExDataRow(
                    title: p.market,
                    subtitle: '${p.rungs} rungs · centre ${fig(p.mid)}'
                        ' · ${exWhen(p.createdAt)}',
                    fields: [
                      (
                        'Spread',
                        ExText('${(p.spreadBps / 100).toStringAsFixed(2)}%')
                      ),
                      ('Resting', ExNum(p.resting)),
                      ('Filled', ExNum(p.filled)),
                    ],
                    trailing: p.open
                        ? IconButton(
                            tooltip: 'Close',
                            icon: const Icon(Icons.close, size: 18),
                            onPressed: () => _close(context, p, reload),
                          )
                        : ExPill(p.state),
                  ),
              ],
            ),
          ],
        );
      },
    );
  }

  Future<void> _close(BuildContext context, LadderPosition p,
      Future<void> Function() reload) async {
    try {
      final r = await c.client.closeLadder(p.id);
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(
          'Cancelled ${r.cancelled} resting order'
          '${r.cancelled == 1 ? '' : 's'}.'
          // NAMED, NOT HIDDEN: a ladder that did its job is mostly filled, and
          // those fills were real trades that are not reversed by closing it.
          '${r.alreadyFilledOrGone == 0 ? '' : ' ${r.alreadyFilledOrGone} rung${r.alreadyFilledOrGone == 1 ? '' : 's'} had already filled or gone — those were real trades and are not reversed.'}',
        ),
      ));
      await reload();
      await c.loadAccount();
      await c.loadBadges();
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not close: ${exSay(e)}')));
    }
  }
}
