/**
 * Manifest signing + verification (ML-DSA-65 / FIPS 204).
 *
 * A valid signature proves control of the signing key at signing time — it does
 * NOT by itself establish the real-world identity of the signer. Identity/trust
 * is a separate, higher layer (certificates, verified publishers).
 */
import { dsa, type Bytes } from './primitives.js'
import { fromBase64Url, toBase64Url } from './encoding.js'
import { manifestSigningBytes, type Manifest, type SignedManifest } from './manifest.js'

/** Sign a manifest with an ML-DSA-65 secret key. */
export function signManifest(manifest: Manifest, dsaSecretKey: Bytes): SignedManifest {
  const signature = dsa.sign(dsaSecretKey, manifestSigningBytes(manifest))
  return { manifest, signature: toBase64Url(signature) }
}

/** Verify a signed manifest against the public key embedded in its body. */
export function verifyManifest(signed: SignedManifest): boolean {
  const pub = fromBase64Url(signed.manifest.signerPublicKey)
  const msg = manifestSigningBytes(signed.manifest)
  const sig = fromBase64Url(signed.signature)
  try {
    return dsa.verify(pub, msg, sig)
  } catch {
    return false
  }
}
