//! Disk layout under the data directory:
//! - `blocks.jsonl`  — one JSON block per line, append-only (rewritten on reorg)
//! - `wallet.json`   — hex-encoded ML-DSA-44 keypair + address
//! - `mempool.json`  — pending transactions awaiting a mined block

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead as _, BufReader, BufWriter, Read as _, Seek, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use blockle_chain::{Chain, ChainParams};
use blockle_core::hash::Hash32;
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
    // A TRAILING PARTIAL LINE IS DROPPED, NOT AN ERROR. `append_block` is a
    // plain append, so a crash or a full disk mid-write leaves half a JSON
    // object on the last line. Erroring there means the node refuses to start
    // and the operator's only move is to delete the chain and re-sync; dropping
    // it costs one block that the next heartbeat re-fetches. Any OTHER corrupt
    // line is still a hard error — that is real damage, not an interrupted
    // write, and silently skipping it would hand `from_blocks` a chain with a
    // hole in it.
    let has_final_newline = data.ends_with('\n');
    let mut lines: Vec<&str> = data.lines().filter(|l| !l.trim().is_empty()).collect();
    if !has_final_newline && !lines.is_empty() {
        let last = lines[lines.len() - 1];
        if serde_json::from_str::<Block>(last).is_err() {
            println!(
                "[storage] dropping a truncated final line of blocks.jsonl ({} bytes) — \
                 interrupted append; the missing block will re-sync",
                last.len()
            );
            lines.pop();
        }
    }
    lines
        .into_iter()
        .map(|l| serde_json::from_str(l).context("corrupt block in blocks.jsonl"))
        .collect()
}

pub fn append_block(datadir: &Path, block: &Block) -> Result<()> {
    fs::create_dir_all(datadir)?;
    /*
     * DROP A TORN FINAL RECORD BEFORE WRITING AFTER IT, or the next restart
     * finds a corrupt line it is not allowed to skip.
     *
     * `append_block` is `writeln!` on an unbuffered File, so std issues the
     * JSON and the '\n' as SEPARATE write_all calls. A kill, a power loss or
     * ENOSPC between the two leaves a final line with no newline — which the
     * reader tolerates, because a truncated LAST line is the documented crash
     * shape and it is dropped on load.
     *
     * The bug was what happened next. The node re-fetches the block it lost
     * and appends it; this write lands directly against those stale bytes with
     * no newline between them, fusing the partial record and a good one into a
     * single corrupt line. That line is no longer last, so the reader's
     * tolerance does not apply to it, and the load fails outright: the datadir
     * is unrecoverable and no restart or reinstall fixes it, because a
     * reinstall keeps the datadir.
     *
     * Truncating is safe and is not data loss: a record with no terminating
     * newline was never a complete record, the reader already refuses to
     * count it, and the heartbeat re-fetches that height. Doing it in the
     * writer rather than the reader keeps loading side-effect free — a loader
     * that silently rewrites the file it was asked to read is its own trap.
     *
     * Covered by `an_interrupted_append_bricks_the_datadir_on_the_second_restart`.
     */
    truncate_torn_tail(datadir)?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(blocks_path(datadir))?;
    let offset = f.metadata()?.len();
    writeln!(f, "{}", serde_json::to_string(block)?)?;
    // Index AFTER the block, never before: an index entry for a block that is
    // not on disk would point `rewrite_tail` past the end of the file. The
    // reverse (a block with no index entry) just degrades to the byte scan.
    append_offset(datadir, offset)?;
    Ok(())
}

/// If the block file does not end in a newline, cut back to the last one.
///
/// A file whose final byte is not '\n' has a record that was never finished
/// being written. See `append_block` for why writing after it is the thing
/// that actually bricks the datadir. A missing or empty file is fine and does
/// nothing; the offset index is trimmed to match so it cannot point into the
/// region that was cut.
fn truncate_torn_tail(datadir: &Path) -> Result<()> {
    let path = blocks_path(datadir);
    let len = match fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(()),
    };
    if len == 0 {
        return Ok(());
    }
    let raw = fs::read(&path)?;
    if raw.last() == Some(&b'\n') {
        return Ok(());
    }
    // Keep everything up to and including the last newline. If there is none,
    // the whole file is one unterminated record and nothing is salvageable.
    let keep = match raw.iter().rposition(|b| *b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    };
    let dropped = raw.len() - keep;
    let f = OpenOptions::new().write(true).open(&path)?;
    f.set_len(keep as u64)?;
    f.sync_all()?;
    // The index must not describe bytes that are gone. One entry per line, so
    // the surviving line count is the entry count to keep.
    let lines = raw[..keep].iter().filter(|b| **b == b'\n').count();
    truncate_offsets(datadir, lines)?;
    eprintln!(
        "[storage] dropped {dropped} trailing bytes of an unterminated block \
         record (interrupted write); {lines} complete blocks remain on disk"
    );
    Ok(())
}

