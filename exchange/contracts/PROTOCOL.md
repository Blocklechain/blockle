# Blockle cross-chain atomic-swap protocol

Non-custodial exchange. A trade settles as a pair of **hash-timelocked
contracts (HTLCs)**, one per chain. Funds move wallet-to-wallet; the relay (or
any coordinator) only matches orders and broadcasts transactions — it **never
holds, signs for, or can seize user funds**. Each leg can only pay its intended
receiver (on preimage reveal) or refund its depositor (after a timeout).

This document is the single source of truth the three implementations must
agree on:

- `evm/`    — Solidity HTLC for ETH + arbitrary ERC-20 (USDC, USDT). Builds + tests.
- `solana/` — Anchor HTLC for SOL + arbitrary SPL (USDC, USDT). Builds + tests.
- `block/`  — Blockle-VM HTLC (BLAKE2B hashlock, height timelock). Builds + tests.

---

## 1. Roles and the single secret

A swap has two parties and **one secret preimage `s`** (32 random bytes) chosen
by the party who locks first (the *maker*). From `s` we derive the hashlock
`H = hash(s)` (see §4 for the per-chain hash function).

- **Maker (A)** holds asset A, wants asset B. Generates `s`, publishes `H`.
- **Taker (B)** holds asset B, wants asset A.

Atomicity comes from one fact: **the act of claiming reveals `s` on-chain**, and
`s` is what the counterparty needs to claim the other leg. Either both legs
complete or both refund. Nobody can claim one leg without enabling the other.

## 2. State machine

```
            lock(H, T)                  withdraw(s)                 settled
  (none) ─────────────────▶ LOCKED ───────────────────────▶ WITHDRAWN
                              │                                 (receiver paid,
                              │  refund()  [now ≥ T]             fee taken)
                              └───────────────────────────▶ REFUNDED
                                                               (depositor repaid,
                                                                no fee)
```

Each leg is independent on-chain but linked by the shared `H` and `s`:

```
Maker A on chain-A         Taker B on chain-B
──────────────────         ──────────────────
1. lock(A, H, T1) ───────▶
                           2. verify A's lock, then lock(B, H, T2)   [T2 < T1]
3. withdraw B with s ◀──── (A reveals s on chain-B, claiming B)
   └─ s now public on chain-B
                           4. withdraw A with s  (B reads s, claims A on chain-A)
```

If step 2 never happens, A refunds after `T1`. If step 3 never happens, both
refund (B after `T2`, A after `T1`). Because `T2 < T1`, once B's leg can be
refunded, A still has time to refund A's leg too — A is never left exposed.

## 3. Timelocks and the `T2 < T1` rule

- **`T1`** = maker's (first) leg timelock. **Longer.**
- **`T2`** = taker's (second) leg timelock. **Shorter.**
- Invariant: `T2 < T1`, with a safety gap `Δ = T1 − T2` large enough that after
  the maker claims the taker's leg just before `T2`, the maker still has time to
  be included on chain-A before `T1`.

