# Blockle Intelligence — testnet rollout & activation runbook

Companion to `BLOCKLE-INTELLIGENCE.md`. This is the operational checklist to take the
protocol from "code-complete + tested" to "live on testnet" and eventually "activated on
mainnet". **Mainnet consensus is never changed without the Phase-5 audit.**

## Implementation status (what's built)

| Layer | Status |
|---|---|
| Spec + incentive math | ✅ `BLOCKLE-INTELLIGENCE.md`, `scripts/intel_sim.py` |
| Deterministic EmissionEpoch (fixed-point, no floats) | ✅ `chain/crates/chain/src/intel_consensus.rs` |
| Consensus actions: SubnetRegister, NeuronRegister | ✅ (Phase 2a) |
| SetWeights commit/reveal, ValidationProof, NeuronClaim | ✅ (Phase 2b / 2b-ii) |
| Coinbase α-split + EmissionEpoch + in-node beacon | ✅ (Phase 2b) |
| Proof-of-validation liveness + slashing + stake-weighted split | ✅ (Phase 2b-ii) |
| Height gate (`intel_activation_height`) — mainnet DISABLED (u64::MAX) | ✅ |
| Node RPC (`/explorer/intel*`) | ✅ |
| `blockle intel` CLI (register/mine/validate/claim/status) | ✅ |
| Explorer page `blockle.org/intelligence` | ✅ (lights up when a node serves the RPC) |
| **Remaining — operator/time-gated:** | |
| Testnet node deploy + activation at a low test height | ⏳ |
| Reference Tier-0 subnet + off-chain serving/validator daemon | ⏳ |
| Wallet "Earnings/Intelligence" tabs (web/ext/Flutter/Qt) | ⏳ |
| Correctness-slashing (on-chain-verifiable tasks / dispute game) | ⏳ (2c) |
| Cross-epoch commit-reveal + x402-revenue demand-weighting | ⏳ |
| Independent audit of incentive + α-budget | ⏳ (Phase 5 gate) |

## A. Bring up a dedicated TESTNET node (never the mainnet node)
Build the node from `main` and run a SEPARATE testnet instance (own datadir/ports). To
exercise intel quickly, temporarily set a LOW activation height in `ChainParams::testnet()`
(e.g. `intel_activation_height: 4`) on a throwaway dev-testnet branch — DO NOT ship a low
height to the real testnet/mainnet params.

```
# on the box, a separate datadir + ports (do not touch /opt/blockle mainnet node)
blockle-chain --network testnet --datadir /opt/blockle/intel-testnet start \
  --listen 0.0.0.0:28444 --aux-http 127.0.0.1:28445 --mine --address <testaddr>
```
Mine past the activation height, then confirm the α-split: the coinbase should pay
`(1-α)·subsidy + fees` and `/explorer/intel` should report a growing `pool`.

## B. End-to-end smoke (CLI against the testnet node)
```
blockle-chain --network testnet --datadir <dir> intel register-subnet --tier 0
blockle-chain ... intel register-neuron --subnet 0 --role miner --bond 1
blockle-chain ... intel register-neuron --subnet 0 --role validator --bond 10
blockle-chain ... intel commit-weights --subnet 0 --weights 0:1000000
# (next epoch) reveal + prove liveness
blockle-chain ... intel reveal-weights --subnet 0
blockle-chain ... intel validate --subnet 0
# after the epoch boundary
blockle-chain ... intel status      # claimable > 0
blockle-chain ... intel claim
```
Point the explorer page at the testnet node (`BEACON_EXPLORER`/nginx) and confirm the subnet
+ neurons + pool render, and the earnings lookup shows the claim.

## C. Reference Tier-0 subnet (Phase 3 completion)
Build a small off-chain `blockle-neuron` daemon that: serves a deterministic, checkable task
(e.g. a hash-preimage or structured-retrieval task), and a validator loop that scores miners
on beacon-selected challenges and drives commit→reveal→validate automatically. This is where
*correctness* (not just liveness) scoring becomes real — and the honest answer to "useful
work": the task is verifiable, so emission tracks provably-correct output.

## D. Mainnet activation (Phase 5 — audit-gated)
1. Independent review of the incentive math + the `α`-budget-vs-hashrate model.
2. Choose `H_INTEL_MAINNET` with ≥ 4 weeks' node-upgrade lead; set it in `ChainParams::mainnet()`.
3. Version-bit (BIP9-style) signaling + lock-in before activation (so no accidental split).
4. Announce; ship the node release; monitor hashrate vs α after activation; be ready to
   lower α via governance if PoW security dips.

**Rollback:** until mainnet H is set, `intel_activation_height = u64::MAX` keeps every intel
rule inert on mainnet — the consensus code ships dormant and changes nothing.
