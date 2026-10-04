//! A simulated proof-of-work chain for demos and tests.
//!
//! This is a real (toy) sha256d chain behind a real HTTP JSON-RPC server
//! speaking the bitcoind dialect: `getblockchaininfo`, `getmininginfo`,
//! `getblocktemplate`, `submitblock`, `getblockcount`. Submitted blocks are
//! actually validated (header links to the tip, PoW meets the target,
//! coinbase present with BIP34 height), so everything downstream — probing,
//! pool generation, stratum, share validation, block submission — runs
//! against honest plumbing with zero external dependencies.

use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::btc;
use crate::http;

const SIM_BITS: u32 = 0x207fffff; // very easy: CPU-minable instantly
const SIM_REWARD: u64 = 50_0000_0000; // 50 SIM, 8 decimals

struct SimState {
    height: u64,
    tip_le: [u8; 32],
    start_time: u32,
    blocks_submitted: u64,
    /// Accepted block hashes, index = height - 1.
    block_hashes: Vec<[u8; 32]>,
    /// Coinbase script hex per accepted block (empty for aux-accepted).
    coinbase_scripts: Vec<String>,
    /// Wallet addresses handed out by getnewaddress: (address, scriptPubKey hex).
    wallet_addrs: Vec<(String, String)>,
}

pub struct SimChain {
    name: String,
    state: Mutex<SimState>,
}

impl SimChain {
    fn new(name: &str) -> Self {
        // Deterministic fake genesis hash (distinct per chain name).
        let genesis = btc::dsha256(format!("blockle-simchain-genesis-{name}").as_bytes());
        SimChain {
            name: name.to_string(),
            state: Mutex::new(SimState {
                height: 0,
                tip_le: genesis,
                start_time: 1_700_000_000,
                blocks_submitted: 0,
                block_hashes: Vec::new(),
                coinbase_scripts: Vec::new(),
                wallet_addrs: Vec::new(),
            }),
        }
    }

    /// The aux-chain "work hash" for the next block: deterministic per tip.
    fn aux_candidate(st: &SimState) -> [u8; 32] {
        let mut data = Vec::with_capacity(40);
        data.extend_from_slice(&st.tip_le);
        data.extend_from_slice(&(st.height + 1).to_le_bytes());
        btc::dsha256(&data)
    }

