//! The hidden-amount transfer circuit: spend one note into two new notes
//! (payment + change) with **private values**, conserving value in-circuit.
//!
//! Statement, for public inputs `(root, nullifier N, C1, C2, fee, sighash)`:
//! the prover knows private `(v, r, position, N1', v1, r1, N2', v2, r2)`
//! such that
//!
//! - `C1 = Rescue(N1', v1, r1)` and `C2 = Rescue(N2', v2, r2)`,
//! - `Rescue(N, v, r)` is a leaf of the note tree with the given `root`,
//! - `v = v1 + v2 + fee` (in the field).
//!
//! Values never appear on chain. Field-level conservation is sound without
//! explicit range proofs because the f128 modulus (~2^128) dwarfs any
//! realistic sum of u64 note values: constructing a wrap-around would
//! require ~2^64 notes. A "wrapped" (astronomically large) note value can
//! never be unshielded, since unshielding reveals the value as a u64.
//!
//! Trace layout (8 columns × 256 steps, 8-step Rescue cycles):
//!
//! ```text
//! cycle 0  (rows   0..8):  C1 = H(N1', v1, r1)         digest at row 7
//! cycle 1  (rows   8..16): C2 = H(N2', v2, r2)         digest at row 15
//! cycle 2  (rows  16..24): leaf = H(N, v, r)           N public at row 16
//! cycles 3..17 (24..144):  15 Merkle merges            root at row 143
//! cycles 18..31:           zero padding
//! col 7: value accumulator  v1 → v1+v2, checked against v + fee
//! ```

use winterfell::{
    crypto::{DefaultRandomCoin, MerkleTree},
    math::{fields::f128::BaseElement, FieldElement, ToElements},
    matrix::ColMatrix,
    AcceptableOptions, Air, AirContext, Assertion, AuxRandElements, CompositionPoly,
    CompositionPolyTrace, ConstraintCompositionCoefficients, DefaultConstraintCommitment,
    DefaultConstraintEvaluator, DefaultTraceLde, EvaluationFrame, PartitionOptions, Proof,
    ProofOptions, Prover, StarkDomain, TraceInfo, TracePolyTable, TraceTable,
    TransitionConstraintDegree,
};

use crate::rescue::{
    self, Hash, CYCLE_LENGTH as HASH_CYCLE_LEN, NUM_ROUNDS as NUM_HASH_ROUNDS,
    STATE_WIDTH as HASH_STATE_WIDTH,
};
use crate::spend::{proof_options, TREE_DEPTH};
use crate::utils::{are_equal, is_binary, is_zero, not, EvaluationResult};
use crate::ZkError;

const TRACE_WIDTH: usize = 8;
const TRACE_LEN: usize = 256;
/// Row of the C1 digest / C2 digest / leaf seed / root.
const C1_ROW: usize = 7;
const C2_ROW: usize = 15;
const LEAF_ROW: usize = 16;
const ROOT_ROW: usize = (3 + TREE_DEPTH) * HASH_CYCLE_LEN - 1; // 143

type H = winterfell::crypto::hashers::Blake3_256<BaseElement>;

/// One note's secrets, as used by wallet and prover.
#[derive(Clone, Copy, Debug)]
pub struct NoteOpening {
    pub nullifier: [BaseElement; 2],
    pub value: u64,
    pub blinding: BaseElement,
}

// PUBLIC INPUTS
// ================================================================================================

#[derive(Clone, Debug)]
pub struct TransferPublicInputs {
    pub tree_root: [BaseElement; 2],
    pub nullifier: [BaseElement; 2],
    pub commitment1: [BaseElement; 2],
    pub commitment2: [BaseElement; 2],
    pub fee: BaseElement,
    pub sighash: [BaseElement; 2],
}

impl ToElements<BaseElement> for TransferPublicInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.tree_root[0],
            self.tree_root[1],
            self.nullifier[0],
            self.nullifier[1],
            self.commitment1[0],
            self.commitment1[1],
            self.commitment2[0],
            self.commitment2[1],
            self.fee,
            self.sighash[0],
            self.sighash[1],
        ]
    }
}

// AIR
// ================================================================================================

pub struct TransferAir {
    context: AirContext<BaseElement>,
    pub_inputs: TransferPublicInputs,
}

impl Air for TransferAir {
    type BaseField = BaseElement;
    type PublicInputs = TransferPublicInputs;

