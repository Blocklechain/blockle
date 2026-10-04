//! Direct per-algorithm BLOCK pool, end to end over real sockets: a
//! sha256d "ASIC" speaks bitcoin stratum v1, grinds the synthetic parent
//! header, and its share becomes a real merged BLOCK block paying the
//! miner's own address in the coinbase.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_core::keys::{encode_address, Keypair};
use blockle_core::sha256d;
use blockle_node::stratum::{PoolMode, PoolOpts};
use blockle_node::{p2p, storage, stratum_btc};
use blockle_pow::difficulty::{compact_to_target, hash_meets_target};

fn read_until<'a>(
    reader: &mut BufReader<TcpStream>,
    lines: &'a mut Vec<Value>,
    pred: impl Fn(&Value) -> bool,
) -> &'a Value {
    loop {
        if let Some(v) = lines.iter().position(|v| pred(v)) {
            return &lines[v];
        }
        let mut line = String::new();
        reader.read_line(&mut line).expect("stratum line");
        if line.trim().is_empty() {
            continue;
        }
        lines.push(serde_json::from_str(&line).expect("json line"));
    }
}

#[test]
fn sha256d_asic_mines_block_directly() {
    let params = ChainParams::regtest();
    let datadir = std::env::temp_dir().join(format!("blockle-direct-{}", process::id()));
    let _ = std::fs::remove_dir_all(&datadir);

    let pool = Keypair::generate();
    let miner = Keypair::generate();
    let mut chain = Chain::new(params.clone());
    let (genesis, _) = mine_block(&chain, pool.address(), &[]).unwrap();
    chain.connect_block(genesis.clone()).unwrap();
    storage::append_block(&datadir, &genesis).unwrap();

    let p2p_port = 24000 + (process::id() % 1500) as u16;
    let direct_addr = format!("127.0.0.1:{}", p2p_port + 1);
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
            pools: vec![],
        },
        chain,
        vec![],
    );
    {
        let node = node.clone();
        thread::spawn(move || node.run().unwrap());
    }
    stratum_btc::serve(
        node.clone(),
        direct_addr.clone(),
        "sha256d",
        PoolOpts {
            mode: PoolMode::Solo,
            fee_bp: 100,
            window: 1000,
            pool_address: pool.address(),
            stats_path: None,
            ledger_path: None,
            endpoint: direct_addr.clone(),
        },
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    let stream = loop {
        match TcpStream::connect(&direct_addr) {
            Ok(s) => break s,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            Err(e) => panic!("cannot reach direct pool: {e}"),
        }
    };
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    let mut lines: Vec<Value> = Vec::new();
    let user = encode_address(&miner.address());

    writeln!(
        writer,
        "{}",
        json!({"id": 1, "method": "mining.subscribe", "params": ["cgminer/4.0", null]})
    )
    .unwrap();
    writeln!(
        writer,
        "{}",
        json!({"id": 2, "method": "mining.authorize", "params": [user, "x"]})
    )
    .unwrap();
    let sub = read_until(&mut reader, &mut lines, |v| v.get("id") == Some(&json!(1))).clone();
    let en1: Vec<u8> = hex::decode(sub["result"][1].as_str().unwrap()).unwrap();
    assert_eq!(en1.len(), 4);
    let notify = read_until(&mut reader, &mut lines, |v| {
        v.get("method").and_then(|m| m.as_str()) == Some("mining.notify")
    })
    .clone();
    let p = notify["params"].as_array().unwrap().clone();
    let job_id = p[0].as_str().unwrap().to_string();
    let coinb1 = hex::decode(p[2].as_str().unwrap()).unwrap();
    let coinb2 = hex::decode(p[3].as_str().unwrap()).unwrap();
    let version = u32::from_str_radix(p[5].as_str().unwrap(), 16).unwrap();
    let nbits = u32::from_str_radix(p[6].as_str().unwrap(), 16).unwrap();
    let ntime = u32::from_str_radix(p[7].as_str().unwrap(), 16).unwrap();

    // Grind like an ASIC would: fixed extranonce2, roll the header nonce.
    let en2 = [0u8; 4];
    let mut coinbase = Vec::new();
    coinbase.extend_from_slice(&coinb1);
    coinbase.extend_from_slice(&en1);
    coinbase.extend_from_slice(&en2);
    coinbase.extend_from_slice(&coinb2);
    let merkle = sha256d(&coinbase);
    let mut header = [0u8; 80];
    header[0..4].copy_from_slice(&version.to_le_bytes());
    header[36..68].copy_from_slice(&merkle);
    header[68..72].copy_from_slice(&ntime.to_le_bytes());
    header[72..76].copy_from_slice(&nbits.to_le_bytes());
    let limit = compact_to_target(nbits).unwrap();
    let nonce = (0u32..)
        .find(|n| {
            header[76..80].copy_from_slice(&n.to_le_bytes());
            hash_meets_target(&sha256d(&header), nbits, limit)
        })
        .expect("regtest target reachable");

    writeln!(
        writer,
        "{}",
        json!({"id": 3, "method": "mining.submit",
               "params": [user, job_id, hex::encode(en2),
                           format!("{ntime:08x}"), format!("{nonce:08x}")]})
    )
    .unwrap();
    let resp = read_until(&mut reader, &mut lines, |v| v.get("id") == Some(&json!(3))).clone();
    assert_eq!(resp["result"], json!(true), "submit rejected: {resp}");

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (chain, _) = node.snapshot();
        if chain.height() == Some(1) {
            // The merged block is on the sha256d lane and pays the miner.
            let b = chain.blocks.last().unwrap();
            assert_eq!(Chain::lane_of(b), "sha256d");
            let cb = &b.transactions[0];
            assert_eq!(cb.outputs[0].recipient, miner.address());
            assert_eq!(cb.outputs[1].recipient, pool.address());
            let total: u64 = cb.outputs.iter().map(|o| o.amount).sum();
            assert_eq!(cb.outputs[1].amount, total / 100);
            break;
        }
        assert!(Instant::now() < deadline, "merged block never connected");
        thread::sleep(Duration::from_millis(50));
    }
    let _ = std::fs::remove_dir_all(&datadir);
}
