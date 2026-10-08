import 'dart:convert';
import 'dart:math';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/wallet.dart';
import 'engine.dart';

class _Session {
  String? id, address, pub, secret;
  int at = 0;
  bool get unlocked => secret != null;
  void clearSecret() {
    secret = null;
    at = 0;
  }
}

/// Multi-wallet key management, backed by the post-quantum WASM engine. Mirrors
/// the extension's wallet.js: each wallet's secret lives only in its
/// password-sealed vault; the active wallet's key is held in an ephemeral
/// in-memory session with auto-lock.
class WalletStore {
  WalletStore(this._engine);
  final Engine _engine;

  static const _kWallets = 'bk_wallets';
  static const _kSelected = 'bk_selectedId';
  static const autoLock = Duration(minutes: 30);

  final _storage = const FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );
  final _session = _Session();
  final _rng = Random.secure();

  String _rid() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return 'w${List.generate(8, (_) => chars[_rng.nextInt(chars.length)]).join()}';
  }

  // ---- raw storage ----
  Future<List<WalletRecord>> _all() async {
    final raw = await _storage.read(key: _kWallets);
    if (raw == null || raw.isEmpty) return [];
    final list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
    return list.map(WalletRecord.fromStore).toList();
  }

  Future<void> _save(List<WalletRecord> list) async {
    await _storage.write(
        key: _kWallets, value: jsonEncode(list.map((w) => w.toStore()).toList()));
  }

  Future<String?> _selectedId() => _storage.read(key: _kSelected);
  Future<void> _setSelected(String? id) async {
    if (id == null) {
      await _storage.delete(key: _kSelected);
    } else {
      await _storage.write(key: _kSelected, value: id);
    }
  }

  Future<WalletRecord?> _selectedRec() async {
    final list = await _all();
    if (list.isEmpty) return null;
    final sel = await _selectedId();
    return list.firstWhere((w) => w.id == sel, orElse: () => list.first);
  }

  // ---- public accessors ----
  String? get address => _session.address;
  String? get publicKeyHex => _session.pub;
  String? get activeId => _session.id;
  bool get isUnlocked {
    if (_session.secret == null) return false;
    if (DateTime.now().millisecondsSinceEpoch - _session.at >
        autoLock.inMilliseconds) {
      _session.clearSecret();
      return false;
    }
    return true;
  }

  Future<bool> exists() async => (await _all()).isNotEmpty;

  Future<List<WalletInfo>> list() async {
    final sel = await _selectedId();
    final all = await _all();
    return all
        .map((w) => WalletInfo(w.id, w.label, w.address, w.watchOnly,
            w.id == (sel ?? _session.id)))
        .toList();
  }

  Future<WalletRecord?> selected() => _selectedRec();

  /// Load the active wallet's public identity (no secret).
  Future<String?> loadPublic() async {
    final rec = await _selectedRec();
    if (rec == null) {
      _session
        ..id = null
        ..address = null
        ..pub = null
        ..clearSecret();
      return null;
    }
    _session
      ..id = rec.id
      ..address = rec.address
      ..pub = rec.publicKey;
    return rec.address;
  }

  Future<String> select(String id) async {
    await _setSelected(id);
    lock();
    return (await loadPublic()) ?? '';
  }

  /// Create a new wallet, seal under [password], append, select, unlock.
  Future<WalletRecord> create(String password, {String? label}) async {
    final kp = await _engine.keygen();
    final sealed = await _engine.seal(
        jsonEncode({'secret': kp['secretKey'], 'public': kp['publicKey']}),
        password);
    final list = await _all();
    final rec = WalletRecord(
      id: _rid(),
      label: label?.isNotEmpty == true ? label! : 'Wallet ${list.length + 1}',
      address: kp['address'] as String,
      publicKey: kp['publicKey'] as String,
      crypto: sealed,
      watchOnly: false,
    );
    list.add(rec);
    await _save(list);
    await _setSelected(rec.id);
    _session
      ..id = rec.id
      ..address = rec.address
      ..pub = rec.publicKey
      ..secret = kp['secretKey'] as String
      ..at = DateTime.now().millisecondsSinceEpoch;
    return rec;
  }

  /// Unlock the active wallet. Throws on wrong password.
  Future<String> unlock(String password) async {
    final rec = await _selectedRec();
    if (rec == null || rec.crypto == null) throw Exception('no wallet');
    final opened = jsonDecode(await _engine.open(rec.crypto!, password))
        as Map<String, dynamic>;
    _session
      ..id = rec.id
      ..address = rec.address
      ..pub = (opened['public'] as String?) ?? rec.publicKey
      ..secret = opened['secret'] as String
      ..at = DateTime.now().millisecondsSinceEpoch;
    return rec.address;
  }

  void lock() => _session.clearSecret();

  void _touch() => _session.at = DateTime.now().millisecondsSinceEpoch;

  Future<Map<String, dynamic>> signMessage(String message) async {
    if (!isUnlocked) throw Exception('locked');
    _touch();
    return _engine.signMessage(_session.secret!, _session.pub!, message);
  }

  Future<bool> verify(
          String message, String publicKeyHex, String signatureHex) =>
      _engine.verify(publicKeyHex, message, signatureHex);

  Future<Map<String, dynamic>> buildTransfer(
      String utxosJson, String toAddress, String amountBase, String feeBase) {
    if (!isUnlocked) throw Exception('locked');
    _touch();
    return _engine.buildTransfer(
        _session.secret!, _session.pub!, utxosJson, toAddress, amountBase, feeBase);
  }

  Future<Map<String, dynamic>> buildDeploy(
      String utxosJson, String codeHex, String gasLimit, String gasPrice) {
    if (!isUnlocked) throw Exception('locked');
    _touch();
    return _engine.buildDeploy(
        _session.secret!, _session.pub!, utxosJson, codeHex, gasLimit, gasPrice);
  }

  Future<Map<String, dynamic>> buildPoolSwapBuy(String utxosJson, String token,
      String amountIn, String minOut, int gasLimit, int gasPrice) {
    if (!isUnlocked) throw Exception('locked');
    _touch();
    return _engine.buildPoolSwapBuy(
        _session.secret!, _session.pub!, utxosJson, token, amountIn, minOut, gasLimit, gasPrice);
  }

  Future<Map<String, dynamic>> buildPoolSwapSell(String utxosJson, String token,
      String amountIn, String minOut, int gasLimit, int gasPrice) {
    if (!isUnlocked) throw Exception('locked');
    _touch();
    return _engine.buildPoolSwapSell(
        _session.secret!, _session.pub!, utxosJson, token, amountIn, minOut, gasLimit, gasPrice);
  }

  // ---- import / export ----
  Future<Map<String, dynamic>> exportRecord([String? id]) async {
    final target = id ?? _session.id;
    final rec = (await _all()).firstWhere((w) => w.id == target,
        orElse: () => throw Exception('no wallet'));
    return rec.toExport();
  }

  /// Import a wallet file and set a NEW local password on it. Mirrors the
  /// extension's importFile: our encrypted format is re-sealed; raw secret/
  /// public hex (incl. desktop wallet.json secret_hex/public_hex) becomes a
  /// full signable wallet; address-only becomes watch-only.
  Future<Map<String, dynamic>> importFile(Map<String, dynamic> obj,
      {String? filePassword, required String newPassword, String? label}) async {
    final list = await _all();

    Future<Map<String, dynamic>> addRec(String? secret, String pub,
        String address, bool watchOnly) async {
      final sealed = watchOnly
          ? null
          : await _engine.seal(
              jsonEncode({'secret': secret, 'public': pub}), newPassword);
      final rec = WalletRecord(
        id: _rid(),
        label: label?.isNotEmpty == true
            ? label!
            : (watchOnly ? 'Imported (watch)' : 'Imported ${list.length + 1}'),
        address: address,
        publicKey: pub,
        crypto: sealed,
        watchOnly: watchOnly,
      );
      list.add(rec);
      await _save(list);
      await _setSelected(rec.id);
      if (!watchOnly) {
        _session
          ..id = rec.id
          ..address = address
          ..pub = pub
          ..secret = secret
          ..at = DateTime.now().millisecondsSinceEpoch;
      } else {
        _session
          ..id = rec.id
          ..address = address
          ..pub = pub
          ..clearSecret();
      }
      return {'address': address, 'id': rec.id, 'mode': watchOnly ? 'watch-only' : 'full'};
    }

    // Our encrypted format -> decrypt with file password, re-seal with new.
    if (obj['format'] == 'blockle-wallet' && obj['crypto'] != null) {
      if (filePassword == null) throw Exception('this file needs its password');
      final opened = jsonDecode(
              await _engine.open(jsonEncode(obj['crypto']), filePassword))
          as Map<String, dynamic>;
      final pub = (opened['public'] as String?) ?? '';
      final address = (obj['address'] as String?) ??
          await _engine.addressFromPubkey(pub);
      return addRec(opened['secret'] as String?, pub, address, false);
    }

    // Raw ML-DSA key material (hex) -> FULL wallet under the new password.
    final rawSecret = (obj['secret'] ?? obj['secretKey'] ?? obj['sk'] ?? obj['secret_hex'])
        as String?;
    final rawPublic = (obj['public'] ?? obj['publicKey'] ?? obj['pk'] ?? obj['public_hex'])
        as String?;
    if (rawSecret != null &&
        rawPublic != null &&
        RegExp(r'^[0-9a-fA-F]+$').hasMatch(rawSecret)) {
      final address = (obj['address'] as String?) ??
          await _engine.addressFromPubkey(rawPublic);
      return addRec(rawSecret, rawPublic, address, false);
    }

    if (obj['encrypted'] == true && obj['address'] != null) {
      throw Exception(
          'this wallet file is encrypted — decrypt it in the desktop wallet and export again');
    }

    final addr =
        (obj['address'] ?? obj['block_address'] ?? obj['receive_address']) as String?;
    if (addr != null && addr.startsWith('block1')) {
      return addRec(null, '', addr, true);
    }
    throw Exception('unrecognized wallet file');
  }

  Future<void> remove(String id) async {
    var list = await _all();
    list = list.where((w) => w.id != id).toList();
    await _save(list);
    if (_session.id == id) lock();
    await _setSelected(list.isNotEmpty ? list.first.id : null);
    await loadPublic();
  }

  Future<void> reset() async {
    await _storage.delete(key: _kWallets);
    await _storage.delete(key: _kSelected);
    _session
      ..id = null
      ..address = null
      ..pub = null
      ..clearSecret();
  }
}
