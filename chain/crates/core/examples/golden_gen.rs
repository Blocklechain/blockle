//! One-off generator for the golden-vector test constants.
use blockle_core::*;

fn main() {
    let tx = Transaction {
        version: 1,
        inputs: vec![TxInput {
            prev: OutPoint { txid: [0x11; 32], vout: 3 },
            pubkey: vec![0x22; 8],
            signature: vec![0x33; 4],
        }],
        outputs: vec![TxOutput { recipient: [0x44; 32], amount: 123_456_789 }],
        coinbase_data: vec![],
        shielded: Some(ShieldedBundle {
            spends: vec![ShieldedSpend {
                anchor: [0x55; 32],
                nullifier: [0x66; 32],
                value: 42,
                proof: vec![0x77; 5],
            }],
            outputs: vec![ShieldedOutput { commitment: [0x88; 32], value: 7 }],
            transfers: vec![ShieldedTransfer {
                anchor: [0x99; 32],
                nullifier: [0xaa; 32],
                commitment1: [0xbb; 32],
                commitment2: [0xcc; 32],
                fee: 9,
                memo: vec![0xdd; 3],
                proof: vec![0xee; 6],
            }],
        }),
        contract: Some(ContractAction::Call {
            contract: [0xff; 32],
            input: vec![1, 2, 3],
            value: 55,
            gas_limit: 1000,
        }),
        settlement: None,
    };
    println!("txid:    {}", hex::encode(tx.txid()));
    println!("sighash: {}", hex::encode(tx.sighash()));
    println!("size:    {}", tx.serialized_size());

    let header = BlockHeader {
        version: 1,
        prev_hash: [0x01; 32],
        merkle_root: [0x02; 32],
        state_root: [0x00; 32],
        time: 1_790_000_000,
        bits: 0x207fffff,
        nonce: [0x03; 32],
        solution: vec![0x04; 36],
    };
    println!("header_ser_len: {}", header.serialize().len());
    println!("header_hash: {}", hex::encode(header.hash()));
    let cb = Transaction::coinbase(5, [0x09; 32], 50, b"Blockle");
    println!("coinbase_txid: {}", hex::encode(cb.txid()));
}
