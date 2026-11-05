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

  // ---- CashAddr (Bitcoin Cash) --------------------------------------------
  // NOT bech32: a DIFFERENT 40-bit BCH polymod (own generator, 5 rounds over
  // 64-bit state). Reuses the shared base32 CHARSET + convertBits only.
  const CASH_GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  function cashPolymod(values) {
    let chk = 1n;
    for (const v of values) {
      const top = chk >> 35n;
      chk = ((chk & 0x07ffffffffn) << 5n) ^ BigInt(v);
      for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) chk ^= CASH_GEN[i];
    }
    return chk ^ 1n;
  }
  function cashPrefixExpand(prefix) {
    const ret = [];
    for (let i = 0; i < prefix.length; i++) ret.push(prefix.charCodeAt(i) & 0x1f);
    ret.push(0);
    return ret;
  }
  const CASH_SIZEBITS = { 20: 0, 24: 1, 28: 2, 32: 3, 40: 4, 48: 5, 56: 6, 64: 7 };
  const CASH_SIZELEN = { 0: 20, 1: 24, 2: 28, 3: 32, 4: 40, 5: 48, 6: 56, 7: 64 };
  // type: 0 = P2PKH, 1 = P2SH. hash: 20-byte hash160 (or other allowed length).
  function cashAddrEncode(prefix, type, hash) {
    const h = C.toBytes(hash);
    const sizeBits = CASH_SIZEBITS[h.length];
    if (sizeBits == null) throw new Error('cashaddr: bad hash length');
    const versionByte = (type << 3) | sizeBits;
    const payload8 = C.concatBytes(Uint8Array.of(versionByte), h);
    const payload5 = convertBits(Array.from(payload8), 8, 5, true);
    const values = cashPrefixExpand(prefix).concat(payload5).concat([0, 0, 0, 0, 0, 0, 0, 0]);
    const mod = cashPolymod(values);
    const checksum = [];
    for (let i = 0; i < 8; i++) checksum.push(Number((mod >> (5n * BigInt(7 - i))) & 0x1fn));
    const combined = payload5.concat(checksum);
    let ret = prefix + ':';
    for (const d of combined) ret += CHARSET[d];
    return ret;
  }
  // Accepts both 'bitcoincash:q...' and bare 'q...'. Returns {type, hash, prefix}.
  function cashAddrDecode(addr, defaultPrefix) {
    const s = String(addr).toLowerCase();
    let prefix, body;
    const colon = s.indexOf(':');
    if (colon >= 0) { prefix = s.slice(0, colon); body = s.slice(colon + 1); }
    else { prefix = defaultPrefix || 'bitcoincash'; body = s; }
    const data = [];
    for (const ch of body) {
      const d = CHARSET.indexOf(ch);
      if (d < 0) throw new Error('cashaddr: bad char');
      data.push(d);
    }
    if (cashPolymod(cashPrefixExpand(prefix).concat(data)) !== 0n) throw new Error('cashaddr: bad checksum');
    const payload5 = data.slice(0, data.length - 8);
    const payload8 = convertBits(payload5, 5, 8, false);
    if (!payload8) throw new Error('cashaddr: bad payload');
    const versionByte = payload8[0];
    if (versionByte & 0x80) throw new Error('cashaddr: reserved version bit');
    const type = (versionByte >> 3) & 0x1f;
    const expectLen = CASH_SIZELEN[versionByte & 0x07];
    const hash = Uint8Array.from(payload8.slice(1));
    if (expectLen != null && hash.length !== expectLen) throw new Error('cashaddr: length mismatch');
    return { type, hash, prefix };
  }
  function cashAddrP2pkh(pubKeyBytes, prefix) {
    const pub = C.toBytes(pubKeyBytes);
    return cashAddrEncode(prefix || 'bitcoincash', 0, C.hash160(pub));
  }
  // Heuristic for a bare CashAddr (no prefix): all-charset, starts q (P2PKH) or
  // p (P2SH), length 42 (20-byte-hash payload). Prefixed forms carry the ':'.
  function looksLikeCashAddr(addr) {
    const s = String(addr).toLowerCase();
    if (s.indexOf(':') >= 0) return /^[a-z0-9]+:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(s);
    return /^[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$/.test(s);
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
    cashAddrEncode, cashAddrDecode, cashAddrP2pkh, looksLikeCashAddr, cashPolymod,
    evmAddress, toChecksumAddress,
    p2wpkh, p2pkh, toWIF, fromWIF,
  };
  global.Addr = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
