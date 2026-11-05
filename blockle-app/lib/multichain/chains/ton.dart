// chains/ton.dart — the TON (The Open Network) ChainAdapter.
//
// • account key: ed25519 via SLIP-0010 at m/44'/607'/0' (coin type 607). TON's
//   own standard derives ed25519 from a TON-specific mnemonic, but Blockle wallets
//   derive EVERY chain from ONE BIP39 seed, so TON uses SLIP-0010 ed25519 from
//   that seed (three hardened segments; Solana uses four). Pinned by the vector.
// • address = the v4R2 wallet CONTRACT address = cellHash(StateInit), encoded as
//   the user-friendly bounceable base64url ('EQ…'); non-bounceable + raw '0:hex'
//   also handled. (chains/ton_cell.dart is the cell/BOC engine.)
// • native TON (9 decimals) + jetton (USDT) via toncenter v2 jsonRPC.
// • SEND is CLIENT-BUILT (fund-safety): the signing payload is assembled LOCALLY
//   and its cell hash is ed25519-signed — nothing signed is node-supplied. Only
//   seqno + the owner's jetton-wallet address (get_wallet_address) come from the
//   node, both verifiable. Generic buildSend -> broadcast path.
//
// NOT post-quantum — Ed25519 is classical. Ported from the extension's chains/ton.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/crypto_core.dart' as c;
import '../crypto/ed25519.dart' as ed;
import 'chain_adapter.dart';
import 'ton_cell.dart' as t;

const int nanoPerTon = 1000000000; // 1 TON = 1e9 nanoton
const String tonDefaultPath = "m/44'/607'/0'";
const int _hardened = 0x80000000;
const int jettonTransferOp = 0x0f8a7ea5;
const String defaultJettonGas = '100000000'; // 0.1 TON attached to a jetton transfer
const String defaultFwdAmount = '1';

// ---- SLIP-0010 (ed25519) HD derivation (INLINE, copied from solana.dart) ----
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
  return _Node(Uint8List.fromList(i.sublist(0, 32)), Uint8List.fromList(i.sublist(32, 64)));
}

