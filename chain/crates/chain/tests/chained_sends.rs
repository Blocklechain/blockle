//! TWO PAYMENTS IN ONE BLOCK.
//!
//! A wallet could only make one payment per block. The second send failed
//! with "insufficient spendable funds" for money the wallet plainly had,
//! because the change from the first send exists only in the mempool and
//! every path that looked for spendable coins looked at confirmed state.
//!
//! The thing worth pinning here is that the BLOCK was never the problem.
//! `build_template` and `connect_block` both apply each transaction's
//! effects before validating the next, so a child spending its parent's
//! output — with the parent earlier in the block — has always been valid on
//! this chain. The first test below proves exactly that, which is what makes
//! the mempool fix a policy change rather than a consensus change: no height
//! gate, no activation, and an upgraded miner's blocks are acceptable to a
//! node that was never upgraded.

use blockle_chain::mempool::{
    ancestor_count, pending_spends, pending_view, spendable_with_pending, topo_order,
    MAX_PENDING_CHAIN,
};
use blockle_chain::{build_template, mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::{OutPoint, Transaction, TxInput, TxOutput, COIN};

fn mine_and_connect(chain: &mut Chain, kp: &Keypair, txs: &[Transaction]) {
    let (block, _) = mine_block(chain, kp.address(), txs).unwrap();
    chain.connect_block(block).unwrap();
}

/// Sign a transaction spending `inputs` and paying `outputs`.
fn signed(kp: &Keypair, inputs: &[OutPoint], outputs: Vec<TxOutput>) -> Transaction {
    let mut tx = Transaction {
        version: 1,
        inputs: inputs
            .iter()
            .map(|op| TxInput { prev: *op, pubkey: kp.public_bytes(), signature: vec![] })
            .collect(),
        outputs,
        coinbase_data: vec![],
        shielded: None,
        contract: None,
    };
    let sighash = tx.sighash();
    for i in 0..tx.inputs.len() {
        tx.inputs[i].signature = kp.sign(&sighash);
    }
    tx
}

/// A chain with the premine spendable by `miner`.
fn funded() -> (Chain, Keypair) {
    let mut chain = Chain::new(ChainParams::regtest());
    let miner = Keypair::generate();
    mine_and_connect(&mut chain, &miner, &[]);
    (chain, miner)
}

#[test]
fn a_block_has_always_accepted_a_chained_spend() {
    // THE LOAD-BEARING TEST. If this fails, the mempool fix would be a
    // consensus change and could not ship without an activation height.
    let (mut chain, miner) = funded();
    let alice = Keypair::generate();
    let bob = Keypair::generate();
    let fee = COIN / 1000;

    let (op, entry) = chain.spendable_utxos(&miner.address()).pop().unwrap();
    let send = 1000 * COIN;
    let change = entry.output.amount - send - fee;

    // Parent: pay alice, keep the change.
    let parent = signed(
        &miner,
        &[op],
        vec![
            TxOutput { recipient: alice.address(), amount: send },
            TxOutput { recipient: miner.address(), amount: change },
        ],
    );
    let parent_id = parent.txid();

    // Child: spend the parent's CHANGE — which does not exist in the
    // confirmed UTXO set — to pay bob.
    let send2 = 500 * COIN;
    let child = signed(
        &miner,
        &[OutPoint { txid: parent_id, vout: 1 }],
        vec![
            TxOutput { recipient: bob.address(), amount: send2 },
            TxOutput { recipient: miner.address(), amount: change - send2 - fee },
        ],
    );

    let (block, included) =
        build_template(&chain, miner.address(), &[parent.clone(), child.clone()]).unwrap();
    assert_eq!(included.len(), 2, "both payments must be selected into one block");
    // Parent before child in the block, which is what makes it valid.
    assert_eq!(block.transactions[1].txid(), parent_id);
    assert_eq!(block.transactions[2].txid(), child.txid());

    mine_and_connect(&mut chain, &miner, &[parent, child]);
    assert_eq!(chain.balance(&alice.address()), send, "alice was paid");
    assert_eq!(chain.balance(&bob.address()), send2, "bob was paid in the same block");
}

#[test]
fn a_candidate_out_of_order_is_still_included() {
    // The mempool is usually ordered because the parent was submitted first.
    // That breaks on reload from disk, on gossip arriving out of order, and
    // after a reorg — and the failure is silent: the payment just does not
    // appear in the block. Selection orders candidates itself.
    let (chain, miner) = funded();
    let alice = Keypair::generate();
    let fee = COIN / 1000;

    let (op, entry) = chain.spendable_utxos(&miner.address()).pop().unwrap();
    let send = 10 * COIN;
    let change = entry.output.amount - send - fee;
    let parent = signed(
        &miner,
        &[op],
        vec![
            TxOutput { recipient: alice.address(), amount: send },
            TxOutput { recipient: miner.address(), amount: change },
        ],
    );
    let child = signed(
        &miner,
        &[OutPoint { txid: parent.txid(), vout: 1 }],
        vec![
            TxOutput { recipient: alice.address(), amount: send },
            TxOutput { recipient: miner.address(), amount: change - send - fee },
        ],
    );

    // CHILD FIRST. Before the ordering pass this dropped the child entirely.
    let (_, included) =
        build_template(&chain, miner.address(), &[child.clone(), parent.clone()]).unwrap();
    assert_eq!(included.len(), 2, "order of candidates must not lose a payment");
    assert_eq!(included[0], parent.txid(), "the parent has to be mined first");
    assert_eq!(included[1], child.txid());
}

#[test]
fn the_pending_view_shows_change_the_chain_has_not_seen() {
    let (chain, miner) = funded();
    let alice = Keypair::generate();
    let fee = COIN / 1000;

    let (op, entry) = chain.spendable_utxos(&miner.address()).pop().unwrap();
    let send = 1000 * COIN;
    let change = entry.output.amount - send - fee;
    let parent = signed(
        &miner,
        &[op],
        vec![
            TxOutput { recipient: alice.address(), amount: send },
            TxOutput { recipient: miner.address(), amount: change },
        ],
    );
    let mempool = vec![parent.clone()];

    // THE CONFIRMED SET STILL SAYS the miner has one big coin and alice has
    // nothing — which is correct, and is also exactly why funding from it
    // could not make a second payment.
    assert_eq!(chain.spendable_utxos(&miner.address()).len(), 1);
    assert!(chain.spendable_utxos(&alice.address()).is_empty());

    // The pending view: the spent coin is gone, the change and alice's
    // payment are there.
    let view = pending_view(&chain, &mempool);
    assert!(!view.contains_key(&op), "the input the mempool spends is removed");
    assert!(view.contains_key(&OutPoint { txid: parent.txid(), vout: 1 }));

    let fundable = spendable_with_pending(&chain, &mempool, &miner.address());
    assert_eq!(fundable.len(), 1, "the change is fundable");
    assert_eq!(fundable[0].1.output.amount, change);
    assert!(!fundable[0].2, "and is reported as unconfirmed");

    // Alice can spend what she was paid, before it confirms.
    let hers = spendable_with_pending(&chain, &mempool, &alice.address());
    assert_eq!(hers.len(), 1);
    assert_eq!(hers[0].1.output.amount, send);
    assert!(!hers[0].2);
}

#[test]
fn confirmed_coins_are_offered_before_pending_change() {
    // Spending settled money first keeps the unconfirmed chain short, which
    // means a reorg invalidates less and the ancestor cap is reached later.
    let mut chain = Chain::new(ChainParams::regtest());
    let miner = Keypair::generate();
    mine_and_connect(&mut chain, &miner, &[]);
    // A second block, so there are two confirmed coins to choose from.
    for _ in 0..(chain.params.coinbase_maturity + 1) {
        mine_and_connect(&mut chain, &miner, &[]);
    }

    let alice = Keypair::generate();
    let fee = COIN / 1000;
    let mut utxos = chain.spendable_utxos(&miner.address());
    utxos.sort_by_key(|(_, e)| e.output.amount);
    let (small_op, small) = utxos.first().cloned().unwrap();
    let parent = signed(
        &miner,
        &[small_op],
        vec![
            TxOutput { recipient: alice.address(), amount: fee },
            TxOutput {
                recipient: miner.address(),
                amount: small.output.amount - fee - fee,
            },
        ],
    );

    let ordered = spendable_with_pending(&chain, &[parent], &miner.address());
    assert!(ordered.len() >= 2, "there is a choice to make");
    assert!(ordered[0].2, "the first coin offered is a confirmed one");
    assert!(
        !ordered.last().unwrap().2,
        "and the pending change is offered last"
    );
}

#[test]
fn a_real_double_spend_is_still_a_double_spend() {
    // The one piece of the old policy that was doing real work. Relaxing
    // chaining must not relax this: two transactions spending the same
    // outpoint cannot both stand.
    let (chain, miner) = funded();
    let alice = Keypair::generate();
    let bob = Keypair::generate();
    let fee = COIN / 1000;

    let (op, entry) = chain.spendable_utxos(&miner.address()).pop().unwrap();
    let to_alice = signed(
        &miner,
        &[op],
        vec![TxOutput { recipient: alice.address(), amount: entry.output.amount - fee }],
    );
    let to_bob = signed(
        &miner,
        &[op],
        vec![TxOutput { recipient: bob.address(), amount: entry.output.amount - fee }],
    );

    // The node's admission check is this set membership.
    let spent = pending_spends(&[to_alice.clone()]);
    assert!(
        to_bob.inputs.iter().any(|i| spent.contains(&i.prev)),
        "the competing spend must be seen as conflicting"
    );

    // And a block cannot contain both, whichever order they are offered in.
    let (_, included) = build_template(&chain, miner.address(), &[to_alice, to_bob]).unwrap();
    assert_eq!(included.len(), 1, "only one of a double-spend pair can be mined");
}

#[test]
fn ordering_terminates_on_a_mempool_it_cannot_order() {
    // The mempool is read back from disk, so it is untrusted input. A cycle
    // is impossible with real txids — it would need a hash preimage — but
    // this must terminate and must not drop entries rather than being
    // trusted not to be asked.
    let (_chain, miner) = funded();
    let alice = Keypair::generate();
    // Two transactions each claiming to spend an output of the other.
    let a = signed(
        &miner,
        &[OutPoint { txid: [7u8; 32], vout: 0 }],
        vec![TxOutput { recipient: alice.address(), amount: COIN }],
    );
    let b = signed(
        &miner,
        &[OutPoint { txid: a.txid(), vout: 0 }],
        vec![TxOutput { recipient: alice.address(), amount: COIN }],
    );
    let c = signed(
        &miner,
        &[OutPoint { txid: b.txid(), vout: 0 }],
        vec![TxOutput { recipient: alice.address(), amount: COIN }],
    );

    let order = topo_order(&[c.clone(), b.clone(), a.clone()]);
    assert_eq!(order.len(), 3, "ordering drops nothing");
    let pos = |tx: &Transaction| -> usize {
        let ids = [c.txid(), b.txid(), a.txid()];
        order.iter().position(|&i| ids[i] == tx.txid()).unwrap()
    };
    assert!(pos(&a) < pos(&b), "a before b");
    assert!(pos(&b) < pos(&c), "b before c");
}

#[test]
fn the_unconfirmed_chain_is_bounded() {
    // An unbounded chain is unbounded work on every admission and every
    // prune, and the memory is an attacker's to spend.
    let (chain, miner) = funded();
    let alice = Keypair::generate();
    let fee = COIN / 1000;

    let (op, entry) = chain.spendable_utxos(&miner.address()).pop().unwrap();
    let mut mempool: Vec<Transaction> = Vec::new();
    let mut prev = op;
    let mut left = entry.output.amount;
    for _ in 0..(MAX_PENDING_CHAIN + 5) {
        left -= fee;
        let tx = signed(
            &miner,
            &[prev],
            vec![TxOutput { recipient: miner.address(), amount: left }],
        );
        prev = OutPoint { txid: tx.txid(), vout: 0 };
        mempool.push(tx);
    }

    // The first has no pending ancestors; the last has as many as the cap
    // allows to be counted.
    assert_eq!(ancestor_count(&mempool, &mempool[0]), 0);
    let next = signed(
        &miner,
        &[prev],
        vec![TxOutput { recipient: alice.address(), amount: left - fee }],
    );
    assert!(
        ancestor_count(&mempool, &next) >= MAX_PENDING_CHAIN,
        "a chain past the cap is reported as past the cap"
    );
}
