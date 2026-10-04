# Blockle Consensus Specification (protocol v1)

This document specifies every consensus-critical encoding and rule. The
golden-vector tests (`crates/core/tests/golden.rs`,
`crates/chain/tests/genesis_pinned.rs`) pin these formats; changing any of
them is a hard fork.

## 1. Primitives

| Primitive | Definition |
| --- | --- |
| `blake2b_256(p, m)` | Blake2b, 32-byte output, 16-byte-max personalization `p` |
| General hash | `blake2b_256("BlklHash", ·)` — txids, sighashes |
| Merkle node | `blake2b_256("BlklMrkl", left ‖ right)` |
| Address | `blake2b_256("BlklAddr", mldsa_pubkey)` (32 bytes) |
| Block hash | `SHA256(SHA256(serialized header))`, compared **little-endian** |
| Signature | ML-DSA-44 (FIPS 204), context string `"BlklTxV1"` |
| Shielded field | f128 = GF(2^128 − 45·2^40 + 1); felt = 16-byte LE, canonical only |
| Note hash | Rescue-Prime (winterfell example parameters, state 6, rate 4, 7 rounds) |

Integers are little-endian. Variable byte strings are `u32 length ‖ bytes`
("`bytes`" below). `compactsize` is Bitcoin's varint (header solution only).

## 2. Block header (140 bytes + solution)

```
version   u32            (4)
prev_hash                 (32)   previous block's SHA256d hash
merkle    ‖               (32)   Merkle root of txids
state_root                (32)   reserved; MUST be zero in v1
time      u32            (4)
bits      u32            (4)    Bitcoin compact difficulty encoding
nonce                     (32)
compactsize(len) ‖ solution     Equihash solution
```

Equihash input = first 108 bytes; nonce is the second puzzle input.

## 3. Proof of work

Equihash with the **Zcash wire construction**: personalization
`"ZcashPoW" ‖ n_le32 ‖ k_le32`; Blake2b output length `(512/n)·n/8` covering
`512/n` consecutive indices; input `header[0..108] ‖ nonce ‖ le32(index/(512/n))`;
solutions are big-endian bitstreams of `(c+1)`-bit indices, `c = n/(k+1)`.
Mainnet/testnet: `(n,k) = (200,9)` → 1344-byte solutions. Regtest: `(48,5)`.

Collision-tree validity: at round `r` the XOR of each pair's hashes has its
first `r·c` bits zero (full zero at round `k`); all `2^k` indices distinct;
each left branch carries the smaller minimum leaf index.

Block validity: solution verifies AND `SHA256d(header) ≤ target(bits)`
(little-endian compare). Difficulty: LWMA over the last 17 blocks, retargeted
every block, solvetimes clamped to `[1, 6·spacing]`; before the window fills,
target = `pow_limit`. Fork choice: greatest Σ `2^256/(target+1)`.

## 4. Emission

600-second spacing. Block 0 pays the 210,000 BLOCK premine. Block h ≥ 1 pays
`50 BLOCK >> (h / 210_000)` (zero after 64 halvings) plus all transaction
fees. Coinbase outputs mature after 100 blocks (block 0 exempt). 1 BLOCK =
10^8 base units. Fixed genesis: mainnet block 0 hash (displayed) is
`0c80040e…b314`, testnet `6ee0b2e7…f47a`; any other block 0 is invalid.

## 5. Transaction encoding

```
version       u32
inputs        u32 count, each: prev_txid(32) ‖ vout u32 ‖ bytes(pubkey) ‖ bytes(signature)
outputs       u32 count, each: recipient(32) ‖ amount u64
coinbase_data bytes              (coinbase only: height u64 ‖ tag)
shielded tag  u32 0|1; if 1:
  spends      u32 count, each: anchor(32) ‖ nullifier(32) ‖ value u64 ‖ bytes(proof)
  outputs     u32 count, each: commitment(32) ‖ value u64
  transfers   u32 count, each: anchor(32) ‖ nullifier(32) ‖ c1(32) ‖ c2(32)
                               ‖ fee u64 ‖ bytes(memo) ‖ bytes(proof)
contract tag  u32 0|1|2
  1 (Deploy): bytes(code) ‖ gas_limit u64
  2 (Call):   contract(32) ‖ bytes(input) ‖ value u64 ‖ gas_limit u64
```

