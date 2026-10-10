# exchange/contracts — deploy runbook (HTLC legs)

The cross-chain atomic-swap HTLC legs are **built and unit-tested** (see each
leg's README and `../PROTOCOL.md`) but **not deployed**. This runbook is the
single place that tells whoever holds the keys how to put each leg on-chain with
**one command**, and how the deployed id gets wired into the relay
(`exchange/server`).

> **PREP ONLY.** This document does not deploy anything. It commits **no keys or
> seeds** — every script reads keys from the environment or a local keystore and
> the RPC/network from config. Run **testnet first** (Sepolia / Solana devnet /
> Sui testnet / BTC signet); mainnet is gated behind a recorded legal review on
> every leg.

---

## 0. Who can deploy what (read this first)

| Leg | Deployable by **us**? | Blocked on | Deploy-readiness |
|-----|-----------------------|------------|------------------|
| **BLOCK** | ✅ **Yes** — we hold the node + reserve wallet | nothing external | 🟢 GREEN — we can run it |
| EVM (ETH/ERC-20) | ❌ No | operator's funded deployer key + RPC | 🟢 script ready · 🔴 needs operator key |
| Solana (SOL/SPL) | ❌ No | operator's funded `ANCHOR_WALLET` + fee wallet | 🟢 script ready · 🔴 needs operator key |
| Sui (any coin) | ❌ No | operator's funded Sui keystore address | 🟢 script ready · 🔴 needs operator key |
| BTC (native) | ❌ No (no contract) | operator's funded hot wallet + Esplora + fee addrs | 🟢 tooling ready · 🔴 needs operator wallet |

"Script ready / GREEN" means the one-command deploy is written, gated, and
tested end-to-end in its own environment; "needs operator key / RED" means the
Blockle team **cannot** execute it — only the party who controls that chain's
funded deployer key can. **BLOCK is the only leg we execute ourselves.** See
§6 for the precise human inputs still required per leg.

---

## 1. How a deployed id reaches the relay

The relay holds **no keys**. It only needs the **public** deployed
contract/program/package id (or, for BTC, an Esplora endpoint) per network. The
path is identical for every leg:

```
leg deploy script  ─writes→  <leg>/deployments.json (or env)
        │
        ▼  (node collect-deployments.mjs  — one command, public ids only)
exchange/server/config.json  →  "htlc": { evm, solana, sui, btc, block }
        │
        ▼  (loadConfig → htlcTarget, src/config.ts)
SwapEngine.requireHtlc(chain)  →  FAIL-CLOSED if the address is blank
```

- `exchange/server/src/config.ts` already defines the `htlc` config shape,
  `htlcTarget(cfg, chain)` (maps a logical chain → the deployed address for the
  active network, honoring the mainnet gate), and the dev placeholders.
- `exchange/server/src/swaps.ts` → `SwapEngine.requireHtlc()` **refuses a swap
  leg (fail-closed) when no address is configured** for the active network. A
  testnet deployment stays testnet-only because mainnet keys are left blank.
- **Wiring is one command.** After deploying one or more legs:

  ```bash
  # print the htlc block collected from every leg's deploy artifact + env:
  node exchange/contracts/collect-deployments.mjs
  # or merge it straight into exchange/server/config.json (public ids only;
  # never touches mainnetEnabled / legalReview):
  node exchange/contracts/collect-deployments.mjs --write
  ```

  It reads `evm/deployments.json`, `solana/deployments/<cluster>.json`,
  `sui/deployments.json`, and the BLOCK/BTC ids from env
  (`BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT`, `BLOCKLE_EXCHANGE_HTLC_BTC_ESPLORA`,
  `BLOCKLE_EXCHANGE_HTLC_BTC_HOTWALLET`). You can always paste ids by hand
  instead — the config keys are listed per leg below.

Relay config keys (see `exchange/server/config.example.json`):

```jsonc
"htlc": {
  "evm":    { "sepolia": "0x…", "baseSepolia": "0x…", "base": "", "ethereum": "" },
  "solana": { "devnet": "<programId>", "mainnet": "" },
  "sui":    { "testnet": "0x<packageId>", "mainnet": "" },
  "btc":    { "hotWallet": "tb1q…", "esploraUrl": "https://blockstream.info/testnet/api" },
  "block":  { "contractId": "<64-hex>" }
}
```

Env overrides exist for the two legs without a committed artifact:
`BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT`, `BLOCKLE_EXCHANGE_HTLC_BTC_ESPLORA`,
`BLOCKLE_EXCHANGE_HTLC_BTC_HOTWALLET`.

---

## 2. The mainnet gate (identical contract on every leg)

Every money path defaults to testnet. A **mainnet** deploy on any leg is
**refused** unless BOTH:

```bash
export HTLC_MAINNET_ENABLED=true
export HTLC_LEGAL_REVIEW_REF="<recorded legal/compliance sign-off reference>"
```

And the **relay** only treats itself as mainnet when `mainnetEnabled=true` AND
`legalReview.completed=true` in `exchange/server/config.json` (see
`config.ts → loadConfig`). Deploying a contract does **not** enable it — the
relay gate is separate and stays off until legal sign-off (PROTOCOL.md §7).

> Do **not** set `HTLC_MAINNET_ENABLED` during this prep. Testnet only.

---

## 3. Per-chain one-command deploy (testnet first)

### 3.1 BLOCK — the one we deploy ourselves 🟢

We hold the node + reserve wallet, so there is no third-party key to wait on.

```bash
cd exchange/contracts/block
FEE_ADDR=<32-byte-hex reserve/treasury address> ./scripts/deploy.sh      # -> regtest
```

What it does: emits the HTLC assembly with `FEE_ADDR` baked in (`htlc-asm`
bin) → builds `blockle-chain` → `blockle-chain contract deploy …` from the
reserve wallet → prints `contract id: <64-hex>`.

- **Keys:** the deploy tx is funded + signed by the wallet in the node
  `--datadir` (our reserve wallet). Passphrase from `BLOCKLE_WALLET_PASSPHRASE`
  or an interactive prompt. **No key is read or written by the repo.**
- **Funding:** regtest is free (mine to the reserve wallet). Mainnet needs the
  reserve wallet funded with enough BLOCK to cover deploy gas (`GAS`, default
  300000).
- **Wire it:** put the printed id in `htlc.block.contractId` (or
  `BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT`).

Mainnet (gated — do not run during prep):

```bash
FEE_ADDR=<hex32> NETWORK=mainnet HTLC_MAINNET_ENABLED=true \
  HTLC_LEGAL_REVIEW_REF=LR-123 DATADIR=/var/lib/blockle NODE=1.2.3.4:8444 \
  ./scripts/deploy.sh
```

> Hash note: BLOCK uses **BLAKE2B** (the VM's only hash opcode), so BLOCK⇄BLOCK
> swaps work today; BLOCK⇄EVM/Solana/BTC need the VM to gain a `SHA256` opcode
> (PROTOCOL.md §4). This is a protocol limitation, not a deploy blocker.

### 3.2 EVM — ETH + ERC-20 (USDC/USDT) 🔴 needs operator key

```bash
cd exchange/contracts/evm
npm install
export PRIVATE_KEY=0x…                 # funded Sepolia deployer (operator's key)
export SEPOLIA_RPC_URL=https://…        # operator's RPC (Alchemy/Infura/public)
npm run deploy:sepolia                  # prints address + writes deployments.json
# Base Sepolia (RPC default baked in):
export PRIVATE_KEY=0x…
npm run deploy:baseSepolia
```

- **Keys/RPC:** `PRIVATE_KEY` (or `DEPLOYER_PRIVATE_KEY`) from env; RPC from the
  matching `*_RPC_URL` env var; `hardhat.config.js` wires both. Never committed.
- **Fee:** `feeBps`/`feeAddress` from `evm/config.json` (or `HTLC_FEE_BPS` /
  `HTLC_FEE_ADDRESS`). Fee address must be a real public address, not zero.
- **Wire it:** `deployments.json` records `<network>.address`; collector maps it
  to `htlc.evm.<network>`.

### 3.3 Solana — SOL + SPL (USDC/USDT) 🔴 needs operator key

```bash
cd exchange/contracts/solana
export ANCHOR_WALLET=~/.config/solana/id.json   # operator's funded deployer keypair
./scripts/deploy.sh                              # -> devnet (default)
```

The script builds → `anchor keys sync` → rebuilds → `anchor deploy` →
writes `deployments/<cluster>.json` with `programId`. On devnet it auto-airdrops
if the balance is low. The deployer is also the **upgrade authority** — secure
it (see AUDIT-READINESS §Solana).

- **One-time after deploy:** call `initialize(fee_bps, fee_wallet)` (fee wallet
  is a PUBLIC address) and **leave `mainnet_enabled = false`**.
- **Wire it:** collector maps `deployments/<cluster>.json → programId` to
  `htlc.solana.<devnet|mainnet>` (localnet/devnet both map to `devnet`).

### 3.4 Sui — any `Coin<T>` 🔴 needs operator key

```bash
cd exchange/contracts/sui
./scripts/deploy.sh                 # -> Sui testnet (default)
```

Builds + tests, switches the Sui client to the target env (creating the alias
against `https://fullnode.<env>.sui.io:443` if missing), publishes using the
**active keystore address** (`sui client active-address`), captures the
`packageId` to `deployments.json`.

- **Keys/funding:** the active keystore key (never in the repo); fund it via
  `sui client faucet` on testnet/devnet.
- **Wire it:** collector maps `deployments.json → <env>.packageId` to
  `htlc.sui.<testnet|mainnet>`. The `Clock` object is the well-known `0x6`.

### 3.5 BTC — native, no deployed contract 🔴 needs operator wallet

BTC has **no contract to deploy** — each swap is a fresh P2WSH output. "Deploy"
here means standing up the funded hot wallet + broadcast endpoint the relay
needs to fund/refund and relay spends.

1. **Create + fund a bech32 (P2WPKH) hot wallet** on the target network. Faucets:
   - signet: <https://signet.bc-2.jp/> (or `bitcoin-cli -signet getnewaddress` + mine)
   - testnet3: <https://bitcoinfaucet.uo1.net/> · <https://coinfaucet.eu/en/btc-testnet/>
   The **private key stays in the operator's own signer** — never in this repo.
2. **Fill the per-network treasury fee address** in `btc/config.json`
   (`networks.<net>.treasuryFeeAddress` — currently `_TODO_…` for
   testnet/signet/regtest; mainnet is pre-filled and gated).
3. **Wire it** into the relay:
   - `htlc.btc.hotWallet` = the hot-wallet **address** (or `BLOCKLE_EXCHANGE_HTLC_BTC_HOTWALLET`)
   - `htlc.btc.esploraUrl` = the Esplora base URL (or `BLOCKLE_EXCHANGE_HTLC_BTC_ESPLORA`);
     default testnet `https://blockstream.info/testnet/api`, self-hosted regtest
     `http://127.0.0.1:3002`.
   The relay's fail-closed check for a BTC leg requires `esploraUrl` to be set
   (no broadcast endpoint ⇒ the leg can't settle).

`btc/src/esplora.js` supplies UTXO discovery, fee estimation, broadcast
(`POST /tx`), and confirmation polling against that endpoint. Signing is done by
the operator's signer through the PSBT builders in `btc/src/htlc.js`.

---

## 4. Required keys, funding, faucets, RPCs (at a glance)

| Leg | Key input (env/keystore) | Testnet funding | Faucet | RPC / endpoint |
|-----|--------------------------|------------------|--------|----------------|
| BLOCK | reserve wallet in `--datadir`; `BLOCKLE_WALLET_PASSPHRASE` | regtest: free (mine) | — (we mine) | local node / `--node <p2p>` |
| EVM | `PRIVATE_KEY` | ~0.002–0.01 test ETH gas | sepoliafaucet.com, Alchemy, GCP faucet; Base via superbridge.app | `SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL` (default `https://sepolia.base.org`) |
| Solana | `ANCHOR_WALLET` (keypair json) | ~2 SOL (auto-airdrop on devnet) | `solana airdrop 2` · <https://faucet.solana.com> | `https://api.devnet.solana.com` (override `SOLANA_RPC_URL`) |
| Sui | active keystore address | ~1 SUI (covers many publishes) | `sui client faucet` · <https://faucet.sui.io> | `https://fullnode.testnet.sui.io:443` (override `SUI_RPC_URL`) |
| BTC | operator's external signer (never in repo) | a little signet/testnet BTC | signet/testnet faucets above | Esplora `https://blockstream.info/testnet/api` (or self-hosted) |

Mainnet funding (reference only — gated, do not run during prep): EVM a few USD
on Base / more on L1; Solana ~3–5 SOL for program rent (~400 KB `.so`); Sui a few
cents of SUI; BLOCK reserve-wallet gas; BTC real BTC in the hot wallet.

---

## 5. End-to-end order of operations (testnet)

1. **BLOCK (us):** `cd block && FEE_ADDR=<hex32> ./scripts/deploy.sh` → copy the id.
2. **EVM/Solana/Sui (operator):** each runs its one-command deploy with their
   own funded key (§3.2–3.4); Solana also runs `initialize(fee_bps, fee_wallet)`.
3. **BTC (operator):** fund the hot wallet, fill `btc/config.json` fee address,
   note the hot-wallet address + Esplora URL (§3.5).
4. **Wire the relay:** `node exchange/contracts/collect-deployments.mjs --write`
   (plus set the BLOCK/BTC env vars, or paste those two by hand). Confirm
   `exchange/server/config.json → htlc` has a non-blank entry for every active
   network leg.
5. **Verify fail-closed:** start the relay on testnet; attempt a swap on a leg
   you did **not** configure — it must be refused with the "no HTLC address
   configured … fail-closed" error. That proves the wiring.
6. **Leave mainnet off.** `mainnetEnabled=false`, `legalReview.completed=false`
   until a real review. Mainnet keys in `htlc.*` stay blank.

---

## 6. The exact human inputs still required (RED items)

Automated already (no human needed beyond running the command): build, gate
checks, declare-id sync (Solana), fee baking (BLOCK), artifact capture, relay
collection.

Still required from a human, per leg:

- **BLOCK (us):** choose the public `FEE_ADDR` (reserve/treasury); provide the
  reserve-wallet passphrase at run time. *(Everything else we control.)*
- **EVM (operator):** funded `PRIVATE_KEY`; `SEPOLIA_RPC_URL` (+ `BASE_*`/
  `ETHEREUM_RPC_URL` for other nets); a real `feeAddress`. Optionally
  `ETHERSCAN_API_KEY`/`BASESCAN_API_KEY` to verify source.
- **Solana (operator):** funded `ANCHOR_WALLET`; the PUBLIC `fee_wallet` for
  `initialize`; a decision on upgrade-authority custody (multisig vs.
  `--final`) before mainnet.
- **Sui (operator):** a funded keystore address (`sui client active-address`);
  optionally a private `SUI_RPC_URL`.
- **BTC (operator):** a funded P2WPKH hot wallet + its external signer; the
  per-network `treasuryFeeAddress` (fill the `_TODO_` entries in
  `btc/config.json`); an Esplora endpoint.
- **All legs, mainnet only:** a recorded legal/compliance sign-off →
  `HTLC_MAINNET_ENABLED=true` + `HTLC_LEGAL_REVIEW_REF`, and
  `legalReview.completed=true` in the relay config.

See **AUDIT-READINESS.md** before any leg holds mainnet funds.
