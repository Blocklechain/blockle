//! `blockle` — the universal deployment system for PoW mining pools.
//!
//! Point it at a chain's RPC; it interrogates the node, figures out how to
//! mine it, and deploys a pool: stratum server, vardiff, share validation,
//! block submission, PPLNS payout ledger, web dashboard.

use blockle::{
    adapter, adapters, config, dashboard, discover, genadapter, http, ledger, miner, probe,
    simchain, stratum,
};

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use clap::{Parser, Subcommand};

use adapters::bitcoin::BitcoinAdapter;
use config::{ChainSection, PoolConfig, PoolSection};

#[derive(Parser)]
#[command(
    name = "blockle",
    about = "Blockle AutoPool — point it at a PoW chain, get a mining pool"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Interrogate a chain's RPC and generate a pool configuration.
    AddChain {
        #[arg(long)]
        name: String,
        #[arg(long)]
        rpc: String,
        /// Where to write the pool config.
        #[arg(long, default_value = "pool.toml")]
        out: PathBuf,
        /// Launch the pool immediately after generating.
        #[arg(long)]
        serve: bool,
        /// Hex scriptPubKey receiving coinbase rewards.
        #[arg(long)]
        payout_script: Option<String>,
        #[arg(long, default_value = "0.0.0.0:3333")]
        stratum: String,
        #[arg(long, default_value = "127.0.0.1:8080")]
        dashboard: String,
        /// Payout scheme: solo | pplns | prop | pps.
        #[arg(long, default_value = "pplns")]
        scheme: String,
        /// Pool fee in percent.
        #[arg(long, default_value_t = 1.0)]
        fee: f64,
        /// BLOCK address for Proof-of-Blocks rewards (auto-provisioned from
        /// a local blockle-chain wallet when omitted).
        #[arg(long)]
        blockle_address: Option<String>,
    },
    /// Provision a PRUNED parent-chain full node (config + systemd unit)
    /// so Bitcoin-family majors fit on one box for merged mining.
    ParentNode {
        /// bitcoin | litecoin | dogecoin (bitcoin-family daemons with
        /// prune support; zcashd cannot prune and is listed for reference).
        #[arg(long)]
        coin: String,
        /// Prune target in MB (bitcoind-style; ≥550). Mining needs only
        /// the tip, so near-minimum pruning fits many parents per box.
        #[arg(long, default_value_t = 1024)]
        prune_mb: u64,
        #[arg(long, default_value = "/var/lib")]
        data_root: PathBuf,
        /// Where to write <coin>.conf and <coin>.service.
        #[arg(long, default_value = ".")]
        out_dir: PathBuf,
    },
    /// Run a pool from a generated configuration.
    Serve {
        #[arg(default_value = "pool.toml")]
        config: PathBuf,
    },
    /// Probe a chain's RPC and print the capability report.
    Inspect {
        #[arg(long)]
        rpc: String,
        #[arg(long, default_value = "chain")]
        name: String,
        /// Also write a starter adapter (config manifest + Rust stub).
        #[arg(long)]
        generate_adapter: bool,
        /// Emit the profile as JSON instead of the human checklist.
        #[arg(long)]
        json: bool,
        #[arg(long, default_value = "adapters-out")]
        out_dir: PathBuf,
    },
    /// Scan a chain's source repository (git URL or local path) for mining
    /// parameters.
    Discover { source: String },
    /// One-shot onboarding from a chain's SOURCE: scan the repo, find the
    /// node's RPC, and generate the pool (or a prefilled scaffold with next
    /// steps if no node is running yet).
    Init {
        /// Git URL or local path of the chain's source code.
        source: String,
        #[arg(long, default_value = "pool.toml")]
        out: PathBuf,
        /// Extra RPC URLs to try besides the ones discovered in the source.
        #[arg(long)]
        rpc: Vec<String>,
    },
    /// Self-contained demo: launch the built-in simulated chain, interrogate
    /// it, deploy a pool against it, and mine real blocks through stratum.
    Demo {
        #[arg(long, default_value_t = 3)]
        blocks: u64,
    },
    /// Register this pool with blockle.biz so it appears in the public
    /// directory and starts heartbeating when served.
    Register {
        #[arg(long, default_value = "pool.toml")]
        config: PathBuf,
        /// blockle.biz base URL.
        #[arg(long, default_value = "http://127.0.0.1:8900")]
        biz: String,
        /// Publicly reachable stratum address to advertise (defaults to the
        /// configured listen address).
        #[arg(long)]
        public_stratum: Option<String>,
        #[arg(long)]
        website: Option<String>,
        #[arg(long)]
        location: Option<String>,
        /// Public chain RPC blockle.biz may use to independently verify your
        /// found blocks (required for Proof-of-Blocks credits).
        #[arg(long)]
        public_chain_rpc: Option<String>,
        /// BLOCK address advertised with your pool listing.
        #[arg(long)]
        payout_address: Option<String>,
        /// Verification RPC for a merged-mined aux chain: "NAME=http://…"
        /// (repeatable).
        #[arg(long)]
        aux_chain_rpc: Vec<String>,
    },
    /// Run a standalone simulated PoW chain (for local testing).
    Simchain {
        #[arg(long, default_value = "127.0.0.1:18980")]
        listen: String,
        #[arg(long, default_value = "SimCoin")]
        name: String,
    },
    /// Run the built-in CPU miner against a stratum endpoint.
    Mine {
        #[arg(long)]
        stratum: String,
        #[arg(long, default_value = "worker1")]
        worker: String,
        #[arg(long, default_value_t = 3)]
        shares: u64,
        #[arg(long, default_value_t = 120)]
        timeout_secs: u64,
    },
    /// Fetch payout balances from a running pool's dashboard.
    Payouts {
        #[arg(long, default_value = "http://127.0.0.1:8080")]
        dashboard: String,
    },
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::AddChain { name, rpc, out, serve, payout_script, stratum, dashboard, scheme, fee, blockle_address } => {
            add_chain(name, rpc, out, serve, payout_script, stratum, dashboard, scheme, fee, blockle_address)
        }
        Cmd::ParentNode { coin, prune_mb, data_root, out_dir } => parent_node(&coin, prune_mb, &data_root, &out_dir),
        Cmd::Serve { config } => serve_pool(&PoolConfig::load(&config)?, true),
        Cmd::Inspect { rpc, name, generate_adapter, json, out_dir } => {
            let profile = probe::probe(&rpc);
            if json {
                println!("{}", serde_json::to_string_pretty(&profile.to_json())?);
            } else {
                probe::print_checklist(&profile, &name);
            }
            if generate_adapter {
                let written = genadapter::generate(&profile, &name, &out_dir)?;
                println!("Generated starter adapter:");
                for w in written {
                    println!("  {w}");
                }
            }
            Ok(())
        }
        Cmd::Discover { source } => run_discover(&source),
        Cmd::Init { source, out, rpc } => run_init(&source, &out, rpc),
        Cmd::Register { config, biz, public_stratum, website, location, public_chain_rpc, payout_address, aux_chain_rpc } => {
            register(&config, &biz, public_stratum, website, location, public_chain_rpc, payout_address, aux_chain_rpc)
        }
        Cmd::Simchain { listen, name } => {
            simchain::serve(&listen, &name)?;
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        Cmd::Mine { stratum, worker, shares, timeout_secs } => {
            let report = miner::mine(&stratum, &worker, shares, Duration::from_secs(timeout_secs))?;
            println!(
                "mining done: {} accepted, {} rejected",
                report.shares_accepted, report.shares_rejected
            );
            Ok(())
        }
        Cmd::Demo { blocks } => demo(blocks),
        Cmd::Payouts { dashboard } => payouts(&dashboard),
    }
}

