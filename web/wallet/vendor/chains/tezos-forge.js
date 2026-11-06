// chains/tezos-forge.js — pure, NETWORK-FREE Tezos binary codec engine.
//
// This is the Tezos analogue of chains/ton-cell.js (BOC engine) and
// chains/stellar-xdr.js (XDR codec): a self-contained forge + base58check module
// that BOTH the adapter (chains/tezos.js) and the golden-vector test call. No I/O.
//
// Fund-safety posture: the CLIENT forges the whole manager operation here; the node
// supplies ONLY the branch (verifiable head block hash) and the account counter
// (verifiable per-account) — never any part of the signed payload. Same posture the
// TON (ton.js) and Stellar (stellar.js) adapters document.
//
// Primitives (all byte-exact):
//  • zarith(n)      — unsigned base-128 LEB128 varint (fee/counter/gas/storage/amount).
//  • publicKeyHash  — curve tag (0x00 tz1 / 0x01 tz2 / 0x02 tz3) || 20B blake2b hash.
//  • contractId     — 0x00||pkh (implicit tzN) or 0x01||20B||0x00 (originated KT1).
//  • edpk / tz1 / edsig — standard-alphabet base58check with Tezos prefix bytes.
//  • forgeTransaction — a single 'transaction' manager operation to hex.
//  • signingBytes   — blake2b(0x03 watermark || forged, 32).
//
// Global `TezosForge`; module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;

  // ---- Tezos base58 prefix bytes (standard) --------------------------------
  const PREFIX = {
    tz1: [6, 161, 159],          // ed25519 public-key hash  -> 'tz1…'
    tz2: [6, 161, 161],          // secp256k1 public-key hash -> 'tz2…'
    tz3: [6, 161, 164],          // p256 public-key hash      -> 'tz3…'
    KT1: [2, 90, 121],           // originated contract       -> 'KT1…'
    edpk: [13, 15, 37, 217],     // ed25519 public key        -> 'edpk…'
    edsig: [9, 245, 205, 134, 18], // ed25519 signature       -> 'edsig…'
    B: [1, 52],                  // block hash                -> 'B…'
    o: [5, 116],                 // operation hash            -> 'o…'
  };
  // curve tag for the public-key-hash encoding, keyed by address prefix.
  const CURVE_TAG = { tz1: 0x00, tz2: 0x01, tz3: 0x02 };

  // ---- base58check with a Tezos multi-byte prefix --------------------------
  // Tezos uses the SAME Bitcoin base58 alphabet + double-SHA256 checksum as
  // crypto-core, so no custom codec is needed (unlike XRP). encode: b58check(
  // prefix || raw); decode strips the checksum then the known prefix.
  function b58cEncode(prefixBytes, raw) {
    return C.base58checkEncode(C.concatBytes(Uint8Array.from(prefixBytes), C.toBytes(raw)));
  }
  function b58cDecodeExpect(str, prefixBytes) {
    const payload = C.base58checkDecode(String(str));
    const p = Uint8Array.from(prefixBytes);
    if (payload.length < p.length) throw new Error('tezos: payload shorter than prefix');
    for (let i = 0; i < p.length; i++) if (payload[i] !== p[i]) throw new Error('tezos: wrong base58 prefix');
    return payload.slice(p.length);
  }
  // Decode ANY Tezos base58check string -> { kind, raw }. kind is the matched
  // prefix name (tz1/tz2/tz3/KT1/edpk/edsig/B/o).
  function b58cDecodeAny(str) {
    const payload = C.base58checkDecode(String(str));
    for (const kind of Object.keys(PREFIX)) {
      const p = PREFIX[kind];
      if (payload.length < p.length) continue;
      let ok = true;
      for (let i = 0; i < p.length; i++) if (payload[i] !== p[i]) { ok = false; break; }
      if (ok) return { kind, raw: payload.slice(p.length) };
    }
    throw new Error('tezos: unknown base58 prefix');
  }

  // edpk(pub32), tz1(pub32), edsig(sig64).
  function edpk(pub32) {
    const pub = C.toBytes(pub32);
    if (pub.length !== 32) throw new Error('tezos: ed25519 pubkey must be 32 bytes');
    return b58cEncode(PREFIX.edpk, pub);
  }
  function tz1(pub32) {
    const pub = C.toBytes(pub32);
    if (pub.length !== 32) throw new Error('tezos: ed25519 pubkey must be 32 bytes');
    return b58cEncode(PREFIX.tz1, C.blake2b(pub, 20));
  }
  function edsig(sig64) {
    const sig = C.toBytes(sig64);
    if (sig.length !== 64) throw new Error('tezos: ed25519 signature must be 64 bytes');
    return b58cEncode(PREFIX.edsig, sig);
  }

  // Which Tezos address family a string is (tz1/tz2/tz3/KT1), or null.
  function addressKind(addr) {
    if (typeof addr !== 'string') return null;
    const m = addr.slice(0, 3);
    if (m === 'tz1' || m === 'tz2' || m === 'tz3' || m === 'KT1') {
      try { b58cDecodeExpect(addr, PREFIX[m]); return m; } catch { return null; }
    }
    return null;
  }
  // We ISSUE tz1 only; SEND must accept tz1/tz2/tz3/KT1 destinations.
  function isTz1(addr) { return addressKind(addr) === 'tz1'; }
  function isTezosDestination(addr) { return addressKind(addr) != null; }

  // ---- zarith: unsigned base-128 LEB128 varint -----------------------------
  function zarith(n) {
    let v = BigInt(n);
    if (v < 0n) throw new Error('zarith: value must be non-negative');
    const out = [];
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) out.push(b | 0x80);
      else { out.push(b); break; }
    }
    return Uint8Array.from(out);
  }

  // ---- public-key-hash / contract-id encodings -----------------------------
  // public_key_hash: 1-byte curve tag || 20-byte hash. Used for the manager-op
  // SOURCE field (always our tz1) and inside an implicit contract-id.
  function publicKeyHash(addr) {
    const kind = addressKind(addr);
    if (!kind || !(kind in CURVE_TAG)) throw new Error('tezos: not a tzN public-key-hash: ' + addr);
    const raw = b58cDecodeExpect(addr, PREFIX[kind]);
    if (raw.length !== 20) throw new Error('tezos: pkh must be 20 bytes');
    return C.concatBytes(Uint8Array.of(CURVE_TAG[kind]), raw);
  }
  // contract_id: implicit (tzN) -> 0x00 || public_key_hash(tag||20);
  //              originated (KT1) -> 0x01 || 20B || 0x00 padding.
  function contractId(addr) {
    const kind = addressKind(addr);
    if (!kind) throw new Error('tezos: not a contract id: ' + addr);
    if (kind === 'KT1') {
      const raw = b58cDecodeExpect(addr, PREFIX.KT1);
      if (raw.length !== 20) throw new Error('tezos: KT1 hash must be 20 bytes');
      return C.concatBytes(Uint8Array.of(0x01), raw, Uint8Array.of(0x00));
    }
    return C.concatBytes(Uint8Array.of(0x00), publicKeyHash(addr));
  }

  // ---- forge a single 'transaction' manager operation ----------------------
  // fields = { branch, source(tz1), fee, counter, gas_limit, storage_limit,
  //            amount, destination }. Returns hex (NO watermark, NO signature).
  const TRANSACTION_TAG = 0x6c;
  function forgeTransaction(fields) {
    const branchRaw = b58cDecodeExpect(fields.branch, PREFIX.B); // 32-byte block hash
    if (branchRaw.length !== 32) throw new Error('tezos: branch must decode to 32 bytes');
    const bytes = C.concatBytes(
      branchRaw,
      Uint8Array.of(TRANSACTION_TAG),
      publicKeyHash(fields.source),
      zarith(fields.fee),
      zarith(fields.counter),
      zarith(fields.gas_limit),
      zarith(fields.storage_limit),
      zarith(fields.amount),
      contractId(fields.destination),
      Uint8Array.of(0x00),            // parameters flag: none
    );
    return C.bytesToHex(bytes);
  }

  // signing bytes = blake2b(0x03 generic-operation watermark || forged, 32).
  const WATERMARK_GENERIC = 0x03;
  function signingBytes(forgedHex) {
    const forged = C.hexToBytes(forgedHex);
    return C.blake2b(C.concatBytes(Uint8Array.of(WATERMARK_GENERIC), forged), 32);
  }
  // injection payload (hex) = forged || 64-byte signature.
  function injectionHex(forgedHex, sig64) {
    return forgedHex + C.bytesToHex(C.toBytes(sig64));
  }

  const API = {
    PREFIX, CURVE_TAG, TRANSACTION_TAG, WATERMARK_GENERIC,
    b58cEncode, b58cDecodeExpect, b58cDecodeAny,
    edpk, tz1, edsig,
    addressKind, isTz1, isTezosDestination,
    zarith, publicKeyHash, contractId,
    forgeTransaction, signingBytes, injectionHex,
  };
  global.TezosForge = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
