// chains/tron.dart — the Tron (TRX + TRC-20) ChainAdapter.
//
// • account key derived from the HD seed via BIP44 secp256k1 (the SAME curve +
//   signer the wallet already uses for EVM/BTC), path m/44'/195'/0'/0/index.
// • address = base58check( 0x41 || keccak256(uncompressedPub[1:])[-20:] ) — the
//   exact ETH keccak-of-pubkey body, but prefixed with 0x41 and base58check
//   (double-SHA256 4-byte checksum) instead of EIP-55 hex ⇒ a 'T…' address.
// • native TRX (6 dp) + TRC-20 (USDT TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t, 6 dp)
//   balances via TronGrid REST (getaccount / triggerconstantcontract balanceOf).
// • tx flow keeps keys LOCAL and avoids reimplementing Tron's protobuf: the node
//   ASSEMBLES the unsigned tx (createtransaction / triggersmartcontract) and
//   returns {txID, raw_data, raw_data_hex}. Before signing the client runs TWO
//   guards: (1) txID == sha256(raw_data_hex) — binds the id to the bytes, but is
//   NOT a fund-safety check on its own (it is ALWAYS true for a well-formed
//   raw_data and says nothing about WHO the tx pays); (2) decodeTronRawData()
//   DECODES the node-assembled raw_data and ASSERTS it encodes EXACTLY the
//   transfer buildSend() was asked for (owner/recipient/amount, or token
//   contract + zero call_value + transfer() calldata) — a malicious node that
//   swaps the payee/amount is rejected here with NO signature produced. Only
//   then is the 32-byte txID signed with the existing secp256k1 signer → a
//   65-byte [r||s||v] recoverable signature (v = recovery id, NO +27), attached
//   to tx.signature[] and broadcast via /wallet/broadcasttransaction.
//
// NOT post-quantum — secp256k1/ECDSA, same as Ethereum/Bitcoin. BLOCK's ML-DSA
// signing stays in blockle-wasm. Ported from the extension's chains/tron.js.
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../crypto/crypto_core.dart' as c;
import '../crypto/hd.dart' as hd;
import '../crypto/secp256k1.dart' as s;
import 'chain_adapter.dart';

export 'chain_adapter.dart' show formatUnits;

/// 1 TRX = 1_000_000 sun (6 decimals).
const int sun = 1000000;
const String tronDefaultPath = "m/44'/195'/0'/0";
const String tronAddrPrefixHex = '41';
const int tronAddrPrefix = 0x41;

// ---- Tron address codec (self-contained, mirrors chains/tron.js) ------------

/// The 20-byte ETH-style body of a Tron account: keccak256(uncompressedPub[1:])
/// last 20 bytes. Accepts a 33-byte compressed or 65-byte uncompressed pubkey.
Uint8List tronBodyFromPub(List<int> pub) {
  var p = c.toBytes(pub);
  if (p.length == 33) p = s.encodePoint(s.decodePoint(p), false);
  final body = p.sublist(1); // drop 0x04
  final hash = c.keccak256(body);
  return Uint8List.fromList(hash.sublist(hash.length - 20));
}

/// Derive a 'T…' base58check address from a public key.
String tronAddressFromPub(List<int> pub) {
  final payload = c.concatBytes([
    Uint8List.fromList([tronAddrPrefix]),
    tronBodyFromPub(pub),
  ]);
  return c.base58checkEncode(payload);
}

bool _isHex(String s) => RegExp(r'^[0-9a-fA-F]+$').hasMatch(s);

/// 'T…' (base58check) → 41-prefixed 21-byte hex. Also accepts an already-hex
/// 41… address (returned lower-cased) for convenience.
String addressToHex(String address) {
  final a = address.trim();
  if (a.startsWith('0x')) {
    final h = a.substring(2).toLowerCase();
    if (h.length == 42 && h.startsWith(tronAddrPrefixHex)) return h;
    if (h.length == 40) return tronAddrPrefixHex + h; // bare 20-byte body
  }
  if (a.length == 42 && _isHex(a) && a.toLowerCase().startsWith(tronAddrPrefixHex)) {
    return a.toLowerCase();
  }
  final payload = c.base58checkDecode(a); // throws on bad checksum
  if (payload.length != 21 || payload[0] != tronAddrPrefix) {
    throw const FormatException('not a Tron address');
  }
  return c.bytesToHex(payload);
}

