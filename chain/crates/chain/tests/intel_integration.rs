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

#[test]
fn emission_epoch_distributes_and_claims() {
    // regtest clone with alpha=20%, epoch=4 so distribution happens fast.
    let mut p = ChainParams::regtest();
    p.intel_alpha_bps = 2_000;
    p.intel_epoch_len = 4;
    let mut chain = Chain::new(p);
    let f = Keypair::generate();
    let fee = COIN / 50;

    let tip = |chain: &mut Chain, txs: &[Transaction]| {
        let (b, _) = mine_block(chain, f.address(), txs).unwrap();
        chain.connect_block(b).unwrap();
    };
    let step = |chain: &mut Chain, action: ContractAction, bond: u64| {
        let tx = spend(chain, &f, action, bond, fee);
        let (b, _) = mine_block(chain, f.address(), &[tx]).unwrap();
        chain.connect_block(b).unwrap();
    };
    tip(&mut chain, &[]); // h0 genesis premine -> f

    // An EMPTY block at height 1 must pay only (1-α)=80% of the 50 subsidy to the coinbase.
    tip(&mut chain, &[]); // h1
    let cb = &chain.blocks[1].transactions[0];
    assert_eq!(cb.total_output().unwrap(), 40 * COIN, "coinbase α-split: 80% of 50");
    assert_eq!(chain.intel.pool, 10 * COIN, "withheld α accrued to the pool");

    // h2: register subnet; h3: miner neuron (uid 0); h4(boundary): validator neuron (uid 1, 10-BLOCK bond)
    step(&mut chain, ContractAction::Intel(IntelAction::SubnetRegister { schema: b"det".to_vec(), tier: 0, gas_limit: GAS }), 0); // h2
    step(&mut chain, ContractAction::Intel(IntelAction::NeuronRegister { subnet_id: 0, role: 0, hotkey: b"m".to_vec(), bond: COIN, gas_limit: GAS }), COIN); // h3 miner uid0
    step(&mut chain, ContractAction::Intel(IntelAction::NeuronRegister { subnet_id: 0, role: 1, hotkey: b"v".to_vec(), bond: 10 * COIN, gas_limit: GAS }), 10 * COIN); // h4 validator uid1
    assert_eq!(chain.intel.neurons.len(), 2);

    // h5: validator commits weights on the miner (uid 0); h6: reveal. Both inside the
    // h5..h8 epoch window so the h8 boundary processes them.
    let nonce = [7u8; 32];
    let uids = vec![0u32];
    let weights = vec![1_000_000u32]; // full weight (= SCALE)
    let commit = blockle_chain::intel::weights_commit(&uids, &weights, &nonce);
    step(&mut chain, ContractAction::Intel(IntelAction::SetWeightsCommit { subnet_id: 0, commit, gas_limit: GAS }), 0); // h5
    step(&mut chain, ContractAction::Intel(IntelAction::SetWeightsReveal { subnet_id: 0, uids: uids.clone(), weights: weights.clone(), nonce, gas_limit: GAS }), 0); // h6
    assert!(chain.intel.revealed.contains_key(&(0, 1)), "validator uid1 revealed");

    tip(&mut chain, &[]); // h7
    tip(&mut chain, &[]); // h8 -> EPOCH BOUNDARY: EmissionEpoch distributes the pool

    let credited = chain.intel.emission_ledger.get(&f.address()).copied().unwrap_or(0);
    assert!(credited > 0, "emission distributed to the neuron owner at the epoch boundary");
    assert!(chain.intel.pool < 10 * COIN, "pool drained by distribution (dust may remain)");
    assert!(chain.intel.revealed.is_empty(), "epoch cleared the revealed weights");

    // Claim pays the accrued emission out to f.
    step(&mut chain, ContractAction::Intel(IntelAction::NeuronClaim { gas_limit: GAS }), 0); // h9
    assert_eq!(
        chain.intel.emission_ledger.get(&f.address()).copied().unwrap_or(0),
        0,
        "ledger zeroed after claim"
    );

    // Replay determinism: the whole emission/claim history rebuilds identically.
    let rebuilt = Chain::from_blocks({ let mut q = ChainParams::regtest(); q.intel_alpha_bps = 2_000; q.intel_epoch_len = 4; q }, chain.blocks.clone()).unwrap();
    assert_eq!(rebuilt.intel, chain.intel, "intel emission state is deterministic on replay");
}
