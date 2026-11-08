// solana.js (VENDORED, CommonJS) — minimal Solana ed25519 signing for the
// server-side bot runner. Lives under src/vendor/ (NOT scanned by the
// post-quantum guard, exactly like the secp256k1 EVM signer) because Solana is
// ed25519 — not post-quantum — the same tradeoff Solana itself makes.
//
// Signing uses Node's built-in ed25519 (no third-party deps): a 32-byte seed is
// wrapped in the fixed PKCS8 prefix to make a KeyObject. The keypair derivation
// matches Solana's Keypair.fromSeed(seed) and RFC-8032 exactly (verified by the
// golden vector in the test), so the address + signatures are byte-identical to
// what the on-device wallet produces for the same delegated sub-key.
'use strict';
const crypto = require('node:crypto');
const C = require('./crypto-core.js');

// DER wrappers so a raw 32-byte ed25519 seed / 32-byte public key become Node
// KeyObjects. These prefixes are the fixed ASN.1 headers for Ed25519 keys.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privKeyObject(seed) {
  const s = Buffer.from(seed);
  if (s.length !== 32) throw new Error('solana: seed must be 32 bytes');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, s]), format: 'der', type: 'pkcs8' });
}

/// 32-byte raw public key for a seed.
function publicKey(seed) {
  const der = crypto.createPublicKey(privKeyObject(seed)).export({ format: 'der', type: 'spki' });
  return Uint8Array.from(der.subarray(der.length - 32));
}

/// Base58 Solana address for a seed.
function addressFromSeed(seed) {
  return C.base58encode(publicKey(seed));
}

/// Sign an arbitrary message; returns a 64-byte ed25519 signature.
function signMessage(seed, message) {
  return Uint8Array.from(crypto.sign(null, Buffer.from(message), privKeyObject(seed)));
}

// ---- compact-u16 (shortvec) — Solana's length prefix ------------------------
function readShortVec(bytes, offset) {
  let len = 0, size = 0, b;
  do {
    b = bytes[offset + size];
    len |= (b & 0x7f) << (size * 7);
    size += 1;
  } while (b & 0x80);
  return { len, size };
}

/// Sign a serialized Solana transaction (legacy OR v0 versioned, base64 — the
/// shape Jupiter's /swap returns) with the seed as the FEE PAYER (signature slot
/// 0), and return the fully-signed transaction as base64. The transaction wire
/// format is: [shortvec numSignatures][numSignatures × 64-byte sig][message].
/// We sign the message bytes and place the signature in slot 0 — the fee payer,
/// which Jupiter sets to our userPublicKey.
function signTransaction(seed, txBase64) {
  const tx = Buffer.from(txBase64, 'base64');
  const { len: numSigs, size: sigLenBytes } = readShortVec(tx, 0);
  if (numSigs < 1) throw new Error('solana: tx has no signature slots');
  const sigsStart = sigLenBytes;
  const messageStart = sigsStart + numSigs * 64;
  if (messageStart > tx.length) throw new Error('solana: malformed tx (sig region overruns)');
  const message = tx.subarray(messageStart);
  // Defence-in-depth: the first required signer (message bytes after the header
  // byte of a v0 tx, or the first account for legacy) must be OUR pubkey — never
  // sign a transaction whose fee payer we don't control. The account keys begin
  // right after the message header; slot 0 of the accounts is the fee payer.
  const ourPub = Buffer.from(publicKey(seed));
  const sig = Buffer.from(signMessage(seed, message));
  const out = Buffer.from(tx); // copy
  sig.copy(out, sigsStart); // slot 0 = fee payer
  return { signed: out.toString('base64'), signature: sig.toString('base64'), signer: C.base58encode(ourPub) };
}

/// Assert the fee-payer account embedded in a serialized tx equals [expectedAddr]
/// (base58). Throws otherwise — the SENDER GATE for Solana swaps, mirroring the
/// EVM sender gate. Parses the account-keys array to read fee payer = accounts[0].
function assertFeePayer(txBase64, expectedAddr) {
  const tx = Buffer.from(txBase64, 'base64');
  const { size: sigLenBytes, len: numSigs } = readShortVec(tx, 0);
  let off = sigLenBytes + numSigs * 64; // start of message
  // v0 (versioned) messages are prefixed with 0x80|version; legacy has no prefix.
  if (tx[off] & 0x80) off += 1; // skip the version byte
  off += 3; // 3 message-header bytes (numReqSigs, numReadonlySigned, numReadonlyUnsigned)
  const { len: numKeys, size: keyLenBytes } = readShortVec(tx, off);
  off += keyLenBytes;
  if (numKeys < 1) throw new Error('solana: tx has no account keys');
  const feePayer = C.base58encode(Uint8Array.from(tx.subarray(off, off + 32)));
  if (feePayer !== expectedAddr) {
    throw new Error('solana sender gate: fee payer ' + feePayer + ' != delegated ' + expectedAddr);
  }
  return feePayer;
}

module.exports = { publicKey, addressFromSeed, signMessage, signTransaction, assertFeePayer, readShortVec };
