// vault.dart — password-sealed encryption of wallet secrets (Dart port of
// blockle-extension/vault.js). The sealed blob is byte-for-byte portable with
// the extension and the Qt wallet: same { v, kdf, salt, iv, data } JSON, same
// scrypt(N=16384,r=8,p=1) KDF, same AES-256-GCM AEAD (128-bit tag appended to
// the ciphertext, exactly like WebCrypto).
//
// The vault holds the entire secret state as one authenticated-encrypted blob:
//   - the BLOCK identity (ML-DSA-44 keypair) — post-quantum,
//   - the HD seed for every secp256k1 chain (EVM / BTC / LTC / DOGE) — ECDSA,
//   - and any private settings (agent credential, endpoints, token list).
//
// IMPORTANT (honest scoping): the vault is a STORAGE property, not a signature
// property. Sealing a BTC/LTC/DOGE/EVM key in a memory-hard vault does NOT make
// that key post-quantum — those chains sign with ECDSA. Only BLOCK's on-chain
// signatures are post-quantum (ML-DSA-44).
//
// Crypto:
//   v2 (current) — scrypt (RFC 7914, memory-hard) -> AES-256-GCM (AEAD).
//   v1 (legacy)  — PBKDF2-SHA256/310k -> AES-256-GCM. Still opens; callers
//                  transparently re-seal as v2 on the next successful unlock.

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

/// Thrown on a wrong password (AES-GCM auth-tag failure) or a tampered blob.
/// Normalized so there is no decryption oracle beyond "wrong password".
class WrongPasswordException implements Exception {
  final String message;
  const WrongPasswordException([this.message = 'wrong password']);
  @override
  String toString() => message;
}

/// A sealed vault blob: { v, kdf:{name,params}, salt, iv, data } (base64 parts).
class SealedVault {
  final int v;
  final String kdfName;
  final Map<String, int> kdfParams;
  final String salt; // base64
  final String iv; // base64
  final String data; // base64 AES-256-GCM ciphertext||tag

  const SealedVault({
    required this.v,
    required this.kdfName,
    required this.kdfParams,
    required this.salt,
    required this.iv,
    required this.data,
  });

  Map<String, dynamic> toJson() => {
        'v': v,
        'kdf': {'name': kdfName, 'params': kdfParams},
        'salt': salt,
        'iv': iv,
        'data': data,
      };

  factory SealedVault.fromJson(Map<String, dynamic> j) {
    final kdf = (j['kdf'] as Map?)?.cast<String, dynamic>();
    final params = <String, int>{};
    if (kdf != null && kdf['params'] is Map) {
      (kdf['params'] as Map).forEach((k, v) {
        params['$k'] = (v as num).toInt();
      });
    }
    return SealedVault(
      v: (j['v'] as num?)?.toInt() ?? 1,
      kdfName: kdf != null && kdf['name'] != null
          ? kdf['name'] as String
          : 'pbkdf2',
      kdfParams: params,
      salt: j['salt'] as String,
      iv: j['iv'] as String,
      data: j['data'] as String,
    );
  }
}

/// Password-sealed vault — the Dart equivalent of the extension's `Vault`.
class Vault {
  // Legacy v1 KDF cost (only used to OPEN old blobs).
  static const int pbkdf2Iters = 310000;

  // v2 KDF cost. scrypt N=2^14, r=8, p=1 ~= 16 MiB of memory-hard work per guess
  // — the standard "interactive" setting. Params are stored in the sealed blob
  // so they can evolve without breaking existing vaults.
  static const int scryptN = 16384;
  static const int scryptR = 8;
  static const int scryptP = 1;
  static const int keyLen = 32; // AES-256

  static final Random _rng = Random.secure();

  static Uint8List _randomBytes(int n) {
    final b = Uint8List(n);
    for (var i = 0; i < n; i++) {
      b[i] = _rng.nextInt(256);
    }
    return b;
  }

  // --- key derivation -------------------------------------------------------

  /// scrypt(password, salt, N, r, p) -> derived key (dkLen bytes). Pure Dart
  /// (pointycastle) so it matches RFC 7914 vectors and the extension exactly.
  static Uint8List scrypt(
    String password,
    Uint8List salt,
    int n,
    int r,
    int p,
    int dkLen,
  ) {
    final d = KeyDerivator('scrypt')
      ..init(ScryptParameters(n, r, p, dkLen, salt));
    return d.process(Uint8List.fromList(utf8.encode(password)));
  }

  // Legacy v1 derivation: PBKDF2-HMAC-SHA256 directly to a 32-byte AES key.
  static Uint8List _pbkdf2(String password, Uint8List salt, int iters) {
    final d = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
      ..init(Pbkdf2Parameters(salt, iters, keyLen));
    return d.process(Uint8List.fromList(utf8.encode(password)));
  }

  static Uint8List _keyFor(SealedVault sealed, String password, Uint8List salt) {
    final name = sealed.kdfName;
    if (name == 'scrypt') {
      final p = sealed.kdfParams;
      return scrypt(
        password,
        salt,
        p['N'] ?? scryptN,
        p['r'] ?? scryptR,
        p['p'] ?? scryptP,
        keyLen,
      );
    }
    if (name == 'pbkdf2') {
      return _pbkdf2(password, salt, sealed.kdfParams['iters'] ?? pbkdf2Iters);
    }
    throw ArgumentError('vault: unknown kdf "$name"');
  }

  // --- AES-256-GCM (ct||tag, 128-bit tag — identical layout to WebCrypto) ----

  static Uint8List _gcmEncrypt(Uint8List key, Uint8List iv, Uint8List pt) {
    final c = GCMBlockCipher(AESEngine())
      ..init(true, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
    return c.process(pt);
  }

  static Uint8List _gcmDecrypt(Uint8List key, Uint8List iv, Uint8List ct) {
    final c = GCMBlockCipher(AESEngine())
      ..init(false, AEADParameters(KeyParameter(key), 128, iv, Uint8List(0)));
    try {
      return c.process(ct);
    } catch (_) {
      // GCM tag mismatch (wrong password / tampered blob). Normalize.
      throw const WrongPasswordException();
    }
  }

  // --- public API -----------------------------------------------------------

  /// plaintext object + password -> SealedVault (v2 / scrypt).
  static SealedVault seal(Object plaintext, String password) {
    final salt = _randomBytes(16);
    final iv = _randomBytes(12);
    final dk = scrypt(password, salt, scryptN, scryptR, scryptP, keyLen);
    final ct = _gcmEncrypt(
      dk,
      iv,
      Uint8List.fromList(utf8.encode(jsonEncode(plaintext))),
    );
    return SealedVault(
      v: 2,
      kdfName: 'scrypt',
      kdfParams: {'N': scryptN, 'r': scryptR, 'p': scryptP},
      salt: base64.encode(salt),
      iv: base64.encode(iv),
      data: base64.encode(ct),
    );
  }

  /// SealedVault + password -> decoded plaintext object. Throws
  /// [WrongPasswordException] on a wrong password or a tampered blob.
  static dynamic open(SealedVault sealed, String password) {
    final salt = base64.decode(sealed.salt);
    final key = _keyFor(sealed, password, salt);
    final pt = _gcmDecrypt(key, base64.decode(sealed.iv), base64.decode(sealed.data));
    return jsonDecode(utf8.decode(pt));
  }

  /// True if a sealed blob is not in the current (v2 / scrypt) format and should
  /// be transparently re-sealed on the next unlock.
  static bool needsUpgrade(SealedVault? sealed) {
    return sealed == null || sealed.v != 2 || sealed.kdfName != 'scrypt';
  }
}
