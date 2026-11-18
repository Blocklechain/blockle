// dapp_link.dart — the `blockle://dapp?req=<reqId>` deep-link handler.
//
// An external app (the Blockle Idle game) hands a CONNECT or MINT request to
// this wallet through a relay-poll handshake:
//   1. The game  POST /session {app,kind,payload} -> {reqId}, then opens
//      `blockle://dapp?req=<reqId>`.
//   2. This wallet GETs the session, shows an explicit approval screen, and —
//      only on the user's approval — resolves it:
//        - connect: resolve with the wallet's current BLOCK address.
//        - mint:    build + sign + submit a BLOCK-721 LaunchNft (a 1-item
//                   collection carrying on-chain meta {uid, name}) reusing the
//                   SAME signer path as the in-app browser's contract deploy
//                   (WalletStore, which drives the WASM ML-DSA engine), then
//                   resolve with {token, tokenId:'', tx}.
//   3. POST /session/<reqId>/resolve {status, address, result}.
//
// SECURITY: nothing is signed without an explicit on-screen approval; the
// wallet must be unlocked (the screen prompts for the password if it is not);
// any error resolves the session "rejected" so the game never hangs.

import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../screens/dapp_approval.dart';
import '../state/app_state.dart';
import 'block721.dart';

/// BLOCK-721 LaunchNft gas budget — the proven Blocklings launch budget
/// (mirrors blocklings-web: 400,000 gas × 10 base/gas → ~0.04 BLOCK fee).
const String _kGasLimit = '400000';
const String _kGasPrice = '10';

/// Hard cap the chain enforces on deployed contract code.
const int _kMaxCodeBytes = 24576;

/// Resolver for the `blockle://dapp` relay handshake. One instance is created
/// in main.dart and fed every incoming link (cold-start + while-running).
class DappLink {
  DappLink(this.app, this.navKey, {http.Client? client, String? apiBase})
      : _http = client ?? http.Client(),
        apiBase = apiBase ?? 'https://blockle.org/api/dapp';

  final AppState app;
  final GlobalKey<NavigatorState> navKey;
  final http.Client _http;
  final String apiBase;

  /// Guard so a duplicate/relaunch link can't open two approval screens for the
  /// same request at once.
  bool _busy = false;

  /// Only our own scheme + host, with a sane-looking req id, is ever acted on.
  static final RegExp _reqRe = RegExp(r'^[A-Za-z0-9_-]{1,128}$');

  /// Entry point. Ignores anything that is not `blockle://dapp?req=<reqId>`.
  Future<void> handleUri(Uri uri) async {
    if (uri.scheme.toLowerCase() != 'blockle') return;
    if (uri.host.toLowerCase() != 'dapp') return;
    final req = uri.queryParameters['req'];
    if (req == null || !_reqRe.hasMatch(req)) return;
    if (_busy) return;
    _busy = true;
    try {
      await _run(req);
    } catch (_) {
      // Last-ditch: never let an unexpected failure leave the game hanging.
      await _resolveRejected(req);
    } finally {
      _busy = false;
    }
  }

  Future<void> _run(String reqId) async {
    // A cold-start link can arrive before the navigator is attached — wait
    // briefly for it so the approval screen can be pushed.
    NavigatorState? nav;
    for (var i = 0; i < 40; i++) {
      nav = navKey.currentState;
      if (nav != null) break;
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    if (nav == null) return;

    // 1. Fetch the pending session.
    final Map<String, dynamic> session;
    try {
      session = await _getSession(reqId);
    } catch (_) {
      await _resolveRejected(reqId);
      return;
    }
    final kind = '${session['kind'] ?? ''}';
    if (kind != 'connect' && kind != 'mint') {
      await _resolveRejected(reqId);
      return;
    }
    final appName = '${session['app'] ?? 'A dApp'}';
    final payload = (session['payload'] is Map)
        ? Map<String, dynamic>.from(session['payload'] as Map)
        : <String, dynamic>{};

    // 2. Show the approval screen. It owns unlock + progress + errors and
    //    returns the approved resolve-body, or null if the user rejected.
    final result = await nav.push<Map<String, dynamic>>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => DappApprovalScreen(
          app: app,
          kind: kind,
          appName: appName,
          payload: payload,
          onApprove: kind == 'connect' ? _doConnect : () => _doMint(payload),
        ),
      ),
    );

