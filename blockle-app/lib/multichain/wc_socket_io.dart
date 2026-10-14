// wc_socket_io.dart — the native (dart:io) WebSocket implementation of the WC
// relay's socket abstraction. Selected by a conditional import from wc_relay.dart
// on platforms that have dart:io (mobile / desktop / the Flutter test VM). Opens
// a real wss:// connection to the WalletConnect v2 relay.
import 'dart:io' as io;

import 'wc_relay.dart' show WcSocket;

class _IoWcSocket implements WcSocket {
  _IoWcSocket(this._ws) {
    _ws.listen(
      (data) {
        if (_onMessage != null) _onMessage!('$data');
      },
      onDone: () {
        if (_onClose != null) _onClose!();
      },
      onError: (_) {
        if (_onClose != null) _onClose!();
      },
      cancelOnError: true,
    );
  }

  final io.WebSocket _ws;
  void Function(String)? _onMessage;
  void Function()? _onClose;

  @override
  void send(String data) => _ws.add(data);

  @override
  void onMessage(void Function(String data) cb) => _onMessage = cb;

  @override
  void onClose(void Function() cb) => _onClose = cb;

  @override
  Future<void> close() async {
    try {
      await _ws.close();
    } catch (_) {/* best-effort */}
  }
}

Future<WcSocket> openWcSocket(String url) async {
  final ws = await io.WebSocket.connect(url);
  return _IoWcSocket(ws);
}
