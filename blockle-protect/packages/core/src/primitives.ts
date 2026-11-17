/**
 * Blockle Protect — cryptographic primitives.
 *
 * This is the ONLY module that talks to a crypto library directly. Every
 * algorithm choice is pinned here, with its standard, so a reviewer can audit
 * the whole cryptographic surface in one file. We invent nothing: all
 * primitives come from the @noble audited suite (constant-time, FIPS-vector
 * tested).
 *
 *   ML-KEM-768   FIPS 203  @noble/post-quantum  — post-quantum key establishment
 *   ML-DSA-65    FIPS 204  @noble/post-quantum  — post-quantum digital signatures
 *   AES-256-GCM  NIST SP 800-38D  @noble/ciphers — authenticated file/key encryption
 *   SHA-384      FIPS 180-4  @noble/hashes       — fingerprints + Merkle hashing
 *   HKDF-SHA-384 RFC 5869  @noble/hashes         — key derivation
 *   CSPRNG       platform  @noble/hashes/utils   — randomBytes (crypto.getRandomValues)
 *
 * ML-KEM is a Key Encapsulation Mechanism — used ONLY to establish a shared
 * secret that wraps a data key. It is never used as a signature. ML-DSA is the
 * only signature algorithm.
 */
import { gcm } from '@noble/ciphers/aes'
import { sha384 as nobleSha384 } from '@noble/hashes/sha2'
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf'
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils'
import { ml_kem768 } from '@noble/post-quantum/ml-kem'
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa'

export type Bytes = Uint8Array

// ---------------------------------------------------------------------------
// Sizes (bytes) — FIPS parameter sets. Asserted in tests against the library.
// ---------------------------------------------------------------------------
export const SIZES = {
  aesKey: 32, // AES-256
  gcmNonce: 12, // 96-bit GCM nonce (SP 800-38D recommended)
  gcmTag: 16,
  sha384: 48,
  mlkem768: { publicKey: 1184, secretKey: 2400, cipherText: 1088, sharedSecret: 32 },
  mldsa65: { publicKey: 1952, secretKey: 4032, signature: 3309 }
} as const

/** Cryptographically secure random bytes (platform CSPRNG). */
export function randomBytes(n: number): Bytes {
  return nobleRandomBytes(n)
}

/** SHA-384 fingerprint. */
export function sha384(data: Bytes): Bytes {
  return nobleSha384(data)
}

/** HKDF-SHA-384 key derivation. `length` defaults to a 256-bit key. */
export function hkdfSha384(ikm: Bytes, salt: Bytes, info: Bytes, length = 32): Bytes {
  return nobleHkdf(nobleSha384, ikm, salt, info, length)
}

// ---------------------------------------------------------------------------
// AES-256-GCM (authenticated). The output layout is `ciphertext || tag`.
// `aad` cryptographically binds associated data (e.g. the manifest header) to
// the ciphertext: tampering with the AAD makes decryption fail.
// ---------------------------------------------------------------------------
export function aesGcmEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad?: Bytes): Bytes {
  if (key.length !== SIZES.aesKey) throw new Error('aesGcmEncrypt: key must be 32 bytes (AES-256)')
  if (nonce.length !== SIZES.gcmNonce) throw new Error('aesGcmEncrypt: nonce must be 12 bytes')
  return gcm(key, nonce, aad).encrypt(plaintext)
}

/** Decrypt + verify the GCM tag. Throws if the tag or AAD do not verify. */
export function aesGcmDecrypt(key: Bytes, nonce: Bytes, ciphertextAndTag: Bytes, aad?: Bytes): Bytes {
  if (key.length !== SIZES.aesKey) throw new Error('aesGcmDecrypt: key must be 32 bytes (AES-256)')
  if (nonce.length !== SIZES.gcmNonce) throw new Error('aesGcmDecrypt: nonce must be 12 bytes')
  return gcm(key, nonce, aad).decrypt(ciphertextAndTag)
}

// ---------------------------------------------------------------------------
// ML-KEM-768 (FIPS 203) — post-quantum key establishment for key wrapping.
// ---------------------------------------------------------------------------
export const kem = {
  keygen(): { publicKey: Bytes; secretKey: Bytes } {
    const k = ml_kem768.keygen(nobleRandomBytes(64))
    return { publicKey: k.publicKey, secretKey: k.secretKey }
  },
  /** Encapsulate to a recipient public key → (cipherText, sharedSecret). */
  encapsulate(publicKey: Bytes): { cipherText: Bytes; sharedSecret: Bytes } {
    const e = ml_kem768.encapsulate(publicKey)
    return { cipherText: e.cipherText, sharedSecret: e.sharedSecret }
  },
  /** Recover the shared secret from the cipherText with the secret key. */
  decapsulate(cipherText: Bytes, secretKey: Bytes): Bytes {
    return ml_kem768.decapsulate(cipherText, secretKey)
  },
  /** Deterministic keygen from a 64-byte seed (for recovery-phrase-derived keys). */
  keygenFromSeed(seed64: Bytes): { publicKey: Bytes; secretKey: Bytes } {
    if (seed64.length !== 64) throw new Error('kem.keygenFromSeed: seed must be 64 bytes')
    const k = ml_kem768.keygen(seed64)
    return { publicKey: k.publicKey, secretKey: k.secretKey }
  }
}

// ---------------------------------------------------------------------------
// ML-DSA-65 (FIPS 204) — the ONLY digital signature algorithm.
// ---------------------------------------------------------------------------
export const dsa = {
  keygen(): { publicKey: Bytes; secretKey: Bytes } {
    const k = ml_dsa65.keygen(nobleRandomBytes(32))
    return { publicKey: k.publicKey, secretKey: k.secretKey }
  },
  sign(secretKey: Bytes, message: Bytes): Bytes {
    return ml_dsa65.sign(secretKey, message)
  },
  verify(publicKey: Bytes, message: Bytes, signature: Bytes): boolean {
    return ml_dsa65.verify(publicKey, message, signature)
  },
  /** Deterministic keygen from a 32-byte seed (for recovery-phrase-derived keys). */
  keygenFromSeed(seed32: Bytes): { publicKey: Bytes; secretKey: Bytes } {
    if (seed32.length !== 32) throw new Error('dsa.keygenFromSeed: seed must be 32 bytes')
    const k = ml_dsa65.keygen(seed32)
    return { publicKey: k.publicKey, secretKey: k.secretKey }
  }
}
