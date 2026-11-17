# Blockle Protect — Manifest & Proof Specification (v1)

The normative, cross-platform format. iOS (Swift), the web verifier, and the
backend MUST produce and verify these bytes **identically**. The reference
implementation is `packages/core`.

## Canonicalization

All signed/committed bytes are **canonical JSON**: object keys sorted
lexicographically (UTF-16 code-unit order), no insignificant whitespace, strings
JSON-escaped, `undefined` fields omitted. Binary fields are **base64url** (no
padding). This makes the signed bytes identical on every runtime.

## Algorithm suite (`algo`)

```json
{ "kem":"ML-KEM-768","sig":"ML-DSA-65","cipher":"AES-256-GCM","hash":"SHA-384","kdf":"HKDF-SHA-384" }
```

## Manifest (the signed body)

```jsonc
{
  "v": 1,
  "algo": { ... },
  "fileId": "<b64url 16B random id>",     // not secret, not the hash
  "fingerprint": "<b64url SHA-384(plaintext)>",
  "size": 12345,                           // plaintext bytes
  "contentNonce": "<b64url 12B AES-GCM nonce>",
  "wraps": [                               // data key wrapped per recipient
    {
      "recipient": "<b64url(SHA-384(kemPublicKey))[:22]>",
      "kind": "device" | "recovery" | "share",
      "kemCipherText": "<b64url 1088B ML-KEM-768 encapsulation>",
      "wrapNonce": "<b64url 12B>",
      "wrappedKey": "<b64url AES-256-GCM(KEK) over the 32B data key (ct‖tag)>"
    }
  ],
  "signerPublicKey": "<b64url 1952B ML-DSA-65 public key>",
  "createdAt": 1731800000,                 // unix seconds (NOT proof of authorship)
  "label": "optional user label"
}
```

### Content encryption
`ciphertext = AES-256-GCM(DEK, contentNonce).encrypt(plaintext, aad)` where
`aad = utf8("blockle-protect/v1/content") ‖ fileId ‖ fingerprint ‖ utf8(size)`.
The AAD binds the ciphertext to its manifest header.

### Key wrap (per recipient)
```
(kemCipherText, ss) = ML-KEM-768.encapsulate(recipient.kemPublicKey)
KEK  = HKDF-SHA-384(ikm=ss, salt=fileId, info=utf8("blockle-protect/v1/kek"), len=32)
wrappedKey = AES-256-GCM(KEK, wrapNonce).encrypt(DEK, aad=utf8("blockle-protect/v1/dek-wrap"))
```
Unwrap is the mirror: `decapsulate → HKDF → AES-GCM.decrypt`.

## Signed manifest

```jsonc
{ "manifest": { ...Manifest }, "signature": "<b64url ML-DSA-65 over canonicalJson(manifest)>" }
```

## Commitment & anchoring

```
commitment = SHA-384( canonicalJson(SignedManifest) )        // 48 bytes, the Merkle leaf
leaf       = SHA-384( 0x00 ‖ commitment )
node       = SHA-384( 0x01 ‖ left ‖ right )                  // domain-separated
root       = Merkle root over a batch (odd level duplicates last)
```
The 48-byte `root` is anchored on Blockle via `ContractAction::Call{ input=root }`
(or, fallback, as a burn-output recipient). The anchoring transaction is paid by
an app-managed wallet — consumers never need BLOCK.

## Portable proof (v1)

```jsonc
{
  "v": 1,
  "signed": { "manifest": {...}, "signature": "..." },
  "commitment": "<b64url SHA-384(signed manifest)>",
  "merkleProof": { "leafIndex": 0, "siblings": [ { "hash":"<b64url>", "side":"left|right" } ] },
  "anchor": { "chain":"blockle", "txid":"<hex>", "root":"<b64url>", "height":49000, "blockTime":1731800000 }
}
```

## Verification procedure (independent — no Blockle Protect server)

1. **Signature** — `ML-DSA-65.verify(signed.manifest.signerPublicKey, canonicalJson(manifest), signed.signature)`.
2. **Commitment** — `SHA-384(canonicalJson(signed)) == base64url_decode(commitment)`.
3. **Inclusion** — fold `merkleProof.siblings` from the leaf up; result must equal `anchor.root`.
4. **Anchor (optional, online)** — read `GET {publicChain}/explorer/tx/<anchor.txid>`; confirm it carries `anchor.root`. This read is against the **public Blockle chain**, not our backend.
5. **File match (optional)** — `SHA-384(file) == manifest.fingerprint`.

A verifier that passes 1–3 (and 4 if online) and 5 has established, without
trusting Blockle Protect, that *this exact file* was committed under *this
signing key* and anchored on-chain at the referenced transaction.

## Versioning

`v` on the manifest and proof gates all format changes. HKDF `info` strings are
version-scoped (`blockle-protect/v1/...`) so a future suite derives independent
keys and can never collide with v1 material.
