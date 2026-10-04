//! Equihash solver and verifier, wire-compatible with the Zcash construction
//! so existing Equihash ASICs and pool tooling work from day 1.
//!
//! For parameters `(n, k)` with collision bit length `c = n / (k + 1)`:
//! - Blake2b personalization: `"ZcashPoW" || n_le32 || k_le32`.
//! - Each Blake2b call has output length `(512 / n) * n / 8` bytes and covers
//!   `512 / n` consecutive puzzle indices; the input is
//!   `input || nonce || le32(index / (512 / n))` and index `i`'s hash is the
//!   `i % (512 / n)`-th `n/8`-byte slice of the output.
//! - A solution is `2^k` distinct indices in `[0, 2^(c+1))` whose hashes XOR
//!   to zero under the collision-tree constraints (first `r·c` bits zero
//!   after round `r`, left branch carries the smaller minimum leaf index).
//! - Solutions serialize as a big-endian bitstream of `(c+1)`-bit indices
//!   (1344 bytes for mainnet's (200, 9)).
//!
//! Collision rounds work at bit granularity, so the classic (200, 9) ASIC
//! parameters are supported alongside small test parameters like (48, 5).

use blake2b_simd::Params as Blake2bParams;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EquihashError {
    #[error("invalid equihash parameters n={0} k={1}")]
    InvalidParams(u32, u32),
    #[error("solution has wrong length")]
    WrongLength,
    #[error("solution indices out of range")]
    IndexOutOfRange,
    #[error("solution indices are not distinct")]
    DuplicateIndices,
    #[error("solution violates index ordering")]
    BadOrdering,
    #[error("collision condition failed at round {0}")]
    CollisionFailure(usize),
}

/// Equihash parameters `(n, k)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    pub n: u32,
    pub k: u32,
}

impl Params {
    pub fn new(n: u32, k: u32) -> Result<Self, EquihashError> {
        let bad = || EquihashError::InvalidParams(n, k);
        if k < 3 || k >= n || n % 8 != 0 || n % (k + 1) != 0 || n > 512 {
            return Err(bad());
        }
        let c = n / (k + 1);
        // Indices must fit u32; bit readers assume segments <= 48 bits.
        if c < 8 || c + 1 >= 32 || 2 * c > 48 {
            return Err(bad());
        }
        Ok(Params { n, k })
    }

    /// Collision bit length per round.
    pub fn collision_bits(&self) -> u32 {
        self.n / (self.k + 1)
    }

    /// Length in bytes of each per-index hash.
    pub fn hash_bytes(&self) -> usize {
        (self.n / 8) as usize
    }

    /// Puzzle indices generated per Blake2b call (Zcash: `512 / n`).
    pub fn indices_per_hash(&self) -> u32 {
        512 / self.n
    }

    /// Total number of puzzle indices: `2^(c+1)`.
    pub fn index_count(&self) -> u32 {
        1u32 << (self.collision_bits() + 1)
    }

    /// Number of indices in a solution: `2^k`.
    pub fn solution_indices(&self) -> usize {
        1usize << self.k
    }

    /// Serialized solution size: `2^k` indices at `c+1` bits each.
    pub fn solution_bytes(&self) -> usize {
        self.solution_indices() * (self.collision_bits() as usize + 1) / 8
    }
}

fn personal(p: &Params) -> [u8; 16] {
    let mut personal = [0u8; 16];
    personal[..8].copy_from_slice(b"ZcashPoW");
    personal[8..12].copy_from_slice(&p.n.to_le_bytes());
    personal[12..16].copy_from_slice(&p.k.to_le_bytes());
    personal
}

/// Hash one Blake2b group; `group = index / indices_per_hash`.
fn generate_group(p: &Params, input: &[u8], nonce: &[u8; 32], group: u32) -> Vec<u8> {
    Blake2bParams::new()
        .hash_length(p.indices_per_hash() as usize * p.hash_bytes())
        .personal(&personal(p))
        .to_state()
        .update(input)
        .update(nonce)
        .update(&group.to_le_bytes())
        .finalize()
        .as_bytes()
        .to_vec()
}

