// vault_store.dart — persistence + ephemeral session for the multi-chain vault.
//
// The sealed blob (scrypt + AES-256-GCM, see vault.dart) is stored in
// flutter_secure_storage (Keychain / Keystore). The DECRYPTED plaintext lives
// only in an in-memory session with an auto-lock timer — never on disk. Lock /
// kill wipes the decrypted HD seed, the BLOCK key, and the agent credential from
// memory, exactly as §4.3 of docs/MULTICHAIN-WALLET.md requires.
//
// The SealedVault JSON is byte-identical to the extension's and the Qt wallet's,
// so a vault exported from one opens in another with the same password.

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'vault.dart';

/// The decrypted secret state (VaultPlaintext in the contract). Lives only in
/// the ephemeral session; never persisted in the clear.
class VaultPlaintext {
  int version;
  String? mnemonic; // BIP39 for every secp256k1 chain (EVM/BTC/LTC/DOGE)
  Map<String, String>? block; // BLOCK ML-DSA-44 keypair {secret, public}
  Map<String, dynamic>? agent; // { provider, apiKey } — optional LLM credential
  Map<String, dynamic>? endpoints;
  List<dynamic>? tokens;
  List<dynamic>? accounts;

  VaultPlaintext({
    this.version = 2,
    this.mnemonic,
    this.block,
    this.agent,
    this.endpoints,
    this.tokens,
    this.accounts,
  });

  Map<String, dynamic> toJson() => {
        'version': version,
        if (mnemonic != null) 'mnemonic': mnemonic,
        if (block != null) 'block': block,
        if (agent != null) 'agent': agent,
        if (endpoints != null) 'endpoints': endpoints,
        if (tokens != null) 'tokens': tokens,
        if (accounts != null) 'accounts': accounts,
      };

  factory VaultPlaintext.fromJson(Map<String, dynamic> j) => VaultPlaintext(
        version: (j['version'] as num?)?.toInt() ?? 2,
        mnemonic: j['mnemonic'] as String?,
        block: (j['block'] as Map?)?.map((k, v) => MapEntry('$k', '$v')),
        agent: (j['agent'] as Map?)?.cast<String, dynamic>(),
        endpoints: (j['endpoints'] as Map?)?.cast<String, dynamic>(),
        tokens: j['tokens'] as List?,
        accounts: j['accounts'] as List?,
      );
}

/// The minimal unlocked-vault surface the Accounts facade depends on.
/// [MultichainVaultStore] implements it; unit tests fake it so account
/// derivation can run without flutter_secure_storage / platform channels.
abstract class VaultSession {
  bool get isUnlocked;
  Future<VaultPlaintext> unlock(String password);
  void lock();
  VaultPlaintext? get plaintext;
}

class _Session {
  VaultPlaintext? plaintext;
  int at = 0;
  bool get unlocked => plaintext != null;
  void clear() {
    plaintext = null;
    at = 0;
  }
}

/// Persists one sealed multi-chain vault and manages its unlocked session. For
/// multi-wallet, construct one per wallet record (keyed by [storageKey]).
class MultichainVaultStore implements VaultSession {
  MultichainVaultStore({
    FlutterSecureStorage? storage,
    this.storageKey = 'bk_mc_vault',
    this.autoLock = const Duration(minutes: 30),
  }) : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final FlutterSecureStorage _storage;
  final String storageKey;
  final Duration autoLock;
  final _Session _session = _Session();

  @override
  bool get isUnlocked {
    if (_session.plaintext == null) return false;
    if (DateTime.now().millisecondsSinceEpoch - _session.at >
        autoLock.inMilliseconds) {
      _session.clear();
      return false;
    }
    return true;
  }

  Future<bool> exists() async =>
      (await _storage.read(key: storageKey))?.isNotEmpty ?? false;

  Future<SealedVault?> _readSealed() async {
    final raw = await _storage.read(key: storageKey);
    if (raw == null || raw.isEmpty) return null;
    return SealedVault.fromJson(jsonDecode(raw) as Map<String, dynamic>);
  }

  Future<void> _writeSealed(SealedVault sealed) =>
      _storage.write(key: storageKey, value: jsonEncode(sealed.toJson()));

  /// Seal [plaintext] under [password] and persist. Also opens the session.
  Future<void> create(VaultPlaintext plaintext, String password) async {
    final sealed = Vault.seal(plaintext.toJson(), password);
    await _writeSealed(sealed);
    _openSession(plaintext);
  }

  /// Unlock the stored vault. Throws [WrongPasswordException] on a wrong
  /// password. Transparently re-seals a legacy v1 blob as v2 on success.
  @override
  Future<VaultPlaintext> unlock(String password) async {
    final sealed = await _readSealed();
    if (sealed == null) throw StateError('no vault');
    final decoded = Vault.open(sealed, password) as Map<String, dynamic>;
    final pt = VaultPlaintext.fromJson(decoded);
    if (Vault.needsUpgrade(sealed)) {
      // transparent v1 -> v2 (scrypt) re-seal; the user never loses access.
      await _writeSealed(Vault.seal(pt.toJson(), password));
    }
    _openSession(pt);
    return pt;
  }

  /// Re-seal the current session plaintext (e.g. after editing the agent cred).
  Future<void> reseal(String password) async {
    if (_session.plaintext == null) throw StateError('locked');
    await _writeSealed(Vault.seal(_session.plaintext!.toJson(), password));
  }

  void _openSession(VaultPlaintext pt) {
    _session
      ..plaintext = pt
      ..at = DateTime.now().millisecondsSinceEpoch;
  }

  void _touch() => _session.at = DateTime.now().millisecondsSinceEpoch;

  /// The unlocked plaintext (refreshes the auto-lock timer). Null if locked.
  @override
  VaultPlaintext? get plaintext {
    if (!isUnlocked) return null;
    _touch();
    return _session.plaintext;
  }

  /// The agent LLM credential, if the user enabled the agent. Null if locked or
  /// not configured.
  Map<String, dynamic>? get agentCredential => plaintext?.agent;

  /// Lock / kill: wipe all decrypted key material + the LLM credential from
  /// memory. Nothing spendable survives a lock.
  @override
  void lock() => _session.clear();

  /// Wipe the persisted sealed blob and the session.
  Future<void> reset() async {
    await _storage.delete(key: storageKey);
    _session.clear();
  }
}