Recommended defaults (configurable per market; tune to each chain's finality):

| Leg | Timelock basis | Default |
|-----|----------------|---------|
| EVM    | `block.timestamp` (unix seconds) | maker `T1 = now + 24h`, taker `T2 = now + 12h` |
| Solana | `Clock.unix_timestamp` (unix seconds) | same as EVM |
| BLOCK  | block **height** (`HEIGHT`) | `T` = `tip + ceil(hours/ (600s/block))` → e.g. 24h ≈ 144 blocks |

`Δ` should comfortably exceed the slower chain's reorg/confirmation window. The
relay must also wait a configurable confirmation depth before treating any lock
as final (reorg safety) — that policy lives in the off-chain service, not in the
contracts.

### Withdraw vs. refund windows
- `withdraw` is only valid **while `now < T`** (EVM/Solana) — after the timelock
  only `refund` is possible. This removes the post-timeout race where both
  withdraw and refund are simultaneously valid.
- The BLOCK leg mirrors this: `withdraw` requires state `LOCKED`; `refund`
  requires `HEIGHT ≥ T`. (BLOCK does not additionally forbid a late withdraw;
  since `T2 < T1` and the relay reveals `s` well before `T2`, operate the BLOCK
  leg as the **maker/long** (`T1`) side when pairing with a timestamp chain, or
  add the same `HEIGHT < T` guard if BLOCK is the short side — see `block/`
  README.)

## 4. Hash choice — and the one honest limitation

A cross-chain HTLC is only safe if **both legs verify the same preimage against
hashlocks that are provably derived from the same `s`.** If the two legs used
*different* hash functions (`H_A = f(s)` on one, `H_B = g(s)` on the other), a
malicious maker could pick `H_A = f(s1)` and `H_B = g(s2)` with `s1 ≠ s2`; the
taker cannot detect this without already knowing a preimage, and ends up locking
funds that the maker can take while the taker's claim fails. **Therefore the two
legs of a given swap MUST use the same hash function.**

Per-chain hashing primitives actually available:

| Chain  | Native hash available on-chain | Used by this protocol |
|--------|--------------------------------|-----------------------|
| EVM    | `sha256` (precompile 0x02), `keccak256` | **SHA-256** |
| Solana | `sha256`, `keccak`, `blake3` (syscalls) | **SHA-256** |
| BLOCK  | **`BLAKE2B` only** (VM opcode `0x68`); **no `SHA256` opcode** | BLAKE2B |

Consequences, stated plainly:

1. **EVM ⇄ Solana** swaps use **SHA-256 on both legs** → fully safe and
   supported today. `H = sha256(s)`.
2. **BLOCK ⇄ BLOCK** swaps use **BLAKE2B on both legs** → fully safe and
   supported today. `H = blake2b256(s)`.
3. **BLOCK ⇄ EVM** and **BLOCK ⇄ Solana** cannot share a hashlock today, because
   the Blockle VM exposes no SHA-256. Mixing BLAKE2B on one leg and SHA-256 on
   the other is the unsafe cross-hash case above and is **not** implemented.

### The single missing opcode (documented, not faked)
To make BLOCK a first-class leg against EVM/Solana, the Blockle VM needs a
**`SHA256` host opcode** so the BLOCK HTLC can verify `sha256(preimage)` and use
the identical `H = sha256(s)` as the other legs. Concretely, in
`chain/crates/vm/src/lib.rs`:

- add `pub const SHA256: u8 = 0x6a;` (next free opcode after `ZKVERIFY = 0x69`),
- implement it exactly like `BLAKE2B` (pops `dst, len, src`; writes a 32-byte
  digest) using a SHA-256 implementation (`sha2` crate — already a workspace
  dependency),
- add the `"SHA256"` mnemonic in `chain/crates/vm/src/asm.rs`.

Until that opcode exists, the BLOCK leg here uses BLAKE2B and is proven working
for BLOCK⇄BLOCK; the builder in `block/` is written so that swapping the one
hash call over to a `SHA256` opcode is the only change needed to light up
BLOCK⇄EVM/Solana. We did **not** fake a SHA-256 path on the VM.

## 5. Protocol fee

A **0.1% fee (10 bps, configurable)** is taken **only on settlement**
(`withdraw`, i.e. the happy path). A `refund` (failed swap) takes **no fee** —
users are made whole. The fee goes to a **configurable fee address**, never
hardcoded in logic.

Exactly where the fee is applied on each leg:

| Leg | Fee computation | Where it goes | Code |
|-----|-----------------|---------------|------|
| EVM | `fee = amount * feeBps / 10000` inside `withdraw`; receiver gets `amount - fee` | `feeAddress` (immutable ctor arg) | `evm/contracts/HTLC.sol` `withdraw()` → `_payOut` |
| Solana | same, inside `withdraw_sol` / `withdraw_spl` | `config.fee_wallet` (SOL) / `fee_ata` owned by `config.fee_wallet` (SPL) | `solana/programs/htlc/src/lib.rs` |
| BLOCK | same, inside the `withdraw` branch; two `SEND`s (payout to receiver, fee to fee addr) | `fee_addr` baked into bytecode at build time | `block/src/lib.rs` `htlc_asm` |

`feeBps` is capped (EVM/Solana enforce `MAX_FEE_BPS = 100` = 1.00%) so a
misconfiguration cannot confiscate a trade.

## 6. Failure / refund paths (every one)

1. **Taker never locks leg B** → maker `refund`s leg A after `T1`. Done.
2. **Maker never reveals `s`** (abandons after both locked) → taker `refund`s B
   after `T2`; maker `refund`s A after `T1`. Both whole.
3. **Wrong preimage submitted** → `withdraw` reverts (`InvalidPreimage`); funds
   stay `LOCKED` until a correct `s` or a refund.
4. **Double withdraw / double refund** → second call reverts (`NotLocked` /
   state no longer `LOCKED`). One-shot per leg.
5. **Early refund** (before timelock) → reverts (`TimelockNotExpired`).
6. **Late withdraw** (after timelock, EVM/Solana) → reverts (`TimelockExpired`);
   only refund remains.
7. **Reorg** → handled off-chain by the configurable confirmation depth before a
   leg is acted on; on-chain state is idempotent (state flag) so replays are
   no-ops.

## 7. Testnet-first and mainnet gating

Every money path is **disabled on mainnet by default**:

- EVM: `scripts/deploy.js` refuses any non-testnet network unless
  `HTLC_MAINNET_ENABLED=true` **and** `HTLC_LEGAL_REVIEW_REF` (a recorded
  legal/compliance sign-off reference) are both set. Dev targets Base Sepolia /
  Sepolia.
- Solana: the `Config` account carries `mainnet_enabled` (default `false`), flip
  only via the authority-gated `set_mainnet`. Dev targets localnet / devnet.
- BLOCK: runs on regtest/testnet; the exchange service holds the
  `mainnet_enabled` switch for BLOCK money paths.

> **Operators: obtain legal/compliance sign-off before enabling any mainnet
> money path.** KYC / geo-screening hooks live at the fiat/custody boundaries in
> the off-chain service (no-op in dev); these contracts are non-custodial and do
> not themselves onboard fiat.

## 8. Reference: ABI per leg

**EVM** (`HTLC.sol`)
- `lock(bytes32 hashlock, uint256 timelock, address receiver, address token, uint256 amount) payable → bytes32 id`
- `withdraw(bytes32 id, bytes preimage)`  · `refund(bytes32 id)`
- `token == address(0)` ⇒ native ETH (send `msg.value == amount`); otherwise an
  ERC-20 (approve first). USDT-style no-return tokens are handled.

**Solana** (Anchor program `htlc`)
- `initialize(fee_bps, fee_wallet)` · `set_mainnet(enabled)`
- SOL: `lock_sol / withdraw_sol / refund_sol`
- SPL: `lock_spl / withdraw_spl / refund_spl` (mint is a per-swap account)

**BLOCK** (VM bytecode via `blockle-htlc`)
- Deploy the HTLC code, then `Call` with a leading selector byte:
  - `0x00` lock: `receiver(32) ‖ hashlock(32) ‖ timelock_height(8 LE)`, `value = amount`
  - `0x01` withdraw: `preimage(..)`
  - `0x02` refund
