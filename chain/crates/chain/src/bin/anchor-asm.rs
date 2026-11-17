//! Emit the Blockle Protect anchor-registry bytecode. Default = VM assembly
//! (for `blockle-chain contract deploy anchor.asm`); pass `hex` for raw
//! bytecode hex (for an issuer-key build_deploy).
//! Usage: cargo run -p blockle-chain --bin anchor-asm [hex] > anchor.(asm|hex)
fn main() {
    let hex = std::env::args().nth(1).as_deref() == Some("hex");
    if hex {
        print!("{}", hex::encode(blockle_chain::anchor_registry::anchor_registry_bytecode()));
    } else {
        print!("{}", blockle_chain::anchor_registry::anchor_registry_asm());
    }
}