/// 41-prefixed hex (21 bytes) → 'T…' base58check. Accepts an optional 0x and a
/// bare 20-byte (40-hex) body (0x41 is prepended).
String hexToBase58(String hex) {
  var h = hex.trim();
  if (h.startsWith('0x')) h = h.substring(2);
  h = h.toLowerCase();
  if (h.length == 40) h = tronAddrPrefixHex + h;
  if (h.length != 42 || !h.startsWith(tronAddrPrefixHex)) {
    throw const FormatException('not a 41-prefixed Tron hex address');
  }
  return c.base58checkEncode(c.hexToBytes(h));
}

/// Validate a 'T…' base58check Tron address (correct prefix, length, checksum).
bool isTronAddress(String address) {
  final a = address.trim();
  if (!a.startsWith('T')) return false;
  try {
    final p = c.base58checkDecode(a);
    return p.length == 21 && p[0] == tronAddrPrefix;
  } catch (_) {
    return false;
  }
}

/// The 20-byte (ETH-style) body for any accepted address form ('T…' or 41-hex).
Uint8List _body20(String address) {
  final hex = addressToHex(address); // 42-char 41… hex
  return c.hexToBytes(hex.substring(2)); // drop the 0x41 prefix byte
}

// ---- local txID signing (the malicious-node guard + 65-byte sig) ------------

/// The canonical txID of an assembled tx: sha256 of its raw_data_hex bytes.
String txIdFromRawData(String rawDataHex) =>
    c.bytesToHex(c.sha256(c.hexToBytes(rawDataHex)));

/// Sign the 32-byte txID with [priv] → a 65-byte recoverable signature
/// [r(32) || s(32) || v(1)], v = recovery id (0/1), NO +27. Deterministic
/// RFC6979 ⇒ byte-identical across all four wallet ports.
Uint8List signTxId(List<int> txIdBytes, List<int> priv) {
  final sig = s.sign(txIdBytes, priv);
  return c.concatBytes([
    sig.rBytes,
    sig.sBytes,
    Uint8List.fromList([sig.recovery & 0xff]),
  ]);
}

/// ABI-encode a 20-byte address as a left-zero-padded 32-byte word (Tron omits
/// the 0x41 prefix in ABI params — only the 20-byte body is encoded).
String _abiAddress(String address) =>
    c.bytesToHex(_body20(address)).padLeft(64, '0');

String _abiUint(String decimalAmount) {
  var h = BigInt.parse(decimalAmount).toRadixString(16);
  if (h == '0') h = '';
  return h.padLeft(64, '0');
}

/// transfer(address,uint256) parameter: 32B to-address ++ 32B amount.
String trc20TransferParameter(String to, String amount) =>
    _abiAddress(to) + _abiUint(amount);

// ---- raw_data decode + fund-safety assertion (DECODE-ONLY protobuf walk) ----
//
// txID == sha256(raw_data_hex) is ALWAYS true for any raw_data — it proves the
// id matches the bytes, NOT that the bytes pay who the user asked. A malicious /
// compromised node can assemble a raw_data that pays an attacker and its txID
// will still equal sha256(raw_data). The ONLY real guard is to decode the
// node-returned Transaction.raw protobuf and assert it encodes EXACTLY the
// transfer buildSend() was asked for. We do a tiny decode-only field walk (no
// protobuf library, no re-encoding): Transaction.raw field 11 (repeated
// Contract) → contract[0] → {type, parameter=google.protobuf.Any} → Any.value,
// decoded by contract type.
const int tronTransferContract = 1; // Contract.type TransferContract
const int tronTriggerSmartContract = 31; // Contract.type TriggerSmartContract
const String trc20TransferSelector = 'a9059cbb'; // keccak('transfer(address,uint256)')[:4]

