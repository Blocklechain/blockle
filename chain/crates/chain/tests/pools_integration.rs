//! Native AMM ↔ BLOCK-20 integration: proves the native pool actions settle
//! token legs against the *same* storage slots the BLOCK-20 contract uses, and
//! that BLOCK payouts / refunds / the 1-week lock behave end-to-end.

use blockle_chain::block20::block20_bytecode;
use blockle_chain::contracts::{self, ContractInfo, ContractMap, StorageMap};
use blockle_chain::pools::{apply_pool_action, pool_id, LP_LOCK_BLOCKS, PoolState};
use blockle_core::keys::{pubkey_to_address, Keypair};
use blockle_core::transaction::{ContractAction, OutPoint, Transaction, TxInput};

const GAS: u64 = 10_000_000;
const TOKEN_ID: [u8; 32] = [0x11u8; 32];

/// Read a holder's BLOCK-20 balance via the actual contract getter (selector 1).
fn balance_of(
    holder: &[u8; 32],
    contracts: &mut ContractMap,
    storage: &mut StorageMap,
) -> u64 {
    let mut input = vec![1u8];
    input.extend_from_slice(holder);
    let r = contracts::execute_call(&TOKEN_ID, &input, 0, GAS, [0u8; 32], 1, contracts, storage);
    let mut b = [0u8; 8];
    b.copy_from_slice(&r.return_data[..8]);
    u64::from_le_bytes(b)
}

/// Build a tx whose first input carries `kp`'s pubkey (so apply_pool_action
/// derives the caller = kp's address). Other fields are irrelevant to apply.
fn tx_from(kp: &Keypair, action: ContractAction) -> Transaction {
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
        contract: Some(action),
    }
}

#[test]
fn native_amm_settles_against_block20() {
    let alice = Keypair::generate();
    let bob = Keypair::generate();
    let alice_a = pubkey_to_address(&alice.public_bytes());
    let bob_a = pubkey_to_address(&bob.public_bytes());

    let mut contracts: ContractMap = ContractMap::new();
    let mut storage: StorageMap = StorageMap::new();
    let mut pools = PoolState::default();

    // deploy token + init() -> alice holds the whole supply
    let code = block20_bytecode("Pool Token", "POOL", 6, 1_000_000);
    contracts.insert(TOKEN_ID, ContractInfo { code, balance: 0 });
    let init = contracts::execute_call(&TOKEN_ID, &[0u8], 0, GAS, alice_a, 1, &mut contracts, &mut storage);
    assert!(init.success);
    assert_eq!(balance_of(&alice_a, &mut contracts, &mut storage), 1_000_000);

    let id = pool_id(&TOKEN_ID);

    // alice creates a pool: 1000 BLOCK + 400_000 POOL
    let pay = apply_pool_action(
        &ContractAction::PoolCreate { token: TOKEN_ID, block_amt: 1000, token_amt: 400_000, gas_limit: 100_000 },
        &tx_from(&alice, ContractAction::PoolCreate { token: TOKEN_ID, block_amt: 1000, token_amt: 400_000, gas_limit: 100_000 }),
        100, &mut pools, &mut storage,
    );
    assert!(pay.is_empty(), "create has no BLOCK payout");
    assert_eq!(pools.pools[&id].block_reserve, 1000);
    assert_eq!(pools.pools[&id].token_reserve, 400_000);
    // the token actually moved alice -> pool, visible through the real contract
    assert_eq!(balance_of(&alice_a, &mut contracts, &mut storage), 600_000);
    assert_eq!(balance_of(&id, &mut contracts, &mut storage), 400_000);

    // bob swaps 100 BLOCK -> POOL (buy). No payout; bob's token balance rises.
    let act = ContractAction::PoolSwapBuy { token: TOKEN_ID, block_in: 100, min_token_out: 1, gas_limit: 100_000 };
    let pay = apply_pool_action(&act, &tx_from(&bob, act.clone()), 110, &mut pools, &mut storage);
    assert!(pay.is_empty());
    let bob_tok = balance_of(&bob_a, &mut contracts, &mut storage);
    assert!(bob_tok > 0, "bob received tokens from the buy");
    assert_eq!(pools.pools[&id].block_reserve, 1100);
    assert_eq!(balance_of(&id, &mut contracts, &mut storage), 400_000 - bob_tok);

    // bob sells his tokens back -> BLOCK paid out to bob
    let act = ContractAction::PoolSwapSell { token: TOKEN_ID, token_in: bob_tok, min_block_out: 1, gas_limit: 100_000 };
    let pay = apply_pool_action(&act, &tx_from(&bob, act.clone()), 120, &mut pools, &mut storage);
    assert_eq!(pay.len(), 1);
    assert_eq!(pay[0].0, bob_a);
    assert!(pay[0].1 > 0 && pay[0].1 < 100, "round-trip loses to fees+slippage");
    assert_eq!(balance_of(&bob_a, &mut contracts, &mut storage), 0);

    // a buy with an impossible min_token_out refunds the BLOCK
    let act = ContractAction::PoolSwapBuy { token: TOKEN_ID, block_in: 50, min_token_out: u64::MAX, gas_limit: 100_000 };
    let pay = apply_pool_action(&act, &tx_from(&bob, act.clone()), 130, &mut pools, &mut storage);
    assert_eq!(pay, vec![(bob_a, 50)], "slippage-failed buy refunds the BLOCK in full");

    // alice can't remove LP before the 1-week lock...
    let shares = pools.lp[&(id, alice_a)].shares;
    let act = ContractAction::PoolRemove { token: TOKEN_ID, shares, gas_limit: 100_000 };
    let early = apply_pool_action(&act, &tx_from(&alice, act.clone()), 100 + 10, &mut pools, &mut storage);
    assert!(early.is_empty(), "locked: no payout, no withdrawal");
    assert!(pools.pools.contains_key(&id));
    // ...but can after it (BLOCK paid out, tokens credited back)
    let after = apply_pool_action(&act, &tx_from(&alice, act.clone()), 100 + LP_LOCK_BLOCKS, &mut pools, &mut storage);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].0, alice_a);
    assert!(after[0].1 > 0, "LP withdrawal pays BLOCK back");
    assert!(balance_of(&alice_a, &mut contracts, &mut storage) > 600_000, "LP withdrawal returns tokens");
}
