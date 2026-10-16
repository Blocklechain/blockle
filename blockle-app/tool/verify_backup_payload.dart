// Verifies the Flutter backup payload shape round-trips through the shared envelope.
// Uses backup_crypto only (pure Dart) with a representative VaultPlaintext.toJson() map, so it
// runs under `dart run` without pulling in Flutter platform deps.
// Run from blockle-app/:  dart run tool/verify_backup_payload.dart
import 'dart:convert';
import 'dart:io';
import 'package:blockle_app/multichain/backup_crypto.dart' as crypto;

void main() {
  // Mirrors VaultPlaintext.toJson() (version, mnemonic, block{secret,public}, tokens, accounts).
  final payload = {
    'version': 2,
    'mnemonic': 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    'block': {'secret': 'MLDSA_SECRET_HEX', 'public': 'MLDSA_PUBLIC_HEX'},
    'tokens': [{'chain': 'BLOCK', 'symbol': 'BLK'}],
    'accounts': [{'label': 'Main'}],
  };
  const passphrase = 'my-backup-passphrase';

  final blob = crypto.encryptVault(passphrase, json.encode(payload));
  if (blob.contains('MLDSA_SECRET_HEX') || blob.contains('legal winner')) {
    stderr.writeln('FAIL: plaintext leaked into the blob'); exit(1);
  }
  print('blob is opaque (no plaintext): OK');

  final restored = json.decode(crypto.decryptVault(passphrase, blob)) as Map<String, dynamic>;
  if (restored['mnemonic'] != payload['mnemonic'] ||
      (restored['block'] as Map)['secret'] != 'MLDSA_SECRET_HEX') {
    stderr.writeln('FAIL: round-trip mismatch'); exit(1);
  }
  print('Flutter vault payload round-trips through the envelope: OK');

  try {
    crypto.decryptVault('wrong', blob);
    stderr.writeln('FAIL: wrong passphrase decrypted'); exit(1);
  } catch (_) { print('wrong passphrase rejected: OK'); }
  print('FLUTTER BACKUP PAYLOAD OK');
}
