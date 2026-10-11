// detail_view.dart — BOT DETAIL (§4/§5a): the active deal as a vertical stepper
// (base -> safety fills -> next armed -> take-profit), realized/unrealized P&L
// tiles, allocation + win rate, and controls (pause/resume/edit/clone/stop +
// per-bot kill). Everything reads the real persisted deal state; controls call
// only the BotRunner's gated lifecycle methods.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../agent/bots.dart' as b;
import '../../agent/notify.dart' show formatQty;
import '../../state/bots_controller.dart';
import 'bots_tokens.dart';
import 'bots_widgets.dart';

class DetailView extends StatelessWidget {
  const DetailView({
    super.key,
    required this.controller,
    required this.botId,
    required this.onBack,
    required this.onClonedTo,
  });
  final BotsController controller;
  final String botId;
  final VoidCallback onBack;
  final ValueChanged<String> onClonedTo;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final bot = controller.bot(botId);
    if (bot == null) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text('Bot not found.', style: TextStyle(color: t.inkMuted)),
          const SizedBox(height: 10),
          BotButton(label: 'Back to cockpit', onPressed: onBack),
        ]),
      );
    }
    final d = controller.dashboard(botId) ?? const {};
    final deal = _openDeal(bot);
    final pair = bot.pairs().isNotEmpty ? bot.pairs().first : '—';

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 36),
      children: [
        Row(children: [
          InkWell(
            onTap: onBack,
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.all(6),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.arrow_back, size: 18, color: t.inkMuted),
                const SizedBox(width: 4),
                Text('Cockpit', style: TextStyle(color: t.inkMuted, fontSize: 13)),
              ]),
            ),
          ),
        ]),
        const SizedBox(height: 8),
        LayoutBuilder(builder: (ctx, c) {
          final dealCard = _dealCard(context, bot, deal, pair, d);
          final perfCard = _perfCard(context, bot, d);
          if (c.maxWidth > 760) {
            return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(flex: 5, child: dealCard),
              const SizedBox(width: 16),
              Expanded(flex: 4, child: perfCard),
            ]);
          }
          return Column(children: [dealCard, const SizedBox(height: 16), perfCard]);
        }),
      ],
    );
  }

  Map<String, dynamic>? _openDeal(b.Bot bot) {
    final byPair = (bot.state['byPair'] as Map?) ?? const {};
    for (final k in byPair.keys) {
      final ps = byPair[k] as Map?;
      final deal = ps?['deal'];
      if (deal is Map && deal['status'] != 'closed') return deal.cast<String, dynamic>();
    }
    return null;
  }

  Widget _dealCard(BuildContext context, b.Bot bot, Map<String, dynamic>? deal,
      String pair, Map<String, dynamic> d) {
    final t = BotTheme.of(context);
    final typeLabel = bot.type[0].toUpperCase() + bot.type.substring(1);
    return BotCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            BotChip(typeLabel, accent: true),
            const SizedBox(width: 12),
            Expanded(
              child: Text(bot.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: t.ink)),
            ),
            ModeBadge(live: bot.mode == 'live'),
          ]),
          const SizedBox(height: 6),
          Row(children: [
            StatusDot(status: (d['status'] as String?) ?? 'paused'),
            const SizedBox(width: 10),
            Text(pair, style: mono(t, size: 12, color: t.inkMuted)),
          ]),
          const SizedBox(height: 14),
          if (deal == null)
            _noDeal(t, bot)
          else
            _Stepper(bot: bot, deal: deal),
          const SizedBox(height: 18),
          _controls(context, bot),
        ],
      ),
    );
  }

  Widget _noDeal(BotTokens t, b.Bot bot) {
    final waiting = bot.enabled;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 18),
      decoration: BoxDecoration(
        color: t.elevated,
        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
        border: Border.all(color: t.line),
      ),
      child: Row(children: [
        Icon(waiting ? Icons.hourglass_empty : Icons.pause_circle_outline,
            color: t.inkMuted, size: 20),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            waiting
                ? 'No open deal yet — the bot opens one on its next tick once market data is available.'
                : 'Paused — no open deal. Resume to let the bot open a deal on its schedule.',
            style: TextStyle(color: t.inkMuted, fontSize: 13, height: 1.4),
          ),
        ),
      ]),
    );
  }

  Widget _controls(BuildContext context, b.Bot bot) {
    final running = bot.enabled;
    return Wrap(spacing: 9, runSpacing: 9, children: [
      if (running)
        BotButton(label: 'Pause', icon: Icons.pause, onPressed: () => controller.pause(bot.id))
      else
        BotButton(
            label: 'Resume',
            icon: Icons.play_arrow,
            onPressed: () => _resume(context, bot)),
      BotButton(label: 'Edit', icon: Icons.tune, onPressed: () => _edit(context, bot)),
      BotButton(
          label: 'Clone',
          icon: Icons.copy_all_outlined,
          onPressed: () {
            final c = controller.clone(bot.id);
            ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Cloned as a new paper bot.')));
            onClonedTo(c.id);
          }),
      BotButton(label: 'Stop', icon: Icons.stop, onPressed: () => controller.stop(bot.id)),
      BotButton(
          label: 'Kill bot',
          icon: Icons.power_settings_new,
          danger: true,
          onPressed: () => _killBot(context, bot)),
    ]);
  }

  Future<void> _resume(BuildContext context, b.Bot bot) async {
    if (bot.mode == 'paper') {
      await controller.enablePaper(bot.id);
      return;
    }
    // Live resume is deliberate — a short confirm, then re-arm through the gate.
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) {
        final t = BotTheme.of(context);
        return AlertDialog(
          backgroundColor: t.surface,
          title: const Text('Resume live bot'),
          content: Text(
              'Re-arm "${bot.name}" live within its ${moneyUsd(bot.allocationUsd, sign: false)} '
              'allocation cap. Orders will run auto within the cap.',
              style: TextStyle(color: t.inkMuted, fontSize: 13)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(dctx, true), child: const Text('Arm live')),
          ],
        );
      },
    );
    if (ok != true) return;
    try {
      await controller.armLive(bot.id, allocationUsd: bot.allocationUsd);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(e.toString().replaceFirst('StateError: ', ''))));
      }
    }
  }

  Future<void> _edit(BuildContext context, b.Bot bot) async {
    final ctrl = TextEditingController(text: bot.allocationUsd.toStringAsFixed(0));
    final t = BotTheme.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: t.surface,
        title: const Text('Edit allocation'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(
              'Adjust the hard allocation cap. For a LIVE bot this re-arms it through '
              'the gate with the new cap. Advanced safety-order edits: clone the bot.',
              style: TextStyle(color: t.inkMuted, fontSize: 12.5)),
          const SizedBox(height: 12),
          TextField(
            controller: ctrl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
            decoration: const InputDecoration(labelText: 'Allocation USD', prefixText: '\$'),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dctx, true), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true) return;
    final v = double.tryParse(ctrl.text.trim()) ?? bot.allocationUsd;
    if (bot.mode == 'live' && bot.enabled) {
      try {
        await controller.armLive(bot.id, allocationUsd: v);
      } catch (e) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(e.toString().replaceFirst('StateError: ', ''))));
        }
      }
    } else {
      bot.allocationUsd = v;
      controller.refresh();
    }
  }

  Future<void> _killBot(BuildContext context, b.Bot bot) async {
    final t = BotTheme.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: t.surface,
        title: const Text('Kill this bot'),
        content: Text(
            'Immediately stop "${bot.name}" and disable it. Any open deal is preserved. '
            'Use Kill-all in the top bar to stop every bot and lock the vault.',
            style: TextStyle(color: t.inkMuted, fontSize: 13)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text('Cancel')),
          FilledButton(
              style: FilledButton.styleFrom(backgroundColor: t.loss),
              onPressed: () => Navigator.pop(dctx, true),
              child: const Text('Kill bot')),
        ],
      ),
    );
    if (ok == true) await controller.pause(bot.id);
  }

  Widget _perfCard(BuildContext context, b.Bot bot, Map<String, dynamic> d) {
    final t = BotTheme.of(context);
    final unreal = (d['unrealizedUsd'] as num?);
    final realized = (d['realizedUsd'] as num?) ?? 0;
    final totalDeals = (d['totalDeals'] as int?) ?? 0;
    final wins = (d['winCount'] as int?) ?? 0;
    final winRate = totalDeals > 0 ? (wins / totalDeals * 100).round() : null;
    final committed = (d['committedUsd'] as num?) ?? 0;
    final cap = bot.allocationUsd;
    final dd = (d['maxDrawdownUsd'] as num?) ?? 0;

    Widget tile(String eyebrow, Widget value, String? sub) => Container(
          padding: const EdgeInsets.all(15),
          decoration: BoxDecoration(
            color: t.elevated,
            borderRadius: BorderRadius.circular(BotTokens.radiusSm),
            border: Border.all(color: t.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Eyebrow(eyebrow),
              const SizedBox(height: 8),
              value,
              if (sub != null) ...[
                const SizedBox(height: 4),
                Text(sub, style: TextStyle(fontSize: 12, color: t.inkMuted)),
              ],
            ],
          ),
        );

    return BotCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Eyebrow('Performance'),
          const SizedBox(height: 12),
          GridView.count(
            crossAxisCount: 2,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisSpacing: 12,
            mainAxisSpacing: 12,
            childAspectRatio: 1.9,
            children: [
              tile(
                'Unrealized',
                Text(unreal == null ? '—' : moneyUsd(unreal),
                    style: mono(t, size: 22, color: unreal == null ? t.inkMuted : t.pnlColor(unreal), w: FontWeight.w600)),
                unreal == null ? 'awaiting market data' : 'mark-to-market',
              ),
              tile(
                'Realized ($totalDeals deals)',
                Text(moneyUsd(realized),
                    style: mono(t, size: 22, color: t.pnlColor(realized), w: FontWeight.w600)),
                totalDeals > 0 ? 'avg ${moneyUsd(realized / totalDeals)} / deal' : 'no closed deals',
              ),
              tile(
                'Allocation used',
                Row(crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic, children: [
                  Text(moneyUsd(committed, sign: false),
                      style: mono(t, size: 20, color: t.ink, w: FontWeight.w600)),
                  Text(' / ${moneyUsd(cap, sign: false)}',
                      style: mono(t, size: 13, color: t.inkFaint)),
                ]),
                null,
              ),
              tile(
                'Win rate',
                Text(winRate != null ? '$winRate%' : '—',
                    style: mono(t, size: 22, color: t.ink, w: FontWeight.w600)),
                '$wins of $totalDeals · max DD ${moneyUsd(dd, sign: false)}',
              ),
            ],
          ),
          const SizedBox(height: 18),
          SafetyNote(
            icon: Icons.shield_outlined,
            child: Text.rich(TextSpan(children: [
              const TextSpan(
                  text: 'Profit pop-ups are on. ',
                  style: TextStyle(fontWeight: FontWeight.w700)),
              TextSpan(
                  text:
                      'When a deal closes into a stablecoin in profit you get a notification like ',
                  style: TextStyle(color: t.inkFaint)),
              TextSpan(
                  text: '“+\$5.97 — sold 1.7 SOL → USDC”.',
                  style: TextStyle(color: t.gain, fontWeight: FontWeight.w600)),
            ])),
          ),
        ],
      ),
    );
  }
}

