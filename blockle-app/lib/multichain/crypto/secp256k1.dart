// secp256k1.dart — the ECDSA curve used by EVM and BTC/LTC/DOGE. Pure BigInt,
// ported from the audited extension secp256k1.js so signatures are
// byte-identical to the browser reference.
//
// Provides: private->public key, point add (for BIP32 child derivation),
// deterministic ECDSA signing (RFC6979, low-S, with recovery id), DER encoding,
// verify + public-key recovery.
//
// NOT post-quantum — this is secp256k1/ECDSA, same as Bitcoin and Ethereum.
// BLOCK's post-quantum signing stays in blockle-wasm.
import 'dart:typed_data';

import 'crypto_core.dart' as c;

final BigInt _p = BigInt.parse(
    'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f',
    radix: 16);
final BigInt n = BigInt.parse(
    'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    radix: 16);
final BigInt _gx = BigInt.parse(
    '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    radix: 16);
final BigInt _gy = BigInt.parse(
    '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
    radix: 16);
final BigInt _a = BigInt.zero;
final BigInt _b = BigInt.from(7);

final BigInt _two = BigInt.two;
final BigInt _three = BigInt.from(3);

/// Affine point; `null` = point at infinity.
typedef Point = List<BigInt>;

BigInt mod(BigInt a, [BigInt? m]) {
  final mm = m ?? _p;
  final r = a % mm;
  return r >= BigInt.zero ? r : r + mm;
}

BigInt invMod(BigInt a, [BigInt? m]) {
  final mm = m ?? _p;
  a = mod(a, mm);
  var oldR = a, r = mm;
  var oldS = BigInt.one, s = BigInt.zero;
  while (r != BigInt.zero) {
    final q = oldR ~/ r;
    final tr = oldR - q * r;
    oldR = r;
    r = tr;
    final ts = oldS - q * s;
    oldS = s;
    s = ts;
  }
  return mod(oldS, mm);
}

BigInt powMod(BigInt base, BigInt exp, BigInt m) {
  base = mod(base, m);
  var result = BigInt.one;
  while (exp > BigInt.zero) {
    if ((exp & BigInt.one) == BigInt.one) result = mod(result * base, m);
    base = mod(base * base, m);
    exp >>= 1;
  }
  return result;
}

Point? pointAdd(Point? p1, Point? p2) {
  if (p1 == null) return p2;
  if (p2 == null) return p1;
  final x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
  if (x1 == x2 && mod(y1 + y2) == BigInt.zero) return null;
  BigInt m;
  if (x1 == x2 && y1 == y2) {
    m = mod((_three * x1 * x1 + _a) * invMod(_two * y1));
  } else {
    m = mod((y2 - y1) * invMod(x2 - x1));
  }
  final x3 = mod(m * m - x1 - x2);
  final y3 = mod(m * (x1 - x3) - y1);
  return [x3, y3];
}

Point? pointMul(BigInt k, Point? point) {
  k = mod(k, n);
  Point? result;
  var addend = point;
  while (k > BigInt.zero) {
    if ((k & BigInt.one) == BigInt.one) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1;
  }
  return result;
}

final Point g = [_gx, _gy];

BigInt bytesToBig(List<int> b) {
  var x = BigInt.zero;
  for (final v in b) {
    x = (x << 8) | BigInt.from(v);
  }
  return x;
}

Uint8List bigTo32(BigInt x) {
  final out = Uint8List(32);
  for (var i = 31; i >= 0; i--) {
    out[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  return out;
}

bool isValidPrivate(BigInt d) => d > BigInt.zero && d < n;

Uint8List encodePoint(Point q, bool compressed) {
  final x = q[0], y = q[1];
  final xb = bigTo32(x);
  if (compressed) {
    final prefix = (y & BigInt.one) == BigInt.zero ? 0x02 : 0x03;
    return c.concatBytes([
      Uint8List.fromList([prefix]),
      xb,
    ]);
  }
  return c.concatBytes([
    Uint8List.fromList([0x04]),
    xb,
    bigTo32(y),
  ]);
}

Point decodePoint(List<int> pub) {
  final b = c.toBytes(pub);
  if (b[0] == 0x04) {
    return [bytesToBig(b.sublist(1, 33)), bytesToBig(b.sublist(33, 65))];
  }
  final x = bytesToBig(b.sublist(1, 33));
  final ySq = mod(x * x * x + _b);
  var y = powMod(ySq, (_p + BigInt.one) ~/ BigInt.from(4), _p);
  if ((y & BigInt.one) != BigInt.from(b[0] & 1)) y = mod(-y);
  return [x, y];
}

/// 33-byte compressed (default) or 65-byte uncompressed public key.
Uint8List publicKey(List<int> privBytes, {bool compressed = true}) {
  final d = bytesToBig(c.toBytes(privBytes));
  if (!isValidPrivate(d)) throw ArgumentError('invalid private key');
  final q = pointMul(d, g)!;
  return encodePoint(q, compressed);
}

/// BIP32: parentPub + tweak*G (non-hardened public child derivation).
Uint8List pointAddScalar(List<int> pubBytes, List<int> tweakBytes) {
  final q = decodePoint(pubBytes);
  final t = bytesToBig(c.toBytes(tweakBytes));
  final r = pointAdd(q, pointMul(t, g));
  if (r == null) throw StateError('infinity');
  return encodePoint(r, true);
}

/// BIP32: parentPriv + tweak (mod n) — private child derivation.
Uint8List privAdd(List<int> privBytes, List<int> tweakBytes) {
  final d = bytesToBig(c.toBytes(privBytes));
  final t = bytesToBig(c.toBytes(tweakBytes));
  final r = mod(d + t, n);
  if (r == BigInt.zero) throw StateError('zero key');
  return bigTo32(r);
}

/// Deterministic ECDSA signature (RFC6979, HMAC-SHA256), low-S, with recovery.
class EcdsaSignature {
  EcdsaSignature(this.r, this.s, this.recovery);
  final BigInt r;
  final BigInt s;
  final int recovery;

  Uint8List get rBytes => bigTo32(r);
  Uint8List get sBytes => bigTo32(s);
  String get rHex => c.bytesToHex(rBytes);
  String get sHex => c.bytesToHex(sBytes);
  Uint8List get compact => c.concatBytes([rBytes, sBytes]);
  Uint8List get der => derEncode(r, s);
}

EcdsaSignature sign(List<int> msgHash, List<int> privBytes) {
  final h1 = c.toBytes(msgHash);
  final x = c.toBytes(privBytes);
  final d = bytesToBig(x);
  if (!isValidPrivate(d)) throw ArgumentError('invalid private key');
  final z = bytesToBig(h1);

  var v = Uint8List(32)..fillRange(0, 32, 1);
  var k = Uint8List(32); // all zero
  final x32 = bigTo32(d);
  final z32 = bigTo32(mod(z, n));
  k = c.hmacSha256(
      k,
      c.concatBytes([
        v,
        Uint8List.fromList([0x00]),
        x32,
        z32,
      ]));
  v = c.hmacSha256(k, v);
  k = c.hmacSha256(
      k,
      c.concatBytes([
        v,
        Uint8List.fromList([0x01]),
        x32,
        z32,
      ]));
  v = c.hmacSha256(k, v);
  for (var iter = 0; iter < 1000; iter++) {
    v = c.hmacSha256(k, v);
    final kCand = bytesToBig(v);
    if (kCand > BigInt.zero && kCand < n) {
      final rPt = pointMul(kCand, g)!;
      final r = mod(rPt[0], n);
      if (r != BigInt.zero) {
        var s = mod(invMod(kCand, n) * mod(z + r * d, n), n);
        var recovery = (rPt[1] & BigInt.one) == BigInt.zero ? 0 : 1;
        if (rPt[0] >= n) recovery |= 2;
        if (s > n ~/ _two) {
          s = n - s;
          recovery ^= 1;
        }
        return EcdsaSignature(r, s, recovery);
      }
    }
    k = c.hmacSha256(
        k,
        c.concatBytes([
          v,
          Uint8List.fromList([0x00]),
        ]));
    v = c.hmacSha256(k, v);
  }
  throw StateError('sign failed');
}

Uint8List derEncode(BigInt r, BigInt s) {
  Uint8List enc(BigInt v) {
    var b = bigTo32(v);
    var i = 0;
    while (i < b.length - 1 && b[i] == 0) {
      i++;
    }
    b = b.sublist(i);
    if ((b[0] & 0x80) != 0) {
      b = c.concatBytes([
        Uint8List.fromList([0x00]),
        b,
      ]);
    }
    return b;
  }

  final rb = enc(r), sb = enc(s);
  final body = c.concatBytes([
    Uint8List.fromList([0x02, rb.length]),
    rb,
    Uint8List.fromList([0x02, sb.length]),
    sb,
  ]);
  return c.concatBytes([
    Uint8List.fromList([0x30, body.length]),
    body,
  ]);
}

bool verify(List<int> msgHash, EcdsaSignature sig, List<int> pubBytes) {
  final z = mod(bytesToBig(c.toBytes(msgHash)), n);
  final r = sig.r, s = sig.s;
  if (r <= BigInt.zero || r >= n || s <= BigInt.zero || s >= n) return false;
  final w = invMod(s, n);
  final u1 = mod(z * w, n);
  final u2 = mod(r * w, n);
  final q = decodePoint(pubBytes);
  final rPt = pointAdd(pointMul(u1, g), pointMul(u2, q));
  if (rPt == null) return false;
  return mod(rPt[0], n) == r;
}

/// Recover a public key from a hash + signature + recovery id.
Uint8List recover(
    List<int> msgHash, BigInt r, BigInt s, int recovery, bool compressed) {
  final z = mod(bytesToBig(c.toBytes(msgHash)), n);
  final x = (recovery & 2) != 0 ? r + n : r;
  final ySq = mod(x * x * x + _b);
  var y = powMod(ySq, (_p + BigInt.one) ~/ BigInt.from(4), _p);
  if ((y & BigInt.one) != BigInt.from(recovery & 1)) y = mod(-y);
  final rPoint = [x, y];
  final rInv = invMod(r, n);
  final sR = pointMul(s, rPoint);
  final zG = pointMul(z, g)!;
  final q = pointMul(rInv, pointAdd(sR, [zG[0], mod(-zG[1])]))!;
  return encodePoint(q, compressed);
}
