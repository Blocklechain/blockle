# BLOCK ↔ wBLOCK bridge — deployment runbook

**Golden rule:** every step that deploys to Solana, mints/moves a real token, moves real BLOCK or
SOL, or creates a pool requires **explicit, written human authorization** recorded at the time.
No agent, script, or CI job may perform these steps autonomously. Until authorized, every money/
deploy path stays OFF / dry-run by config default.

The stages are strictly ordered. **Do not skip a stage.** A later stage must not begin until the
previous stage's exit criteria are signed off.

---

## Stage 0 — Local (no network, no keys)
**Goal:** prove the logic with stubs.
- Run the bridge service, relayer, and SPL tooling against **stubs/mocks**: a mock chain reader
  (fixtures instead of the live node), a mock SPL mint client, and `reserve-signer` in
  `dryRun:true`.
- Run the test suites. Confirm: deposit verify at depth, idempotency (no double-mint / no
  double-release), state-machine transitions, cap enforcement, fee math.
- **Exit:** all tests green twice back-to-back; no real key present anywhere.

## Stage 1 — Devnet (Solana devnet + BLOCK testnet)
**Goal:** exercise the real protocols with worthless assets.
- Target **Solana devnet** and a **BLOCK testnet/regtest** node. Never mainnet.
- Rehearse: create a wBLOCK devnet SPL mint (decimals 8), mint against a verified testnet BLOCK
  deposit, trade on a devnet pool if used, burn, and release via `reserve-signer`
  (`network` pointed at testnet, still `dryRun` until the release path itself is being tested).
- Verify reorg handling by forcing a shallow→deep confirmation transition on testnet.
- **Exit:** a full round-trip (deposit→mint→burn→release) completes on devnet/testnet;
  reconciliation shows bucket 1 ≥ bucket 2 throughout; operator signs off.

## Stage 2 — Security review (external)
**Goal:** independent eyes before any mainnet exposure.
- Independent security audit of: the relayer (double-mint resistance, crash recovery, reorg),
  the SPL mint-authority handling, the deposit verifier, and the reserve-signer integration.
- Legal/compliance sign-off on the custodial model (money-transmission posture, per the open
  item in [`BLOCKERS.md`](./BLOCKERS.md)).
- Cold-key custody plan for **both** the BLOCK reserve key and the wBLOCK mint authority.
- **Exit:** written audit report + legal sign-off + custody plan, all archived. This is a hard
  gate — no mainnet step proceeds without it.

## Stage 3 — Mainnet prep (no funds yet)
**Goal:** stage mainnet config with money switches still OFF.
- Produce a **reproducible deployment manifest** (see below) describing exactly what will be
  deployed and with which parameters, reviewed and approved before execution.
- Place mainnet config on the box with `mainnetEnabled:false` and/or `dryRun:true` (money
  switches left SAFE), real deposit address and mint authority referenced via signer/secret
  manager (never in files).
- Dry-run the mainnet config end-to-end (the signer returns `dryRun:true` txids; no funds move).
- **Exit:** manifest approved; dry-run clean; the only remaining action is flipping switches.

## Stage 4 — Controlled launch (authorized, funded, capped)
**Goal:** go live with the smallest possible blast radius.
- **Requires a fresh, explicit human authorization** separate from Stage 3 approval.
- Seed amounts (BLOCK reserve top-up, the SOL + wBLOCK pool seed) require a **human-signed**
  authorization each — see cost estimate below and [`BLOCKERS.md`](./BLOCKERS.md).
- Flip switches in order: `legalReviewCompleted` (already recorded) → `mainnetEnabled` →
  `dryRun:false`. Keep `dailyCapBlock` / `maxAmountBlock` tight initially.
- Launch in monitor-only / low-cap mode; watch [`MONITORING.md`](./MONITORING.md) alerts; raise
  caps only deliberately and only after clean operation.
- **Exit:** sustained clean operation under low caps before any cap increase.

---

