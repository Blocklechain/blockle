// bot_delegation_client.dart — thin client for the server-side live-bot
// delegation registry (Stage 1: lifecycle only, NO key material sent).
//
// Registering a delegation tells the server "this live bot is running on this
// chain, within this cap" so the 24/7 runner (Stage 2) can act for it; revoking
// removes it the instant the bot stops / Kill-all fires. Authed with the
// account session bearer — a signed-out (device-only) wallet simply skips these
// calls and the bot runs only while the app is open.

import 'dart:convert';
import 'package:http/http.dart' as http;

typedef HttpPostFn = Future<String> Function(String url, String body, String bearer);

class BotDelegationClient {
  BotDelegationClient({
    required this.origin,
    required this.bearer,
    HttpPostFn? post,
  }) : _post = post ?? _httpPost;

  /// Accounts-server origin (e.g. https://blockle.org).
  final String origin;

  /// Returns the current account session bearer, or null when signed out.
  final String? Function() bearer;
  final HttpPostFn _post;

  static Future<String> _httpPost(String url, String body, String bearer) async {
    final r = await http.post(Uri.parse(url),
        headers: {'content-type': 'application/json', 'authorization': 'Bearer $bearer'},
        body: body);
    if (r.statusCode >= 400) throw StateError('delegation http ${r.statusCode}');
    return r.body;
  }

  bool get _ready {
    final b = bearer();
    return b != null && b.isNotEmpty && origin.isNotEmpty;
  }

  /// Register (or refresh) the delegation for a running live bot. Best-effort:
  /// a signed-out wallet or a network error just means no background running.
  Future<bool> register({
    required String botId,
    required String chain,
    required num capUsd,
    String? address,
  }) async {
    final b = bearer();
    if (!_ready || b == null) return false;
    try {
      await _post(
        '$origin/account/api/bots/delegate',
        jsonEncode({'botId': botId, 'chain': chain, 'capUsd': capUsd, if (address != null) 'address': address}),
        b,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Revoke ONE bot's delegation (bot stopped/removed).
  Future<void> revoke(String botId) => _revoke({'botId': botId});

  /// Revoke EVERY delegation for this account (Kill-all).
  Future<void> revokeAll() => _revoke(const {});

  Future<void> _revoke(Map<String, dynamic> body) async {
    final b = bearer();
    if (!_ready || b == null) return;
    try {
      await _post('$origin/account/api/bots/revoke', jsonEncode(body), b);
    } catch (_) {/* best-effort — server also auto-expires + fail-closes on restart */}
  }
}