    fn handle(&self, method: &str, _params: &Value, body: &Value) -> Value {
        let mut st = self.state.lock().unwrap();
        match method {
            "getblockchaininfo" => json!({
                "chain": self.name.clone(),
                "blocks": st.height,
                "bestblockhash": btc::le_to_display(&st.tip_le),
                "difficulty": 4.6565e-10,
            }),
            "getblockcount" => json!(st.height),
            "getmininginfo" => json!({
                "blocks": st.height,
                "bits": format!("{SIM_BITS:08x}"),
                "difficulty": 4.6565e-10,
                "networkhashps": 1000.0,
                "chain": self.name.clone(),
            }),
            "getblocktemplate" => {
                let target = btc::compact_to_target(SIM_BITS);
                json!({
                    "version": 0x2000_0000u32,
                    "previousblockhash": btc::le_to_display(&st.tip_le),
                    "transactions": [],
                    "coinbasevalue": SIM_REWARD,
                    "coinbaseaux": {"flags": ""},
                    "target": hex::encode(target),
                    "bits": format!("{SIM_BITS:08x}"),
                    "curtime": st.start_time + st.height as u32 * 60,
                    "mintime": st.start_time,
                    "height": st.height + 1,
                    "mutable": ["time", "transactions", "prevblock"],
                    "noncerange": "00000000ffffffff",
                    "capabilities": ["proposal"],
                })
            }
            "submitblock" => {
                let hex_data = body
                    .get("params")
                    .and_then(|p| p.get(0))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let Ok(raw) = hex::decode(hex_data) else {
                    return json!({"__error": "decode failed"});
                };
                if raw.len() < 81 {
                    return json!({"__error": "block too small"});
                }
                let header: [u8; 80] = raw[..80].try_into().unwrap();
                let prev: [u8; 32] = header[4..36].try_into().unwrap();
                if prev != st.tip_le {
                    return json!({"__error": "inconclusive"}); // stale / wrong prev
                }
                let hash = btc::dsha256(&header);
                let target = btc::compact_to_target(SIM_BITS);
                if !btc::hash_meets_target(&hash, &target) {
                    return json!({"__error": "high-hash"});
                }
                // Minimal body check: at least one tx (the coinbase).
                if raw[80] == 0 {
                    return json!({"__error": "bad-txns-missing-coinbase"});
                }
                // Extract the coinbase script for watcher attribution.
                let coinbase_script = parse_coinbase_script(&raw[80..]).unwrap_or_default();
                st.height += 1;
                st.tip_le = hash;
                st.block_hashes.push(hash);
                st.coinbase_scripts.push(coinbase_script);
                st.blocks_submitted += 1;
                println!(
                    "[simchain:{}] accepted block {} ({})",
                    self.name,
                    st.height,
                    btc::le_to_display(&hash)
                );
                Value::Null // bitcoind convention: null = accepted
            }
            "getnewaddress" => {
                // Fresh deterministic wallet address (p2wpkh-shaped script).
                let mut seed = self.name.clone().into_bytes();
                seed.extend_from_slice(&(st.wallet_addrs.len() as u64).to_le_bytes());
                let h = btc::dsha256(&seed);
                let addr = format!("sim1{}", hex::encode(&h[..20]));
                let script = format!("0014{}", hex::encode(&h[..20]));
                st.wallet_addrs.push((addr.clone(), script));
                json!(addr)
            }
            "getaddressinfo" | "validateaddress" => {
                let addr = body
                    .get("params")
                    .and_then(|p| p.get(0))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match st.wallet_addrs.iter().find(|(a, _)| a == addr) {
                    Some((_, script)) => json!({
                        "address": addr,
                        "isvalid": true,
                        "ismine": true,
                        "scriptPubKey": script,
                    }),
                    None => json!({"isvalid": false}),
                }
            }
            "getblock" => {
                let hash_param = body
                    .get("params")
                    .and_then(|p| p.get(0))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let found = st
                    .block_hashes
                    .iter()
                    .position(|h| btc::le_to_display(h) == hash_param);
                match found {
                    Some(i) => {
                        let height = i as u64 + 1;
                        json!({
                            "hash": hash_param,
                            "height": height,
                            "confirmations": st.height - height + 1,
                            "difficulty": 4.6565e-10,
                            "chain": self.name.clone(),
                            "coinbase_script": st.coinbase_scripts.get(i).cloned().unwrap_or_default(),
                        })
                    }
                    None => json!({"__error": "Block not found"}),
                }
            }
            "getblockhash" => {
                let h = body
                    .get("params")
                    .and_then(|p| p.get(0))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if h == 0 || h > st.height {
                    return json!({"__error": "Block height out of range"});
                }
                json!(btc::le_to_display(&st.block_hashes[(h - 1) as usize]))
            }
            // ---- merged mining (aux chain) ----
            "createauxblock" | "getauxblock" => {
                let candidate = Self::aux_candidate(&st);
                let target = btc::compact_to_target(SIM_BITS);
                json!({
                    "hash": btc::le_to_display(&candidate),
                    "chainid": 1,
                    "target": hex::encode(target),
                    "height": st.height + 1,
                })
            }
            "submitauxblock" => {
                let params = body.get("params").cloned().unwrap_or(Value::Null);
                let hash_param = params.get(0).and_then(|v| v.as_str()).unwrap_or("");
                let auxpow_hex = params.get(1).and_then(|v| v.as_str()).unwrap_or("");
                let candidate = Self::aux_candidate(&st);
                if hash_param != btc::le_to_display(&candidate) {
                    return json!({"__error": "stale-aux-hash"});
                }
                let Ok(raw) = hex::decode(auxpow_hex) else {
                    return json!({"__error": "decode failed"});
                };
                match validate_auxpow(&raw, &candidate) {
                    Ok(()) => {
                        st.height += 1;
                        st.tip_le = candidate;
                        st.block_hashes.push(candidate);
                        st.coinbase_scripts.push(String::new());
                        st.blocks_submitted += 1;
                        println!(
                            "[simchain:{}] accepted AUX block {} ({})",
                            self.name,
                            st.height,
                            btc::le_to_display(&candidate)
                        );
                        Value::Bool(true)
                    }
                    Err(e) => json!({"__error": e}),
                }
            }
            _ => json!({"__method_not_found": true}),
        }
    }
}

