import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';
import 'wallet/send_gate.dart';

class SendScreen extends StatefulWidget {
  /// When [token] is non-null it is a BLOCK-20 token send:
  /// {contract, decimals, symbol}. Null => native BLOCK.
  final Map<String, dynamic>? token;
  const SendScreen({super.key, this.token});
  @override
  State<SendScreen> createState() => _SendScreenState();
}

class _SendScreenState extends State<SendScreen> {
  final _to = TextEditingController();
  final _amt = TextEditingController();
  final _fee = TextEditingController(text: '0.001'); // native BLOCK network fee
  final _gasLimit = TextEditingController(text: '200000'); // token gas
  final _gasPrice = TextEditingController(text: '10');
  bool _busy = false;
  String? _error;
  String? _ok;

  static const _coin = 100000000;

  bool get _isToken => widget.token != null;
  int get _decimals => _isToken ? (widget.token!['decimals'] as int? ?? 0) : 8;
  String get _symbol => _isToken ? (widget.token!['symbol'] as String? ?? 'TOKEN') : 'BLOCK';
  String get _contract => (widget.token!['contract'] ?? widget.token!['address'] ?? '').toString().toLowerCase();

  // Exact decimal string -> base units (no float rounding; safe for big amounts).
  String _toBase(String decStr, int decimals) {
    var s = decStr.trim().replaceAll(',', '');
    if (s.isEmpty || s == '.' || !RegExp(r'^\d*(\.\d*)?$').hasMatch(s)) return '0';
    final parts = s.split('.');
    final whole = parts[0].isEmpty ? '0' : parts[0];
    var frac = parts.length > 1 ? parts[1] : '';
    frac = (frac + '00000000000000000000').substring(0, decimals);
    final bi = BigInt.parse(whole) * BigInt.from(10).pow(decimals) +
        BigInt.parse(frac.isEmpty ? '0' : frac);
    return bi.toString();
  }

  Future<void> _send() async {
    final app = context.read<AppState>();
    final to = _to.text.trim();
    final amt = double.tryParse(_amt.text.trim().replaceAll(',', ''));
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

    final amountBase = _toBase(_amt.text.trim(), _decimals);
    int gasLimit = int.tryParse(_gasLimit.text.trim()) ?? 200000;
    int gasPrice = int.tryParse(_gasPrice.text.trim()) ?? 10;
    if (gasLimit < 1) gasLimit = 200000;
    if (gasPrice < 1) gasPrice = 10;
    final feeStr = _isToken
        ? (BigInt.from(gasLimit) * BigInt.from(gasPrice)).toString()
        : (((double.tryParse(_fee.text.trim()) ?? 0.001) * _coin).round()).toString();

    // SECURITY GATE: every send clears inspect + the shared confirm sheet first.
    final approved = await reviewSend(
      context,
      chain: 'block',
      to: to,
      amount: amountBase,
      fee: feeStr,
      asset: _isToken
          ? {'chain': 'block', 'kind': 'block20', 'symbol': _symbol, 'decimals': _decimals, 'address': _contract}
          : const {'chain': 'block', 'kind': 'native', 'symbol': 'BLOCK', 'decimals': 8},
      title: 'Review send',
      previewHeader: 'Send $_symbol',
      resolvedAddress: shortSendAddr(to),
    );
    if (!mounted) return;
    if (!approved) {
      setState(() => _error = 'Send cancelled — nothing was signed.');
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
        throw Exception(_isToken
            ? 'need a little BLOCK for gas — balance may be unconfirmed'
            : 'no spendable UTXOs — balance may be unconfirmed');
      }
      final built = _isToken
          ? await app.store.buildTokenTransfer(
              jsonEncode(utxos), _contract, to, amountBase, gasLimit.toString(), gasPrice.toString())
          : await app.store.buildTransfer(
              jsonEncode(utxos), to, amountBase, feeStr);
      final raw = built['raw'] as String?;
      if (raw == null) throw Exception('could not build transaction');
      final res = await app.chain.submit(raw);
      final txid = (res is Map ? (res['txid'] ?? built['txid']) : built['txid']).toString();
      await app.addPending(txid, _isToken ? 'Send $_symbol' : 'Send');
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
      appBar: AppBar(title: Text('Send $_symbol')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (_isToken)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text('BLOCK-20 token · the gas fee is paid in BLOCK.',
                  style: const TextStyle(color: Bk.muted, fontSize: 12)),
            ),
          TextField(
            controller: _to,
            decoration: const InputDecoration(labelText: 'Recipient address', hintText: 'block1…'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _amt,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(labelText: 'Amount ($_symbol)', hintText: '0.0'),
          ),
          const SizedBox(height: 14),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            childrenPadding: EdgeInsets.zero,
            title: const Text('Advanced · adjust gas / fee', style: TextStyle(color: Bk.muted, fontSize: 13)),
            children: _isToken
                ? [
                    Row(children: [
                      Expanded(child: TextField(controller: _gasLimit, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Gas limit'))),
                      const SizedBox(width: 10),
                      Expanded(child: TextField(controller: _gasPrice, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Gas price'))),
                    ]),
                    const Padding(padding: EdgeInsets.only(top: 6), child: Text('Fee = gas limit × gas price (paid in BLOCK).', style: TextStyle(color: Bk.muted, fontSize: 11))),
                  ]
                : [
                    TextField(controller: _fee, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Network fee (BLOCK)')),
                  ],
          ),
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