/// Rewrite the whole block file. Only for callers that really are replacing
/// every block (tests, `blockle init`); a reorg uses [`rewrite_tail`], which
/// touches only the blocks that actually changed.
pub fn save_chain(datadir: &Path, blocks: &[Block]) -> Result<()> {
    fs::create_dir_all(datadir)?;
    let mut out = String::new();
    let mut offsets: Vec<u64> = Vec::with_capacity(blocks.len());
    for block in blocks {
        offsets.push(out.len() as u64);
        out.push_str(&serde_json::to_string(block)?);
        out.push('\n');
    }
    let tmp = blocks_path(datadir).with_extension("jsonl.tmp");
    fs::write(&tmp, out)?;
    fs::rename(&tmp, blocks_path(datadir))?;
    write_offsets(datadir, &offsets)?;
    Ok(())
}

// ---------- the reorg write path ----------

/// Byte offset of the first byte of each block's line in `blocks.jsonl`, one
/// little-endian u64 per block.
///
/// PURELY DERIVED: it holds nothing that is not recoverable by reading
/// `blocks.jsonl`, it is validated against that file before it is ever trusted
/// (see [`truncation_offset`]), and a missing or stale one only costs a byte
/// scan. That is deliberate — the live mainnet datadirs predate this file, so
/// the first run after an upgrade must work with no index at all, and the
/// recovery path must be the normal path rather than a rarely-exercised one.
pub fn blocks_index_path(datadir: &Path) -> PathBuf {
    datadir.join("blocks.idx")
}

fn append_offset(datadir: &Path, offset: u64) -> Result<()> {
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(blocks_index_path(datadir))?;
    f.write_all(&offset.to_le_bytes())?;
    Ok(())
}

/// Keep the first `entries` offsets, discarding the rest.
///
/// Fixed 8 bytes per entry, so this is a `set_len`. Used when a torn block
/// record is cut: an index entry describing bytes that no longer exist would
/// send `rewrite_tail` seeking past the end of the file.
fn truncate_offsets(datadir: &Path, entries: usize) -> Result<()> {
    let path = blocks_index_path(datadir);
    if !path.exists() {
        return Ok(());
    }
    let want = (entries as u64) * 8;
    let f = OpenOptions::new().write(true).open(&path)?;
    if f.metadata()?.len() > want {
        f.set_len(want)?;
        f.sync_all()?;
    }
    Ok(())
}

fn write_offsets(datadir: &Path, offsets: &[u64]) -> Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(offsets.len() * 8);
    for o in offsets {
        buf.extend_from_slice(&o.to_le_bytes());
    }
    let tmp = blocks_index_path(datadir).with_extension("idx.tmp");
    fs::write(&tmp, buf)?;
    fs::rename(&tmp, blocks_index_path(datadir))?;
    Ok(())
}

/// The index's entry for block `n`, or `None` if the index is absent/too short.
fn indexed_offset(datadir: &Path, n: usize) -> Option<u64> {
    let mut f = File::open(blocks_index_path(datadir)).ok()?;
    let want = (n as u64).checked_mul(8)?;
    if f.metadata().ok()?.len() < want + 8 {
        return None;
    }
    f.seek(SeekFrom::Start(want)).ok()?;
    let mut b = [0u8; 8];
    f.read_exact(&mut b).ok()?;
    Some(u64::from_le_bytes(b))
}

/// Byte offset just past the line of block `keep - 1` — i.e. where block `keep`
/// begins and where the file must be cut.
///
/// `anchor` is the header hash the caller expects block `keep - 1` to have, and
/// it is CHECKED rather than assumed. That check is the whole safety argument
/// for truncating in place: a wrong offset here would destroy good blocks, so
/// the offset is only used once the block immediately before it has been read
/// back off disk and identified. A mismatch (stale index, index from another
/// datadir, index and file out of step after a crash between the two appends)
/// falls back to counting newlines, which cannot be wrong because it does not
/// depend on any derived state.
fn truncation_offset(path: &Path, datadir: &Path, keep: usize, anchor: Hash32) -> Result<u64> {
    if keep == 0 {
        return Ok(0);
    }
    if let Some(start) = indexed_offset(datadir, keep - 1) {
        if let Some(end) = verify_line_at(path, start, anchor)? {
            return Ok(end);
        }
        println!(
            "[storage] blocks.idx disagrees with blocks.jsonl at block {} — \
             falling back to a byte scan and rebuilding the index",
            keep - 1
        );
    }
    scan_truncation_offset(path, keep, anchor)
}

