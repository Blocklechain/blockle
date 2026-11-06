import 'dart:collection';
import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_inappwebview/flutter_inappwebview.dart' hide AndroidOptions;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../multichain/security.dart' as sec;
import '../multichain/walletconnect.dart' show decodePersonalSign;
import '../services/agent_service.dart' show AgentService, SiteScreening;
import '../state/app_state.dart';
import '../state/multichain_controller.dart';
import '../services/open_url.dart';
import '../theme.dart';
import 'wallet/security_sheet.dart';

const _home = 'https://blockle.org';

/// Origin the curated dApp directory + open-counter are served from (#129).
const _dappsBase = 'https://blockle.org';

class BrowserTab extends StatefulWidget {
  const BrowserTab({super.key});
  @override
  State<BrowserTab> createState() => _BrowserTabState();
}

class _BrowserTabState extends State<BrowserTab> {
  InAppWebViewController? _ctrl;
  final _urlBar = TextEditingController(text: _home);
  String _origin = _home;
  String? _title;
  bool _loading = true;
  String? _inpage;
  bool _canBack = false, _canFwd = false;

  // EVM (EIP-1193) dApp session state for the injected window.ethereum.
  final Set<String> _evmConnected = {};
  String _evmChainId = '0x1'; // default Ethereum mainnet; dApp may switch it

  // Curated trusted-dApp homepage (#129): a Blockle-vetted directory shown in
  // place of a blank URL page. `_atHome` is an explicit home state (toolbar home
  // button ⇒ true; a tile tap / URL nav ⇒ false) layered over the live webview.
  bool _atHome = true;
  List<_Dapp> _dapps = const [];
  bool _dappsLoading = true;
  final _store = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  static const _kDappsCache = 'bk_dapps_cache';

  @override
  void initState() {
    super.initState();
    _loadProvider();
    _loadDapps();
  }

  Future<void> _loadProvider() async {
    final src = await rootBundle.loadString('assets/provider/inpage.js');
    if (mounted) setState(() => _inpage = src);
  }

  /// Load the curated directory: render the disk cache immediately (offline-ok),
  /// then refresh from GET /account/api/dapps (popularity-ranked server-side) and
  /// re-cache. Both steps are best-effort — a failure just keeps the last list.
  Future<void> _loadDapps() async {
    try {
      final raw = await _store.read(key: _kDappsCache);
      if (raw != null && raw.isNotEmpty) {
        final list = _parseDapps(jsonDecode(raw));
        if (list.isNotEmpty && mounted) setState(() => _dapps = list);
      }
    } catch (_) {}
    try {
      final r = await http.get(Uri.parse('$_dappsBase/account/api/dapps'));
      if (r.statusCode >= 200 && r.statusCode < 300) {
        final decoded = jsonDecode(r.body);
        final list = _parseDapps(decoded);
        if (list.isNotEmpty) {
          await _store.write(key: _kDappsCache, value: r.body);
          if (mounted) setState(() => _dapps = list);
        }
      }
    } catch (_) {}
    if (mounted) setState(() => _dappsLoading = false);
  }

  List<_Dapp> _parseDapps(dynamic decoded) {
    if (decoded is! List) return const [];
    final out = <_Dapp>[];
    for (final e in decoded) {
      if (e is Map) out.add(_Dapp.fromJson(e));
    }
    return out;
  }

  /// Open a curated dApp: leave the home state, navigate, and fire the
  /// pseudonymous open-counter bump (fire-and-forget) so the server can rank by
  /// in-app popularity. No uid/PII is sent — just {id}.
  void _openDapp(_Dapp d) {
    setState(() => _atHome = false);
    _go(d.url);
    _bumpOpen(d.id);
  }

  void _bumpOpen(String id) {
    http
        .post(Uri.parse('$_dappsBase/account/api/dapps/open'),
            headers: const {'content-type': 'application/json'},
            body: jsonEncode({'id': id}))
        .catchError((_) => http.Response('', 599));
  }

