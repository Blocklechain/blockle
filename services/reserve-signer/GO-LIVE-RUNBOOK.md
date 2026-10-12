# Reserve-signer go-live runbook — #37 listing-liquidity seed dispense

This flips the **premine BLOCK dispense** from dry-run to a **real mainnet send**. It is a
hard-to-reverse, money-moving change. Legal/compliance sign-off is recorded (operator
confirmed 2026-10-11). Everything below runs **on the VPS**, as the operator — Claude does
**not** flip the production money switches; it prepared this runbook and the code guards.

## What this does and does NOT do

- **Does:** lets the reserve signer dispense ~$5 of premine BLOCK to the seed address and
  lets the exchange post the resting protocol SELL-BLOCK order (the maker side of the seed).
- **Does NOT, by itself:** make that order *settle* against a taker. Settlement is a
  cross-chain atomic swap (HTLC) and still requires the exchange HTLC legs deployed + funded
  + a testnet proof. Until then the seed rests but cannot be taken on the non-BLOCK legs.

## Preconditions (all must be true)

1. `blockle-node` + the mainnet reserve wallet (`/var/lib/blockle-mainnet`) are healthy and
   the reserve holds enough BLOCK for the seed + fee.
2. You have a **real, spendable, operator-controlled mainnet `block1…` address** to use as
   `seedDestination` (the seed maker). **Not** the placeholder `block1seedliquidityreserve…`
   — the signer now refuses that sentinel. To mint/confirm one you control:
   ```bash
   /opt/blockle/chain/target/release/blockle-chain --json --datadir /var/lib/blockle-mainnet \
     --network mainnet newaddress   # or reuse a known address from this wallet
   ```
3. The reserve-signer unit is installed and currently running in SAFE mode
   (`dryRun:true`, `mainnetEnabled:false`) and `GET /healthz` returns the reserve address.

## Step 1 — install the production config (still SAFE)

```bash
cd /opt/blockle/services/reserve-signer
cp -n config.json config.json.bak.$(date +%s) 2>/dev/null || true
cp config.mainnet.example.json config.json
# set the REAL seed maker address you control:
# edit config.json -> "seedDestination": "block1<your-real-address>"
```
`config.json` now has `legalReviewCompleted:true` but `mainnetEnabled:false` + `dryRun:true`
— so it still sends nothing.

## Step 2 — dry-run proof with the real address

Restart and confirm the signer accepts the real seed address in dry-run (this also proves the
sentinel guard — a leftover placeholder will be refused here, before any real money):
```bash
systemctl restart blockle-reserve-signer
curl -s http://127.0.0.1:8795/healthz   # expect the reserve address, dryRun:true
curl -s -X POST http://127.0.0.1:8795/reserve/dispense \
  -H 'content-type: application/json' \
  -d '{"purpose":"listing-liquidity-seed","amountBase":"500000000"}'
# expect: {"ok":true,"txid":"dryrun-…","dryRun":true}   (0.5 BLOCK test amount)
```
If you see `placeholder seed sentinel`, `seedDestination` is still the placeholder — fix it.

## Step 3 — THE FLIP (real money) — single reviewed change

Set the two money switches live. Keep the caps tight (config ships maxAmountBlock=25,
dailyCapBlock=100).
```bash
cd /opt/blockle/services/reserve-signer
# flip the two booleans in config.json:
#   "mainnetEnabled": true,
#   "dryRun": false,
systemctl restart blockle-reserve-signer
curl -s http://127.0.0.1:8795/healthz   # expect mainnet:true, dryRun:false
```

## Step 4 — smallest real end-to-end test, then the actual seed

Dispense a tiny real amount first and confirm it on-chain before relying on the seed path:
```bash
curl -s -X POST http://127.0.0.1:8795/reserve/dispense \
  -H 'content-type: application/json' \
  -d '{"purpose":"listing-liquidity-seed","amountBase":"10000000"}'   # 0.1 BLOCK
# expect: {"ok":true,"txid":"<64-hex>","dryRun":false}
/opt/blockle/chain/target/release/blockle-chain --json --datadir /var/lib/blockle-mainnet \
  --network mainnet gettransaction --txid <txid>
```
Confirm the recipient received it and it is spendable. The exchange seeder (`seed.signerUrl`
→ `http://127.0.0.1:8795`) will now perform the real $5 dispense when a listing activates.

## Rollback (instant, reversible)

```bash
cd /opt/blockle/services/reserve-signer
# set "mainnetEnabled": false  (or "dryRun": true) in config.json
systemctl restart blockle-reserve-signer
# or restore the backup:  cp config.json.bak.<ts> config.json && systemctl restart blockle-reserve-signer
```
Already-sent dispenses are on-chain and not reversible; the ledger
(`/var/lib/blockle-reserve-signer/dispensed.jsonl`) + audit log record every send.

## Safety invariants (enforced in code — do not weaken)

- `live = mainnetEnabled && legalReviewCompleted && !dryRun` — three switches, all required.
- Per-dispense cap (`maxAmountBlock`) + daily cap (`dailyCapBlock`) from the append-only ledger.
- Recipient must match `block1…`; the placeholder seed sentinel is refused (dry-run and live).
- Loopback-only (127.0.0.1); optional bearer `authToken`; the reserve key never leaves the
  node wallet datadir — this service only shells `blockle-chain send`.
