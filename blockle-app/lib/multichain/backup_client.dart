// Blockle encrypted-backup client (Flutter wallet) — Dart port.
//
// Talks to the accounts service as a native wallet (bearer token). Encryption is local via
// backup_crypto; only opaque ciphertext is uploaded (zero-knowledge). 2FA is required for backup
// ops, so a current TOTP code is supplied. Shared contract with backup-client.js / backup_client.py.
import 'dart:convert';
import 'package:http/http.dart' as http;

import 'backup_crypto.dart' as crypto;

const String kDefaultOrigin = 'https://blockle.org';

Future<Map<String, dynamic>> _req(String? origin, String method, String path,
    {String? token, String? totp, Map<String, dynamic>? body}) async {
  final headers = <String, String>{'x-blockle-client': 'wallet'};
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token != null) headers['Authorization'] = 'Bearer $token';
  if (totp != null) headers['x-totp'] = totp;
  final uri = Uri.parse('${origin ?? kDefaultOrigin}$path');
  final req = http.Request(method, uri)..headers.addAll(headers);
  if (body != null) req.body = json.encode(body);
  final resp = await http.Response.fromStream(await req.send());
  final data = resp.body.isEmpty ? <String, dynamic>{} : json.decode(resp.body) as Map<String, dynamic>;
  if (resp.statusCode >= 400) {
    throw Exception(data['error'] ?? data['message'] ?? 'http ${resp.statusCode}');
  }
  return data;
}

/// Sign in; returns the bearer token. [totp] only if 2FA is enabled.
Future<String> login(String? origin, String email, String password, {String? totp}) async {
  final d = await _req(origin, 'POST', '/account/api/login',
      body: {'email': email, 'password': password, if (totp != null) 'totp': totp});
  final token = d['token'] as String?;
  if (token == null) throw Exception('no token returned');
  return token;
}

/// Create a Blockle account. The server sends an email-verification link and
/// returns a generic message (never a token, never reveals if the email exists).
/// Returns the server message to show the user.
Future<String> register(String? origin, String email, String password, {String? username}) async {
  final d = await _req(origin, 'POST', '/account/api/register', body: {
    'email': email,
    'password': password,
    if (username != null && username.isNotEmpty) 'username': username,
  });
  return (d['message'] as String?) ?? 'Check your email to verify your account.';
}

/// The signed-in account (incl. `sub` with the Copilot tier) — for feature gating.
Future<Map<String, dynamic>?> me(String? origin, String token) async {
  final d = await _req(origin, 'GET', '/account/api/me', token: token);
  return d['user'] as Map<String, dynamic>?;
}

/// Extract the EFFECTIVE Copilot tier from a /me user object: the server's `entitledTier`
/// (which folds in an active free trial), falling back to the legacy active+tier for older
/// account-service builds. 'free' when neither applies.
String tierOf(Map<String, dynamic>? user) {
  final sub = (user?['sub'] as Map?)?.cast<String, dynamic>() ?? const {};
  final eff = sub['entitledTier'] as String?;
  if (eff != null && eff.isNotEmpty) return eff;
  return (sub['active'] == true) ? (sub['tier'] as String? ?? 'free') : 'free';
}

/// Extract the per-plan LIVE-bot cap from a /me user object: `sub.liveBotLimit`
/// (Free 1, Copilot 3, Pro -1 = unlimited). Defaults to 1 (the Free cap) when the
/// account service does not report one, mirroring the web wallet (app.js loadTier).
int liveBotLimitOf(Map<String, dynamic>? user) {
  final sub = (user?['sub'] as Map?)?.cast<String, dynamic>() ?? const {};
  final v = sub['liveBotLimit'];
  if (v is num) return v.toInt();
  return 1;
}

/// Quick backtest of a CONFIGURED strategy on recent real prices (the tune-and-test
/// loop). Play-money simulation. Returns {pnlPct, trades, maxDrawdownPct, curve, ...}.
Future<Map<String, dynamic>> backtest(String? origin, String token,
    {required String type, required Map<String, dynamic> params, required String asset}) async {
  return _req(origin, 'POST', '/account/api/backtest', token: token,
      body: {'type': type, 'params': params, 'asset': asset});
}

/// Clone another trader's bot CONFIG into the signed-in account (copy-trade; config
/// only, never funds/live state). Returns the created bot view {type, pair, params, ...}.
Future<Map<String, dynamic>?> copyBot(String? origin, String token, String fromBotId) async {
  final d = await _req(origin, 'POST', '/account/api/bots/copy', token: token,
      body: {'fromBotId': fromBotId});
  return (d['bot'] as Map?)?.cast<String, dynamic>();
}

/// Start the one-time 7-day Copilot free trial. Returns the updated `sub` (incl. entitledTier).
Future<Map<String, dynamic>> startTrial(String? origin, String token) async {
  final d = await _req(origin, 'POST', '/account/api/trial/start', token: token, body: const {});
  return (d['sub'] as Map?)?.cast<String, dynamic>() ?? const {};
}

/// Submit an Apple StoreKit receipt for server-side verification; returns the updated `sub`.
Future<Map<String, dynamic>> verifyAppleIap(String? origin, String token, String receiptData) async {
  final d = await _req(origin, 'POST', '/account/api/iap/apple/verify', token: token, body: {'receiptData': receiptData});
  return (d['sub'] as Map?)?.cast<String, dynamic>() ?? const {};
}

/// Submit a Google Play purchase for server-side verification; returns the updated `sub`.
Future<Map<String, dynamic>> verifyGoogleIap(String? origin, String token, String productId, String purchaseToken) async {
  final d = await _req(origin, 'POST', '/account/api/iap/google/verify', token: token,
      body: {'productId': productId, 'purchaseToken': purchaseToken});
  return (d['sub'] as Map?)?.cast<String, dynamic>() ?? const {};
}

/// Encrypt [vault] with [passphrase] and upload. [meta] is non-secret.
Future<void> backup(String? origin, String token, String totp, Object vault, String passphrase,
    {Map<String, dynamic> meta = const {}}) async {
  final plaintext = vault is String ? vault : json.encode(vault);
  final ciphertext = crypto.encryptVault(passphrase, plaintext);
  await _req(origin, 'PUT', '/account/api/backup', token: token, totp: totp,
      body: {'ciphertext': ciphertext, 'meta': meta});
}

/// Download the latest backup and decrypt locally. Returns the vault JSON string.
Future<String> restore(String? origin, String token, String totp, String passphrase) async {
  final d = await _req(origin, 'GET', '/account/api/backup', token: token, totp: totp);
  final latest = d['latest'] as Map<String, dynamic>?;
  final ct = latest?['ciphertext'] as String?;
  if (ct == null) throw Exception('no backup stored');
  return crypto.decryptVault(passphrase, ct);
}