  /// Quick-scan (#127): run the READ-ONLY connect screening (rules gate + the
  /// user's local on-device AI as protector) and show the combined result in the
  /// shared security sheet WITHOUT connecting. No approval is acted on.
  Future<void> _quickScan() async {
    if (_atHome) return;
    final agent = context.read<MultichainController>().agent;
    final cfg = await buildSiteScreeningConfig(agent, _origin, _title, forConnect: false);
    if (!mounted) return;
    await showSecuritySheet(context, cfg);
  }

  /// Connect (#127): drive the existing injected-provider connect RPC. It routes
  /// through AppState.handleRpc('blockle_connect') → onApproval → the approval
  /// sheet, whose connect branch now runs the mandatory screening + the
  /// non-bypassable security-sheet confirm BEFORE the site is recorded.
  Future<void> _connect() async {
    if (_atHome) return;
    final res = await context.read<AppState>().handleRpc('blockle_connect', const [], _origin);
    if (!mounted) return;
    final err = res['error'];
    final ok = res['result'] != null && err == null;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(ok
          ? 'Connected to ${Uri.tryParse(_origin)?.host ?? _origin}'
          : (err is Map ? '${err['message'] ?? 'Connection not established'}' : 'Connection not established')),
    ));
  }

  /// The prominent toolbar Connect button: ask the current dApp to connect
  /// through the injected provider, so the user only approves. Works for EVM
  /// dApps (window.ethereum) and the BLOCK-native provider (window.blockle).
  void _connectEvm() {
    if (_atHome) return;
    _ctrl?.evaluateJavascript(source: '''
      try {
        if (window.ethereum && window.ethereum.request) {
          window.ethereum.request({method:'eth_requestAccounts'}).catch(function(){});
        } else if (window.blockle && window.blockle.connect) {
          window.blockle.connect().catch(function(){});
        }
      } catch (e) {}
    ''');
  }

  void _emitEvm(String event, dynamic data) {
    _ctrl?.evaluateJavascript(
        source:
            'window.__blockleEmit && window.__blockleEmit(${jsonEncode(event)}, ${jsonEncode(data)})');
  }

  /// EVM (EIP-1193) dApp bridge for the injected window.ethereum. Connection +
  /// chain + read-state are handled here; the dApp's handshake is automatic and
  /// the user only approves the single connect prompt. Message/transaction
  /// signing is the next increment (returns a clear notice until then).
  Future<Map<String, dynamic>> _handleEvmRpc(
      String method, List params, String origin) async {
    Map<String, dynamic> err(int code, String msg) => {
          'error': {'code': code, 'message': msg}
        };
    String? evmAddr() {
      try {
        return context.read<MultichainController>().accounts.evmHostedSigner()?.address;
      } catch (_) {
        return null;
      }
    }

    switch (method) {
      case 'eth_chainId':
        return {'result': _evmChainId};
      case 'net_version':
        return {'result': '${int.parse(_evmChainId.substring(2), radix: 16)}'};
      case 'eth_accounts':
        final a = evmAddr();
        return {
          'result': (a != null && _evmConnected.contains(origin)) ? [a] : []
        };
      case 'eth_requestAccounts':
        final a = evmAddr();
        if (a == null) {
          return err(4100,
              'Unlock your multi-chain accounts (Accounts tab) to connect an EVM dApp.');
        }
        if (_evmConnected.contains(origin)) return {'result': [a]};
        final dec = await _approve(ApprovalRequest('connect', origin));
        if (!dec.approved) return err(4001, 'Connection request rejected.');
        _evmConnected.add(origin);
        _emitEvm('accountsChanged', [a]);
        _emitEvm('connect', {'chainId': _evmChainId});
        return {'result': [a]};
      case 'wallet_switchEthereumChain':
        final cid = (params.isNotEmpty && params[0] is Map)
            ? params[0]['chainId']?.toString()
            : null;
        if (cid != null && cid.startsWith('0x')) {
          setState(() => _evmChainId = cid);
          _emitEvm('chainChanged', cid);
        }
        return {'result': null};
      case 'wallet_addEthereumChain':
        return {'result': null};
      case 'personal_sign':
      case 'eth_sign':
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
      case 'eth_sendTransaction':
        return err(4200,
            'Signing from the in-app browser is landing in the next update — '
            'connecting works now; message & transaction signing is on the way.');
      default:
        return err(4200, 'Unsupported method: $method');
    }
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
    final agent = context.read<MultichainController>().agent;
    final result = await showModalBottomSheet<ApprovalResult>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Bk.surface,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (_) => _ApprovalSheet(req: req, app: app, agent: agent, title: _title),
    );
    return result ?? ApprovalResult(false);
  }

  void _go([String? raw]) {
    var u = (raw ?? _urlBar.text).trim();
    if (u.isEmpty) return;
    if (!u.startsWith('http://') && !u.startsWith('https://')) {
      u = u.contains('.') && !u.contains(' ') ? 'https://$u' : 'https://blockle.org/explorer/search?q=${Uri.encodeComponent(u)}';
    }
    if (_atHome) setState(() => _atHome = false);
    _ctrl?.loadUrl(urlRequest: URLRequest(url: WebUri(u)));
  }

  /// A compact toolbar icon button with a tight hit box so several fit without
  /// crowding the URL field (the old wide IconButtons truncated the bar).
  Widget _navIcon(IconData icon, double size, VoidCallback? onTap) {
    return IconButton(
      onPressed: onTap,
      icon: Icon(icon, size: size),
      color: Bk.text,
      disabledColor: Bk.muted.withValues(alpha: 0.4),
      visualDensity: VisualDensity.compact,
      padding: const EdgeInsets.symmetric(horizontal: 4),
      constraints: const BoxConstraints(minWidth: 34, minHeight: 40),
    );
  }

  @override
  Widget build(BuildContext context) {
    // The in-app dApp browser (InAppWebView) isn't supported on Flutter web;
    // offer a new-tab link instead.
    if (kIsWeb) return const _WebBrowserPlaceholder();

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
            padding: const EdgeInsets.fromLTRB(4, 6, 4, 6),
            child: Row(
              children: [
                _navIcon(Icons.arrow_back_ios_new, 16,
                    _canBack ? () => _ctrl?.goBack() : null),
                _navIcon(Icons.arrow_forward_ios, 16,
                    _canFwd ? () => _ctrl?.goForward() : null),
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
                        onTapOutside: (_) =>
                            FocusManager.instance.primaryFocus?.unfocus(),
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
                _navIcon(Icons.refresh, 19, () => _ctrl?.reload()),
                // Prominent, always-visible Connect pill when on a dApp page —
                // taps the dApp's own connect via the injected provider so the
                // user just approves once.
                if (!_atHome)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    child: FilledButton.icon(
                      onPressed: _connectEvm,
                      icon: const Icon(Icons.link, size: 16),
                      label: const Text('Connect'),
                      style: FilledButton.styleFrom(
                        backgroundColor: Bk.accent,
                        foregroundColor: Colors.white,
                        visualDensity: VisualDensity.compact,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        minimumSize: const Size(0, 36),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        textStyle: const TextStyle(
                            fontSize: 13, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
                // Secondary actions live in an overflow menu so the bar never
                // crowds/truncates on narrow phones.
                PopupMenuButton<String>(
                  tooltip: 'More',
                  color: Bk.surface,
                  icon: const Icon(Icons.more_vert, size: 20, color: Bk.muted),
                  onSelected: (v) {
                    switch (v) {
                      case 'home':
                        setState(() => _atHome = true);
                        break;
                      case 'scan':
                        _quickScan();
                        break;
                      case 'connect':
                        _connect();
                        break;
                    }
                  },
                  itemBuilder: (_) => [
                    const PopupMenuItem(
                        value: 'home',
                        child: _MenuRow(Icons.home_outlined, 'Trusted dApps')),
                    if (!_atHome)
                      const PopupMenuItem(
                          value: 'scan',
                          child: _MenuRow(
                              Icons.security_outlined, 'Security scan')),
                    if (!_atHome)
                      const PopupMenuItem(
                          value: 'connect',
                          child: _MenuRow(Icons.link, 'Connect dApp')),
                  ],
                ),
              ],
            ),
          ),
          if (_loading && !_atHome) const LinearProgressIndicator(minHeight: 2, color: Bk.accent, backgroundColor: Bk.surface2),
          Expanded(
            child: Stack(children: [
            InAppWebView(
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
                    // EVM / EIP-1193 methods (Uniswap et al.) are handled by the
                    // EVM bridge; everything else is the BLOCK-native provider.
                    if (method.startsWith('eth_') ||
                        method.startsWith('wallet_') ||
                        method == 'personal_sign' ||
                        method == 'net_version') {
                      return await _handleEvmRpc(method, params, _origin);
                    }
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
                try {
                  _title = await c.getTitle();
                } catch (_) {}
                if (mounted) setState(() => _loading = false);
              },
              onReceivedError: (c, req, err) {
                if (mounted) setState(() => _loading = false);
              },
            ),
            if (_atHome)
              Positioned.fill(
                child: _DappHome(
                  dapps: _dapps,
                  loading: _dappsLoading,
                  onOpen: _openDapp,
                  onRefresh: () {
                    setState(() => _dappsLoading = true);
                    _loadDapps();
                  },
                ),
              ),
          ]),
          ),
        ],
      ),
    );
  }
}

