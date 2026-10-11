// cockpit_view.dart — COCKPIT (§5a): aggregate P&L hero + sparkline, a prominent
// Kill-all (in the top bar), a Paper/Live filter, and a grid of bot cards. All
// numbers come from BotRunner.aggregate()/dashboard() — the real persisted deal
// state, never mock data. Empty state invites creating the first bot.

import 'package:flutter/material.dart';

import '../../agent/bots.dart' as b;
import '../../state/bots_controller.dart';
import 'bots_tokens.dart';
import 'bots_widgets.dart';
import 'charts.dart';

enum BotFilter { all, paper, live }

class CockpitView extends StatelessWidget {
  const CockpitView({
    super.key,
    required this.controller,
    required this.filter,
    required this.onFilter,
    required this.onOpenBot,
    required this.onCreate,
  });

  final BotsController controller;
  final BotFilter filter;
  final ValueChanged<BotFilter> onFilter;
  final ValueChanged<String> onOpenBot;
  final VoidCallback onCreate;

  List<b.Bot> _filtered() {
    final all = controller.bots();
    switch (filter) {
      case BotFilter.paper:
        return all.where((x) => x.mode == 'paper').toList();
      case BotFilter.live:
        return all.where((x) => x.mode == 'live').toList();
      case BotFilter.all:
        return all;
    }
  }

  // Cumulative realized across every bot's CLOSED deals, ordered by close time —
  // the real P&L curve (empty when nothing has closed yet).
  List<double> _heroSeries() {
    final deals = <Map<String, dynamic>>[];
    for (final bot in controller.bots()) {
      for (final d in (bot.state['closedDeals'] as List? ?? const [])) {
        if (d is Map) deals.add(d.cast<String, dynamic>());
      }
    }
    deals.sort((a, c) => ((a['closedAt'] as int?) ?? 0).compareTo((c['closedAt'] as int?) ?? 0));
    final out = <double>[0];
    var cum = 0.0;
    for (final d in deals) {
      cum += (b.ucToUsd(d['realizedUc'] as BigInt?) ?? 0);
      out.add(cum);
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final bots = _filtered();

    num realized = 0, unrealized = 0, allocLive = 0, committedLive = 0;
    int paperCount = 0, liveCount = 0, totalDeals = 0, wins = 0, today = 0;
    final cutoff = DateTime.now().millisecondsSinceEpoch - 24 * 3600 * 1000;
    num todayUsd = 0;
    for (final bot in controller.bots()) {
      final d = controller.dashboard(bot.id);
      if (d == null) continue;
      realized += (d['realizedUsd'] as num?) ?? 0;
      unrealized += (d['unrealizedUsd'] as num?) ?? 0;
      totalDeals += (d['totalDeals'] as int?) ?? 0;
      wins += (d['winCount'] as int?) ?? 0;
      if (bot.mode == 'live') {
        liveCount++;
        allocLive += bot.allocationUsd;
        committedLive += (d['committedUsd'] as num?) ?? 0;
      } else {
        paperCount++;
      }
      for (final cd in (bot.state['closedDeals'] as List? ?? const [])) {
        if (cd is Map && ((cd['closedAt'] as int?) ?? 0) >= cutoff) {
          todayUsd += (b.ucToUsd(cd['realizedUc'] as BigInt?) ?? 0);
          today++;
        }
      }
    }
    final totalPnl = realized + unrealized;
    final series = _heroSeries();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 36),
      children: [
        // ---- hero + tiles ----
        LayoutBuilder(builder: (ctx, c) {
          final wide = c.maxWidth > 680;
          final hero = _HeroPnl(
            totalPnl: totalPnl,
            realized: realized,
            unrealized: unrealized,
            series: series,
          );
          final tiles = _Tiles(
            active: paperCount + liveCount,
            paper: paperCount,
            live: liveCount,
            committedLive: committedLive,
            allocLive: allocLive,
            todayUsd: todayUsd,
            todayDeals: today,
            wins: wins,
            totalDeals: totalDeals,
          );
          if (!wide) {
            return Column(children: [hero, const SizedBox(height: 16), tiles]);
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(flex: 11, child: hero),
              const SizedBox(width: 16),
              Expanded(flex: 10, child: tiles),
            ],
          );
        }),
        const SizedBox(height: 26),
        Row(
          children: [
            Text('Your bots',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: t.ink)),
            const SizedBox(width: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
              decoration: BoxDecoration(
                color: t.elevated,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: t.line),
              ),
              child: Text('${controller.bots().length}', style: mono(t, size: 12, color: t.inkFaint)),
            ),
          ],
        ),
        const SizedBox(height: 14),
        if (controller.bots().isEmpty)
          _EmptyState(onCreate: onCreate)
        else
          LayoutBuilder(builder: (ctx, c) {
            final cols = c.maxWidth > 760 ? 3 : (c.maxWidth > 500 ? 2 : 1);
            return GridView.count(
              crossAxisCount: cols,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisSpacing: 16,
              mainAxisSpacing: 16,
              childAspectRatio: 1.35,
              children: [
                for (final bot in bots) _BotGridCard(bot: bot, controller: controller, onOpen: () => onOpenBot(bot.id)),
              ],
            );
          }),
        const SizedBox(height: 22),
        const SafetyNote(
          child: Text.rich(TextSpan(children: [
            TextSpan(
                text: 'Non-custodial & gated. ',
                style: TextStyle(fontWeight: FontWeight.w700)),
            TextSpan(
                text:
                    'Keys never leave your device. Live bots trade fully auto within their allocation cap — '
                    'no per-order tap inside the cap — but every order still passes session caps, the allowlist, '
                    'the hash-chained audit, the 0.05% fee, and the kill switch. Mainnet stays off until you enable it.'),
          ])),
        ),
      ],
    );
  }
}

