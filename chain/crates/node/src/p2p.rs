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

use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use blockle_chain::{build_template, mine_block_cancellable, Chain, ChainParams, U256};
use blockle_core::display_hash;
use blockle_core::hash::Hash32;
use blockle_core::keys::Address;
use blockle_core::{Block, BlockHeader, OutPoint, Transaction};
use blockle_pow::difficulty::{block_work, hash_meets_target};
use blockle_pow::equihash;

use crate::storage;

pub const PROTOCOL_VERSION: u32 = 2;
const MAX_MESSAGE_SIZE: u32 = 64 * 1024 * 1024;
const MAX_HEADERS_PER_MSG: usize = 2000;
const MAX_BLOCKS_PER_REQUEST: usize = 2000;
const OUTBOUND_TARGET: usize = 8;
const HEARTBEAT: Duration = Duration::from_secs(10);

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
}

struct SharedState {
    chain: Chain,
    mempool: Vec<Transaction>,
}

struct PeerHandle {
    sender: Sender<Message>,
    /// The peer's listening address, once learned from its Version.
    listen: Option<String>,
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
    next_peer_id: AtomicU64,
    /// Bumped on every tip change; miners poll it to abandon stale work.
    pub(crate) tip_version: AtomicU64,
}

impl Node {
    pub fn new(config: NodeConfig, chain: Chain, mempool: Vec<Transaction>) -> Arc<Self> {
        let known = config.connect.iter().cloned().collect();
        Arc::new(Node {
            config,
            state: Mutex::new(SharedState { chain, mempool }),
            peers: Mutex::new(HashMap::new()),
            syncs: Mutex::new(HashMap::new()),
            known_addrs: Mutex::new(known),
            outbound_targets: Mutex::new(HashSet::new()),
            next_peer_id: AtomicU64::new(1),
            tip_version: AtomicU64::new(0),
        })
    }

    pub fn tip_generation(&self) -> u64 {
        self.tip_version.load(Ordering::SeqCst)
    }

    pub fn params(&self) -> &ChainParams {
        &self.config.params
    }

    /// Snapshot (chain, mempool) for template building.
    pub fn snapshot(&self) -> (Chain, Vec<Transaction>) {
        let st = self.state.lock().unwrap();
        (st.chain.clone(), st.mempool.clone())
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
                Ok(stream) => node.clone().handle_peer(stream),
                Err(e) => println!("[p2p] could not connect to {addr}: {e}"),
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
        let candidates: Vec<String> = {
            let known = self.known_addrs.lock().unwrap();
            known
                .iter()
                .filter(|a| {
                    !connected.contains(*a)
                        && **a != self.config.listen
                        && !Self::is_unroutable(a)
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
        let (tx, rx) = channel::<Message>();
        self.peers
            .lock()
            .unwrap()
            .insert(peer_id, PeerHandle { sender: tx, listen: None });
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
                    if let Some(peer) = self.peers.lock().unwrap().get_mut(&peer_id) {
                        peer.listen = Some(addr.clone());
                    }
                    if !Self::is_unroutable(&addr) {
                        self.known_addrs.lock().unwrap().insert(addr);
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
        // Standalone PoW check per header before spending bandwidth on bodies.
        for h in &headers {
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
        let retained_work: U256 = st.chain.blocks[..start]
            .iter()
            .fold(U256::zero(), |acc, b| acc.saturating_add(block_work(b.header.bits)));
        let new_work: U256 = headers
            .iter()
            .fold(U256::zero(), |acc, h| acc.saturating_add(block_work(h.bits)));
        let candidate_work = retained_work.saturating_add(new_work);
        if candidate_work <= st.chain.total_work() {
            return;
        }
        drop(st);

        let hashes: Vec<Hash32> = headers
            .iter()
            .take(MAX_BLOCKS_PER_REQUEST)
            .map(|h| h.hash())
            .collect();
        println!(
            "[p2p] peer {peer_id} has heavier chain ({} new headers from height {start_height}); fetching blocks",
            hashes.len()
        );
        self.syncs
            .lock()
            .unwrap()
            .insert(peer_id, SyncState { start_height, hashes: hashes.clone() });
        self.send_to(peer_id, Message::GetBlocks { hashes });
    }

    fn serve_blocks(&self, peer_id: u64, hashes: &[Hash32]) {
        let st = self.state.lock().unwrap();
        let mut blocks = Vec::new();
        for h in hashes.iter().take(MAX_BLOCKS_PER_REQUEST) {
            if let Some(b) = st.chain.blocks.iter().find(|b| &b.header.hash() == h) {
                blocks.push(b.clone());
            }
        }
        drop(st);
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
        let prefix: Vec<Block> = {
            let st = self.state.lock().unwrap();
            st.chain.blocks[..sync.start_height as usize].to_vec()
        };
        let mut candidate_blocks = prefix;
        candidate_blocks.extend(blocks);
        let n = candidate_blocks.len();
        // Heavy validation happens outside the state lock.
        let candidate = match Chain::from_blocks(self.config.params.clone(), candidate_blocks) {
            Ok(c) => c,
            Err(e) => {
                println!("[p2p] peer {peer_id} chain of {n} blocks failed validation: {e}");
                return;
            }
        };
        let cand_work = candidate.total_work();

        let mut st = self.state.lock().unwrap();
        if cand_work <= st.chain.total_work() {
            return;
        }
        let old_height = st.chain.height();
        st.chain = candidate;
        let _ = storage::save_chain(&self.config.datadir, &st.chain.blocks);
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
        match st.chain.connect_block(block.clone()) {
            Ok(()) => {
                let height = st.chain.height().unwrap();
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
        // Reject double-spends against pending transactions (no unconfirmed
        // chaining in the prototype mempool).
        let pending: Vec<OutPoint> = st
            .mempool
            .iter()
            .flat_map(|t| t.inputs.iter().map(|i| i.prev))
            .collect();
        if tx.inputs.iter().any(|i| pending.contains(&i.prev)) {
            return false;
        }
        // Same for shielded nullifiers.
        let pending_nullifiers: Vec<[u8; 32]> =
            st.mempool.iter().flat_map(|t| t.nullifiers()).collect();
        if tx.nullifiers().iter().any(|n| pending_nullifiers.contains(n)) {
            return false;
        }
        let height = st.chain.blocks.len() as u64;
        if let Err(e) = st.chain.check_transaction(&tx, &st.chain.utxos, height) {
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
    fn prune_mempool(&self, st: &mut SharedState) {
        let height = st.chain.blocks.len() as u64;
        let chain = &st.chain;
        st.mempool
            .retain(|tx| chain.check_transaction(tx, &chain.utxos, height).is_ok());
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
            let cancel = || self.tip_version.load(Ordering::SeqCst) != version;
            match mine_block_cancellable(&chain, address, &mempool, cancel) {
                Ok(Some((block, _))) => {
                    if self.submit_block(block, None) {
                        mined += 1;
                        if let Some(secs) = self.config.mine_interval {
                            thread::sleep(Duration::from_secs(secs));
                        }
                    }
                }
                Ok(None) => continue, // tip changed under us — rebuild template
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
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
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
    match read_message(&mut stream)? {
        Message::Version { network, .. } if network == params.name => {}
        Message::Version { network, .. } => {
            return Err(anyhow!("node is on network {network:?}, expected {:?}", params.name))
        }
        _ => return Err(anyhow!("unexpected handshake reply")),
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
