// activity_view.dart — the ACTIVITY surface (docs/design/wallet "ACTIVITY").
// The aggregated cross-chain feed from activity(), showing the security-decoder
// labels (same decode as the pre-sign preview) and FLAGGED counterparties inline.
// Honest "unavailable" notes per chain when no indexer is wired — never a fake
// empty feed. Read-only.

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../multichain/activity.dart' as act;
import '../../state/wallet_controller.dart';
import '../bots/bots_tokens.dart';
import 'wallet_widgets.dart';

class ActivityView extends StatefulWidget {
  const ActivityView({super.key});
  @override
  State<ActivityView> createState() => _ActivityViewState();
}

class _ActivityViewState extends State<ActivityView> {
  late Future<act.ActivityResult> _future;

  @override
  void initState() {
    super.initState();
    _future = context.read<WalletController>().loadActivity();
  }

  void _reload() => setState(() {
        _future = context.read<WalletController>().loadActivity();
      });

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return RefreshIndicator(
      color: t.accent,
      backgroundColor: t.surface,
      onRefresh: () async => _reload(),
      child: FutureBuilder<act.ActivityResult>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return Center(child: CircularProgressIndicator(color: t.accent));
          }
          final res = snap.data;
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 90),
            children: [
              const SectionHead(title: 'Activity', count: 'all chains'),
              if (res == null || res.items.isEmpty)
                WCard(child: _emptyOrNotes(t, res)),
              if (res != null && res.items.isNotEmpty)
                WCard(
                  child: Column(children: [
                    for (var i = 0; i < res.items.length; i++)
                      _row(t, res.items[i], last: i == res.items.length - 1),
                  ]),
                ),
              if (res != null && res.notes.isNotEmpty) ...[
                const SizedBox(height: 12),
                for (final n in res.notes) _note(t, '${n['note']}'),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _emptyOrNotes(BotTokens t, act.ActivityResult? res) => Padding(
        padding: const EdgeInsets.all(22),
        child: Column(children: [
          Icon(Icons.history, color: t.inkFaint, size: 30),
          const SizedBox(height: 10),
          Text(
            (res?.notes.isNotEmpty ?? false)
                ? 'No history to show yet — the per-chain indexers are not configured.'
                : 'No activity yet.',
            textAlign: TextAlign.center,
            style: TextStyle(color: t.inkMuted, fontSize: 13),
          ),
        ]),
      );

  Widget _row(BotTokens t, Map<String, dynamic> a, {required bool last}) {
    final wc = context.read<WalletController>();
    final kind = '${a['kind']}';
    final direction = '${a['direction']}';
    final flagged = a['flagged'] == true;
    final counterparty = a['counterparty'];
    final summary = a['summary'] == null ? _fallbackLead(kind, direction) : '${a['summary']}';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
      decoration: BoxDecoration(
        border: last ? null : Border(bottom: BorderSide(color: t.lineSoft)),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 34,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: t.elevated,
            border: Border.all(color: t.line),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(_iconFor(kind, direction), size: 16, color: t.inkMuted),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Flexible(
                child: Text(summary,
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: t.ink),
                    overflow: TextOverflow.ellipsis),
              ),
              if (flagged) ...[
                const SizedBox(width: 8),
                _flag(t),
              ],
            ]),
            const SizedBox(height: 2),
            Text(
              '${wc.chainLabel('${a['chain']}')} · ${a['status']}'
              '${counterparty != null ? ' · ${shortAddr('$counterparty')}' : ''}',
              style: TextStyle(fontSize: 12, color: t.inkMuted),
              overflow: TextOverflow.ellipsis,
            ),
          ]),
        ),
        if (a['amountBase'] != null) ...[
          const SizedBox(width: 10),
          Text(
            '${direction == 'in' ? '+' : direction == 'out' ? '−' : ''}${a['amountBase']}',
            style: TextStyle(
                fontSize: 12.5,
                color: direction == 'in'
                    ? t.gain
                    : direction == 'out'
                        ? t.ink
                        : t.inkMuted,
                fontFamily: kMonoFamily),
          ),
        ],
      ]),
    );
  }

  Widget _flag(BotTokens t) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(color: t.lossGhost, borderRadius: BorderRadius.circular(6)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.warning_amber_rounded, size: 11, color: t.loss),
          const SizedBox(width: 4),
          Text('flagged',
              style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: t.loss)),
        ]),
      );

  Widget _note(BotTokens t, String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.info_outline, size: 13, color: t.inkFaint),
          const SizedBox(width: 7),
          Expanded(
              child: Text(text, style: TextStyle(fontSize: 11.5, color: t.inkFaint, height: 1.4))),
        ]),
      );

  static String _fallbackLead(String kind, String direction) {
    switch (kind) {
      case 'approval':
        return 'Token approval';
      case 'token-transfer':
        return direction == 'in' ? 'Received token' : 'Sent token';
      case 'transfer':
        return direction == 'in' ? 'Received' : 'Sent';
      case 'nft':
        return 'NFT transfer';
      default:
        return 'Contract interaction';
    }
  }

  static IconData _iconFor(String kind, String direction) {
    if (kind == 'approval') return Icons.verified_user_outlined;
    if (kind == 'contract') return Icons.code;
    if (kind == 'nft') return Icons.image_outlined;
    if (direction == 'in') return Icons.south_west;
    if (direction == 'out') return Icons.north_east;
    return Icons.swap_horiz;
  }
}