    fn new(trace_info: TraceInfo, pub_inputs: TransferPublicInputs, options: ProofOptions) -> Self {
        assert_eq!(TRACE_WIDTH, trace_info.width());
        assert_eq!(TRACE_LEN, trace_info.length());
        let degrees = vec![
            // state columns: Rescue round (deg 5, period-8 mask) + digest
            // forwarding (deg 2, full-length mask)
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN, TRACE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN, TRACE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN, TRACE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN, TRACE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            TransitionConstraintDegree::with_cycles(5, vec![HASH_CYCLE_LEN]),
            // path-bit binarity
            TransitionConstraintDegree::new(2),
            // value accumulator (init / copy / add, full-length masks)
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LEN]),
            // balance check (full-length mask)
            TransitionConstraintDegree::with_cycles(1, vec![TRACE_LEN]),
        ];
        TransferAir {
            context: AirContext::new(trace_info, degrees, 10, options),
            pub_inputs,
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
        let round_flag = periodic_values[0];
        let ark = &periodic_values[1..1 + 2 * HASH_STATE_WIDTH];
        let rest = &periodic_values[1 + 2 * HASH_STATE_WIDTH..];
        let chain_mask = rest[0];
        let acc_init = rest[1];
        let acc_copy = rest[2];
        let acc_add = rest[3];
        let sum_mask = rest[4];

        rescue::enforce_round(
            result,
            &current[..HASH_STATE_WIDTH],
            &next[..HASH_STATE_WIDTH],
            ark,
            round_flag,
        );

        // Capacity registers reset at every cycle boundary.
        let init_flag = not(round_flag);
        result.agg_constraint(4, init_flag, is_zero(next[4]));
        result.agg_constraint(5, init_flag, is_zero(next[5]));

        // Digest forwarding only at boundaries entering Merkle-path cycles.
        let bit = next[6];
        let not_bit = not(bit);
        result.agg_constraint(0, chain_mask, not_bit * are_equal(current[0], next[0]));
        result.agg_constraint(1, chain_mask, not_bit * are_equal(current[1], next[1]));
        result.agg_constraint(2, chain_mask, bit * are_equal(current[0], next[2]));
        result.agg_constraint(3, chain_mask, bit * are_equal(current[1], next[3]));

        result[6] = is_binary(current[6]);

        // Value accumulator: starts as v1, becomes v1+v2, then feeds the
        // balance check v = (v1+v2) + fee at the leaf-cycle boundary.
        result.agg_constraint(7, acc_init, are_equal(current[7], current[2]));
        result.agg_constraint(7, acc_copy, are_equal(next[7], current[7]));
        result.agg_constraint(7, acc_add, are_equal(next[7], current[7] + next[2]));
        result.agg_constraint(
            8,
            sum_mask,
            are_equal(next[2], current[7] + E::from(self.pub_inputs.fee)),
        );
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        let p = &self.pub_inputs;
        vec![
            Assertion::single(0, C1_ROW, p.commitment1[0]),
            Assertion::single(1, C1_ROW, p.commitment1[1]),
            Assertion::single(0, C2_ROW, p.commitment2[0]),
            Assertion::single(1, C2_ROW, p.commitment2[1]),
            Assertion::single(0, LEAF_ROW, p.nullifier[0]),
            Assertion::single(1, LEAF_ROW, p.nullifier[1]),
            Assertion::single(0, ROOT_ROW, p.tree_root[0]),
            Assertion::single(1, ROOT_ROW, p.tree_root[1]),
            Assertion::periodic(4, 0, HASH_CYCLE_LEN, BaseElement::ZERO),
            Assertion::periodic(5, 0, HASH_CYCLE_LEN, BaseElement::ZERO),
        ]
    }

    fn get_periodic_column_values(&self) -> Vec<Vec<Self::BaseField>> {
        let one = BaseElement::ONE;
        let mut hash_mask = vec![one; HASH_CYCLE_LEN];
        hash_mask[HASH_CYCLE_LEN - 1] = BaseElement::ZERO;

        let mut chain_mask = vec![BaseElement::ZERO; TRACE_LEN];
        // Boundaries entering path cycles 3..=17: steps 23, 31, …, 135.
        for cycle in 3..=(2 + TREE_DEPTH) {
            chain_mask[cycle * HASH_CYCLE_LEN - 1] = one;
        }
        let mut acc_init = vec![BaseElement::ZERO; TRACE_LEN];
        acc_init[0] = one;
        let mut acc_copy = vec![BaseElement::ZERO; TRACE_LEN];
        for step in 0..C1_ROW {
            acc_copy[step] = one; // pairs (0,1)…(6,7)
        }
        for step in (C1_ROW + 1)..C2_ROW {
            acc_copy[step] = one; // pairs (8,9)…(14,15)
        }
        let mut acc_add = vec![BaseElement::ZERO; TRACE_LEN];
        acc_add[C1_ROW] = one; // pair (7,8): acc += v2
        let mut sum_mask = vec![BaseElement::ZERO; TRACE_LEN];
        sum_mask[C2_ROW] = one; // pair (15,16): v == acc + fee

        let mut result = vec![hash_mask];
        result.append(&mut rescue::get_round_constants());
        result.push(chain_mask);
        result.push(acc_init);
        result.push(acc_copy);
        result.push(acc_add);
        result.push(sum_mask);
        result
    }
}

