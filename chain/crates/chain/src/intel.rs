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

use crate::intel_consensus as ic;
use blockle_core::hash::blake2b_256;
use blockle_core::keys::pubkey_to_address;
use blockle_core::transaction::{IntelAction, Transaction};
use std::collections::HashMap;

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
    /// Withheld α·subsidy accrued since the last epoch (base units), awaiting distribution.
    pub pool: u64,
    /// Claimable emission per owner address (base units), paid out by `NeuronClaim`.
    pub emission_ledger: HashMap<[u8; 32], u64>,
    /// Current-epoch weight commits: (subnet_id, validator_uid) -> commit hash.
    pub commits: HashMap<(u32, u32), [u8; 32]>,
    /// Current-epoch revealed weights: (subnet_id, validator_uid) -> (miner_uids, weights).
    pub revealed: HashMap<(u32, u32), (Vec<u32>, Vec<u32>)>,
    /// EMA bonds carried across epochs: (subnet_id, validator_uid) -> per-miner bond (fixed-point).
    pub bonds: HashMap<(u32, u32), Vec<u128>>,
    /// In-node beacon seed of the CURRENT epoch (set at each boundary). Validators must
    /// acknowledge it via ValidationProof to count as live.
    pub last_epoch_seed: [u8; 32],
    /// Validators (subnet_id, uid) that submitted a valid ValidationProof this epoch.
    pub pov: std::collections::HashSet<(u32, u32)>,
}

impl IntelState {
    pub fn subnet(&self, id: u32) -> Option<&Subnet> {
        self.subnets.get(id as usize)
    }
    /// Count of neurons already registered in a subnet (used to assign the next uid).
    fn neuron_count(&self, subnet_id: u32) -> u32 {
        self.neurons.iter().filter(|n| n.subnet_id == subnet_id).count() as u32
    }
    /// The uid of the validator (role 1) owned by `owner` in `subnet_id`, if any.
    fn validator_uid(&self, subnet_id: u32, owner: &[u8; 32]) -> Option<u32> {
        self.neurons
            .iter()
            .find(|n| n.subnet_id == subnet_id && n.role == 1 && &n.owner == owner)
            .map(|n| n.uid)
    }
}

/// Canonical bytes for a weight set, hashed for the commit-reveal. The off-chain
/// validator SDK must produce the identical bytes.
pub fn weights_commit(uids: &[u32], weights: &[u32], nonce: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(8 + uids.len() * 4 + weights.len() * 4 + 32);
    buf.extend_from_slice(&(uids.len() as u32).to_le_bytes());
    for u in uids {
        buf.extend_from_slice(&u.to_le_bytes());
    }
    buf.extend_from_slice(&(weights.len() as u32).to_le_bytes());
    for w in weights {
        buf.extend_from_slice(&w.to_le_bytes());
    }
    buf.extend_from_slice(nonce);
    blake2b_256(&buf)
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
        IntelAction::SetWeightsCommit { subnet_id, commit, .. } => {
            // Only a registered validator may commit; silently ignore otherwise.
            if let Some(uid) = intel.validator_uid(*subnet_id, &sender) {
                intel.commits.insert((*subnet_id, uid), *commit);
            }
            Vec::new()
        }
        IntelAction::SetWeightsReveal { subnet_id, uids, weights, nonce, .. } => {
            // Must be a validator, lengths must match, and the reveal must open the
            // committed hash; otherwise it's a no-op (can't frontrun/forge weights).
            if uids.len() == weights.len() && uids.len() <= 4096 {
                if let Some(uid) = intel.validator_uid(*subnet_id, &sender) {
                    if intel.commits.get(&(*subnet_id, uid))
                        == Some(&weights_commit(uids, weights, nonce))
                    {
                        intel.revealed.insert((*subnet_id, uid), (uids.clone(), weights.clone()));
                    }
                }
            }
            Vec::new()
        }
        IntelAction::NeuronClaim { .. } => {
            // Pay out everything the sender has accrued; zero the ledger entry.
            match intel.emission_ledger.remove(&sender) {
                Some(amt) if amt > 0 => vec![(sender, amt)],
                _ => Vec::new(),
            }
        }
        IntelAction::ValidationProof { subnet_id, beacon_ack, .. } => {
            // Live only if the validator acknowledges the CURRENT epoch's beacon (a
            // copier can't, because the beacon is fresh + unpredictable).
            if beacon_ack == &intel.last_epoch_seed {
                if let Some(uid) = intel.validator_uid(*subnet_id, &sender) {
                    intel.pov.insert((*subnet_id, uid));
                }
            }
            Vec::new()
        }
    }
}

/// Deterministic in-node beacon seed for an epoch — blake2b of the tip hash at the epoch
/// boundary. (Proof-of-validation spot-check selection consumes this in Phase 2b-ii.)
pub fn epoch_beacon(tip_hash: &[u8; 32]) -> [u8; 32] {
    blake2b_256(tip_hash)
}

