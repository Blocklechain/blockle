# Blockle

> **BLOCK — the universal auxiliary chain.**
> The ultimate ASIC merge coin: BLOCK's consensus accepts a parent block's
> proof-of-work from **every major ASIC algorithm** in place of a native
> solution. Keep mining Bitcoin, Litecoin/Dogecoin, Zcash, Dash — every
> share you mine also mines BLOCK. [blockle.org](https://blockle.org) runs
> the pools.

## The chain (`chain/`, binary `blockle-chain`)

A post-quantum L1 with Bitcoin tokenomics (50 BLOCK / block, halving every
210,000 blocks, 10-minute combined spacing, 210,000 BLOCK genesis premine)
and a fixed, mined mainnet genesis (`069209f0…954b4e`).

- **Multi-algorithm merged mining (AuxPoW)** — the headline. Ten
  independent proof-of-work lanes: native Equihash (200,9) plus parent
  proofs under `sha256d`, `scrypt`, `x11`, `equihash`, `blake2b`,
  `blake2s`, `blake3`, `eaglesong`, and `kheavyhash`. A bitcoin-family
  parent block whose coinbase commits to a BLOCK header
  (Namecoin-shaped `fabe6d6d` commitment, chain id 16972) *is* a BLOCK
  block; each lane runs its own LWMA difficulty so an S19 never competes
  with an L7. Zcash parents verify bit-exactly (same Equihash
  personalization, same header layout, sha256d block hash).
  Structurally-alien majors (Kaspa, Nervos, Alephium native headers) have
  their algorithms registered; per-chain proof adapters are roadmap.
- **Post-quantum**: ML-DSA-44 signatures, ML-KEM-768 encrypted note
  delivery.
- **Privacy**: STARK shielded pool — shield/unshield, hidden-amount z→z
  transfers, out-of-band vouchers, incoming viewing keys, payment
  disclosures.
- **Blockle VM**: contracts with gas, an assembler, and the Blockle Script
  compiler (`blockle-chain contract …`).
- **Pools built into the node**:
  `blockle-chain start --stratum 0.0.0.0:3333 --stratum-pplns 0.0.0.0:3334
  --pool-fee 1.0` runs two Equihash stratum endpoints —
  **solo** (each miner authorizes with their BLOCK address; the coinbase
  pays the finder directly, minus the fee — the pool never holds funds)
  and **PPLNS** (difficulty-weighted share window; found blocks append to
  a public ledger and a payout executor settles them on-chain after
  coinbase maturity). Live stats JSON per pool
  (MiningPoolStats-compatible), vardiff, full share validation.
- **Aux-work interface**: `--aux-http` serves
  `createauxblock` / `submitauxblock` / `getauxchaininfo` so any parent
  pool can merge-mine BLOCK with ~30 lines of glue.
- **Wallet tooling**: `ui-snapshot` (one JSON document: balances, notes,
  history) and `--json` transaction output drive the GUI below.

## The Qt wallet (`pip install 'blockle[qt]'` → `blockle-qt`)

Qt 6 desktop wallet, one codebase for macOS/Windows/Linux — and
decentralized by construction: it embeds a full `blockle-chain` node that
syncs peer-to-peer. Transparent + shielded funds, private sends,
vouchers, note scanning, regtest mining. Direct downloads on
[blockle.org/wallet](https://blockle.org/wallet), built by public CI.

## AutoPool (`src/`, binaries `blockle` + `blockle-biz`)

The universal deployment system for PoW mining pools:

- 3-layer chain interrogation (RPC dialect census → template
  introspection with field mapping → algorithm fingerprinting), `blockle
  add-chain` / `blockle init <repo>`.
- Stratum v1 engine with vardiff, full share reconstruction,
  solo/PPLNS/PROP/PPS ledgers, **1% default fee**, miner bans.
- Bitcoin-family merged mining (AuxPoW) in the adapter.
- **Wallet auto-provisioning**: `add-chain` creates a hot (coinbase) and
  payout wallet via the chain's own RPC and a local BLOCK wallet for the
  pool.
- **Pruned parent nodes**: `blockle parent-node --coin bitcoin
  --prune-mb 4096` emits the config + systemd unit that lets the majors
  coexist on one box (pruned bitcoind ≈ 5 GB; mining needs no history).
- `blockle-biz` serves [blockle.org](https://blockle.org): our pools with
  live stats, the BLOCK explorer (fed by the node's snapshot), wallet
  downloads, a third-party pool directory with verified-vs-reported data
  separation, and JSON APIs (`/api/chain`, `/api/mps/{solo|pplns}`,
  `/api/pools`, …).

## Try it

```sh
# the chain, end to end (regtest)
cd chain && cargo build --release
./target/release/blockle-chain --network regtest --datadir /tmp/b init
./target/release/blockle-chain --network regtest --datadir /tmp/b \
    start --stratum 127.0.0.1:3333 --stratum-pplns 127.0.0.1:3334 --aux-http 127.0.0.1:8445

# the pool generator
cargo build --release
./target/release/blockle demo
```

## Honest status

Prototype-grade but proven end-to-end by 95 Rust + Python integration
tests over real sockets: merged blocks accepted from all nine parent
algorithms, solo coinbases paying the finder, PPLNS ledgers, P2P wallet
sync, STARK shielded transfers, VM contracts. Not yet shaken down against
live ASIC firmware or live parent mainnets (byte-order quirks expected);
kHeavyHash/Blake lanes follow our 80-byte-parent definition pending
native-structure adapters; the payout executor retries conservatively.
Statistics on blockle.org are live or absent — never simulated.
