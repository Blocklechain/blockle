//! Bitcoin-family adapter: `getblocktemplate`/`submitblock` JSON-RPC,
//! sha256d PoW, stratum v1 work format, and **merged mining** (AuxPoW):
//! auxiliary chains' block hashes are committed into the parent coinbase
//! (`0xfabe6d6d` magic), and a share that meets an aux chain's target is
//! submitted there with a full Namecoin-shaped AuxPoW proof.
//!
//! The adapter is **manifest-driven**: every method and field name it touches
//! comes from a [`FieldMap`], so bitcoind forks that renamed template fields
//! are onboarded by editing the generated pool config — no code. Defaults
//! match bitcoind.
//!
//! Status: exercised end-to-end (including AuxPoW) against Blockle's
//! built-in simulated chains over real sockets; not yet shaken down against
//! live bitcoind/namecoind — miner-firmware byte-order quirks may need the
//! usual stratum fiddling.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::adapter::{BlockResult, Job, PoolAdapter, ShareOutcome, ShareSubmit};
use crate::btc;
use crate::rpc::RpcClient;

/// Method/field mapping for bitcoind-dialect chains.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct FieldMap {
    pub template_method: String,
    pub submit_method: String,
    pub prev_hash: String,
    pub height: String,
    pub bits: String,
    pub curtime: String,
    pub version: String,
    pub coinbase_value: String,
    pub transactions: String,
    pub tx_id_field: String,
    pub tx_data_field: String,
}

impl Default for FieldMap {
    fn default() -> Self {
        FieldMap {
            template_method: "getblocktemplate".into(),
            submit_method: "submitblock".into(),
            prev_hash: "previousblockhash".into(),
            height: "height".into(),
            bits: "bits".into(),
            curtime: "curtime".into(),
            version: "version".into(),
            coinbase_value: "coinbasevalue".into(),
            transactions: "transactions".into(),
            tx_id_field: "txid".into(),
            tx_data_field: "data".into(),
        }
    }
}

/// A merged-mined auxiliary chain.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AuxConfig {
    pub name: String,
    pub rpc: String,
    #[serde(default = "default_chain_id")]
    pub chain_id: u32,
    #[serde(default = "default_create_method")]
    pub create_method: String,
    #[serde(default = "default_submit_method")]
    pub submit_method: String,
    /// Payout address sent with createauxblock (aux chains that mint to
    /// the caller, like BLOCK's aux-work interface).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub payout_address: String,
    /// Parent algorithm declared to the aux chain (BLOCK lanes).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub algorithm: String,
}

fn default_chain_id() -> u32 {
    1
}
fn default_create_method() -> String {
    "createauxblock".into()
}
fn default_submit_method() -> String {
    "submitauxblock".into()
}

#[derive(Clone)]
struct AuxWork {
    hash_le: [u8; 32],
    target: btc::Target,
    height: u64,
}

struct AuxChain {
    cfg: AuxConfig,
    rpc: RpcClient,
    work: Option<AuxWork>,
}

struct JobData {
    height: u64,
    prev_le: [u8; 32],
    coinb1: Vec<u8>,
    coinb2: Vec<u8>,
    branch: Vec<[u8; 32]>,
    version: u32,
    nbits: u32,
    ntime: u32,
    tx_raw: Vec<Vec<u8>>,
    reward: u64,
    // merged-mining snapshot for this job
    aux_works: Vec<AuxWork>,
    aux_leaves: Vec<[u8; 32]>,
    aux_size: u32,
}

pub struct BitcoinAdapter {
    rpc: RpcClient,
    map: FieldMap,
    chain: String,
    payout_script: Vec<u8>,
    coinbase_tag: Vec<u8>,
    extranonce_total: usize,
    aux: Vec<AuxChain>,
    last_prev: Option<[u8; 32]>,
    last_aux_hashes: Vec<[u8; 32]>,
    next_job: u64,
    jobs: HashMap<String, JobData>,
    last_reward: Option<u64>,
}

