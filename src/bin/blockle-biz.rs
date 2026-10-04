//! `blockle-biz` — the blockle.biz directory + monitoring server.

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;

#[derive(Parser)]
#[command(
    name = "blockle-biz",
    about = "blockle.biz — public directory and monitoring network for Blockle pools"
)]
struct Cli {
    #[arg(long, default_value = "0.0.0.0:8900")]
    listen: String,
    /// Registry persistence file.
    #[arg(long, default_value = "blockle-biz-registry.json")]
    data: PathBuf,
    /// Extra Proof-of-Blocks whitelist entries added to the built-in
    /// big-chain defaults. Format: "Name[:min_difficulty[:algorithm]]",
    /// comma separated. Emission comes from the per-ALGORITHM weight table
    /// (--algo-weight), never per chain.
    #[arg(long, default_value = "")]
    pob_whitelist: String,
    /// Override/extend per-algorithm emission weights:
    /// "algo=base_units_per_difficulty" pairs, comma separated
    /// (e.g. "randomx=7.5e-3,myalgo=1e18").
    #[arg(long, default_value = "")]
    algo_weight: String,
    /// Drop the built-in big-chain whitelist (use only --pob-whitelist).
    #[arg(long)]
    no_default_whitelist: bool,
    /// Monitoring / PoB verification cycle interval in seconds.
    #[arg(long, default_value_t = 30)]
    monitor_interval: u64,
    /// Project repository URL (placeholder until the official repo exists).
    #[arg(long, default_value = "https://github.com/YOUR-ORG/blockle")]
    github: String,
    /// Shared secret authorizing /api/pob/mark-settled (empty = disabled).
    #[arg(long, default_value = "")]
    settle_key: String,
    /// Public domain for site titles and copy.
    #[arg(long, default_value = "blockle.biz")]
    domain: String,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let mut whitelist = if cli.no_default_whitelist {
        vec![]
    } else {
        blockle::biz::default_whitelist()
    };
    for spec in cli.pob_whitelist.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let mut parts = spec.split(':');
        let name = parts.next().unwrap_or_default().to_string();
        let floor: f64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let algorithm = parts.next().unwrap_or("unknown").to_string();
        whitelist.push(blockle::biz::WhitelistEntry {
            name,
            aliases: vec![],
            algorithm,
            min_difficulty: floor,
            daily_cap_per_pool: 300,
            listing: "community".into(),
        });
    }
    let mut algo_weights = blockle::biz::default_algo_weights();
    for pair in cli.algo_weight.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((k, v)) = pair.split_once('=') {
            if let Ok(w) = v.trim().parse::<f64>() {
                algo_weights.insert(k.trim().to_lowercase(), w);
            }
        }
    }
    blockle::biz::serve(blockle::biz::BizConfig {
        listen: cli.listen,
        data_path: cli.data,
        whitelist,
        algo_weights,
        github: cli.github,
        monitor_interval_secs: cli.monitor_interval,
        settle_key: cli.settle_key,
        domain: cli.domain,
    })?;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
