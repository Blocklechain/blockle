//! Native AMM pools for Blockle — Phase 2 of the token system.
//!
//! Each pool pairs native BLOCK with one BLOCK-20 token (constant-product
//! `x*y=k`, 0.30% swap fee). Liquidity providers mint LP shares; every
//! liquidity add is **locked for one week** (1008 blocks at 600s spacing)
//! before it can be withdrawn, and the lock is public (stored per position).
//!
//! This module is the pure, self-contained math + state model. It is exercised
//! by the tests below and wired into block application / a transaction action
//! separately (so consensus changes land tested, in isolation first).

use std::collections::HashMap;

use blockle_core::hash::blake2b_256_raw;
use blockle_core::{ContractAction, Transaction};

use crate::contracts::StorageMap;

pub type Hash32 = [u8; 32];

// ---- BLOCK-20 balance access from native code --------------------------
// BLOCK-20 stores balances as 8 LE bytes at key = H(0x01 ‖ address) using the
// VM's un-personalized Blake2b (see token asm). The native AMM reads/writes the
// same slots so pool token legs settle without a contract-to-contract call.
fn tok_key(addr: &Hash32) -> [u8; 32] {
    let mut buf = [0u8; 33];
    buf[0] = 1;
    buf[1..].copy_from_slice(addr);
    blake2b_256_raw(&buf)
}
fn get_tok(storage: &StorageMap, token: &Hash32, addr: &Hash32) -> u64 {
    match storage.get(&(*token, tok_key(addr))) {
        Some(v) if v.len() >= 8 => {
            let mut b = [0u8; 8];
            b.copy_from_slice(&v[..8]);
            u64::from_le_bytes(b)
        }
        _ => 0,
    }
}
fn set_tok(storage: &mut StorageMap, token: &Hash32, addr: &Hash32, amt: u64) {
    storage.insert((*token, tok_key(addr)), amt.to_le_bytes().to_vec());
}