/// The n-bit hash for a single puzzle index.
fn generate_hash(p: &Params, input: &[u8], nonce: &[u8; 32], index: u32) -> Vec<u8> {
    let per = p.indices_per_hash();
    let group = generate_group(p, input, nonce, index / per);
    let off = (index % per) as usize * p.hash_bytes();
    group[off..off + p.hash_bytes()].to_vec()
}

/// Read `nbits` (<= 48) big-endian bits starting at `bit_off`.
fn bits_at(h: &[u8], bit_off: usize, nbits: usize) -> u64 {
    debug_assert!(nbits <= 48);
    let start = bit_off / 8;
    let end = (bit_off + nbits).div_ceil(8);
    let mut v: u64 = 0;
    for &b in &h[start..end] {
        v = (v << 8) | b as u64;
    }
    let drop_right = (end - start) * 8 - (bit_off % 8) - nbits;
    (v >> drop_right) & ((1u64 << nbits) - 1)
}

/// Are the first `nbits` bits of `h` all zero?
fn leading_bits_zero(h: &[u8], nbits: usize) -> bool {
    let full = nbits / 8;
    if h[..full].iter().any(|&b| b != 0) {
        return false;
    }
    let rem = nbits % 8;
    rem == 0 || h[full] >> (8 - rem) == 0
}

/// Pack solution indices as a big-endian bitstream of `c+1`-bit values.
pub fn pack_solution(p: &Params, indices: &[u32]) -> Vec<u8> {
    let bits_per = p.collision_bits() as usize + 1;
    let mut out = Vec::with_capacity(p.solution_bytes());
    let mut acc: u64 = 0;
    let mut acc_bits = 0usize;
    for &i in indices {
        acc = (acc << bits_per) | i as u64;
        acc_bits += bits_per;
        while acc_bits >= 8 {
            out.push((acc >> (acc_bits - 8)) as u8);
            acc_bits -= 8;
        }
    }
    debug_assert_eq!(acc_bits, 0, "solution bit count is a byte multiple");
    out
}

/// Unpack a serialized solution; rejects wrong lengths.
pub fn unpack_solution(p: &Params, solution: &[u8]) -> Result<Vec<u32>, EquihashError> {
    if solution.len() != p.solution_bytes() {
        return Err(EquihashError::WrongLength);
    }
    let bits_per = p.collision_bits() as usize + 1;
    let mut out = Vec::with_capacity(p.solution_indices());
    let mut acc: u64 = 0;
    let mut acc_bits = 0usize;
    for &b in solution {
        acc = (acc << 8) | b as u64;
        acc_bits += 8;
        if acc_bits >= bits_per {
            out.push(((acc >> (acc_bits - bits_per)) & ((1u64 << bits_per) - 1)) as u32);
            acc_bits -= bits_per;
        }
    }
    Ok(out)
}

/// One Wagner row: sort key, hash slot in the current buffer, collision-tree
/// node, and minimum leaf index (for the ordering rule).
struct Row {
    key: u64,
    slot: u32,
    node: u32,
    min_idx: u32,
}

/// Collision tree arena. Leaves are ids `< index_count`; internal node `id`
/// stores its (left, right) children at `arena[id - index_count]`.
struct Arena {
    leaf_count: u32,
    nodes: Vec<(u32, u32)>,
}

impl Arena {
    fn push(&mut self, left: u32, right: u32) -> u32 {
        self.nodes.push((left, right));
        self.leaf_count + self.nodes.len() as u32 - 1
    }

    fn expand(&self, node: u32, out: &mut Vec<u32>) {
        if node < self.leaf_count {
            out.push(node);
        } else {
            let (l, r) = self.nodes[(node - self.leaf_count) as usize];
            self.expand(l, out);
            self.expand(r, out);
        }
    }
}

