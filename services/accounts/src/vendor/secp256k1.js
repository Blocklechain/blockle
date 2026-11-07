// secp256k1.js — the ECDSA curve used by EVM and BTC/LTC/DOGE. Pure BigInt.
// Provides: private->public key, point add (for BIP32 child derivation),
// deterministic ECDSA signing (RFC6979, low-S, with recovery id), and
// DER encoding. NOT post-quantum — this is secp256k1/ECDSA, same as Bitcoin
// and Ethereum. (BLOCK's post-quantum signing stays in blockle-wasm.)
//
// Global `Secp256k1`; also module.exports for the tests.
(function (global) {
  'use strict';
  const C = (typeof module !== 'undefined' && module.exports)
    ? require('./crypto-core.js')
    : global.BLKCrypto;

  const P  = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const N  = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
  const A  = 0n;
  const B  = 7n;

  function mod(a, m = P) { const r = a % m; return r >= 0n ? r : r + m; }
  function invMod(a, m = P) {
    a = mod(a, m);
    let [old_r, r] = [a, m];
    let [old_s, s] = [1n, 0n];
    while (r !== 0n) {
      const q = old_r / r;
      [old_r, r] = [r, old_r - q * r];
      [old_s, s] = [s, old_s - q * s];
    }
    return mod(old_s, m);
  }

  // Jacobian point ops would be faster, but affine is clear and fast enough.
  const ZERO = null; // point at infinity
  function pointAdd(p1, p2) {
    if (p1 === ZERO) return p2;
    if (p2 === ZERO) return p1;
    const [x1, y1] = p1, [x2, y2] = p2;
    if (x1 === x2 && mod(y1 + y2) === 0n) return ZERO;
    let m;
    if (x1 === x2 && y1 === y2) {
      m = mod((3n * x1 * x1 + A) * invMod(2n * y1));
    } else {
      m = mod((y2 - y1) * invMod(x2 - x1));
    }
    const x3 = mod(m * m - x1 - x2);
    const y3 = mod(m * (x1 - x3) - y1);
    return [x3, y3];
  }
  function pointMul(k, point) {
    k = mod(k, N);
    let result = ZERO;
    let addend = point;
    while (k > 0n) {
      if (k & 1n) result = pointAdd(result, addend);
      addend = pointAdd(addend, addend);
      k >>= 1n;
    }
    return result;
  }

  const G = [Gx, Gy];

  function bytesToBig(b) { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; }
  function bigTo32(x) {
    const out = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  }

  function isValidPrivate(d) { return d > 0n && d < N; }

  // 65-byte uncompressed (0x04 | X | Y) and 33-byte compressed (0x02/0x03 | X)
  function publicKey(privBytes, compressed = true) {
    const d = bytesToBig(C.toBytes(privBytes));
    if (!isValidPrivate(d)) throw new Error('invalid private key');
    const Q = pointMul(d, G);
    return encodePoint(Q, compressed);
  }
  function encodePoint(Q, compressed) {
    const [x, y] = Q;
    const xb = bigTo32(x);
    if (compressed) {
      const prefix = (y & 1n) === 0n ? 0x02 : 0x03;
      return C.concatBytes(Uint8Array.of(prefix), xb);
    }
    return C.concatBytes(Uint8Array.of(0x04), xb, bigTo32(y));
  }
  // decompress a 33-byte compressed pubkey to a point
  function decodePoint(pub) {
    const b = C.toBytes(pub);
    if (b[0] === 0x04) return [bytesToBig(b.slice(1, 33)), bytesToBig(b.slice(33, 65))];
    const x = bytesToBig(b.slice(1, 33));
    const ySq = mod(x * x * x + B);
    let y = powMod(ySq, (P + 1n) / 4n, P);
    if ((y & 1n) !== BigInt(b[0] & 1)) y = mod(-y);
    return [x, y];
  }
  function powMod(base, exp, m) {
    base = mod(base, m); let result = 1n;
    while (exp > 0n) { if (exp & 1n) result = mod(result * base, m); base = mod(base * base, m); exp >>= 1n; }
    return result;
  }

  // point add of two public keys (for BIP32: parentPub + tweak*G)
  function pointAddScalar(pubBytes, tweakBytes) {
    const Q = decodePoint(pubBytes);
    const t = bytesToBig(C.toBytes(tweakBytes));
    const R = pointAdd(Q, pointMul(t, G));
    if (R === ZERO) throw new Error('infinity');
    return encodePoint(R, true);
  }
  // scalar add mod N (for BIP32 private child: parentPriv + tweak)
  function privAdd(privBytes, tweakBytes) {
    const d = bytesToBig(C.toBytes(privBytes));
    const t = bytesToBig(C.toBytes(tweakBytes));
    const r = mod(d + t, N);
    if (r === 0n) throw new Error('zero key');
    return bigTo32(r);
  }

  // ---- RFC6979 deterministic ECDSA ----------------------------------------
  // msgHash: 32 bytes already hashed. Returns {r,s,recovery, der, compact}.
  function sign(msgHash, privBytes) {
    const h1 = C.toBytes(msgHash);
    const x = C.toBytes(privBytes);
    const d = bytesToBig(x);
    if (!isValidPrivate(d)) throw new Error('invalid private key');
    const z = bytesToBig(h1);

    // RFC6979 with HMAC-SHA256
    let v = new Uint8Array(32).fill(1);
    let k = new Uint8Array(32).fill(0);
    const x32 = bigTo32(d);
    const z32 = bigTo32(mod(z, N)); // bits2octets(h1)
    k = C.hmacSha256(k, C.concatBytes(v, Uint8Array.of(0x00), x32, z32));
    v = C.hmacSha256(k, v);
    k = C.hmacSha256(k, C.concatBytes(v, Uint8Array.of(0x01), x32, z32));
    v = C.hmacSha256(k, v);
    for (let iter = 0; iter < 1000; iter++) {
      v = C.hmacSha256(k, v);
      const kCand = bytesToBig(v);
      if (kCand > 0n && kCand < N) {
        const R = pointMul(kCand, G);
        const r = mod(R[0], N);
        if (r !== 0n) {
          let s = mod(invMod(kCand, N) * mod(z + r * d, N), N);
          let recovery = (R[1] & 1n) === 0n ? 0 : 1;
          if (R[0] >= N) recovery |= 2;
          // low-S (BIP62 / Ethereum)
          if (s > N / 2n) { s = N - s; recovery ^= 1; }
          return finalize(r, s, recovery);
        }
      }
      k = C.hmacSha256(k, C.concatBytes(v, Uint8Array.of(0x00)));
      v = C.hmacSha256(k, v);
    }
    throw new Error('sign failed');
  }
  function finalize(r, s, recovery) {
    const rb = bigTo32(r), sb = bigTo32(s);
    return {
      r, s, recovery,
      compact: C.concatBytes(rb, sb),
      rHex: C.bytesToHex(rb), sHex: C.bytesToHex(sb),
      der: derEncode(r, s),
    };
  }
  function derEncode(r, s) {
    const enc = (v) => {
      let b = bigTo32(v);
      let i = 0; while (i < b.length - 1 && b[i] === 0) i++;
      b = b.slice(i);
      if (b[0] & 0x80) b = C.concatBytes(Uint8Array.of(0x00), b);
      return b;
    };
    const rb = enc(r), sb = enc(s);
    const body = C.concatBytes(Uint8Array.of(0x02, rb.length), rb, Uint8Array.of(0x02, sb.length), sb);
    return C.concatBytes(Uint8Array.of(0x30, body.length), body);
  }

  // verify(msgHash, sig{r,s}, pubBytes) -> bool
  function verify(msgHash, sig, pubBytes) {
    const z = mod(bytesToBig(C.toBytes(msgHash)), N);
    const r = typeof sig.r === 'bigint' ? sig.r : bytesToBig(C.toBytes(sig.r));
    const s = typeof sig.s === 'bigint' ? sig.s : bytesToBig(C.toBytes(sig.s));
    if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
    const w = invMod(s, N);
    const u1 = mod(z * w, N);
    const u2 = mod(r * w, N);
    const Q = decodePoint(pubBytes);
    const R = pointAdd(pointMul(u1, G), pointMul(u2, Q));
    if (R === ZERO) return false;
    return mod(R[0], N) === r;
  }
  // recover public key (compressed) from msgHash + sig + recovery id
  function recover(msgHash, r, s, recovery, compressed = false) {
    const rBig = typeof r === 'bigint' ? r : bytesToBig(C.toBytes(r));
    const sBig = typeof s === 'bigint' ? s : bytesToBig(C.toBytes(s));
    const z = mod(bytesToBig(C.toBytes(msgHash)), N);
    const x = (recovery & 2) ? rBig + N : rBig;
    // point with this x
    const ySq = mod(x * x * x + B);
    let y = powMod(ySq, (P + 1n) / 4n, P);
    if ((y & 1n) !== BigInt(recovery & 1)) y = mod(-y);
    const R = [x, y];
    const rInv = invMod(rBig, N);
    // Q = rInv * (s*R - z*G)
    const sR = pointMul(sBig, R);
    const zG = pointMul(z, G);
    const Q = pointMul(rInv, pointAdd(sR, [zG[0], mod(-zG[1])]));
    return encodePoint(Q, compressed);
  }

  const API = {
    P, N, G,
    mod, invMod, pointAdd, pointMul, encodePoint, decodePoint, powMod,
    publicKey, pointAddScalar, privAdd, isValidPrivate,
    bytesToBig, bigTo32, sign, verify, recover, derEncode,
  };
  global.Secp256k1 = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
