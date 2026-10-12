# Wallet Security Suite — spec

One spec, three identical implementations: `blockle-extension` (JS, reference),
`blockle-app/lib` (Dart), `python/blockle` (Python). Shared vectors:
`docs/security-vectors.json` (authored by the extension; ports assert against it).

Goal: stop the #1 way funds get drained — blind-signing a malicious transaction or a
hostile token approval. Everything here is **read-only analysis + warnings**; it never
signs, never moves funds, and never fabricates a safety claim (absence of a warning ≠ safe).

## 1. `inspectTransaction(tx, ctx) -> Inspection`  (the core, pure + testable)

Decodes an *outgoing* transaction into a human-readable preview + typed warnings, BEFORE it
is signed. Pure given its inputs (RPC lookups are injected via `ctx`, mockable).

```
Inspection = {
  chain, kind,                 // 'native-transfer' | 'token-transfer' | 'token-approval' |
                               // 'contract-call' | 'block-send' | 'utxo-send' | 'unknown'
  summary: string,             // one-line plain-language ("Send 1.5 ETH to 0xabc…")
  details: [ {label, value} ], // decoded fields (to, amount, token, spender, selector…)
  effects: [ {asset, direction:'out'|'in', amountBase, usd?} ],  // best-effort net effect
  warnings: [ Warning ],       // see §3; [] means "nothing flagged", NOT "safe"
  severity: 'none'|'info'|'warn'|'danger',   // max over warnings
}
```

Decoding per chain (no fabrication — unknown stays `kind:'contract-call'`/`'unknown'`):
- **EVM**: parse calldata by selector. Recognize `transfer(address,uint256)` (a9059cbb),
  `approve(address,uint256)` (095ea7b3), `transferFrom` (23b872dd), `setApprovalForAll`
  (a22cb465). Native value > 0 with empty data → native-transfer. Decode the `to`, token,
  amount/allowance, spender. Unknown selector → `contract-call` with the raw selector shown.
  Amount `2^256-1` (or `>= UINT_UNLIMITED_THRESHOLD`) → mark the approval **unlimited**.
- **Solana**: decode instructions enough to recognize SystemProgram transfer + SPL
  token transfer/approve; otherwise `contract-call` listing the program ids.
- **UTXO (BTC/LTC/DOGE)**: summarize inputs/outputs + the net send amount + change.
- **BLOCK**: native send (to, amount, fee).

## 2. Approval manager

```
listApprovals(chain, owner, ctx) -> [ Approval ]   // READ-ONLY
Approval = { token, tokenSymbol, spender, spenderLabel?, allowanceBase, unlimited:bool, lastUpdated? }
buildRevoke(chain, token, spender) -> tx            // approve(spender, 0) calldata; still goes through the normal sign gate
```
- EVM: source allowances from the indexer (Alchemy token-allowances / `Approval` logs)
  injected via `ctx`; compute `unlimited` from the threshold. No indexer → empty list +
  an audited "approvals unavailable" note (never a fabricated empty "all clear").
- Revoke builds `approve(spender, 0)` via the existing `erc20ApproveData` and routes through
  the normal signing path (and the agent gate) — the suite itself never signs.

## 3. Scam / phishing / malicious-approval warnings (configurable, flag-based)

`Warning = { code, severity, message, evidence? }`. Rules (each independently toggleable;
thresholds in config). Representative set (pin exact codes in the vectors):

- `unlimited-approval` (warn) — an approval with unlimited allowance.
- `approval-to-unknown-spender` (warn) — spender not on the known-good router allowlist
  (Uniswap/1inch/0x/Jupiter/Blockle routers) AND not previously approved by this wallet.
- `approval-to-eoa` (danger) — approving a spender with no code (an EOA can't be a router;
  classic drainer pattern). Requires a code check via `ctx.getCode`; skip rule if unavailable.
- `known-drainer` (danger) — `to`/`spender` on the configurable denylist of known drainer
  addresses (`config.denylist`, operator-updatable; ships small + conservative).
- `send-to-flagged` (danger) — recipient on the denylist.
- `setApprovalForAll-true` (danger) — NFT operator-approval for a whole collection.
- `new-address` (info) — first time this wallet sends to this recipient (from local history).
- `large-share` (warn) — effect spends > `config.largeSharePct` of the asset balance.
- `mismatch-currency` (info) — sending a token whose USD value can't be resolved.

Never claim "safe". The UI shows warnings by severity; `danger` requires an explicit extra
confirm. No rule fabricates reputation — a clean result says "no warnings from N checks", and
lists which checks couldn't run (e.g. "code check skipped: no RPC").

## 4. Pre-sign gate + agent/bots reuse

- The signer calls `inspectTransaction` before signing; `danger` → an extra confirm step
  (the user must acknowledge the specific warnings). This is UI-enforced, not bypassable by a
  tool.
- The in-wallet agent/bots call `inspectTransaction` on a prepared swap/transfer in
  `prepare()` and attach the resulting `warnings`/`severity` to the confirm summary; a
  `danger`-severity inspection is surfaced in the gate's confirm (it does not silently
  auto-approve a danger even under `autoApproveUnderUsd`/within-allocation — a danger forces a
  confirm). This composes with, and never weakens, the existing policy gate.

## 5. Parity + tests

`docs/security-vectors.json`: canonical decode + warning cases asserted identically in all
three languages —
- EVM transfer decode (to/amount), approve decode (spender/allowance), **unlimited** flag,
  transferFrom, setApprovalForAll, unknown selector → contract-call.
- warning triggers: unlimited-approval, approval-to-eoa (with a mocked no-code spender),
  known-drainer (denylist), send-to-flagged, large-share, new-address; and a clean tx →
  `warnings:[]`, severity `none`, with the "N checks ran" list.
- revoke builds `approve(spender,0)` calldata exactly.
- gate composition: a `danger` inspection forces a confirm even within allocation / under the
  auto-approve threshold.

All money math base-unit/BigInt-exact. The suite is read-only; the only state it writes is a
local "seen recipients" set for `new-address` (no keys, no PII beyond addresses the wallet
already handles). Keep all existing tests green.
