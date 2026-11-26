//! Peer-to-peer networking: binary wire protocol, headers-first sync,
//! most-work fork choice, gossip, and peer discovery.
//!
//! Transport is plain TCP carrying length-prefixed **bincode** frames, one
//! reader/writer thread pair per peer — no async runtime.
//!
//! ## Sync (headers-first)
//!
//! On `Version`/`Tip` showing more accumulated work, the lighter side sends
//! `GetHeaders` with a block locator (exponentially spaced tip hashes). The
//! peer replies with headers after the highest locator match. Headers are
//! checked for linkage and standalone proof-of-work; if the implied chain has
//! more total work, only the missing blocks are requested with `GetBlocks`,
//! and the reassembled chain is fully re-validated before adoption. Blocks
//! extending the tip skip all that and connect directly from `NewBlock`
//! gossip.
//!
//! ## Discovery
//!
//! `Version` carries the peer's listening address; `GetAddr`/`Addr` gossip
//! known addresses, and an auto-connect loop dials new peers until the
//! outbound target is reached.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use blockle_chain::{build_template, mine_block_cancellable, Chain, ChainParams, U256};
use blockle_core::display_hash;
use blockle_core::hash::Hash32;
use blockle_core::keys::Address;
use blockle_core::{Block, BlockHeader, Transaction};
use blockle_pow::difficulty::hash_meets_target;
use blockle_pow::equihash;

use crate::storage;

pub const PROTOCOL_VERSION: u32 = 2;
const MAX_MESSAGE_SIZE: u32 = 64 * 1024 * 1024;
const MAX_HEADERS_PER_MSG: usize = 2000;
const MAX_BLOCKS_PER_REQUEST: usize = 2000;
const OUTBOUND_TARGET: usize = 8;
/// After this many consecutive failed dials a LEARNED (gossiped) address is
/// evicted from the known set; until then retries are spaced by an exponential
/// backoff. SEED addresses (built-in + operator `--connect`) are NEVER evicted —
/// a temporary outage of the main node must not permanently island a miner.
const MAX_DIAL_FAILS: u32 = 6;
/// Built-in always-on seed nodes, merged into every node's known set and never
/// evicted. A node therefore has a bootstrap path even with no `--connect` and
/// even after the main node restarts. Add community always-on nodes here.
const DEFAULT_SEEDS: &[&str] = &[
    "blockle.org:18444",
    // Community always-on node operated by Shears Mining (Andy).
    "stratum.shears.co.uk:18444",
];
const HEARTBEAT: Duration = Duration::from_secs(10);
/// Keep a validated chain snapshot every this many blocks, and retain this many
/// of them — so a fork rooted up to `SNAP_INTERVAL × SNAP_RING` blocks below our
/// tip can be resolved by replaying forward from a snapshot instead of
/// rebuilding from genesis. See [`Node::pick_reorg_base`] for why bounding the
/// MECHANISM does not bound which forks are acceptable.
///
/// SIZED FROM OBSERVATION, AND THE OBSERVATION IS THIN: in a 6-hour window the
/// live pool node saw peers announcing forks 1-3 blocks below its tip, plus one
/// peer pinned ~80 blocks below it. The block locator's spacing doubles after
/// its first 10 entries, so a true depth-d fork resolves to a start height up
/// to roughly 2d below the tip; 256 covers the observed 80 with headroom. The
/// fork-depth histogram ([`Node::fork_depth_histogram`]) exists to replace this
/// guess with data — if real forks turn out to exceed the horizon, the right
/// shape is a geometric ladder (snapshots at tip-32, -64, -128, -256, -512, …),
/// which keeps replay O(depth) out to thousands of blocks for ~10 snapshots.
pub const SNAP_INTERVAL: u64 = 32;
pub const SNAP_RING: usize = 8;
/// How many (fork start height, fork tip hash) pairs to remember as "already
/// weighed and found lighter". See [`Node::remember_rejected_fork`].
const REJECTED_FORK_MEMORY: usize = 1024;
/// How often the local miner abandons and rebuilds its block template so the
/// quiet-lane difficulty decay (which is a function of wall-clock time) takes
/// effect even when nothing else is moving the tip.
const MINE_TEMPLATE_REFRESH: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Message {
    Version {
        network: String,
        protocol: u32,
        height: Option<u64>,
        /// Accumulated work, big-endian — byte order equals numeric order.
        total_work: [u8; 32],
        tip: Hash32,
        /// Address this peer accepts connections on (for discovery).
        listen: Option<String>,
    },
    GetTip,
    Tip { height: Option<u64>, total_work: [u8; 32], tip: Hash32 },
    /// Block locator: tip-first, exponentially spaced header hashes.
    GetHeaders { locator: Vec<Hash32> },
    /// Headers starting at `start_height` on the sender's chain.
    Headers { start_height: u64, headers: Vec<BlockHeader> },
    GetBlocks { hashes: Vec<Hash32> },
    Blocks { blocks: Vec<Block> },
    NewBlock { block: Block },
    NewTx { tx: Transaction },
    GetAddr,
    Addr { addrs: Vec<String> },
    Ping,
    Pong,
}

pub fn work_bytes(w: U256) -> [u8; 32] {
    let mut out = [0u8; 32];
    w.to_big_endian(&mut out);
    out
}

// ---------- wire framing (length-prefixed bincode) ----------

pub fn write_message<W: Write>(w: &mut W, msg: &Message) -> io::Result<()> {
    let data = bincode::serialize(msg).map_err(io::Error::other)?;
    w.write_all(&(data.len() as u32).to_le_bytes())?;
    w.write_all(&data)?;
    w.flush()
}

