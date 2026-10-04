//! Blockle — the universal deployment system for PoW mining pools.
//! Library crate shared by the `blockle` CLI and the `blockle-biz`
//! directory/monitoring server.

pub mod adapter;
pub mod adapters;
pub mod biz;
pub mod btc;
pub mod config;
pub mod dashboard;
pub mod discover;
pub mod genadapter;
pub mod http;
pub mod ledger;
pub mod miner;
pub mod probe;
pub mod rpc;
pub mod simchain;
pub mod stratum;