/// The deal timeline as a vertical stepper (done fills -> next armed -> TP).
class _Stepper extends StatelessWidget {
  const _Stepper({required this.bot, required this.deal});
  final b.Bot bot;
  final Map<String, dynamic> deal;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final base = b.splitPair(bot.pairs().isNotEmpty ? bot.pairs().first : 'X/USDC')[0];
    final bd = b.decimalsFor(base);
    final fills = (deal['fills'] as List? ?? const []).cast<Map<String, dynamic>>();

    final steps = <_StepData>[];
    var soIdx = 0;
    for (final f in fills) {
      final kind = '${f['kind']}';
      final priceUsd = b.ucToUsd(f['priceUc'] as BigInt?) ?? 0;
      final qty = f['qty'] as BigInt? ?? BigInt.zero;
      final usd = b.ucToUsd((f['costUc'] ?? f['proceedsUc']) as BigInt?) ?? 0;
      String label;
      if (f['side'] == 'sell') {
        label = kind == 'tp' ? 'Take-profit sold' : kind == 'sl' ? 'Stop-loss sold' : 'Sold';
      } else if (kind == 'base') {
        label = 'Base order filled';
      } else {
        soIdx++;
        label = 'Safety order $soIdx filled';
      }
      steps.add(_StepData(
        state: 'done',
        label: label,
        meta: 'entry \$${priceUsd.toStringAsFixed(2)}${f['paper'] == true ? ' · paper' : ''}',
        amount: '${formatQty(qty, decimals: bd)} $base',
        sub: moneyUsd(usd, sign: false),
      ));
    }

