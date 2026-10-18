# wBLOCK devnet setup

Exact commands to create the wBLOCK mint and (optionally) a devnet wBLOCK/SOL
pool, for **devnet only**. Nothing here touches mainnet. No secrets appear in this
file or in any committed config — keypairs live in files you control, referenced by
path.

> **Trust model:** this is a **custodial / trusted-operator** bridge. wBLOCK is a
> standard SPL mint backed by BLOCK held in the operator reserve wallet. It is **not**
> a trustless on-chain vault. See `docs/bridge/SOLANA.md`.

> **Every money/deploy step is gated.** The `mint.js` / `pool.js` helpers are
> **dry-run by default**; a real transaction needs `{ execute: true }` **and** the
> config switches below turned on **and** explicit human authorization. Do the whole
> flow on **devnet** first. Never run these against `mainnet-beta` without a separate,
> deliberate go-live decision.

---

## 0. Prerequisites

- Node.js >= 20 and the bridge service deps installed:
  ```sh
  cd services/bridge
  npm install          # installs @solana/web3.js + @solana/spl-token
  ```
- Solana CLI (for keypair generation + airdrop). Install from the official
  Solana release channel for your OS.
- `@raydium-io/raydium-sdk-v2` is **not** installed. The pool-creation path is a
  validated, gated **stub** (it computes + checks, then refuses). To actually create
  a devnet pool you must install that SDK and wire the CPI yourself, or create the
  pool manually in the Raydium devnet UI. See `pool.js` header.

---

## 1. Generate the bridge operator keypair (NEVER commit it)

This single keypair is the wBLOCK **mint authority** and the fee payer for devnet.

```sh
# Write to a path OUTSIDE the repo. Treat this file as a secret.
solana-keygen new --no-bip39-passphrase -o ~/.config/blockle/bridge-devnet.json

# Show its public key (safe to share / put in config as mintAuthority):
solana-keygen pubkey ~/.config/blockle/bridge-devnet.json
```

Point the tooling at it via **env** (preferred) or the config file's
`authorityKeypairPath` (a path, never the key bytes):

```sh
export BRIDGE_SOLANA_KEYPAIR=~/.config/blockle/bridge-devnet.json
export BRIDGE_SOLANA_CLUSTER=devnet
```

---

## 2. Fund it with devnet SOL (airdrop)

```sh
solana config set --url https://api.devnet.solana.com
solana airdrop 2 $(solana-keygen pubkey ~/.config/blockle/bridge-devnet.json)
solana balance $(solana-keygen pubkey ~/.config/blockle/bridge-devnet.json)
```

You want >= ~1 SOL to cover mint creation, the pool seed, rent-exempt reserves, and
token-account creation. `estimateCreateCostSol()` in `pool.js` prints a breakdown.

---

## 3. Create the wBLOCK mint (decimals 8)

The helper is dry-run by default. To actually create on **devnet**, enable sends and
pass `execute:true`. `mainnet-beta` would additionally require `mainnetEnabled` — we
leave that off.

```sh
cd services/bridge
BRIDGE_SOLANA_CLUSTER=devnet \
BRIDGE_SOLANA_SENDS_ENABLED=1 \
BRIDGE_SOLANA_KEYPAIR=~/.config/blockle/bridge-devnet.json \
node --input-type=module -e '
import { createSolblockMint, loadSolanaConfig } from "./solana/mint.js";
const r = await createSolblockMint({ cfg: loadSolanaConfig(), execute: true });
console.log(JSON.stringify(r, null, 2));
'
```

Record the printed `mint` address. Put it in config / env for every later step:

```sh
export BRIDGE_wBLOCK_MINT=<printed mint address>
```

Confirm on-chain:

```sh
spl-token display $BRIDGE_wBLOCK_MINT --url devnet
```

You should see `Decimals: 8`, `Mint authority:` = your bridge pubkey, and
`Supply: 0`.

> **Dry-run first:** drop `BRIDGE_SOLANA_SENDS_ENABLED` / `execute:true` to print the
> plan (mint authority, decimals, cluster) without creating anything.

---

## 4. (Optional) mint wBLOCK to a test recipient — simulates a verified deposit

In production `mintSolblock` runs **only after** a BLOCK deposit is verified
(`services/settlement/src/chain.ts` approach: correct address + >= 100 confirmations).
On devnet you can mint a test amount directly. `amountBase` is in 8-decimal base
units (100000000 = 1.0 wBLOCK).

```sh
cd services/bridge
BRIDGE_SOLANA_CLUSTER=devnet BRIDGE_SOLANA_SENDS_ENABLED=1 \
BRIDGE_SOLANA_KEYPAIR=~/.config/blockle/bridge-devnet.json \
BRIDGE_wBLOCK_MINT=$BRIDGE_wBLOCK_MINT \
node --input-type=module -e '
import { mintSolblock, loadSolanaConfig } from "./solana/mint.js";
const r = await mintSolblock({
  cfg: loadSolanaConfig(),
  recipient: process.env.RECIPIENT,          // a devnet Solana address you control
  amountBase: "100000000000",                // 1000 wBLOCK
  execute: true,
  depositRef: "devnet-test",
});
console.log(JSON.stringify(r, null, 2));
'
```

Check supply vs a hypothetical backing figure (read-only, no tx):

```sh
node --input-type=module -e '
import { reconcileSupply, loadSolanaConfig } from "./solana/mint.js";
console.log(JSON.stringify(await reconcileSupply({ cfg: loadSolanaConfig(), backingBaseUnits: "100000000000" }), null, 2));
'
```

---

## 5. (Optional) create a devnet wBLOCK/SOL pool

Compute the seed config first (pure math, no tx, no keys). Pass the SOL price from an
explicit source — it is never hardcoded:

```sh
node --input-type=module -e '
import { computeInitialPoolConfig, estimateCreateCostSol } from "./solana/pool.js";
const pc = computeInitialPoolConfig({ solblockAmount: 1000, usdTarget: 100, solPriceUsd: 200 /* from your price source */ });
console.log(JSON.stringify(pc, null, 2));
console.log(JSON.stringify(estimateCreateCostSol(pc), null, 2));
'
```

`createPool()` is a **gated stub**: even with `execute:true` + `authorized:true` +
sends enabled it throws, because `@raydium-io/raydium-sdk-v2` is not wired. To make a
real devnet pool you must either:

1. Install `@raydium-io/raydium-sdk-v2`, build the `raydium.cpmm.createPool`
   instruction (base = wBLOCK mint, quote = wrapped SOL
   `So11111111111111111111111111111111111111112`, the computed base/quote amounts,
   feeBps 25), sign with the bridge keypair, and confirm on devnet; **or**
2. Create the pool manually in the Raydium **devnet** UI using the amounts the config
   helper printed.

Devnet Raydium CPMM program id: `CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW`
(verify against current Raydium docs before use).

---

## 6. Teardown / notes

- Devnet SOL and devnet wBLOCK have no value; airdrop more if you run dry.
- Keep the bridge keypair out of the repo. If it ever leaks, rotate the mint
  authority (`spl-token authorize <mint> mint <new-authority>`) and update config.
- Do **not** reuse the devnet keypair on mainnet. Mainnet is a separate, authorized
  go-live decision — see `docs/bridge/SOLANA.md` emergency/authority sections.
