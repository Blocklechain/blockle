# BLOCK ↔ wBLOCK bridge — blockers before real users can deposit funds

This is the explicit, honest list of unresolved security, legal, and technical items that **must**
be closed before any real user deposits real funds. Until every CRITICAL/HIGH item here is
resolved and signed off, the bridge stays in dry-run / testnet only, and the money switches
(`mainnetEnabled`, `dryRun`, `SOLANA_DEPLOY_ENABLED`) must not be flipped. Nothing on this list has
been resolved by the current work — this is code + tests + gated tooling only.

Legend: **CRITICAL** = hard gate; **HIGH** = must resolve before launch; **MEDIUM** = resolve
before scaling beyond a tiny controlled launch.

---

## Trust & design

- **[CRITICAL] Custodial trust model is inherent, not fixed.** wBLOCK is backed by BLOCK in the
  operator's reserve wallet, honored by the operator. It is **not** a trustless on-chain vault and
  cannot be made into one without a cross-chain protocol that does not exist here. Users must be
  told plainly, in-product, that they are trusting the operator's solvency and honesty. This is a
  disclosure + informed-consent blocker, not something an audit removes.

- **[HIGH] Solvency is operational, not cryptographic.** The bucket 1 ≥ bucket 2 invariant is
  enforced by process and monitoring, not by a contract. A published, verifiable **reserve
  attestation** (e.g. signed periodic proof that reserve ≥ supply) should exist before launch so
  the claim is auditable by users, not just asserted.

## Security

- **[CRITICAL] Independent security audit.** The relayer (double-mint resistance, crash recovery,
  reorg handling), the SPL mint-authority handling, the deposit verifier, and the reserve-signer
  integration must be reviewed by an **independent** auditor. Self-attestation does not count. No
  mainnet step proceeds without a written report. (Runbook Stage 2.)

- **[CRITICAL] Cold-key custody for BOTH authorities.** The **BLOCK reserve key** (in the node
  wallet datadir behind the signer) and the **wBLOCK mint authority** must have a documented
  cold-custody + rotation plan (HSM / hardware signer / multisig as appropriate). Today both are
  hot-ish single keys; that is unacceptable for real funds at scale.

- **[HIGH] Mint-authority model decision.** Decide and document: single key vs multisig for mint
  authority, and whether to eventually **revoke** mint authority or cap supply externally. A hot
  single mint key is a single point of total failure (unbacked-mint risk, alert A11).

- **[HIGH] Freeze-authority decision.** Decide whether the wBLOCK SPL mint has a freeze authority
  (enables freezing stolen/maliciously-minted tokens, but adds a censorship capability and a
  trust surface). Record the choice and its rationale before mint creation — it cannot be cleanly
  changed after.

- **[MEDIUM] Reserve-signer hardening review.** Confirm the loopback bind is enforced in prod (no
  nginx proxy), the optional bearer token is set, caps are tuned tight for launch, and the audit
  log is durable. The sentinel-refusal and gating already exist; verify they hold in the real
  deployment.

## Technical

- **[HIGH] Devnet/testnet end-to-end rehearsal.** A full round-trip (deposit → mint → burn →
  release) must complete on Solana devnet + BLOCK testnet, including a forced reorg case, with
  reconciliation showing the invariant held throughout. (Runbook Stage 1.) Not yet done.

- **[HIGH] Relayer crash-recovery proof.** Demonstrate under fault injection that a crash mid-mint
  or mid-release never double-mints or double-releases (the idempotency design exists; it must be
  proven under load, not just asserted).

- **[MEDIUM] Reproducible deployment manifest.** The manifest idea in the runbook must be
  implemented as a reviewed, hash-pinned artifact before mainnet prep, so what gets deployed is
  exactly what was approved.

- **[MEDIUM] Monitoring + paging live.** The health/reserve endpoints and the A1/A4/A11 auto-pause
  (or page-within-minutes) alerts from `MONITORING.md` must be wired and tested before launch, not
  after.

## Legal / compliance

- **[CRITICAL] Legal / compliance sign-off.** The custodial model's regulatory posture
  (money-transmission / custody licensing, per jurisdiction) must be reviewed and signed off by
  counsel, recorded with reviewer + date, before `legalReviewCompleted` is set true. KYC/AML
  obligations must be assessed. This gates mainnet in both the bridge and the reserve-signer.

- **[HIGH] User-facing risk disclosures.** Plain-language disclosures must ship with the product:
  custodial trust, no guaranteed liquidity, slippage on thin pools, redemption rate-limiting under
  caps, and the suspension-with-pending-redemptions behavior (`FEES.md` scenario 8). No language
  that promises profit, appreciation, or guaranteed liquidity.

## Funding (each requires a separate human-signed authorization)

- **[CRITICAL] BLOCK reserve seed.** Funding the reserve (e.g. the ~10,000 BLOCK backing +
  working balance) requires an explicit **human-signed** authorization. An agent must never seed
  the reserve.

- **[CRITICAL] SOL + wBLOCK pool seed.** The indicative pool seed (~$100 SOL / 1,000 wBLOCK,
  see `FEES.md`) and any pool creation require a separate **human-signed** authorization. No pool
  may be created autonomously; creating a pool is explicitly out of scope for automated tooling.

---

## Summary gate
Real user deposits are allowed **only** when: every CRITICAL and HIGH item above is closed and
signed off, the staged runbook (local → devnet → security review → mainnet prep → controlled
launch) has been followed in order, and a fresh explicit human authorization has been given for
the controlled launch. Anything less, the bridge stays dry-run / testnet.
