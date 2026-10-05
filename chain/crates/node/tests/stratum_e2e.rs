//! End-to-end stratum test: run a node with a stratum endpoint, act as a
//! miner over real TCP — subscribe, receive a job, solve it, submit — and
//! verify the block connects to the chain.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_core::keys::Keypair;
use blockle_core::BlockHeader;
use blockle_node::{p2p, storage};
use blockle_pow::difficulty::hash_meets_target;
use blockle_pow::equihash;

fn read_until<'a>(
    reader: &mut BufReader<TcpStream>,
    lines: &'a mut Vec<Value>,
    pred: impl Fn(&Value) -> bool,
) -> &'a Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(v) = lines.iter().position(&pred) {
            return &lines[v];
        }
        assert!(Instant::now() < deadline, "timed out waiting for stratum message");
        let mut line = String::new();
        reader.read_line(&mut line).expect("stratum read");
        if line.trim().is_empty() {
            continue;
        }
        lines.push(serde_json::from_str(&line).expect("stratum json"));
    }
}

fn hex4(v: &Value) -> [u8; 4] {
    hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
}

fn hex32(v: &Value) -> [u8; 32] {
    hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap()
}

fn run_pool_test(mode: &str, port_off: u16) -> (std::path::PathBuf, std::sync::Arc<p2p::Node>, blockle_core::keys::Keypair, blockle_core::keys::Keypair) {
    use blockle_node::stratum::{PoolMode, PoolOpts};
    let params = ChainParams::regtest();
    let datadir = std::env::temp_dir().join(format!("blockle-stratum-{mode}-{}", process::id()));
    let _ = std::fs::remove_dir_all(&datadir);

    // Genesis on disk; `pool` is the pool wallet, `miner` the customer.
    let pool = Keypair::generate();
    let miner = Keypair::generate();
    let mut chain = Chain::new(params.clone());
    let (genesis, _) = mine_block(&chain, pool.address(), &[]).unwrap();
    chain.connect_block(genesis.clone()).unwrap();
    storage::append_block(&datadir, &genesis).unwrap();

    let p2p_port = 21000 + (process::id() % 1500) as u16 + port_off;
    let stratum_addr = format!("127.0.0.1:{}", p2p_port + 1);
    let opts = PoolOpts {
        mode: if mode == "solo" { PoolMode::Solo } else { PoolMode::Pplns },
        fee_bp: 100,
        window: 1000,
        pool_address: pool.address(),
        stats_path: Some(datadir.join(format!("stratum-{mode}.json"))),
        ledger_path: if mode == "pplns" { Some(datadir.join("pplns-ledger.jsonl")) } else { None },
        endpoint: stratum_addr.clone(),
        share_floor_target: None,
    };
    let node = p2p::Node::new(
        p2p::NodeConfig {
            datadir: datadir.clone(),
            params: params.clone(),
            listen: format!("127.0.0.1:{p2p_port}"),
            connect: vec![],
            mine_to: Some(pool.address()),
            local_mine: false,
            mine_blocks: None,
            mine_interval: None,
            pools: vec![(stratum_addr.clone(), opts)],
        },
        chain,
        vec![],
    );
    {
        let node = node.clone();
        thread::spawn(move || node.run().unwrap());
    }

    // Connect as a stratum miner (with retries while the server starts).
    let deadline = Instant::now() + Duration::from_secs(10);
    let stream = loop {
        match TcpStream::connect(&stratum_addr) {
            Ok(s) => break s,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Err(e) => panic!("cannot reach stratum: {e}"),
        }
    };
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    let mut lines: Vec<Value> = Vec::new();
    let miner_user = blockle_core::keys::encode_address(&miner.address());

    writeln!(
        writer,
        "{}",
        json!({"id": 1, "method": "mining.subscribe", "params": ["blockle-test/1.0", null]})
    )
    .unwrap();
    writeln!(
        writer,
        "{}",
        json!({"id": 2, "method": "mining.authorize", "params": [miner_user, "x"]})
    )
    .unwrap();

    let sub = read_until(&mut reader, &mut lines, |v| v.get("id") == Some(&json!(1))).clone();
    let nonce1: Vec<u8> = hex::decode(sub["result"][1].as_str().unwrap()).unwrap();
    assert_eq!(nonce1.len(), 16);
    let auth = read_until(&mut reader, &mut lines, |v| v.get("id") == Some(&json!(2))).clone();
    assert_eq!(auth["result"], json!(true), "authorize rejected: {auth}");

    let notify = read_until(&mut reader, &mut lines, |v| {
        v.get("method").and_then(|m| m.as_str()) == Some("mining.notify")
    })
    .clone();
    let p = notify["params"].as_array().unwrap().clone();
    let job_id = p[0].as_str().unwrap().to_string();

    // Rebuild the header template from the job and solve it.
    let mut header = BlockHeader {
        version: u32::from_le_bytes(hex4(&p[1])),
        prev_hash: hex32(&p[2]),
        merkle_root: hex32(&p[3]),
        state_root: hex32(&p[4]),
        time: u32::from_le_bytes(hex4(&p[5])),
        bits: u32::from_le_bytes(hex4(&p[6])),
        nonce: [0u8; 32],
        solution: vec![],
    };
    let input = header.equihash_input();

    let mut found: Option<([u8; 16], Vec<u8>)> = None;
    'outer: for n2 in 0u64..8192 {
        let mut nonce2 = [0u8; 16];
        nonce2[..8].copy_from_slice(&n2.to_le_bytes());
        let mut nonce = [0u8; 32];
        nonce[..16].copy_from_slice(&nonce1);
        nonce[16..].copy_from_slice(&nonce2);
        for sol in equihash::solve(&params.equihash, &input, &nonce) {
            header.nonce = nonce;
            header.solution = equihash::pack_solution(&params.equihash, &sol);
            if hash_meets_target(&header.hash(), header.bits, params.pow_limit) {
                found = Some((nonce2, header.solution.clone()));
                break 'outer;
            }
        }
    }
    let (nonce2, solution) = found.expect("found a share");

    writeln!(
        writer,
        "{}",
        json!({"id": 3, "method": "mining.submit",
               "params": [miner_user, job_id, hex::encode(header.time.to_le_bytes()),
                           hex::encode(nonce2), hex::encode(&solution)]})
    )
    .unwrap();

    let resp = read_until(&mut reader, &mut lines, |v| v.get("id") == Some(&json!(3))).clone();
    assert_eq!(resp["result"], json!(true), "submit rejected: {resp}");

    // The block must now be the chain tip.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (chain, _) = node.snapshot();
        if chain.height() == Some(1) {
            break;
        }
        assert!(Instant::now() < deadline, "block never connected");
        thread::sleep(Duration::from_millis(50));
    }
    (datadir, node, pool, miner)
}

