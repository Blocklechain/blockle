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
  lock→withdraw (fee). Confirmed green across repeated runs.
- `scripts/deploy.sh` exercised end-to-end against a local validator: build →
  `anchor keys sync` → rebuild → `anchor deploy` → program id captured to
  `deployments/<cluster>.json`, then a live `initialize(...)` invoke succeeded.

Toolchain used: `anchor-cli 0.29.0`, `solana-cli 1.18.20` (Agave), Anchor
platform-tools rust `1.75`.

### Test note — pinned JS client deps (honest)
Anchor 0.29's error translator expects the pre-1.90 `@solana/web3.js`
`SendTransactionError` shape; web3.js ≥1.90 masks every transaction error as
`Unknown action 'undefined'`. `@solana/web3.js` is therefore pinned to
**1.89.1** (and `rpc-websockets` to **7.9.0** via `overrides`, the last with the
`dist/lib/client` path web3 1.89 imports). The refund test is driven off the
program's own `Clock` sysvar (not wall time) and polls by retrying, because the
local validator's clock lags wall-clock and drifts under load — a fixed
wall-clock sleep was flaky. These are test/toolchain-age constraints, not
program issues.

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

## Deploy — one command (testnet-first, gated)
```bash
cd exchange/contracts/solana
export ANCHOR_WALLET=~/.config/solana/id.json   # the funded deployer keypair
./scripts/deploy.sh                              # -> devnet (default)
```
`scripts/deploy.sh` does the whole thing and is safe to re-run:
1. builds, runs **`anchor keys sync`**, rebuilds (see "Why keys sync" below),
2. refuses to deploy unless `declare_id!` == the program keypair,
3. `anchor deploy`s to the configured cluster with `ANCHOR_WALLET` as deployer +
   upgrade authority,
4. writes the program id to `deployments/<cluster>.json`, and
5. prints the exact relay-config snippet to paste.

Cluster + RPC come from [`deploy.config.json`](deploy.config.json) (override with
`SOLANA_CLUSTER` / `SOLANA_RPC_URL`). On devnet it auto-airdrops if the balance
is low. **No keys are read from or written to the repo** — only `ANCHOR_WALLET`.

```bash
SOLANA_CLUSTER=localnet ./scripts/deploy.sh                 # local validator
SOLANA_CLUSTER=mainnet-beta HTLC_MAINNET_ENABLED=true \
  HTLC_LEGAL_REVIEW_REF=LR-123 ./scripts/deploy.sh          # mainnet (gated)
```
Mainnet-beta is **refused** unless BOTH `HTLC_MAINNET_ENABLED=true` and
`HTLC_LEGAL_REVIEW_REF=<ref>` are set — same contract as the EVM/Sui legs
(PROTOCOL.md §7). To deploy at a known/vanity id, set `PROGRAM_KEYPAIR=<path>`
(your keypair, copied into place, never committed).

After deploy, call the one-time `initialize(fee_bps, fee_wallet)` (fee wallet is
a PUBLIC address) and leave `mainnet_enabled = false`.

### Why `keys sync` (do not skip)
`anchor deploy` creates the program account **at the program-keypair address**,
but the on-chain program enforces that this equals the `declare_id!` baked into
the `.so`. A fresh checkout generates a *new random* program keypair, so without
a sync the deployed program rejects every instruction with
`DeclaredProgramIdMismatch` (confirmed — `anchor test` hides this because it
loads the program at the `Anchor.toml` id, not the keypair id). The script runs
`anchor keys sync` so the deployed id always matches the declared id. This
rewrites `declare_id!` in `lib.rs` and the `Anchor.toml` program id to **your**
program id — commit that change for your deployment; the value in git
(`4Lo3…EdS`) is a placeholder from this environment, not a claimed deployment.

## What the operator must provide (Solana)
| Need | Testnet (devnet) | Mainnet-beta |
|---|---|---|
| Deployer keypair | any keypair at `ANCHOR_WALLET` | funded keypair; this is also the **upgrade authority** — secure it |
| SOL for rent + fees | free via airdrop (`solana airdrop 2`, or https://faucet.solana.com) | ~3–5 SOL (BPF program rent scales with `.so` size ≈ 400 KB; plus tx fees) |
| Cluster URL | `https://api.devnet.solana.com` (default) | `https://api.mainnet-beta.solana.com` or a private RPC (public RPC rate-limits large deploys) |
| Gate | none | `HTLC_MAINNET_ENABLED=true` + `HTLC_LEGAL_REVIEW_REF` + recorded legal review |

Human steps (not automated): fund/secure the keypair, choose the fee wallet,
run `initialize`, paste the program id into `exchange/server/config.json →
htlc.solana.<devnet|mainnet>`, and — only on mainnet, only after legal review —
call `set_mainnet(true)`.

> **Testnet-first.** `Config.mainnet_enabled` defaults `false`; flip it (via the
> authority-gated `set_mainnet`) only after a recorded legal/compliance review.
> KYC/geo screening belongs at the off-chain fiat/custody boundary.

## Audit-readiness review (honest)
Non-custodial design is sound: per-swap PDAs/vaults seeded by a client `swap_id`,
one-shot `State` flag, SHA-256 hashlock matching the other legs, fee capped at
1% and taken only on settlement, refund takes no fee. Before an external audit
and any mainnet money path:
- **Program keypair / upgrade authority.** The deployer is the upgrade
  authority — a live upgradeable program is a trust assumption. Decide and
  document multisig vs. a burned authority (`solana program set-upgrade-authority
  --final`) before mainnet. The committed `declare_id` is a placeholder.
- **`swap_id` uniqueness.** `lock_*` does `init` on the PDA, so a reused
  `swap_id` fails closed (good), but the relay must guarantee uniqueness so an
  attacker cannot grief by front-running a well-known id. Worth an explicit test.
- **Fee/receiver account validation.** Handlers check `receiver`, `sender`,
  `fee_wallet`, and ATA `mint`/`owner`; the SPL path reclaims vault rent to the
  sender. Add negative tests for wrong `fee_ata`/`receiver_ata` owners and for a
  `vault`/`mint` mismatch to lock the constraints in.
- **No reentrancy surface** (no CPI back into untrusted programs) and lamport
  math is checked (`overflow-checks = true`), but a reviewer should confirm the
  manual lamport moves in `withdraw_sol`/`refund_sol` against rent-exemption
  edge cases for the PDA.
- **Timelock units.** Seconds here vs. Sui's milliseconds — the `T2 < T1`
  cross-leg invariant lives in the relay, not the program; auditors should see
  the relay enforce it.
- **Tests** cover happy paths + wrong-preimage + timelock windows for SOL and
  SPL; expand with the negative/ownership cases above and an SPL refund test
  before audit. Not yet audited; testnet-only until then.
