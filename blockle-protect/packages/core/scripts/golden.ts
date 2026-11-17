/**
 * Generate golden cross-platform vectors from the audited TS core. The Swift PQ
 * core MUST reproduce every one of these byte-for-byte, which is how we prove a
 * proof made on iOS verifies in the browser/backend and vice-versa. Run:
 *   node --import tsx scripts/golden.ts > ../../ios/Tests/golden-vectors.json
 */
import {
  sha384, hkdfSha384, aesGcmEncrypt, kem, dsa,
  toBase64Url, toHex, utf8, canonicalJson, canonicalJsonBytes,
  merkleTree, hashLeaf,
} from '../src/index.js'

function hex(b: Uint8Array): string { return toHex(b) }
const te = new TextEncoder()

// Deterministic inputs (fixed bytes so the vector is stable).
const seed32 = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff)   // ML-DSA keygen seed
const seed64 = new Uint8Array(64).map((_, i) => (i * 5 + 3) & 0xff)   // ML-KEM keygen seed
const aesKey = new Uint8Array(32).map((_, i) => (i * 3 + 9) & 0xff)
const nonce  = new Uint8Array(12).map((_, i) => (i * 2 + 1) & 0xff)
const ikm    = new Uint8Array(32).fill(0x11)
const salt   = te.encode('golden-salt')
const info   = te.encode('blockle-protect/v1/kek')
const pt     = te.encode('The quick brown fox jumps over the lazy dog.')
const aad    = te.encode('blockle-protect/v1/content')

// ML-DSA: deterministic keygen + a verify vector (sign then prove verify==true).
const dkey = dsa.keygenFromSeed(seed32)
const dsaMsg = te.encode('sign me — manifest signing bytes stand-in')
const dsaSig = dsa.sign(dkey.secretKey, dsaMsg)

// ML-KEM: deterministic keygen; encapsulate to the pubkey; Swift must decapsulate
// the SAME cipherText with the seed-derived secret key and recover sharedSecret.
const kkey = kem.keygenFromSeed(seed64)
const kenc = kem.encapsulate(kkey.publicKey)

// Canonical JSON: a representative manifest-shaped object with nested object +
// array + an optional field, to pin key-sorting + escaping.
const sampleManifest = {
  v: 1,
  algo: { kem: 'ML-KEM-768', sig: 'ML-DSA-65', cipher: 'AES-256-GCM', hash: 'SHA-384', kdf: 'HKDF-SHA-384' },
  fileId: 'AAECAwQFBgcICQoLDA0ODw',
  fingerprint: toBase64Url(sha384(pt)),
  size: pt.length,
  contentNonce: toBase64Url(nonce),
  wraps: [{ recipient: 'r1', kind: 'device', kemCipherText: 'zz', wrapNonce: 'nn', wrappedKey: 'ww' }],
  signerPublicKey: toBase64Url(dkey.publicKey),
  createdAt: 1700000000,
  label: 'quarterly "report" / Q3\tfinal',
}

// Merkle: four fixed commitments → root + inclusion proof for index 1.
const commitments = [0x11, 0x22, 0x33, 0x44].map(b => new Uint8Array(48).fill(b))
const tree = merkleTree(commitments)

const vectors = {
  note: 'Golden cross-platform vectors from @blockle-protect/core. Swift must reproduce every field.',
  sha384: { input_utf8: 'The quick brown fox jumps over the lazy dog.', output_hex: hex(sha384(pt)) },
  hkdfSha384: {
    ikm_hex: hex(ikm), salt_utf8: 'golden-salt', info_utf8: 'blockle-protect/v1/kek',
    length: 32, output_hex: hex(hkdfSha384(ikm, salt, info, 32)),
  },
  aesGcm: {
    key_hex: hex(aesKey), nonce_hex: hex(nonce), aad_utf8: 'blockle-protect/v1/content',
    plaintext_utf8: 'The quick brown fox jumps over the lazy dog.',
    ciphertext_and_tag_hex: hex(aesGcmEncrypt(aesKey, nonce, pt, aad)),
  },
  canonicalJson: {
    value: sampleManifest,
    canonical_string: canonicalJson(sampleManifest),
    canonical_sha384_hex: hex(sha384(canonicalJsonBytes(sampleManifest))),
  },
  merkle: {
    commitments_hex: commitments.map(hex),
    leaf1_hex: hex(hashLeaf(commitments[1]!)),
    root_hex: hex(tree.root),
    proof_index1: tree.proof(1),
  },
  mldsa65: {
    seed32_hex: hex(seed32),
    publicKey_hex: hex(dkey.publicKey),
    message_utf8: 'sign me — manifest signing bytes stand-in',
    signature_hex: hex(dsaSig),          // Swift verify(pub,msg,sig) must be true
    verifies: dsa.verify(dkey.publicKey, dsaMsg, dsaSig),
  },
  mlkem768: {
    seed64_hex: hex(seed64),
    publicKey_hex: hex(kkey.publicKey),
    cipherText_hex: hex(kenc.cipherText),       // Swift decapsulate(ct, seedKey) must equal:
    sharedSecret_hex: hex(kenc.sharedSecret),
  },
}

// sanity: round-trip our own vectors before emitting
if (!dsa.verify(dkey.publicKey, dsaMsg, dsaSig)) throw new Error('self-check: dsa verify failed')
if (hex(kem.decapsulate(kenc.cipherText, kkey.secretKey)) !== hex(kenc.sharedSecret)) throw new Error('self-check: kem decapsulate mismatch')

process.stdout.write(JSON.stringify(vectors, null, 2) + '\n')
