# Blockle hosted vault — a Coinbase-style account balance, without the custody

Goal: let someone log into their Blockle account from **any browser** and see/hold/eventually
trade their funds — the smooth, account-based feel of Coinbase — **without the platform ever
holding their keys or funds.** A server breach must still yield nothing spendable.

> **Non-custodial, enforced.** The server stores an opaque, client-encrypted vault blob it cannot
> decrypt (the same zero-knowledge backup from `docs/ACCOUNTS.md §3`), reads only **public**
> on-chain data, and **relays client-signed transactions** to the network. It never holds a
> private key, never signs, and cannot move a user's funds. This keeps Blockle out of the
> money-transmitter *custody* bucket by construction.

## How it works

1. **Vault = the account's zero-knowledge backup.** The wallet encrypts its vault on-device under
   the user's backup passphrase (PBKDF2-600k + AES-256-GCM, post-quantum-safe symmetric) and
   uploads only ciphertext. The backup metadata carries the **public receive address** (never the
   key). This blob already exists — the hosted vault reuses it.
2. **Balance (read-only).** The server reads the receive address from the vault metadata (public)
   and proxies the BLOCK chain/explorer API for the balance + token holdings. No key involved.
3. **Deposit.** The dashboard shows the receive address (and a QR) — deposits go straight on-chain
   to the user's own address. The platform is never in the path of the funds.
4. **Send / withdraw / trade (client-signed).** The browser downloads the encrypted blob, the user
   unlocks it locally with their passphrase, the **ML-DSA (FIPS-204) signature is produced in the
   browser** (via the existing `blockle_wasm` signer), and the signed transaction is handed to the
   server's **broadcast relay**, which only forwards opaque bytes to the node. The server sees a
   signed transaction, never a key.

## Why this is safe (and legal-lighter)

- **Breach blast-radius unchanged from today:** a DB dump yields undecryptable blobs + public
  addresses — no funds. Contrast with true custody, where a breach drains everyone.
- **No unilateral spend:** the server has no key material and no signing path; it cannot move
  funds even if fully compromised or coerced.
- **Not custody:** because the platform cannot control or move user assets, this is a non-custodial
  wallet UX, not a custodial exchange. (KYC/AML still merits legal review per jurisdiction, but the
  money-transmitter *custody* licensing that true custody triggers does not apply the same way.)
- **Post-quantum throughout:** vault keys are ML-DSA-44; the envelope is symmetric (PQ-safe); the
  only asymmetric layer is TLS transport (tracked separately).

## Server surface (this service — non-custodial only)

- `GET  /account/api/vault` — the stored encrypted blob + public metadata (session + 2FA).
- `GET  /account/api/vault/address` — the public receive address from metadata.
- `GET  /account/api/vault/balance` — proxied public balance/tokens for that address (read-only).
- `POST /account/api/vault/broadcast` — relay a client-signed raw transaction to the node. The
  payload is opaque signed bytes; the server validates shape + size and forwards, nothing more.

Every spendable operation happens in the browser/wallet; the server offers storage, public reads,
and a relay. The chain client is injectable (stub in tests, node/explorer in prod).

## Phasing

1. **Backbone (this pass):** encrypted-vault storage (reuse), address + balance read-only proxy,
   broadcast relay — all behind an injectable chain client, with tests asserting the non-custodial
   invariants (no key stored, no signing path, relay forwards opaque bytes).
2. **Web signer:** wire the `blockle_wasm` ML-DSA signer into a `/account/vault` page so send/trade
   work entirely client-side; browser QA required before it touches mainnet.
3. **Trade:** route swaps through the existing DEX/exchange from the web vault, client-signed.

What this is NOT: it does not and will not hold keys or custody funds. If true custody is ever
wanted, that's a separate, licensed program (see the custody checklist discussion).
