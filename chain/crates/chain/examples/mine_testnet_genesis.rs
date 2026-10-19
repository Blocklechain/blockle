// Mine the fixed testnet genesis block (one-time), paying the premine to a fresh
// testnet dev wallet. Prints the embeddable Option<Block> JSON on stdout and the
// wallet + hash on stderr. testnet uses Equihash (48,5) + a generous pow_limit,
// so this solves on CPU in seconds.
use blockle_chain::{mine_block, Chain, ChainParams};
use blockle_core::{display_hash, encode_address, Keypair};

fn main() {
    let kp = Keypair::generate();
    let chain = Chain::new(ChainParams::testnet());
    let (genesis, _) = mine_block(&chain, kp.address(), &[]).expect("mine testnet genesis");
    eprintln!("ADDR   {}", encode_address(&kp.address()));
    eprintln!("SECRET {}", hex::encode(kp.secret_bytes()));
    eprintln!("PUBLIC {}", hex::encode(kp.public_bytes()));
    eprintln!("HASH   {}", display_hash(&genesis.header.hash()));
    println!("{}", serde_json::to_string(&Some(genesis)).expect("serialize genesis"));
}
