//! Golden vectors locking the consensus wire format.
//!
//! These constants pin the canonical encoding of transactions and headers.
//! If any of these tests fail, the consensus serialization changed — which
//! is a HARD FORK. Do that deliberately or not at all.

use blockle_core::*;

fn reference_tx() -> Transaction {
    Transaction {
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
    }
}

#[test]
fn transaction_encoding_is_frozen() {
    let tx = reference_tx();
    assert_eq!(
        hex::encode(tx.txid()),
        "9a0994ef35a39f5be04c199692ba8d35e3975b63f281f9c5d96bd666a6d91d6e"
    );
    assert_eq!(
        hex::encode(tx.sighash()),
        "73351fa2efb03bd066754422c8c93abd3c66e8aa8ef0e4feadd4af48e7aac97c"
    );
    assert_eq!(tx.serialized_size(), 461);
}

#[test]
fn header_encoding_is_frozen() {
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
    // 140-byte fixed region + 1-byte compactsize + 36-byte solution.
    assert_eq!(header.serialize().len(), 177);
    assert_eq!(
        hex::encode(header.hash()),
        "884a5b81c916ace19ceda40e796667a338068466ea3b85c75e232c67642f62b2"
    );
}

#[test]
fn coinbase_encoding_is_frozen() {
    let cb = Transaction::coinbase(5, [0x09; 32], 50, b"Blockle");
    assert_eq!(
        hex::encode(cb.txid()),
        "2f10041663de3aea68d54b58d0895a7ca75540a2ebf74939880e77bf47fb1715"
    );
}