#[test]
fn solo_pool_pays_the_finder_directly() {
    let (datadir, node, pool, miner) = run_pool_test("solo", 0);
    let (chain, _) = node.snapshot();
    let coinbase = &chain.blocks[1].transactions[0];
    // Coinbase: 99% to the miner's own address, 1% fee to the pool.
    assert_eq!(coinbase.outputs.len(), 2);
    assert_eq!(coinbase.outputs[0].recipient, miner.address());
    assert_eq!(coinbase.outputs[1].recipient, pool.address());
    let total: u64 = coinbase.outputs.iter().map(|o| o.amount).sum();
    assert_eq!(coinbase.outputs[1].amount, total / 100);
    assert!(chain.balance(&miner.address()) > 0);
    let _ = std::fs::remove_dir_all(&datadir);
}

#[test]
fn pplns_pool_records_a_payout() {
    let (datadir, node, pool, miner) = run_pool_test("pplns", 500);
    let (chain, _) = node.snapshot();
    let coinbase = &chain.blocks[1].transactions[0];
    // PPLNS coinbase pays the pool wallet; the miner is owed via ledger.
    assert_eq!(coinbase.outputs.len(), 1);
    assert_eq!(coinbase.outputs[0].recipient, pool.address());

    let ledger = std::fs::read_to_string(datadir.join("pplns-ledger.jsonl"))
        .expect("ledger written");
    let record: Value = serde_json::from_str(ledger.lines().next().unwrap()).unwrap();
    assert_eq!(record["height"], json!(1));
    assert_eq!(record["fee_bp"], json!(100));
    let entries = record["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0][0].as_str().unwrap(),
        blockle_core::keys::encode_address(&miner.address())
    );
    let owed = entries[0][1].as_u64().unwrap();
    let reward = record["reward"].as_u64().unwrap();
    assert_eq!(owed, reward * 99 / 100);
    let _ = std::fs::remove_dir_all(&datadir);
}
