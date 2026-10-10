# exchange/contracts — audit-readiness review (HTLC legs)

An honest security review of the five cross-chain atomic-swap HTLC legs before
they hold any mainnet funds. It states what is tested, the trust/threat model,
the known gaps, and — bluntly — the recommendation below.

> ## Recommendation (read this first)
>
> **These HTLC contracts were written by an AI (Claude) and have NOT had an
> external security audit. They custody user funds on five chains. Do NOT enable
> any mainnet money path until each leg has been reviewed by a qualified
> third-party auditor for that chain.** Unit tests pass and the design follows
> the standard HTLC pattern, but tests prove the cases we thought of — they do
> not substitute for an adversarial audit of custody code. Testnet-first is
> enforced in code (PROTOCOL.md §7); keep it that way until sign-off. Nothing in
> this repo is a representation that these contracts are safe to hold value.

---

## 1. What is tested today

| Leg | Build | Tests | Coverage |
|-----|-------|-------|----------|
| EVM | Hardhat (solc 0.8.24) | ✅ 10 passing | ETH + ERC-20 + USDT-style no-return token; happy path, wrong preimage, refund, timelock windows, double-withdraw |
| Solana | `anchor build` → `htlc.so` | ✅ 5 passing (local validator) | config init, SOL lock→withdraw (fee), wrong preimage, SOL refund after timelock, SPL lock→withdraw (fee) |
| Sui | `sui move build` | ✅ 7 passing | lock→redeem fee split, wrong preimage abort, redeem-after-timelock abort, refund after/before timelock, refund-by-non-sender abort, fee-above-cap abort |
| BLOCK | `cargo build` | ✅ regtest lifecycle | lock→withdraw (receiver + fee), wrong preimage rejected, double-claim rejected, refund only after timelock height |
| BTC | pure-JS (bitcoinjs-lib) | ✅ 12 passing | script-template vector, deterministic P2WSH address, network prefixes, full lock→redeem + lock→refund with **real SegWit-v0 sighash signature verification**, fee split, negatives |

These are **unit/integration tests in each leg's own environment** on
local/regtest. **No leg has been deployed to a public testnet or mainnet, and
no leg has been externally audited.** Several tests carry honest toolchain
caveats (Solana pins `@solana/web3.js` 1.89.1 for the Anchor 0.29 error
translator; its clock-driven refund test polls rather than sleeps).

---

## 2. Trust and threat model

**Non-custodial by construction.** A trade is two independent HTLC legs linked by
one secret `s` and hashlock `H = hash(s)`. Each leg can only (a) pay its
receiver on preimage reveal before the timelock, or (b) refund its depositor
after the timelock. The relay/operator/contract owner **cannot seize a locked
swap** — it holds no key and no fund.

**Trusted:**
- The **cryptographic hash** (SHA-256 on EVM/Solana/Sui/BTC; BLAKE2B on BLOCK)
  and each chain's consensus/finality.
- The **relay to size the two legs correctly** — in particular the `T2 < T1`
  timelock invariant and the confirmation-depth / reorg policy live off-chain
  (PROTOCOL.md §3, §6). A buggy relay can create an unsafe pairing even if every
  contract is correct. **This is the single biggest non-contract risk** and an
  auditor must review the relay's leg-sizing, not just the contracts.
- On **Solana**, the deployer = **upgrade authority**: a live upgradeable
  program is a standing trust assumption until the authority is a multisig or
  burned.
- On **BLOCK**, the `fee_addr` and `fee_bps` are **baked into bytecode at deploy
  time** by whoever runs our deploy — trust that the reserve operator baked the
  intended values.

**Explicitly out of scope of the contracts (handled off-chain, no-op in dev):**
KYC / geo-screening / fiat onboarding. These contracts onboard no fiat and do
not screen users; that belongs at the fiat/custody boundary (PROTOCOL.md §7).

**Adversaries considered:** a malicious counterparty (wrong preimage, abandon
after lock, griefing a known swap id), a malicious relay (unsafe leg sizing,
withholding `s`), chain reorgs, and non-standard tokens (fee-on-transfer,
no-return, rebasing).

