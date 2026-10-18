# BLOCK ↔ wBLOCK bridge — monitoring

The operator must be able to answer, at any moment: **is the bridge solvent, is it keeping up,
and is any money switch live that shouldn't be?** This doc lists the health surface and the alert
conditions. All endpoints bind loopback; expose them only through an authenticated operator
channel, never publicly.

---

## 1. Health / status endpoints

### Bridge service — `GET /health`
Mirrors the settlement service's health shape (`services/settlement/src/server.ts`). Returns the
current posture without moving anything:
```jsonc
{
  "status": "ok",
  "cluster": "devnet",
  "mainnetEnabled": false,
  "legalReviewCompleted": false,
  "dryRun": true,
  "confirmationDepth": 100,
  "dailyCapBlock": 1000,
  "feeBps": 0
}
```

### Bridge service — `GET /reserve` (solvency snapshot)
The single most important read. Reports the five buckets and the backing invariant:
```jsonc
{
  "blockReserveBase": "…",        // bucket 1: operator BLOCK that backs wBLOCK
  "solblockOutstandingBase": "…", // bucket 2: wBLOCK minted, not burned
  "backingRatio": 1.0,            // bucket1 / bucket2 ; MUST be >= 1.0
  "solSeedUsd": 0,                // bucket 3 (0 until a pool is seeded)
  "lpPresent": false,             // bucket 4
  "treasuryBase": "0",            // bucket 5
  "asOf": 0
}
```

### Reserve-signer — `GET /healthz`
Already shipped: `{ ok, address, mainnet, dryRun }`. Confirms the only BLOCK-moving process is
reachable and reports whether its money switches are live.

### Relayer — `GET /health`
```jsonc
{
  "status": "ok",
  "lastBlockScanHeight": 0,     // last BLOCK height scanned for deposits
  "lastSolanaSlot": 0,          // last Solana slot scanned for burns
  "pendingMints": 0,            // rows in confirmed/minting
  "pendingReleases": 0,         // rows in verified/releasing
  "lagSeconds": 0,              // now - lastScanTime
  "reserveSignerReachable": true
}
```

### Operator dashboard
A read-only panel composing the above: posture (switches), solvency (backing ratio + buckets),
throughput (pending mints/releases, lag), caps usage (BLOCK dispensed today vs daily cap), and a
tail of the reserve-signer audit log. No action buttons perform money moves without the gated
flow in [`INCIDENT-RESPONSE.md`](./INCIDENT-RESPONSE.md).

---

## 2. Alert conditions

| # | Condition | Severity | Why it matters / response |
|---|-----------|----------|---------------------------|
| A1 | `backingRatio < 1.0` (bucket 1 < bucket 2) | **CRITICAL** | Reserve under-collateralized vs outstanding wBLOCK — the core invariant is broken. **Pause immediately** and investigate (possible unbacked mint or reserve drain). |
| A2 | Backing ratio dropping trend (e.g. < 1.02 and falling) | HIGH | Early solvency erosion; investigate before it breaches A1. |
| A3 | Reserve-signer `GET /healthz` not `ok`, or unreachable | HIGH | Redemptions cannot be honored; releases stall. Restore the signer; releases queue in the meantime. |
| A4 | Money switches live unexpectedly (`mainnetEnabled && !dryRun`) when not in a sanctioned launch window | **CRITICAL** | Possible misconfig or compromise; funds can move. Flip to dry-run / pause and verify authorization. |
| A5 | Daily BLOCK dispense approaching/at cap (`≥ 90%` of `dailyCapBlock`) | MEDIUM | Redemptions will start rate-limiting; expected under load but confirm it is legitimate demand, not an attack. |
| A6 | Per-dispense rejection spike (amount/recipient/sentinel rejects) | MEDIUM | Either user error or probing; inspect the audit log. |
| A7 | Relayer `lagSeconds` above threshold (e.g. > 5 min) | HIGH | Relayer is behind or stalled; deposits aren't minting / burns aren't releasing. See stalled-relayer runbook. |
| A8 | `pendingMints` or `pendingReleases` monotonically rising | HIGH | Work is arriving faster than it clears, or a row is stuck in a non-terminal state. |
| A9 | A deposit/burn stuck in a non-terminal state beyond SLA (e.g. `minting`/`releasing` > N min) | HIGH | Likely a failed submit needing operator review; risk of perceived loss of funds. |
| A10 | BLOCK reorg detected affecting a counted deposit (confirmations regress) | HIGH | A deposit we minted against may no longer be valid. Freeze mints for the affected tx; reconcile. |
| A11 | Mint authority used outside the relayer (unexpected wBLOCK supply increase) | **CRITICAL** | Possible mint-authority compromise. Treat as incident; see INCIDENT-RESPONSE. |
| A12 | Audit-log write failures on the reserve-signer | MEDIUM | Loss of attributability; fix IO before further dispenses (signer degrades safe but visibility drops). |
| A13 | SOL seed / LP depth drop below a floor (if a pool exists) | LOW/MEDIUM | Tradeability + slippage worsen (see `FEES.md`); not a backing issue, but user-facing. |

A1, A4, and A11 are the three that should **auto-trigger a pause** (or page a human to pause
within minutes), because each means money can move wrongly.

---

## 3. What to watch continuously vs on-change
- **Continuous (polled dashboard):** backing ratio, relayer lag, pending counts, daily-cap usage.
- **On-change (event/alert):** any money switch flip, any reorg, any mint-authority use outside
  the relayer, any backing-ratio breach. These should page, not just chart.
