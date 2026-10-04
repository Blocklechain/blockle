# Blockle

> An independent Equihash Proof-of-Work blockchain — ASIC-compatible from day
> 1, post-quantum signatures, native smart contracts on its own VM, and
> native zero-knowledge privacy on the roadmap. No EVM compatibility.

**⛏ Equihash** — ASIC-ready PoW with a stratum endpoint · **🔒 Privacy** —
shielded pool with STARK spend proofs, live · **📜 Contracts** — the Blockle
VM, live

## Chain parameters

| Parameter          | Value                                             |
| ------------------ | ------------------------------------------------- |
| Ticker             | **BLOCK** (1 BLOCK = 10⁸ base units)              |
| Consensus          | Equihash **(200, 9)** — the exact Zcash wire construction (`"ZcashPoW"` Blake2b personalization, 1344-byte packed solutions), so existing Equihash ASICs and pool stacks work unmodified |
| Header             | 140-byte Zcash-shaped layout; block hash = double-SHA256, compared little-endian |
| Block time         | 600 s (10 minutes); regtest: 1 s                  |
| Difficulty         | LWMA, retuned every block (window 17)             |
| Block subsidy      | 50 BLOCK, halving every 210,000 blocks (Bitcoin schedule, ~21M mined) |
| Premine            | 210,000 BLOCK, paid by the genesis coinbase       |
| Coinbase maturity  | 100 blocks (genesis premine exempt)               |
| Signatures         | **ML-DSA-44** (FIPS 204 / Dilithium2) — post-quantum; 1312-byte keys, 2420-byte signatures |
| Addresses          | bech32m `block1…` (Blake2b-256 of the public key)  |
| Contracts          | Blockle VM: gas-metered stack machine; gas prepaid via fee at 10 base units/gas; 10M gas/block |
| Shielded pool      | Rescue note commitments in a depth-15 tree; nullifier set; **STARK spend proofs** (winterfell, hash-based → PQ-aligned, ~18 KB, ~1 ms verify) |
| Max block size     | 2 MB                                              |
| Networks           | `mainnet` · `testnet` (both 200,9, fixed embedded genesis) · `regtest` (48,5, mine-your-own) |

## Workspace layout

```
crates/
├── pow     Equihash solver/verifier (bit-level Wagner, Zcash-compatible
│           construction) + compact-bits targets, LWMA, accumulated work
├── core    Blocks (Zcash-shaped headers), transactions (contract actions +
│           shielded bundles), Merkle roots, ML-DSA-44 keys, addresses
├── chain   Consensus validation, UTXO + contract + shielded state, subsidy
│           schedule, contract execution, block templates, CPU miner
├── vm      The Blockle VM: deterministic gas-metered stack machine with
│           storage/send/hash host calls, plus an assembler
├── zk      Shielded pool cryptography: Rescue commitments, sparse note
│           tree, and the STARK spend circuit (winterfell)
└── node    Library (P2P, storage, stratum) + the `blockle` CLI
```

## The shielded pool (live)

Native privacy, post-quantum-aligned end to end: spend proofs are **STARKs**
(hash-based, transparent setup — no elliptic curves, no trusted ceremony),
matching the chain's ML-DSA signatures.

A note is `C = Rescue(N, v, r)` in an append-only commitment tree. Spending
reveals only the nullifier `N` and value `v`, with a STARK proving the note
exists under a historical tree root — *which* note, and its position, stay
hidden (ownership unlinkability). Each proof is bound to its transaction's
sighash through the proof transcript, so proofs can't be replayed or
redirected. Double spends are caught by the nullifier set.

```sh
blockle shield --amount 1000 --node …                  # t → z: create a note
blockle notes / zbalance                               # wallet note status
blockle zaddress                                       # your zblockpk… address
blockle zsend --note 0 --amount 300 --to zblockpk… --node …
                                   # hidden-amount payment, encrypted delivery
blockle scan                       # find + decrypt incoming notes
blockle unshield --note 0 --to block1… --node …        # z → t
blockle note-disclose 0 / verify-disclosure …          # proof of payment
blockle viewkey                                        # audit (incoming) key
```

**Hidden amounts** (`zsend`): fully-shielded transfers use a second STARK —
spend one note into a payment note + change note with **private values**,
proving `v = v₁ + v₂ + fee` in-circuit. Only the fee is public. Amounts are
visible only at the pool boundary (`shield` / `unshield`), like Zcash.

**Encrypted delivery**: `zsend --to zblockpk…` delivers the payment note
on-chain, encrypted to the recipient's **ML-KEM-768** key (post-quantum);
`blockle scan` finds and decrypts incoming notes — no out-of-band step.
`viewkey` exports an incoming viewing key for audit-mode scanning, and
`note-disclose` / `verify-disclosure` give verifiable proof of payment.

Remaining v1 caveats, stated plainly:
- A sender can derive the secrets of notes it creates (bearer-note model) —
  recipients should promptly `zsend` received funds to themselves;
  recipient-bound nullifiers (sk-derived) are the fix, planned as a circuit
  upgrade.
- Proof parameters are prototype-grade and consensus-pinned; the tree holds
  2^15 notes.

## The Blockle VM + Blockle Script (live)

Write contracts in **Blockle Script** and deploy the `.bs` file directly —
it compiles to VM bytecode on the way in:

```text
contract Counter {
    state count: u64

    fn add(amount: u64) -> u64 {
        require(amount > 0)
        count = count + amount
        return count
    }
}
```