/// Extract the coinbase scriptSig hex from serialized block body bytes
/// (starting at the tx-count varint).
fn parse_coinbase_script(body: &[u8]) -> Option<String> {
    let mut pos = 0usize;
    // tx count varint
    let first = *body.first()?;
    pos += match first {
        0..=0xfc => 1,
        0xfd => 3,
        0xfe => 5,
        _ => 9,
    };
    pos += 4; // tx version
    let vin = *body.get(pos)?;
    pos += 1;
    if vin != 1 {
        return None;
    }
    pos += 36; // prevout
    let script_len = *body.get(pos)? as usize;
    pos += 1;
    let script = body.get(pos..pos + script_len)?;
    Some(hex::encode(script))
}

/// Validate a Namecoin-shaped AuxPoW proof for `aux_hash`:
/// parent coinbase commits to the aux tree containing our hash, the
/// coinbase is in the parent block, and the parent header meets our target.
fn validate_auxpow(raw: &[u8], aux_hash: &[u8; 32]) -> Result<(), &'static str> {
    let mut pos = 0usize;
    let take = |pos: &mut usize, n: usize| -> Result<&[u8], &'static str> {
        if *pos + n > raw.len() {
            return Err("truncated auxpow");
        }
        let s = &raw[*pos..*pos + n];
        *pos += n;
        Ok(s)
    };
    let read_varint = |pos: &mut usize| -> Result<u64, &'static str> {
        let first = take(pos, 1)?[0];
        Ok(match first {
            0..=0xfc => first as u64,
            0xfd => u16::from_le_bytes(take(pos, 2)?.try_into().unwrap()) as u64,
            0xfe => u32::from_le_bytes(take(pos, 4)?.try_into().unwrap()) as u64,
            _ => u64::from_le_bytes(take(pos, 8)?.try_into().unwrap()),
        })
    };

    // -- parent coinbase tx (minimal structural parse to find its length) --
    let tx_start = pos;
    take(&mut pos, 4)?; // version
    let vin = read_varint(&mut pos)?;
    if vin != 1 {
        return Err("coinbase must have one input");
    }
    take(&mut pos, 36)?; // prevout
    let script_len = read_varint(&mut pos)? as usize;
    let script = take(&mut pos, script_len)?.to_vec();
    take(&mut pos, 4)?; // sequence
    let vout = read_varint(&mut pos)?;
    for _ in 0..vout {
        take(&mut pos, 8)?;
        let sl = read_varint(&mut pos)? as usize;
        take(&mut pos, sl)?;
    }
    take(&mut pos, 4)?; // locktime
    let coinbase_raw = &raw[tx_start..pos];
    let coinbase_txid = btc::dsha256(coinbase_raw);

    let parent_hash: [u8; 32] = take(&mut pos, 32)?.try_into().unwrap();
    let cb_branch_len = read_varint(&mut pos)? as usize;
    let mut cb_branch = Vec::with_capacity(cb_branch_len);
    for _ in 0..cb_branch_len {
        cb_branch.push(<[u8; 32]>::try_from(take(&mut pos, 32)?).unwrap());
    }
    let cb_index = u32::from_le_bytes(take(&mut pos, 4)?.try_into().unwrap());
    if cb_index != 0 {
        return Err("coinbase must be leaf 0");
    }
    let aux_branch_len = read_varint(&mut pos)? as usize;
    let mut aux_branch = Vec::with_capacity(aux_branch_len);
    for _ in 0..aux_branch_len {
        aux_branch.push(<[u8; 32]>::try_from(take(&mut pos, 32)?).unwrap());
    }
    let aux_index = u32::from_le_bytes(take(&mut pos, 4)?.try_into().unwrap());
    let header: [u8; 80] = take(&mut pos, 80)?.try_into().unwrap();

    // 1. parent PoW meets our target
    let parent_pow = btc::dsha256(&header);
    if !btc::hash_meets_target(&parent_pow, &btc::compact_to_target(SIM_BITS)) {
        return Err("parent header fails aux target");
    }
    if parent_pow != parent_hash {
        return Err("parent hash mismatch");
    }
    // 2. aux hash folds to the committed root
    let aux_root = {
        let mut acc = *aux_hash;
        let mut index = aux_index as usize;
        for node in &aux_branch {
            let mut d = [0u8; 64];
            if index & 1 == 0 {
                d[..32].copy_from_slice(&acc);
                d[32..].copy_from_slice(node);
            } else {
                d[..32].copy_from_slice(node);
                d[32..].copy_from_slice(&acc);
            }
            acc = btc::dsha256(&d);
            index /= 2;
        }
        acc
    };
    // 3. coinbase script contains MM_MAGIC ‖ aux_root (+ size/nonce sanity)
    let magic_pos = script
        .windows(4)
        .position(|w| w == btc::MM_MAGIC)
        .ok_or("no merged-mining commitment in coinbase")?;
    if script.len() < magic_pos + 4 + 32 + 8 {
        return Err("truncated merged-mining commitment");
    }
    if script[magic_pos + 4..magic_pos + 36] != aux_root {
        return Err("aux root mismatch in coinbase commitment");
    }
    let size = u32::from_le_bytes(script[magic_pos + 36..magic_pos + 40].try_into().unwrap());
    let nonce = u32::from_le_bytes(script[magic_pos + 40..magic_pos + 44].try_into().unwrap());
    if btc::aux_slot(1, size, nonce) != aux_index {
        return Err("aux index does not match slot derivation");
    }
    // 4. coinbase is in the parent block
    let merkle_root: [u8; 32] = header[36..68].try_into().unwrap();
    let mut acc = coinbase_txid;
    for node in &cb_branch {
        let mut d = [0u8; 64];
        d[..32].copy_from_slice(&acc);
        d[32..].copy_from_slice(node);
        acc = btc::dsha256(&d);
    }
    if acc != merkle_root {
        return Err("coinbase not in parent block");
    }
    Ok(())
}