class _WebBrowserPlaceholder extends StatelessWidget {
  const _WebBrowserPlaceholder();
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.public_off, size: 48, color: Bk.muted),
            const SizedBox(height: 16),
            const Text('The in-app dApp browser runs on the mobile/desktop app.',
                textAlign: TextAlign.center,
                style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            const Text(
                'On the web preview, open blockle.org in a new tab. The wallet, '
                'swap and queue tabs work here.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Bk.muted)),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: () => openExternal('https://blockle.org'),
              icon: const Icon(Icons.open_in_new, size: 18),
              label: const Text('Open blockle.org'),
            ),
          ],
        ),
      ),
    );
  }
}

class _ApprovalSheet extends StatefulWidget {
  const _ApprovalSheet({required this.req, required this.app, required this.agent, this.title});
  final ApprovalRequest req;
  final AppState app;
  final AgentService agent;
  final String? title;
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
      // SECURITY GATE (#127): a dApp CONNECT is screened BEFORE the site is
      // recorded. The screening = the rules scam/denylist + host heuristics PLUS
      // the user's LOCAL on-device AI acting as a protector (never the hosted
      // gateway). The combined verdict is shown in the SHARED security confirm
      // sheet; any red flag is a DANGER that forces the explicit "I understand
      // the risk" confirm. A reject aborts WITHOUT connecting — this is the
      // non-bypassable gate, mirroring the sign/deploy pattern below.
      if (req.type == 'connect') {
        final cfg = await buildSiteScreeningConfig(
            widget.agent, req.origin, widget.title, forConnect: true);
        if (!mounted) return;
        final ok = await showSecuritySheet(context, cfg);
        if (!ok) {
          if (mounted) Navigator.pop(context, ApprovalResult(false));
          return;
        }
      }
      dynamic payload;
      if (req.type == 'sign') {
        // SECURITY GATE (docs/WALLET-SECURITY.md §4): a dApp signMessage must be
        // decoded (decodePersonalSign — detects EIP-712 / raw-tx blobs smuggled
        // as "text") and cleared through the SHARED security confirm sheet BEFORE
        // the existing signer signs. A reject aborts WITHOUT signing. The
        // security module stays read-only; app.store.signMessage still signs,
        // only after this returns true.
        final decoded = decodePersonalSign(req.message ?? '');
        if (!mounted) return;
        final ok = await showSecuritySheet(
          context,
          SecuritySheetConfig.fromDecoded(
            decoded,
            title: 'Signature request',
            dappName: req.origin,
            dappUrl: req.origin,
            dappIcon: 'network',
          ),
        );
        if (!ok) {
          if (mounted) Navigator.pop(context, ApprovalResult(false));
          return;
        }
        payload = await app.store.signMessage(req.message ?? '');
      } else if (req.type == 'deploy') {
        // SECURITY GATE: a contract deploy is a value-moving on-chain action, so
        // it runs security.inspectTransaction + the SHARED confirm sheet BEFORE
        // anything is built or broadcast (a DANGER — e.g. a denylisted entity —
        // forces the explicit confirm; a reject aborts without broadcasting). A
        // clean deploy simply shows the uniform preview with no warnings.
        final bytes = (req.code ?? '').length ~/ 2;
        final insp = await sec.inspectTransaction(
          sec.buildInspectTx('block', const {
            'to': null,
            'amount': '0',
            'asset': {'chain': 'block', 'kind': 'native', 'symbol': 'BLOCK', 'decimals': 8},
          }),
          sec.SecCtx(chain: 'block', config: sec.defaultSecurityConfig()),
        );
        if (!mounted) return;
        final ok = await showSecuritySheet(
          context,
          SecuritySheetConfig.fromInspection(
            insp,
            title: 'Deploy contract',
            dappName: req.origin,
            dappUrl: req.origin,
            dappIcon: 'network',
            previewHeader: 'Deploy contract · $bytes bytes · gas ${req.gas ?? '200000'}',
          ),
        );
        if (!ok) {
          if (mounted) Navigator.pop(context, ApprovalResult(false));
          return;
        }
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

// ---------------------------------------------------------------------------
// Secure connect screening (#127): rules gate + local-AI protector → one sheet.
// ---------------------------------------------------------------------------

/// Build the combined connect/scan screening into a plain [SecuritySheetConfig]
/// — the RULES verdict (scam/drainer denylist + lightweight host heuristics) PLUS
/// the LOCAL on-device AI's assessment (via [AgentService.screenSite]; the hosted
/// gateway is never used). Any red flag (denylist hit, punycode lookalike, or an
/// AI-raised flag) is a DANGER severity, which makes [showSecuritySheet] swap in
/// the explicit "I understand the risk" button — the non-bypassable confirm.
Future<SecuritySheetConfig> buildSiteScreeningConfig(
  AgentService agent,
  String origin,
  String? title, {
  required bool forConnect,
}) async {
  const perms = <String>['your wallet address', 'request signatures & transactions'];
  final SiteScreening screening =
      await agent.screenSite(origin: origin, title: title, permissions: perms);
  return composeScreeningConfig(
    origin: origin,
    rules: rulesScreenSite(origin),
    screening: screening,
    forConnect: forConnect,
  );
}

/// Pure composition of the security-sheet config from the already-computed RULES
/// warnings + the (possibly not-run) local-AI [screening]. Separated so it is
/// deterministically unit-testable without a live [AgentService]/vault.
SecuritySheetConfig composeScreeningConfig({
  required String origin,
  required List<SheetWarning> rules,
  required SiteScreening screening,
  required bool forConnect,
}) {
  final warnings = <SheetWarning>[...rules];
  final rows = <MapEntry<String, String>>[];

  if (screening.ran) {
    for (final f in screening.redFlags) {
      warnings.add(SheetWarning('danger', f));
    }
    rows.add(MapEntry('On-device AI',
        screening.assessment.isEmpty ? 'reviewed (no issues stated)' : screening.assessment));
    if (screening.risk == 'medium') {
      warnings.add(const SheetWarning(
          'warn', 'The on-device AI rated this site MEDIUM risk — review before connecting.'));
    } else if (!warnings.any((w) => w.severity == 'danger' || w.severity == 'warn') &&
        (screening.risk == 'low' || screening.risk.isEmpty)) {
      warnings.add(const SheetWarning(
          'info', 'On-device AI screening found no obvious red flags. Always verify the site yourself.'));
    }
  } else {
    rows.add(const MapEntry('On-device AI', 'not run (rules-only)'));
    if (screening.note != null) {
      warnings.add(SheetWarning('info', screening.note!));
    }
  }

  final danger = warnings.any((w) => w.severity == 'danger');
  final host = Uri.tryParse(origin)?.host ?? origin;
  return SecuritySheetConfig(
    title: forConnect ? 'Connect to this dApp' : 'Security scan',
    dappName: host,
    dappUrl: origin,
    dappIcon: 'network',
    previewHeader: forConnect
        ? 'Connecting shares your wallet address and lets this site request signatures.'
        : 'Read-only security scan of this site — nothing is connected.',
    rows: rows,
    warnings: warnings,
    checksLine: checksLineFor(screening.ran ? 2 : 1, const []),
    approveLabel: forConnect
        ? (danger ? 'I understand the risk — connect' : 'Connect')
        : 'Done',
  );
}

/// Rules-based (non-AI) screening of a SITE origin (#127). Reuses the wallet's
/// scam/drainer denylist ([sec.defaultSecurityConfig]) and the lightweight host
/// heuristics the RAG dApp-security chunks describe (punycode/lookalike domain,
/// non-TLS, raw-IP host). Pure + synchronous; the AI assessment augments this,
/// never replaces it.
List<SheetWarning> rulesScreenSite(String origin) {
  final out = <SheetWarning>[];
  final uri = Uri.tryParse(origin);
  final host = (uri?.host ?? '').toLowerCase();
  final cfg = sec.mergeConfig(sec.defaultSecurityConfig());
  if (host.isNotEmpty &&
      (cfg.denylist.contains(host) || cfg.denylist.contains(origin.toLowerCase()))) {
    out.add(const SheetWarning(
        'danger', 'This site is on the wallet scam/drainer denylist. Do not connect.'));
  }
  if (uri != null) {
    if (uri.scheme == 'http') {
      out.add(const SheetWarning('warn',
          'This site is not served over HTTPS — traffic is not encrypted. Legitimate dApps use HTTPS.'));
    }
    if (_isIpLiteral(host)) {
      out.add(const SheetWarning('warn',
          'The site is a raw IP address, not a domain name — unusual for a legitimate dApp.'));
    }
    if (host.contains('xn--')) {
      out.add(const SheetWarning('danger',
          'Punycode (internationalized) domain — this can be a lookalike of a well-known site. Verify carefully.'));
    } else if (_looksLikeLookalike(host)) {
      out.add(const SheetWarning('warn',
          'This domain resembles a well-known brand. Confirm you are on the official site before connecting.'));
    }
  }
  return out;
}

bool _isIpLiteral(String host) =>
    RegExp(r'^\d{1,3}(\.\d{1,3}){3}$').hasMatch(host) || host.contains(':');

const List<String> _knownBrands = [
  'uniswap', 'pancakeswap', 'raydium', 'jupiter', 'aave', 'curve', 'lido',
  'orca', 'stonfi', 'sunswap', 'metamask', 'opensea', 'phantom', 'blockle',
];

/// A domain is a lookalike when a known brand appears as a substring of the
/// registrable label but the label is not exactly that brand (e.g.
/// "myuniswap-airdrop", "uniswaps"). The exact brand label is explicitly safe.
bool _looksLikeLookalike(String host) {
  if (host.isEmpty) return false;
  final labels = host.split('.');
  final core = labels.length >= 2 ? labels[labels.length - 2] : host;
  for (final b in _knownBrands) {
    if (core == b) return false;
    if (core.contains(b)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Curated trusted-dApp homepage (#129)
// ---------------------------------------------------------------------------

/// One entry in the Blockle-curated directory (GET /account/api/dapps).
class _Dapp {
  final String id, name, url, icon;
  final List<String> chains;
  final int popularity;
  const _Dapp(this.id, this.name, this.url, this.icon, this.chains, this.popularity);
  factory _Dapp.fromJson(Map j) => _Dapp(
        '${j['id']}',
        '${j['name']}',
        '${j['url']}',
        '${j['icon'] ?? ''}',
        [for (final c in (j['chains'] as List? ?? const [])) '$c'],
        (j['popularity'] as num?)?.toInt() ?? 0,
      );
}

/// The in-app browser homepage: a Blockle-curated, popularity-ranked directory of
/// TRUSTED dApps (server-maintained, fetched + cached). Tapping a tile navigates
/// AND bumps the pseudonymous open-counter. A safe default pairing with the
/// mandatory connect-time security screening (#127).
class _DappHome extends StatelessWidget {
  const _DappHome({
    required this.dapps,
    required this.loading,
    required this.onOpen,
    required this.onRefresh,
  });
  final List<_Dapp> dapps;
  final bool loading;
  final void Function(_Dapp) onOpen;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Bk.bg,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
        children: [
          Row(children: [
            const Icon(Icons.verified_user, size: 18, color: Bk.accent),
            const SizedBox(width: 8),
            const Expanded(
              child: Text('Trusted dApps',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: Bk.text)),
            ),
            IconButton(
                tooltip: 'Refresh',
                onPressed: onRefresh,
                icon: const Icon(Icons.refresh, size: 18, color: Bk.muted)),
          ]),
          const SizedBox(height: 2),
          const Text(
            'A Blockle-vetted directory, ranked by in-app popularity. Every connection is '
            'security-screened before it is allowed.',
            style: TextStyle(fontSize: 12.5, color: Bk.muted, height: 1.4),
          ),
          const SizedBox(height: 16),
          if (dapps.isEmpty && loading)
            const Padding(
              padding: EdgeInsets.only(top: 40),
              child: Center(child: CircularProgressIndicator(color: Bk.accent)),
            )
          else if (dapps.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 30),
              child: Column(children: [
                const Icon(Icons.cloud_off, size: 36, color: Bk.muted),
                const SizedBox(height: 10),
                const Text('Could not load the dApp directory.',
                    style: TextStyle(color: Bk.muted)),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: onRefresh,
                  icon: const Icon(Icons.refresh, size: 16),
                  label: const Text('Try again'),
                ),
              ]),
            )
          else
            for (final d in dapps) ...[
              _DappCard(dapp: d, onTap: () => onOpen(d)),
              const SizedBox(height: 10),
            ],
        ],
      ),
    );
  }
}

