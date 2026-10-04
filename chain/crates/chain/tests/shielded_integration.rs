//! Shielded pool end-to-end: shield → unshield with real STARK proofs
//! through mined blocks, plus double-spend / tamper / binding rejections.

use blockle_chain::{mine_block, Chain, ChainError, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{
    ShieldedBundle, ShieldedOutput, ShieldedSpend, Transaction, TxInput, TxOutput, COIN,
};
use blockle_zk::{self as zk, BaseElement};

fn mine_with(chain: &mut Chain, kp: &Keypair, txs: &[Transaction]) -> usize {
    let (block, included) = mine_block(chain, kp.address(), txs).unwrap();
    let n = included.len();
    chain.connect_block(block).unwrap();
    n
}

/// Transparent-funded tx that creates one shielded note.
fn build_shield_tx(chain: &Chain, kp: &Keypair, commitment: [u8; 32], value: u64, fee: u64) -> Transaction {
    let (outpoint, entry) = chain
        .spendable_utxos(&kp.address())
        .into_iter()
        .max_by_key(|(_, e)| e.output.amount)
        .unwrap();
    let change = entry.output.amount - value - fee;
    let mut tx = Transaction {
        version: 1,
        inputs: vec![TxInput { prev: outpoint, pubkey: kp.public_bytes(), signature: vec![] }],
        outputs: vec![TxOutput { recipient: kp.address(), amount: change }],
        coinbase_data: vec![],
        shielded: Some(ShieldedBundle {
            spends: vec![],
            outputs: vec![ShieldedOutput { commitment, value }],
            transfers: vec![],
        }),
        contract: None,
    };
    let sighash = tx.sighash();
    tx.inputs[0].signature = kp.sign(&sighash);
    tx
}

/// Shielded-funded tx that spends a note back to a transparent address.
fn build_unshield_tx(
    chain: &Chain,
    nullifier: [BaseElement; 2],
    value: u64,
    blinding: BaseElement,
    leaf_index: usize,
    recipient: [u8; 32],
    fee: u64,
) -> Transaction {
    let tree = zk::NoteTree::from_leaves(&chain.note_leaves).unwrap();
    let anchor = tree.root();
    let mut tx = Transaction {
        version: 1,
        inputs: vec![],
        outputs: vec![TxOutput { recipient, amount: value - fee }],
        coinbase_data: vec![],
        shielded: Some(ShieldedBundle {
            spends: vec![ShieldedSpend {
                anchor,
                nullifier: zk::felts_to_bytes(&nullifier),
                value,
                proof: vec![],
            }],
            outputs: vec![],
            transfers: vec![],
        }),
        contract: None,
    };
    // The sighash excludes proofs, so we can compute it, prove, then attach.
    let sighash = zk::bytes_to_felts_reduced(&tx.sighash());
    let branch = tree.branch(leaf_index).unwrap();
    let proof = zk::prove_spend(
        nullifier,
        BaseElement::new(value as u128),
        blinding,
        branch,
        leaf_index,
        sighash,
    )
    .unwrap();
    tx.shielded.as_mut().unwrap().spends[0].proof = proof;
    tx
}

#[test]
fn shield_then_unshield_roundtrip() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params);
    let kp = Keypair::generate();
    let alice = Keypair::generate();
    mine_with(&mut chain, &kp, &[]); // genesis premine

    // Shield 100 BLOCK.
    let nullifier = [zk::random_felt(), zk::random_felt()];
    let blinding = zk::random_felt();
    let value = 100 * COIN;
    let commitment = zk::commitment(nullifier, value, blinding);
    let fee = COIN / 1000;
    let shield = build_shield_tx(&chain, &kp, commitment, value, fee);
    assert_eq!(mine_with(&mut chain, &kp, &[shield]), 1);
    assert_eq!(chain.note_leaves.len(), 1);
    let anchor = zk::NoteTree::from_leaves(&chain.note_leaves).unwrap().root();
    assert!(chain.note_anchors.contains(&anchor));

    // Unshield to alice.
    let unshield = build_unshield_tx(&chain, nullifier, value, blinding, 0, alice.address(), fee);
    assert_eq!(mine_with(&mut chain, &kp, &[unshield.clone()]), 1);
    assert_eq!(chain.balance(&alice.address()), value - fee);
    assert!(chain.nullifiers.contains(&zk::felts_to_bytes(&nullifier)));

    // Double spend of the same note must be rejected.
    let double = build_unshield_tx(&chain, nullifier, value, blinding, 0, alice.address(), fee);
    let err = chain.check_transaction(&double, &chain.utxos, chain.blocks.len() as u64);
    assert!(matches!(err, Err(ChainError::NullifierReused)), "{err:?}");
}