/// Write a pruned-node config + systemd unit for a bitcoin-family parent
/// daemon, sized to coexist with the other merged-mining parents on one
/// server.
fn parent_node(coin: &str, prune_mb: u64, data_root: &std::path::Path, out_dir: &std::path::Path) -> Result<()> {
    let (daemon, default_rpcport, extra) = match coin {
        "bitcoin" => ("bitcoind", 8332, ""),
        "litecoin" => ("litecoind", 9332, ""),
        "dogecoin" => ("dogecoind", 22555, ""),
        "dash" => ("dashd", 9998, "port=9999\n"),
        "bitcoincash" => ("bitcoind-bch", 18832, "port=18833\n"),
        "digibyte" => ("digibyted", 14022, "port=12024\n"),
        "zcash" => {
            bail!("zcashd does not support pruning — budget ~60 GB unpruned, or run the BLOCK equihash pools natively instead");
        }
        other => bail!("unknown parent coin {other} (bitcoin | litecoin | dogecoin | dash | bitcoincash | digibyte)"),
    };
    let prune_mb = prune_mb.max(550);
    let datadir = data_root.join(coin);
    let conf = format!(
        "# {coin} pruned merged-mining parent (generated by blockle)\n\
         server=1\nprune={prune_mb}\ndaemon=0\ntxindex=0\n\
         rpcbind=127.0.0.1\nrpcallowip=127.0.0.1\nrpcport={default_rpcport}\n\
         rpcuser=blockle\nrpcpassword=CHANGE_ME_{coin}\n\
         maxconnections=24\ndbcache=256\n{extra}"
    );
    let unit = format!(
        "[Unit]\nDescription={coin} pruned node (Blockle merged-mining parent)\nAfter=network-online.target\n\n\
         [Service]\nExecStart=/usr/local/bin/{daemon} -datadir={dd} -conf={dd}/{coin}.conf\n\
         Restart=on-failure\nRestartSec=10\nUser=root\n\n[Install]\nWantedBy=multi-user.target\n",
        dd = datadir.display(),
    );
    std::fs::create_dir_all(out_dir)?;
    let conf_path = out_dir.join(format!("{coin}.conf"));
    let unit_path = out_dir.join(format!("{coin}.service"));
    std::fs::write(&conf_path, conf)?;
    std::fs::write(&unit_path, unit)?;
    println!("✓ {} (prune={} MB → ~{} GB on disk)", conf_path.display(), prune_mb, prune_mb / 1024 + 1);
    println!("✓ {}", unit_path.display());
    println!();
    println!("Install on the server:");
    println!("  1. install the official {daemon} binary to /usr/local/bin");
    println!("  2. mkdir -p {} && cp {} {}/", datadir.display(), conf_path.display(), datadir.display());
    println!("  3. edit rpcpassword, then: cp {} /etc/systemd/system/ && systemctl enable --now {coin}", unit_path.display());
    println!("  4. once synced: blockle add-chain --name {coin} --rpc http://blockle:PASS@127.0.0.1:{default_rpcport}");
    println!("     (pruned nodes serve getblocktemplate fine — mining needs no history)");
    Ok(())
}

