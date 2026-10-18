# wBLOCK on Solana — token spec & operations

wBLOCK is the Solana-side representation of BLOCK in the **BLOCK ↔ wBLOCK
bridge**. This document is the authoritative spec for the token, its authorities,
how supply moves, how to account for it, and emergency procedures.

---

## 1. Trust model (state this plainly, everywhere)

**This is a CUSTODIAL / trusted-operator bridge.** wBLOCK is backed by BLOCK held
in the operator's reserve wallet. It is **NOT** a trustless on-chain vault. There is
no smart contract escrowing BLOCK; the backing is the operator's reserve, moved only
by `services/reserve-signer` (loopback-only, gated). An off-chain database is **not**
an on-chain vault and must never be described as one. Holders trust the operator to
keep wBLOCK fully backed and to honor redemptions.

Do not claim decentralization, trustlessness, or on-chain collateralization. The
honest claim is: *"wBLOCK is a custodial wrapped representation of BLOCK; 1 wBLOCK
is redeemable for 1 BLOCK from the operator while the bridge is solvent and running."*

---

## 2. Token spec

| Property        | Value                                                        |
|-----------------|--------------------------------------------------------------|
| Name            | `Wrapped Blockle`                                             |
| Symbol          | `wBLOCK`                                                   |
| Program         | **SPL Token Program** (standard) — **no custom program**     |
| Decimals        | **8** (matches BLOCK: 1 COIN = 1e8 base units)               |
| Base-unit peg   | 1 wBLOCK base unit = 1 BLOCK base unit (exact integer 1:1) |
| Mint authority  | the bridge operator key (loaded from a keypair **path**)     |
| Freeze authority| disabled (`null`) by default                                |
| Supply cap      | **none hardcoded** — supply floats with backing (see §4)     |