/// Read the line starting at `start`; if it is block `anchor`, return the
/// offset just past it. `None` means "that is not the block I expected".
fn verify_line_at(path: &Path, start: u64, anchor: Hash32) -> Result<Option<u64>> {
    let mut f = File::open(path)?;
    if start >= f.metadata()?.len() {
        return Ok(None);
    }
    f.seek(SeekFrom::Start(start))?;
    let mut r = BufReader::new(f);
    let mut line = String::new();
    let n = read_line_limited(&mut r, &mut line)?;
    let Ok(block) = serde_json::from_str::<Block>(line.trim_end()) else {
        return Ok(None);
    };
    if block.header.hash() != anchor {
        return Ok(None);
    }
    Ok(Some(start + n as u64))
}

/// Count newlines to find the end of block `keep - 1`, then verify it. The
/// index-free oracle: O(file) bytes read, no JSON parsing except the one
/// anchor line, and nothing derived to be stale.
fn scan_truncation_offset(path: &Path, keep: usize, anchor: Hash32) -> Result<u64> {
    let f = File::open(path)?;
    let mut r = BufReader::new(f);
    let mut pos: u64 = 0;
    let mut seen = 0usize;
    let mut line = String::new();
    loop {
        line.clear();
        let n = read_line_limited(&mut r, &mut line)?;
        if n == 0 {
            bail!(
                "blocks.jsonl holds only {seen} blocks but the chain wants to keep {keep} — \
                 refusing to truncate"
            );
        }
        pos += n as u64;
        if line.trim().is_empty() {
            continue;
        }
        seen += 1;
        if seen == keep {
            break;
        }
    }
    let block: Block = serde_json::from_str(line.trim_end())
        .context("corrupt block in blocks.jsonl at the reorg truncation point")?;
    if block.header.hash() != anchor {
        bail!(
            "blocks.jsonl block {} is {} but the chain says it is {} — refusing to truncate a \
             file that is not the chain we are holding",
            keep - 1,
            blockle_core::display_hash(&block.header.hash()),
            blockle_core::display_hash(&anchor)
        );
    }
    Ok(pos)
}

/// `BufRead::read_line` with a ceiling, so a corrupt file with no newlines
/// cannot be read into memory in its entirety. Returns bytes consumed.
fn read_line_limited<R: std::io::BufRead>(r: &mut R, out: &mut String) -> Result<usize> {
    const MAX_LINE: u64 = 64 * 1024 * 1024;
    let mut limited = r.take(MAX_LINE);
    let n = limited.read_line(out)?;
    if n as u64 == MAX_LINE {
        bail!("a line in blocks.jsonl exceeds {MAX_LINE} bytes — refusing to parse it");
    }
    Ok(n)
}

