//! Share ledger and payout accounting.
//!
//! Supported schemes (`pool.scheme`):
//! - **solo**  — the block finder gets the whole reward (minus pool fee).
//! - **pplns** — reward split over the last N shares at find time.
//! - **prop**  — reward split over the shares of the current round
//!   (cleared at each block).
//! - **pps**   — every accepted share earns a fixed expected value
//!   (`share_diff / network_diff × reward`), independent of blocks; the
//!   pool absorbs variance.
//!
//! All attributions are computed and frozen immediately (auditable later).
//! Executing payouts (building payment transactions) is chain-specific and
//! left to the operator.

use std::collections::{HashMap, VecDeque};
use std::time::Instant;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scheme {
    Solo,
    Pplns { window: usize },
    Prop,
    Pps,
}

impl Scheme {
    pub fn parse(name: &str, pplns_window: usize) -> Option<Scheme> {
        match name.to_lowercase().as_str() {
            "solo" => Some(Scheme::Solo),
            "pplns" => Some(Scheme::Pplns { window: pplns_window }),
            "prop" | "proportional" => Some(Scheme::Prop),
            "pps" => Some(Scheme::Pps),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Scheme::Solo => "SOLO",
            Scheme::Pplns { .. } => "PPLNS",
            Scheme::Prop => "PROP",
            Scheme::Pps => "PPS",
        }
    }
}

#[derive(Default, Clone, Serialize)]
pub struct WorkerStats {
    pub accepted: u64,
    pub rejected: u64,
    /// Sum of share difficulties (weight).
    pub weight: f64,
    /// Credited earnings in base units (scheme-dependent).
    pub balance: u64,
}

#[derive(Clone, Serialize)]
pub struct FoundBlock {
    pub chain: String,
    pub height: u64,
    pub hash: String,
    pub finder: String,
    pub reward: u64,
    /// Reward attribution per worker, fixed at find time (empty for PPS —
    /// PPS credits accrue per share instead).
    pub distribution: HashMap<String, u64>,
}

pub struct Ledger {
    scheme: Scheme,
    /// Pool fee in percent (0–100).
    fee_percent: f64,
    pub workers: HashMap<String, WorkerStats>,
    /// PPLNS sliding window / PROP round buffer: (worker, share weight).
    window: VecDeque<(String, f64)>,
    pub blocks: Vec<FoundBlock>,
    pub started: Instant,
    /// Pool-fee + PPS-risk earnings retained by the operator.
    pub pool_balance: u64,
}

impl Ledger {
    pub fn new(scheme: Scheme, fee_percent: f64) -> Self {
        Ledger {
            scheme,
            fee_percent: fee_percent.clamp(0.0, 100.0),
            workers: HashMap::new(),
            window: VecDeque::new(),
            blocks: Vec::new(),
            started: Instant::now(),
            pool_balance: 0,
        }
    }

