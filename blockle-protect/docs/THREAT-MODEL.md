# Blockle Protect — Cryptographic Threat Model & Honest Claims

This document states what Blockle Protect **does** and, just as importantly,
what it **does not** guarantee. No production marketing claim may exceed what is
written here, and no security claim ships before independent cryptographic
review.

## Algorithms (pinned, audited, no invention)

| Role | Algorithm | Standard | Library |
|---|---|---|---|
| Key establishment / file-key wrap | ML-KEM-768 | FIPS 203 | `@noble/post-quantum` |
| Digital signatures (manifests) | ML-DSA-65 | FIPS 204 | `@noble/post-quantum` |
| Authenticated encryption | AES-256-GCM | NIST SP 800-38D | `@noble/ciphers` |
| Fingerprint / Merkle / commitment | SHA-384 | FIPS 180-4 | `@noble/hashes` |
| Key derivation | HKDF-SHA-384 | RFC 5869 | `@noble/hashes` |
| Randomness | CSPRNG | platform | `crypto.getRandomValues` |

ML-KEM is a **key-encapsulation mechanism**, used only to derive a shared secret
that wraps a data key. It is **never** used as a signature. ML-DSA is the only
signature algorithm. Keys are **separated by role** — encryption (KEM), signing
(DSA), recovery (a second KEM/DSA pair from a user-held seed), and account auth
(session credentials) are distinct and never reused.

## What a user gets

1. **Confidentiality** — a unique random 256-bit key encrypts each file with
   AES-256-GCM on device. The data key is wrapped to recipients with ML-KEM-768.
   The server never sees plaintext, the data key, or any secret key.
2. **Integrity / tamper-evidence** — the GCM tag plus a SHA-384 fingerprint
   detect any modification. A changed ciphertext or a changed file fails
   verification (proven by tests).
3. **Authenticity of the record** — the manifest is signed with ML-DSA-65.
4. **Independent, tamper-evident timestamping** — the manifest commitment is
   batched into a Merkle root anchored on the Blockle chain; anyone can verify
   inclusion against the public chain without our backend.

## What it explicitly does NOT claim

- **Not "unhackable."** Security depends on correct implementation, device
  integrity, user key custody, and the continued strength of the standards.
- **Not "quantum immunity."** ML-KEM/ML-DSA are *believed* resistant to known
  quantum attacks under current analysis; cryptography can be broken by future
  advances. We say "post-quantum," never "quantum-proof."
- **A timestamp is not proof of authorship.** The anchor proves a record existed
  at a point in time, not who created the underlying content.
- **A signature proves control of a signing key, not real-world identity.**
  Binding a key to a person/organization is a separate trust layer (verified
  publishers / certificates) and is clearly labeled as such.
- **A changed file is not automatically an attack.** Legitimate edits are normal;
  the Integrity Monitor distinguishes *expected* re-signed versions from
  *unexpected* changes and never cries wolf.

## Key lifecycle

- **Generation:** on device, from the platform CSPRNG (or deterministically from
  a user recovery seed). Secret keys never leave the device unencrypted.
- **Storage (iOS):** data keys and identity secrets live in Keychain, protected
  by the Secure Enclave and biometrics where available. NOTE: the Secure Enclave
  does **not** natively perform ML-DSA/ML-KEM today; those run in software with
  **hardware-backed protection of the key material** as a separate concern — we
  do not conflate the two.
- **Rotation:** identities can rotate; superseded manifests are re-signed and a
  new commitment anchored, preserving version history.
- **Recovery / device migration:** modeled as an **additional recipient** whose
  KEM key derives from the user's own recovery seed. Restoring that seed on a new
  device unwraps the data keys. There is **no server-held escrow and no
  undocumented central backdoor** — losing the seed with no other recipient means
  the data is unrecoverable, by design. This is documented to the user.

## Adversaries & mitigations (summary)

| Adversary | Mitigation |
|---|---|
| Cloud provider / server compromise | Server only ever holds ciphertext + public commitments; no keys, no plaintext. |
| Network attacker | TLS in transit; AEAD (GCM) + signatures detect tampering at rest. |
| Chain reorg / fake anchor | Verification requires the root to be found at a real, confirmed `txid` on the public chain. |
| Tampered manifest | Canonical bytes are ML-DSA-65 signed; any edit invalidates the signature. |
| Leaf/second-preimage on the Merkle tree | Domain-separated leaf (`0x00`) vs node (`0x01`) hashing. |
| Replay of an old version | Manifests carry a version + fileId; the latest anchored commitment supersedes. |
| Lost device | Recovery recipient (user seed) + optional family recovery contacts. |

## Before any production security claim

Threat modeling, cryptographic-design review, key-lifecycle review, fuzzing of
all parsers (manifest/proof JSON), known-answer tests (NIST vectors for the
primitives + our composite KATs), dependency scanning, and an **independent
third-party cryptographic review**. Until then, all claims stay bounded to this
document.
