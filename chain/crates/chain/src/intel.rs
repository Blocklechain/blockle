//! Blockle Intelligence — on-chain state + native action apply logic (Phase 2a).
//!
//! Mirrors the Pool* native-action pattern in `chain.rs`: `apply_intel_action` mutates
//! the staged `IntelState` and returns any BLOCK payouts (refunds), which the caller
//! turns into UTXOs. Height-gating (reject below `intel_activation_height`) lives in
//! `Chain::check_transaction`; this module only runs for already-gated, structurally
//! valid txs. The emission math (EmissionEpoch) lives in `intel_consensus.rs`.
//!
//! Scope of 2a: SubnetRegister + NeuronRegister (registry + bonded stake). Weight
//! commit/reveal, proof-of-validation, the coinbase α-split and EmissionEpoch land in
//! a following increment.

use blockle_core::keys::pubkey_to_address;
use blockle_core::transaction::{IntelAction, Transaction};

/// A subnet = a task market (see spec §2). Tier: 0 checkable, 1 redundant/reference,
/// 2 subjective.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subnet {
    pub id: u32,
    pub schema: Vec<u8>,
    pub tier: u8,
    pub creator: [u8; 32],
    pub created_height: u64,
}

/// A neuron = a registered participant. role: 0 miner, 1 validator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Neuron {
    pub subnet_id: u32,
    pub uid: u32,
    pub role: u8,
    pub hotkey: Vec<u8>,
    pub owner: [u8; 32],
    /// Locked BLOCK bond (recoverable via Unbond in a later increment).
    pub bond: u64,
    pub registered_height: u64,
}

/// All Blockle Intelligence consensus state. Cloned into the connect_block scratch set
/// and committed like every other state map, so it is fully part of consensus.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IntelState {
    pub subnets: Vec<Subnet>,
    pub neurons: Vec<Neuron>,
}

impl IntelState {
    pub fn subnet(&self, id: u32) -> Option<&Subnet> {
        self.subnets.get(id as usize)
    }
    /// Count of neurons already registered in a subnet (used to assign the next uid).
    fn neuron_count(&self, subnet_id: u32) -> u32 {
        self.neurons.iter().filter(|n| n.subnet_id == subnet_id).count() as u32
    }
}

/// Apply a native intelligence action to the staged state. Returns BLOCK payouts
/// (refunds of the action's `value()` when it cannot execute) — identical contract to
/// `pools::apply_pool_action`. Never panics: a malformed/invalid action refunds its
/// bond rather than aborting the block.
pub fn apply_intel_action(
    intel: &mut IntelState,
    action: &IntelAction,
    tx: &Transaction,
    height: u64,
) -> Vec<([u8; 32], u64)> {
    // A contract action always has a transparent input (enforced in check_transaction).
    let sender = match tx.inputs.first() {
        Some(i) => pubkey_to_address(&i.pubkey),
        None => return Vec::new(),
    };
    match action {
        IntelAction::SubnetRegister { schema, tier, .. } => {
            // Bound the schema so a subnet can't bloat state; oversized → no-op.
            if schema.len() > 4_096 {
                return Vec::new();
            }
            let id = intel.subnets.len() as u32;
            intel.subnets.push(Subnet {
                id,
                schema: schema.clone(),
                tier: (*tier).min(2),
                creator: sender,
                created_height: height,
            });
            Vec::new()
        }
        IntelAction::NeuronRegister { subnet_id, role, hotkey, bond, .. } => {
            // Invalid subnet or oversized hotkey → refund the bond, no state change.
            if intel.subnet(*subnet_id).is_none() || hotkey.len() > 256 {
                return vec![(sender, *bond)];
            }
            let uid = intel.neuron_count(*subnet_id);
            intel.neurons.push(Neuron {
                subnet_id: *subnet_id,
                uid,
                role: (*role).min(1),
                hotkey: hotkey.clone(),
                owner: sender,
                bond: *bond,
                registered_height: height,
            });
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blockle_core::keys::Keypair;
    use blockle_core::transaction::{OutPoint, Transaction, TxInput};

    // Build a throwaway tx with one (unsigned — apply doesn't verify sigs) input from
    // `kp`, so apply_intel_action can read the sender address from the pubkey.
    fn tx_from(kp: &Keypair) -> Transaction {
        Transaction {
            version: 1,
            inputs: vec![TxInput {
                prev: OutPoint { txid: [0u8; 32], vout: 0 },
                pubkey: kp.public_bytes(),
                signature: vec![],
            }],
            outputs: vec![],
            coinbase_data: vec![],
            shielded: None,
            contract: None,
        }
    }

    #[test]
    fn subnet_then_neuron_register() {
        let kp = Keypair::generate();
        let addr = blockle_core::keys::pubkey_to_address(&kp.public_bytes());
        let tx = tx_from(&kp);
        let mut st = IntelState::default();

        let refund = apply_intel_action(
            &mut st,
            &IntelAction::SubnetRegister { schema: b"embeddings".to_vec(), tier: 0, gas_limit: 1000 },
            &tx,
            10,
        );
        assert!(refund.is_empty());
        assert_eq!(st.subnets.len(), 1);
        assert_eq!(st.subnets[0].tier, 0);
        assert_eq!(st.subnets[0].creator, addr);

        let refund = apply_intel_action(
            &mut st,
            &IntelAction::NeuronRegister { subnet_id: 0, role: 0, hotkey: b"hk".to_vec(), bond: 5_000, gas_limit: 1000 },
            &tx,
            11,
        );
        assert!(refund.is_empty(), "valid register should not refund");
        assert_eq!(st.neurons.len(), 1);
        assert_eq!(st.neurons[0].bond, 5_000);
        assert_eq!(st.neurons[0].uid, 0);
        assert_eq!(st.neurons[0].owner, addr);
    }

    #[test]
    fn neuron_register_bad_subnet_refunds_bond() {
        let kp = Keypair::generate();
        let addr = blockle_core::keys::pubkey_to_address(&kp.public_bytes());
        let tx = tx_from(&kp);
        let mut st = IntelState::default();
        // no subnet 7 exists -> bond must be refunded, no neuron created
        let refund = apply_intel_action(
            &mut st,
            &IntelAction::NeuronRegister { subnet_id: 7, role: 1, hotkey: b"x".to_vec(), bond: 9_000, gas_limit: 1000 },
            &tx,
            5,
        );
        assert_eq!(refund, vec![(addr, 9_000)]);
        assert!(st.neurons.is_empty());
    }

    #[test]
    fn uids_increment_per_subnet() {
        let kp = Keypair::generate();
        let tx = tx_from(&kp);
        let mut st = IntelState::default();
        apply_intel_action(&mut st, &IntelAction::SubnetRegister { schema: vec![], tier: 1, gas_limit: 1 }, &tx, 1);
        for _ in 0..3 {
            apply_intel_action(&mut st, &IntelAction::NeuronRegister { subnet_id: 0, role: 0, hotkey: vec![1], bond: 1, gas_limit: 1 }, &tx, 1);
        }
        let uids: Vec<u32> = st.neurons.iter().map(|n| n.uid).collect();
        assert_eq!(uids, vec![0, 1, 2]);
    }
}
