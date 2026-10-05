//! Merged mining end-to-end: BLOCK blocks carried by sha256d, scrypt, and
//! equihash parent proofs — plus the rejections that keep it sound.

use blockle_chain::{build_template, mine_block, Chain, ChainError, ChainParams};
use blockle_core::{auxpow, sha256d, AuxPow, Block};
use blockle_pow::difficulty::{compact_to_target, hash_meets_target};
use blockle_pow::{equihash, scrypt_pow_hash};

fn new_chain() -> (Chain, [u8; 32]) {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params);
    let addr = [7u8; 32];
    let (genesis, _) = mine_block(&chain, addr, &[]).expect("genesis");
    chain.connect_block(genesis).expect("genesis connects");
    (chain, addr)
}

/// Build an unsolved BLOCK block on the given lane (no native solution).
fn aux_candidate(chain: &Chain, addr: [u8; 32], lane: &str) -> Block {
    let (mut block, _) = build_template(chain, addr, &[]).expect("template");
    block.header.bits = chain.next_bits_for(lane);
    block.header.nonce = [0u8; 32];
    block.header.solution = vec![];
    block
}

/// Parent coinbase committing to `aux_hash` in a single-slot tree.
fn parent_coinbase(aux_hash: [u8; 32]) -> Vec<u8> {
    let mut cb = b"parent coinbase bytes ".to_vec();
    cb.extend(auxpow::mm_commitment(&aux_hash, 1, 0));
    cb
}

/// 80-byte parent header over the given merkle root, ground until
/// `pow(header)` meets `bits`.
fn grind_parent80(merkle_root: [u8; 32], bits: u32, pow: impl Fn(&[u8]) -> [u8; 32]) -> Vec<u8> {
    let limit = compact_to_target(bits).expect("bits");
    let mut h = vec![0u8; 80];
    h[0] = 4; // version
    h[36..68].copy_from_slice(&merkle_root);
    for n in 0u32.. {
        h[76..80].copy_from_slice(&n.to_le_bytes());
        if hash_meets_target(&pow(&h), bits, limit) {
            return h;
        }
    }
    unreachable!()
}

fn attach(block: &mut Block, algo: &str, parent_header: Vec<u8>, cb: Vec<u8>) {
    block.aux_pow = Some(AuxPow {
        parent_algo: algo.into(),
        parent_header,
        parent_coinbase: cb,
        coinbase_branch: vec![],
        chain_branch: vec![],
        chain_index: 0,
    });
}

#[test]
fn sha256d_parent_carries_a_block() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "sha256d");
    let cb = parent_coinbase(block.header.hash());
    let header = grind_parent80(sha256d(&cb), block.header.bits, |h| sha256d(h));
    attach(&mut block, "sha256d", header, cb);
    chain.connect_block(block).expect("sha256d-merged block accepted");
    assert_eq!(chain.height(), Some(1));
    assert_eq!(Chain::lane_of(chain.blocks.last().unwrap()), "sha256d");
}

#[test]
fn scrypt_parent_carries_a_block() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "scrypt");
    let cb = parent_coinbase(block.header.hash());
    let header = grind_parent80(sha256d(&cb), block.header.bits, scrypt_pow_hash);
    attach(&mut block, "scrypt", header, cb);
    chain.connect_block(block).expect("scrypt-merged block accepted");
    assert_eq!(chain.height(), Some(1));
}

#[test]
fn equihash_parent_carries_a_block() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "equihash");
    let cb = parent_coinbase(block.header.hash());
    let cb_txid = sha256d(&cb);

    // Zcash-layout parent: reuse our own header shape, solve its Equihash.
    let eq = chain.params.equihash.clone();
    let limit = compact_to_target(block.header.bits).expect("bits");
    let mut parent = blockle_core::BlockHeader {
        version: 4,
        prev_hash: [9u8; 32],
        merkle_root: cb_txid,
        state_root: [0u8; 32],
        time: 1_700_000_000,
        bits: block.header.bits,
        nonce: [0u8; 32],
        solution: vec![],
    };
    'done: for n in 0u64.. {
        parent.nonce[..8].copy_from_slice(&n.to_le_bytes());
        for sol in equihash::solve(&eq, &parent.equihash_input(), &parent.nonce) {
            parent.solution = equihash::pack_solution(&eq, &sol);
            if hash_meets_target(&sha256d(&parent.serialize()), block.header.bits, limit) {
                break 'done;
            }
        }
    }
    attach(&mut block, "equihash", parent.serialize(), cb);
    chain.connect_block(block).expect("equihash-merged block accepted");
    assert_eq!(chain.height(), Some(1));
}

