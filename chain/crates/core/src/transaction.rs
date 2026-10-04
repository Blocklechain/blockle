//! Blockle's transaction model: a note/output system (UTXO-style) with a
//! reserved shielded bundle so the privacy milestone extends the same wire
//! format instead of forking it.

use serde::{Deserialize, Serialize};

use crate::encode::{put_bytes, put_fixed, put_u32, put_u64};
use crate::hash::{blake2b_256, Hash32};
use crate::keys::Address;

/// Reference to a transaction output being spent.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct OutPoint {
    pub txid: Hash32,
    pub vout: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TxInput {
    pub prev: OutPoint,
    /// ML-DSA-44 public key whose hash must match the spent output's address.
    pub pubkey: Vec<u8>,
    /// ML-DSA-44 signature over the transaction sighash. Empty while unsigned.
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TxOutput {
    pub recipient: Address,
    pub amount: u64,
}

/// A shielded spend: consumes a note from the commitment tree.
///
/// Reveals the nullifier (double-spend tag) and the note's value; the STARK
/// proof shows the note exists under `anchor` without revealing which one.
/// The proof is excluded from the sighash (it *binds* the sighash via the
/// proof transcript instead).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShieldedSpend {
    /// A historical note-tree root this spend proves membership against.
    pub anchor: Hash32,
    pub nullifier: Hash32,
    pub value: u64,
    pub proof: Vec<u8>,
}

/// A shielded output: appends a note commitment to the tree.
/// The value is public in protocol v1 (ownership privacy, not amount
/// privacy); the note secrets travel to the recipient out of band.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShieldedOutput {
    pub commitment: Hash32,
    pub value: u64,
}

/// A fully-shielded transfer: spends one note into two new notes (payment +
/// change) with **hidden values** — only the fee is public. The STARK proves
/// value conservation. `memo` carries the recipient's encrypted note secrets
/// (opaque to consensus, bound by the sighash).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShieldedTransfer {
    pub anchor: Hash32,
    pub nullifier: Hash32,
    pub commitment1: Hash32,
    pub commitment2: Hash32,
    pub fee: u64,
    pub memo: Vec<u8>,
    pub proof: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShieldedBundle {
    pub spends: Vec<ShieldedSpend>,
    pub outputs: Vec<ShieldedOutput>,
    /// Hidden-amount z→z transfers.
    #[serde(default)]
    pub transfers: Vec<ShieldedTransfer>,
}

/// A Blockle VM action carried by a transaction. Gas is prepaid: consensus
/// requires `fee >= gas_limit * gas_price`, whether or not execution
/// succeeds or uses less.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ContractAction {
    /// Store `code` as a new contract. The contract id is derived from the
    /// deploying txid.
    Deploy { code: Vec<u8>, gas_limit: u64 },
    /// Execute a deployed contract. `value` moves from this transaction's
    /// inputs into the contract's balance before execution (refunded to the
    /// sender if the call fails).
    Call { contract: Hash32, input: Vec<u8>, value: u64, gas_limit: u64 },
}

impl ContractAction {
    pub fn gas_limit(&self) -> u64 {
        match self {
            ContractAction::Deploy { gas_limit, .. } => *gas_limit,
            ContractAction::Call { gas_limit, .. } => *gas_limit,
        }
    }

