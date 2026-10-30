//! Blockle Intelligence — deterministic incentive mechanism (EmissionEpoch core).
//!
//! CONSENSUS-CRITICAL: every node must compute identical results, so this uses ONLY
//! integer / fixed-point arithmetic (u128). No floats — IEEE rounding differences
//! could split the chain. Weights and shares are fixed-point with denominator SCALE;
//! stakes and emission are integer base units (micro-BLOCK). Ported from the
//! Phase-1 reference simulation (scripts/intel_sim.py), §5 of BLOCKLE-INTELLIGENCE.md.

pub const SCALE: u128 = 1_000_000; // 6-dp fixed point for weights/shares

/// Stake-weighted median clip (Yuma). `w[i][j]` ∈ [0,SCALE] is validator i's weight on
/// miner j; `s[i]` is validator i's stake. For each miner j, Ĉ_j is the weight at which
/// cumulative stake (validators sorted by weight desc) first reaches `kappa` of total
/// stake; clipped weight = min(w, Ĉ_j). A sub-kappa minority cannot inflate a miner.
/// `kappa` is fixed-point (e.g. SCALE/2 = 50%). Deterministic: stable sort with a tie
/// break on validator index.
pub fn consensus_clip(w: &[Vec<u128>], s: &[u128], kappa: u128) -> Vec<Vec<u128>> {
    let nv = s.len();
    let nm = if nv > 0 { w[0].len() } else { 0 };
    let total: u128 = s.iter().copied().sum();
    let thresh = total.saturating_mul(kappa) / SCALE;
    let mut clip = vec![0u128; nm];
    for j in 0..nm {
        // (weight, stake, idx) sorted by weight desc, idx asc for determinism
        let mut pairs: Vec<(u128, u128, usize)> = (0..nv).map(|i| (w[i][j], s[i], i)).collect();
        pairs.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)));
        let mut acc = 0u128;
        for (wv, sv, _) in pairs {
            acc += sv;
            if acc >= thresh {
                clip[j] = wv;
                break;
            }
        }
    }
    (0..nv)
        .map(|i| (0..nm).map(|j| w[i][j].min(clip[j])).collect())
        .collect()
}

/// Rank R_j = Σ_i s_i · w̄_ij  (u128; fits: stake ~1e14 × weight ~1e6 × vals ~1e4 ≈ 1e24).
pub fn ranks(wbar: &[Vec<u128>], s: &[u128]) -> Vec<u128> {
    let nv = s.len();
    let nm = if nv > 0 { wbar[0].len() } else { 0 };
    (0..nm)
        .map(|j| (0..nv).map(|i| s[i].saturating_mul(wbar[i][j])).sum())
        .collect()
}

/// Normalize a vector to fixed-point shares summing to ~SCALE (integer division; the
/// tiny rounding remainder is handled by the caller assigning it to the top element).
pub fn shares(x: &[u128]) -> Vec<u128> {
    let t: u128 = x.iter().copied().sum();
    if t == 0 {
        return vec![0u128; x.len()];
    }
    x.iter().map(|&v| v.saturating_mul(SCALE) / t).collect()
}

/// EMA bonds: B_ij = (lam·B_prev + (SCALE−lam)·s_i·w̄_ij) / SCALE, then column-normalized
/// to SCALE (each miner's bonds sum to SCALE across validators). `lam` fixed-point.
pub fn update_bonds(bprev: &[Vec<u128>], wbar: &[Vec<u128>], s: &[u128], lam: u128) -> Vec<Vec<u128>> {
    let nv = s.len();
    let nm = if nv > 0 { wbar[0].len() } else { 0 };
    let mut b: Vec<Vec<u128>> = (0..nv)
        .map(|i| {
            (0..nm)
                .map(|j| {
                    let decay = lam.saturating_mul(bprev[i][j]) / SCALE;
                    let fresh = (SCALE - lam).saturating_mul(s[i].saturating_mul(wbar[i][j]) / SCALE) / SCALE;
                    decay + fresh
                })
                .collect()
        })
        .collect();
    for j in 0..nm {
        let col: u128 = (0..nv).map(|i| b[i][j]).sum();
        if col > 0 {
            for i in 0..nv {
                b[i][j] = b[i][j].saturating_mul(SCALE) / col;
            }
        }
    }
    b
}

/// Dividends D_i = Σ_j B_ij · I_j / SCALE  (I = incentive shares).
pub fn dividends(b: &[Vec<u128>], incentive: &[u128]) -> Vec<u128> {
    let nv = b.len();
    let nm = incentive.len();
    (0..nv)
        .map(|i| (0..nm).map(|j| b[i][j].saturating_mul(incentive[j]) / SCALE).sum())
        .collect()
}

