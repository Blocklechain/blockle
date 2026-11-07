// chains/stellar.dart — the Stellar (XLM) ChainAdapter.
//
// • account key: ed25519 via SLIP-0010 at m/44'/148'/0' (SEP-0005), the SAME
//   ed25519 signer Solana/TON use. node.key is the 32-byte ed25519 seed.
// • address = strkey 'G…' = base32(0x30 || pub || crc16-xmodem) (chains/
//   stellar_xdr.dart is the codec engine).
// • native XLM (7 dp = stroops). Issued assets (AlphaNum4) supported by the codec;
//   none shipped by default to start.
// • SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety, TON-style): the
//   TransactionEnvelope is assembled LOCALLY and the ed25519 signature covers
//   SHA256(networkId || ENVELOPE_TYPE_TX || txXDR) — nothing signed is node-
//   supplied. Only the account Sequence (Horizon GET /accounts) comes from the
//   node, verifiable. buildSend returns the already-signed base64 envelope
//   (needsSign:false); broadcast POSTs it to Horizon /transactions.
//
// NOT post-quantum — ed25519. Ported from the extension's chains/stellar.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/crypto_core.dart' as c;
import '../crypto/ed25519.dart' as ed;
import 'chain_adapter.dart';
import 'stellar_xdr.dart' as sx;

export 'chain_adapter.dart' show formatUnits;

const int _hardened = 0x80000000;

/// 1-XLM base reserve surfaced in the send UI (network reserve value).
const int stellarBaseReserveStroops = 10000000; // 1 XLM

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

/// Build + sign a native-XLM Payment envelope. Pure (no network); the pieces are
/// pinned by docs/stellar-vectors.json. [sequence] is the account's CURRENT
/// sequence + 1 (the tx's seqNum).
class StellarBuilt {
  StellarBuilt(
      {required this.txXdr,
      required this.signature,
      required this.hint,
      required this.hashHex,
      required this.envelopeBase64});
  final Uint8List txXdr;
  final Uint8List signature;
  final Uint8List hint;
  final String hashHex;
  final String envelopeBase64;
}

StellarBuilt buildPayment({
  required List<int> seedKey,
  required Uint8List sourcePub,
  required Uint8List destPub,
  required BigInt sequence,
  required int fee,
  required String amountStroops,
  sx.StellarAsset asset = const sx.StellarAsset.native(),
  String passphrase = sx.publicNetworkPassphrase,
}) {
  final payment = sx.StellarPayment(
    sourcePub: sourcePub,
    destPub: destPub,
    sequence: sequence,
    fee: fee,
    amountStroops: amountStroops,
    asset: asset,
  );
  final txXdr = sx.serializeTransaction(payment);
  final hash = sx.txHashBytes(txXdr, passphrase);
  final signature = ed.sign(hash, seedKey);
  final hint = Uint8List.fromList(sourcePub.sublist(sourcePub.length - 4));
  final env = sx.serializeEnvelope(txXdr, hint, signature);
  return StellarBuilt(
    txXdr: txXdr,
    signature: signature,
    hint: hint,
    hashHex: c.bytesToHex(hash),
    envelopeBase64: sx.toBase64(env),
  );
}

class StellarAdapter implements ChainAdapter {
  StellarAdapter({
    this.path = sx.stellarDefaultPath,
    this.explorer = 'https://stellar.expert/explorer/public/tx/',
    this.symbol = 'XLM',
    this.horizon,
    this.passphrase = sx.publicNetworkPassphrase,
    HttpGetFn? get,
    HttpPostFn? post,
    int baseFeeStroops = 100,
  })  : _getOverride = get,
        _postOverride = post,
        _baseFee = baseFeeStroops {
    native = AssetRef(chain: 'stellar', kind: 'native', symbol: symbol, decimals: 7);
  }

  final String path;
  final String explorer;
  final String symbol;

  /// Horizon REST base (CONFIG; default https://horizon.stellar.org). Not secret.
  final String? horizon;
  final String passphrase;
  final HttpGetFn? _getOverride;
  final HttpPostFn? _postOverride;
  final int _baseFee;

  @override
  ChainId get id => 'stellar';
  @override
  late final AssetRef native;

  Uint8List? _rootSeed;
  Uint8List? _impEd; // imported single ed25519 seed (bypasses HD)

  @override
  void unlock(RootSecret root) {
    _rootSeed = root.seed;
    _impEd = root.importedEd25519;
  }

  @override
  void lock() {
    _rootSeed = null;
    _impEd = null;
  }

  String _pathWithIndex(int index) =>
      index == 0 ? path : path.replaceFirst(RegExp(r"/0'$"), "/$index'");

  Uint8List _keyFor(int index) {
    if (_impEd != null) return _impEd!;
    if (_rootSeed == null) throw StateError('locked');
    return deriveSlip10Key(_rootSeed!, _pathWithIndex(index));
  }

  Future<String> _horizonGet(String apiPath) async {
    if (_getOverride != null) return _getOverride(apiPath);
    final base = horizon;
    if (base == null) throw StateError('stellar: no Horizon endpoint configured');
    final r = await http.get(Uri.parse('$base$apiPath'),
        headers: {'accept': 'application/json'});
    return r.body;
  }

