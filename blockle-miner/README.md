# blockle-miner

An easy, multi-algorithm **CPU miner** that speaks **Stratum v1**. Pick an
algorithm, point it at any stratum pool, and mine — on any hardware, with any
pool, not just Blockle's.

```
blockle-miner mine --algo scrypt \
  --url stratum+tcp://pool.example.com:3333 \
  --user YOUR_WALLET.worker1
```

## Install / build

Rust (stable) required.

```
cargo build --release          # from this directory
./target/release/blockle-miner --help
```

Or install from the workspace: `cargo install --path .`

## Usage

```
blockle-miner mine --algo <ALGO> --url <STRATUM_URL> --user <USER> [--pass x] [--threads N]
blockle-miner algos            # list supported algorithms
```

- `--algo`   one of: `sha256d`, `scrypt`, `x11`, `blake2b`, `blake2s`, `blake3`
- `--url`    `stratum+tcp://host:port` (or `host:port`). **Any** Stratum v1 pool.
- `--user`   pool username — usually your wallet address, often `address.worker`.
- `--pass`   pool password (most pools accept `x`, the default).
- `--threads` CPU threads (defaults to all cores).

Examples:

```
# Perbug / Bitcoin-family (SHA-256d)
blockle-miner mine --algo sha256d --url stratum+tcp://perbug.com:3333 --user block1you.rig1

# Litecoin / Dogecoin (Scrypt) — any public LTC pool works
blockle-miner mine --algo scrypt --url stratum+tcp://ltc.pool.com:3333 --user LTCADDR.worker

# Dash (X11)
blockle-miner mine --algo x11 --url stratum+tcp://dash.pool.com:3333 --user XxADDR

# Use 4 threads
blockle-miner mine --algo sha256d --url host:3333 --user me --threads 4
```

While running it prints your hashrate and accepted/rejected shares every few
seconds.

## Supported algorithms

| Algo      | Coin families                 | Notes |
|-----------|-------------------------------|-------|
| `sha256d` | Bitcoin, Perbug, BCH          | fully standard |
| `scrypt`  | Litecoin, Dogecoin            | N=1024, r=1, p=1 |
| `x11`     | Dash                          | standard |
| `blake2b` | Blake2b-256 header pools      | 80-byte-header hash |
| `blake2s` | Blake2s-256 header pools      | 80-byte-header hash |
| `blake3`  | Blake3 header pools           | 80-byte-header hash |

All of these share the classic Bitcoin-family 80-byte block header and Stratum
v1 — only the header hash differs, which is why one miner covers them and works
with any pool that speaks that protocol.

**Not yet supported:** chains with bespoke stratum dialects / non-Bitcoin
headers — e.g. Kaspa (kHeavyHash), Nervos (Eaglesong), Alephium. Those use
different work formats and need dedicated backends; they are a planned addition.

## Notes

- This is a **CPU** miner — great for testing a pool, small algos, or low-power
  rigs. For SHA-256d/Scrypt/X11 at scale you'll want ASICs pointed at the same
  pool URL; the point of this tool is that it works everywhere with zero setup.
- It never holds keys or funds. `--user` is just the pool account the pool
  credits your shares to.

MIT OR Apache-2.0.