    // 3. Resolve the session either way.
    if (result != null) {
      await _resolve(reqId, result);
    } else {
      await _resolveRejected(reqId);
    }
  }

  // ---- actions (run only AFTER the screen has an unlocked wallet) ----

  /// connect: hand back the wallet's current BLOCK address.
  Future<Map<String, dynamic>> _doConnect() async {
    final addr = app.store.address;
    if (addr == null || addr.isEmpty) {
      throw Exception('No wallet is set up in Blockle Wallet');
    }
    return {'status': 'approved', 'address': addr};
  }

  /// mint: build + sign + submit a BLOCK-721 LaunchNft, reusing the SAME signer
  /// path as the in-app browser's contract deploy (WalletStore → WASM engine).
  Future<Map<String, dynamic>> _doMint(Map<String, dynamic> payload) async {
    final addr = app.store.address;
    if (addr == null || addr.isEmpty) {
      throw Exception('No wallet is set up in Blockle Wallet');
    }
    final uid = '${payload['uid'] ?? ''}';
    final rawName = '${payload['name'] ?? ''}'.trim();
    if (uid.isEmpty) throw Exception('mint request is missing a uid');

    // On-chain, immutable metadata (selector 9 `meta()`): the canonical uid +
    // display name (+ cosmetic key when present).
    final meta = <String, dynamic>{'uid': uid, 'name': rawName};
    final cosmetic = payload['cosmetic'];
    if (cosmetic != null) meta['cosmetic'] = cosmetic;
    final metaJson = jsonEncode(meta);

    // BLOCK-721 collection: <=32-char name, symbol 'BLKG', meta blob.
    final name = rawName.isEmpty
        ? 'Blockling Item'
        : rawName.substring(0, math.min(32, rawName.length));
    final asm = block721Asm(name, 'BLKG', metaJson);

    // Assemble via the consensus assembler, then enforce the code cap.
    final asmRes = await app.store.assembleAsm(asm);
    if (asmRes['ok'] != true || asmRes['bytecode'] == null) {
      throw Exception('BLOCK-721 assembly failed: ${asmRes['error'] ?? 'unknown'}');
    }
    final codeHex = asmRes['bytecode'] as String;
    if (codeHex.length ~/ 2 > _kMaxCodeBytes) {
      throw Exception('NFT code exceeds the $_kMaxCodeBytes-byte chain cap');
    }

    // Fund from the wallet's UTXOs; build+sign the launch tx; derive the
    // collection contract id from the (node-spelling) txid; broadcast.
    final u = await app.chain.utxos(addr);
    final utxos = (u?['utxos'] as List?) ?? const [];
    final built =
        await app.store.buildLaunchNft(jsonEncode(utxos), codeHex, _kGasLimit, _kGasPrice);
    final builtTxid = '${built['txid'] ?? ''}';
    if (builtTxid.isEmpty || built['raw'] == null) {
      throw Exception('could not build the mint transaction');
    }
    final token = await app.store.contractIdForTxid(builtTxid);
    final submitRes = await app.chain.submit(built['raw'] as String);
    // chain.submit returns the display-spelling txid; fall back to the builder's.
    final tx = (submitRes is Map && submitRes['txid'] != null)
        ? '${submitRes['txid']}'
        : builtTxid;
    await app.addPending(tx, 'Mint NFT');

    return {
      'status': 'approved',
      'address': addr,
      'result': {'token': token, 'tokenId': '', 'tx': tx},
    };
  }

  // ---- relay I/O ----

  Future<Map<String, dynamic>> _getSession(String reqId) async {
    final r = await _http
        .get(Uri.parse('$apiBase/session/$reqId'),
            headers: const {'accept': 'application/json'})
        .timeout(const Duration(seconds: 12));
    if (r.statusCode >= 400) {
      throw Exception('relay session ${r.statusCode}');
    }
    final j = jsonDecode(r.body);
    if (j is! Map) throw Exception('bad relay session');
    return Map<String, dynamic>.from(j);
  }

  Future<void> _resolve(String reqId, Map<String, dynamic> body) async {
    try {
      await _http
          .post(Uri.parse('$apiBase/session/$reqId/resolve'),
              headers: const {'content-type': 'application/json'},
              body: jsonEncode(body))
          .timeout(const Duration(seconds: 12));
    } catch (_) {
      // Best-effort: the game also times out its poll, so a lost resolve POST
      // degrades gracefully rather than throwing into the deep-link callback.
    }
  }

  Future<void> _resolveRejected(String reqId) =>
      _resolve(reqId, {'status': 'rejected', 'address': app.store.address ?? ''});
}