## Reproducible deployment manifest (idea)
A single committed, reviewable file (no secrets) that fully describes a deployment so it can be
reproduced and audited:
```jsonc
{
  "stage": "mainnet-prep",
  "solanaCluster": "mainnet-beta",     // target cluster
  "splMint": {
    "decimals": 8,
    "mintAuthorityRef": "secret://bridge/mint-authority",  // pointer, never the key
    "freezeAuthority": null             // decision recorded; see BLOCKERS.md
  },
  "blockNode": "http://127.0.0.1:8445",
  "depositAddressRef": "config://bridge/deposit-addr",
  "confirmationDepth": 100,
  "reserveSigner": { "mainnetEnabled": false, "dryRun": true, "dailyCapBlock": 100, "maxAmountBlock": 25 },
  "fees": { "BRIDGE_FEE_BPS": 0 },
  "seed": { "solUsd": 0, "solblock": 0 },   // 0 until human-signed
  "authorizedBy": "",                        // filled at execution time
  "manifestHash": ""                          // hash of the approved manifest
}
```
The manifest is approved as a unit; the executed deployment's parameters are checked against it,
and the approver + hash are recorded in the audit log.

---

## Minimum SOL for deploy + token accounts + pool

Separate **KNOWN** protocol costs from **ESTIMATES** that depend on market conditions. All figures
require confirmation against live network params at execution time — do not treat as exact.

**KNOWN (protocol rent/fees, Solana):**
- Create SPL mint account: ~0.00145 SOL rent-exempt (mint account ~82 bytes).
- Each associated token account (ATA): ~0.00204 SOL rent-exempt.
- Per-transaction base fee: ~0.000005 SOL × number of txs (negligible but nonzero).
- No program deploy cost for wBLOCK itself — it is a **standard SPL mint**, not a custom
  program, so there is **no `.so` upload / program-rent cost** for the token. (A custom program
  would cost ~roughly 0.002 SOL per byte of bytecode; not applicable here.)

**ESTIMATE (operator-chosen, market-dependent — NOT protocol-fixed):**
- Pool seed liquidity: the indicative **$100 of SOL** paired with 1,000 wBLOCK (see
  [`FEES.md`](./FEES.md)). The SOL quantity depends on SOL's USD price at seeding; this is an
  operator funding decision, not a fixed cost, and requires a **human-signed authorization**.
- AMM/pool creation fee: whatever the chosen AMM charges to initialize a pool (varies by venue).
- BLOCK reserve top-up (e.g. 10,000 BLOCK backing + working balance): a BLOCK-side funding
  decision requiring **human-signed authorization**; not a SOL cost.

**Rough all-in SOL floor (deploy + a handful of ATAs + per-tx fees), excluding pool seed:**
on the order of **~0.01 SOL** of rent/fees. The dominant cost is the operator-chosen pool seed,
which is an ESTIMATE, not a known protocol figure.

## Wiring the HTTP API behind the site (deploy)

The `/bridge` frontend + explorer fetch same-origin `/api/bridge/*`. Serve them by
proxying to the loopback bridge service:

1. Deploy `services/bridge` to `/opt/blockle/services/bridge`; `npm ci` (installs
   `@solana/web3.js` + `@solana/spl-token`).
2. Install `services/bridge/bridge.service` (systemd), create
   `/opt/blockle/secrets/bridge.env` (see `docs/bridge/ENV.md`, chmod 600). The
   service binds `127.0.0.1:8797` only.
3. nginx (blockle.org vhost) — proxy the API to the service:
   ```nginx
   location /api/bridge/ { proxy_pass http://127.0.0.1:8797; proxy_set_header Host $host; }
   ```
4. `systemctl enable --now bridge`. Until a wBLOCK mint is configured
   (`BRIDGE_wBLOCK_MINT`) and un-paused, `/api/bridge/info` reports `live:false`
   and the UI shows the honest "not yet live" state — nothing is minted or moved.
5. Turn on the relayer (`BRIDGE_RELAYER_ENABLED=1`) only after the mint exists and
   Solana sends + reserve-signer mainnet are explicitly authorized. The minter and
   reserve-signer adapters THROW while gated, so a deposit waits in `minting` /
   a redeem waits in `releasing` rather than ever being falsely completed.
