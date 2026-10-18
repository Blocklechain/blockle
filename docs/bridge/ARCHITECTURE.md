# BLOCK ↔ wBLOCK bridge — architecture

**Status:** code + tests + gated tooling only. Nothing in this document is deployed, and no
real BLOCK, SOL, or SPL token has been minted, moved, or locked. Every money/deploy path is
gated behind an explicit config flag that defaults OFF / dry-run and requires human
authorization to flip. See [`BLOCKERS.md`](./BLOCKERS.md) before anyone deposits real funds.

---

## 1. Trust model — read this first

> **This is a CUSTODIAL, trusted-operator bridge.** wBLOCK is an SPL token on Solana that is
> backed 1:1 by BLOCK held in the **operator's reserve wallet** on the BLOCK chain. Holding
> wBLOCK is a claim on operator-held BLOCK, honored by the operator running the redemption
> path below. It is **NOT** a trustless, on-chain vault; there is no smart contract on either
> chain that programmatically guarantees the backing. An off-chain ledger is **not** an
> on-chain vault, and we never describe it as one.

What the operator is trusted to do, and what limits that trust:

- **Trusted:** to hold the BLOCK reserve honestly, to mint wBLOCK only against verified
  deposits, to release BLOCK only against verified burns/redemptions, and to keep the reserve
  ≥ outstanding wBLOCK supply at all times.
- **Bounded by construction:** the only process that can move reserve BLOCK is the
  loopback-only `reserve-signer`, which enforces a daily cap, a per-dispense cap, recipient
  validation, and an audit log, and refuses to send at all unless three switches
  (`mainnetEnabled && legalReviewCompleted && !dryRun`) are explicitly set.
- **Not guaranteed:** solvency is an operational promise, not a cryptographic one. A dishonest
  or compromised operator can mint unbacked wBLOCK or fail to honor redemptions. Mitigations
  (cold custody, published reserve attestation, caps) reduce but do not eliminate this.

---

## 2. Components

```
  BLOCK chain                     bridge service + relayer                 Solana
  ───────────                     ────────────────────────                 ──────
                                                                    ┌──────────────────┐
  user sends BLOCK ───────▶  (1) deposit verify (read-only)         │  wBLOCK SPL     │
  to bridge deposit addr        GET /explorer/tx/{id}  ───────────▶ │  mint (Token      │
                                confirmations ≥ depth               │  Program,         │
                                                     (2) mint ─────▶│  decimals 8)      │
                                                                    └──────────────────┘
                                                                            │ user holds / trades
                                                                            │ wBLOCK, then burns
                                                                            ▼
  reserve-signer (loopback) ◀─── (4) POST /reserve/dispense ◀── (3) redemption verify
  moves reserve BLOCK            { purpose, amountBase,            relayer sees burn on Solana,
  (gated, capped, audited)        asset:"BLOCK", to }              verifies, then releases BLOCK
          │
          ▼
  BLOCK released to user's block1… address
```