/// One week of blocks at the 600s mainnet spacing.
pub const LP_LOCK_BLOCKS: u64 = 7 * 24 * 60 * 60 / 600; // = 1008
/// Swap fee in basis points (0.30%), the classic AMM fee.
pub const SWAP_FEE_BPS: u64 = 30;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pool {
    /// The paired BLOCK-20 token (contract id). BLOCK is the implicit other side.
    pub token: Hash32,
    pub block_reserve: u64,
    pub token_reserve: u64,
    pub lp_total: u64,
    pub created_height: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LpPosition {
    pub shares: u64,
    /// Height at/after which these shares may be withdrawn.
    pub unlock_height: u64,
}

/// Canonical pool id for a token: one BLOCK/token pool per token.
pub fn pool_id(token: &Hash32) -> Hash32 {
    blockle_core::hash::blake2b_256_personal(b"BlklPool", token)
}

/// Integer sqrt (for initial LP share minting).
fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Constant-product output for swapping `amount_in` of the input side into the
/// output side, net of the swap fee. Returns 0 on empty reserves / zero input.
pub fn amount_out(amount_in: u64, in_reserve: u64, out_reserve: u64) -> u64 {
    if amount_in == 0 || in_reserve == 0 || out_reserve == 0 {
        return 0;
    }
    let ain = amount_in as u128 * (10_000 - SWAP_FEE_BPS as u128);
    let num = ain * out_reserve as u128;
    let den = in_reserve as u128 * 10_000 + ain;
    (num / den) as u64
}

#[derive(Debug, PartialEq, Eq)]
pub enum PoolError {
    Exists,
    NoPool,
    ZeroAmount,
    BadRatio,
    Locked,
    InsufficientShares,
    InsufficientLiquidity,
    Overflow,
}

/// Native-AMM state: pools by id, and LP positions by (pool, provider).
#[derive(Clone, Default)]
pub struct PoolState {
    pub pools: HashMap<Hash32, Pool>,
    pub lp: HashMap<(Hash32, Hash32), LpPosition>,
}

impl PoolState {
    /// Create a pool for `token`, seeding it with `block_amt` + `token_amt`.
    /// Returns (pool_id, lp_shares_minted). Shares lock for one week.
    pub fn create_pool(
        &mut self,
        token: Hash32,
        provider: Hash32,
        block_amt: u64,
        token_amt: u64,
        height: u64,
    ) -> Result<(Hash32, u64), PoolError> {
        if block_amt == 0 || token_amt == 0 {
            return Err(PoolError::ZeroAmount);
        }
        let id = pool_id(&token);
        if self.pools.contains_key(&id) {
            return Err(PoolError::Exists);
        }
        let shares = isqrt(block_amt as u128 * token_amt as u128) as u64;
        if shares == 0 {
            return Err(PoolError::InsufficientLiquidity);
        }
        self.pools.insert(id, Pool {
            token,
            block_reserve: block_amt,
            token_reserve: token_amt,
            lp_total: shares,
            created_height: height,
        });
        self.lp.insert((id, provider), LpPosition { shares, unlock_height: height + LP_LOCK_BLOCKS });
        Ok((id, shares))
    }

    /// Add liquidity at the current ratio. `block_amt` is authoritative; the
    /// required token amount is derived and must be <= `token_max`.
    /// Returns (token_used, lp_shares_minted).
    pub fn add_liquidity(
        &mut self,
        id: &Hash32,
        provider: Hash32,
        block_amt: u64,
        token_max: u64,
        height: u64,
    ) -> Result<(u64, u64), PoolError> {
        let p = self.pools.get_mut(id).ok_or(PoolError::NoPool)?;
        if block_amt == 0 {
            return Err(PoolError::ZeroAmount);
        }
        let token_used = (block_amt as u128 * p.token_reserve as u128 / p.block_reserve as u128) as u64;
        if token_used == 0 || token_used > token_max {
            return Err(PoolError::BadRatio);
        }
        let minted = (block_amt as u128 * p.lp_total as u128 / p.block_reserve as u128) as u64;
        if minted == 0 {
            return Err(PoolError::InsufficientLiquidity);
        }
        p.block_reserve = p.block_reserve.checked_add(block_amt).ok_or(PoolError::Overflow)?;
        p.token_reserve = p.token_reserve.checked_add(token_used).ok_or(PoolError::Overflow)?;
        p.lp_total = p.lp_total.checked_add(minted).ok_or(PoolError::Overflow)?;
        let pos = self.lp.entry((*id, provider)).or_default();
        pos.shares += minted;
        pos.unlock_height = height + LP_LOCK_BLOCKS; // adding re-locks the whole position
        Ok((token_used, minted))
    }

    /// Remove `shares` of liquidity after the lock expires.
    /// Returns (block_out, token_out).
    pub fn remove_liquidity(
        &mut self,
        id: &Hash32,
        provider: Hash32,
        shares: u64,
        height: u64,
    ) -> Result<(u64, u64), PoolError> {
        let pos = self.lp.get_mut(&(*id, provider)).ok_or(PoolError::InsufficientShares)?;
        if shares == 0 || shares > pos.shares {
            return Err(PoolError::InsufficientShares);
        }
        if height < pos.unlock_height {
            return Err(PoolError::Locked);
        }
        let p = self.pools.get_mut(id).ok_or(PoolError::NoPool)?;
        let block_out = (shares as u128 * p.block_reserve as u128 / p.lp_total as u128) as u64;
        let token_out = (shares as u128 * p.token_reserve as u128 / p.lp_total as u128) as u64;
        p.block_reserve -= block_out;
        p.token_reserve -= token_out;
        p.lp_total -= shares;
        pos.shares -= shares;
        Ok((block_out, token_out))
    }

    /// Swap BLOCK -> token. Returns token_out.
    pub fn swap_block_for_token(&mut self, id: &Hash32, block_in: u64) -> Result<u64, PoolError> {
        let p = self.pools.get_mut(id).ok_or(PoolError::NoPool)?;
        let out = amount_out(block_in, p.block_reserve, p.token_reserve);
        if out == 0 {
            return Err(PoolError::ZeroAmount);
        }
        p.block_reserve = p.block_reserve.checked_add(block_in).ok_or(PoolError::Overflow)?;
        p.token_reserve -= out;
        Ok(out)
    }

    /// Swap token -> BLOCK. Returns block_out.
    pub fn swap_token_for_block(&mut self, id: &Hash32, token_in: u64) -> Result<u64, PoolError> {
        let p = self.pools.get_mut(id).ok_or(PoolError::NoPool)?;
        let out = amount_out(token_in, p.token_reserve, p.block_reserve);
        if out == 0 {
            return Err(PoolError::ZeroAmount);
        }
        p.token_reserve = p.token_reserve.checked_add(token_in).ok_or(PoolError::Overflow)?;
        p.block_reserve -= out;
        Ok(out)
    }

    pub fn spot_block_per_token(&self, id: &Hash32) -> Option<f64> {
        let p = self.pools.get(id)?;
        if p.token_reserve == 0 {
            return None;
        }
        Some(p.block_reserve as f64 / p.token_reserve as f64)
    }
}

/// Apply a pool `ContractAction` during block processing. Mutates pool state
/// and the BLOCK-20 token storage; returns BLOCK payouts (UTXOs to mint):
/// liquidity/swap proceeds, or a refund of the BLOCK `value` if the action
/// can't execute (slippage, missing pool, insufficient balance, lock). The
/// gas fee is always consumed (anti-spam), like a reverted contract call.
pub fn apply_pool_action(
    action: &ContractAction,
    tx: &Transaction,
    height: u64,
    pools: &mut PoolState,
    storage: &mut StorageMap,
) -> Vec<([u8; 32], u64)> {
    let caller = blockle_core::keys::pubkey_to_address(&tx.inputs[0].pubkey);
    match action {
        ContractAction::PoolCreate { token, block_amt, token_amt, .. } => {
            if get_tok(storage, token, &caller) < *token_amt {
                return vec![(caller, *block_amt)]; // refund BLOCK
            }
            match pools.create_pool(*token, caller, *block_amt, *token_amt, height) {
                Ok((id, _)) => {
                    let cb = get_tok(storage, token, &caller);
                    set_tok(storage, token, &caller, cb - *token_amt);
                    let pb = get_tok(storage, token, &id);
                    set_tok(storage, token, &id, pb + *token_amt);
                    vec![]
                }
                Err(_) => vec![(caller, *block_amt)],
            }
        }
        ContractAction::PoolAdd { token, block_amt, token_max, .. } => {
            let id = pool_id(token);
            let token_used = match pools.pools.get(&id) {
                Some(p) if p.block_reserve > 0 => {
                    (*block_amt as u128 * p.token_reserve as u128 / p.block_reserve as u128) as u64
                }
                _ => return vec![(caller, *block_amt)],
            };
            if token_used == 0 || token_used > *token_max || get_tok(storage, token, &caller) < token_used {
                return vec![(caller, *block_amt)];
            }
            match pools.add_liquidity(&id, caller, *block_amt, *token_max, height) {
                Ok((used, _)) => {
                    let cb = get_tok(storage, token, &caller);
                    set_tok(storage, token, &caller, cb - used);
                    let pb = get_tok(storage, token, &id);
                    set_tok(storage, token, &id, pb + used);
                    vec![]
                }
                Err(_) => vec![(caller, *block_amt)],
            }
        }
        ContractAction::PoolRemove { token, shares, .. } => {
            let id = pool_id(token);
            match pools.remove_liquidity(&id, caller, *shares, height) {
                Ok((block_out, token_out)) => {
                    let pb = get_tok(storage, token, &id);
                    set_tok(storage, token, &id, pb.saturating_sub(token_out));
                    let cb = get_tok(storage, token, &caller);
                    set_tok(storage, token, &caller, cb + token_out);
                    if block_out > 0 { vec![(caller, block_out)] } else { vec![] }
                }
                Err(_) => vec![], // value is 0; nothing to refund
            }
        }
        ContractAction::PoolSwapBuy { token, block_in, min_token_out, .. } => {
            let id = pool_id(token);
            // Pre-check slippage against current reserves (swap mutates).
            let out = match pools.pools.get(&id) {
                Some(p) => amount_out(*block_in, p.block_reserve, p.token_reserve),
                None => 0,
            };
            if out == 0 || out < *min_token_out {
                return vec![(caller, *block_in)]; // refund
            }
            match pools.swap_block_for_token(&id, *block_in) {
                Ok(o) => {
                    let pb = get_tok(storage, token, &id);
                    set_tok(storage, token, &id, pb.saturating_sub(o));
                    let cb = get_tok(storage, token, &caller);
                    set_tok(storage, token, &caller, cb + o);
                    vec![]
                }
                Err(_) => vec![(caller, *block_in)],
            }
        }
        ContractAction::PoolSwapSell { token, token_in, min_block_out, .. } => {
            let id = pool_id(token);
            if get_tok(storage, token, &caller) < *token_in {
                return vec![]; // nothing taken, no BLOCK was supplied
            }
            let out = match pools.pools.get(&id) {
                Some(p) => amount_out(*token_in, p.token_reserve, p.block_reserve),
                None => 0,
            };
            if out == 0 || out < *min_block_out {
                return vec![];
            }
            match pools.swap_token_for_block(&id, *token_in) {
                Ok(bout) => {
                    let cb = get_tok(storage, token, &caller);
                    set_tok(storage, token, &caller, cb - *token_in);
                    let pb = get_tok(storage, token, &id);
                    set_tok(storage, token, &id, pb + *token_in);
                    vec![(caller, bout)]
                }
                Err(_) => vec![],
            }
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_one_week() {
        assert_eq!(LP_LOCK_BLOCKS, 1008);
    }

    #[test]
    fn create_add_swap_remove() {
        let token = [0x22u8; 32];
        let alice = [0xAAu8; 32];
        let bob = [0xBBu8; 32];
        let mut s = PoolState::default();

        // create at height 10: 1000 BLOCK + 4000 token
        let (id, shares) = s.create_pool(token, alice, 1000, 4000, 10).unwrap();
        assert!(shares > 0);
        assert_eq!(s.pools[&id].block_reserve, 1000);
        assert_eq!(s.pools[&id].token_reserve, 4000);
        // creating again fails
        assert_eq!(s.create_pool(token, alice, 1, 1, 10).unwrap_err(), PoolError::Exists);

        // spot price ~ 0.25 BLOCK per token
        assert!((s.spot_block_per_token(&id).unwrap() - 0.25).abs() < 1e-9);

        // swap 100 BLOCK -> token (price moves, fee applied)
        let out = s.swap_block_for_token(&id, 100).unwrap();
        assert!(out > 0 && out < 400); // less than naive 400 due to slippage+fee
        assert_eq!(s.pools[&id].block_reserve, 1100);
        assert_eq!(s.pools[&id].token_reserve, 4000 - out);

        // constant-product roughly preserved (k grows slightly from the fee)
        let k0 = 1000u128 * 4000;
        let k1 = s.pools[&id].block_reserve as u128 * s.pools[&id].token_reserve as u128;
        assert!(k1 >= k0);

        // bob adds liquidity at height 20
        let (tok_used, minted) = s.add_liquidity(&id, bob, 110, 1000, 20).unwrap();
        assert!(tok_used > 0 && minted > 0);

        // bob can't withdraw before the 1-week lock
        assert_eq!(s.remove_liquidity(&id, bob, minted, 20 + 10).unwrap_err(), PoolError::Locked);
        // ...but can after it
        let (b_out, t_out) = s.remove_liquidity(&id, bob, minted, 20 + LP_LOCK_BLOCKS).unwrap();
        assert!(b_out > 0 && t_out > 0);
        assert_eq!(s.lp[&(id, bob)].shares, 0);
    }

    #[test]
    fn swap_round_trip_loses_to_fees() {
        let token = [1u8; 32];
        let mut s = PoolState::default();
        let (id, _) = s.create_pool(token, [9u8; 32], 1_000_000, 1_000_000, 0).unwrap();
        let got_token = s.swap_block_for_token(&id, 10_000).unwrap();
        let got_block = s.swap_token_for_block(&id, got_token).unwrap();
        assert!(got_block < 10_000); // fees + slippage mean you never round-trip to profit
    }
}
