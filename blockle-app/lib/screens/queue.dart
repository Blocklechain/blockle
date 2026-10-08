import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';

/// Transaction queue — BLOCK blocks are ~10 minutes, so submitted txs sit here
/// with a live pending→confirmed status until a block includes them.
class QueueScreen extends StatefulWidget {
  const QueueScreen({super.key});
  @override
  State<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends State<QueueScreen> {
  // txid -> 'pending' | 'confirmed:N' | 'confirmed'
  final Map<String, String> _status = {};
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    final app = context.read<AppState>();
    setState(() => _refreshing = true);
    for (final p in app.pending) {
      final txid = p['txid'] as String;
      final t = await app.chain.tx(txid);
      if (t != null && (t['confirmations'] != null || t['height'] != null)) {
        final c = t['confirmations'];
        _status[txid] = c != null ? 'confirmed:$c' : 'confirmed';
      } else {
        _status[txid] = 'pending';
      }
    }
    if (!mounted) return;
    setState(() => _refreshing = false);
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final pending = app.pending;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Transaction queue'),
        actions: [
          IconButton(
            onPressed: _refreshing ? null : _refresh,
            icon: _refreshing
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
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
              'Blocks are ~10 minutes, so a submitted transaction stays pending until the next block confirms it.',
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
          ...pending.map(_row),
        ],
      ),
    );
  }

  Widget _row(Map<String, dynamic> p) {
    final txid = p['txid'] as String;
    final st = _status[txid] ?? 'pending';
    final confirmed = st.startsWith('confirmed');
    final confN = st.startsWith('confirmed:') ? st.split(':')[1] : null;
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
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(p['kind']?.toString() ?? 'Transaction',
                    style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                GestureDetector(
                  onTap: () => Clipboard.setData(ClipboardData(text: txid)),
                  child: Text('${txid.substring(0, 24)}…',
                      style: kMono.copyWith(fontSize: 11, color: Bk.muted)),
                ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              color: (confirmed ? Bk.good : const Color(0xFFF2B04A)).withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Text(
              confirmed ? (confN != null ? 'confirmed · $confN' : 'confirmed') : 'pending…',
              style: TextStyle(
                  color: confirmed ? Bk.good : const Color(0xFFF2B04A),
                  fontSize: 12,
                  fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
