/**
 * A Blockle Protect cryptographic identity.
 *
 * Keys are SEPARATED by purpose (never reused across roles), per the security
 * design:
 *   - kem  (ML-KEM-768): establishes shared secrets that WRAP per-file data keys
 *   - dsa  (ML-DSA-65):  signs manifests (proves control of the signing key)
 *
 * A "recipient" (device / recovery / share target) is addressed by a short,
 * stable id derived from its KEM public key. Recovery and sharing are modeled as
 * additional recipients — a file's data key is wrapped once per recipient — so
 * recovery is the user's own second key, NOT a server-held backdoor.
 */
import { kem, dsa, sha384, type Bytes } from './primitives.js'
import { toBase64Url } from './encoding.js'

export interface PublicIdentity {
  /** base64url ML-KEM-768 public key (1184 bytes) — the key files are wrapped to. */
  kemPublicKey: string
  /** base64url ML-DSA-65 public key (1952 bytes) — the key manifests are verified with. */
  dsaPublicKey: string
  /** Short stable recipient id of the KEM key: base64url(SHA-384(kemPublicKey))[:22]. */
  recipientId: string
}

export interface SecretIdentity {
  kemSecretKey: Bytes // ML-KEM-768 (2400 bytes)
  dsaSecretKey: Bytes // ML-DSA-65 (4032 bytes)
}

export interface Identity {
  public: PublicIdentity
  secret: SecretIdentity
}

/** Short stable id for any KEM public key (used as the `recipient` field). */
export function recipientIdFor(kemPublicKey: Bytes): string {
  return toBase64Url(sha384(kemPublicKey)).slice(0, 22)
}

/** Fresh random identity (e.g. a new device key). */
export function generateIdentity(): Identity {
  const k = kem.keygen()
  const d = dsa.keygen()
  return {
    public: {
      kemPublicKey: toBase64Url(k.publicKey),
      dsaPublicKey: toBase64Url(d.publicKey),
      recipientId: recipientIdFor(k.publicKey)
    },
    secret: { kemSecretKey: k.secretKey, dsaSecretKey: d.secretKey }
  }
}

/**
 * Deterministic identity from a 96-byte recovery seed (64 for KEM, 32 for DSA).
 * The seed is what a user's recovery phrase expands to; reconstructing it on a
 * new device restores both keys WITHOUT any server escrow.
 */
export function identityFromSeed(seed96: Bytes): Identity {
  if (seed96.length !== 96) throw new Error('identityFromSeed: seed must be 96 bytes')
  const k = kem.keygenFromSeed(seed96.subarray(0, 64))
  const d = dsa.keygenFromSeed(seed96.subarray(64, 96))
  return {
    public: {
      kemPublicKey: toBase64Url(k.publicKey),
      dsaPublicKey: toBase64Url(d.publicKey),
      recipientId: recipientIdFor(k.publicKey)
    },
    secret: { kemSecretKey: k.secretKey, dsaSecretKey: d.secretKey }
  }
}