pub fn read_message<R: Read>(r: &mut R) -> io::Result<Message> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len);
    if len > MAX_MESSAGE_SIZE {
        return Err(io::Error::other("message too large"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    bincode::deserialize(&buf).map_err(io::Error::other)
}

// ---------- node ----------

pub struct NodeConfig {
    pub datadir: PathBuf,
    pub params: ChainParams,
    pub listen: String,
    pub connect: Vec<String>,
    /// Reward address for mined/stratum blocks.
    pub mine_to: Option<Address>,
    /// Run the in-process CPU miner.
    pub local_mine: bool,
    /// Stop the local miner after this many blocks (None = forever).
    pub mine_blocks: Option<u64>,
    /// Seconds to pause after each locally mined block (regtest pacing).
    pub mine_interval: Option<u64>,
    /// Stratum server bind address, if enabled.
    /// Stratum pool listeners: (address, pool options).
    pub pools: Vec<(String, crate::stratum::PoolOpts)>,
    /// ESCAPE HATCH: always rebuild a reorg candidate from genesis, never from
    /// a retained prefix snapshot.
    ///
    /// The bounded path and the from-genesis path are supposed to be the same
    /// function of the same blocks (see `Chain::from_blocks`, which is kept as
    /// the reference implementation precisely so this flag can exist). If that
    /// ever turns out to be false in production, an operator needs a way to run
    /// the slow, known-correct code without waiting for a new build — this is
    /// that way. It costs a full from-genesis revalidation per announced fork,
    /// which at height 82,000 is ~17 minutes, so it is strictly a break-glass
    /// setting and not a hardening measure.
    pub reorg_authority: bool,
    /// CANARY: on every bounded reorg, ALSO build the candidate from genesis
    /// and refuse the adoption unless the two agree on every byte of state.
    ///
    /// This is how the bounded path earns the right to be the silent default:
    /// run a node with it for a week and the equivalence is a production fact
    /// rather than a test fixture. It pays the full from-genesis cost on top of
    /// the cheap path, so it must not be left on anywhere that serves miners.
    pub selfcheck_reorg: bool,
}

struct SharedState {
    /// BEHIND AN Arc ON PURPOSE.
    ///
    /// `snapshot()` is called on every RPC method, every explorer request and
    /// every stratum job across all 18 pools. When this was a plain `Chain`,
    /// each of those deep-copied the entire chain — 441 MB at 75k blocks — and
    /// then dropped it. Hundreds of MB allocated and freed per request, spread
    /// across ~113 connection threads, is the exact workload glibc malloc
    /// handles worst: every thread claims its own arena, each arena grows a
    /// 64 MB heap to fit one transient, and a non-main arena heap is never
    /// returned to the OS. The mainnet node reached 24.8 GB RSS holding a
    /// 441 MB chain, 17.3 GB of it sitting in 236 empty 64 MB arena heaps.
    ///
    /// With an Arc, readers clone a pointer. The chain is copied once per
    /// block connect (copy-on-write via `Arc::make_mut`) — every 600 s instead
    /// of every request.
    chain: Arc<Chain>,
    mempool: Vec<Transaction>,
    /// Recently validated prefixes of `chain`, ascending by height — the
    /// states a bounded reorg replays forward from.
    ///
    /// INVARIANT: every entry is a strict prefix of `chain`, i.e. entry `s`
    /// equals what `chain` was when it held `s.blocks.len()` blocks. Maintained
    /// by [`Node::record_snapshot`] (which only ever stores the current chain)
    /// and [`Node::prune_snapshots`] (which drops entries describing a branch
    /// we just abandoned). NOT TRUSTED on the strength of that invariant: every
    /// use re-proves it with an O(1) hash comparison, because a bookkeeping bug
    /// here would mean replaying onto the state of an orphaned branch, which is
    /// a chain split. See [`Node::pick_reorg_base`].
    ///
    /// Each entry costs one pointer per block (0.66 MB of pointers at height
    /// 82,000) plus a copy of the state maps — affordable only because
    /// `Chain::blocks` is `Vec<Arc<Block>>`; as `Vec<Block>` each snapshot
    /// would have pinned ~954 MB of block bodies.
    snaps: VecDeque<Arc<Chain>>,
}

struct PeerHandle {
    sender: Sender<Message>,
    /// The peer's listening address, once learned from its Version — stored as
    /// the peer's real source IP plus the port it advertises.
    listen: Option<String>,
    /// The peer's source IP (from the TCP connection). Authoritative: a peer
    /// can't lie about the address it's connecting from, so we reconstruct its
    /// dialable address from this + the advertised port rather than trusting
    /// the advertised host (which is typically a 0.0.0.0 bind).
    src: Option<std::net::IpAddr>,
}

/// Outcome of a bounded (snapshot-based) reorg attempt. The three cases are
/// deliberately distinct: a bad FORK is a verdict a from-genesis rebuild would
/// also reach, whereas bad BOOKKEEPING on our side says nothing about the fork
/// and must fall through to the reference implementation.
enum Replay {
    Ok(Chain),
    /// The peer's blocks do not validate. Final.
    ForkInvalid,
    /// A structural check on our own snapshot bookkeeping failed. Retry via
    /// `Chain::from_blocks`.
    Degrade,
}

/// An in-flight headers-first download from one peer.
struct SyncState {
    start_height: u64,
    hashes: Vec<Hash32>,
}

pub struct Node {
    pub(crate) config: NodeConfig,
    state: Mutex<SharedState>,
    peers: Mutex<HashMap<u64, PeerHandle>>,
    syncs: Mutex<HashMap<u64, SyncState>>,
    known_addrs: Mutex<HashSet<String>>,
    /// Resolved socket addresses of live/in-flight outbound dials — the
    /// dedupe that string comparison (hostname vs IP) cannot provide.
    outbound_targets: Mutex<HashSet<std::net::SocketAddr>>,
    /// addr -> (consecutive dial failures, earliest next retry). Without this a
    /// dead/unreachable gossiped peer is re-dialed every autoconnect cycle,
    /// spamming "could not connect" and churning. Backoff spaces retries and
    /// `MAX_DIAL_FAILS` evicts the address from the known set entirely.
    dial_backoff: Mutex<HashMap<String, (u32, Instant)>>,
    /// Sticky bootstrap addresses (built-in DEFAULT_SEEDS + operator `--connect`)
    /// that are kept in the known set forever and retried with a capped backoff,
    /// never evicted — so a transient main-node outage can't orphan a node.
    seeds: HashSet<String>,
    next_peer_id: AtomicU64,
    /// Bumped on every tip change; miners poll it to abandon stale work.
    pub(crate) tip_version: AtomicU64,
    /// Forks already fully validated and found NOT heavier: (fork start height,
    /// hash of the last block we fetched for it).
    ///
    /// SOUND AND PERMANENT, not a cache with a staleness problem: our
    /// `total_work` only ever increases (both adoption sites either extend the
    /// tip or require a strictly heavier candidate), so a fork that lost once
    /// can never win later with the same tip. A peer that EXTENDS that fork
    /// announces a different last hash and is re-evaluated from scratch.
    ///
    /// Only work-gate rejections are recorded here. Validation failures are
    /// deliberately NOT, because one of `connect_block`'s checks — the
    /// `header.time > now + max_future_drift` drift limit — loosens as the
    /// clock advances, so a block that is invalid now can be valid in a minute.
    rejected_forks: Mutex<(HashSet<(u64, Hash32)>, VecDeque<(u64, Hash32)>)>,
    /// How many forks were seen at each depth, bucketed by power of two. Pure
    /// instrumentation: `SNAP_INTERVAL`/`SNAP_RING` were chosen from a single
    /// 6-hour observation window, and this is how that guess gets replaced by
    /// measurement. Also the alarm that the snapshot horizon is too short —
    /// `deep` counts the forks that had to fall back to a from-genesis rebuild.
    fork_depths: Mutex<(HashMap<u32, u64>, u64)>,
    /// Total `connect_block` calls ever made while building a reorg candidate.
    ///
    /// THIS IS THE REGRESSION ALARM FOR THE ORIGINAL BUG, and it is a counter
    /// rather than a timer on purpose. The defect was never "reorgs are slow";
    /// it was "a reorg re-validates the whole chain from genesis, so its cost
    /// is a function of HEIGHT rather than of fork depth". That is an exact,
    /// countable property, so `tests/reorg.rs` asserts it exactly: for a fixed
    /// fork depth, this counter must not grow as the chain gets taller. A
    /// wall-clock assertion would have to be loose enough to pass on a loaded
    /// CI box, and a from-genesis rebuild at the heights a test can reach is
    /// only milliseconds — the original bug would have sailed through a timing
    /// test at test scale and only bitten at height 58,000.
    reorg_blocks_connected: AtomicU64,
}

impl Node {
    pub fn new(config: NodeConfig, chain: Chain, mempool: Vec<Transaction>) -> Arc<Self> {
        Self::new_with_prefixes(config, chain, mempool, vec![])
    }

    /// [`Node::new`], seeded with validated prefix states for the reorg ring.
    ///
    /// THE STARTUP HALF OF THE BOUNDED-REORG FIX. `Node::new` cannot build
    /// these itself: a prefix state is destroyed by connecting past it, so
    /// recovering height-32's state from the tip would mean a second
    /// from-genesis replay — doubling a startup that already takes ~15 minutes
    /// at this height. Instead `storage::load_chain_with_prefixes` captures
    /// them during the replay it was going to do anyway, and hands them here.
    ///
    /// Without this, a node that starts up already at the tip has an empty
    /// ring and takes the from-genesis rebuild for even a depth-1 fork — 17
    /// minutes at height 82,000, retried every 10 seconds. Both the pool node
    /// and the exchange node start that way, and so does every wallet: it is
    /// the reported "stuck at 57999, and reinstalling did not help", because
    /// reinstalling keeps the datadir and the restart lands in the same hole.
    pub fn new_with_prefixes(
        config: NodeConfig,
        chain: Chain,
        mempool: Vec<Transaction>,
        prefixes: Vec<Arc<Chain>>,
    ) -> Arc<Self> {
        // Seeds = operator --connect peers + the built-in defaults, minus our
        // own listen address (a node must not seed to itself). These are sticky.
        let mut seeds: HashSet<String> = config.connect.iter().cloned().collect();
        for s in DEFAULT_SEEDS {
            seeds.insert((*s).to_string());
        }
        seeds.remove(&config.listen);
        let known: HashSet<String> = seeds.clone();
        Arc::new(Node {
            config,
            state: Mutex::new(SharedState {
                chain: Arc::new(chain),
                mempool,
                // Oldest first, as `record_snapshot` maintains it; anything
                // beyond the ring bound is dropped rather than trusted.
                snaps: {
                    let mut q: VecDeque<Arc<Chain>> = prefixes.into_iter().collect();
                    while q.len() > SNAP_RING {
                        q.pop_front();
                    }
                    q
                },
            }),
            peers: Mutex::new(HashMap::new()),
            syncs: Mutex::new(HashMap::new()),
            known_addrs: Mutex::new(known),
            outbound_targets: Mutex::new(HashSet::new()),
            dial_backoff: Mutex::new(HashMap::new()),
            seeds,
            next_peer_id: AtomicU64::new(1),
            tip_version: AtomicU64::new(0),
            rejected_forks: Mutex::new((HashSet::new(), VecDeque::new())),
            fork_depths: Mutex::new((HashMap::new(), 0)),
            reorg_blocks_connected: AtomicU64::new(0),
        })
    }

    pub fn peer_count(&self) -> usize {
        self.peers.lock().unwrap().len()
    }

    /// Connected peers: (id, dialable listen address, source ip).
    pub fn peer_list(&self) -> Vec<(u64, Option<String>, Option<String>)> {
        let mut v: Vec<_> = self
            .peers
            .lock()
            .unwrap()
            .iter()
            .map(|(id, p)| (*id, p.listen.clone(), p.src.map(|ip| ip.to_string())))
            .collect();
        v.sort_by_key(|(id, _, _)| *id);
        v
    }

    /// Number of distinct dialable peer addresses this node has learned.
    pub fn known_addr_count(&self) -> usize {
        self.known_addrs.lock().unwrap().len()
    }

    pub fn tip_generation(&self) -> u64 {
        self.tip_version.load(Ordering::SeqCst)
    }

    pub fn params(&self) -> &ChainParams {
        &self.config.params
    }

    /// Snapshot (chain, mempool) for template building.
    /// A consistent, immutable view of the chain plus the current mempool.
    ///
    /// O(1) in the chain: the Arc is cloned, not the chain. Callers keep using
    /// it as a `Chain` through `Deref`. See `SharedState::chain`.
    pub fn snapshot(&self) -> (Arc<Chain>, Vec<Transaction>) {
        let st = self.state.lock().unwrap();
        (Arc::clone(&st.chain), st.mempool.clone())
    }

    /// Build an unsolved block template for external miners.
    /// Template whose coinbase is split among `recipients` by basis points
    /// (pool use: miner + fee outputs).
    pub fn block_template_split(&self, recipients: &[(Address, u32)]) -> Result<Block> {
        let (chain, mempool) = self.snapshot();
        if chain.blocks.is_empty() && !self.config.connect.is_empty() {
            return Err(anyhow!("chain not yet synced"));
        }
        let (block, _) = blockle_chain::build_template_split(&chain, recipients, &mempool)?;
        Ok(block)
    }

    pub fn block_template(&self) -> Result<Block> {
        let reward = self
            .config
            .mine_to
            .ok_or_else(|| anyhow!("no reward address configured"))?;
        let (chain, mempool) = self.snapshot();
        if chain.blocks.is_empty() && !self.config.connect.is_empty() {
            return Err(anyhow!("chain not yet synced"));
        }
        let (block, _) = build_template(&chain, reward, &mempool)?;
        Ok(block)
    }

    /// Run the node: listener, outbound connections, miner, stratum,
    /// heartbeat. Blocks forever.
    pub fn run(self: &Arc<Self>) -> Result<()> {
        let listener = TcpListener::bind(&self.config.listen)
            .map_err(|e| anyhow!("cannot listen on {}: {e}", self.config.listen))?;
        println!("[p2p] listening on {}", self.config.listen);

        {
            let node = self.clone();
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let node = node.clone();
                    thread::spawn(move || node.handle_peer(stream));
                }
            });
        }

        for addr in self.config.connect.clone() {
            self.dial(addr);
        }

        if self.config.local_mine {
            if let Some(address) = self.config.mine_to {
                let node = self.clone();
                thread::spawn(move || node.mining_loop(address));
            }
        }

        for (addr, opts) in self.config.pools.clone() {
            crate::stratum::serve(self.clone(), addr, opts);
        }

        // Heartbeat + discovery loop.
        loop {
            thread::sleep(HEARTBEAT);
            self.broadcast(Message::GetTip, None);
            self.broadcast(Message::GetAddr, None);
            self.autoconnect();
        }
    }

    fn listen_port_of(listen: &str) -> u16 {
        listen.rsplit(':').next().and_then(|p| p.parse().ok()).unwrap_or(0)
    }

    /// Addresses that must never be gossiped or auto-dialed: wildcard
    /// binds and loopback (a gossiped 127.0.0.1 is someone else's
    /// loopback — dialing it connects a node to itself).
    fn is_unroutable(addr: &str) -> bool {
        addr.starts_with("0.0.0.0")
            || addr.starts_with("[::]")
            || addr.starts_with("127.")
            || addr.starts_with("localhost")
    }

    fn dial(self: &Arc<Self>, addr: String) {
        use std::net::ToSocketAddrs;
        let Some(resolved) = addr.to_socket_addrs().ok().and_then(|mut i| i.next()) else {
            println!("[p2p] cannot resolve {addr}");
            return;
        };
        // One outbound connection per resolved endpoint, however it's
        // spelled (blockle.org:18444 == 144.126.133.21:18444).
        // Self-detection without a wire change: ask the OS which local
        // address would route to the target — if that's the target's own
        // IP and the port is our listen port, the "peer" is this node.
        if resolved.port() == Self::listen_port_of(&self.config.listen) {
            if let Ok(probe) = std::net::UdpSocket::bind("0.0.0.0:0") {
                if probe.connect(resolved).is_ok() {
                    if let Ok(local) = probe.local_addr() {
                        if local.ip() == resolved.ip() {
                            return; // that's us — never dial ourselves
                        }
                    }
                }
            }
        }
        if !self.outbound_targets.lock().unwrap().insert(resolved) {
            return;
        }
        println!("[p2p] dialing {addr}");
        let node = self.clone();
        thread::spawn(move || {
            match TcpStream::connect(resolved) {
                Ok(stream) => {
                    node.dial_backoff.lock().unwrap().remove(&addr);
                    node.clone().handle_peer(stream);
                }
                Err(e) => {
                    let mut bo = node.dial_backoff.lock().unwrap();
                    let entry = bo.entry(addr.clone()).or_insert((0, Instant::now()));
                    entry.0 += 1;
                    // Exponential backoff 15s, 30s, 60s, … capped at 5 min.
                    let secs = 15u64.saturating_mul(1u64 << (entry.0.min(5) - 1)).min(300);
                    entry.1 = Instant::now() + Duration::from_secs(secs);
                    // Log only the first failure of a streak — no per-cycle spam.
                    if entry.0 == 1 {
                        println!("[p2p] could not connect to {addr}: {e}");
                    }
                }
            }
            node.outbound_targets.lock().unwrap().remove(&resolved);
        });
    }

    /// Dial known addresses until the outbound target is met.
    fn autoconnect(self: &Arc<Self>) {
        let connected: HashSet<String> = {
            let peers = self.peers.lock().unwrap();
            peers.values().filter_map(|p| p.listen.clone()).collect()
        };
        let peer_count = self.peers.lock().unwrap().len();
        if peer_count >= OUTBOUND_TARGET {
            return;
        }
        let now = Instant::now();
        let candidates: Vec<String> = {
            let mut known = self.known_addrs.lock().unwrap();
            let mut backoff = self.dial_backoff.lock().unwrap();
            // Evict LEARNED addresses that have failed too many times — stop
            // retrying a gossiped peer that is gone for good. SEEDS are exempt:
            // they stay known forever (retried on the capped backoff) so the
            // main node coming back after an outage always re-peers us.
            let dead: Vec<String> = backoff
                .iter()
                .filter(|(a, (c, _))| *c >= MAX_DIAL_FAILS && !self.seeds.contains(*a))
                .map(|(a, _)| a.clone())
                .collect();
            for a in &dead {
                known.remove(a);
                backoff.remove(a);
            }
            known
                .iter()
                .filter(|a| {
                    !connected.contains(*a)
                        && **a != self.config.listen
                        && !Self::is_unroutable(a)
                        // Respect the backoff window of a recently-failed addr.
                        && backoff.get(*a).map_or(true, |(_, next)| now >= *next)
                })
                .take(OUTBOUND_TARGET - peer_count)
                .cloned()
                .collect()
        };
        for addr in candidates {
            self.dial(addr);
        }
    }

    fn status(&self) -> (Option<u64>, [u8; 32], Hash32) {
        let st = self.state.lock().unwrap();
        (st.chain.height(), work_bytes(st.chain.total_work()), st.chain.tip_hash())
    }

    fn version_message(&self) -> Message {
        let (height, total_work, tip) = self.status();
        Message::Version {
            network: self.config.params.name.clone(),
            protocol: PROTOCOL_VERSION,
            height,
            total_work,
            tip,
            listen: Some(self.config.listen.clone()),
        }
    }

    /// Exponentially spaced tip-first block locator.
    fn locator(&self) -> Vec<Hash32> {
        let st = self.state.lock().unwrap();
        let blocks = &st.chain.blocks;
        let mut out = Vec::new();
        if blocks.is_empty() {
            return out;
        }
        let mut idx = blocks.len() as i64 - 1;
        let mut step = 1i64;
        while idx >= 0 {
            out.push(blocks[idx as usize].header.hash());
            if out.len() >= 10 {
                step *= 2;
            }
            idx -= step;
        }
        if out.last() != Some(&blocks[0].header.hash()) {
            out.push(blocks[0].header.hash());
        }
        out
    }

    fn broadcast(&self, msg: Message, except: Option<u64>) {
        let peers = self.peers.lock().unwrap();
        for (id, peer) in peers.iter() {
            if Some(*id) != except {
                let _ = peer.sender.send(msg.clone());
            }
        }
    }

    fn send_to(&self, peer_id: u64, msg: Message) {
        if let Some(peer) = self.peers.lock().unwrap().get(&peer_id) {
            let _ = peer.sender.send(msg);
        }
    }

    /// Per-peer connection loop: register, handshake, dispatch messages.
    fn handle_peer(self: Arc<Self>, stream: TcpStream) {
        let label = stream
            .peer_addr()
            .map(|a| a.to_string())
            .unwrap_or_else(|_| "?".into());
        let peer_id = self.next_peer_id.fetch_add(1, Ordering::SeqCst);

        let mut write_half = match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        };
        let src_ip = stream.peer_addr().ok().map(|a| a.ip());
        let (tx, rx) = channel::<Message>();
        self.peers
            .lock()
            .unwrap()
            .insert(peer_id, PeerHandle { sender: tx, listen: None, src: src_ip });
        println!("[p2p] peer {peer_id} connected ({label})");

        let writer = thread::spawn(move || {
            for msg in rx {
                if write_message(&mut write_half, &msg).is_err() {
                    break;
                }
            }
            let _ = write_half.shutdown(std::net::Shutdown::Both);
        });

        self.send_to(peer_id, self.version_message());

        let mut read_half = stream;
        loop {
            match read_message(&mut read_half) {
                Ok(msg) => {
                    if let Err(e) = self.dispatch(peer_id, msg) {
                        println!("[p2p] peer {peer_id} error: {e}");
                        break;
                    }
                }
                Err(_) => break,
            }
        }

        self.peers.lock().unwrap().remove(&peer_id);
        self.syncs.lock().unwrap().remove(&peer_id);
        println!("[p2p] peer {peer_id} disconnected ({label})");
        let _ = writer.join();
    }

    fn dispatch(&self, peer_id: u64, msg: Message) -> Result<()> {
        match msg {
            Message::Version { network, protocol, total_work, listen, .. } => {
                if network != self.config.params.name {
                    return Err(anyhow!("wrong network {network:?}"));
                }
                if protocol != PROTOCOL_VERSION {
                    return Err(anyhow!("unsupported protocol {protocol}"));
                }
                if let Some(addr) = listen {
                    // Peers bind and advertise 0.0.0.0, which is unroutable and
                    // would never be gossiped — leaving the network a star around
                    // the seed. Reconstruct a dialable address from the peer's
                    // real source IP plus the port it advertises, so every
                    // reachable node's address propagates through GetAddr/Addr.
                    let port = addr
                        .parse::<std::net::SocketAddr>()
                        .map(|s| s.port())
                        .ok()
                        .or_else(|| addr.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()));
                    let dialable = {
                        let mut peers = self.peers.lock().unwrap();
                        let src = peers.get(&peer_id).and_then(|p| p.src);
                        let d = match (src, port) {
                            (Some(ip), Some(p)) => std::net::SocketAddr::new(ip, p).to_string(),
                            _ => addr.clone(),
                        };
                        if let Some(peer) = peers.get_mut(&peer_id) {
                            peer.listen = Some(d.clone());
                        }
                        d
                    };
                    if !Self::is_unroutable(&dialable) {
                        self.known_addrs.lock().unwrap().insert(dialable);
                    }
                }
                self.maybe_sync(peer_id, &total_work);
            }
            Message::GetTip => {
                let (height, total_work, tip) = self.status();
                self.send_to(peer_id, Message::Tip { height, total_work, tip });
            }
            Message::Tip { total_work, .. } => self.maybe_sync(peer_id, &total_work),
            Message::GetHeaders { locator } => self.serve_headers(peer_id, &locator),
            Message::Headers { start_height, headers } => {
                self.handle_headers(peer_id, start_height, headers)
            }
            Message::GetBlocks { hashes } => self.serve_blocks(peer_id, &hashes),
            Message::Blocks { blocks } => self.handle_blocks(peer_id, blocks),
            Message::NewBlock { block } => {
                self.submit_block(block, Some(peer_id));
            }
            Message::NewTx { tx } => {
                self.submit_tx(tx, Some(peer_id));
            }
            Message::GetAddr => {
                let addrs: Vec<String> = self
                    .known_addrs
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|a| !Self::is_unroutable(a))
                    .take(100)
                    .cloned()
                    .collect();
                self.send_to(peer_id, Message::Addr { addrs });
            }
            Message::Addr { addrs } => {
                let mut known = self.known_addrs.lock().unwrap();
                for a in addrs.into_iter().take(100) {
                    if !Self::is_unroutable(&a) {
                        known.insert(a);
                    }
                }
            }
            Message::Ping => self.send_to(peer_id, Message::Pong),
            Message::Pong => {}
        }
        Ok(())
    }

    /// Start a headers-first sync when the peer claims more work.
    fn maybe_sync(&self, peer_id: u64, their_work: &[u8; 32]) {
        let ours = work_bytes(self.state.lock().unwrap().chain.total_work());
        if their_work > &ours {
            self.send_to(peer_id, Message::GetHeaders { locator: self.locator() });
        }
    }

    /// Answer GetHeaders: find the fork point from the locator and send
    /// headers from there.
    fn serve_headers(&self, peer_id: u64, locator: &[Hash32]) {
        let st = self.state.lock().unwrap();
        let hashes: Vec<Hash32> = st.chain.blocks.iter().map(|b| b.header.hash()).collect();
        let mut start = 0usize;
        for lh in locator {
            if let Some(i) = hashes.iter().position(|h| h == lh) {
                start = i + 1;
                break;
            }
        }
        let headers: Vec<BlockHeader> = st.chain.blocks[start..]
            .iter()
            .take(MAX_HEADERS_PER_MSG)
            .map(|b| b.header.clone())
            .collect();
        drop(st);
        self.send_to(peer_id, Message::Headers { start_height: start as u64, headers });
    }

    /// Validate announced headers (linkage + standalone PoW); if they imply a
    /// heavier chain, request the corresponding blocks.
    fn handle_headers(&self, peer_id: u64, start_height: u64, headers: Vec<BlockHeader>) {
        if headers.is_empty() || headers.len() > MAX_HEADERS_PER_MSG {
            return;
        }
        let params = &self.config.params;
        // Standalone PoW check per header before spending bandwidth on
        // bodies — but ONLY for native-solution headers. Merged-mined
        // (AuxPoW) blocks carry an empty solution and zero nonce; their
        // proof is in the block body, so they can only be verified once
        // the body arrives (connect_block does the full AuxPoW check).
        // Checking the native solution here would reject every merged
        // block's header and stall the sync.
        for h in &headers {
            let is_merged = h.solution.is_empty() && h.nonce == [0u8; 32];
            if is_merged {
                continue;
            }
            let Ok(indices) = equihash::unpack_solution(&params.equihash, &h.solution) else {
                return;
            };
            if equihash::verify(&params.equihash, &h.equihash_input(), &h.nonce, &indices).is_err()
            {
                return;
            }
            if !hash_meets_target(&h.hash(), h.bits, params.pow_limit) {
                return;
            }
        }
        // Linkage within the batch.
        for w in headers.windows(2) {
            if w[1].prev_hash != w[0].hash() {
                return;
            }
        }
        let st = self.state.lock().unwrap();
        let start = start_height as usize;
        if start > st.chain.blocks.len() {
            return;
        }
        // The first header must attach to our chain at start_height.
        let expected_prev = if start == 0 {
            [0u8; 32]
        } else {
            st.chain.blocks[start - 1].header.hash()
        };
        if headers[0].prev_hash != expected_prev {
            // Deeper fork than the locator resolved — rare with exponential
            // locators; ignore and let the next heartbeat retry.
            return;
        }
        // THE FETCH GATE IS A ONE-SIDED BOUND, NOT A FORK-CHOICE DECISION.
        //
        // THE BUG THIS REPLACES, because it is the most serious one this file
        // has had: these three lines used to be
        //
        //     let retained_work = blocks[..start].fold(+ block_work(bits));
        //     let new_work      = headers.fold(+ block_work(bits));
        //     if retained_work + new_work <= st.chain.total_work() { return; }
        //
        // — raw `block_work` on the left, ENERGY-WEIGHTED `total_work()` on the
        // right. Those are the same number only below
        // `cross_algo_activation_height` (53,000). Above it they drift apart,
        // and measured on the real mainnet chain our own weighted total
        // overtook the raw sum by 9.8e16 around height 57,000 — more than the
        // ~4.9e16 of raw work a full 2000-block batch contributes. From that
        // point on EVERY announced batch scored as lighter, and this gate took
        // a bare `return`: no log, no `GetBlocks`, no error. A fresh wallet
        // synced to a fixed height and then sat there reporting "stuck
        // updating" forever, and reinstalling did not help because the blocks
        // that cause it are immutable. Reproduced from genesis on real blocks:
        // a stall at height 57999, which is the height a Windows user
        // reported. Seeded at the exchange node's observed start height 53371
        // it reproduces that node's two adoptions and then stalls at 57370 —
        // its exact stranded height. The stall height is only a function of
        // where the 2000-block batch boundary falls, which is why two nodes
        // stalled at two different heights with one signature.
        //
        // The same mismatch ran the other way too: raw overstated weighted by
        // 0.24% over the whole chain, worth ~200 blocks of free head start, so
        // the live pool node fetched ~363 phantom forks in 6 hours and threw
        // every one away after a from-genesis rebuild.
        //
        // WHY NOT JUST WEIGHT THE HEADERS. Because it is not possible:
        // `BlockHeader` carries no lane, `Chain::lane_of` reads
        // `block.aux_pow.parent_algo` out of the block BODY, and merged-mined
        // headers are indistinguishable from one another. So the weighted
        // comparison can only be made once the bodies are in hand, which is
        // where it now exclusively lives (`adopt_candidate`). Here we only ask
        // the much weaker question "could this possibly be heavier?", using the
        // exact weighted work of the prefix we would retain (O(1) via
        // `work_upto`) plus the most generous weight any lane could give the
        // announced headers. Overestimating costs a cheap fetch; underestimating
        // is the stall, so the bound only ever errs high.
        let retained_work = st.chain.work_upto(start);
        let best_case_new = headers.iter().enumerate().fold(U256::zero(), |acc, (i, h)| {
            acc.saturating_add(st.chain.header_work_upper_bound((start + i) as u64, h.bits))
        });
        if retained_work.saturating_add(best_case_new) <= st.chain.total_work() {
            // Now logged. The silent version of this return is what made the
            // stall undiagnosable from a node's own output.
            println!(
                "[p2p] peer {peer_id} announced {} headers from height {start_height} that cannot \
                 outweigh our chain even at the most favourable weighting; not fetching",
                headers.len()
            );
            return;
        }
        // Already ours. The locator resolves to the fork point, so a peer on
        // our own chain re-announces blocks we already hold; fetching and
        // re-validating them is pure waste.
        let announced_end = start + headers.len();
        if announced_end <= st.chain.blocks.len()
            && st.chain.blocks[announced_end - 1].header.hash()
                == headers[headers.len() - 1].hash()
        {
            return;
        }
        drop(st);

        let hashes: Vec<Hash32> = headers
            .iter()
            .take(MAX_BLOCKS_PER_REQUEST)
            .map(|h| h.hash())
            .collect();
        // Already weighed and found wanting. Without this the live node
        // re-fetched and re-validated the same losing fork every heartbeat,
        // forever — 418 announcements producing 7 adoptions in one 6-hour
        // window, each rejection preceded by a full chain rebuild.
        let fork_key = (start_height, *hashes.last().expect("headers is non-empty"));
        if self.rejected_forks.lock().unwrap().0.contains(&fork_key) {
            return;
        }
        println!(
            "[p2p] peer {peer_id} may have a heavier chain ({} new headers from height {start_height}); fetching blocks",
            hashes.len()
        );
        self.syncs
            .lock()
            .unwrap()
            .insert(peer_id, SyncState { start_height, hashes: hashes.clone() });
        self.send_to(peer_id, Message::GetBlocks { hashes });
    }

    fn serve_blocks(&self, peer_id: u64, hashes: &[Hash32]) {
        // Answer in request order with a SINGLE pass over the chain. The old code
        // did `blocks.iter().find()` per requested hash — O(height × batch) header
        // re-hashes while holding the state lock, which took MINUTES at high
        // heights, so the requesting peer timed out and the blocks "never arrived"
        // (deep-sync stall past the early blocks). Map requested hash -> position,
        // then scan once (O(n)) placing each match.
        let want: std::collections::HashMap<Hash32, usize> = hashes
            .iter()
            .take(MAX_BLOCKS_PER_REQUEST)
            .enumerate()
            .map(|(i, h)| (*h, i))
            .collect();
        let mut found: Vec<Option<Block>> = vec![None; want.len()];
        {
            let st = self.state.lock().unwrap();
            for b in &st.chain.blocks {
                if let Some(&i) = want.get(&b.header.hash()) {
                    found[i] = Some((**b).clone());
                }
            }
        }
        let blocks: Vec<Block> = found.into_iter().flatten().collect();
        self.send_to(peer_id, Message::Blocks { blocks });
    }

    /// Complete a headers-first sync: reassemble, fully validate, adopt if
    /// heavier.
    fn handle_blocks(&self, peer_id: u64, blocks: Vec<Block>) {
        let Some(sync) = self.syncs.lock().unwrap().remove(&peer_id) else {
            return;
        };
        if blocks.len() != sync.hashes.len()
            || blocks
                .iter()
                .zip(&sync.hashes)
                .any(|(b, h)| &b.header.hash() != h)
        {
            println!("[p2p] peer {peer_id} sent mismatched blocks");
            return;
        }
        let start = sync.start_height as usize;
        let mut st = self.state.lock().unwrap();
        // FAST PATH — the batch extends our current tip. Connect each new block
        // incrementally (O(batch)) and append it (O(1)). The old code rebuilt and
        // RE-VALIDATED THE ENTIRE CHAIN FROM GENESIS every batch (Chain::from_blocks
        // over prefix+batch) and rewrote the whole block file (save_chain) — O(n)
        // per batch, O(n²) for a full sync. Deep syncs slowed to a crawl and stalled
        // (the serving peer timed out mid-batch), stranding nodes partway. from_blocks
        // is just connect_block in a loop from genesis, so connecting only the new
        // blocks onto the existing validated chain is byte-for-byte identical.
        if start == st.chain.blocks.len() {
            let old_height = st.chain.height();
            for b in blocks {
                if let Err(e) = Arc::make_mut(&mut st.chain).connect_block(b.clone()) {
                    println!("[p2p] peer {peer_id} block failed validation during sync: {e}");
                    break; // keep what connected; the next heartbeat fetches the rest
                }
                let _ = storage::append_block(&self.config.datadir, &b);
                // Snapshot INSIDE the loop, not once per batch: batches are up
                // to 2000 blocks, so snapshotting per batch would leave gaps of
                // 2000 and a "bounded" reorg would still replay 2000 blocks.
                // `Arc::make_mut` is therefore re-taken each iteration — it
                // copies only when a snapshot (or a reader) holds the Arc, i.e.
                // once every SNAP_INTERVAL blocks, and copies only the state
                // maps now that block bodies are behind `Arc<Block>`.
                Self::record_snapshot(&mut st);
            }
            self.prune_mempool(&mut st);
            self.tip_version.fetch_add(1, Ordering::SeqCst);
            let (height, total_work, tip) =
                (st.chain.height(), work_bytes(st.chain.total_work()), st.chain.tip_hash());
            println!(
                "[chain] adopted heavier chain from peer {peer_id}: height {old_height:?} → {height:?}, tip {}",
                display_hash(&tip)
            );
            drop(st);
            self.broadcast(Message::Tip { height, total_work, tip }, None);
            return;
        }
        drop(st);

        // REORG PATH (start < tip) — a fork rooted below our tip.
        //
        // THIS PATH USED TO SAY "Rare" AND THAT COMMENT WAS THE BUG. It did:
        //
        //     let prefix: Vec<Block> = st.chain.blocks[..start].to_vec();
        //     candidate_blocks = prefix ++ blocks;
        //     Chain::from_blocks(params, candidate_blocks)
        //
        // `from_blocks` is `connect_block` in a loop FROM GENESIS, so at height
        // 58,000 that was 58,000 blocks of PoW and state re-validation per
        // batch, plus a deep copy of every block body (954 MB at height
        // 82,000) taken while holding the state lock. Measured on real mainnet
        // blocks: 30.5 s per attempt at height 58,000 — as much as the entire
        // from-genesis sync up to that height — and 16 min 59 s at 82,386. The
        // heartbeat retries every 10 s, so a 17-minute unit of work was
        // obsolete long before it finished. That is the "100% of one core, no
        // progress" signature, and it was measured at ~5.5 cores of burn.
        //
        // AND IT IS NOT RARE. The headers message starts at the FORK POINT, so
        // a peer whose chain diverges even ONE block below our tip lands here —
        // the stranded exchange node's own log shows start_height 53371 against
        // tip 53372. Ten merge-mined lanes with per-block retargeting produce
        // shallow forks constantly: heights 57999/58000/58001 are all x11
        // within two seconds of each other. In one 6-hour window the live pool
        // node took this path 418 times (and 369 times in another), adopting 7.
        // "Rare" was wrong by about 60 entries per hour.
        //
        // WHAT IT DOES NOW: replay forward from a retained, already-validated
        // prefix snapshot instead of from genesis. Same `connect_block` calls
        // on the same blocks in the same order, so the result is the same value
        // `from_blocks` would have produced — see `pick_reorg_base` for the
        // argument and the two O(1) structural checks that enforce it. Forks
        // deeper than the snapshot horizon still take the from-genesis path;
        // nothing is rejected for being deep.
        let depth = {
            let st = self.state.lock().unwrap();
            st.chain.blocks.len().saturating_sub(start)
        };
        self.record_fork_depth(depth);

        let (candidate, bounded) = match self.build_reorg_candidate(peer_id, start, &blocks) {
            Some(v) => v,
            None => return,
        };
        self.adopt_candidate(peer_id, candidate, start, bounded);
    }

    /// Build the fork's candidate chain, bounded if we hold a usable snapshot
    /// and from genesis otherwise. Returns `(candidate, took_the_bounded_path)`.
    ///
    /// ALL HEAVY VALIDATION HAPPENS HERE, OUTSIDE THE STATE LOCK, and on a
    /// `Chain` value that is never aliased to the live one — so a candidate
    /// that fails leaves the node's chain untouched by construction rather than
    /// by cleanup. The lock is taken only for microsecond-long reads that copy
    /// block POINTERS.
    fn build_reorg_candidate(
        &self,
        peer_id: u64,
        start: usize,
        blocks: &[Block],
    ) -> Option<(Chain, bool)> {
        if !self.config.reorg_authority {
            if let Some((base, common, rejoin)) = self.pick_reorg_base(start) {
                match self.replay_candidate(peer_id, base, common, start, rejoin, blocks) {
                    Replay::Ok(c) => return Some((c, true)),
                    // The fork itself is invalid — a from-genesis rebuild would
                    // reach the same verdict, so do not pay for one.
                    Replay::ForkInvalid => return None,
                    // Our own bookkeeping did not check out. Fall through to
                    // the reference implementation rather than guess.
                    Replay::Degrade => {}
                }
            }
        }
        self.rebuild_candidate(peer_id, start, blocks).map(|c| (c, false))
    }

    /// Choose the highest retained snapshot that is a genuine prefix of our
    /// chain at or below `start`, plus the blocks between it and `start`.
    ///
    /// WHY A SNAPSHOT IS A SAFE PLACE TO START. `Chain` has no inverse: the only
    /// state transition is `connect_block`, there is no undo journal, and
    /// `UtxoEntry` keeps only the creating height, so a spent output's previous
    /// value is gone the moment it is overwritten. A reorg therefore cannot
    /// "roll back" to the fork point — the state there can only be REACHED
    /// FORWARD. Replaying from genesis reaches it; so does replaying from any
    /// earlier state this node already built with the same `connect_block`
    /// calls, which is what a snapshot is. Nothing is skipped and nothing is
    /// inverted: every fork block still goes through the full `connect_block`
    /// battery. That also disposes of the genuinely hard question a rollback
    /// would raise — `note_anchors` is a monotone set that is never pruned, so
    /// un-inserting an orphaned branch's anchor would be a CONSENSUS decision;
    /// a forward replay simply never contains it, exactly as a from-genesis
    /// rebuild would not.
    ///
    /// THE INVARIANT IS RE-PROVEN, NOT ASSUMED. A snapshot is only eligible if
    /// its tip hash still equals our chain's block at that height. A snapshot
    /// left over from an abandoned branch, or a `prune_snapshots` bug, fails
    /// this and is skipped — so the worst outcome of a bookkeeping error is the
    /// slow path, never a chain built on an orphan's state.
    fn pick_reorg_base(&self, start: usize) -> Option<(Arc<Chain>, Vec<Arc<Block>>, Hash32)> {
        // `start == 0` would mean replacing the chain including genesis; there
        // is no prefix to start from, so let the deep path handle it.
        if start == 0 {
            return None;
        }
        let st = self.state.lock().unwrap();
        if start > st.chain.blocks.len() {
            return None;
        }
        let base = st.snaps.iter().rev().find(|s| {
            let k = s.blocks.len();
            k >= 1
                && k <= start
                && s.tip_hash() == st.chain.blocks[k - 1].header.hash()
        })?;
        let k = base.blocks.len();
        Some((
            Arc::clone(base),
            // Pointer copies, not block copies: at most SNAP_INTERVAL of them.
            st.chain.blocks[k..start].to_vec(),
            st.chain.blocks[start - 1].header.hash(),
        ))
    }

    /// Bounded reorg: clone a snapshot, replay our own blocks up to the fork
    /// point, then replay the fork's blocks.
    fn replay_candidate(
        &self,
        peer_id: u64,
        base: Arc<Chain>,
        common: Vec<Arc<Block>>,
        start: usize,
        rejoin: Hash32,
        fork: &[Block],
    ) -> Replay {
        // Copies the state maps; block bodies are shared via `Arc<Block>`.
        let mut cand: Chain = (*base).clone();
        self.reorg_blocks_connected
            .fetch_add((common.len() + fork.len()) as u64, Ordering::Relaxed);
        for b in common {
            if cand.connect_block_arc(b).is_err() {
                // Our own chain failed to re-connect onto our own snapshot.
                // That can only be a bug here, so hand over to the reference
                // implementation rather than reason about it.
                return Replay::Degrade;
            }
        }
        // REJOIN PROOF. After replaying the common blocks the candidate must be
        // exactly our chain at `start` — same length, same tip. This is what
        // catches an off-by-one in the snapshot offsets, or the tip having
        // moved between `pick_reorg_base` and here. Together with the
        // prefix proof in `pick_reorg_base` it means the cheap path cannot
        // assemble a different block sequence than the deep path would have.
        if cand.blocks.len() != start || cand.tip_hash() != rejoin {
            return Replay::Degrade;
        }
        for b in fork {
            if let Err(e) = cand.connect_block(b.clone()) {
                println!(
                    "[p2p] peer {peer_id} fork from height {start} failed validation: {e}"
                );
                return Replay::ForkInvalid;
            }
        }
        if self.config.selfcheck_reorg {
            // CANARY. Also build the candidate the old way and compare every
            // byte of state. Costs a full from-genesis rebuild, so it is
            // opt-in — but it is how the bounded path earns the right to be
            // the silent default, and it is meant to run on the box for a week
            // before anyone trusts it.
            match self.rebuild_candidate(peer_id, start, fork) {
                Some(reference) => {
                    if reference.state_fingerprint() != cand.state_fingerprint() {
                        println!(
                            "[chain] SELFCHECK FAILED: bounded reorg at height {start} disagrees \
                             with a from-genesis rebuild — REFUSING the adoption. This is a bug; \
                             please report it with the node log."
                        );
                        return Replay::ForkInvalid;
                    }
                    println!("[chain] selfcheck ok: bounded reorg at height {start} matches from_blocks");
                }
                None => return Replay::Degrade,
            }
        }
        Replay::Ok(cand)
    }

    /// From-genesis rebuild: the original reorg path, kept deliberately. It is
    /// the fallback for forks deeper than the snapshot horizon, the escape
    /// hatch behind `--reorg-authority`, and the oracle `--selfcheck-reorg`
    /// compares against. Do not delete it in the name of having one path.
    fn rebuild_candidate(&self, peer_id: u64, start: usize, blocks: &[Block]) -> Option<Chain> {
        let mut candidate_blocks: Vec<Arc<Block>> = {
            let st = self.state.lock().unwrap();
            if start > st.chain.blocks.len() {
                return None;
            }
            self.note_deep_rebuild();
            // Pointer copies. This line used to be `blocks[..start].to_vec()`
            // on a `Vec<Block>` — a ~1 GB deep copy taken under the lock.
            st.chain.blocks[..start].to_vec()
        };
        candidate_blocks.extend(blocks.iter().cloned().map(Arc::new));
        let n = candidate_blocks.len();
        // Every block from genesis forward gets re-validated here. This is the
        // term that used to be the whole bug: it scales with HEIGHT, not with
        // fork depth.
        self.reorg_blocks_connected.fetch_add(n as u64, Ordering::Relaxed);
        match Chain::from_arc_blocks(self.config.params.clone(), candidate_blocks) {
            Ok(c) => Some(c),
            Err(e) => {
                println!("[p2p] peer {peer_id} chain of {n} blocks failed validation: {e}");
                None
            }
        }
    }

    /// The fork-choice decision, unchanged: adopt only if STRICTLY heavier by
    /// `Chain::total_work`, both sides energy-weighted by the same function.
    /// No depth, age or first-seen rule exists or should be added here.
    fn adopt_candidate(&self, peer_id: u64, candidate: Chain, start: usize, bounded: bool) {
        let cand_work = candidate.total_work();
        let mut st = self.state.lock().unwrap();
        if cand_work <= st.chain.total_work() {
            // Logged, where it used to be a bare `return`, and remembered so
            // the next heartbeat does not re-validate the identical fork.
            println!(
                "[chain] fork from peer {peer_id} at height {start} is not heavier \
                 ({} ≤ {}); keeping our chain",
                cand_work,
                st.chain.total_work()
            );
            let tip = candidate.tip_hash();
            drop(st);
            self.remember_rejected_fork(start as u64, tip);
            return;
        }
        let old_height = st.chain.height();
        // Captured for the disk write, which happens AFTER the in-memory swap
        // and OUTSIDE the lock.
        let tail: Vec<Arc<Block>> = candidate.blocks[start..].to_vec();
        let anchor = if start == 0 {
            [0u8; 32]
        } else {
            candidate.blocks[start - 1].header.hash()
        };
        st.chain = Arc::new(candidate);
        // Snapshots at or above the fork point describe the branch we just
        // abandoned. They would fail the prefix proof anyway, but leaving them
        // in would crowd out the ring with entries that can never be used.
        Self::prune_snapshots(&mut st, start);
        Self::record_snapshot(&mut st);
        // Shielded spends in the mempool that referenced an anchor only the
        // abandoned branch created now fail `check_transaction` with
        // `UnknownAnchor` and are evicted here. That was unreachable while a
        // reorg never completed; with reorgs routine it happens for real.
        self.prune_mempool(&mut st);
        self.tip_version.fetch_add(1, Ordering::SeqCst);
        let (height, total_work, tip) =
            (st.chain.height(), work_bytes(st.chain.total_work()), st.chain.tip_hash());
        println!(
            "[chain] adopted heavier chain from peer {peer_id}: height {old_height:?} → {height:?}, tip {} ({} reorg from height {start}, {} blocks)",
            display_hash(&tip),
            if bounded { "bounded" } else { "from-genesis" },
            tail.len()
        );
        drop(st);
        // Memory first, disk second — a crash in between leaves a valid but
        // lighter chain on disk, which re-syncs. Rewriting only the tail
        // replaces a 954 MB whole-file rewrite that ran under the lock.
        if let Err(e) = storage::rewrite_tail(&self.config.datadir, start, anchor, &tail) {
            println!("[storage] could not rewrite blocks.jsonl after the reorg: {e}");
        }
        self.broadcast(Message::Tip { height, total_work, tip }, None);
    }

    /// Retain the current chain as a replay base, every `SNAP_INTERVAL` blocks.
    ///
    /// O(1): an `Arc` clone. The copy it implies is deferred to the next
    /// `Arc::make_mut` on a block connect, and with `Vec<Arc<Block>>` that copy
    /// is the state maps rather than every block body.
    fn record_snapshot(st: &mut SharedState) {
        let len = st.chain.blocks.len();
        if len == 0 || (len as u64) % SNAP_INTERVAL != 0 {
            return;
        }
        if st.snaps.back().map(|s| s.blocks.len()) == Some(len) {
            return;
        }
        st.snaps.push_back(Arc::clone(&st.chain));
        while st.snaps.len() > SNAP_RING {
            st.snaps.pop_front();
        }
    }

    /// Drop snapshots that are no longer prefixes of our chain.
    fn prune_snapshots(st: &mut SharedState, fork_start: usize) {
        st.snaps.retain(|s| s.blocks.len() <= fork_start);
    }

    fn remember_rejected_fork(&self, start_height: u64, tip: Hash32) {
        let key = (start_height, tip);
        let mut g = self.rejected_forks.lock().unwrap();
        let (seen, order) = &mut *g;
        if seen.insert(key) {
            order.push_back(key);
            while order.len() > REJECTED_FORK_MEMORY {
                if let Some(old) = order.pop_front() {
                    seen.remove(&old);
                }
            }
        }
    }

    fn record_fork_depth(&self, depth: usize) {
        let bucket = 64 - (depth as u64).max(1).leading_zeros(); // ~log2 bucket
        self.fork_depths.lock().unwrap().0.entry(bucket).and_modify(|c| *c += 1).or_insert(1);
    }

    fn note_deep_rebuild(&self) {
        self.fork_depths.lock().unwrap().1 += 1;
    }

    /// Observed fork depths bucketed by power of two, plus the number of forks
    /// that exceeded the snapshot horizon and needed a from-genesis rebuild.
    /// Exposed so `SNAP_INTERVAL`/`SNAP_RING` can be set from data instead of
    /// from the single observation window they were guessed from.
    pub fn fork_depth_histogram(&self) -> (Vec<(u32, u64)>, u64) {
        let g = self.fork_depths.lock().unwrap();
        let mut v: Vec<(u32, u64)> = g.0.iter().map(|(k, c)| (*k, *c)).collect();
        v.sort_unstable();
        (v, g.1)
    }

    /// Number of retained reorg snapshots (diagnostics and tests).
    pub fn snapshot_count(&self) -> usize {
        self.state.lock().unwrap().snaps.len()
    }

    /// Cumulative `connect_block` calls made while building reorg candidates.
    /// See the field comment: this is the countable form of "the reorg path's
    /// cost must depend on fork depth, not on chain height".
    pub fn reorg_blocks_connected(&self) -> u64 {
        self.reorg_blocks_connected.load(Ordering::Relaxed)
    }

    /// TEST SEAM — register an in-flight sync exactly as [`Node::handle_headers`]
    /// does, then hand the blocks to the real [`Node::handle_blocks`].
    ///
    /// Deliberately a seam and not a reimplementation: the properties worth
    /// testing (which path is taken, the prefix and rejoin proofs, the
    /// strictly-heavier gate, that a failed candidate leaves the chain
    /// untouched) all live INSIDE `handle_blocks`, so a test that reimplemented
    /// its logic would be testing a copy and would have passed happily against
    /// the from-genesis version of this code. The only thing this skips is the
    /// socket.
    #[doc(hidden)]
    pub fn deliver_blocks_for_test(&self, peer_id: u64, start_height: u64, blocks: Vec<Block>) {
        let hashes: Vec<Hash32> = blocks.iter().map(|b| b.header.hash()).collect();
        self.syncs
            .lock()
            .unwrap()
            .insert(peer_id, SyncState { start_height, hashes });
        self.handle_blocks(peer_id, blocks);
    }

    /// Validate and connect a block claiming to extend our tip. Returns true
    /// if the tip advanced.
    pub fn submit_block(&self, block: Block, from: Option<u64>) -> bool {
        let hash = block.header.hash();
        let mut st = self.state.lock().unwrap();

        if st.chain.blocks.iter().any(|b| b.header.hash() == hash) {
            return false; // already have it
        }
        if block.header.prev_hash != st.chain.tip_hash() {
            // Fork or gap — resolve via headers-first sync.
            drop(st);
            if let Some(peer) = from {
                self.send_to(peer, Message::GetHeaders { locator: self.locator() });
            }
            return false;
        }
        match Arc::make_mut(&mut st.chain).connect_block(block.clone()) {
            Ok(()) => {
                let height = st.chain.height().unwrap();
                /*
                 * RECORD A REPLAY BASE HERE TOO, OR THE RING FREEZES.
                 *
                 * The bulk-sync path (`apply_headers_batch`) called this and
                 * this path did not, which made the whole bounded-reorg fix
                 * conditional on HOW a block arrived. A node that is caught up
                 * receives every block singly — gossip, the local miner, a
                 * stratum submission — so its ring stopped advancing at the
                 * last bulk sync, and the replay cost for a FIXED fork depth
                 * then grew with uptime instead of staying O(depth). After 300
                 * gossip blocks (50 hours of mainnet) a depth-1 fork was
                 * already replaying past the documented
                 * SNAP_INTERVAL × SNAP_RING horizon.
                 *
                 * Cheap by construction: `record_snapshot` returns immediately
                 * unless the height is a multiple of SNAP_INTERVAL, so this is
                 * a modulo on the common path and an `Arc` clone once every 32
                 * blocks. Covered by
                 * `a_node_that_grows_by_gossip_loses_the_snapshot_horizon`.
                 */
                Self::record_snapshot(&mut st);
                let _ = storage::append_block(&self.config.datadir, &block);
                self.prune_mempool(&mut st);
                self.tip_version.fetch_add(1, Ordering::SeqCst);
                println!(
                    "[chain] height {height} ({} txs) {}",
                    block.transactions.len(),
                    display_hash(&hash)
                );
                drop(st);
                self.broadcast(Message::NewBlock { block }, from);
                true
            }
            Err(e) => {
                println!("[chain] rejected block {}: {e}", display_hash(&hash));
                false
            }
        }
    }

    /// Validate a transaction against the current tip and queue + gossip it.
    pub fn submit_tx(&self, tx: Transaction, from: Option<u64>) -> bool {
        let mut st = self.state.lock().unwrap();
        let txid = tx.txid();
        if st.mempool.iter().any(|t| t.txid() == txid) {
            return false;
        }
        // Reject transactions too large to ever fit in a block (reserving room for the
        // coinbase + header) — otherwise they sit in the mempool forever, unminable.
        // Mempool policy only; block validity is separately bounded by max_block_size.
        // Size against the limit at the NEXT height (where this tx would be mined), so
        // the ceiling tracks the height-gated block-size bump.
        let next_height = st.chain.height().unwrap_or(0).saturating_add(1);
        let max_tx = st.chain.params.max_block_size_at(next_height).saturating_sub(4096);
        if tx.serialized_size() > max_tx {
            println!("[mempool] rejected tx {}: {} bytes exceeds the {}-byte limit", display_hash(&txid), tx.serialized_size(), max_tx);
            return false;
        }
        // A TRUE DOUBLE-SPEND is still refused: two transactions spending the
        // same outpoint cannot both stand, and whichever arrived first keeps
        // the claim.
        //
        // WHAT IS NO LONGER REFUSED is a transaction spending an output
        // another pending transaction CREATED. That was rejected outright —
        // the comment here used to say "no unconfirmed chaining in the
        // prototype mempool" — and it is why a wallet could only make one
        // payment per block: the second send spends the change from the first,
        // which has not confirmed yet.
        //
        // This is mempool policy, not consensus. Such a block was always
        // valid: build_template and connect_block both apply each
        // transaction's effects before validating the next, so a child after
        // its parent has always been accepted by every node on the network.
        let spent = blockle_chain::pending_spends(&st.mempool);
        if tx.inputs.iter().any(|i| spent.contains(&i.prev)) {
            println!(
                "[mempool] rejected tx {}: double-spends a pending input",
                display_hash(&txid)
            );
            return false;
        }
        // Same for shielded nullifiers.
        let pending_nullifiers: Vec<[u8; 32]> =
            st.mempool.iter().flat_map(|t| t.nullifiers()).collect();
        if tx.nullifiers().iter().any(|n| pending_nullifiers.contains(n)) {
            return false;
        }
        // Bounded depth, so a chain of unconfirmed spends cannot be used to
        // make admission and pruning arbitrarily expensive.
        let ancestors = blockle_chain::ancestor_count(&st.mempool, &tx);
        if ancestors >= blockle_chain::MAX_PENDING_CHAIN {
            println!(
                "[mempool] rejected tx {}: {} unconfirmed ancestors exceeds the limit of {}",
                display_hash(&txid), ancestors, blockle_chain::MAX_PENDING_CHAIN
            );
            return false;
        }
        let height = st.chain.blocks.len() as u64;
        // VALIDATED AGAINST THE MEMPOOL'S VIEW, not the confirmed set alone.
        // Against the confirmed set a child's input simply does not exist yet,
        // so the transaction is rejected as spending nothing.
        let view = blockle_chain::pending_view(&st.chain, &st.mempool);
        if let Err(e) = st.chain.check_transaction(&tx, &view, height) {
            println!("[mempool] rejected tx {}: {e}", display_hash(&txid));
            return false;
        }
        st.mempool.push(tx.clone());
        let _ = storage::save_mempool(&self.config.datadir, &st.mempool);
        println!("[mempool] accepted tx {} ({} pending)", display_hash(&txid), st.mempool.len());
        drop(st);
        self.broadcast(Message::NewTx { tx }, from);
        true
    }

    /// Drop mempool entries that no longer validate against the tip.
    ///
    /// WALKED IN DEPENDENCY ORDER against a view that grows as it goes, so a
    /// transaction spending another pending transaction's output survives.
    /// Checking each one against the confirmed set alone evicted every
    /// chained child on the next tick — which would have undone the
    /// admission fix within a second of it working.
    fn prune_mempool(&self, st: &mut SharedState) {
        let height = st.chain.blocks.len() as u64;
        let order = blockle_chain::topo_order(&st.mempool);
        let mut view = st.chain.utxos.clone();
        let mut keep: Vec<Transaction> = Vec::with_capacity(st.mempool.len());
        for i in order {
            let tx = st.mempool[i].clone();
            if st.chain.check_transaction(&tx, &view, height).is_err() {
                // Dropped, and its outputs never enter the view — so anything
                // that depended on it is dropped on this same pass rather
                // than lingering as an orphan.
                continue;
            }
            let txid = tx.txid();
            for inp in &tx.inputs {
                view.remove(&inp.prev);
            }
            for (vout, out) in tx.outputs.iter().enumerate() {
                view.insert(
                    blockle_core::OutPoint { txid, vout: vout as u32 },
                    blockle_chain::UtxoEntry {
                        output: out.clone(),
                        height,
                        coinbase: false,
                    },
                );
            }
            keep.push(tx);
        }
        st.mempool = keep;
        let _ = storage::save_mempool(&self.config.datadir, &st.mempool);
    }

    fn mining_loop(self: Arc<Self>, address: Address) {
        let mut mined: u64 = 0;
        println!("[miner] mining to {}", blockle_core::encode_address(&address));
        loop {
            if let Some(limit) = self.config.mine_blocks {
                if mined >= limit {
                    println!("[miner] finished {mined} blocks, miner stopping");
                    return;
                }
            }
            let (chain, mempool) = {
                let st = self.state.lock().unwrap();
                // A node that hasn't synced yet shouldn't mine a competing
                // genesis; wait for peers to feed us a chain first.
                if st.chain.blocks.is_empty() && !self.config.connect.is_empty() {
                    drop(st);
                    thread::sleep(Duration::from_secs(2));
                    continue;
                }
                (st.chain.clone(), st.mempool.clone())
            };
            let version = self.tip_version.load(Ordering::SeqCst);
            // Abandon the current template when the tip changes OR after a short
            // refresh interval, then loop to rebuild. The periodic rebuild is
            // essential: the quiet-lane difficulty decay lowers the required
            // target as wall-clock time advances, but only a freshly-built
            // template (new timestamp) picks that up. Without it a solo miner
            // whose lane difficulty has outrun its hashrate would grind one
            // impossible template forever — the tip never changes, so it would
            // never rebuild and never benefit from the decay. (This is exactly
            // how the chain stalled for hours.)
            let deadline = Instant::now() + MINE_TEMPLATE_REFRESH;
            let cancel = || self.tip_version.load(Ordering::SeqCst) != version || Instant::now() >= deadline;
            match mine_block_cancellable(&chain, address, &mempool, cancel) {
                Ok(Some((block, _))) => {
                    if self.submit_block(block, None) {
                        mined += 1;
                        if let Some(secs) = self.config.mine_interval {
                            thread::sleep(Duration::from_secs(secs));
                        }
                    }
                }
                Ok(None) => continue, // tip changed or refresh elapsed — rebuild template
                Err(e) => {
                    println!("[miner] error: {e}");
                    thread::sleep(Duration::from_secs(1));
                }
            }
        }
    }
}

