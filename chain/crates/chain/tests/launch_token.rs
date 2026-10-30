//! ContractAction::LaunchToken — the atomic "deploy + mint + seed pool" action.
//! Proves all three happen in ONE apply (the contract exists, the supply is
//! minted to the sender, and the AMM pool is seeded from that fresh supply),
//! and that a bad launch (token_amt > supply) refunds the seed BLOCK instead.

use std::collections::{HashMap, HashSet};

use blockle_chain::block20::block20_bytecode;
use blockle_chain::block721::block721_bytecode;
use blockle_chain::chain::Chain;
use blockle_chain::contracts::{self, ContractMap, StorageMap};
use blockle_chain::pools::{pool_id, PoolState};
use blockle_core::keys::{pubkey_to_address, Keypair};
use blockle_core::transaction::{ContractAction, OutPoint, Transaction, TxInput};

const GAS: u64 = 10_000_000;

fn balance_of(
    token: &[u8; 32],
    holder: &[u8; 32],
    contracts: &mut ContractMap,
    storage: &mut StorageMap,
) -> u64 {
    let mut input = vec![1u8];
    input.extend_from_slice(holder);
    let r = contracts::execute_call(token, &input, 0, GAS, [0u8; 32], 1, contracts, storage);
    let mut b = [0u8; 8];
    b.copy_from_slice(&r.return_data[..8]);
    u64::from_le_bytes(b)
}

fn launch_tx(kp: &Keypair, code: Vec<u8>, block_amt: u64, token_amt: u64) -> Transaction {
    Transaction {
        version: 1,
        inputs: vec![TxInput {
            prev: OutPoint { txid: [7u8; 32], vout: 0 },
            pubkey: kp.public_bytes(),
            signature: vec![],
        }],
        outputs: vec![],
        coinbase_data: vec![],
        shielded: None,
        contract: Some(ContractAction::LaunchToken {
            code,
            block_amt,
            token_amt,
            gas_limit: 300_000,
        }),
    }
}

fn apply(tx: &Transaction, pools: &mut PoolState, contracts: &mut ContractMap, storage: &mut StorageMap) {
    let mut utxos = HashMap::new();
    let mut nullifiers = HashSet::new();
    let mut note_leaves = Vec::new();
    let mut intel = blockle_chain::intel::IntelState::default();
    let txid = tx.txid();
    Chain::apply_tx_effects(
        tx, &txid, 100, &mut utxos, contracts, storage, pools, &mut nullifiers, &mut note_leaves,
        &mut intel,
    );
}

#[test]
fn launch_token_atomically_deploys_mints_and_pools() {
    let alice = Keypair::generate();
    let alice_a = pubkey_to_address(&alice.public_bytes());

    let mut contracts: ContractMap = ContractMap::new();
    let mut storage: StorageMap = StorageMap::new();
    let mut pools = PoolState::default();

    // supply 1_000_000 (raw); pool seeds 10_000 BLOCK + 400_000 of the token.
    let code = block20_bytecode("World", "WORLD", 8, 1_000_000);
    let tx = launch_tx(&alice, code, 10_000, 400_000);
    let cid = contracts::contract_id(&tx.txid());

    apply(&tx, &mut pools, &mut contracts, &mut storage);

    // 1. contract deployed
    assert!(contracts.contains_key(&cid), "contract deployed in the same tx");
    // 2. supply minted to alice, minus what went into the pool
    assert_eq!(balance_of(&cid, &alice_a, &mut contracts, &mut storage), 600_000, "alice keeps supply - pooled");
    // 3. pool created and seeded
    let id = pool_id(&cid);
    assert_eq!(pools.pools[&id].block_reserve, 10_000, "pool holds the seed BLOCK");
    assert_eq!(pools.pools[&id].token_reserve, 400_000, "pool holds the seed tokens");
    // the pool's token leg is visible through the real contract storage
    assert_eq!(balance_of(&cid, &id, &mut contracts, &mut storage), 400_000, "pool token balance moved on-chain");
}

#[test]
fn launch_token_refunds_when_pool_exceeds_supply() {
    let alice = Keypair::generate();
    let alice_a = pubkey_to_address(&alice.public_bytes());

    let mut contracts: ContractMap = ContractMap::new();
    let mut storage: StorageMap = StorageMap::new();
    let mut pools = PoolState::default();

    // ask to pool MORE token than the minted supply -> pool can't be created,
    // the seed BLOCK is refunded (payout back to alice), no pool exists.
    let code = block20_bytecode("World", "WORLD", 8, 1_000_000);
    let tx = launch_tx(&alice, code, 10_000, 2_000_000);
    let cid = contracts::contract_id(&tx.txid());

    let mut utxos = HashMap::new();
    let mut nullifiers = HashSet::new();
    let mut note_leaves = Vec::new();
    let mut intel = blockle_chain::intel::IntelState::default();
    let txid = tx.txid();
    Chain::apply_tx_effects(
        &tx, &txid, 100, &mut utxos, &mut contracts, &mut storage, &mut pools,
        &mut nullifiers, &mut note_leaves, &mut intel,
    );

    // the token still deployed + fully minted to alice (the mint succeeded)...
    assert_eq!(balance_of(&cid, &alice_a, &mut contracts, &mut storage), 1_000_000);
    // ...but no pool, and the seed BLOCK was refunded as a payout UTXO to alice.
    assert!(!pools.pools.contains_key(&pool_id(&cid)), "no pool created");
    let refunded = utxos.values().any(|e| e.output.recipient == alice_a && e.output.amount == 10_000);
    assert!(refunded, "seed BLOCK refunded to alice");
}

#[test]
fn launch_nft_atomically_deploys_and_inits_collection() {
    let alice = Keypair::generate();
    let alice_a = pubkey_to_address(&alice.public_bytes());
    let bob = Keypair::generate();
    let bob_a = pubkey_to_address(&bob.public_bytes());

    let mut contracts: ContractMap = ContractMap::new();
    let mut storage: StorageMap = StorageMap::new();
    let mut pools = PoolState::default();

    let code = block721_bytecode("World Items", "WRLD-ITEM");
    let tx = Transaction {
        version: 1,
        inputs: vec![TxInput {
            prev: OutPoint { txid: [9u8; 32], vout: 0 },
            pubkey: alice.public_bytes(),
            signature: vec![],
        }],
        outputs: vec![],
        coinbase_data: vec![],
        shielded: None,
        contract: Some(ContractAction::LaunchNft { code, gas_limit: 300_000 }),
    };
    let cid = contracts::contract_id(&tx.txid());
    apply(&tx, &mut pools, &mut contracts, &mut storage);

    // collection deployed + initialized: alice (deployer) is the minter and can
    // mint id1 -> bob in a subsequent single call (no deploy/init race left).
    assert!(contracts.contains_key(&cid), "collection deployed");
    let id1 = [0x01u8; 32];
    let mut mint = vec![8u8];
    mint.extend_from_slice(&id1);
    mint.extend_from_slice(&bob_a);
    let r = contracts::execute_call(&cid, &mint, 0, GAS, alice_a, 101, &mut contracts, &mut storage);
    assert!(r.success, "minter (deployer) can mint right after the atomic launch");
    // ownerOf(id1) == bob
    let mut own = vec![7u8];
    own.extend_from_slice(&id1);
    let o = contracts::execute_call(&cid, &own, 0, GAS, alice_a, 101, &mut contracts, &mut storage);
    assert_eq!(o.return_data, bob_a.to_vec(), "ownerOf id1 == bob");
}
