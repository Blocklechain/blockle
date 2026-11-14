/**
 * crypto.ts — passphrase sealing for the on-device wallet vault.
 *
 * WebCrypto only: PBKDF2-SHA-256 (310,000 iterations) → AES-256-GCM.
 * Plaintext key material exists only transiently; intermediate byte buffers
 * are zeroed after use. (JS strings are immutable and cannot be wiped — the
 * decrypted hex key lives as a string for the unlock session only, never
 * persisted, never transmitted.)
 */

const PBKDF2_ITERS = 310_000

export interface SealedVault {
  v: 1
  kdf: 'PBKDF2-SHA-256'
  iters: number
  /** base64 */
  salt: string
  /** base64 */
  iv: string
  /** base64 AES-GCM ciphertext */
  ct: string
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function wipe(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0)
}

function requireSubtle(): SubtleCrypto {
  if (!crypto?.subtle) {
    throw new Error(
      'WebCrypto unavailable — the wallet needs a secure context (https:// or localhost)'
    )
  }
  return crypto.subtle
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iters: number
): Promise<CryptoKey> {
  const subtle = requireSubtle()
  const passBytes = new TextEncoder().encode(passphrase)
  try {
    const baseKey = await subtle.importKey('raw', passBytes as BufferSource, 'PBKDF2', false, [
      'deriveKey'
    ])
    return await subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iters },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  } finally {
    wipe(passBytes)
  }
}

/** Encrypt a JSON-serialisable secret payload under `passphrase`. */
export async function seal(payload: unknown, passphrase: string): Promise<SealedVault> {
  const subtle = requireSubtle()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERS)
  const plain = new TextEncoder().encode(JSON.stringify(payload))
  try {
    const ct = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource)
    )
    return {
      v: 1,
      kdf: 'PBKDF2-SHA-256',
      iters: PBKDF2_ITERS,
      salt: toB64(salt),
      iv: toB64(iv),
      ct: toB64(ct)
    }
  } finally {
    wipe(plain)
  }
}

/**
 * Decrypt a sealed vault. Throws on a wrong passphrase (GCM auth failure)
 * or a corrupt blob.
 */
export async function open<T>(vault: SealedVault, passphrase: string): Promise<T> {
  const subtle = requireSubtle()
  const salt = fromB64(vault.salt)
  const iv = fromB64(vault.iv)
  const ct = fromB64(vault.ct)
  const key = await deriveAesKey(passphrase, salt, vault.iters || PBKDF2_ITERS)
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource)
    )
  } catch {
    throw new Error('wrong passphrase')
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } finally {
    wipe(plain)
  }
}
