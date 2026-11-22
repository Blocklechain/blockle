//! Unconfirmed-transaction views: what the UTXO set looks like once the
//! mempool is taken into account.
//!
//! # Why this exists
//!
//! A wallet could only make ONE payment per block. Not by design and not by
//! any consensus rule — the second send simply failed, and three separate
//! places were each independently responsible:
//!
//! 1. **Funding** drew inputs from confirmed UTXOs only. After the first
//!    send, the wallet's coins are spent by a pending transaction and the
//!    change it creates exists nowhere but the mempool, so the second send
//!    saw no spendable coins and reported "insufficient funds" for money the
//!    player plainly had.
//!
//! 2. **Mempool admission** rejected any transaction spending an output
//!    another pending transaction had created — the comment in the node said
//!    so outright: "no unconfirmed chaining in the prototype mempool".
//!
//! 3. **The light-wallet UTXO endpoint** served confirmed outputs and did not
//!    subtract the ones the mempool had already spent, so a phone wallet
//!    would build a transaction double-spending its own pending input, and
//!    the node would reject it. Every route to a second payment was closed.
//!
//! # This is not a consensus change
//!
//! Worth being exact about, because it is the reason this can ship as a
//! point release and take effect the moment a node restarts.
//!
//! Chained spends were ALWAYS valid in a block. `build_template` validates
//! each candidate against a scratch view and applies its effects before
//! considering the next, and `Chain::connect_block` does the same when
//! validating — so a child spending its parent's output, with the parent
//! earlier in the block, has always been accepted by every node. Nothing
//! below changes which blocks are valid; it changes which valid
//! transactions a node is willing to HOLD and MINE.
//!
//! That makes it:
//!
//! * **Backwards compatible.** An upgraded node produces blocks an old node
//!   accepts, because such blocks were always acceptable. An old node simply
//!   declines to relay the chained child, and the upgraded node mines it.
//! * **Immediate.** No height gate, no activation, no coordination. The
//!   first upgraded miner includes both payments in its next block.
//! * **Safe to roll back.** Reverting leaves no invalid state behind; the
//!   chained children drop out of the mempool and the funds are still where
//!   their confirmed parents left them.

use std::collections::{HashMap, HashSet};

use blockle_core::{OutPoint, Transaction};

use crate::chain::{Chain, UtxoEntry};

/// How deep a chain of unconfirmed transactions a node will hold.
///
/// A cap rather than no cap, because an unbounded chain is an unbounded
/// amount of work on every admission and every prune, and the memory is an
/// attacker's to spend. Twenty-five is far beyond what a person sending
/// payments produces and far below what hurts.
pub const MAX_PENDING_CHAIN: usize = 25;

/// Every outpoint some pending transaction already spends.
///
/// A second transaction spending one of these is a genuine double-spend and
/// stays rejected — that check is the one piece of the old policy that was
/// doing real work, and it is kept exactly as strict.
pub fn pending_spends(mempool: &[Transaction]) -> HashSet<OutPoint> {
    mempool
        .iter()
        .flat_map(|t| t.inputs.iter().map(|i| i.prev))
        .collect()
}

