//! Proof-of-work for the Blockle blockchain.
//!
//! Two pieces live here:
//! - [`equihash`]: a memory-hard Equihash implementation (Wagner's algorithm)
//!   used as the PoW puzzle. Blockle defines its own canonical Equihash
//!   construction (Blake2b-personalized, byte-aligned collision rounds); it is
//!   deliberately *not* wire-compatible with Zcash.
//! - [`difficulty`]: Bitcoin-style compact target encoding plus an LWMA
//!   difficulty adjustment that retunes every block.

pub mod difficulty;
pub mod equihash;

pub use primitive_types::U256;
