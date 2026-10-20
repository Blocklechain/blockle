// ed25519.js — pure-JS Ed25519 (RFC 8032) signing + verification. This is the
// signature scheme Solana uses for account keys and transaction signatures.
//
// Why pure JS: WebCrypto has no Ed25519 in MV3 service workers reliably across
// browsers, and we never want a key to leave the extension. This is the RFC 8032
// reference construction (extended twisted-Edwards coordinates, SHA-512 from
// crypto-core.js), validated below against the RFC 8032 §7.1 test vectors.
//
// NOT post-quantum — Ed25519 is classical EC crypto (only BLOCK is PQ via ML-DSA).
//
// Global `Ed25519`; module.exports for the tests. Style matches secp256k1.js.
(function (global) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports)
    ? require('./crypto-core.js')
    : global.BLKCrypto;

  // Curve constants (Ed25519).
  const P = (1n << 255n) - 19n;
  const L = (1n << 252n) + 27742317777372353535851937790883648493n; // group order
  const D = mod(-121665n * invMod(121666n));
  const SQRT_M1 = powMod(2n, (P - 1n) / 4n, P); // sqrt(-1) mod p

  function mod(a, m = P) { const r = a % m; return r >= 0n ? r : r + m; }
  function powMod(base, exp, m) {
    base = mod(base, m); let result = 1n;
    while (exp > 0n) { if (exp & 1n) result = mod(result * base, m); base = mod(base * base, m); exp >>= 1n; }
    return result;
  }
  function invMod(a, m = P) { return powMod(mod(a, m), m - 2n, m); }

  // little-endian byte <-> BigInt helpers (Ed25519 is little-endian throughout)
  function bytesToBigLE(b) {
    let x = 0n;
    for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
    return x;
  }
  function bigToBytesLE(x, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  }

  // ---- extended twisted-Edwards point ops (RFC 8032 reference) -------------
  // A point is [X, Y, Z, T] with x = X/Z, y = Y/Z, x*y = T/Z.
  // The neutral element is (0, 1).
  const NEUTRAL = [0n, 1n, 1n, 0n];
  // This single addition formula is complete on Ed25519 (a = -1, d non-square),
  // so it is also used for doubling via pointAdd(P, P).
  function pointAdd(p1, p2) {
    const A = mod((p1[1] - p1[0]) * (p2[1] - p2[0]));
    const B = mod((p1[1] + p1[0]) * (p2[1] + p2[0]));
    const Cc = mod(2n * p1[3] * p2[3] * D);
    const Dd = mod(2n * p1[2] * p2[2]);
    const E = B - A, F = Dd - Cc, G = Dd + Cc, H = B + A;
    return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
  }
  function pointMul(s, point) {
    let q = NEUTRAL;
    let pt = point;
    s = mod(s, L);
    while (s > 0n) {
      if (s & 1n) q = pointAdd(q, pt);
      pt = pointAdd(pt, pt);
      s >>= 1n;
    }
    return q;
  }
  function pointEqual(p1, p2) {
    // x1/z1 == x2/z2 and y1/z1 == y2/z2
    if (mod(p1[0] * p2[2] - p2[0] * p1[2]) !== 0n) return false;
    if (mod(p1[1] * p2[2] - p2[1] * p1[2]) !== 0n) return false;
    return true;
  }

  function recoverX(y, sign) {
    if (y >= P) return null;
    const y2 = mod(y * y);
    const x2 = mod((y2 - 1n) * invMod(D * y2 + 1n));
    if (x2 === 0n) { return sign ? null : 0n; }
    let x = powMod(x2, (P + 3n) / 8n, P);
    if (mod(x * x - x2) !== 0n) x = mod(x * SQRT_M1);
    if (mod(x * x - x2) !== 0n) return null;
    if ((x & 1n) !== BigInt(sign)) x = mod(-x);
    return x;
  }

  // base point G
  const GY = mod(4n * invMod(5n));
  const GX = recoverX(GY, 0);
  const G = [GX, GY, 1n, mod(GX * GY)];

  function pointCompress(pt) {
    const zinv = invMod(pt[2]);
    const x = mod(pt[0] * zinv);
    const y = mod(pt[1] * zinv);
    return bigToBytesLE(y | ((x & 1n) << 255n), 32);
  }
  function pointDecompress(bytes) {
    if (bytes.length !== 32) return null;
    let y = bytesToBigLE(bytes);
    const sign = Number((y >> 255n) & 1n);
    y &= (1n << 255n) - 1n;
    const x = recoverX(y, sign);
    if (x === null) return null;
    return [x, y, 1n, mod(x * y)];
  }

  function sha512Mod(bytes) { return mod(bytesToBigLE(C.sha512(bytes)), L); }

  // Expand a 32-byte secret seed into (scalar a, prefix) per RFC 8032.
  function secretExpand(seed) {
    const s = C.toBytes(seed);
    if (s.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
    const h = C.sha512(s);
    let a = bytesToBigLE(h.slice(0, 32));
    a &= (1n << 254n) - 8n;   // clear low 3 bits
    a |= (1n << 254n);        // set bit 254, clear bit 255
    return { a, prefix: h.slice(32, 64) };
  }

  // Public key (32 bytes) from a 32-byte secret seed.
  function publicKey(seed) {
    const { a } = secretExpand(seed);
    return pointCompress(pointMul(a, G));
  }

  // Sign message (bytes) with a 32-byte secret seed → 64-byte signature.
  function sign(message, seed) {
    const msg = C.toBytes(message);
    const { a, prefix } = secretExpand(seed);
    const A = pointCompress(pointMul(a, G));
    const r = sha512Mod(C.concatBytes(prefix, msg));
    const R = pointMul(r, G);
    const Rs = pointCompress(R);
    const k = sha512Mod(C.concatBytes(Rs, A, msg));
    const S = mod(r + k * a, L);
    return C.concatBytes(Rs, bigToBytesLE(S, 32));
  }

  // Verify a 64-byte signature of message under a 32-byte public key.
  function verify(message, signature, pubKey) {
    const sig = C.toBytes(signature);
    const pub = C.toBytes(pubKey);
    if (sig.length !== 64 || pub.length !== 32) return false;
    const A = pointDecompress(pub);
    if (!A) return false;
    const Rs = sig.slice(0, 32);
    const R = pointDecompress(Rs);
    if (!R) return false;
    const S = bytesToBigLE(sig.slice(32, 64));
    if (S >= L) return false;
    const msg = C.toBytes(message);
    const k = sha512Mod(C.concatBytes(Rs, pub, msg));
    const sB = pointMul(S, G);
    const kA = pointMul(k, A);
    return pointEqual(sB, pointAdd(R, kA));
  }

  const API = {
    P, L, publicKey, sign, verify,
    // exposed for the Solana adapter / tests:
    pointMul, pointAdd, pointCompress, pointDecompress, G,
    bytesToBigLE, bigToBytesLE, secretExpand,
  };
  global.Ed25519 = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
