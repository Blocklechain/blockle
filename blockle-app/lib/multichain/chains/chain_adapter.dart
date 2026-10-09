// chain_adapter.dart — the central contract of the multi-chain layer. Every
// supported chain implements the SAME interface; the UI, exchange layer, and AI
// agent talk to adapters only, never to a chain's RPC directly.
//
// Mirrors the TypeScript `ChainAdapter` in docs/MULTICHAIN-WALLET.md and the
// extension's chains/*.js. All amounts are BASE-UNIT DECIMAL STRINGS
// (BigInt-safe) — convert to human units only at the display edge.
import 'dart:typed_data';

typedef ChainId = String; // "block" | "ethereum" | "base" | "bitcoin" | ...

/// The unlocked root secret handed to secp256k1 / ed25519 adapters. For BLOCK
/// the "root secret" is the ML-DSA keypair held in the engine session, not this.
class RootSecret {
  RootSecret({this.seed});

  /// BIP39/HD seed bytes (secp256k1 + ed25519 chains). Never logged or sent.
  final Uint8List? seed;
}

/// A coin or token on a given chain.
class AssetRef {
  const AssetRef({
    required this.chain,
    required this.kind, // "native" | "erc20" | "block20" | "spl"
    required this.symbol,
    required this.decimals,
    this.address, // ERC-20 contract / BLOCK-20 id / SPL mint; null for native
  });

  final ChainId chain;
  final String kind;
  final String symbol;
  final int decimals;
  final String? address;

  Map<String, dynamic> toJson() => {
        'chain': chain,
        'kind': kind,
        'symbol': symbol,
        'decimals': decimals,
        if (address != null) 'address': address,
      };
}

/// A derived account. The private key / secret is NEVER returned here; signing
/// happens inside the adapter against the unlocked in-memory key material only.
class DerivedAccount {
  const DerivedAccount({
    required this.chain,
    required this.index,
    required this.address,
    required this.publicKey,
    required this.scheme, // "ml-dsa-44" | "secp256k1" | "ed25519"
    this.path,
  });

  final ChainId chain;
  final int index;
  final String address;
  final String publicKey;
  final String scheme;
  final String? path;

  Map<String, dynamic> toJson() => {
        'chain': chain,
        'index': index,
        'address': address,
        'publicKey': publicKey,
        'scheme': scheme,
        if (path != null) 'path': path,
      };
}

class Balance {
  const Balance({
    required this.asset,
    required this.confirmed, // base units, decimal string
    required this.display, // human units, UI only
    this.spendable, // mature/spendable subset (UTXO chains)
    this.error,
  });

  final AssetRef asset;
  final String confirmed;
  final String display;
  final String? spendable;
  final String? error;
}

class SendRequest {
  const SendRequest({
    required this.to,
    required this.amount, // base units, decimal string
    this.asset, // native coin or a token on this chain; null = native
    this.feeRate, // sat/vB (UTXO) | maxFeePerGas (EVM) | fee (BLOCK)
    this.memo,
    this.utxos, // optional pre-fetched UTXO set (UTXO chains / tests)
  });

  final AssetRef? asset;
  final String to;
  final String amount;
  final String? feeRate;
  final String? memo;
  final List<Map<String, dynamic>>? utxos;
}

/// A signed, broadcast-ready transaction. `broadcast` is a SEPARATE call so the
/// confirmation screen (and the AI-agent confirmation gate) can inspect the
/// fully-built, summarized tx before anything hits the network.
class BuiltTx {
  const BuiltTx({
    required this.chain,
    required this.raw, // signed payload (hex, or base64 for Solana)
    required this.txid,
    required this.fee, // base units
    required this.summary,
    this.extra,
  });

  final ChainId chain;
  final String raw;
  final String txid;
  final String fee;
  final SendRequest summary;
  final Map<String, dynamic>? extra;
}

class BroadcastResult {
  const BroadcastResult(this.txid, this.accepted);
  final String txid;
  final bool accepted;
}

/// The five-method interface every chain implements (plus unlock/lock session
/// management). Reads are best-effort and MUST NOT throw into the UI.
abstract class ChainAdapter {
  ChainId get id;
  AssetRef get native;

  /// Load the unlocked root secret into the adapter session (in-memory only).
  void unlock(RootSecret root);

  /// Wipe the in-memory key material.
  void lock();

  /// Pure derivation — no network.
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0});

  /// Best-effort balance read. On failure returns a Balance with confirmed:"0"
  /// and a flagged error — never throws into the UI.
  Future<List<Balance>> getBalance(String address, {List<AssetRef>? tokens});

  /// Build + SIGN a transaction. Does NOT broadcast.
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req);

  /// Broadcast a signed BuiltTx via this chain's configured endpoint.
  Future<BroadcastResult> broadcast(BuiltTx tx);

  /// A public explorer URL for a txid (UI deep-link + audit log).
  String explorerTx(String txid);
}

/// Minimal injectable JSON-RPC transport (EVM / Solana). The default uses
/// `package:http`; tests inject a stub so no network is touched.
typedef JsonRpcFn = Future<dynamic> Function(String method, List<dynamic> params);

/// Minimal injectable Esplora-style HTTP transport (UTXO chains).
typedef HttpGetFn = Future<String> Function(String path);
typedef HttpPostFn = Future<String> Function(String path, String body);

String formatUnits(String baseStr, int decimals) {
  var s = BigInt.parse(baseStr).toString().padLeft(decimals + 1, '0');
  final i = s.substring(0, s.length - decimals);
  var f = s.substring(s.length - decimals).replaceFirst(RegExp(r'0+$'), '');
  return f.isNotEmpty ? '$i.$f' : i;
}