---

## 3. Cross-cutting correctness properties an auditor must confirm

Same single-secret HTLC on every leg (PROTOCOL.md). Verify on **each** leg:

1. **Hashlock correctness** — the leg verifies `preimage` against the *same*
   hash family the paired leg uses (SHA-256 across EVM/Solana/Sui/BTC). A
   cross-hash pairing (BLAKE2B vs SHA-256) is unsafe and must stay impossible —
   BLOCK is BLAKE2B-only and is therefore restricted to BLOCK⇄BLOCK until the VM
   gains a `SHA256` opcode (PROTOCOL.md §4). Confirm the relay never pairs a
   BLAKE2B leg with a SHA-256 leg.
2. **Timelock correctness** — withdraw only before `T`, refund only at/after
   `T`; units are consistent (EVM/Solana seconds, Sui milliseconds, BTC
   nLockTime, BLOCK block-height) and the relay enforces `T2 < T1` with a safety
   gap Δ larger than the slower chain's reorg window.
3. **Refund race** — after `T` there must be no window where withdraw and refund
   are both valid. EVM/Solana/Sui enforce `now < T` on withdraw. **BLOCK does
   NOT** forbid a late withdraw (see §4.4) — a real gap.
4. **One-shot** — a leg settles or refunds exactly once; replays are no-ops.
5. **Fee bounds** — fee taken only on settlement, never on refund, and capped so
   a misconfiguration cannot confiscate a trade. **Cap is enforced on EVM
   (`MAX_FEE_BPS=100`), Solana (`MAX_FEE_BPS=100`), Sui (`MAX_FEE_BPS`). It is
   NOT enforced in the BLOCK bytecode** (see §4.4).

---

## 4. Per-leg findings and what an auditor must check

### 4.1 EVM (`evm/contracts/HTLC.sol`)

**Structure is sound:** checks-effects-interactions (state set to
`WITHDRAWN`/`REFUNDED` *before* any transfer), per-swap `id` derived from
`keccak256(sender, receiver, token, amount, hashlock, timelock, chainid,
nonce)`, immutable `feeBps`/`feeAddress` with `MAX_FEE_BPS=100`, USDT-style
no-return tokens tolerated via low-level call + conditional decode.

Auditor must check:
- **Reentrancy.** CEI is followed and state is per-`id`, so a re-entrant call
  hits `NotLocked`. Confirm there is no cross-swap reentrancy via a malicious
  ERC-777/hook token or a malicious `receiver`/`feeAddress` contract on the
  native-ETH `.call{value}` path, and that a reverting fee-address payout cannot
  brick an otherwise valid withdraw.
- **Fee-on-transfer / rebasing / deflationary tokens.** `lock` escrows the
  stated `amount`, but a fee-on-transfer token delivers less than `amount` to
  the contract while `withdraw` pays out `amount − fee` — a **shortfall that can
  underpay a later swap or revert**. The contract does not measure the actual
  received balance. Decide whether to support only standard tokens (document an
  allowlist) or measure balance deltas.
- **Authorization.** `withdraw`/`refund` are intentionally callable by anyone
  (funds route to the stored `receiver`/`sender`), which is correct for HTLC;
  confirm there is no path to redirect the payout.
- **`timelock` bounds / `block.timestamp`** miner skew tolerance vs. the chosen
  Δ.
- **ERC-20 return-data decode** against odd tokens (e.g. returns 32+ bytes, or
  a non-bool), and griefing via a token that reverts on zero-value transfer.

### 4.2 Solana (`solana/programs/htlc/src/lib.rs`)

**Structure is sound:** per-swap PDA seeded by a client `swap_id` with `init`
(reused id fails closed), one-shot `State` flag, `MAX_FEE_BPS=100`,
authority-gated `set_mainnet` via `has_one = authority`, receiver/sender/
fee-wallet key checks (`require_keys_eq!`), SPL vault owned by the swap PDA with
`mint`/`owner` constraints, `overflow-checks = true`.

