# Blockle Intelligence — a verifiable, demand-backed alternative to Bittensor

**Status:** DESIGN SPEC (v0.1) — for review. Nothing here is implemented yet. Every
consensus change ships and runs on **testnet** first and activates at a height; the
live mainnet consensus is never modified in place.

**Decisions locked (operator, this revision):**
1. **Consensus model:** a *height-activated* consensus upgrade. Additive new rules
   activate at height **H_INTEL**; all pre-H history stays valid forever (backwards
   compatible in the Bitcoin soft/hard-fork-at-a-height sense). Nodes upgrade before H.
2. **Economics:** a *single* token — **BLOCK** — whose block emission is **split
   across subnets** by consensus (Bittensor-classic shape, but demand-weighted; see §6).
3. **First deliverable:** this spec + the testnet plan (§11), before any protocol code.

---

## 1. Thesis — why this beats Bittensor

Bittensor pioneered "incentivized decentralized intelligence," but it has three
structural weaknesses. Blockle already owns the pieces to fix each.

| Bittensor weakness | Blockle fix | Already built? |
|---|---|---|
| **Validation is subjective & gameable** — validators score "intelligence" with no ground truth → weight-copying, collusion, emissions decoupled from quality | **Verifiable-task-first**: prioritize subnets whose outputs are objectively checkable; for subjective tasks use beacon-seeded blind spot-checks + redundancy, not pure peer opinion | partially (the beacon) |
| **Thin demand** — TAO emission is pure inflation; nobody has to *want* the output | **x402 real-demand backing**: paying customers submit tasks + USDC via the x402 rail; subnet emission is weighted by *real revenue*. Useful work becomes actually-paid-for work | yes — x402 rail + beacon/oracle live |
| **Validator collusion / weight-copying** — Yuma + commit-reveal mitigate but don't eliminate | **Proof-of-validation**: the PoW randomness beacon seeds unpredictable spot-check challenges validators must answer on demand; wrong/absent → slashed. A weight-copier can't answer fresh challenges | yes — verifiable PoW beacon live |

Two more structural advantages Blockle starts with:
- **Security budget already exists.** Multi-algo merge-mined PoW already secures the
  ledger that will record registrations, stake, weights and emissions. No new security
  to bootstrap (Bittensor had to bootstrap its own).
- **Markets infrastructure already exists.** BLOCK-20 tokens, the launchpad and the
  native AMM mean per-subnet instruments, staking UIs and liquidity are mostly built
  if/when we want them — but per the locked decision, v1 uses single-token BLOCK.

**One-line positioning:** *Bittensor pays for claimed intelligence with inflation;
Blockle pays for verifiable, paid-for intelligence with a security budget it already
has.*

---

## 2. Roles & objects

- **Subnet** — a market for one task type (e.g., `embeddings`, `det-compute`,
  `retrieval-qa`, `image-gen`). Has a **task schema**, a **verification tier** (§4),
  and an **emission share** (§6).
- **Neuron** — a registered participant with a stake bond and a hotkey. Two roles:
  - **Miner** — produces task outputs.
  - **Validator** — issues challenges, scores miners, submits a weight vector, and
    must pass **proof-of-validation** (§5.3).
- **Root** — the subnet-of-subnets that sets each subnet's emission share (§6).
- **Client** — a paying user (human or agent) who submits tasks + USDC over x402.
  Client acceptance is an *organic validation signal* (§7).

All of the above live in on-chain state introduced by the upgrade (§3).

---

## 3. The consensus upgrade (height-activated, backwards compatible)

### 3.1 Activation
- **Testnet activation height: `H_INTEL_TESTNET = 18888`** (operator-set). As of writing
  the tip is ~16,970, so this is ~1,918 blocks ≈ **8 days** out — a good target to first
  exercise the new consensus rules **on testnet**.
- **Mainnet activation height: TBD, audit-gated.** Set only after Phases 1–5 (§11)
  complete — 8 days is far too little to simulate, run on testnet, ship a reference
  subnet, and audit the incentive + `α`-budget math. Activating an unbuilt consensus
  change on mainnet would be reckless; mainnet H is chosen at Phase 5 with ≥ 4 weeks'
  node-upgrade lead. (If the operator intends 18888 for *mainnet*, that needs an explicit
  override — this spec treats it as the testnet target.)