/// Run the EmissionEpoch (spec §5): distribute the accrued `pool` across eligible subnets
/// and credit neuron owners' emission_ledger via the deterministic incentive math. Clears
/// the per-epoch weight commits/reveals. Decrements `pool` by exactly what was distributed
/// (dust carries to the next epoch — never over-mints). Called at the epoch boundary.
pub fn run_emission_epoch(intel: &mut IntelState, seed: [u8; 32], _height: u64) {
    intel.last_epoch_seed = seed;
    // Eligible subnets: ≥1 miner and ≥1 revealed validator this epoch.
    let eligible: Vec<u32> = intel
        .subnets
        .iter()
        .map(|s| s.id)
        .filter(|&sid| {
            intel.neurons.iter().any(|n| n.subnet_id == sid && n.role == 0)
                && intel.revealed.keys().any(|(s, _)| *s == sid)
        })
        .collect();
    if eligible.is_empty() {
        return;
    }
    let miner_frac = ic::SCALE / 2; // 50/50 miners/validators
    let kappa = ic::SCALE / 2;
    let lam: u128 = 900_000; // 0.9
    const SLASH_BPS: u64 = 500; // 5% bond slash for revealed-but-absent (no PoV) validators

    // Stake-weighted split across subnets (weight = total neuron bond). Demand-weighting
    // by x402 revenue (§6) needs the off-chain oracle and lands in a later pass.
    let sweights: Vec<(u32, u128)> = eligible
        .iter()
        .map(|&sid| {
            let w: u128 =
                intel.neurons.iter().filter(|n| n.subnet_id == sid).map(|n| n.bond as u128).sum();
            (sid, w.max(1))
        })
        .collect();
    let total_w: u128 = sweights.iter().map(|(_, w)| *w).sum::<u128>().max(1);
    let pool_u = intel.pool as u128;

    let mut distributed: u64 = 0;
    let mut slashed_total: u64 = 0;
    let mut to_slash: Vec<(u32, u32)> = Vec::new(); // (subnet, validator uid) revealed but no PoV

    for (sid, w_s) in sweights {
        let per_subnet = (pool_u * w_s / total_w) as u64;
        if per_subnet == 0 {
            continue;
        }
        // miners (role 0) in uid order -> columns
        let mut miners: Vec<(u32, [u8; 32])> = intel
            .neurons
            .iter()
            .filter(|n| n.subnet_id == sid && n.role == 0)
            .map(|n| (n.uid, n.owner))
            .collect();
        miners.sort_by_key(|(u, _)| *u);
        let nm = miners.len();
        let col_of: HashMap<u32, usize> =
            miners.iter().enumerate().map(|(k, (u, _))| (*u, k)).collect();

        // validators that revealed -> rows; active iff they ALSO proved liveness (PoV).
        let mut vals: Vec<(u32, [u8; 32], u128)> = Vec::new();
        for n in intel.neurons.iter().filter(|n| n.subnet_id == sid && n.role == 1) {
            if intel.revealed.contains_key(&(sid, n.uid)) {
                vals.push((n.uid, n.owner, n.bond as u128));
            }
        }
        if vals.is_empty() || nm == 0 {
            continue;
        }

        let mut w: Vec<Vec<u128>> = Vec::with_capacity(vals.len());
        let mut s: Vec<u128> = Vec::with_capacity(vals.len());
        let mut bonds_prev: Vec<Vec<u128>> = Vec::with_capacity(vals.len());
        let mut active: Vec<bool> = Vec::with_capacity(vals.len());
        for (v_uid, _owner, stake) in &vals {
            let mut row = vec![0u128; nm];
            if let Some((uids, weights)) = intel.revealed.get(&(sid, *v_uid)) {
                for (mu, wt) in uids.iter().zip(weights.iter()) {
                    if let Some(&col) = col_of.get(mu) {
                        row[col] = (*wt as u128).min(ic::SCALE);
                    }
                }
            }
            w.push(row);
            s.push(*stake);
            let mut bp = intel.bonds.get(&(sid, *v_uid)).cloned().unwrap_or_default();
            bp.resize(nm, 0);
            bonds_prev.push(bp);
            let live = intel.pov.contains(&(sid, *v_uid));
            active.push(live);
            if !live {
                to_slash.push((sid, *v_uid)); // revealed but skipped proof-of-validation
            }
        }

        let (miner_em, val_em, new_bonds) =
            ic::emission_epoch(&w, &s, &active, &bonds_prev, per_subnet as u128, miner_frac, kappa, lam);

        for (k, (_uid, owner)) in miners.iter().enumerate() {
            let amt = miner_em[k] as u64;
            if amt > 0 {
                *intel.emission_ledger.entry(*owner).or_insert(0) += amt;
                distributed += amt;
            }
        }
        for (vi, (v_uid, owner, _)) in vals.iter().enumerate() {
            let amt = val_em[vi] as u64;
            if amt > 0 {
                *intel.emission_ledger.entry(*owner).or_insert(0) += amt;
                distributed += amt;
            }
            intel.bonds.insert((sid, *v_uid), new_bonds[vi].clone());
        }
    }

    // Slash revealed-but-absent validators; the slashed bond is recycled into the pool.
    for (sid, v_uid) in to_slash {
        if let Some(n) = intel
            .neurons
            .iter_mut()
            .find(|n| n.subnet_id == sid && n.uid == v_uid && n.role == 1)
        {
            let cut = (n.bond as u128 * SLASH_BPS as u128 / 10_000) as u64;
            n.bond = n.bond.saturating_sub(cut);
            slashed_total = slashed_total.saturating_add(cut);
        }
    }

    intel.pool = intel.pool.saturating_sub(distributed).saturating_add(slashed_total);
    // reset per-epoch state
    intel.commits.clear();
    intel.revealed.clear();
    intel.pov.clear();
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
