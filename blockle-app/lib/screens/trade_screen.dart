import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';

/// Trade — the custodial shared-price BLOCK AMM (super-amm). Buy/sell BLOCK
/// against base-chain coins via the live /api/amm endpoints. LIVE mode uses the
/// deposit-intent flow (send to the pool address, we detect + execute + pay out);
/// PAPER mode uses the instant /trade endpoint.
class TradeScreen extends StatefulWidget {
  const TradeScreen({super.key});
  @override
  State<TradeScreen> createState() => _TradeScreenState();
}

const _amm = 'https://blockle.org/api/amm';

String _toBase(String s, int dec) {
  s = s.trim();
  if (s.isEmpty || s.startsWith('-')) return '0';
  final parts = s.split('.');
  final whole = parts[0].isEmpty ? '0' : parts[0];
  var frac = parts.length > 1 ? parts[1] : '';
  if (frac.length > dec) frac = frac.substring(0, dec);
  while (frac.length < dec) { frac += '0'; }
  try {
    final b = BigInt.parse(whole) * BigInt.from(10).pow(dec) + BigInt.parse(frac.isEmpty ? '0' : frac);
    return b > BigInt.zero ? b.toString() : '0';
  } catch (_) {
    return '0';
  }
}

double _whole(dynamic base, int dec) {
  try {
    return BigInt.parse(base.toString()).toDouble() / BigInt.from(10).pow(dec).toDouble();
  } catch (_) {
    return 0;
  }
}

class _TradeScreenState extends State<TradeScreen> {
  final _amt = TextEditingController();
  final _recv = TextEditingController();
  Timer? _qTimer, _poll;
  String _side = 'buy';
  List<dynamic> _pairs = [];
  Map<String, int> _dec = {'BLOCK': 8};
  bool _live = false;
  String _priceUsd = '—', _sub = '', _quote = 'Enter an amount.', _status = '';
  bool _canGo = false;
  String? _sym, _intentId;

