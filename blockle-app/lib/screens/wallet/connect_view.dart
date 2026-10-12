// connect_view.dart — the CONNECT surface (docs/design/wallet "CONNECT").
// WalletConnect v2 sessions list + paste-URI connect, plus the proposal review
// sheet. Every dApp signing request is gated through the SHARED security confirm
// sheet (wired in WalletController.wcRequestCtx) — a DANGER forces the explicit
// confirm and nothing auto-signs. The paste-URI path validates through the real
// WC core (rejects v1 / malformed). Read-only; the core holds no keys.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../state/wallet_controller.dart';
import '../bots/bots_tokens.dart';
import 'wallet_widgets.dart';

class ConnectView extends StatefulWidget {
  const ConnectView({super.key});
  @override
  State<ConnectView> createState() => _ConnectViewState();
}

class _ConnectViewState extends State<ConnectView> {
  final _uri = TextEditingController();
  late Future<List<Map<String, dynamic>>> _future;
  String? _error;
  String? _ok;

  @override
  void initState() {
    super.initState();
    _future = context.read<WalletController>().sessions();
  }

  @override
  void dispose() {
    _uri.dispose();
    super.dispose();
  }

  void _reload() => setState(() {
        _future = context.read<WalletController>().sessions();
      });

  Future<void> _connect() async {
    final uri = _uri.text.trim();
    setState(() {
      _error = null;
      _ok = null;
    });
    if (uri.isEmpty) {
      setState(() => _error = 'Paste a WalletConnect URI (wc:…@2).');
      return;
    }
    try {
      await context.read<WalletController>().pairUri(uri);
      setState(() {
        _ok = 'Pairing accepted — approve the dApp’s session proposal when it arrives.';
        _uri.clear();
      });
    } catch (e) {
      setState(() => _error = '$e'.replaceFirst('Invalid argument(s): ', ''));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = BotTheme.of(context);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 90),
      children: [
        const SectionHead(title: 'Connected dApps', count: 'WalletConnect'),
        WCard(
          child: Column(children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(children: [
                Row(children: [
                  Expanded(
                    child: Container(
                      height: 44,
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      decoration: BoxDecoration(
                        color: t.elevated,
                        border: Border.all(color: t.line),
                        borderRadius: BorderRadius.circular(BotTokens.radiusSm),
                      ),
                      child: Row(children: [
                        Icon(Icons.qr_code_2, size: 16, color: t.inkFaint),
                        const SizedBox(width: 9),
                        Expanded(
                          child: TextField(
                            controller: _uri,
                            style: TextStyle(
                                color: t.ink, fontFamily: kMonoFamily, fontSize: 13),
                            decoration: InputDecoration(
                              isCollapsed: true,
                              border: InputBorder.none,
                              hintText: 'Paste a WalletConnect URI (wc:…@2)',
                              hintStyle: TextStyle(color: t.inkFaint, fontSize: 13),
                            ),
                            onSubmitted: (_) => _connect(),
                          ),
                        ),
                        IconButton(
                          tooltip: 'Paste',
                          icon: Icon(Icons.content_paste, size: 16, color: t.inkMuted),
                          onPressed: () async {
                            final d = await Clipboard.getData('text/plain');
                            if (d?.text != null) _uri.text = d!.text!.trim();
                          },
                        ),
                      ]),
                    ),
                  ),
                  const SizedBox(width: 9),
                  FilledButton(
                    style: FilledButton.styleFrom(
                        backgroundColor: t.accent,
                        foregroundColor: Colors.white,
                        minimumSize: const Size(0, 44)),
                    onPressed: _connect,
                    child: const Text('Connect'),
                  ),
                ]),
                if (_error != null) ...[
                  const SizedBox(height: 10),
                  Row(children: [
                    Icon(Icons.error_outline, size: 15, color: t.loss),
                    const SizedBox(width: 8),
                    Expanded(child: Text(_error!, style: TextStyle(color: t.loss, fontSize: 12.5))),
                  ]),
                ],
                if (_ok != null) ...[
                  const SizedBox(height: 10),
                  Row(children: [
                    Icon(Icons.check_circle_outline, size: 15, color: t.gain),
                    const SizedBox(width: 8),
                    Expanded(child: Text(_ok!, style: TextStyle(color: t.gain, fontSize: 12.5))),
                  ]),
                ],
              ]),
            ),
            FutureBuilder<List<Map<String, dynamic>>>(
              future: _future,
              builder: (context, snap) {
                final sessions = snap.data ?? const [];
                if (snap.connectionState != ConnectionState.done) {
                  return Padding(
                    padding: const EdgeInsets.all(18),
                    child: Center(child: CircularProgressIndicator(color: t.accent)),
                  );
                }
                if (sessions.isEmpty) {
                  return Container(
                    padding: const EdgeInsets.all(20),
                    decoration: BoxDecoration(border: Border(top: BorderSide(color: t.lineSoft))),
                    child: Center(
                      child: Text('No connected dApps yet.',
                          style: TextStyle(color: t.inkMuted, fontSize: 13)),
                    ),
                  );
                }
                return Column(children: [
                  for (var i = 0; i < sessions.length; i++) _sessionRow(t, sessions[i]),
                ]);
              },
            ),
          ]),
        ),
        const SizedBox(height: 12),
        _footnote(t,
            'dApps are untrusted — every signing request needs your explicit approval and runs the security check. Nothing auto-signs.'),
      ],
    );
  }

  Widget _sessionRow(BotTokens t, Map<String, dynamic> s) {
    final dapp = (s['dapp'] as Map?)?.cast<String, dynamic>() ?? const {};
    final namespaces = (s['namespaces'] as Map?)?.cast<String, dynamic>() ?? const {};
    final methods = <String>{};
    for (final ns in namespaces.values) {
      for (final m in ((ns as Map)['methods'] as List? ?? const [])) {
        methods.add('$m');
      }
    }
    final name = '${dapp['name'] ?? 'Unknown dApp'}';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: t.lineSoft))),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          width: 38,
          height: 38,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: t.elevated,
            border: Border.all(color: t.line),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(Icons.language, size: 18, color: t.inkMuted),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: t.ink)),
            if (dapp['url'] != null)
              Text('${dapp['url']}', style: TextStyle(fontSize: 12, color: t.inkMuted)),
            if (methods.isNotEmpty) ...[
              const SizedBox(height: 6),
              Wrap(spacing: 6, runSpacing: 6, children: [
                for (final m in methods.take(4)) WTag(m, mono: true, color: t.inkMuted),
              ]),
            ],
          ]),
        ),
        IconButton(
          tooltip: 'Disconnect',
          icon: Icon(Icons.close, size: 16, color: t.inkMuted),
          onPressed: () async {
            await context.read<WalletController>().disconnectSession('${s['topic']}');
            _reload();
          },
        ),
      ]),
    );
  }

  Widget _footnote(BotTokens t, String text) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline, size: 14, color: t.inkFaint),
          const SizedBox(width: 8),
          Expanded(
              child: Text(text, style: TextStyle(fontSize: 12, color: t.inkFaint, height: 1.4))),
        ],
      );
}

