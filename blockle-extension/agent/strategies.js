// agent/strategies.js — the TRADING-STRATEGY engine (planners only). See the
// shared spec docs/AGENT-STRATEGIES.md and the shared fixture
// docs/strategy-vectors.json. The three wallets (JS here, Dart, Python) must
// behave IDENTICALLY: same names, params, defaults, and numeric decisions,
// checked against that fixture.
//
// SAFETY MODEL (non-negotiable): a Strategy is a PLANNER, never an executor. It
// NEVER signs, broadcasts, or touches keys. plan() reads market/balance data via
// the READ-ONLY ctx accessors and returns a list of Intents. Every Intent is
// dispatched by the StrategyRunner through the EXISTING value-moving pipeline
// (prepare -> policy.assessValue -> policy.gateConfirm -> commit -> recordSpend),
// so caps / confirm / allowlist / kill / audit / the 0.05% fee all still apply and
// CANNOT be bypassed here.
//
// Conventions matched to the shared fixture:
//   - amounts are BASE-UNIT integer strings; USD->base conversion FLOORS.
//   - venue bid/ask and order prices are DECIMAL (quote per whole base).
//   - bps params are integers; the per-leg agent fee defaults to 5 bps (0.05%).
//   - the clock is injected as ctx.now(); pure logic never calls Date.now.
//
// Exposed as global `AgentStrategies`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  const AGENT_FEE_BPS = 5; // per leg (0.05%); agentFeeBps is FLOORED here — never below this
  const SLIPPAGE_FLOOR_BPS = 5; // conservative non-zero slippage floor (matches shared vectors)

  const DEFAULT_DECIMALS = {
    BLOCK: 8, BTC: 8, LTC: 8, DOGE: 8,
    USDC: 6, USDT: 6, DAI: 6, USD: 2,
    ETH: 18, WETH: 18, SOL: 9,
  };
  const STABLE_USD = { USDC: 1, USDT: 1, DAI: 1, USD: 1 };

  // ---- pure helpers ---------------------------------------------------------
  function splitPair(pair) {
    const parts = String(pair || '').toUpperCase().split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('bad pair (want BASE/QUOTE): ' + pair);
    return [parts[0], parts[1]];
  }
  function decimalsFor(sym, p) {
    const over = p && p.decimals && p.decimals[sym];
    if (over != null) return Number(over);
    const d = DEFAULT_DECIMALS[String(sym).toUpperCase()];
    return d != null ? d : 8;
  }
  function pow10(n) { return Math.pow(10, n); }
  function pow10n(n) { return 10n ** BigInt(n); }
  // Canonical decimal->integer scaling shared across JS/Dart/Python: render a JS
  // number with USD_SCALE fixed decimal places (rounds away float noise exactly as
  // fmtNum does) then parse the digits as a BigInt scaled by 10^USD_SCALE. This is
  // deterministic and lossless for the decimal the caller intended.
  const USD_SCALE = 12;
  function toScaled(x) {
    const n = Number(x);
    if (!isFinite(n)) return 0n;
    const neg = n < 0;
    const s = Math.abs(n).toFixed(USD_SCALE);
    const dot = s.indexOf('.');
    const intPart = dot < 0 ? s : s.slice(0, dot);
    const fracPart = dot < 0 ? '' : s.slice(dot + 1);
    const digits = intPart + fracPart.padEnd(USD_SCALE, '0').slice(0, USD_SCALE);
    const v = BigInt(digits);
    return neg ? -v : v;
  }
  // USD -> base units of an asset priced at `unitUsd` USD per whole token. FLOORS.
  // BigInt-exact (no float multiply): floor(usd / unitUsd * 10^decimals) computed
  // entirely in integer space so 18-decimal assets lose no low digits and the
  // result is identical across JS/Dart/Python (FIX-4).
  function usdToBase(usd, decimals, unitUsd) {
    if (!(unitUsd > 0) || !(usd > 0)) return 0n;
    const den = toScaled(unitUsd);
    if (den <= 0n) return 0n;
    // usdScaled and unitScaled share the 10^USD_SCALE factor, which cancels.
    const num = toScaled(usd) * pow10n(decimals);
    const q = num / den; // BigInt division truncates toward zero == floor for >= 0
    return q > 0n ? q : 0n;
  }
  // base units -> quote base units at a decimal price (quote per whole base). FLOORS.
  // BigInt-exact; used when a depth-clamped arb leg must reprice the quote spend.
  function baseToQuote(baseUnits, bd, qd, price) {
    const p = toScaled(price);
    if (p <= 0n || baseUnits <= 0n) return 0n;
    const num = baseUnits * p * pow10n(qd);
    const den = pow10n(bd) * pow10n(USD_SCALE);
    const q = num / den;
    return q > 0n ? q : 0n;
  }
  function num(v, dflt) { const n = Number(v); return isFinite(n) ? n : dflt; }
  function clampInt(v, lo, hi, dflt) {
    let n = Math.trunc(Number(v));
    if (!isFinite(n)) n = dflt;
    return Math.max(lo, Math.min(hi, n));
  }
  // clean decimal string: trims float noise + trailing zeros (0.99, 1, 1.02).
  function fmtNum(x) { return String(+Number(x).toFixed(12)); }
  async function call0(fn) { return typeof fn === 'function' ? await fn() : undefined; }
  async function call1(fn, a) { return typeof fn === 'function' ? await fn(a) : undefined; }
  function emptyPlan(reason) { const a = []; if (reason) a.skipped = reason; return a; }
  function mainnetOf(ctx) { try { return !!(ctx && typeof ctx.network === 'function' && ctx.network() === 'mainnet'); } catch (_) { return false; } }
  function venueMainnet(v) { return v && (v.mainnet === true || v.network === 'mainnet'); }

  function intent(o) {
    return {
      tool: o.tool,
      args: o.args,
      rationale: o.rationale,
      estUsd: o.estUsd != null ? o.estUsd : null,
      strategy: o.strategy,
      tag: o.tag,
      group: o.group || null,       // paired legs share a group id (arbitrage)
      mainnet: !!o.mainnet,         // routes through a mainnet venue?
    };
  }

  // Normalize a balances source (array of rows or {sym:base} map) to {SYM: BigInt}
  // and a decimals map derived from row.asset.decimals where present.
  async function portfolio(ctx, p) {
    let rows = p.balances || p.holdings;
    if (!rows) {
      if (typeof ctx.getBalances === 'function') rows = await ctx.getBalances();
      else if (typeof ctx.balances === 'function') rows = await ctx.balances();
    }
    if (!rows) return null;
    const held = {}, dec = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const a = r.asset || {};
        const sym = String(a.symbol != null ? a.symbol : r.symbol || '').toUpperCase();
        if (!sym) continue;
        held[sym] = BigInt(String(r.confirmed != null ? r.confirmed : (r.balance != null ? r.balance : '0')));
        if (a.decimals != null) dec[sym] = Number(a.decimals);
      }
    } else {
      for (const [k, v] of Object.entries(rows)) held[String(k).toUpperCase()] = BigInt(String(v));
    }
    return { held, dec };
  }

  // ===========================================================================
  // 3.1 arbitrage (headline)
  // ===========================================================================
  const arbitrage = {
    name: 'arbitrage',
    describe() { return 'Capture a cross-venue price gap on one pair, net of both venues\' fees, two 0.05% agent legs, slippage and gas.'; },
    defaults: { pair: null, venues: null, minEdgeBps: 30, maxNotionalUsd: 50, gasBufferUsd: 2, slippageBps: 10, agentFeeBps: AGENT_FEE_BPS },
    validateParams(params) {
      const p = Object.assign({}, this.defaults, params || {});
      if (!p.pair) throw new Error('arbitrage requires a pair, e.g. "BLOCK/USDC"');
      splitPair(p.pair);
      p.minEdgeBps = Math.max(0, Math.trunc(num(p.minEdgeBps, 30)));
      p.maxNotionalUsd = Math.max(0, num(p.maxNotionalUsd, 50));
      p.gasBufferUsd = Math.max(0, num(p.gasBufferUsd, 2));
      // FIX-2: slippage has a conservative non-zero floor, and the agent-fee term
      // is pinned at the REAL mandatory rate — a caller can never configure either
      // below what the swap pipeline actually charges (0 would price a loss-maker).
      p.slippageBps = Math.max(SLIPPAGE_FLOOR_BPS, Math.trunc(num(p.slippageBps, 10)));
      p.agentFeeBps = Math.max(AGENT_FEE_BPS, Math.trunc(num(p.agentFeeBps, AGENT_FEE_BPS)));
      if (p.venues != null && !Array.isArray(p.venues)) throw new Error('arbitrage venues must be an array');
      return p;
    },
    async plan(ctx, p) {
      const [base, quote] = splitPair(p.pair);

      // venue descriptors carry id + executable bid/ask (quote per base) + feeBps.
      // If a descriptor has no bid/ask, fall back to ctx.venueQuote probing.
      let venueList = p.venues && p.venues.length ? p.venues : await call1(ctx.listVenues, p.pair);
      venueList = (venueList || []).map((v) => (typeof v === 'string' ? { id: v } : v)).filter((v) => v && v.id);
      if (venueList.length < 2) return emptyPlan('need >= 2 venues');

      const rem = await call0(ctx.policyRemaining);
      const sessionUsd = rem && rem.sessionUsd != null ? Number(rem.sessionUsd) : null;
      const notionalUsd = Math.min(p.maxNotionalUsd, sessionUsd != null ? sessionUsd : p.maxNotionalUsd);
      if (!(notionalUsd > 0)) return emptyPlan('no notional budget (cap exhausted)');

      const prices = (await call1(ctx.prices, [base, quote])) || {};
      const quoteUsd = num(prices[quote], STABLE_USD[quote] != null ? STABLE_USD[quote] : 1);
      if (!(quoteUsd > 0)) return emptyPlan('no USD price for quote ' + quote);
      const bd = decimalsFor(base, p), qd = decimalsFor(quote, p);

      const rows = [];
      for (const v of venueList) {
        let ask = v.ask != null ? Number(v.ask) : NaN;
        let bid = v.bid != null ? Number(v.bid) : NaN;
        let feeBps = num(v.feeBps, 0);
        if (!(ask > 0) || !(bid > 0)) {
          // derive from venueQuote at a probe size if the descriptor lacks prices
          try {
            const probeBase = usdToBase(notionalUsd, bd, quoteUsd); // rough probe
            const sell = await ctx.venueQuote(v.id, base, quote, probeBase.toString());
            const buy = await ctx.venueQuote(v.id, quote, base, usdToBase(notionalUsd, qd, quoteUsd).toString());
            if (!sell || !buy || sell.out == null || buy.out == null) continue;
            bid = (Number(sell.out) / pow10(qd)) / (Number(probeBase) / pow10(bd));
            ask = (notionalUsd / quoteUsd) / (Number(buy.out) / pow10(bd));
            feeBps = num(sell.feeBps, feeBps);
          } catch (_) { continue; }
        }
        if (!(ask > 0) || !(bid > 0)) continue;
        rows.push({ id: v.id, ask, bid, feeBps, mainnet: venueMainnet(v), depthBase: v.depthBase != null ? BigInt(String(v.depthBase)) : null });
      }
      if (rows.length < 2) return emptyPlan('fewer than 2 venues could quote');

      const buyV = rows.reduce((a, b) => (b.ask < a.ask ? b : a));   // lowest ask
      const sellV = rows.reduce((a, b) => (b.bid > a.bid ? b : a));  // highest bid
      if (buyV.id === sellV.id) return emptyPlan('best bid and ask are the same venue — no edge');

      // gross edge is independent of size.
      const grossEdgeBps = ((sellV.bid - buyV.ask) / buyV.ask) * 10000;

      // Size FIRST: balanced buy `baseUnits` of base, sell the SAME amount, clamped
      // to the shallower venue's depth. (notionalUsd/quoteUsd) whole quote budget /
      // ask -> whole base -> base units.
      const fullBase = usdToBase(notionalUsd / quoteUsd, bd, buyV.ask);
      let baseUnits = fullBase;
      if (buyV.depthBase && buyV.depthBase < baseUnits) baseUnits = buyV.depthBase;
      if (sellV.depthBase && sellV.depthBase < baseUnits) baseUnits = sellV.depthBase;
      if (baseUnits <= 0n) return emptyPlan('size rounds to zero');

      // FIX-1: recompute ALL USD-denominated costs on the ACTUAL (possibly
      // depth-clamped) executed notional, not the full probe, then RE-RUN the net
      // edge test. A fat gross edge on a shallow book must not emit a loss-maker:
      // gas is a fixed USD buffer, so its bps cost explodes as notional shrinks.
      const execUsd = (Number(baseUnits) / pow10(bd)) * buyV.ask * quoteUsd;
      if (!(execUsd > 0)) return emptyPlan('size rounds to zero');
      const gasBps = (p.gasBufferUsd / execUsd) * 10000;
      const costsBps = buyV.feeBps + sellV.feeBps + (2 * p.agentFeeBps) + p.slippageBps + gasBps;
      const netEdgeBps = grossEdgeBps - costsBps;
      if (netEdgeBps < p.minEdgeBps) {
        return emptyPlan('edge < min (net ' + netEdgeBps.toFixed(2) + 'bps < ' + p.minEdgeBps + 'bps; gross ' + grossEdgeBps.toFixed(2) + ', costs ' + costsBps.toFixed(2) + ')');
      }

      // quote spent on the buy leg = full notional (when NOT depth-clamped), else
      // the clamped baseUnits repriced to quote base units (BigInt-exact).
      const buyAmt = (baseUnits === fullBase)
        ? usdToBase(notionalUsd, qd, quoteUsd).toString()
        : baseToQuote(baseUnits, bd, qd, buyV.ask).toString();
      const sellAmt = baseUnits.toString();
      // FIX-3: mainnet is true if EITHER venue is a mainnet descriptor OR the chain
      // context reports mainnet — never only the venue markers.
      const mainnet = venueMainnet(buyV) || venueMainnet(sellV) || mainnetOf(ctx);
      // FIX-1: report the ACTUAL clamped notional, not the full probe.
      const estUsd = Math.round(execUsd * 100) / 100;
      const group = 'arb:' + p.pair + ':' + buyV.id + '->' + sellV.id;
      const rationale = 'arb ' + p.pair + ': buy ' + base + ' @ ' + fmtNum(buyV.ask) + ' on ' + buyV.id +
        ', sell @ ' + fmtNum(sellV.bid) + ' on ' + sellV.id +
        '; net ' + netEdgeBps.toFixed(1) + 'bps (gross ' + grossEdgeBps.toFixed(1) + ' - costs ' + costsBps.toFixed(1) + ') on $' + estUsd;

      // balanced two-leg pair, tagged as one group. Both legs or neither.
      return [
        intent({ tool: 'swap', args: { from: quote, to: base, amount: buyAmt, venue: buyV.id }, rationale, estUsd, strategy: 'arbitrage', tag: group + ':buy', group, mainnet }),
        intent({ tool: 'swap', args: { from: base, to: quote, amount: sellAmt, venue: sellV.id }, rationale, estUsd, strategy: 'arbitrage', tag: group + ':sell', group, mainnet }),
      ];
    },
  };

  // ===========================================================================
  // 3.2 dca (dollar-cost averaging)
  // ===========================================================================
  const dca = {
    name: 'dca',
    describe() { return 'Buy a fixed USD amount of an asset every interval, regardless of price.'; },
    defaults: { asset: null, quote: 'USDC', usdPerBuy: 10, intervalSec: 86400, lastRunAt: 0 },
    validateParams(params) {
      const p = Object.assign({}, this.defaults, params || {});
      if (!p.asset) throw new Error('dca requires an asset');
      p.asset = String(p.asset).toUpperCase();
      p.quote = String(p.quote || 'USDC').toUpperCase();
      p.usdPerBuy = Math.max(0, num(p.usdPerBuy, 10));
      p.intervalSec = Math.max(1, Math.trunc(num(p.intervalSec, 86400)));
      p.lastRunAt = Math.max(0, Math.trunc(num(p.lastRunAt, 0)));
      return p;
    },
    async plan(ctx, p) {
      const now = Number(ctx.now ? ctx.now() : 0);
      if (now - p.lastRunAt < p.intervalSec * 1000) return emptyPlan('interval not elapsed');
      if (!(p.usdPerBuy > 0)) return emptyPlan('usdPerBuy is zero');
      const qd = decimalsFor(p.quote, p);
      const quoteUsd = STABLE_USD[p.quote] != null ? STABLE_USD[p.quote] : num((await call1(ctx.prices, [p.quote]) || {})[p.quote], 1);
      const amount = usdToBase(p.usdPerBuy, qd, quoteUsd).toString();
      if (amount === '0') return emptyPlan('buy size rounds to zero');
      const mainnet = mainnetOf(ctx);
      return [intent({
        tool: 'swap',
        args: { from: p.quote, to: p.asset, amount, venue: 'blockle' },
        rationale: 'dca: buy $' + p.usdPerBuy + ' of ' + p.asset + ' with ' + p.quote + ' (interval ' + p.intervalSec + 's)',
        estUsd: p.usdPerBuy, strategy: 'dca', tag: 'dca:' + p.asset, mainnet,
      })];
    },
  };

  // ===========================================================================
  // 3.3 grid
  // ===========================================================================
  const grid = {
    name: 'grid',
    describe() { return 'Place a ladder of limit buys below and limit sells above the mid price.'; },
    defaults: { market: null, levels: 6, stepBps: 50, sizeUsdPerLevel: 10, recenter: false, openOrders: null },
    validateParams(params) {
      const p = Object.assign({}, this.defaults, params || {});
      if (!p.market) throw new Error('grid requires a market');
      splitPair(p.market);
      p.levels = clampInt(p.levels, 2, 20, 6);
      p.stepBps = Math.max(1, Math.trunc(num(p.stepBps, 50)));
      p.sizeUsdPerLevel = Math.max(0, num(p.sizeUsdPerLevel, 10));
      p.recenter = !!p.recenter;
      return p;
    },
    async plan(ctx, p) {
      const [base, quote] = splitPair(p.market);
      const book = await call1(ctx.getBook, p.market);
      const mid = bookMid(book);
      if (!(mid > 0)) return emptyPlan('no mid price from book');
      if (!(p.sizeUsdPerLevel > 0)) return emptyPlan('sizeUsdPerLevel is zero');
      const bd = decimalsFor(base, p), qd = decimalsFor(quote, p);
      const quoteUsd = STABLE_USD[quote] != null ? STABLE_USD[quote] : num((await call1(ctx.prices, [quote]) || {})[quote], 1);
      const half = Math.floor(p.levels / 2);
      const openOrders = p.openOrders || (ctx.openOrders ? await call1(ctx.openOrders, p.market) : []) || [];
      const halfStepTol = mid * ((p.stepBps / 1e4) / 2); // "within half a step"
      const mainnet = mainnetOf(ctx);

      const buys = [], sells = [];
      for (let k = 1; k <= half; k++) {
        const stepFrac = (k * p.stepBps) / 1e4;
        const buyPrice = mid * (1 - stepFrac);
        const sellPrice = mid * (1 + stepFrac);
        if (buyPrice > 0 && !occupied(openOrders, buyPrice, halfStepTol)) buys.push(gridOrder(p, quote, 'buy', buyPrice, bd, quoteUsd, mainnet, k));
        if (!occupied(openOrders, sellPrice, halfStepTol)) sells.push(gridOrder(p, quote, 'sell', sellPrice, bd, quoteUsd, mainnet, k));
      }
      return buys.concat(sells); // all buys then all sells (matches shared fixture)
    },
  };
  function gridOrder(p, quote, side, price, bd, quoteUsd, mainnet, k) {
    // amount = base units of base sized to sizeUsdPerLevel at this price.
    // price field = the DECIMAL price (quote per whole base), as a string.
    const priceUsd = price * quoteUsd;
    const amount = usdToBase(p.sizeUsdPerLevel, bd, priceUsd).toString();
    return intent({
      tool: 'place_order',
      args: { market: p.market, side, type: 'limit', amount, price: fmtNum(price) },
      rationale: 'grid ' + side + ' L' + k + ' @ ' + fmtNum(price) + ' ' + quote + ' (' + p.sizeUsdPerLevel + ' USD)',
      estUsd: p.sizeUsdPerLevel, strategy: 'grid', tag: 'grid:' + p.market + ':' + side + ':' + k, mainnet,
    });
  }
  function bookMid(book) {
    if (!book) return NaN;
    if (book.mid != null) return Number(book.mid);
    const bb = book.bids && book.bids[0];
    const ba = book.asks && book.asks[0];
    const bestBid = bb ? Number(bb.price != null ? bb.price : bb[0]) : NaN;
    const bestAsk = ba ? Number(ba.price != null ? ba.price : ba[0]) : NaN;
    if (isFinite(bestBid) && isFinite(bestAsk)) return (bestBid + bestAsk) / 2;
    return NaN;
  }
  function occupied(openOrders, price, tol) {
    for (const o of openOrders || []) {
      const op = Number(o.price != null ? o.price : (Array.isArray(o) ? o[0] : NaN));
      if (isFinite(op) && Math.abs(op - price) <= tol) return true;
    }
    return false;
  }

  // ===========================================================================
  // 3.4 rebalance
  // ===========================================================================
  const rebalance = {
    name: 'rebalance',
    describe() { return 'Trade assets whose weight drifts outside the band back toward target, closing half the gap.'; },
    defaults: { targets: null, bandBps: 500, baseQuote: 'USDC', maxTradeUsd: 50, balances: null, holdings: null },
    validateParams(params) {
      const p = Object.assign({}, this.defaults, params || {});
      if (!p.targets || typeof p.targets !== 'object' || !Object.keys(p.targets).length) {
        throw new Error('rebalance requires a non-empty targets map');
      }
      const t = {};
      let sum = 0;
      for (const [k, v] of Object.entries(p.targets)) { const w = Number(v); if (!(w >= 0)) throw new Error('bad target weight for ' + k); t[String(k).toUpperCase()] = w; sum += w; }
      if (sum <= 0) throw new Error('target weights sum to zero');
      if (Math.abs(sum - 1) > 0.02) throw new Error('target weights must sum to ~1.0 (got ' + sum.toFixed(3) + ')');
      p.targets = t;
      p.bandBps = Math.max(0, Math.trunc(num(p.bandBps, 500)));
      p.baseQuote = String(p.baseQuote || 'USDC').toUpperCase();
      p.maxTradeUsd = Math.max(0, num(p.maxTradeUsd, 50));
      return p;
    },
    async plan(ctx, p) {
      const symbols = Array.from(new Set(Object.keys(p.targets).concat([p.baseQuote])));
      const prices = (await call1(ctx.prices, symbols)) || {};
      const port = await portfolio(ctx, p);
      if (!port) return emptyPlan('no balances available');

      const valueUsd = {};
      let totalUsd = 0;
      for (const sym of Object.keys(p.targets)) {
        const unit = num(prices[sym], STABLE_USD[sym] != null ? STABLE_USD[sym] : NaN);
        if (!(unit > 0)) return emptyPlan('no USD price for ' + sym + ' — not fabricating one');
        const dec = port.dec[sym] != null ? port.dec[sym] : decimalsFor(sym, p);
        const whole = Number(port.held[sym] != null ? port.held[sym] : 0n) / pow10(dec);
        const v = whole * unit;
        valueUsd[sym] = v;
        totalUsd += v;
      }
      if (!(totalUsd > 0)) return emptyPlan('portfolio value is zero');

      const quoteUsd = num(prices[p.baseQuote], STABLE_USD[p.baseQuote] != null ? STABLE_USD[p.baseQuote] : 1);
      const qd = port.dec[p.baseQuote] != null ? port.dec[p.baseQuote] : decimalsFor(p.baseQuote, p);
      const mainnet = mainnetOf(ctx);
      const out = [];
      for (const sym of Object.keys(p.targets)) {
        if (sym === p.baseQuote) continue; // the funding leg is not itself rebalanced
        const target = p.targets[sym];
        const actual = valueUsd[sym] / totalUsd;
        const driftBps = Math.abs(actual - target) * 10000;
        if (driftBps <= p.bandBps) continue;              // inside the band
        // gap in USD computed from values (not weights) to avoid float drift.
        const gapUsd = Math.abs(valueUsd[sym] - target * totalUsd);
        const tradeUsd = Math.min(gapUsd / 2, p.maxTradeUsd); // close HALF the gap
        if (!(tradeUsd > 0)) continue;
        const overweight = actual > target;
        const unit = num(prices[sym], STABLE_USD[sym]);
        const dec = port.dec[sym] != null ? port.dec[sym] : decimalsFor(sym, p);
        const estUsd = Math.round(tradeUsd * 100) / 100;
        if (overweight) {
          out.push(intent({
            tool: 'swap', args: { from: sym, to: p.baseQuote, amount: usdToBase(tradeUsd, dec, unit).toString(), venue: 'blockle' },
            rationale: 'rebalance SELL ' + sym + ' (' + (actual * 100).toFixed(1) + '% vs ' + (target * 100).toFixed(1) + '% target) ~$' + tradeUsd.toFixed(2),
            estUsd, strategy: 'rebalance', tag: 'rebalance:' + sym, mainnet,
          }));
        } else {
          out.push(intent({
            tool: 'swap', args: { from: p.baseQuote, to: sym, amount: usdToBase(tradeUsd, qd, quoteUsd).toString(), venue: 'blockle' },
            rationale: 'rebalance BUY ' + sym + ' (' + (actual * 100).toFixed(1) + '% vs ' + (target * 100).toFixed(1) + '% target) ~$' + tradeUsd.toFixed(2),
            estUsd, strategy: 'rebalance', tag: 'rebalance:' + sym, mainnet,
          }));
        }
      }
      return out; // at most one Intent per asset per tick
    },
  };

  // ===========================================================================
  // 3.5 momentum (SMA crossover)
  // ===========================================================================
  const momentum = {
    name: 'momentum',
    describe() { return 'SMA crossover: buy on a golden cross (short over long), sell held on a death cross.'; },
    // feeAwareMarginBps + roundTripCostBps implement LEVER 3 (fee-aware trade gate)
    // for the directional ENTRY: only BUY when the expected move clears the round-
    // trip cost of the chosen route PLUS a margin. BOTH default to 0 => the gate is
    // a NO-OP (today's behavior, shared fixtures unchanged); set them to arm it.
    defaults: { market: null, shortN: 10, longN: 30, tradeUsd: 20, history: null, held: null, balances: null, feeAwareMarginBps: 0, roundTripCostBps: 0 },
    validateParams(params) {
      const p = Object.assign({}, this.defaults, params || {});
      if (!p.market) throw new Error('momentum requires a market');
      splitPair(p.market);
      p.shortN = Math.max(1, Math.trunc(num(p.shortN, 10)));
      p.longN = Math.max(2, Math.trunc(num(p.longN, 30)));
      if (p.shortN >= p.longN) throw new Error('momentum needs shortN < longN');
      p.tradeUsd = Math.max(0, num(p.tradeUsd, 20));
      p.feeAwareMarginBps = Math.max(0, num(p.feeAwareMarginBps, 0));
      p.roundTripCostBps = Math.max(0, num(p.roundTripCostBps, 0));
      return p;
    },
    async plan(ctx, p) {
      const [base, quote] = splitPair(p.market);
      const history = (p.history || (ctx.getHistory ? await call1(ctx.getHistory, p.market) : null) || []).map(Number);
      if (history.length < p.longN) return emptyPlan('need >= longN (' + p.longN + ') prices, have ' + history.length);
      if (!(p.tradeUsd > 0)) return emptyPlan('tradeUsd is zero');

      const n = history.length;
      const sma = (endIdx, win) => { let s = 0; for (let i = endIdx - win + 1; i <= endIdx; i++) s += history[i]; return s / win; };
      const prevShort = sma(n - 2, p.shortN), currShort = sma(n - 1, p.shortN);
      const prevLong = sma(n - 2, p.longN), currLong = sma(n - 1, p.longN);
      const golden = prevShort <= prevLong && currShort > currLong;
      const death = prevShort >= prevLong && currShort < currLong;
      if (!golden && !death) return emptyPlan('no cross (SMA' + p.shortN + ' ' + currShort.toFixed(4) + ' vs SMA' + p.longN + ' ' + currLong.toFixed(4) + ')');

      const price = history[n - 1];
      if (!(price > 0)) return emptyPlan('non-positive latest price');
      const bd = decimalsFor(base, p), qd = decimalsFor(quote, p);
      // FIX-4: NO fabricated $1. Stable quotes use their peg; a non-stable quote
      // MUST be priced from ctx.prices — if it has no positive price, refuse rather
      // than default to 1 (which would mis-size every non-stable-quote pair).
      const quoteUsd = STABLE_USD[quote] != null ? STABLE_USD[quote] : num((await call1(ctx.prices, [quote]) || {})[quote], NaN);
      if (!(quoteUsd > 0)) return emptyPlan('no reliable quote price for ' + quote);
      const baseUsd = price * quoteUsd;
      const mainnet = mainnetOf(ctx);

      if (golden) {
        // LEVER 3 — FEE-AWARE ENTRY GATE. Only ENTER when the EXPECTED MOVE clears
        // the round-trip cost of the chosen route + the configured margin. The
        // expected move is the realized trend that PRODUCED the cross — the short-
        // window trailing return (price now vs `shortN` candles ago), NOT the SMA gap
        // at the cross itself (which is ~0 by construction at any crossover and so
        // would veto winners and whipsaws alike). This SKIPS fee-bleeding sub-
        // threshold entries only; a genuinely strong move is never suppressed. No-op
        // when feeAwareMarginBps and roundTripCostBps are both 0 (default). Exits
        // (death cross) are NEVER gated — risk reduction must always be allowed.
        const gateBps = p.roundTripCostBps + p.feeAwareMarginBps;
        if (gateBps > 0) {
          const back = history[n - 1 - p.shortN];
          const expectedMoveBps = (back > 0) ? ((history[n - 1] - back) / back) * 10000 : 0;
          if (!(expectedMoveBps >= gateBps)) {
            return emptyPlan('momentum entry below fee-aware threshold (expected move ' + expectedMoveBps.toFixed(2) + 'bps < roundtrip+margin ' + gateBps.toFixed(2) + 'bps)');
          }
        }
        return [intent({
          tool: 'swap', args: { from: quote, to: base, amount: usdToBase(p.tradeUsd, qd, quoteUsd).toString(), venue: 'blockle' },
          rationale: 'momentum GOLDEN cross ' + p.market + ': SMA' + p.shortN + ' crossed above SMA' + p.longN + ' — buy $' + p.tradeUsd,
          estUsd: p.tradeUsd, strategy: 'momentum', tag: 'momentum:' + p.market + ':buy', mainnet,
        })];
      }
      // death cross -> SELL, but only what is held.
      let heldBase = 0n;
      if (p.held != null) heldBase = BigInt(String(p.held));
      else { const port = await portfolio(ctx, p); if (port) heldBase = port.held[base] || 0n; }
      if (heldBase <= 0n) return emptyPlan('death cross but nothing held to sell');
      const wantBase = usdToBase(p.tradeUsd, bd, baseUsd);
      const sellBase = wantBase < heldBase ? wantBase : heldBase; // only what's held
      if (sellBase <= 0n) return emptyPlan('death cross but sell size rounds to zero');
      const sellUsd = (Number(sellBase) / pow10(bd)) * baseUsd;
      return [intent({
        tool: 'swap', args: { from: base, to: quote, amount: sellBase.toString(), venue: 'blockle' },
        rationale: 'momentum DEATH cross ' + p.market + ': SMA' + p.shortN + ' crossed below SMA' + p.longN + ' — sell held',
        estUsd: Math.round(sellUsd * 100) / 100, strategy: 'momentum', tag: 'momentum:' + p.market + ':sell', mainnet,
      })];
    },
  };

  // ===========================================================================
  // 3.6 indicator planners (ported from the paper bot engine in
  //     services/accounts/src/bots.js step()). These are PURE + STATELESS: every
  //     indicator is recomputed from p.history (oldest->newest) each tick, and any
  //     cross-state (prev relation for macd/emacross) is DERIVED from the window —
  //     exactly as momentum recomputes golden/death from history[n-2]/history[n-1].
  //     The StrategyRunner host persists the per-strategy price ring and supplies
  //     it as p.history. These 9 reproduce the AUTHORITATIVE server decisions in
  //     bots.js step() so "USE THIS STRATEGY" behaves like its ranked backtest:
  //       - BUY size = posUsd = budgetUsd*positionPct/100 (the server's posUsd),
  //         CLAMPED to the remaining session budget (the LIVE risk bound). Never a
  //         bounded tradeUsd slice (that diverged from the ranked backtest).
  //       - SELL = FULL liquidation of the held base (server sellAll), clamped so
  //         it never exceeds what is held.
  //       - QUOTE price: stable peg, else the live ctx.prices price; a non-stable
  //         quote with no price REFUSES (no fabricated $1).
  //     scalp + martingale are DROPPED here (per-position-state strategies that a
  //     stateless planner cannot safely reproduce) — they stay PAPER-only in bots.js.
  // ===========================================================================

  // ---- deterministic indicators (ported VERBATIM from bots.js; null until warm) --
  function smaH(h, n) { if (h.length < n) return null; let t = 0; for (let i = h.length - n; i < h.length; i++) t += h[i]; return t / n; }
  function stdevH(h, n) { const m = smaH(h, n); if (m == null) return null; let t = 0; for (let i = h.length - n; i < h.length; i++) t += (h[i] - m) ** 2; return Math.sqrt(t / n); }
  function emaH(h, n) { if (h.length < n) return null; const k = 2 / (n + 1); let e = h[0]; for (let i = 1; i < h.length; i++) e = h[i] * k + e * (1 - k); return e; }
  function macdH(h, fast, slow, signalP) {
    if (h.length < slow + signalP) return null;
    const kf = 2 / (fast + 1), ks = 2 / (slow + 1), kg = 2 / (signalP + 1);
    let ef = h[0], es = h[0], sig = null;
    for (let i = 1; i < h.length; i++) { ef = h[i] * kf + ef * (1 - kf); es = h[i] * ks + es * (1 - ks); const m = ef - es; sig = sig == null ? m : m * kg + sig * (1 - kg); }
    return { macd: ef - es, signal: sig };
  }
  function rsiH(h, n) {
    if (h.length < n + 1) return null;
    let up = 0, dn = 0;
    for (let i = h.length - n; i < h.length; i++) { const d = h[i] - h[i - 1]; if (d >= 0) up += d; else dn -= d; }
    if (dn === 0) return 100;
    const rs = (up / n) / (dn / n);
    return 100 - 100 / (1 + rs);
  }
  function donHighH(h, n) { return h.length < n + 1 ? null : Math.max.apply(null, h.slice(h.length - 1 - n, h.length - 1)); }
  function donLowH(h, n) { return h.length < n + 1 ? null : Math.min.apply(null, h.slice(h.length - 1 - n, h.length - 1)); }
  function rocH(h, n) { return h.length < n + 1 ? null : (h[h.length - 1] - h[h.length - 1 - n]) / h[h.length - 1 - n] * 100; }

  // FIX-4: resolve the USD price of a quote asset. Stable quotes use their peg; a
  // NON-stable quote MUST come from ctx.prices — returns null if no positive price
  // is available (callers then refuse rather than fabricate $1).
  async function quoteUsdOf(ctx, quote) {
    if (STABLE_USD[quote] != null) return STABLE_USD[quote];
    const px = (await call1(ctx.prices, [quote])) || {};
    const v = Number(px[quote]);
    return v > 0 ? v : null;
  }
  // FIX-2: the LIVE risk bound. The remaining session allocation caps exposure —
  // a full-size posUsd buy is safe BY CONSTRUCTION because it is clamped to this.
  // Falls back to the bot's own budget when the host exposes no session remaining.
  async function remainingUsd(ctx, budgetUsd) {
    const rem = await call0(ctx.policyRemaining);
    const s = rem && rem.sessionUsd != null ? Number(rem.sessionUsd) : null;
    return s != null ? s : budgetUsd;
  }

  // Shared param validation for the single-market indicator planners. FIX-1:
  // sizing is posUsd = budgetUsd * positionPct/100 (the ranked-backtest convention,
  // NOT a bounded tradeUsd slice). budgetUsd is the bot's USD allocation.
  function validateMarketParams(self, params) {
    const p = Object.assign({}, self.defaults, params || {});
    if (!p.market) throw new Error(self.name + ' requires a market');
    splitPair(p.market);
    p.budgetUsd = Math.max(1, Math.min(1e9, num(p.budgetUsd, 1000)));
    let pp = num(p.positionPct, 100);
    if (!(pp > 0)) pp = 100;                 // clamp to (0, 100]
    p.positionPct = Math.min(100, pp);
    return p;
  }
  // Build a BUY (quote->base) intent sized at posUsd = budgetUsd*positionPct/100,
  // CLAMPED to the remaining session budget (FIX-1 + FIX-2). Never fabricates a
  // quote price (FIX-4).
  async function indicatorBuy(ctx, p, name, price, reason) {
    const [base, quote] = splitPair(p.market);
    const quoteUsd = await quoteUsdOf(ctx, quote);
    if (quoteUsd == null) return emptyPlan('no reliable quote price for ' + quote);
    const qd = decimalsFor(quote, p);
    let usd = p.budgetUsd * p.positionPct / 100;              // posUsd
    const remain = await remainingUsd(ctx, p.budgetUsd);
    usd = Math.min(usd, remain);                             // LIVE risk bound
    if (!(usd > 0)) return emptyPlan('no remaining budget');
    const amount = usdToBase(usd, qd, quoteUsd).toString();
    if (amount === '0') return emptyPlan('buy size rounds to zero');
    return [intent({
      tool: 'swap', args: { from: quote, to: base, amount, venue: 'blockle' },
      rationale: reason, estUsd: Math.round(usd * 100) / 100, strategy: name, tag: name + ':' + p.market + ':buy', mainnet: mainnetOf(ctx),
    })];
  }
  // Build a SELL (base->quote) intent that FULLY LIQUIDATES the held base (FIX-3:
  // sellAll, clamped to held — an indicator exit dumps the ENTIRE position, never a
  // tradeUsd slice). Never fabricates a quote price (FIX-4).
  async function indicatorSell(ctx, p, name, price, reason) {
    const [base, quote] = splitPair(p.market);
    if (!(price > 0)) return emptyPlan('non-positive latest price');
    const quoteUsd = await quoteUsdOf(ctx, quote);
    if (quoteUsd == null) return emptyPlan('no reliable quote price for ' + quote);
    const bd = decimalsFor(base, p);
    const baseUsd = price * quoteUsd;
    let heldBase = 0n;
    if (p.held != null) heldBase = BigInt(String(p.held));
    else { const port = await portfolio(ctx, p); if (port) heldBase = port.held[base] || 0n; }
    if (heldBase <= 0n) return emptyPlan(reason + ' but nothing held to sell');
    const sellBase = heldBase;                                // full liquidation (clamped to held)
    const sellUsd = (Number(sellBase) / pow10(bd)) * baseUsd;
    return [intent({
      tool: 'swap', args: { from: base, to: quote, amount: sellBase.toString(), venue: 'blockle' },
      rationale: reason, estUsd: Math.round(sellUsd * 100) / 100, strategy: name, tag: name + ':' + p.market + ':sell', mainnet: mainnetOf(ctx),
    })];
  }

  // --- rsi: buy oversold, sell overbought ------------------------------------
  const rsi = {
    name: 'rsi',
    describe() { return 'RSI: buy when the Relative Strength Index is oversold, sell held when it is overbought.'; },
    defaults: { market: null, period: 14, oversold: 30, overbought: 70, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.period = clampInt(p.period, 2, 200, 14);
      p.oversold = Math.max(1, Math.min(50, num(p.oversold, 30)));
      p.overbought = Math.max(50, Math.min(99, num(p.overbought, 70)));
      return p;
    },
    async plan(ctx, p) {
      const history = (p.history || []).map(Number);
      const r = rsiH(history, p.period);
      if (r == null) return emptyPlan('warming up (need > period prices)');
      const price = history[history.length - 1];
      if (r <= p.oversold) return indicatorBuy(ctx, p, 'rsi', price, 'rsi oversold (' + r.toFixed(1) + ' <= ' + p.oversold + ') — buy');
      if (r >= p.overbought) return indicatorSell(ctx, p, 'rsi', price, 'rsi overbought (' + r.toFixed(1) + ' >= ' + p.overbought + ')');
      return emptyPlan('rsi neutral (' + r.toFixed(1) + ')');
    },
  };

  // --- macd: trade the signal-line crossover ---------------------------------
  const macd = {
    name: 'macd',
    describe() { return 'MACD: buy when the MACD line crosses above its signal line, sell held on a cross below.'; },
    defaults: { market: null, fast: 12, slow: 26, signalP: 9, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.fast = clampInt(p.fast, 2, 100, 12);
      p.slow = clampInt(p.slow, 3, 300, 26);
      p.signalP = clampInt(p.signalP, 1, 100, 9);
      if (p.fast >= p.slow) throw new Error('macd needs fast < slow');
      return p;
    },
    async plan(ctx, p) {
      const history = (p.history || []).map(Number);
      const curr = macdH(history, p.fast, p.slow, p.signalP);
      if (curr == null) return emptyPlan('warming up (need >= slow+signalP prices)');
      const prev = macdH(history.slice(0, -1), p.fast, p.slow, p.signalP);
      const relCurr = curr.macd > curr.signal ? 1 : -1;
      const relPrev = prev == null ? 0 : (prev.macd > prev.signal ? 1 : -1);
      const price = history[history.length - 1];
      if (relCurr === 1 && relPrev <= 0) return indicatorBuy(ctx, p, 'macd', price, 'macd crossed above signal — buy');
      if (relCurr === -1 && relPrev >= 0) return indicatorSell(ctx, p, 'macd', price, 'macd crossed below signal — sell held');
      return emptyPlan('no macd cross');
    },
  };

  // --- bollinger: fade the bands ---------------------------------------------
  const bollinger = {
    name: 'bollinger',
    describe() { return 'Bollinger Bands: buy when price pierces the lower band, sell held when it pierces the upper band.'; },
    defaults: { market: null, period: 20, k: 2, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.period = clampInt(p.period, 2, 200, 20);
      p.k = Math.max(0.5, Math.min(5, num(p.k, 2)));
      return p;
    },
    async plan(ctx, p) {
      const history = (p.history || []).map(Number);
      const m = smaH(history, p.period), sd = stdevH(history, p.period);
      if (m == null || sd == null) return emptyPlan('warming up (need >= period prices)');
      const price = history[history.length - 1];
      if (price <= m - p.k * sd) return indicatorBuy(ctx, p, 'bollinger', price, 'bollinger lower-band pierce — buy');
      if (price >= m + p.k * sd) return indicatorSell(ctx, p, 'bollinger', price, 'bollinger upper-band pierce — sell held');
      return emptyPlan('bollinger inside the bands');
    },
  };

  // --- breakout: ride new range highs (Donchian) -----------------------------
  // NOTE: the paper engine also exits on an avgCost stop; that is position state
  // not derivable from price history, so the live planner exits ONLY on the
  // Donchian range break (price below the trailing low). Stateless.
  const breakout = {
    name: 'breakout',
    describe() { return 'Donchian breakout: buy a new range high, sell held when price breaks the trailing range low.'; },
    defaults: { market: null, lookback: 20, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.lookback = clampInt(p.lookback, 2, 300, 20);
      return p;
    },
    async plan(ctx, p) {
      const history = (p.history || []).map(Number);
      const hi = donHighH(history, p.lookback), lo = donLowH(history, p.lookback);
      if (hi == null) return emptyPlan('warming up (need > lookback prices)');
      const price = history[history.length - 1];
      if (price > hi) return indicatorBuy(ctx, p, 'breakout', price, 'breakout above ' + fmtNum(hi) + ' — buy');
      if (lo != null && price < lo) return indicatorSell(ctx, p, 'breakout', price, 'breakdown below ' + fmtNum(lo) + ' — sell held');
      return emptyPlan('inside the Donchian range');
    },
  };

  // --- emacross: fast/slow EMA trend follow ----------------------------------
  const emacross = {
    name: 'emacross',
    describe() { return 'EMA cross: buy when the fast EMA crosses above the slow EMA, sell held on a cross below.'; },
    defaults: { market: null, fast: 10, slow: 30, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.fast = clampInt(p.fast, 2, 200, 10);
      p.slow = clampInt(p.slow, 3, 400, 30);
      if (p.fast >= p.slow) throw new Error('emacross needs fast < slow');
      return p;
    },
    async plan(ctx, p) {
      const history = (p.history || []).map(Number);
      const f = emaH(history, p.fast), sl = emaH(history, p.slow);
      if (f == null || sl == null) return emptyPlan('warming up (need >= slow prices)');
      const hp = history.slice(0, -1);
      const fp = emaH(hp, p.fast), slp = emaH(hp, p.slow);
      const relCurr = f > sl ? 1 : -1;
      const relPrev = (fp == null || slp == null) ? 0 : (fp > slp ? 1 : -1);
      const price = history[history.length - 1];
      if (relCurr === 1 && relPrev <= 0) return indicatorBuy(ctx, p, 'emacross', price, 'EMA' + p.fast + ' crossed above EMA' + p.slow + ' — buy');
      if (relCurr === -1 && relPrev >= 0) return indicatorSell(ctx, p, 'emacross', price, 'EMA' + p.fast + ' crossed below EMA' + p.slow + ' — sell held');
      return emptyPlan('no EMA cross');
    },
  };

  // --- momentum_roc: follow rate-of-change -----------------------------------
  // The paper engine's `momentum` bot (rate-of-change). Named momentum_roc here to
  // avoid colliding with the existing SMA-crossover `momentum` planner above.
  const momentum_roc = {
    name: 'momentum_roc',
    describe() { return 'Rate-of-change momentum: buy when ROC over the lookback clears the threshold, sell held when ROC turns negative.'; },
    defaults: { market: null, lookback: 10, thresholdPct: 3, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.lookback = clampInt(p.lookback, 2, 300, 10);
      p.thresholdPct = Math.max(0, Math.min(100, num(p.thresholdPct, 3)));
      return p;
    },
    async plan(ctx, p) {
      const history = (p.history || []).map(Number);
      const r = rocH(history, p.lookback);
      if (r == null) return emptyPlan('warming up (need > lookback prices)');
      const price = history[history.length - 1];
      if (r >= p.thresholdPct) return indicatorBuy(ctx, p, 'momentum_roc', price, 'ROC ' + r.toFixed(2) + '% >= ' + p.thresholdPct + '% — buy');
      if (r < 0) return indicatorSell(ctx, p, 'momentum_roc', price, 'ROC turned negative (' + r.toFixed(2) + '%) — sell held');
      return emptyPlan('ROC below threshold (' + r.toFixed(2) + '%)');
    },
  };

  // --- meanrev: buy below / sell above the moving average ---------------------
  const meanrev = {
    name: 'meanrev',
    describe() { return 'Mean reversion: buy when price is a band below the moving average, sell held when it is a band above.'; },
    defaults: { market: null, period: 20, bandPct: 5, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.period = clampInt(p.period, 2, 300, 20);
      p.bandPct = Math.max(0.1, Math.min(100, num(p.bandPct, 5)));
      return p;
    },
    async plan(ctx, p) {
      const history = (p.history || []).map(Number);
      const m = smaH(history, p.period);
      if (m == null) return emptyPlan('warming up (need >= period prices)');
      const price = history[history.length - 1];
      if (price <= m * (1 - p.bandPct / 100)) return indicatorBuy(ctx, p, 'meanrev', price, 'price ' + p.bandPct + '% below the mean — buy');
      if (price >= m * (1 + p.bandPct / 100)) return indicatorSell(ctx, p, 'meanrev', price, 'price ' + p.bandPct + '% above the mean — sell held');
      return emptyPlan('within the mean-reversion band');
    },
  };

  // --- rebalance_hold: keep targetPct of VALUE in the asset -------------------
  // The paper engine's single-asset `rebalance` (vs the multi-asset `rebalance`
  // planner above). Needs both base + quote balances; sizes by the drift gap.
  const rebalance_hold = {
    name: 'rebalance_hold',
    describe() { return 'Single-asset rebalance: hold a target % of portfolio value in the asset; trade the drift back toward target.'; },
    defaults: { market: null, targetPct: 50, driftPct: 10, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) {
      const p = validateMarketParams(this, params);
      p.targetPct = Math.max(1, Math.min(99, num(p.targetPct, 50)));
      p.driftPct = Math.max(1, Math.min(100, num(p.driftPct, 10)));
      return p;
    },
    async plan(ctx, p) {
      const [base, quote] = splitPair(p.market);
      const history = (p.history || []).map(Number);
      const price = history[history.length - 1];
      if (!(price > 0)) return emptyPlan('warming up (need a price)');
      const bd = decimalsFor(base, p), qd = decimalsFor(quote, p);
      // FIX-4: never fabricate $1 — a non-stable quote must be priced from ctx.prices.
      const quoteUsd = await quoteUsdOf(ctx, quote);
      if (quoteUsd == null) return emptyPlan('no reliable quote price for ' + quote);
      const baseUsd = price * quoteUsd;
      const port = await portfolio(ctx, p);
      if (!port) return emptyPlan('no balances available');
      const heldBase = port.held[base] || 0n, heldQuote = port.held[quote] || 0n;
      const baseVal = (Number(heldBase) / pow10(bd)) * baseUsd;
      const quoteVal = (Number(heldQuote) / pow10(qd)) * quoteUsd;
      const value = baseVal + quoteVal;
      if (!(value > 0)) return emptyPlan('portfolio value is zero');
      const target = p.targetPct / 100;
      const held = baseVal / value;
      if (Math.abs(held - target) * 100 < p.driftPct) return emptyPlan('allocation within drift band');
      const wantUsd = value * target;
      const mainnet = mainnetOf(ctx);
      if (wantUsd > baseVal) {
        let buyUsd = wantUsd - baseVal;
        // FIX-2: clamp the drift buy to the remaining session budget (LIVE risk bound).
        const remain = await remainingUsd(ctx, p.budgetUsd);
        buyUsd = Math.min(buyUsd, remain);
        if (!(buyUsd > 0)) return emptyPlan('no remaining budget');
        const wantQuote = usdToBase(buyUsd, qd, quoteUsd);
        const spendQuote = wantQuote < heldQuote ? wantQuote : heldQuote;
        if (spendQuote <= 0n) return emptyPlan('buy size rounds to zero / no quote held');
        const estUsd = Math.round((Number(spendQuote) / pow10(qd)) * quoteUsd * 100) / 100;
        return [intent({
          tool: 'swap', args: { from: quote, to: base, amount: spendQuote.toString(), venue: 'blockle' },
          rationale: 'rebalance_hold BUY ' + base + ' (' + (held * 100).toFixed(1) + '% vs ' + p.targetPct + '% target) ~$' + estUsd,
          estUsd, strategy: 'rebalance_hold', tag: 'rebalance_hold:' + p.market + ':buy', mainnet,
        })];
      }
      const sellUsd = baseVal - wantUsd;
      const wantBase = usdToBase(sellUsd, bd, baseUsd);
      const sellBase = wantBase < heldBase ? wantBase : heldBase;
      if (sellBase <= 0n) return emptyPlan('sell size rounds to zero');
      const estUsd = Math.round((Number(sellBase) / pow10(bd)) * baseUsd * 100) / 100;
      return [intent({
        tool: 'swap', args: { from: base, to: quote, amount: sellBase.toString(), venue: 'blockle' },
        rationale: 'rebalance_hold SELL ' + base + ' (' + (held * 100).toFixed(1) + '% vs ' + p.targetPct + '% target) ~$' + estUsd,
        estUsd, strategy: 'rebalance_hold', tag: 'rebalance_hold:' + p.market + ':sell', mainnet,
      })];
    },
  };

  // NOTE: `scalp` and `martingale` are DROPPED FROM LIVE. They depend on per-position
  // state (avgCost / lastBuyPrice with a ratchet) that a stateless price-history
  // planner cannot faithfully or safely reproduce — an adversarial review found the
  // live approximations oversized/unbounded real exposure. They remain available as
  // PAPER strategies in services/accounts/src/bots.js (the ranked backtest engine),
  // but are intentionally absent from the live registry below: creating a live bot
  // of type scalp/martingale is cleanly rejected as an unknown live strategy.

  // --- hodl: buy once and hold (benchmark) ------------------------------------
  const hodl = {
    name: 'hodl',
    describe() { return 'HODL: buy the asset once when nothing is held, then hold forever (never sells).'; },
    defaults: { market: null, budgetUsd: 1000, positionPct: 100, history: null, held: null, balances: null },
    validateParams(params) { return validateMarketParams(this, params); },
    async plan(ctx, p) {
      const [base] = splitPair(p.market);
      let heldBase = 0n;
      if (p.held != null) heldBase = BigInt(String(p.held));
      else { const port = await portfolio(ctx, p); if (port) heldBase = port.held[base] || 0n; }
      if (heldBase > 0n) return emptyPlan('already holding');
      const history = (p.history || []).map(Number);
      const price = history.length ? history[history.length - 1] : 0;
      // server hodl buys ALL cash (ignores positionPct) — pin to the full allocation.
      return indicatorBuy(ctx, Object.assign({}, p, { positionPct: 100 }), 'hodl', price, 'hodl entry — buy the allocation of ' + base);
    },
  };

  // (scalp + martingale live planners removed — see the note above. PAPER-only.)

  // ===========================================================================
  // registry
  // ===========================================================================
  function createRegistry() {
    const list = [arbitrage, dca, grid, rebalance, momentum,
      rsi, macd, bollinger, breakout, emacross, momentum_roc, meanrev, rebalance_hold, hodl];
    const byName = new Map(list.map((s) => [s.name, s]));
    return {
      all: list.slice(),
      names: () => list.map((s) => s.name),
      get: (name) => byName.get(name) || null,
      has: (name) => byName.has(name),
    };
  }

  const AgentStrategies = {
    createRegistry,
    arbitrage, dca, grid, rebalance, momentum,
    rsi, macd, bollinger, breakout, emacross, momentum_roc, meanrev, rebalance_hold, hodl,
    AGENT_FEE_BPS, DEFAULT_DECIMALS,
    splitPair, decimalsFor, usdToBase, baseToQuote, toScaled, bookMid, occupied, fmtNum,
    smaH, stdevH, emaH, macdH, rsiH, donHighH, donLowH, rocH,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AgentStrategies;
  root.AgentStrategies = AgentStrategies;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
