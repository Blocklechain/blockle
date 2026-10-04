# Blockle

> **The universal deployment system for PoW mining pools.**
> Point Blockle at a chain. It interrogates the node, figures out how to
> mine it, and deploys the pool — stratum, vardiff, share validation,
> merged mining, payouts, dashboard. blockle.biz is the public directory
> and monitoring network those pools register with.

```text
$ blockle init https://github.com/example/newcoin
── blockle init ──
1. scanning source … algorithm: SHA-256d · rpc port 8332 · confidence 76%
2. looking for a running node… found at http://127.0.0.1:8332/
Pool ready.                       # or: a prefilled scaffold + next steps

$ blockle add-chain --name MyCoin --rpc http://127.0.0.1:8332
Analyzing MyCoin...
✓ RPC connection
✓ Chain detected (main, /Satoshi:27.0.0/)
✓ Current block: 182921
✓ Block template detected (getblocktemplate)
✓ Difficulty detected
✓ Reward detected
✓ Template field mapping
✓ PoW algorithm: SHA-256d
✓ Block submission method (submitblock)
Confidence: 100%

Generating pool...
✓ Stratum server          ✓ Variable difficulty
✓ Share validation        ✓ Block tracker
✓ Payout ledger (PPLNS)   ✓ Web dashboard
Pool ready.
stratum+tcp://0.0.0.0:3333
```

## How detection works

Unknown chains are handled in three layers, so new coins degrade
gracefully instead of failing:

1. **Dialect census** — probes the signature methods of each RPC family
   (bitcoind, ethereum, monero) and records exactly what answered.
2. **Template introspection** — fetches the block template and maps its
   actual JSON onto a normalized schema by field-name synonyms *and value
   shape* (64-hex ⇒ hash, 8-hex ⇒ compact bits, `seed_hash` ⇒ RandomX,
   work-array ⇒ Ethash…). Forks with renamed fields get a concrete
   field-map manifest written into the pool config — onboarding is editing
   TOML, not writing code.
3. **Algorithm fingerprinting** — subversion strings, solutions-vs-hashes
   rate fields, template markers; every finding carries its evidence and a
   confidence score.

When a chain can't be fully classified:

```text
$ blockle inspect --rpc http://… --generate-adapter
⚠ Manual adapter required
Generated starter adapter:
  adapters-out/mycoin.toml          ← everything that WAS detected
  adapters-out/mycoin_adapter.rs    ← stub listing exactly what wasn't
```

And given only a source repository:

```text
$ blockle discover https://github.com/example/newcoin
Blockle discovered:
  Algorithm: Equihash  (14 signature hits, e.g. src/pow.rs)
  getblocktemplate RPC · block subsidy logic · target spacing · …
Confidence: 96%
```

## Pool features

- **Stratum v1** server, thread-per-miner, fractional difficulties
- **Vardiff** seeded from network difficulty, retargeting per miner
- **Share validation**: full PoW reconstruction (coinbase splice, merkle
  branch, header) — never trust the miner
- **Payout schemes**: `solo`, `pplns`, `prop`, `pps` + pool fee; every
  attribution frozen at block-find time, auditable; miner banning on
  invalid-share streaks
- **Merged mining (AuxPoW)**: commit any number of aux chains into the
  parent coinbase (`0xfabe6d6d`), submit Namecoin-shaped proofs when a
  share meets an aux target — one miner's work, many chains' blocks
- **Dashboard**: dark HTML + `/stats.json` + `/payouts.json`
- **blockle.biz registration**: `blockle register` pairs the pool with the
  directory; `blockle serve` then heartbeats automatically

## blockle.biz (the monitoring network)

`blockle-biz` serves the public directory: homepage with live network
summary, `/pools` (search/filter/sort), `/pool/{id}` with 48h sparkline
charts and offline warnings, `/chain/{chain}`, `/algorithms` (only
algorithms actually observed — nothing assumed), `/status`, `/developers`,
`/open-source`, and a free JSON API (`/api/pools`, `/api/chains`,
`/api/stats`, `/api/health`, documented at `/api`).