Auditor must check:
- **Account validation completeness.** Confirm every handler fully constrains
  `receiver_ata`/`fee_ata`/`sender_ata` (`owner` AND `mint`), the `vault` ↔
  `swap` relationship, and the `config` PDA — add **negative tests** for wrong
  `fee_ata`/`receiver_ata` owner and a `vault`/`mint` mismatch (currently
  missing).
- **Upgrade authority.** Deployer = upgrade authority. Decide multisig vs.
  `solana program set-upgrade-authority --final` before mainnet; a live
  upgradeable custody program is a trust assumption. The committed `declare_id`
  is a placeholder.
- **Lamport math / rent.** Manual lamport moves in `withdraw_sol`/`refund_sol`
  vs. the PDA's rent-exemption floor; confirm no path leaves the PDA below rent
  or lets rounding strand lamports.
- **`swap_id` uniqueness / front-running.** `init` makes a reused id fail
  closed, but the relay must guarantee uniqueness so an attacker can't grief by
  pre-creating a well-known id — add an explicit test.
- **Missing SPL refund test.** Only SOL refund is covered; add SPL refund +
  vault-rent-reclaim.

### 4.3 Sui (`sui/sources/htlc.move`)

**Structure is sound:** escrow is a **shared object consumed by value** on
`redeem`/`refund` and deleted (one-shot by construction, no state flag needed),
`MAX_FEE_BPS` cap, generic `Coin<T>` (no hardcoded coin), timelock read from the
system `Clock` (`0x6`).

Auditor must check:
- **Object ownership / who can call.** It is a shared object, so anyone can
  submit `redeem`/`refund`; confirm the Move logic forces funds to the stored
  `receiver` (redeem) / `sender` (refund) and that the `preimage`+`timelock`
  gates cannot be bypassed by passing attacker-controlled arguments. Confirm
  `refund` aborts for a non-sender (tested) and that nothing lets a caller
  substitute a different recipient or split.
- **Coin handling.** No dust/rounding path strands value in the deleted object;
  the fee split (`amount − fee` to receiver, fee to `fee_recipient`) sums
  exactly to the escrow.
- **`public entry` lint.** The redundant-`entry` warning is cosmetic; confirm
  the published ABI matches what the relay/client PTB builder calls.

### 4.4 BLOCK (`block/src/lib.rs` → VM bytecode)

**Structure is sound:** selector-dispatched lock/withdraw/refund, state guard
(`LOCKED`), BLAKE2B-256 hashlock compared word-by-word, `HEIGHT ≥ timelock`
gate on refund, amount/receiver/sender in keyed storage, fee split via two
`SEND`s.

Auditor must check (these are **real gaps**, documented not hidden):
- **No `HEIGHT < timelock` guard on `withdraw`.** Unlike EVM/Solana/Sui,
  `fn_withdraw` does not forbid a late withdraw, so after the refund height
  there is a window where both withdraw (with `s`) and refund are valid — a
  refund race. **Mitigation today:** run BLOCK as the maker/long (`T1`) side, or
  add a `HEIGHT < timelock` guard to `withdraw` (the one-line fix noted in the
  README). An auditor should require the guard before BLOCK is ever the short
  leg.
- **Fee bps is NOT capped in bytecode.** EVM/Solana/Sui enforce
  `MAX_FEE_BPS=100`; the BLOCK HTLC bakes whatever `FEE_BPS` the deployer passes
  with **no on-chain cap**. PROTOCOL.md §5 claims a 1% cap "EVM/Solana enforce" —
  that cap does not exist on BLOCK. Add a build-time assert (`fee_bps <= 100`)
  and/or an in-bytecode bound, and have the auditor confirm the baked value.
- **Fee/payout arithmetic overflow.** `fee = amount * fee_bps / 10000` uses the
  VM `MUL`/`DIV`; confirm the VM's integer semantics (wrap vs. trap) and that a
  large `amount * fee_bps` cannot overflow before the divide. `payout = amount −
  fee` must not underflow.
- **Preimage handling.** `withdraw` hashes the entire remaining calldata as the
  preimage; confirm there is no length/aliasing issue and that an empty preimage
  can't match.