- **Backwards compatibility guarantees:**
  - Every block and transaction valid before H stays valid forever. No historical
    reinterpretation, no reorg.
  - The new rules are **additive**: they introduce new *action types* and new *state*,
    and change exactly **one** existing rule — the coinbase emission split (§3.4) —
    and only for blocks at height ≥ H.
  - Nodes signal readiness via a version bit in the block header `version` field
    (same mechanism already used for the AuxPoW height-80000 fork). Activation is
    gated on a supermajority of recent blocks signaling, then locks in, then activates
    — BIP9-style — so a non-upgraded miner can't accidentally split the chain.
  - A non-upgraded node after activation will see new action types as invalid and stop
    following the tip — i.e., upgrading is mandatory, exactly like any height fork. This
    is "backwards compatible" in the sense required: **old data is never invalidated**
    and the upgrade path is coordinated and non-destructive.

### 3.2 New actions (atomic, VM-level — mirrors LaunchToken/Stablecoin actions)
| Action | Who | Effect |
|---|---|---|
| `SubnetRegister{schema, tier, hyperparams}` | anyone (burns a registration fee) | creates a subnet; fee rises with active subnet count (anti-spam) |
| `NeuronRegister{subnetId, role, hotkey, bond}` | anyone | registers a miner/validator; locks a **stake bond** (anti-sybil); emits a UID |
| `SetWeightsCommit{subnetId, H(weights‖nonce)}` | validator | commits a weight-vector hash for the epoch |
| `SetWeightsReveal{subnetId, weights, nonce}` | validator | reveals the committed weights next epoch |
| `ValidationProof{subnetId, beaconRound, answers, sig}` | validator | proof-of-validation over beacon-seeded spot-checks (§5.3) |
| `EmissionEpoch{subnetId}` | deterministic (any node computes identically) | runs the incentive mechanism (§5) and credits the epoch's BLOCK emission to neurons |
| `Deregister / Unbond` | neuron | exit + bond return after an unbonding delay |

All are **deterministic** given chain state + the beacon, so every node computes the
same emission ledger — no off-chain trust.

### 3.3 New state
- **Subnet registry**: `subnetId → {schema, tier, hyperparams, emissionShare}`.
- **Neuron registry**: `(subnetId, uid) → {role, hotkey, bondStake, trust, rank,
  incentive, dividends, lastUpdate}`.
- **Weight matrix** per subnet (commit-reveal), **bonds** (EMA), and the **emission
  ledger**. State is Merkleized; its root is committed in the block header (so light
  clients and the anchored-layer fallback can verify it).

### 3.4 The one changed existing rule — emission split
At height ≥ H, the block subsidy (currently 50 BLOCK, Bitcoin-style halvings) is split:

```
miner_subsidy      = (1 − α) · block_subsidy      # paid to the PoW miner as today
intelligence_pool  =   α     · block_subsidy      # distributed by §5/§6 this epoch
```

- `α` starts **small and ramps** (e.g. 0.10 → target 0.40 over the first halving era),
  governed by the Root mechanism within a hard cap, so PoW security is never starved.
  This is the central tension and is called out as an open problem (§10).
- The supply schedule (210k premine, 50/block, 210k-block halvings, fixed cap) is
  **unchanged** — we *redirect* part of each block's existing subsidy, we do **not**
  mint extra. (Alternative inflationary models were rejected to preserve BLOCK's
  Bitcoin-style scarcity.)
- Before H: 100% to the miner, exactly as today.

---

## 4. Verifiability tiers (the core differentiator)

Every subnet declares a tier; scoring rigor and anti-gaming strength follow from it.

- **Tier 0 — Deterministic / checkable.** Output correctness is a pure function of the
  input (e.g. deterministic compute, hash puzzles, proof verification, constraint
  solving, retrieval against a committed corpus, structured output validated by a test
  oracle). Score ∈ {0,1} (or a graded objective metric). **No subjective judgment.**
  Weights are *derived from* objective scores, not from validator opinion.
- **Tier 1 — Redundant / reference-checkable.** No single checker, but correctness is
  verifiable by *redundancy* (k independent miners; majority/agreement) or a hidden
  **reference solution** revealed after the epoch. Validators are scored on agreement
  with the revealed reference.
- **Tier 2 — Subjective (LLM/image quality).** No ground truth. Uses beacon-seeded
  blind spot-checks + reference validators + the clipping consensus (§5) to bound
  collusion. **Explicitly the weakest tier** — flagged as such; emission share for
  Tier-2 subnets is capped lower than Tier-0/1 until better verification exists (ZKML,
  TEE attestation — §10). We do **not** pretend Tier-2 output is verifiable.

