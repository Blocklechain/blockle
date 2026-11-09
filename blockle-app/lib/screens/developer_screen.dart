// screens/developer_screen.dart — the Developer Tools suite (gated behind the
// Developer-mode switch, which is OFF by default). None of this bypasses the
// money gates; it is read/inspect/testnet tooling for builders.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../multichain/prices.dart';
import '../multichain/chains/chain_adapter.dart' show AssetRef;
import '../multichain/chains/registry.dart' show kTestnetEndpoints, defaultEndpoints;
import '../state/dev_settings.dart';
import '../state/liquidity_controller.dart';
import '../state/multichain_controller.dart';
import '../theme.dart';

class DeveloperScreen extends StatelessWidget {
  const DeveloperScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Developer Tools')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 40),
        children: const [
          _EnvCard(),
          SizedBox(height: 16),
          _TestnetCard(),
          SizedBox(height: 16),
          _RpcConsole(),
          SizedBox(height: 16),
          _PriceProbe(),
          SizedBox(height: 16),
          _AddressInspector(),
          SizedBox(height: 16),
          _LiquidityCard(),
          SizedBox(height: 16),
          _FlagsCard(),
          SizedBox(height: 16),
          _DangerCard(),
        ],
      ),
    );
  }
}

Widget _card(String title, List<Widget> children) => Builder(builder: (_) {
      return Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Bk.surface,
          borderRadius: BorderRadius.circular(Bk.rMd),
          border: Border.all(color: Bk.border),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Bk.text)),
          const SizedBox(height: 10),
          ...children,
        ]),
      );
    });

InputDecoration _dec(String hint) => InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(color: Bk.faint, fontSize: 13),
      filled: true,
      fillColor: Bk.surface2,
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(Bk.rSm), borderSide: BorderSide.none),
    );

class _EnvCard extends StatelessWidget {
  const _EnvCard();
  @override
  Widget build(BuildContext context) {
    const hasAlchemy = bool.hasEnvironment('BLOCKLE_ALCHEMY_KEY');
    const hasTon = bool.hasEnvironment('TONCENTER_API_KEY');
    const hasBlockfrost = bool.hasEnvironment('BLOCKFROST_PROJECT_ID');
    Widget row(String k, String v) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Row(children: [
            Expanded(child: Text(k, style: const TextStyle(color: Bk.muted, fontSize: 12.5))),
            Text(v, style: const TextStyle(color: Bk.text, fontSize: 12.5, fontWeight: FontWeight.w600)),
          ]),
        );
    return _card('Environment', [
      row('Platform', defaultTargetPlatform.name),
      row('Debug build', kDebugMode ? 'yes' : 'no'),
      row('Alchemy key', hasAlchemy ? 'configured' : '—'),
      row('TON key', hasTon ? 'configured' : '—'),
      row('Blockfrost key', hasBlockfrost ? 'configured' : '—'),
      row('Testnets available', '${kTestnetEndpoints.length} chains'),
    ]);
  }
}

class _TestnetCard extends StatelessWidget {
  const _TestnetCard();
  @override
  Widget build(BuildContext context) {
    final mc = context.watch<MultichainController>();
    final chains = mc.testnetCapableChains;
    return _card('Networks — Testnet', [
      const Text('Switch a chain to its public testnet (Sepolia / devnet / …). '
          'Turning Developer mode off returns every chain to mainnet.',
          style: TextStyle(color: Bk.muted, fontSize: 12, height: 1.4)),
      const SizedBox(height: 6),
      for (final c in chains)
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          dense: true,
          activeColor: Bk.accent,
          title: Text(mc.chainLabel(c), style: const TextStyle(color: Bk.text, fontSize: 14)),
          subtitle: Text(mc.isChainTestnet(c) ? 'testnet' : 'mainnet',
              style: TextStyle(color: mc.isChainTestnet(c) ? Bk.warn : Bk.faint, fontSize: 11)),
          value: mc.isChainTestnet(c),
          onChanged: (v) => mc.setChainTestnet(c, v),
        ),
    ]);
  }
}

class _RpcConsole extends StatefulWidget {
  const _RpcConsole();
  @override
  State<_RpcConsole> createState() => _RpcConsoleState();
}

class _RpcConsoleState extends State<_RpcConsole> {
  final _url = TextEditingController();
  final _method = TextEditingController(text: 'eth_blockNumber');
  final _params = TextEditingController(text: '[]');
  String _out = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final mc = context.read<MultichainController>();
    _url.text = mc.effectiveEndpoint('ethereum').rpcUrl ?? defaultEndpoints['ethereum']!.rpcUrl ?? '';
  }

  @override
  void dispose() {
    _url.dispose();
    _method.dispose();
    _params.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    setState(() { _busy = true; _out = ''; });
    try {
      final params = jsonDecode(_params.text.trim().isEmpty ? '[]' : _params.text);
      final r = await http
          .post(Uri.parse(_url.text.trim()),
              headers: const {'content-type': 'application/json'},
              body: jsonEncode({'jsonrpc': '2.0', 'id': 1, 'method': _method.text.trim(), 'params': params}))
          .timeout(const Duration(seconds: 15));
      final pretty = const JsonEncoder.withIndent('  ').convert(jsonDecode(r.body));
      setState(() => _out = pretty);
    } catch (e) {
      setState(() => _out = 'Error: $e');
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _card('JSON-RPC console', [
      TextField(controller: _url, style: const TextStyle(color: Bk.text, fontSize: 12.5), decoration: _dec('RPC URL')),
      const SizedBox(height: 8),
      Row(children: [
        Expanded(flex: 3, child: TextField(controller: _method, style: const TextStyle(color: Bk.text, fontSize: 12.5), decoration: _dec('method'))),
        const SizedBox(width: 8),
        Expanded(flex: 2, child: TextField(controller: _params, style: const TextStyle(color: Bk.text, fontSize: 12.5), decoration: _dec('params JSON'))),
      ]),
      const SizedBox(height: 10),
      Align(
        alignment: Alignment.centerRight,
        child: FilledButton(
          onPressed: _busy ? null : _send,
          style: FilledButton.styleFrom(backgroundColor: Bk.accent),
          child: Text(_busy ? '…' : 'Send'),
        ),
      ),
      if (_out.isNotEmpty) ...[
        const SizedBox(height: 8),
        Container(
          width: double.infinity,
          constraints: const BoxConstraints(maxHeight: 220),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: Bk.bg2, borderRadius: BorderRadius.circular(Bk.rSm)),
          child: SingleChildScrollView(child: SelectableText(_out, style: const TextStyle(color: Bk.text, fontFamily: 'monospace', fontSize: 11.5))),
        ),
      ],
    ]);
  }
}