impl BitcoinAdapter {
    pub fn new(
        rpc_url: &str,
        chain: &str,
        map: FieldMap,
        payout_script: Vec<u8>,
        aux: Vec<AuxConfig>,
    ) -> Self {
        BitcoinAdapter {
            rpc: RpcClient::new(rpc_url),
            map,
            chain: chain.to_string(),
            payout_script,
            coinbase_tag: b"/blockle/".to_vec(),
            extranonce_total: 8, // 4 server + 4 miner
            aux: aux
                .into_iter()
                .map(|cfg| AuxChain { rpc: RpcClient::new(&cfg.rpc), cfg, work: None })
                .collect(),
            last_prev: None,
            last_aux_hashes: Vec::new(),
            next_job: 1,
            jobs: HashMap::new(),
            last_reward: None,
        }
    }

    fn get_u64(&self, v: &Value, field: &str) -> Result<u64> {
        v.get(field)
            .and_then(|x| x.as_u64())
            .ok_or_else(|| anyhow!("template missing numeric field {field:?}"))
    }

    /// Refresh aux work from every merged chain; returns true if any changed.
    fn refresh_aux(&mut self) -> bool {
        let mut changed = false;
        for chain in &mut self.aux {
            let create_params = if chain.cfg.payout_address.is_empty() {
                json!([])
            } else if chain.cfg.algorithm.is_empty() {
                json!([chain.cfg.payout_address])
            } else {
                json!([chain.cfg.payout_address, chain.cfg.algorithm])
            };
            match chain.rpc.require(&chain.cfg.create_method.clone(), create_params) {
                Ok(v) => {
                    let hash = v
                        .get("hash")
                        .and_then(|h| h.as_str())
                        .and_then(btc::display_to_le);
                    let target = v
                        .get("target")
                        .and_then(|t| t.as_str())
                        .and_then(|t| hex::decode(t).ok())
                        .and_then(|b| <[u8; 32]>::try_from(b).ok());
                    let height = v.get("height").and_then(|h| h.as_u64()).unwrap_or(0);
                    if let (Some(hash_le), Some(target)) = (hash, target) {
                        if chain.work.as_ref().map(|w| w.hash_le) != Some(hash_le) {
                            changed = true;
                        }
                        chain.work = Some(AuxWork { hash_le, target, height });
                    }
                }
                Err(e) => {
                    if chain.work.take().is_some() {
                        changed = true;
                    }
                    println!("[pool] aux chain {} unreachable: {e}", chain.cfg.name);
                }
            }
        }
        changed
    }