/// Run Wagner's algorithm for this `(input, nonce)` pair. Returns every
/// distinct valid solution, in canonical index order.
pub fn solve(p: &Params, input: &[u8], nonce: &[u8; 32]) -> Vec<Vec<u32>> {
    let hash_len = p.hash_bytes();
    let c = p.collision_bits() as usize;
    let index_count = p.index_count();

    // Generate all leaf hashes into a flat buffer.
    let mut buf: Vec<u8> = Vec::with_capacity(index_count as usize * hash_len);
    for group in 0..index_count.div_ceil(p.indices_per_hash()) {
        buf.extend_from_slice(&generate_group(p, input, nonce, group));
    }
    let mut rows: Vec<Row> = (0..index_count)
        .map(|i| Row { key: 0, slot: i, node: i, min_idx: i })
        .collect();
    let mut arena = Arena { leaf_count: index_count, nodes: Vec::new() };
    let stride = hash_len;

    // Rounds 0..k-1: collide on c bits, XOR survivors into the next buffer.
    for round in 0..(p.k as usize - 1) {
        let bit_lo = round * c;
        for row in rows.iter_mut() {
            let h = &buf[row.slot as usize * stride..][..stride];
            row.key = bits_at(h, bit_lo, c);
        }
        rows.sort_unstable_by_key(|r| r.key);

        let mut next_rows: Vec<Row> = Vec::with_capacity(rows.len());
        let mut next_buf: Vec<u8> = Vec::with_capacity(buf.len());
        let mut start = 0;
        while start < rows.len() {
            let mut end = start + 1;
            while end < rows.len() && rows[end].key == rows[start].key {
                end += 1;
            }
            for a in start..end {
                for b in (a + 1)..end {
                    let ha = &buf[rows[a].slot as usize * stride..][..stride];
                    let hb = &buf[rows[b].slot as usize * stride..][..stride];
                    let xored: Vec<u8> = ha.iter().zip(hb).map(|(x, y)| x ^ y).collect();
                    // Discard trivial branches that already collapsed to zero
                    // beyond this round's collision segment.
                    if leading_bits_zero(&xored, ((round + 2) * c).min(p.n as usize))
                        && xored[((round + 2) * c).min(p.n as usize) / 8..]
                            .iter()
                            .all(|&v| v == 0)
                    {
                        continue;
                    }
                    let (first, second) = if rows[a].min_idx < rows[b].min_idx {
                        (&rows[a], &rows[b])
                    } else {
                        (&rows[b], &rows[a])
                    };
                    let node = arena.push(first.node, second.node);
                    next_rows.push(Row {
                        key: 0,
                        slot: next_rows.len() as u32,
                        node,
                        min_idx: first.min_idx.min(second.min_idx),
                    });
                    next_buf.extend_from_slice(&xored);
                }
            }
            start = end;
        }
        rows = next_rows;
        buf = next_buf;
    }

    // Final round: rows whose remaining 2c bits match XOR to zero entirely.
    let bit_lo = (p.k as usize - 1) * c;
    for row in rows.iter_mut() {
        let h = &buf[row.slot as usize * stride..][..stride];
        row.key = bits_at(h, bit_lo, 2 * c);
    }
    rows.sort_unstable_by_key(|r| r.key);

    let mut solutions: Vec<Vec<u32>> = Vec::new();
    let mut seen: Vec<Vec<u32>> = Vec::new();
    let mut start = 0;
    while start < rows.len() {
        let mut end = start + 1;
        while end < rows.len() && rows[end].key == rows[start].key {
            end += 1;
        }
        for a in start..end {
            for b in (a + 1)..end {
                let (ra, rb) = (&rows[a], &rows[b]);
                let (first, second) = if ra.min_idx < rb.min_idx { (ra, rb) } else { (rb, ra) };
                let mut indices = Vec::with_capacity(p.solution_indices());
                arena.expand(first.node, &mut indices);
                arena.expand(second.node, &mut indices);
                // Distinctness was not enforced per-round; check now.
                let mut sorted = indices.clone();
                sorted.sort_unstable();
                if sorted.windows(2).any(|w| w[0] == w[1]) {
                    continue;
                }
                if seen.contains(&sorted) {
                    continue;
                }
                if verify(p, input, nonce, &indices).is_ok() {
                    seen.push(sorted);
                    solutions.push(indices);
                }
            }
        }
        start = end;
    }
    solutions
}

