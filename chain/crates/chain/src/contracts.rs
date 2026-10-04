//! Contract state and deterministic execution of contract actions.
//!
//! Model: contracts hold account-style balances and keyed storage inside
//! chain state; the UTXO world bridges in via `Call.value` (inputs → contract
//! balance) and back out via the `SEND` host op, which mints payout UTXOs
//! under a txid derived from the calling transaction. Gas is prepaid through
//! the fee, so failed executions change nothing except refunding any attached
//! value to the sender.

use std::collections::HashMap;

use blockle_core::hash::{blake2b_256_personal, Hash32};
use blockle_core::{ContractAction, Transaction};
use blockle_vm as vm;

/// Deploy cost: base + per-byte of stored code (charged against gas_limit).
pub const DEPLOY_GAS_BASE: u64 = 100;
pub const DEPLOY_GAS_PER_BYTE: u64 = 10;

#[derive(Clone, Debug)]
pub struct ContractInfo {
    pub code: Vec<u8>,
    pub balance: u64,
}

pub type ContractMap = HashMap<Hash32, ContractInfo>;
pub type StorageMap = HashMap<(Hash32, [u8; 32]), Vec<u8>>;

/// A deployed contract's id, derived from the deploying transaction.
pub fn contract_id(txid: &Hash32) -> Hash32 {
    blake2b_256_personal(b"BlklCntr", txid)
}

/// The synthetic txid under which a call's payout/refund outputs are created.
pub fn payout_txid(txid: &Hash32) -> Hash32 {
    blake2b_256_personal(b"BlklPout", txid)
}

/// Host implementation that stages all effects; nothing touches real state
/// unless the caller commits.
struct StagingHost<'a> {
    contract: Hash32,
    balance: u64,
    base: &'a StorageMap,
    overlay: HashMap<[u8; 32], Vec<u8>>,
    payouts: Vec<([u8; 32], u64)>,
    logs: Vec<Vec<u8>>,
}

impl vm::Host for StagingHost<'_> {
    fn storage_get(&self, key: &[u8; 32]) -> Option<Vec<u8>> {
        if let Some(v) = self.overlay.get(key) {
            return Some(v.clone());
        }
        self.base.get(&(self.contract, *key)).cloned()
    }

    fn storage_set(&mut self, key: [u8; 32], value: Vec<u8>) {
        self.overlay.insert(key, value);
    }

    fn send(&mut self, recipient: [u8; 32], amount: u64) -> Result<(), vm::VmError> {
        if amount > self.balance {
            return Err(vm::VmError::SendFailed);
        }
        self.balance -= amount;
        self.payouts.push((recipient, amount));
        Ok(())
    }

    fn balance(&self) -> u64 {
        self.balance
    }

    fn log(&mut self, data: &[u8]) {
        self.logs.push(data.to_vec());
    }

    /// Protocol spend-proof verification as a contract primitive.
    /// `public_inputs = root(32) ‖ nullifier(32) ‖ value_le(8) ‖ binding(32)`.
    fn zk_verify(&self, proof: &[u8], public_inputs: &[u8]) -> bool {
        if public_inputs.len() != 104 {
            return false;
        }
        let root: [u8; 32] = public_inputs[..32].try_into().expect("32");
        let nullifier: [u8; 32] = public_inputs[32..64].try_into().expect("32");
        let value = u64::from_le_bytes(public_inputs[64..72].try_into().expect("8"));
        let binding: [u8; 32] = public_inputs[72..].try_into().expect("32");
        let (Ok(root), Ok(nullifier)) = (
            blockle_zk::bytes_to_felts(&root),
            blockle_zk::bytes_to_felts(&nullifier),
        ) else {
            return false;
        };
        blockle_zk::verify_spend(
            proof,
            root,
            nullifier,
            blockle_zk::BaseElement::new(value as u128),
            blockle_zk::bytes_to_felts_reduced(&binding),
        )
    }
}

/// What a call execution produced (also used by `simulate`).
pub struct CallResult {
    pub success: bool,
    pub gas_used: u64,
    pub return_data: Vec<u8>,
    pub logs: Vec<Vec<u8>>,
    pub payouts: Vec<([u8; 32], u64)>,
}

/// Execute a call against the given state, staging effects. On success the
/// staged storage/balance changes are written into `contracts`/`storage` and
/// payouts are returned; on failure nothing is written and the refund payout
/// (attached value back to `sender`) is returned instead.
#[allow(clippy::too_many_arguments)]
pub fn execute_call(
    contract: &Hash32,
    input: &[u8],
    value: u64,
    gas_limit: u64,
    sender: [u8; 32],
    height: u64,
    contracts: &mut ContractMap,
    storage: &mut StorageMap,
) -> CallResult {
    let fail = |gas_used| CallResult {
        success: false,
        gas_used,
        return_data: vec![],
        logs: vec![],
        payouts: if value > 0 { vec![(sender, value)] } else { vec![] },
    };

    let Some(info) = contracts.get(contract) else {
        return fail(0);
    };
    let code = info.code.clone();
    let mut host = StagingHost {
        contract: *contract,
        balance: info.balance.saturating_add(value),
        base: storage,
        overlay: HashMap::new(),
        payouts: Vec::new(),
        logs: Vec::new(),
    };
    let ctx = vm::Context { caller: sender, contract: *contract, value, height };
    match vm::execute(&code, input, &ctx, &mut host, gas_limit) {
        Ok(vm::Receipt { gas_used, outcome: vm::Outcome::Return(data) }) => {
            let StagingHost { balance, overlay, payouts, logs, .. } = host;
            for (key, val) in overlay {
                storage.insert((*contract, key), val);
            }
            contracts.get_mut(contract).expect("exists").balance = balance;
            CallResult { success: true, gas_used, return_data: data, logs, payouts }
        }
        Ok(vm::Receipt { gas_used, outcome: vm::Outcome::Revert(_) }) => fail(gas_used),
        Err(_) => fail(gas_limit),
    }
}

/// Deterministically apply a transaction's contract action to staged state.
/// Returns payout outputs `(address, amount)` to be minted as UTXOs under
/// [`payout_txid`]. Never fails: user-level failures burn the prepaid gas and
/// leave state untouched (minus value refunds).
pub fn apply_contract_action(
    tx: &Transaction,
    txid: &Hash32,
    height: u64,
    contracts: &mut ContractMap,
    storage: &mut StorageMap,
) -> Vec<([u8; 32], u64)> {
    let Some(action) = &tx.contract else {
        return vec![];
    };
    match action {
        ContractAction::Deploy { code, gas_limit } => {
            let cost = DEPLOY_GAS_BASE
                .saturating_add(DEPLOY_GAS_PER_BYTE.saturating_mul(code.len() as u64));
            if cost <= *gas_limit {
                contracts.insert(
                    contract_id(txid),
                    ContractInfo { code: code.clone(), balance: 0 },
                );
            }
            vec![]
        }
        ContractAction::Call { contract, input, value, gas_limit } => {
            // Non-coinbase is guaranteed by validation, so inputs exist.
            let sender =
                blockle_core::keys::pubkey_to_address(&tx.inputs[0].pubkey);
            let result = execute_call(
                contract, input, *value, *gas_limit, sender, height, contracts, storage,
            );
            result.payouts
        }
    }
}