State variables, functions with selector dispatch, `if`/`while`, `require`,
`send_caller`, `log`, and env builtins (`value()`, `height()`, `balance()`).
`blockle contract build file.bs` shows the generated assembly; `.asm` files
remain first-class for hand-written contracts. The `ZKVERIFY` opcode lets
contracts verify shielded spend proofs — privacy as a contract primitive.

Underneath: a purpose-built stack machine — deterministic,
gas-metered per instruction, no EVM. Transactions carry an optional action:
**Deploy** (store code; contract id derived from the txid) or **Call**
(execute with calldata, optionally attaching BLOCK value). Gas is prepaid
through the fee (`fee ≥ gas_limit × gas_price`) — failed calls change nothing
and refund attached value to the sender. Contracts hold balances and 32-byte-
keyed storage; the `SEND` host op pays out of a contract's balance by minting
real UTXOs. Host calls for Blake2b and (next milestone) ZK-proof verification
make privacy a first-class contract primitive.

Write contracts in assembler for now (`examples/contracts/`); Blockle Script
compiles to this VM later.

```sh
blockle --network regtest contract deploy examples/contracts/counter.asm --node 127.0.0.1:18444
blockle --network regtest contract call <id> --input 0700000000000000 --node 127.0.0.1:18444
blockle --network regtest contract simulate <id> --input 0a00000000000000   # dry-run, free
blockle --network regtest contract storage <id>
blockle --network regtest contract list
```

## P2P network

`blockle start` runs a full node: TCP transport with length-prefixed
**bincode** frames, thread-per-peer, no async runtime.

- **Headers-first sync**: peers advertise accumulated work; the lighter side
  sends a block locator, validates returned headers (linkage + standalone
  PoW), downloads only the missing blocks, and fully re-validates before
  adopting (most-work fork choice).
- **Gossip**: new blocks and transactions propagate to all peers; a tip
  heartbeat repairs anything missed.
- **Peer discovery**: `Version` carries each node's listen address;
  `GetAddr`/`Addr` gossip spreads them, and nodes auto-dial until the
  outbound target is met — one bootstrap peer is enough to join the mesh.
- The built-in miner abandons stale work the moment a better tip arrives.

```sh
# first node: create the chain, then serve + mine + stratum
blockle --network regtest init
blockle --network regtest start --listen 127.0.0.1:18444 --mine --mine-interval 2 \
    --stratum 127.0.0.1:3333

# everyone else: no init — sync from the network
blockle --datadir .blockle-b --network regtest start \
    --listen 127.0.0.1:18445 --connect 127.0.0.1:18444

# transact through any running node
blockle --network regtest send --to block1… --amount 1000 --node 127.0.0.1:18444
```

Only ever `init` one node per network.

## Stratum mining (ASICs / pools)

`--stratum HOST:PORT` serves Equihash stratum jobs: `mining.subscribe` (16-byte
server nonce1 + 16-byte miner nonce2), `mining.set_target`, `mining.notify`
with the 140-byte header fields, and `mining.submit`. Submissions are
validated (Equihash + target + full block rules), connected, and gossiped.
Currently a **solo** endpoint — share-difficulty accounting for pools, and
byte-order shakedown against real ASIC firmware, are listed under M5.

## Roadmap

- [x] **M1 — Core chain**: Equihash PoW, LWMA difficulty, UTXO/note
      transactions, Bitcoin-schedule emission + premine, CLI node & miner
- [x] **M1.5 — Day-1 hardening**: ASIC-compatible Equihash (200,9) with the
      Zcash wire construction; post-quantum ML-DSA-44 signatures
- [x] **M2 — Blockle VM**: deterministic gas-metered interpreter, contract
      storage/balances, deploy/call transactions, payout UTXOs, assembler,
      simulate/storage CLI
- [x] **M4 — Network**: P2P gossip, most-work fork choice, network-aware miner
- [x] **M4.5 — Network hardening**: binary wire codec, headers-first sync
      with locators, peer discovery + auto-connect, stratum endpoint
- [x] **M3 — Privacy (core)**: shielded pool with Rescue note commitments,
      nullifier set, and STARK spend proofs bound to transactions
- [x] **M3.5 — Privacy hardening**: hidden-amount transfers (in-circuit
      value conservation), ML-KEM-768 encrypted on-chain note delivery,
      wallet scanning, viewing keys, payment disclosures
- [x] **M2.5 — Blockle Script**: high-level contract language (state vars,
      functions, control flow, require/send/log) compiling to the VM;
      `ZKVERIFY` spend-proof verification as a VM opcode
- [x] **M5 — Launch prep**: fixed embedded genesis for mainnet + testnet
      (rogue genesis rejected by consensus), testnet network, pool-grade
      stratum (per-client share targets + vardiff), SPEC.md with
      golden-vector tests freezing the wire format
- [ ] **Next**: recipient-bound nullifiers (circuit v3), binary block
      storage + incremental reorgs, ASIC firmware interop testing,
      independent circuit + consensus audit, public testnet launch

## Status

Prototype with real consensus: every block fully re-validates from disk —
including every STARK spend proof — contract execution is deterministic and
consensus-enforced, and candidate chains are completely re-validated before
adoption. Multi-node sync, peer discovery, contract deploy/call, shielded
shield/zsend/unshield with voucher handoff between wallets, and stratum
mining are all exercised end-to-end by tests and live demos. Not yet
production: JSON storage, full-chain revalidation on reorg, solo-only
stratum, per-`init` genesis, and the v1 privacy limitations listed above.
The spend circuit is adapted from winterfell's audited example constraints
but has not itself been independently audited.
