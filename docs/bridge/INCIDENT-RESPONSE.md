# BLOCK ↔ wBLOCK bridge — incident response

This is the operator playbook for when something goes wrong. The guiding principle: **stopping the
bridge is always safe and reversible; moving money is not.** When in doubt, pause first,
investigate second. Pausing never loses a pending redemption — state rows persist in the durable
store and resume on un-pause.

All recovery actions that move BLOCK go through the loopback `reserve-signer` and its caps/audit
log; there is no out-of-band money path.

---

## 1. Pause controls (how to stop)

There are layered switches, fastest first. Use the fastest that addresses the incident.

1. **Dry-run the bridge** — set `BRIDGE_DRY_RUN=true` (or config `dryRun:true`) and reload. Mints
   and releases immediately become no-ops that record intent. Fastest soft-stop.
2. **Dry-run / disable the reserve-signer** — set `RESERVE_DRY_RUN=true` or
   `RESERVE_MAINNET_ENABLED=false`. This halts **all** real BLOCK movement regardless of what the
   relayer requests. Use this if you suspect the release path specifically.
3. **Stop the relayer process** — halts all polling, minting, and release requests. New deposits
   simply wait; nothing is lost.
4. **Full pause** — do 1 + 2 + 3. Bridge is inert; pool (if any) keeps trading on-chain
   independently (disclosed in `FEES.md` scenario 8).

Document every pause in the incident log: who, when, why, which switches.

---

## 2. Playbooks

### 2.1 Reserve mismatch (backing ratio < 1.0 — alert A1)
The reserve no longer covers outstanding wBLOCK. **This is the worst case.**
1. **Pause fully** (§1.4) — no further mints, no further releases.
2. Reconcile: snapshot bucket 1 (reserve-signer `address` balance on-chain) vs bucket 2
   (wBLOCK outstanding from the SPL mint). Diff against the durable store's mint/release ledger
   to find where they diverged.
3. Classify: (a) an **unbacked mint** (supply too high → see 2.3 mint-authority), or (b) a
   **reserve drain** (reserve too low → see 2.3 / custody).
4. Do **not** resume mints until bucket 1 ≥ bucket 2 again, either by topping up the reserve
   (human-signed BLOCK authorization) or by burning the excess wBLOCK.
5. Communicate honestly: if redemptions are delayed, say so. Never claim full backing while A1 is
   open.

### 2.2 Stalled relayer (alert A7/A8)
1. Check relayer `GET /health`: `lagSeconds`, `pendingMints`, `pendingReleases`,
   `reserveSignerReachable`.
2. If the signer is unreachable, fix that first (§2.? / A3) — releases can't proceed without it.
3. Restart the relayer. Because every operation is idempotent (pending row before action, keyed on
   txid / burn signature, per `settle.ts` discipline), restart **cannot** double-mint or
   double-release; it re-drives stuck rows from where they were.
4. For rows stuck in `minting`/`releasing` beyond SLA (A9): verify on-chain whether the action
   actually landed (query the SPL mint / BLOCK explorer by the recorded txid) before retrying, so
   you reconcile reality rather than blindly resubmitting.

### 2.3 Mint-authority compromise (alert A11)
Unexpected wBLOCK supply increase, or evidence the mint-authority key is exposed.
1. **Pause fully** (§1.4) immediately.
2. If the key is only *suspected* exposed: rotate the mint authority to a fresh key held in cold
   custody (requires authority-signed transaction; human-authorized).
3. If unbacked wBLOCK was minted: treat as a reserve mismatch (2.1) — quantify the unbacked
   supply, and either burn it (if under operator control) or top up the reserve to re-cover, with
   a public disclosure.
4. Longer-term: the freeze-authority decision (see `BLOCKERS.md`) determines whether malicious
   wBLOCK can be frozen; decide and document this before mainnet.
5. Preserve logs; this is a security incident, not just an ops hiccup.

### 2.4 BLOCK reorg (alert A10)
A deposit's confirmations regress below `confirmationDepth`, or a counted deposit disappears.
1. The `confirmationDepth=100` default (BLOCK coinbase maturity) makes this unlikely, but handle
   it anyway.
2. Freeze mints for the affected txid. If wBLOCK was already minted against a deposit that is now
   invalid, treat the delta as a reserve mismatch (2.1).
3. Re-verify the deposit once the chain restabilizes using the read-only explorer path; resume only
   if it re-confirms to depth paying the deposit address.

### 2.5 Reserve-signer down (alert A3)
1. Redemptions can't be honored while the signer is down; they **queue** (state `verified`/
   `releasing`), they are not lost.
2. Restart the signer (`GET /healthz` returns `{ ok, address }` when healthy). Confirm its money
   switches are in the intended state before it starts dispensing again.
3. The relayer resumes draining the release queue idempotently once the signer is reachable.

---

## 3. Recovery & resumption checklist
Before un-pausing after any incident:
- [ ] Backing invariant restored: bucket 1 ≥ bucket 2, verified from on-chain reads (not just the
      ledger).
- [ ] Root cause identified and the specific failure path closed.
- [ ] Keys confirmed uncompromised (or rotated); mint authority + reserve key custody verified.
- [ ] Stuck state rows reconciled against on-chain reality.
- [ ] Caps reviewed (consider lowering `dailyCapBlock` / `maxAmountBlock` during the recovery
      window to bound blast radius).
- [ ] Incident logged; if users were affected, a plain, honest disclosure is prepared.
- [ ] Un-pause in reverse order of §1: start relayer → re-enable signer → clear bridge dry-run,
      watching [`MONITORING.md`](./MONITORING.md) alerts at each step.

---

## 4. Non-negotiables during any incident
- Never move BLOCK outside the reserve-signer (there is no other sanctioned path).
- Never claim full backing or guaranteed redemption while a reserve mismatch is open.
- Never disable the audit log to "move faster".
- Any fund movement to fix an incident is a **human-authorized** action, recorded.
