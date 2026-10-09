// block_signer_bridge.dart — binds the multichain BLOCK adapter
// (lib/multichain/chains/block.dart) to the app's REAL post-quantum stack: the
// WASM ML-DSA-44 engine (via WalletStore's unlocked session) + the live BLOCK
// chain client (Chain). This is the seam the contract mandates: the BLOCK
// adapter signs/submits through the existing signer and NEVER reimplements any
// ML-DSA crypto.
//
// HARD RULE: no secret key ever crosses this boundary. WalletStore holds the
// decrypted ML-DSA secret in its ephemeral session; buildTransfer() runs inside
// the engine. This bridge only passes public data (address, pubkey hex, UTXOs,
// signed raw bytes) in and out.

import 'dart:convert';

import '../multichain/chains/block.dart' show BlockSignerBridge;
import 'chain.dart';
import 'wallet_store.dart';

/// The app-wired implementation of [BlockSignerBridge]. Construct with the
/// app's singleton [WalletStore] (engine-backed signer session) and a [Chain]
/// read/broadcast client. The multichain [BlockAdapter] drives it.
class AppBlockSignerBridge implements BlockSignerBridge {
  AppBlockSignerBridge(this._wallet, this._chain);

  final WalletStore _wallet;
  final Chain _chain;

  @override
  bool isUnlocked() => _wallet.isUnlocked;

  @override
  String get address => _wallet.address ?? '';

  @override
  String get publicKeyHex => _wallet.publicKeyHex ?? '';

  @override
  Future<Map<String, dynamic>?> account(String address) =>
      _chain.account(address);

  @override
  Future<List<dynamic>> utxos(String address) async {
    final u = await _chain.utxos(address);
    final list = u?['utxos'];
    return list is List ? list : const [];
  }

  @override
  Future<Map<String, dynamic>> buildTransfer(
      List<dynamic> utxos, String to, BigInt amount, BigInt fee) {
    // WalletStore.buildTransfer runs the WASM signer against its in-session
    // ML-DSA secret and returns the already-signed {raw, txid}. We serialize the
    // UTXO set to the engine's expected JSON shape.
    return _wallet.buildTransfer(
        jsonEncode(utxos), to, amount.toString(), fee.toString());
  }

  @override
  Future<dynamic> submit(String raw) => _chain.submit(raw);
}
