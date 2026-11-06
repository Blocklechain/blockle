// chains/tezos.dart — the Tezos (XTZ) ChainAdapter.
//
// • account key: ed25519 via SLIP-0010 at m/44'/1729'/0'/0' (coin type 1729;
//   FOUR hardened segments, Solana-style — pinned by docs/tezos-vectors.json).
//   node.key is the 32-byte ed25519 seed (same signer Solana/TON/Stellar use).
// • address = tz1 = base58check([6,161,159] || blake2b(pub, 20)). Public key is
//   exported as edpk. (chains/tezos_forge.dart is the binary codec engine.)
// • native XTZ = 6 decimals (mutez). SEND accepts tz1/tz2/tz3/KT1 destinations.
// • SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety, TON/Stellar-style): the
//   whole `transaction` manager-op is FORGED locally and the ed25519 signature
//   covers blake2b(0x03 || forged, 32) — nothing signed is node-supplied. The
//   node supplies ONLY branch (head-block hash) + counter, both verifiable.
//   buildSend returns the injection-ready hex (forged || sig, needsSign:false);
//   broadcast POSTs it to /injection/operation.
//
// NOT post-quantum — ed25519. Ported from the extension's chains/tezos.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/crypto_core.dart' as c;
import '../crypto/ed25519.dart' as ed;
import 'chain_adapter.dart';
import 'tezos_forge.dart' as tz;

export 'chain_adapter.dart' show formatUnits;

const String tezosDefaultPath = "m/44'/1729'/0'/0'";
// Primary public RPC. Fallback alt: https://rpc.tzkt.io/mainnet
const String tezosDefaultRpc = 'https://mainnet.api.tez.ie';
const int _hardened = 0x80000000;

// Conservative default limits for a simple implicit->implicit transfer, used
// only when the caller does not override. fee = 1420 mutez (0.00142 XTZ).
const String tezosDefaultFee = '1420';
const String tezosDefaultGasLimit = '10600';
const String tezosDefaultStorageLimit = '300';

// ---- SLIP-0010 (ed25519) HD derivation (INLINE, copied from ton.dart) -------
Uint8List _ser32(int i) {
  final b = Uint8List(4);
  ByteData.view(b.buffer).setUint32(0, i & 0xffffffff, Endian.big);
  return b;
}

class _Node {
  _Node(this.key, this.chainCode);
  final Uint8List key;
  final Uint8List chainCode;
}

_Node _masterKey(List<int> seed) {
  final i = c.hmacSha512(c.utf8Bytes('ed25519 seed'), c.toBytes(seed));
  return _Node(
      Uint8List.fromList(i.sublist(0, 32)), Uint8List.fromList(i.sublist(32, 64)));
}

_Node _deriveChild(_Node node, int index) {
  final data = c.concatBytes([
    Uint8List.fromList([0x00]),
    node.key,
    _ser32(index),
  ]);
  final i = c.hmacSha512(node.chainCode, data);
  return _Node(
      Uint8List.fromList(i.sublist(0, 32)), Uint8List.fromList(i.sublist(32, 64)));
}

List<int> _parsePath(String path) {
  final parts = path.split('/');
  if (parts[0] != 'm') throw ArgumentError("path must start with 'm'");
  return parts.sublist(1).map((p) {
    final isHardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
    if (!isHardened) {
      throw ArgumentError('ed25519 derivation requires hardened segments: $p');
    }
    final n = int.parse(p.substring(0, p.length - 1));
    if (n < 0) throw ArgumentError('bad path segment: $p');
    return (n + _hardened) & 0xffffffff;
  }).toList();
}

/// The 32-byte ed25519 seed for [seed] + [path].
Uint8List deriveSlip10Key(List<int> seed, String path) {
  var node = _masterKey(seed);
  for (final index in _parsePath(path)) {
    node = _deriveChild(node, index);
  }
  return node.key;
}

/// The locally-forged + locally-signed single-transaction operation. Pure (no
/// network); pinned by docs/tezos-vectors.json. [counter] is the account's
/// current counter + 1 (the op's counter).
class TezosBuilt {
  TezosBuilt({
    required this.forgedHex,
    required this.signingHashHex,
    required this.signature,
    required this.edsig,
    required this.injectionHex,
  });
  final String forgedHex;
  final String signingHashHex;
  final Uint8List signature;
  final String edsig;
  final String injectionHex;
}

/// Forge + sign a native-XTZ transfer. The ed25519 signature covers
/// blake2b(0x03 || forged, 32). Deterministic + offline.
TezosBuilt buildTransfer({
  required List<int> seedKey,
  required tz.TezosTxFields fields,
}) {
  final forged = tz.forgeTransactionBytes(fields);
  final hash = tz.signingBytes(forged);
  final sig = ed.sign(hash, seedKey);
  final forgedHex = c.bytesToHex(forged);
  return TezosBuilt(
    forgedHex: forgedHex,
    signingHashHex: c.bytesToHex(hash),
    signature: sig,
    edsig: tz.edsig(sig),
    injectionHex: forgedHex + c.bytesToHex(sig),
  );
}

