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

  // ---- Tron (base58check over 0x41 || keccak20) ---------------------------
  // Tron reuses the SAME body as an EVM address — keccak256(uncompressedPub[1:])
  // last 20 bytes — but prepends a 0x41 version byte and encodes the 21-byte
  // payload with Bitcoin-style base58check (double-SHA256 4-byte checksum)
  // instead of EIP-55 hex. The result is a 'T…' address.
  function tronAddress(pubKeyBytes) {
    let pub = C.toBytes(pubKeyBytes);
    if (pub.length === 33) pub = S.encodePoint(S.decodePoint(pub), false); // -> 65B uncompressed
    const body = pub.slice(1);            // drop 0x04
    const hash = C.keccak256(body);
    const payload = C.concatBytes(Uint8Array.of(0x41), hash.slice(-20)); // 21 bytes
    return C.base58checkEncode(payload);
  }
  // 'T…' -> '41'+40-hex (21-byte hex, 0x41 prefix). Throws unless prefix is 0x41.
  function tronAddressToHex(addr) {
    const payload = C.base58checkDecode(String(addr));
    if (payload.length !== 21 || payload[0] !== 0x41) throw new Error('not a tron address');
    return C.bytesToHex(payload);
  }
  // '41…'(21B) or bare 20-byte hex (optionally 0x-prefixed) -> 'T…' base58.
  function tronHexToBase58(hex) {
    let b = C.hexToBytes(String(hex).replace(/^0x/i, ''));
    if (b.length === 20) b = C.concatBytes(Uint8Array.of(0x41), b);
    if (b.length !== 21 || b[0] !== 0x41) throw new Error('bad tron hex address');
    return C.base58checkEncode(b);
  }
  function isTronAddress(addr) {
    if (typeof addr !== 'string') return false;
    if (/^(0x)?41[0-9a-fA-F]{40}$/.test(addr)) return true;           // hex form
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return false;      // base58 shape
    try { const p = C.base58checkDecode(addr); return p.length === 21 && p[0] === 0x41; }
    catch { return false; }
  }

  // ---- XRP Ledger (classic 'r…' = base58check over 0x00 || accountId) ------
  // AccountID = RIPEMD160(SHA256(compressedPub)). The 'r…' classic address is
  // Bitcoin-style base58check (0x00 version byte, 4-byte double-SHA256 checksum)
  // but over the RIPPLE base58 alphabet rather than the Bitcoin one.
  const XRP_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
  function baseXEncode(bytes, alphabet) {
    const b = C.toBytes(bytes);
    let zeros = 0; while (zeros < b.length && b[zeros] === 0) zeros++;
    const digits = [0];
    for (let i = zeros; i < b.length; i++) {
      let carry = b[i];
      for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let str = '';
    for (let i = 0; i < zeros; i++) str += alphabet[0];
    if (zeros < b.length) for (let i = digits.length - 1; i >= 0; i--) str += alphabet[digits[i]];
    return str;
  }
  function baseXDecode(str, alphabet) {
    const bytes = [0];
    for (const ch of str) {
      const val = alphabet.indexOf(ch);
      if (val < 0) throw new Error('invalid base58 char');
      let carry = val;
      for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    let zeros = 0;
    for (const ch of str) { if (ch === alphabet[0]) zeros++; else break; }
    let n = bytes.length; if (n === 1 && bytes[0] === 0) n = 0;
    const out = new Uint8Array(zeros + n);
    for (let i = 0; i < n; i++) out[zeros + i] = bytes[n - 1 - i];
    return out;
  }
  function xrplBase58CheckEncode(payload) {
    const b = C.toBytes(payload);
    const checksum = C.hash256(b).slice(0, 4);
    return baseXEncode(C.concatBytes(b, checksum), XRP_ALPHABET);
  }
  function xrplBase58CheckDecode(str) {
    const full = baseXDecode(String(str), XRP_ALPHABET);
    if (full.length < 5) throw new Error('xrp: short payload');
    const payload = full.slice(0, -4), checksum = full.slice(-4);
    const expect = C.hash256(payload).slice(0, 4);
    for (let i = 0; i < 4; i++) if (checksum[i] !== expect[i]) throw new Error('xrp: bad base58check checksum');
    return payload; // 0x00 || accountId(20)
  }
  // 20-byte AccountID from a 33-byte compressed secp256k1 pubkey.
  function xrpAccountId(pubKeyBytes) {
    const pub = C.toBytes(pubKeyBytes); // MUST be 33-byte compressed (XRPL signs/addresses with compressed)
    return C.hash160(pub);              // RIPEMD160(SHA256(pub))
  }
  function xrpAddress(pubKeyBytes) {
    return xrplBase58CheckEncode(C.concatBytes(Uint8Array.of(0x00), xrpAccountId(pubKeyBytes)));
  }
  // 'r…' -> 20-byte accountId hex. Throws unless version byte is 0x00.
  function xrpAddressToAccountId(addr) {
    const payload = xrplBase58CheckDecode(String(addr));
    if (payload.length !== 21 || payload[0] !== 0x00) throw new Error('not an xrp classic address');
    return payload.slice(1); // 20 bytes
  }
  // 20-byte accountId -> 'r…'.
  function xrpAccountIdToAddress(accountId20) {
    const b = C.toBytes(accountId20);
    if (b.length !== 20) throw new Error('xrp: accountId must be 20 bytes');
    return xrplBase58CheckEncode(C.concatBytes(Uint8Array.of(0x00), b));
  }
  function isXrpAddress(addr) {
    if (typeof addr !== 'string') return false;
    if (!/^r[1-9A-HJ-NP-Za-km-zA-Z]{24,34}$/.test(addr)) return false;
    try { const p = xrplBase58CheckDecode(addr); return p.length === 21 && p[0] === 0x00; }
    catch { return false; }
  }

  // ---- Stellar (strkey 'G…' = base32(0x30 || pub32 || crc16xmodem-LE)) -----
  const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const STRKEY_VERSION_ACCOUNT = 6 << 3; // 0x30 => leading 'G'
  function crc16xmodem(bytes) { // poly 0x1021, init 0x0000 (XModem / CCITT-FALSE sans init)
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) { crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1); crc &= 0xffff; }
    }
    return crc & 0xffff;
  }
  function base32Encode(bytes) {
    const b = C.toBytes(bytes);
    let out = '', bits = 0, val = 0;
    for (let i = 0; i < b.length; i++) {
      val = (val << 8) | b[i]; bits += 8;
      while (bits >= 5) { out += B32_ALPHABET[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32_ALPHABET[(val << (5 - bits)) & 31];
    return out; // no '=' padding (strkey convention)
  }
  function base32Decode(str) {
    const s = String(str).replace(/=+$/, '');
    let bits = 0, val = 0; const out = [];
    for (const ch of s) {
      const idx = B32_ALPHABET.indexOf(ch);
      if (idx < 0) throw new Error('bad base32 char');
      val = (val << 5) | idx; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    return Uint8Array.from(out);
  }
  function strkeyEncode(versionByte, payload) {
    const data = C.concatBytes(Uint8Array.of(versionByte), C.toBytes(payload));
    const crc = crc16xmodem(data);
    const full = C.concatBytes(data, Uint8Array.of(crc & 0xff, (crc >> 8) & 0xff)); // CRC little-endian
    return base32Encode(full);
  }
  function strkeyDecode(str, expectVersion) {
    const full = base32Decode(str);
    if (full.length < 3) throw new Error('strkey: short');
    const data = full.slice(0, full.length - 2), crcBytes = full.slice(full.length - 2);
    const crc = crc16xmodem(data);
    if (crcBytes[0] !== (crc & 0xff) || crcBytes[1] !== ((crc >> 8) & 0xff)) throw new Error('strkey: bad crc');
    if (expectVersion != null && data[0] !== expectVersion) throw new Error('strkey: wrong version');
    return data.slice(1); // payload (pubkey for account)
  }
  function stellarAddress(pubKey32) {
    const pub = C.toBytes(pubKey32);
    if (pub.length !== 32) throw new Error('stellar: pubkey must be 32 bytes');
    return strkeyEncode(STRKEY_VERSION_ACCOUNT, pub);
  }
  function stellarAddressToPub(addr) { return strkeyDecode(String(addr), STRKEY_VERSION_ACCOUNT); }
  function isStellarAddress(addr) {
    if (typeof addr !== 'string') return false;
    if (!/^G[A-Z2-7]{55}$/.test(addr)) return false;
    try { return strkeyDecode(addr, STRKEY_VERSION_ACCOUNT).length === 32; } catch { return false; }
  }

  // ---- Tezos (tz1 = base58check([6,161,159] || blake2b(pub,20))) -----------
  // WE issue tz1 (ed25519) only; destinations may be tz1/tz2/tz3/KT1. Standard
  // Bitcoin-alphabet base58check (crypto-core), so no custom codec is needed.
  const TEZOS_PREFIX = {
    tz1: [6, 161, 159], tz2: [6, 161, 161], tz3: [6, 161, 164], KT1: [2, 90, 121],
  };
  function tezosAddress(pubKey32) {
    const pub = C.toBytes(pubKey32);
    if (pub.length !== 32) throw new Error('tezos: pubkey must be 32 bytes');
    return C.base58checkEncode(C.concatBytes(Uint8Array.from(TEZOS_PREFIX.tz1), C.blake2b(pub, 20)));
  }
  function tezosDecodeExpect(addr, kind) {
    const payload = C.base58checkDecode(String(addr));
    const p = TEZOS_PREFIX[kind];
    if (payload.length < p.length) throw new Error('tezos: short payload');
    for (let i = 0; i < p.length; i++) if (payload[i] !== p[i]) throw new Error('tezos: wrong prefix');
    return payload.slice(p.length);
  }
  function isTezosAddress(addr) { // our own account is always tz1
    if (typeof addr !== 'string' || !/^tz1[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return false;
    try { return tezosDecodeExpect(addr, 'tz1').length === 20; } catch { return false; }
  }
  function isTezosDestination(addr) { // SEND accepts tz1/tz2/tz3/KT1
    if (typeof addr !== 'string') return false;
    const kind = addr.slice(0, 3);
    if (!(kind in TEZOS_PREFIX) || !/^[a-zA-Z0-9]{3}[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr)) return false;
    try { return tezosDecodeExpect(addr, kind).length === 20; } catch { return false; }
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
    tronAddress, tronAddressToHex, tronHexToBase58, isTronAddress,
    xrpAccountId, xrpAddress, xrpAddressToAccountId, xrpAccountIdToAddress, isXrpAddress,
    xrplBase58CheckEncode, xrplBase58CheckDecode,
    stellarAddress, stellarAddressToPub, isStellarAddress,
    tezosAddress, isTezosAddress, isTezosDestination,
    strkeyEncode, strkeyDecode, crc16xmodem, base32Encode, base32Decode,
    p2wpkh, p2pkh, toWIF, fromWIF,
  };
  global.Addr = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
