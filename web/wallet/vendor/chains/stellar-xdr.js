// chains/stellar-xdr.js — the minimal Stellar XDR encoder + strkey address codec
// the Stellar adapter (chains/stellar.js) and the golden-vector tests depend on.
// Byte-identical logic to the Qt/Python chains/stellar_xdr.py and cross-checked
// against @stellar/stellar-base / stellar-sdk.
//
// A v1 TransactionEnvelope with a single Payment op (native XLM or an AlphaNum4
// issued asset) is serialized with standard XDR. The tx hash (and signature
// base) is SHA256( networkId || ENVELOPE_TYPE_TX(=2) || txXDR ), networkId =
// SHA256(network passphrase); the ed25519 signature of that 32-byte hash plus a
// 4-byte key hint form the single DecoratedSignature in the envelope.
//
// NOT post-quantum — ed25519 is classical EC crypto.
//
// Global `StellarXdr`; module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const ED = inNode ? require('../ed25519.js') : global.Ed25519;

  const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
  const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
  const ENVELOPE_TYPE_TX = 2;
  const STRKEY_VERSION_ACCOUNT = 6 << 3; // 0x30 -> 'G…'
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const BASE_FEE = 100;

  // ---- CRC-16/XMODEM (poly 0x1021, init 0x0000) ----------------------------
  function crc16Xmodem(data) {
    let crc = 0;
    for (const b of C.toBytes(data)) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff) : ((crc << 1) & 0xffff);
    }
    return crc & 0xffff;
  }

  // ---- base32 (RFC 4648, no padding) ---------------------------------------
  function base32encode(data) {
    const bytes = C.toBytes(data);
    let bits = 0, value = 0, out = '';
    for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(value >> bits) & 31]; } }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }
  function base32decode(s) {
    let bits = 0, value = 0; const out = [];
    for (const ch of s) {
      const d = B32.indexOf(ch);
      if (d < 0) throw new Error('stellar: bad base32 char');
      value = (value << 5) | d; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
    }
    return Uint8Array.from(out);
  }

  // ---- strkey 'G…' account address -----------------------------------------
  function encodeEd25519PublicKey(pub32) {
    const pub = C.toBytes(pub32);
    if (pub.length !== 32) throw new Error('stellar: ed25519 pubkey must be 32 bytes');
    let payload = C.concatBytes(Uint8Array.of(STRKEY_VERSION_ACCOUNT), pub);
    const crc = crc16Xmodem(payload);
    payload = C.concatBytes(payload, Uint8Array.of(crc & 0xff, (crc >> 8) & 0xff)); // little-endian
    return base32encode(payload);
  }
  function decodeEd25519PublicKey(addr) {
    const raw = base32decode(String(addr));
    if (raw.length !== 35 || raw[0] !== STRKEY_VERSION_ACCOUNT) throw new Error("stellar: not a 'G…' account address");
    const body = raw.slice(0, 33), chk = raw.slice(33);
    const crc = crc16Xmodem(body);
    if (chk[0] !== (crc & 0xff) || chk[1] !== ((crc >> 8) & 0xff)) throw new Error('stellar: bad strkey checksum');
    return body.slice(1);
  }
  function isStellarAddress(addr) {
    if (typeof addr !== 'string' || addr[0] !== 'G' || addr.length !== 56) return false;
    try { return decodeEd25519PublicKey(addr).length === 32; } catch { return false; }
  }

  // ---- XDR primitives ------------------------------------------------------
  function u32(v) { const n = BigInt(v) & 0xffffffffn; return Uint8Array.of(Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn)); }
  function i64(v) { let n = BigInt(v) & 0xffffffffffffffffn; const out = new Uint8Array(8); for (let i = 7; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; }
  function opaqueVar(b) { const pad = (4 - (b.length % 4)) % 4; return C.concatBytes(u32(b.length), b, new Uint8Array(pad)); }
  function muxedEd25519(pub32) { return C.concatBytes(u32(0), C.toBytes(pub32)); }  // KEY_TYPE_ED25519 = 0
  function accountId(pub32) { return C.concatBytes(u32(0), C.toBytes(pub32)); }     // PUBLIC_KEY_TYPE_ED25519 = 0
  function assetNative() { return u32(0); }
  function assetAlphanum4(code, issuerPub32) {
    const c = C.utf8(code);
    if (c.length > 4) throw new Error('stellar: AlphaNum4 code > 4 chars');
    const padded = C.concatBytes(c, new Uint8Array(4 - c.length));
    return C.concatBytes(u32(1), padded, accountId(issuerPub32));  // CREDIT_ALPHANUM4 = 1
  }
  function paymentOp(destPub32, amountStroops, assetXdr) {
    let body = muxedEd25519(destPub32);
    body = C.concatBytes(body, assetXdr || assetNative(), i64(amountStroops));
    return C.concatBytes(u32(0), u32(1), body); // op source none, body union PAYMENT = 1
  }
  function transactionXdr(sourcePub32, fee, seqnum, ops) {
    let out = muxedEd25519(sourcePub32);
    out = C.concatBytes(out, u32(fee), i64(seqnum), u32(0), u32(0), u32(ops.length)); // precond none, memo none
    for (const op of ops) out = C.concatBytes(out, op);
    return C.concatBytes(out, u32(0)); // ext v = 0
  }
  function networkId(passphrase) { return C.sha256(C.utf8(passphrase || PUBLIC_NETWORK_PASSPHRASE)); }
  function signingBase(txXdr, passphrase) { return C.concatBytes(networkId(passphrase), u32(ENVELOPE_TYPE_TX), C.toBytes(txXdr)); }
  function txHash(txXdr, passphrase) { return C.sha256(signingBase(txXdr, passphrase)); }

  function toBase64(bytes) {
    const b = C.toBytes(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  }

  // Build + ed25519-sign a v1 TransactionEnvelope.
  function buildSignedEnvelope(sourcePub32, seedKey, seqnum, ops, opts) {
    opts = opts || {};
    const pub = C.toBytes(sourcePub32);
    const passphrase = opts.passphrase || PUBLIC_NETWORK_PASSPHRASE;
    const fee = opts.fee === undefined ? (BASE_FEE * ops.length) : opts.fee;
    const tx = transactionXdr(pub, fee, seqnum, ops);
    const base = signingBase(tx, passphrase);
    const h = C.sha256(base);
    const signature = ED.sign(h, seedKey);
    const hint = pub.slice(-4);
    const env = C.concatBytes(u32(ENVELOPE_TYPE_TX), tx, u32(1), hint, opaqueVar(signature));
    return {
      txXDRunsignedHex: C.bytesToHex(tx),
      signingBaseHex: C.bytesToHex(base),
      hash: C.bytesToHex(h),
      signatureHex: C.bytesToHex(signature),
      hint: C.bytesToHex(hint),
      envelopeXDRBase64: toBase64(env),
    };
  }

  const API = {
    PUBLIC_NETWORK_PASSPHRASE, TESTNET_PASSPHRASE, ENVELOPE_TYPE_TX, STRKEY_VERSION_ACCOUNT, BASE_FEE,
    crc16Xmodem, base32encode, base32decode,
    encodeEd25519PublicKey, decodeEd25519PublicKey, isStellarAddress,
    assetNative, assetAlphanum4, paymentOp, transactionXdr, networkId, signingBase, txHash,
    buildSignedEnvelope, toBase64,
  };
  global.StellarXdr = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