class TezosAdapter implements ChainAdapter {
  TezosAdapter({
    this.path = tezosDefaultPath,
    this.explorer = 'https://tzkt.io/',
    this.symbol = 'XTZ',
    this.rpc,
    HttpGetFn? get,
    HttpPostFn? post,
    this.fee = tezosDefaultFee,
    this.gasLimit = tezosDefaultGasLimit,
    this.storageLimit = tezosDefaultStorageLimit,
  })  : _getOverride = get,
        _postOverride = post {
    native = AssetRef(chain: 'tezos', kind: 'native', symbol: symbol, decimals: 6);
  }

  final String path;
  final String explorer;
  final String symbol;

  /// Tezos RPC base (CONFIG; default https://mainnet.api.tez.ie). Not secret.
  final String? rpc;
  final HttpGetFn? _getOverride;
  final HttpPostFn? _postOverride;
  final String fee;
  final String gasLimit;
  final String storageLimit;

  @override
  ChainId get id => 'tezos';
  @override
  late final AssetRef native;

  Uint8List? _rootSeed;

  @override
  void unlock(RootSecret root) => _rootSeed = root.seed;
  @override
  void lock() => _rootSeed = null;

  String _pathWithIndex(int index) =>
      index == 0 ? path : path.replaceFirst(RegExp(r"/0'$"), "/$index'");

  Uint8List _keyFor(int index) {
    if (_rootSeed == null) throw StateError('locked');
    return deriveSlip10Key(_rootSeed!, _pathWithIndex(index));
  }

  String _rpcBase() {
    final base = rpc ?? tezosDefaultRpc;
    return base.replaceFirst(RegExp(r'/+$'), '');
  }

  Future<String> _rpcGet(String apiPath) async {
    if (_getOverride != null) return _getOverride(apiPath);
    final r = await http.get(Uri.parse('${_rpcBase()}$apiPath'),
        headers: {'accept': 'application/json'});
    return r.body;
  }

  Future<String> _rpcPost(String apiPath, String body) async {
    if (_postOverride != null) return _postOverride(apiPath, body);
    final r = await http.post(Uri.parse('${_rpcBase()}$apiPath'),
        headers: {'content-type': 'application/json'}, body: body);
    return r.body;
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final seed = root.seed ?? _rootSeed;
    if (seed == null) throw StateError('no root seed');
    final key = deriveSlip10Key(seed, _pathWithIndex(index));
    final pub = ed.publicKey(key);
    return DerivedAccount(
      chain: 'tezos',
      index: index,
      address: tz.tz1FromPublicKey(pub),
      publicKey: c.bytesToHex(pub),
      scheme: 'ed25519',
      path: _pathWithIndex(index),
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final raw = await _rpcGet(
          '/chains/main/blocks/head/context/contracts/$address/balance');
      // A funded contract returns a numeric JSON string, e.g. "12300000". An
      // UNFUNDED tz1 returns null / a JSON error array / 'non_existing_contract'
      // — treat anything non-numeric as a zero balance (not "unavailable").
      // Only a genuine transport failure (non-JSON) throws into the catch below.
      final decoded = jsonDecode(raw);
      final mutez = (decoded is String && RegExp(r'^\d+$').hasMatch(decoded))
          ? decoded
          : '0';
      out.add(Balance(
          asset: native, confirmed: mutez, display: formatUnits(mutez, 6)));
    } catch (e) {
      out.add(Balance(
          asset: native, confirmed: '0', display: '—', error: e.toString()));
    }
    return out;
  }

  @override
  Future<List<Balance>> discoverTokens(String address) async => const [];

  Future<String> _branch() async {
    final raw = await _rpcGet('/chains/main/blocks/head/hash');
    return jsonDecode(raw).toString();
  }

  Future<BigInt> _counter(String address) async {
    final raw = await _rpcGet(
        '/chains/main/blocks/head/context/contracts/$address/counter');
    return BigInt.parse(jsonDecode(raw).toString());
  }

  /// CLIENT-BUILT + CLIENT-SIGNED transaction (TON/Stellar-style). Only branch +
  /// counter come from the node; the signed operation is produced locally.
  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    if (_rootSeed == null) throw StateError('locked');
    if (!tz.isTezosDestination(req.to)) {
      throw StateError('tezos: invalid destination (expect tz1/tz2/tz3/KT1)');
    }
    final key = _keyFor(account.index);
    final branch = await _branch();
    final counter = (await _counter(account.address)) + BigInt.one;
    final fields = tz.TezosTxFields(
      branch: branch,
      source: account.address,
      fee: req.feeRate ?? fee,
      counter: counter.toString(),
      gasLimit: gasLimit,
      storageLimit: storageLimit,
      amount: req.amount,
      destination: req.to,
    );
    final built = buildTransfer(seedKey: key, fields: fields);
    return BuiltTx(
      chain: 'tezos',
      raw: built.injectionHex,
      txid: built.edsig,
      fee: fields.fee,
      summary: req,
      extra: {
        'kind': 'transaction',
        'counter': counter.toString(),
        'branch': branch,
        'forgedHex': built.forgedHex,
        'edsig': built.edsig,
      },
    );
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    // POST /injection/operation, body = a JSON string "<forgedHex+sigHex>".
    final body = jsonEncode(tx.raw);
    final resp = await _rpcPost('/injection/operation', body);
    final opHash = jsonDecode(resp).toString();
    return BroadcastResult(opHash, true);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
