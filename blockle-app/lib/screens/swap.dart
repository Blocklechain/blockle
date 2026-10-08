import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';
import 'queue.dart';

/// In-wallet DEX swap against native AMM pools (BLOCK ↔ BLOCK-20 token).
class SwapScreen extends StatefulWidget {
  const SwapScreen({super.key});
  @override
  State<SwapScreen> createState() => _SwapScreenState();
}

class _SwapScreenState extends State<SwapScreen> {
  static const _coin = 100000000;
  static const _fee = 0.003; // 0.30% swap fee
  static const _slip = 0.01; // 1% slippage tolerance

  final _amt = TextEditingController();
  List<Map<String, dynamic>> _pools = [];
  Map<String, dynamic>? _pool;
  bool _buy = true; // true = BLOCK→token, false = token→BLOCK
  bool _loading = true;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _amt.addListener(() => setState(() {}));
    _load();
  }

  Future<void> _load() async {
    final app = context.read<AppState>();
    final pools = await app.chain.pools();
    if (!mounted) return;
    setState(() {
      _pools = pools;
      _pool = pools.isNotEmpty ? pools.first : null;
      _loading = false;
    });
  }

  int get _dec => (_pool?['decimals'] as num?)?.toInt() ?? 0;
  double get _blockRes => ((_pool?['blockReserve'] as num?) ?? 0) / _coin;
  double get _tokRes => ((_pool?['tokenReserve'] as num?) ?? 0) / pow(10, _dec);
  String get _sym => (_pool?['symbol'] as String?) ?? 'token';

  double _out(double amt, double inRes, double outRes) {
    if (amt <= 0 || inRes <= 0 || outRes <= 0) return 0;
    final ain = amt * (1 - _fee);
    return outRes * ain / (inRes + ain);
  }

  double get _amountIn => double.tryParse(_amt.text.trim()) ?? 0;
  double get _estOut =>
      _buy ? _out(_amountIn, _blockRes, _tokRes) : _out(_amountIn, _tokRes, _blockRes);

  String _fmt(double n) => n == 0
      ? '—'
      : n.toStringAsFixed(6).replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');

  Future<void> _swap() async {
    final app = context.read<AppState>();
    if (_pool == null || _amountIn <= 0) {
      setState(() => _error = 'Enter an amount.');
      return;
    }
    if (!app.store.isUnlocked) {
      setState(() => _error = 'Wallet is locked — unlock it first.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final addr = app.store.address!;
      final u = await app.chain.utxos(addr);
      final utxos = (u?['utxos'] as List?) ?? [];
      if (utxos.isEmpty) throw Exception('no spendable UTXOs for gas');
      final token = _pool!['token'] as String;
      final out = _estOut;
      Map<String, dynamic> built;
      if (_buy) {
        final amountIn = BigInt.from((_amountIn * _coin).round());
        final minOut = BigInt.from((out * (1 - _slip) * pow(10, _dec)).floor());
        built = await app.store.buildPoolSwapBuy(
            jsonEncode(utxos), token, amountIn.toString(), minOut.toString(), 200000, 10);
      } else {
        final amountIn = BigInt.from((_amountIn * pow(10, _dec)).round());
        final minOut = BigInt.from((out * (1 - _slip) * _coin).floor());
        built = await app.store.buildPoolSwapSell(
            jsonEncode(utxos), token, amountIn.toString(), minOut.toString(), 200000, 10);
      }
      final raw = built['raw'] as String?;
      if (raw == null) throw Exception('could not build swap');
      final res = await app.chain.submit(raw);
      final txid = (res is Map ? (res['txid'] ?? built['txid']) : built['txid']).toString();
      await app.addPending(txid, _buy ? 'Buy $_sym' : 'Sell $_sym');
      if (!mounted) return;
      Navigator.pushReplacement(
          context, MaterialPageRoute(builder: (_) => const QueueScreen()));
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
      appBar: AppBar(title: const Text('Swap')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _pools.isEmpty
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(28),
                    child: Text(
                      'No liquidity pools yet. Launch a token with a pool at blockle.org/launch, then swap here.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: Bk.muted),
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    DropdownButtonFormField<Map<String, dynamic>>(
                      initialValue: _pool,
                      isExpanded: true,
                      dropdownColor: Bk.surface,
                      decoration: const InputDecoration(labelText: 'Pool'),
                      items: _pools
                          .map((p) => DropdownMenuItem(
                                value: p,
                                child: Text(
                                    '${p['symbol'] ?? '?'} — ${p['name'] ?? (p['token'] as String).substring(0, 10)}',
                                    overflow: TextOverflow.ellipsis),
                              ))
                          .toList(),
                      onChanged: (p) => setState(() => _pool = p),
                    ),
                    const SizedBox(height: 14),
                    Row(children: [
                      _sideBtn('Buy $_sym', _buy, () => setState(() => _buy = true)),
                      const SizedBox(width: 10),
                      _sideBtn('Sell $_sym', !_buy, () => setState(() => _buy = false)),
                    ]),
                    const SizedBox(height: 14),
                    TextField(
                      controller: _amt,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: InputDecoration(
                          labelText: _buy ? 'You pay (BLOCK)' : 'You pay ($_sym)',
                          hintText: '0.0'),
                    ),
                    const SizedBox(height: 16),
                    _quoteRow('Rate',
                        _buy
                            ? '1 BLOCK ≈ ${_fmt(_out(1, _blockRes, _tokRes))} $_sym'
                            : '1 $_sym ≈ ${_fmt(_out(1, _tokRes, _blockRes))} BLOCK'),
                    _quoteRow('You receive ≈',
                        '${_fmt(_estOut)} ${_buy ? _sym : 'BLOCK'}'),
                    _quoteRow('Min received (1%)',
                        '${_fmt(_estOut * (1 - _slip))} ${_buy ? _sym : 'BLOCK'}'),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(_error!, style: const TextStyle(color: Bk.bad)),
                    ],
                    const SizedBox(height: 22),
                    FilledButton(
                      onPressed: _busy ? null : _swap,
                      child: _busy
                          ? const SizedBox(height: 22, width: 22, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Text('Swap'),
                    ),
                    const SizedBox(height: 10),
                    const Text(
                        'Swaps settle against the native AMM. A block (~10 min) must confirm it — track it in the queue.',
                        style: TextStyle(color: Bk.muted, fontSize: 12)),
                  ],
                ),
    );
  }

  Widget _sideBtn(String label, bool on, VoidCallback onTap) {
    return Expanded(
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: on ? Bk.accent : Bk.surface2,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: on ? Bk.accent : Bk.border),
          ),
          child: Text(label,
              style: TextStyle(
                  color: on ? Colors.white : Bk.muted, fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }

  Widget _quoteRow(String k, String v) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(k, style: const TextStyle(color: Bk.muted, fontSize: 13)),
          Text(v, style: kMono.copyWith(fontSize: 13)),
        ],
      ),
    );
  }
}