    fn build_job(&mut self, tpl: &Value) -> Result<Job> {
        let m = self.map.clone();
        let prev_display = tpl
            .get(&m.prev_hash)
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("template missing {:?}", m.prev_hash))?;
        let prev_le = btc::display_to_le(prev_display)
            .ok_or_else(|| anyhow!("bad prev hash {prev_display:?}"))?;
        let height = self.get_u64(tpl, &m.height)?;
        let version = self.get_u64(tpl, &m.version)? as u32;
        let ntime = self.get_u64(tpl, &m.curtime)? as u32;
        let bits_str = tpl
            .get(&m.bits)
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("template missing {:?}", m.bits))?;
        let nbits = u32::from_str_radix(bits_str, 16)?;
        let reward = self.get_u64(tpl, &m.coinbase_value).unwrap_or(0);

        let empty = vec![];
        let txs = tpl.get(&m.transactions).and_then(|v| v.as_array()).unwrap_or(&empty);
        let mut txids = Vec::new();
        let mut tx_raw = Vec::new();
        for tx in txs {
            let id = tx
                .get(&m.tx_id_field)
                .or_else(|| tx.get("hash"))
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("transaction missing {:?}", m.tx_id_field))?;
            txids.push(btc::display_to_le(id).ok_or_else(|| anyhow!("bad txid {id:?}"))?);
            let data = tx
                .get(&m.tx_data_field)
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow!("transaction missing {:?}", m.tx_data_field))?;
            tx_raw.push(hex::decode(data)?);
        }
        let branch = btc::merkle_branch(&txids);

        // Merged-mining commitment for the current aux work set.
        let aux_works: Vec<AuxWork> =
            self.aux.iter().filter_map(|c| c.work.clone()).collect();
        let entries: Vec<(u32, [u8; 32])> = self
            .aux
            .iter()
            .filter_map(|c| c.work.as_ref().map(|w| (c.cfg.chain_id, w.hash_le)))
            .collect();
        let (aux_leaves, aux_size, tag) = if entries.is_empty() {
            (Vec::new(), 1, self.coinbase_tag.clone())
        } else {
            let (root, leaves, size) = btc::aux_tree(&entries);
            let mut tag = btc::mm_commitment(&root, size, 0);
            tag.extend_from_slice(&self.coinbase_tag);
            (leaves, size, tag)
        };
        self.last_aux_hashes = entries.iter().map(|(_, h)| *h).collect();

        let (coinb1, coinb2) = btc::coinbase_parts(
            height,
            self.extranonce_total,
            &tag,
            reward,
            &self.payout_script,
        );

        let id = format!("{:x}", self.next_job);
        self.next_job += 1;
        let block_target = btc::compact_to_target(nbits);
        let notify_tail = vec![
            json!(btc::stratum_prevhash(&prev_le)),
            json!(hex::encode(&coinb1)),
            json!(hex::encode(&coinb2)),
            json!(branch.iter().map(hex::encode).collect::<Vec<_>>()),
            json!(format!("{version:08x}")),
            json!(format!("{nbits:08x}")),
            json!(format!("{ntime:08x}")),
        ];
        let clean = self.last_prev != Some(prev_le);
        self.last_prev = Some(prev_le);
        self.last_reward = Some(reward);
        self.jobs.insert(
            id.clone(),
            JobData {
                height,
                prev_le,
                coinb1,
                coinb2,
                branch,
                version,
                nbits,
                ntime,
                tx_raw,
                reward,
                aux_works,
                aux_leaves,
                aux_size,
            },
        );
        if self.jobs.len() > 16 {
            let min_keep = self.next_job.saturating_sub(16);
            self.jobs.retain(|k, _| u64::from_str_radix(k, 16).unwrap_or(0) >= min_keep);
        }
        Ok(Job { id, height, block_target, notify_tail, clean })
    }

    /// Rebuild the header + coinbase for a submit.
    fn rebuild(&self, job: &Job, s: &ShareSubmit) -> Result<([u8; 80], Vec<u8>, [u8; 32])> {
        let data = self
            .jobs
            .get(&job.id)
            .ok_or_else(|| anyhow!("unknown job {}", job.id))?;
        if s.extranonce1.len() + s.extranonce2.len() != self.extranonce_total {
            return Err(anyhow!("bad extranonce length"));
        }
        let mut coinbase = data.coinb1.clone();
        coinbase.extend_from_slice(&s.extranonce1);
        coinbase.extend_from_slice(&s.extranonce2);
        coinbase.extend_from_slice(&data.coinb2);
        let cb_txid = btc::dsha256(&coinbase);
        let root = btc::merkle_root_from_branch(cb_txid, &data.branch);
        let ntime = u32::from_str_radix(&s.ntime_hex, 16)?;
        let nonce = u32::from_str_radix(&s.nonce_hex, 16)?;
        let header =
            btc::header_bytes(data.version, &data.prev_le, &root, ntime, data.nbits, nonce);
        let hash = btc::dsha256(&header);
        Ok((header, coinbase, hash))
    }
}

impl PoolAdapter for BitcoinAdapter {
    fn chain_name(&self) -> String {
        self.chain.clone()
    }

    fn poll_job(&mut self, refresh: bool) -> Result<Option<Job>> {
        let aux_changed = self.refresh_aux();
        let tpl = self
            .rpc
            .require(&self.map.template_method.clone(), json!([{ "rules": ["segwit"] }]))
            .or_else(|_| self.rpc.require(&self.map.template_method.clone(), json!([])))?;
        let prev = tpl
            .get(&self.map.prev_hash)
            .and_then(|v| v.as_str())
            .and_then(btc::display_to_le);
        if !refresh && !aux_changed && prev.is_some() && prev == self.last_prev {
            return Ok(None);
        }
        Ok(Some(self.build_job(&tpl)?))
    }

