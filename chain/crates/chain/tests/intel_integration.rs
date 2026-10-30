//! Blockle Intelligence Phase-2a consensus integration tests.
//!
//! Proves the new height-gated actions end-to-end THROUGH connect_block (so the state
//! is really committed by consensus), and that the height gate rejects them below
//! `intel_activation_height` — the backwards-compatibility guarantee.

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::transaction::{ContractAction, IntelAction};
use blockle_core::{OutPoint, Transaction, TxInput, TxOutput, COIN};

const GAS: u64 = 100_000; // gas_cost = GAS * gas_price(10) = 1_000_000

fn spend(chain: &Chain, kp: &Keypair, action: ContractAction, bond: u64, fee: u64) -> Transaction {
    let (outpoint, entry) = chain.spendable_utxos(&kp.address()).pop().expect("spendable utxo");
    let change = entry.output.amount - bond - fee;
    let mut tx = Transaction {
        version: 1,
        inputs: vec![TxInput { prev: outpoint, pubkey: kp.public_bytes(), signature: vec![] }],
        outputs: vec![TxOutput { recipient: kp.address(), amount: change }],
        coinbase_data: vec![],
        shielded: None,
        contract: Some(action),
    };
    let sighash = tx.sighash();
    tx.inputs[0].signature = kp.sign(&sighash);
    tx
}

#[test]
fn register_subnet_and_neuron_through_consensus() {
    // regtest: intel_activation_height = 0, so actions are live from genesis.
    let mut chain = Chain::new(ChainParams::regtest());
    let miner = Keypair::generate();
    let (b0, _) = mine_block(&chain, miner.address(), &[]).unwrap();
    chain.connect_block(b0).unwrap(); // genesis premine -> miner

    // 1) register a Tier-0 subnet
    let reg = spend(
        &chain,
        &miner,
        ContractAction::Intel(IntelAction::SubnetRegister { schema: b"embeddings".to_vec(), tier: 0, gas_limit: GAS }),
        0,
        COIN / 50,
    );
    let (b1, inc) = mine_block(&chain, miner.address(), &[reg]).unwrap();
    assert_eq!(inc.len(), 1, "subnet-register tx included");
    chain.connect_block(b1).unwrap();
    assert_eq!(chain.intel.subnets.len(), 1, "subnet committed by consensus");
    assert_eq!(chain.intel.subnets[0].tier, 0);
    assert_eq!(chain.intel.subnets[0].creator, miner.address());

    // 2) register a miner neuron with a 5-BLOCK bond
    let bond = 5 * COIN;
    let nr = spend(
        &chain,
        &miner,
        ContractAction::Intel(IntelAction::NeuronRegister { subnet_id: 0, role: 0, hotkey: b"hk1".to_vec(), bond, gas_limit: GAS }),
        bond,
        COIN / 50,
    );
    let (b2, inc) = mine_block(&chain, miner.address(), &[nr]).unwrap();
    assert_eq!(inc.len(), 1, "neuron-register tx included");
    chain.connect_block(b2).unwrap();
    assert_eq!(chain.intel.neurons.len(), 1, "neuron committed by consensus");
    assert_eq!(chain.intel.neurons[0].bond, bond);
    assert_eq!(chain.intel.neurons[0].owner, miner.address());

    // the chain still rebuilds identically from its blocks (replay-safe state)
    let rebuilt = Chain::from_blocks(ChainParams::regtest(), chain.blocks.clone()).unwrap();
    assert_eq!(rebuilt.intel, chain.intel, "intel state is deterministic on replay");
}

#[test]
fn intel_actions_rejected_below_activation_height() {
    // A chain whose intel actions don't activate until height 100.
    let mut params = ChainParams::regtest();
    params.intel_activation_height = 100;
    let mut chain = Chain::new(params);
    let miner = Keypair::generate();
    let (b0, _) = mine_block(&chain, miner.address(), &[]).unwrap();
    chain.connect_block(b0).unwrap();

    let tx = spend(
        &chain,
        &miner,
        ContractAction::Intel(IntelAction::SubnetRegister { schema: vec![], tier: 0, gas_limit: GAS }),
        0,
        COIN / 50,
    );
    // check_transaction takes an explicit height — below H it must reject...
    assert!(chain.check_transaction(&tx, &chain.utxos, 50).is_err(), "rejected below H_INTEL");
    // ...and at/above H it validates (returns a fee).
    assert!(chain.check_transaction(&tx, &chain.utxos, 150).is_ok(), "accepted at/above H_INTEL");
}
