//! Chain adapters. `bitcoin` covers the whole bitcoind-RPC family —
//! including forks with renamed template fields, via the manifest-driven
//! [`bitcoin::FieldMap`]. New families implement [`crate::adapter::PoolAdapter`].

pub mod bitcoin;