/// Cursor over a protobuf buffer exposing only the two wire types Tron tx
/// bodies use for the fields we read (varint, length-delimited) plus skip of
/// the fixed-width ones. Decode-only — never writes.
class _Pb {
  _Pb(this.buf);
  final Uint8List buf;
  int pos = 0;
  bool get eof => pos >= buf.length;
  BigInt _varint() {
    var shift = 0;
    var result = BigInt.zero;
    while (true) {
      if (pos >= buf.length) {
        throw const FormatException('tron: truncated varint in raw_data');
      }
      final b = buf[pos++];
      result |= BigInt.from(b & 0x7f) << shift;
      if ((b & 0x80) == 0) break;
      shift += 7;
    }
    return result;
  }

  Uint8List _lenDelim() {
    final len = _varint().toInt();
    if (len < 0 || pos + len > buf.length) {
      throw const FormatException('tron: length-delimited field overruns raw_data');
    }
    final out = buf.sublist(pos, pos + len);
    pos += len;
    return out;
  }

  /// (fieldNumber, wireType) of the next tag; advances past the tag.
  (int, int) tag() {
    final key = _varint().toInt();
    return (key >> 3, key & 7);
  }

  BigInt varint() => _varint();
  Uint8List bytes() => _lenDelim();

  /// Skip a field of the given wire type we do not care about.
  void skip(int wire) {
    switch (wire) {
      case 0:
        _varint();
      case 2:
        _lenDelim();
      case 1:
        pos += 8; // 64-bit
      case 5:
        pos += 4; // 32-bit
      default:
        throw FormatException('tron: unsupported wire type $wire in raw_data');
    }
  }
}

/// The subset of contract[0] fund-safety depends on, recovered from raw_data.
/// Address fields are the 21-byte 0x41-prefixed lowercase hex (compare with
/// [addressToHex]); [dataHex] is the lowercase TRC-20 calldata.
class DecodedTronContract {
  const DecodedTronContract({
    required this.type,
    required this.ownerHex,
    this.toHex,
    this.amount,
    this.contractHex,
    this.callValue,
    this.dataHex,
  });
  final int type;
  final String ownerHex;
  final String? toHex; // TransferContract recipient
  final BigInt? amount; // TransferContract amount (sun)
  final String? contractHex; // TriggerSmartContract token contract
  final BigInt? callValue; // TriggerSmartContract call_value (must be 0)
  final String? dataHex; // TriggerSmartContract ABI calldata
}