class _DappCard extends StatelessWidget {
  const _DappCard({required this.dapp, required this.onTap});
  final _Dapp dapp;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Bk.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: Bk.border),
          ),
          child: Row(children: [
            Container(
              width: 42,
              height: 42,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: Bk.surface2,
                borderRadius: BorderRadius.circular(11),
              ),
              child: Text(dapp.icon.isEmpty ? '🌐' : dapp.icon,
                  style: const TextStyle(fontSize: 22)),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(dapp.name,
                    style: const TextStyle(
                        fontSize: 15, fontWeight: FontWeight.w700, color: Bk.text)),
                const SizedBox(height: 2),
                Text(Uri.tryParse(dapp.url)?.host ?? dapp.url,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 11.5, color: Bk.muted)),
                const SizedBox(height: 7),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final c in dapp.chains) _chainChip(c),
                ]),
              ]),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right, size: 20, color: Bk.muted),
          ]),
        ),
      ),
    );
  }

  Widget _chainChip(String chain) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Bk.accent.withValues(alpha: 0.13),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: Bk.accent.withValues(alpha: 0.3)),
        ),
        child: Text(_chainLabel(chain),
            style: const TextStyle(fontSize: 10.5, color: Bk.accent2, fontWeight: FontWeight.w600)),
      );

  static String _chainLabel(String c) {
    switch (c.toLowerCase()) {
      case 'evm':
        return 'EVM';
      case 'bnb':
        return 'BNB';
      case 'ton':
        return 'TON';
      case 'tron':
        return 'Tron';
      case 'ethereum':
        return 'Ethereum';
      case 'solana':
        return 'Solana';
      default:
        return c.isEmpty ? c : '${c[0].toUpperCase()}${c.substring(1)}';
    }
  }
}

/// A tiny icon+label row for the browser toolbar's overflow menu items.
class _MenuRow extends StatelessWidget {
  const _MenuRow(this.icon, this.label);
  final IconData icon;
  final String label;
  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 18, color: Bk.muted),
        const SizedBox(width: 12),
        Text(label, style: const TextStyle(color: Bk.text)),
      ],
    );
  }
}
