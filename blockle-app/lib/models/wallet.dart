import 'dart:convert';

/// A stored wallet record. The secret key never lives here in the clear — it
/// is inside `crypto` (a sealed vault blob), or absent for watch-only wallets.
/// Format is identical to the browser extension so files interoperate.
class WalletRecord {
  final String id;
  String label;
  final String address;
  final String publicKey;
  final String? crypto; // sealed-vault JSON string, or null (watch-only)
  final bool watchOnly;
  final String scheme;

  WalletRecord({
    required this.id,
    required this.label,
    required this.address,
    required this.publicKey,
    required this.crypto,
    required this.watchOnly,
    this.scheme = 'ML-DSA-44',
  });

  /// Export shape — `crypto` is a nested object, as in the extension's files.
  Map<String, dynamic> toExport() => {
        'id': id,
        'label': label,
        'format': 'blockle-wallet',
        'version': 2,
        'scheme': scheme,
        'address': address,
        'publicKey': publicKey,
        'crypto': crypto == null ? null : jsonDecode(crypto!),
        'watchOnly': watchOnly,
      };

  /// Internal persistence shape (crypto kept as its JSON string).
  Map<String, dynamic> toStore() => {
        'id': id,
        'label': label,
        'scheme': scheme,
        'address': address,
        'publicKey': publicKey,
        'crypto': crypto,
        'watchOnly': watchOnly,
      };

  factory WalletRecord.fromStore(Map<String, dynamic> j) => WalletRecord(
        id: j['id'] as String,
        label: (j['label'] ?? 'Wallet') as String,
        address: (j['address'] ?? '') as String,
        publicKey: (j['publicKey'] ?? '') as String,
        crypto: j['crypto'] as String?,
        watchOnly: (j['watchOnly'] ?? false) as bool,
        scheme: (j['scheme'] ?? 'ML-DSA-44') as String,
      );
}

/// Lightweight view for the UI list.
class WalletInfo {
  final String id;
  final String label;
  final String address;
  final bool watchOnly;
  final bool active;
  WalletInfo(this.id, this.label, this.address, this.watchOnly, this.active);
}