`txid = blake2b_256("BlklHash", encoding)`. The **sighash** uses the same
encoding with every signature and every proof replaced by empty strings —
signatures sign it; shielded proofs bind it through their Fiat–Shamir
transcript. Balance rule:

```
fee = Σ t_in + Σ spend.value − Σ t_out − Σ z_out.value − contract_value + Σ transfer.fee ≥ 0
```

and if a contract action is present, `fee ≥ gas_limit × 10`. A coinbase has
no inputs and no shielded bundle; a non-coinbase needs transparent inputs or
shielded spends/transfers, and contract actions require ≥ 1 transparent
input.

## 6. Shielded pool

Note commitment `C = Rescue(N₀, N₁, v, r)`; commitments append (in
transaction order: spends' tx outputs, then per-transfer `c1`, `c2`) to a
depth-15 tree whose node hash is the Rescue merge and whose empty leaf is the
all-zero digest. Each block-end root is a valid **anchor**. Nullifiers are
revealed on spend and may never repeat.

Two proof statements (STARKs, winterfell 0.13, options pinned: 28 queries,
blowup 8, grinding 16, no field extension, FRI folding 8 / remainder 31,
linear batching; transcript hash Blake3-256):

- **Spend** (public `root, N, v, sighash`): knows `r`, position such that
  `Rescue(N₀,N₁,v,r)` ∈ tree(root). Used for z→t and public-value z→z.
- **Transfer** (public `root, N, C1, C2, fee, sighash`): knows
  `v, r, position, (N1′,v1,r1), (N2′,v2,r2)` with `C1 = Rescue(N1′,v1,r1)`,
  `C2 = Rescue(N2′,v2,r2)`, `Rescue(N,v,r)` ∈ tree(root), and
  `v = v1 + v2 + fee` in the field. Values stay private; the f128 modulus
  makes u64 wrap-around infeasible, so no range proof is needed for
  conservation.

Transfer memos (≤ 4096 bytes) are consensus-opaque. The wallet convention:
`ML-KEM-768 ct (1088) ‖ value XOR Blake2b("BlklNtEV", ss) (8) ‖
Blake2b("BlklNtTG", ss ‖ enc_v ‖ C1) (32)`, with note secrets derived as
`Blake2b("BlklNtN0"/"BlklNtN1"/"BlklNtRr", ss)`.

## 7. Contracts (Blockle VM)

Deploy cost `100 + 10·len` gas against the limit; contract id =
`blake2b_256("BlklCntr", txid)`. Calls execute at most `gas_limit` gas; on
return, staged storage writes, balance changes, and `SEND` payouts apply —
payout UTXOs mint under txid `blake2b_256("BlklPout", txid)`, vout = index.
On revert/trap/missing contract, state is untouched and attached value
refunds to the first input's address. Gas is prepaid via the fee (no refund);
blocks cap Σ gas_limit at 10,000,000. VM: 64-bit stack machine (stack ≤ 1024,
memory ≤ 64 KiB, storage values ≤ 1 KiB, return ≤ 8 KiB); opcodes and gas
schedule are normative as implemented in `crates/vm/src/lib.rs`. `ZKVERIFY`
verifies the Spend statement with public inputs
`root(32) ‖ N(32) ‖ v_le(8) ‖ binding(32)`.

## 8. P2P and stratum (non-consensus)

P2P: TCP, frames = `u32 len ‖ bincode(Message)`, ≤ 64 MiB; protocol version
2; headers-first sync with exponential locators; most-work adoption after
full revalidation; `GetAddr`/`Addr` discovery. Stratum: line-delimited
JSON-RPC, Zcash dialect; nonce = server nonce1(16) ‖ miner nonce2(16);
`version/ntime/nbits` hex of LE header bytes, hashes in internal byte order;
shares validated against per-client vardiff targets (never easier than
`pow_limit`, never harder than the block target).

## 9. Known deviations from production readiness

Storage is JSON; reorgs revalidate whole chains; the note tree holds 2^15
notes; bearer-note theft-by-sender is mitigated only by prompt re-sends;
stratum byte order is untested against physical ASIC firmware; the STARK
circuits and this implementation are unaudited.
