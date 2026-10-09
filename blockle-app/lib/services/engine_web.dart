import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

/// Engine (web) — the Blockle crypto core on Flutter web. Instead of a headless
/// WebView (unavailable on web), it calls the in-page `window.Engine` defined by
/// web/blockle_engine.js, which runs the SAME WASM signer + vault. Public API is
/// identical to the native Engine so the rest of the app is unchanged.

@JS('Engine')
external _EngineJS get _engine;

@JS('__engineLoaded')
external JSBoolean? get _engineLoaded;

extension type _EngineJS._(JSObject _) implements JSObject {
  external JSPromise<JSAny?> ready();
  external JSPromise<JSString> keygen();
  external JSPromise<JSString> addressFromPubkey(JSString pubHex);
  external JSPromise<JSString> signMessage(JSString s, JSString p, JSString m);
  external JSPromise<JSBoolean> verify(JSString p, JSString m, JSString sig);
  external JSPromise<JSString> buildTransfer(
      JSString s, JSString p, JSString utxos, JSString to, JSString amt, JSString fee);
  external JSPromise<JSString> buildDeploy(
      JSString s, JSString p, JSString utxos, JSString code, JSString gl, JSString gp);
  external JSPromise<JSString> buildPoolSwapBuy(JSString s, JSString p, JSString utxos,
      JSString tok, JSString amt, JSString min, JSString gl, JSString gp);
  external JSPromise<JSString> buildPoolSwapSell(JSString s, JSString p, JSString utxos,
      JSString tok, JSString amt, JSString min, JSString gl, JSString gp);
  external JSPromise<JSString> seal(JSString obj, JSString pw);
  external JSPromise<JSString> open(JSString sealed, JSString pw);
}

class Engine {
  Engine._();
  static final Engine instance = Engine._();

  Future<void>? _booting;

  Future<void> ensureStarted() {
    _booting ??= _boot().catchError((e) {
      _booting = null;
      throw e;
    });
    return _booting!;
  }

  Future<void> _boot() async {
    // The engine script is loaded synchronously in <head>, so it's normally
    // ready before Dart runs; poll briefly just in case.
    for (var i = 0; i < 200; i++) {
      if (_engineLoaded?.toDart ?? false) break;
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    if (!(_engineLoaded?.toDart ?? false)) {
      throw Exception('crypto engine script failed to load');
    }
    await _engine.ready().toDart;
  }

  Future<String> _str(JSPromise<JSString> p) async => (await p.toDart).toDart;

  Future<Map<String, dynamic>> keygen() async {
    await ensureStarted();
    return _json(await _str(_engine.keygen()));
  }

  Future<String> addressFromPubkey(String pubHex) async {
    await ensureStarted();
    return _str(_engine.addressFromPubkey(pubHex.toJS));
  }

  Future<Map<String, dynamic>> signMessage(
      String secretHex, String publicHex, String msg) async {
    await ensureStarted();
    return _json(await _str(_engine.signMessage(secretHex.toJS, publicHex.toJS, msg.toJS)));
  }

  Future<bool> verify(String publicHex, String msg, String sigHex) async {
    await ensureStarted();
    return (await _engine.verify(publicHex.toJS, msg.toJS, sigHex.toJS).toDart).toDart;
  }

  Future<Map<String, dynamic>> buildTransfer(String secretHex, String publicHex,
      String utxosJson, String toAddr, String amountBase, String feeBase) async {
    await ensureStarted();
    return _json(await _str(_engine.buildTransfer(secretHex.toJS, publicHex.toJS,
        utxosJson.toJS, toAddr.toJS, amountBase.toJS, feeBase.toJS)));
  }

  Future<Map<String, dynamic>> buildDeploy(String secretHex, String publicHex,
      String utxosJson, String codeHex, String gasLimit, String gasPrice) async {
    await ensureStarted();
    return _json(await _str(_engine.buildDeploy(secretHex.toJS, publicHex.toJS,
        utxosJson.toJS, codeHex.toJS, gasLimit.toJS, gasPrice.toJS)));
  }

  Future<Map<String, dynamic>> buildPoolSwapBuy(String secretHex, String publicHex,
      String utxosJson, String tokenHex, String amountIn, String minOut,
      int gasLimit, int gasPrice) async {
    await ensureStarted();
    return _json(await _str(_engine.buildPoolSwapBuy(secretHex.toJS, publicHex.toJS,
        utxosJson.toJS, tokenHex.toJS, amountIn.toJS, minOut.toJS,
        gasLimit.toString().toJS, gasPrice.toString().toJS)));
  }

  Future<Map<String, dynamic>> buildPoolSwapSell(String secretHex, String publicHex,
      String utxosJson, String tokenHex, String amountIn, String minOut,
      int gasLimit, int gasPrice) async {
    await ensureStarted();
    return _json(await _str(_engine.buildPoolSwapSell(secretHex.toJS, publicHex.toJS,
        utxosJson.toJS, tokenHex.toJS, amountIn.toJS, minOut.toJS,
        gasLimit.toString().toJS, gasPrice.toString().toJS)));
  }

  Future<String> seal(String objJson, String password) async {
    await ensureStarted();
    return _str(_engine.seal(objJson.toJS, password.toJS));
  }

  Future<String> open(String sealedJson, String password) async {
    await ensureStarted();
    return _str(_engine.open(sealedJson.toJS, password.toJS));
  }

  static Map<String, dynamic> _json(String s) =>
      Map<String, dynamic>.from(jsonDecode(s) as Map);
}
