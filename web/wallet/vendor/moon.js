// moon.js — MOON: the Moonshot-style "tap to buy a BLOCK-20 token" flow, shared
// by the web wallet and the Flutter mobile wallet (docs/MOONSHOT.md). This file
// is the PURE core: feed ranking, USD<->BLOCK<->token quoting through the native
// constant-product AMM, a local average-cost position ledger and P&L. It never
// signs, never fetches, never touches keys — the host wires it to the feed API
// (/api/signals/moon/feed), the AMM swap builder and its storage.
//
// Numbers are plain JS doubles for DISPLAY and BigInt base-unit strings for
// anything that becomes a transaction (amountIn / minOut), so the on-chain
// quote matches Venues.ammQuote byte-for-byte.
//
// Global `Moon`; module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  const BPS = 10000n;
  const COIN = 100000000; // 1 BLOCK = 1e8 base units
  const DEFAULT_POOL_FEE_BPS = 30;
  const DEFAULT_SLIPPAGE = 0.01;    // 1% — the wallet's standard
  const MAX_IMPACT_PCT = 15;        // refuse to quote a buy that moves the pool > 15%
  const PRESETS_USD = [5, 20, 50, 100];

  function bigOf(v) { if (typeof v === 'bigint') return v; const s = String(v == null ? '0' : v).trim(); if (!/^-?\d+$/.test(s)) throw new Error('base-unit integer expected: ' + s); return BigInt(s); }
  function ammOut(amountIn, reserveIn, reserveOut, feeBps) {
    const aIn = bigOf(amountIn), rIn = bigOf(reserveIn), rOut = bigOf(reserveOut);
    if (aIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
    const fee = BigInt(Math.trunc(Number(feeBps == null ? DEFAULT_POOL_FEE_BPS : feeBps)));
    const inAfterFee = (aIn * (BPS - fee)) / BPS;
    return (rOut * inAfterFee) / (rIn + inAfterFee);
  }
  function minOut(amountOut, slippage) {
    const s = Number(slippage == null ? DEFAULT_SLIPPAGE : slippage);
    if (!(s > 0)) return bigOf(amountOut);
    return (bigOf(amountOut) * (BPS - BigInt(Math.round(Math.min(s, 1) * 10000)))) / BPS;
  }
  function toBase(amount, decimals) { // double → base-unit BigInt (floors)
    const d = Number(decimals) || 0;
    const s = Number(amount).toFixed(Math.min(d, 20));
    const [i, f = ''] = s.split('.');
    return BigInt(i + f.padEnd(d, '0').slice(0, d));
  }
  function fromBase(base, decimals) { try { return Number(bigOf(base)) / Math.pow(10, Number(decimals) || 0); } catch (_) { return 0; } }

  // ---- pool math -------------------------------------------------------------
  // pool = { blockReserve, tokenReserve, decimals, poolFeeBps? } (base units)
  function poolPriceBlock(pool) {
    const br = Number(pool.blockReserve) / COIN, tr = Number(pool.tokenReserve) / Math.pow(10, Number(pool.decimals) || 0);
    return tr > 0 ? br / tr : null; // BLOCK per 1 token
  }
  function poolLiquidityBlock(pool) { return (Number(pool.blockReserve) / COIN) * 2; }

  // Quote a BUY sized in USD. Returns the exact tx inputs + display numbers.
  function quoteBuyUsd(usd, blockUsd, pool, opts) {
    opts = opts || {};
    if (!(usd > 0) || !(blockUsd > 0) || !pool) return null;
    const blockIn = toBase(usd / blockUsd, 8);
    return quoteBuyBlock(blockIn, blockUsd, pool, opts);
  }
  function quoteBuyBlock(blockInBase, blockUsd, pool, opts) {
    opts = opts || {};
    const blockIn = bigOf(blockInBase);
    if (blockIn <= 0n || !pool) return null;
    const dec = Number(pool.decimals) || 0;
    const out = ammOut(blockIn, pool.blockReserve, pool.tokenReserve, pool.poolFeeBps);
    if (out <= 0n) return null;
    const mo = minOut(out, opts.slippage);
    const spot = poolPriceBlock(pool);
    const effPrice = (Number(blockIn) / COIN) / (Number(out) / Math.pow(10, dec)); // BLOCK per token paid
    const impactPct = spot > 0 ? Math.max(0, (effPrice / spot - 1) * 100) : null;
    const blockAmt = Number(blockIn) / COIN;
    return {
      side: 'buy', amountIn: blockIn.toString(), amountOut: out.toString(), minOut: mo.toString(),
      blockIn: blockAmt, usdIn: blockUsd > 0 ? blockAmt * blockUsd : null,
      tokensOut: Number(out) / Math.pow(10, dec), effPriceBlock: effPrice, effPriceUsd: blockUsd > 0 ? effPrice * blockUsd : null,
      impactPct, tooBig: impactPct != null && impactPct > (opts.maxImpactPct != null ? opts.maxImpactPct : MAX_IMPACT_PCT),
    };
  }
  // Quote a SELL of `tokenBase` units (or a fraction of a held balance).
  function quoteSell(tokenBase, blockUsd, pool, opts) {
    opts = opts || {};
    const tokenIn = bigOf(tokenBase);
    if (tokenIn <= 0n || !pool) return null;
    const dec = Number(pool.decimals) || 0;
    const out = ammOut(tokenIn, pool.tokenReserve, pool.blockReserve, pool.poolFeeBps);
    if (out <= 0n) return null;
    const mo = minOut(out, opts.slippage);
    const spot = poolPriceBlock(pool);
    const effPrice = (Number(out) / COIN) / (Number(tokenIn) / Math.pow(10, dec));
    const impactPct = spot > 0 ? Math.max(0, (1 - effPrice / spot) * 100) : null;
    const blockAmt = Number(out) / COIN;
    return {
      side: 'sell', amountIn: tokenIn.toString(), amountOut: out.toString(), minOut: mo.toString(),
      tokensIn: Number(tokenIn) / Math.pow(10, dec), blockOut: blockAmt, usdOut: blockUsd > 0 ? blockAmt * blockUsd : null,
      effPriceBlock: effPrice, effPriceUsd: blockUsd > 0 ? effPrice * blockUsd : null, impactPct,
      tooBig: impactPct != null && impactPct > (opts.maxImpactPct != null ? opts.maxImpactPct : MAX_IMPACT_PCT),
    };
  }
  function fractionOf(balanceBase, pct) { const b = bigOf(balanceBase); const p = BigInt(Math.max(0, Math.min(100, Math.round(Number(pct))))); return ((b * p) / 100n).toString(); }

  // ---- feed ranking ----------------------------------------------------------
  // token rows come from /api/signals/moon/feed: { contract, symbol, name, logo,
  // decimals, priceBlock, priceUsd, liquidityBlock, liquidityUsd, marketCapUsd,
  // change1hPct, change24hPct, ageBlocks, lpLocked, lockDaysLeft, spark:[...], flags:[] }
  function trendingScore(t) {
    const liq = Math.max(0, Number(t.liquidityBlock) || 0);
    const liqScore = Math.min(40, Math.log10(1 + liq) * 10);                 // depth (0..40)
    const c24 = Number(t.change24hPct) || 0, c1 = Number(t.change1hPct) || 0;
    const momentum = Math.max(-20, Math.min(35, c24 * 0.5 + c1 * 1.5));       // movement (-20..35)
    const age = Number(t.ageBlocks);
    const fresh = Number.isFinite(age) ? Math.max(0, 15 - age / 48) : 0;       // new launches (0..15, fades over ~5 days)
    const lock = t.lpLocked ? 8 : 0;
    const vol = Number(t.volume24hBlock) || 0;
    const volScore = Math.min(12, Math.log10(1 + vol) * 4);
    const penalty = (t.flags || []).some((f) => /honeypot|rug|scam|denylist/i.test(f)) ? -100 : 0;
    return Math.round((liqScore + momentum + fresh + lock + volScore + penalty) * 100) / 100;
  }
  function rank(tokens, tab) {
    const rows = (tokens || []).map((t) => Object.assign({}, t, { score: t.score != null ? t.score : trendingScore(t) }));
    const by = {
      trending: (a, b) => b.score - a.score,
      new: (a, b) => (Number(a.ageBlocks) || 1e12) - (Number(b.ageBlocks) || 1e12),
      gainers: (a, b) => (Number(b.change24hPct) || 0) - (Number(a.change24hPct) || 0),
      liquid: (a, b) => (Number(b.liquidityBlock) || 0) - (Number(a.liquidityBlock) || 0),
    }[tab || 'trending'] || ((a, b) => b.score - a.score);
    rows.sort((a, b) => by(a, b) || String(a.symbol).localeCompare(String(b.symbol)));
    return rows;
  }

  // ---- position ledger (average cost) ----------------------------------------
  // positions = { [contract]: { contract, symbol, decimals, qty(base str), costBlock(base str), costUsd(number), realizedUsd, realizedBlock, trades:[...] } }
  function applyTrade(positions, t) {
    // t = { contract, symbol, decimals, side:'buy'|'sell', qty(base str), blockAmt(base str), blockUsd, txid, at }
    positions = positions || {};
    const key = String(t.contract).toLowerCase();
    const p = positions[key] || { contract: t.contract, symbol: t.symbol || null, decimals: Number(t.decimals) || 0, qty: '0', costBlock: '0', costUsd: 0, realizedUsd: 0, realizedBlock: 0, trades: [] };
    const qty = bigOf(p.qty), cost = bigOf(p.costBlock);
    const tq = bigOf(t.qty), tb = bigOf(t.blockAmt);
    const usd = (Number(tb) / COIN) * (Number(t.blockUsd) || 0);
    if (t.side === 'buy') {
      p.qty = (qty + tq).toString(); p.costBlock = (cost + tb).toString(); p.costUsd = (p.costUsd || 0) + usd;
    } else {
      const sellQ = tq > qty ? qty : tq;
      const basisBlock = qty > 0n ? (cost * sellQ) / qty : 0n;
      const basisUsd = qty > 0n ? (p.costUsd || 0) * (Number(sellQ) / Number(qty)) : 0;
      p.realizedBlock = (p.realizedBlock || 0) + (Number(tb) - Number(basisBlock)) / COIN;
      p.realizedUsd = (p.realizedUsd || 0) + (usd - basisUsd);
      p.qty = (qty - sellQ).toString(); p.costBlock = (cost - basisBlock).toString(); p.costUsd = Math.max(0, (p.costUsd || 0) - basisUsd);
      if (bigOf(p.qty) <= 0n) { p.qty = '0'; p.costBlock = '0'; p.costUsd = 0; }
    }
    if (t.symbol) p.symbol = t.symbol;
    p.trades.push({ side: t.side, qty: tq.toString(), blockAmt: tb.toString(), blockUsd: Number(t.blockUsd) || null, txid: t.txid || null, at: t.at || 0 });
    if (p.trades.length > 200) p.trades.splice(0, p.trades.length - 200);
    positions[key] = p;
    return positions;
  }
  // Mark a position: current value + unrealized P&L in BLOCK and USD.
  function pnl(p, priceBlock, blockUsd, liveQtyBase) {
    if (!p) return null;
    const qty = liveQtyBase != null ? bigOf(liveQtyBase) : bigOf(p.qty);
    const dec = Number(p.decimals) || 0;
    const qtyNum = Number(qty) / Math.pow(10, dec);
    const valueBlock = priceBlock > 0 ? qtyNum * priceBlock : 0;
    const costBlock = Number(bigOf(p.costBlock)) / COIN;
    const ledgerQty = Number(bigOf(p.qty)) / Math.pow(10, dec);
    // basis for the LIVE quantity (the ledger may lag on-chain if the user traded elsewhere)
    const scale = ledgerQty > 0 ? Math.min(1, qtyNum / ledgerQty) : 0;
    const basisBlock = costBlock * scale, basisUsd = (p.costUsd || 0) * scale;
    const valueUsd = blockUsd > 0 ? valueBlock * blockUsd : null;
    const unrealBlock = valueBlock - basisBlock;
    const unrealUsd = valueUsd != null ? valueUsd - basisUsd : null;
    return {
      qty: qtyNum, valueBlock, valueUsd, basisBlock, basisUsd,
      unrealizedBlock: unrealBlock, unrealizedUsd: unrealUsd,
      unrealizedPct: basisBlock > 0 ? (unrealBlock / basisBlock) * 100 : null,
      avgEntryBlock: ledgerQty > 0 ? costBlock / ledgerQty : null,
      realizedUsd: p.realizedUsd || 0, realizedBlock: p.realizedBlock || 0,
      untracked: scale === 0 && qtyNum > 0, // held but never bought through Moon
    };
  }

  // ---- safety summary for the token sheet -------------------------------------
  function warnings(t) {
    const w = [];
    const liq = Number(t.liquidityBlock) || 0;
    if (liq < 50) w.push({ code: 'thin', text: 'Very thin liquidity — even small buys move the price a lot.' });
    if (!t.lpLocked) w.push({ code: 'lp-unlocked', text: 'Liquidity is not locked — the creator can pull the pool.' });
    const age = Number(t.ageBlocks);
    if (Number.isFinite(age) && age < 144) w.push({ code: 'new', text: 'Launched less than a day ago. No track record.' });
    for (const f of (t.flags || [])) if (/honeypot|rug|scam|denylist/i.test(f)) w.push({ code: 'danger', text: 'Flagged ' + f + ' — do not buy.' });
    return w;
  }
  function fmtPct(v) { const n = Number(v); if (!Number.isFinite(n)) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 100 ? 0 : 1) + '%'; }

  const API = {
    COIN, PRESETS_USD, DEFAULT_SLIPPAGE, MAX_IMPACT_PCT,
    ammOut, minOut, toBase, fromBase, fractionOf,
    poolPriceBlock, poolLiquidityBlock, quoteBuyUsd, quoteBuyBlock, quoteSell,
    trendingScore, rank, applyTrade, pnl, warnings, fmtPct,
  };
  global.Moon = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
