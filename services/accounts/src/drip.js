// drip.js — BLOCKLE DRIP: a funded giveaway wallet (the operator sends it
// 50,000 BLOCK) that releases a daily on-chain claim to each wallet user.
//
// Reward schedule (Bitcoin-style halving over the remaining pool):
//   1 BLOCK/day   until 25,000 total has been claimed,
//   0.5 BLOCK/day until 37,500,   0.25 until 43,750,   … halving each time
//   half of what remains is distributed. The series converges on the 50k pool.
//
// Hard rules:
//   • ONE claim per account per 24h AND one per destination address per 24h.
//   • Claims are ON-CHAIN sends from the drip's own ML-DSA wallet (its key is
//     generated once and stored encrypted under the treasury seed — separate
//     store key from the liquidity treasury, so funds never mix).
//   • The ledger (totalClaimed) advances ONLY after the broadcast succeeds.
//   • Every send is gated by LIQUIDITY_MAINNET like the other BLOCK legs.

import {
  ensureTreasuryWallet, treasuryBlockAddress, payoutBlock, blockAddressBalance, flipTxid,
} from './liquidity_block.js';

const COLL = 'drip';
const STATE_KEY = 'state';
const WALLET_KEY = 'dripWallet';
const PENDING_KEY = 'dripPendingSpends';
const DAY_MS = 24 * 60 * 60 * 1000;

export const DRIP_SUPPLY = 50000;

/// Daily reward at a given claimed total: 1 → 0.5 → 0.25 → … with tranche
/// boundaries at 25,000, 37,500, 43,750, … (each tranche = half the remainder).
export function rewardFor(totalClaimed) {
  let reward = 1;
  let tranche = DRIP_SUPPLY / 2;
  let boundary = tranche;
  while (totalClaimed >= boundary) {
    reward /= 2;
    tranche /= 2;
    boundary += tranche;
    if (reward < 1e-8) return 0; // 8-dp chain precision floor — the drip is over
  }
  return reward;
}

export function makeDrip({ store, env = process.env, chainBase, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const seed = env.LIQUIDITY_TREASURY_SEED || '';

  function _load() {
    return store.get(COLL, STATE_KEY) || { totalClaimed: 0, claims: {}, byAddress: {}, count: 0 };
  }
  async function _save(t) { await store.put(COLL, STATE_KEY, t); }

  /// The drip wallet's receiving address (created on first use). Null without a seed.
  async function address() {
    if (!seed) return null;
    const w = await ensureTreasuryWallet(store, seed, { walletKey: WALLET_KEY });
    return w.address;
  }

  function addressSync() {
    return treasuryBlockAddress(store, seed, { walletKey: WALLET_KEY });
  }

  /// Public state (+ the caller's own claim clock when [uid] is given).
  async function state(uid) {
    const t = _load();
    const addr = await address().catch(() => addressSync());
    let balance = null;
    if (addr) { try { balance = await blockAddressBalance(addr, chainBase, fetchFn); } catch (_) {} }
    const out = {
      address: addr,
      supply: DRIP_SUPPLY,
      totalClaimed: t.totalClaimed,
      remaining: Math.max(0, DRIP_SUPPLY - t.totalClaimed),
      onchainBalance: balance,
      reward: rewardFor(t.totalClaimed),
      claims: t.count || 0,
      active: /^(1|true|yes|on)$/i.test(env.LIQUIDITY_MAINNET || '') && !!addr,
    };
    if (uid) {
      const mine = t.claims[uid];
      out.yourTotal = mine ? mine.total : 0;
      out.nextClaimAt = mine ? mine.lastAt + DAY_MS : 0; // 0 = claimable now
      if (out.nextClaimAt <= now()) out.nextClaimAt = 0;
    }
    return out;
  }

  /// Claim today's drip for [uid] to [toAddress]. Sends ON-CHAIN; the claim is
  /// recorded only after the broadcast succeeds. Throws with a user-facing
  /// message on every refusal.
  async function claim({ uid, toAddress }) {
    if (!uid) throw new Error('sign in to claim');
    const to = String(toAddress || '').trim();
    if (!/^block1[02-9ac-hj-np-z]{20,90}$/.test(to)) throw new Error('a valid block1… address is required');
    const t = _load();
    const reward = rewardFor(t.totalClaimed);
    if (reward <= 0 || t.totalClaimed >= DRIP_SUPPLY) throw new Error('the drip pool is fully distributed');
    const nowMs = now();
    const mine = t.claims[uid];
    if (mine && nowMs - mine.lastAt < DAY_MS) {
      const e = new Error('already claimed — come back in ' + Math.ceil((mine.lastAt + DAY_MS - nowMs) / 3600000) + 'h');
      e.nextClaimAt = mine.lastAt + DAY_MS;
      throw e;
    }
    const addrLast = t.byAddress[to];
    if (addrLast && nowMs - addrLast < DAY_MS) throw new Error('this address already claimed today');

    const r = await payoutBlock({
      store, seedHex: seed, toAddress: to, amountBlock: reward, chainBase, fetchFn, env, now,
      walletKey: WALLET_KEY, pendingKey: PENDING_KEY,
    });
    // On-chain leg done — now (and only now) advance the ledger.
    const fresh = _load();
    fresh.totalClaimed = +(fresh.totalClaimed + reward).toFixed(8);
    fresh.count = (fresh.count || 0) + 1;
    const prev = fresh.claims[uid];
    fresh.claims[uid] = { lastAt: nowMs, total: +(((prev && prev.total) || 0) + reward).toFixed(8), address: to };
    fresh.byAddress[to] = nowMs;
    await _save(fresh);
    return { ok: true, amount: reward, txid: r.txid, nextClaimAt: nowMs + DAY_MS, totalClaimed: fresh.totalClaimed };
  }

  return { address, state, claim, rewardFor, _consts: { DRIP_SUPPLY, DAY_MS } };
}

export { flipTxid };
