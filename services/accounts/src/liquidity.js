// liquidity.js — the SERVER-AUTHORITATIVE Blockle Liquidity treasury.
//
// ONE BLOCK price across every currency (matches the Flutter engine exactly): a
// single USD price, starting at $0.001, that rises uniformly as the 0.05% bot
// fees accumulate. Per-coin RESERVES ("hot wallets") hold whatever the fees have
// deposited; a swap converts at the one BLOCK price (adjusted by the coin's live
// USD price), bounded by that coin's reserve and the 50,000-BLOCK supply.
//
// This module is the SOURCE OF TRUTH for the reserves — shared across every
// wallet, fed by real fees, persisted via the Store. The ACTUAL on-chain movement
// of funds (deposits in / payouts out of the custodial hot wallets) is GATED
// behind LIQUIDITY_MAINNET=1 and performed by the operator/relayer; until then a
// swap is authoritative ACCOUNTING + a recorded settlement intent (status
// 'recorded'), never a silent real-money transfer. Custodial addresses derive
// from LIQUIDITY_TREASURY_SEED (hex) — null/unfunded until the operator sets it.

import crypto from 'node:crypto';
import { evmAddressFromPrivate } from './evmsign.js';

const BLOCK_SEED_SUPPLY = 50000;
const BLOCK_SEED_PRICE_USD = 0.001;
const FEE_APPRECIATION_DIVISOR = BLOCK_SEED_SUPPLY; // $/BLOCK per $fee, over the supply
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'USD', 'USDB', 'PYUSD', 'TUSD']);

// EVM-settled coins share the treasury's EVM hot wallet; Solana coins share the
// Solana one. (Others are display-only until their chain's relayer is wired.)
const EVM_COINS = new Set(['USDC', 'USDT', 'DAI', 'ETH', 'BNB', 'MATIC', 'AVAX']);
const SOL_COINS = new Set(['SOL']);

