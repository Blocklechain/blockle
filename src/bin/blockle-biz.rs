//! `blockle-biz` — the blockle.org mining-pool site: our BLOCK pools,
//! the chain explorer, wallet downloads, and the third-party directory.

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;

#[derive(Parser)]
#[command(
    name = "blockle-biz",
    about = "blockle.org — mining pools for the majors, every one merge-mining BLOCK"
)]
struct Cli {
    #[arg(long, default_value = "0.0.0.0:8900")]
    listen: String,
    /// Registry persistence file.
    #[arg(long, default_value = "blockle-biz-registry.json")]
    data: PathBuf,
    /// Monitoring cycle interval in seconds.
    #[arg(long, default_value_t = 30)]
    monitor_interval: u64,
    /// Project repository URL.
    #[arg(long, default_value = "https://github.com/blocklechain/blockle")]
    github: String,
    /// Public domain for site titles and copy.
    #[arg(long, default_value = "blockle.org")]
    domain: String,
    /// BLOCK chain snapshot file written by `blockle-chain start`
    /// (<datadir>/explorer.json) — powers the explorer and chain stats.
    #[arg(long)]
    chain_file: Option<PathBuf>,
    /// Live pool stats feed: "name=path" (repeatable), where path is a
    /// stratum stats file (<datadir>/stratum-solo.json). Served at
    /// /api/mps/{name} and rendered on the homepage.
    #[arg(long = "mps")]
    mps: Vec<String>,
    /// Node explorer API base URL (aux-work listener), e.g.
    /// http://127.0.0.1:8445 — enables block/tx/address pages.
    #[arg(long)]
    chain_api: Option<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let mps_files = cli
        .mps
        .iter()
        .filter_map(|spec| {
            spec.split_once('=')
                .map(|(name, path)| (name.trim().to_string(), PathBuf::from(path.trim())))
        })
        .collect();
    blockle::biz::serve(blockle::biz::BizConfig {
        listen: cli.listen,
        data_path: cli.data,
        github: cli.github,
        monitor_interval_secs: cli.monitor_interval,
        domain: cli.domain,
        chain_file: cli.chain_file,
        mps_files,
        chain_api: cli.chain_api,
    })?;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}
