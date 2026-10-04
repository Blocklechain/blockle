//! Disk layout under the data directory:
//! - `blocks.jsonl`  — one JSON block per line, append-only (rewritten on reorg)
//! - `wallet.json`   — hex-encoded ML-DSA-44 keypair + address
//! - `mempool.json`  — pending transactions awaiting a mined block

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use blockle_chain::{Chain, ChainParams};
use blockle_core::{Block, Transaction};

pub fn blocks_path(datadir: &Path) -> PathBuf {
    datadir.join("blocks.jsonl")
}

pub fn wallet_path(datadir: &Path) -> PathBuf {
    datadir.join("wallet.json")
}

pub fn mempool_path(datadir: &Path) -> PathBuf {
    datadir.join("mempool.json")
}

/// Load stored blocks; errors if the chain was never initialized.
pub fn load_blocks(datadir: &Path) -> Result<Vec<Block>> {
    let path = blocks_path(datadir);
    if !path.exists() {
        bail!(
            "no chain found in {} — run `blockle init` or `blockle start --connect …`",
            datadir.display()
        );
    }
    read_blocks(&path)
}

/// Load stored blocks, treating a missing file as an empty chain.
pub fn load_blocks_or_empty(datadir: &Path) -> Result<Vec<Block>> {
    let path = blocks_path(datadir);
    if !path.exists() {
        return Ok(vec![]);
    }
    read_blocks(&path)
}

fn read_blocks(path: &Path) -> Result<Vec<Block>> {
    let data = fs::read_to_string(path)?;
    data.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).context("corrupt block in blocks.jsonl"))
        .collect()
}

pub fn append_block(datadir: &Path, block: &Block) -> Result<()> {
    fs::create_dir_all(datadir)?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(blocks_path(datadir))?;
    writeln!(f, "{}", serde_json::to_string(block)?)?;
    Ok(())
}

/// Rewrite the whole block file (used when adopting a heavier chain).
pub fn save_chain(datadir: &Path, blocks: &[Block]) -> Result<()> {
    fs::create_dir_all(datadir)?;
    let mut out = String::new();
    for block in blocks {
        out.push_str(&serde_json::to_string(block)?);
        out.push('\n');
    }
    let tmp = blocks_path(datadir).with_extension("jsonl.tmp");
    fs::write(&tmp, out)?;
    fs::rename(&tmp, blocks_path(datadir))?;
    Ok(())
}

pub fn load_chain(datadir: &Path, params: ChainParams) -> Result<Chain> {
    let blocks = load_blocks(datadir)?;
    Chain::from_blocks(params, blocks).map_err(|e| anyhow!("stored chain failed validation: {e}"))
}

pub fn load_chain_or_empty(datadir: &Path, params: ChainParams) -> Result<Chain> {
    let blocks = load_blocks_or_empty(datadir)?;
    Chain::from_blocks(params, blocks).map_err(|e| anyhow!("stored chain failed validation: {e}"))
}

pub fn load_mempool(datadir: &Path) -> Result<Vec<Transaction>> {
    let path = mempool_path(datadir);
    if !path.exists() {
        return Ok(vec![]);
    }
    Ok(serde_json::from_str(&fs::read_to_string(&path)?)?)
}

pub fn save_mempool(datadir: &Path, txs: &[Transaction]) -> Result<()> {
    fs::create_dir_all(datadir)?;
    fs::write(mempool_path(datadir), serde_json::to_string_pretty(txs)?)?;
    Ok(())
}

// ---------- shielded note store ----------

use serde::{Deserialize, Serialize};

/// A shielded note's secrets, held by the wallet. The nullifier is secret
/// until the note is spent.
#[derive(Clone, Serialize, Deserialize)]
pub struct NoteRecord {
    /// Hex of the 32-byte note commitment (on-chain locator).
    pub commitment: String,
    /// Hex of the 32-byte nullifier (secret until spent).
    pub nullifier: String,
    /// Hex of the 16-byte blinding field element.
    pub blinding: String,
    /// Note value in base units (public in protocol v1).
    pub value: u64,
}

pub fn notes_path(datadir: &Path) -> PathBuf {
    datadir.join("notes.json")
}

pub fn load_notes(datadir: &Path) -> Result<Vec<NoteRecord>> {
    let path = notes_path(datadir);
    if !path.exists() {
        return Ok(vec![]);
    }
    Ok(serde_json::from_str(&fs::read_to_string(&path)?)?)
}

pub fn save_notes(datadir: &Path, notes: &[NoteRecord]) -> Result<()> {
    fs::create_dir_all(datadir)?;
    fs::write(notes_path(datadir), serde_json::to_string_pretty(notes)?)?;
    Ok(())
}
