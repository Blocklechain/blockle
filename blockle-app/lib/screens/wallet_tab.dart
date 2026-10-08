import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';
import '../widgets/particle_logo.dart';
import 'send.dart';
import 'receive.dart';
import 'swap.dart';
import 'queue.dart';

const _kTokens = 'bk_tokens';
const _storage = FlutterSecureStorage(
  aOptions: AndroidOptions(encryptedSharedPreferences: true),
);

class WalletTab extends StatefulWidget {
  const WalletTab({super.key});
  @override
  State<WalletTab> createState() => _WalletTabState();
}

class _WalletTabState extends State<WalletTab> {
  Map<String, dynamic>? _account;
  String? _priceUsd;
  List<Map<String, dynamic>> _tokens = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    final app = context.read<AppState>();
    final addr = app.store.address;
    final acct = await app.chain.account(addr);
    final price = await _fetchPrice();
    final toks = await _loadTokens(addr);
    if (!mounted) return;
    setState(() {
      _account = acct;
      _priceUsd = price;
      _tokens = toks;
      _loading = false;
    });
  }

  Future<String?> _fetchPrice() async {
    try {
      final r = await http
          .get(Uri.parse('https://blockle.org/api/buy/history'))
          .timeout(const Duration(seconds: 6));
      final hist = jsonDecode(r.body) as List;
      if (hist.isEmpty) return null;
      return (hist.last['price']).toString();
    } catch (_) {
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> _loadTokens(String? holderHex) async {
    final raw = await _storage.read(key: _kTokens);
    if (raw == null || raw.isEmpty) return [];
    final ids = (jsonDecode(raw) as List).cast<String>();
    final out = <Map<String, dynamic>>[];
    final hq = (holderHex != null && holderHex.isNotEmpty)
        ? '?holder=${Uri.encodeQueryComponent(holderHex)}'
        : '';
    for (final id in ids) {
      try {
        final r = await http
            .get(Uri.parse('https://blockle.org/api/token/$id$hq'))
            .timeout(const Duration(seconds: 6));
        final j = jsonDecode(r.body) as Map<String, dynamic>;
        final res = (j['result'] ?? j) as Map<String, dynamic>;
        out.add({'id': id, ...res});
      } catch (_) {
        out.add({'id': id, 'name': null, 'symbol': null});
      }
    }
    return out;
  }

  Future<void> _importToken() async {
    final ctrl = TextEditingController();
    final id = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Bk.surface,
        title: const Text('Import token'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(
              labelText: 'BLOCK-20 contract id (hex)',
              hintText: '64-character contract id'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, ctrl.text.trim()),
              child: const Text('Import')),
        ],
      ),
    );
    if (id == null || id.isEmpty) return;
    // verify it's a token before saving
    try {
      final r = await http.get(Uri.parse('https://blockle.org/api/token/$id'));
      final j = jsonDecode(r.body) as Map<String, dynamic>;
      final res = (j['result'] ?? j) as Map<String, dynamic>;
      if (res['isToken'] != true) {
        _snack('That contract is not a BLOCK-20 token.');
        return;
      }
    } catch (_) {
      _snack('Could not reach the token — check the contract id.');
      return;
    }
    final raw = await _storage.read(key: _kTokens);
    final ids = raw == null ? <String>[] : (jsonDecode(raw) as List).cast<String>();
    if (!ids.contains(id)) ids.add(id);
    await _storage.write(key: _kTokens, value: jsonEncode(ids));
    await _refresh();
  }

  void _snack(String m) {
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final addr = app.store.address ?? '—';
    final balFmt = _account?['balanceFmt'] ?? '—';
    final txs = (_account?['txs'] as List?) ?? [];

    return SafeArea(
      child: RefreshIndicator(
        onRefresh: _refresh,
        color: Bk.accent,
        backgroundColor: Bk.surface,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 28),
          children: [
            Row(
              children: [
                const SizedBox(width: 44, height: 44, child: ParticleLogo(size: 44)),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Blockle Wallet',
                          style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                      Text(_priceUsd != null ? '1 BLOCK ≈ \$$_priceUsd' : 'price —',
                          style: const TextStyle(color: Bk.muted, fontSize: 12)),
                    ],
                  ),
                ),
                IconButton(
                    onPressed: () => _walletSwitcher(app),
                    icon: const Icon(Icons.swap_horiz, color: Bk.muted)),
              ],
            ),
            const SizedBox(height: 18),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: const LinearGradient(colors: [Bk.surface, Bk.surface2]),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Bk.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Balance', style: TextStyle(color: Bk.muted, fontSize: 13)),
                  const SizedBox(height: 6),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Text(_loading ? '…' : '$balFmt',
                          style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w800)),
                      const SizedBox(width: 8),
                      const Text('BLOCK', style: TextStyle(color: Bk.muted)),
                    ],
                  ),
                  const SizedBox(height: 14),
                  InkWell(
                    onTap: () {
                      Clipboard.setData(ClipboardData(text: addr));
                      _snack('Address copied');
                    },
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(addr,
                              style: kMono.copyWith(fontSize: 12, color: Bk.muted),
                              overflow: TextOverflow.ellipsis),
                        ),
                        const Icon(Icons.copy, size: 15, color: Bk.muted),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                _action(Icons.south_west, 'Receive', () {
                  Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const ReceiveScreen()));
                }),
                const SizedBox(width: 10),
                _action(Icons.north_east, 'Send', () {
                  Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const SendScreen()))
                      .then((_) => _refresh());
                }),
                const SizedBox(width: 10),
                _action(Icons.swap_vert, 'Buy / Sell',
                    () => app.openBrowser('https://blockle.org/buy')),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                _action(Icons.swap_horiz, 'Swap', () {
                  Navigator.push(context,
                          MaterialPageRoute(builder: (_) => const SwapScreen()))
                      .then((_) => _refresh());
                }),
                const SizedBox(width: 10),
                _action(Icons.receipt_long, 'Queue', () {
                  Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const QueueScreen()));
                }),
                const SizedBox(width: 10),
                const Spacer(),
              ],
            ),
            const SizedBox(height: 22),
            Row(
              children: [
                const Text('Tokens',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                const Spacer(),
                TextButton.icon(
                    onPressed: _importToken,
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Import')),
              ],
            ),
            if (_tokens.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('No tokens imported. Import a BLOCK-20 by contract id.',
                    style: TextStyle(color: Bk.muted, fontSize: 13)),
              ),
            ..._tokens.map(_tokenRow),
            const SizedBox(height: 22),
            const Text('Activity',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 6),
            if (txs.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text('No transactions yet.',
                    style: TextStyle(color: Bk.muted, fontSize: 13)),
              ),
            ...txs.take(15).map((t) => _txRow(t as Map<String, dynamic>)),
          ],
        ),
      ),
    );
  }

  Widget _action(IconData ic, String label, VoidCallback onTap) {
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            color: Bk.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: Bk.border),
          ),
          child: Column(
            children: [
              Icon(ic, color: Bk.accent, size: 22),
              const SizedBox(height: 6),
              Text(label, style: const TextStyle(fontSize: 12)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _tokenRow(Map<String, dynamic> t) {
    final sym = (t['symbol'] ?? '?').toString();
    final name = (t['name'] ?? 'Unknown token').toString();
    final dec = (t['decimals'] as num?)?.toInt() ?? 0;
    final balRaw = t['balance'];
    String bal = '—';
    if (balRaw is num) {
      bal = dec > 0 ? (balRaw / _pow10(dec)).toStringAsFixed(dec > 6 ? 6 : dec) : balRaw.toString();
    }
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Bk.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Bk.border),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: Bk.accent.withValues(alpha: 0.18),
            child: Text(sym.isNotEmpty ? sym[0] : '?',
                style: const TextStyle(color: Bk.accent, fontWeight: FontWeight.w700)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sym, style: const TextStyle(fontWeight: FontWeight.w700)),
                Text(name, style: const TextStyle(color: Bk.muted, fontSize: 12)),
              ],
            ),
          ),
          Text(bal, style: kMono),
        ],
      ),
    );
  }

  Widget _txRow(Map<String, dynamic> t) {
    final txid = (t['txid'] ?? '').toString();
    final inc = t['incoming'] == true || t['direction'] == 'in';
    final val = (t['valueFmt'] ?? t['value'] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          Icon(inc ? Icons.south_west : Icons.north_east,
              size: 16, color: inc ? Bk.good : Bk.muted),
          const SizedBox(width: 10),
          Expanded(
            child: Text(txid.isNotEmpty ? '${txid.substring(0, txid.length.clamp(0, 18))}…' : 'transaction',
                style: kMono.copyWith(fontSize: 12, color: Bk.muted)),
          ),
          Text(val, style: const TextStyle(fontSize: 13)),
        ],
      ),
    );
  }

  double _pow10(int n) {
    var r = 1.0;
    for (var i = 0; i < n; i++) {
      r *= 10;
    }
    return r;
  }

  Future<void> _walletSwitcher(AppState app) async {
    final wallets = await app.store.list();
    if (!mounted) return;
    showModalBottomSheet(
      context: context,
      backgroundColor: Bk.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Your wallets', style: TextStyle(fontWeight: FontWeight.w700)),
            ),
            ...wallets.map((w) => ListTile(
                  leading: Icon(w.active ? Icons.radio_button_checked : Icons.radio_button_off,
                      color: w.active ? Bk.accent : Bk.muted),
                  title: Text(w.label),
                  subtitle: Text(w.address,
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: kMono.copyWith(fontSize: 11)),
                  trailing: w.watchOnly ? const Text('watch', style: TextStyle(color: Bk.muted, fontSize: 11)) : null,
                  onTap: () async {
                    final nav = Navigator.of(context);
                    await app.store.select(w.id);
                    app.refresh();
                    nav.pop();
                    _refresh();
                  },
                )),
            const SizedBox(height: 10),
          ],
        ),
      ),
    );
  }
}