/// Decode the node-assembled raw_data far enough to re-verify the transfer.
/// Throws [FormatException] on anything malformed or unexpected.
DecodedTronContract decodeTronRawData(String rawDataHex) {
  final top = _Pb(c.hexToBytes(rawDataHex));
  Uint8List? contract;
  while (!top.eof) {
    final (field, wire) = top.tag();
    if (field == 11 && wire == 2) {
      contract = top.bytes(); // repeated Contract — take contract[0]
      break;
    }
    top.skip(wire);
  }
  if (contract == null) {
    throw const FormatException('tron: raw_data has no contract');
  }

  final cr = _Pb(contract);
  int? type;
  Uint8List? param;
  while (!cr.eof) {
    final (field, wire) = cr.tag();
    if (field == 1 && wire == 0) {
      type = cr.varint().toInt();
    } else if (field == 2 && wire == 2) {
      param = cr.bytes();
    } else {
      cr.skip(wire);
    }
  }
  if (type == null || param == null) {
    throw const FormatException('tron: malformed contract');
  }

  // parameter = google.protobuf.Any { f1 type_url (string), f2 value (bytes) }.
  final anyR = _Pb(param);
  Uint8List? value;
  while (!anyR.eof) {
    final (field, wire) = anyR.tag();
    if (field == 2 && wire == 2) {
      value = anyR.bytes();
    } else {
      anyR.skip(wire);
    }
  }
  if (value == null) {
    throw const FormatException('tron: empty Any.value');
  }

  final vr = _Pb(value);
  if (type == tronTransferContract) {
    String? owner, to;
    BigInt? amount;
    while (!vr.eof) {
      final (field, wire) = vr.tag();
      if (field == 1 && wire == 2) {
        owner = c.bytesToHex(vr.bytes());
      } else if (field == 2 && wire == 2) {
        to = c.bytesToHex(vr.bytes());
      } else if (field == 3 && wire == 0) {
        amount = vr.varint();
      } else {
        vr.skip(wire);
      }
    }
    if (owner == null || to == null || amount == null) {
      throw const FormatException('tron: incomplete TransferContract');
    }
    return DecodedTronContract(
        type: type, ownerHex: owner, toHex: to, amount: amount);
  } else if (type == tronTriggerSmartContract) {
    String? owner, contractAddr, data;
    var callValue = BigInt.zero;
    while (!vr.eof) {
      final (field, wire) = vr.tag();
      if (field == 1 && wire == 2) {
        owner = c.bytesToHex(vr.bytes());
      } else if (field == 2 && wire == 2) {
        contractAddr = c.bytesToHex(vr.bytes());
      } else if (field == 3 && wire == 0) {
        callValue = vr.varint();
      } else if (field == 4 && wire == 2) {
        data = c.bytesToHex(vr.bytes());
      } else {
        vr.skip(wire);
      }
    }
    if (owner == null || contractAddr == null || data == null) {
      throw const FormatException('tron: incomplete TriggerSmartContract');
    }
    return DecodedTronContract(
        type: type,
        ownerHex: owner,
        contractHex: contractAddr,
        callValue: callValue,
        dataHex: data);
  }
  throw FormatException('tron: unexpected contract type $type');
}

/// FUND-SAFETY GATE: decode [rawDataHex] and assert it encodes EXACTLY the
/// transfer the user asked for. Throws [StateError] (refusing to sign) on ANY
/// mismatch — a different recipient, amount, token, non-zero call_value, or
/// altered calldata. [ownerAddr], [to], [contract] may be any accepted form.
void assertTronRawDataMatches({
  required String rawDataHex,
  required bool isTrc20,
  required String ownerAddr,
  required String to,
  required String amount,
  String? contract,
}) {
  final DecodedTronContract d;
  try {
    d = decodeTronRawData(rawDataHex);
  } catch (e) {
    throw StateError('tron: cannot decode node raw_data — refusing to sign ($e)');
  }
  final ownerHex = addressToHex(ownerAddr);
  if (d.ownerHex != ownerHex) {
    throw StateError('tron: raw_data owner != our address — refusing to sign');
  }
  if (isTrc20) {
    if (d.type != tronTriggerSmartContract) {
      throw StateError('tron: expected TriggerSmartContract — refusing to sign');
    }
    if (contract == null || d.contractHex != addressToHex(contract)) {
      throw StateError('tron: raw_data token contract mismatch — refusing to sign');
    }
    if (d.callValue != BigInt.zero) {
      throw StateError('tron: non-zero call_value on a TRC-20 transfer — refusing to sign');
    }
    final expected =
        (trc20TransferSelector + trc20TransferParameter(to, amount)).toLowerCase();
    if ((d.dataHex ?? '') != expected) {
      throw StateError('tron: raw_data calldata != requested transfer — refusing to sign');
    }
  } else {
    if (d.type != tronTransferContract) {
      throw StateError('tron: expected TransferContract — refusing to sign');
    }
    if (d.toHex != addressToHex(to)) {
      throw StateError('tron: raw_data recipient != requested recipient — refusing to sign');
    }
    if (d.amount != BigInt.parse(amount)) {
      throw StateError('tron: raw_data amount != requested amount — refusing to sign');
    }
  }
}

class TronAdapter implements ChainAdapter {
  TronAdapter({
    this.path = tronDefaultPath,
    this.explorer = 'https://tronscan.org/#/transaction/',
    this.symbol = 'TRX',
    this.api,
    this.apiKey,
    HttpPostFn? post,
    int feeLimit = 15000000, // 15 TRX default TRC-20 fee cap (config-overridable)
  })  : _postOverride = post,
        _feeLimit = feeLimit {
    native = AssetRef(chain: 'tron', kind: 'native', symbol: symbol, decimals: 6);
  }