> This tiering is the honest heart of the design. Bittensor treats everything like
> Tier 2. Blockle pushes value toward Tier 0/1, where "useful work" is *provably* done.

---

## 5. Incentive mechanism ("Yuma, improved")

Per subnet, per epoch (e.g. 360 blocks):

### 5.1 Base: stake-weighted, clipped consensus (Yuma-style anti-collusion)
Let `S_i` = validator i's stake, `W_ij` ∈ [0,1] = i's weight on miner j (revealed).
- **Consensus clip** `Ĉ_j`: the largest value such that stake holding `W_ij ≥ Ĉ_j`
  is ≥ κ (e.g. κ = 0.5 of stake). Clip `W̄_ij = min(W_ij, Ĉ_j)`. A minority of
  validators therefore **cannot inflate** a miner above the stake-weighted median.
- **Rank** `R_j = Σ_i S_i · W̄_ij`; **Trust** `T_j = Σ_i S_i · 1[W_ij>0]`;
  **Incentive** `I_j = R_j / Σ_k R_k` (miner reward share).
- **Bonds** `B_ij = λ·B_ij^{prev} + (1−λ)·S_i·W̄_ij` (EMA); **Dividends**
  `D_i = Σ_j B_ij · I_j` (validator reward — rewards validators who bonded *early* to
  miners the consensus later agrees are good → pays real discovery, punishes copying).
- Emission split within a subnet: miners get `Σ I`, validators get `Σ D` (e.g. 50/50,
  hyperparam).

### 5.2 Blockle improvement — objective scores feed weights
For Tier-0/1 subnets, a validator's weight `W_ij` is **derived from objective scores**
`V_ij` (the fraction of beacon-seeded checkable challenges miner j passed for validator
i), not free opinion. A validator that reports weights diverging from its own verifiable
`V_ij` is provably dishonest (§5.3). This collapses most of the subjective attack surface.

### 5.3 Blockle improvement — proof-of-validation (kills weight-copying)
Each epoch the **beacon** (`/api/beacon`, already live) produces a public random round
`r_e`. It deterministically selects, per validator, a **spot-check set** of (miner,
input) pairs the validator must have actually evaluated. The validator submits a
`ValidationProof{beaconRound:r_e, answers, sig}`.
- Tier-0/1: answers are checked against ground truth/reference. Wrong or missing →
  the validator's weights are **ignored this epoch and a slice of its bond is slashed**.
- Tier-2: answers must fall within the robust consensus band; persistent outliers decay.
- Because `r_e` is unpredictable until the epoch and PoW-fixed afterward, a validator
  that merely **copies** another's revealed weights cannot produce correct spot-check
  answers → copying stops being profitable. This is the key anti-collusion upgrade.

### 5.4 Commit-reveal weights
`SetWeightsCommit` in epoch e, `SetWeightsReveal` in e+1 — validators can't see each
other's weights before committing, so intra-epoch copying is impossible. Beacon round
orders the reveal processing.

---

## 6. Emission across subnets (demand-weighted Root)

The `α` pool is split across subnets by an **emission share** per subnet, set each
epoch by the Root mechanism as a blend:

```
share(subnet) ∝  w_rev · normalizedRevenue(subnet)     # real x402 USDC the subnet earned
               + w_stk · rootStakeWeight(subnet)        # stake-weighted validator vote
               + w_flr · floor                          # small equal floor (bootstrapping)
```

- **`normalizedRevenue`** is the subnet's realized x402 task revenue over a trailing
  window (demand-driven — emissions follow *paid* usage). **This is the differentiator:
  Bittensor's root vote is pure politics; Blockle anchors it to real money.**
- `rootStakeWeight` is the clipped, stake-weighted vote of root validators (Yuma on the
  root) — keeps governance decentralized.
- Weights `w_rev, w_stk, w_flr` are Root hyperparams (start revenue-light while demand
  bootstraps, ramp `w_rev` up).

---

## 7. x402 demand integration

- Clients submit tasks + USDC over x402 (`/api/intel/<subnet>/task`, same rail as the
  beacon/exchange). Payment is escrowed; released to the serving miner(s) on accepted
  output (or refunded on timeout/failure).
- **Organic validation:** a client's accept/reject is a high-value, Sybil-resistant
  signal (they paid). Client acceptance feeds `V_ij` with elevated weight and feeds
  `normalizedRevenue` (§6). Paying users become the most trusted validators of all.
- Miners thus earn **twice**: x402 fees now + BLOCK emission for being consistently
  good — aligning emission with genuine demand.

---

## 8. Anti-gaming summary

