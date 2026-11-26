//! MEASUREMENT HARNESS (not shipped logic): how expensive is the p2p reorg
//! path (`Chain::from_blocks(prefix + fork)`) as chain height grows, versus the
//! append-only path (`connect_block` over just the batch)?
//!
//! Usage: reorg_bench <blocks.jsonl> <N1,N2,...> [batch]
//! Reads real mainnet blocks and, for each N:
//!   * clones blocks[..N]              -> the `prefix.to_vec()` cost
//!   * Chain::from_blocks over them    -> the per-batch reorg validation cost
//!   * connect_block over [N..N+batch] -> the append-path cost at that height
//! Also prints raw-vs-energy total work (the fork-choice unit question) and
//! probes whether block N+1 connects at all.

use std::time::Instant;

use blockle_chain::{Chain, ChainParams};
use blockle_core::Block;
use blockle_pow::difficulty::block_work;
use blockle_pow::U256;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let ns: Vec<usize> = args[2].split(',').map(|s| s.parse().unwrap()).collect();
    let batch: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(2000);

    let t0 = Instant::now();
    let data = std::fs::read_to_string(path).expect("read blocks");
    let master: Vec<Block> = data
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("parse block"))
        .collect();
    drop(data);
    eprintln!("loaded {} blocks in {:?}", master.len(), t0.elapsed());

    let params = ChainParams::mainnet();
    println!("# N\tclone_ms\tfrom_blocks_ms\tms_per_block\tappend_{batch}_ms\tspeedup");

    for &n in &ns {
        if n > master.len() {
            eprintln!("skip N={n}: only {} blocks available", master.len());
            continue;
        }
        // --- the prefix clone the reorg path does ---
        let tc = Instant::now();
        let prefix: Vec<Block> = master[..n].to_vec();
        let clone_ms = tc.elapsed().as_secs_f64() * 1000.0;

        // --- the from-genesis revalidation the reorg path does ---
        let tf = Instant::now();
        let mut chain = match Chain::from_blocks(params.clone(), prefix) {
            Ok(c) => c,
            Err(e) => {
                println!("N={n}\tFROM_BLOCKS FAILED: {e}");
                continue;
            }
        };
        let from_ms = tf.elapsed().as_secs_f64() * 1000.0;

        // --- the append path at the same height ---
        let mut append_ms = f64::NAN;
        let mut appended = 0usize;
        if n + batch <= master.len() {
            let ta = Instant::now();
            for b in &master[n..n + batch] {
                match chain.connect_block(b.clone()) {
                    Ok(()) => appended += 1,
                    Err(e) => {
                        println!("# N={n}: connect_block failed at height {} : {e}", n + appended);
                        break;
                    }
                }
            }
            append_ms = ta.elapsed().as_secs_f64() * 1000.0;
        } else if n < master.len() {
            // still probe the single next block
            let nb = master[n].clone();
            match chain.connect_block(nb) {
                Ok(()) => {
                    appended = 1;
                    println!("# N={n}: block {n} connects OK");
                }
                Err(e) => println!("# N={n}: block {n} REJECTED: {e}"),
            }
        }

        println!(
            "{n}\t{clone_ms:.0}\t{from_ms:.0}\t{:.3}\t{append_ms:.0}\t{:.0}x",
            from_ms / n as f64,
            from_ms / append_ms.max(0.001)
        );

        // --- fork-choice units: raw sum vs energy-weighted total_work ---
        let raw: U256 = chain
            .blocks
            .iter()
            .fold(U256::zero(), |a, b| a.saturating_add(block_work(b.header.bits)));
        let energy = chain.total_work();
        println!(
            "#   height={:?} appended={appended} raw_work={raw} energy_work={energy} raw_gt_energy={}",
            chain.height(),
            raw > energy
        );
        drop(chain);
    }
}