  final String path;
  final String explorer;
  final String symbol;

  /// TronGrid REST base, e.g. https://api.trongrid.io (CONFIG, never a secret).
  final String? api;

  /// Optional TronGrid API key → `TRON-PRO-API-KEY` header (CONFIG, never logged).
  final String? apiKey;
  final HttpPostFn? _postOverride;
  final int _feeLimit;

  @override
  ChainId get id => 'tron';
  @override
  late final AssetRef native;

  Uint8List? _rootSeed;

  @override
  void unlock(RootSecret root) => _rootSeed = root.seed;
  @override
  void lock() => _rootSeed = null;

  String _pathWithIndex(int index) => '$path/$index';

  hd.HdNode _nodeFor(int index) {
    if (_rootSeed == null) throw StateError('locked');
    return hd.derivePath(_rootSeed, _pathWithIndex(index));
  }

  /// POST {base}{path} with a JSON body; returns the decoded JSON object. The
  /// transport is injectable (tests) — otherwise package:http with an optional
  /// TRON-PRO-API-KEY header.
  Future<Map<String, dynamic>> _tronPost(
      String apiPath, Map<String, dynamic> body) async {
    final b = jsonEncode(body);
    if (_postOverride != null) {
      final resp = await _postOverride(apiPath, b);
      final j = jsonDecode(resp);
      return j is Map<String, dynamic> ? j : <String, dynamic>{};
    }
    final base = api;
    if (base == null) throw StateError('tron: no TronGrid endpoint configured');
    final headers = {'content-type': 'application/json'};
    final key = apiKey;
    if (key != null && key.isNotEmpty) headers['TRON-PRO-API-KEY'] = key;
    final r = await http.post(Uri.parse('$base$apiPath'),
        headers: headers, body: b);
    final j = jsonDecode(r.body);
    return j is Map<String, dynamic> ? j : <String, dynamic>{};
  }

  @override
  Future<DerivedAccount> deriveAccount(RootSecret root, {int index = 0}) async {
    final seed = root.seed ?? _rootSeed;
    if (seed == null) throw StateError('no root seed');
    final node = hd.derivePath(seed, _pathWithIndex(index));
    return DerivedAccount(
      chain: 'tron',
      index: index,
      address: tronAddressFromPub(node.publicKey),
      publicKey: c.bytesToHex(node.publicKey),
      scheme: 'secp256k1',
      path: _pathWithIndex(index),
    );
  }

  @override
  Future<List<Balance>> getBalance(String address,
      {List<AssetRef>? tokens}) async {
    final out = <Balance>[];
    try {
      final res =
          await _tronPost('/wallet/getaccount', {'address': address, 'visible': true});
      final bal = res['balance'];
      final v = BigInt.parse((bal ?? 0).toString()).toString();
      out.add(Balance(asset: native, confirmed: v, display: formatUnits(v, 6)));
    } catch (e) {
      out.add(Balance(
          asset: native, confirmed: '0', display: '—', error: e.toString()));
    }
    for (final t in tokens ?? const <AssetRef>[]) {
      if (t.kind != 'trc20' || t.address == null) continue;
      try {
        final res = await _tronPost('/wallet/triggerconstantcontract', {
          'owner_address': address,
          'contract_address': t.address,
          'function_selector': 'balanceOf(address)',
          'parameter': _abiAddress(address),
          'visible': true,
        });
        final cr = res['constant_result'];
        var amount = BigInt.zero;
        if (cr is List && cr.isNotEmpty) {
          final hex = cr.first.toString();
          if (hex.isNotEmpty) amount = BigInt.parse(hex, radix: 16);
        }
        final v = amount.toString();
        out.add(
            Balance(asset: t, confirmed: v, display: formatUnits(v, t.decimals)));
      } catch (e) {
        out.add(Balance(
            asset: t, confirmed: '0', display: '—', error: e.toString()));
      }
    }
    return out;
  }

