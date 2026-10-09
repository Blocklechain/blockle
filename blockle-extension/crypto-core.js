// crypto-core.js — pure-JS crypto primitives the multi-chain layer needs that
// WebCrypto does NOT provide: SHA-256/512 + HMAC (sync, for RFC6979), RIPEMD-160,
// Keccak-256, plus hex / base58check / RLP helpers.
//
// Why pure JS: WebCrypto has no secp256k1, no keccak256, no ripemd160, and its
// HMAC/PBKDF2 are async — but RFC6979 deterministic ECDSA needs a *synchronous*
// HMAC inside its loop. These are small, well-known reference algorithms.
//
// Works in the extension (global `BLKCrypto`) and under Node (module.exports),
// so the unit tests can require it directly.
(function (global) {
  'use strict';

  // ---- byte / hex helpers --------------------------------------------------
  function toBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (Array.isArray(x)) return Uint8Array.from(x);
    if (typeof x === 'string') return hexToBytes(x);
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    throw new Error('toBytes: unsupported');
  }
  function hexToBytes(hex) {
    let h = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (h.length % 2) h = '0' + h;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToHex(bytes) {
    const b = toBytes(bytes);
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }
  function concatBytes(...arrs) {
    let len = 0;
    for (const a of arrs) len += a.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  function utf8(str) { return new TextEncoder().encode(str); }

  // ---- SHA-256 (FIPS 180-4) ------------------------------------------------
  const K256 = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(msg) {
    const m = toBytes(msg);
    const l = m.length;
    const withOne = l + 1;
    const k = (56 - (withOne % 64) + 64) % 64;
    const total = withOne + k + 8;
    const buf = new Uint8Array(total);
    buf.set(m);
    buf[l] = 0x80;
    const bitLen = l * 8;
    // 64-bit big-endian length (high 32 assumed 0 for our sizes)
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 4, bitLen >>> 0, false);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
        const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
      }
      let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
        const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h=g; g=f; f=e; e=(d + t1)|0; d=c; c=b; b=a; a=(t1 + t2)|0;
      }
      H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
      H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i] >>> 0, false);
    return out;
  }

  // ---- SHA-512 (FIPS 180-4), BigInt-free using 32-bit hi/lo words ----------
  // SHA-512 round constants (64-bit) as [hi,lo] pairs.
  const K512 = [
    [0x428a2f98,0xd728ae22],[0x71374491,0x23ef65cd],[0xb5c0fbcf,0xec4d3b2f],[0xe9b5dba5,0x8189dbbc],
    [0x3956c25b,0xf348b538],[0x59f111f1,0xb605d019],[0x923f82a4,0xaf194f9b],[0xab1c5ed5,0xda6d8118],
    [0xd807aa98,0xa3030242],[0x12835b01,0x45706fbe],[0x243185be,0x4ee4b28c],[0x550c7dc3,0xd5ffb4e2],
    [0x72be5d74,0xf27b896f],[0x80deb1fe,0x3b1696b1],[0x9bdc06a7,0x25c71235],[0xc19bf174,0xcf692694],
    [0xe49b69c1,0x9ef14ad2],[0xefbe4786,0x384f25e3],[0x0fc19dc6,0x8b8cd5b5],[0x240ca1cc,0x77ac9c65],
    [0x2de92c6f,0x592b0275],[0x4a7484aa,0x6ea6e483],[0x5cb0a9dc,0xbd41fbd4],[0x76f988da,0x831153b5],
    [0x983e5152,0xee66dfab],[0xa831c66d,0x2db43210],[0xb00327c8,0x98fb213f],[0xbf597fc7,0xbeef0ee4],
    [0xc6e00bf3,0x3da88fc2],[0xd5a79147,0x930aa725],[0x06ca6351,0xe003826f],[0x14292967,0x0a0e6e70],
    [0x27b70a85,0x46d22ffc],[0x2e1b2138,0x5c26c926],[0x4d2c6dfc,0x5ac42aed],[0x53380d13,0x9d95b3df],
    [0x650a7354,0x8baf63de],[0x766a0abb,0x3c77b2a8],[0x81c2c92e,0x47edaee6],[0x92722c85,0x1482353b],
    [0xa2bfe8a1,0x4cf10364],[0xa81a664b,0xbc423001],[0xc24b8b70,0xd0f89791],[0xc76c51a3,0x0654be30],
    [0xd192e819,0xd6ef5218],[0xd6990624,0x5565a910],[0xf40e3585,0x5771202a],[0x106aa070,0x32bbd1b8],
    [0x19a4c116,0xb8d2d0c8],[0x1e376c08,0x5141ab53],[0x2748774c,0xdf8eeb99],[0x34b0bcb5,0xe19b48a8],
    [0x391c0cb3,0xc5c95a63],[0x4ed8aa4a,0xe3418acb],[0x5b9cca4f,0x7763e373],[0x682e6ff3,0xd6b2b8a3],
    [0x748f82ee,0x5defb2fc],[0x78a5636f,0x43172f60],[0x84c87814,0xa1f0ab72],[0x8cc70208,0x1a6439ec],
    [0x90befffa,0x23631e28],[0xa4506ceb,0xde82bde9],[0xbef9a3f7,0xb2c67915],[0xc67178f2,0xe372532b],
    [0xca273ece,0xea26619c],[0xd186b8c7,0x21c0c207],[0xeada7dd6,0xcde0eb1e],[0xf57d4f7f,0xee6ed178],
    [0x06f067aa,0x72176fba],[0x0a637dc5,0xa2c898a6],[0x113f9804,0xbef90dae],[0x1b710b35,0x131c471b],
    [0x28db77f5,0x23047d84],[0x32caab7b,0x40c72493],[0x3c9ebe0a,0x15c9bebc],[0x431d67c4,0x9c100d4c],
    [0x4cc5d4be,0xcb3e42b6],[0x597f299c,0xfc657e2a],[0x5fcb6fab,0x3ad6faec],[0x6c44198c,0x4a475817]];

  function sha512(msg) {
    const m = toBytes(msg);
    const l = m.length;
    const withOne = l + 1;
    const k = (112 - (withOne % 128) + 128) % 128;
    const total = withOne + k + 16;
    const buf = new Uint8Array(total);
    buf.set(m); buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = l * 8;
    dv.setUint32(total - 4, bitLen >>> 0, false);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
    // H0..H7 as [hi,lo]
    const H = [
      [0x6a09e667,0xf3bcc908],[0xbb67ae85,0x84caa73b],[0x3c6ef372,0xfe94f82b],[0xa54ff53a,0x5f1d36f1],
      [0x510e527f,0xade682d1],[0x9b05688c,0x2b3e6c1f],[0x1f83d9ab,0xfb41bd6b],[0x5be0cd19,0x137e2179]];
    const w = new Array(80);
    // 64-bit helpers on [hi,lo]
    function add(a, b) {
      const lo = (a[1] >>> 0) + (b[1] >>> 0);
      const hi = (a[0] >>> 0) + (b[0] >>> 0) + (lo > 0xffffffff ? 1 : 0);
      return [hi >>> 0, lo >>> 0];
    }
    function xor(a, b) { return [(a[0]^b[0])>>>0, (a[1]^b[1])>>>0]; }
    function and(a, b) { return [(a[0]&b[0])>>>0, (a[1]&b[1])>>>0]; }
    function not(a) { return [(~a[0])>>>0, (~a[1])>>>0]; }
    function shr(a, n) {
      if (n === 0) return [a[0], a[1]];
      if (n < 32) return [a[0] >>> n, ((a[1] >>> n) | (a[0] << (32 - n))) >>> 0];
      return [0, (a[0] >>> (n - 32)) >>> 0];
    }
    function rotr64(a, n) {
      n %= 64;
      if (n === 0) return [a[0], a[1]];
      if (n < 32) {
        return [((a[0] >>> n) | (a[1] << (32 - n))) >>> 0, ((a[1] >>> n) | (a[0] << (32 - n))) >>> 0];
      }
      const m2 = n - 32;
      if (m2 === 0) return [a[1], a[0]];
      return [((a[1] >>> m2) | (a[0] << (32 - m2))) >>> 0, ((a[0] >>> m2) | (a[1] << (32 - m2))) >>> 0];
    }
    for (let off = 0; off < total; off += 128) {
      for (let i = 0; i < 16; i++) w[i] = [dv.getUint32(off + i*8, false), dv.getUint32(off + i*8 + 4, false)];
      for (let i = 16; i < 80; i++) {
        const s0 = xor(xor(rotr64(w[i-15],1), rotr64(w[i-15],8)), shr(w[i-15],7));
        const s1 = xor(xor(rotr64(w[i-2],19), rotr64(w[i-2],61)), shr(w[i-2],6));
        w[i] = add(add(add(w[i-16], s0), w[i-7]), s1);
      }
      let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for (let i = 0; i < 80; i++) {
        const S1 = xor(xor(rotr64(e,14), rotr64(e,18)), rotr64(e,41));
        const ch = xor(and(e,f), and(not(e),g));
        const t1 = add(add(add(add(h, S1), ch), K512[i]), w[i]);
        const S0 = xor(xor(rotr64(a,28), rotr64(a,34)), rotr64(a,39));
        const maj = xor(xor(and(a,b), and(a,c)), and(b,c));
        const t2 = add(S0, maj);
        h=g; g=f; f=e; e=add(d,t1); d=c; c=b; b=a; a=add(t1,t2);
      }
      H[0]=add(H[0],a); H[1]=add(H[1],b); H[2]=add(H[2],c); H[3]=add(H[3],d);
      H[4]=add(H[4],e); H[5]=add(H[5],f); H[6]=add(H[6],g); H[7]=add(H[7],h);
    }
    const out = new Uint8Array(64);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) { odv.setUint32(i*8, H[i][0] >>> 0, false); odv.setUint32(i*8+4, H[i][1] >>> 0, false); }
    return out;
  }

  // ---- HMAC ----------------------------------------------------------------
  function hmac(hashFn, blockSize, key, msg) {
    let k = toBytes(key);
    if (k.length > blockSize) k = hashFn(k);
    const pad = new Uint8Array(blockSize);
    pad.set(k);
    const ipad = new Uint8Array(blockSize), opad = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) { ipad[i] = pad[i] ^ 0x36; opad[i] = pad[i] ^ 0x5c; }
    const inner = hashFn(concatBytes(ipad, toBytes(msg)));
    return hashFn(concatBytes(opad, inner));
  }
  function hmacSha256(key, msg) { return hmac(sha256, 64, key, msg); }
  function hmacSha512(key, msg) { return hmac(sha512, 128, key, msg); }

  // ---- PBKDF2-HMAC-SHA512 (for BIP39 seed) ---------------------------------
  function pbkdf2Sha512(password, salt, iterations, dkLen) {
    const pw = toBytes(password);
    const s = toBytes(salt);
    const hLen = 64;
    const blocks = Math.ceil(dkLen / hLen);
    const out = new Uint8Array(blocks * hLen);
    const block = new Uint8Array(s.length + 4);
    block.set(s);
    for (let i = 1; i <= blocks; i++) {
      const dv = new DataView(block.buffer);
      dv.setUint32(s.length, i, false);
      let u = hmacSha512(pw, block);
      const t = u.slice();
      for (let j = 1; j < iterations; j++) {
        u = hmacSha512(pw, u);
        for (let k = 0; k < hLen; k++) t[k] ^= u[k];
      }
      out.set(t, (i - 1) * hLen);
    }
    return out.slice(0, dkLen);
  }

  // ---- RIPEMD-160 ----------------------------------------------------------
  function ripemd160(msg) {
    const data = toBytes(msg);
    const rl = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
      7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,
      3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,
      1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,
      4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
    const rr = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,
      6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,
      15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,
      8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,
      12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
    const sl = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,
      7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,
      11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,
      11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,
      9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
    const sr = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,
      9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,
      9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,
      15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,
      8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
    const kl = [0x00000000,0x5a827999,0x6ed9eba1,0x8f1bbcdc,0xa953fd4e];
    const kr = [0x50a28be6,0x5c4dd124,0x6d703ef3,0x7a6d76e9,0x00000000];
    const rol = (x,n) => ((x << n) | (x >>> (32 - n))) >>> 0;
    const f = (j,x,y,z) =>
      j < 16 ? (x ^ y ^ z) :
      j < 32 ? ((x & y) | (~x & z)) :
      j < 48 ? ((x | ~y) ^ z) :
      j < 64 ? ((x & z) | (y & ~z)) :
               (x ^ (y | ~z));
    const l = data.length;
    const withOne = l + 1;
    const k = (56 - (withOne % 64) + 64) % 64;
    const total = withOne + k + 8;
    const buf = new Uint8Array(total);
    buf.set(data); buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, (l * 8) >>> 0, true);
    dv.setUint32(total - 4, Math.floor((l * 8) / 0x100000000) >>> 0, true);
    let h0=0x67452301,h1=0xefcdab89,h2=0x98badcfe,h3=0x10325476,h4=0xc3d2e1f0;
    for (let off = 0; off < total; off += 64) {
      const x = new Uint32Array(16);
      for (let i = 0; i < 16; i++) x[i] = dv.getUint32(off + i*4, true);
      let al=h0,bl=h1,cl=h2,dl=h3,el=h4;
      let ar=h0,br=h1,cr=h2,dr=h3,er=h4;
      for (let j = 0; j < 80; j++) {
        const kj = (j/16)|0;
        let t = (al + f(j,bl,cl,dl) + x[rl[j]] + kl[kj]) >>> 0;
        t = (rol(t, sl[j]) + el) >>> 0;
        al=el; el=dl; dl=rol(cl,10); cl=bl; bl=t;
        const kj2 = (j/16)|0;
        let u = (ar + f(79-j,br,cr,dr) + x[rr[j]] + kr[kj2]) >>> 0;
        u = (rol(u, sr[j]) + er) >>> 0;
        ar=er; er=dr; dr=rol(cr,10); cr=br; br=u;
      }
      const t2 = (h1 + cl + dr) >>> 0;
      h1 = (h2 + dl + er) >>> 0;
      h2 = (h3 + el + ar) >>> 0;
      h3 = (h4 + al + br) >>> 0;
      h4 = (h0 + bl + cr) >>> 0;
      h0 = t2;
    }
    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    odv.setUint32(0,h0,true); odv.setUint32(4,h1,true); odv.setUint32(8,h2,true);
    odv.setUint32(12,h3,true); odv.setUint32(16,h4,true);
    return out;
  }

  // ---- Keccak-256 (pre-NIST padding, as used by Ethereum) ------------------
  // 64-bit lane arithmetic via [hi,lo] pairs.
  const KECCAK_RC = [
    [0x00000000,0x00000001],[0x00000000,0x00008082],[0x80000000,0x0000808a],[0x80000000,0x80008000],
    [0x00000000,0x0000808b],[0x00000000,0x80000001],[0x80000000,0x80008081],[0x80000000,0x00008009],
    [0x00000000,0x0000008a],[0x00000000,0x00000088],[0x00000000,0x80008009],[0x00000000,0x8000000a],
    [0x00000000,0x8000808b],[0x80000000,0x0000008b],[0x80000000,0x00008089],[0x80000000,0x00008003],
    [0x80000000,0x00008002],[0x80000000,0x00000080],[0x00000000,0x0000800a],[0x80000000,0x8000000a],
    [0x80000000,0x80008081],[0x80000000,0x00008080],[0x00000000,0x80000001],[0x80000000,0x80008008]];
  const KECCAK_ROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
  function keccak256(msg) {
    const rate = 136; // 1088 bits for keccak-256
    const data = toBytes(msg);
    // state: 25 lanes of [hi,lo]
    const s = [];
    for (let i = 0; i < 25; i++) s.push([0, 0]);
    function rotl(lane, n) {
      n %= 64;
      if (n === 0) return [lane[0], lane[1]];
      if (n < 32) return [((lane[0] << n) | (lane[1] >>> (32 - n))) >>> 0, ((lane[1] << n) | (lane[0] >>> (32 - n))) >>> 0];
      const m2 = n - 32;
      if (m2 === 0) return [lane[1], lane[0]];
      return [((lane[1] << m2) | (lane[0] >>> (32 - m2))) >>> 0, ((lane[0] << m2) | (lane[1] >>> (32 - m2))) >>> 0];
    }
    function keccakF() {
      for (let round = 0; round < 24; round++) {
        const C = [];
        for (let x = 0; x < 5; x++) {
          let hi = s[x][0], lo = s[x][1];
          for (let y = 1; y < 5; y++) { hi ^= s[x + 5*y][0]; lo ^= s[x + 5*y][1]; }
          C[x] = [hi >>> 0, lo >>> 0];
        }
        const D = [];
        for (let x = 0; x < 5; x++) {
          const r = rotl(C[(x+1)%5], 1);
          D[x] = [(C[(x+4)%5][0] ^ r[0]) >>> 0, (C[(x+4)%5][1] ^ r[1]) >>> 0];
        }
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
          s[x + 5*y][0] ^= D[x][0]; s[x + 5*y][1] ^= D[x][1];
        }
        // rho + pi
        const B = [];
        for (let i = 0; i < 25; i++) B.push([0,0]);
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
          const idx = x + 5*y;
          const nx = y;
          const ny = (2*x + 3*y) % 5;
          B[nx + 5*ny] = rotl(s[idx], KECCAK_ROT[idx]);
        }
        // chi
        for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
          const i = x + 5*y;
          const b0 = B[i], b1 = B[((x+1)%5) + 5*y], b2 = B[((x+2)%5) + 5*y];
          s[i][0] = (b0[0] ^ ((~b1[0]) & b2[0])) >>> 0;
          s[i][1] = (b0[1] ^ ((~b1[1]) & b2[1])) >>> 0;
        }
        // iota
        s[0][0] = (s[0][0] ^ KECCAK_RC[round][0]) >>> 0;
        s[0][1] = (s[0][1] ^ KECCAK_RC[round][1]) >>> 0;
      }
    }
    // absorb
    const padded = [];
    for (let i = 0; i < data.length; i++) padded.push(data[i]);
    // keccak padding: 0x01 ... 0x80 (NOT the 0x06 SHA3 pad)
    const q = rate - (padded.length % rate);
    if (q === 1) { padded.push(0x81); }
    else { padded.push(0x01); for (let i = 0; i < q - 2; i++) padded.push(0x00); padded.push(0x80); }
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate; i += 8) {
        const lane = (off + i) / 8 | 0;
        const laneIdx = (i / 8) | 0;
        const lo = (padded[off+i] | (padded[off+i+1]<<8) | (padded[off+i+2]<<16) | (padded[off+i+3]<<24)) >>> 0;
        const hi = (padded[off+i+4] | (padded[off+i+5]<<8) | (padded[off+i+6]<<16) | (padded[off+i+7]<<24)) >>> 0;
        s[laneIdx][0] = (s[laneIdx][0] ^ hi) >>> 0;
        s[laneIdx][1] = (s[laneIdx][1] ^ lo) >>> 0;
      }
      keccakF();
    }
    // squeeze 32 bytes
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 8) {
      const laneIdx = (i / 8) | 0;
      const lo = s[laneIdx][1], hi = s[laneIdx][0];
      out[i]   = lo & 0xff; out[i+1] = (lo>>>8)&0xff; out[i+2] = (lo>>>16)&0xff; out[i+3] = (lo>>>24)&0xff;
      out[i+4] = hi & 0xff; out[i+5] = (hi>>>8)&0xff; out[i+6] = (hi>>>16)&0xff; out[i+7] = (hi>>>24)&0xff;
    }
    return out;
  }

  function hash256(msg) { return sha256(sha256(msg)); }         // double SHA-256
  function hash160(msg) { return ripemd160(sha256(msg)); }      // RIPEMD160(SHA256)

  // ---- Base58 / Base58Check ------------------------------------------------
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58encode(bytes) {
    const b = toBytes(bytes);
    let zeros = 0;
    while (zeros < b.length && b[zeros] === 0) zeros++;
    // big-endian base conversion
    const digits = [0];
    for (let i = zeros; i < b.length; i++) {
      let carry = b[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let str = '';
    for (let i = 0; i < zeros; i++) str += '1';
    for (let i = digits.length - 1; i >= 0; i--) str += B58[digits[i]];
    return str;
  }
  function base58decode(str) {
    const bytes = [0];
    for (const ch of str) {
      const val = B58.indexOf(ch);
      if (val < 0) throw new Error('invalid base58 char');
      let carry = val;
      for (let j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    let zeros = 0;
    for (const ch of str) { if (ch === '1') zeros++; else break; }
    const out = new Uint8Array(zeros + bytes.length);
    for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
    return out;
  }
  function base58checkEncode(payload) {
    const b = toBytes(payload);
    const checksum = hash256(b).slice(0, 4);
    return base58encode(concatBytes(b, checksum));
  }
  function base58checkDecode(str) {
    const full = base58decode(str);
    const payload = full.slice(0, -4);
    const checksum = full.slice(-4);
    const expect = hash256(payload).slice(0, 4);
    for (let i = 0; i < 4; i++) if (checksum[i] !== expect[i]) throw new Error('bad base58check checksum');
    return payload;
  }

  // ---- RLP (Ethereum) ------------------------------------------------------
  function rlpEncodeLength(len, offset) {
    if (len < 56) return Uint8Array.of(len + offset);
    const hex = len.toString(16);
    const lenBytes = hexToBytes(hex.length % 2 ? '0' + hex : hex);
    return concatBytes(Uint8Array.of(lenBytes.length + offset + 55), lenBytes);
  }
  function rlpEncode(input) {
    if (Array.isArray(input)) {
      let out = new Uint8Array(0);
      for (const item of input) out = concatBytes(out, rlpEncode(item));
      return concatBytes(rlpEncodeLength(out.length, 0xc0), out);
    }
    const b = toBytes(input);
    if (b.length === 1 && b[0] < 0x80) return b;
    return concatBytes(rlpEncodeLength(b.length, 0x80), b);
  }

  const API = {
    toBytes, hexToBytes, bytesToHex, concatBytes, utf8,
    sha256, sha512, hmacSha256, hmacSha512, pbkdf2Sha512,
    ripemd160, keccak256, hash256, hash160,
    base58encode, base58decode, base58checkEncode, base58checkDecode,
    rlpEncode,
  };
  global.BLKCrypto = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