/// Present the WalletConnect proposal review sheet (CLAIMED metadata + the
/// requested chains/methods + any warnings). Returns true iff the user approves
/// the session. Driven by the WC core's reviewProposal — surfaced, never trusted.
/// The relay integration calls this on an incoming session proposal.
Future<bool> showWcProposalReview(BuildContext context, Map<String, dynamic> review) async {
  final t = BotTheme.of(context);
  final dapp = (review['dapp'] as Map?)?.cast<String, dynamic>() ?? const {};
  final chains = (review['chains'] as List?)?.map((e) => '$e').toList() ?? const [];
  final methods = (review['methods'] as List?)?.map((e) => '$e').toList() ?? const [];
  final warnings = (review['warnings'] as List?) ?? const [];
  final res = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (ctx) => BotTheme(
      tokens: t,
      child: Container(
        decoration: BoxDecoration(
          color: t.surface,
          border: Border.all(color: t.line),
          borderRadius: const BorderRadius.vertical(top: Radius.circular(18)),
        ),
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 20, 22, 24),
            child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Connection request',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: t.ink)),
                  const SizedBox(height: 6),
                  Text('${dapp['name'] ?? 'Unknown dApp'}${dapp['url'] != null ? ' · ${dapp['url']}' : ''}',
                      style: TextStyle(fontSize: 13, color: t.inkMuted)),
                  const SizedBox(height: 14),
                  Text('Requested chains',
                      style: TextStyle(fontSize: 12, color: t.inkFaint)),
                  const SizedBox(height: 6),
                  Wrap(spacing: 6, runSpacing: 6, children: [
                    for (final c in chains) WTag(c, mono: true, color: t.inkMuted),
                  ]),
                  const SizedBox(height: 12),
                  Text('Requested methods', style: TextStyle(fontSize: 12, color: t.inkFaint)),
                  const SizedBox(height: 6),
                  Wrap(spacing: 6, runSpacing: 6, children: [
                    for (final m in methods) WTag(m, mono: true, color: t.inkMuted),
                  ]),
                  for (final w in warnings)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Icon(Icons.warning_amber_rounded, size: 16, color: t.warn),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                              w is Map ? '${w['message']}' : '$w',
                              style: TextStyle(fontSize: 12.5, color: t.inkMuted)),
                        ),
                      ]),
                    ),
                  const SizedBox(height: 18),
                  Row(children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.of(ctx).pop(false),
                        child: const Text('Reject'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        style: FilledButton.styleFrom(
                            backgroundColor: t.accent, foregroundColor: Colors.white),
                        onPressed: () => Navigator.of(ctx).pop(true),
                        child: const Text('Approve'),
                      ),
                    ),
                  ]),
                ]),
          ),
        ),
      ),
    ),
  );
  return res == true;
}
