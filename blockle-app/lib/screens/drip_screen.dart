// drip_screen.dart — BLOCKLE DRIP: claim free BLOCK every 24 hours from the
// funded giveaway wallet. The server meters claims (per account AND per
// address) and sends REAL on-chain BLOCK; this screen just shows the pool,
// today's reward, the countdown, and fires the claim to YOUR block1… address.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../state/multichain_controller.dart';
import '../theme.dart';
import 'account_auth_screen.dart';

const String _kDripBase = 'https://blockle.org';

class DripScreen extends StatefulWidget {
  const DripScreen({super.key});
  @override
  State<DripScreen> createState() => _DripScreenState();
}

class _DripScreenState extends State<DripScreen> {
  Map<String, dynamic>? _state;
  String? _myAddress;
  String? _error;
  String? _lastTxid;
  double? _lastAmount;
  bool _busy = false;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _refresh();
    // 1s tick only re-renders the countdown; no network.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _nextClaimAt > 0) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  int get _nextClaimAt => ((_state?['nextClaimAt'] as num?) ?? 0).toInt();

  Future<void> _refresh() async {
    final mc = context.read<MultichainController>();
    try {
      final acct = await mc.addressFor('block');
      if (mounted) setState(() => _myAddress = acct?.address);
    } catch (_) {}
    try {
      final token = mc.agent.acctToken;
      final r = await http.get(
        Uri.parse('$_kDripBase/account/api/drip/state'),
        headers: token != null ? {'authorization': 'Bearer $token'} : const {},
      ).timeout(const Duration(seconds: 10));
      if (r.statusCode == 200 && mounted) {
        setState(() {
          _state = (jsonDecode(r.body) as Map).cast<String, dynamic>();
          _error = null;
        });
      }
    } catch (_) {
      if (mounted && _state == null) {
        setState(() => _error = 'Could not reach the drip server — check your connection.');
      }
    }
  }

  Future<void> _claim() async {
    final mc = context.read<MultichainController>();
    if (mc.agent.acctToken == null) {
      final ok = await requireAccount(context,
          reason: 'The daily drip is one claim per Blockle account — sign in (free) '
              'so your 24-hour timer can be tracked.');
      if (!ok || !mounted) return;
    }
    final to = _myAddress;
    if (to == null || to.isEmpty) {
      setState(() => _error = 'No BLOCK address in this wallet yet.');
      return;
    }
    setState(() { _busy = true; _error = null; _lastTxid = null; });
    try {
      final token = mc.agent.acctToken;
      final r = await http.post(
        Uri.parse('$_kDripBase/account/api/drip/claim'),
        headers: {
          'content-type': 'application/json',
          if (token != null) 'authorization': 'Bearer $token',
        },
        body: jsonEncode({'address': to}),
      ).timeout(const Duration(seconds: 25));
      final j = (jsonDecode(r.body) as Map).cast<String, dynamic>();
      if (r.statusCode == 200 && j['ok'] == true) {
        setState(() {
          _lastTxid = j['txid'] as String?;
          _lastAmount = (j['amount'] as num?)?.toDouble();
        });
      } else {
        setState(() => _error = (j['error'] as String?) ?? 'Claim failed.');
      }
    } catch (e) {
      setState(() => _error = 'Claim failed: $e');
    } finally {
      if (mounted) {
        setState(() => _busy = false);
        unawaited(_refresh());
      }
    }
  }

  String _fmtBlock(num? v) {
    if (v == null) return '—';
    final d = v.toDouble();
    if (d == d.roundToDouble()) return d.toInt().toString();
    return d.toStringAsFixed(d < 0.01 ? 8 : 2).replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
  }