/// One EmissionEpoch: given raw weights, stakes, the epoch emission pool (base units)
/// and the miner/validator split, return (miner_emission, validator_emission) in base
/// units. `active` zeroes out validators that failed proof-of-validation (their weights
/// are ignored this epoch). Deterministic end-to-end.
pub fn emission_epoch(
    w: &[Vec<u128>],
    s: &[u128],
    active: &[bool],
    bonds_prev: &[Vec<u128>],
    pool: u128,
    miner_frac: u128, // fixed-point
    kappa: u128,
    lam: u128,
) -> (Vec<u128>, Vec<u128>, Vec<Vec<u128>>) {
    let nv = s.len();
    let s_use: Vec<u128> = (0..nv).map(|i| if active[i] { s[i] } else { 0 }).collect();
    let wbar = consensus_clip(w, &s_use, kappa);
    let r = ranks(&wbar, &s_use);
    let incentive = shares(&r);
    let bonds = update_bonds(bonds_prev, &wbar, &s_use, lam);
    let div = shares(&dividends(&bonds, &incentive));
    let miner_pool = pool.saturating_mul(miner_frac) / SCALE;
    let val_pool = pool - miner_pool;
    let miner_em: Vec<u128> = incentive.iter().map(|&i| miner_pool.saturating_mul(i) / SCALE).collect();
    let val_em: Vec<u128> = div.iter().map(|&d| val_pool.saturating_mul(d) / SCALE).collect();
    (miner_em, val_em, bonds)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: weight row from quality (fixed-point).
    fn q(v: f64) -> u128 { (v * SCALE as f64) as u128 }

    #[test]
    fn incentive_tracks_quality() {
        // 3 miners: good, mediocre, bad. 4 honest validators weight by quality.
        let w = vec![
            vec![q(0.9), q(0.5), q(0.1)],
            vec![q(0.88), q(0.52), q(0.12)],
            vec![q(0.91), q(0.48), q(0.08)],
            vec![q(0.9), q(0.5), q(0.1)],
        ];
        let s = vec![100u128, 100, 100, 100];
        let active = vec![true; 4];
        let bonds = vec![vec![0u128; 3]; 4];
        let (mem, _ve, _b) = emission_epoch(&w, &s, &active, &bonds, 1_000_000, SCALE / 2, SCALE / 2, 900_000);
        assert!(mem[0] > mem[1] && mem[1] > mem[2], "good>mediocre>bad: {:?}", mem);
    }

    #[test]
    fn clipping_caps_minority_cartel() {
        // 3 honest validators (stake 100) weight a bad miner ~0.1; a 1-validator cartel
        // with HIGH stake (but still minority <50%) dumps 1.0 on the bad miner.
        // miner 0 = good, miner 1 = bad (the pump target).
        let w = vec![
            vec![q(0.9), q(0.1)], // honest
            vec![q(0.9), q(0.1)], // honest
            vec![q(0.9), q(0.1)], // honest
            vec![q(0.0), q(1.0)], // cartel: dumps on bad miner 1
        ];
        // honest 3×100=300, cartel 1×250 -> cartel = 250/550 = 45% (minority)
        let s = vec![100u128, 100, 100, 250];
        // raw ranks
        let r_raw = shares(&ranks(&w, &s));
        // clipped ranks
        let wbar = consensus_clip(&w, &s, SCALE / 2);
        let r_clip = shares(&ranks(&wbar, &s));
        // the bad miner's share must DROP under clipping
        assert!(r_clip[1] < r_raw[1], "clip should cut bad miner: raw={} clip={}", r_raw[1], r_clip[1]);
        // and the good miner's share must RISE
        assert!(r_clip[0] > r_raw[0], "clip should lift good miner: raw={} clip={}", r_raw[0], r_clip[0]);
    }

    #[test]
    fn inactive_validators_are_ignored() {
        // a validator that failed proof-of-validation (active=false) must not influence.
        let w = vec![vec![q(0.1), q(0.9)], vec![q(1.0), q(0.0)]];
        let s = vec![100u128, 100];
        let active_all = vec![true, true];
        let active_one = vec![true, false]; // 2nd validator slashed/ignored
        let bonds = vec![vec![0u128; 2]; 2];
        let (a, _, _) = emission_epoch(&w, &s, &active_all, &bonds, 1_000_000, SCALE / 2, SCALE / 2, 900_000);
        let (b, _, _) = emission_epoch(&w, &s, &active_one, &bonds, 1_000_000, SCALE / 2, SCALE / 2, 900_000);
        // with validator 2 ignored, miner 1 (which only v1 liked) should get MORE
        assert!(b[1] > a[1], "ignoring the dishonest validator should change the outcome: {:?} vs {:?}", a, b);
    }

    #[test]
    fn emission_conserves_budget() {
        let w = vec![vec![q(0.8), q(0.4)], vec![q(0.7), q(0.5)]];
        let s = vec![100u128, 100];
        let active = vec![true; 2];
        let bonds = vec![vec![0u128; 2]; 2];
        let pool = 1_000_000u128;
        let (mem, vem, _) = emission_epoch(&w, &s, &active, &bonds, pool, SCALE / 2, SCALE / 2, 900_000);
        let spent: u128 = mem.iter().sum::<u128>() + vem.iter().sum::<u128>();
        // integer rounding leaves a tiny dust remainder; must never OVER-spend
        assert!(spent <= pool, "never over-spend: spent={} pool={}", spent, pool);
        assert!(pool - spent < 100, "dust remainder small: {}", pool - spent);
    }
}
