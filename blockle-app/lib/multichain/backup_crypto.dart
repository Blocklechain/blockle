// Blockle encrypted-backup envelope (v1) — Dart port (pointycastle).
//
// Byte-for-byte compatible with blockle-extension/backup-crypto.js and
// python/blockle/backup_crypto.py so a backup made on any wallet restores on any other. The
// vault is encrypted on-device with a key derived from the backup passphrase; only the opaque
// envelope leaves the device (zero-knowledge — the server can't decrypt). Verified against
// docs/backup-vectors.json.
//
// Envelope: base64url( utf8( JSON {v,kdf,iter,salt,nonce,ct} ) )
//   kdf    = PBKDF2-HMAC-SHA256, iter iterations, 32-byte key   (symmetric -> post-quantum safe)
//   cipher = AES-256-GCM, 12-byte nonce, AAD = "blockle-backup-v1", ct = ciphertext||tag (base64)
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:pointycastle/export.dart';

const int _iter = 600000;
final Uint8List _aad = Uint8List.fromList(utf8.encode('blockle-backup-v1'));

Uint8List _deriveKey(String passphrase, Uint8List salt, int iterations) {
  final d = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
    ..init(Pbkdf2Parameters(salt, iterations, 32));
  return d.process(Uint8List.fromList(utf8.encode(passphrase)));
}

Uint8List _randomBytes(int n) {
  final r = Random.secure();
  return Uint8List.fromList(List<int>.generate(n, (_) => r.nextInt(256)));
}

Uint8List _gcm(bool forEncryption, Uint8List key, Uint8List nonce, Uint8List input) {
  final c = GCMBlockCipher(AESEngine())
    ..init(forEncryption, AEADParameters(KeyParameter(key), 128, nonce, _aad));
  return c.process(input);
}

/// Encrypt [plaintext] (the vault JSON) under [passphrase]. [salt]/[nonce] only for test vectors.
String encryptVault(String passphrase, String plaintext,
    {Uint8List? salt, Uint8List? nonce, int iterations = _iter}) {
  salt ??= _randomBytes(16);
  nonce ??= _randomBytes(12);
  final key = _deriveKey(passphrase, salt, iterations);
  final ct = _gcm(true, key, nonce, Uint8List.fromList(utf8.encode(plaintext))); // ciphertext||tag
  final env = {
    'v': 1, 'kdf': 'pbkdf2-sha256', 'iter': iterations,
    'salt': base64.encode(salt), 'nonce': base64.encode(nonce), 'ct': base64.encode(ct),
  };
  return base64Url.encode(utf8.encode(json.encode(env)));
}

/// Decrypt an envelope [blob] produced by any Blockle wallet.
String decryptVault(String passphrase, String blob) {
  final env = json.decode(utf8.decode(base64Url.decode(base64Url.normalize(blob))));
  if (env['v'] != 1 || env['kdf'] != 'pbkdf2-sha256') {
    throw StateError('unsupported backup version');
  }
  final key = _deriveKey(passphrase, base64.decode(env['salt'] as String), env['iter'] as int);
  final pt = _gcm(false, key, base64.decode(env['nonce'] as String), base64.decode(env['ct'] as String));
  return utf8.decode(pt);
}
