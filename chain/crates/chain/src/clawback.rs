//! Alienbeing LLC clawback authority: 2-of-2 post-quantum, rate-limited.
//!
//! Blockle is the intellectual property of Alienbeing LLC, which reserves the
//! right to recover BLOCK. This module is the mechanism, and its design is
//! shaped by one assumption: **the authority keys will eventually leak.** Every
//! constraint below exists so that the day they do is survivable rather than
//! terminal.
//!
//! # The three constraints
//!
//! 1. **2-of-2 signatures.** Two independent ML-DSA-44 keys, both required,
//!    held in different places. One breach authorises nothing.
//!
//!    This is what "2FA" has to become inside consensus. A TOTP code cannot be
//!    verified by a node: the nodes share no secret with an authenticator, the
//!    code is time-dependent (nodes re-validate historical blocks years later),
//!    and it is replayable by anyone who observes it once. Two signatures give
//!    the same property — two things you must have — and every node can check
//!    them from the block alone.
//!
//! 2. **A rolling cap: [`MAX_PER_WINDOW`] per [`WINDOW_SECS`].** The reason this
//!    matters more than it looks: a leak is no longer unbounded loss. An
//!    attacker with both keys can take at most the cap before the window
//!    closes, which leaves time to notice and ship new authority addresses.
//!    Without the cap, a leak is one transaction and the whole chain.
//!
//! 3. **A strictly increasing nonce.** A clawback transaction is a bearer
//!    instrument: anyone who sees it holds two valid signatures. The nonce means
//!    a captured transaction cannot be replayed.
//!
//! # Why the window is median-time-past, not a block count
//!
//! Measured spacing on mainnet is ~16.4 s/block, so seven days is ~36,900
//! blocks *today*. Spacing is a function of hashrate: if it doubles, a
//! height-based window becomes a 3.5-day window and the cap silently doubles in
//! rate. MTP is monotonic, already consensus-critical here (`TimeTooOld`), and
//! bounded against miner manipulation — so the limit keeps meaning seven days.
//!
//! # What this module is not
//!
//! It is not an issuance mechanism. A clawback MOVES existing outputs; it
//! cannot create BLOCK, cannot exceed what the named outputs hold, and cannot
//! touch the emission schedule. The worst a fully compromised authority can do
//! is relocate up to the cap of already-existing coins per window.

use blockle_core::keys::{pubkey_to_address, verify_signature, Address};
use blockle_core::transaction::OutPoint;

/// Rolling cap, in base units: 100,000 BLOCK per window.
pub const MAX_PER_WINDOW: u64 = 10_000_000_000_000;

/// Window length in seconds (7 days), measured against median-time-past.
pub const WINDOW_SECS: u64 = 7 * 24 * 60 * 60;

/// Domain separator. Signing is over this tag plus the canonical payload, so a
/// signature made for a clawback can never be replayed as any other message
/// this chain's keys sign, and vice versa.
pub const SIG_TAG: &[u8] = b"blockle-clawback-v1";

/// One exercised clawback, retained to enforce the rolling cap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClawbackRecord {
    /// Median-time-past of the block that included it.
    pub mtp: u64,
    pub amount: u64,
    pub nonce: u64,
}

/// Consensus state for the authority. Lives in `Chain`, serialized with it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClawbackState {
    /// Highest nonce ever accepted. The next must be strictly greater.
    pub last_nonce: u64,
    /// Exercised clawbacks, pruned once outside the window.
    pub history: Vec<ClawbackRecord>,
}

impl ClawbackState {
    /// Total clawed back within the window ending at `mtp`.
    pub fn spent_in_window(&self, mtp: u64) -> u64 {
        let floor = mtp.saturating_sub(WINDOW_SECS);
        self.history
            .iter()
            .filter(|r| r.mtp > floor)
            .fold(0u64, |a, r| a.saturating_add(r.amount))
    }

    /// Remaining allowance at `mtp`.
    pub fn remaining_in_window(&self, mtp: u64) -> u64 {
        MAX_PER_WINDOW.saturating_sub(self.spent_in_window(mtp))
    }