| Attack | Defense |
|---|---|
| Validator weight-copying | proof-of-validation over beacon-seeded spot-checks + slashing (§5.3); commit-reveal (§5.4) |
| Minority weight inflation | stake-weighted median clipping (§5.1) |
| Sybil neurons | stake bond + rising registration fee; emission ∝ stake·performance |
| Lazy/offline validators | must submit `ValidationProof` each epoch or earn nothing + decay |
| Self-weighting / miner-validator collusion | self-weights ignored; bonds reward *early agreement with later consensus*, not self-dealing |
| Fake demand (wash x402) | revenue counts only from distinct, fee-paying clients net of refunds; wash trading costs real USDC + gas and is rate/identity-screened |
| Tier-2 ungameable-claims | Tier-2 emission share capped; outputs never labeled "verified" |

---

## 9. Backwards compatibility — precise statement

- **Pre-H:** zero change. All historical blocks, txs, balances, PoW, AuxPoW stay valid.
- **At/after H:** one existing rule changes (coinbase split, §3.4) + new action types +
  new Merkleized state. Activation is version-bit signaled + locked in (BIP9-style) so
  no accidental split.
- **Non-upgraded nodes:** follow the chain normally until H; after activation they must
  upgrade (they'd reject new actions) — a *coordinated, announced* upgrade, never a
  silent reinterpretation of old data.
- **SPV / light clients:** the intelligence state root in the header lets them verify
  emissions without full validation.

---

## 10. Open problems & honest risks

1. **PoW-vs-intelligence budget tension.** Redirecting `α` of the subsidy reduces PoW
   pay → could reduce hashrate/security. Mitigation: `α` ramps slowly under a hard cap;
   monitored against hashrate; Root-governed. **This is the single biggest risk and must
   be modeled before mainnet.**
2. **Tier-2 verification is unsolved.** Subjective quality isn't cryptographically
   checkable today (our own inference tests showed CPU LLM output isn't bit-reproducible).
   Tier-2 relies on redundancy + spot-checks + capped emission — honest but imperfect.
   Real fixes (ZKML for tiny models, TEE attestation) are future work, not claimed now.
3. **Validator stake centralization.** Clipping + proof-of-validation blunt it but don't
   remove it; cap per-validator emission share and consider quadratic-ish dampening.
4. **Challenge design is the hard part.** A subnet is only as good as its verifiable
   challenge generator. Tier-0 subnets must ship a strong, un-memorizable task generator.
5. **Beacon liveness dependency.** Proof-of-validation needs the beacon each epoch; the
   beacon is PoW-derived and already live, but its liveness becomes consensus-critical —
   fold its derivation into the node itself (not an external service) before mainnet.

---

## 11. Rollout plan (testnet-first)

- **Phase 0 (this doc).** Spec + incentive math + activation design. ✅
- **Phase 1 — simulation.** Implement the §5 incentive mechanism as a pure, testable
  module + an agent-based simulator (honest/colluding/lazy validators, good/bad miners);
  verify anti-collusion + budget behavior *before* any chain code. Deliverable: numbers.
- **Phase 2 — testnet consensus (target height `H_INTEL_TESTNET = 18888`).** Add the §3
  actions + state + height activation to a **testnet** node (the node already supports
  height forks + atomic VM actions). Fold beacon derivation in-node. Run `EmissionEpoch`
  deterministically across ≥ 3 testnet nodes. Phase 1 simulation must pass **before** this.
- **Phase 3 — reference subnet (Tier 0).** One fully verifiable subnet end-to-end
  (e.g. deterministic-compute or retrieval-QA): reference miner + validator + x402 task
  intake + organic acceptance. Prove the full loop pays the right neurons on testnet.
- **Phase 4 — neuron SDK + UX.** `blockle-neuron` CLI (register/mine/validate), subnet
  dashboards in the explorer + wallets, docs.
- **Phase 5 — audit + mainnet activation vote.** Independent review of the incentive
  math + the `α` budget model; set `H_INTEL`; version-bit signaling; activate.

Each phase gates the next; nothing touches mainnet consensus until Phase 5.

---

## 12. Naming / surface
- Protocol: **Blockle Intelligence** (working name).
- Public: `blockle.org/intelligence` (explorer subnet pages), `/api/intel/*` (task +
  x402 intake), `blockle-neuron` CLI.
- Reuses: the PoW **beacon** (randomness/spot-checks), the **x402 rail** (demand), the
  **node's** height-fork + atomic-action machinery (consensus), **PoW** (security).
