// chains/xrpl-codec.js — the minimal XRP Ledger binary codec + classic-address
// codec the XRP adapter (chains/xrp.js) and the golden-vector tests depend on.
// Byte-identical logic to the Qt/Python chains/xrpl_codec.py and cross-checked
// against ripple-binary-codec / xrpl-py.
//
// A Payment is serialized in canonical field order (sorted by (type_code,
// field_code)) with the standard XRPL type serializers. Signing hashes the
// 'STX\0'-prefixed serialization WITHOUT TxnSignature with SHA512-half (first 32
// bytes of SHA512); the secp256k1 low-S DER goes in TxnSignature; the tx is then
// re-serialized WITH the signature. The tx hash is SHA512-half of the
// 'TXN\0'-prefixed full signed serialization (upper hex).
//
// NOT post-quantum — secp256k1/ECDSA, exactly like Bitcoin/Ethereum.
//
// Global `XrplCodec`; module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const S = inNode ? require('../secp256k1.js') : global.Secp256k1;

  const RIPPLE_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
  const ACCOUNT_PREFIX = Uint8Array.of(0x00);            // classic address version
  const STX_PREFIX = Uint8Array.of(0x53, 0x54, 0x58, 0x00); // 'STX\0'
  const TXN_PREFIX = Uint8Array.of(0x54, 0x58, 0x4e, 0x00); // 'TXN\0'
  const TX_PAYMENT = 0;
  const TF_FULLY_CANONICAL_SIG = 0x80000000;

  // ---- ripple base58check (double-SHA256 4-byte checksum) ------------------
  function b58encode(bytes) {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    let out = '';
    while (n > 0n) { const r = Number(n % 58n); n /= 58n; out = RIPPLE_ALPHABET[r] + out; }
    for (const b of bytes) { if (b === 0) out = RIPPLE_ALPHABET[0] + out; else break; }
    return out;
  }
  function b58decode(str) {
    let n = 0n;
    for (const ch of str) {
      const d = RIPPLE_ALPHABET.indexOf(ch);
      if (d < 0) throw new Error('xrp: bad ripple-base58 char');
      n = n * 58n + BigInt(d);
    }
    const bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
    let pad = 0;
    for (const ch of str) { if (ch === RIPPLE_ALPHABET[0]) pad++; else break; }
    return Uint8Array.from(new Array(pad).fill(0).concat(bytes));
  }
  function b58checkEncode(payload) {
    const chk = C.sha256(C.sha256(payload)).slice(0, 4);
    return b58encode(C.concatBytes(C.toBytes(payload), chk));
  }
  function b58checkDecode(str) {
    const raw = b58decode(str);
    if (raw.length < 5) throw new Error('xrp: base58check too short');
    const payload = raw.slice(0, -4), chk = raw.slice(-4);
    const good = C.sha256(C.sha256(payload)).slice(0, 4);
    for (let i = 0; i < 4; i++) if (good[i] !== chk[i]) throw new Error('xrp: bad base58check checksum');
    return payload;
  }

  // ---- classic address -----------------------------------------------------
  function accountIdFromPubkey(pub33) { return C.hash160(C.toBytes(pub33)); }
  function classicAddress(pub33) { return b58checkEncode(C.concatBytes(ACCOUNT_PREFIX, accountIdFromPubkey(pub33))); }
  function addressFromAccountId(accountId20) { return b58checkEncode(C.concatBytes(ACCOUNT_PREFIX, C.toBytes(accountId20))); }
  function accountIdFromAddress(addr) {
    const payload = b58checkDecode(String(addr));
    if (payload.length !== 21 || payload[0] !== 0) throw new Error('xrp: not a classic address');
    return payload.slice(1);
  }
  function isXrpAddress(addr) {
    if (typeof addr !== 'string' || addr[0] !== 'r') return false;
    try { return accountIdFromAddress(addr).length === 20; } catch { return false; }
  }

  // ---- field table + binary serializer -------------------------------------
  // [type_code, field_code, kind]
  const FIELDS = {
    TransactionType: [1, 2, 'UInt16'],
    Flags: [2, 2, 'UInt32'],
    Sequence: [2, 4, 'UInt32'],
    DestinationTag: [2, 14, 'UInt32'],
    LastLedgerSequence: [2, 27, 'UInt32'],
    Amount: [6, 1, 'Amount'],
    Fee: [6, 8, 'Amount'],
    SigningPubKey: [7, 3, 'Blob'],
    TxnSignature: [7, 4, 'Blob'],
    Account: [8, 1, 'AccountID'],
    Destination: [8, 3, 'AccountID'],
  };

  function fieldId(t, f) {
    if (t < 16 && f < 16) return Uint8Array.of((t << 4) | f);
    if (t >= 16 && f < 16) return Uint8Array.of(f, t);
    if (t < 16 && f >= 16) return Uint8Array.of(t << 4, f);
    return Uint8Array.of(0, t, f);
  }
  function vlLength(n) {
    if (n <= 192) return Uint8Array.of(n);
    if (n <= 12480) { n -= 193; return Uint8Array.of(193 + (n >> 8), n & 0xff); }
    if (n <= 918744) { n -= 12481; return Uint8Array.of(241 + (n >> 16), (n >> 8) & 0xff, n & 0xff); }
    throw new Error('xrp: VL field too long');
  }
  function u16(v) { return Uint8Array.of((v >> 8) & 0xff, v & 0xff); }
  function u32(v) { const n = BigInt(v) & 0xffffffffn; return Uint8Array.of(Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn)); }
  function encAmountXrp(drops) {
    let v = BigInt(drops);
    if (v < 0n) throw new Error('xrp: negative drops');
    v |= 0x4000000000000000n; // positive XRP (bit 62), not-issued (bit 63 = 0)
    const out = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
  }
  function encField(name, val) {
    const [t, f, kind] = FIELDS[name];
    const hdr = fieldId(t, f);
    let body;
    if (kind === 'UInt16') body = u16(Number(val));
    else if (kind === 'UInt32') body = u32(val);
    else if (kind === 'Amount') body = encAmountXrp(val);
    else { const p = typeof val === 'string' ? C.hexToBytes(val) : C.toBytes(val); body = C.concatBytes(vlLength(p.length), p); }
    return C.concatBytes(hdr, body);
  }
  function serialize(fields, forSigning) {
    const items = [];
    for (const name of Object.keys(fields)) {
      const val = fields[name];
      if (val === null || val === undefined) continue;
      if (forSigning && name === 'TxnSignature') continue;
      const [t, f] = FIELDS[name];
      items.push([t, f, name, val]);
    }
    items.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    let out = new Uint8Array(0);
    for (const [, , name, val] of items) out = C.concatBytes(out, encField(name, val));
    return out;
  }
  function sha512Half(b) { return C.sha512(b).slice(0, 32); }
  // 'STX\0' || serialize(fields, forSigning=true) — the exact pre-hash bytes.
  function signingData(fields) { return C.concatBytes(STX_PREFIX, serialize(fields, true)); }
  function signingHash(fields) { return sha512Half(signingData(fields)); }
  function txHash(signedBlob) { return C.bytesToHex(sha512Half(C.concatBytes(TXN_PREFIX, C.toBytes(signedBlob)))).toUpperCase(); }

  // Build the ordered Payment field map (Account/Destination hex account ids).
  function buildPaymentFields(accountAddr, destAddr, amountDrops, feeDrops, sequence,
                              lastLedgerSequence, signingPubKeyHex, opts) {
    opts = opts || {};
    const flags = opts.flags === undefined ? TF_FULLY_CANONICAL_SIG : opts.flags;
    const fields = {
      TransactionType: TX_PAYMENT,
      Flags: Number(flags) >>> 0,
      Sequence: Number(sequence),
      LastLedgerSequence: Number(lastLedgerSequence),
      Amount: String(amountDrops),
      Fee: String(feeDrops),
      SigningPubKey: String(signingPubKeyHex).toLowerCase(),
      Account: C.bytesToHex(accountIdFromAddress(accountAddr)),
      Destination: C.bytesToHex(accountIdFromAddress(destAddr)),
    };
    if (opts.destinationTag !== undefined && opts.destinationTag !== null) {
      fields.DestinationTag = Number(opts.destinationTag);
    }
    return fields;
  }

  // Sign the payment fields + re-serialize with TxnSignature.
  function buildSignedPayment(fields, priv) {
    const h = signingHash(fields);
    const sig = S.sign(h, C.toBytes(priv));
    const der = sig.der;
    const signed = Object.assign({}, fields, { TxnSignature: C.bytesToHex(der) });
    const blob = serialize(signed, false);
    return {
      txBlobHex: C.bytesToHex(blob),
      txnSignatureDerHex: C.bytesToHex(der),
      signHashHex: C.bytesToHex(h),
      hash: txHash(blob),
      fields: signed,
    };
  }

  // Adapter-style convenience wrapper: takes a flat arg object and returns BOTH
  // the Design-A (…Hex) and Design-B field names, so a caller using either name
  // set is satisfied. args: { pub, priv, account, destination, amount, fee,
  // sequence, flags, lastLedgerSequence, destinationTag }.
  function buildPayment(args) {
    const fields = buildPaymentFields(args.account, args.destination, args.amount, args.fee,
      args.sequence, args.lastLedgerSequence, args.pub && args.pub.length ? C.bytesToHex(C.toBytes(args.pub)) : args.signingPubKey,
      { flags: args.flags, destinationTag: args.destinationTag });
    const sd = signingData(fields);
    const built = buildSignedPayment(fields, args.priv);
    return Object.assign({}, built, {
      fields: built.fields,
      signingData: C.bytesToHex(sd),       // hex (Design B)
      signingDataHex: C.bytesToHex(sd),    // hex (Design A)
      signingHash: sha512Half(sd),         // bytes (Design B verify step)
      txnSignatureDer: built.txnSignatureDerHex,
      txBlob: built.txBlobHex,
      txid: built.hash,
    });
  }

  const API = {
    RIPPLE_ALPHABET, STX_PREFIX, TXN_PREFIX, TX_PAYMENT, TF_FULLY_CANONICAL_SIG, FIELDS,
    b58encode, b58decode, b58checkEncode, b58checkDecode,
    accountIdFromPubkey, classicAddress, addressFromAccountId, accountIdFromAddress, isXrpAddress,
    serialize, sha512Half, signingData, signingHash, txHash,
    buildPaymentFields, buildSignedPayment, buildPayment,
    amountDrops: encAmountXrp, vlPrefix: vlLength,
  };
  global.XrplCodec = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