#[test]
fn forged_and_tampered_spends_rejected() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params);
    let kp = Keypair::generate();
    mine_with(&mut chain, &kp, &[]);

    let nullifier = [zk::random_felt(), zk::random_felt()];
    let blinding = zk::random_felt();
    let value = 10 * COIN;
    let commitment = zk::commitment(nullifier, value, blinding);
    let fee = COIN / 1000;
    let shield = build_shield_tx(&chain, &kp, commitment, value, fee);
    mine_with(&mut chain, &kp, &[shield]);

    let height = chain.blocks.len() as u64;
    let good = build_unshield_tx(&chain, nullifier, value, blinding, 0, kp.address(), fee);
    assert!(chain.check_transaction(&good, &chain.utxos, height).is_ok());

    // Inflation attempt: claim a larger spend value. The sighash (and the
    // proof's public value) no longer match → proof fails.
    let mut inflated = good.clone();
    inflated.shielded.as_mut().unwrap().spends[0].value = value * 2;
    inflated.outputs[0].amount = value * 2 - fee;
    assert!(matches!(
        chain.check_transaction(&inflated, &chain.utxos, height),
        Err(ChainError::BadSpendProof)
    ));

    // Redirect attempt: reuse the proof but change the payout address.
    // The sighash changes, so the transcript-bound proof dies.
    let mut redirected = good.clone();
    redirected.outputs[0].recipient = [0xEE; 32];
    assert!(matches!(
        chain.check_transaction(&redirected, &chain.utxos, height),
        Err(ChainError::BadSpendProof)
    ));

    // Unknown anchor.
    let mut bad_anchor = good.clone();
    bad_anchor.shielded.as_mut().unwrap().spends[0].anchor = [0x11; 32];
    let err = chain.check_transaction(&bad_anchor, &chain.utxos, height);
    assert!(
        matches!(err, Err(ChainError::UnknownAnchor) | Err(ChainError::ShieldedRules(_))),
        "{err:?}"
    );

    // Spending a note that was never shielded (fabricated proof data).
    let ghost_n = [zk::random_felt(), zk::random_felt()];
    let mut ghost = good.clone();
    ghost.shielded.as_mut().unwrap().spends[0].nullifier = zk::felts_to_bytes(&ghost_n);
    assert!(matches!(
        chain.check_transaction(&ghost, &chain.utxos, height),
        Err(ChainError::BadSpendProof)
    ));
}

#[test]
fn shielded_transfer_z_to_z() {
    // Spend one note into a fresh note (what `zsend` does): the chain only
    // sees a nullifier come in and a new commitment appear.
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params);
    let kp = Keypair::generate();
    mine_with(&mut chain, &kp, &[]);

    let n1 = [zk::random_felt(), zk::random_felt()];
    let r1 = zk::random_felt();
    let v1 = 50 * COIN;
    let c1 = zk::commitment(n1, v1, r1);
    let fee = COIN / 1000;
    let shield = build_shield_tx(&chain, &kp, c1, v1, fee);
    mine_with(&mut chain, &kp, &[shield]);

    // z→z: new note for the "recipient", fee paid from shielded value.
    let n2 = [zk::random_felt(), zk::random_felt()];
    let r2 = zk::random_felt();
    let v2 = v1 - fee;
    let c2 = zk::commitment(n2, v2, r2);
    let tree = zk::NoteTree::from_leaves(&chain.note_leaves).unwrap();
    let mut tx = Transaction {
        version: 1,
        inputs: vec![],
        outputs: vec![],
        coinbase_data: vec![],
        shielded: Some(ShieldedBundle {
            spends: vec![ShieldedSpend {
                anchor: tree.root(),
                nullifier: zk::felts_to_bytes(&n1),
                value: v1,
                proof: vec![],
            }],
            outputs: vec![ShieldedOutput { commitment: c2, value: v2 }],
            transfers: vec![],
        }),
        contract: None,
    };
    let sighash = zk::bytes_to_felts_reduced(&tx.sighash());
    let proof = zk::prove_spend(
        n1,
        BaseElement::new(v1 as u128),
        r1,
        tree.branch(0).unwrap(),
        0,
        sighash,
    )
    .unwrap();
    tx.shielded.as_mut().unwrap().spends[0].proof = proof;

    assert_eq!(mine_with(&mut chain, &kp, &[tx]), 1);
    assert_eq!(chain.note_leaves.len(), 2);
    assert!(chain.nullifiers.contains(&zk::felts_to_bytes(&n1)));

    // The new note is spendable in turn.
    let unshield = build_unshield_tx(&chain, n2, v2, r2, 1, kp.address(), fee);
    let height = chain.blocks.len() as u64;
    assert!(chain.check_transaction(&unshield, &chain.utxos, height).is_ok());
}

