/// Blocklings — iOS shell.
///
/// The game itself is the web build served from https://blockle.org/blocklings/
/// (updated server-side; no app release needed for game updates). This shell is
/// a fullscreen WKWebView plus the ONE thing the web cannot do on iOS: real
/// StoreKit purchases for GOLD, exposed to the page as `window.blocklingsIAP`.
///
/// Bridge contract (what the game's gold module expects):
///   window.blocklingsIAP.buy(sku) -> Promise<{ receipt: string }>
/// The receipt is the App Store receipt (base64) which the game POSTs to the
/// accounts service for server-side validation; GOLD is only ever credited
/// there. Nothing in this shell grants anything.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

const _gameUrl = 'https://blockle.org/blocklings/';
const _goldSkus = <String>{'gold_100', 'gold_550', 'gold_1200', 'gold_2600'};

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const BlocklingsShell());
}

class BlocklingsShell extends StatelessWidget {
  const BlocklingsShell({super.key});
  @override
  Widget build(BuildContext context) => const MaterialApp(
        title: 'Blocklings',
        debugShowCheckedModeBanner: false,
        home: ShellScreen(),
      );
}

class ShellScreen extends StatefulWidget {
  const ShellScreen({super.key});
  @override
  State<ShellScreen> createState() => _ShellScreenState();
}

class _ShellScreenState extends State<ShellScreen> {
  late final WebViewController _web;
  bool _loading = true;
  bool _failed = false;

  // In-flight IAP requests keyed by the JS-side call id.
  final Map<String, String> _pendingSkuByCallId = {};
  StreamSubscription<List<PurchaseDetails>>? _purchases;

