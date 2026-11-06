// chains/cardano-crypto.js — Icarus (CIP-3) master key + CIP-1852 BIP32-Ed25519
// (Khovratovich / "Ed25519-BIP32") hierarchical derivation for Cardano.
//
// This is NOT SLIP-0010. Cardano derives the master key from the BIP39 ENTROPY
// (the 16-32 raw entropy bytes, NOT the 64-byte seed):
//   mk = PBKDF2-HMAC-SHA512(password = "", salt = entropy, iters = 4096, dkLen = 96)
//   kL = mk[0:32]; kR = mk[32:64]; cc = mk[64:96]
//   clamp: kL[0] &= 0xF8; kL[31] &= 0x1F; kL[31] |= 0x40    (CIP-3)
//   A = scalarMulBase(kL)   (compressed 32-byte ed25519 public key)
//
// Child derivation (BIP32-Ed25519), index i, little-endian LE32(i):
//   hardened (i >= 2^31):
//     Z   = HMAC-SHA512(cc, 0x00 || kL || kR || LE32(i))
//     cc' = HMAC-SHA512(cc, 0x01 || kL || kR || LE32(i))[32:64]
//   soft:
//     Z   = HMAC-SHA512(cc, 0x02 || A  || LE32(i))
//     cc' = HMAC-SHA512(cc, 0x03 || A  || LE32(i))[32:64]
//   ZL = Z[0:28]; ZR = Z[32:64]
//   kL' = 8 * int_LE(ZL) + int_LE(kL)            (full 256-bit LE, NO mod L)
//   kR' = (int_LE(ZR) + int_LE(kR)) mod 2^256
//   A'  = scalarMulBase(kL')
//
// Path m/1852'/1815'/0'/role/idx — purpose/coinType/account are HARDENED,
// role and idx are SOFT. payment = role 0 idx 0; stake = role 2 idx 0.
//
// Signing with the resulting extended key uses Ed25519.signExtended (ed25519.js).
// Pinned byte-exactly by docs/cardano-vectors.json; cross-checked against
// @emurgo/cardano-serialization-lib-nodejs.
//
// Global `CardanoCrypto`; module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const ED = inNode ? require('../ed25519.js') : global.Ed25519;

  const HARDENED = 0x80000000;
  const TWO_256 = 1n << 256n;

  function le32(i) {
    const n = i >>> 0;
    return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }
  function intLE(bytes) { return ED.bytesToBigLE(C.toBytes(bytes)); }
  function toLE(x, len) { return ED.bigToBytesLE(x, len); }

  // node: { kL:Uint8Array(32), kR:Uint8Array(32), cc:Uint8Array(32), A:Uint8Array(32) }
  function makeNode(kL, kR, cc) {
    return { kL, kR, cc, A: ED.scalarMulBase(kL) };
  }

  // Icarus (CIP-3) master key from the BIP39 ENTROPY bytes (16..32 bytes).
  function icarusMasterKey(entropy) {
    const ent = C.toBytes(entropy);
    const mk = C.pbkdf2Sha512(new Uint8Array(0), ent, 4096, 96);
    const kL = mk.slice(0, 32);
    const kR = mk.slice(32, 64);
    const cc = mk.slice(64, 96);
    kL[0] &= 0xf8;
    kL[31] &= 0x1f;
    kL[31] |= 0x40;
    return makeNode(kL, kR, cc);
  }

  function deriveChild(node, index) {
    const i = index >>> 0;
    const hardened = i >= HARDENED;
    let Z, ccFull;
    if (hardened) {
      Z = C.hmacSha512(node.cc, C.concatBytes(Uint8Array.of(0x00), node.kL, node.kR, le32(i)));
      ccFull = C.hmacSha512(node.cc, C.concatBytes(Uint8Array.of(0x01), node.kL, node.kR, le32(i)));
    } else {
      Z = C.hmacSha512(node.cc, C.concatBytes(Uint8Array.of(0x02), node.A, le32(i)));
      ccFull = C.hmacSha512(node.cc, C.concatBytes(Uint8Array.of(0x03), node.A, le32(i)));
    }
    const ZL = Z.slice(0, 28);
    const ZR = Z.slice(32, 64);
    const kLp = 8n * intLE(ZL) + intLE(node.kL);             // NO mod L
    const kRp = (intLE(ZR) + intLE(node.kR)) % TWO_256;
    const kL = toLE(kLp, 32);
    const kR = toLE(kRp, 32);
    const cc = ccFull.slice(32, 64);
    return makeNode(kL, kR, cc);
  }

  // Parse "m/1852'/1815'/0'/0/0" -> [1852|H, 1815|H, 0|H, 0, 0].
  function parsePath(path) {
    const parts = String(path).split('/');
    if (parts[0] !== 'm') throw new Error("cardano path must start with 'm'");
    return parts.slice(1).map((p) => {
      const hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
      const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error('bad path segment: ' + p);
      return hardened ? ((n + HARDENED) >>> 0) : (n >>> 0);
    });
  }

  function derivePath(entropy, path) {
    let node = icarusMasterKey(entropy);
    for (const idx of parsePath(path)) node = deriveChild(node, idx);
    return node;
  }

  function derivePathFromMaster(masterNode, path) {
    let node = masterNode;
    for (const idx of parsePath(path)) node = deriveChild(node, idx);
    return node;
  }

  // Public key (32 bytes) of a node is node.A.
  function publicKey(node) { return node.A; }

  const API = {
    HARDENED,
    icarusMasterKey, deriveChild, parsePath, derivePath, derivePathFromMaster,
    publicKey, le32,
  };
  global.CardanoCrypto = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
