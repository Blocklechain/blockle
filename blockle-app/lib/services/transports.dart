// transports.dart — real network transports for the multichain adapters.
//
// The adapters (EVM / Solana / UTXO) accept injectable typed closures:
//   JsonRpcFn  — JSON-RPC 2.0 (EVM eth_*, Solana get*/sendTransaction)
//   HttpGetFn  — Esplora-style GET  (UTXO reads)
//   HttpPostFn — Esplora-style POST (UTXO broadcast)
// This module builds those closures over package:http from the configured
// endpoints (public defaults, overridable in settings), and a registry builder
// that wires a ChainRegistry with them.
//
// Testability: every transport routes through a single injectable [HttpSend]
// seam, so unit tests assert request SHAPING (JSON-RPC envelope, headers, URL
// composition) and response parsing with NO network.

import 'dart:convert';

import 'package:http/http.dart' as http;

import '../multichain/chains/block.dart' show BlockSignerBridge;
import '../multichain/chains/chain_adapter.dart';
import '../multichain/chains/registry.dart';

/// A raw HTTP request (method/url/headers/body) — the one seam every transport
/// funnels through.
class HttpReq {
  const HttpReq(this.method, this.url, {this.headers = const {}, this.body});
  final String method;
  final String url;
  final Map<String, String> headers;
  final String? body;
}

/// A raw HTTP reply.
class HttpReply {
  const HttpReply(this.status, this.body);
  final int status;
  final String body;
}

/// The injectable low-level sender. Default is [httpSend] (package:http); tests
/// inject a capture/stub to verify shaping offline.
typedef HttpSend = Future<HttpReply> Function(HttpReq req);

/// Default sender over package:http.
Future<HttpReply> httpSend(HttpReq req) async {
  final uri = Uri.parse(req.url);
  final http.Response r;
  switch (req.method) {
    case 'GET':
      r = await http.get(uri, headers: req.headers);
      break;
    case 'POST':
      r = await http.post(uri, headers: req.headers, body: req.body);
      break;
    default:
      throw ArgumentError('unsupported method: ${req.method}');
  }
  return HttpReply(r.statusCode, r.body);
}

int _rpcId = 0;

/// Build a [JsonRpcFn] for a JSON-RPC 2.0 endpoint. Posts
/// `{jsonrpc, id, method, params}`, returns `result`, throws on a transport or
/// JSON-RPC `error`.
JsonRpcFn jsonRpc(String url, {HttpSend send = httpSend, Map<String, String>? headers}) {
  final hdrs = {'content-type': 'application/json', ...?headers};
  return (String method, List<dynamic> params) async {
    final reply = await send(HttpReq('POST', url,
        headers: hdrs,
        body: jsonEncode({
          'jsonrpc': '2.0',
          'id': ++_rpcId,
          'method': method,
          'params': params,
        })));
    if (reply.status >= 400) {
      throw StateError('rpc http ${reply.status}');
    }
    final j = jsonDecode(reply.body);
    if (j is Map && j['error'] != null) {
      final e = j['error'];
      throw StateError(e is Map ? (e['message']?.toString() ?? 'rpc error') : '$e');
    }
    return (j is Map) ? j['result'] : j;
  };
}

/// Build an [HttpGetFn] for an Esplora-style base URL. GETs `base + path`.
HttpGetFn esploraGet(String base, {HttpSend send = httpSend}) {
  return (String path) async {
    final reply = await send(HttpReq('GET', base + path));
    if (reply.status >= 400) throw StateError('esplora http ${reply.status}');
    return reply.body;
  };
}

/// Build an [HttpPostFn] for an Esplora-style base URL. POSTs `body` (text) to
/// `base + path`.
HttpPostFn esploraPost(String base, {HttpSend send = httpSend}) {
  return (String path, String body) async {
    final reply = await send(HttpReq('POST', base + path,
        headers: {'content-type': 'text/plain'}, body: body));
    if (reply.status >= 400) throw StateError('esplora http ${reply.status}');
    return reply.body;
  };
}

/// Build a [ChainRegistry] whose EVM / Solana / UTXO adapters are wired with
/// EXPLICIT package:http transports from the resolved endpoint config. The
/// resulting registry behaves identically to `ChainRegistry.create`, but every
/// network edge is an injectable closure (so a test build can swap [send]).
///
/// [endpoints] overrides the public defaults (settings). [block] is the app's
/// BLOCK signer bridge (always supplied by the app; omitted in pure-Dart tests).
ChainRegistry buildWiredRegistry({
  Map<String, EndpointCfg>? endpoints,
  Map<String, List<AssetRef>>? tokens,
  List<String>? enabled,
  BlockSignerBridge? block,
  HttpSend send = httpSend,
}) {
  final ep = {...defaultEndpoints, ...?endpoints};
  return ChainRegistry.create(
    endpoints: ep,
    tokens: tokens,
    enabled: enabled,
    block: block,
    rpcBuilder: (url) => jsonRpc(url, send: send),
    alchemyBuilder: (url) => jsonRpc(url, send: send),
    getBuilder: (base) => esploraGet(base, send: send),
    postBuilder: (base) => esploraPost(base, send: send),
  );
}
