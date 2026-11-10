import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../services/chain.dart';
import '../services/open_url.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// Transaction queue — submitted BLOCK txs sit here with a live status until a
/// block includes them. Status comes from the explorer's /tx read (normalised
/// by Chain.tx): mined → confirmed · N; known but unmined → pending (in the
/// mempool); unknown → it was never accepted or was dropped, which is shown
/// honestly (after a short grace period for propagation) instead of spinning
/// as "pending" forever. Entries can be removed; the list auto-refreshes.
///
/// A second tab, History, lists the address's on-chain transactions from the
/// explorer (`/address/<addr>` history: {txid, height, time, kind, net}).
class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key});
  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

/// Resolved queue status for one txid.
enum TxQueueStatus { pending, confirmed, notFound }

/// Pure decision used by the screen (and tests): what a queue row should say
/// given the explorer read for a tx submitted at [submittedMs].
///
/// `null` tx (unknown to the node) is "pending" only within the first
/// [graceMs] after submission (propagation / explorer lag); after that it is
/// reported as not found — the wallet never saw it enter the mempool, so it
/// will not confirm on its own.
TxQueueStatus resolveQueueStatus(Map<String, dynamic>? tx, int submittedMs, int nowMs,
    {int graceMs = 3 * 60 * 1000}) {
  if (tx == null) {
    return (nowMs - submittedMs) < graceMs ? TxQueueStatus.pending : TxQueueStatus.notFound;
  }
  final mined = tx['mined'] == true || tx['block_hash'] != null || tx['height'] != null;
  return mined ? TxQueueStatus.confirmed : TxQueueStatus.pending;
}

class _QueueScreenState extends State<QueueScreen> {
  final Map<String, TxQueueStatus> _status = {};
  final Map<String, int?> _confs = {};
  bool _refreshing = false;
  Timer? _timer;
  List<Map<String, dynamic>> _history = [];
  bool _historyLoading = true;
  String? _historyAddr;

