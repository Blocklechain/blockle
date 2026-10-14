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
import 'dart:math';
import 'dart:typed_data';

import 'package:pointycastle/export.dart' as pc;

/// Cryptographically-secure random bytes (Random.secure).
Uint8List randomBytes(int n) {
  final rng = Random.secure();
  final out = Uint8List(n);
  for (var i = 0; i < n; i++) {
    out[i] = rng.nextInt(256);
  }
  return out;
}

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

// ===========================================================================
// WALLETCONNECT v2 TRANSPORT CRYPTO — ChaCha20-Poly1305 (RFC 8439) + HKDF-SHA256
// + X25519 (RFC 7748). Ported to match blockle-extension/crypto-core.js so the
// Dart WC relay (wc_relay.dart) produces byte-identical envelopes / derivations.
// ===========================================================================

/// ChaCha20-Poly1305 AEAD seal → ciphertext||tag(16). Empty [aad] per WC v2.
/// Returned bytes are `ciphertext || 16-byte-tag` (the WC "sealbox").
Uint8List chacha20poly1305Seal(List<int> key, List<int> nonce, List<int> pt,
    [List<int>? aad]) {
  // NOTE: PointyCastle's BaseAEADCipher.process() only runs processBytes (no
  // doFinal) — it never appends the Poly1305 tag and leaves the trailing block
  // buffered. Drive processBytes + doFinal explicitly to get ct || tag(16).
  final c = pc.ChaCha20Poly1305(pc.ChaCha7539Engine(), pc.Poly1305())
    ..init(
        true,
        pc.AEADParameters(pc.KeyParameter(toBytes(key)), 128,
            toBytes(nonce), Uint8List.fromList(aad ?? const [])));
  final input = Uint8List.fromList(pt);
  final out = Uint8List(input.length + 16);
  var len = c.processBytes(input, 0, input.length, out, 0);
  len += c.doFinal(out, len);
  return out.sublist(0, len);
}

/// ChaCha20-Poly1305 AEAD open of `ciphertext||tag`. Returns the plaintext, or
/// `null` on authentication failure (NEVER forged plaintext).
Uint8List? chacha20poly1305Open(List<int> key, List<int> nonce, List<int> sealbox,
    [List<int>? aad]) {
  try {
    final c = pc.ChaCha20Poly1305(pc.ChaCha7539Engine(), pc.Poly1305())
      ..init(
          false,
          pc.AEADParameters(pc.KeyParameter(toBytes(key)), 128,
              toBytes(nonce), Uint8List.fromList(aad ?? const [])));
    final input = Uint8List.fromList(sealbox);
    if (input.length < 16) return null;
    final out = Uint8List(input.length);
    var len = c.processBytes(input, 0, input.length, out, 0);
    len += c.doFinal(out, len); // throws on a failed MAC check
    return out.sublist(0, len);
  } catch (_) {
    return null; // bad tag / truncated — authentication failed
  }
}

/// HKDF-SHA256 extract+expand. [salt]/[info] may be null (WC v2 uses neither).
Uint8List hkdfSha256(List<int> ikm, List<int>? salt, List<int>? info, int length) {
  final d = pc.HKDFKeyDerivator(pc.SHA256Digest())
    ..init(pc.HkdfParameters(
        toBytes(ikm),
        length,
        salt == null ? null : toBytes(salt),
        info == null ? Uint8List(0) : toBytes(info)));
  return d.process(Uint8List(0));
}

// ---- X25519 (RFC 7748) — Montgomery-ladder scalar multiplication -----------
final BigInt _x25519P = (BigInt.one << 255) - BigInt.from(19);
final BigInt _x25519A24 = BigInt.from(121665);

BigInt _modPow(BigInt base, BigInt exp, BigInt m) {
  base = base % m;
  var r = BigInt.one;
  while (exp > BigInt.zero) {
    if ((exp & BigInt.one) == BigInt.one) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1;
  }
  return r;
}

BigInt _x25519DecodeU(List<int> u) {
  final t = Uint8List.fromList(u.sublist(0, 32));
  t[31] &= 0x7f; // RFC 7748 decodeUCoordinate masks the MSB
  var x = BigInt.zero;
  for (var i = 31; i >= 0; i--) {
    x = (x << 8) | BigInt.from(t[i]);
  }
  return x % _x25519P;
}

BigInt _x25519Clamp(List<int> scalar) {
  final k = Uint8List.fromList(scalar.sublist(0, 32));
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;
  var n = BigInt.zero;
  for (var i = 31; i >= 0; i--) {
    n = (n << 8) | BigInt.from(k[i]);
  }
  return n;
}

/// X25519 scalar mult: clamp [scalar], multiply the u-coordinate [uCoord].
Uint8List x25519(List<int> scalar, List<int> uCoord) {
  final k = _x25519Clamp(scalar);
  final x1 = _x25519DecodeU(uCoord);
  var x2 = BigInt.one, z2 = BigInt.zero, x3 = x1, z3 = BigInt.one;
  var swap = BigInt.zero;
  for (var t = 254; t >= 0; t--) {
    final kt = (k >> t) & BigInt.one;
    swap ^= kt;
    if (swap == BigInt.one) {
      var tmp = x2; x2 = x3; x3 = tmp;
      tmp = z2; z2 = z3; z3 = tmp;
    }
    swap = kt;
    final a = (x2 + z2) % _x25519P;
    final aa = (a * a) % _x25519P;
    final b = (x2 - z2) % _x25519P;
    final bb = (b * b) % _x25519P;
    final e = (aa - bb) % _x25519P;
    final cc = (x3 + z3) % _x25519P;
    final d = (x3 - z3) % _x25519P;
    final da = (d * a) % _x25519P;
    final cb = (cc * b) % _x25519P;
    x3 = ((da + cb) * (da + cb)) % _x25519P;
    z3 = (x1 * (((da - cb) % _x25519P) * ((da - cb) % _x25519P))) % _x25519P;
    x2 = (aa * bb) % _x25519P;
    z2 = (e * ((aa + (_x25519A24 * e)) % _x25519P)) % _x25519P;
  }
  if (swap == BigInt.one) {
    var tmp = x2; x2 = x3; x3 = tmp;
    tmp = z2; z2 = z3; z3 = tmp;
  }
  final res = (x2 * _modPow(z2, _x25519P - BigInt.two, _x25519P)) % _x25519P;
  final out = Uint8List(32);
  var v = res % _x25519P;
  for (var i = 0; i < 32; i++) {
    out[i] = (v & BigInt.from(0xff)).toInt();
    v >>= 8;
  }
  return out;
}

/// X25519 public key from a private scalar: scalar · basepoint (u = 9).
Uint8List x25519Base(List<int> scalar) {
  final base = Uint8List(32)..[0] = 9;
  return x25519(scalar, base);
}

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