    /// Record an accepted clawback and drop entries that can no longer count.
    pub fn record(&mut self, mtp: u64, amount: u64, nonce: u64) {
        self.history.push(ClawbackRecord { mtp, amount, nonce });
        let floor = mtp.saturating_sub(WINDOW_SECS);
        self.history.retain(|r| r.mtp > floor);
        if nonce > self.last_nonce {
            self.last_nonce = nonce;
        }
    }
}

/// The authorisation carried by a clawback transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClawbackAuth {
    /// Outputs to move. Must be unspent.
    pub outpoints: Vec<OutPoint>,
    /// Where they go.
    pub dest: Address,
    /// Strictly greater than the last accepted nonce.
    pub nonce: u64,
    /// Public keys, in the same order as `params.clawback_authority`.
    pub pubkeys: [Vec<u8>; 2],
    /// Signatures over [`signing_payload`], same order.
    pub sigs: [Vec<u8>; 2],
}

/// The exact bytes both factors sign.
///
/// Canonical and unambiguous: every field is length-prefixed or fixed-width, so
/// two different authorisations can never produce the same payload. Without
/// that, a signature over one clawback could be valid for another with the
/// fields re-split.
pub fn signing_payload(outpoints: &[OutPoint], dest: &Address, nonce: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(SIG_TAG.len() + 8 + 32 + outpoints.len() * 36 + 8);
    v.extend_from_slice(SIG_TAG);
    v.extend_from_slice(&nonce.to_be_bytes());
    v.extend_from_slice(dest);
    v.extend_from_slice(&(outpoints.len() as u64).to_be_bytes());
    for o in outpoints {
        v.extend_from_slice(&o.txid);
        v.extend_from_slice(&o.vout.to_be_bytes());
    }
    v
}

/// Decode the two bech32 authority addresses from params.
///
/// Params holds them as bech32 so a human reviewing a diff can check them; this
/// turns them into the raw addresses consensus compares against. An empty or
/// malformed entry means the authority is not configured for this network,
/// which must REFUSE rather than fall back to a zero address — a zero address
/// would be an authority nobody holds the key to, and `pubkey_to_address` can
/// never produce it, so the failure would look like a bad signature instead of
/// a misconfiguration.
pub fn authority_from(bech32: &[&str; 2]) -> Result<[Address; 2], String> {
    let mut out = [[0u8; 32]; 2];
    for i in 0..2 {
        if bech32[i].is_empty() {
            return Err(format!("clawback authority {i} is not configured on this network"));
        }
        out[i] = blockle_core::keys::decode_address(bech32[i])
            .map_err(|e| format!("clawback authority {i} is not a valid address: {e:?}"))?;
    }
    if out[0] == out[1] {
        return Err("clawback authority slots hold the same address; 2-of-2 needs two".into());
    }
    Ok(out)
}

/// Why a clawback was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClawbackError {
    NotActivated { height: u64, activates: u64 },
    NoOutpoints,
    /// A public key does not hash to the authority address at that index.
    WrongAuthority { index: usize },
    /// Both factors presented the same key — one key is not two factors.
    DuplicateFactor,
    BadSignature { index: usize },
    /// Replay, or a nonce that did not advance.
    StaleNonce { got: u64, last: u64 },
    /// An output is missing or already spent.
    UnknownOutpoint(OutPoint),
    /// The same output listed twice, which would double-count against the cap.
    DuplicateOutpoint(OutPoint),
    /// Over the rolling cap.
    RateLimited { requested: u64, remaining: u64, window_secs: u64 },
}

impl std::fmt::Display for ClawbackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotActivated { height, activates } =>
                write!(f, "clawback not active at height {height} (activates {activates})"),
            Self::NoOutpoints => write!(f, "clawback names no outputs"),
            Self::WrongAuthority { index } =>
                write!(f, "clawback factor {index} is not an authority key"),
            Self::DuplicateFactor =>
                write!(f, "clawback presented the same key twice; 2-of-2 needs two distinct keys"),
            Self::BadSignature { index } =>
                write!(f, "clawback factor {index} signature is invalid"),
            Self::StaleNonce { got, last } =>
                write!(f, "clawback nonce {got} must exceed {last}"),
            Self::UnknownOutpoint(o) =>
                write!(f, "clawback names an unspent-set miss: {}:{}", hex::encode(o.txid), o.vout),
            Self::DuplicateOutpoint(o) =>
                write!(f, "clawback lists {}:{} twice", hex::encode(o.txid), o.vout),
            Self::RateLimited { requested, remaining, window_secs } =>
                write!(f, "clawback of {requested} exceeds {remaining} remaining in the {window_secs}s window"),
        }
    }
}

