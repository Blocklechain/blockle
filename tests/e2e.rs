//! End-to-end: simulated chain → probe → pool engine → external stratum
//! miner → parent block + merged-mined aux block.

use std::time::Duration;

use blockle::adapters::bitcoin::{AuxConfig, BitcoinAdapter};
use blockle::ledger::Scheme;
use blockle::{miner, probe, simchain, stratum};

#[test]
fn pool_mines_parent_and_aux_blocks() {
    let parent = simchain::serve("127.0.0.1:28980", "TestCoin").unwrap();
    let aux = simchain::serve("127.0.0.1:28981", "BLOCK").unwrap();
    std::thread::sleep(Duration::from_millis(200));

    // Interrogation must fully classify the chain.
    let profile = probe::probe("http://127.0.0.1:28980/");
    assert!(profile.ready_for_builtin_adapter(), "probe failed: {:?}", profile.unknowns);
    assert_eq!(profile.algorithm.to_string(), "SHA-256d");

    let adapter = BitcoinAdapter::new(
        "http://127.0.0.1:28980/",
        "TestCoin",
        "SHA-256d",
        profile.field_map.clone().unwrap(),
        vec![0x51],
        vec![AuxConfig {
            name: "BLOCK".into(),
            rpc: "http://127.0.0.1:28981/".into(),
            chain_id: 1,
            create_method: "createauxblock".into(),
            submit_method: "submitauxblock".into(),
            payout_address: String::new(),
            algorithm: String::new(),
        }],
    );
    let engine = stratum::Engine::new(
        Box::new(adapter),
        "127.0.0.1:23334",
        Scheme::Pplns { window: 1000 },
        1.0,
        "sha256d",
    );
    engine.start().unwrap();
    std::thread::sleep(Duration::from_millis(500));

    let report = miner::mine("127.0.0.1:23334", "tester", 3, Duration::from_secs(60)).unwrap();
    assert!(report.shares_accepted >= 3);

    std::thread::sleep(Duration::from_millis(300));
    assert!(parent.height() >= 1, "no parent block mined");
    assert!(aux.height() >= 1, "no merged-mined aux block");
    let ledger = engine.ledger.lock().unwrap();
    assert!(ledger.blocks.iter().any(|b| b.chain == "TestCoin"));
    assert!(ledger.blocks.iter().any(|b| b.chain == "BLOCK"));
    assert!(!ledger.balances().is_empty());
}
