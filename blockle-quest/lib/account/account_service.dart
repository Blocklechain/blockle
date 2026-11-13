import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Shared **Blockle account** SSO — the same account that powers the wallet and
/// site. Blocklings signs in as a native client (bearer token) against the
/// accounts service; the token is kept in the OS secure store. This is the one
/// identity across wallet + game + economy. Non-custodial: the server never
/// holds keys; on-chain actions still go through the wallet.
class AccountService extends ChangeNotifier {
  AccountService._();
  static final AccountService instance = AccountService._();

  static const String origin = 'https://blockle.org';
  static const _store = FlutterSecureStorage();
  static const _kToken = 'blk_account_token';

  String? _token;
  String? handle;
  String tier = 'free';

  bool get signedIn => _token != null;
  String? get token => _token;

  Future<Map<String, dynamic>> _req(String method, String path,
      {Map<String, dynamic>? body, bool auth = false}) async {
    final headers = <String, String>{'x-blockle-client': 'blocklings'};
    if (body != null) headers['Content-Type'] = 'application/json';
    if (auth && _token != null) headers['Authorization'] = 'Bearer $_token';
    final req = http.Request(method, Uri.parse('$origin$path'))..headers.addAll(headers);
    if (body != null) req.body = jsonEncode(body);
    final resp = await http.Response.fromStream(await req.send());
    final data = resp.body.isEmpty ? <String, dynamic>{} : jsonDecode(resp.body) as Map<String, dynamic>;
    if (resp.statusCode >= 400) {
      throw Exception(data['error'] ?? data['message'] ?? 'http ${resp.statusCode}');
    }
    return data;
  }

  /// Restore a saved session on launch and refresh the profile.
  Future<void> init() async {
    _token = await _store.read(key: _kToken);
    if (_token != null) {
      try {
        await refresh();
      } catch (_) {
        await signOut(); // stale/invalid token
      }
    }
  }

  Future<void> signIn(String email, String password, {String? totp}) async {
    final d = await _req('POST', '/account/api/login',
        body: {'email': email, 'password': password, if (totp != null && totp.isNotEmpty) 'totp': totp});
    final t = d['token'] as String?;
    if (t == null) throw Exception('no token returned');
    _token = t;
    await _store.write(key: _kToken, value: t);
    await refresh();
  }

  Future<String> register(String email, String password, {String? username}) async {
    final d = await _req('POST', '/account/api/register', body: {
      'email': email,
      'password': password,
      if (username != null && username.isNotEmpty) 'username': username,
    });
    return (d['message'] as String?) ?? 'Check your email to verify your account.';
  }

  Future<void> refresh() async {
    final d = await _req('GET', '/account/api/me', auth: true);
    final user = d['user'] as Map<String, dynamic>?;
    handle = (user?['username'] ?? user?['handle'] ?? user?['email']) as String?;
    final sub = user?['sub'] as Map<String, dynamic>?;
    tier = (sub?['tier'] as String?) ?? 'free';
    notifyListeners();
  }

  Future<void> signOut() async {
    _token = null;
    handle = null;
    tier = 'free';
    await _store.delete(key: _kToken);
    notifyListeners();
  }
}
