//! The shielded spend circuit: a STARK proving, for public inputs
//! `(root, nullifier N, value v, sighash)`, knowledge of a private blinding
//! `r` and a private Merkle position such that
//! `commitment = Rescue(N0, N1, v, r)` is a leaf of the note tree with the
//! given root.
//!
//! The nullifier is bound *inside* the commitment, so spending the same note
//! twice must reveal the same `N` (caught by the chain's nullifier set), and
//! spending with a different `N` requires a Rescue second preimage. The
//! transaction sighash rides in the public inputs: it is absorbed into the
//! Fiat–Shamir transcript, binding each proof to exactly one transaction.
//!
//! The AIR is adapted from winterfell's Merkle membership example
//! (MIT licensed, Copyright (c) Facebook, Inc. and its affiliates): trace of
//! 7 columns — a 6-element Rescue state plus a path-bit column — in 8-step
//! hash cycles. Cycle 0 computes the commitment from `[N0, N1, v, r]`;
//! cycles 1..=DEPTH hash up the tree, with the bit column choosing the
//! left/right placement of the accumulated digest.

use winterfell::{
    crypto::{DefaultRandomCoin, MerkleTree},
    math::{fields::f128::BaseElement, FieldElement, ToElements},
    matrix::ColMatrix,
    AcceptableOptions, Air, AirContext, Assertion, AuxRandElements, BatchingMethod,
    CompositionPoly, CompositionPolyTrace, ConstraintCompositionCoefficients,
    DefaultConstraintCommitment, DefaultConstraintEvaluator, DefaultTraceLde, EvaluationFrame,
    FieldExtension, PartitionOptions, Proof, ProofOptions, Prover, StarkDomain, Trace, TraceInfo,
    TracePolyTable, TraceTable, TransitionConstraintDegree,
};

use crate::rescue::{
    self, Hash, CYCLE_LENGTH as HASH_CYCLE_LEN, NUM_ROUNDS as NUM_HASH_ROUNDS,
    STATE_WIDTH as HASH_STATE_WIDTH,
};
use crate::utils::{are_equal, is_binary, is_zero, not, EvaluationResult};
use crate::ZkError;

/// Depth of the note commitment tree. `DEPTH + 1` must be a power of two
/// (hash cycles: 1 leaf cycle + DEPTH path cycles).
pub const TREE_DEPTH: usize = 15;

const TRACE_WIDTH: usize = 7;

/// Fiat–Shamir / commitment hasher for the STARK itself (hash-based → the
/// proof system stays post-quantum-aligned).
type H = winterfell::crypto::hashers::Blake3_256<BaseElement>;

/// Pinned proof parameters. Verification rejects proofs generated with any
/// other options, so these are consensus-critical.
pub fn proof_options() -> ProofOptions {
    ProofOptions::new(
        28, // queries
        8,  // blowup
        16, // grinding bits
        FieldExtension::None,
        8,  // FRI folding factor
        31, // FRI max remainder degree
        BatchingMethod::Linear,
        BatchingMethod::Linear,
    )
}

// PUBLIC INPUTS
// ================================================================================================

#[derive(Clone, Debug)]
pub struct SpendPublicInputs {
    pub tree_root: [BaseElement; 2],
    pub nullifier: [BaseElement; 2],
    pub value: BaseElement,
    /// Transaction sighash (reduced to field elements). Not constrained by
    /// the AIR — binding comes from the Fiat–Shamir transcript.
    pub sighash: [BaseElement; 2],
}

impl ToElements<BaseElement> for SpendPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.tree_root[0],
            self.tree_root[1],
            self.nullifier[0],
            self.nullifier[1],
            self.value,
            self.sighash[0],
            self.sighash[1],
        ]
    }
}

// AIR
// ================================================================================================

pub struct SpendAir {
    context: AirContext<BaseElement>,
    tree_root: [BaseElement; 2],
    nullifier: [BaseElement; 2],
    value: BaseElement,
}

impl Air for SpendAir {
    type BaseField = BaseElement;
    type PublicInputs = SpendPublicInputs;

