// token_list.dart — the user's BLOCK-20 watch-list (contract ids), shared by
// the Wallet tab (Import), the Swap screen and the Moon buy flow so a token
// you just BOUGHT is listed immediately (balance fills in once the swap
// confirms) instead of only ever appearing after a manual Import.
//
// Storage: the same secure-storage key the Wallet tab has always used, so
// existing imports carry over unchanged.
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const kBlockTokensKey = 'bk_tokens';

const _storage = FlutterSecureStorage(
  aOptions: AndroidOptions(encryptedSharedPreferences: true),
);

/// Injectable backing store (tests swap this for an in-memory map).
class TokenListStore {
  TokenListStore({Future<String?> Function(String key)? read,
      Future<void> Function(String key, String value)? write})
      : _read = read ?? ((k) => _storage.read(key: k)),
        _write = write ?? ((k, v) => _storage.write(key: k, value: v));
  final Future<String?> Function(String key) _read;
  final Future<void> Function(String key, String value) _write;

  Future<List<String>> list() async {
    try {
      final raw = await _read(kBlockTokensKey);
      if (raw == null || raw.isEmpty) return <String>[];
      final v = jsonDecode(raw);
      if (v is! List) return <String>[];
      return v.map((e) => e.toString()).where((e) => e.isNotEmpty).toList();
    } catch (_) {
      return <String>[];
    }
  }

  /// Add [contractId] (64-hex) to the list. Returns true when newly added.
  Future<bool> remember(String contractId) async {
    final id = contractId.trim().toLowerCase();
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(id)) return false;
    final ids = await list();
    if (ids.any((e) => e.toLowerCase() == id)) return false;
    ids.add(id);
    await _write(kBlockTokensKey, jsonEncode(ids));
    return true;
  }

  Future<void> replace(List<String> ids) =>
      _write(kBlockTokensKey, jsonEncode(ids));
}

/// Process-wide store (the app's secure storage).
TokenListStore blockTokenList = TokenListStore();

Future<List<String>> listBlockTokens() => blockTokenList.list();
Future<bool> rememberBlockToken(String contractId) => blockTokenList.remember(contractId);