/// Create a hot (coinbase) and a payout wallet address through the chain's
/// own wallet RPC. Returns (hot_address, payout_address, hot scriptPubKey).
fn provision_chain_wallets(rpc_url: &str) -> Option<(String, String, String)> {
    let client = blockle::rpc::RpcClient::new(rpc_url);
    let newaddr = |label: &str| -> Option<String> {
        match client.call("getnewaddress", serde_json::json!([label])) {
            blockle::rpc::RpcOutcome::Ok(v) => v.as_str().map(|s| s.to_string()),
            _ => None,
        }
    };
    let hot = newaddr("blockle-hot")?;
    let payout = newaddr("blockle-payout").unwrap_or_else(|| hot.clone());
    for method in ["getaddressinfo", "validateaddress"] {
        if let blockle::rpc::RpcOutcome::Ok(info) = client.call(method, serde_json::json!([hot])) {
            if let Some(script) = info.get("scriptPubKey").and_then(|v| v.as_str()) {
                return Some((hot, payout, script.to_string()));
            }
        }
    }
    None
}

/// Create (or reuse) a local BLOCK wallet via the `blockle-chain` binary and
/// return its address — the pool's Proof-of-Blocks reward destination.
fn provision_blockle_address() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let datadir = format!("{home}/.blockle");
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(env_bin) = std::env::var("BLOCKLE_CHAIN_BIN") {
        candidates.push(env_bin.into());
    }
    if let Ok(exe) = std::env::current_exe() {
        // Same checkout: <workspace>/target/release/blockle → <workspace>/chain/target/release/blockle-chain
        if let Some(ws) = exe.ancestors().nth(3) {
            candidates.push(ws.join("chain/target/release/blockle-chain"));
        }
    }
    candidates.push("blockle-chain".into());
    for bin in candidates {
        let run = |args: &[&str]| {
            std::process::Command::new(&bin)
                .args(["--datadir", &datadir])
                .args(args)
                .output()
                .ok()
        };
        let Some(out) = run(&["keygen"]) else { continue };
        if !out.status.success() {
            continue;
        }
        if let Some(addr_out) = run(&["address"]) {
            let addr = String::from_utf8_lossy(&addr_out.stdout).trim().to_string();
            if addr.starts_with("block1") {
                return Some(addr);
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn add_chain(
    name: String,
    rpc: String,
    out: PathBuf,
    serve: bool,
    payout_script: Option<String>,
    stratum: String,
    dashboard: String,
    scheme: String,
    fee: f64,
    blockle_address: Option<String>,
) -> Result<()> {
    let profile = probe::probe(&rpc);
    probe::print_checklist(&profile, &name);

    if !profile.ready_for_builtin_adapter() {
        println!();
        println!("⚠ Manual adapter required — the built-in bitcoin-family adapter");
        println!("  cannot drive this chain as detected. Run:");
        println!("    blockle inspect --rpc {rpc} --name {name} --generate-adapter");
        bail!("chain not supported by the built-in adapter (yet)");
    }

    // Wallet auto-setup: a hot wallet for coinbase and a separate payout
    // wallet, created inside the chain node's own wallet (keys never leave
    // the node); plus a BLOCK address for Proof-of-Blocks rewards.
    println!();
    println!("Setting up wallets...");
    let mut hot_address = String::new();
    let mut chain_payout_address = String::new();
    let payout_script = match payout_script {
        Some(s) => {
            println!("✓ Coinbase script provided (--payout-script)");
            s
        }
        None => match provision_chain_wallets(&rpc) {
            Some((hot, payout, script)) => {
                println!("✓ Hot wallet (coinbase):   {hot}");
                println!("✓ Payout wallet:           {payout}");
                println!("  (keys live in the chain node's wallet — back it up)");
                hot_address = hot;
                chain_payout_address = payout;
                script
            }
            None => {
                println!("⚠ chain RPC has no wallet support and no --payout-script given;");
                println!("  using OP_TRUE (test chains only!)");
                "51".into()
            }
        },
    };
    let blockle_address = match blockle_address {
        Some(a) => {
            println!("✓ BLOCK rewards address:   {a}");
            a
        }
        None => match provision_blockle_address() {
            Some(a) => {
                println!("✓ BLOCK rewards address:   {a} (auto-created local BLOCK wallet)");
                a
            }
            None => {
                println!("⚠ no BLOCK wallet found (install blockle-chain or pass --blockle-address)");
                println!("  Proof-of-Blocks rewards will need an address at `blockle register` time");
                String::new()
            }
        },
    };

    let config = PoolConfig {
        chain: ChainSection {
            name: name.clone(),
            rpc,
            adapter: "bitcoin-family".into(),
            algorithm: profile.algorithm.to_string(),
            field_map: profile.field_map.clone().unwrap_or_default(),
            aux: vec![],
        },
        pool: PoolSection {
            stratum,
            dashboard,
            payout_script,
            hot_address,
            payout_address: chain_payout_address,
            blockle_address,
            scheme: scheme.clone(),
            fee_percent: fee,
            ..PoolSection::default()
        },
        biz: None,
    };
    config.save(&out)?;
    println!();
    println!("Generating pool...");
    println!("✓ Stratum server");
    println!("✓ Variable difficulty");
    println!("✓ Share validation");
    println!("✓ Block tracker");
    println!("✓ Payout ledger ({})", scheme.to_uppercase());
    println!("✓ Web dashboard");
    println!("Pool config written to {}", out.display());
    println!("Pool ready.");
    println!("stratum+tcp://{}", config.pool.stratum);
    if serve {
        serve_pool(&config, true)?;
    }
    Ok(())
}

fn build_adapter(cfg: &PoolConfig) -> Result<Box<dyn adapter::PoolAdapter>> {
    match cfg.chain.adapter.as_str() {
        "bitcoin-family" => {
            let script = hex::decode(&cfg.pool.payout_script)
                .map_err(|e| anyhow!("bad payout_script hex: {e}"))?;
            Ok(Box::new(BitcoinAdapter::new(
                &cfg.chain.rpc,
                &cfg.chain.name,
                &cfg.chain.algorithm,
                cfg.chain.field_map.clone(),
                script,
                cfg.chain.aux.clone(),
            )))
        }
        other => bail!(
            "adapter {other:?} is not built in — implement it (see `blockle inspect --generate-adapter`)"
        ),
    }
}

fn pool_scheme(cfg: &PoolConfig) -> Result<ledger::Scheme> {
    ledger::Scheme::parse(&cfg.pool.scheme, cfg.pool.pplns_window)
        .ok_or_else(|| anyhow!("unknown payout scheme {:?} (solo|pplns|prop|pps)", cfg.pool.scheme))
}

fn serve_pool(cfg: &PoolConfig, block_forever: bool) -> Result<()> {
    let engine = stratum::Engine::new(
        build_adapter(cfg)?,
        &cfg.pool.stratum,
        pool_scheme(cfg)?,
        cfg.pool.fee_percent,
    );
    engine.start()?;
    dashboard::serve(engine.clone(), &cfg.pool.dashboard)?;
    if let Some(biz) = cfg.biz.clone() {
        let engine = engine.clone();
        let chain = cfg.chain.name.clone();
        let beat_secs = cfg.pool.heartbeat_secs;
        std::thread::spawn(move || loop {
            let (hashrate, miners, workers, shares, blocks) = engine.heartbeat_snapshot();
            let payload = serde_json::json!({
                "pool_id": biz.pool_id,
                "token": biz.token,
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
                "pool_hashrate": hashrate,
                "miners": miners,
                "workers": workers,
                "blocks_found": blocks.len(),
                "block_height": engine.current_height().unwrap_or(0),
                "network_difficulty": engine.network_difficulty(),
                "network_hashrate": 0.0,
                "shares_submitted": shares,
                "version": env!("CARGO_PKG_VERSION"),
                "blocks": blocks.iter().map(|(c, h, hash)| serde_json::json!({
                    "chain": c, "height": h, "hash": hash,
                })).collect::<Vec<_>>(),
            });
            let url = format!("{}/api/heartbeat", biz.url);
            match http::post(&url, "application/json", payload.to_string().as_bytes(), Duration::from_secs(10)) {
                Ok(_) => {}
                Err(e) => println!("[pool] blockle.biz heartbeat failed: {e} (chain {chain})"),
            }
            std::thread::sleep(Duration::from_secs(beat_secs.max(5)));
        });
    }
    if block_forever {
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn register(
    config_path: &PathBuf,
    biz: &str,
    public_stratum: Option<String>,
    website: Option<String>,
    location: Option<String>,
    public_chain_rpc: Option<String>,
    payout_address: Option<String>,
    aux_chain_rpc: Vec<String>,
) -> Result<()> {
    let mut cfg = PoolConfig::load(config_path)?;
    let stratum = public_stratum.unwrap_or_else(|| cfg.pool.stratum.clone());
    if stratum.starts_with("0.0.0.0") {
        println!("⚠ advertising {stratum} — pass --public-stratum host:port so miners and monitoring can reach you");
    }
    if public_chain_rpc.is_none() {
        println!("⚠ no --public-chain-rpc: Proof-of-Blocks claims cannot be verified or credited");
    }
    let payload = serde_json::json!({
        "name": cfg.chain.name,
        "chain": cfg.chain.name,
        "algorithm": cfg.chain.algorithm,
        "stratum": stratum,
        "pool_fee": cfg.pool.fee_percent,
        "website": website.unwrap_or_default(),
        "location": location.unwrap_or_default(),
        "chain_rpc": public_chain_rpc.unwrap_or_default(),
        "payout_address": payout_address.unwrap_or_else(|| cfg.pool.blockle_address.clone()),
        "aux_chain_rpcs": aux_chain_rpc
            .iter()
            .filter_map(|s| s.split_once('='))
            .map(|(k, v)| (k.to_string(), serde_json::json!(v)))
            .collect::<serde_json::Map<_, _>>(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    let url = format!("{}/api/register", biz.trim_end_matches('/'));
    let raw = http::post(&url, "application/json", payload.to_string().as_bytes(), Duration::from_secs(10))?;
    let v: serde_json::Value = serde_json::from_slice(&raw)?;
    let (Some(pool_id), Some(token)) = (
        v.get("pool_id").and_then(|x| x.as_str()),
        v.get("token").and_then(|x| x.as_str()),
    ) else {
        bail!("registration failed: {v}");
    };
    cfg.biz = Some(config::BizSection {
        url: biz.trim_end_matches('/').to_string(),
        pool_id: pool_id.to_string(),
        token: token.to_string(),
    });
    cfg.save(config_path)?;
    println!("registered as {pool_id} on {biz}");
    println!("pairing token stored in {} — `blockle serve` now heartbeats automatically", config_path.display());
    println!("directory page: {}/pool/{pool_id}", biz.trim_end_matches('/'));
    Ok(())
}

/// `blockle init`: chain source in, pool out.
fn run_init(source: &str, out: &PathBuf, extra_rpc: Vec<String>) -> Result<()> {
    println!("── blockle init ──");
    let scratch = std::env::temp_dir();
    let root = discover::obtain_source(source, &scratch)?;
    let name_guess = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "newchain".into());
    println!("1. scanning source at {} …", root.display());
    let report = discover::discover(&root);
    match &report.algorithm {
        Some(a) => println!("   algorithm: {a}"),
        None => println!("   algorithm: not identified"),
    }
    println!("   confidence: {}%", report.confidence);

    println!("2. looking for a running node…");
    let mut candidates: Vec<String> = extra_rpc;
    for port in &report.rpc_ports {
        candidates.push(format!("http://127.0.0.1:{port}/"));
    }
    for port in [8332u16, 8545, 18443, 18980] {
        let url = format!("http://127.0.0.1:{port}/");
        if !candidates.contains(&url) {
            candidates.push(url);
        }
    }
    for url in &candidates {
        let profile = probe::probe(url);
        if profile.ready_for_builtin_adapter() {
            println!("   found a live, fully-classified node at {url}");
            println!();
            return add_chain(
                name_guess,
                url.clone(),
                out.clone(),
                false,
                None,
                "0.0.0.0:3333".into(),
                "127.0.0.1:8080".into(),
                "pplns".into(),
                1.0,
                None,
            );
        }
        if profile.template_method.is_some() {
            println!("   node at {url} responds but isn't fully classified:");
            probe::print_checklist(&profile, &name_guess);
            println!("   → blockle inspect --rpc {url} --generate-adapter");
            return Ok(());
        }
    }

    println!("   no running node found (tried {} endpoints)", candidates.len());
    println!("3. writing a prefilled scaffold to {} …", out.display());
    let rpc_hint = report
        .rpc_ports
        .first()
        .map(|p| format!("http://127.0.0.1:{p}/"))
        .unwrap_or_else(|| "http://127.0.0.1:PORT/".into());
    let config = PoolConfig {
        chain: ChainSection {
            name: name_guess.clone(),
            rpc: rpc_hint.clone(),
            adapter: "bitcoin-family".into(),
            algorithm: report.algorithm.clone().unwrap_or_else(|| "unknown".into()),
            field_map: Default::default(),
            aux: vec![],
        },
        pool: PoolSection::default(),
        biz: None,
    };
    config.save(out)?;
    println!();
    println!("Next steps:");
    println!("  1. start the {name_guess} node with RPC enabled ({rpc_hint})");
    println!("  2. blockle add-chain --name {name_guess} --rpc {rpc_hint} --out {}", out.display());
    println!("     (re-runs the interrogation against the live node and finalizes the config)");
    println!("  3. blockle serve {}", out.display());
    println!("  4. blockle register --config {} --biz https://blockle.biz", out.display());
    Ok(())
}

fn run_discover(source: &str) -> Result<()> {
    let scratch = std::env::temp_dir();
    let root = discover::obtain_source(source, &scratch)?;
    println!("Scanning {} …", root.display());
    let report = discover::discover(&root);
    println!();
    println!("Blockle discovered:");
    match &report.algorithm {
        Some(a) => println!("  Algorithm: {a}"),
        None => println!("  Algorithm: not identified"),
    }
    for f in &report.findings {
        println!("  {}  ({})", f.what, f.evidence);
    }
    println!("Confidence: {}%", report.confidence);
    if report.confidence >= 50 {
        println!();
        println!("Next: start the node and run `blockle add-chain --rpc http://…`");
    }
    Ok(())
}

fn demo(blocks: u64) -> Result<()> {
    println!("── Blockle AutoPool demo ──");
    println!("1. launching simulated PoW chains (sha256d, bitcoind-style RPC)");
    println!("   • SimCoin  — the parent chain being mined");
    println!("   • BLOCK    — the Blockle incentive chain, merged-mined for free");
    let sim = simchain::serve("127.0.0.1:18980", "SimCoin")?;
    let block_chain = simchain::serve("127.0.0.1:18981", "BLOCK")?;
    std::thread::sleep(Duration::from_millis(200));

    println!();
    println!("2. interrogating it like any unknown chain:");
    let rpc_url = "http://127.0.0.1:18980/";
    let profile = probe::probe(rpc_url);
    probe::print_checklist(&profile, "SimCoin");
    if !profile.ready_for_builtin_adapter() {
        bail!("demo probe failed");
    }

    println!();
    println!("3. deploying the pool:");
    let config = PoolConfig {
        chain: ChainSection {
            name: "SimCoin".into(),
            rpc: rpc_url.into(),
            adapter: "bitcoin-family".into(),
            algorithm: profile.algorithm.to_string(),
            field_map: profile.field_map.clone().unwrap_or_default(),
            aux: vec![adapters::bitcoin::AuxConfig {
                name: "BLOCK".into(),
                rpc: "http://127.0.0.1:18981/".into(),
                chain_id: 1,
                create_method: "createauxblock".into(),
                payout_address: String::new(),
                algorithm: String::new(),
                submit_method: "submitauxblock".into(),
            }],
        },
        pool: PoolSection {
            stratum: "127.0.0.1:13333".into(),
            dashboard: "127.0.0.1:18081".into(),
            payout_script: "51".into(),
            ..PoolSection::default()
        },
        biz: None,
    };
    let engine = stratum::Engine::new(
        build_adapter(&config)?,
        &config.pool.stratum,
        pool_scheme(&config)?,
        config.pool.fee_percent,
    );
    engine.start()?;
    dashboard::serve(engine.clone(), &config.pool.dashboard)?;
    std::thread::sleep(Duration::from_millis(500));

    println!();
    println!("4. attaching a CPU miner over real stratum and mining {blocks} block(s)…");
    let report = miner::mine("127.0.0.1:13333", "demo-worker", blocks, Duration::from_secs(120))?;

    std::thread::sleep(Duration::from_millis(500));
    let height = sim.height();
    let block_height = block_chain.height();
    let ledger = engine.ledger.lock().unwrap();
    println!();
    println!("── demo results ──");
    println!("SimCoin height:    {height}");
    println!("BLOCK height:      {block_height}  (earned by merged mining — zero extra hashpower)");
    println!("shares accepted:   {}", report.shares_accepted);
    println!("blocks found:      {}", ledger.blocks.len());
    for b in &ledger.blocks {
        println!("  [{}] height {} by {}  {}", b.chain, b.height, b.finder, b.hash);
    }
    println!("payout balances:   {:?}", ledger.balances());
    println!("dashboard:         http://{}/", config.pool.dashboard);
    if height == 0 || ledger.blocks.is_empty() {
        bail!("demo did not produce parent blocks");
    }
    if block_height == 0 {
        bail!("merged mining produced no BLOCK blocks");
    }
    println!("demo OK ✓");
    Ok(())
}

fn payouts(dashboard: &str) -> Result<()> {
    let url = format!("{}/payouts.json", dashboard.trim_end_matches('/'));
    let body = http::post(&url, "application/json", b"", Duration::from_secs(5))
        .or_else(|_| {
            // dashboards answer GET too, but our client only POSTs; fall back
            // to a direct GET-style read
            http::post(&url, "text/plain", b"", Duration::from_secs(5))
        })?;
    let v: serde_json::Value = serde_json::from_slice(&body)?;
    println!("{}", serde_json::to_string_pretty(&v)?);
    Ok(())
}