// PROVER
// ================================================================================================

struct TransferProver {
    options: ProofOptions,
    fee: BaseElement,
    sighash: [BaseElement; 2],
}

impl TransferProver {
    #[allow(clippy::too_many_arguments)]
    fn build_trace(
        &self,
        old: &NoteOpening,
        new1: &NoteOpening,
        new2: &NoteOpening,
        branch: &[Hash],
        index: usize,
    ) -> TraceTable<BaseElement> {
        let siblings = &branch[1..];
        let seed =
            |n: &NoteOpening| -> [BaseElement; 4] {
                [n.nullifier[0], n.nullifier[1], BaseElement::new(n.value as u128), n.blinding]
            };
        let (s1, s2, s_old) = (seed(new1), seed(new2), seed(old));
        let v1 = BaseElement::new(new1.value as u128);
        let v2 = BaseElement::new(new2.value as u128);

        let mut trace = TraceTable::new(TRACE_WIDTH, TRACE_LEN);
        trace.fill(
            |state| {
                state[..4].copy_from_slice(&s1);
                state[4] = BaseElement::ZERO;
                state[5] = BaseElement::ZERO;
                state[6] = BaseElement::ZERO;
                state[7] = v1;
            },
            |step, state| {
                let cycle_pos = step % HASH_CYCLE_LEN;
                if cycle_pos < NUM_HASH_ROUNDS {
                    rescue::apply_round(&mut state[..HASH_STATE_WIDTH], step);
                    return; // col 6 and col 7 carry over unchanged
                }
                // Boundary: this writes the state of the *next* cycle.
                let next_cycle = step / HASH_CYCLE_LEN + 1;
                match next_cycle {
                    1 => {
                        state[..4].copy_from_slice(&s2);
                        state[7] = v1 + v2;
                    }
                    2 => {
                        state[..4].copy_from_slice(&s_old);
                        state[7] = BaseElement::ZERO;
                    }
                    c if c >= 3 && c < 3 + TREE_DEPTH => {
                        let level = c - 3;
                        let node = siblings[level].to_elements();
                        let bit = (index >> level) & 1;
                        if bit == 0 {
                            state[2] = node[0];
                            state[3] = node[1];
                        } else {
                            state[2] = state[0];
                            state[3] = state[1];
                            state[0] = node[0];
                            state[1] = node[1];
                        }
                        state[6] = BaseElement::new(bit as u128);
                        state[7] = BaseElement::ZERO;
                    }
                    _ => {
                        // padding cycles: zero state (keeps capacity
                        // assertions and round constraints trivially valid)
                        state.fill(BaseElement::ZERO);
                        return;
                    }
                }
                state[4] = BaseElement::ZERO;
                state[5] = BaseElement::ZERO;
                if next_cycle < 3 {
                    state[6] = BaseElement::ZERO;
                }
            },
        );
        trace
    }
}

impl Prover for TransferProver {
    type BaseField = BaseElement;
    type Air = TransferAir;
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

