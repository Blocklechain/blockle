//! Constraint-evaluation helpers, vendored from winterfell's examples
//! (MIT licensed, Copyright (c) Facebook, Inc. and its affiliates).

use winterfell::math::FieldElement;

/// Returns zero only when a == b.
pub fn are_equal<E: FieldElement>(a: E, b: E) -> E {
    a - b
}

/// Returns zero only when a == zero.
pub fn is_zero<E: FieldElement>(a: E) -> E {
    a
}

/// Returns zero only when a == zero || a == one.
pub fn is_binary<E: FieldElement>(a: E) -> E {
    a * a - a
}

/// Return zero when a == one, and one when a == zero;
/// assumes that a is a binary value.
pub fn not<E: FieldElement>(a: E) -> E {
    E::ONE - a
}

pub trait EvaluationResult<E> {
    fn agg_constraint(&mut self, index: usize, flag: E, value: E);
}

impl<E: FieldElement> EvaluationResult<E> for [E] {
    fn agg_constraint(&mut self, index: usize, flag: E, value: E) {
        self[index] += flag * value;
    }
}

impl<E: FieldElement> EvaluationResult<E> for Vec<E> {
    fn agg_constraint(&mut self, index: usize, flag: E, value: E) {
        self[index] += flag * value;
    }
}