  @override
  void initState() {
    super.initState();

    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0d1b2a))
      ..addJavaScriptChannel('BlocklingsIAPNative', onMessageReceived: (msg) {
        _onIapRequest(msg.message);
      })
      // External-browser bridge: MoonPay (and anything else that refuses to
      // render in-frame) opens in Safari. The page exposes it as
      // window.blocklingsOpenURL(url) via the shim below.
      ..addJavaScriptChannel('BlocklingsNavNative', onMessageReceived: (msg) {
        final uri = Uri.tryParse(msg.message);
        if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) {
          launchUrl(uri, mode: LaunchMode.externalApplication);
        }
      })
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (_) {
          _injectIapShim();
          if (mounted) setState(() => _loading = false);
        },
        onWebResourceError: (err) {
          // Only the main frame failing should show the offline screen.
          if (err.isForMainFrame ?? true) {
            if (mounted) setState(() => _failed = true);
          }
        },
      ))
      ..loadRequest(Uri.parse(_gameUrl));

    _purchases = InAppPurchase.instance.purchaseStream.listen(
      _onPurchaseUpdates,
      onError: (Object e) => _rejectAll('purchase stream error: $e'),
    );
  }

  @override
  void dispose() {
    _purchases?.cancel();
    super.dispose();
  }

  /// window.blocklingsIAP shim: forwards buy() to this shell and awaits the
  /// native resolution routed back through __blkIapSettle.
  void _injectIapShim() {
    const shim = '''
      (function () {
        if (window.blocklingsIAP) return;
        const pending = new Map();
        let seq = 0;
        window.__blkIapSettle = function (id, ok, payload) {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          ok ? p.resolve(payload) : p.reject(new Error(payload));
        };
        window.blocklingsOpenURL = function (u) { BlocklingsNavNative.postMessage(String(u)); };
        window.blocklingsIAP = {
          buy: function (sku) {
            return new Promise(function (resolve, reject) {
              const id = 'iap' + (++seq) + '_' + Date.now();
              pending.set(id, { resolve: resolve, reject: reject });
              BlocklingsIAPNative.postMessage(JSON.stringify({ id: id, sku: sku }));
            });
          }
        };
      })();
    ''';
    _web.runJavaScript(shim);
  }

  Future<void> _onIapRequest(String raw) async {
    String? callId;
    try {
      final req = jsonDecode(raw) as Map<String, dynamic>;
      callId = req['id'] as String;
      final sku = req['sku'] as String;
      if (!_goldSkus.contains(sku)) {
        _settle(callId, false, 'unknown sku');
        return;
      }
      final available = await InAppPurchase.instance.isAvailable();
      if (!available) {
        _settle(callId, false, 'App Store unavailable');
        return;
      }
      final resp = await InAppPurchase.instance.queryProductDetails({sku});
      final product = resp.productDetails.firstOrNull;
      if (product == null) {
        _settle(callId, false, 'product not configured in App Store Connect');
        return;
      }
      _pendingSkuByCallId[callId] = sku;
      final ok = await InAppPurchase.instance.buyConsumable(
        purchaseParam: PurchaseParam(productDetails: product),
      );
      if (!ok) {
        _pendingSkuByCallId.remove(callId);
        _settle(callId, false, 'purchase could not start');
      }
      // Success resolves via the purchase stream.
    } catch (e) {
      if (callId != null) _settle(callId, false, 'iap error: $e');
    }
  }

  void _onPurchaseUpdates(List<PurchaseDetails> purchases) {
    for (final p in purchases) {
      if (p.status == PurchaseStatus.purchased || p.status == PurchaseStatus.restored) {
        final receipt = p.verificationData.serverVerificationData;
        // Resolve every waiting call for this product (normally exactly one).
        final ids = _pendingSkuByCallId.entries
            .where((e) => e.value == p.productID)
            .map((e) => e.key)
            .toList();
        for (final id in ids) {
          _pendingSkuByCallId.remove(id);
          _settle(id, true, jsonEncode({'receipt': receipt}));
        }
        InAppPurchase.instance.completePurchase(p);
      } else if (p.status == PurchaseStatus.error || p.status == PurchaseStatus.canceled) {
        final ids = _pendingSkuByCallId.entries
            .where((e) => e.value == p.productID)
            .map((e) => e.key)
            .toList();
        for (final id in ids) {
          _pendingSkuByCallId.remove(id);
          _settle(id, false, p.error?.message ?? 'purchase ${p.status.name}');
        }
        if (p.pendingCompletePurchase) InAppPurchase.instance.completePurchase(p);
      }
    }
  }

  void _rejectAll(String reason) {
    for (final id in _pendingSkuByCallId.keys.toList()) {
      _settle(id, false, reason);
    }
    _pendingSkuByCallId.clear();
  }

  void _settle(String callId, bool ok, String payload) {
    // Payload goes through as a JS string (JSON for success payloads).
    final js = ok
        ? 'window.__blkIapSettle(${jsonEncode(callId)}, true, ${payload.startsWith('{') ? payload : jsonEncode(payload)})'
        : 'window.__blkIapSettle(${jsonEncode(callId)}, false, ${jsonEncode(payload)})';
    _web.runJavaScript(js);
  }

  Future<void> _retry() async {
    setState(() {
      _failed = false;
      _loading = true;
    });
    await _web.loadRequest(Uri.parse(_gameUrl));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0d1b2a),
      body: _failed
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('BLOCKLINGS',
                      style: TextStyle(
                          color: Color(0xFFE9C46A),
                          fontSize: 32,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 4)),
                  const SizedBox(height: 12),
                  const Text('The realm is unreachable. Check your connection.',
                      style: TextStyle(color: Colors.white70)),
                  const SizedBox(height: 20),
                  FilledButton(onPressed: _retry, child: const Text('Try Again')),
                ],
              ),
            )
          : Stack(
              children: [
                WebViewWidget(
                  controller: _web,
                  // iOS: the WebView must WIN Flutter's gesture arena outright,
                  // or taps get claimed by the framework and never reach the
                  // page (pinch slipped through, everything else was dead).
                  gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{
                    Factory<OneSequenceGestureRecognizer>(EagerGestureRecognizer.new),
                  },
                ),
                if (_loading)
                  const ColoredBox(
                    color: Color(0xFF0d1b2a),
                    child: Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text('BLOCKLINGS',
                              style: TextStyle(
                                  color: Color(0xFFE9C46A),
                                  fontSize: 32,
                                  fontWeight: FontWeight.w900,
                                  letterSpacing: 4)),
                          SizedBox(height: 18),
                          SizedBox(
                            width: 180,
                            child: LinearProgressIndicator(
                              color: Color(0xFF7ed957),
                              backgroundColor: Color(0xFF1b263b),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
    );
  }
}