    fn get_pub_inputs(&self, trace: &Self::Trace) -> TransferPublicInputs {
        TransferPublicInputs {
            tree_root: [trace.get(0, ROOT_ROW), trace.get(1, ROOT_ROW)],
            nullifier: [trace.get(0, LEAF_ROW), trace.get(1, LEAF_ROW)],
            commitment1: [trace.get(0, C1_ROW), trace.get(1, C1_ROW)],
            commitment2: [trace.get(0, C2_ROW), trace.get(1, C2_ROW)],
            fee: self.fee,
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

/// Generate a hidden-amount transfer proof. The caller must satisfy
/// `old.value == new1.value + new2.value + fee` (checked here; the circuit
/// enforces it too).
#[allow(clippy::too_many_arguments)]
pub fn prove_transfer(
    old: &NoteOpening,
    new1: &NoteOpening,
    new2: &NoteOpening,
    fee: u64,
    branch: Vec<Hash>,
    index: usize,
    sighash: [BaseElement; 2],
) -> Result<Vec<u8>, ZkError> {
    if branch.len() != TREE_DEPTH + 1 {
        return Err(ZkError::BadWitness("wrong branch length".into()));
    }
    let balanced = new1
        .value
        .checked_add(new2.value)
        .and_then(|s| s.checked_add(fee))
        .map(|s| s == old.value)
        .unwrap_or(false);
    if !balanced {
        return Err(ZkError::BadWitness("values do not balance".into()));
    }
    let prover = TransferProver {
        options: proof_options(),
        fee: BaseElement::new(fee as u128),
        sighash,
    };
    let trace = prover.build_trace(old, new1, new2, &branch, index);
    let proof = prover.prove(trace).map_err(|e| ZkError::Prover(e.to_string()))?;
    Ok(proof.to_bytes())
}

/// Verify a transfer proof against the public inputs.
#[allow(clippy::too_many_arguments)]
pub fn verify_transfer(
    proof_bytes: &[u8],
    tree_root: [BaseElement; 2],
    nullifier: [BaseElement; 2],
    commitment1: [BaseElement; 2],
    commitment2: [BaseElement; 2],
    fee: u64,
    sighash: [BaseElement; 2],
) -> bool {
    let Ok(proof) = Proof::from_bytes(proof_bytes) else {
        return false;
    };
    let pub_inputs = TransferPublicInputs {
        tree_root,
        nullifier,
        commitment1,
        commitment2,
        fee: BaseElement::new(fee as u128),
        sighash,
    };
    let acceptable = AcceptableOptions::OptionSet(vec![proof_options()]);
    winterfell::verify::<TransferAir, H, DefaultRandomCoin<H>, MerkleTree<H>>(
        proof,
        pub_inputs,
        &acceptable,
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note::{bytes_to_felts, bytes_to_felts_reduced, commitment, random_felt, NoteTree};

    fn opening(value: u64) -> NoteOpening {
        NoteOpening {
            nullifier: [random_felt(), random_felt()],
            value,
            blinding: random_felt(),
        }
    }

    #[test]
    fn transfer_roundtrip_and_rejections() {
        let old = opening(1_000_000);
        let fee = 1_000;
        let new1 = opening(700_000);
        let new2 = opening(299_000);

        let c_old = commitment(old.nullifier, old.value, old.blinding);
        let tree = NoteTree::from_leaves(&[c_old]).unwrap();
        let root = bytes_to_felts(&tree.root()).unwrap();
        let sighash = bytes_to_felts_reduced(&[7u8; 32]);
        let branch = tree.branch(0).unwrap();

        let proof =
            prove_transfer(&old, &new1, &new2, fee, branch.clone(), 0, sighash).unwrap();

        let c1 = bytes_to_felts(&commitment(new1.nullifier, new1.value, new1.blinding)).unwrap();
        let c2 = bytes_to_felts(&commitment(new2.nullifier, new2.value, new2.blinding)).unwrap();

        assert!(verify_transfer(&proof, root, old.nullifier, c1, c2, fee, sighash));

        // wrong fee claim
        assert!(!verify_transfer(&proof, root, old.nullifier, c1, c2, fee + 1, sighash));
        // swapped commitments
        assert!(!verify_transfer(&proof, root, old.nullifier, c2, c1, fee, sighash));
        // wrong nullifier
        assert!(!verify_transfer(
            &proof,
            root,
            [old.nullifier[1], old.nullifier[0]],
            c1,
            c2,
            fee,
            sighash
        ));
        // different transaction
        let other_sig = bytes_to_felts_reduced(&[8u8; 32]);
        assert!(!verify_transfer(&proof, root, old.nullifier, c1, c2, fee, other_sig));

        // unbalanced witness is refused at proving time
        let too_rich = opening(999_999);
        assert!(matches!(
            prove_transfer(&old, &too_rich, &new2, fee, branch, 0, sighash),
            Err(ZkError::BadWitness(_))
        ));
    }
}
