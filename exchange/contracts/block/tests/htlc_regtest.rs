//! End-to-end HTLC lifecycle on a real regtest chain: deploy, lock (with value),
//! then either claim with the preimage (happy path, fee taken) or refund after
//! the timelock (failure path). Mirrors the pattern in
//! `chain/crates/chain/tests/contract_integration.rs`.

use blockle_chain::{contract_id, mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{ContractAction, Transaction, TxInput, TxOutput, COIN};
use blockle_htlc::{
    blake2b256, htlc_bytecode, lock_calldata, refund_calldata, withdraw_calldata, DEFAULT_FEE_BPS,
};

const GAS: u64 = 300_000;

fn gas_fee(params: &ChainParams) -> u64 {
    GAS * params.gas_price
}

fn build_tx(chain: &Chain, kp: &Keypair, fee: u64, action: Option<ContractAction>) -> Transaction {
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

/// Deploy the HTLC and return its contract id.
fn deploy_htlc(chain: &mut Chain, kp: &Keypair, params: &ChainParams, fee_addr: [u8; 32]) -> [u8; 32] {
    let code = htlc_bytecode(&fee_addr, DEFAULT_FEE_BPS);
    let deploy = build_tx(
        chain,
        kp,
        gas_fee(params),
        Some(ContractAction::Deploy { code, gas_limit: GAS }),
    );
    let txid = deploy.txid();
    assert_eq!(mine_with(chain, kp, &[deploy]), 1);
    let id = contract_id(&txid);
    assert!(chain.contracts.contains_key(&id), "HTLC deployed");
    id
}

#[test]
fn claim_path_pays_receiver_and_fee() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params.clone());
    let maker = Keypair::generate();
    mine_with(&mut chain, &maker, &[]); // premine to the maker

    let receiver = Keypair::generate();
    let fee_addr = [0x11u8; 32];
    let id = deploy_htlc(&mut chain, &maker, &params, fee_addr);

    // Secret preimage and its BLAKE2B hashlock.
    let preimage = b"correct horse battery staple".to_vec();
    let hashlock = blake2b256(&preimage);

    // Lock 10 BLOCK for the receiver, timelock far in the future.
    let amount = 10 * COIN;
    let timelock = chain.height().unwrap_or(0) + 1000;
    let lock = build_tx(
        &chain,
        &maker,
        gas_fee(&params),
        Some(ContractAction::Call {
            contract: id,
            input: lock_calldata(&receiver.address(), &hashlock, timelock),
            value: amount,
            gas_limit: GAS,
        }),
    );
    mine_with(&mut chain, &maker, &[lock]);
    assert_eq!(chain.contracts.get(&id).unwrap().balance, amount, "amount locked in contract");

    // A WRONG preimage must not move funds (call reverts; value 0 so nothing changes).
    let bad = build_tx(
        &chain,
        &maker,
        gas_fee(&params),
        Some(ContractAction::Call {
            contract: id,
            input: withdraw_calldata(b"wrong secret"),
            value: 0,
            gas_limit: GAS,
        }),
    );
    mine_with(&mut chain, &maker, &[bad]);
    assert_eq!(chain.contracts.get(&id).unwrap().balance, amount, "wrong preimage: still locked");

    // Correct preimage: receiver is paid amount - fee, fee address gets the fee.
    let recv_before = chain.balance(&receiver.address());
    let fee_before = chain.balance(&fee_addr);
    let claim = build_tx(
        &chain,
        &maker,
        gas_fee(&params),
        Some(ContractAction::Call {
            contract: id,
            input: withdraw_calldata(&preimage),
            value: 0,
            gas_limit: GAS,
        }),
    );
    mine_with(&mut chain, &maker, &[claim]);

    let fee = amount * DEFAULT_FEE_BPS / 10_000;
    let payout = amount - fee;
    assert_eq!(chain.contracts.get(&id).unwrap().balance, 0, "contract drained");
    assert_eq!(chain.balance(&receiver.address()), recv_before + payout, "receiver paid net");
    assert_eq!(chain.balance(&fee_addr), fee_before + fee, "fee address paid fee");

    // Double-claim is rejected (state no longer LOCKED).
    let recv_after = chain.balance(&receiver.address());
    let again = build_tx(
        &chain,
        &maker,
        gas_fee(&params),
        Some(ContractAction::Call {
            contract: id,
            input: withdraw_calldata(&preimage),
            value: 0,
            gas_limit: GAS,
        }),
    );
    mine_with(&mut chain, &maker, &[again]);
    assert_eq!(chain.balance(&receiver.address()), recv_after, "no second payout");
}

#[test]
fn refund_path_returns_to_sender_after_timelock() {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params.clone());
    let maker = Keypair::generate();
    mine_with(&mut chain, &maker, &[]);

    let receiver = Keypair::generate();
    let id = deploy_htlc(&mut chain, &maker, &params, [0x22u8; 32]);

    let preimage = b"never revealed".to_vec();
    let hashlock = blake2b256(&preimage);
    let amount = 7 * COIN;
    // Short timelock so we can pass it in the test.
    let timelock = chain.height().unwrap_or(0) + 3;
    let lock = build_tx(
        &chain,
        &maker,
        gas_fee(&params),
        Some(ContractAction::Call {
            contract: id,
            input: lock_calldata(&receiver.address(), &hashlock, timelock),
            value: amount,
            gas_limit: GAS,
        }),
    );
    mine_with(&mut chain, &maker, &[lock]);
    assert_eq!(chain.contracts.get(&id).unwrap().balance, amount);

    // Refund BEFORE the timelock must fail (funds stay locked).
    let early = build_tx(
        &chain,
        &maker,
        gas_fee(&params),
        Some(ContractAction::Call {
            contract: id,
            input: refund_calldata(),
            value: 0,
            gas_limit: GAS,
        }),
    );
    mine_with(&mut chain, &maker, &[early]);
    assert_eq!(chain.contracts.get(&id).unwrap().balance, amount, "early refund blocked");

    // Advance past the timelock.
    while chain.height().unwrap_or(0) < timelock {
        mine_with(&mut chain, &maker, &[]);
    }

    // Refund now succeeds: full amount back to the maker (sender), no fee.
    let maker_before = chain.balance(&maker.address());
    let refund = build_tx(
        &chain,
        &maker,
        gas_fee(&params),
        Some(ContractAction::Call {
            contract: id,
            input: refund_calldata(),
            value: 0,
            gas_limit: GAS,
        }),
    );
    mine_with(&mut chain, &maker, &[refund]);
    assert_eq!(chain.contracts.get(&id).unwrap().balance, 0, "contract drained on refund");
    // maker is also the miner: +subsidy +fee-returned-via-coinbase +amount refund.
    assert_eq!(
        chain.balance(&maker.address()),
        maker_before + 50 * COIN + amount,
        "sender refunded in full"
    );
}
