// backup_service.dart — encrypted cloud backup/restore for the Flutter wallet. Orchestrates the
// vault (vault_store.dart) with backup_client.dart: the unlocked VaultPlaintext is encrypted
// on-device under a SEPARATE backup passphrase (backup_crypto.dart) and only opaque ciphertext is
// uploaded to the Blockle account (bearer token). 2FA is required for backup ops. Restore decrypts
// locally and re-seals the vault under a new device password. Same-wallet restore; the envelope
// format is shared with the extension + Qt wallets.
import 'dart:convert';

import 'backup_client.dart' as client;
import 'vault_store.dart';

class BackupResult {
  const BackupResult(this.ok, [this.reason]);
  final bool ok;
  final String? reason;
}

/// Encrypt the unlocked vault and upload it. Requires the vault to be unlocked.
Future<BackupResult> backupVault(
  MultichainVaultStore store, {
  String? origin,
  required String email,
  required String password,
  required String totp,
  required String passphrase,
  Map<String, dynamic> meta = const {},
}) async {
  if (!store.isUnlocked || store.plaintext == null) return const BackupResult(false, 'locked');
  final token = await client.login(origin, email, password, totp: totp);
  await client.backup(origin, token, totp, store.plaintext!.toJson(), passphrase,
      meta: {'app': 'flutter', ...meta});
  return const BackupResult(true);
}

/// Download + decrypt the latest backup and re-seal it under [newDevicePassword].
Future<BackupResult> restoreVault(
  MultichainVaultStore store, {
  String? origin,
  required String email,
  required String password,
  required String totp,
  required String passphrase,
  required String newDevicePassword,
}) async {
  final token = await client.login(origin, email, password, totp: totp);
  VaultPlaintext pt;
  try {
    final jsonStr = await client.restore(origin, token, totp, passphrase);
    pt = VaultPlaintext.fromJson(jsonDecode(jsonStr) as Map<String, dynamic>);
  } catch (_) {
    return const BackupResult(false, 'bad-passphrase'); // decrypt (GCM) or parse failed
  }
  await store.create(pt, newDevicePassword);
  return const BackupResult(true);
}
