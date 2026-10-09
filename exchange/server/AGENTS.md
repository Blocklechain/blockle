# AGENTS.md — exchange relay (for autonomous agents & contributors)

This is the **non-custodial** exchange relay. It **holds no funds and no keys**.
Agents are first-class clients: everything the web UI can do is reachable
programmatically. The easiest route is the SDK (`sdk/`, `agent.exchange`) or
the MCP `exchange_*` tools — both are clients of the HTTP contract below.

## Golden rules (do not break)

- **Non-custodial, always.** Never add escrow, a hot wallet, a deposit address,
  or any path where the relay holds user funds or keys. Settlement is the
  parties' own on-chain HTLC legs; the relay only coordinates `H`/preimage/
  timelocks and tracks state.
- **Testnet-first.** `mainnetEnabled` defaults false and only flips true when
  `legalReview.completed=true` is recorded in config. Operators must obtain
  legal/compliance sign-off before enabling mainnet. Keep the gate.
- **Mandatory BLOCK pair.** Every listing includes `BLOCK/<asset>`; never add a
  path that lists an asset without it or that bypasses the fee.
- **Verify before you move state.** A listing activates only after the fee is
  verified (on-chain txid + confirmations, or an x402 `listing-paid` receipt).
  Orders/cancels activate only after the signature verifies.
- **Base units everywhere** (`bigint`/integer strings). Convert only at display
  edges. `1 BLOCK = 100_000_000`.
- **Idempotent + audited.** Dedupe value-moving actions; append to `audit_log`.
- **Keys never here.** The relay process holds none; compliance and fee
  verification are pluggable and no-op/dev-safe by default.

## Authenticate (same for agents and humans)

1. `POST /auth/nonce {address, chain}` → `{nonce}`
2. sign the nonce the chain's way:
   - `block`: ML-DSA via `blockle-wasm.sign_message` (send `publicKey` too — the
     address is a hash, so the relay needs the key to verify)
   - `ethereum`/`base`: EIP-191 `personal_sign`
   - `solana`: ed25519 detached signature (base58 or hex)
3. `POST /auth/verify {address, chain, signature, publicKey?}` → `{token}`;
   send it as `Authorization: Bearer <token>`.

There is **no password / custodial login path** — identity is signature only.

## Place a signed order

Orders are **signed swap intents**. Sign the canonical JSON (sorted keys, no
whitespace) of `{market, side, type, price, amount, expiry, maker, nonce}` and
POST `{...intent, intent, signature}` to `/orders`. The relay verifies the
signature against your session key before it touches the book.

## Run a swap

`POST /swaps/:id/step {action, payload}`; `action:"poll"` asks what to do next.
The relay replies `lock | withdraw | refund | wait | done` with a `payload`
(hashlock, timelock, lockRef, preimage). You perform the on-chain leg with your
own signer and report back (`locked|withdrawn|refunded` + receipt). The SDK's
`agent.exchange.executeSwap` / `swap()` drives this loop for you.

## List an asset

`POST /listings/quote {asset, extraPairs}` → live price (`$5 + $1/extra pair`,
BLOCK pair included). Pay the quoted `payTo` non-custodially, then
`POST /listings {asset, extraPairs, paymentTxid | x402Receipt}`. SDK:
`agent.exchange.listAsset({asset, extraPairs})`.

## Local dev

```bash
npm install && npm run build && npm test
npm start   # :8900, testnet
```

Tests cover signature verification (EVM + Solana + BLOCK concretely), price-time
matching, the swap state machine, and the listing/fee flow. Keep them green and
add coverage with any change.
