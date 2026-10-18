//! Emit USDB (Blockle USD) stablecoin bytecode. Default = VM assembly (for
//! `blockle-chain contract deploy usdb.asm`); pass `hex` for raw bytecode hex
//! (for an issuer-key build_deploy). Name/symbol/decimals baked; supply 0.
//! Usage: cargo run -p blockle-chain --bin usdb-asm [hex] > usdb.(asm|hex)
fn main() {
    let hex = std::env::args().nth(1).as_deref() == Some("hex");
    if hex {
        print!("{}", hex::encode(blockle_chain::stablecoin::stablecoin_bytecode("Blockle USD", "USDB", 6)));
    } else {
        print!("{}", blockle_chain::stablecoin::stablecoin_asm("Blockle USD", "USDB", 6));
    }
}