    pub fn scheme_name(&self) -> &'static str {
        self.scheme.name()
    }

    fn after_fee(&self, reward: u64) -> u64 {
        ((reward as f64) * (1.0 - self.fee_percent / 100.0)) as u64
    }

    /// Record an accepted share. For PPS, `network_difficulty` and
    /// `reward_estimate` convert the share into an immediate credit.
    pub fn accept_share(
        &mut self,
        worker: &str,
        difficulty: f64,
        network_difficulty: f64,
        reward_estimate: u64,
    ) {
        let w = self.workers.entry(worker.to_string()).or_default();
        w.accepted += 1;
        w.weight += difficulty;
        match self.scheme {
            Scheme::Pps => {
                let expected = (reward_estimate as f64 * difficulty
                    / network_difficulty.max(difficulty))
                    as u64;
                let credit = self.after_fee(expected);
                self.workers.get_mut(worker).unwrap().balance += credit;
            }
            Scheme::Pplns { window } => {
                self.window.push_back((worker.to_string(), difficulty));
                while self.window.len() > window {
                    self.window.pop_front();
                }
            }
            Scheme::Prop => {
                self.window.push_back((worker.to_string(), difficulty));
            }
            Scheme::Solo => {}
        }
    }

    pub fn reject_share(&mut self, worker: &str) {
        self.workers.entry(worker.to_string()).or_default().rejected += 1;
    }

    pub fn record_block(&mut self, chain: &str, height: u64, hash: String, finder: &str, reward: u64) {
        let payable = self.after_fee(reward);
        self.pool_balance += reward - payable;
        let distribution: HashMap<String, u64> = match self.scheme {
            Scheme::Solo => HashMap::from([(finder.to_string(), payable)]),
            Scheme::Pps => {
                // PPS: the block belongs to the pool; miners were already
                // credited per share.
                self.pool_balance += payable;
                HashMap::new()
            }
            Scheme::Pplns { .. } | Scheme::Prop => {
                let mut weights: HashMap<String, f64> = HashMap::new();
                for (w, d) in &self.window {
                    *weights.entry(w.clone()).or_default() += d;
                }
                let total: f64 = weights.values().sum();
                let dist: HashMap<String, u64> = if total > 0.0 {
                    weights
                        .into_iter()
                        .map(|(w, d)| (w, ((d / total) * payable as f64) as u64))
                        .collect()
                } else {
                    HashMap::from([(finder.to_string(), payable)])
                };
                if self.scheme == Scheme::Prop {
                    self.window.clear(); // round ends at each block
                }
                dist
            }
        };
        for (w, amt) in &distribution {
            self.workers.entry(w.clone()).or_default().balance += amt;
        }
        self.blocks.push(FoundBlock {
            chain: chain.to_string(),
            height,
            hash,
            finder: finder.to_string(),
            reward,
            distribution,
        });
    }

    /// Total credited per worker.
    pub fn balances(&self) -> HashMap<String, u64> {
        self.workers
            .iter()
            .filter(|(_, w)| w.balance > 0)
            .map(|(k, w)| (k.clone(), w.balance))
            .collect()
    }

    /// Rough pool hashrate estimate from accepted share weight
    /// (difficulty-1 share ≈ 2^32 hashes).
    pub fn hashrate(&self) -> f64 {
        let secs = self.started.elapsed().as_secs_f64().max(1.0);
        let weight: f64 = self.workers.values().map(|w| w.weight).sum();
        weight * 4_294_967_296.0 / secs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solo_pays_the_finder() {
        let mut l = Ledger::new(Scheme::Solo, 1.0);
        l.accept_share("a", 1.0, 1000.0, 50);
        l.accept_share("b", 1.0, 1000.0, 50);
        l.record_block("c", 1, "h".into(), "b", 100_000);
        assert_eq!(l.balances().get("b"), Some(&99_000));
        assert!(l.balances().get("a").is_none());
        assert_eq!(l.pool_balance, 1_000);
    }

    #[test]
    fn pplns_splits_by_weight() {
        let mut l = Ledger::new(Scheme::Pplns { window: 100 }, 0.0);
        l.accept_share("a", 3.0, 1000.0, 0);
        l.accept_share("b", 1.0, 1000.0, 0);
        l.record_block("c", 1, "h".into(), "a", 100);
        let b = l.balances();
        assert_eq!(b.get("a"), Some(&75));
        assert_eq!(b.get("b"), Some(&25));
    }

    #[test]
    fn prop_rounds_reset() {
        let mut l = Ledger::new(Scheme::Prop, 0.0);
        l.accept_share("a", 1.0, 1000.0, 0);
        l.record_block("c", 1, "h".into(), "a", 100);
        // new round: only b contributes
        l.accept_share("b", 1.0, 1000.0, 0);
        l.record_block("c", 2, "h2".into(), "b", 100);
        let b = l.balances();
        assert_eq!(b.get("a"), Some(&100));
        assert_eq!(b.get("b"), Some(&100));
    }

    #[test]
    fn pps_credits_per_share() {
        let mut l = Ledger::new(Scheme::Pps, 0.0);
        // network diff 100, reward 1000 → each diff-1 share worth 10.
        l.accept_share("a", 1.0, 100.0, 1000);
        l.accept_share("a", 1.0, 100.0, 1000);
        assert_eq!(l.balances().get("a"), Some(&20));
        // the found block goes to the pool
        l.record_block("c", 1, "h".into(), "a", 1000);
        assert_eq!(l.pool_balance, 1000);
        assert_eq!(l.balances().get("a"), Some(&20));
    }
}
