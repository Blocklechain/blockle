// portfolio_view.dart — the PORTFOLIO home (docs/design/wallet "PORTFOLIO").
// Net-worth hero + 30-point sparkline (from portfolio() + the daily snapshot),
// a by-chain breakdown (stacked bar + legend — the dataviz method: one value
// axis, the categorical theme), and the holdings list with UNPRICED tokens shown
// but NOT counted. Send / Receive / Swap. All data is the REAL portfolio engine
// (portfolio.dart) over the live mark source — nothing mocked.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../multichain/chains/chain_adapter.dart' show formatUnits;
import '../../multichain/portfolio.dart' as pf;
import '../../state/app_state.dart';
import '../../state/wallet_controller.dart';
import '../bots/bots_tokens.dart';
import '../bots/charts.dart' show Sparkline;
import 'wallet_widgets.dart';

class PortfolioView extends StatefulWidget {
  const PortfolioView({super.key, required this.onSend});
  final void Function() onSend;
  @override
  State<PortfolioView> createState() => _PortfolioViewState();
}

class _PortfolioViewState extends State<PortfolioView> {
  late Future<pf.Portfolio> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<WalletController>().loadPortfolio();
  }

  void _reload() => setState(() {
        _future = context.read<WalletController>().loadPortfolio();
      });

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return RefreshIndicator(
      color: t.accent,
      backgroundColor: t.surface,
      onRefresh: () async => _reload(),
      child: FutureBuilder<pf.Portfolio>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return Center(child: CircularProgressIndicator(color: t.accent));
          }
          if (snap.hasError || snap.data == null) {
            return _error(t, '${snap.error ?? 'could not load portfolio'}');
          }
          return _body(t, snap.data!);
        },
      ),
    );
  }

  Widget _body(BotTokens t, pf.Portfolio p) {
    final wc = context.read<WalletController>();
    final spark = wc.nwSpark();
    final unpricedCount = p.unpriced.length;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
      children: [
        _hero(t, p, spark, unpricedCount),
        const SizedBox(height: 16),
        _byChain(t, p),
        SectionHead(title: 'Holdings', count: '${p.holdings.length}'),
        WCard(
          child: p.holdings.isEmpty
              ? _empty(t, 'No holdings yet — or the vault is locked.')
              : Column(
                  children: [
                    for (var i = 0; i < p.holdings.length; i++)
                      _holdingRow(t, p.holdings[i], last: i == p.holdings.length - 1),
                  ],
                ),
        ),
        const SizedBox(height: 12),
        _footnote(t, Icons.info_outline,
            'Unpriced tokens are shown but not counted in net worth — never guessed.'
            '${unpricedCount > 0 ? ' ($unpricedCount unpriced)' : ''}'),
      ],
    );
  }

  Widget _hero(BotTokens t, pf.Portfolio p, List<double> spark, int unpriced) {
    // today's change from the last two daily snapshots (honest — "—" if <2).
    String changeText = '';
    Color changeColor = t.inkMuted;
    if (spark.length >= 2) {
      final prev = spark[spark.length - 2];
      final now = spark.last;
      final d = now - prev;
      final pct = prev != 0 ? d / prev * 100 : 0;
      changeColor = d > 0 ? t.gain : (d < 0 ? t.loss : t.inkMuted);
      changeText =
          '${d >= 0 ? '▲ +' : '▼ '}${pct.toStringAsFixed(2)}%   ${d >= 0 ? '+' : '−'}\$${d.abs().toStringAsFixed(2)} today';
    }
    return WCard(
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('NET WORTH · ALL CHAINS',
            style: TextStyle(
                fontSize: 11, letterSpacing: 1.4, fontWeight: FontWeight.w600, color: t.inkFaint)),
        const SizedBox(height: 9),
        Text('\$${_grouped(p.totalUsd)}',
            style: TextStyle(
                fontSize: 42,
                height: 1,
                fontWeight: FontWeight.w700,
                letterSpacing: -1,
                color: t.ink,
                fontFamily: kMonoFamily)),
        const SizedBox(height: 7),
        Row(children: [
          if (changeText.isNotEmpty)
            Flexible(
              child: Text(changeText,
                  style: TextStyle(
                      fontSize: 13, color: changeColor, fontWeight: FontWeight.w600, fontFamily: kMonoFamily),
                  overflow: TextOverflow.ellipsis),
            )
          else
            Text('one snapshot so far — a trend builds daily',
                style: TextStyle(fontSize: 13, color: t.inkMuted)),
          if (unpriced > 0) ...[
            Text(' · ', style: TextStyle(color: t.inkFaint)),
            Text('$unpriced unpriced', style: TextStyle(fontSize: 13, color: t.inkMuted)),
          ],
        ]),
        const SizedBox(height: 14),
        SizedBox(
          height: 72,
          child: spark.length >= 2
              ? Sparkline(data: spark, up: spark.last >= spark.first)
              : Center(
                  child: Text('net-worth sparkline appears after a few daily snapshots',
                      style: TextStyle(fontSize: 11.5, color: t.inkFaint))),
        ),
        const SizedBox(height: 16),
        Row(children: [
          Expanded(child: _action(t, Icons.north_east, 'Send', primary: true, onTap: widget.onSend)),
          const SizedBox(width: 9),
          Expanded(
              child: _action(t, Icons.south_west, 'Receive',
                  onTap: () => context.read<AppState>().setTab(1))),
          const SizedBox(width: 9),
          Expanded(
              child: _action(t, Icons.swap_horiz, 'Swap',
                  onTap: () => context.read<AppState>().setTab(2))),
        ]),
      ]),
    );
  }

  Widget _action(BotTokens t, IconData ic, String label,
      {bool primary = false, required VoidCallback onTap}) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 11),
        decoration: BoxDecoration(
          color: primary ? t.accent : t.elevated,
          border: Border.all(color: primary ? t.accent : t.line),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(ic, size: 15, color: primary ? Colors.white : t.ink),
          const SizedBox(width: 7),
          Text(label,
              style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: primary ? Colors.white : t.ink)),
        ]),
      ),
    );
  }

  Widget _byChain(BotTokens t, pf.Portfolio p) {
    final chains = p.byChain.where((c) => (c['usd'] as num) > 0).toList();
    final wc = context.read<WalletController>();
    return WCard(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('BY CHAIN',
            style: TextStyle(
                fontSize: 11, letterSpacing: 1.4, fontWeight: FontWeight.w600, color: t.inkFaint)),
        const SizedBox(height: 14),
        if (chains.isEmpty)
          Text('nothing priced yet', style: TextStyle(fontSize: 13, color: t.inkMuted))
        else ...[
          ClipRRect(
            borderRadius: BorderRadius.circular(7),
            child: SizedBox(
              height: 12,
              child: Row(children: [
                for (final c in chains)
                  Expanded(
                    flex: ((c['pct'] as num) * 100).round().clamp(1, 1 << 20),
                    child: Container(
                      margin: const EdgeInsets.only(right: 2),
                      color: colorForChain('${c['chain']}', t),
                    ),
                  ),
              ]),
            ),
          ),
          const SizedBox(height: 16),
          for (final c in chains) _chainLegendRow(t, c, wc),
        ],
      ]),
    );
  }

  Widget _chainLegendRow(BotTokens t, Map<String, dynamic> c, WalletController wc) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Row(children: [
        Container(
          width: 9,
          height: 9,
          decoration: BoxDecoration(
              color: colorForChain('${c['chain']}', t), borderRadius: BorderRadius.circular(3)),
        ),
        const SizedBox(width: 10),
        Text(wc.chainLabel('${c['chain']}'), style: TextStyle(fontSize: 13, color: t.ink)),
        const Spacer(),
        Text('\$${_grouped((c['usd'] as num).toDouble())}',
            style: TextStyle(fontSize: 13, color: t.ink, fontFamily: kMonoFamily)),
        SizedBox(
          width: 56,
          child: Text('${(c['pct'] as num).toStringAsFixed(1)}%',
              textAlign: TextAlign.right,
              style: TextStyle(fontSize: 13, color: t.inkFaint, fontFamily: kMonoFamily)),
        ),
      ]),
    );
  }

  Widget _holdingRow(BotTokens t, Map<String, dynamic> h, {required bool last}) {
    final wc = context.read<WalletController>();
    final symbol = '${h['symbol']}';
    final amount = _amount('${h['amountBase']}', (h['decimals'] as num?)?.toInt() ?? 0);
    final priced = h['pricedOk'] == true;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 13),
      decoration: BoxDecoration(
        border: last ? null : Border(bottom: BorderSide(color: t.lineSoft)),
      ),
      child: Row(children: [
        TokenBubble(label: symbol),
        const SizedBox(width: 13),
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(symbol, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: t.ink)),
          Text(wc.chainLabel('${h['chain']}'), style: TextStyle(fontSize: 12, color: t.inkMuted)),
        ]),
        const Spacer(),
        Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
          Text('$amount $symbol',
              style: TextStyle(fontSize: 13, color: t.ink, fontFamily: kMonoFamily)),
          if (priced)
            Text('\$${_grouped((h['usd'] as num).toDouble())}',
                style: TextStyle(fontSize: 12, color: t.inkFaint, fontFamily: kMonoFamily))
          else
            const WTag('UNPRICED', bordered: true),
        ]),
      ]),
    );
  }

  Widget _footnote(BotTokens t, IconData ic, String text) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(ic, size: 14, color: t.inkFaint),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text, style: TextStyle(fontSize: 12, color: t.inkFaint, height: 1.4))),
        ],
      );

  Widget _empty(BotTokens t, String msg) => Padding(
        padding: const EdgeInsets.all(22),
        child: Center(child: Text(msg, style: TextStyle(color: t.inkMuted, fontSize: 13))),
      );

  Widget _error(BotTokens t, String msg) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Icon(Icons.error_outline, color: t.loss, size: 36),
            const SizedBox(height: 12),
            Text(msg, textAlign: TextAlign.center, style: TextStyle(color: t.inkMuted)),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: _reload, child: const Text('Retry')),
          ]),
        ),
      );

  static String _amount(String base, int decimals) {
    try {
      final s = formatUnits(base, decimals);
      final d = double.tryParse(s);
      if (d == null) return s;
      // trim to a sane number of significant figures for display
      if (d == d.roundToDouble() && d.abs() < 1e15) return _grouped(d, maxDec: 0);
      return _grouped(d, maxDec: 4);
    } catch (_) {
      return base;
    }
  }

  static String _grouped(double v, {int maxDec = 2}) {
    final neg = v < 0;
    final a = v.abs();
    final fixed = a.toStringAsFixed(maxDec);
    final parts = fixed.split('.');
    final intPart = parts[0];
    final buf = StringBuffer();
    for (var i = 0; i < intPart.length; i++) {
      if (i > 0 && (intPart.length - i) % 3 == 0) buf.write(',');
      buf.write(intPart[i]);
    }
    var out = buf.toString();
    if (parts.length > 1 && maxDec > 0) {
      var frac = parts[1].replaceAll(RegExp(r'0+$'), '');
      if (frac.isNotEmpty) out = '$out.$frac';
    }
    return neg ? '−$out' : out;
  }
}
