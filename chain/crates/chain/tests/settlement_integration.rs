//! Proof-of-Blocks settlement mints through real mined blocks.

use blockle_chain::{mine_block, Chain, ChainError, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{SettlementEntry, SettlementMint, Transaction, TxOutput, COIN};

fn settlement_tx(authority: &Keypair, epoch: u64, entries: Vec<SettlementEntry>) -> Transaction {
    let mut mint = SettlementMint { epoch, entries, signature: vec![] };
    mint.signature = authority.sign(&mint.signing_message());
    Transaction {
        version: 1,
        inputs: vec![],
        outputs: mint
            .entries
            .iter()
            .map(|e| TxOutput { recipient: e.address, amount: e.amount })
            .collect(),
        coinbase_data: vec![],
        shielded: None,
        contract: None,
        settlement: Some(mint),
    }
}

#[test]
fn settlement_mints_block_on_chain() {
    let authority = Keypair::generate();
    let mut params = ChainParams::regtest();
    params.settlement_authority = Some(authority.public_bytes());
    let mut chain = Chain::new(params);
    let miner = Keypair::generate();
    let alice = Keypair::generate();
    let bob = Keypair::generate();

    let (genesis, _) = mine_block(&chain, miner.address(), &[]).unwrap();
    chain.connect_block(genesis).unwrap();

    // Mint epoch 20729: 20.95 BLOCK to alice, 1 BLOCK to bob.
    let tx = settlement_tx(
        &authority,
        20729,
        vec![
            SettlementEntry { address: alice.address(), amount: 20 * COIN + 95425000 },
            SettlementEntry { address: bob.address(), amount: COIN },
        ],
    );
    let (block, included) = mine_block(&chain, miner.address(), &[tx.clone()]).unwrap();
    assert_eq!(included.len(), 1);
    chain.connect_block(block).unwrap();

    assert_eq!(chain.balance(&alice.address()), 20 * COIN + 95425000);
    assert_eq!(chain.balance(&bob.address()), COIN);
    assert!(chain.settled_epochs.contains(&20729));

    // Replaying the same epoch is rejected — even re-signed.
    let replay = settlement_tx(
        &authority,
        20729,
        vec![SettlementEntry { address: alice.address(), amount: COIN }],
    );
    let err = chain.check_transaction(&replay, &chain.utxos, chain.blocks.len() as u64);
    assert!(matches!(err, Err(ChainError::SettlementEpochReplayed)), "{err:?}");

    // A different epoch works.
    let next = settlement_tx(
        &authority,
        20730,
        vec![SettlementEntry { address: bob.address(), amount: 2 * COIN }],
    );
    let (block, _) = mine_block(&chain, miner.address(), &[next]).unwrap();
    chain.connect_block(block).unwrap();
    assert_eq!(chain.balance(&bob.address()), 3 * COIN);
}

#[test]
fn forged_settlements_rejected() {
    let authority = Keypair::generate();
    let impostor = Keypair::generate();
    let mut params = ChainParams::regtest();
    params.settlement_authority = Some(authority.public_bytes());
    let mut chain = Chain::new(params);
    let miner = Keypair::generate();
    let (genesis, _) = mine_block(&chain, miner.address(), &[]).unwrap();
    chain.connect_block(genesis).unwrap();
    let height = chain.blocks.len() as u64;
    let entry = SettlementEntry { address: miner.address(), amount: COIN };

    // Signed by the wrong key.
    let forged = settlement_tx(&impostor, 1, vec![entry.clone()]);
    assert!(matches!(
        chain.check_transaction(&forged, &chain.utxos, height),
        Err(ChainError::SettlementUnauthorized)
    ));

    // Valid signature but outputs inflated beyond the signed entries.
    let mut tampered = settlement_tx(&authority, 1, vec![entry.clone()]);
    tampered.outputs[0].amount += 1;
    assert!(matches!(
        chain.check_transaction(&tampered, &chain.utxos, height),
        Err(ChainError::SettlementRules(_))
    ));

    // Tampering with the signed entry amount breaks the signature.
    let mut resigned = settlement_tx(&authority, 1, vec![entry.clone()]);
    resigned.settlement.as_mut().unwrap().entries[0].amount += 1;
    resigned.outputs[0].amount += 1;
    assert!(matches!(
        chain.check_transaction(&resigned, &chain.utxos, height),
        Err(ChainError::SettlementUnauthorized)
    ));

    // No authority configured → settlement disabled.
    let mut chain2 = Chain::new(ChainParams::regtest());
    let (g2, _) = mine_block(&chain2, miner.address(), &[]).unwrap();
    chain2.connect_block(g2).unwrap();
    let valid = settlement_tx(&authority, 1, vec![entry]);
    assert!(matches!(
        chain2.check_transaction(&valid, &chain2.utxos, 1),
        Err(ChainError::SettlementUnauthorized)
    ));
}
