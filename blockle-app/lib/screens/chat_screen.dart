// AI Chat screen — ChatGPT/Claude-style, paid per message in BLOCK via a generatable API key
// against the Blockle Intelligence gateway (same backend as the web + extension + Qt wallets).
// Additive + self-contained. Top-up is manual (send BLOCK to the deposit address, paste the
// txid) to avoid coupling to the per-chain signer here.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import '../theme.dart';

const _base = 'https://blockle.org/api/inference';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _storage = const FlutterSecureStorage();
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final List<Map<String, String>> _msgs = [];
  String _key = '';
  String _deposit = '';
  String _balance = '—';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<Map<String, dynamic>> _api(String path,
      {String method = 'GET', Map<String, dynamic>? body, String? key}) async {
    final uri = Uri.parse(_base + path);
    final headers = <String, String>{
      'content-type': 'application/json',
      if (key != null) 'authorization': 'Bearer $key',
    };
    try {
      final r = method == 'POST'
          ? await http.post(uri, headers: headers, body: jsonEncode(body ?? {}))
          : await http.get(uri, headers: headers);
      final ok = r.statusCode >= 200 && r.statusCode < 300;
      dynamic j;
      try {
        j = jsonDecode(r.body);
      } catch (_) {
        j = <String, dynamic>{};
      }
      return {'ok': ok, 'status': r.statusCode, 'j': j};
    } catch (e) {
      return {'ok': false, 'status': 0, 'j': {'error': '$e'}};
    }
  }

  Future<String> _ensureKey() async {
    if (_key.isNotEmpty) return _key;
    final stored = await _storage.read(key: 'inferKey');
    if (stored != null && stored.isNotEmpty) {
      _key = stored;
      return _key;
    }
    final r = await _api('/keys/create', method: 'POST', body: {'address': ''});
    if (r['ok'] == true && r['j']['key'] != null) {
      _key = r['j']['key'] as String;
      await _storage.write(key: 'inferKey', value: _key);
    }
    return _key;
  }

  Future<void> _bootstrap() async {
    await _ensureKey();
    await _refreshBalance();
  }

  Future<void> _refreshBalance() async {
    if (_key.isEmpty) return;
    final r = await _api('/credit', key: _key);
    if (!mounted) return;
    final j = r['j'] as Map<String, dynamic>? ?? {};
    setState(() {
      if (j['balanceBlock'] != null) _balance = '${j['balanceBlock']}';
      if (j['depositAddr'] != null) _deposit = j['depositAddr'] as String;
    });
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _busy) return;
    final key = await _ensureKey();
    setState(() {
      _input.clear();
      _msgs.add({'role': 'user', 'content': text});
      _busy = true;
    });
    _toBottom();
    final r = await _api('/chat', method: 'POST', body: {'prompt': text}, key: key);
    if (!mounted) return;
    final j = r['j'] as Map<String, dynamic>? ?? {};
    setState(() {
      if (r['status'] == 402) {
        _msgs.add({'role': 'ai', 'content': 'Out of BLOCK credit — tap the wallet icon to top up.'});
      } else if (r['ok'] == true) {
        _msgs.add({'role': 'ai', 'content': (j['answer'] ?? '(no answer)').toString()});
        if (j['balanceBlock'] != null) _balance = '${j['balanceBlock']}';
      } else {
        _msgs.add({'role': 'ai', 'content': 'Error: ${j['error'] ?? 'unavailable'}'});
      }
      _busy = false;
    });
    _toBottom();
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  void _openCredit() {
    final txid = TextEditingController();
    String msg = '';
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Bk.bg2,
      isScrollControlled: true,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheet) => Padding(
          padding: EdgeInsets.only(
              left: 16, right: 16, top: 16,
              bottom: 16 + MediaQuery.of(ctx).viewInsets.bottom),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('Top up BLOCK credit',
                  style: TextStyle(color: Bk.text, fontSize: 16, fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              const Text('Send BLOCK to this address (Wallet ▸ Send), then paste the transaction id.',
                  style: TextStyle(color: Bk.muted, fontSize: 12)),
              const SizedBox(height: 8),
              SelectableText(_deposit.isEmpty ? '(loading…)' : _deposit,
                  style: const TextStyle(color: Bk.text, fontFamily: 'monospace', fontSize: 12)),
              const SizedBox(height: 12),
              TextField(
                controller: txid,
                style: const TextStyle(color: Bk.text),
                decoration: const InputDecoration(hintText: 'deposit transaction id'),
              ),
              const SizedBox(height: 8),
              ElevatedButton(
                onPressed: () async {
                  final id = txid.text.trim();
                  if (id.isEmpty) {
                    setSheet(() => msg = 'Paste a transaction id.');
                    return;
                  }
                  final k = await _ensureKey();
                  final r = await _api('/deposit', method: 'POST', body: {'txid': id}, key: k);
                  final j = r['j'] as Map<String, dynamic>? ?? {};
                  setSheet(() => msg = r['ok'] == true
                      ? 'Credited ${j['creditedBlock'] ?? ''} BLOCK.'
                      : (j['error']?.toString() ?? 'Not confirmed yet — try again shortly.'));
                  _refreshBalance();
                },
                child: const Text('Credit'),
              ),
              if (msg.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(msg, style: const TextStyle(color: Bk.muted, fontSize: 12)),
                ),
              const SizedBox(height: 16),
              const Text('Your API key (OpenAI-compatible)',
                  style: TextStyle(color: Bk.text, fontWeight: FontWeight.bold)),
              const SizedBox(height: 4),
              SelectableText(_key.isEmpty ? '(none)' : _key,
                  style: const TextStyle(color: Bk.muted, fontFamily: 'monospace', fontSize: 11)),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Bk.bg,
      appBar: AppBar(
        backgroundColor: Bk.bg2,
        title: const Text('AI Chat', style: TextStyle(color: Bk.text)),
        actions: [
          Center(
              child: Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Text('$_balance BLOCK', style: const TextStyle(color: Bk.muted, fontSize: 13)),
          )),
          IconButton(
              icon: const Icon(Icons.account_balance_wallet_outlined, color: Bk.accent),
              onPressed: _openCredit),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: _msgs.isEmpty
                ? const Center(
                    child: Text('Ask anything. Paid per message in BLOCK.',
                        style: TextStyle(color: Bk.muted)))
                : ListView.builder(
                    controller: _scroll,
                    padding: const EdgeInsets.all(12),
                    itemCount: _msgs.length,
                    itemBuilder: (ctx, idx) {
                      final m = _msgs[idx];
                      final mine = m['role'] == 'user';
                      return Align(
                        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                          constraints: BoxConstraints(
                              maxWidth: MediaQuery.of(ctx).size.width * 0.82),
                          decoration: BoxDecoration(
                            color: mine ? Bk.accent : Bk.bg2,
                            borderRadius: BorderRadius.circular(14),
                          ),
                          child: Text(m['content'] ?? '',
                              style: TextStyle(color: mine ? Colors.white : Bk.text)),
                        ),
                      );
                    },
                  ),
          ),
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    style: const TextStyle(color: Bk.text),
                    onSubmitted: (_) => _send(),
                    decoration: const InputDecoration(hintText: 'Message Blockle Intelligence…'),
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton(onPressed: _busy ? null : _send, child: const Text('Send')),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }
}
