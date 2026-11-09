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
import { ensureTreasuryWallet, blockAddressBalance } from './liquidity_block.js';
import { COIN_CHAIN, COIN_TOKEN, COIN_DECIMALS } from './liquidity_relayer.js';

const BLOCK_SEED_SUPPLY = 50000;
const BLOCK_SEED_PRICE_USD = 0.001;
const FEE_APPRECIATION_DIVISOR = BLOCK_SEED_SUPPLY; // $/BLOCK per $fee, over the supply

// BONDING CURVE: buys of BLOCK push the price UP, sells push it back DOWN
// (symmetric), ON TOP OF the fee-funded floor. `d = SEED - treasuryBlock` is the
// net BLOCK bought out of the treasury; spot price = floor × (1 + C·d). STEEP:
// C = 0.0002/BLOCK, so a 500-BLOCK buy (1% of the 50k seed) lifts the price ~10%.
// Swaps integrate along the curve so a big single order can't fill at the start
// price. MIN_MULT floors the multiplier so heavy net-selling can't drive it ≤0.
const CURVE_STEEPNESS = 0.0002;
const CURVE_MIN_MULT = 0.1;
const STABLE = new Set(['USDC', 'USDT', 'DAI', 'USD', 'USDB', 'PYUSD', 'TUSD']);

// EVM-settled coins share the treasury's EVM hot wallet; Solana coins share the
// Solana one. (Others are display-only until their chain's relayer is wired.)
const EVM_COINS = new Set(['USDC', 'USDT', 'DAI', 'ETH', 'BNB', 'MATIC', 'AVAX']);
const SOL_COINS = new Set(['SOL']);

