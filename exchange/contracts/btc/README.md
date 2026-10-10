# BTC leg — native Bitcoin Script HTLC

Hash-timelocked contract for **native BTC**, implemented as a raw Bitcoin
Script and wrapped in **P2WSH** (native SegWit v0). This is the classic
cross-chain atomic-swap leg: the output can only be spent by the receiver (with
the preimage) or refunded to the depositor (after a `OP_CHECKLOCKTIMEVERIFY`
timelock). There is no contract account, no custodian — the swap lives entirely
in the output's spending conditions.

See [`../PROTOCOL.md`](../PROTOCOL.md) for the full swap state machine, timelock
`T2 < T1` rule, and where the 0.1% settlement fee is taken.

## Hash reconciliation (IMPORTANT)

The shared protocol hashlock is **`H = sha256(preimage)`** (same as the EVM and
Solana legs — PROTOCOL.md §4). This leg therefore uses the Script opcode
**`OP_SHA256`**, *not* the more common `OP_HASH160`.

> `OP_HASH160` computes `ripemd160(sha256(x))`, a **different** hashlock. Using
> it here would make the BTC leg's `H` incompatible with the other legs and
> break the single-secret safety argument. We deliberately use `OP_SHA256` so
> the on-chain hashlock is byte-identical to `H = sha256(s)` everywhere.

Result: **BTC ⇄ EVM**, **BTC ⇄ Solana**, and (via a BTC-side `sha256` lock)
**BTC ⇄ BLOCK** when BLOCK gains its `SHA256` opcode (PROTOCOL.md §4) all share
one hashlock. BTC ⇄ anything-on-sha256 is safe today.

## The witness script

```
OP_SHA256 <H> OP_EQUAL
OP_IF
    <receiverPubKey>
OP_ELSE
    <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP
    <refundPubKey>
OP_ENDIF
OP_CHECKSIG
```

- `H` = 32-byte `sha256(preimage)`.
- `receiverPubKey` / `refundPubKey` = 33-byte compressed pubkeys.
- `locktime` = CLTV value. **Unix time** (`>= 500000000`) to pair with the
  timestamp-based EVM/Solana legs, or a **block height** (`< 500000000`).

`OP_SHA256 … OP_EQUAL` pushes TRUE/FALSE, which `OP_IF` consumes to pick the
branch; a single trailing `OP_CHECKSIG` serves both. This keeps the script
small and the two spend witnesses symmetric.

### Spend witnesses (P2WSH)

| Path | Who | When | Witness stack (bottom → top) |
|------|-----|------|------------------------------|
| **redeem** | receiver | any time, needs preimage | `[ <sig> , <preimage> , <witnessScript> ]` |
| **refund** | depositor | `nLockTime ≥ locktime` | `[ <sig> , <empty> , <witnessScript> ]` |

The empty element on the refund path makes `OP_EQUAL` push FALSE → the `OP_ELSE`
branch runs, which gates on `OP_CHECKLOCKTIMEVERIFY`. The refund spend sets the
transaction's `nLockTime = locktime` and uses a non-final `nSequence`
(`0xfffffffe`) so CLTV is enforced.

### Addresses

- Each swap produces a fresh **P2WSH address** from `sha256(witnessScript)`:
  - testnet3 / signet → `tb1q…`
  - regtest → `bcrt1q…`
  - mainnet → `bc1q…` (gated)
- The protocol-fee output on redeem pays the configured treasury address
  (`config.json` → `networks.<net>.treasuryFeeAddress`; mainnet is
  `bc1q0wz2gwq09qreh22qrefmt7k8qwtg5m8yekhvcm`, shared with `treasury.json`).

## Layout

- `src/htlc.js` — script builder + PSBT builders:
  - `hashlock(preimage)` → `sha256(preimage)`
  - `buildHtlc({ hash, receiverPubkey, refundPubkey, locktime }, network)` →
    `{ witnessScript, address, output, … }`
  - `buildLockPsbt(…)` — fund the P2WSH output
  - `buildRedeemPsbt(…)` — spend with preimage; takes the 0.1% fee (capped 1%)
  - `buildRefundPsbt(…)` — spend after the timelock; **no fee**
  - `finalizeRedeem(psbt, i, preimage)` / `finalizeRefund(psbt, i)` — inject the
    correct witness stack for each branch
- `test/htlc.test.js` — script-template vector, deterministic P2WSH address,
  network prefixes, full lock→redeem and lock→refund lifecycles with **real
  SegWit-v0 sighash signature verification**, fee split, and negative cases.
- `config.json` — `feeBps` (10 = 0.1%), `maxFeeBps` (100 = 1%), per-network
  treasury fee address + Esplora endpoint, timelock defaults, mainnet gate.

## Build & test

```bash
cd exchange/contracts/btc
npm install
npm test        # node --test → 12 passing
```

Pure-JS — no Bitcoin node required to build scripts, derive addresses, or
construct/sign/finalize the lock, redeem, and refund PSBTs. Tests verify each
spend's ECDSA signature against the actual `hashForWitnessV0` sighash for its
branch, so a produced transaction is cryptographically valid, not just
well-shaped.

## What builds vs. what needs an external testnet

| Capability | Status |
|------------|--------|
| HTLC witness-script construction (`OP_SHA256` hashlock + CLTV refund) | ✅ builds + tested |
| P2WSH address derivation (testnet/signet/regtest/mainnet) | ✅ builds + tested |
| Lock / redeem / refund PSBT construction | ✅ builds + tested |
| Signing + custom branch finalizers + tx extraction | ✅ builds + tested |
| Signature validity vs. real SegWit-v0 sighash | ✅ verified in tests |
| **Broadcasting** a real testnet/signet tx | ⚠️ **needs an external node/wallet** — out of scope here |
| **UTXO discovery / fee estimation** from live chain | ⚠️ needs an Esplora/Core RPC endpoint (`config.json` has the URLs) |

Broadcast + UTXO selection are deliberately not implemented in this package:
they require a funded testnet wallet and a node/Esplora connection, which this
environment does not have. The builders emit standard base64 PSBTs and
fully-finalized raw transactions, so wiring them to
`sendrawtransaction` / Esplora `POST /tx` is a thin, node-dependent shell step —
documented, not faked.

## Testnet-first and mainnet gating

`config.json → mainnet_enabled` defaults to `false`. The mainnet network entry
exists only so the address format and treasury fee address are documented; any
caller enabling a mainnet money path must satisfy the same gate the other legs
use (recorded legal/compliance sign-off — PROTOCOL.md §7). Dev targets Bitcoin
**testnet3 / signet / regtest**.

## Non-custodial by construction

No private keys live in this package or anywhere in the repo. The builders take
only public keys, an address, a hashlock, and a timelock; signing is done by the
caller's own key through the standard PSBT interface. The relay can match and
broadcast but can never spend a locked output — only the receiver (with the
preimage) or the depositor (after the timelock) can.
