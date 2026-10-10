# BLOCK leg — Blockle-VM HTLC

Hash-timelocked contract on the Blockle VM for native **BLOCK**. One deployed
contract instance per swap leg; the escrowed amount rides in as the native
`Call.value`, the hashlock is **BLAKE2B-256** (the VM's only hashing opcode),
and the timelock is a block **height**.

This is a Rust crate (`blockle-htlc`) that **emits VM bytecode** and provides
calldata builders — it wraps the existing VM/consensus, it does not fork them.

See [`../PROTOCOL.md`](../PROTOCOL.md) for the full protocol.

## Call ABI (leading selector byte)
- `0x00` **lock** — `receiver(32) ‖ hashlock(32) ‖ timelock_height(8 LE)`,
  attach `Call.value = amount`. Callable once.
- `0x01` **withdraw** — `preimage(..)`. Pays `receiver` `amount − fee`, sends the
  0.1% fee to the baked `fee_addr`. Succeeds iff `blake2b256(preimage) == hashlock`.
- `0x02` **refund** — repays the locker; valid once `HEIGHT ≥ timelock_height`.
  No fee on a failed swap.

## Build & test
```bash
cd exchange/contracts/block
cargo test     # unit tests + regtest HTLC lifecycle (claim path + refund path)
```
`tests/htlc_regtest.rs` deploys the HTLC on a real regtest `Chain`, locks value,
proves a wrong preimage and a double-claim are rejected, that the correct
preimage pays receiver + fee, and that refund returns funds to the sender only
after the timelock height.

## Hash reconciliation (IMPORTANT)
The VM exposes **only `BLAKE2B`** (opcode `0x68`) — there is **no `SHA256`
opcode**. Therefore:

- **BLOCK ⇄ BLOCK** swaps are fully supported today (BLAKE2B both legs).
- **BLOCK ⇄ EVM / Solana** needs the VM to gain a `SHA256` opcode so all legs
  can share `H = sha256(s)`. A cross-hash swap (BLAKE2B on one leg, SHA-256 on
  the other) is cryptographically unsafe and is deliberately **not** provided.
  The exact one-opcode change is specified in `PROTOCOL.md §4`; `htlc_asm` is
  structured so flipping the single `BLAKE2B` call to `SHA256` is all that's
  needed once the opcode lands. No SHA-256 path on the VM was faked.

## Timelock side note
`refund` requires `HEIGHT ≥ timelock`; it does not additionally forbid a late
`withdraw`. When pairing BLOCK with a timestamp chain, run BLOCK as the
**maker/long (`T1`)** side, or add a `HEIGHT < timelock` guard to `withdraw` if
BLOCK must be the short side. See `PROTOCOL.md §3`.

## Deploy (the one leg WE can deploy)

BLOCK is the only HTLC leg the Blockle side controls end-to-end: we hold the
node + reserve wallet, so we deploy it ourselves with the `blockle-chain` CLI.
There is no third-party operator key to wait on.

### One command

```bash
cd exchange/contracts/block
FEE_ADDR=<32-byte-hex reserve/treasury address> ./scripts/deploy.sh         # -> regtest
# mainnet (gated):
FEE_ADDR=<hex32> NETWORK=mainnet HTLC_MAINNET_ENABLED=true \
  HTLC_LEGAL_REVIEW_REF=LR-123 DATADIR=/var/lib/blockle NODE=1.2.3.4:8444 \
  ./scripts/deploy.sh
```

`scripts/deploy.sh` (a) emits the HTLC assembly with `FEE_ADDR` baked in via the
`htlc-asm` bin, (b) builds + runs `blockle-chain`, and (c) prints the contract
id. The wallet in `--datadir` funds + signs the deploy tx; its passphrase comes
from `BLOCKLE_WALLET_PASSPHRASE` (or an interactive prompt). **No key is ever
read or written by this repo.**

### The exact underlying command

The script wraps exactly this (so you can run it by hand):

```bash
# 1. emit the .asm with the reserve fee address baked in
FEE_ADDR=<hex32> FEE_BPS=10 cargo run --quiet --bin htlc-asm > htlc.asm

# 2. deploy it as a BLOCK-VM contract from the reserve wallet/node
blockle-chain --network regtest --datadir .blockle \
  contract deploy htlc.asm --gas 300000 [--node <p2p-addr>]
# prints:  contract id: <64-hex>
```

Deploying the `.asm` is byte-identical to deploying `htlc_bytecode()`:
`blockle-chain contract deploy *.asm` assembles with the same
`blockle_vm::asm::assemble` the crate uses.

### Where the contract id goes

Put the printed `contract id: <hex>` in the relay config:

```jsonc
// exchange/server/config.json
"htlc": { "block": { "contractId": "<64-hex>" } }
```

or set env `BLOCKLE_EXCHANGE_HTLC_BLOCK_CONTRACT=<hex>`. The swap engine refuses
a BLOCK leg (fail-closed) until this is set for the active network
(`exchange/server/src/config.ts` → `htlcTarget`).

> **Testnet-first.** Use regtest/testnet; the BLOCK mainnet money-path switch
> lives in the exchange service and requires legal/compliance sign-off.