export function makeLiquidity({ store, env = process.env, now = () => Date.now() }) {
  const COLL = 'liquidity';
  const KEY = 'treasury';
  const seedHex = env.LIQUIDITY_TREASURY_SEED || '';
  const mainnet = /^(1|true|yes|on)$/i.test(env.LIQUIDITY_MAINNET || '');
  // vendor/solana.js is CommonJS — load it once (async) and cache for the Solana
  // custodial address. Until it resolves, only the EVM address is reported.
  let _sol = null;
  if (seedHex) import('./vendor/solana.js').then((m) => { _sol = m.default || m; }).catch(() => {});

  function fresh() {
    return { blockTreasury: BLOCK_SEED_SUPPLY, reserves: {}, fees: {}, updatedAt: now() };
  }
  function load() {
    const t = store.get(COLL, KEY);
    if (!t || typeof t.blockTreasury !== 'number') return fresh();
    return { blockTreasury: t.blockTreasury, reserves: t.reserves || {}, fees: t.fees || {}, updatedAt: t.updatedAt || 0 };
  }
  async function save(t) { t.updatedAt = now(); await store.put(COLL, KEY, t); return t; }

  const totalFeesUsd = (t) => Object.values(t.fees).reduce((s, v) => s + (+v || 0), 0);
  const blockPriceUsd = (t) => BLOCK_SEED_PRICE_USD + totalFeesUsd(t) / FEE_APPRECIATION_DIVISOR;

  // ---- custodial hot-wallet addresses (public) ------------------------------
  // Derived deterministically from the treasury seed; one EVM + one Solana wallet
  // back the respective coin families. Returns {} until a seed is configured.
  function custodialAddresses() {
    if (!seedHex || seedHex.length < 32) return {};
    try {
      const evmPriv = '0x' + crypto.createHash('sha256').update('evm:' + seedHex).digest('hex');
      const out = { evm: evmAddressFromPrivate(evmPriv) };
      if (_sol) {
        const solSeed = crypto.createHash('sha256').update('sol:' + seedHex).digest();
        out.solana = _sol.addressFromSeed(solSeed);
      }
      return out;
    } catch (_) { return {}; }
  }

  function depositAddressFor(coin) {
    const a = custodialAddresses();
    const c = String(coin || '').toUpperCase();
    if (EVM_COINS.has(c)) return a.evm || null;
    if (SOL_COINS.has(c)) return a.solana || null;
    return null;
  }

  // ---- public state ---------------------------------------------------------
  function state() {
    const t = load();
    return {
      blockPriceUsd: blockPriceUsd(t),
      blockSeedSupply: BLOCK_SEED_SUPPLY,
      blockTreasury: t.blockTreasury,
      reserves: t.reserves,
      fees: t.fees,
      totalFeesUsd: totalFeesUsd(t),
      custodial: custodialAddresses(),
      settlement: mainnet ? 'onchain' : 'accounting', // gated
      updatedAt: t.updatedAt,
    };
  }

  // ---- fee intake -----------------------------------------------------------
  // Deposit a bot fee: feeUsd worth of `coin` joins that coin's reserve. coinUsd
  // is the coin's live USD price (stablecoins pinned to 1 if omitted).
  async function accrueFee(coin, feeUsd, coinUsd) {
    const c = String(coin || '').toUpperCase();
    const fee = +feeUsd;
    if (!c || !(fee > 0)) return { ok: false, error: 'bad fee' };
    const cu = STABLE.has(c) ? 1 : (+coinUsd > 0 ? +coinUsd : 0);
    if (!(cu > 0)) return { ok: false, error: 'coin price required' };
    const t = load();
    t.reserves[c] = (+t.reserves[c] || 0) + fee / cu;
    t.fees[c] = (+t.fees[c] || 0) + fee;
    await save(t);
    return { ok: true };
  }

  // ---- quote / swap ---------------------------------------------------------
  function quote(from, to, amountIn, coinUsd) {
    from = String(from || '').toUpperCase();
    to = String(to || '').toUpperCase();
    const amt = +amountIn;
    const t = load();
    const bp = blockPriceUsd(t);
    if (!(amt > 0)) return { ok: false, reason: 'enter an amount', blockPriceUsd: bp };
    if ((from === 'BLOCK') === (to === 'BLOCK')) return { ok: false, reason: 'one side must be BLOCK', blockPriceUsd: bp };
    const coin = from === 'BLOCK' ? to : from;
    const cu = STABLE.has(coin) ? 1 : (+coinUsd > 0 ? +coinUsd : 0);
    if (!(cu > 0)) return { ok: false, reason: 'coin price required', blockPriceUsd: bp };
    if (from === 'BLOCK') {
      const out = amt * bp / cu;
      const have = +t.reserves[coin] || 0;
      if (out > have) return { ok: false, reason: have <= 0 ? `no liquidity for ${coin}` : `only ${have} ${coin} available`, blockPriceUsd: bp };
      return { ok: true, amountIn: amt, amountOut: out, assetIn: from, assetOut: to, blockPriceUsd: bp };
    }
    const out = amt * cu / bp;
    if (out > t.blockTreasury) return { ok: false, reason: 'treasury BLOCK exhausted', blockPriceUsd: bp };
    return { ok: true, amountIn: amt, amountOut: out, assetIn: from, assetOut: to, blockPriceUsd: bp };
  }

  // Execute a swap: apply the reserve move + record a settlement intent. When the
  // on-chain gate is OFF the status is 'recorded' (authoritative accounting, no
  // funds move); when ON it is 'settling' and the relayer performs the real legs.
  async function swap({ from, to, amountIn, coinUsd, userAddress }) {
    const q = quote(from, to, amountIn, coinUsd);
    if (!q.ok) return q;
    const t = load();
    const coin = (String(from).toUpperCase() === 'BLOCK' ? to : from).toUpperCase();
    if (String(from).toUpperCase() === 'BLOCK') {
      t.blockTreasury += q.amountIn;
      t.reserves[coin] = (+t.reserves[coin] || 0) - q.amountOut;
    } else {
      t.reserves[coin] = (+t.reserves[coin] || 0) + q.amountIn;
      t.blockTreasury -= q.amountOut;
    }
    await save(t);
    const id = crypto.randomBytes(9).toString('base64url');
    const rec = {
      id, from: q.assetIn, to: q.assetOut, amountIn: q.amountIn, amountOut: q.amountOut,
      userAddress: userAddress || null, depositAddress: depositAddressFor(coin),
      status: mainnet ? 'settling' : 'recorded', ts: now(),
    };
    await store.put(COLL, 'swap:' + id, rec);
    return { ...q, ...rec };
  }

  return { state, quote, swap, accrueFee, blockPriceUsd: () => blockPriceUsd(load()), custodialAddresses, _consts: { BLOCK_SEED_SUPPLY, BLOCK_SEED_PRICE_USD } };
}