    // Active + pending steps for an open DCA deal.
    if (bot.type == 'dca' && deal['status'] != 'closed') {
      final cfg = bot.config;
      final used = (deal['safetyOrdersUsed'] as int?) ?? 0;
      final maxSo = (cfg['maxSafetyOrders'] as num?)?.toInt() ?? 0;
      final tpArmed = deal['tpArmed'] == true;
      final nextTrig = b.ucToUsd(deal['nextTriggerUc'] as BigInt?) ?? 0;
      if (!tpArmed && used < maxSo && (deal['filledQty'] as BigInt? ?? BigInt.zero) > BigInt.zero) {
        steps.add(_StepData(
          state: 'active',
          label: 'Safety order ${used + 1} armed',
          meta: 'triggers at \$${nextTrig.toStringAsFixed(2)} (−${cfg['safetyStepPct']}%)',
          amount: 'waiting',
          sub: '',
        ));
      }
      final avg = b.ucToUsd(deal['avgEntryUc'] as BigInt?) ?? 0;
      final tpPct = (cfg['takeProfitPct'] as num?)?.toDouble() ?? 0;
      final tpTarget = avg * (1 + tpPct / 100);
      steps.add(_StepData(
        state: tpArmed ? 'active' : 'pending',
        label: tpArmed ? 'Take-profit armed (trailing)' : 'Take-profit',
        meta: '+${tpPct.toStringAsFixed(1)}% from avg \$${avg.toStringAsFixed(2)}',
        amount: '\$${tpTarget.toStringAsFixed(2)}',
        sub: 'target',
      ));
    }

