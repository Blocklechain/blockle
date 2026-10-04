//! `blockle` — node CLI: wallet, miner, P2P networking, chain management.

use blockle_node::{httpc, p2p, storage};

use std::path::{Path, PathBuf};
use std::fs;
use std::thread;
use std::sync::OnceLock;
use std::collections::HashMap;

use anyhow::{anyhow, bail, Result};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_core::keys::{decode_address, encode_address, Address, Keypair};
use blockle_core::{display_hash, format_amount, parse_amount, Hash32, OutPoint, Transaction, TxInput, TxOutput};
use serde_json::json;

#[derive(Parser)]
#[command(
    name = "blockle",
    about = "Blockle: ASIC-friendly Equihash PoW chain with post-quantum signatures, native privacy and contracts (prototype)"
)]
struct Cli {
    /// Data directory for chain, wallet, and mempool files.
    #[arg(long, global = true, default_value = ".blockle")]
    datadir: PathBuf,
    /// Network: mainnet (Equihash 200,9) or regtest (48,5 — fast, for dev).
    #[arg(long, global = true, default_value = "mainnet")]
    network: String,
    /// Emit machine-readable JSON from transaction commands (GUIs/tooling).
    #[arg(long, global = true)]
    json: bool,
    /// Wallet passphrase for encrypted wallets (or set
    /// BLOCKLE_WALLET_PASSPHRASE; interactive runs prompt).
    #[arg(long, global = true)]
    passphrase: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

static JSON_MODE: OnceLock<bool> = OnceLock::new();
fn json_mode() -> bool { *JSON_MODE.get().unwrap_or(&false) }
static PASSPHRASE: OnceLock<Option<String>> = OnceLock::new();

/// The wallet passphrase: --passphrase, else the environment, else (on a
/// terminal) an interactive prompt the first time it is needed.
fn passphrase() -> Option<String> {
    PASSPHRASE
        .get_or_init(|| {
            std::env::var("BLOCKLE_WALLET_PASSPHRASE").ok().filter(|s| !s.is_empty()).or_else(
                || {
                    if json_mode() {
                        return None;
                    }
                    rpassword::prompt_password("wallet passphrase: ").ok().filter(|s| !s.is_empty())
                },
            )
        })
        .clone()
}
fn emit_json(v: serde_json::Value) { if json_mode() { println!("{v}"); } }

#[derive(Subcommand)]
enum Cmd {
    /// Create a wallet (if needed) and mine the genesis block, paying the
    /// 210,000 BLOCK premine to your address.
    Init,
    /// Generate a wallet keypair (no-op if one already exists).
    Keygen,
    /// Print this wallet's address.
    Address,
    /// Run a node: listen for peers, sync, gossip, and optionally mine.
    Start {
        /// Address to accept peer connections on.
        #[arg(long, default_value = "127.0.0.1:18444")]
        listen: String,
        /// Peers to connect to (repeatable).
        #[arg(long)]
        connect: Vec<String>,
        /// Mine continuously while running.
        #[arg(long)]
        mine: bool,
        /// Stop mining after this many blocks (requires --mine).
        #[arg(long)]
        mine_blocks: Option<u64>,
        /// Reward address for mined blocks (defaults to your wallet).
        #[arg(long)]
        address: Option<String>,
        /// Solo pool: stratum endpoint where each miner's coinbase pays
        /// their own authorized BLOCK address (e.g. 0.0.0.0:3333).
        #[arg(long)]
        stratum: Option<String>,
        /// PPLNS pool: stratum endpoint with share-weighted payouts
        /// (e.g. 0.0.0.0:3334).
        #[arg(long)]
        stratum_pplns: Option<String>,
        /// Pool fee percent, applied in both modes.
        #[arg(long, default_value_t = 1.0)]
        pool_fee: f64,
        /// PPLNS share window (shares).
        #[arg(long, default_value_t = 10_000)]
        pplns_window: usize,
        /// Public hostname miners use, for stats/labels (e.g. blockle.org).
        #[arg(long)]
        pool_host: Option<String>,
        /// Merged-mining work interface (createauxblock/submitauxblock),
        /// e.g. 127.0.0.1:8445.
        #[arg(long)]
        aux_http: Option<String>,
        /// Dedicated direct BLOCK pool for one parent algorithm:
        /// "algo=listen" (repeatable), e.g. sha256d=0.0.0.0:3340.
        #[arg(long = "stratum-direct")]
        stratum_direct: Vec<String>,
        /// Seconds to pause after each locally mined block (regtest pacing).
        #[arg(long)]
        mine_interval: Option<u64>,
    },
    /// Mine blocks offline to an address (defaults to your wallet).
    Mine {
        #[arg(long, default_value_t = 1)]
        blocks: u32,
        #[arg(long)]
        address: Option<String>,
    },
    /// Show the confirmed balance of an address (defaults to your wallet).
    Balance { address: Option<String> },
    /// Create a transaction; hand it to a running node (--node) or queue it
    /// in the local mempool file.
    Send {
        #[arg(long)]
        to: String,
        #[arg(long)]
        amount: String,
        #[arg(long, default_value = "0.0001")]
        fee: String,
        /// P2P address of a running node to submit through.
        #[arg(long)]
        node: Option<String>,
    },
    /// Print chain status.
    Info,
    /// Re-validate every block from disk.
    Validate,
    /// Deploy, call, and inspect Blockle VM contracts.
    Contract {
        #[command(subcommand)]
        cmd: ContractCmd,
    },
    /// Move transparent funds into the shielded pool (creates a note).
    Shield {
        #[arg(long)]
        amount: String,
        #[arg(long, default_value = "0.0001")]
        fee: String,
        #[arg(long)]
        node: Option<String>,
    },
    /// Spend a shielded note back to a transparent address.
    Unshield {
        /// Note index (see `blockle notes`).
        #[arg(long)]
        note: usize,
        /// Recipient (defaults to your wallet address).
        #[arg(long)]
        to: Option<String>,
        #[arg(long, default_value = "0.0001")]
        fee: String,
        #[arg(long)]
        node: Option<String>,
    },
    /// Hidden-amount shielded transfer: spend a note into a payment note +
    /// change note. Amounts never appear on chain. With --to, the payment
    /// note is delivered encrypted on chain (ML-KEM); otherwise a voucher is
    /// printed for out-of-band delivery.
    Zsend {
        #[arg(long)]
        note: usize,
        /// Amount to pay (defaults to the whole note minus fee).
        #[arg(long)]
        amount: Option<String>,
        /// Recipient shielded address (`zblockpk…`, from `blockle zaddress`).
        #[arg(long)]
        to: Option<String>,
        #[arg(long, default_value = "0.0001")]
        fee: String,
        #[arg(long)]
        node: Option<String>,
    },
    /// Import a note voucher received from a sender.
    NoteImport { voucher: String },
    /// List shielded notes and their status.
    Notes,
    /// Total unspent shielded balance.
    Zbalance,
    /// Print this wallet's shielded address (ML-KEM public key).
    Zaddress,
    /// Scan the chain for encrypted notes addressed to this wallet
    /// (or to a provided incoming viewing key).
    Scan {
        /// Incoming viewing key (hex); read-only audit mode.
        #[arg(long)]
        viewkey: Option<String>,
    },
    /// Export the incoming viewing key (allows *detecting and decrypting*
    /// incoming notes, but not spending them... except bearer-note caveats).
    Viewkey,
    /// Wallet management: encryption, backup, import/export, signing —
    /// everything you'd expect from a Bitcoin Core wallet.
    Wallet {
        #[command(subcommand)]
        cmd: WalletCmd,
    },
    /// Dump wallet + chain state as one JSON document (for GUIs/tooling).
    UiSnapshot,
    /// Produce a payment disclosure for a note (proof you were paid).
    NoteDisclose { note: usize },
    /// Verify a payment disclosure against the chain.
    VerifyDisclosure { disclosure: String },
}

#[derive(Subcommand)]
enum WalletCmd {
    /// Encrypt the wallet with a passphrase (Bitcoin Core `encryptwallet`).
    Encrypt,
    /// Remove wallet encryption (requires the current passphrase).
    Decrypt,
    /// Re-encrypt under a new passphrase (current via --passphrase/env).
    ChangePassphrase {
        #[arg(long)]
        new_passphrase: String,
    },
    /// Copy wallet.json to a backup location (`backupwallet`).
    Backup { out: PathBuf },
    /// Print a portable secret-key export (`dumpwallet`). Treat as cash.
    Export,
    /// Import an export blob, a wallet.json, or a path to either
    /// (`importwallet`). Refuses to overwrite without --force.
    Import {
        source: String,
        #[arg(long)]
        force: bool,
    },
    /// Sign a message with the wallet key (`signmessage`).
    SignMessage { message: String },
    /// Verify a signed message against an address (`verifymessage`).
    VerifyMessage {
        address: String,
        signature: String,
        message: String,
    },
}

#[derive(Subcommand)]
enum ContractCmd {
    /// Assemble a .asm file / compile a .bs file and print (or write) the
    /// bytecode.
    Assemble {
        file: PathBuf,
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Compile a Blockle Script (.bs) file and print the generated assembly.
    Build { file: PathBuf },
    /// Deploy a contract (.asm is assembled; anything else is raw bytecode).
    Deploy {
        file: PathBuf,
        #[arg(long, default_value_t = 200_000)]
        gas: u64,
        /// P2P address of a running node to submit through.
        #[arg(long)]
        node: Option<String>,
    },
    /// Call a deployed contract.
    Call {
        /// Contract id (hex).
        id: String,
        /// Calldata as hex.
        #[arg(long, default_value = "")]
        input: String,
        /// BLOCK value to attach.
        #[arg(long, default_value = "0")]
        value: String,
        #[arg(long, default_value_t = 200_000)]
        gas: u64,
        #[arg(long)]
        node: Option<String>,
    },
    /// Dry-run a call against current state (no transaction, no mutation).
    Simulate {
        id: String,
        #[arg(long, default_value = "")]
        input: String,
        #[arg(long, default_value = "0")]
        value: String,
        #[arg(long, default_value_t = 200_000)]
        gas: u64,
    },
    /// Show a contract's storage value for a key (hex, zero-padded to 32).
    Storage {
        id: String,
        #[arg(long, default_value = "")]
        key: String,
    },
    /// List deployed contracts.
    List,
}

use blockle_node::walletfile::WalletFile;

fn main() -> Result<()> {
    let cli = Cli::parse();
    let params = ChainParams::by_name(&cli.network)
        .ok_or_else(|| anyhow!("unknown network {:?} (mainnet or regtest)", cli.network))?;
    let datadir = cli.datadir;
    let _ = JSON_MODE.set(cli.json || matches!(cli.cmd, Cmd::UiSnapshot));
    if let Some(p) = cli.passphrase {
        let _ = PASSPHRASE.set(Some(p));
    }
    match cli.cmd {
        Cmd::Init => init(&datadir, params),
        Cmd::Keygen => {
            let kp = load_or_create_wallet(&datadir)?;
            println!("address: {}", encode_address(&kp.address()));
            Ok(())
        }
        Cmd::Address => {
            let kp = load_wallet(&datadir)?;
            println!("{}", encode_address(&kp.address()));
            Ok(())
        }
        Cmd::Start { listen, connect, mine, mine_blocks, address, stratum, stratum_pplns, pool_fee, pplns_window, pool_host, aux_http, stratum_direct, mine_interval } => start(
            &datadir, params, listen, connect, mine, mine_blocks, address, stratum,
            stratum_pplns, pool_fee, pplns_window, pool_host, aux_http, stratum_direct,
            mine_interval,
        ),
        Cmd::Mine { blocks, address } => mine_cmd(&datadir, params, blocks, address),
        Cmd::Balance { address } => balance(&datadir, params, address),
        Cmd::Send { to, amount, fee, node } => send(&datadir, params, &to, &amount, &fee, node),
        Cmd::Info => info(&datadir, params),
        Cmd::Validate => validate(&datadir, params),
        Cmd::Contract { cmd } => contract_cmd(&datadir, params, cmd),
        Cmd::Shield { amount, fee, node } => shield(&datadir, params, &amount, &fee, node),
        Cmd::Unshield { note, to, fee, node } => unshield(&datadir, params, note, to, &fee, node),
        Cmd::Zsend { note, amount, to, fee, node } => {
            zsend(&datadir, params, note, amount, to, &fee, node)
        }
        Cmd::NoteImport { voucher } => note_import(&datadir, params, &voucher),
        Cmd::Notes => notes_cmd(&datadir, params),
        Cmd::Zbalance => zbalance(&datadir, params),
        Cmd::Zaddress => zaddress(&datadir),
        Cmd::Scan { viewkey } => scan(&datadir, params, viewkey),
        Cmd::Viewkey => viewkey(&datadir),
        Cmd::Wallet { cmd } => wallet_cmd(&datadir, cmd),
        Cmd::UiSnapshot => ui_snapshot(&datadir, params),
        Cmd::NoteDisclose { note } => note_disclose(&datadir, note),
        Cmd::VerifyDisclosure { disclosure } => verify_disclosure(&datadir, params, &disclosure),
    }
}

// ---------- wallet ----------

/// Atomic wallet write (tmp + rename): concurrent readers never see a
/// torn file.
fn write_wallet_file(datadir: &Path, wf: &WalletFile) -> Result<()> {
    let path = storage::wallet_path(datadir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(wf)?)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

fn read_wallet_file(datadir: &Path) -> Result<WalletFile> {
    let path = storage::wallet_path(datadir);
    if !path.exists() {
        bail!("no wallet in {} — run `blockle keygen` first", datadir.display());
    }
    Ok(serde_json::from_str(&fs::read_to_string(&path)?)?)
}

fn load_wallet(datadir: &Path) -> Result<Keypair> {
    let wf = read_wallet_file(datadir)?;
    let (secret, _) = wf.secrets(passphrase().as_deref())?;
    Keypair::from_bytes(&secret, &hex::decode(&wf.public_hex)?)
        .map_err(|_| anyhow!("corrupt wallet key material"))
}

fn load_or_create_wallet(datadir: &Path) -> Result<Keypair> {
    if storage::wallet_path(datadir).exists() {
        return load_wallet(datadir);
    }
    fs::create_dir_all(datadir)?;
    let kp = Keypair::generate();
    let wf = WalletFile {
        secret_hex: hex::encode(kp.secret_bytes()),
        public_hex: hex::encode(kp.public_bytes()),
        address: encode_address(&kp.address()),
        // KEM keys are generated lazily on first shielded use.
        ..WalletFile::default()
    };
    write_wallet_file(datadir, &wf)?;
    println!("new wallet written to {}", storage::wallet_path(datadir).display());
    Ok(kp)
}

fn resolve_address(datadir: &Path, address: Option<String>) -> Result<Address> {
    match address {
        Some(s) => decode_address(&s).map_err(|e| anyhow!("{e}")),
        None => Ok(load_wallet(datadir)?.address()),
    }
}

// ---------- commands ----------

fn init(datadir: &Path, params: ChainParams) -> Result<()> {
    if storage::blocks_path(datadir).exists() {
        bail!("chain already initialized in {}", datadir.display());
    }
    // Networks with a fixed genesis don't mine one — they install it.
    if let Some(genesis) = blockle_chain::genesis::embedded_genesis(&params.name) {
        let mut chain = Chain::new(params);
        chain
            .connect_block(genesis.clone())
            .map_err(|e| anyhow!("embedded genesis failed validation: {e}"))?;
        storage::append_block(datadir, &genesis)?;
        load_or_create_wallet(datadir)?;
        println!(
            "installed fixed {} genesis: {}",
            chain.params.name,
            display_hash(&genesis.header.hash())
        );
        println!(
            "note: the {} {} premine belongs to the project's genesis wallet, not this wallet",
            format_amount(chain.params.premine),
            chain.params.ticker
        );
        return Ok(());
    }
    let kp = load_or_create_wallet(datadir)?;
    println!(
        "mining genesis block ({} {} premine → {}) …",
        format_amount(params.premine),
        params.ticker,
        encode_address(&kp.address())
    );
    if params.equihash.n == 200 {
        println!("(mainnet Equihash (200,9) is ASIC-class — a CPU genesis can take a while)");
    }
    let mut chain = Chain::new(params);
    let (genesis, _) = mine_block(&chain, kp.address(), &[])?;
    let hash = genesis.header.hash();
    chain.connect_block(genesis.clone())?;
    storage::append_block(datadir, &genesis)?;
    println!("genesis mined: {}", display_hash(&hash));
    println!(
        "balance: {} {}",
        format_amount(chain.balance(&kp.address())),
        chain.params.ticker
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn start(
    datadir: &Path,
    params: ChainParams,
    listen: String,
    connect: Vec<String>,
    mine: bool,
    mine_blocks: Option<u64>,
    address: Option<String>,
    stratum: Option<String>,
    stratum_pplns: Option<String>,
    pool_fee: f64,
    pplns_window: usize,
    pool_host: Option<String>,
    aux_http: Option<String>,
    stratum_direct: Vec<String>,
    mine_interval: Option<u64>,
) -> Result<()> {
    use blockle_node::stratum::{PoolMode, PoolOpts};
    let has_pool = stratum.is_some() || stratum_pplns.is_some() || !stratum_direct.is_empty();
    // The local miner, the pools, and the payout executor all need a
    // wallet: it is the reward / fee / payout-funding address.
    let kp = if mine || has_pool { Some(load_or_create_wallet(datadir)?) } else { None };
    let mine_to = if mine || has_pool {
        Some(match address {
            Some(s) => decode_address(&s).map_err(|e| anyhow!("{e}"))?,
            None => kp.as_ref().expect("created above").address(),
        })
    } else {
        None
    };
    let fee_bp = (pool_fee.clamp(0.0, 100.0) * 100.0) as u32;
    let endpoint_for = |listen_addr: &str| -> String {
        match (&pool_host, listen_addr.rsplit(':').next()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            _ => listen_addr.to_string(),
        }
    };
    let mut pools = Vec::new();
    if let Some(addr) = stratum {
        pools.push((
            addr.clone(),
            PoolOpts {
                mode: PoolMode::Solo,
                fee_bp,
                window: pplns_window,
                pool_address: mine_to.expect("pool implies wallet"),
                stats_path: Some(datadir.join("stratum-solo.json")),
                ledger_path: None,
                endpoint: format!("stratum+tcp://{}", endpoint_for(&addr)),
            },
        ));
    }
    let ledger_path = datadir.join("pplns-ledger.jsonl");
    if let Some(addr) = stratum_pplns {
        pools.push((
            addr.clone(),
            PoolOpts {
                mode: PoolMode::Pplns,
                fee_bp,
                window: pplns_window,
                pool_address: mine_to.expect("pool implies wallet"),
                stats_path: Some(datadir.join("stratum-pplns.json")),
                ledger_path: Some(ledger_path.clone()),
                endpoint: format!("stratum+tcp://{}", endpoint_for(&addr)),
            },
        ));
    }
    let run_payouts = pools.iter().any(|(_, o)| o.mode == PoolMode::Pplns);

    let chain = storage::load_chain_or_empty(datadir, params.clone())?;
    let mempool = storage::load_mempool(datadir)?;
    match chain.height() {
        Some(h) => println!(
            "[chain] loaded height {h}, tip {}",
            display_hash(&chain.tip_hash())
        ),
        None => println!("[chain] empty chain — waiting to sync from peers"),
    }
    let self_addr = listen.replace("0.0.0.0", "127.0.0.1").replace("[::]", "127.0.0.1");
    let node = p2p::Node::new(
        p2p::NodeConfig {
            datadir: datadir.to_path_buf(),
            params,
            listen,
            connect,
            mine_to,
            local_mine: mine,
            mine_blocks,
            mine_interval,
            pools,
        },
        chain,
        mempool,
    );
    blockle_node::pool::spawn_explorer_writer(node.clone(), datadir.join("explorer.json"));
    for spec in &stratum_direct {
        let Some((algo, listen_addr)) = spec.split_once('=') else {
            bail!("--stratum-direct expects algo=listen, got {spec:?}");
        };
        let algo: &'static str = blockle_pow::parent::FIXED_HEADER_ALGOS
            .iter()
            .find(|a| **a == algo)
            .copied()
            .ok_or_else(|| anyhow!("unknown direct-pool algorithm {algo:?}"))?;
        blockle_node::stratum_btc::serve(
            node.clone(),
            listen_addr.to_string(),
            algo,
            PoolOpts {
                mode: PoolMode::Solo,
                fee_bp,
                window: pplns_window,
                pool_address: mine_to.expect("pool implies wallet"),
                stats_path: Some(datadir.join(format!("stratum-{algo}.json"))),
                ledger_path: None,
                endpoint: format!("stratum+tcp://{}", endpoint_for(listen_addr)),
            },
        );
    }
    if let Some(aux_addr) = aux_http {
        blockle_node::pool::spawn_aux_http(node.clone(), aux_addr);
    }
    if run_payouts {
        let kp = kp.expect("pool implies wallet");
        let node2 = node.clone();
        thread::spawn(move || payout_executor(node2, kp, ledger_path, self_addr));
    }
    node.run()
}

/// PPLNS payout executor: once a found block matures (and is still in the
/// main chain), pay its share-weighted entries from the pool wallet in one
/// transaction, then mark the ledger record settled with the txid.
fn payout_executor(
    node: std::sync::Arc<p2p::Node>,
    kp: Keypair,
    ledger: PathBuf,
    self_addr: String,
) {
    use blockle_node::stratum::PayoutRecord;
    loop {
        thread::sleep(std::time::Duration::from_secs(60));
        let Ok(raw) = fs::read_to_string(&ledger) else { continue };
        let mut records: Vec<PayoutRecord> = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let (chain, mempool) = node.snapshot();
        let Some(tip) = chain.height() else { continue };
        let maturity = chain.params.coinbase_maturity;
        let mut changed = false;
        for rec in records.iter_mut().filter(|r| !r.paid) {
            if tip < rec.height + maturity {
                continue;
            }
            let still_in_chain = chain
                .blocks
                .get(rec.height as usize)
                .map(|b| display_hash(&b.header.hash()) == rec.block_hash)
                .unwrap_or(false);
            if !still_in_chain {
                // Orphaned find: drop the record as unpayable.
                rec.paid = true;
                rec.txid = Some("orphaned".into());
                changed = true;
                continue;
            }
            let outputs: Vec<TxOutput> = rec
                .entries
                .iter()
                .filter_map(|(addr, amount)| {
                    decode_address(addr).ok().map(|recipient| TxOutput {
                        recipient,
                        amount: *amount,
                    })
                })
                .collect();
            if outputs.is_empty() {
                rec.paid = true;
                rec.txid = Some("no-entries".into());
                changed = true;
                continue;
            }
            match build_funded_tx(&kp, &chain, &mempool, outputs, 10_000, None, None) {
                Ok(tx) => {
                    let txid = display_hash(&tx.txid());
                    match p2p::push_tx_to_node(&self_addr, &chain.params, &tx) {
                        Ok(()) => {
                            println!(
                                "[payout] block {} settled: {} entr{} → txid {txid}",
                                rec.height,
                                rec.entries.len(),
                                if rec.entries.len() == 1 { "y" } else { "ies" },
                            );
                            rec.paid = true;
                            rec.txid = Some(txid);
                            changed = true;
                        }
                        Err(e) => println!("[payout] submit failed (will retry): {e}"),
                    }
                }
                Err(e) => println!("[payout] cannot fund payout yet (will retry): {e}"),
            }
        }
        if changed {
            let out: String = records
                .iter()
                .filter_map(|r| serde_json::to_string(r).ok())
                .map(|l| l + "\n")
                .collect();
            let _ = fs::write(&ledger, out);
        }
    }
}

fn mine_cmd(datadir: &Path, params: ChainParams, blocks: u32, address: Option<String>) -> Result<()> {
    let reward_to = resolve_address(datadir, address)?;
    let mut chain = storage::load_chain(datadir, params)?;
    let mut mempool = storage::load_mempool(datadir)?;
    for _ in 0..blocks {
        let height = chain.blocks.len() as u64;
        let (block, included) = mine_block(&chain, reward_to, &mempool)?;
        let hash = block.header.hash();
        let ntx = block.transactions.len();
        chain
            .connect_block(block.clone())
            .map_err(|e| anyhow!("freshly mined block failed validation: {e}"))?;
        storage::append_block(datadir, &block)?;
        mempool.retain(|tx| !included.contains(&tx.txid()));
        println!(
            "mined block {height} ({ntx} tx{}): {}",
            if ntx == 1 { "" } else { "s" },
            display_hash(&hash)
        );
    }
    storage::save_mempool(datadir, &mempool)?;
    println!(
        "height {} · reward address balance: {} {}",
        chain.height().unwrap(),
        format_amount(chain.balance(&reward_to)),
        chain.params.ticker
    );
    Ok(())
}

fn balance(datadir: &Path, params: ChainParams, address: Option<String>) -> Result<()> {
    let addr = resolve_address(datadir, address)?;
    let chain = storage::load_chain(datadir, params)?;
    println!("{} {}", format_amount(chain.balance(&addr)), chain.params.ticker);
    Ok(())
}

fn send(
    datadir: &Path,
    params: ChainParams,
    to: &str,
    amount: &str,
    fee: &str,
    node: Option<String>,
) -> Result<()> {
    let kp = load_wallet(datadir)?;
    let chain = storage::load_chain(datadir, params)?;
    let mut mempool = storage::load_mempool(datadir)?;
    let recipient = decode_address(to).map_err(|e| anyhow!("{e}"))?;
    let amount = parse_amount(amount).map_err(|e| anyhow!("{e}"))?;
    let fee = parse_amount(fee).map_err(|e| anyhow!("{e}"))?;
    let tx = build_funded_tx(&kp, &chain, &mempool, vec![TxOutput { recipient, amount }], fee, None, None)?;
    if !json_mode() {
        println!(
            "sending {} {} (+{} fee) → {to}",
            format_amount(amount),
            chain.params.ticker,
            format_amount(fee)
        );
    }
    let txid = submit_tx(datadir, &chain, &mut mempool, tx, node)?;
    emit_json(json!({"ok": true, "txid": display_hash(&txid)}));
    Ok(())
}

fn info(datadir: &Path, params: ChainParams) -> Result<()> {
    let chain = storage::load_chain(datadir, params)?;
    let mempool = storage::load_mempool(datadir)?;
    let tip = chain.blocks.last().expect("validated chain has genesis");
    let p = &chain.params;
    println!("chain:       {}", p.name);
    println!("ticker:      {}", p.ticker);
    println!("height:      {}", chain.height().unwrap());
    println!("tip:         {}", display_hash(&tip.header.hash()));
    println!("tip time:    {}", tip.header.time);
    println!("bits:        {:#010x}", tip.header.bits);
    println!("next bits:   {:#010x}", chain.next_bits());
    println!("total work:  {}", hex::encode(p2p::work_bytes(chain.total_work())));
    println!("equihash:    ({}, {})", p.equihash.n, p.equihash.k);
    println!("spacing:     {}s", p.target_spacing);
    println!(
        "subsidy:     {} {} (halves every {} blocks)",
        format_amount(p.block_subsidy(chain.blocks.len() as u64)),
        p.ticker,
        p.halving_interval
    );
    println!("premine:     {} {}", format_amount(p.premine), p.ticker);
    println!("signatures:  ML-DSA-44 (post-quantum)");
    println!("utxos:       {}", chain.utxos.len());
    println!("mempool:     {} tx", mempool.len());
    Ok(())
}

fn validate(datadir: &Path, params: ChainParams) -> Result<()> {
    let chain = storage::load_chain(datadir, params)?;
    println!(
        "chain valid: {} blocks, tip {}",
        chain.blocks.len(),
        display_hash(&chain.tip_hash())
    );
    Ok(())
}

// ---------- shared tx building & contract commands ----------

/// Fund, sign, and sanity-check a transaction paying `outputs` plus `fee`
/// (and any contract value) from the wallet's spendable utxos.
fn build_funded_tx(
    kp: &Keypair,
    chain: &Chain,
    mempool: &[Transaction],
    outputs: Vec<TxOutput>,
    fee: u64,
    contract: Option<blockle_core::ContractAction>,
    shielded: Option<blockle_core::ShieldedBundle>,
) -> Result<Transaction> {
    let pay: u64 = outputs.iter().map(|o| o.amount).sum();
    let value = contract.as_ref().map(|a| a.value()).unwrap_or(0);
    let z_out: u64 = shielded
        .as_ref()
        .map(|b| b.outputs.iter().map(|o| o.value).sum())
        .unwrap_or(0);
    let needed = pay
        .checked_add(fee)
        .and_then(|v| v.checked_add(value))
        .and_then(|v| v.checked_add(z_out))
        .ok_or_else(|| anyhow!("amount overflow"))?;

    // Exclude utxos already referenced by pending mempool txs.
    let pending: Vec<OutPoint> = mempool
        .iter()
        .flat_map(|tx| tx.inputs.iter().map(|i| i.prev))
        .collect();

    let mut selected = Vec::new();
    let mut total: u64 = 0;
    for (outpoint, entry) in chain.spendable_utxos(&kp.address()) {
        if pending.contains(&outpoint) {
            continue;
        }
        total += entry.output.amount;
        selected.push(outpoint);
        if total >= needed {
            break;
        }
    }
    if total < needed {
        bail!(
            "insufficient spendable funds: have {}, need {}",
            format_amount(total),
            format_amount(needed)
        );
    }

    let mut outputs = outputs;
    let change = total - needed;
    if change > 0 {
        outputs.push(TxOutput { recipient: kp.address(), amount: change });
    }
    if outputs.is_empty() {
        bail!("transaction needs at least one output; add funds for change");
    }
    let mut tx = Transaction {
        version: 1,
        inputs: selected
            .iter()
            .map(|op| TxInput { prev: *op, pubkey: kp.public_bytes(), signature: vec![] })
            .collect(),
        outputs,
        coinbase_data: vec![],
        shielded,
        contract,
    };
    let sighash = tx.sighash();
    let signature = kp.sign(&sighash);
    for input in &mut tx.inputs {
        input.signature = signature.clone();
    }

    let next_height = chain.blocks.len() as u64;
    chain
        .check_transaction(&tx, &chain.utxos, next_height)
        .map_err(|e| anyhow!("transaction rejected: {e}"))?;
    Ok(tx)
}

/// Hand a signed transaction to a running node, or queue it locally.
fn submit_tx(
    datadir: &Path,
    chain: &Chain,
    mempool: &mut Vec<Transaction>,
    tx: Transaction,
    node: Option<String>,
) -> Result<Hash32> {
    let txid = tx.txid();
    match node {
        Some(addr) => {
            p2p::push_tx_to_node(&addr, &chain.params, &tx)?;
            if !json_mode() { println!("submitted via node {addr}"); }
        }
        None => {
            mempool.push(tx);
            storage::save_mempool(datadir, mempool)?;
            if !json_mode() { println!("queued in local mempool"); }
        }
    }
    if !json_mode() {
        println!("txid {} — it will confirm in the next mined block", display_hash(&txid));
    }
    Ok(txid)
}

fn parse_hash32(s: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(s).map_err(|e| anyhow!("bad hex: {e}"))?;
    bytes.try_into().map_err(|_| anyhow!("expected 32 bytes of hex"))
}

fn load_code(file: &Path) -> Result<Vec<u8>> {
    match file.extension().and_then(|e| e.to_str()) {
        Some("asm") => {
            let source = fs::read_to_string(file)?;
            blockle_vm::asm::assemble(&source).map_err(|e| anyhow!("assembly failed: {e}"))
        }
        Some("bs") => {
            let source = fs::read_to_string(file)?;
            blockle_vm::script::compile(&source).map_err(|e| anyhow!("compile failed: {e}"))
        }
        _ => Ok(fs::read(file)?),
    }
}

fn contract_cmd(datadir: &Path, params: ChainParams, cmd: ContractCmd) -> Result<()> {
    match cmd {
        ContractCmd::Assemble { file, out } => {
            let code = load_code(&file)?;
            match out {
                Some(path) => {
                    fs::write(&path, &code)?;
                    println!("{} bytes → {}", code.len(), path.display());
                }
                None => println!("{}", hex::encode(&code)),
            }
            Ok(())
        }
        ContractCmd::Build { file } => {
            let source = fs::read_to_string(&file)?;
            let asm = blockle_vm::script::compile_to_asm(&source)
                .map_err(|e| anyhow!("compile failed: {e}"))?;
            println!("{asm}");
            Ok(())
        }
        ContractCmd::Deploy { file, gas, node } => {
            let code = load_code(&file)?;
            let kp = load_wallet(datadir)?;
            let chain = storage::load_chain(datadir, params)?;
            let mut mempool = storage::load_mempool(datadir)?;
            let fee = gas
                .checked_mul(chain.params.gas_price)
                .ok_or_else(|| anyhow!("gas overflow"))?;
            let action = blockle_core::ContractAction::Deploy { code, gas_limit: gas };
            let tx = build_funded_tx(&kp, &chain, &mempool, vec![], fee, Some(action), None)?;
            let id = blockle_chain::contract_id(&tx.txid());
            println!(
                "deploying ({} gas, {} {} fee)",
                gas,
                format_amount(fee),
                chain.params.ticker
            );
            println!("contract id: {}", hex::encode(id));
            submit_tx(datadir, &chain, &mut mempool, tx, node).map(|_| ())
        }
        ContractCmd::Call { id, input, value, gas, node } => {
            let id = parse_hash32(&id)?;
            let input = hex::decode(input).map_err(|e| anyhow!("bad input hex: {e}"))?;
            let value = parse_amount(&value).map_err(|e| anyhow!("{e}"))?;
            let kp = load_wallet(datadir)?;
            let chain = storage::load_chain(datadir, params)?;
            let mut mempool = storage::load_mempool(datadir)?;
            let fee = gas
                .checked_mul(chain.params.gas_price)
                .ok_or_else(|| anyhow!("gas overflow"))?;
            let action =
                blockle_core::ContractAction::Call { contract: id, input, value, gas_limit: gas };
            let tx = build_funded_tx(&kp, &chain, &mempool, vec![], fee, Some(action), None)?;
            println!(
                "calling {} ({} gas, {} value)",
                hex::encode(id),
                gas,
                format_amount(value)
            );
            submit_tx(datadir, &chain, &mut mempool, tx, node).map(|_| ())
        }
        ContractCmd::Simulate { id, input, value, gas } => {
            let id = parse_hash32(&id)?;
            let input = hex::decode(input).map_err(|e| anyhow!("bad input hex: {e}"))?;
            let value = parse_amount(&value).map_err(|e| anyhow!("{e}"))?;
            let kp = load_wallet(datadir)?;
            let chain = storage::load_chain(datadir, params)?;
            let result = chain.simulate_call(&id, kp.address(), &input, value, gas);
            println!("success:  {}", result.success);
            println!("gas used: {}", result.gas_used);
            println!("return:   {}", hex::encode(&result.return_data));
            for (i, log) in result.logs.iter().enumerate() {
                println!("log[{i}]:   {}", hex::encode(log));
            }
            for (addr, amount) in &result.payouts {
                println!(
                    "payout:   {} {} → {}",
                    format_amount(*amount),
                    chain.params.ticker,
                    encode_address(addr)
                );
            }
            Ok(())
        }
        ContractCmd::Storage { id, key } => {
            let id = parse_hash32(&id)?;
            let mut key_bytes = hex::decode(key).map_err(|e| anyhow!("bad key hex: {e}"))?;
            if key_bytes.len() > 32 {
                bail!("key longer than 32 bytes");
            }
            key_bytes.resize(32, 0);
            let key: [u8; 32] = key_bytes.try_into().unwrap();
            let chain = storage::load_chain(datadir, params)?;
            match chain.contract_storage.get(&(id, key)) {
                Some(value) => println!("{}", hex::encode(value)),
                None => println!("(empty)"),
            }
            Ok(())
        }
        ContractCmd::List => {
            let chain = storage::load_chain(datadir, params)?;
            if chain.contracts.is_empty() {
                println!("no contracts deployed");
            }
            for (id, info) in &chain.contracts {
                println!(
                    "{}  {} bytes code, balance {} {}",
                    hex::encode(id),
                    info.code.len(),
                    format_amount(info.balance),
                    chain.params.ticker
                );
            }
            Ok(())
        }
    }
}

// ---------- shielded pool commands ----------

use blockle_core::{ShieldedBundle, ShieldedOutput, ShieldedSpend};
use blockle_zk::{self as zk, BaseElement};
use storage::NoteRecord;

fn blinding_to_hex(b: BaseElement) -> String {
    use blockle_zk::StarkField;
    hex::encode(b.as_int().to_le_bytes())
}

fn hex_to_blinding(s: &str) -> Result<BaseElement> {
    let bytes: [u8; 16] = hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow!("blinding must be 16 bytes"))?;
    Ok(BaseElement::new(u128::from_le_bytes(bytes)))
}

fn hex_to_hash32(s: &str) -> Result<[u8; 32]> {
    hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow!("expected 32 bytes of hex"))
}

/// Generate fresh note secrets for `value` and return the stored record.
fn new_note(value: u64) -> NoteRecord {
    let nullifier = [zk::random_felt(), zk::random_felt()];
    let blinding = zk::random_felt();
    let commitment = zk::commitment(nullifier, value, blinding);
    NoteRecord {
        commitment: hex::encode(commitment),
        nullifier: hex::encode(zk::felts_to_bytes(&nullifier)),
        blinding: blinding_to_hex(blinding),
        value,
    }
}

fn shield(datadir: &Path, params: ChainParams, amount: &str, fee: &str, node: Option<String>) -> Result<()> {
    let kp = load_wallet(datadir)?;
    let chain = storage::load_chain(datadir, params)?;
    let mut mempool = storage::load_mempool(datadir)?;
    let amount = parse_amount(amount).map_err(|e| anyhow!("{e}"))?;
    let fee = parse_amount(fee).map_err(|e| anyhow!("{e}"))?;

    let record = new_note(amount);
    let bundle = ShieldedBundle {
        spends: vec![],
        outputs: vec![ShieldedOutput { commitment: hex_to_hash32(&record.commitment)?, value: amount }],
        transfers: vec![],
    };
    let tx = build_funded_tx(&kp, &chain, &mempool, vec![], fee, None, Some(bundle))?;

    let mut notes = storage::load_notes(datadir)?;
    notes.push(record.clone());
    storage::save_notes(datadir, &notes)?;
    if !json_mode() {
        println!(
            "shielding {} {} into note {} (note #{} in your wallet)",
            format_amount(amount),
            chain.params.ticker,
            &record.commitment[..16],
            notes.len() - 1
        );
    }
    let note_index = notes.len() - 1;
    let txid = submit_tx(datadir, &chain, &mut mempool, tx, node)?;
    emit_json(json!({"ok": true, "txid": display_hash(&txid), "note": note_index}));
    Ok(())
}

/// Build a tx that spends wallet note `index`, paying `t_out` transparently
/// and/or creating `z_output`. Fee is implicit (value - outputs).
fn build_spend_note_tx(
    chain: &Chain,
    note: &NoteRecord,
    t_out: Vec<TxOutput>,
    z_output: Option<ShieldedOutput>,
) -> Result<Transaction> {
    let commitment = hex_to_hash32(&note.commitment)?;
    let leaf_index = chain
        .note_leaves
        .iter()
        .position(|l| *l == commitment)
        .ok_or_else(|| anyhow!("note not found on chain (unconfirmed?)"))?;
    let nullifier_bytes = hex_to_hash32(&note.nullifier)?;
    if chain.nullifiers.contains(&nullifier_bytes) {
        bail!("note already spent");
    }
    let tree = zk::NoteTree::from_leaves(&chain.note_leaves).map_err(|e| anyhow!("{e}"))?;
    let mut tx = Transaction {
        version: 1,
        inputs: vec![],
        outputs: t_out,
        coinbase_data: vec![],
        shielded: Some(ShieldedBundle {
            spends: vec![ShieldedSpend {
                anchor: tree.root(),
                nullifier: nullifier_bytes,
                value: note.value,
                proof: vec![],
            }],
            outputs: z_output.into_iter().collect(),
            transfers: vec![],
        }),
        contract: None,
    };
    let sighash = zk::bytes_to_felts_reduced(&tx.sighash());
    let nullifier = zk::bytes_to_felts(&nullifier_bytes).map_err(|e| anyhow!("{e}"))?;
    let branch = tree.branch(leaf_index).map_err(|e| anyhow!("{e}"))?;
    let proof = zk::prove_spend(
        nullifier,
        BaseElement::new(note.value as u128),
        hex_to_blinding(&note.blinding)?,
        branch,
        leaf_index,
        sighash,
    )
    .map_err(|e| anyhow!("proving failed: {e}"))?;
    tx.shielded.as_mut().unwrap().spends[0].proof = proof;

    let next_height = chain.blocks.len() as u64;
    chain
        .check_transaction(&tx, &chain.utxos, next_height)
        .map_err(|e| anyhow!("transaction rejected: {e}"))?;
    Ok(tx)
}

fn get_note(datadir: &Path, index: usize) -> Result<NoteRecord> {
    let notes = storage::load_notes(datadir)?;
    notes
        .get(index)
        .cloned()
        .ok_or_else(|| anyhow!("no note #{index}; see `blockle notes`"))
}

fn unshield(
    datadir: &Path,
    params: ChainParams,
    note: usize,
    to: Option<String>,
    fee: &str,
    node: Option<String>,
) -> Result<()> {
    let chain = storage::load_chain(datadir, params)?;
    let mut mempool = storage::load_mempool(datadir)?;
    let record = get_note(datadir, note)?;
    let fee = parse_amount(fee).map_err(|e| anyhow!("{e}"))?;
    let recipient = resolve_address(datadir, to)?;
    if record.value <= fee {
        bail!("note value does not cover the fee");
    }
    let tx = build_spend_note_tx(
        &chain,
        &record,
        vec![TxOutput { recipient, amount: record.value - fee }],
        None,
    )?;
    if !json_mode() {
        println!(
            "unshielding note #{note}: {} {} → {}",
            format_amount(record.value - fee),
            chain.params.ticker,
            encode_address(&recipient)
        );
    }
    let txid = submit_tx(datadir, &chain, &mut mempool, tx, node)?;
    emit_json(json!({"ok": true, "txid": display_hash(&txid)}));
    Ok(())
}

// ---------- ML-KEM encrypted delivery ----------

use fips203::ml_kem_768;
use fips203::traits::{Decaps, Encaps, KeyGen, SerDes};

const ZADDR_PREFIX: &str = "zblockpk";
const MEMO_LEN: usize = ml_kem_768::CT_LEN + 8 + 32; // kem ct || enc(value) || tag

/// Load (or lazily create and persist) this wallet's ML-KEM keypair.
fn load_or_create_kem(datadir: &Path) -> Result<(Vec<u8>, Vec<u8>)> {
    let path = storage::wallet_path(datadir);
    let mut wf = read_wallet_file(datadir)?;
    if wf.kem_public_hex.is_empty() {
        let (ek, dk) = ml_kem_768::KG::try_keygen().map_err(|e| anyhow!("kem keygen: {e}"))?;
        wf.set_kem_secret(&ek.into_bytes(), &dk.into_bytes(), passphrase().as_deref())?;
        write_wallet_file(datadir, &wf)?;
        if !json_mode() {
            println!("(generated ML-KEM shielded-address keys for this wallet)");
        }
    }
    let (_, kem_secret) = wf.secrets(passphrase().as_deref())?;
    Ok((hex::decode(&wf.kem_public_hex)?, kem_secret))
}

/// Derive deterministic note secrets from a KEM shared secret — both sender
/// and recipient compute the same (nullifier, blinding).
fn derive_note_secrets(ss: &[u8; 32]) -> ([BaseElement; 2], BaseElement) {
    let kdf = |tag: &[u8]| -> BaseElement {
        let h = blockle_core::hash::blake2b_256_personal(tag, ss);
        BaseElement::new(u128::from_le_bytes(h[..16].try_into().unwrap()))
    };
    ([kdf(b"BlklNtN0"), kdf(b"BlklNtN1")], kdf(b"BlklNtRr"))
}

fn memo_tag(ss: &[u8; 32], enc_v: &[u8; 8], commitment: &[u8; 32]) -> [u8; 32] {
    let mut data = Vec::with_capacity(72);
    data.extend_from_slice(ss);
    data.extend_from_slice(enc_v);
    data.extend_from_slice(commitment);
    blockle_core::hash::blake2b_256_personal(b"BlklNtTG", &data)
}

/// Encrypt a note to a recipient's KEM key. Returns (memo, note record the
/// RECIPIENT will derive — the sender keeps no copy).
fn encrypt_note_to(zaddr_ek: &[u8], value: u64) -> Result<(Vec<u8>, NoteRecord)> {
    let ek_bytes: [u8; ml_kem_768::EK_LEN] = zaddr_ek
        .try_into()
        .map_err(|_| anyhow!("bad shielded address length"))?;
    let ek = ml_kem_768::EncapsKey::try_from_bytes(ek_bytes)
        .map_err(|e| anyhow!("bad shielded address: {e}"))?;
    let (ssk, ct) = ek.try_encaps().map_err(|e| anyhow!("encapsulation failed: {e}"))?;
    let ss: [u8; 32] = ssk.into_bytes();
    let (nullifier, blinding) = derive_note_secrets(&ss);
    let commitment = zk::commitment(nullifier, value, blinding);
    let pad = blockle_core::hash::blake2b_256_personal(b"BlklNtEV", &ss);
    let mut enc_v = [0u8; 8];
    for (i, b) in value.to_le_bytes().iter().enumerate() {
        enc_v[i] = b ^ pad[i];
    }
    let tag = memo_tag(&ss, &enc_v, &commitment);
    let mut memo = Vec::with_capacity(MEMO_LEN);
    memo.extend_from_slice(&ct.into_bytes());
    memo.extend_from_slice(&enc_v);
    memo.extend_from_slice(&tag);
    let record = NoteRecord {
        commitment: hex::encode(commitment),
        nullifier: hex::encode(zk::felts_to_bytes(&nullifier)),
        blinding: blinding_to_hex(blinding),
        value,
    };
    Ok((memo, record))
}

/// Try to decrypt a transfer memo with a KEM secret key; checks the MAC and
/// that the derived commitment matches the on-chain one.
fn try_decrypt_memo(dk_bytes: &[u8], memo: &[u8], commitment1: &[u8; 32]) -> Option<NoteRecord> {
    if memo.len() != MEMO_LEN {
        return None;
    }
    let dk_arr: [u8; ml_kem_768::DK_LEN] = dk_bytes.try_into().ok()?;
    let dk = ml_kem_768::DecapsKey::try_from_bytes(dk_arr).ok()?;
    let ct_arr: [u8; ml_kem_768::CT_LEN] = memo[..ml_kem_768::CT_LEN].try_into().ok()?;
    let ct = ml_kem_768::CipherText::try_from_bytes(ct_arr).ok()?;
    let ss: [u8; 32] = dk.try_decaps(&ct).ok()?.into_bytes();
    let enc_v: [u8; 8] = memo[ml_kem_768::CT_LEN..ml_kem_768::CT_LEN + 8].try_into().ok()?;
    let tag: [u8; 32] = memo[ml_kem_768::CT_LEN + 8..].try_into().ok()?;
    if memo_tag(&ss, &enc_v, commitment1) != tag {
        return None;
    }
    let pad = blockle_core::hash::blake2b_256_personal(b"BlklNtEV", &ss);
    let mut v_bytes = [0u8; 8];
    for i in 0..8 {
        v_bytes[i] = enc_v[i] ^ pad[i];
    }
    let value = u64::from_le_bytes(v_bytes);
    let (nullifier, blinding) = derive_note_secrets(&ss);
    if zk::commitment(nullifier, value, blinding) != *commitment1 {
        return None;
    }
    Some(NoteRecord {
        commitment: hex::encode(commitment1),
        nullifier: hex::encode(zk::felts_to_bytes(&nullifier)),
        blinding: blinding_to_hex(blinding),
        value,
    })
}

fn zaddress(datadir: &Path) -> Result<()> {
    let (ek, _) = load_or_create_kem(datadir)?;
    println!("{ZADDR_PREFIX}{}", hex::encode(ek));
    Ok(())
}

fn viewkey(datadir: &Path) -> Result<()> {
    let (_, dk) = load_or_create_kem(datadir)?;
    println!("incoming viewing key (can detect + decrypt your incoming notes):");
    println!("{}", hex::encode(dk));
    Ok(())
}

fn note_opening(record: &NoteRecord) -> Result<zk::NoteOpening> {
    Ok(zk::NoteOpening {
        nullifier: zk::bytes_to_felts(&hex_to_hash32(&record.nullifier)?)
            .map_err(|e| anyhow!("{e}"))?,
        value: record.value,
        blinding: hex_to_blinding(&record.blinding)?,
    })
}

#[allow(clippy::too_many_arguments)]
fn zsend(
    datadir: &Path,
    params: ChainParams,
    note: usize,
    amount: Option<String>,
    to: Option<String>,
    fee: &str,
    node: Option<String>,
) -> Result<()> {
    let chain = storage::load_chain(datadir, params)?;
    let mut mempool = storage::load_mempool(datadir)?;
    let record = get_note(datadir, note)?;
    let fee = parse_amount(fee).map_err(|e| anyhow!("{e}"))?;
    let pay_value = match &amount {
        Some(a) => parse_amount(a).map_err(|e| anyhow!("{e}"))?,
        None => record.value.saturating_sub(fee),
    };
    let change_value = record
        .value
        .checked_sub(pay_value)
        .and_then(|v| v.checked_sub(fee))
        .ok_or_else(|| anyhow!("note value does not cover amount + fee"))?;

    // Payment note: KEM-encrypted to the recipient, or voucher-based.
    let (memo, pay_record, voucher) = match &to {
        Some(zaddr) => {
            let ek_hex = zaddr
                .strip_prefix(ZADDR_PREFIX)
                .ok_or_else(|| anyhow!("shielded address must start with {ZADDR_PREFIX}"))?;
            let (memo, rec) = encrypt_note_to(&hex::decode(ek_hex)?, pay_value)?;
            (memo, rec, None)
        }
        None => {
            let rec = new_note(pay_value);
            let voucher = format!("blocklenote1{}", hex::encode(serde_json::to_vec(&rec)?));
            (vec![], rec, Some(voucher))
        }
    };
    let change_record = new_note(change_value);

    let old = note_opening(&record)?;
    let pay = note_opening(&pay_record)?;
    let change = note_opening(&change_record)?;

    let commitment = hex_to_hash32(&record.commitment)?;
    let leaf_index = chain
        .note_leaves
        .iter()
        .position(|l| *l == commitment)
        .ok_or_else(|| anyhow!("note not found on chain (unconfirmed?)"))?;
    if chain.nullifiers.contains(&hex_to_hash32(&record.nullifier)?) {
        bail!("note already spent");
    }
    let tree = zk::NoteTree::from_leaves(&chain.note_leaves).map_err(|e| anyhow!("{e}"))?;
    let mut tx = Transaction {
        version: 1,
        inputs: vec![],
        outputs: vec![],
        coinbase_data: vec![],
        shielded: Some(ShieldedBundle {
            spends: vec![],
            outputs: vec![],
            transfers: vec![blockle_core::ShieldedTransfer {
                anchor: tree.root(),
                nullifier: hex_to_hash32(&record.nullifier)?,
                commitment1: hex_to_hash32(&pay_record.commitment)?,
                commitment2: hex_to_hash32(&change_record.commitment)?,
                fee,
                memo,
                proof: vec![],
            }],
        }),
        contract: None,
    };
    let sighash = zk::bytes_to_felts_reduced(&tx.sighash());
    let proof = zk::prove_transfer(
        &old,
        &pay,
        &change,
        fee,
        tree.branch(leaf_index).map_err(|e| anyhow!("{e}"))?,
        leaf_index,
        sighash,
    )
    .map_err(|e| anyhow!("proving failed: {e}"))?;
    tx.shielded.as_mut().unwrap().transfers[0].proof = proof;

    let next_height = chain.blocks.len() as u64;
    chain
        .check_transaction(&tx, &chain.utxos, next_height)
        .map_err(|e| anyhow!("transaction rejected: {e}"))?;

    // Keep the change note; the payment note belongs to the recipient.
    if change_value > 0 {
        let mut notes = storage::load_notes(datadir)?;
        notes.push(change_record);
        storage::save_notes(datadir, &notes)?;
    }
    if !json_mode() {
        println!(
            "hidden transfer: paying {} {} (+{} fee), {} change — amounts not visible on chain",
            format_amount(pay_value),
            chain.params.ticker,
            format_amount(fee),
            format_amount(change_value),
        );
        match (&to, &voucher) {
            (Some(_), _) => println!("payment note delivered on-chain, encrypted to the recipient (ML-KEM-768)"),
            (None, Some(v)) => {
                println!("voucher (hand to the recipient out of band; treat as cash):");
                println!("{v}");
            }
            _ => unreachable!(),
        }
    }
    let txid = submit_tx(datadir, &chain, &mut mempool, tx, node)?;
    emit_json(json!({"ok": true, "txid": display_hash(&txid), "voucher": voucher}));
    Ok(())
}

fn scan(datadir: &Path, params: ChainParams, viewkey_hex: Option<String>) -> Result<()> {
    let chain = storage::load_chain(datadir, params)?;
    let audit_only = viewkey_hex.is_some();
    let dk = match viewkey_hex {
        Some(h) => hex::decode(h.trim())?,
        None => load_or_create_kem(datadir)?.1,
    };
    let mut notes = if audit_only { vec![] } else { storage::load_notes(datadir)? };
    let mut found = 0usize;
    for block in &chain.blocks {
        for tx in &block.transactions {
            let Some(bundle) = &tx.shielded else { continue };
            for t in &bundle.transfers {
                if t.memo.is_empty() {
                    continue;
                }
                let Some(rec) = try_decrypt_memo(&dk, &t.memo, &t.commitment1) else {
                    continue;
                };
                if notes.iter().any(|n| n.commitment == rec.commitment) {
                    continue;
                }
                let spent = chain
                    .nullifiers
                    .contains(&hex_to_hash32(&rec.nullifier)?);
                println!(
                    "found note: {} {}  {}  {}",
                    format_amount(rec.value),
                    chain.params.ticker,
                    &rec.commitment[..16],
                    if spent { "SPENT" } else { "unspent" }
                );
                found += 1;
                notes.push(rec);
            }
        }
    }
    if audit_only {
        println!("audit scan complete: {found} note(s) decrypted (not saved)");
    } else if found > 0 {
        storage::save_notes(datadir, &notes)?;
        println!("{found} new note(s) added to the wallet");
    } else {
        println!("no new notes found");
    }
    Ok(())
}

fn note_disclose(datadir: &Path, note: usize) -> Result<()> {
    let record = get_note(datadir, note)?;
    println!("payment disclosure for note #{note} (reveals this note's value and spend status to the holder):");
    println!("blockledisclose1{}", hex::encode(serde_json::to_vec(&record)?));
    Ok(())
}

fn verify_disclosure(datadir: &Path, params: ChainParams, disclosure: &str) -> Result<()> {
    let hex_part = disclosure
        .strip_prefix("blockledisclose1")
        .ok_or_else(|| anyhow!("not a blockle payment disclosure"))?;
    let record: NoteRecord = serde_json::from_slice(&hex::decode(hex_part)?)?;
    let opening = note_opening(&record)?;
    let expected = zk::commitment(opening.nullifier, opening.value, opening.blinding);
    if hex::encode(expected) != record.commitment {
        bail!("INVALID: commitment does not match the disclosed opening");
    }
    let chain = storage::load_chain(datadir, params)?;
    if !chain.note_leaves.contains(&expected) {
        bail!("INVALID: note does not exist on chain");
    }
    let spent = chain.nullifiers.contains(&hex_to_hash32(&record.nullifier)?);
    println!(
        "VALID: note of {} {} exists on chain ({})",
        format_amount(record.value),
        chain.params.ticker,
        if spent { "already spent" } else { "unspent" }
    );
    Ok(())
}

fn note_import(datadir: &Path, params: ChainParams, voucher: &str) -> Result<()> {
    let hex_part = voucher
        .strip_prefix("blocklenote1")
        .ok_or_else(|| anyhow!("not a blockle note voucher"))?;
    let record: NoteRecord = serde_json::from_slice(&hex::decode(hex_part)?)?;
    // Verify internal consistency: commitment must equal H(N, v, r).
    let nullifier = zk::bytes_to_felts(&hex_to_hash32(&record.nullifier)?).map_err(|e| anyhow!("{e}"))?;
    let expected = zk::commitment(nullifier, record.value, hex_to_blinding(&record.blinding)?);
    if hex::encode(expected) != record.commitment {
        bail!("voucher is inconsistent (commitment mismatch)");
    }
    let chain = storage::load_chain(datadir, params)?;
    let on_chain = chain.note_leaves.contains(&expected);
    let mut notes = storage::load_notes(datadir)?;
    if notes.iter().any(|n| n.commitment == record.commitment) {
        bail!("note already in wallet");
    }
    let value = record.value;
    notes.push(record);
    storage::save_notes(datadir, &notes)?;
    println!(
        "imported {} {} note as #{}{}",
        format_amount(value),
        chain.params.ticker,
        notes.len() - 1,
        if on_chain { "" } else { " (not yet confirmed on chain)" }
    );
    println!("recommended: `blockle zsend --note {}` to yourself so the sender can no longer spend it.", notes.len() - 1);
    Ok(())
}

fn notes_cmd(datadir: &Path, params: ChainParams) -> Result<()> {
    let chain = storage::load_chain(datadir, params)?;
    let notes = storage::load_notes(datadir)?;
    if notes.is_empty() {
        println!("no shielded notes; create one with `blockle shield`");
        return Ok(());
    }
    for (i, note) in notes.iter().enumerate() {
        let nullifier = hex_to_hash32(&note.nullifier)?;
        let commitment = hex_to_hash32(&note.commitment)?;
        let status = if chain.nullifiers.contains(&nullifier) {
            "SPENT"
        } else if chain.note_leaves.contains(&commitment) {
            "unspent"
        } else {
            "unconfirmed"
        };
        println!(
            "#{i}  {} {}  {}  {}",
            format_amount(note.value),
            chain.params.ticker,
            &note.commitment[..16],
            status
        );
    }
    Ok(())
}

fn zbalance(datadir: &Path, params: ChainParams) -> Result<()> {
    let chain = storage::load_chain(datadir, params)?;
    let notes = storage::load_notes(datadir)?;
    let mut total = 0u64;
    for note in &notes {
        let nullifier = hex_to_hash32(&note.nullifier)?;
        let commitment = hex_to_hash32(&note.commitment)?;
        if !chain.nullifiers.contains(&nullifier) && chain.note_leaves.contains(&commitment) {
            total += note.value;
        }
    }
    println!("{} {}", format_amount(total), chain.params.ticker);
    Ok(())
}

const EXPORT_PREFIX: &str = "blockleexport1";
const SIG_PREFIX: &str = "blocklesig1";

fn message_digest(message: &str) -> [u8; 32] {
    blockle_core::hash::blake2b_256_personal(b"BlklMsgS", message.as_bytes())
}

fn wallet_cmd(datadir: &Path, cmd: WalletCmd) -> Result<()> {
    let path = storage::wallet_path(datadir);
    match cmd {
        WalletCmd::Encrypt => {
            let mut wf = read_wallet_file(datadir)?;
            let pass = passphrase()
                .ok_or_else(|| anyhow!("pass --passphrase (or BLOCKLE_WALLET_PASSPHRASE)"))?;
            wf.encrypt(&pass)?;
            write_wallet_file(datadir, &wf)?;
            emit_json(json!({"ok": true, "encrypted": true}));
            if !json_mode() {
                println!("wallet encrypted — keep the passphrase safe; without it the funds are gone");
            }
            Ok(())
        }
        WalletCmd::Decrypt => {
            let mut wf = read_wallet_file(datadir)?;
            let pass = passphrase().ok_or_else(|| anyhow!("passphrase required"))?;
            wf.decrypt(&pass)?;
            write_wallet_file(datadir, &wf)?;
            emit_json(json!({"ok": true, "encrypted": false}));
            if !json_mode() {
                println!("wallet decrypted (keys stored in plain text again)");
            }
            Ok(())
        }
        WalletCmd::ChangePassphrase { new_passphrase } => {
            let mut wf = read_wallet_file(datadir)?;
            let old = passphrase().ok_or_else(|| anyhow!("current passphrase required"))?;
            wf.change_passphrase(&old, &new_passphrase)?;
            write_wallet_file(datadir, &wf)?;
            emit_json(json!({"ok": true}));
            if !json_mode() {
                println!("passphrase changed");
            }
            Ok(())
        }
        WalletCmd::Backup { out } => {
            read_wallet_file(datadir)?; // validate before copying
            fs::copy(&path, &out)?;
            emit_json(json!({"ok": true, "backup": out.display().to_string()}));
            if !json_mode() {
                println!("wallet backed up to {}", out.display());
            }
            Ok(())
        }
        WalletCmd::Export => {
            let wf = read_wallet_file(datadir)?;
            let (secret, kem) = wf.secrets(passphrase().as_deref())?;
            let payload = json!({
                "secret_hex": hex::encode(secret),
                "public_hex": wf.public_hex,
                "address": wf.address,
                "kem_public_hex": wf.kem_public_hex,
                "kem_secret_hex": hex::encode(kem),
            });
            let blob = format!("{EXPORT_PREFIX}{}", hex::encode(payload.to_string()));
            emit_json(json!({"ok": true, "export": blob}));
            if !json_mode() {
                println!("{blob}");
                println!("(anyone with this string owns the wallet — treat it as cash)");
            }
            Ok(())
        }
        WalletCmd::Import { source, force } => {
            if path.exists() && !force {
                bail!("a wallet already exists in {} — pass --force to replace it", datadir.display());
            }
            let raw = if std::path::Path::new(&source).exists() {
                fs::read_to_string(&source)?
            } else {
                source
            };
            let raw = raw.trim();
            let parsed: serde_json::Value = if let Some(hexpart) = raw.strip_prefix(EXPORT_PREFIX) {
                serde_json::from_slice(&hex::decode(hexpart.trim())?)?
            } else {
                serde_json::from_str(raw).map_err(|_| {
                    anyhow!("not an export blob (blockleexport1…) or wallet.json")
                })?
            };
            let get = |k: &str| parsed.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let secret = hex::decode(get("secret_hex"))
                .map_err(|_| anyhow!("import has no plaintext secret (decrypt-export it first)"))?;
            if secret.is_empty() {
                bail!("import has no secret key material");
            }
            let public = hex::decode(get("public_hex"))?;
            let kp = Keypair::from_bytes(&secret, &public)
                .map_err(|_| anyhow!("import key material is invalid"))?;
            let address = encode_address(&kp.address());
            let wf = WalletFile {
                secret_hex: hex::encode(&secret),
                public_hex: hex::encode(&public),
                address: address.clone(),
                kem_public_hex: get("kem_public_hex"),
                kem_secret_hex: get("kem_secret_hex"),
                ..WalletFile::default()
            };
            fs::create_dir_all(datadir)?;
            write_wallet_file(datadir, &wf)?;
            emit_json(json!({"ok": true, "address": address}));
            if !json_mode() {
                println!("wallet imported: {address}");
                println!("(run `blockle wallet encrypt` to protect it with a passphrase)");
            }
            Ok(())
        }
        WalletCmd::SignMessage { message } => {
            let kp = load_wallet(datadir)?;
            let sig = kp.sign(&message_digest(&message));
            let payload = json!({
                "p": hex::encode(kp.public_bytes()),
                "s": hex::encode(sig),
            });
            let blob = format!("{SIG_PREFIX}{}", hex::encode(payload.to_string()));
            emit_json(json!({"ok": true, "signature": blob, "address": encode_address(&kp.address())}));
            if !json_mode() {
                println!("{blob}");
            }
            Ok(())
        }
        WalletCmd::VerifyMessage { address, signature, message } => {
            let hexpart = signature
                .trim()
                .strip_prefix(SIG_PREFIX)
                .ok_or_else(|| anyhow!("signature must start with {SIG_PREFIX}"))?;
            let payload: serde_json::Value = serde_json::from_slice(&hex::decode(hexpart)?)?;
            let pubkey = hex::decode(payload.get("p").and_then(|v| v.as_str()).unwrap_or(""))?;
            let sig = hex::decode(payload.get("s").and_then(|v| v.as_str()).unwrap_or(""))?;
            let claimed = decode_address(&address).map_err(|e| anyhow!("{e}"))?;
            let valid = blockle_core::keys::pubkey_to_address(&pubkey) == claimed
                && blockle_core::keys::verify_signature(&pubkey, &message_digest(&message), &sig)
                    .is_ok();
            emit_json(json!({"ok": true, "valid": valid}));
            if !json_mode() {
                println!("{}", if valid { "VALID — signed by the key behind that address" } else { "INVALID" });
            }
            if !valid && !json_mode() {
                std::process::exit(1);
            }
            Ok(())
        }
    }
}

/// One JSON document with everything a wallet GUI needs: wallet keys and
/// balances, shielded notes, chain status, and the wallet's transaction
/// history (computed by walking the chain with a running UTXO-ownership map).
fn ui_snapshot(datadir: &Path, params: ChainParams) -> Result<()> {
    let wallet_exists = storage::wallet_path(datadir).exists();
    let chain = storage::load_chain_or_empty(datadir, params)?;
    let mempool = storage::load_mempool(datadir).unwrap_or_default();
    let p = chain.params.clone();

    let mut wallet = json!(null);
    let mut history: Vec<serde_json::Value> = vec![];
    if wallet_exists {
        let mut wf = read_wallet_file(datadir)?;
        // Plain wallets get their shielded keys on first look; encrypted
        // wallets defer until an unlock provides the passphrase.
        if wf.kem_public_hex.is_empty() && !wf.encrypted {
            let _ = load_or_create_kem(datadir);
            wf = read_wallet_file(datadir)?;
        }
        let addr = decode_address(&wf.address).map_err(|e| anyhow!("{e}"))?;
        let ek = hex::decode(&wf.kem_public_hex).unwrap_or_default();
        let notes = storage::load_notes(datadir)?;
        let mut notes_json = vec![];
        let mut zbal = 0u64;
        for (i, note) in notes.iter().enumerate() {
            let nullifier = hex_to_hash32(&note.nullifier)?;
            let commitment = hex_to_hash32(&note.commitment)?;
            let status = if chain.nullifiers.contains(&nullifier) {
                "spent"
            } else if chain.note_leaves.contains(&commitment) {
                "unspent"
            } else {
                "unconfirmed"
            };
            if status == "unspent" {
                zbal += note.value;
            }
            notes_json.push(json!({
                "index": i,
                "value": note.value,
                "value_fmt": format_amount(note.value),
                "commitment": note.commitment,
                "status": status,
            }));
        }

        let mut owned: HashMap<(Hash32, u32), u64> = HashMap::new();
        let mut walk = |tx: &Transaction, height: Option<u64>, time: Option<u32>, owned: &mut HashMap<(Hash32, u32), u64>| -> Option<serde_json::Value> {
            let txid = tx.txid();
            let mut received = 0u64;
            let mut spent = 0u64;
            let mut counterparty: Option<String> = None;
            for input in &tx.inputs {
                if let Some(v) = owned.get(&(input.prev.txid, input.prev.vout)) {
                    spent += v;
                }
            }
            for (vout, out) in tx.outputs.iter().enumerate() {
                if out.recipient == addr {
                    received += out.amount;
                    owned.insert((txid, vout as u32), out.amount);
                } else if counterparty.is_none() {
                    counterparty = Some(encode_address(&out.recipient));
                }
            }
            if received == 0 && spent == 0 {
                return None;
            }
            let kind = if tx.is_coinbase() {
                "coinbase"
            } else if tx.shielded.is_some() {
                "shielded"
            } else {
                "transfer"
            };
            let net = received as i128 - spent as i128;
            Some(json!({
                "height": height,
                "time": time,
                "txid": display_hash(&txid),
                "kind": kind,
                "net": net,
                "net_fmt": format!("{}{}", if net < 0 { "-" } else { "+" }, format_amount(net.unsigned_abs() as u64)),
                "counterparty": if net < 0 { counterparty } else { None },
                "pending": height.is_none(),
            }))
        };
        for (height, block) in chain.blocks.iter().enumerate() {
            for tx in &block.transactions {
                if let Some(e) = walk(tx, Some(height as u64), Some(block.header.time), &mut owned) {
                    history.push(e);
                }
            }
        }
        for tx in &mempool {
            if let Some(e) = walk(tx, None, None, &mut owned) {
                history.push(e);
            }
        }
        history.reverse();

        let balance = chain.balance(&addr);
        wallet = json!({
            "address": encode_address(&addr),
            "zaddress": if ek.is_empty() {
                String::new()
            } else {
                format!("{ZADDR_PREFIX}{}", hex::encode(&ek))
            },
            "encrypted": wf.encrypted,
            "balance": balance,
            "balance_fmt": format_amount(balance),
            "zbalance": zbal,
            "zbalance_fmt": format_amount(zbal),
            "notes": notes_json,
        });
    }

    let tip = chain.blocks.last().map(|b| json!({
        "hash": display_hash(&b.header.hash()),
        "time": b.header.time,
    }));
    let out = json!({
        "wallet": wallet,
        "chain": {
            "name": p.name,
            "ticker": p.ticker,
            "network": if p.equihash.n == 200 { "mainnet" } else { "regtest" },
            "height": chain.height(),
            "tip": tip,
            "subsidy": p.block_subsidy(chain.blocks.len() as u64),
            "mempool": mempool.len(),
            "utxos": chain.utxos.len(),
        },
        "history": history,
    });
    println!("{}", serde_json::to_string(&out)?);
    Ok(())
}

