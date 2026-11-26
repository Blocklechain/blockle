//! ADVERSARIAL: the recovery story `rewrite_tail`'s doc comment relies on.
//!
//! It claims: "a crash midway through the appends leaves a shorter valid chain
//! plus possibly one half-written final line, which `read_blocks` drops. Either
//! way the node starts and the next heartbeat re-fetches the rest."
//!
//! These tests follow that exact sequence one step further than the comment
//! does: drop the partial line, then append the next block, then restart again.

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_node::storage;

fn datadir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "blockle-storage-attack-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// Two regtest blocks, natively mined (regtest equihash 48,5 is cheap).
fn two_blocks() -> (ChainParams, Vec<blockle_core::Block>) {
    let params = ChainParams::regtest();
    let mut chain = Chain::new(params.clone());
    let addr = [7u8; 32];
    let mut out = Vec::new();
    for _ in 0..2 {
        let (b, _) = mine_block(&chain, addr, &[]).expect("mine");
        chain.connect_block(b.clone()).expect("connects");
        out.push(b);
    }
    (params, out)
}

#[test]
fn an_interrupted_append_bricks_the_datadir_on_the_second_restart() {
    let dir = datadir("interrupted");
    let (params, blocks) = two_blocks();

    // --- Normal operation: genesis is appended and the file is well formed.
    storage::append_block(&dir, &blocks[0]).expect("append genesis");

    // --- The interrupted append. `append_block` is `writeln!` on an unbuffered
    // File, so std issues the JSON and the '\n' as SEPARATE write_all calls;
    // ENOSPC or a kill between them leaves exactly this state. (Simulated here
    // by writing the bytes without the newline, which is what the file looks
    // like either way.)
    {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(storage::blocks_path(&dir))
            .expect("open");
        let line = serde_json::to_string(&blocks[1]).expect("serialize");
        // Half the bytes and no '\n' — the process died here.
        f.write_all(&line.as_bytes()[..line.len() / 2]).expect("partial write");
    }

    // --- RESTART 1. This is the behaviour the new code added, and it works:
    // the truncated final line is dropped and the node comes up one block short.
    let loaded = storage::load_blocks_or_empty(&dir).expect("restart 1 should succeed");
    assert_eq!(loaded.len(), 1, "the truncated final line should be dropped");

    // --- The node now re-fetches block 1 and appends it, exactly as the
    // comment says it will. Nothing truncated the stale bytes, so this append
    // lands on a line that has no newline in front of it.
    storage::append_block(&dir, &blocks[1]).expect("re-append block 1");

    let raw = std::fs::read_to_string(storage::blocks_path(&dir)).expect("read");
    println!("lines on disk: {}", raw.lines().count());

    // --- RESTART 2.
    let again = storage::load_blocks_or_empty(&dir);
    match &again {
        Ok(v) => println!("restart 2 loaded {} blocks", v.len()),
        Err(e) => println!("restart 2 FAILED: {e}"),
    }
    assert!(
        again.is_ok(),
        "restart 2 failed: the datadir is unrecoverable. {:?}",
        again.err().map(|e| format!("{e:#}"))
    );
    assert_eq!(
        again.unwrap().len(),
        2,
        "the re-appended block was swallowed by the stale partial line"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
