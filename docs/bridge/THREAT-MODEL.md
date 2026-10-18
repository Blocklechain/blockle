# BLOCK ↔ wBLOCK Bridge — Threat Model

**This is a custodial, trusted-operator bridge.** wBLOCK (Wrapped Blockle) is an
SPL token on Solana backed 1:1 by native BLOCK held in the operator's reserve
wallet. It is **not** a trustless on-chain vault, and an off-chain balance is not
the same as on-chain collateral. Users of wBLOCK trust the operator to (a) keep
the reserve solvent and (b) honor redemptions. Read this before depositing.

## Trust boundaries

| Component | Trusted? | What it can do |
|---|---|---|
| Reserve wallet (holds BLOCK) | **Fully trusted** | Operator controls the keys. A compromise/misuse can drain backing. Mitigation: cold/multisig custody + daily caps in reserve-signer. |
| Solana mint authority (mints wBLOCK) | **Fully trusted** | A compromise can mint unbacked wBLOCK. Mitigation: cold/HSM custody, supply reconciliation + auto-pause on mismatch. |
| Relayer process | **Trusted for liveness, NOT for authorization** | It executes engine-authorized actions. It cannot *fabricate* backing: a mint requires a deep-confirmed BLOCK deposit; a release requires a finalized Solana burn. A compromised relayer can **stall** the bridge or, within the reserve-signer caps, attempt releases — but it holds no reserve key and every release is capped + audited by reserve-signer. |
| Blockle node explorer | Trusted data source for deposit verification | The relayer reads `/explorer/tx/{id}` to confirm a deposit. A lying/compromised node could assert a fake deposit. Mitigation: run our own node; require `confirmationDepth=100`; reconcile issued supply vs on-chain reserve. |
| Solana RPC | Trusted data source for burn verification | Used to confirm finalized burns. Mitigation: use a reputable RPC / our own; require `finalized`. |

## Independently verified (cryptographically / on-chain)

- **BLOCK deposit**: a specific txid paid the bridge address, at ≥100 confirmations (reorg safety matches `services/settlement`). Read-only; no keys.
- **Solana burn**: a finalized burn of the wBLOCK mint, with the redemption BLOCK address in an SPL-memo.

## NOT verified / must be trusted

- That the operator's reserve actually holds the backing BLOCK (verify via the published reserve address on the explorer — the bridge exposes it; do your own check).
- That the mint authority is not abused.
- That the operator honors redemptions promptly and does not pause maliciously.

## How a compromise affects users

- **Reserve key compromise** → backing can be stolen; wBLOCK becomes under-/un-backed. *Highest-impact.* → cold/multisig + minimal hot float + alerts.
- **Mint-authority compromise** → unbacked wBLOCK minted → holders/LPs diluted; reconciliation detects the supply>reserve mismatch and should auto-pause issuance.
- **Relayer compromise** → stalled transfers or capped release attempts; cannot mint without a real deposit or release beyond reserve-signer's daily cap; no key exfiltration (keys live in reserve-signer/HSM, not the relayer).
- **Node/RPC lie** → a fabricated deposit could authorize a mint; mitigated by running our own node + reconciliation + the deposit requiring real coins at the bridge address (the operator can see no coins arrived and refuse/pause).

## Invariants enforced in code (see `src/accounting.js`, `src/statemachine.js`)

1. Every outstanding wBLOCK is backed by finalized BLOCK; **pending transfers never count as backing**.
2. One deposit authorizes ≤ 1 mint; one burn authorizes ≤ 1 release (dedup by canonical id).
3. The bridge never releases more BLOCK than finalized custody (`canRelease`); otherwise → `refund_pending`.
4. Consistent 8-decimal conversion; fees charged on the output so custody ≥ issued.
5. A supply/reserve discrepancy sets `shouldPause` → halt new issuance + alert.

## Known limitations

- Custodial trust as above — **not** a trust-minimized light-client/zk bridge.
- No independent security audit yet (passing tests ≠ an audit).
- Reorg handling relies on the 100-confirmation depth; a deeper reorg than that is out of scope and would require manual reconciliation.
- Mint idempotency on relayer crash relies on the minter being idempotent-by-ref (the SPL mint memo = transfer id); this must be verified against the live mint before mainnet.

## Before real funds

See `docs/bridge/BLOCKERS.md`. In short: cold/multisig custody for the reserve + mint authority, an independent audit, legal/compliance sign-off, and conservative caps at launch.