#[test]
fn tampered_commitment_is_rejected() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "sha256d");
    let cb = parent_coinbase([0xAB; 32]); // commits to the wrong hash
    let header = grind_parent80(sha256d(&cb), block.header.bits, |h| sha256d(h));
    attach(&mut block, "sha256d", header, cb);
    assert!(matches!(chain.connect_block(block), Err(ChainError::BadAuxPow(_))));
}

#[test]
fn missing_commitment_is_rejected() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "sha256d");
    let cb = b"no commitment here".to_vec();
    let header = grind_parent80(sha256d(&cb), block.header.bits, |h| sha256d(h));
    attach(&mut block, "sha256d", header, cb);
    assert!(matches!(chain.connect_block(block), Err(ChainError::BadAuxPow(_))));
}

#[test]
fn weak_parent_pow_is_rejected() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "sha256d");
    let cb = parent_coinbase(block.header.hash());
    // Deliberately weak parent: grind for a nonce whose hash MISSES the
    // (easy) regtest target — deterministic, unlike a fixed header which
    // would pass it one time in sixteen.
    let limit = compact_to_target(block.header.bits).expect("bits");
    let mut header = vec![0u8; 80];
    header[36..68].copy_from_slice(&sha256d(&cb));
    for n in 0u32.. {
        header[76..80].copy_from_slice(&n.to_le_bytes());
        if !hash_meets_target(&sha256d(&header), block.header.bits, limit) {
            break;
        }
    }
    attach(&mut block, "sha256d", header, cb);
    assert!(matches!(
        chain.connect_block(block),
        Err(ChainError::InsufficientWork) | Err(ChainError::BadAuxPow(_))
    ));
}

#[test]
fn native_solution_on_aux_block_is_rejected() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "sha256d");
    let cb = parent_coinbase(block.header.hash());
    let header = grind_parent80(sha256d(&cb), block.header.bits, |h| sha256d(h));
    attach(&mut block, "sha256d", header, cb);
    block.header.solution = vec![1, 2, 3]; // changes the hash AND is illegal
    assert!(chain.connect_block(block).is_err());
}

#[test]
fn unknown_parent_algo_is_rejected() {
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "native");
    attach(&mut block, "x17", vec![0u8; 80], vec![]);
    assert!(matches!(chain.connect_block(block), Err(ChainError::BadAuxPow(_))));
}

#[test]
fn every_asic_algo_carries_a_block() {
    // One merged block per fixed-header lane, all on one chain.
    let (mut chain, addr) = new_chain();
    for algo in blockle_pow::parent::FIXED_HEADER_ALGOS {
        let mut block = aux_candidate(&chain, addr, algo);
        let cb = parent_coinbase(block.header.hash());
        let header = grind_parent80(sha256d(&cb), block.header.bits, |h| {
            blockle_pow::parent::pow_hash(algo, h).expect("registered algo")
        });
        attach(&mut block, algo, header, cb);
        chain
            .connect_block(block)
            .unwrap_or_else(|e| panic!("{algo}-merged block rejected: {e}"));
    }
    assert_eq!(chain.height(), Some(blockle_pow::parent::FIXED_HEADER_ALGOS.len() as u64));
}

#[test]
fn lanes_retarget_independently() {
    let (mut chain, addr) = new_chain();
    // Mine several sha256d-merged blocks; the scrypt lane must stay at the
    // pow limit while the sha256d lane starts adjusting.
    for _ in 0..3 {
        let mut block = aux_candidate(&chain, addr, "sha256d");
        let cb = parent_coinbase(block.header.hash());
        let header = grind_parent80(sha256d(&cb), block.header.bits, |h| sha256d(h));
        attach(&mut block, "sha256d", header, cb);
        chain.connect_block(block).expect("merged block");
    }
    let fresh = Chain::new(ChainParams::regtest());
    assert_eq!(
        chain.next_bits_for("scrypt"),
        fresh.next_bits_for("scrypt"),
        "untouched lane stays at its floor"
    );
}

#[test]
fn merged_block_header_has_no_native_solution() {
    // Headers-first sync skips the native PoW check for these; this pins
    // the invariant that lets that skip be safe (empty solution + zero
    // nonce uniquely identify a merged-mined block's header).
    let (mut chain, addr) = new_chain();
    let mut block = aux_candidate(&chain, addr, "sha256d");
    let cb = parent_coinbase(block.header.hash());
    let header = grind_parent80(sha256d(&cb), block.header.bits, |h| sha256d(h));
    attach(&mut block, "sha256d", header, cb);
    assert!(block.header.solution.is_empty());
    assert_eq!(block.header.nonce, [0u8; 32]);
    chain.connect_block(block).expect("merged block accepted");
    let h = &chain.blocks.last().unwrap().header;
    assert!(h.solution.is_empty() && h.nonce == [0u8; 32]);
}