  @override
  void initState() {
    super.initState();
    _amt.addListener(() {
      _qTimer?.cancel();
      _qTimer = Timer(const Duration(milliseconds: 250), _doQuote);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void dispose() {
    _qTimer?.cancel();
    _poll?.cancel();
    _amt.dispose();
    _recv.dispose();
    super.dispose();
  }

  int _curDec() => _dec[_sym] ?? 8;

  Future<void> _refresh() async {
    try {
      final r = await http.get(Uri.parse('$_amm/info'));
      final d = jsonDecode(r.body);
      final pairs = (d['pairs'] as List?) ?? [];
      final dec = <String, int>{'BLOCK': (d['blockDecimals'] ?? 8) as int};
      for (final p in pairs) {
        dec[p['sym'] as String] = p['decimals'] as int;
      }
      final seed = d['seed'] ?? {};
      if (!mounted) return;
      setState(() {
        _live = d['live'] == true;
        _pairs = pairs;
        _dec = dec;
        _sym ??= pairs.isNotEmpty ? pairs[0]['sym'] as String : null;
        _priceUsd = '${d['priceUsd']}';
        _sub = '${d['paper'] == true ? 'PAPER · ' : ''}fee ${(d['feeBps'] ?? 0) / 100}% · seed ${seed['block']} BLOCK @ \$${seed['priceUsd']}';
        if (_recv.text.isEmpty) _recv.text = context.read<AppState>().store.address ?? '';
      });
    } catch (_) {
      if (mounted) setState(() => _status = 'Market unavailable right now.');
    }
  }

  Future<void> _doQuote() async {
    if (_sym == null) return;
    final inDec = _side == 'buy' ? _curDec() : (_dec['BLOCK'] ?? 8);
    final amtBase = _toBase(_amt.text, inDec);
    if (amtBase == '0') {
      setState(() { _quote = 'Enter an amount.'; _canGo = false; });
      return;
    }
    setState(() { _quote = 'Quoting…'; _canGo = false; });
    try {
      final r = await http.get(Uri.parse('$_amm/quote?side=$_side&sym=$_sym&amount=$amtBase'));
      final d = jsonDecode(r.body);
      if (r.statusCode != 200) { setState(() => _quote = d['error']?.toString() ?? 'Quote failed'); return; }
      final before = double.tryParse('${d['priceBeforeMicroUsd']}') ?? 0;
      final after = double.tryParse('${d['priceAfterMicroUsd']}') ?? 0;
      final impact = before > 0 ? (after - before) / before * 100 : 0;
      if (_side == 'buy') {
        final blk = _whole(d['blockOut'], _dec['BLOCK'] ?? 8);
        setState(() {
          _quote = 'Receive ${blk.toStringAsFixed(4)} BLOCK · fee \$${(double.parse('${d['feeUsd']}') / 1e6).toStringAsFixed(2)} · impact ${impact.toStringAsFixed(2)}%';
          _canGo = true;
        });
      } else {
        final out = _whole(d['assetOut'], _curDec());
        if (d['liquidity'] != true) {
          setState(() { _quote = 'Would receive ${out.toStringAsFixed(6)} $_sym, but that pair has no liquidity yet.'; _canGo = false; });
        } else {
          setState(() {
            _quote = 'Receive ${out.toStringAsFixed(6)} $_sym · fee \$${(double.parse('${d['feeUsd']}') / 1e6).toStringAsFixed(2)} · impact ${impact.toStringAsFixed(2)}%';
            _canGo = true;
          });
        }
      }
    } catch (_) {
      setState(() => _quote = 'Quote unavailable');
    }
  }

  Future<void> _execute() async {
    if (_sym == null) return;
    final inDec = _side == 'buy' ? _curDec() : (_dec['BLOCK'] ?? 8);
    final amtBase = _toBase(_amt.text, inDec);
    if (amtBase == '0') return;
    setState(() => _canGo = false);
    try {
      if (!_live) {
        final r = await http.post(Uri.parse('$_amm/trade'),
            headers: {'content-type': 'application/json'},
            body: jsonEncode({'side': _side, 'sym': _sym, 'amount': amtBase, 'to': context.read<AppState>().store.address}));
        final d = jsonDecode(r.body);
        setState(() => _canGo = true);
        if (r.statusCode != 200) { setState(() => _status = d['error']?.toString() ?? 'Trade failed'); return; }
        setState(() => _status = _side == 'buy'
            ? 'Bought ${_whole(d['blockOut'], _dec['BLOCK'] ?? 8).toStringAsFixed(4)} BLOCK (paper)'
            : 'Sold BLOCK for ${_whole(d['assetOut'], _curDec()).toStringAsFixed(6)} $_sym (paper)');
        _amt.clear();
        _refresh();
        return;
      }
      // LIVE: create an intent, show the deposit address, poll to settlement.
      final payout = _side == 'buy' ? (context.read<AppState>().store.address ?? '') : _recv.text.trim();
      final r = await http.post(Uri.parse('$_amm/intent'),
          headers: {'content-type': 'application/json'},
          body: jsonEncode({'side': _side, 'sym': _sym, 'amount': amtBase, 'payoutAddress': payout}));
      final it = jsonDecode(r.body);
      setState(() => _canGo = true);
      if (r.statusCode != 200) { setState(() => _status = it['error']?.toString() ?? 'Could not create order'); return; }
      _intentId = it['id'] as String?;
      final depDec = _dec[it['depositAsset']] ?? 8;
      final outDec = _dec[it['payoutAsset']] ?? 8;
      final amt = _whole(it['amountInBase'], depDec);
      final out = _whole((it['quote'] ?? {})['outBase'], outDec);
      setState(() => _status = 'Send exactly ${amt.toStringAsFixed(8)} ${it['depositAsset']} to:\n${it['depositAddress']}\nYou receive ≈ ${out.toStringAsFixed(6)} ${it['payoutAsset']}\nWaiting for your deposit…');
      _poll?.cancel();
      _poll = Timer.periodic(const Duration(seconds: 5), (_) => _pollTick());
    } catch (_) {
      setState(() { _canGo = true; _status = 'Order failed'; });
    }
  }

  Future<void> _pollTick() async {
    if (_intentId == null) return;
    try {
      final r = await http.get(Uri.parse('$_amm/intent/$_intentId'));
      final it = jsonDecode(r.body);
      final outDec = _dec[it['payoutAsset']] ?? 8;
      final st = it['status'];
      if (st == 'funded') { setState(() => _status = 'Deposit detected — executing…'); }
      else if (st == 'executed' || st == 'paid') { setState(() => _status = 'Paying out…'); }
      else if (st == 'settled') {
        final got = _whole(it['executedOutBase'] ?? (it['quote'] ?? {})['outBase'], outDec);
        setState(() => _status = '✓ Done — received ${got.toStringAsFixed(6)} ${it['payoutAsset']}');
        _poll?.cancel(); _intentId = null; _amt.clear(); _refresh();
      } else if (st == 'refund') {
        setState(() => _status = 'Refunded — ${it['error'] ?? 'price moved / no liquidity'}. Your deposit is being returned.');
        _poll?.cancel(); _intentId = null;
      } else if (st == 'expired') {
        setState(() => _status = 'Order expired — no deposit received.');
        _poll?.cancel(); _intentId = null;
      }
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Bk.bg,
      appBar: AppBar(title: const Text('Trade'), backgroundColor: Bk.bg2),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('BLOCK price  \$$_priceUsd', style: const TextStyle(color: Bk.text, fontSize: 22, fontWeight: FontWeight.w700)),
        const SizedBox(height: 4),
        Text(_sub, style: const TextStyle(color: Bk.muted, fontSize: 12)),
        const SizedBox(height: 14),
        Row(children: [
          Expanded(child: _sideBtn('buy', 'Buy BLOCK')),
          const SizedBox(width: 8),
          Expanded(child: _sideBtn('sell', 'Sell BLOCK')),
        ]),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(flex: 2, child: TextField(
            controller: _amt, keyboardType: const TextInputType.numberWithOptions(decimal: true),
            style: const TextStyle(color: Bk.text),
            decoration: InputDecoration(labelText: _side == 'buy' ? 'You pay' : 'You sell (BLOCK)', labelStyle: const TextStyle(color: Bk.muted)),
          )),
          const SizedBox(width: 8),
          Expanded(flex: 1, child: DropdownButton<String>(
            isExpanded: true, dropdownColor: Bk.surface, value: _sym,
            items: _pairs.map<DropdownMenuItem<String>>((p) => DropdownMenuItem(value: p['sym'] as String, child: Text('${p['sym']} · ${p['network']}', style: const TextStyle(color: Bk.text, fontSize: 12)))).toList(),
            onChanged: (v) { setState(() => _sym = v); _doQuote(); },
          )),
        ]),
        if (_side == 'sell')
          TextField(controller: _recv, style: const TextStyle(color: Bk.text, fontSize: 12),
              decoration: const InputDecoration(labelText: 'Receive address (your address on that chain)', labelStyle: TextStyle(color: Bk.muted))),
        const SizedBox(height: 10),
        Text(_quote, style: const TextStyle(color: Bk.text)),
        const SizedBox(height: 10),
        ElevatedButton(
          onPressed: _canGo ? _execute : null,
          style: ElevatedButton.styleFrom(backgroundColor: Bk.accent, minimumSize: const Size.fromHeight(44)),
          child: Text(_side == 'buy' ? 'Buy BLOCK' : 'Sell BLOCK'),
        ),
        if (_status.isNotEmpty) ...[
          const SizedBox(height: 12),
          Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: Bk.surface, borderRadius: BorderRadius.circular(10)),
            child: SelectableText(_status, style: const TextStyle(color: Bk.text, fontSize: 13))),
        ],
        const SizedBox(height: 16),
        const Text('Pairs & liquidity', style: TextStyle(color: Bk.text, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        ..._pairs.map((p) => Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Text(
          '${p['pair']} — ${p['network']} · ${p['hasLiquidity'] == true ? 'sellable ≤ ${_whole(p['maxSellableBlockBase'], _dec['BLOCK'] ?? 8).toStringAsFixed(2)} BLOCK' : 'no liquidity yet'}',
          style: const TextStyle(color: Bk.muted, fontSize: 12)))),
      ]),
    );
  }

  Widget _sideBtn(String side, String label) {
    final on = _side == side;
    return ElevatedButton(
      onPressed: () { setState(() => _side = side); _doQuote(); },
      style: ElevatedButton.styleFrom(backgroundColor: on ? Bk.accent : Bk.surface2, foregroundColor: on ? Colors.white : Bk.muted),
      child: Text(label),
    );
  }
}