_Node _deriveChild(_Node node, int index) {
  final data = c.concatBytes([Uint8List.fromList([0x00]), node.key, _ser32(index)]);
  final i = c.hmacSha512(node.chainCode, data);
  return _Node(Uint8List.fromList(i.sublist(0, 32)), Uint8List.fromList(i.sublist(32, 64)));
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

/// Returns the 32-byte ed25519 seed for [seed] + [path].
Uint8List deriveSlip10Key(List<int> seed, String path) {
  var node = _masterKey(seed);
  for (final index in _parsePath(path)) {
    node = _deriveChild(node, index);
  }
  return node.key;
}

// ---- deterministic client-built external messages (fund-safety core) --------
/// The signed external message + its pieces. Shared by buildSend + the tests.
class TonBuilt {
  TonBuilt(
      {required this.signingCell,
      required this.signature,
      required this.internalMsg,
      required this.external,
      required this.boc,
      required this.hash,
      this.jettonBody});
  final t.Cell signingCell;
  final Uint8List signature;
  final t.Cell internalMsg;
  final t.Cell external;
  final String boc;
  final String hash;
  final t.Cell? jettonBody;
}

t.Cell _v4SigningCell(int subwallet, int validUntil, int seqno, t.Cell internalMsg) {
  return t
      .beginCell()
      .storeUint(subwallet, 32)
      .storeUint(validUntil & 0xffffffff, 32)
      .storeUint(seqno, 32)
      .storeUint(0, 8) // op
      .storeUint(3, 8) // sendMode
      .storeRef(internalMsg)
      .endCell();
}

void _storeBodyMaybeInline(t.Builder b, t.Cell body) {
  final needRef =
      (b.availableBits() - 1) < body.bitLen || (b.refsCount + body.refs.length) > 4;
  if (needRef) {
    b.storeBit(1).storeRef(body);
  } else {
    b.storeBit(0).storeSlice(body);
  }
}

t.Cell _internalMessage(t.TonAddr dest, String amount, bool bounce, t.Cell body) {
  final b = t
      .beginCell()
      .storeBit(0)
      .storeBit(1)
      .storeBit(bounce ? 1 : 0)
      .storeBit(0)
      .storeAddress(null)
      .storeAddress(dest)
      .storeCoins(amount)
      .storeBit(0)
      .storeCoins(0)
      .storeCoins(0)
      .storeUint(0, 64)
      .storeUint(0, 32)
      .storeBit(0); // no state init
  _storeBodyMaybeInline(b, body);
  return b.endCell();
}

t.Cell _externalMessage(t.TonAddr self, t.Cell? stateInit, t.Cell body) {
  final b = t
      .beginCell()
      .storeBit(1)
      .storeBit(0)
      .storeAddress(null)
      .storeAddress(self)
      .storeCoins(0);
  if (stateInit != null) {
    b.storeBit(1);
    final initRef = (b.availableBits() - 2) < (stateInit.bitLen + body.bitLen);
    if (initRef) {
      b.storeBit(1).storeRef(stateInit);
    } else {
      b.storeBit(0).storeSlice(stateInit);
    }
  } else {
    b.storeBit(0);
  }
  _storeBodyMaybeInline(b, body);
  return b.endCell();
}

t.Cell _commentBody(String text) {
  final b = t.beginCell().storeUint(0, 32);
  if (text.isNotEmpty) b.storeBuffer(c.utf8Bytes(text));
  return b.endCell();
}

/// Build the FULL signed external message for a native TON transfer.
TonBuilt buildNativeExternal({
  required List<int> pubKey,
  required List<int> seedKey,
  required t.TonAddr dest,
  required String amount,
  String comment = '',
  bool? bounce,
  required int seqno,
  int? validUntil,
  int subwallet = t.subwalletId,
}) {
  final b = bounce ?? dest.bounceable;
  final vu = validUntil ??
      (seqno == 0 ? 0xffffffff : (DateTime.now().millisecondsSinceEpoch ~/ 1000) + 60);
  final internalMsg = _internalMessage(dest, amount, b, _commentBody(comment));
  final signingCell = _v4SigningCell(subwallet, vu, seqno, internalMsg);
  final signature = ed.sign(signingCell.hash(), seedKey);
  final body = t.beginCell().storeBuffer(signature).storeSlice(signingCell).endCell();
  final stateInit = seqno == 0 ? t.v4r2StateInit(pubKey, subwallet: subwallet) : null;
  final self = t.TonAddr(0, t.v4r2StateInit(pubKey, subwallet: subwallet).hash());
  final external = _externalMessage(self, stateInit, body);
  final boc = t.serializeBoc(external);
  return TonBuilt(
    signingCell: signingCell,
    signature: signature,
    internalMsg: internalMsg,
    external: external,
    boc: t.tonToBase64(boc),
    hash: c.bytesToHex(external.hash()),
  );
}

/// Build the FULL signed external message for a jetton (e.g. USDT) transfer.
/// [jettonWallet] is the OWNER's jetton-wallet address (node-derived + validated).
TonBuilt buildJettonExternal({
  required List<int> pubKey,
  required List<int> seedKey,
  required t.TonAddr jettonWallet,
  required t.TonAddr dest,
  required t.TonAddr response,
  required String amount,
  String? fwdAmount,
  String? gas,
  required int seqno,
  int? validUntil,
  int subwallet = t.subwalletId,
}) {
  final vu = validUntil ??
      (seqno == 0 ? 0xffffffff : (DateTime.now().millisecondsSinceEpoch ~/ 1000) + 60);
  final jbody = t
      .beginCell()
      .storeUint(jettonTransferOp, 32)
      .storeUint(0, 64)
      .storeCoins(amount)
      .storeAddress(dest)
      .storeAddress(response)
      .storeBit(0)
      .storeCoins(fwdAmount ?? defaultFwdAmount)
      .storeBit(0)
      .endCell();
  final internalMsg = _internalMessage(jettonWallet, gas ?? defaultJettonGas, true, jbody);
  final signingCell = _v4SigningCell(subwallet, vu, seqno, internalMsg);
  final signature = ed.sign(signingCell.hash(), seedKey);
  final body = t.beginCell().storeBuffer(signature).storeSlice(signingCell).endCell();
  final stateInit = seqno == 0 ? t.v4r2StateInit(pubKey, subwallet: subwallet) : null;
  final self = t.TonAddr(0, t.v4r2StateInit(pubKey, subwallet: subwallet).hash());
  final external = _externalMessage(self, stateInit, body);
  final boc = t.serializeBoc(external);
  return TonBuilt(
    signingCell: signingCell,
    signature: signature,
    internalMsg: internalMsg,
    external: external,
    boc: t.tonToBase64(boc),
    hash: c.bytesToHex(external.hash()),
    jettonBody: jbody,
  );
}

class TonAdapter implements ChainAdapter {
  TonAdapter({
    this.path = tonDefaultPath,
    this.explorer = 'https://tonviewer.com/transaction/',
    this.symbol = 'TON',
    this.api,
    this.apiKey,
    HttpPostFn? post,
    this.subwallet = t.subwalletId,
  }) : _postOverride = post {
    native = AssetRef(chain: 'ton', kind: 'native', symbol: symbol, decimals: 9);
  }

  final String path;
  final String explorer;
  final String symbol;
  final String? api;
  final String? apiKey;
  final HttpPostFn? _postOverride;
  final int subwallet;

  @override
  ChainId get id => 'ton';
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

  /// toncenter v2 jsonRPC over {base}/jsonRPC. Transport injectable for tests.
  Future<Map<String, dynamic>> _tonApi(String method, dynamic params) async {
    final body = jsonEncode({'id': 1, 'jsonrpc': '2.0', 'method': method, 'params': params ?? {}});
    Map<String, dynamic> j;
    if (_postOverride != null) {
      final resp = await _postOverride(
          '/jsonRPC', body);
      final d = jsonDecode(resp);
      j = d is Map<String, dynamic> ? d : <String, dynamic>{};
    } else {
      final base = api;
      if (base == null) throw StateError('ton: no toncenter endpoint configured');
      final headers = {'content-type': 'application/json'};
      final key = apiKey;
      if (key != null && key.isNotEmpty) headers['X-API-Key'] = key;
      final r = await http.post(Uri.parse('$base/jsonRPC'), headers: headers, body: body);
      final d = jsonDecode(r.body);
      j = d is Map<String, dynamic> ? d : <String, dynamic>{};
    }
    if (j['error'] != null) throw StateError(j['error'].toString());
    final res = j['result'];
    return res is Map<String, dynamic> ? res : {'value': res};
  }

  BigInt _stackInt(Map<String, dynamic> result) {
    final st = result['stack'];
    if (st is! List || st.isEmpty) return BigInt.zero;
    final v = st[0][1];
    if (v is String) {
      return v.startsWith('0x') ? BigInt.parse(v.substring(2), radix: 16) : BigInt.parse(v);
    }
    if (v is Map && v['number'] != null) return BigInt.parse(v['number'].toString());
    return BigInt.zero;
  }

  t.TonAddr _stackAddress(Map<String, dynamic> result) {
    final st = result['stack'];
    if (st is! List || st.isEmpty) throw StateError('ton: empty address stack');
    final payload = st[0][1];
    String? b64;
    if (payload is Map) {
      b64 = payload['bytes']?.toString();
    } else if (payload is String) {
      b64 = payload;
    }
    if (b64 == null) throw StateError('ton: no cell in address stack');
    final cell = t.parseBoc(t.tonFromBase64(b64))[0];
    final a = t.loadMsgAddress(cell);
    if (a == null) throw StateError('ton: get_wallet_address returned addr_none');
    return a;
  }

  Future<int> _seqnoOf(String address) async {
    try {
      final r = await _tonApi('runGetMethod', {'address': address, 'method': 'seqno', 'stack': []});
      return _stackInt(r).toInt();
    } catch (_) {
      return 0; // undeployed -> seqno 0 (send carries StateInit)
    }
  }

  Future<t.TonAddr> _jettonWalletOf(String owner, String master) async {
    final ownerCellBoc = t.tonToBase64(t.serializeBoc(t.addressCell(t.parseAddress(owner))));
    final r = await _tonApi('runGetMethod', {
      'address': master,
      'method': 'get_wallet_address',
      'stack': [
        ['tvm.Slice', ownerCellBoc]
      ]
    });
    return _stackAddress(r);
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final seed = root.seed ?? _rootSeed;
    if (seed == null) throw StateError('no root seed');
    final key = deriveSlip10Key(seed, _pathWithIndex(index));
    final pub = ed.publicKey(key);
    final hash = t.v4r2StateInit(pub, subwallet: subwallet).hash();
    return DerivedAccount(
      chain: 'ton',
      index: index,
      address: t.formatAddress(0, hash),
      publicKey: c.bytesToHex(pub),
      scheme: 'ed25519',
      path: _pathWithIndex(index),
    );
  }

  @override
  Future<List<Balance>> getBalance(String address, {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final res = await _tonApi('getAddressBalance', {'address': address});
      final raw = res['value'] ?? res['balance'] ?? 0;
      final bal = BigInt.parse(raw.toString()).toString();
      out.add(Balance(asset: native, confirmed: bal, display: formatUnits(bal, 9)));
    } catch (e) {
      out.add(Balance(asset: native, confirmed: '0', display: '—', error: e.toString()));
    }
    for (final tok in tokens ?? const <AssetRef>[]) {
      if (tok.kind != 'jetton' || tok.address == null) continue;
      try {
        final jw = await _jettonWalletOf(address, tok.address!);
        final jwAddr = t.formatAddress(jw.workchain, jw.hash);
        final r = await _tonApi('runGetMethod', {'address': jwAddr, 'method': 'get_wallet_data', 'stack': []});
        final v = _stackInt(r).toString();
        out.add(Balance(asset: tok, confirmed: v, display: formatUnits(v, tok.decimals)));
      } catch (e) {
        out.add(Balance(asset: tok, confirmed: '0', display: '—', error: e.toString()));
      }
    }
    return out;
  }

  /// No cheap "all jettons" RPC on bare toncenter v2 — the known list is the
  /// source. Best-effort no-op.
  @override
  Future<List<Balance>> discoverTokens(String address) async => const [];

  /// CLIENT-BUILT signed external message (native or jetton). The signing cell
  /// is assembled locally; only seqno (+ jetton-wallet addr) come from the node.
  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    if (_rootSeed == null) throw StateError('locked');
    final key = _keyFor(account.index);
    final pub = ed.publicKey(key);
    final owner = account.address;
    final seqno = await _seqnoOf(owner);
    final asset = req.asset;
    final isJetton = asset != null && asset.kind == 'jetton' && asset.address != null;
    if (isJetton) {
      final dest = t.parseAddress(req.to);
      final jw = await _jettonWalletOf(owner, asset.address!);
      final self = t.v4r2StateInit(pub, subwallet: subwallet).hash();
      final built = buildJettonExternal(
        pubKey: pub,
        seedKey: key,
        jettonWallet: jw,
        dest: dest,
        response: t.TonAddr(0, self),
        amount: req.amount,
        seqno: seqno,
        subwallet: subwallet,
      );
      return BuiltTx(
        chain: 'ton',
        raw: built.boc,
        txid: built.hash,
        fee: defaultJettonGas,
        summary: req,
        extra: {'kind': 'jetton-transfer', 'seqno': seqno, 'jettonWallet': t.formatAddress(jw.workchain, jw.hash)},
      );
    }
    final dest = t.parseAddress(req.to);
    final built = buildNativeExternal(
      pubKey: pub,
      seedKey: key,
      dest: dest,
      amount: req.amount,
      comment: req.memo ?? '',
      seqno: seqno,
      subwallet: subwallet,
    );
    return BuiltTx(
      chain: 'ton',
      raw: built.boc,
      txid: built.hash,
      fee: '0',
      summary: req,
      extra: {'kind': 'send', 'seqno': seqno},
    );
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final res = await _tonApi('sendBoc', {'boc': tx.raw});
    final hash = (res['hash'] ?? res['value'] ?? tx.txid).toString();
    return BroadcastResult(hash, true);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
