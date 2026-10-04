//! Blockle node library: storage, P2P networking, and the stratum server.
//! The `blockle` binary (main.rs) is a CLI over these pieces.

pub mod httpc;
pub mod p2p;
pub mod storage;
pub mod stratum;
