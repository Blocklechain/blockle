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