  /// TRC-20 auto-detect via TronGrid's indexer (/v1/accounts/{addr}/trc20).
  /// Best-effort — returns `[]` on any failure or when unconfigured.
  @override
  Future<List<Balance>> discoverTokens(String address) async {
    return const [];
  }

  /// ASSEMBLE (node) + SIGN (local) a TRX / TRC-20 transfer. Returns a BuiltTx
  /// whose `raw` is the SIGNED tx JSON and `txid` is the verified txID. Does NOT
  /// broadcast — the confirmation gate inspects it first, then broadcast().
  @override
  Future<BuiltTx> buildSend(DerivedAccount account, SendRequest req) async {
    final node = _nodeFor(account.index);
    final priv = node.privateKey!;
    final from = account.address;
    final asset = req.asset;
    final isTrc20 = asset != null && asset.kind == 'trc20' && asset.address != null;

    Map<String, dynamic> unsigned;
    if (isTrc20) {
      unsigned = await _tronPost('/wallet/triggersmartcontract', {
        'owner_address': from,
        'contract_address': asset.address,
        'function_selector': 'transfer(address,uint256)',
        'parameter': trc20TransferParameter(req.to, req.amount),
        'fee_limit': _feeLimit,
        'call_value': 0,
        'visible': true,
      });
      // triggersmartcontract wraps the tx under `transaction`.
      final tx = unsigned['transaction'];
      if (tx is Map<String, dynamic>) unsigned = tx;
    } else {
      unsigned = await _tronPost('/wallet/createtransaction', {
        'owner_address': from,
        'to_address': req.to,
        'amount': int.parse(req.amount),
        'visible': true,
      });
    }

    final rawDataHex = (unsigned['raw_data_hex'] ?? '').toString();
    final nodeTxId = (unsigned['txID'] ?? '').toString();
    if (rawDataHex.isEmpty || nodeTxId.isEmpty) {
      final err = unsigned['Error'] ?? unsigned['error'] ?? 'node did not assemble a tx';
      throw StateError('tron: $err');
    }
    // GUARD 1 — txID binds to the bytes: re-derive txID locally. (Necessary but
    // NOT sufficient: sha256(raw_data) always equals a well-formed txID, so this
    // alone proves nothing about WHO the tx pays.)
    final localTxId = txIdFromRawData(rawDataHex);
    if (localTxId != nodeTxId.toLowerCase()) {
      throw StateError('tron: txID mismatch (node lied about raw_data)');
    }
    // GUARD 2 — the real fund-safety check: decode the node-assembled raw_data
    // and assert it encodes EXACTLY the transfer buildSend() was asked for. A
    // malicious node that swaps the recipient/amount/token/calldata is rejected
    // here, BEFORE any signature is produced.
    assertTronRawDataMatches(
      rawDataHex: rawDataHex,
      isTrc20: isTrc20,
      ownerAddr: from,
      to: req.to,
      amount: req.amount,
      contract: isTrc20 ? asset.address : null,
    );

    final sig = signTxId(c.hexToBytes(localTxId), priv);
    final signed = <String, dynamic>{
      ...unsigned,
      'signature': [c.bytesToHex(sig)],
    };
    return BuiltTx(
      chain: 'tron',
      raw: jsonEncode(signed),
      txid: localTxId,
      fee: isTrc20 ? _feeLimit.toString() : '0',
      summary: req,
      extra: {
        'kind': isTrc20 ? 'trc20' : 'native',
        'rawDataHex': rawDataHex,
        if (isTrc20) 'contract': asset.address,
      },
    );
  }

  @override
  Future<BroadcastResult> broadcast(BuiltTx tx) async {
    final signed = jsonDecode(tx.raw) as Map<String, dynamic>;
    final res = await _tronPost('/wallet/broadcasttransaction', signed);
    final ok = res['result'] == true || res['code'] == 'SUCCESS';
    final txid = (res['txid'] ?? tx.txid).toString();
    return BroadcastResult(txid, ok);
  }

  @override
  String explorerTx(String txid) => explorer + txid;
}