/// Replace the blocks from `keep` onward with `tail`, keeping the first `keep`
/// blocks byte-for-byte as they already are on disk.
///
/// WHY NOT `save_chain`. The reorg path used to call `save_chain`, which builds
/// the ENTIRE file as one in-memory `String` — 954 MB at height 82,000 — and it
/// did so while holding the node's state lock, stalling mining, RPC, the
/// explorer and all 18 stratum pools for the duration. That was survivable only
/// because a reorg never completed. Now that a shallow reorg costs milliseconds
/// and happens dozens of times an hour, rewriting a gigabyte each time would be
/// ~16 GB of writes per hour and would wear out the disk; it also scales with
/// chain height rather than with how much actually changed.
///
/// WHY TRUNCATE IN PLACE RATHER THAN temp-file + rename. Copying the retained
/// prefix to a temp file is the usual way to make a rewrite atomic, but here it
/// would copy ~954 MB to change a handful of blocks, which is the cost we are
/// trying to remove. In-place is safe for this file BECAUSE OF ITS SHAPE: every
/// prefix of `blocks.jsonl` is a valid chain. A crash after the truncate but
/// before the appends leaves a shorter valid chain; a crash midway through the
/// appends leaves a shorter valid chain plus possibly one half-written final
/// line, which `read_blocks` drops. Either way the node starts and the next
/// heartbeat re-fetches the rest — the same recovery the append path has always
/// relied on. The truncation point itself is the part that must not be wrong,
/// so it is verified against the block on disk (see [`truncation_offset`]).
///
/// The caller must have ALREADY swapped the new chain into memory: memory
/// first, disk second, so a crash in between leaves a lighter-but-valid chain
/// on disk rather than a chain the node never validated.
pub fn rewrite_tail(
    datadir: &Path,
    keep: usize,
    anchor: Hash32,
    tail: &[Arc<Block>],
) -> Result<()> {
    fs::create_dir_all(datadir)?;
    let path = blocks_path(datadir);
    if !path.exists() {
        // Nothing to preserve — write the whole thing.
        let all: Vec<Block> = tail.iter().map(|b| (**b).clone()).collect();
        return save_chain(datadir, &all);
    }
    let cut = truncation_offset(&path, datadir, keep, anchor)?;

    let mut f = OpenOptions::new().read(true).write(true).open(&path)?;
    f.set_len(cut)?;
    f.seek(SeekFrom::End(0))?;
    let mut offsets: Vec<u64> = Vec::with_capacity(tail.len());
    let mut pos = cut;
    {
        let mut w = BufWriter::new(&mut f);
        for b in tail {
            offsets.push(pos);
            let line = serde_json::to_string(&**b)?;
            w.write_all(line.as_bytes())?;
            w.write_all(b"\n")?;
            pos += line.len() as u64 + 1;
        }
        w.flush()?;
    }
    // fsync the data before the index that describes it, so the index can
    // never be ahead of the file it indexes.
    f.sync_all()?;

    // The index is rewritten wholesale for the retained prefix + new tail. It
    // is only `keep + tail.len()` u64s (0.66 MB at height 82,000), so there is
    // nothing to be gained by being clever, and a full rewrite cannot leave it
    // half-describing the old branch.
    let mut idx: Vec<u64> = Vec::with_capacity(keep + tail.len());
    match read_offsets_prefix(datadir, keep) {
        Some(prefix) => idx.extend_from_slice(&prefix),
        None => {
            // No usable index: rebuild the prefix offsets by scanning. Paid at
            // most once, on the first reorg after an upgrade from a build that
            // never wrote an index.
            idx.extend(scan_offsets(&path, keep)?);
        }
    }
    idx.extend_from_slice(&offsets);
    write_offsets(datadir, &idx)?;
    Ok(())
}

fn read_offsets_prefix(datadir: &Path, keep: usize) -> Option<Vec<u64>> {
    let data = fs::read(blocks_index_path(datadir)).ok()?;
    if data.len() < keep * 8 {
        return None;
    }
    Some(
        data[..keep * 8]
            .chunks_exact(8)
            .map(|c| u64::from_le_bytes(c.try_into().expect("chunks_exact(8) yields 8 bytes")))
            .collect(),
    )
}

fn scan_offsets(path: &Path, keep: usize) -> Result<Vec<u64>> {
    let f = File::open(path)?;
    let mut r = BufReader::new(f);
    let mut out = Vec::with_capacity(keep);
    let mut pos: u64 = 0;
    let mut line = String::new();
    while out.len() < keep {
        line.clear();
        let start = pos;
        let n = read_line_limited(&mut r, &mut line)?;
        if n == 0 {
            break;
        }
        pos += n as u64;
        if !line.trim().is_empty() {
            out.push(start);
        }
    }
    Ok(out)
}

pub fn load_chain(datadir: &Path, params: ChainParams) -> Result<Chain> {
    let blocks = load_blocks(datadir)?;
    Chain::from_blocks(params, blocks).map_err(|e| anyhow!("stored chain failed validation: {e}"))
}

/// [`load_chain`] that also returns reorg replay bases captured during the
/// replay it already performs. See `Chain::from_blocks_with_prefixes` and
/// `p2p::Node::new_with_prefixes` for why a restarted node needs them.
pub fn load_chain_with_prefixes(
    datadir: &Path,
    params: ChainParams,
    interval: u64,
    keep: usize,
) -> Result<(Chain, Vec<std::sync::Arc<Chain>>)> {
    let blocks = load_blocks_or_empty(datadir)?;
    Chain::from_blocks_with_prefixes(params, blocks, interval, keep)
        .map_err(|e| anyhow!("stored chain failed validation: {e}"))
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
