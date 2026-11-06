// chains/cardano-cbor.js — minimal CANONICAL CBOR codec for Cardano (Conway/
// Babbage era) transactions. Definite-length, canonical minimal integer
// encoding only; just enough to serialize a native-ADA transfer byte-exactly.
//
// Supported majors:
//   0 uint   : 0x00..0x17 inline, else 0x18/0x19/0x1a/0x1b minimal width
//   2 bytes  : 0x40|len header (len<24 inline, else widened) then raw bytes
//   4 array  : 0x80|len header
//   5 map    : 0xa0|len header, caller supplies canonically-ordered small keys
//   6 tag    : 0xc0|tag (used only for set tag 258 = 0xd90102)
//   simple   : true (0xf5), null (0xf6)
//
// SETS: Cardano transaction inputs and vkey witnesses are logically sets. We
// encode them as PLAIN definite-length CBOR arrays (NO set tag 258) — this is
// the canonical Shelley/Babbage serialization still accepted by the node, and
// the form produced by the bip_utils + cbor2 reference that pins the golden
// vector. (A generic taggedSet(258,…) helper is exposed for callers that need
// the Conway tagged form, but the tx builders below use plain arrays.)
//
// This is a WRITE-ONLY encoder (we never need to parse CBOR for v1). Pinned by
// docs/cardano-vectors.json (cborIntKats + the full tx_body / signed_tx bytes).
//
// Global `CardanoCbor`; module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;

  function concat(arrs) { return C.concatBytes.apply(null, arrs); }

  // Head byte for (majorType<<5 | argument), with argument encoded minimally.
  function head(major, n) {
    const m = major << 5;
    if (typeof n === 'number') n = BigInt(n);
    if (n < 0n) throw new Error('cbor: negative length/uint not supported');
    if (n < 24n) return Uint8Array.of(m | Number(n));
    if (n < 0x100n) return Uint8Array.of(m | 24, Number(n));
    if (n < 0x10000n) {
      const x = Number(n);
      return Uint8Array.of(m | 25, (x >> 8) & 0xff, x & 0xff);
    }
    if (n < 0x100000000n) {
      const x = Number(n);
      return Uint8Array.of(m | 26, (x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
    }
    // 64-bit width
    const b = new Uint8Array(9);
    b[0] = m | 27;
    let v = n;
    for (let i = 8; i >= 1; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return b;
  }

  function uint(n) { return head(0, n); }

  function bytes(b) {
    const raw = C.toBytes(b);
    return concat([head(2, raw.length), raw]);
  }

  // items: array of already-encoded Uint8Array elements
  function array(items) {
    const parts = [head(4, items.length)];
    for (const it of items) parts.push(it);
    return concat(parts);
  }

  // entries: array of [encodedKey, encodedValue]; caller MUST pass them in
  // canonical key order (Cardano uses small int keys 0..n, already sorted).
  function map(entries) {
    const parts = [head(5, entries.length)];
    for (const [k, v] of entries) { parts.push(k); parts.push(v); }
    return concat(parts);
  }

  // CBOR tag wrapper. taggedSet wraps an array with the Conway "set" tag 258.
  function tag(t, payload) { return concat([head(6, t), payload]); }
  function taggedSet(items) { return tag(258, array(items)); }

  const TRUE = Uint8Array.of(0xf5);
  const NULL = Uint8Array.of(0xf6);

  // tx_body = map { 0: set<[txHash32, index]>, 1: [[addrBytes, coin], ...],
  //                 2: fee, 3: ttl }
  // inputs:  [{ txHashHex, index }]
  // outputs: [{ addressBytes:Uint8Array, coin:BigInt|string }]
  function txBody(inputs, outputs, fee, ttl) {
    const inItems = inputs.map((i) =>
      array([bytes(C.toBytes(i.txHashHex || i.txHash)), uint(i.index || 0)]));
    const outItems = outputs.map((o) =>
      array([bytes(o.addressBytes), uint(BigInt(o.coin))]));
    return map([
      [uint(0), array(inItems)],
      [uint(1), array(outItems)],
      [uint(2), uint(BigInt(fee))],
      [uint(3), uint(BigInt(ttl))],
    ]);
  }

  // witness_set = map { 0: set<[vkey32, sig64]> }
  function witnessSet(vkeyWitnesses) {
    const items = vkeyWitnesses.map((w) =>
      array([bytes(C.toBytes(w.vkey)), bytes(C.toBytes(w.sig))]));
    return map([[uint(0), array(items)]]);
  }

  // signed tx = [ tx_body, witness_set, true (valid), null (aux data) ]
  function signedTx(bodyBytes, witnessSetBytes) {
    return array([bodyBytes, witnessSetBytes, TRUE, NULL]);
  }

  const API = {
    uint, bytes, array, map, tag, taggedSet, head,
    txBody, witnessSet, signedTx, TRUE, NULL,
  };
  global.CardanoCbor = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
