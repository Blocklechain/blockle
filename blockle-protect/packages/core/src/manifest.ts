/**
 * The protected-file manifest — the versioned, signed record that describes how
 * a file is protected WITHOUT revealing its contents. This is the single source
 * of truth every platform (iOS, web, backend) must produce and verify
 * identically; it is serialized with canonical JSON so an ML-DSA-65 signature is
 * byte-stable across runtimes.
 *
 * The manifest NEVER contains plaintext, the data-encryption key, or any secret
 * key. It contains the file fingerprint (SHA-384 of the plaintext), the wrapped
 * data key for each authorized recipient, and the algorithm identifiers.
 */
import { canonicalJsonBytes } from './encoding.js'

/** Bump ONLY on a breaking manifest-format change; verifiers branch on it. */
export const MANIFEST_VERSION = 1

/** The pinned algorithm suite. Written into every manifest so a verifier never
 *  has to guess, and so a future suite can coexist by version. */
export const ALGO = {
  kem: 'ML-KEM-768', //    FIPS 203 — wraps the per-file data key
  sig: 'ML-DSA-65', //     FIPS 204 — signs this manifest
  cipher: 'AES-256-GCM', // SP 800-38D — encrypts file content + wrapped key
  hash: 'SHA-384', //      FIPS 180-4 — fingerprint + Merkle + commitment
  kdf: 'HKDF-SHA-384' //   RFC 5869 — derives the key-wrapping key from the KEM secret
} as const

/** HKDF info/context strings (domain separation). Versioned so a format bump
 *  derives fresh keys and can never collide with v1 material. */
export const CONTEXT = {
  kek: 'blockle-protect/v1/kek', //        key-wrap KEK derivation
  contentAad: 'blockle-protect/v1/content', // AES-GCM AAD binding content to the header
  wrapAad: 'blockle-protect/v1/dek-wrap' //  AES-GCM AAD for the wrapped data key
} as const

/** One authorized recipient's wrapped copy of the file's data key.
 *  `recipient` is a short stable id = base64url(SHA-384(kemPublicKey))[:22]. */
export interface WrapEntry {
  recipient: string
  kind: 'device' | 'recovery' | 'share'
  kemCipherText: string // base64url — ML-KEM-768 encapsulation (1088 bytes)
  wrapNonce: string //     base64url — AES-GCM nonce (12 bytes)
  wrappedKey: string //    base64url — AES-GCM(KEK) over the 32-byte data key (ct‖tag)
}

/** The signed body. Everything here is public-safe metadata. */
export interface Manifest {
  v: number //              MANIFEST_VERSION
  algo: typeof ALGO
  fileId: string //         base64url random 16-byte id (not secret, not the hash)
  fingerprint: string //    base64url SHA-384(plaintext) — the integrity anchor
  size: number //           plaintext length in bytes
  contentNonce: string //   base64url AES-GCM nonce for the content (12 bytes)
  wraps: WrapEntry[] //      data key wrapped to each authorized recipient
  signerPublicKey: string // base64url ML-DSA-65 public key (1952 bytes)
  createdAt: number //       unix seconds. NOTE: a timestamp proves WHEN a record
  //                         was made, never WHO authored the underlying content.
  label?: string //          optional user label (kept inside the signed body)
}

/** A manifest plus its ML-DSA-65 signature over the canonical manifest bytes. */
export interface SignedManifest {
  manifest: Manifest
  signature: string // base64url ML-DSA-65 signature over canonicalJsonBytes(manifest)
}

/** The exact bytes that get signed: canonical JSON of the manifest body. */
export function manifestSigningBytes(manifest: Manifest): Uint8Array {
  return canonicalJsonBytes(manifest)
}

/** The on-chain commitment / Merkle leaf for a protected file: a SHA-384 over
 *  the canonical SIGNED record, so the anchor binds the manifest AND its
 *  signature. (Imported lazily to avoid a cycle with primitives.) */
export function signedManifestBytes(signed: SignedManifest): Uint8Array {
  return canonicalJsonBytes(signed)
}
