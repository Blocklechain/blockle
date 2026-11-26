//! `Node::snapshot()` must share the chain, not copy it.
//!
//! WHY THIS TEST EXISTS.
//!
//! snapshot() is on the path of every RPC method, every explorer request and
//! every stratum job across all 18 mining pools. It used to deep-copy the
//! whole chain. At 75k blocks that is 441 MB allocated and freed per request,
//! across ~113 connection threads — and glibc malloc answers that pattern by
//! giving each thread its own arena, growing each in 64 MB heaps, and never
//! returning a non-main arena heap to the OS. The mainnet node was measured at
//! 24.8 GB RSS holding a 441 MB chain, 17.3 GB of it resident in 236 empty
//! 64 MB arena heaps.
//!
//! The fix put the chain behind an `Arc`, so readers clone a pointer and the
//! chain is copied once per block connect instead of once per request. That
//! trade only holds if two properties hold with it, and both are the kind that
//! break quietly:
//!
//!   * SHARING: a snapshot must not allocate a chain. If someone reintroduces
//!     a `.clone()` into snapshot(), or stores a `Chain` instead of an
//!     `Arc<Chain>`, everything still compiles and still returns correct data
//!     — the only symptom is the node slowly eating 24 GB again. So sharing is
//!     asserted structurally, by pointer identity, not inferred from timing.
//!
//!   * ISOLATION: copy-on-write means a reader holding a snapshot while the
//!     node connects a block must keep seeing the chain as it was. If the
//!     write ever mutated shared storage instead of copying it, a reader would
//!     observe a half-applied block — a UTXO set that does not match its own
//!     block list. That is a correctness bug, not a performance one.

use std::sync::Arc;

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_node::{p2p, storage};

/// A regtest node with a genesis block, no networking, no mining threads.
fn node(tag: &str) -> (std::path::PathBuf, Arc<p2p::Node>, Keypair) {
    let params = ChainParams::regtest();
    let datadir = std::env::temp_dir().join(format!("blockle-snap-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&datadir);

    let miner = Keypair::generate();
    let mut chain = Chain::new(params.clone());
    let (genesis, _) = mine_block(&chain, miner.address(), &[]).unwrap();
    chain.connect_block(genesis.clone()).unwrap();
    storage::append_block(&datadir, &genesis).unwrap();

    // Port 0 is never bound: run() is not called, so nothing listens.
    let n = p2p::Node::new(
        p2p::NodeConfig {
            datadir: datadir.clone(),
            params,
            listen: "127.0.0.1:0".to_string(),
            connect: vec![],
            mine_to: None,
            local_mine: false,
            mine_blocks: None,
            mine_interval: None,
            pools: vec![],
            reorg_authority: false,
            selfcheck_reorg: false,
        },
        chain,
        vec![],
    );
    (datadir, n, miner)
}

/// Mine the next block onto whatever the node's tip currently is.
fn next_block(node: &Arc<p2p::Node>, miner: &Keypair) -> blockle_core::Block {
    let (chain, _) = node.snapshot();
    mine_block(&chain, miner.address(), &[]).unwrap().0
}

#[test]
fn snapshots_share_the_chain_rather_than_copying_it() {
    let (datadir, node, _miner) = node("share");

    let (a, _) = node.snapshot();
    let (b, _) = node.snapshot();

    // THE LOAD-BEARING ASSERTION. Two snapshots taken with no write between
    // them must be the same allocation. A deep copy would be equal but not
    // identical, so `==` would pass and this will not.
    assert!(
        Arc::ptr_eq(&a, &b),
        "snapshot() copied the chain — two reads returned different allocations. \
         Every RPC call, explorer request and stratum job takes a snapshot; \
         copying here is what drove the node to 24.8 GB RSS."
    );

    // Many readers at once still share one chain; nothing is per-reader.
    let many: Vec<_> = (0..64).map(|_| node.snapshot().0).collect();
    for s in &many {
        assert!(Arc::ptr_eq(s, &a), "a concurrent reader got its own copy");
    }

    let _ = std::fs::remove_dir_all(&datadir);
}

#[test]
fn a_reader_holding_a_snapshot_is_unaffected_by_a_block_connecting() {
    let (datadir, node, miner) = node("cow");

    let (before, _) = node.snapshot();
    let height_before = before.height();
    let utxos_before = before.utxos.len();
    let blocks_before = before.blocks.len();

    assert!(node.submit_block(next_block(&node, &miner), None), "block should connect");

    // ISOLATION: the view this reader already holds has not moved under it,
    // and is still internally consistent — block list, height and UTXO set all
    // describe the same chain, not a half-applied one.
    assert_eq!(before.height(), height_before, "the held snapshot's height changed");
    assert_eq!(before.utxos.len(), utxos_before, "the held snapshot's UTXO set changed");
    assert_eq!(before.blocks.len(), blocks_before, "the held snapshot's blocks changed");

    // And the node really did advance — the isolation above is not just a node
    // that failed to connect anything.
    let (after, _) = node.snapshot();
    assert_eq!(
        after.blocks.len(),
        blocks_before + 1,
        "the node did not advance, so this test proved nothing"
    );
    assert!(
        !Arc::ptr_eq(&before, &after),
        "a write must publish a new version, not mutate the one readers hold"
    );

    // Copy-on-write is not a one-shot: the next write, with no reader holding
    // the current version, must still be correct.
    assert!(node.submit_block(next_block(&node, &miner), None), "second block should connect");
    assert_eq!(node.snapshot().0.blocks.len(), blocks_before + 2);
    assert_eq!(before.blocks.len(), blocks_before, "the original snapshot is still pinned");

    let _ = std::fs::remove_dir_all(&datadir);
}