/// Verify a solution independently of the solver.
pub fn verify(
    p: &Params,
    input: &[u8],
    nonce: &[u8; 32],
    indices: &[u32],
) -> Result<(), EquihashError> {
    if indices.len() != p.solution_indices() {
        return Err(EquihashError::WrongLength);
    }
    if indices.iter().any(|&i| i >= p.index_count()) {
        return Err(EquihashError::IndexOutOfRange);
    }
    let mut sorted = indices.to_vec();
    sorted.sort_unstable();
    if sorted.windows(2).any(|w| w[0] == w[1]) {
        return Err(EquihashError::DuplicateIndices);
    }

    let c = p.collision_bits() as usize;
    let mut level: Vec<(Vec<u8>, u32)> = indices
        .iter()
        .map(|&i| (generate_hash(p, input, nonce, i), i))
        .collect();

    for round in 0..p.k as usize {
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks_exact(2) {
            let (left, right) = (&pair[0], &pair[1]);
            if left.1 >= right.1 {
                return Err(EquihashError::BadOrdering);
            }
            let xored: Vec<u8> =
                left.0.iter().zip(right.0.iter()).map(|(x, y)| x ^ y).collect();
            let ok = if round == p.k as usize - 1 {
                xored.iter().all(|&v| v == 0)
            } else {
                leading_bits_zero(&xored, (round + 1) * c)
            };
            if !ok {
                return Err(EquihashError::CollisionFailure(round));
            }
            next.push((xored, left.1.min(right.1)));
        }
        level = next;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_params() -> Params {
        Params::new(48, 5).unwrap()
    }

    fn find_solution() -> (Params, Vec<u8>, [u8; 32], Vec<u32>) {
        let p = test_params();
        let input = b"blockle equihash test input".to_vec();
        for n in 0u8..64 {
            let mut nonce = [0u8; 32];
            nonce[0] = n;
            let sols = solve(&p, &input, &nonce);
            if let Some(s) = sols.into_iter().next() {
                return (p, input, nonce, s);
            }
        }
        panic!("no equihash solution found in 64 nonces");
    }

    #[test]
    fn param_validity() {
        assert!(Params::new(200, 9).is_ok()); // mainnet / ASIC params (c=20)
        assert!(Params::new(144, 5).is_ok());
        assert!(Params::new(96, 5).is_ok());
        assert!(Params::new(48, 5).is_ok());
        assert!(Params::new(50, 9).is_err()); // n % 8 != 0
        assert!(Params::new(96, 2).is_err()); // k too small
    }

    #[test]
    fn solution_sizes_match_zcash() {
        assert_eq!(Params::new(200, 9).unwrap().solution_bytes(), 1344);
        assert_eq!(Params::new(144, 5).unwrap().solution_bytes(), 100);
        assert_eq!(Params::new(48, 5).unwrap().solution_bytes(), 36);
    }

    #[test]
    fn bit_reader() {
        let h = [0b1010_1010, 0b1100_0011, 0xff];
        assert_eq!(bits_at(&h, 0, 8), 0b1010_1010);
        assert_eq!(bits_at(&h, 4, 8), 0b1010_1100);
        assert_eq!(bits_at(&h, 7, 3), 0b011);
        assert!(leading_bits_zero(&[0, 0b0000_0111], 13));
        assert!(!leading_bits_zero(&[0, 0b0000_0111], 14));
    }

    #[test]
    fn solve_verify_roundtrip() {
        let (p, input, nonce, sol) = find_solution();
        assert_eq!(sol.len(), p.solution_indices());
        verify(&p, &input, &nonce, &sol).unwrap();
    }

    #[test]
    fn tampered_solution_fails() {
        let (p, input, nonce, mut sol) = find_solution();
        sol[0] ^= 1;
        assert!(verify(&p, &input, &nonce, &sol).is_err());
    }

    #[test]
    fn wrong_input_fails() {
        let (p, _input, nonce, sol) = find_solution();
        assert!(verify(&p, b"different input", &nonce, &sol).is_err());
    }

    #[test]
    fn packing_roundtrip() {
        let (p, _, _, sol) = find_solution();
        let bytes = pack_solution(&p, &sol);
        assert_eq!(bytes.len(), p.solution_bytes());
        assert_eq!(unpack_solution(&p, &bytes).unwrap(), sol);
        assert!(unpack_solution(&p, &bytes[1..]).is_err());
    }
}