    fn check_share(&self, job: &Job, submit: &ShareSubmit) -> ShareOutcome {
        match self.rebuild(job, submit) {
            Ok((_, _, hash)) => {
                let meets_block = btc::hash_meets_target(&hash, &job.block_target);
                let meets_aux = self
                    .jobs
                    .get(&job.id)
                    .map(|d| {
                        d.aux_works
                            .iter()
                            .enumerate()
                            .filter(|(_, w)| btc::hash_meets_target(&hash, &w.target))
                            .map(|(i, _)| i)
                            .collect()
                    })
                    .unwrap_or_default();
                ShareOutcome::Valid { hash_le: hash, meets_block, meets_aux }
            }
            Err(e) => ShareOutcome::Rejected(e.to_string()),
        }
    }

    fn submit_block(&self, job: &Job, submit: &ShareSubmit) -> BlockResult {
        let (header, coinbase, hash) = match self.rebuild(job, submit) {
            Ok(x) => x,
            Err(e) => return BlockResult::Rejected(e.to_string()),
        };
        let data = self.jobs.get(&job.id).expect("rebuild succeeded");
        let mut block = Vec::with_capacity(81 + coinbase.len());
        block.extend_from_slice(&header);
        block.extend_from_slice(&btc::varint(1 + data.tx_raw.len() as u64));
        block.extend_from_slice(&coinbase);
        for tx in &data.tx_raw {
            block.extend_from_slice(tx);
        }
        match self.rpc.require(&self.map.submit_method.clone(), json!([hex::encode(&block)])) {
            Ok(Value::Null) => BlockResult::Accepted { hash_display: btc::le_to_display(&hash) },
            Ok(Value::String(reason)) => BlockResult::Rejected(reason),
            Ok(other) => BlockResult::Rejected(format!("unexpected reply {other}")),
            Err(e) => BlockResult::Rejected(e.to_string()),
        }
    }

    fn submit_aux(&self, job: &Job, submit: &ShareSubmit, aux_index: usize) -> BlockResult {
        let (header, coinbase, hash) = match self.rebuild(job, submit) {
            Ok(x) => x,
            Err(e) => return BlockResult::Rejected(e.to_string()),
        };
        let data = self.jobs.get(&job.id).expect("rebuild succeeded");
        let Some(work) = data.aux_works.get(aux_index) else {
            return BlockResult::Rejected("no such aux chain in this job".into());
        };
        let Some(chain) = self.aux.get(aux_index) else {
            return BlockResult::Rejected("aux chain gone".into());
        };
        let slot = btc::aux_slot(chain.cfg.chain_id, data.aux_size, 0) as usize;
        let aux_branch = btc::branch_for_index(&data.aux_leaves, slot);
        let auxpow = btc::auxpow_bytes(
            &coinbase,
            &hash,
            &data.branch,
            &aux_branch,
            slot as u32,
            &header,
        );
        let params = json!([btc::le_to_display(&work.hash_le), hex::encode(&auxpow)]);
        match chain.rpc.require(&chain.cfg.submit_method.clone(), params) {
            Ok(Value::Null) | Ok(Value::Bool(true)) => {
                BlockResult::Accepted { hash_display: btc::le_to_display(&work.hash_le) }
            }
            Ok(Value::String(reason)) => BlockResult::Rejected(reason),
            Ok(Value::Bool(false)) => BlockResult::Rejected("aux chain rejected the proof".into()),
            Ok(other) => BlockResult::Rejected(format!("unexpected reply {other}")),
            Err(e) => BlockResult::Rejected(e.to_string()),
        }
    }

    fn aux_names(&self) -> Vec<String> {
        self.aux.iter().map(|c| c.cfg.name.clone()).collect()
    }

    fn block_reward(&self) -> Option<u64> {
        self.last_reward
    }
}
