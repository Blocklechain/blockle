//! MEASUREMENT HARNESS (not shipped) — times the two headers-first sync paths
//! in p2p.rs::handle_blocks as a function of chain height, using REAL mainnet
//! blocks so every consensus check does its real work.
//!
//! usage: reorgbench <blocks.jsonl> <max_blocks> <mode>
//!   mode = append    incremental connect_block in 2000-block batches (fast path)
//!   mode = reorg     Chain::from_blocks over blocks[..N] for several N (reorg path)
//!   mode = replay    connect every block, report the FIRST validation failure
//!   mode = connectcost  per-block connect_block cost at increasing heights

use std::path::PathBuf;
use std::time::Instant;

use blockle_chain::{Chain, ChainParams};
use blockle_core::Block;

const BATCH: usize = 2000; // MAX_BLOCKS_PER_REQUEST in p2p.rs

fn load(path: &PathBuf, max: usize) -> Vec<Block> {
    let t = Instant::now();
    let data = std::fs::read_to_string(path).expect("read blocks.jsonl");
    let mut out = Vec::with_capacity(max);
    for line in data.lines() {
        if out.len() >= max {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str::<Block>(line).expect("parse block"));
    }
    eprintln!("[load] {} blocks parsed in {:.1}s", out.len(), t.elapsed().as_secs_f64());
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = PathBuf::from(&args[1]);
    let max: usize = args[2].parse().unwrap();
    let mode = args.get(3).cloned().unwrap_or_else(|| "append".into());
    let params = ChainParams::mainnet();
    let blocks = load(&path, max);

    match mode.as_str() {
        // ---- FAST PATH: cost of connecting one 2000-block batch at height N.
        "append" => {
            println!("# append-only path (p2p.rs fast path): per-2000-block-batch seconds");
            println!("# tip_before\tbatch_secs\tper_block_ms\tcum_secs");
            let mut chain = Chain::new(params.clone());
            let mut cum = 0.0f64;
            let mut idx = 0usize;
            while idx < blocks.len() {
                let end = (idx + BATCH).min(blocks.len());
                let t = Instant::now();
                for b in &blocks[idx..end] {
                    if let Err(e) = chain.connect_block(b.clone()) {
                        println!("!! connect_block FAILED at height {}: {e}", chain.blocks.len());
                        return;
                    }
                }
                let secs = t.elapsed().as_secs_f64();
                cum += secs;
                println!(
                    "{}\t{:.3}\t{:.3}\t{:.1}",
                    idx,
                    secs,
                    secs * 1000.0 / (end - idx) as f64,
                    cum
                );
                idx = end;
            }
        }

        // ---- REORG PATH: exactly what p2p.rs:816-838 does — clone the prefix,
        // append the batch, Chain::from_blocks over the whole candidate.
        "reorg" => {
            println!("# reorg path (p2p.rs:816-838): cost of ONE adoption at tip N");
            println!("# N\tprefix_clone_secs\tfrom_blocks_secs\ttotal_secs");
            let mut ns: Vec<usize> = vec![1000, 2000, 5000, 10000, 20000, 30000, 40000, 58000];
            ns.retain(|n| *n <= blocks.len());
            for n in ns {
                // start = n - BATCH (fork rooted BATCH below our tip); candidate
                // = prefix(start) + the peer's BATCH blocks.
                let start = n.saturating_sub(BATCH);
                let t0 = Instant::now();
                let prefix: Vec<Block> = blocks[..start].to_vec();
                let clone_s = t0.elapsed().as_secs_f64();
                let mut candidate = prefix;
                candidate.extend(blocks[start..n].iter().cloned());
                let t1 = Instant::now();
                match Chain::from_blocks(params.clone(), candidate) {
                    Ok(c) => {
                        let v = t1.elapsed().as_secs_f64();
                        println!(
                            "{}\t{:.3}\t{:.3}\t{:.3}\t(height {:?})",
                            n,
                            clone_s,
                            v,
                            clone_s + v,
                            c.height()
                        );
                    }
                    Err(e) => {
                        println!("{}\tFAILED after {:.3}s: {e}", n, t1.elapsed().as_secs_f64());
                        return;
                    }
                }
            }
        }

        // ---- Does every stored block actually re-validate? Finds the first
        // height where a fresh node's connect_block would reject.
        "replay" => {
            let mut chain = Chain::new(params.clone());
            let t = Instant::now();
            for (h, b) in blocks.iter().enumerate() {
                if let Err(e) = chain.connect_block(b.clone()) {
                    println!("FIRST FAILURE at height {h}: {e}");
                    println!("  block hash   {}", hex::encode(b.header.hash()));
                    println!("  bits         {:#010x}", b.header.bits);
                    println!("  time         {}", b.header.time);
                    println!("  lane         {}", Chain::lane_of(b));
                    return;
                }
                if h % 5000 == 0 {
                    println!("  .. {h} ok ({:.0}s)", t.elapsed().as_secs_f64());
                }
            }
            println!("ALL {} blocks re-validated clean in {:.0}s", blocks.len(), t.elapsed().as_secs_f64());
        }

        // ---- Per-block connect cost vs height: is a single connect_block O(1)
        // or O(height)?
        "connectcost" => {
            println!("# single connect_block cost at increasing heights");
            println!("# height\tms_per_block (mean of 50)\tutxos");
            let mut chain = Chain::new(params.clone());
            let mut next_probe = 1000usize;
            let mut window = Instant::now();
            let mut window_start = 0usize;
            for (h, b) in blocks.iter().enumerate() {
                if h == next_probe {
                    let n = h - window_start;
                    println!(
                        "{}\t{:.4}\t{}",
                        h,
                        window.elapsed().as_secs_f64() * 1000.0 / n as f64,
                        chain.utxos.len()
                    );
                    next_probe = match h {
                        x if x < 10000 => x + 1000,
                        x if x < 60000 => x + 5000,
                        x => x + 10000,
                    };
                    window = Instant::now();
                    window_start = h;
                }
                if let Err(e) = chain.connect_block(b.clone()) {
                    println!("!! failed at {h}: {e}");
                    return;
                }
            }
        }
        // ---- Faithful replay of the real sync loop against a peer that serves
        // the whole chain: reproduces serve_headers' start_height, then the
        // EXACT work arithmetic of handle_headers (p2p.rs:713-721) and the
        // fast/reorg path split of handle_blocks. Reports the height at which a
        // from-genesis node first fails the headers work check (silent stall) or
        // first takes the reorg path.
        "syncsim" => {
            let start_len: usize = args.get(4).map(|s| s.parse().unwrap()).unwrap_or(0);
            println!("# syncsim: from-genesis sync against a peer holding all {} blocks", blocks.len());
            println!("# our_len\tstart\tpath\tretained+new (raw)\tours (total_work)\tdecision");
            // Seed the chain with the first `start_len` blocks (simulating a node
            // that already has them), then sync in 2000-block batches.
            let mut chain = Chain::new(params.clone());
            for b in &blocks[..start_len] {
                chain.connect_block(b.clone()).expect("seed block");
            }
            loop {
                let our_len = chain.blocks.len();
                if our_len >= blocks.len() {
                    println!("reached peer tip at len {our_len}");
                    break;
                }
                // serve_headers: our locator is tip-first; our tip IS on the
                // peer's chain, so the first locator match is at our_len-1 and
                // start = our_len.
                let start = our_len;
                let end = (start + BATCH).min(blocks.len());
                let headers: Vec<_> = blocks[start..end].iter().map(|b| b.header.clone()).collect();
                // handle_headers work arithmetic, verbatim:
                let retained: blockle_pow::U256 = chain.blocks[..start]
                    .iter()
                    .fold(blockle_pow::U256::zero(), |a, b| {
                        a.saturating_add(blockle_pow::difficulty::block_work(b.header.bits))
                    });
                let new_work: blockle_pow::U256 = headers
                    .iter()
                    .fold(blockle_pow::U256::zero(), |a, h| {
                        a.saturating_add(blockle_pow::difficulty::block_work(h.bits))
                    });
                let cand = retained.saturating_add(new_work);
                let ours = chain.total_work();

                // THE FIXED GATE, as `handle_headers` now computes it: the
                // retained prefix at its exact ENERGY-WEIGHTED work (O(1) via
                // work_upto) plus a one-sided upper bound on what the announced
                // headers could contribute. Both sides are now in the same
                // units, which is the whole fix.
                let retained_w = chain.work_upto(start);
                let best_new = headers.iter().enumerate().fold(
                    blockle_pow::U256::zero(),
                    |a, (i, h)| {
                        a.saturating_add(chain.header_work_upper_bound((start + i) as u64, h.bits))
                    },
                );
                let cand_fixed = retained_w.saturating_add(best_new);
                let old_would_stall = cand <= ours;

                if cand_fixed <= ours {
                    println!(
                        "{our_len}\t{start}\tn/a\t{cand_fixed}\t{ours}\tSTALL under the FIXED \
                         gate (height {:?}) — this should not happen",
                        chain.height()
                    );
                    println!("  retained(weighted) = {retained_w}");
                    println!("  best-case new({} hdrs) = {best_new}", headers.len());
                    break;
                }
                if old_would_stall {
                    // The exact point the shipped v0.8.0 wallet gives up, with
                    // no log line and no error: "stuck updating" forever.
                    println!(
                        "{our_len}\t{start}\tn/a\t{cand}\t{ours}\tOLD RAW GATE WOULD HAVE \
                         STALLED HERE at height {:?} (shortfall {}); the fixed gate continues",
                        chain.height(),
                        ours.saturating_sub(cand)
                    );
                }
                let path = if start == chain.blocks.len() { "append" } else { "reorg" };
                for b in &blocks[start..end] {
                    if let Err(e) = chain.connect_block(b.clone()) {
                        println!("{our_len}\t{start}\t{path}\tconnect FAILED at {}: {e}", chain.blocks.len());
                        return;
                    }
                }
                println!(
                    "{our_len}\t{start}\t{path}\t{cand}\t{ours}\tadopted → len {}",
                    chain.blocks.len()
                );
            }
        }

        // ---- Per-batch margin of the handle_headers work check across the
        // cross-algo activation height, plus the lane mix, so the flip is
        // attributable.
        "workmargin" => {
            println!("# len\tlane mix of last 2000\tcand_raw/ours ratio (x1000)");
            let mut chain = Chain::new(params.clone());
            let mut next = 2000usize;
            for (h, b) in blocks.iter().enumerate() {
                chain.connect_block(b.clone()).expect("connect");
                if h + 1 == next {
                    let len = chain.blocks.len();
                    let end = (len + BATCH).min(blocks.len());
                    if end <= len {
                        break;
                    }
                    let retained = chain.blocks.iter().fold(blockle_pow::U256::zero(), |a, b| {
                        a.saturating_add(blockle_pow::difficulty::block_work(b.header.bits))
                    });
                    let new_work = blocks[len..end].iter().fold(blockle_pow::U256::zero(), |a, b| {
                        a.saturating_add(blockle_pow::difficulty::block_work(b.header.bits))
                    });
                    let cand = retained.saturating_add(new_work);
                    let ours = chain.total_work();
                    let ratio = if ours.is_zero() {
                        0u128
                    } else {
                        (cand / (ours / blockle_pow::U256::from(1000u64)).max(blockle_pow::U256::one())).low_u128()
                    };
                    let mut mix: std::collections::BTreeMap<&str, usize> = Default::default();
                    for b in &chain.blocks[len.saturating_sub(2000)..len] {
                        *mix.entry(Chain::lane_of(b)).or_default() += 1;
                    }
                    let mixs: Vec<String> = mix.iter().map(|(k, v)| format!("{k}={v}")).collect();
                    println!("{len}\t{}\t{ratio}", mixs.join(","));
                    next += 2000;
                }
            }
        }

        // ---- Where does the energy-weighted fork-choice metric overtake the raw
        // block_work sum that handle_headers uses to score a candidate?
        "crossover" => {
            println!("# N\traw_sum\tweighted_total_work\traw-weighted\tlane mix of last 1000");
            let mut chain = Chain::new(params.clone());
            let mut raw = blockle_pow::U256::zero();
            let mut next = 1000usize;
            for (h, b) in blocks.iter().enumerate() {
                chain.connect_block(b.clone()).expect("connect");
                raw = raw.saturating_add(blockle_pow::difficulty::block_work(b.header.bits));
                if h + 1 == next {
                    let w = chain.total_work();
                    let sign = if raw >= w { "+" } else { "-" };
                    let diff = if raw >= w { raw - w } else { w - raw };
                    let mut mix: std::collections::BTreeMap<&str, usize> = Default::default();
                    let len = chain.blocks.len();
                    for b in &chain.blocks[len.saturating_sub(1000)..len] {
                        *mix.entry(Chain::lane_of(b)).or_default() += 1;
                    }
                    let mixs: Vec<String> = mix.iter().map(|(k, v)| format!("{k}={v}")).collect();
                    println!("{len}\t{raw}\t{w}\t{sign}{diff}\t{}", mixs.join(","));
                    next += if len < 50000 { 10000 } else { 1000 };
                }
            }
        }

        // ---- Per-P2P-message O(height) overhead at a given tip: what every
        // GetHeaders/Headers round trip costs regardless of which path runs.
        "msgcost" => {
            let mut chain = Chain::new(params.clone());
            for b in &blocks {
                chain.connect_block(b.clone()).expect("connect");
            }
            let n = chain.blocks.len();
            println!("# tip len {n}");
            let t = Instant::now();
            let mut acc = blockle_pow::U256::zero();
            for _ in 0..10 {
                acc = acc.saturating_add(chain.total_work());
            }
            println!("total_work()            {:.1} ms/call", t.elapsed().as_secs_f64() * 100.0);
            let t = Instant::now();
            for _ in 0..10 {
                let _: blockle_pow::U256 = chain.blocks.iter().fold(blockle_pow::U256::zero(), |a, b| {
                    a.saturating_add(blockle_pow::difficulty::block_work(b.header.bits))
                });
            }
            println!("handle_headers raw fold {:.1} ms/call", t.elapsed().as_secs_f64() * 100.0);
            let t = Instant::now();
            for _ in 0..3 {
                let _: Vec<_> = chain.blocks.iter().map(|b| b.header.hash()).collect();
            }
            println!("serve_headers full hash {:.1} ms/call", t.elapsed().as_secs_f64() * 1000.0 / 3.0);
            let t = Instant::now();
            let _ = chain.next_bits_coupled("sha256d");
            println!("next_bits_coupled       {:.1} ms/call (once per connect_block)", t.elapsed().as_secs_f64() * 1000.0);
            let t = Instant::now();
            let _c = chain.blocks.clone();
            println!("prefix clone (all)      {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
            println!("utxo set size           {}", chain.utxos.len());
        }

        // ---- Which lane creates the raw-vs-energy-weighted work gap above the
        // cross-algo activation height? No chain build needed: just the two
        // work formulas over the real headers.
        "attrib" => {
            let act = params.cross_algo_activation_height as usize;
            let hi = blocks.len().min(58000);
            println!("# blocks {act}..{hi}: per-lane raw vs energy-weighted work");
            println!("# lane\tcount\traw\tweighted\tweighted-raw");
            let mut agg: std::collections::BTreeMap<&str, (usize, blockle_pow::U256, blockle_pow::U256)> =
                Default::default();
            for b in &blocks[act..hi] {
                let lane = Chain::lane_of(b);
                let raw = blockle_pow::difficulty::block_work(b.header.bits);
                let w = blockle_pow::difficulty::energy_work(
                    b.header.bits,
                    blockle_pow::energy_coeff(lane),
                    blockle_pow::ENERGY_COEFF_SCALE,
                );
                let e = agg.entry(lane).or_insert((0, blockle_pow::U256::zero(), blockle_pow::U256::zero()));
                e.0 += 1;
                e.1 = e.1.saturating_add(raw);
                e.2 = e.2.saturating_add(w);
            }
            let mut traw = blockle_pow::U256::zero();
            let mut tw = blockle_pow::U256::zero();
            for (lane, (n, raw, w)) in &agg {
                let sign = if *w >= *raw { "+" } else { "-" };
                let d = if *w >= *raw { *w - *raw } else { *raw - *w };
                println!("{lane}\t{n}\t{raw}\t{w}\t{sign}{d}");
                traw = traw.saturating_add(*raw);
                tw = tw.saturating_add(*w);
            }
            let sign = if tw >= traw { "+" } else { "-" };
            let d = if tw >= traw { tw - traw } else { traw - tw };
            println!("TOTAL\t{}\t{traw}\t{tw}\t{sign}{d}", hi - act);
        }

        other => eprintln!("unknown mode {other}"),
    }
}
