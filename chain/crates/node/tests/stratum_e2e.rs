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

#[test]
fn stratum_miner_finds_a_block() {
    let params = ChainParams::regtest();
    let datadir = std::env::temp_dir().join(format!("blockle-stratum-{}", process::id()));
    let _ = std::fs::remove_dir_all(&datadir);

    // Genesis on disk.
    let kp = Keypair::generate();
    let mut chain = Chain::new(params.clone());
    let (genesis, _) = mine_block(&chain, kp.address(), &[]).unwrap();
    chain.connect_block(genesis.clone()).unwrap();
    storage::append_block(&datadir, &genesis).unwrap();

    // Node with stratum, no local miner.
    let p2p_port = 21000 + (process::id() % 2000) as u16;
    let stratum_addr = format!("127.0.0.1:{}", p2p_port + 1);
    let node = p2p::Node::new(
        p2p::NodeConfig {
            datadir: datadir.clone(),
            params: params.clone(),
            listen: format!("127.0.0.1:{p2p_port}"),
            connect: vec![],
            mine_to: Some(kp.address()),
            local_mine: false,
            mine_blocks: None,
            mine_interval: None,
            stratum: Some(stratum_addr.clone()),
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

    writeln!(
        writer,
        "{}",
        json!({"id": 1, "method": "mining.subscribe", "params": ["blockle-test/1.0", null]})
    )
    .unwrap();
    writeln!(
        writer,
        "{}",
        json!({"id": 2, "method": "mining.authorize", "params": ["worker1", "x"]})
    )
    .unwrap();

    let sub = read_until(&mut reader, &mut lines, |v| v.get("id") == Some(&json!(1))).clone();
    let nonce1: Vec<u8> = hex::decode(sub["result"][1].as_str().unwrap()).unwrap();
    assert_eq!(nonce1.len(), 16);

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
    'outer: for n2 in 0u64..4096 {
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
               "params": ["worker1", job_id, hex::encode(header.time.to_le_bytes()),
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
    let _ = std::fs::remove_dir_all(&datadir);
}
