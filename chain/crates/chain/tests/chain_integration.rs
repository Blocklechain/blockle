//! End-to-end consensus tests on regtest parameters (Equihash 48,5).

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{OutPoint, Transaction, TxInput, TxOutput, COIN};

fn mine_and_connect(chain: &mut Chain, kp: &Keypair, txs: &[Transaction]) {
    let (block, _) = mine_block(chain, kp.address(), txs).unwrap();
    chain.connect_block(block).unwrap();
}

#[test]
fn genesis_premine_and_subsidies() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params);
    let miner = Keypair::generate();

    // Genesis pays the 210,000 BLOCK premine.
    mine_and_connect(&mut chain, &miner, &[]);
    assert_eq!(chain.height(), Some(0));
    assert_eq!(chain.balance(&miner.address()), 210_000 * COIN);

    // Block 1 pays the 50 BLOCK subsidy.
    mine_and_connect(&mut chain, &miner, &[]);
    assert_eq!(chain.balance(&miner.address()), 210_050 * COIN);
}

#[test]
fn spend_premine_and_reject_bad_blocks() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params);
    let miner = Keypair::generate();
    let alice = Keypair::generate();

    mine_and_connect(&mut chain, &miner, &[]);

    // Build a tx spending the premine: 1000 BLOCK to alice, rest change, 0.001 fee.
    let (outpoint, entry) = chain.spendable_utxos(&miner.address()).pop().unwrap();
    let fee = COIN / 1000;
    let send = 1000 * COIN;
    let mut tx = Transaction {
        version: 1,
        inputs: vec![TxInput {
            prev: outpoint,
            pubkey: miner.public_bytes(),
            signature: vec![],
        }],
        outputs: vec![
            TxOutput { recipient: alice.address(), amount: send },
            TxOutput { recipient: miner.address(), amount: entry.output.amount - send - fee },
        ],
        coinbase_data: vec![],
        shielded: None,
            contract: None,
    };
    let sighash = tx.sighash();
    tx.inputs[0].signature = miner.sign(&sighash);

    let (block, included) = mine_block(&chain, miner.address(), &[tx.clone()]).unwrap();
    assert_eq!(included.len(), 1);
    chain.connect_block(block).unwrap();

    assert_eq!(chain.balance(&alice.address()), 1000 * COIN);
    // premine - send - fee + block1 subsidy(50) + block1-of-this-test coinbase... :
    // miner got premine (210,000), spent 1000 + fee, plus 50 subsidy + fee back as miner.
    assert_eq!(
        chain.balance(&miner.address()),
        210_000 * COIN - send - fee + 50 * COIN + fee
    );

    // A block with a bad signature must be rejected.
    let mut bad_tx = tx.clone();
    bad_tx.inputs[0].signature[0] ^= 1;
    // (the outpoint is already spent too — both reasons reject)
    let err = chain.check_transaction(&bad_tx, &chain.utxos, 2);
    assert!(err.is_err());

    // Tampering with a mined block must invalidate it.
    let (mut block, _) = mine_block(&chain, miner.address(), &[]).unwrap();
    block.transactions[0].outputs[0].amount += 1;
    assert!(chain.connect_block(block).is_err());
}

#[test]
fn full_chain_revalidates_from_storage() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params.clone());
    let miner = Keypair::generate();
    for _ in 0..4 {
        mine_and_connect(&mut chain, &miner, &[]);
    }
    let blocks = chain.blocks.clone();
    let rebuilt = Chain::from_blocks(params, blocks).unwrap();
    assert_eq!(rebuilt.height(), Some(3));
    assert_eq!(rebuilt.tip_hash(), chain.tip_hash());
    assert_eq!(rebuilt.balance(&miner.address()), chain.balance(&miner.address()));
}

#[test]
fn coinbase_maturity_enforced() {
    let params = ChainParams::regtest(); // maturity = 5
    let mut chain = Chain::new(params);
    let miner = Keypair::generate();

    mine_and_connect(&mut chain, &miner, &[]); // genesis (premine, exempt)
    mine_and_connect(&mut chain, &miner, &[]); // height 1 coinbase, matures at 6

    // Find the height-1 coinbase utxo and try to spend it immediately.
    let immature = chain
        .utxos
        .iter()
        .find(|(_, e)| e.coinbase && e.height == 1)
        .map(|(op, e)| (*op, e.clone()))
        .unwrap();
    let mut tx = Transaction {
        version: 1,
        inputs: vec![TxInput {
            prev: immature.0,
            pubkey: miner.public_bytes(),
            signature: vec![],
        }],
        outputs: vec![TxOutput { recipient: miner.address(), amount: immature.1.output.amount }],
        coinbase_data: vec![],
        shielded: None,
            contract: None,
    };
    let sighash = tx.sighash();
    tx.inputs[0].signature = miner.sign(&sighash);

    let err = chain.check_transaction(&tx, &chain.utxos, 2);
    assert!(matches!(err, Err(blockle_chain::ChainError::ImmatureSpend)));

    // spendable_utxos must exclude it but include the premine.
    let spendable = chain.spendable_utxos(&miner.address());
    assert_eq!(spendable.len(), 1);
    assert_eq!(spendable[0].1.height, 0);
}

// Shielded-pool consensus tests live in tests/shielded_integration.rs.
