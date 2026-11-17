# Blockle Protect

**An independent post-quantum security layer for your files and cloud storage.**
By Alienbeing LLC · powered by the Blockle blockchain · `protect.blockle.org` (proposed)

> Your digital life. Protected for the future.

Blockle Protect encrypts and signs your important files locally with post-quantum
cryptography, keeps them in the cloud storage you already use (Apple iCloud
first), and anchors tamper-evident proofs on the Blockle chain — so anyone can
verify a file's integrity and authenticity independently, without trusting our
servers. Users never have to understand keys, signatures, or quantum computing.

---

## Architecture (three layers)

```
            ┌──────────────────────────────────────────────────────────┐
  LAYER 1   │  BLOCKLE PQ SECURITY (on device, zero server trust)       │
            │  per-file AES-256-GCM  ·  ML-KEM-768 key-wrap  ·          │
            │  ML-DSA-65 manifest signature  ·  SHA-384 fingerprint     │
            └──────────────────────────────────────────────────────────┘
                              │ encrypted copy + manifest
            ┌──────────────────────────────────────────────────────────┐
  LAYER 2   │  APPLE iCLOUD  (Files / Photos / CloudKit — user's own)   │
            │  originals untouched; Blockle stores an ENCRYPTED copy     │
            └──────────────────────────────────────────────────────────┘
                              │ commitment only (never the file)
            ┌──────────────────────────────────────────────────────────┐
  LAYER 3   │  BLOCKLE CHAIN  (Merkle root of a batch, one cheap tx)    │
            │  independently verifiable at /explorer/tx/<txid>           │
            └──────────────────────────────────────────────────────────┘
```

Nothing private ever leaves the device unencrypted. On-chain we store only a
SHA-384 Merkle root — no file names, no contents, no keys.

---

## Reusing the Blockle platform (verified infra map)

| Need | Reused Blockle component |
|---|---|
| PQ signatures | `@noble/post-quantum` ML-DSA-65 (stronger than the chain wallet's ML-DSA-44; **separate key**) |
| PQ key wrapping | `@noble/post-quantum` ML-KEM-768 (chain uses ML-KEM-768 for shielded notes; we use it for file-key wrapping) |
| Anchoring a commitment | `ContractAction::Call { input }` — the Merkle root as the call input; built via wasm `build_call`, submitted with `submitrawtransaction` |
| Chain RPC | aux-http `http://127.0.0.1:8445` (public `blockle.org/api/*`): `submitrawtransaction`, `GET /explorer/tx/<txid>`, `/explorer/utxos/<addr>` |
| Fees (no BLOCK for users) | app-managed hot wallet pays one batched anchor tx for thousands of files (same pool-wallet pattern as the gas-sponsor) |
| Accounts / auth | accounts-service pattern: cookie-session + per-session CSRF, JSON store, `entitledTier`/`paid` entitlements |
| Subscriptions | `iap.js` StoreKit `verifyReceipt` (prod→sandbox fallback), Google Play, PayPal — all mapping to tiers |

Gaps we own: ML-KEM is not yet in the Blockle wasm bundle (we use audited
`@noble`), and there is no native Swift PQC (iOS will bridge this core's spec).

---

## Build status

### ✅ Phase 1 — Cryptographic core (`packages/core`) — DONE & TESTED
Real, audited primitives only (`@noble`). **13/13 tests pass, typecheck clean.**

- **Envelope encryption** — unique per-file DEK, AES-256-GCM, AAD-bound to the manifest.
- **ML-KEM-768 key wrapping** — DEK wrapped to each recipient (device / recovery / share); HKDF-SHA-384 KEK.
- **ML-DSA-65 signed, versioned manifest** — canonical-JSON, byte-stable across runtimes.
- **Merkle batching** (SHA-384, domain-separated) + inclusion proofs.
- **Portable proof** + **independent verification** (signature → commitment → inclusion → optional public-chain confirm). No server trust.
- **Recovery / device migration** — seed-derived identity, data keys wrapped to a user-held recovery key (no server escrow / no backdoor).
- **Sharing** — add a recipient without re-encrypting content.

Covered Definition-of-Done items (library level): **2, 3, 7, 8, 9, 10, 11**.

```
packages/core/
  src/primitives.ts   all algorithm choices pinned here (audit surface)
  src/encoding.ts     base64url + canonical JSON
  src/manifest.ts     versioned signed-manifest schema + ALGO suite
  src/identity.ts     separate KEM + DSA keys; seed-derived recovery
  src/envelope.ts     protect() / unprotect() / addRecipient() / recoverDek()
  src/sign.ts         signManifest() / verifyManifest()  (ML-DSA-65)
  src/merkle.ts       merkleTree() / verifyMerkleProof()
  src/proof.ts        buildProof() / verifyProof()  (independent)
  test/core.test.ts   KAT + roundtrip + tamper + recovery + sharing + proof
```

### ⏳ Roadmap
- **Phase 2 — Backend anchoring service** (TS): batch commitments → Merkle root → `build_call` → `submitrawtransaction`; proof retrieval; public verification API; accounts/entitlement reuse. DB + API spec land here.
- **Phase 3 — Public verification website** (`protect.blockle.org/verify`): upload a file or scan a QR, run `verifyProof()` in the browser against the public chain.
- **Phase 4 — iOS/iPadOS app** (SwiftUI): onboarding, Vault, iCloud Shield (Files + PhotosPicker), integrity monitor, StoreKit tiers. Mirrors `MANIFEST-SPEC.md` byte-for-byte; biometric unlock + Keychain/Secure-Enclave-protected key storage.
- **Phase 5 — Commercial**: StoreKit entitlements, landing page, privacy/terms, security docs.
- **Phase 6 — macOS/Windows/Android, Google Drive/Dropbox, Family, Enterprise API.**

See `docs/THREAT-MODEL.md` (honest security limits) and `docs/MANIFEST-SPEC.md`
(the cross-platform format every client must implement identically).

## Develop
```
cd packages/core && npm install && npm test && npm run typecheck
```
