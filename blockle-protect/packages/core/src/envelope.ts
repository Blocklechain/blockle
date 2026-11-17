/**
 * Envelope encryption — the heart of local protection.
 *
 * protect():
 *   1. Generate a fresh random 256-bit data-encryption key (DEK) for THIS file.
 *   2. Encrypt the file with AES-256-GCM(DEK), AAD = the manifest header, so the
 *      ciphertext is cryptographically bound to its metadata.
 *   3. Wrap the DEK to each authorized recipient with ML-KEM-768:
 *        (kemCt, ss) = KEM.encapsulate(recipient.kemPublicKey)
 *        KEK        = HKDF-SHA-384(ss, salt=fileId, info="…/kek")
 *        wrappedKey = AES-256-GCM(KEK).encrypt(DEK)
 *   4. Build the manifest (fingerprint = SHA-384(plaintext), wraps, algos, …).
 *
 * unprotect(): the mirror — KEM.decapsulate → HKDF → unwrap DEK → AES-GCM decrypt.
 *
 * The DEK exists only in memory during the operation and is never stored or
 * logged. The server never sees the DEK, the plaintext, or any secret key.
 */
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  hkdfSha384,
  kem,
  randomBytes,
  sha384,
  SIZES,
  type Bytes
} from './primitives.js'
import { toBase64Url, fromBase64Url, utf8, bytesEqual, concatBytes } from './encoding.js'
import { ALGO, CONTEXT, MANIFEST_VERSION, type Manifest, type WrapEntry } from './manifest.js'
import { recipientIdFor, type PublicIdentity } from './identity.js'

export interface Recipient {
  kemPublicKey: Bytes
  kind: WrapEntry['kind']
}

export interface ProtectResult {
  /** AES-256-GCM ciphertext of the file content (ct‖tag). */
  ciphertext: Bytes
  /** The unsigned manifest (sign it next with signManifest). */
  manifest: Manifest
}

/** The header bytes used as GCM AAD for the content: binds ciphertext⇆metadata. */
function contentAad(fileId: Bytes, fingerprint: Bytes, size: number): Bytes {
  return concatBytes(utf8(CONTEXT.contentAad), fileId, fingerprint, utf8(String(size)))
}

/** Derive the KEK and wrap the DEK for one recipient. */
function wrapDekFor(dek: Bytes, fileId: Bytes, recipient: Recipient): WrapEntry {
  const { cipherText, sharedSecret } = kem.encapsulate(recipient.kemPublicKey)
  const kek = hkdfSha384(sharedSecret, fileId, utf8(CONTEXT.kek), SIZES.aesKey)
  const wrapNonce = randomBytes(SIZES.gcmNonce)
  const wrappedKey = aesGcmEncrypt(kek, wrapNonce, dek, utf8(CONTEXT.wrapAad))
  return {
    recipient: recipientIdFor(recipient.kemPublicKey),
    kind: recipient.kind,
    kemCipherText: toBase64Url(cipherText),
    wrapNonce: toBase64Url(wrapNonce),
    wrappedKey: toBase64Url(wrappedKey)
  }
}

/**
 * Encrypt + wrap a file to one or more recipients (the owner's device key, a
 * recovery key, and any share targets). `signerPublicKey` is the owner's
 * ML-DSA-65 public key that will sign the manifest.
 */
export function protect(
  plaintext: Bytes,
  recipients: Recipient[],
  signerPublicKey: Bytes,
  opts: { label?: string; now?: number } = {}
): ProtectResult {
  if (recipients.length === 0) throw new Error('protect: at least one recipient required')
  const dek = randomBytes(SIZES.aesKey)
  const fileId = randomBytes(16)
  const fingerprint = sha384(plaintext)
  const contentNonce = randomBytes(SIZES.gcmNonce)
  const aad = contentAad(fileId, fingerprint, plaintext.length)
  const ciphertext = aesGcmEncrypt(dek, contentNonce, plaintext, aad)

  const wraps = recipients.map((r) => wrapDekFor(dek, fileId, r))
  dek.fill(0) // best-effort scrub

  const manifest: Manifest = {
    v: MANIFEST_VERSION,
    algo: ALGO,
    fileId: toBase64Url(fileId),
    fingerprint: toBase64Url(fingerprint),
    size: plaintext.length,
    contentNonce: toBase64Url(contentNonce),
    wraps,
    signerPublicKey: toBase64Url(signerPublicKey),
    createdAt: opts.now ?? Math.floor(Date.now() / 1000),
    ...(opts.label !== undefined ? { label: opts.label } : {})
  }
  return { ciphertext, manifest }
}

/** Add a new recipient (share / recovery) to an existing file without
 *  re-encrypting its content: unwrap the DEK with `holder`, re-wrap to `to`.
 *  Returns the new WrapEntry to append to a RE-SIGNED manifest. */
export function addRecipient(
  manifest: Manifest,
  holderSecret: { kemSecretKey: Bytes; recipientId: string },
  to: Recipient
): WrapEntry {
  const dek = recoverDek(manifest, holderSecret)
  const fileId = fromBase64Url(manifest.fileId)
  const entry = wrapDekFor(dek, fileId, to)
  dek.fill(0)
  return entry
}

/** Recover the raw DEK from a manifest using a holder's KEM secret key. */
export function recoverDek(
  manifest: Manifest,
  holder: { kemSecretKey: Bytes; recipientId: string }
): Bytes {
  const entry = manifest.wraps.find((w) => w.recipient === holder.recipientId)
  if (!entry) throw new Error('recoverDek: this identity is not an authorized recipient')
  const ss = kem.decapsulate(fromBase64Url(entry.kemCipherText), holder.kemSecretKey)
  const kek = hkdfSha384(ss, fromBase64Url(manifest.fileId), utf8(CONTEXT.kek), SIZES.aesKey)
  return aesGcmDecrypt(kek, fromBase64Url(entry.wrapNonce), fromBase64Url(entry.wrappedKey), utf8(CONTEXT.wrapAad))
}

/**
 * Decrypt a protected file for an authorized recipient and VERIFY integrity
 * (the GCM tag + the SHA-384 fingerprint). Throws if the ciphertext was
 * tampered with or does not match the manifest fingerprint.
 */
export function unprotect(
  ciphertext: Bytes,
  manifest: Manifest,
  holder: { kemSecretKey: Bytes; recipientId: string }
): Bytes {
  const dek = recoverDek(manifest, holder)
  const fileId = fromBase64Url(manifest.fileId)
  const fingerprint = fromBase64Url(manifest.fingerprint)
  const aad = contentAad(fileId, fingerprint, manifest.size)
  let plaintext: Bytes
  try {
    plaintext = aesGcmDecrypt(dek, fromBase64Url(manifest.contentNonce), ciphertext, aad)
  } finally {
    dek.fill(0)
  }
  if (!bytesEqual(sha384(plaintext), fingerprint)) {
    throw new Error('unprotect: fingerprint mismatch — file does not match its manifest')
  }
  return plaintext
}

/** Verify a file's plaintext matches a manifest's fingerprint (integrity check
 *  with no decryption / no keys — for the File Integrity Monitor). */
export function verifyFingerprint(plaintext: Bytes, manifest: Manifest): boolean {
  return bytesEqual(sha384(plaintext), fromBase64Url(manifest.fingerprint))
}

/** Convenience: build a Recipient from a PublicIdentity. */
export function recipientFromIdentity(id: PublicIdentity, kind: WrapEntry['kind']): Recipient {
  return { kemPublicKey: fromBase64Url(id.kemPublicKey), kind }
}