  Future<Map<String, dynamic>> _horizonGetJson(String apiPath) async {
    final body = await _horizonGet(apiPath);
    final d = jsonDecode(body);
    return d is Map<String, dynamic> ? d : <String, dynamic>{};
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final imp = root.importedEd25519 ?? _impEd;
    final seed = root.seed ?? _rootSeed;
    if (imp == null && seed == null) throw StateError('no root seed');
    final key = imp ?? deriveSlip10Key(seed!, _pathWithIndex(index));
    final pub = ed.publicKey(key);
    return DerivedAccount(
      chain: 'stellar',
      index: index,
      address: sx.strkeyEncodeEd25519(pub),
      publicKey: c.bytesToHex(pub),
      scheme: 'ed25519',
      path: imp != null ? 'imported' : _pathWithIndex(index),
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final res = await _horizonGetJson('/accounts/$address');
      final balances = res['balances'];
      var native7 = '0';
      if (balances is List) {
        for (final b in balances) {
          if (b is Map && b['asset_type'] == 'native') {
            // Horizon returns balances as a 7-dp decimal string; to stroops.
            native7 = _toStroops(b['balance']?.toString() ?? '0');
          }
        }
      }
      out.add(
          Balance(asset: native, confirmed: native7, display: formatUnits(native7, 7)));
    } catch (e) {
      // An unfunded Stellar account does not exist on-ledger (Horizon 404) — a
      // zero balance, not an error. Only real transport failures read as such.
      final s = e.toString().toLowerCase();
      if (s.contains('404') || s.contains('not_found') || s.contains('not found')) {
        out.add(Balance(asset: native, confirmed: '0', display: formatUnits('0', 7)));
      } else {
        out.add(Balance(
            asset: native, confirmed: '0', display: '—', error: e.toString()));
      }
    }
    return out;
  }

  String _toStroops(String decimal) {
    final parts = decimal.split('.');
    final whole = parts[0];
    var frac = parts.length > 1 ? parts[1] : '';
    if (frac.length > 7) frac = frac.substring(0, 7);
    frac = frac.padRight(7, '0');
    return BigInt.parse(whole + frac).toString();
  }

  /// Issued-asset (trustline) auto-detect. Reuses the SAME Horizon /accounts/{G…}
  /// read getBalance uses; every non-native balance row is a trustline the account
  /// holds. Each is mapped to a Balance (kind 'stellar-asset', 7 decimals) whose
  /// `address` is the unique `code:issuer` id, with the balance converted to
  /// stroops so the shared auto-import gate can parse it. Zero trustlines are
  /// skipped. Best-effort — returns `[]` on any failure.
  @override
  Future<List<Balance>> discoverTokens(String address) async {
    try {
      final res = await _horizonGetJson('/accounts/$address');
      final balances = res['balances'];
      if (balances is! List) return const [];
      final out = <Balance>[];
      for (final b in balances) {
        if (b is! Map) continue;
        final type = '${b['asset_type']}';
        if (type == 'native') continue;
        final code = '${b['asset_code'] ?? ''}';
        final issuer = '${b['asset_issuer'] ?? ''}';
        if (code.isEmpty || issuer.isEmpty) continue;
        final stroops = _toStroops('${b['balance'] ?? '0'}');
        if (isZeroBalance(stroops)) continue;
        out.add(Balance(
          asset: AssetRef(
            chain: 'stellar',
            kind: 'stellar-asset',
            symbol: code,
            decimals: 7,
            address: '$code:$issuer',
          ),
          confirmed: stroops,
          display: formatUnits(stroops, 7),
        ));
      }
      return out;
    } catch (_) {
      return const [];
    }
  }

  Future<BigInt> _sequenceOf(String address) async {
    final res = await _horizonGetJson('/accounts/$address');
    final seq = res['sequence'];
    if (seq != null) return BigInt.parse(seq.toString());
    throw StateError('stellar: account not found / unfunded (needs 1 XLM reserve)');
  }

  /// CLIENT-BUILT + CLIENT-SIGNED Payment envelope (TON-style). Only the account
  /// sequence comes from the node; the signed envelope is produced locally.
  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    if (_rootSeed == null && _impEd == null) throw StateError('locked');
    if (!sx.isStellarAddress(req.to)) {
      throw StateError('stellar: invalid destination address');
    }
    final key = _keyFor(account.index);
    final pub = ed.publicKey(key);
    final destPub = sx.strkeyDecodeEd25519(req.to);
    final curSeq = await _sequenceOf(account.address);
    final seqNum = curSeq + BigInt.one;
    final asset = req.asset;
    sx.StellarAsset built = const sx.StellarAsset.native();
    if (asset != null && asset.kind == 'asset' && asset.address != null) {
      // asset.address carries the issuer 'G…'; asset.symbol the code.
      built = sx.StellarAsset.alphaNum4(
          asset.symbol, sx.strkeyDecodeEd25519(asset.address!));
    }
    final b = buildPayment(
      seedKey: key,
      sourcePub: Uint8List.fromList(pub),
      destPub: destPub,
      sequence: seqNum,
      fee: _baseFee,
      amountStroops: req.amount,
      asset: built,
      passphrase: passphrase,
    );
    return BuiltTx(
      chain: 'stellar',
      raw: b.envelopeBase64,
      txid: b.hashHex,
      fee: _baseFee.toString(),
      summary: req,
      extra: {'kind': 'payment', 'sequence': seqNum.toString()},
    );
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final form = 'tx=${Uri.encodeQueryComponent(tx.raw)}';
    String body;
    if (_postOverride != null) {
      body = await _postOverride('/transactions', form);
    } else {
      final base = horizon;
      if (base == null) throw StateError('stellar: no Horizon endpoint configured');
      final r = await http.post(Uri.parse('$base/transactions'),
          headers: {'content-type': 'application/x-www-form-urlencoded'},
          body: form);
      body = r.body;
    }
    final d = jsonDecode(body);
    final j = d is Map<String, dynamic> ? d : <String, dynamic>{};
    final hash = (j['hash'] ?? tx.txid).toString();
    final ok = j['successful'] == true || j['hash'] != null;
    return BroadcastResult(hash, ok);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
