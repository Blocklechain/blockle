# Solana leg — Anchor HTLC

Hash-timelocked contract for **native SOL** and **arbitrary SPL tokens**. USDC
and USDT are first-class legs — the mint is a per-swap account, never hardcoded.
Protocol hash is **SHA-256** (`solana_program::hash` is SHA-256), matching the
EVM leg, so one preimage `s` opens both.

See [`../PROTOCOL.md`](../PROTOCOL.md) for the swap state machine.

## Program (`programs/htlc/src/lib.rs`)
- `initialize(fee_bps, fee_wallet)` — one-time `Config` PDA; `mainnet_enabled`
  starts `false`. `set_mainnet(enabled)` is authority-gated.
- **SOL:** `lock_sol` (escrows lamports in the swap PDA) / `withdraw_sol` /
  `refund_sol`.
- **SPL:** `lock_spl` (escrows into a per-swap vault token account owned by the
  swap PDA) / `withdraw_spl` / `refund_spl`.
- 0.1% settlement fee (configurable, capped at 1% via `MAX_FEE_BPS`) to
  `config.fee_wallet`, taken only on `withdraw_*`. `refund_*` takes no fee.
- Per-swap PDA seeded by a client-chosen 32-byte `swap_id`; swaps are one-shot
  (`State` flag) so replays/double-spends are no-ops.

## Status: BUILDS + TESTS PASS
Verified in this environment:
- `anchor build` → `target/deploy/htlc.so` + IDL/types generated.
- `anchor test` → **5 passing** on a local validator: config init, SOL
  lock→withdraw (fee), wrong-preimage rejection, SOL refund after timelock, SPL
  lock→withdraw (fee).

Toolchain used: `anchor-cli 0.29.0`, `solana-cli 1.18.20` (Agave), Anchor
platform-tools rust `1.75`.

## Build & test
```bash
cd exchange/contracts/solana
anchor build
anchor test            # spins up a local validator, runs tests/htlc.ts
# or against an already-running validator / existing .so:
#   anchor test --skip-build
```

### Build note — dependency pinning (honest)
Anchor 0.29 + Solana 1.18 build with the bundled platform-tools **rust 1.75**,
which predates several transitive crates that have since moved to
`edition2024` / require a newer rustc. A fresh resolve fails with
`feature 'edition2024' is required`. The committed **`Cargo.lock` (version 3)**
pins the working set; if you regenerate it, re-apply:

```bash
PT=~/.cache/solana/*/platform-tools/rust/bin/cargo   # platform-tools cargo (1.75)
$PT generate-lockfile
$PT update -p zeroize_derive --precise 1.4.2
$PT update -p blake3 --precise 1.5.5
$PT update -p indexmap@2.14.2 --precise 2.2.6
$PT update -p typenum --precise 1.17.0
$PT update -p toml_edit@0.25.16 --precise 0.21.1     # via proc-macro-crate below
$PT update -p proc-macro-crate@3.5.0 --precise 3.1.0
$PT update -p borsh@1.8.1 --precise 1.5.1
$PT update -p unicode-segmentation --precise 1.11.0
$PT update -p jobserver --precise 0.1.32
anchor build
```
The `Cargo.lock` is kept in git precisely so this does not need repeating. This
is an environment/toolchain-age constraint, not a program issue — the program
compiles to BPF and the full test suite passes.

## Deploy (devnet, gated)
```bash
solana config set --url devnet
anchor deploy --provider.cluster devnet
# then: initialize(fee_bps, fee_wallet); leave mainnet_enabled = false.
```

> **Testnet-first.** `Config.mainnet_enabled` defaults `false`; flip it (via the
> authority-gated `set_mainnet`) only after a recorded legal/compliance review.
> KYC/geo screening belongs at the off-chain fiat/custody boundary.