  @override
  void initState() {
    super.initState();
    _refresh();
    _loadHistory();
    // Blocks land every minute or so; keep the status live while the screen
    // is open (the manual refresh button still works).
    _timer = Timer.periodic(const Duration(seconds: 20), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    final app = context.read<AppState>();
    final addr = app.store.address;
    _historyAddr = addr;
    final acct = await app.chain.account(addr);
    if (!mounted) return;
    setState(() {
      _history = ((acct?['txs'] as List?) ?? const [])
          .whereType<Map>()
          .map((m) => m.cast<String, dynamic>())
          .toList();
      _historyLoading = false;
    });
  }

  Future<void> _refresh() async {
    if (_refreshing) return;
    final app = context.read<AppState>();
    if (mounted) setState(() => _refreshing = true);
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final p in List<Map<String, dynamic>>.from(app.pending)) {
      final txid = p['txid'] as String;
      final t = await app.chain.tx(txid);
      final st = resolveQueueStatus(t, (p['time'] as num?)?.toInt() ?? now, now);
      _status[txid] = st;
      _confs[txid] = st == TxQueueStatus.confirmed ? (t?['confirmations'] as num?)?.toInt() : null;
    }
    if (!mounted) return;
    setState(() => _refreshing = false);
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final pending = app.pending;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Transactions'),
          actions: [
            IconButton(
              onPressed: _refreshing
                  ? null
                  : () {
                      _refresh();
                      _loadHistory();
                    },
              icon: _refreshing
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.refresh),
            ),
          ],
          bottom: const TabBar(tabs: [Tab(text: 'Queue'), Tab(text: 'History')]),
        ),
        body: TabBarView(
          children: [
            ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Bk.surface2,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: Bk.border),
                  ),
                  child: const Text(
                    'A submitted transaction stays pending until a block includes it. '
                    'Swipe an entry away to remove it from this list.',
                    style: TextStyle(color: Bk.muted, fontSize: 13),
                  ),
                ),
                const SizedBox(height: 16),
                if (pending.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Text('No recent transactions.',
                        textAlign: TextAlign.center, style: TextStyle(color: Bk.muted)),
                  ),
                ...pending.map((p) => _row(app, p)),
              ],
            ),
            RefreshIndicator(
              color: Bk.accent,
              backgroundColor: Bk.surface,
              onRefresh: _loadHistory,
              child: _historyLoading
                  ? const Center(child: CircularProgressIndicator())
                  : ListView(
                      padding: const EdgeInsets.all(20),
                      children: [
                        if (_historyAddr == null || _historyAddr!.isEmpty)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 24),
                            child: Text('No wallet address yet.',
                                textAlign: TextAlign.center, style: TextStyle(color: Bk.muted)),
                          )
                        else if (_history.isEmpty)
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 24),
                            child: Text('No on-chain transactions for this address yet.',
                                textAlign: TextAlign.center, style: TextStyle(color: Bk.muted)),
                          ),
                        ..._history.map(historyRow),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(AppState app, Map<String, dynamic> p) {
    final txid = p['txid'] as String;
    final st = _status[txid] ?? TxQueueStatus.pending;
    final confN = _confs[txid];
    final Color color;
    final String label;
    switch (st) {
      case TxQueueStatus.confirmed:
        color = Bk.good;
        label = confN != null ? 'confirmed · $confN' : 'confirmed';
        break;
      case TxQueueStatus.notFound:
        color = Bk.bad;
        label = 'not found';
        break;
      case TxQueueStatus.pending:
        color = const Color(0xFFF2B04A);
        label = 'pending…';
        break;
    }
    return Dismissible(
      key: ValueKey('q:$txid'),
      direction: DismissDirection.endToStart,
      onDismissed: (_) => app.removePending(txid),
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 18),
        margin: const EdgeInsets.only(bottom: 10),
        decoration: BoxDecoration(
          color: Bk.bad.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(12),
        ),
        child: const Icon(Icons.delete_outline, color: Bk.bad),
      ),
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Bk.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(p['kind']?.toString() ?? 'Transaction',
                          style: const TextStyle(fontWeight: FontWeight.w700)),
                      const SizedBox(height: 2),
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        Flexible(
                          child: GestureDetector(
                            onTap: () => Clipboard.setData(ClipboardData(text: txid)),
                            child: Text('${txid.length > 24 ? txid.substring(0, 24) : txid}…',
                                style: kMono.copyWith(fontSize: 11, color: Bk.muted)),
                          ),
                        ),
                        const SizedBox(width: 6),
                        GestureDetector(
                          onTap: () => openExternal('https://blockle.org/tx/$txid'),
                          child: const Icon(Icons.open_in_new_rounded, size: 14, color: Bk.accent2),
                        ),
                      ]),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(label,
                      style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600)),
                ),
              ],
            ),
            if (st == TxQueueStatus.notFound) ...[
              const SizedBox(height: 8),
              const Text(
                'The node does not know this transaction — it was never accepted into '
                'the mempool (or was dropped), so nothing was sent. Your coins were not '
                'spent; you can try again.',
                style: TextStyle(color: Bk.muted, fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Human label for an explorer history entry.
String historyKindLabel(Map<String, dynamic> t) {
  final net = (t['net'] as num?) ?? 0;
  final kind = (t['kind'] ?? '').toString();
  if (kind == 'coinbase') return 'Mined reward';
  if (kind == 'contract') return 'Contract / swap';
  return net >= 0 ? 'Received' : 'Sent';
}

/// Signed BLOCK amount for an explorer history entry, e.g. "+1.5 BLOCK".
String historyAmountLabel(Map<String, dynamic> t) {
  final net = (t['net'] as num?) ?? 0;
  final sign = net > 0 ? '+' : (net < 0 ? '−' : '');
  return '$sign${Chain.fmt(net.abs())} BLOCK';
}

String _historyWhen(Map<String, dynamic> t) {
  final secs = (t['time'] as num?)?.toInt();
  final h = t['height'];
  if (secs == null) return h != null ? 'block $h' : '';
  final d = DateTime.fromMillisecondsSinceEpoch(secs * 1000);
  final diff = DateTime.now().difference(d);
  String ago;
  if (diff.inMinutes < 1) {
    ago = 'just now';
  } else if (diff.inHours < 1) {
    ago = '${diff.inMinutes} min ago';
  } else if (diff.inDays < 1) {
    ago = '${diff.inHours} h ago';
  } else {
    ago = '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  }
  return h != null ? '$ago · block $h' : ago;
}

/// One on-chain history row (explorer `/address/<addr>` history item).
Widget historyRow(Map<String, dynamic> t) {
  final txid = (t['txid'] ?? '').toString();
  final net = (t['net'] as num?) ?? 0;
  final inc = net > 0;
  final color = inc ? Bk.good : (net < 0 ? Bk.text : Bk.muted);
  return Container(
    margin: const EdgeInsets.only(bottom: 10),
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: Bk.surface,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: Bk.border),
    ),
    child: Row(
      children: [
        Icon(inc ? Icons.south_west : Icons.north_east, size: 18, color: inc ? Bk.good : Bk.muted),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(historyKindLabel(t), style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text(_historyWhen(t), style: const TextStyle(color: Bk.muted, fontSize: 12)),
              const SizedBox(height: 2),
              Row(mainAxisSize: MainAxisSize.min, children: [
                Flexible(
                  child: GestureDetector(
                    onTap: () => Clipboard.setData(ClipboardData(text: txid)),
                    child: Text(txid.isNotEmpty ? '${txid.substring(0, txid.length.clamp(0, 24))}…' : '',
                        style: kMono.copyWith(fontSize: 11, color: Bk.muted)),
                  ),
                ),
                if (txid.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  GestureDetector(
                    onTap: () => openExternal('https://blockle.org/tx/$txid'),
                    child: const Icon(Icons.open_in_new_rounded, size: 14, color: Bk.accent2),
                  ),
                ],
              ]),
            ],
          ),
        ),
        Text(historyAmountLabel(t),
            style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 13)),
      ],
    ),
  );
}
