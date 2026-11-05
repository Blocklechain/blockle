// address.dart — address encoders for the secp256k1 chains:
//   • EVM checksummed hex (EIP-55)
//   • Bitcoin/Litecoin native SegWit v0 P2WPKH (bech32, BIP173)
//   • legacy Base58Check P2PKH (BTC/LTC/DOGE)
//   • WIF private-key import/export
// Ported from the extension's address.js.
import 'dart:typed_data';

import 'crypto_core.dart' as c;
import 'secp256k1.dart' as s;

// ---- bech32 / bech32m (BIP173 / BIP350) ------------------------------------
const String _charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const List<int> _gen = [
  0x3b6a57b2,
  0x26508e6d,
  0x1ea119fa,
  0x3d4233dd,
  0x2a1462b3
];

int _polymod(List<int> values) {
  var chk = 1;
  for (final v in values) {
    final b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (var i = 0; i < 5; i++) {
      if (((b >> i) & 1) != 0) chk ^= _gen[i];
    }
  }
  return chk;
}

List<int> _hrpExpand(String hrp) {
  final ret = <int>[];
  for (var i = 0; i < hrp.length; i++) {
    ret.add(hrp.codeUnitAt(i) >> 5);
  }
  ret.add(0);
  for (var i = 0; i < hrp.length; i++) {
    ret.add(hrp.codeUnitAt(i) & 31);
  }
  return ret;
}

