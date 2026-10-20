// address.js — address encoders for the secp256k1 chains:
//   • EVM checksummed hex (EIP-55)
//   • Bitcoin/Litecoin native SegWit v0 P2WPKH (bech32, BIP173)
//   • legacy Base58Check P2PKH (BTC/LTC/DOGE)
//   • WIF private-key import/export
// Global `Addr`; module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('./crypto-core.js') : global.BLKCrypto;
  const S = inNode ? require('./secp256k1.js') : global.Secp256k1;

  // ---- bech32 / bech32m (BIP173 / BIP350) ----------------------------------
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  function polymod(values) {
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }
  function hrpExpand(hrp) {
    const ret = [];
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
    ret.push(0);
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
    return ret;
  }
  function createChecksum(hrp, data, spec) {
    const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    const mod = polymod(values) ^ (spec === 'bech32m' ? 0x2bc830a3 : 1);
    const ret = [];
    for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 31);
    return ret;
  }
  function verifyChecksum(hrp, data, spec) {
    const c = polymod(hrpExpand(hrp).concat(data));
    return c === (spec === 'bech32m' ? 0x2bc830a3 : 1);
  }
  function convertBits(data, from, to, pad) {
    let acc = 0, bits = 0;
    const ret = [];
    const maxv = (1 << to) - 1;
    for (const value of data) {
      if (value < 0 || value >> from) return null;
      acc = (acc << from) | value;
      bits += from;
      while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); }
    }
    if (pad) { if (bits > 0) ret.push((acc << (to - bits)) & maxv); }
    else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
    return ret;
  }
  // Encode a native SegWit address (witver 0 = P2WPKH/P2WSH).
  function segwitEncode(hrp, witver, program) {
    const prog = C.toBytes(program);
    const spec = witver === 0 ? 'bech32' : 'bech32m';
    const data = [witver].concat(convertBits(Array.from(prog), 8, 5, true));
    const combined = data.concat(createChecksum(hrp, data, spec));
    let ret = hrp + '1';
    for (const d of combined) ret += CHARSET[d];
    return ret;
  }
  function segwitDecode(hrp, addr) {
    const lowered = addr.toLowerCase();
    if (!lowered.startsWith(hrp + '1')) throw new Error('wrong hrp');
    const data = [];
    const body = lowered.slice(hrp.length + 1);
    for (const ch of body) {
      const d = CHARSET.indexOf(ch);
      if (d < 0) throw new Error('bad bech32 char');
      data.push(d);
    }
    const witver = data[0];
    const spec = witver === 0 ? 'bech32' : 'bech32m';
    if (!verifyChecksum(hrp, data, spec)) throw new Error('bad bech32 checksum');
    const program = convertBits(data.slice(1, -6), 5, 8, false);
    if (!program) throw new Error('bad program');
    return { version: witver, program: Uint8Array.from(program) };
  }

  // ---- EVM (EIP-55 checksum) ----------------------------------------------
  function evmAddress(pubKeyBytes) {
    // pubKeyBytes: 33 (compressed) or 65 (uncompressed, 0x04|X|Y)
    let pub = C.toBytes(pubKeyBytes);
    if (pub.length === 33) pub = S.encodePoint(S.decodePoint(pub), false);
    const body = pub.slice(1); // drop 0x04
    const hash = C.keccak256(body);
    return toChecksumAddress('0x' + C.bytesToHex(hash.slice(-20)));
  }
  function toChecksumAddress(addr) {
    const a = addr.toLowerCase().replace(/^0x/, '');
    const hash = C.bytesToHex(C.keccak256(C.utf8(a)));
    let out = '0x';
    for (let i = 0; i < a.length; i++) {
      out += parseInt(hash[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
    }
    return out;
  }

  // ---- UTXO addresses ------------------------------------------------------
  // P2WPKH native segwit (BTC/LTC): hrp-dependent.
  function p2wpkh(pubKeyBytes, hrp) {
    const pub = C.toBytes(pubKeyBytes); // MUST be compressed (33 bytes)
    const h160 = C.hash160(pub);
    return segwitEncode(hrp, 0, h160);
  }
  // Legacy P2PKH base58check (BTC/LTC/DOGE): version byte per network.
  function p2pkh(pubKeyBytes, versionByte) {
    const pub = C.toBytes(pubKeyBytes);
    const h160 = C.hash160(pub);
    return C.base58checkEncode(C.concatBytes(Uint8Array.of(versionByte), h160));
  }

  // ---- WIF -----------------------------------------------------------------
  function toWIF(privBytes, versionByte = 0x80, compressed = true) {
    let payload = C.concatBytes(Uint8Array.of(versionByte), C.toBytes(privBytes));
    if (compressed) payload = C.concatBytes(payload, Uint8Array.of(0x01));
    return C.base58checkEncode(payload);
  }
  function fromWIF(wif) {
    const dec = C.base58checkDecode(wif);
    const compressed = dec.length === 34;
    return { version: dec[0], privateKey: dec.slice(1, 33), compressed };
  }

  const API = {
    segwitEncode, segwitDecode, convertBits,
    evmAddress, toChecksumAddress,
    p2wpkh, p2pkh, toWIF, fromWIF,
  };
  global.Addr = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
