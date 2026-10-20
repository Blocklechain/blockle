// portfolio.js — WALLET PORTFOLIO: unified cross-chain NET WORTH (docs/WALLET-PORTFOLIO.md §1).
//
// READ-ONLY. No signing, no money path. `portfolio(accounts, ctx)` is PURE given
// an injected balance + price ctx: it aggregates the balances the EXISTING chain
// adapters already report (BLOCK, every EVM net + custom, BTC/LTC/DOGE, Solana)
// and prices them from the SHARED live mark source (exchange book mid/last + the
// configured USD price map — the same source the bots use), injected via ctx.
//
// NEVER fabricates a price or a balance: a holding with no resolvable price goes
// to `unpriced` (shown, NOT counted, NOT guessed as 0). All money math is
// integer/BigInt-exact in micro-dollars (uc = round(usd · 1e6), the §8
// convention shared with agent/pnl.js). The clock is injected (ctx.asOf) — this
// module never calls Date.now() in its pure logic.
//
// Also a tiny append-only DAILY snapshot store ({ts, totalUsdMicro}, dedup by UTC
// day) that drives the net-worth sparkline (§2.1).
//
// Global `WalletPortfolio`; module.exports for node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  const DAY_MS = 86400000;

  // ---- exact integer helpers (mirror agent/pnl.js) --------------------------
  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (v == null || v === '') return 0n;
    const s = String(v).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
    if (!/^-?\d+$/.test(s)) throw new Error('not a base-unit integer: ' + s);
    return BigInt(s);
  }
  // round(usd · 1e6) as a BigInt of micro-dollars. Half-away-from-zero.
  function microUsd(usd) {
    if (usd == null || !isFinite(Number(usd))) return null;
    return BigInt(Math.round(Number(usd) * 1e6));
  }
  // round(num / den) for BigInts, half-away-from-zero. den > 0 required.
  function divRound(num, den) {
    if (den <= 0n) throw new Error('divRound: denominator must be > 0');
    if (num >= 0n) return (num + den / 2n) / den;
    return -(((-num) + den / 2n) / den);
  }
  // micro-dollar value of `amountBase` base units of an asset priced at
  // `priceUsd` per WHOLE unit. Exact: floor-rounded BigInt math, never a float.
  function holdingMicro(amountBase, decimals, priceUsd) {
    const pm = microUsd(priceUsd);
    if (pm == null) return null;
    const dec = Number(decimals != null ? decimals : 0);
    return divRound(toBig(amountBase) * pm, 10n ** BigInt(dec));
  }
  function microToUsd(micro) { return Number(micro) / 1e6; }

  // ---- price lookup against the injected shared mark source -----------------
  // ctx.priceUsd may be: a function(asset|symbol)->number|null (possibly async),
  // or a plain { SYMBOL: price } map. Returns a finite positive number, or null
  // (null => unpriced; a non-positive/NaN price is treated as unknown, never 0).
  async function lookupPrice(ctx, asset) {
    const sym = String((asset && asset.symbol) || '').toUpperCase();
    let v = null;
    const src = ctx && ctx.priceUsd != null ? ctx.priceUsd : (ctx && ctx.marks);
    if (typeof src === 'function') {
      try { v = await src(asset); } catch (_) { v = null; }
    } else if (src && typeof src === 'object') {
      v = src[sym] != null ? src[sym] : null;
    }
    const n = v == null ? null : Number(v);
    return (n != null && isFinite(n) && n > 0) ? n : null;
  }

  // ---- getBalance shim: adapters return [{asset, confirmed}] ------------------
  async function holdingsFor(ctx, chain, address) {
    const fn = (ctx && (ctx.getHoldings || ctx.getBalance));
    if (typeof fn !== 'function') return [];
    let rows;
    try { rows = await fn(chain, address); } catch (_) { rows = []; }
    return Array.isArray(rows) ? rows : [];
  }

  // ===========================================================================
  // portfolio(accounts, ctx) -> Portfolio
  //   accounts: [{ chain, address }]   (one per configured chain + account)
  // ===========================================================================
  async function portfolio(accounts, ctx) {
    ctx = ctx || {};
    accounts = Array.isArray(accounts) ? accounts : [];

    const holdings = [];
    const unpriced = [];
    const byChainMicro = new Map(); // chain -> BigInt micro
    let totalMicro = 0n;

    for (const acc of accounts) {
      const chain = acc && acc.chain;
      const address = acc && acc.address;
      if (!chain) continue;
      const rows = await holdingsFor(ctx, chain, address);
      for (const row of rows) {
        const asset = (row && row.asset) || {};
        const amountBase = String(row && (row.confirmed != null ? row.confirmed : row.balance) || '0');
        let amt;
        try { amt = toBig(amountBase); } catch (_) { continue; }
        if (amt <= 0n) continue; // omit dust/zero — contributes nothing
        const decimals = asset.decimals != null ? Number(asset.decimals) : 0;
        const symbol = asset.symbol || '?';
        const price = await lookupPrice(ctx, asset);
        if (price == null) {
          unpriced.push({ chain, symbol, amountBase: amt.toString(), decimals, asset });
          holdings.push({ chain, asset, symbol, amountBase: amt.toString(), decimals, priceUsd: null, usdMicro: null, usd: null, pricedOk: false });
          continue;
        }
        const micro = holdingMicro(amt, decimals, price);
        totalMicro += micro;
        byChainMicro.set(chain, (byChainMicro.get(chain) || 0n) + micro);
        holdings.push({
          chain, asset, symbol, amountBase: amt.toString(), decimals,
          priceUsd: price, usdMicro: micro.toString(), usd: microToUsd(micro), pricedOk: true,
        });
      }
    }

    // byChain with BigInt-exact pct (basis points) of the priced total, using
    // LARGEST-REMAINDER apportionment so the bps ALWAYS sum to exactly 10000
    // (independent rounding can drift to 9999/10001 and show 100.01%). Each chain
    // gets floor(micro*10000/total); the leftover bps go to the largest remainders,
    // tie-broken by chain asc for determinism.
    const byChain = [];
    const parts = [];
    for (const [chain, micro] of byChainMicro.entries()) {
      if (totalMicro > 0n) {
        const scaled = micro * 10000n;
        const bps = scaled / totalMicro;          // floor (positive operands)
        const rem = scaled % totalMicro;          // remainder for apportionment
        parts.push({ chain, micro, bps, rem });
      } else {
        parts.push({ chain, micro, bps: 0n, rem: 0n });
      }
    }
    if (totalMicro > 0n && parts.length) {
      let assigned = 0n;
      for (const p of parts) assigned += p.bps;
      let leftover = 10000n - assigned; // in [0, nChains)
      const order = parts.slice().sort((a, b) => cmpBig(b.rem.toString(), a.rem.toString()) || cmpStr(a.chain, b.chain));
      for (let i = 0; i < order.length && leftover > 0n; i++) { order[i].bps += 1n; leftover -= 1n; }
    }
    for (const p of parts) {
      const pctBps = Number(p.bps);
      byChain.push({ chain: p.chain, usdMicro: p.micro.toString(), usd: microToUsd(p.micro), pctBps, pct: pctBps / 100 });
    }
    // deterministic ordering: priced holdings by value desc then chain/symbol;
    // byChain by value desc then chain.
    byChain.sort((a, b) => cmpBig(b.usdMicro, a.usdMicro) || cmpStr(a.chain, b.chain));
    holdings.sort((a, b) => {
      const av = a.pricedOk ? 1 : 0, bv = b.pricedOk ? 1 : 0;
      if (av !== bv) return bv - av; // priced first
      const byVal = cmpBig(b.usdMicro || '0', a.usdMicro || '0');
      if (byVal) return byVal;
      return cmpStr(a.chain, b.chain) || cmpStr(a.symbol, b.symbol);
    });
    unpriced.sort((a, b) => cmpStr(a.chain, b.chain) || cmpStr(a.symbol, b.symbol));

    return {
      totalUsdMicro: totalMicro.toString(),
      totalUsd: microToUsd(totalMicro),
      byChain,
      holdings,
      unpriced,
      asOf: ctx.asOf != null ? ctx.asOf : null,
    };
  }

  function cmpBig(a, b) { const x = toBig(a), y = toBig(b); return x < y ? -1 : x > y ? 1 : 0; }
  function cmpStr(a, b) { a = String(a || ''); b = String(b || ''); return a < b ? -1 : a > b ? 1 : 0; }

  // ===========================================================================
  // §2.1 DAILY SNAPSHOT STORE — append-only, dedup by UTC day. Pure: the caller
  // injects `ts` (never a clock call here). An entry carries the net-worth total
  // in micro-dollars (BigInt-exact string) so the sparkline is lossless.
  // ===========================================================================
  function dayOf(ts) { return Math.floor(Number(ts) / DAY_MS); }

  // Append {ts, totalUsdMicro} to `history` (array, oldest→newest). Dedup by day:
  // a second write for a day REPLACES that day's point (latest total for the day
  // wins). Returns a NEW sorted array; never mutates the input.
  function recordSnapshot(history, entry) {
    const list = Array.isArray(history) ? history.slice() : [];
    const ts = Number(entry && entry.ts);
    if (!isFinite(ts)) throw new Error('recordSnapshot: ts (ms) is required');
    const totalUsdMicro = String((entry && (entry.totalUsdMicro != null ? entry.totalUsdMicro : entry.totalUsd)) || '0');
    const day = dayOf(ts);
    const point = { ts, day, totalUsdMicro };
    const i = list.findIndex((p) => p.day === day);
    if (i >= 0) list[i] = point; else list.push(point);
    list.sort((a, b) => a.ts - b.ts);
    return list;
  }

  // The last `n` points (default 30) as {ts, totalUsdMicro, usd} for the sparkline.
  function sparkline(history, n) {
    const list = Array.isArray(history) ? history : [];
    const take = n != null ? Number(n) : 30;
    return list.slice(Math.max(0, list.length - take)).map((p) => ({
      ts: p.ts, totalUsdMicro: String(p.totalUsdMicro), usd: microToUsd(toBig(p.totalUsdMicro)),
    }));
  }

  const API = {
    portfolio,
    // snapshot store:
    dayOf, recordSnapshot, sparkline,
    // helpers exported for tests / ports:
    microUsd, divRound, holdingMicro, microToUsd, toBig, lookupPrice,
    DAY_MS,
  };
  global.WalletPortfolio = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