class _HeroPnl extends StatelessWidget {
  const _HeroPnl({
    required this.totalPnl,
    required this.realized,
    required this.unrealized,
    required this.series,
  });
  final num totalPnl, realized, unrealized;
  final List<double> series;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final up = totalPnl >= 0;
    return BotCard(
      padding: const EdgeInsets.fromLTRB(22, 22, 22, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Eyebrow('Portfolio P&L · all bots'),
          const SizedBox(height: 10),
          Text(
            moneyUsd(totalPnl),
            style: TextStyle(
              fontSize: 44,
              height: 1,
              fontWeight: FontWeight.w700,
              letterSpacing: -1.2,
              fontFamily: kMonoFamily,
              color: t.pnlColor(totalPnl),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'realized ${moneyUsd(realized)} · unrealized ${moneyUsd(unrealized)}',
            style: TextStyle(color: t.inkMuted, fontSize: 13),
          ),
          const SizedBox(height: 14),
          if (series.length >= 2)
            Sparkline(data: series, up: up, height: 72)
          else
            SizedBox(
              height: 72,
              child: Center(
                child: Text('No closed deals yet — your P&L curve appears here.',
                    style: TextStyle(color: t.inkFaint, fontSize: 12)),
              ),
            ),
        ],
      ),
    );
  }
}

class _Tiles extends StatelessWidget {
  const _Tiles({
    required this.active,
    required this.paper,
    required this.live,
    required this.committedLive,
    required this.allocLive,
    required this.todayUsd,
    required this.todayDeals,
    required this.wins,
    required this.totalDeals,
  });
  final int active, paper, live, todayDeals, wins, totalDeals;
  final num committedLive, allocLive, todayUsd;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final winRate = totalDeals > 0 ? (wins / totalDeals * 100).round() : null;
    Widget tile(String eyebrow, String value, String sub, {Color? vc}) => Container(
          color: t.surface,
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Eyebrow(eyebrow),
              const SizedBox(height: 7),
              Text(value, style: mono(t, size: 22, color: vc ?? t.ink, w: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(sub, style: TextStyle(fontSize: 12, color: t.inkMuted)),
            ],
          ),
        );
    return Container(
      decoration: BoxDecoration(
        color: t.lineSoft,
        borderRadius: BorderRadius.circular(BotTokens.radius),
        border: Border.all(color: t.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: GridView.count(
        crossAxisCount: 2,
        shrinkWrap: true,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 1,
        crossAxisSpacing: 1,
        childAspectRatio: 1.7,
        children: [
          tile('Active bots', '$active', '$paper paper · $live live'),
          tile('Allocation in use', moneyUsd(committedLive, sign: false),
              'of ${moneyUsd(allocLive, sign: false)} capped'),
          tile('Today', moneyUsd(todayUsd), 'across $todayDeals deals',
              vc: t.pnlColor(todayUsd)),
          tile('Win rate', winRate != null ? '$winRate%' : '—',
              '$wins of $totalDeals deals'),
        ],
      ),
    );
  }
}

/// The Paper/Live (+ All) segmented filter. Lives in the top bar (the shared
/// visual contract, docs/design/bots/index.html) and drives the cockpit grid.
class BotFilterSeg extends StatelessWidget {
  const BotFilterSeg({super.key, required this.filter, required this.onFilter});
  final BotFilter filter;
  final ValueChanged<BotFilter> onFilter;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    Widget seg(BotFilter f, String label) {
      final on = filter == f;
      return Semantics(
        button: true,
        selected: on,
        label: '$label filter',
        child: InkWell(
          onTap: () => onFilter(f),
          borderRadius: BorderRadius.circular(7),
          child: Container(
            constraints: const BoxConstraints(minHeight: 32),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: on ? t.elevated : Colors.transparent,
              borderRadius: BorderRadius.circular(7),
            ),
            child: Text(label,
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: on ? t.ink : t.inkMuted)),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: t.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: t.line),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        seg(BotFilter.all, 'All'),
        seg(BotFilter.paper, 'Paper'),
        seg(BotFilter.live, 'Live'),
      ]),
    );
  }
}

