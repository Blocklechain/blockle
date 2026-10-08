import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

/// Engine — the Blockle crypto core. Runs the extension's WASM signer
/// (ML-DSA-44) and password vault inside a hidden headless WebView, served
/// from the app's assets over a localhost server. Every operation is
/// byte-identical to the browser extension and desktop wallet.
class Engine {
  Engine._();
  static final Engine instance = Engine._();

  static const int _port = 8753;
  InAppLocalhostServer? _server;
  HeadlessInAppWebView? _headless;
  InAppWebViewController? _ctrl;
  final Completer<void> _loaded = Completer<void>();
  Future<void>? _booting;

  Future<void> ensureStarted() {
    return _booting ??= _boot();
  }

  Future<void> _boot() async {
    _server = InAppLocalhostServer(documentRoot: 'assets', port: _port);
    await _server!.start();

    _headless = HeadlessInAppWebView(
      initialUrlRequest:
          URLRequest(url: WebUri('http://localhost:$_port/engine/engine.html')),
      initialSettings: InAppWebViewSettings(
        isInspectable: kDebugMode,
        javaScriptEnabled: true,
        mediaPlaybackRequiresUserGesture: true,
      ),
      onConsoleMessage: (c, m) => debugPrint('[engine] ${m.message}'),
      onWebViewCreated: (c) => _ctrl = c,
      onLoadStop: (c, url) async {
        if (!_loaded.isCompleted) _loaded.complete();
      },
      onReceivedError: (c, req, err) =>
          debugPrint('[engine] load error: ${err.description}'),
    );
    await _headless!.run();
    await _loaded.future;
    // Wait for the WASM module to finish instantiating.
    await _ready();
  }

  Future<void> _ready() async {
    for (var i = 0; i < 100; i++) {
      final r = await _ctrl!.evaluateJavascript(
          source: 'window.__engineLoaded === true');
      if (r == true) break;
      await Future.delayed(const Duration(milliseconds: 50));
    }
    final res = await _ctrl!
        .callAsyncJavaScript(functionBody: 'return await window.Engine.ready();');
    if (res?.error != null) {
      throw Exception('engine init failed: ${res!.error}');
    }
  }

  Future<dynamic> _call(String body) async {
    await ensureStarted();
    final res = await _ctrl!.callAsyncJavaScript(functionBody: body);
    if (res == null) throw Exception('engine call returned null');
    if (res.error != null) throw Exception(res.error.toString());
    return res.value;
  }

  // JSON-string helpers: pass values via callAsyncJavaScript arguments-free
  // bodies that embed JSON.encode-safe literals. We build the JS literal in
  // Dart using jsonEncode of each argument to stay injection-safe.

  Future<Map<String, dynamic>> keygen() async {
    final v = await _call('return await window.Engine.keygen();');
    return _json(v);
  }

  Future<String> addressFromPubkey(String pubHex) async {
    final v = await _call(
        'return await window.Engine.addressFromPubkey(${_s(pubHex)});');
    return v as String;
  }

  Future<Map<String, dynamic>> signMessage(
      String secretHex, String publicHex, String msg) async {
    final v = await _call(
        'return await window.Engine.signMessage(${_s(secretHex)}, ${_s(publicHex)}, ${_s(msg)});');
    return _json(v);
  }

  Future<bool> verify(String publicHex, String msg, String sigHex) async {
    final v = await _call(
        'return await window.Engine.verify(${_s(publicHex)}, ${_s(msg)}, ${_s(sigHex)});');
    return v == true;
  }

  Future<Map<String, dynamic>> buildTransfer(
      String secretHex,
      String publicHex,
      String utxosJson,
      String toAddr,
      String amountBase,
      String feeBase) async {
    final v = await _call(
        'return await window.Engine.buildTransfer(${_s(secretHex)}, ${_s(publicHex)}, ${_s(utxosJson)}, ${_s(toAddr)}, ${_s(amountBase)}, ${_s(feeBase)});');
    return _json(v);
  }

  Future<Map<String, dynamic>> buildDeploy(
      String secretHex,
      String publicHex,
      String utxosJson,
      String codeHex,
      String gasLimit,
      String gasPrice) async {
    final v = await _call(
        'return await window.Engine.buildDeploy(${_s(secretHex)}, ${_s(publicHex)}, ${_s(utxosJson)}, ${_s(codeHex)}, ${_s(gasLimit)}, ${_s(gasPrice)});');
    return _json(v);
  }

  /// Seal plaintext JSON under a password -> sealed-vault JSON string.
  Future<String> seal(String objJson, String password) async {
    final v = await _call(
        'return await window.Engine.seal(${_s(objJson)}, ${_s(password)});');
    return v as String;
  }

  /// Open sealed-vault JSON with a password -> plaintext JSON string.
  /// Throws if the password is wrong.
  Future<String> open(String sealedJson, String password) async {
    final v = await _call(
        'return await window.Engine.open(${_s(sealedJson)}, ${_s(password)});');
    return v as String;
  }

  // ---- helpers ----
  static String _s(String raw) => _dq(raw);
  static Map<String, dynamic> _json(dynamic v) {
    if (v is Map) return Map<String, dynamic>.from(v);
    if (v is String) return Map<String, dynamic>.from(jsonDecode(v) as Map);
    throw Exception('expected JSON, got ${v.runtimeType}');
  }
}

String _dq(String raw) {
  // Produce a safe JS double-quoted string literal.
  final b = StringBuffer('"');
  for (final r in raw.runes) {
    switch (r) {
      case 0x22:
        b.write('\\"');
        break;
      case 0x5C:
        b.write('\\\\');
        break;
      case 0x0A:
        b.write('\\n');
        break;
      case 0x0D:
        b.write('\\r');
        break;
      case 0x09:
        b.write('\\t');
        break;
      case 0x2028:
        b.write('\\u2028');
        break;
      case 0x2029:
        b.write('\\u2029');
        break;
      default:
        if (r < 0x20) {
          b.write('\\u${r.toRadixString(16).padLeft(4, '0')}');
        } else {
          b.writeCharCode(r);
        }
    }
  }
  b.write('"');
  return b.toString();
}