  String _countdown() {
    final left = _nextClaimAt - DateTime.now().millisecondsSinceEpoch;
    if (left <= 0) return '';
    final h = left ~/ 3600000, m = (left % 3600000) ~/ 60000, s = (left % 60000) ~/ 1000;
    return '${h.toString().padLeft(2, '0')}:${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final st = _state;
    final reward = (st?['reward'] as num?)?.toDouble();
    final remaining = (st?['remaining'] as num?)?.toDouble();
    final claimed = (st?['totalClaimed'] as num?)?.toDouble() ?? 0;
    final supply = (st?['supply'] as num?)?.toDouble() ?? 50000;
    final yourTotal = (st?['yourTotal'] as num?)?.toDouble();
    final active = st?['active'] == true;
    final waiting = _nextClaimAt > DateTime.now().millisecondsSinceEpoch;

    return Scaffold(
      backgroundColor: Bk.bg,
      appBar: AppBar(title: const Text('Blockle Drip')),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(18, 10, 18, 32),
          children: [
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [Bk.accent2.withValues(alpha: 0.16), Bk.accent.withValues(alpha: 0.05)],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Bk.accent2.withValues(alpha: 0.35)),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('Free BLOCK, every day',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Bk.text)),
                const SizedBox(height: 6),
                Text(
                  st == null
                      ? 'Loading the drip pool…'
                      : 'Today\'s drip is ${_fmtBlock(reward)} BLOCK per wallet, sent straight '
                        'to your address on-chain. The drip halves as the ${_fmtBlock(supply)}-BLOCK '
                        'pool is claimed — early birds get the most.',
                  style: const TextStyle(color: Bk.muted, fontSize: 13, height: 1.45),
                ),
              ]),
            ),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(child: _stat('Today\'s drip', '${_fmtBlock(reward)} BLOCK')),
              const SizedBox(width: 10),
              Expanded(child: _stat('Pool left', '${_fmtBlock(remaining)} BLOCK')),
            ]),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: _stat('Claimed so far', '${_fmtBlock(claimed)} BLOCK')),
              const SizedBox(width: 10),
              Expanded(child: _stat('You\'ve collected', yourTotal == null ? 'sign in' : '${_fmtBlock(yourTotal)} BLOCK')),
            ]),
            const SizedBox(height: 10),
            // Halving ladder — where the drip stands on the schedule.
            _progress(claimed, supply),
            const SizedBox(height: 18),
            if (waiting)
              Column(children: [
                const Text('Next claim in', style: TextStyle(color: Bk.muted, fontSize: 12)),
                const SizedBox(height: 4),
                Text(_countdown(),
                    style: const TextStyle(
                        fontSize: 34, fontWeight: FontWeight.w800, color: Bk.text,
                        fontFeatures: [FontFeature.tabularFigures()])),
                const SizedBox(height: 12),
              ]),
            FilledButton(
              onPressed: (_busy || waiting || st == null || !active || (remaining ?? 0) <= 0) ? null : _claim,
              style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(52), backgroundColor: Bk.accent2,
                  disabledBackgroundColor: Bk.surface),
              child: Text(
                _busy
                    ? 'Claiming…'
                    : waiting
                        ? 'Claimed — come back tomorrow'
                        : (remaining ?? 1) <= 0
                            ? 'The drip pool is fully distributed'
                            : !active && st != null
                                ? 'Drip is paused'
                                : 'Claim ${_fmtBlock(reward)} BLOCK',
                style: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: (_busy || waiting || !active) ? Bk.muted : const Color(0xFF07140F)),
              ),
            ),
            if (_myAddress != null) ...[
              const SizedBox(height: 10),
              Text('Pays out to ${_myAddress!.substring(0, 14)}…${_myAddress!.substring(_myAddress!.length - 6)}',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Bk.faint, fontSize: 11.5)),
            ],
            if (_lastTxid != null) ...[
              const SizedBox(height: 12),
              _banner('Sent ${_fmtBlock(_lastAmount)} BLOCK — tx ${_lastTxid!.substring(0, 12)}… '
                  'It will appear in your wallet once the next block confirms.', Bk.good),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              _banner(_error!, Bk.bad),
            ],
            const SizedBox(height: 18),
            const Text(
              'One claim per Blockle account and per address every 24 hours. Claims are '
              'real on-chain transfers from the drip wallet and halve as the pool '
              'depletes: 1 BLOCK/day for the first 25,000, then 0.5, 0.25, and so on.',
              style: TextStyle(color: Bk.muted, fontSize: 11.5, height: 1.5),
            ),
          ],
        ),
      ),
    );
  }

  Widget _stat(String label, String value) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: Bk.border),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(color: Bk.muted, fontSize: 11.5)),
          const SizedBox(height: 3),
          Text(value, style: const TextStyle(color: Bk.text, fontSize: 15, fontWeight: FontWeight.w700)),
        ]),
      );

  Widget _progress(double claimed, double supply) {
    final pct = supply > 0 ? (claimed / supply).clamp(0.0, 1.0) : 0.0;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: LinearProgressIndicator(
          value: pct,
          minHeight: 8,
          backgroundColor: Bk.surface,
          valueColor: const AlwaysStoppedAnimation(Bk.accent2),
        ),
      ),
      const SizedBox(height: 5),
      Text('${(pct * 100).toStringAsFixed(1)}% of the pool claimed · halves at 25,000 / 37,500 / 43,750…',
          style: const TextStyle(color: Bk.faint, fontSize: 10.5)),
    ]);
  }

  Widget _banner(String text, Color color) => Container(
        padding: const EdgeInsets.all(11),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.4)),
        ),
        child: Text(text, style: TextStyle(color: color, fontSize: 12.5, height: 1.4)),
      );
}