    fn new(trace_info: TraceInfo, pub_inputs: SpendPublicInputs, options: ProofOptions) -> Self {
        let degrees = vec![
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            TransitionConstraintDegree::new(2),
        ];
        assert_eq!(TRACE_WIDTH, trace_info.width());
        SpendAir {
            context: AirContext::new(trace_info, degrees, 7, options),
            tree_root: pub_inputs.tree_root,
            nullifier: pub_inputs.nullifier,
            value: pub_inputs.value,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn evaluate_transition<E: FieldElement + From<Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        periodic_values: &[E],
        result: &mut [E],
    ) {
        let current = frame.current();
        let next = frame.next();
        debug_assert_eq!(TRACE_WIDTH, current.len());
        debug_assert_eq!(TRACE_WIDTH, next.len());

        // split periodic values into the hash-cycle mask and Rescue round constants
        let hash_flag = periodic_values[0];
        let ark = &periodic_values[1..];

        // hash_flag = 1: enforce a Rescue round on the state columns
        rescue::enforce_round(
            result,
            &current[..HASH_STATE_WIDTH],
            &next[..HASH_STATE_WIDTH],
            ark,
            hash_flag,
        );

        // hash_flag = 0 (cycle boundary): the accumulated digest moves into
        // registers [0,1] (path bit 0) or [2,3] (path bit 1) for the next
        // merge, and the capacity registers reset to zero.
        let hash_init_flag = not(hash_flag);
        let bit = next[6];
        let not_bit = not(bit);
        result.agg_constraint(0, hash_init_flag, not_bit * are_equal(current[0], next[0]));
        result.agg_constraint(1, hash_init_flag, not_bit * are_equal(current[1], next[1]));
        result.agg_constraint(2, hash_init_flag, bit * are_equal(current[0], next[2]));
        result.agg_constraint(3, hash_init_flag, bit * are_equal(current[1], next[3]));
        result.agg_constraint(4, hash_init_flag, is_zero(next[4]));
        result.agg_constraint(5, hash_init_flag, is_zero(next[5]));

        // the path-bit register must stay binary
        result[6] = is_binary(current[6]);
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        // Step 0 pins the public parts of the commitment preimage
        // (nullifier, value); the blinding in register 3 stays private.
        // The last step pins the tree root; capacity registers are zero at
        // the start of every hash cycle.
        let last_step = self.trace_length() - 1;
        vec![
            Assertion::single(0, 0, self.nullifier[0]),
            Assertion::single(1, 0, self.nullifier[1]),
            Assertion::single(2, 0, self.value),
            Assertion::single(0, last_step, self.tree_root[0]),
            Assertion::single(1, last_step, self.tree_root[1]),
            Assertion::periodic(4, 0, HASH_CYCLE_LEN, BaseElement::ZERO),
            Assertion::periodic(5, 0, HASH_CYCLE_LEN, BaseElement::ZERO),
        ]
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<Self::BaseField>> {
        let mut result = vec![HASH_CYCLE_MASK.to_vec()];
        result.append(&mut rescue::get_round_constants());
        result
    }
}

const HASH_CYCLE_MASK: [BaseElement; HASH_CYCLE_LEN] = [
    BaseElement::ONE,
    BaseElement::ONE,
    BaseElement::ONE,
    BaseElement::ONE,
    BaseElement::ONE,
    BaseElement::ONE,
    BaseElement::ONE,
    BaseElement::ZERO,
];

// PROVER
// ================================================================================================

struct SpendProver {
    options: ProofOptions,
    sighash: [BaseElement; 2],
}

impl SpendProver {
    /// Build the execution trace. `branch[0]` is the leaf (recomputed in the
    /// trace from the preimage); `branch[1..]` are the path siblings.
    fn build_trace(
        &self,
        preimage: [BaseElement; 4],
        branch: &[Hash],
        index: usize,
    ) -> TraceTable<BaseElement> {
        let trace_length = branch.len() * HASH_CYCLE_LEN;
        let mut trace = TraceTable::new(TRACE_WIDTH, trace_length);
        let siblings = &branch[1..];

        trace.fill(
            |state| {
                state[0] = preimage[0];
                state[1] = preimage[1];
                state[2] = preimage[2];
                state[3] = preimage[3];
                state[4] = BaseElement::ZERO;
                state[5] = BaseElement::ZERO;
                state[6] = BaseElement::ZERO;
            },
            |step, state| {
                let cycle_num = step / HASH_CYCLE_LEN;
                let cycle_pos = step % HASH_CYCLE_LEN;
                if cycle_pos < NUM_HASH_ROUNDS {
                    rescue::apply_round(&mut state[..HASH_STATE_WIDTH], step);
                } else {
                    let branch_node = siblings[cycle_num].to_elements();
                    let index_bit = BaseElement::new(((index >> cycle_num) & 1) as u128);
                    if index_bit == BaseElement::ZERO {
                        state[2] = branch_node[0];
                        state[3] = branch_node[1];
                    } else {
                        state[2] = state[0];
                        state[3] = state[1];
                        state[0] = branch_node[0];
                        state[1] = branch_node[1];
                    }
                    state[4] = BaseElement::ZERO;
                    state[5] = BaseElement::ZERO;
                    state[6] = index_bit;
                }
            },
        );

        // keep the bit-register constraint degree stable (see upstream example)
        trace.set(6, 1, FieldElement::ONE);
        trace
    }
}

impl Prover for SpendProver {
    type BaseField = BaseElement;
    type Air = SpendAir;
    type Trace = TraceTable<BaseElement>;
    type HashFn = H;
    type VC = MerkleTree<H>;
    type RandomCoin = DefaultRandomCoin<H>;
    type TraceLde<E: FieldElement<BaseField = Self::BaseField>> =
        DefaultTraceLde<E, Self::HashFn, Self::VC>;
    type ConstraintCommitment<E: FieldElement<BaseField = Self::BaseField>> =
        DefaultConstraintCommitment<E, H, Self::VC>;
    type ConstraintEvaluator<'a, E: FieldElement<BaseField = Self::BaseField>> =
        DefaultConstraintEvaluator<'a, Self::Air, E>;

    fn get_pub_inputs(&self, trace: &Self::Trace) -> SpendPublicInputs {
        let last_step = trace.length() - 1;
        SpendPublicInputs {
            tree_root: [trace.get(0, last_step), trace.get(1, last_step)],
            nullifier: [trace.get(0, 0), trace.get(1, 0)],
            value: trace.get(2, 0),
            sighash: self.sighash,
        }
    }

    fn options(&self) -> &ProofOptions {
        &self.options
    }

    fn new_trace_lde<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        trace_info: &TraceInfo,
        main_trace: &ColMatrix<Self::BaseField>,
        domain: &StarkDomain<Self::BaseField>,
        partition_option: PartitionOptions,
    ) -> (Self::TraceLde<E>, TracePolyTable<E>) {
        DefaultTraceLde::new(trace_info, main_trace, domain, partition_option)
    }

    fn new_evaluator<'a, E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        air: &'a Self::Air,
        aux_rand_elements: Option<AuxRandElements<E>>,
        composition_coefficients: ConstraintCompositionCoefficients<E>,
    ) -> Self::ConstraintEvaluator<'a, E> {
        DefaultConstraintEvaluator::new(air, aux_rand_elements, composition_coefficients)
    }

    fn build_constraint_commitment<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        composition_poly_trace: CompositionPolyTrace<E>,
        num_constraint_composition_columns: usize,
        domain: &StarkDomain<Self::BaseField>,
        partition_options: PartitionOptions,
    ) -> (Self::ConstraintCommitment<E>, CompositionPoly<E>) {
        DefaultConstraintCommitment::new(
            composition_poly_trace,
            num_constraint_composition_columns,
            domain,
            partition_options,
        )
    }
}