/// One-shot client: connect to a running node, handshake, hand it a
/// transaction, and disconnect. Used by `blockle send --node`.
pub fn push_tx_to_node(addr: &str, params: &ChainParams, tx: &Transaction) -> Result<()> {
    let mut stream =
        TcpStream::connect(addr).map_err(|e| anyhow!("cannot reach node at {addr}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    write_message(
        &mut stream,
        &Message::Version {
            network: params.name.clone(),
            protocol: PROTOCOL_VERSION,
            height: None,
            total_work: [0u8; 32],
            tip: [0u8; 32],
            listen: None,
        },
    )?;
    // The node sends its Version first, but a mining node also gossips Tip/NewBlock/
    // Ping/Inv to every connected peer, and those frames can reach a one-shot client
    // before (or interleaved with) the handshake Version. Read until we see the peer's
    // Version, skipping gossip, rather than treating the first non-Version frame as a
    // hard failure (which made `--node` submits flaky against a busy pool node).
    let mut handshook = false;
    for _ in 0..32 {
        match read_message(&mut stream)? {
            Message::Version { network, .. } if network == params.name => { handshook = true; break; }
            Message::Version { network, .. } => {
                return Err(anyhow!("node is on network {network:?}, expected {:?}", params.name))
            }
            _ => continue, // gossip arriving before the handshake Version — keep reading
        }
    }
    if !handshook {
        return Err(anyhow!("no handshake Version from node after 32 frames"));
    }
    write_message(&mut stream, &Message::NewTx { tx: tx.clone() })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_wire_roundtrip() {
        let msg = Message::Tip {
            height: Some(7),
            total_work: work_bytes(U256::from(123_456u64)),
            tip: [0xab; 32],
        };
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        // Binary framing: 4-byte LE length prefix + bincode payload.
        let len = u32::from_le_bytes(buf[..4].try_into().unwrap()) as usize;
        assert_eq!(buf.len(), 4 + len);
        match read_message(&mut &buf[..]).unwrap() {
            Message::Tip { height, total_work, tip } => {
                assert_eq!(height, Some(7));
                assert_eq!(total_work, work_bytes(U256::from(123_456u64)));
                assert_eq!(tip, [0xab; 32]);
            }
            other => panic!("wrong message {other:?}"),
        }
    }

    #[test]
    fn work_bytes_order_matches_numeric() {
        let small = work_bytes(U256::from(5u64));
        let big = work_bytes(U256::from(1u64) << 200);
        assert!(big > small);
    }

    #[test]
    fn oversized_message_rejected() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_MESSAGE_SIZE + 1).to_le_bytes());
        buf.extend_from_slice(&[0u8; 16]);
        assert!(read_message(&mut &buf[..]).is_err());
    }

    #[test]
    fn header_roundtrips_through_bincode() {
        let header = BlockHeader {
            version: 1,
            prev_hash: [1; 32],
            merkle_root: [2; 32],
            state_root: [0; 32],
            time: 123,
            bits: 0x207fffff,
            nonce: [9; 32],
            solution: vec![0xaa; 100],
        };
        let msg = Message::Headers { start_height: 3, headers: vec![header.clone()] };
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        match read_message(&mut &buf[..]).unwrap() {
            Message::Headers { start_height, headers } => {
                assert_eq!(start_height, 3);
                assert_eq!(headers, vec![header]);
            }
            other => panic!("wrong message {other:?}"),
        }
    }
}
