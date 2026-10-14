// wc_socket_stub.dart — the no-dart:io fallback for openWcSocket (e.g. web, where
// a raw WebSocket client would need a different transport). The WC relay accepts
// an injected socketFactory; this stub only runs when nothing native is wired.
import 'wc_relay.dart' show WcSocket;

Future<WcSocket> openWcSocket(String url) =>
    throw UnsupportedError(
        'wc-relay: no native WebSocket on this platform — inject a socketFactory');
