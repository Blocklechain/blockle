// chains/utxo.dart — the UTXO ChainAdapter shared by Bitcoin, Litecoin and
// Dogecoin. One base implementation parameterized by network (address prefixes,
// bech32 HRP, BIP44/84 path, segwit on/off).
//
// • BTC/LTC: BIP84 P2WPKH (native segwit, bech32), BIP143 sighash
// • DOGE:    BIP44 P2PKH (legacy base58), legacy sighash
// • UTXO fetch / fee / broadcast via a configurable Esplora-style endpoint
// • coin selection + change; keys never leave the adapter
//
// NOT post-quantum: ECDSA / secp256k1, exactly like Bitcoin itself.
// Ported from the extension's chains/utxo.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/address.dart' as addr;
import '../crypto/crypto_core.dart' as c;
import '../crypto/hd.dart' as hd;
import '../crypto/secp256k1.dart' as s;
import 'chain_adapter.dart';

class UtxoNetwork {
  const UtxoNetwork({
    required this.id,
    required this.symbol,
    required this.decimals,
    required this.hrp,
    required this.p2pkh,
    required this.p2sh,
    required this.wif,
    required this.segwit,
    required this.path,
    required this.explorer,
    required this.esplora,
  });

  final String id;
  final String symbol;
  final int decimals;
  final String? hrp;
  final int p2pkh;
  final int p2sh;
  final int wif;
  final bool segwit;
  final String path;
  final String explorer;
  final String? esplora;
}

const Map<String, UtxoNetwork> networks = {
  'bitcoin': UtxoNetwork(
    id: 'bitcoin',
    symbol: 'BTC',
    decimals: 8,
    hrp: 'bc',
    p2pkh: 0x00,
    p2sh: 0x05,
    wif: 0x80,
    segwit: true,
    path: "m/84'/0'/0'/0",
    explorer: 'https://mempool.space/tx/',
    esplora: 'https://blockstream.info/api',
  ),
  'litecoin': UtxoNetwork(
    id: 'litecoin',
    symbol: 'LTC',
    decimals: 8,
    hrp: 'ltc',
    p2pkh: 0x30,
    p2sh: 0x32,
    wif: 0xb0,
    segwit: true,
    path: "m/84'/2'/0'/0",
    explorer: 'https://blockchair.com/litecoin/transaction/',
    esplora: 'https://litecoinspace.org/api',
  ),
  'dogecoin': UtxoNetwork(
    id: 'dogecoin',
    symbol: 'DOGE',
    decimals: 8,
    hrp: null,
    p2pkh: 0x1e,
    p2sh: 0x16,
    wif: 0x9e,
    segwit: false,
    path: "m/44'/3'/0'/0",
    explorer: 'https://blockchair.com/dogecoin/transaction/',
    esplora: null,
  ),
};

// ---- little-endian + varint helpers ----------------------------------------
Uint8List u32le(int n) {
  final b = Uint8List(4);
  ByteData.view(b.buffer).setUint32(0, n & 0xffffffff, Endian.little);
  return b;
}

