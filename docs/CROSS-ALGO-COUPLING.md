# Cross-Algorithm Difficulty Coupling (energy-weighted)

**Status:** scheduled consensus change — activates at **mainnet block 53,000**
(`ChainParams::cross_algo_activation_height`). Below this height nothing changes;
at and above it the rules in this document are enforced. Every mainnet node and
miner MUST run a binary that contains this rule before height 53,000 or it will
fork off the network.

## The problem

Blockle is merge-mined across **10 lanes**: its native Equihash plus the eight
fixed-header ASIC algorithms (`sha256d`, `scrypt`, `x11`, `blake2b`, `blake2s`,
`blake3`, `eaglesong`, `kheavyhash`) and parent-chain `equihash`. Until block
53,000 each lane retargets **independently** (per-lane LWMA at
`target_spacing × lane_count`). Independent retargeting drives every lane to the
**same block share** — roughly one tenth of blocks each — *regardless of how much
real energy backs it*.

That is a fairness and security problem. A lane mined by an ultra-efficient
SHA-256 ASIC (≈1.75e-11 J/hash) earns the same reward as a lane mined by
power-hungry hardware (native Equihash on CPUs is ~11 orders of magnitude less
efficient per attempt). Reward should follow the real work — the **energy** —
not the raw hash count, and chain security should be the total energy an attacker
must out-spend, not the total hashes.

## The rule

At/above the activation height all lanes are retargeted from **one shared base
difficulty**, scaled per-lane by a benchmark-derived **energy-per-hash
coefficient** `w_lane` (see `blockle_pow::energy_coeff`, fixed-point ×1e6,
normalised so the median lane = 1.0).

Let `T0` be the shared base target. A lane's required target is:

```
target_lane = T0 · w_lane / SCALE          (denormalize_target)
```

`T0` itself is an LWMA over the most recent `lwma_window` blocks **across all
lanes**, at the whole-chain `target_spacing`, where each historical block's
target is first brought into the shared frame by dividing out its own
coefficient:

```
normalized(block) = target_block · SCALE / w_lane(block)      (normalize_target)
T0 = LWMA_window( normalized(recent blocks), whole-chain spacing )
```

Because `target ∝ 1/work`, a lane with a **small** `w` (cheap energy) gets a
**tighter** target — it must grind proportionally **more** hashes to find a
block — while a lane with a **large** `w` (expensive energy) gets an easier one.
At equilibrium every lane expends the **same real energy per block**, so block
production (and therefore reward and security weight) is proportional to each
lane's share of total network **power draw**, exactly as intended.

### Fork choice

`Chain::total_work` is the fork-choice metric. From the activation height each
block contributes **energy-weighted** work:

```
energy_work(block) = block_work(bits) · w_lane / SCALE
```

so the heaviest chain is the one backed by the most real power, and an efficient
lane can no longer accumulate chain-work cheaply. Pre-fork blocks keep counting
at their raw `block_work`, so history is unchanged.

### Quiet-lane decay is preserved

The existing quiet-lane difficulty decay still applies **on top of** the coupled
base target, so an abandoned lane still eases over time and the chain cannot
stall.

## The energy coefficients

`w_lane` is measured energy-per-hash on the **best production hardware** for each
algorithm (watts ÷ hashrate), normalised by the median of the ten lanes
(≈ 3.23e-9 J/hash) and stored ×1e6.

| lane        | hardware basis            | ~J/hash  | coeff (×1e-6) | coeff (int) |
|-------------|---------------------------|----------|---------------|-------------|
| sha256d     | SHA-256 ASIC (S21-class)  | 1.75e-11 | 0.00542       | 5,420 |
| eaglesong   | CKB ASIC (K7-class)       | 1.5e-10  | 0.04644       | 46,440 |
| kheavyhash  | Kaspa ASIC (KS5-class)    | 1.7e-10  | 0.05263       | 52,630 |
| blake2b     | Sia/Blake2b ASIC          | 1.5e-9   | 0.4644        | 464,400 |
| blake2s     | Blake2s ASIC              | 1.5e-9   | 0.4644        | 464,400 |
| x11         | X11 ASIC (X7-class)       | 4.96e-9  | 1.5356        | 1,535,600 |
| blake3      | Blake3 GPU / early ASIC   | 1.0e-7   | 30.96         | 30,960,000 |
| scrypt      | Scrypt ASIC (L7-class)    | 3.6e-7   | 111.46        | 111,460,000 |
| equihash    | Equihash ASIC (Z15-class) | 3.6e-3   | 1.1146e6      | 1,114,600,000,000 |
| native      | Blockle Equihash (CPU)    | 3.3e0    | 1.0217e9      | 1,021,700,000,000,000 |

These are order-of-magnitude benchmark figures, not a live feed — they are a
fixed consensus constant (all nodes must agree bit-for-bit). They can be revised
only by a future height-gated change. Unknown/future lanes fall back to the
median (1.0) rather than a privileged weight.

## Where it lives

- `crates/pow/src/lib.rs` — `energy_coeff`, `ENERGY_COEFF_SCALE`.
- `crates/pow/src/difficulty.rs` — `normalize_target`, `denormalize_target`,
  `energy_work`, `lwma_coupled_next_bits` (+ unit tests).
- `crates/chain/src/params.rs` — `cross_algo_activation_height` (mainnet 53,000).
- `crates/chain/src/chain.rs` — `next_bits_coupled`, the gate inside
  `next_bits_for_at`, and energy-weighted `total_work`.
- `crates/chain/tests/cross_algo_integration.rs` — the height-gate + enforcement
  test.

## Operator action

See the fork-countdown notice on the site. In short: **node operators** and
**pool/miner operators** must upgrade to a build containing this rule before
block 53,000; **wallet users** should update to the matching wallet release. No
address, key, or balance changes — this is a difficulty/fork-choice rule only.