Data honesty is structural: token-authenticated heartbeats are schema-,
range-, and freshness-validated and rate-limited; responses separate
**verified** data (heartbeat recency, active stratum reachability probes)
from **operator-reported** data (hashrates, miner counts); empty states
render as zeros. Statuses: registered → online → verified.

### Proof of Blocks (the BLOCK incentive)

Blocks found on whitelisted chains mint BLOCK — but only after
**independent verification**: blockle.biz checks every claim against the
pool's registered public chain RPC (block exists, ≥3 confirmations,
difficulty ≥ the chain's floor, per-pool daily caps, global dedupe by
hash). Emission is **difficulty-based**: minted BLOCK = the block's
independently-verified difficulty × a per-algorithm weight — reward is
proportional to actual work, nothing is operator-declared, and a Bitcoin
block mints on the order of a thousand BLOCK while a small chain's block
mints a fraction. The algorithm weights only normalize difficulty units
across PoW algorithms (SHA-256d ≠ RandomX ≠ Equihash); they're launch
calibrations reviewed against market hashprice data before settlement —
an emission rule, explicitly *not* a USD peg or redemption promise. The
whitelist ships with ~35 major PoW
chains (Bitcoin, Litecoin, Monero, Zcash, ETC, Kaspa, Ravencoin, Ergo, …)
with per-chain difficulty floors; new chains apply (technical criteria
always gate; listing-review fees are labeled and never substitute for
them).

**One weight per algorithm, period.** Emission weights live in a single
public per-algorithm table (`--algo-weight`), shared by every chain on
that algorithm — no per-chain overrides exist, so no chain can negotiate
its own emission. The **BLOCK Explorer** (`/explorer`) tracks the ledger:
every mint event with full provenance (source coin, block height/hash,
verified difficulty, the exact emission formula, recipient address),
emission totals **by source coin** and by algorithm, and pending
settlement batches — BLOCK's ledger is the emission ledger until on-chain
settlement activates transfers.

**Existing pools opt in with zero infrastructure change**: register as an
external pool (name, public chain RPC, coinbase signature) and the chain
watcher walks new blocks itself, attributes yours by coinbase tag, and
mints to your registered BLOCK address. Credits are grouped into per-epoch
settlement batches (`/api/pob/settlement-batch`) and **settled on-chain**:
the BLOCK chain lives in `chain/` (the revived Blockle L1 — Equihash PoW,
post-quantum ML-DSA signatures, STARK shielded pool, Blockle VM), extended
with a consensus-validated **settlement mint** transaction. The
`blockle-chain settle` executor fetches a batch, signs one mint per epoch
with the settlement-authority key (federated settlement v1; consensus
enforces the authority signature, exact output↔entry matching, and
one-mint-per-epoch replay protection), submits it to the chain, and marks
the epoch settled on blockle.biz — the explorer then links every mint to
its BLOCK-chain txid. The full loop runs in the demo: a share mined on a
foreign chain ends as spendable BLOCK at the pool's payout address.
Decentralization upgrades (AuxPoW-native emission, multi-sig authority)
are the roadmap.

## Try it (fully self-contained)

```sh
cargo build --release
./target/release/blockle demo
# simulated chain + interrogation + generated pool + CPU miner
# + merged-mined BLOCK chain, over real sockets
```

Or the whole network, as separate processes:

```sh
blockle-biz --listen 127.0.0.1:8900 &
blockle simchain --listen 127.0.0.1:18980 --name SimCoin &
blockle simchain --listen 127.0.0.1:18981 --name BLOCK &
blockle add-chain --name SimCoin --rpc http://127.0.0.1:18980/ --out pool.toml
blockle register --config pool.toml --biz http://127.0.0.1:8900
blockle serve pool.toml &
blockle mine --stratum 127.0.0.1:3333 --worker alice --shares 4
open http://127.0.0.1:8900/pool/simcoin
```

