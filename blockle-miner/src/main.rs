//! blockle-miner — an easy multi-algorithm CPU miner speaking Stratum v1.
//! Pick an algorithm, point it at any stratum pool (Blockle or otherwise), mine.
mod algo;
mod hash;
mod miner;
mod stratum;
mod target;

use anyhow::Result;
use clap::{Parser, Subcommand};

use algo::Algo;

#[derive(Parser)]
#[command(
    name = "blockle-miner",
    version,
    about = "Easy multi-algorithm CPU miner (Stratum v1). Pick an algorithm, point it at any pool, and mine on any hardware."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start mining against a stratum pool.
    Mine {
        /// Algorithm to mine (e.g. sha256d, scrypt, x11, blake2b, blake2s, blake3).
        #[arg(short, long)]
        algo: String,
        /// Stratum URL — stratum+tcp://host:port, or just host:port. Any pool works.
        #[arg(short = 'o', long, alias = "pool", alias = "stratum")]
        url: String,
        /// Pool username — usually your wallet address, optionally address.worker.
        #[arg(short, long)]
        user: String,
        /// Pool password (most pools accept "x").
        #[arg(short, long, default_value = "x")]
        pass: String,
        /// CPU worker threads (default: all cores).
        #[arg(short, long)]
        threads: Option<usize>,
    },
    /// List the supported algorithms.
    Algos,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Algos => {
            println!("Supported algorithms:");
            for (_, name, coins) in Algo::ALL {
                println!("  {:<9} {}", name, coins);
            }
            println!("\nStratum protocol: classic Bitcoin-family Stratum v1 — works with any");
            println!("pool that speaks it (Blockle lanes, plus Litecoin/Dogecoin/Dash/BTC pools).");
            Ok(())
        }
        Cmd::Mine { algo, url, user, pass, threads } => {
            let algo = Algo::parse(&algo)?;
            let addr = parse_addr(&url);
            let threads = threads.unwrap_or_else(num_cpus::get).max(1);
            eprintln!("[blockle-miner] starting · algo={} · pool={} · threads={}", algo.name(), addr, threads);
            miner::run(miner::Options { addr, user, pass, algo, threads })
        }
    }
}

/// Accept stratum+tcp://host:port, stratum://, tcp://, or a bare host:port.
fn parse_addr(url: &str) -> String {
    let u = url.trim();
    let u = u
        .strip_prefix("stratum+tcp://")
        .or_else(|| u.strip_prefix("stratum://"))
        .or_else(|| u.strip_prefix("tcp://"))
        .unwrap_or(u);
    u.trim_end_matches('/').to_string()
}