/// Validate an authorisation. Pure: no state is changed, so the caller decides
/// when to commit.
///
/// `amount_of` resolves an outpoint to its value, returning `None` if it is not
/// in the unspent set. `mtp` is the including block's median-time-past.
#[allow(clippy::too_many_arguments)]
pub fn validate(
    auth: &ClawbackAuth,
    state: &ClawbackState,
    authority: &[Address; 2],
    height: u64,
    activation_height: u64,
    mtp: u64,
    amount_of: &dyn Fn(&OutPoint) -> Option<u64>,
) -> Result<u64, ClawbackError> {
    if height < activation_height {
        return Err(ClawbackError::NotActivated { height, activates: activation_height });
    }
    if auth.outpoints.is_empty() {
        return Err(ClawbackError::NoOutpoints);
    }

    // -- authority: each key must hash to the address at ITS index ------------
    // Index-bound rather than set-membership, so one key cannot satisfy both
    // slots by being presented twice in different positions.
    for i in 0..2 {
        if pubkey_to_address(&auth.pubkeys[i]) != authority[i] {
            return Err(ClawbackError::WrongAuthority { index: i });
        }
    }
    if auth.pubkeys[0] == auth.pubkeys[1] {
        return Err(ClawbackError::DuplicateFactor);
    }

    // -- nonce, before any signature work ------------------------------------
    if auth.nonce <= state.last_nonce {
        return Err(ClawbackError::StaleNonce { got: auth.nonce, last: state.last_nonce });
    }

    // -- signatures over the canonical payload -------------------------------
    let msg = signing_payload(&auth.outpoints, &auth.dest, auth.nonce);
    for i in 0..2 {
        verify_signature(&auth.pubkeys[i], &msg, &auth.sigs[i])
            .map_err(|_| ClawbackError::BadSignature { index: i })?;
    }

    // -- outputs exist, are distinct, and total up --------------------------
    let mut seen = std::collections::HashSet::new();
    let mut total: u64 = 0;
    for o in &auth.outpoints {
        if !seen.insert((o.txid, o.vout)) {
            return Err(ClawbackError::DuplicateOutpoint(o.clone()));
        }
        let amt = amount_of(o).ok_or_else(|| ClawbackError::UnknownOutpoint(o.clone()))?;
        total = total.saturating_add(amt);
    }

    // -- the rolling cap ------------------------------------------------------
    let remaining = state.remaining_in_window(mtp);
    if total > remaining {
        return Err(ClawbackError::RateLimited {
            requested: total,
            remaining,
            window_secs: WINDOW_SECS,
        });
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use blockle_core::keys::Keypair;

    const DAY: u64 = 86_400;

    fn op(n: u8, vout: u32) -> OutPoint {
        OutPoint { txid: [n; 32], vout }
    }

    struct Fixture {
        a: Keypair,
        b: Keypair,
        authority: [Address; 2],
    }

    fn fixture() -> Fixture {
        let a = Keypair::generate();
        let b = Keypair::generate();
        let authority = [a.address(), b.address()];
        Fixture { a, b, authority }
    }

    fn auth_for(f: &Fixture, outs: Vec<OutPoint>, dest: Address, nonce: u64) -> ClawbackAuth {
        let msg = signing_payload(&outs, &dest, nonce);
        ClawbackAuth {
            outpoints: outs,
            dest,
            nonce,
            pubkeys: [f.a.public_bytes(), f.b.public_bytes()],
            sigs: [f.a.sign(&msg), f.b.sign(&msg)],
        }
    }

    /// Every outpoint worth 1,000 BLOCK.
    fn amounts(v: u64) -> impl Fn(&OutPoint) -> Option<u64> {
        move |_| Some(v)
    }

    fn run(
        f: &Fixture,
        auth: &ClawbackAuth,
        st: &ClawbackState,
        mtp: u64,
        amt: u64,
    ) -> Result<u64, ClawbackError> {
        validate(auth, st, &f.authority, 100_000, 90_000, mtp, &amounts(amt))
    }

    #[test]
    fn a_correct_two_of_two_is_accepted() {
        let f = fixture();
        let a = auth_for(&f, vec![op(1, 0)], [9u8; 32], 1);
        assert_eq!(run(&f, &a, &ClawbackState::default(), 10 * DAY, 500), Ok(500));
    }

    #[test]
    fn one_signature_is_not_enough() {
        // The whole point of 2-of-2: factor A alone authorises nothing.
        let f = fixture();
        let mut a = auth_for(&f, vec![op(1, 0)], [9u8; 32], 1);
        a.sigs[1] = vec![0u8; a.sigs[1].len()];
        assert_eq!(
            run(&f, &a, &ClawbackState::default(), 10 * DAY, 500),
            Err(ClawbackError::BadSignature { index: 1 })
        );
    }

    #[test]
    fn factor_a_cannot_fill_both_slots() {
        // If one leaked key could occupy both positions, 2-of-2 would be 1-of-1.
        let f = fixture();
        let outs = vec![op(1, 0)];
        let dest = [9u8; 32];
        let msg = signing_payload(&outs, &dest, 1);
        let a = ClawbackAuth {
            outpoints: outs,
            dest,
            nonce: 1,
            pubkeys: [f.a.public_bytes(), f.a.public_bytes()],
            sigs: [f.a.sign(&msg), f.a.sign(&msg)],
        };
        // Caught by the index-bound authority check before the duplicate test.
        assert_eq!(
            run(&f, &a, &ClawbackState::default(), 10 * DAY, 500),
            Err(ClawbackError::WrongAuthority { index: 1 })
        );
    }

    #[test]
    fn a_stranger_with_two_keys_is_refused() {
        let f = fixture();
        let outsider = fixture(); // valid 2-of-2, wrong authority
        let a = auth_for(&outsider, vec![op(1, 0)], [9u8; 32], 1);
        assert_eq!(
            run(&f, &a, &ClawbackState::default(), 10 * DAY, 500),
            Err(ClawbackError::WrongAuthority { index: 0 })
        );
    }

    #[test]
    fn replay_is_refused() {
        let f = fixture();
        let a = auth_for(&f, vec![op(1, 0)], [9u8; 32], 5);
        let mut st = ClawbackState::default();
        assert!(run(&f, &a, &st, 10 * DAY, 500).is_ok());
        st.record(10 * DAY, 500, 5);
        // The captured transaction, rebroadcast verbatim.
        assert_eq!(
            run(&f, &a, &st, 10 * DAY, 500),
            Err(ClawbackError::StaleNonce { got: 5, last: 5 })
        );
    }

    #[test]
    fn signatures_do_not_transfer_to_a_different_clawback() {
        // Sign for one destination, then swap the destination.
        let f = fixture();
        let mut a = auth_for(&f, vec![op(1, 0)], [9u8; 32], 1);
        a.dest = [8u8; 32];
        assert_eq!(
            run(&f, &a, &ClawbackState::default(), 10 * DAY, 500),
            Err(ClawbackError::BadSignature { index: 0 })
        );
    }

    #[test]
    fn the_cap_bounds_a_single_clawback() {
        let f = fixture();
        let a = auth_for(&f, vec![op(1, 0)], [9u8; 32], 1);
        // One output worth more than the window allows.
        let over = MAX_PER_WINDOW + 1;
        assert_eq!(
            run(&f, &a, &ClawbackState::default(), 10 * DAY, over),
            Err(ClawbackError::RateLimited {
                requested: over,
                remaining: MAX_PER_WINDOW,
                window_secs: WINDOW_SECS,
            })
        );
    }

    #[test]
    fn the_cap_bounds_the_sum_across_the_window() {
        // THE KEY PROPERTY: a leaked pair cannot drain by splitting into many
        // small clawbacks.
        let f = fixture();
        let mut st = ClawbackState::default();
        let mtp = 30 * DAY;
        let each = MAX_PER_WINDOW / 4;
        for n in 1..=4u64 {
            let a = auth_for(&f, vec![op(n as u8, 0)], [9u8; 32], n);
            assert!(run(&f, &a, &st, mtp, each).is_ok(), "clawback {n} should fit");
            st.record(mtp, each, n);
        }
        assert_eq!(st.spent_in_window(mtp), MAX_PER_WINDOW);
        // The fifth, however small, does not.
        let a = auth_for(&f, vec![op(9, 0)], [9u8; 32], 5);
        assert_eq!(
            run(&f, &a, &st, mtp, 1),
            Err(ClawbackError::RateLimited { requested: 1, remaining: 0, window_secs: WINDOW_SECS })
        );
    }

    #[test]
    fn the_window_rolls_forward() {
        let f = fixture();
        let mut st = ClawbackState::default();
        let t0 = 30 * DAY;
        st.record(t0, MAX_PER_WINDOW, 1);
        assert_eq!(st.remaining_in_window(t0), 0);
        // Still inside at 6 days 23 hours.
        assert_eq!(st.remaining_in_window(t0 + WINDOW_SECS - 3600), 0);
        // Just past 7 days the allowance is whole again.
        assert_eq!(st.remaining_in_window(t0 + WINDOW_SECS + 1), MAX_PER_WINDOW);
        let a = auth_for(&f, vec![op(2, 0)], [9u8; 32], 2);
        assert!(run(&f, &a, &st, t0 + WINDOW_SECS + 1, 1_000).is_ok());
    }

    #[test]
    fn history_is_pruned_so_it_cannot_grow_without_bound() {
        let mut st = ClawbackState::default();
        for i in 0..50u64 {
            st.record(30 * DAY + i * DAY, 1, i + 1);
        }
        // Only entries inside the final window survive.
        assert!(st.history.len() <= 8, "history was {}", st.history.len());
        assert_eq!(st.last_nonce, 50);
    }

    #[test]
    fn duplicate_outpoints_cannot_double_count() {
        let f = fixture();
        let a = auth_for(&f, vec![op(1, 0), op(1, 0)], [9u8; 32], 1);
        assert_eq!(
            run(&f, &a, &ClawbackState::default(), 10 * DAY, 500),
            Err(ClawbackError::DuplicateOutpoint(op(1, 0)))
        );
    }

    #[test]
    fn a_spent_output_is_refused() {
        let f = fixture();
        let a = auth_for(&f, vec![op(1, 0)], [9u8; 32], 1);
        let none = |_: &OutPoint| None;
        assert_eq!(
            validate(&a, &ClawbackState::default(), &f.authority, 100_000, 90_000, 10 * DAY, &none),
            Err(ClawbackError::UnknownOutpoint(op(1, 0)))
        );
    }

    #[test]
    fn inert_before_activation() {
        let f = fixture();
        let a = auth_for(&f, vec![op(1, 0)], [9u8; 32], 1);
        assert_eq!(
            validate(&a, &ClawbackState::default(), &f.authority, 89_999, 90_000, 10 * DAY, &amounts(500)),
            Err(ClawbackError::NotActivated { height: 89_999, activates: 90_000 })
        );
    }

    #[test]
    fn empty_outpoint_list_is_refused() {
        let f = fixture();
        let a = auth_for(&f, vec![], [9u8; 32], 1);
        assert_eq!(
            run(&f, &a, &ClawbackState::default(), 10 * DAY, 500),
            Err(ClawbackError::NoOutpoints)
        );
    }

    #[test]
    fn the_cap_is_one_hundred_thousand_block() {
        // 100,000 BLOCK at 8 decimals, stated explicitly so a unit slip in the
        // constant is caught here rather than by an over-large clawback.
        assert_eq!(MAX_PER_WINDOW, 100_000 * 100_000_000);
        assert_eq!(WINDOW_SECS, 604_800);
    }
}
