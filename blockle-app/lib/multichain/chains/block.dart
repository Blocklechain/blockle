// chains/block.dart — the BLOCK ChainAdapter. A THIN wrapper over the app's
// EXISTING, consensus-correct BLOCK stack (the WASM ML-DSA-44 engine + the
// chain read/submit client). It does NOT reimplement any BLOCK crypto — ML-DSA
// signing stays entirely in blockle-wasm, reused through [BlockSignerBridge].
//
// BLOCK is the wallet's native identity and is ALWAYS enabled. This adapter
// exists so the UI / exchange / agent can talk to every chain through one
// uniform ChainAdapter interface.
//
// Post-quantum: YES — BLOCK alone is signed with ML-DSA-44 (FIPS 204).
import 'chain_adapter.dart';

const int blockCoin = 100000000;

/// The seam onto the app's existing BLOCK signer + chain client. The app wires
/// this to WalletStore (session + ML-DSA key) + Engine (wasm buildTransfer) +
/// Chain (explorer/submit). Keys never pass through the adapter — the engine
/// holds and uses them internally.
abstract class BlockSignerBridge {
  bool isUnlocked();

  /// Current BLOCK address (`block1…` bech32) and ML-DSA public key hex.
  String get address;
  String get publicKeyHex;

  /// Account info: `{balance: <base units>, balanceFmt: <display>}` or null.
  Future<Map<String, dynamic>?> account(String address);

  /// Spendable UTXOs for the address (list of chain UTXO maps).
  Future<List<dynamic>> utxos(String address);

  /// Build + SIGN a transfer via the wasm signer. Returns `{raw, txid}`.
  Future<Map<String, dynamic>> buildTransfer(
      List<dynamic> utxos, String to, BigInt amount, BigInt fee);

  /// Broadcast a signed bincode-hex transaction; returns the accepted txid.
  Future<dynamic> submit(String raw);
}

class BlockAdapter implements ChainAdapter {
  BlockAdapter(this._bridge, {this.explorer = 'https://blockle.org/tx/'});

  final BlockSignerBridge _bridge;
  final String explorer;

  @override
  ChainId get id => 'block';

  @override
  final AssetRef native =
      const AssetRef(chain: 'block', kind: 'native', symbol: 'BLOCK', decimals: 8);

  // No-ops for interface symmetry: the BLOCK key lives in the engine session.
  @override
  void unlock(RootSecret root) {}
  @override
  void lock() {}

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    // BLOCK identity is the ML-DSA keypair in the engine session — not HD.
    return DerivedAccount(
      chain: 'block',
      index: 0,
      address: _bridge.address,
      publicKey: _bridge.publicKeyHex,
      scheme: 'ml-dsa-44',
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    try {
      final a = await _bridge.account(address.isEmpty ? _bridge.address : address);
      final confirmed = a != null ? (a['balance'] ?? 0).toString() : '0';
      return [
        Balance(
            asset: native,
            confirmed: confirmed,
            spendable: confirmed,
            display: a != null ? (a['balanceFmt']?.toString() ?? '—') : '—'),
      ];
    } catch (e) {
      return [
        Balance(
            asset: native, confirmed: '0', display: '—', error: e.toString()),
      ];
    }
  }

  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    if (!_bridge.isUnlocked()) throw StateError('locked');
    final utxos = await _bridge.utxos(_bridge.address);
    final fee = BigInt.parse(req.feeRate ?? '100000');
    final built = await _bridge.buildTransfer(
        utxos, req.to, BigInt.parse(req.amount), fee);
    return BuiltTx(
      chain: 'block',
      raw: built['raw'].toString(),
      txid: built['txid'].toString(),
      fee: fee.toString(),
      summary: req,
    );
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final res = await _bridge.submit(tx.raw);
    final txid = res is Map
        ? (res['txid'] ?? res['result'] ?? tx.txid).toString()
        : (res ?? tx.txid).toString();
    return BroadcastResult(txid, true);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
