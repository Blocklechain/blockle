/**
 * @blockle-protect/core — the shared post-quantum cryptographic core.
 *
 * Audited primitives only (@noble). ML-KEM-768 wraps per-file data keys,
 * ML-DSA-65 signs manifests, AES-256-GCM encrypts content, SHA-384 fingerprints
 * and Merkle-batches, HKDF-SHA-384 derives wrapping keys. The same code powers
 * the backend anchoring service and the public verification website; iOS mirrors
 * this manifest/proof spec.
 */
export * from './primitives.js'
export * from './encoding.js'
export * from './manifest.js'
export * from './identity.js'
export * from './envelope.js'
export * from './sign.js'
export * from './merkle.js'
export * from './proof.js'
export * from './checkup.js'