class _BotGridCard extends StatelessWidget {
  const _BotGridCard({required this.bot, required this.controller, required this.onOpen});
  final b.Bot bot;
  final BotsController controller;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    final d = controller.dashboard(bot.id) ?? const {};
    final pair = bot.pairs().isNotEmpty ? bot.pairs().first : '—';
    final pnl = ((d['realizedUsd'] as num?) ?? 0) + ((d['unrealizedUsd'] as num?) ?? 0);
    final used = (d['committedUsd'] as num?) ?? 0;
    final cap = bot.allocationUsd;
    final status = (d['status'] as String?) ?? 'paused';
    final typeLabel = bot.type[0].toUpperCase() + bot.type.substring(1);

    return BotCard(
      onTap: onOpen,
      padding: const EdgeInsets.fromLTRB(16, 15, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(bot.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: t.ink)),
                    const SizedBox(height: 2),
                    Text(pair, style: mono(t, size: 12, color: t.inkMuted)),
                  ],
                ),
              ),
              ModeBadge(live: bot.mode == 'live'),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 7,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              BotChip(typeLabel, accent: true),
              // Secondary mode chip (shared visual contract): a live bot runs
              // "auto · within cap"; a paper bot is "simulated".
              BotChip(bot.mode == 'live' ? 'auto · within cap' : 'simulated'),
              StatusDot(status: status),
            ],
          ),
          const Spacer(),
          Row(children: [
            Text('Allocation', style: TextStyle(fontSize: 12, color: t.inkMuted)),
            const Spacer(),
            Text('${moneyUsd(used, sign: false)} / ${moneyUsd(cap, sign: false)}',
                style: mono(t, size: 12, color: t.ink)),
          ]),
          const SizedBox(height: 6),
          AllocBar(fraction: cap > 0 ? used / cap : 0),
          const SizedBox(height: 12),
          Divider(height: 1, color: t.lineSoft),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Total P&L', style: TextStyle(fontSize: 12, color: t.inkMuted)),
                  Text(moneyUsd(pnl),
                      style: mono(t, size: 15, color: t.pnlColor(pnl), w: FontWeight.w600)),
                ],
              ),
              const Spacer(),
              // Per-card minispark of this bot's realized-P&L curve (its closed
              // deals, cumulative). Rendered only once there are >=2 points.
              if (_series(bot).length >= 2)
                SizedBox(
                  width: 72,
                  child: Sparkline(data: _series(bot), up: pnl >= 0, mini: true, height: 30),
                ),
            ],
          ),
        ],
      ),
    );
  }

  /// This bot's cumulative realized-P&L curve from its own closed deals, in
  /// close-time order (starts at 0). Empty/short until deals close.
  List<double> _series(b.Bot bot) {
    final deals = <Map<String, dynamic>>[];
    for (final d in (bot.state['closedDeals'] as List? ?? const [])) {
      if (d is Map) deals.add(d.cast<String, dynamic>());
    }
    deals.sort((a, c) => ((a['closedAt'] as int?) ?? 0).compareTo((c['closedAt'] as int?) ?? 0));
    final out = <double>[0];
    var cum = 0.0;
    for (final d in deals) {
      cum += (b.ucToUsd(d['realizedUc'] as BigInt?) ?? 0);
      out.add(cum);
    }
    return out;
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onCreate});
  final VoidCallback onCreate;
  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return BotCard(
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 34),
      child: Column(
        children: [
          Icon(Icons.smart_toy_outlined, size: 40, color: t.accent),
          const SizedBox(height: 14),
          Text('Create your first bot',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: t.ink)),
          const SizedBox(height: 6),
          Text(
            'Pick a template, choose a pair, set one amount. Bots start in paper — '
            'forward-test risk-free before you ever go live.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, color: t.inkMuted, height: 1.5),
          ),
          const SizedBox(height: 18),
          BotButton(label: 'Create a bot', icon: Icons.add, primary: true, onPressed: onCreate),
        ],
      ),
    );
  }
}
