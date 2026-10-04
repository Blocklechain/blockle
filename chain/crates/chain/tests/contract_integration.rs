//! Contract lifecycle through real mined blocks on regtest.

use blockle_chain::{contract_id, mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{ContractAction, Transaction, TxInput, TxOutput, COIN};
use blockle_vm::asm;

const COUNTER: &str = "
    ; add calldata u64 (or 1 if empty) to the counter at storage key 0
    PUSH 0
    PUSH 0
    CALLDATASIZE
    CALLDATACOPY
    PUSH 0
    MLOAD64             ; inc (0 when no calldata)
    DUP 0
    ISZERO
    PUSH @useone
    JUMPI
    PUSH @doadd
    JUMP
useone:
    POP
    PUSH 1
doadd:
    PUSH 64             ; key offset (32 zero bytes)
    PUSH 32             ; dst
    SLOAD
    POP
    PUSH 32
    MLOAD64             ; old value
    ADD
    PUSH 32
    SWAP 1
    MSTORE64
    PUSH 64
    PUSH 32
    PUSH 8
    SSTORE
    PUSH 32
    PUSH 8
    RETURN
";

const FAUCET: &str = "
    ; empty calldata: deposit (keep value). any calldata: pay 1 BLOCK to caller
    CALLDATASIZE
    PUSH @withdraw
    JUMPI
    STOP
withdraw:
    PUSH 0
    CALLER
    PUSH 0
    PUSH 100000000
    SEND
    STOP
";

fn gas_fee(params: &ChainParams, gas: u64) -> u64 {
    gas * params.gas_price
}

/// Build a signed tx spending the miner's richest utxo, with optional action.
fn build_tx(
    chain: &Chain,
    kp: &Keypair,
    fee: u64,
    action: Option<ContractAction>,
) -> Transaction {
    let mut utxos = chain.spendable_utxos(&kp.address());
    utxos.sort_by_key(|(_, e)| e.output.amount);
    let (outpoint, entry) = utxos.pop().expect("spendable utxo");
    let value = action.as_ref().map(|a| a.value()).unwrap_or(0);
    let change = entry.output.amount - fee - value;
    let mut tx = Transaction {
        version: 1,
        inputs: vec![TxInput { prev: outpoint, pubkey: kp.public_bytes(), signature: vec![] }],
        outputs: vec![TxOutput { recipient: kp.address(), amount: change }],
        coinbase_data: vec![],
        shielded: None,
        contract: action,
        settlement: None,
    };
    let sighash = tx.sighash();
    tx.inputs[0].signature = kp.sign(&sighash);
    tx
}

fn mine_with(chain: &mut Chain, kp: &Keypair, txs: &[Transaction]) -> usize {
    let (block, included) = mine_block(chain, kp.address(), txs).unwrap();
    let n = included.len();
    chain.connect_block(block).unwrap();
    n
}

#[test]
fn counter_deploy_and_call() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params.clone());
    let kp = Keypair::generate();
    mine_with(&mut chain, &kp, &[]); // genesis premine

    // Deploy the counter.
    let code = asm::assemble(COUNTER).unwrap();
    let gas = 100_000;
    let deploy = build_tx(
        &chain,
        &kp,
        gas_fee(&params, gas),
        Some(ContractAction::Deploy { code, gas_limit: gas }),
    );
    let deploy_txid = deploy.txid();
    assert_eq!(mine_with(&mut chain, &kp, &[deploy]), 1);
    let id = contract_id(&deploy_txid);
    assert!(chain.contracts.contains_key(&id), "contract deployed");

    // Call with +5.
    let call = build_tx(
        &chain,
        &kp,
        gas_fee(&params, gas),
        Some(ContractAction::Call {
            contract: id,
            input: 5u64.to_le_bytes().to_vec(),
            value: 0,
            gas_limit: gas,
        }),
    );
    assert_eq!(mine_with(&mut chain, &kp, &[call]), 1);
    let stored = chain.contract_storage.get(&(id, [0u8; 32])).unwrap();
    assert_eq!(u64::from_le_bytes(stored.clone().try_into().unwrap()), 5);

    // Call with empty input → +1.
    let call2 = build_tx(
        &chain,
        &kp,
        gas_fee(&params, gas),
        Some(ContractAction::Call { contract: id, input: vec![], value: 0, gas_limit: gas }),
    );
    assert_eq!(mine_with(&mut chain, &kp, &[call2]), 1);
    let stored = chain.contract_storage.get(&(id, [0u8; 32])).unwrap();
    assert_eq!(u64::from_le_bytes(stored.clone().try_into().unwrap()), 6);

    // Simulate (read-only): +10 would make 16, but state stays at 6.
    let sim = chain.simulate_call(&id, kp.address(), &10u64.to_le_bytes(), 0, gas);
    assert!(sim.success);
    assert_eq!(u64::from_le_bytes(sim.return_data.try_into().unwrap()), 16);
    let stored = chain.contract_storage.get(&(id, [0u8; 32])).unwrap();
    assert_eq!(u64::from_le_bytes(stored.clone().try_into().unwrap()), 6);
}

#[test]
fn faucet_value_and_payouts() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params.clone());
    let kp = Keypair::generate();
    mine_with(&mut chain, &kp, &[]);

    let code = asm::assemble(FAUCET).unwrap();
    let gas = 100_000;
    let deploy = build_tx(
        &chain,
        &kp,
        gas_fee(&params, gas),
        Some(ContractAction::Deploy { code, gas_limit: gas }),
    );
    let id = contract_id(&deploy.txid());
    mine_with(&mut chain, &kp, &[deploy]);

    // Deposit 10 BLOCK (empty calldata).
    let deposit = build_tx(
        &chain,
        &kp,
        gas_fee(&params, gas),
        Some(ContractAction::Call {
            contract: id,
            input: vec![],
            value: 10 * COIN,
            gas_limit: gas,
        }),
    );
    mine_with(&mut chain, &kp, &[deposit]);
    assert_eq!(chain.contracts.get(&id).unwrap().balance, 10 * COIN);

    // Withdraw: non-empty calldata pays 1 BLOCK to the caller as a UTXO.
    let before = chain.balance(&kp.address());
    let withdraw = build_tx(
        &chain,
        &kp,
        gas_fee(&params, gas),
        Some(ContractAction::Call { contract: id, input: vec![1], value: 0, gas_limit: gas }),
    );
    let wfee = gas_fee(&params, gas);
    mine_with(&mut chain, &kp, &[withdraw]);
    assert_eq!(chain.contracts.get(&id).unwrap().balance, 9 * COIN);
    // miner == sender here: -fee +fee(coinbase) +subsidy +1 BLOCK payout
    assert_eq!(chain.balance(&kp.address()), before + 50 * COIN + COIN);
    let _ = wfee;

    // Failed call (missing contract) refunds attached value to the sender.
    let before = chain.balance(&kp.address());
    let bogus = build_tx(
        &chain,
        &kp,
        gas_fee(&params, gas),
        Some(ContractAction::Call {
            contract: [0xee; 32],
            input: vec![],
            value: 3 * COIN,
            gas_limit: gas,
        }),
    );
    mine_with(&mut chain, &kp, &[bogus]);
    // value refunded; net change is just the subsidy (fee returns via coinbase).
    assert_eq!(chain.balance(&kp.address()), before + 50 * COIN);
}