Uint8List u64le(dynamic v) {
  var x = v is BigInt ? v : BigInt.parse(v.toString());
  final b = Uint8List(8);
  for (var i = 0; i < 8; i++) {
    b[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  return b;
}

Uint8List varint(int n) {
  if (n < 0xfd) return Uint8List.fromList([n]);
  if (n <= 0xffff) {
    return c.concatBytes([
      Uint8List.fromList([0xfd]),
      u32le(n).sublist(0, 2),
    ]);
  }
  if (n <= 0xffffffff) {
    return c.concatBytes([
      Uint8List.fromList([0xfe]),
      u32le(n),
    ]);
  }
  return c.concatBytes([
    Uint8List.fromList([0xff]),
    u64le(BigInt.from(n)),
  ]);
}

Uint8List pushData(List<int> data) {
  final d = c.toBytes(data);
  if (d.length < 0x4c) {
    return c.concatBytes([
      Uint8List.fromList([d.length]),
      d,
    ]);
  }
  if (d.length <= 0xff) {
    return c.concatBytes([
      Uint8List.fromList([0x4c, d.length]),
      d,
    ]);
  }
  return c.concatBytes([
    Uint8List.fromList([0x4d]),
    u32le(d.length).sublist(0, 2),
    d,
  ]);
}

Uint8List _revHex(String txidHex) =>
    Uint8List.fromList(c.hexToBytes(txidHex).reversed.toList());

// scriptPubKey builders
Uint8List p2wpkhScript(List<int> h160) => c.concatBytes([
      Uint8List.fromList([0x00, 0x14]),
      c.toBytes(h160),
    ]);

Uint8List p2pkhScript(List<int> h160) => c.concatBytes([
      Uint8List.fromList([0x76, 0xa9, 0x14]),
      c.toBytes(h160),
      Uint8List.fromList([0x88, 0xac]),
    ]);

/// Address -> scriptPubKey (for building outputs to arbitrary recipients).
Uint8List addressToScript(String address, UtxoNetwork net) {
  if (net.segwit &&
      net.hrp != null &&
      address.toLowerCase().startsWith('${net.hrp}1')) {
    final dec = addr.segwitDecode(net.hrp!, address);
    if (dec.version == 0 && dec.program.length == 20) {
      return p2wpkhScript(dec.program);
    }
    if (dec.version == 0 && dec.program.length == 32) {
      return c.concatBytes([
        Uint8List.fromList([0x00, 0x20]),
        dec.program,
      ]); // P2WSH
    }
    throw const FormatException('unsupported segwit output');
  }
  final dec = c.base58checkDecode(address);
  final ver = dec[0];
  final h160 = dec.sublist(1);
  if (ver == net.p2pkh) return p2pkhScript(h160);
  if (ver == net.p2sh) {
    return c.concatBytes([
      Uint8List.fromList([0xa9, 0x14]),
      h160,
      Uint8List.fromList([0x87]),
    ]); // P2SH
  }
  throw FormatException('unknown address version for ${net.id}');
}

class UtxoInput {
  UtxoInput(this.txid, this.vout, this.sequence, [this.value]);
  final String txid;
  final int vout;
  final int sequence;
  final BigInt? value;
}

class UtxoOutput {
  UtxoOutput(this.script, this.value);
  final Uint8List script;
  final BigInt value;
}

// ---- BIP143 (segwit) sighash for a P2WPKH input ----------------------------
Uint8List sighashSegwit(
    int version,
    List<UtxoInput> inputs,
    List<UtxoOutput> outputs,
    int index,
    List<int> scriptCode,
    BigInt amount,
    int sequence,
    int locktime,
    int hashType) {
  final prevouts =
      c.concatBytes([for (final i in inputs) c.concatBytes([_revHex(i.txid), u32le(i.vout)])]);
  final sequences = c.concatBytes([for (final i in inputs) u32le(i.sequence)]);
  final outs = c.concatBytes([
    for (final o in outputs)
      c.concatBytes([u64le(o.value), varint(o.script.length), o.script])
  ]);
  final hashPrevouts = c.hash256(prevouts);
  final hashSequence = c.hash256(sequences);
  final hashOutputs = c.hash256(outs);
  final thisIn = inputs[index];
  final preimage = c.concatBytes([
    u32le(version),
    hashPrevouts,
    hashSequence,
    _revHex(thisIn.txid),
    u32le(thisIn.vout),
    varint(scriptCode.length),
    scriptCode,
    u64le(amount),
    u32le(sequence),
    hashOutputs,
    u32le(locktime),
    u32le(hashType),
  ]);
  return c.hash256(preimage);
}

// ---- legacy sighash for a P2PKH input --------------------------------------
Uint8List sighashLegacy(int version, List<UtxoInput> inputs,
    List<UtxoOutput> outputs, int index, List<int> subScript, int locktime, int hashType) {
  final parts = <List<int>>[u32le(version), varint(inputs.length)];
  for (var i = 0; i < inputs.length; i++) {
    final inp = inputs[i];
    parts.add(_revHex(inp.txid));
    parts.add(u32le(inp.vout));
    if (i == index) {
      parts.add(varint(subScript.length));
      parts.add(c.toBytes(subScript));
    } else {
      parts.add(varint(0));
    }
    parts.add(u32le(inp.sequence));
  }
  parts.add(varint(outputs.length));
  for (final o in outputs) {
    parts.add(u64le(o.value));
    parts.add(varint(o.script.length));
    parts.add(o.script);
  }
  parts.add(u32le(locktime));
  parts.add(u32le(hashType));
  return c.hash256(c.concatBytes(parts));
}

class SignedUtxoInput {
  SignedUtxoInput(this.txid, this.vout, this.sequence, this.scriptSig, this.witness,
      this.sighash, this.sig);
  final String txid;
  final int vout;
  final int sequence;
  final Uint8List scriptSig;
  final List<Uint8List>? witness;
  final Uint8List sighash;
  final s.EcdsaSignature sig;
}

// ---- full tx serializer ----------------------------------------------------
Uint8List serializeTx(int version, List<SignedUtxoInput> signedInputs,
    List<UtxoOutput> outputs, int locktime, bool hasWitness) {
  final parts = <List<int>>[u32le(version)];
  if (hasWitness) parts.add(Uint8List.fromList([0x00, 0x01]));
  parts.add(varint(signedInputs.length));
  for (final inp in signedInputs) {
    parts.add(_revHex(inp.txid));
    parts.add(u32le(inp.vout));
    final ss = inp.scriptSig;
    parts.add(varint(ss.length));
    parts.add(ss);
    parts.add(u32le(inp.sequence));
  }
  parts.add(varint(outputs.length));
  for (final o in outputs) {
    parts.add(u64le(o.value));
    parts.add(varint(o.script.length));
    parts.add(o.script);
  }
  if (hasWitness) {
    for (final inp in signedInputs) {
      final w = inp.witness ?? const <Uint8List>[];
      parts.add(varint(w.length));
      for (final item in w) {
        parts.add(varint(item.length));
        parts.add(item);
      }
    }
  }
  parts.add(u32le(locktime));
  return c.concatBytes(parts);
}

String txidOf(int version, List<SignedUtxoInput> signedInputs,
    List<UtxoOutput> outputs, int locktime) {
  final nonWit = serializeTx(version, signedInputs, outputs, locktime, false);
  return c.bytesToHex(c.hash256(nonWit).reversed.toList());
}

// ---- coin selection (accumulative) -----------------------------------------
class CoinSelection {
  CoinSelection(this.chosen, this.fee, this.sum);
  final List<Map<String, dynamic>> chosen;
  final BigInt fee;
  final BigInt sum;
}

CoinSelection selectCoins(List<Map<String, dynamic>> utxos, BigInt target,
    double feeRate, UtxoNetwork net) {
  final sorted = utxos.toList()
    ..sort((a, b) => BigInt.parse(b['value'].toString())
        .compareTo(BigInt.parse(a['value'].toString())));
  final chosen = <Map<String, dynamic>>[];
  var sum = BigInt.zero;
  final inVbytes = net.segwit ? 68 : 148;
  const base = 10 + 34;
  for (final u in sorted) {
    chosen.add(u);
    sum += BigInt.parse(u['value'].toString());
    final vbytes = base + chosen.length * inVbytes + 34;
    final fee = BigInt.from((vbytes * feeRate).ceil());
    if (sum >= target + fee) return CoinSelection(chosen, fee, sum);
  }
  final vbytes = base + chosen.length * inVbytes;
  final fee = BigInt.from((vbytes * feeRate).ceil());
  if (sum >= target + fee) return CoinSelection(chosen, fee, sum);
  throw StateError('insufficient funds');
}

/// A fully built + signed UTXO transaction, with per-input sighashes + sigs
/// exposed for verification/tests.
class BuiltUtxoTx {
  BuiltUtxoTx(this.raw, this.txid, this.fee, this.change, this.signedInputs);
  final String raw;
  final String txid;
  final String fee;
  final String change;
  final List<SignedUtxoInput> signedInputs;

  List<String> get sighashes =>
      signedInputs.map((s2) => c.bytesToHex(s2.sighash)).toList();
}

/// Build + sign a full send. `node` carries the private + public key; `req`
/// provides {to, amount, feeRate, utxos:[{txid,vout,value}]}.
BuiltUtxoTx buildAndSign(UtxoNetwork net, hd.HdNode node, String fromAddress,
    Map<String, dynamic> req) {
  const sighashAll = 0x01;
  final pub = node.publicKey;
  final ownH160 = c.hash160(pub);
  final feeRate = (req['feeRate'] ?? 10) is num
      ? (req['feeRate'] ?? 10).toDouble()
      : double.parse(req['feeRate'].toString());
  final amount = BigInt.parse(req['amount'].toString());
  final utxos = (req['utxos'] as List).cast<Map<String, dynamic>>();
  final sel = selectCoins(utxos, amount, feeRate, net);
  final inSum = sel.chosen
      .fold<BigInt>(BigInt.zero, (a, u) => a + BigInt.parse(u['value'].toString()));
  final change = inSum - amount - sel.fee;

  final outputs = <UtxoOutput>[
    UtxoOutput(addressToScript(req['to'] as String, net), amount),
  ];
  if (change > BigInt.from(546)) {
    outputs.add(UtxoOutput(addressToScript(fromAddress, net), change));
  }

  final inputs = sel.chosen
      .map((u) => UtxoInput(u['txid'] as String, u['vout'] as int, 0xffffffff,
          BigInt.parse(u['value'].toString())))
      .toList();
  const version = 1, locktime = 0;
  final signedInputs = <SignedUtxoInput>[];

  if (net.segwit) {
    final scriptCode = p2pkhScript(ownH160); // BIP143 scriptCode for P2WPKH
    for (var i = 0; i < sel.chosen.length; i++) {
      final u = sel.chosen[i];
      final sh = sighashSegwit(version, inputs, outputs, i, scriptCode,
          BigInt.parse(u['value'].toString()), 0xffffffff, locktime, sighashAll);
      final sig = s.sign(sh, node.privateKey!);
      final sigPlusType = c.concatBytes([
        sig.der,
        Uint8List.fromList([sighashAll]),
      ]);
      signedInputs.add(SignedUtxoInput(u['txid'] as String, u['vout'] as int,
          0xffffffff, Uint8List(0), [sigPlusType, pub], sh, sig));
    }
  } else {
    final subScript = p2pkhScript(ownH160);
    for (var i = 0; i < sel.chosen.length; i++) {
      final u = sel.chosen[i];
      final sh = sighashLegacy(
          version, inputs, outputs, i, subScript, locktime, sighashAll);
      final sig = s.sign(sh, node.privateKey!);
      final sigPlusType = c.concatBytes([
        sig.der,
        Uint8List.fromList([sighashAll]),
      ]);
      final scriptSig = c.concatBytes([pushData(sigPlusType), pushData(pub)]);
      signedInputs.add(SignedUtxoInput(u['txid'] as String, u['vout'] as int,
          0xffffffff, scriptSig, null, sh, sig));
    }
  }
  final rawBytes = serializeTx(version, signedInputs, outputs, locktime, net.segwit);
  final txid = txidOf(version, signedInputs, outputs, locktime);
  return BuiltUtxoTx(c.bytesToHex(rawBytes), txid, sel.fee.toString(),
      change.toString(), signedInputs);
}

String _fmt(String baseStr, int decimals) {
  final s2 = BigInt.parse(baseStr).toString().padLeft(decimals + 1, '0');
  final i = s2.substring(0, s2.length - decimals);
  final f = s2.substring(s2.length - decimals).replaceFirst(RegExp(r'0+$'), '');
  return f.isNotEmpty ? '$i.$f' : i;
}

class UtxoAdapter implements ChainAdapter {
  UtxoAdapter(dynamic netOrId, {String? esplora, HttpGetFn? httpGet, HttpPostFn? httpPost})
      : net = netOrId is String ? networks[netOrId]! : netOrId as UtxoNetwork,
        _esploraOverride = esplora,
        _httpGet = httpGet,
        _httpPost = httpPost {
    native =
        AssetRef(chain: net.id, kind: 'native', symbol: net.symbol, decimals: net.decimals);
  }

  final UtxoNetwork net;
  final String? _esploraOverride;
  final HttpGetFn? _httpGet;
  final HttpPostFn? _httpPost;

  @override
  ChainId get id => net.id;
  @override
  late final AssetRef native;

  Uint8List? _rootSeed;

  @override
  void unlock(RootSecret root) => _rootSeed = root.seed;
  @override
  void lock() => _rootSeed = null;

  String get _base {
    final b = _esploraOverride ?? net.esplora;
    if (b == null) throw StateError('${net.id}: no endpoint configured');
    return b;
  }

  Future<String> _apiGet(String path) async {
    if (_httpGet != null) return _httpGet(path);
    final r = await http.get(Uri.parse(_base + path));
    if (r.statusCode >= 400) throw StateError('${net.id} api ${r.statusCode}');
    return r.body;
  }

  Future<String> _apiPost(String path, String body) async {
    if (_httpPost != null) return _httpPost(path, body);
    final r = await http.post(Uri.parse(_base + path),
        headers: {'content-type': 'text/plain'}, body: body);
    if (r.statusCode >= 400) throw StateError('${net.id} api ${r.statusCode}');
    return r.body;
  }

  hd.HdNode _nodeFor(int index) {
    if (_rootSeed == null) throw StateError('locked');
    return hd.derivePath(_rootSeed, '${net.path}/$index');
  }

  String _addressOf(hd.HdNode node) => net.segwit
      ? addr.p2wpkh(node.publicKey, net.hrp!)
      : addr.p2pkh(node.publicKey, net.p2pkh);

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final seed = root.seed ?? _rootSeed;
    if (seed == null) throw StateError('no root seed');
    final node = hd.derivePath(seed, '${net.path}/$index');
    return DerivedAccount(
      chain: net.id,
      index: index,
      address: _addressOf(node),
      publicKey: c.bytesToHex(node.publicKey),
      scheme: 'secp256k1',
      path: '${net.path}/$index',
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    try {
      final j = jsonDecode(await _apiGet('/address/$address')) as Map<String, dynamic>;
      final cs = (j['chain_stats'] ?? {}) as Map<String, dynamic>;
      final confirmed = (BigInt.parse((cs['funded_txo_sum'] ?? 0).toString()) -
              BigInt.parse((cs['spent_txo_sum'] ?? 0).toString()))
          .toString();
      return [
        Balance(
            asset: native,
            confirmed: confirmed,
            spendable: confirmed,
            display: _fmt(confirmed, net.decimals)),
      ];
    } catch (e) {
      return [
        Balance(
            asset: native, confirmed: '0', display: '—', error: e.toString()),
      ];
    }
  }

  Future<List<Map<String, dynamic>>> utxos(String address) async {
    final j = jsonDecode(await _apiGet('/address/$address/utxo')) as List;
    return j
        .map((u) => {
              'txid': u['txid'],
              'vout': u['vout'],
              'value': u['value'].toString(),
            })
        .toList();
  }

  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    if (_rootSeed == null) throw StateError('locked');
    final node = _nodeFor(account.index);
    final from = account.address;
    final us = req.utxos ?? await utxos(from);
    final built = buildAndSign(net, node, from, {
      'to': req.to,
      'amount': req.amount,
      if (req.feeRate != null) 'feeRate': req.feeRate,
      'utxos': us,
    });
    return BuiltTx(
        chain: net.id, raw: built.raw, txid: built.txid, fee: built.fee, summary: req);
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final txid = (await _apiPost('/tx', tx.raw)).trim();
    return BroadcastResult(txid, true);
  }

  @override
  String explorerTx(String txid) => net.explorer + txid;
}