Decimals of 8 (not SPL's common 6 or 9) is deliberate: it makes wBLOCK base units
identical to BLOCK base units, so issuance/redemption/reconciliation are exact
integer arithmetic with no scaling or rounding.

**Name/symbol storage.** The SPL Token Program stores no name/symbol. Those are shown
by wallets via a separate Metaplex Token Metadata account, which is **optional** and
off the money path. `mint.js` exposes `metadataPlan()` describing how to attach it
(requires `@metaplex-foundation/mpl-token-metadata`, not currently a dependency); the
token functions correctly without it.

---

## 3. The 1,000 figure is a liquidity TARGET, not a cap

The initial pool is seeded with **1,000 wBLOCK** against ~**$100 of SOL** (see
`pool.js`), giving an indicative init price of **$0.10 / wBLOCK**. That 1,000 is the
**initial liquidity seed target** — it is **NOT** a maximum supply, not a cap, and not
a promise about price. Total wBLOCK supply grows and shrinks with real deposits and
redemptions (§4). There is no hardcoded permanent supply ceiling anywhere in the mint.

---

## 4. How supply moves

```
   BLOCK deposit (verified)                    wBLOCK redemption
   ────────────────────────                    ───────────────────
   user sends BLOCK to the        user returns wBLOCK to the bridge
   bridge deposit address                      │
            │                                  ▼
   verify on BLOCK chain               burn wBLOCK  (mint.js burnSolblock)
   (chain.ts approach:                         │  supply ↓
    correct address +                          ▼
    >= 100 confirmations)              release BLOCK to the user
            │                          via services/reserve-signer
            ▼                          (POST /reserve/dispense, gated)
   mint wBLOCK to the user
   (mint.js mintSolblock)
     supply ↑
```

- **Deposit → mint (supply ↑).** A BLOCK deposit is verified exactly like the
  settlement service does today: read the node explorer (`GET /explorer/tx/{id}`),
  confirm it paid the bridge address, and require **>= 100 confirmations**
  (`confirmationDepth = 100`, the same reorg-safety depth the settlement service uses;
  BLOCK coinbase maturity is also 100). Only then does the bridge call
  `mintSolblock({ amountBase, recipient })` with the exact verified base units.
- **Redemption → burn + release (supply ↓).** The bridge takes the user's wBLOCK,
  `burnSolblock(...)` destroys it, and **only after the burn confirms** the bridge
  releases BLOCK by POSTing `services/reserve-signer` `/reserve/dispense`
  (`{ purpose, amountBase, asset:"BLOCK", to }`). The bridge never holds the reserve
  key — the reserve-signer is the only process that moves BLOCK, and it enforces its
  own mainnet gate, daily cap, and recipient/amount validation.

Ordering matters: **mint only after deposit finality; release BLOCK only after burn
finality.** This prevents a double-spend of backing on either side.

---

## 5. Accounting: the five distinct wBLOCK quantities

Keep these separate — conflating them hides insolvency:

1. **BLOCK-in-custody** — BLOCK base units actually held in the operator reserve
   wallet. This is the *backing*. Source of truth: the BLOCK chain + reserve ledger.
2. **wBLOCK-issued (mint supply)** — total wBLOCK in existence, read on-chain via
   `getMint(...).supply`. This is the *liability* to holders.
3. **wBLOCK-in-pool** — wBLOCK sitting in the wBLOCK/SOL AMM pool as liquidity
   the operator provided. Still part of issued supply; it is operator-owned LP, not a
   user claim, but it **is** backed like any other wBLOCK.
4. **wBLOCK-held-by-users** — issued supply minus operator-held (pool LP + treasury)
   = the float that real users can redeem.
5. **Pending liabilities** — wBLOCK for in-flight redemptions (burned or queued) and
   BLOCK for deposits verified-but-not-yet-minted. Track both so the solvency check is
   not fooled by timing.

**Solvency invariant (the one that must always hold):**

```
BLOCK-in-custody (base units)  >=  wBLOCK-issued (base units)
```

Because both are 8-decimal base units, this is an exact integer comparison.
`mint.js reconcileSupply({ backingBaseUnits })` reads the live mint supply and
reports `healthy = supply <= backing`. If supply ever exceeds backing, the bridge is
under-collateralized: **halt all mints immediately** and investigate.

---

## 6. Authorities & key handling

- **Mint authority** = the bridge operator key. Loaded only from a keypair **file
  path** (`BRIDGE_SOLANA_KEYPAIR` env or `authorityKeypairPath` in config). The key
  bytes NEVER appear in source, config, or any committed file. Config examples carry
  placeholders only.
- **Freeze authority** = disabled (`null`) by default. Enabling freeze is a policy
  decision (it lets the operator freeze token accounts — a centralization lever);
  document it explicitly if ever turned on.
- **Reserve (BLOCK) key** — not here at all. Lives in the node wallet datadir behind
  `services/reserve-signer`. The bridge interacts with BLOCK only over that loopback
  HTTP contract.

**Gating.** All on-chain sends are off by default. `mint.js` requires
`{ execute:true }` **and** `sendsEnabled` in config; `mainnet-beta` additionally
requires `mainnetEnabled`. `pool.js createPool` additionally requires
`{ authorized:true }` and still refuses (SDK not wired). Dry-run is always the
default and is safe to run anywhere.

---

## 7. Liquidity pool (summary — details in `services/bridge/solana/pool.js`)

- **AMM chosen: Raydium CPMM** (constant-product), because init price = reserve ratio
  and slippage follows the `x*y=k` curve — the right model for a simply-seeded pool.
  (Orca Whirlpools = concentrated liquidity, no single reserve ratio; Raydium AMM v4
  needs an OpenBook market first. CPMM needs neither.)
- SDK `@raydium-io/raydium-sdk-v2` is **not installed**; create-pool is a validated,
  gated **stub**. Program ids: mainnet-beta
  `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`, devnet
  `CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW` (verify against current docs).
- The pool helpers compute the seed config (1,000 wBLOCK + $100 of SOL at a
  **passed-in** SOL price), expected init price, slippage, and a create-cost estimate
  (Raydium creation fee + rent-exempt reserves + token-account creation + tx fees).
  **No pool is ever created by this code.**

---

## 8. Emergency procedures

- **Under-collateralization detected** (`reconcileSupply` reports `healthy:false`, or
  BLOCK-in-custody < wBLOCK-issued): **halt mints** (turn `sendsEnabled` off / stop
  the mint path), freeze no funds unless freeze authority is deliberately enabled,
  reconcile the ledgers, and top up BLOCK backing before resuming.
- **Mint-authority key compromise:** rotate immediately —
  `spl-token authorize <mint> mint <new-authority>` from the current authority — then
  update config to the new keypair path. If the key is fully lost but still valid,
  rotate to a fresh operator key held in a hardware signer. Consider migrating holders
  to a new mint if integrity is in doubt.
- **Reserve (BLOCK) issue:** handled by `services/reserve-signer` controls (mainnet
  gate, daily cap, audit log). Disable `mainnetEnabled` / set `dryRun` there to stop
  all BLOCK movement.
- **Pause everything:** flip `sendsEnabled=false` (Solana side) and the reserve-signer
  gate (BLOCK side). With both off, no wBLOCK can be minted/burned and no BLOCK can
  be released — the bridge is frozen safely while you investigate.
- **Redemption backlog:** honor redemptions FIFO from backing; never mint new wBLOCK
  to cover a redemption shortfall (that only deepens under-collateralization).

---

## 9. Files

- `services/bridge/solana/mint.js` — wBLOCK mint/mint-to/burn + supply
  reconciliation; dry-run default, gated, no inline keys.
- `services/bridge/solana/pool.js` — wBLOCK/SOL Raydium-CPMM liquidity math +
  gated create-pool stub.
- `services/bridge/solana/devnet-setup.md` — exact devnet commands.
- `services/settlement/src/chain.ts` — the deposit-verification approach reused for
  BLOCK deposits.
- `services/reserve-signer/` — the only process that releases BLOCK on redemption.
