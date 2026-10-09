// hd.js — BIP39 mnemonic + BIP32 hierarchical-deterministic derivation for the
// secp256k1 chains (EVM + BTC/LTC/DOGE). The BIP39 seed is the HD root stored
// in the vault; each chain derives its account via a BIP44/BIP84 path.
//
// Pure JS, built on crypto-core.js + secp256k1.js. Global `HD`; module.exports
// for the tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('./crypto-core.js') : global.BLKCrypto;
  const S = inNode ? require('./secp256k1.js') : global.Secp256k1;
  const WORDS = inNode ? require('./bip39-wordlist.js') : global.BIP39_WORDLIST;

  // ---- BIP39 ---------------------------------------------------------------
  function entropyToMnemonic(entropy) {
    const ent = C.toBytes(entropy);
    if (ent.length % 4 !== 0 || ent.length < 16 || ent.length > 32) throw new Error('bad entropy length');
    const hash = C.sha256(ent);
    const csBits = (ent.length * 8) / 32;
    // bit string of entropy + checksum
    let bits = '';
    for (const b of ent) bits += b.toString(2).padStart(8, '0');
    let csByteBits = '';
    for (const b of hash) csByteBits += b.toString(2).padStart(8, '0');
    bits += csByteBits.slice(0, csBits);
    const words = [];
    for (let i = 0; i < bits.length; i += 11) words.push(WORDS[parseInt(bits.slice(i, i + 11), 2)]);
    return words.join(' ');
  }
  function generateMnemonic(strength = 128) {
    if (strength % 32 !== 0) throw new Error('strength must be multiple of 32');
    const ent = crypto.getRandomValues(new Uint8Array(strength / 8));
    return entropyToMnemonic(ent);
  }
  function mnemonicToEntropy(mnemonic) {
    const words = mnemonic.normalize('NFKD').trim().split(/\s+/);
    if (![12, 15, 18, 21, 24].includes(words.length)) throw new Error('bad mnemonic word count');
    let bits = '';
    for (const w of words) {
      const idx = WORDS.indexOf(w);
      if (idx < 0) throw new Error('unknown word: ' + w);
      bits += idx.toString(2).padStart(11, '0');
    }
    const csBits = words.length / 3;
    const entBits = bits.length - csBits;
    const entropy = new Uint8Array(entBits / 8);
    for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    // verify checksum
    const hash = C.sha256(entropy);
    let csCheck = '';
    for (const b of hash) csCheck += b.toString(2).padStart(8, '0');
    if (bits.slice(entBits) !== csCheck.slice(0, csBits)) throw new Error('invalid mnemonic checksum');
    return entropy;
  }
  function validateMnemonic(mnemonic) {
    try { mnemonicToEntropy(mnemonic); return true; } catch { return false; }
  }
  function mnemonicToSeed(mnemonic, passphrase = '') {
    const mn = C.utf8(mnemonic.normalize('NFKD'));
    const salt = C.utf8(('mnemonic' + passphrase).normalize('NFKD'));
    return C.pbkdf2Sha512(mn, salt, 2048, 64);
  }

  // ---- BIP32 ---------------------------------------------------------------
  const HARDENED = 0x80000000;
  // node: { privateKey:Uint8Array|null, publicKey:Uint8Array(33), chainCode:Uint8Array(32), depth, index }
  function masterFromSeed(seed) {
    const I = C.hmacSha512(C.utf8('Bitcoin seed'), C.toBytes(seed));
    const IL = I.slice(0, 32), IR = I.slice(32);
    const d = S.bytesToBig(IL);
    if (d === 0n || !S.isValidPrivate(d)) throw new Error('invalid master key');
    return {
      privateKey: IL,
      publicKey: S.publicKey(IL, true),
      chainCode: IR,
      depth: 0,
      index: 0,
      parentFingerprint: new Uint8Array(4),
    };
  }
  function fingerprint(node) { return C.hash160(node.publicKey).slice(0, 4); }
  function ser32(i) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, i >>> 0, false);
    return b;
  }
  function deriveChild(node, index) {
    const hardened = index >= HARDENED;
    let data;
    if (hardened) {
      if (!node.privateKey) throw new Error('cannot derive hardened from public node');
      data = C.concatBytes(Uint8Array.of(0x00), node.privateKey, ser32(index));
    } else {
      data = C.concatBytes(node.publicKey, ser32(index));
    }
    const I = C.hmacSha512(node.chainCode, data);
    const IL = I.slice(0, 32), IR = I.slice(32);
    if (S.bytesToBig(IL) >= S.N) return deriveChild(node, index + 1); // invalid, skip
    if (node.privateKey) {
      let childPriv;
      try { childPriv = S.privAdd(node.privateKey, IL); }
      catch { return deriveChild(node, index + 1); }
      return {
        privateKey: childPriv,
        publicKey: S.publicKey(childPriv, true),
        chainCode: IR,
        depth: node.depth + 1,
        index,
        parentFingerprint: fingerprint(node),
      };
    } else {
      let childPub;
      try { childPub = S.pointAddScalar(node.publicKey, IL); }
      catch { return deriveChild(node, index + 1); }
      return { privateKey: null, publicKey: childPub, chainCode: IR, depth: node.depth + 1, index, parentFingerprint: fingerprint(node) };
    }
  }
  function parsePath(path) {
    const parts = path.split('/');
    if (parts[0] !== 'm') throw new Error("path must start with 'm'");
    return parts.slice(1).map((p) => {
      const hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
      const n = parseInt(hardened ? p.slice(0, -1) : p, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error('bad path segment: ' + p);
      return hardened ? (n + HARDENED) >>> 0 : n;
    });
  }
  function derivePath(seedOrNode, path) {
    let node = (seedOrNode && seedOrNode.chainCode) ? seedOrNode : masterFromSeed(seedOrNode);
    for (const index of parsePath(path)) node = deriveChild(node, index);
    return node;
  }

  // xprv/xpub serialization (mainnet version bytes) — handy for export/debug.
  function serialize(node, pub, versionHex = pub ? '0488b21e' : '0488ade4') {
    const version = C.hexToBytes(versionHex);
    const depth = Uint8Array.of(node.depth & 0xff);
    const parentFp = node.parentFingerprint || new Uint8Array(4);
    const childIndex = ser32(node.index);
    const key = pub ? node.publicKey : C.concatBytes(Uint8Array.of(0x00), node.privateKey);
    return C.base58checkEncode(C.concatBytes(version, depth, parentFp, childIndex, node.chainCode, key));
  }

  const API = {
    entropyToMnemonic, generateMnemonic, mnemonicToEntropy, validateMnemonic, mnemonicToSeed,
    masterFromSeed, deriveChild, derivePath, parsePath, serialize, HARDENED,
  };
  global.HD = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
