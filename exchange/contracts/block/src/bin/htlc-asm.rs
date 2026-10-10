//! Emit the BLOCK-VM HTLC as VM assembly (`.asm`) with the reserve/treasury fee
//! address baked in, ready for `blockle-chain contract deploy`.
//!
//! The deployed bytecode is `blockle_vm::asm::assemble(htlc_asm(fee_addr, fee_bps))`
//! — the EXACT bytes `htlc_bytecode()` produces and the regtest tests exercise,
//! because `blockle-chain contract deploy <file>.asm` assembles a `.asm` with
//! the very same `blockle_vm::asm::assemble`. Emitting the `.asm` and deploying
//! it is therefore byte-identical to deploying `htlc_bytecode()` directly.
//!
//! Usage (see scripts/deploy.sh):
//!   FEE_ADDR=<32-byte hex> [FEE_BPS=10] cargo run --quiet --bin htlc-asm > htlc.asm
//!
//! FEE_ADDR is the PUBLIC reserve/treasury BLOCK address that receives the 0.1%
//! settlement fee. No private key is ever read here.

use std::env;

use blockle_htlc::{htlc_asm, DEFAULT_FEE_BPS};

fn parse_fee_addr(s: &str) -> [u8; 32] {
    let s = s.trim();
    let s = s.strip_prefix("0x").unwrap_or(s);
    assert_eq!(s.len(), 64, "FEE_ADDR must be 32 bytes (64 hex chars), got {}", s.len());
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .expect("FEE_ADDR must be hex");
    }
    out
}

fn main() {
    let fee_addr = env::var("FEE_ADDR").expect(
        "set FEE_ADDR=<32-byte hex> — the PUBLIC reserve/treasury BLOCK address \
         that receives the 0.1% settlement fee",
    );
    let fee_bps = env::var("FEE_BPS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_FEE_BPS);
    let addr = parse_fee_addr(&fee_addr);
    // no trailing newline so the .asm is exactly what assemble() consumes
    print!("{}", htlc_asm(&addr, fee_bps));
}
