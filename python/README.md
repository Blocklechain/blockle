# blockle (Python)

> `pip install blockle` — the Python interface to Blockle, the universal
> deployment system for PoW mining pools.

The heavy lifting (chain interrogation, stratum, share validation, merged
mining, payouts) runs in the Blockle core — a single static Rust binary.
This package provides the `blockle` CLI, process management, and Python
clients for blockle.biz and pool dashboards.

```python
import blockle

# interrogate any chain's RPC → full profile with confidence + evidence
profile = blockle.inspect("http://127.0.0.1:8332")

# generate a pool (raises if the chain can't be auto-classified)
pool = blockle.add_chain("MyCoin", "http://127.0.0.1:8332")
pool.add_aux("BLOCK", "http://127.0.0.1:18981/")      # merged mining
pool.register("https://blockle.biz",
              public_chain_rpc="http://mynode.example:8332",
              payout_address="block1…")               # Proof of Blocks

with pool.serve():                                     # stratum + dashboard
    print(pool.dashboard_stats())

# blockle.biz network API
biz = blockle.BizClient("https://blockle.biz")
biz.pools(); biz.pob(); biz.settlement_batch()

# onboard an EXISTING pool with zero infrastructure change:
biz.register_external(name="Legacy Mining Co", chain="Bitcoin",
                      stratum="stratum.legacy.example:3333",
                      chain_rpc="http://public-node.example:8332",
                      coinbase_tag="/LegacyPool/",
                      payout_address="block1…")
```

The CLI delegates to the core, so everything in the main docs works
unchanged: `blockle init <chain-source>`, `add-chain`, `serve`,
`register`, `discover`, `inspect --generate-adapter`, `demo`.

## Binary resolution

The wrapper finds the core via, in order: `BLOCKLE_BIN` env var → a binary
bundled in the wheel (platform wheels, release pipeline) → `PATH` → a
sibling Cargo workspace (auto-built with `cargo build --release` on first
use). Source installs need Rust; platform wheels will not.

## Tests

`python -m unittest discover -s tests` runs real end-to-end integrations:
simulated chains, generated pools, actual stratum mining, blockle.biz
registration, and Proof-of-Blocks verification — no mocks.
