import 'dart:collection';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:provider/provider.dart';

import '../state/app_state.dart';
import '../theme.dart';

const _home = 'https://blockle.org';

class BrowserTab extends StatefulWidget {
  const BrowserTab({super.key});
  @override
  State<BrowserTab> createState() => _BrowserTabState();
}

class _BrowserTabState extends State<BrowserTab> {
  InAppWebViewController? _ctrl;
  final _urlBar = TextEditingController(text: _home);
  String _origin = _home;
  bool _loading = true;
  String? _inpage;
  bool _canBack = false, _canFwd = false;

  @override
  void initState() {
    super.initState();
    _loadProvider();
  }

  Future<void> _loadProvider() async {
    final src = await rootBundle.loadString('assets/provider/inpage.js');
    if (mounted) setState(() => _inpage = src);
  }

  void _wireAppState(AppState app) {
    app.onApproval = _approve;
    app.emitEvent = (origin, event, data) {
      if (origin == _origin && _ctrl != null) {
        _ctrl!.evaluateJavascript(
            source: 'window.__blockleEmit && window.__blockleEmit(${jsonEncode(event)}, ${jsonEncode(data)})');
      }
    };
  }

  Future<ApprovalResult> _approve(ApprovalRequest req) async {
    final app = context.read<AppState>();
    final result = await showModalBottomSheet<ApprovalResult>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Bk.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => _ApprovalSheet(req: req, app: app),
    );
    return result ?? ApprovalResult(false);
  }

  void _go([String? raw]) {
    var u = (raw ?? _urlBar.text).trim();
    if (u.isEmpty) return;
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      u = u.contains('.') && !u.contains(' ') ? 'https://$u' : 'https://blockle.org/explorer/search?q=${Uri.encodeComponent(u)}';
    }
    _ctrl?.loadUrl(urlRequest: URLRequest(url: WebUri(u)));
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    _wireAppState(app);
    // deep-link request from elsewhere (e.g. Buy/Sell button)
    if (app.pendingBrowserUrl != null && _ctrl != null) {
      final target = app.pendingBrowserUrl!;
      app.consumedBrowserUrl();
      WidgetsBinding.instance.addPostFrameCallback((_) => _go(target));
    }

    if (_inpage == null) {
      return const Center(child: CircularProgressIndicator(color: Bk.accent));
    }

    return SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
            child: Row(
              children: [
                IconButton(
                    onPressed: _canBack ? () => _ctrl?.goBack() : null,
                    icon: const Icon(Icons.arrow_back_ios_new, size: 18)),
                IconButton(
                    onPressed: _canFwd ? () => _ctrl?.goForward() : null,
                    icon: const Icon(Icons.arrow_forward_ios, size: 18)),
                Expanded(
                  child: Container(
                    height: 40,
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    decoration: BoxDecoration(
                        color: Bk.surface2,
                        borderRadius: BorderRadius.circular(20),
                        border: Border.all(color: Bk.border)),
                    child: Center(
                      child: TextField(
                        controller: _urlBar,
                        textInputAction: TextInputAction.go,
                        onSubmitted: _go,
                        style: const TextStyle(fontSize: 13),
                        decoration: const InputDecoration(
                          border: InputBorder.none,
                          isDense: true,
                          hintText: 'Search or enter address',
                        ),
                      ),
                    ),
                  ),
                ),
                IconButton(
                    onPressed: () => _ctrl?.reload(),
                    icon: const Icon(Icons.refresh, size: 20)),
                IconButton(
                    onPressed: () => _go(_home),
                    icon: const Icon(Icons.home_outlined, size: 20)),
              ],
            ),
          ),
          if (_loading) const LinearProgressIndicator(minHeight: 2, color: Bk.accent, backgroundColor: Bk.surface2),
          Expanded(
            child: InAppWebView(
              initialUrlRequest: URLRequest(url: WebUri(_home)),
              initialUserScripts: UnmodifiableListView([
                UserScript(
                    source: _inpage!,
                    injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
                    forMainFrameOnly: true),
              ]),
              initialSettings: InAppWebViewSettings(
                javaScriptEnabled: true,
                transparentBackground: true,
              ),
              onWebViewCreated: (c) {
                _ctrl = c;
                c.addJavaScriptHandler(
                  handlerName: 'blockleRpc',
                  callback: (args) async {
                    final arg = (args.isNotEmpty && args[0] is Map)
                        ? Map<String, dynamic>.from(args[0] as Map)
                        : <String, dynamic>{};
                    final method = (arg['method'] ?? '').toString();
                    final params = (arg['params'] as List?) ?? [];
                    return await context.read<AppState>().handleRpc(method, params, _origin);
                  },
                );
              },
              onLoadStart: (c, url) => setState(() => _loading = true),
              onLoadStop: (c, url) async {
                _canBack = await c.canGoBack();
                _canFwd = await c.canGoForward();
                if (url != null) {
                  _urlBar.text = url.toString();
                  _origin = '${url.scheme}://${url.host}${url.hasPort ? ':${url.port}' : ''}';
                }
                if (mounted) setState(() => _loading = false);
              },
              onReceivedError: (c, req, err) {
                if (mounted) setState(() => _loading = false);
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _ApprovalSheet extends StatefulWidget {
  const _ApprovalSheet({required this.req, required this.app});
  final ApprovalRequest req;
  final AppState app;
  @override
  State<_ApprovalSheet> createState() => _ApprovalSheetState();
}

class _ApprovalSheetState extends State<_ApprovalSheet> {
  final _pw = TextEditingController();
  bool _busy = false;
  String? _error;

  Future<void> _approve() async {
    final app = widget.app;
    final req = widget.req;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      // unlock if needed for signing/deploying
      if ((req.type == 'sign' || req.type == 'deploy') && !app.store.isUnlocked) {
        if (_pw.text.isEmpty) {
          setState(() {
            _busy = false;
            _error = 'Enter your password to approve.';
          });
          return;
        }
        await app.store.unlock(_pw.text);
      }
      dynamic payload;
      if (req.type == 'sign') {
        payload = await app.store.signMessage(req.message ?? '');
      } else if (req.type == 'deploy') {
        final addr = app.store.address!;
        final u = await app.chain.utxos(addr);
        final utxos = (u?['utxos'] as List?) ?? [];
        final gasLimit = req.gas ?? '200000';
        final built = await app.store.buildDeploy(jsonEncode(utxos), req.code ?? '', gasLimit, '1');
        final raw = built['raw'] as String?;
        if (raw == null) throw Exception('could not build deployment');
        await app.chain.submit(raw);
        await app.addPending(built['txid']?.toString(), 'Deploy');
        payload = {'txid': built['txid'], 'contractId': built['contractId']};
      }
      if (mounted) Navigator.pop(context, ApprovalResult(true, payload));
    } catch (e) {
      setState(() {
        _busy = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final req = widget.req;
    final locked = (req.type == 'sign' || req.type == 'deploy') && !widget.app.store.isUnlocked;
    final title = switch (req.type) {
      'connect' => 'Connect to this site',
      'sign' => 'Signature request',
      'deploy' => 'Deploy contract',
      _ => 'Request',
    };
    return Padding(
      padding: EdgeInsets.only(
          left: 20, right: 20, top: 20, bottom: MediaQuery.of(context).viewInsets.bottom + 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          Text(req.origin, style: kMono.copyWith(color: Bk.muted, fontSize: 12)),
          const SizedBox(height: 14),
          if (req.type == 'connect')
            const Text('This site is requesting your BLOCK address and permission to interact with your wallet.',
                style: TextStyle(color: Bk.muted)),
          if (req.type == 'sign') ...[
            const Text('Message to sign:', style: TextStyle(color: Bk.muted, fontSize: 12)),
            const SizedBox(height: 4),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: Bk.surface2, borderRadius: BorderRadius.circular(10)),
              child: Text(req.message ?? '', style: kMono.copyWith(fontSize: 12)),
            ),
          ],
          if (req.type == 'deploy')
            Text('Bytecode: ${(req.code ?? '').length ~/ 2} bytes · gas ${req.gas}',
                style: const TextStyle(color: Bk.muted, fontSize: 13)),
          if (locked) ...[
            const SizedBox(height: 14),
            TextField(
              controller: _pw,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password to unlock'),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: const TextStyle(color: Bk.bad)),
          ],
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: _busy ? null : () => Navigator.pop(context, ApprovalResult(false)),
                  child: const Text('Reject'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: _busy ? null : _approve,
                  child: _busy
                      ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('Approve'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