#[test]
fn hidden_amount_transfer_through_blocks() {
    use blockle_core::ShieldedTransfer;
    use blockle_zk::NoteOpening;

    let params = ChainParams::regtest();
    let mut chain = Chain::new(params);
    let kp = Keypair::generate();
    mine_with(&mut chain, &kp, &[]);

    // Shield 100 BLOCK (public amount at the boundary, as designed).
    let old = NoteOpening {
        nullifier: [zk::random_felt(), zk::random_felt()],
        value: 100 * COIN,
        blinding: zk::random_felt(),
    };
    let c_old = zk::commitment(old.nullifier, old.value, old.blinding);
    let fee = COIN / 1000;
    let shield = build_shield_tx(&chain, &kp, c_old, old.value, fee);
    mine_with(&mut chain, &kp, &[shield]);

    // Hidden transfer: 70 BLOCK payment + change, amounts not on chain.
    let pay = NoteOpening {
        nullifier: [zk::random_felt(), zk::random_felt()],
        value: 70 * COIN,
        blinding: zk::random_felt(),
    };
    let change = NoteOpening {
        nullifier: [zk::random_felt(), zk::random_felt()],
        value: old.value - pay.value - fee,
        blinding: zk::random_felt(),
    };
    let tree = zk::NoteTree::from_leaves(&chain.note_leaves).unwrap();
    let mut tx = Transaction {
        version: 1,
        inputs: vec![],
        outputs: vec![],
        coinbase_data: vec![],
        shielded: Some(ShieldedBundle {
            spends: vec![],
            outputs: vec![],
            transfers: vec![ShieldedTransfer {
                anchor: tree.root(),
                nullifier: zk::felts_to_bytes(&old.nullifier),
                commitment1: zk::commitment(pay.nullifier, pay.value, pay.blinding),
                commitment2: zk::commitment(change.nullifier, change.value, change.blinding),
                fee,
                memo: b"opaque-to-consensus".to_vec(),
                proof: vec![],
            }],
        }),
        contract: None,
    };
    let sighash = zk::bytes_to_felts_reduced(&tx.sighash());
    let proof = zk::prove_transfer(
        &old, &pay, &change, fee, tree.branch(0).unwrap(), 0, sighash,
    ).unwrap();
    tx.shielded.as_mut().unwrap().transfers[0].proof = proof;

    // Miner must collect exactly the declared fee.
    let miner_before = chain.balance(&kp.address());
    assert_eq!(mine_with(&mut chain, &kp, &[tx.clone()]), 1);
    assert_eq!(chain.balance(&kp.address()), miner_before + 50 * COIN + fee);
    assert_eq!(chain.note_leaves.len(), 3); // old + pay + change
    assert!(chain.nullifiers.contains(&zk::felts_to_bytes(&old.nullifier)));

    // Replaying the nullifier is rejected.
    let height = chain.blocks.len() as u64;
    let err = chain.check_transaction(&tx, &chain.utxos, height);
    assert!(matches!(err, Err(ChainError::NullifierReused)), "{err:?}");

    // Tampering with the declared fee (inflating miner reward out of the
    // pool) breaks the sighash → proof rejected.
    let mut greedy = tx.clone();
    greedy.shielded.as_mut().unwrap().transfers[0].nullifier =
        zk::felts_to_bytes(&[zk::random_felt(), zk::random_felt()]);
    greedy.shielded.as_mut().unwrap().transfers[0].fee = fee * 10;
    assert!(matches!(
        chain.check_transaction(&greedy, &chain.utxos, height),
        Err(ChainError::BadSpendProof)
    ));

    // Both hidden notes are spendable: unshield the payment note.
    let unshield = build_unshield_tx(
        &chain, pay.nullifier, pay.value, pay.blinding, 1, kp.address(), fee,
    );
    let before = chain.balance(&kp.address());
    mine_with(&mut chain, &kp, &[unshield]);
    assert_eq!(chain.balance(&kp.address()), before + 50 * COIN + fee + (pay.value - fee));

    // And the change note too.
    let unshield2 = build_unshield_tx(
        &chain, change.nullifier, change.value, change.blinding, 2, kp.address(), fee,
    );
    let height = chain.blocks.len() as u64;
    assert!(chain.check_transaction(&unshield2, &chain.utxos, height).is_ok());
}
