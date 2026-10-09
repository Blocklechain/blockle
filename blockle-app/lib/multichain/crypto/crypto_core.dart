// crypto_core.dart — pure-Dart crypto primitives the multi-chain layer needs:
// SHA-256/512 + HMAC (for RFC6979 / BIP32 / BIP39), RIPEMD-160, Keccak-256,
// PBKDF2-HMAC-SHA512 (BIP39 seed), plus hex / base58check / RLP helpers.
//
// Hashes are backed by PointyCastle (audited, constant-shape implementations);
// the byte/encoding helpers mirror the extension's crypto-core.js so the Dart
// port is byte-identical to the browser reference.
//
// Nothing here is post-quantum — these are the classical primitives shared by
// EVM/BTC/LTC/DOGE/Solana. BLOCK's ML-DSA signing stays in blockle-wasm.
import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart' as pc;

// ---- byte / hex helpers ----------------------------------------------------
Uint8List hexToBytes(String hex) {
  var h = hex.startsWith('0x') ? hex.substring(2) : hex;
  if (h.length.isOdd) h = '0$h';
  final out = Uint8List(h.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(h.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String bytesToHex(List<int> bytes) {
  final b = StringBuffer();
  for (final v in bytes) {
    b.write((v & 0xff).toRadixString(16).padLeft(2, '0'));
  }
  return b.toString();
}

Uint8List concatBytes(List<List<int>> arrs) {
  var len = 0;
  for (final a in arrs) {
    len += a.length;
  }
  final out = Uint8List(len);
  var o = 0;
  for (final a in arrs) {
    out.setRange(o, o + a.length, a);
    o += a.length;
  }
  return out;
}

Uint8List utf8Bytes(String s) => Uint8List.fromList(utf8.encode(s));

Uint8List toBytes(dynamic x) {
  if (x is Uint8List) return x;
  if (x is List<int>) return Uint8List.fromList(x);
  if (x is String) return hexToBytes(x);
  throw ArgumentError('toBytes: unsupported ${x.runtimeType}');
}

// ---- hashes (PointyCastle) -------------------------------------------------
Uint8List sha256(List<int> msg) =>
    pc.SHA256Digest().process(Uint8List.fromList(msg));

Uint8List sha512(List<int> msg) =>
    pc.SHA512Digest().process(Uint8List.fromList(msg));

Uint8List ripemd160(List<int> msg) =>
    pc.RIPEMD160Digest().process(Uint8List.fromList(msg));

Uint8List keccak256(List<int> msg) =>
    pc.KeccakDigest(256).process(Uint8List.fromList(msg));

Uint8List _hmac(pc.Digest digest, int blockSize, List<int> key, List<int> msg) {
  final mac = pc.HMac(digest, blockSize)..init(pc.KeyParameter(toBytes(key)));
  return mac.process(Uint8List.fromList(msg));
}

Uint8List hmacSha256(List<int> key, List<int> msg) =>
    _hmac(pc.SHA256Digest(), 64, key, msg);

Uint8List hmacSha512(List<int> key, List<int> msg) =>
    _hmac(pc.SHA512Digest(), 128, key, msg);

// PBKDF2-HMAC-SHA512 (BIP39 mnemonic -> seed).
Uint8List pbkdf2Sha512(
    List<int> password, List<int> salt, int iterations, int dkLen) {
  final derivator = pc.PBKDF2KeyDerivator(pc.HMac(pc.SHA512Digest(), 128))
    ..init(pc.Pbkdf2Parameters(Uint8List.fromList(salt), iterations, dkLen));
  return derivator.process(Uint8List.fromList(password));
}

Uint8List hash256(List<int> msg) => sha256(sha256(msg)); // double SHA-256
Uint8List hash160(List<int> msg) => ripemd160(sha256(msg)); // RIPEMD160(SHA256)

// ---- Base58 / Base58Check --------------------------------------------------
const String _b58 =
    '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

String base58encode(List<int> bytes) {
  final b = toBytes(bytes);
  var zeros = 0;
  while (zeros < b.length && b[zeros] == 0) {
    zeros++;
  }
  final digits = <int>[0];
  for (var i = zeros; i < b.length; i++) {
    var carry = b[i];
    for (var j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = carry ~/ 58;
    }
    while (carry > 0) {
      digits.add(carry % 58);
      carry = carry ~/ 58;
    }
  }
  final sb = StringBuffer();
  for (var i = 0; i < zeros; i++) {
    sb.write('1');
  }
  for (var i = digits.length - 1; i >= 0; i--) {
    sb.write(_b58[digits[i]]);
  }
  return sb.toString();
}

Uint8List base58decode(String str) {
  final bytes = <int>[0];
  for (final ch in str.split('')) {
    final val = _b58.indexOf(ch);
    if (val < 0) throw FormatException('invalid base58 char: $ch');
    var carry = val;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.add(carry & 0xff);
      carry >>= 8;
    }
  }
  var zeros = 0;
  for (final ch in str.split('')) {
    if (ch == '1') {
      zeros++;
    } else {
      break;
    }
  }
  final out = Uint8List(zeros + bytes.length);
  for (var i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i];
  }
  return out;
}

String base58checkEncode(List<int> payload) {
  final b = toBytes(payload);
  final checksum = hash256(b).sublist(0, 4);
  return base58encode(concatBytes([b, checksum]));
}

Uint8List base58checkDecode(String str) {
  final full = base58decode(str);
  final payload = full.sublist(0, full.length - 4);
  final checksum = full.sublist(full.length - 4);
  final expect = hash256(payload).sublist(0, 4);
  for (var i = 0; i < 4; i++) {
    if (checksum[i] != expect[i]) {
      throw const FormatException('bad base58check checksum');
    }
  }
  return payload;
}

// ---- RLP (Ethereum) --------------------------------------------------------
Uint8List _rlpEncodeLength(int len, int offset) {
  if (len < 56) return Uint8List.fromList([len + offset]);
  var hex = len.toRadixString(16);
  if (hex.length.isOdd) hex = '0$hex';
  final lenBytes = hexToBytes(hex);
  return concatBytes([
    Uint8List.fromList([lenBytes.length + offset + 55]),
    lenBytes,
  ]);
}

/// RLP-encode a nested structure. Convention (unambiguous, unlike JS): a
/// [Uint8List] is a byte string leaf; ANY other [List] is a structural list
/// (so an empty structural list `<dynamic>[]` correctly encodes as 0xc0, used
/// for the EIP-1559 empty accessList). Mirrors crypto-core.js `rlpEncode`.
Uint8List rlpEncode(dynamic input) {
  if (input is List && input is! Uint8List) {
    var out = Uint8List(0);
    for (final item in input) {
      out = concatBytes([out, rlpEncode(item)]);
    }
    return concatBytes([_rlpEncodeLength(out.length, 0xc0), out]);
  }
  final b = toBytes(input);
  if (b.length == 1 && b[0] < 0x80) return b;
  return concatBytes([_rlpEncodeLength(b.length, 0x80), b]);
}