/// Start the simulated chain's RPC server; returns once listening.
pub fn serve(listen: &str, name: &str) -> Result<Arc<SimChain>> {
    let chain = Arc::new(SimChain::new(name));
    let listener =
        TcpListener::bind(listen).map_err(|e| anyhow!("simchain cannot listen on {listen}: {e}"))?;
    println!("[simchain:{name}] sha256d test chain with bitcoind-style RPC on http://{listen}/");
    let chain2 = chain.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let chain = chain2.clone();
            thread::spawn(move || {
                let mut stream = stream;
                let Ok(req) = http::read_request(&mut stream) else { return };
                let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
                let id = body.get("id").cloned().unwrap_or(Value::Null);
                let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let params = body.get("params").cloned().unwrap_or(Value::Null);
                let result = chain.handle(method, &params, &body);
                let reply = if result.get("__method_not_found").is_some() {
                    json!({"id": id, "result": null,
                           "error": {"code": -32601, "message": "Method not found"}})
                } else if let Some(e) = result.get("__error") {
                    // submitblock returns the reject reason as a string result,
                    // like bitcoind.
                    json!({"id": id, "result": e, "error": null})
                } else {
                    json!({"id": id, "result": result, "error": null})
                };
                http::respond(&mut stream, "200 OK", "application/json", reply.to_string().as_bytes());
            });
        }
    });
    Ok(chain)
}

impl SimChain {
    pub fn height(&self) -> u64 {
        self.state.lock().unwrap().height
    }
}