## Qt wallet (`pip install 'blockle[qt]'` → `blockle-qt`)

A desktop wallet for the BLOCK chain, built on Qt 6 (PySide6) — one
codebase, native on macOS/Windows/Linux. Decentralized by construction:
the wallet embeds a full `blockle-chain` node (P2P listen/connect, chain
sync, tx gossip) and all keys/signing stay in the Rust binary on your
machine. Transparent + shielded funds are first-class: balances, history,
send, shield/unshield, hidden-amount `zsend` with voucher or on-chain
ML-KEM delivery, note import, and incoming-note scanning — plus regtest
mining for development. The GUI drives the node through `blockle-chain
ui-snapshot` (one JSON document: wallet, notes, chain status, full wallet
history) and `--json` transaction commands; anything can build on the same
interface.

## Pool wallets & fees

`blockle add-chain` auto-provisions the money plumbing: a **hot wallet**
(coinbase target) and a separate **payout wallet** created inside the
chain node's own wallet via RPC (keys never leave the node), and a local
**BLOCK wallet** whose address receives the pool's Proof-of-Blocks
rewards (`--blockle-address` to use your own). The pool fee is
`--fee` (default **1%**, applied uniformly across solo/PPLNS/PROP/PPS).

## Python (`pip install blockle`)

The `python/` package wraps the core: the `blockle` console script
delegates to the Rust binary, and the library gives a Pythonic API —
`blockle.inspect()`, `blockle.add_chain(...).serve()`, `BizClient`
(directory, PoB, settlement batches, `register_external`), plus process
management for chains/pools in tests. Integration tests drive the real
binaries end to end. Platform wheels will bundle the binary; source
installs auto-build via Cargo.

## Architecture

```
src/
├── probe.rs      3-layer chain interrogation → ChainProfile + confidence
├── adapter.rs    PoolAdapter trait — everything chain-specific behind it
├── adapters/
│   └── bitcoin.rs  bitcoind family: GBT, coinbase/merkle/header, AuxPoW
├── stratum.rs    chain-agnostic engine: sessions, vardiff, shares, bans
├── ledger.rs     solo/PPLNS/PROP/PPS accounting, fees, block attribution
├── btc.rs        sha256d, targets, varints, merkle, AuxPoW primitives
├── simchain.rs   real toy chain w/ bitcoind RPC + full AuxPoW validator
├── biz.rs        blockle.biz: registry, monitoring worker, site, API, PoB
├── discover.rs   source-repo scanning
├── genadapter.rs starter-adapter generation
├── miner.rs      built-in stratum CPU miner (demo + tests)
└── dashboard.rs  per-pool dashboard
```

Zero heavy dependencies (no async runtime, no database, no web framework);
single static binaries; registry persists to JSON. Designed so the free
tier stays free: paid products (Blockle Cloud hosting, advanced
monitoring/alerts, API-key tiers, custom adapter development, labeled
featured placement) layer on without touching registration or the core.

## The BLOCK chain (`chain/`)

Its own workspace: the complete L1 built earlier in this project
(ASIC-compatible Equihash, ML-DSA/ML-KEM post-quantum crypto, STARK
shielded pool with hidden amounts, the Blockle VM + Blockle Script, P2P,
fixed genesis) plus the settlement-mint consensus. Binary:
`blockle-chain`. Run `blockle-chain --settlement-authority <wallet> …` so
nodes accept mints signed by that authority.

## Honest status

Prototype, proven end-to-end against its own simulated chains (real
sockets, real PoW, real AuxPoW validation) and covered by unit + e2e
tests. Not yet validated against live bitcoind or ASIC/miner firmware
(byte-order shakedown pending); ethereum/monero dialects are detected and
stubbed, not pooled; charts are 48h sparklines; API keys and the
higher-rate tiers are documented but not enforced; Proof-of-Blocks
credits await on-chain settlement. The repository URL shown on the site
is a configurable placeholder (`--github`).