// PUBLIC API
// ================================================================================================

/// Generate a spend proof.
///
/// `branch[0]` must be the leaf commitment `Rescue(N0, N1, v, r)`;
/// `branch[1..]` the `TREE_DEPTH` path siblings bottom-up; `index` the leaf
/// position. Returns the serialized proof.
pub fn prove_spend(
    nullifier: [BaseElement; 2],
    value: BaseElement,
    blinding: BaseElement,
    branch: Vec<Hash>,
    index: usize,
    sighash: [BaseElement; 2],
) -> Result<Vec<u8>, ZkError> {
    if branch.len() != TREE_DEPTH + 1 {
        return Err(ZkError::BadWitness("wrong branch length".into()));
    }
    let prover = SpendProver { options: proof_options(), sighash };
    let trace = prover.build_trace([nullifier[0], nullifier[1], value, blinding], &branch, index);
    let proof = prover.prove(trace).map_err(|e| ZkError::Prover(e.to_string()))?;
    Ok(proof.to_bytes())
}

/// Verify a spend proof against the public inputs. Proof parameters are
/// pinned to [`proof_options`].
pub fn verify_spend(
    proof_bytes: &[u8],
    tree_root: [BaseElement; 2],
    nullifier: [BaseElement; 2],
    value: BaseElement,
    sighash: [BaseElement; 2],
) -> bool {
    let Ok(proof) = Proof::from_bytes(proof_bytes) else {
        return false;
    };
    let pub_inputs = SpendPublicInputs { tree_root, nullifier, value, sighash };
    let acceptable = AcceptableOptions::OptionSet(vec![proof_options()]);
    winterfell::verify::<SpendAir, H, DefaultRandomCoin<H>, MerkleTree<H>>(
        proof,
        pub_inputs,
        &acceptable,
    )
    .is_ok()
}