- **BLAKE2B vs SHA-256.** BLOCK is BLAKE2B-only ⇒ BLOCK⇄BLOCK only until the VM
  gains a `SHA256` opcode (PROTOCOL.md §4). The relay must never pair BLOCK with
  a SHA-256 leg. No SHA-256 path was faked on the VM.
- **Caller authorization.** `withdraw`/`refund` are callable by anyone and route
  to the stored receiver/sender (correct for HTLC); confirm no redirect.

### 4.5 BTC (`btc/src/htlc.js` — P2WSH, no deployed contract)

**Structure is sound:** witness script
`OP_SHA256 <H> OP_EQUAL OP_IF <recv> OP_ELSE <locktime> OP_CLTV OP_DROP <refund>
OP_ENDIF OP_CHECKSIG`, wrapped in **P2WSH (SegWit v0)**, using **`OP_SHA256`**
(not `OP_HASH160`) so `H` is byte-identical to the other legs. Tests verify real
`hashForWitnessV0` sighashes for both branches.

Auditor must check:
- **Malleability / sighash.** SegWit v0 removes scriptSig malleability; confirm
  the **sighash type** used for signing (SIGHASH_ALL expected) and that the
  refund spend sets `nLockTime = locktime` with a non-final `nSequence`
  (`0xfffffffe`) so CLTV is actually enforced — a wrong `nSequence` silently
  disables the timelock.
- **Fee is cooperative, NOT enforced on-chain.** Bitcoin Script (pre-Taproot/
  CTV) cannot constrain the spend's outputs, so the 0.1% fee lives only in the
  `buildRedeemPsbt` builder the honest receiver uses — **a receiver spending
  directly can skip the fee.** This is a protocol limitation of the BTC leg, not
  a bug; document the expected revenue model accordingly (the swap's safety does
  not depend on the fee).
- **CLTV value domain.** `locktime ≥ 500000000` = unix time, `< 500000000` =
  block height; confirm the chosen domain matches the paired leg and the relay's
  `T2 < T1` sizing, and that the comparison semantics (median-time-past for
  time-based CLTV) are respected in Δ.
- **Address / network derivation** and **dust limits** on the fee + change
  outputs.
- **Live spend shell (`btc/src/esplora.js`).** UTXO selection, fee estimation,
  and broadcast are off-chain and depend on a trusted Esplora endpoint — review
  for fee-rate griefing and for confirmation-depth handling before accepting a
  lock as final.

---

## 5. Known gaps summary (prioritized)

1. **No external audit.** Blocking for mainnet on every leg. (§Recommendation)
2. **Relay leg-sizing is trusted and unaudited** — `T2 < T1`, Δ, confirmation
   depth, and the BLAKE2B/SHA-256 pairing rule all live off-chain. Audit the
   relay alongside the contracts.
3. **BLOCK**: no late-withdraw guard (refund race if BLOCK is the short leg) and
   **no on-chain fee cap** — fix both before BLOCK holds mainnet value.
4. **EVM**: fee-on-transfer/rebasing token shortfall — restrict to standard
   tokens or measure balance deltas.
5. **BTC**: fee is cooperative only (cannot be enforced in Script); verify
   sighash + `nSequence` so CLTV is real.
6. **Solana**: add negative account-validation tests + SPL refund test; decide
   upgrade-authority custody.
7. **No deployment or public-testnet soak** on any leg yet; placeholders
   (`declare_id`, treasury `_TODO_` addresses) must be replaced with real
   deployed values.

---

## 6. Deploy-readiness vs. audit-readiness (do not conflate)

- **Deploy-readiness** (DEPLOY.md): 🟢 the one-command deploy is written and
  gated for every leg; 🟢 BLOCK is runnable by us; 🔴 EVM/Solana/Sui/BTC need the
  operator's funded keys. The relay consumes deployed ids fail-closed and
  testnet-first.
- **Audit-readiness** (this doc): 🔴 **not ready for mainnet on any leg.** The
  code is testnet-grade and unaudited. Deploy to testnets, soak, fix the gaps in
  §5, obtain a third-party audit per chain, record the legal/compliance review,
  and only then flip the mainnet gate (`HTLC_MAINNET_ENABLED` +
  `legalReview.completed`).
