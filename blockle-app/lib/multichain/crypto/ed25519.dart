// ed25519.dart — pure-Dart Ed25519 (RFC 8032) signing + verification, the
// signature scheme Solana uses for account keys and transaction signatures.
// Ported from the extension's ed25519.js (extended twisted-Edwards coordinates,
// SHA-512 from crypto_core) and validated against RFC 8032 §7.1 test vectors.
//
// NOT post-quantum — Ed25519 is classical EC crypto (only BLOCK is PQ via ML-DSA).
import 'dart:typed_data';

import 'crypto_core.dart' as c;

final BigInt _p = (BigInt.one << 255) - BigInt.from(19);
final BigInt l = (BigInt.one << 252) +
    BigInt.parse('27742317777372353535851937790883648493');

BigInt _mod(BigInt a, [BigInt? m]) {
  final mm = m ?? _p;
  final r = a % mm;
  return r >= BigInt.zero ? r : r + mm;
}

BigInt _powMod(BigInt base, BigInt exp, BigInt m) {
  base = _mod(base, m);
  var result = BigInt.one;
  while (exp > BigInt.zero) {
    if ((exp & BigInt.one) == BigInt.one) result = _mod(result * base, m);
    base = _mod(base * base, m);
    exp >>= 1;
  }
  return result;
}

BigInt _invMod(BigInt a, [BigInt? m]) {
  final mm = m ?? _p;
  return _powMod(_mod(a, mm), mm - BigInt.two, mm);
}

final BigInt _d = _mod(BigInt.from(-121665) * _invMod(BigInt.from(121666)));
final BigInt _sqrtM1 =
    _powMod(BigInt.two, (_p - BigInt.one) ~/ BigInt.from(4), _p);

BigInt _bytesToBigLE(List<int> b) {
  var x = BigInt.zero;
  for (var i = b.length - 1; i >= 0; i--) {
    x = (x << 8) | BigInt.from(b[i]);
  }
  return x;
}

Uint8List bigToBytesLE(BigInt x, int len) {
  final out = Uint8List(len);
  for (var i = 0; i < len; i++) {
    out[i] = (x & BigInt.from(0xff)).toInt();
    x >>= 8;
  }
  return out;
}

// Extended twisted-Edwards point [X, Y, Z, T]; neutral element is (0, 1).
typedef _Pt = List<BigInt>;
final _Pt _neutral = [BigInt.zero, BigInt.one, BigInt.one, BigInt.zero];

_Pt _pointAdd(_Pt p1, _Pt p2) {
  final a = _mod((p1[1] - p1[0]) * (p2[1] - p2[0]));
  final b = _mod((p1[1] + p1[0]) * (p2[1] + p2[0]));
  final cc = _mod(BigInt.two * p1[3] * p2[3] * _d);
  final dd = _mod(BigInt.two * p1[2] * p2[2]);
  final e = b - a, f = dd - cc, gg = dd + cc, hh = b + a;
  return [_mod(e * f), _mod(gg * hh), _mod(f * gg), _mod(e * hh)];
}

_Pt _pointMul(BigInt s, _Pt point) {
  var q = _neutral;
  var pt = point;
  s = _mod(s, l);
  while (s > BigInt.zero) {
    if ((s & BigInt.one) == BigInt.one) q = _pointAdd(q, pt);
    pt = _pointAdd(pt, pt);
    s >>= 1;
  }
  return q;
}

bool _pointEqual(_Pt p1, _Pt p2) {
  if (_mod(p1[0] * p2[2] - p2[0] * p1[2]) != BigInt.zero) return false;
  if (_mod(p1[1] * p2[2] - p2[1] * p1[2]) != BigInt.zero) return false;
  return true;
}