export function makeLiquidity({ store, env = process.env, now = () => Date.now(), chainBase, fetchFn = globalThis.fetch, rpcFor = null }) {
  const COLL = 'liquidity';
  const KEY = 'treasury';
  const seedHex = env.LIQUIDITY_TREASURY_SEED || '';
  const mainnet = /^(1|true|yes|on)$/i.test(env.LIQUIDITY_MAINNET || '');
  const chainApi = chainBase || env.ACCOUNTS_CHAIN_API || env.ACCOUNTS_ORIGIN || 'https://blockle.org';
  // vendor/solana.js is CommonJS — load it once (async) and cache for the Solana
  // custodial address. Until it resolves, only the EVM address is reported.
  let _sol = null;
  const _solP = seedHex
    ? import('./vendor/solana.js').then((m) => { _sol = m.default || m; }).catch(() => {})
    : null;
  // Provision the treasury BLOCK (post-quantum) wallet once the gate is live, so
  // its deposit address exists before anyone swaps. Best-effort.
  if (seedHex && mainnet) ensureTreasuryWallet(store, seedHex).catch(() => {});

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
  // The fee-funded FLOOR price (rises only with fees — "fees just add liquidity").
  const priceFloorUsd = (t) => BLOCK_SEED_PRICE_USD + totalFeesUsd(t) / FEE_APPRECIATION_DIVISOR;
  // Curve multiplier from net BLOCK bought out of the treasury (buys ↑, sells ↓).
  const curveMult = (treasury) => Math.max(CURVE_MIN_MULT, 1 + CURVE_STEEPNESS * (BLOCK_SEED_SUPPLY - treasury));
  // SPOT price = floor × curve. This is what every wallet shows and it moves on buys.
  const blockPriceUsd = (t) => priceFloorUsd(t) * curveMult(t.blockTreasury);

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
      // BLOCK (post-quantum) wallet — generated once + stored; present once provisioned.
      const bw = store.get(COLL, 'blockWallet');
      if (bw && bw.address) out.block = bw.address;
      return out;
    } catch (_) { return {}; }
  }

  function depositAddressFor(coin) {
    const a = custodialAddresses();
    const c = String(coin || '').toUpperCase();
    if (c === 'BLOCK') return a.block || null;
    if (EVM_COINS.has(c)) return a.evm || null;
    if (SOL_COINS.has(c)) return a.solana || null;
    return null;
  }

  // ---- on-chain treasury BLOCK balance (cached) -----------------------------
  // The REAL balance of the custodial BLOCK hot wallet, read from the explorer.
  // Cached briefly so /state stays cheap. Distinct from the accounting
  // blockTreasury (the seed/ledger figure).
  let _balCache = { at: 0, address: null, block: null };
  async function blockOnchainBalance() {
    const addr = custodialAddresses().block || null;
    const age = now() - _balCache.at;
    if (_balCache.address === addr && age < 30000 && _balCache.block != null) {
      return { address: addr, block: _balCache.block };
    }
    const block = addr ? await blockAddressBalance(addr, chainApi, fetchFn) : null;
    _balCache = { at: now(), address: addr, block };
    return { address: addr, block };
  }

  // ---- REAL on-chain balances for EVERY hot wallet (cached) -----------------
  // The accounting reserves say what the ledger THINKS each hot wallet holds; a
  // payout can only spend what the wallet REALLY holds. This reads every wallet's
  // actual balance (BLOCK explorer, Solana getBalance, EVM native + ERC-20
  // balanceOf) and quotes are capped by it. Each coin keeps a PAYOUT FLOOR back
  // (chain fee / Solana rent-exempt minimum) so a payout can never strand the
  // wallet. null = unreadable (quote falls back to the accounting reserve).
  const PAYOUT_FLOOR = { BLOCK: 0.002, SOL: 0.001, ETH: 0.0003, BNB: 0.0005, MATIC: 0.02, AVAX: 0.005, USDC: 0, USDT: 0, DAI: 0 };
  let _oc = { at: 0, data: null }; // { balances: {COIN: n|null}, addresses }
  async function _readEvmCoin(coin, evmAddr) {
    if (!rpcFor) return null;
    try {
      const rpc = rpcFor(COIN_CHAIN[coin]);
      if (!rpc) return null;
      const dec = COIN_DECIMALS[coin] ?? 18;
      if (COIN_TOKEN[coin]) {
        const data = '0x70a08231' + '0'.repeat(24) + evmAddr.slice(2).toLowerCase();
        const hex = await rpc('eth_call', [{ to: COIN_TOKEN[coin], data }, 'latest']);
        return Number(BigInt(hex || '0x0')) / 10 ** dec;
      }
      const hex = await rpc('eth_getBalance', [evmAddr, 'latest']);
      return Number(BigInt(hex || '0x0')) / 10 ** dec;
    } catch (_) { return null; }
  }
  async function refreshOnchain(force = false) {
    if (!force && _oc.data && now() - _oc.at < 30000) return _oc.data;
    if (_solP) { try { await _solP; } catch (_) {} } // Solana address derives from the async vendor module
    const addrs = custodialAddresses();
    const balances = {};
    const jobs = [];
    // BLOCK (post-quantum explorer read)
    jobs.push((async () => {
      balances.BLOCK = addrs.block ? await blockAddressBalance(addrs.block, chainApi, fetchFn).catch(() => null) : null;
    })());
    // SOL
    jobs.push((async () => {
      if (!addrs.solana || !rpcFor) { balances.SOL = null; return; }
      try {
        const r = await rpcFor('solana')('getBalance', [addrs.solana]);
        const lam = r && typeof r === 'object' ? r.value : r;
        balances.SOL = Number.isFinite(+lam) ? +lam / 1e9 : null;
      } catch (_) { balances.SOL = null; }
    })());
    // EVM family (native + ERC-20), one shared wallet
    if (addrs.evm) {
      for (const coin of Object.keys(COIN_CHAIN)) {
        jobs.push((async () => { balances[coin] = await _readEvmCoin(coin, addrs.evm); })());
      }
    }
    await Promise.all(jobs);
    _oc = { at: now(), data: { balances, addresses: addrs } };
    return _oc.data;
  }
  // SPENDABLE on-chain amount of [coin] from the cache: real balance minus its
  // payout floor. null = unknown (not read yet / unreadable) → caller falls back.
  function onchainSpendable(coin) {
    const d = _oc.data;
    if (!d) return null;
    const b = d.balances[coin];
    if (b == null || !Number.isFinite(b)) return null;
    return Math.max(0, b - (PAYOUT_FLOOR[coin] || 0));
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

  // State + the live on-chain balances of EVERY hot wallet (cached reads).
  async function stateWithOnchain() {
    const s = state();
    try {
      const oc = await refreshOnchain();
      // Per-coin REAL balances + spendable (balance − payout floor). The wallets
      // show these next to the accounting reserves; quotes are capped by them.
      s.onchain = {};
      for (const [coin, bal] of Object.entries(oc.balances)) {
        s.onchain[coin] = bal == null ? null : { balance: bal, spendable: Math.max(0, bal - (PAYOUT_FLOOR[coin] || 0)) };
      }
      // Back-compat fields the wallets already read.
      s.blockOnchainAddress = oc.addresses.block || null;
      s.blockOnchainBalance = oc.balances.BLOCK ?? null;
    } catch (_) {/* accounting-only */}
    return s;
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
  // Prices along the bonding curve: p(d) = F·(1 + C·d), d = SEED − treasury.
  //  • BUY  (coin→BLOCK): usdIn = ∫ p dd over the BLOCK delivered ⇒ solve the
  //    quadratic (C/2)x² + (1+C·d0)x − usdIn/F = 0 for x BLOCK out.
  //  • SELL (BLOCK→coin): usdOut = ∫ p dd over the BLOCK returned =
  //    F·[x + C·x·(d0 − x/2)], then / coin price.
  // So a bigger order walks the curve instead of filling at the start price.
  function quote(from, to, amountIn, coinUsd) {
    from = String(from || '').toUpperCase();
    to = String(to || '').toUpperCase();
    const amt = +amountIn;
    const t = load();
    const bp = blockPriceUsd(t); // spot (pre-trade), for display
    if (!(amt > 0)) return { ok: false, reason: 'enter an amount', blockPriceUsd: bp };
    if ((from === 'BLOCK') === (to === 'BLOCK')) return { ok: false, reason: 'one side must be BLOCK', blockPriceUsd: bp };
    const coin = from === 'BLOCK' ? to : from;
    const cu = STABLE.has(coin) ? 1 : (+coinUsd > 0 ? +coinUsd : 0);
    if (!(cu > 0)) return { ok: false, reason: 'coin price required', blockPriceUsd: bp };
    const F = priceFloorUsd(t);
    const d0 = BLOCK_SEED_SUPPLY - t.blockTreasury;
    if (from === 'BLOCK') {
      // SELL BLOCK → coin (price falls as BLOCK returns to the treasury).
      const x = amt;
      const usdOut = F * (x + CURVE_STEEPNESS * x * (d0 - x / 2));
      const out = usdOut / cu;
      // Payable = the LOWER of the accounting reserve and the REAL on-chain
      // spendable balance of the hot wallet (gate on + balance known). The
      // ledger must never promise coins the wallet doesn't actually hold.
      const reserve = +t.reserves[coin] || 0;
      const spend = mainnet ? onchainSpendable(coin) : null;
      const have = spend == null ? reserve : Math.min(reserve, spend);
      if (!(out > 0)) return { ok: false, reason: 'amount too small', blockPriceUsd: bp };
      if (out > have) {
        const why = have <= 0
          ? `no liquidity for ${coin}`
          : (spend != null && spend < reserve)
            ? `only ${have} ${coin} actually in the hot wallet — fund it to unlock the full reserve`
            : `only ${have} ${coin} available`;
        return { ok: false, reason: why, blockPriceUsd: bp, onchainAvailable: spend };
      }
      return { ok: true, amountIn: amt, amountOut: out, assetIn: from, assetOut: to, blockPriceUsd: bp, execPriceUsd: usdOut / x };
    }
    // BUY coin → BLOCK (price rises as BLOCK leaves the treasury).
    const usdIn = amt * cu;
    const A = F * CURVE_STEEPNESS / 2;
    const B = F * (1 + CURVE_STEEPNESS * d0);
    const x = A <= 0 ? usdIn / B : (-B + Math.sqrt(B * B + 4 * A * usdIn)) / (2 * A);
    if (!(x > 0)) return { ok: false, reason: 'amount too small', blockPriceUsd: bp };
    // Same cap on the BLOCK side: the payout wallet's REAL post-quantum balance.
    const blockSpend = mainnet ? onchainSpendable('BLOCK') : null;
    const blockHave = blockSpend == null ? t.blockTreasury : Math.min(t.blockTreasury, blockSpend);
    if (x > blockHave) {
      return {
        ok: false,
        reason: (blockSpend != null && blockSpend < t.blockTreasury)
          ? `only ${blockHave} BLOCK actually in the treasury wallet`
          : 'treasury BLOCK exhausted',
        blockPriceUsd: bp, onchainAvailable: blockSpend,
      };
    }
    return { ok: true, amountIn: amt, amountOut: x, assetIn: from, assetOut: to, blockPriceUsd: bp, execPriceUsd: usdIn / x };
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
    // Gate OFF: authoritative accounting only ('recorded'). Gate ON: the user must
    // deposit the input asset to our hot wallet, then the relayer verifies + pays
    // out ('awaiting-deposit' → settled). depositCoin = the input asset.
    const depositCoin = (String(from).toUpperCase() === 'BLOCK' ? from : from).toUpperCase();
    const rec = {
      id, from: q.assetIn, to: q.assetOut, amountIn: q.amountIn, amountOut: q.amountOut,
      userAddress: userAddress || null,
      depositAddress: depositAddressFor(depositCoin),
      status: mainnet ? 'awaiting-deposit' : 'recorded', ts: now(),
    };
    await store.put(COLL, 'swap:' + id, rec);
    return { ...q, ...rec };
  }

  // Undo a swap's reserve move after its deposit was REFUNDED (the payout
  // could not be made): the treasury never kept the input and never paid the
  // output, so both legs return to where they were. Idempotent per record.
  async function revertSwap(rec) {
    if (!rec || rec.reverted) return { ok: false, reason: 'nothing to revert' };
    const t = load();
    const coin = (String(rec.from).toUpperCase() === 'BLOCK' ? rec.to : rec.from).toUpperCase();
    const aIn = +rec.amountIn || 0, aOut = +rec.amountOut || 0;
    if (String(rec.from).toUpperCase() === 'BLOCK') {
      t.blockTreasury -= aIn;
      t.reserves[coin] = (+t.reserves[coin] || 0) + aOut;
    } else {
      t.reserves[coin] = Math.max(0, (+t.reserves[coin] || 0) - aIn);
      t.blockTreasury += aOut;
    }
    await save(t);
    rec.reverted = true;
    await store.put(COLL, 'swap:' + rec.id, rec);
    return { ok: true };
  }

  return { state, stateWithOnchain, blockOnchainBalance, refreshOnchain, onchainSpendable, quote, swap, accrueFee, revertSwap, blockPriceUsd: () => blockPriceUsd(load()), custodialAddresses, _consts: { BLOCK_SEED_SUPPLY, BLOCK_SEED_PRICE_USD } };
}