class _PriceProbe extends StatefulWidget {
  const _PriceProbe();
  @override
  State<_PriceProbe> createState() => _PriceProbeState();
}

class _PriceProbeState extends State<_PriceProbe> {
  final _sym = TextEditingController(text: 'SOL');
  final _svc = PriceService(serverBase: 'https://blockle.org');
  String _out = '';
  @override
  void dispose() { _sym.dispose(); super.dispose(); }

  Future<void> _probe() async {
    setState(() => _out = '…');
    try {
      final sym = _sym.text.trim().toUpperCase();
      final ref = AssetRef(chain: '', kind: 'native', symbol: sym, decimals: 18);
      final usd = await _svc.fetchUsd([ref]);
      final p = usd[priceKey(ref)];
      setState(() => _out = p != null ? '$sym = \$$p' : '$sym: no price');
    } catch (e) {
      setState(() => _out = 'Error: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return _card('Price probe', [
      Row(children: [
        Expanded(child: TextField(controller: _sym, style: const TextStyle(color: Bk.text, fontSize: 13), decoration: _dec('symbol (SOL, ETH…)'))),
        const SizedBox(width: 8),
        FilledButton(onPressed: _probe, style: FilledButton.styleFrom(backgroundColor: Bk.accent), child: const Text('Probe')),
      ]),
      if (_out.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: SelectableText(_out, style: const TextStyle(color: Bk.text, fontSize: 13))),
    ]);
  }
}

class _AddressInspector extends StatelessWidget {
  const _AddressInspector();
  @override
  Widget build(BuildContext context) {
    final mc = context.read<MultichainController>();
    final chains = mc.registry.adapters.keys.toList()..sort();
    return _card('Address inspector', [
      const Text('Your derived address per chain (public — no keys shown).',
          style: TextStyle(color: Bk.muted, fontSize: 12)),
      const SizedBox(height: 6),
      for (final c in chains)
        FutureBuilder(
          future: mc.addressFor(c),
          builder: (ctx, snap) {
            final addr = snap.data?.address ?? '—';
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(width: 92, child: Text(mc.chainLabel(c), style: const TextStyle(color: Bk.muted, fontSize: 12))),
                Expanded(child: SelectableText(addr, style: const TextStyle(color: Bk.text, fontSize: 11.5, fontFamily: 'monospace'))),
              ]),
            );
          },
        ),
    ]);
  }
}

class _LiquidityCard extends StatelessWidget {
  const _LiquidityCard();
  @override
  Widget build(BuildContext context) {
    final svc = context.watch<LiquidityService>();
    final dev = context.read<DevSettings>();
    return _card('Liquidity treasury', [
      SelectableText(const JsonEncoder.withIndent('  ').convert(svc.pool.toJson()),
          style: const TextStyle(color: Bk.text, fontSize: 11, fontFamily: 'monospace')),
      const SizedBox(height: 8),
      Row(children: [
        if (dev.flag('fakeFees'))
          OutlinedButton(
            onPressed: () {
              for (final c in const ['USDC', 'SOL', 'ETH']) {
                svc.takeFee(c, 25);
              }
            },
            child: const Text('Seed sample fees'),
          ),
        const Spacer(),
        TextButton(onPressed: svc.reset, child: const Text('Reset treasury', style: TextStyle(color: Bk.bad))),
      ]),
    ]);
  }
}

class _FlagsCard extends StatelessWidget {
  const _FlagsCard();
  @override
  Widget build(BuildContext context) {
    final dev = context.watch<DevSettings>();
    return _card('Feature flags', [
      for (final f in kDevFlags)
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          dense: true,
          activeColor: Bk.accent,
          title: Text(f.label, style: const TextStyle(color: Bk.text, fontSize: 14)),
          subtitle: Text(f.desc, style: const TextStyle(color: Bk.faint, fontSize: 11)),
          value: dev.flags[f.key] ?? false,
          onChanged: (v) => dev.setFlag(f.key, v),
        ),
    ]);
  }
}

class _DangerCard extends StatelessWidget {
  const _DangerCard();
  @override
  Widget build(BuildContext context) {
    return _card('Diagnostics', [
      OutlinedButton.icon(
        icon: const Icon(Icons.copy, size: 16),
        label: const Text('Copy diagnostics'),
        onPressed: () {
          final mc = context.read<MultichainController>();
          final diag = {
            'platform': defaultTargetPlatform.name,
            'testnets': {for (final c in mc.testnetCapableChains) c: mc.isChainTestnet(c)},
          };
          Clipboard.setData(ClipboardData(text: const JsonEncoder.withIndent('  ').convert(diag)));
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Diagnostics copied')));
        },
      ),
    ]);
  }
}