BigInt? _recoverX(BigInt y, int sign) {
  if (y >= _p) return null;
  final y2 = _mod(y * y);
  final x2 = _mod((y2 - BigInt.one) * _invMod(_d * y2 + BigInt.one));
  if (x2 == BigInt.zero) {
    return sign != 0 ? null : BigInt.zero;
  }
  var x = _powMod(x2, (_p + BigInt.from(3)) ~/ BigInt.from(8), _p);
  if (_mod(x * x - x2) != BigInt.zero) x = _mod(x * _sqrtM1);
  if (_mod(x * x - x2) != BigInt.zero) return null;
  if ((x & BigInt.one) != BigInt.from(sign)) x = _mod(-x);
  return x;
}

final BigInt _gy = _mod(BigInt.from(4) * _invMod(BigInt.from(5)));
final BigInt _gx = _recoverX(_gy, 0)!;
final _Pt _g = [_gx, _gy, BigInt.one, _mod(_gx * _gy)];

Uint8List _pointCompress(_Pt pt) {
  final zinv = _invMod(pt[2]);
  final x = _mod(pt[0] * zinv);
  final y = _mod(pt[1] * zinv);
  return bigToBytesLE(y | ((x & BigInt.one) << 255), 32);
}

_Pt? _pointDecompress(List<int> bytes) {
  if (bytes.length != 32) return null;
  var y = _bytesToBigLE(bytes);
  final sign = ((y >> 255) & BigInt.one).toInt();
  y &= (BigInt.one << 255) - BigInt.one;
  final x = _recoverX(y, sign);
  if (x == null) return null;
  return [x, y, BigInt.one, _mod(x * y)];
}

BigInt _sha512Mod(List<int> bytes) => _mod(_bytesToBigLE(c.sha512(bytes)), l);

class _Expanded {
  _Expanded(this.a, this.prefix);
  final BigInt a;
  final Uint8List prefix;
}

_Expanded _secretExpand(List<int> seed) {
  final s = c.toBytes(seed);
  if (s.length != 32) throw ArgumentError('ed25519 seed must be 32 bytes');
  final h = c.sha512(s);
  var a = _bytesToBigLE(h.sublist(0, 32));
  a &= (BigInt.one << 254) - BigInt.from(8);
  a |= (BigInt.one << 254);
  return _Expanded(a, h.sublist(32, 64));
}

/// 32-byte public key from a 32-byte secret seed.
Uint8List publicKey(List<int> seed) {
  final e = _secretExpand(seed);
  return _pointCompress(_pointMul(e.a, _g));
}

/// 64-byte signature over [message] with a 32-byte secret seed.
Uint8List sign(List<int> message, List<int> seed) {
  final msg = c.toBytes(message);
  final e = _secretExpand(seed);
  final aPub = _pointCompress(_pointMul(e.a, _g));
  final r = _sha512Mod(c.concatBytes([e.prefix, msg]));
  final rPt = _pointMul(r, _g);
  final rs = _pointCompress(rPt);
  final k = _sha512Mod(c.concatBytes([rs, aPub, msg]));
  final s = _mod(r + k * e.a, l);
  return c.concatBytes([rs, bigToBytesLE(s, 32)]);
}

/// Verify a 64-byte signature of [message] under a 32-byte public key.
bool verify(List<int> message, List<int> signature, List<int> pubKey) {
  final sig = c.toBytes(signature);
  final pub = c.toBytes(pubKey);
  if (sig.length != 64 || pub.length != 32) return false;
  final aPt = _pointDecompress(pub);
  if (aPt == null) return false;
  final rs = sig.sublist(0, 32);
  final rPt = _pointDecompress(rs);
  if (rPt == null) return false;
  final s = _bytesToBigLE(sig.sublist(32, 64));
  if (s >= l) return false;
  final msg = c.toBytes(message);
  final k = _sha512Mod(c.concatBytes([rs, pub, msg]));
  final sB = _pointMul(s, _g);
  final kA = _pointMul(k, aPt);
  return _pointEqual(sB, _pointAdd(rPt, kA));
}
