# Blockle Accounts — spec + threat model

Email/password accounts for **blockle.org** (the site/portal), with three capabilities —
**identity**, a **paid tier**, and **zero-knowledge wallet backup** — built on one hard line:

> **Non-custodial, always.** The server never holds a private key, a seed, a plaintext
> wallet, a balance, or a signer. It stores credentials, a subscription flag, and an
> **opaque ciphertext blob** it cannot decrypt. Losing the account never loses funds;
> a server breach never yields a key.

New service `services/accounts/` (loopback + nginx TLS, mirrors `reserve-signer`/`agent-gateway`).

## 1. Auth (hardened)

- **Password hashing:** scrypt via Node's built-in `crypto` (N=2^15, r=8, p=1, 32-byte
  key, 16-byte random salt) — zero native deps, strong — OR argon2id if the dep builds on
  the box. Never store or log the password or hash alongside the email in plaintext logs.
- **Verification + reset:** email a single-use, time-boxed (15 min) token (32 random bytes,
  stored hashed); verify before login is usable; reset invalidates all sessions.
- **2FA:** TOTP (RFC 6238, 30s, SHA-1, 6 digits) enrolled with a QR + recovery codes;
  optional WebAuthn/passkey later. 2FA required to reveal/download the backup blob.
- **Sessions:** opaque 32-byte token in an **httpOnly, Secure, SameSite=Lax** cookie, 15-min
  idle + sliding refresh, server-side session store; **CSRF** token on every mutating form.
  Logout + password-change revoke all sessions.
- **Abuse:** per-IP + per-account rate limits on login/register/reset; exponential lockout
  after N failures; constant-time compares; generic errors (never "no such email"); a
  global kill flag. All secrets from env, never the repo.

## 2. Paid tier

- One plan (config: name, price, interval; `trialDays` default 0). **PayPal Subscriptions**
  (sandbox in dev, live creds in prod env only) — server creates the subscription, client
  follows the approval link as a full redirect (PWA/iOS-safe). **Entitlement is granted and
  revoked ONLY by verified PayPal webhooks** (signature-verified, idempotent by event id),
  never by the return URL. A lapsed subscription drops the tier but **never** restricts
  withdrawing funds or downloading the backup. x402 accepted as an alternative rail.
- Entitlement is a server flag checked at login + periodically; it gates site features
  (pro bot templates, higher hosted-agent quota) — never key access.

## 3. Zero-knowledge wallet backup

- The **wallet** (client) encrypts its vault with a key derived from a **separate backup
  passphrase** (NOT the account password) via scrypt/HKDF → AES-256-GCM. Only the
  **ciphertext + non-secret metadata** (version, kdf params, salt, nonce, createdAt,
  device label) are uploaded, keyed to the account.
- The server **stores and returns the blob; it can never decrypt it** (no passphrase, no
  key material ever leaves the device). Recovery on a new device: authenticate → (2FA) →
  download blob → decrypt locally with the backup passphrase. A forgotten backup passphrase
  = an unrecoverable blob (by design); the wallet still has its normal seed-phrase recovery.
- Endpoints: `PUT /backup` (store ciphertext, size-capped, versioned), `GET /backup`
  (return latest + list versions), `DELETE /backup`. All require a live session + 2FA.

## 4. Threat model (what a breach must NOT yield)

- **Server/DB breach** → attacker gets email + scrypt hashes + subscription flags +
  **undecryptable** backup blobs. No keys, seeds, balances, or plaintext.
- **Stolen session** → bounded by idle TTL + 2FA on sensitive ops; revocable.
- **Malicious server operator** → still cannot decrypt a backup or move funds (client-side
  crypto; the wallet signs locally).
- **Phishing** → generic errors, verified email, 2FA; the site never asks for a seed/backup
  passphrase server-side.

## 5. Tests (must assert the security properties)

scrypt hash verifies + rejects wrong password timing-safely; a stored backup is **byte-for-byte
ciphertext the server cannot decrypt** (no plaintext path exists); verification/reset tokens are
single-use + expire; rate-limit/lockout engages; sessions are httpOnly/Secure/SameSite + revoked
on reset; CSRF enforced; entitlement flips only on a (mock) verified webhook, never the return
URL; a lapsed plan still allows backup download; no secret/password/token is ever logged. Email +
PayPal are behind injectable interfaces (stub in tests, sandbox in dev, live creds in prod env).

## 5a. Post-quantum posture

The brief is "post-quantum entirely." What that means concretely, layer by layer:

- **Application + at-rest crypto is already post-quantum-safe, by construction.** Everything the
  service touches is *symmetric*: scrypt (passwords), HMAC-SHA1 (TOTP), SHA-256 (token hashing),
  AES-256-GCM (the client-side backup envelope), and CSPRNG (sessions/tokens). There is **no
  RSA/EC/ECDSA/DH/X25519 anywhere in our code** — so there is nothing for Shor's algorithm to
  break. Grover only halves symmetric strength, and AES-256 / SHA-256 are chosen so the
  post-quantum margin is still ≥128-bit. This is enforced in CI by `test/postquantum.test.js`,
  which fails the build if any asymmetric primitive appears in the source.
- **Zero-knowledge backup envelope:** AES-256-GCM with the key derived from the user's *backup
  passphrase* via a memory-hard KDF (Argon2id preferred, scrypt acceptable). Passphrase-symmetric
  means no public key is involved, so the blob is post-quantum secure end-to-end and even a
  "harvest-now-decrypt-later" capture of TLS yields only PQ-encrypted ciphertext.
- **TLS transport is the one genuinely asymmetric layer, and it's external to this code.** The
  box runs OpenSSL 3.0.13, which predates native ML-KEM (that's OpenSSL 3.5, 2025), so a
  hybrid X25519MLKEM768 key exchange isn't available on the stock edge today. We do **not**
  rebuild OpenSSL/nginx on the live prod box casually. The planned upgrade path: move the edge to
  OpenSSL 3.5+ (or load the oqs-provider) and enable `X25519MLKEM768` as the preferred group —
  tracked as a follow-up. Note the sensitive payload (the wallet vault) is already PQ-encrypted
  before it reaches TLS, so this gap does not expose keys even under harvest-now-decrypt-later.
- **PayPal** is a third party; its API/transport crypto is outside our control and is not part of
  the PQ guarantee. No key material flows through it.

## 6. Go-live preflight (operator-provided)

A transactional email provider + domain SPF/DKIM; PayPal Business + REST app (client id/secret/
webhook id); a decision on the account DB (better-sqlite3 vs Postgres vs file store). Until these
are wired, the service runs with stubbed email + PayPal sandbox and is NOT deployed to prod. A
security review runs before it handles real credentials or money.
