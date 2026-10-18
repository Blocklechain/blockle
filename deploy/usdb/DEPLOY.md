# USDB (Blockle USD) — mainnet deploy walkthrough

## ✅ LIVE ON MAINNET (as of 2026-10-18)
- **Contract id:** `946b4f3771970c8be5ca9416898408ac88fdbaedcd2177f3cbfd564a639ada09`
- **Issuer wallet:** `block16qp45xs7qy5agu7vre34h8xfw766rr2pcyh5d3m2vgq7vtgtp2es4hy3yu`
  (dedicated key, box-only at `/opt/blockle/secrets/usdb-issuer.json`, chmod 600 — **never** the premine key).
- **Status:** deployed + `init()` (issuer set) + a net-zero mint/burn self-test proving
  the issuer rails. Metadata on-chain: name "Blockle USD", symbol "USDB", 6 decimals.
- **Issuance service:** `blockle-usdb.service` on `127.0.0.1:8801`, proxied at
  `https://blockle.org/api/usdb/`. Reads the issuer key by path; `USDB_ENABLED=0`
  so the **public** buy/redeem stay dry-run until the fiat rail + KYC are wired.
- **Fees (both ramps = our 0.5% + PayPal pass-through):** on-ramp = PayPal 2.9%+$0.30
  + 0.5%; off-ramp = PayPal payout 2% (cap $1) + 0.5%. USDB received == reserves
  credited (fully backed). Override the PayPal rates in `usdb.env` to the account's real rate.
- **Gas note:** the reserve-signer (`:8795`) rejected the deploy-gas dispense because
  its wallet datadir (`/var/lib/blockle-mainnet`) is a **stale Oct-4 snapshot** → it
  builds txs against spent outpoints. Worked around by funding 1 BLOCK of gas from the
  live synced node operator wallet. **TODO: resync/repoint the reserve-signer datadir.**

### To enable PUBLIC issuance (issuer action, when ready)
Fund USD reserves + configure a KYC/sanctions verifier + the PayPal capture/payout rail,
then set in `/opt/blockle/secrets/usdb.env`: `USDB_KYC_URL=<verifier>` and `USDB_ENABLED=1`,
and `systemctl restart blockle-usdb`. Until then every public mint/burn is fail-closed.

---


> **Regulated-asset deploy. The issuer (ALienbeing LLC) performs + signs every
> step. Nothing here is auto-run.** USDB is a BLOCK-20S stablecoin: issuer-only
> mint/burn, freeze/blacklist, global pause, mutable supply. Peg integrity is
> enforced off-chain by the issuance service (mint only against verified USD
> reserves ⇒ supply ≤ reserves). It is already deployed + verified on **testnet**
> as a reference.

## 0. The issuer authority
Whoever signs `init()` becomes the permanent issuer (controls mint/burn/freeze/
pause). Use a **dedicated, securely-custodied issuer wallet** — ideally the key
you can rotate/cold-store. Fund it with a little BLOCK for gas (~0.05 BLOCK).

## 1. Get the bytecode
`deploy/usdb/usdb.asm` in this repo is the exact USDB VM assembly
(`Blockle USD` / `USDB` / 6 decimals). Regenerate any time with:
```sh
cargo run -p blockle-chain --bin usdb-asm > usdb.asm      # assembly
cargo run -p blockle-chain --bin usdb-asm hex > usdb.hex  # raw bytecode hex
```

## 2. Deploy on mainnet (issuer-signed)
From the **issuer wallet's** datadir, against the live mainnet node:
```sh
blockle-chain --datadir <ISSUER_DATADIR> --network mainnet \
  contract deploy deploy/usdb/usdb.asm --gas 400000 --node 127.0.0.1:18444
```
Record the printed **contract id** — that's USDB's on-chain address.

## 3. Initialize (sets issuer = you)
Wait for the deploy to confirm (one block), then:
```sh
blockle-chain --datadir <ISSUER_DATADIR> --network mainnet \
  contract call <USDB_CONTRACT_ID> --input 00 --gas 120000 --node 127.0.0.1:18444
```
`--input 00` is selector 0 = `init()`. After this, only this wallet can
mint/burn/freeze/pause.

## 4. Verify
```sh
blockle-chain --network mainnet contract simulate <USDB_CONTRACT_ID> --input 05   # name -> "Blockle USD"
blockle-chain --network mainnet contract simulate <USDB_CONTRACT_ID> --input 06   # symbol -> "USDB"
blockle-chain --network mainnet contract simulate <USDB_CONTRACT_ID> --input 03   # totalSupply -> 0
```

## 5. Wire issuance (gated — see services/stablecoin)
Set in `/opt/blockle/secrets/usdb.env`: `USDB_CONTRACT=<id>`,
`USDB_ISSUER_KEYPAIR=<path>` (the issuer key, chmod 600),
`USDB_KYC_URL=<verifier>`, fee bps, caps. Fund reserves + record the backing.
Only then set `USDB_ENABLED=1`. Until every one of those is in place the service
stays dry-run / fail-closed and mints nothing.

## Selector reference (BLOCK-20S)
`0 init · 1 balanceOf(addr) · 2 transfer(to,amt) · 3 totalSupply · 4 decimals ·
5 name · 6 symbol · 7 mint(to,amt)* · 8 burn(from,amt)* · 9 freeze(addr)* ·
10 unfreeze(addr)* · 11 pause()* · 12 unpause()* · 13 isFrozen(addr) · 14 isPaused`
(`*` = issuer-only). Args: addr = 32 bytes, amt = u64 little-endian; in USDB base
units (6 decimals → 1 USDB = 1_000_000).