    pub fn value(&self) -> u64 {
        match self {
            ContractAction::Deploy { .. } => 0,
            ContractAction::Call { value, .. } => *value,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Transaction {
    pub version: u32,
    /// Empty for coinbase transactions.
    pub inputs: Vec<TxInput>,
    pub outputs: Vec<TxOutput>,
    /// Coinbase-only payload (block height + arbitrary tag); makes coinbase
    /// txids unique. Must be empty for regular transactions.
    pub coinbase_data: Vec<u8>,
    pub shielded: Option<ShieldedBundle>,
    /// Optional Blockle VM deploy/call.
    #[serde(default)]
    pub contract: Option<ContractAction>,
}

impl Transaction {
    /// Coinbase: no transparent inputs, no shielded bundle, and no
    /// (the other input-less transaction kind).
    pub fn is_coinbase(&self) -> bool {
        self.inputs.is_empty() && self.shielded.is_none()
    }

    /// Total value entering from the shielded pool.
    pub fn shielded_in(&self) -> Option<u64> {
        self.shielded.as_ref().map_or(Some(0), |b| {
            b.spends.iter().try_fold(0u64, |acc, s| acc.checked_add(s.value))
        })
    }

    /// Total value leaving into the shielded pool.
    pub fn shielded_out(&self) -> Option<u64> {
        self.shielded.as_ref().map_or(Some(0), |b| {
            b.outputs.iter().try_fold(0u64, |acc, o| acc.checked_add(o.value))
        })
    }

    /// Fees paid by hidden-amount transfers (their only public value flow).
    pub fn transfer_fees(&self) -> Option<u64> {
        self.shielded.as_ref().map_or(Some(0), |b| {
            b.transfers.iter().try_fold(0u64, |acc, t| acc.checked_add(t.fee))
        })
    }

    /// All nullifiers this transaction reveals.
    pub fn nullifiers(&self) -> Vec<Hash32> {
        self.shielded
            .as_ref()
            .map(|b| {
                b.spends
                    .iter()
                    .map(|s| s.nullifier)
                    .chain(b.transfers.iter().map(|t| t.nullifier))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Canonical consensus encoding. With `for_sighash` set, signatures are
    /// replaced by empty strings so inputs can be signed.
    pub fn encode(&self, for_sighash: bool) -> Vec<u8> {
        let mut out = Vec::new();
        put_u32(&mut out, self.version);
        put_u32(&mut out, self.inputs.len() as u32);
        for input in &self.inputs {
            put_fixed(&mut out, &input.prev.txid);
            put_u32(&mut out, input.prev.vout);
            put_bytes(&mut out, &input.pubkey);
            if for_sighash {
                put_bytes(&mut out, &[]);
            } else {
                put_bytes(&mut out, &input.signature);
            }
        }
        put_u32(&mut out, self.outputs.len() as u32);
        for output in &self.outputs {
            put_fixed(&mut out, &output.recipient);
            put_u64(&mut out, output.amount);
        }
        put_bytes(&mut out, &self.coinbase_data);
        match &self.shielded {
            None => put_u32(&mut out, 0),
            Some(s) => {
                put_u32(&mut out, 1);
                put_u32(&mut out, s.spends.len() as u32);
                for spend in &s.spends {
                    put_fixed(&mut out, &spend.anchor);
                    put_fixed(&mut out, &spend.nullifier);
                    put_u64(&mut out, spend.value);
                    // Like signatures, proofs are excluded from the sighash:
                    // each proof binds the sighash through its transcript.
                    if for_sighash {
                        put_bytes(&mut out, &[]);
                    } else {
                        put_bytes(&mut out, &spend.proof);
                    }
                }
                put_u32(&mut out, s.outputs.len() as u32);
                for output in &s.outputs {
                    put_fixed(&mut out, &output.commitment);
                    put_u64(&mut out, output.value);
                }
                put_u32(&mut out, s.transfers.len() as u32);
                for t in &s.transfers {
                    put_fixed(&mut out, &t.anchor);
                    put_fixed(&mut out, &t.nullifier);
                    put_fixed(&mut out, &t.commitment1);
                    put_fixed(&mut out, &t.commitment2);
                    put_u64(&mut out, t.fee);
                    put_bytes(&mut out, &t.memo);
                    if for_sighash {
                        put_bytes(&mut out, &[]);
                    } else {
                        put_bytes(&mut out, &t.proof);
                    }
                }
            }
        }
        match &self.contract {
            None => put_u32(&mut out, 0),
            Some(ContractAction::Deploy { code, gas_limit }) => {
                put_u32(&mut out, 1);
                put_bytes(&mut out, code);
                put_u64(&mut out, *gas_limit);
            }
            Some(ContractAction::Call { contract, input, value, gas_limit }) => {
                put_u32(&mut out, 2);
                put_fixed(&mut out, contract);
                put_bytes(&mut out, input);
                put_u64(&mut out, *value);
                put_u64(&mut out, *gas_limit);
            }
        }
        out
    }

    pub fn txid(&self) -> Hash32 {
        blake2b_256(&self.encode(false))
    }

    /// The message each input signs: the transaction with signatures blanked.
    pub fn sighash(&self) -> Hash32 {
        blake2b_256(&self.encode(true))
    }

    pub fn total_output(&self) -> Option<u64> {
        self.outputs
            .iter()
            .try_fold(0u64, |acc, o| acc.checked_add(o.amount))
    }

    pub fn serialized_size(&self) -> usize {
        self.encode(false).len()
    }

    /// Build a coinbase transaction paying `recipient` at `height`.
    pub fn coinbase(height: u64, recipient: Address, amount: u64, tag: &[u8]) -> Self {
        let mut coinbase_data = height.to_le_bytes().to_vec();
        coinbase_data.extend_from_slice(tag);
        Transaction {
            version: 1,
            inputs: vec![],
            outputs: vec![TxOutput { recipient, amount }],
            coinbase_data,
            shielded: None,
            contract: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Keypair;

    #[test]
    fn txid_changes_with_content_sighash_ignores_sigs() {
        let kp = Keypair::generate();
        let mut tx = Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev: OutPoint { txid: [1; 32], vout: 0 },
                pubkey: kp.public_bytes(),
                signature: vec![],
            }],
            outputs: vec![TxOutput { recipient: kp.address(), amount: 42 }],
            coinbase_data: vec![],
            shielded: None,
            contract: None,
        };
        let sighash_before = tx.sighash();
        let txid_before = tx.txid();
        tx.inputs[0].signature = kp.sign(&sighash_before).to_vec();
        assert_eq!(tx.sighash(), sighash_before, "sighash must ignore signatures");
        assert_ne!(tx.txid(), txid_before, "txid commits to signatures");

        tx.outputs[0].amount = 43;
        assert_ne!(tx.sighash(), sighash_before);
    }

    #[test]
    fn coinbase_txids_unique_per_height() {
        let addr = [9u8; 32];
        let a = Transaction::coinbase(1, addr, 50, b"blockle");
        let b = Transaction::coinbase(2, addr, 50, b"blockle");
        assert!(a.is_coinbase());
        assert_ne!(a.txid(), b.txid());
    }
}