/// Mempool transaction indices ordered so every parent precedes its children.
///
/// Needed in three places, all for the same reason: a child validated before
/// its parent has been applied looks invalid. The mempool is usually already
/// in order, because the parent was submitted first — but "usually" fails on
/// reload from disk, on gossip arriving out of order, and after a reorg, and
/// the symptom is the child being silently dropped rather than anything that
/// looks like an error.
///
/// Transactions whose parents are not in the mempool at all (the normal case
/// — they spend confirmed outputs) keep their relative order, so this is a
/// stable sort and an already-ordered mempool comes back unchanged.
pub fn topo_order(mempool: &[Transaction]) -> Vec<usize> {
    // txid -> index, so an input can be resolved to the pending tx creating it.
    let mut by_txid: HashMap<[u8; 32], usize> = HashMap::new();
    for (i, tx) in mempool.iter().enumerate() {
        by_txid.insert(tx.txid(), i);
    }

    let mut done = vec![false; mempool.len()];
    let mut out = Vec::with_capacity(mempool.len());
    // Repeated passes rather than recursion: the depth is bounded by
    // MAX_PENDING_CHAIN in practice but the mempool on disk is untrusted
    // input, and a cycle — impossible with real txids, but cheap to be
    // immune to — must not blow the stack.
    loop {
        let mut progressed = false;
        for i in 0..mempool.len() {
            if done[i] {
                continue;
            }
            let ready = mempool[i].inputs.iter().all(|inp| {
                match by_txid.get(&inp.prev.txid) {
                    // Parent is in the mempool: it has to go first.
                    Some(&p) => p == i || done[p],
                    // Parent is confirmed (or unknown); nothing to wait for.
                    None => true,
                }
            });
            if ready {
                done[i] = true;
                out.push(i);
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }
    // Anything left is part of a cycle or depends on something unorderable.
    // Appended rather than dropped: this function orders, it does not filter,
    // and the caller's validation is what decides whether a tx is usable.
    for i in 0..mempool.len() {
        if !done[i] {
            out.push(i);
        }
    }
    out
}

/// The UTXO set as it will be once every pending transaction has confirmed:
/// the chain's confirmed set, minus what the mempool spends, plus what it
/// creates.
///
/// This is the view funding should select from and the view admission should
/// validate against. Outputs it adds carry the height the chain is at, so
/// maturity still works — they are never coinbase outputs, so maturity never
/// actually bites, but a view that lied about height would be a trap for the
/// next reader.
pub fn pending_view(chain: &Chain, mempool: &[Transaction]) -> HashMap<OutPoint, UtxoEntry> {
    let mut view = chain.utxos.clone();
    let height = chain.blocks.len() as u64;
    // In dependency order, so a child's inputs are present by the time it is
    // applied and its own outputs land in the view for anything after it.
    for i in topo_order(mempool) {
        let tx = &mempool[i];
        let txid = tx.txid();
        for inp in &tx.inputs {
            view.remove(&inp.prev);
        }
        for (vout, out) in tx.outputs.iter().enumerate() {
            view.insert(
                OutPoint { txid, vout: vout as u32 },
                UtxoEntry { output: out.clone(), height, coinbase: false },
            );
        }
    }
    view
}

/// Mature, unspent outputs paying `address`, including change still sitting
/// in the mempool — what a wallet may actually fund a payment from.
///
/// Returns `(outpoint, entry, confirmed)`. The flag is the caller's to
/// surface: a wallet showing a balance should distinguish settled funds from
/// its own pending change, even though both are spendable.
pub fn spendable_with_pending(
    chain: &Chain,
    mempool: &[Transaction],
    address: &[u8; 32],
) -> Vec<(OutPoint, UtxoEntry, bool)> {
    let view = pending_view(chain, mempool);
    let mut out: Vec<(OutPoint, UtxoEntry, bool)> = Vec::new();
    for (op, entry) in view {
        if &entry.output.recipient != address {
            continue;
        }
        // Confirmed means "the chain's own set still has it" — a pending
        // output is one the view added.
        let confirmed = chain.utxos.contains_key(&op);
        if confirmed && !chain.is_spendable_now(&entry) {
            // Immature coinbase. Pending outputs are never coinbase, so this
            // only ever excludes real rewards still inside their maturity
            // window.
            continue;
        }
        out.push((op, entry, confirmed));
    }
    // Confirmed first, then by amount: spend settled money before pending
    // change, so a chain of unconfirmed transactions stays as short as it can
    // be and a reorg has less to invalidate.
    out.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then(b.1.output.amount.cmp(&a.1.output.amount))
            .then(a.0.txid.cmp(&b.0.txid))
            .then(a.0.vout.cmp(&b.0.vout))
    });
    out
}

/// How many pending ancestors `tx` would have. Used to enforce
/// [`MAX_PENDING_CHAIN`] at admission.
pub fn ancestor_count(mempool: &[Transaction], tx: &Transaction) -> usize {
    let mut by_txid: HashMap<[u8; 32], usize> = HashMap::new();
    for (i, t) in mempool.iter().enumerate() {
        by_txid.insert(t.txid(), i);
    }
    let mut seen: HashSet<usize> = HashSet::new();
    let mut stack: Vec<[u8; 32]> = tx.inputs.iter().map(|i| i.prev.txid).collect();
    while let Some(id) = stack.pop() {
        let Some(&i) = by_txid.get(&id) else { continue };
        if !seen.insert(i) {
            continue;
        }
        if seen.len() > MAX_PENDING_CHAIN {
            break;
        }
        for inp in &mempool[i].inputs {
            stack.push(inp.prev.txid);
        }
    }
    seen.len()
}
