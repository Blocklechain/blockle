// Verifies the Dart backup envelope against the shared cross-platform vector.
// Run from blockle-app/:  dart run tool/verify_backup.dart
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:blockle_app/multichain/backup_crypto.dart';

void main() {
  final vec = json.decode(File('../docs/backup-vectors.json').readAsStringSync());
  final salt = base64.decode(vec['saltB64'] as String);
  final nonce = base64.decode(vec['nonceB64'] as String);

  // 1) reproduce the exact ct from JS
  final blob = encryptVault(vec['passphrase'], vec['plaintext'],
      salt: Uint8List.fromList(salt), nonce: Uint8List.fromList(nonce), iterations: vec['iter'] as int);
  final env = json.decode(utf8.decode(base64Url.decode(base64Url.normalize(blob))));
  if (env['ct'] != vec['ctB64']) {
    stderr.writeln('ct MISMATCH\n dart=${env['ct']}\n js  =${vec['ctB64']}');
    exit(1);
  }
  print('Dart ct matches JS exactly: ${(env['ct'] as String).substring(0, 32)} ...');

  // 2) decrypt the JS-produced blob
  final pt = decryptVault(vec['passphrase'] as String, vec['blob'] as String);
  if (pt != vec['plaintext']) { stderr.writeln('decrypt of JS blob MISMATCH'); exit(1); }
  print('Dart decrypts JS blob OK');

  // 3) wrong passphrase must throw
  try {
    decryptVault('wrong', vec['blob'] as String);
    stderr.writeln('FAIL: wrong passphrase decrypted'); exit(1);
  } catch (_) { print('Dart rejects wrong passphrase OK'); }
  print('DART INTEROP OK');
}