### 2.1 Deposit verifier (read-only, no keys)
Reuses the **exact** approach in `services/settlement/src/chain.ts` (`NodeChainReader`): it reads
the BLOCK node aux-http explorer with `GET /explorer/tx/{id}`, sums outputs paid to the bridge
deposit address, and returns `{ amountBase, confirmations, displayTxid }`. It tries the txid both
as-given and reversed (raw ↔ display hash). **No keys, no wasm on the BLOCK side** — it only
confirms a transaction paid the deposit address and how deep it is buried. A deposit is eligible
to mint once `confirmations ≥ confirmationDepth` (default **100**, matching BLOCK coinbase
maturity and the settlement service's reorg-safety depth).

### 2.2 wBLOCK SPL mint
A **standard SPL mint** under the SPL Token Program — no custom Solana program. Decimals **8** to
match BLOCK's `COIN = 1e8` base unit exactly, so 1 wBLOCK base unit ↔ 1 BLOCK base unit with no
rounding. Mint authority is the **bridge operator key** (held in a signer/secret manager, never in
source). There is **no hardcoded permanent supply cap** — outstanding supply is whatever has been
minted against verified, unredeemed deposits. (Freeze authority: see `BLOCKERS.md` — a decision
that needs sign-off.)

### 2.3 Relayer
A long-running operator process that drives both directions:
- **Deposit → mint:** polls for inbound BLOCK to the deposit address, waits for
  `confirmationDepth`, then mints the matching wBLOCK to the user's Solana address.
- **Burn/redeem → release:** watches wBLOCK burn events on Solana, verifies them, then
  **releases BLOCK by POSTing to `reserve-signer`** (`POST /reserve/dispense`). The relayer
  **never holds the reserve key** — it only asks the loopback signer to dispense.

### 2.4 Reserve release (the only BLOCK-moving process)
`services/reserve-signer` (bind `127.0.0.1` only) is the sole process that moves reserve/premine
BLOCK. Contract:
- `POST /reserve/dispense { purpose, amountBase, asset:"BLOCK", to } -> { txid, detail, dryRun }`
- `GET /healthz -> { ok, address }`

It enforces the `mainnetEnabled && legalReviewCompleted && !dryRun` gate, a daily BLOCK cap, a
per-dispense cap, recipient (`block1…`) + amount validation, rejection of the placeholder seed
sentinel, and a JSONL audit log. The bridge adds a bridge-specific `purpose` (e.g.
`bridge-redemption`) so dispenses are attributable in the audit trail.

### 2.5 Durable store
Bridge state (deposits, mints, redemptions, idempotency keys) persists through the atomic
file-store + write-queue pattern from `services/accounts/src/store.js` (the same store the social
service reuses). State is append-friendly and crash-safe; it is an **operational ledger**, not an
on-chain source of truth.

---

## 3. State machines

Deposit → mint (one row per BLOCK deposit txid; idempotent on txid):

| state        | meaning                                                          |
|--------------|------------------------------------------------------------------|
| `seen`       | inbound BLOCK tx observed, below confirmation depth              |
| `confirmed`  | `confirmations ≥ confirmationDepth`, amount verified             |
| `minting`    | SPL mint submitted to Solana                                     |
| `minted`     | wBLOCK delivered; terminal success                            |
| `failed`     | verification or mint failed; terminal, needs operator review     |

Redeem/burn → release (one row per Solana burn; idempotent on burn signature):

| state         | meaning                                                         |
|---------------|-----------------------------------------------------------------|
| `burn-seen`   | wBLOCK burn observed on Solana                                |
| `verified`    | burn confirmed + recipient `block1…` validated                 |
| `releasing`   | `POST /reserve/dispense` in flight (may be dry-run)            |
| `released`    | reserve-signer returned a BLOCK txid; terminal success          |
| `failed`      | verification or dispense failed; terminal, needs operator review |

The pending-row-before-pay idempotency discipline mirrors `services/settlement/src/settle.ts`
(begin pending → act → settle), so a crash mid-flight never double-mints or double-releases.

---

## 4. The 5 asset buckets

Reserve accounting tracks five distinct buckets. They are **not** fungible with one another, and
the invariant that matters for solvency is bucket 1 ≥ bucket 2.

1. **BLOCK reserve** — operator-held BLOCK on the BLOCK chain that backs wBLOCK. The signer's
   `address` is the authoritative balance. **Invariant: ≥ outstanding wBLOCK supply.**
2. **wBLOCK outstanding supply** — total wBLOCK minted and not yet burned, read from the SPL
   mint on Solana. This is the operator's liability.
3. **SOL seed liquidity** — SOL the operator contributes to a wBLOCK/SOL trading pool so the
   token is tradeable (see `FEES.md`; indicative seed $100 SOL / 1,000 wBLOCK). Owned by the
   operator; at market risk.
4. **LP position** — pool LP tokens representing bucket 3 + its paired wBLOCK once a pool
   exists. Subject to impermanent loss and pool solvency, separate from the 1:1 backing.
5. **Treasury / fees** — any bridge fees or network-fee recovery accrued (default fee is 0; see
   `FEES.md`). Operator-owned, not part of the backing.

Buckets 3–5 exist only once liquidity and fees are configured; the bridge's core backing promise
is purely buckets 1 vs 2.

---

## 5. Production-readiness by component

| Component                         | State                                                        |
|-----------------------------------|--------------------------------------------------------------|
| Deposit verifier (explorer read)  | **Production-ready pattern** — reuses shipped settlement code |
| reserve-signer (BLOCK release)    | **Production-ready + gated** — already shipped, loopback, capped |
| Durable store                     | **Production-ready pattern** — reuses shipped accounts store  |
| wBLOCK SPL mint tooling         | Built as **gated/dry-run tooling**; needs devnet rehearsal + external review before any real mint |
| Relayer                           | Needs external review (reorg handling, crash recovery, double-mint resistance under load) |
| Pool / LP (buckets 3–4)           | Design only — **no pool exists**; creating one needs human-signed SOL authorization |
| End-to-end custody (cold keys)    | **Not ready** — reserve + mint-authority cold-key custody is an open blocker |

"External review" means an independent security audit and operator/legal sign-off — not
self-attestation. See [`BLOCKERS.md`](./BLOCKERS.md).

---

## 6. Related docs
- [`FEES.md`](./FEES.md) — fee + economic model, the indicative pool price, the 8 scenarios.
- [`RUNBOOK.md`](./RUNBOOK.md) — staged deployment (local → devnet → review → mainnet prep → launch).
- [`ENV.md`](./ENV.md) — environment-variable reference.
- [`MONITORING.md`](./MONITORING.md) — health endpoints + alert conditions.
- [`INCIDENT-RESPONSE.md`](./INCIDENT-RESPONSE.md) — pause controls + recovery.
- [`BLOCKERS.md`](./BLOCKERS.md) — unresolved blockers before real deposits.
