use std::time::Instant;
use blockle_zk::*;
use winterfell::math::fields::f128::BaseElement;

fn main() {
    let n = [BaseElement::new(1), BaseElement::new(2)];
    let v = 500u64;
    let r = BaseElement::new(3);
    let c = commitment(n, v, r);

    let t = Instant::now();
    let tree = NoteTree::from_leaves(&[c]).unwrap();
    println!("tree build (32768 leaves): {:?}", t.elapsed());

    let branch = tree.branch(0).unwrap();
    let root = bytes_to_felts(&tree.root()).unwrap();
    let sighash = bytes_to_felts_reduced(&[9u8; 32]);

    let t = Instant::now();
    let proof = prove_spend(n, BaseElement::new(v as u128), r, branch, 0, sighash).unwrap();
    println!("prove: {:?} ({} bytes)", t.elapsed(), proof.len());

    let t = Instant::now();
    let ok = verify_spend(&proof, root, n, BaseElement::new(v as u128), sighash);
    println!("verify: {:?} ok={ok}", t.elapsed());
}