    if (steps.isEmpty) {
      return Text('No fills yet.', style: TextStyle(color: t.inkMuted, fontSize: 13));
    }

    return Column(
      children: [
        for (var i = 0; i < steps.length; i++)
          _StepRow(data: steps[i], index: i, last: i == steps.length - 1),
      ],
    );
  }
}

class _StepData {
  final String state; // done | active | pending
  final String label, meta, amount, sub;
  _StepData({required this.state, required this.label, required this.meta, required this.amount, required this.sub});
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.data, required this.index, required this.last});
  final _StepData data;
  final int index;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final done = data.state == 'done';
    final active = data.state == 'active';
    final ringColor = done ? t.gain : (active ? t.accent : t.line);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(children: [
            Container(
              width: 26,
              height: 26,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: done ? t.gain : t.surface,
                border: Border.all(color: ringColor, width: 2),
              ),
              alignment: Alignment.center,
              child: done
                  ? Icon(Icons.check, size: 14, color: t.isDark ? const Color(0xFF06241A) : Colors.white)
                  : Text(active ? '${index + 1}' : '▲',
                      style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          color: active ? t.accent : t.inkFaint)),
            ),
            if (!last)
              Expanded(
                child: Container(width: 2, color: done ? t.gain : t.line),
              ),
          ]),
          const SizedBox(width: 13),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(data.label,
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: t.ink)),
                    const SizedBox(height: 2),
                    Text(data.meta, style: TextStyle(fontSize: 12, color: t.inkMuted)),
                  ]),
                ),
                Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Text(data.amount, style: mono(t, size: 13, color: t.ink)),
                  if (data.sub.isNotEmpty)
                    Text(data.sub, style: mono(t, size: 11, color: t.inkFaint)),
                ]),
              ]),
            ),
          ),
        ],
      ),
    );
  }
}