List<int> _createChecksum(String hrp, List<int> data, String spec) {
  final values = [..._hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  final mod = _polymod(values) ^ (spec == 'bech32m' ? 0x2bc830a3 : 1);
  final ret = <int>[];
  for (var i = 0; i < 6; i++) {
    ret.add((mod >> (5 * (5 - i))) & 31);
  }
  return ret;
}

bool _verifyChecksum(String hrp, List<int> data, String spec) {
  final c2 = _polymod([..._hrpExpand(hrp), ...data]);
  return c2 == (spec == 'bech32m' ? 0x2bc830a3 : 1);
}

List<int>? convertBits(List<int> data, int from, int to, bool pad) {
  var acc = 0, bits = 0;
  final ret = <int>[];
  final maxv = (1 << to) - 1;
  for (final value in data) {
    if (value < 0 || (value >> from) != 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.add((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.add((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) != 0) {
    return null;
  }
  return ret;
}

String segwitEncode(String hrp, int witver, List<int> program) {
  final prog = c.toBytes(program);
  final spec = witver == 0 ? 'bech32' : 'bech32m';
  final data = [witver, ...convertBits(prog, 8, 5, true)!];
  final combined = [...data, ..._createChecksum(hrp, data, spec)];
  final sb = StringBuffer('${hrp}1');
  for (final d in combined) {
    sb.write(_charset[d]);
  }
  return sb.toString();
}

class SegwitDecoded {
  SegwitDecoded(this.version, this.program);
  final int version;
  final Uint8List program;
}

SegwitDecoded segwitDecode(String hrp, String addr) {
  final lowered = addr.toLowerCase();
  if (!lowered.startsWith('${hrp}1')) throw const FormatException('wrong hrp');
  final data = <int>[];
  final body = lowered.substring(hrp.length + 1);
  for (final ch in body.split('')) {
    final d = _charset.indexOf(ch);
    if (d < 0) throw const FormatException('bad bech32 char');
    data.add(d);
  }
  final witver = data[0];
  final spec = witver == 0 ? 'bech32' : 'bech32m';
  if (!_verifyChecksum(hrp, data, spec)) {
    throw const FormatException('bad bech32 checksum');
  }
  final program = convertBits(data.sublist(1, data.length - 6), 5, 8, false);
  if (program == null) throw const FormatException('bad program');
  return SegwitDecoded(witver, Uint8List.fromList(program));
}

/// Generic bech32 encode (used for the BLOCK `block1…` address format).
String bech32Encode(String hrp, List<int> bytes) {
  final data = convertBits(c.toBytes(bytes), 8, 5, true)!;
  final combined = [...data, ..._createChecksum(hrp, data, 'bech32')];
  final sb = StringBuffer('${hrp}1');
  for (final d in combined) {
    sb.write(_charset[d]);
  }
  return sb.toString();
}

// ---- CashAddr (Bitcoin Cash) -----------------------------------------------
// NOT bech32: a DIFFERENT 40-bit BCH polymod. Self-contained codec; reuses only
// the shared base32 `_charset` + `convertBits` above. BigInt is used for the
// 40-bit polymod so it is correct on both the Dart VM and dart2js (web).
final List<BigInt> _cashGen = [
  BigInt.parse('98f2bc8e61', radix: 16),
  BigInt.parse('79b76d99e2', radix: 16),
  BigInt.parse('f33e5fb3c4', radix: 16),
  BigInt.parse('ae2eabe2a8', radix: 16),
  BigInt.parse('1e4f43e470', radix: 16),
];
final BigInt _cash35 = BigInt.parse('07ffffffff', radix: 16);

BigInt _cashPolymod(List<int> values) {
  var c0 = BigInt.one;
  for (final v in values) {
    final b = c0 >> 35;
    c0 = ((c0 & _cash35) << 5) ^ BigInt.from(v);
    for (var i = 0; i < 5; i++) {
      if (((b >> i) & BigInt.one) != BigInt.zero) c0 ^= _cashGen[i];
    }
  }
  return c0 ^ BigInt.one;
}

List<int> _cashPrefixExpand(String prefix) {
  final ret = <int>[];
  for (var i = 0; i < prefix.length; i++) {
    ret.add(prefix.codeUnitAt(i) & 0x1f);
  }
  ret.add(0);
  return ret;
}

/// Encode a CashAddr. `type`: 0 = P2PKH, 1 = P2SH. A 160-bit hash => sizeBits 0.
String cashAddrEncode(String prefix, int type, List<int> hash) {
  final h = c.toBytes(hash);
  final versionByte = (type << 3) | 0;
  final payload5 = [versionByte, ...h];
  final data = convertBits(payload5, 8, 5, true)!;
  final checksumInput = [..._cashPrefixExpand(prefix), ...data, 0, 0, 0, 0, 0, 0, 0, 0];
  final mod = _cashPolymod(checksumInput);
  final checksum = <int>[];
  for (var i = 0; i < 8; i++) {
    checksum.add(((mod >> (5 * (7 - i))) & BigInt.from(0x1f)).toInt());
  }
  final sb = StringBuffer('$prefix:');
  for (final d in [...data, ...checksum]) {
    sb.write(_charset[d]);
  }
  return sb.toString();
}

/// Cheap heuristic: does this string look like a CashAddr (prefixed or bare)?
bool looksLikeCashAddr(String address) {
  if (address.isEmpty) return false;
  if (address.contains(':')) return true; // prefixed form, e.g. bitcoincash:q...
  // bare form: a 160-bit CashAddr is exactly 42 base32 chars (34 payload + 8 cksum)
  if (address.length != 42) return false;
  final low = address.toLowerCase();
  for (final ch in low.split('')) {
    if (!_charset.contains(ch)) return false;
  }
  return true;
}

class CashAddrDecoded {
  CashAddrDecoded(this.prefix, this.type, this.hash);
  final String prefix;
  final int type;
  final Uint8List hash;
}

CashAddrDecoded cashAddrDecode(String address, [String expectPrefix = 'bitcoincash']) {
  String prefix, body;
  if (address.contains(':')) {
    final p = address.split(':');
    prefix = p[0].toLowerCase();
    body = p[1].toLowerCase();
  } else {
    prefix = expectPrefix;
    body = address.toLowerCase();
  }
  final values = <int>[];
  for (final ch in body.split('')) {
    final d = _charset.indexOf(ch);
    if (d < 0) throw const FormatException('bad cashaddr char');
    values.add(d);
  }
  if (_cashPolymod([..._cashPrefixExpand(prefix), ...values]) != BigInt.zero) {
    throw const FormatException('bad cashaddr checksum');
  }
  final payload = convertBits(values.sublist(0, values.length - 8), 5, 8, false);
  if (payload == null) throw const FormatException('bad cashaddr payload');
  final versionByte = payload[0];
  final type = versionByte >> 3;
  return CashAddrDecoded(prefix, type, Uint8List.fromList(payload.sublist(1)));
}

/// Derive a CashAddr P2PKH from a compressed pubkey.
String cashAddrP2pkh(List<int> pubKeyBytes, [String prefix = 'bitcoincash']) {
  final h160 = c.hash160(c.toBytes(pubKeyBytes));
  return cashAddrEncode(prefix, 0, h160);
}

// ---- EVM (EIP-55 checksum) -------------------------------------------------
String evmAddress(List<int> pubKeyBytes) {
  var pub = c.toBytes(pubKeyBytes);
  if (pub.length == 33) pub = s.encodePoint(s.decodePoint(pub), false);
  final body = pub.sublist(1); // drop 0x04
  final hash = c.keccak256(body);
  return toChecksumAddress('0x${c.bytesToHex(hash.sublist(hash.length - 20))}');
}

String toChecksumAddress(String addr) {
  final a = addr.toLowerCase().replaceFirst(RegExp(r'^0x'), '');
  final hash = c.bytesToHex(c.keccak256(c.utf8Bytes(a)));
  final sb = StringBuffer('0x');
  for (var i = 0; i < a.length; i++) {
    sb.write(int.parse(hash[i], radix: 16) >= 8 ? a[i].toUpperCase() : a[i]);
  }
  return sb.toString();
}

// ---- UTXO addresses --------------------------------------------------------
/// P2WPKH native segwit (BTC/LTC): hrp-dependent. `pubKeyBytes` MUST be
/// compressed (33 bytes).
String p2wpkh(List<int> pubKeyBytes, String hrp) {
  final pub = c.toBytes(pubKeyBytes);
  final h160 = c.hash160(pub);
  return segwitEncode(hrp, 0, h160);
}

/// Legacy P2PKH base58check (BTC/LTC/DOGE): version byte per network.
String p2pkh(List<int> pubKeyBytes, int versionByte) {
  final pub = c.toBytes(pubKeyBytes);
  final h160 = c.hash160(pub);
  return c.base58checkEncode(c.concatBytes([
    Uint8List.fromList([versionByte]),
    h160,
  ]));
}

// ---- WIF -------------------------------------------------------------------
String toWIF(List<int> privBytes,
    {int versionByte = 0x80, bool compressed = true}) {
  var payload = c.concatBytes([
    Uint8List.fromList([versionByte]),
    c.toBytes(privBytes),
  ]);
  if (compressed) {
    payload = c.concatBytes([
      payload,
      Uint8List.fromList([0x01]),
    ]);
  }
  return c.base58checkEncode(payload);
}

class WifDecoded {
  WifDecoded(this.version, this.privateKey, this.compressed);
  final int version;
  final Uint8List privateKey;
  final bool compressed;
}

WifDecoded fromWIF(String wif) {
  final dec = c.base58checkDecode(wif);
  final compressed = dec.length == 34;
  return WifDecoded(
      dec[0], Uint8List.fromList(dec.sublist(1, 33)), compressed);
}
