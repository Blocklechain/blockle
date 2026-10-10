# Sui leg — Move HTLC

Hash-timelocked contract for **any Sui coin** `Coin<T>` — native SUI today, and
USDC-on-Sui / any other coin with zero code change (the coin type is a generic
parameter, never hardcoded). The escrow is a **shared object** that can only pay
its receiver on preimage reveal (before the timelock) or refund its sender
(after it). The relay never holds the object, the coin, or a key.

Protocol hash is **SHA-256** (`std::hash::sha2_256`), matching the EVM, Solana
and BTC legs, so one preimage `s` with `H = sha256(s)` opens every leg of a
swap. See [`../PROTOCOL.md`](../PROTOCOL.md) for the shared state machine.

## Module (`sources/htlc.move`)
- `lock<T>(payment, receiver, hashlock, timelock_ms, fee_bps, fee_recipient, clock, ctx)`
  — escrows `payment` into a fresh shared `HTLC<T>`; emits `Locked`.
- `redeem<T>(htlc, preimage, clock, ctx)` — settles iff `sha256(preimage) ==
  hashlock` **and** `now < timelock`; pays `receiver` (amount − fee) and the fee
  to `fee_recipient`; emits `Redeemed` (publishes the preimage); deletes the
  object.
- `refund<T>(htlc, clock, ctx)` — after `now >= timelock`, returns the full
  escrow to `sender` with **no fee**; emits `Refunded`; deletes the object.
- 0.1% settlement fee (configurable per lock, hard-capped at 1% via
  `MAX_FEE_BPS`), taken only on `redeem`. `refund` takes no fee.
- One-shot by construction: `redeem`/`refund` consume the shared object by value
  and delete it, so replays/double-spends have nothing to act on — no state
  flag needed.
- Timelock is a millisecond wall-clock deadline read from the Sui `Clock` (`0x6`);
  it pairs directly with the EVM/Solana unix-second timelocks (×1000). The
  protocol's `T2 < T1` rule is enforced by the relay when it sizes each leg.

## Status: BUILDS + TESTS PASS
Verified in this environment:
- `sui move build` → compiles `blockle_htlc` (two benign lint warnings:
  `entry` on a `public` fn is redundant — kept to match the requested
  `public entry` ABI; it adds no restriction and is callable from PTBs either way).
- `sui move test` → **7 passing**: lock→redeem (fee split to receiver + fee
  recipient), wrong-preimage abort, redeem-after-timelock abort, refund-after-
  timelock (full amount, no fee), refund-before-timelock abort, refund-by-non-
  sender abort, fee-above-cap abort.

Toolchain used: `sui 1.81.1` (Homebrew bottle), Move 2024 edition, `Sui`
framework pinned to `framework/testnet`.

## Build & test
```bash
cd exchange/contracts/sui
sui move build
sui move test
```

## Deploy (one command, testnet-first, gated)
```bash
./scripts/deploy.sh                 # -> Sui testnet (default)
SUI_ENV=devnet ./scripts/deploy.sh  # -> devnet
# mainnet (gated — see below):
SUI_ENV=mainnet HTLC_MAINNET_ENABLED=true HTLC_LEGAL_REVIEW_REF=LR-123 ./scripts/deploy.sh
```
`deploy.sh` builds + tests, switches the Sui client to `SUI_ENV` (creating the
env alias against `https://fullnode.<env>.sui.io:443` if missing), publishes
using the **active keystore address** (`sui client active-address` — no key
touches this repo), then **captures the published `packageId`** and writes it to
`deployments.json` keyed by env (shape in `deployments.example.json`). That file
is what the relay reads for the Sui HTLC package id. The `Clock` object id is
the well-known `0x6` on every network and is recorded alongside the id.

`deployments.json` is git-ignored; commit a real id deliberately with
`git add -f deployments.json`. Parsing uses `jq` if present, else `python3`.

### What the deployer must have (human steps — not automated)
- **The Sui CLI** (`sui`) installed, with a keypair in the local keystore. The
  active address is the publisher: `sui client active-address`. This repo never
  sees the key. Create/import a key with `sui client new-address ed25519` or an
  existing keystore.
- **A funded active address** on the target network:
  - *testnet*: faucet SUI — `sui client faucet` (CLI faucet against the active
    env), or the web/Discord faucet at <https://faucet.sui.io>. One request
    (~1 SUI) covers many publishes; the package gas budget defaults to 0.1 SUI
    (`SUI_GAS_BUDGET`, in MIST).
  - *devnet*: same, `sui client faucet` against the devnet env.
  - *mainnet*: real SUI for gas sent to the active address (a package publish is
    a few cents of SUI; keep a small buffer).
- **RPC/env**: defaults to the public fullnode `https://fullnode.<env>.sui.io:443`.
  Override with `SUI_RPC_URL=...` (e.g. a private/paid fullnode) before running.
  The CLI env is selected/created automatically by the script.
- **Mainnet only**: a recorded legal/compliance sign-off; set
  `HTLC_MAINNET_ENABLED=true` and `HTLC_LEGAL_REVIEW_REF=<ref>` (PROTOCOL.md §7).

After a successful publish, record/commit the `packageId` and wire it into the
relay (`deployments.json`). Nothing else from the package is network-specific.

> **Testnet-first / mainnet gating.** A Sui package is published per network, so
> the mainnet switch lives at the deploy + relay-config boundary, not in the
> module. `scripts/deploy.sh` refuses a `mainnet` publish unless both
> `HTLC_MAINNET_ENABLED=true` and `HTLC_LEGAL_REVIEW_REF=<ref>` are set — the
> same contract as the EVM/Solana legs (PROTOCOL.md §7). Keep the relay's Sui
> mainnet flag OFF until a recorded legal/compliance review. KYC/geo screening
> belongs at the off-chain fiat/custody boundary; this module is non-custodial
> and onboards no fiat.

## JS client (`client/htlc-client.js`)
Non-custodial PTB builder the frontend wallet / relay SDK import to shape the
`lock` / `redeem` / `refund` Move calls. It never holds a key, signs, or
submits — the wallet does. Peer dependency: `@mysten/sui` (v1.x).

```js
import { Transaction } from "@mysten/sui/transactions";
import { buildLockTx, deriveHashlock } from "./client/htlc-client.js";

const hashlock = await deriveHashlock(preimageBytes);         // H = sha256(s)
const tx = buildLockTx({
  packageId, coinType: "0x2::sui::SUI", amount: 1_000_000n,
  receiver, hashlock, timelockMs, feeBps: 10, feeRecipient,
});
await wallet.signAndExecuteTransaction({ transaction: tx });  // wallet signs
```
Also exports `buildRedeemTx`, `buildRefundTx`, `timelockMsFromUnixSeconds`,
`SUI_CLOCK_OBJECT_ID`, `MAX_FEE_BPS`, `SUI_COIN_TYPE`.
