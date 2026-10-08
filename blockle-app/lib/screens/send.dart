import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';

class SendScreen extends StatefulWidget {
  const SendScreen({super.key});
  @override
  State<SendScreen> createState() => _SendScreenState();
}

class _SendScreenState extends State<SendScreen> {
  final _to = TextEditingController();
  final _amt = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _ok;

  static const _coin = 100000000;
  static const _feeBase = 100000; // 0.001 BLOCK default network fee

  Future<void> _send() async {
    final app = context.read<AppState>();
    final to = _to.text.trim();
    final amt = double.tryParse(_amt.text.trim());
    if (!to.startsWith('block1')) {
      setState(() => _error = 'Enter a valid block1… address.');
      return;
    }
    if (amt == null || amt <= 0) {
      setState(() => _error = 'Enter a valid amount.');
      return;
    }
    if (!app.store.isUnlocked) {
      setState(() => _error = 'Wallet is locked — unlock it first.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _ok = null;
    });
    try {
      final addr = app.store.address!;
      final u = await app.chain.utxos(addr);
      final utxos = (u?['utxos'] as List?) ?? [];
      if (utxos.isEmpty) {
        throw Exception('no spendable UTXOs — balance may be unconfirmed');
      }
      final amountBase = (amt * _coin).round();
      final built = await app.store.buildTransfer(
          jsonEncode(utxos), to, amountBase.toString(), _feeBase.toString());
      final raw = built['raw'] as String?;
      if (raw == null) throw Exception('could not build transaction');
      final res = await app.chain.submit(raw);
      final txid = (res is Map ? (res['txid'] ?? built['txid']) : built['txid']).toString();
      setState(() {
        _busy = false;
        _ok = txid;
      });
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Send BLOCK')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          TextField(
            controller: _to,
            decoration: const InputDecoration(labelText: 'Recipient address', hintText: 'block1…'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _amt,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Amount (BLOCK)', hintText: '0.0'),
          ),
          const SizedBox(height: 8),
          const Text('Network fee: 0.001 BLOCK', style: TextStyle(color: Bk.muted, fontSize: 12)),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Bk.bad)),
          ],
          if (_ok != null) ...[
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Bk.good.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Bk.good.withValues(alpha: 0.4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Sent ✓', style: TextStyle(color: Bk.good, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text(_ok!, style: kMono.copyWith(fontSize: 11)),
                ],
              ),
            ),
          ],
          const SizedBox(height: 22),
          FilledButton(
            onPressed: _busy ? null : _send,
            child: _busy
                ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Send'),
          ),
        ],
      ),
    );
  }
}
