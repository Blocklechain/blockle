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

> **Testnet-first.** Use regtest/testnet; the BLOCK mainnet money-path switch
> lives in the exchange service and requires legal/compliance sign-off.
