// agent/discovery.js — the READ-ONLY, configurable candidate feed (shared §7).
//
// Discovery finds and ranks token/pair candidates for the strategies to consider.
// It is strictly READ-ONLY: it NEVER trades, NEVER signs, NEVER broadcasts, and
// NEVER auto-adds anything to the policy allowlist. A discovered token is only a
// SUGGESTION — `approved:false` until an explicit user action flips it. Any trade
// on a discovered token still passes the full dispatch gate (allowlist + caps +
// confirm); an unapproved token fed to a strategy simply produces a `blocked`
// audit note, never a trade.
//
// scan() = gather (from independently-toggleable sources) -> dedupe -> flag
// (rug/scam heuristics, never fabricating safety) -> hard-filter -> score (the
// pinned weighted formula) -> rank -> cap. Deterministic given a snapshot.
//
// Exposed as global `AgentDiscovery`; also `module.exports` for Node tests.
(function (root) {
  'use strict';

  // Pinned source trust weights (Tn in the scoring formula). Identical across the
  // three wallets so a given snapshot scores the same everywhere.
  const SOURCE_TRUST = {
    watchlist: 1.0,
    exchangeListings: 0.8,
    blockLaunches: 0.7,
    venuePairs: 0.5,
    tokenLists: 0.4,
  };

  const DEFAULT_SOURCES = {
    blockLaunches: true,
    exchangeListings: true,
    venuePairs: true,
    tokenLists: true,
    watchlist: true,
  };

  const DEFAULT_FILTERS = {
    minLiquidityUsd: 10000,
    minAgeSec: 3600,       // avoid 0-block honeypots
    maxAgeSec: null,
    chains: null,          // null => any chain
    quoteAssets: ['USDC', 'USDT', 'BLOCK'],
    requireVerified: true, // for EXTERNAL sources; watchlist is always trusted
    allowlist: [],         // symbols or addresses; when non-empty, others drop
    denylist: [],          // symbols or addresses; always drop
    maxCandidates: 50,
  };

  // Pinned scoring weights + normalizers. Tunable via config but defaulted so the
  // canonical vector is EXACT: liq=100000, vol=50000, age=86400, exchangeListings
  // (0.8), 0 flags => 0.40 + 0.30 + 0.20 + 0.08 = 0.98.
  const DEFAULT_WEIGHTS = { liquidity: 0.40, volume: 0.30, age: 0.20, trust: 0.10, flagPenalty: 0.25 };
  const DEFAULT_NORM = { liquidityDivisor: 100000, volumeDivisor: 50000, ageCenterSec: 86400, ageLnWidth: 3 };

  const DEFAULT_REJECT_FLAGS = ['honeypot'];

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  function lc(x) { return x == null ? '' : String(x).toLowerCase(); }
  function inList(list, c) {
    if (!list || !list.length) return false;
    const s = new Set(list.map(lc));
    return s.has(lc(c.symbol)) || s.has(lc(c.address)) || s.has(lc(c.pair));
  }

  // ---- scoring (pure, deterministic, never fabricates a missing feature) -----

  function scoreOf(c, weights, norm) {
    // a missing feature contributes 0 (never fabricated)
    const Ln = c.liquidityUsd == null ? 0 : Math.min(1, c.liquidityUsd / norm.liquidityDivisor);
    const Vn = c.volume24hUsd == null ? 0 : Math.min(1, c.volume24hUsd / norm.volumeDivisor);
    const An = c.ageSec == null ? 0 : clamp01(1 - Math.abs(Math.log(c.ageSec / norm.ageCenterSec)) / norm.ageLnWidth);
    const Tn = typeof c.trust === 'number' ? c.trust : 0;
    const flagPenalty = (c.flags || []).length;
    const raw = weights.liquidity * Ln + weights.volume * Vn + weights.age * An
      + weights.trust * Tn - weights.flagPenalty * flagPenalty;
    // Round to 1e-6 BEFORE clamping so the three wallets agree to the last digit
    // and the pinned canonical vector lands on EXACTLY 0.98 (not 0.98000000…1).
    return clamp01(Math.round(raw * 1e6) / 1e6);
  }

  // ---- rug/scam heuristics: FLAG, never fabricate safety ---------------------

  // Soft flags accumulate a scoring penalty; a flag in rejectFlags hard-drops.
  // We only ever flag a concern the source actually exposed — absence of a flag
  // is NOT a claim of safety.
  function flagsFor(c, filters) {
    const flags = [];
    if (c.liquidityUsd != null && c.liquidityUsd < filters.minLiquidityUsd) flags.push('low-liquidity');
    if (c.liquidityLocked === false) flags.push('liquidity-not-locked');
    if (c.mintAuthorityRenounced === false) flags.push('mint-authority-not-renounced');
    if (c.honeypot === true) flags.push('honeypot');
    if (c.topHolderPct != null && c.topHolderPct >= 50) flags.push('holder-concentration');
    if (c.ageSec != null && c.ageSec < DEFAULT_NORM.ageCenterSec) flags.push('new');
    // external + unverified: flagged here; the hard requireVerified filter may
    // additionally drop it (watchlist is exempt — always trusted as a candidate).
    if (c.source !== 'watchlist' && c.verified === false) flags.push('unverified');
    // dedupe + merge any source-supplied flags
    for (const f of (c.flags || [])) if (!flags.includes(f)) flags.push(f);
    return flags;
  }

  function quoteOf(c) {
    if (c.quote) return c.quote;
    if (c.pair && c.pair.indexOf('/') >= 0) return c.pair.split('/')[1];
    return null;
  }

  // ---- normalization: coerce each raw source row into a Candidate skeleton ----

  function normalize(raw, source) {
    const c = {
      chain: raw.chain || null,
      symbol: raw.symbol || null,
      address: raw.address || raw.mint || null,
      pair: raw.pair || (raw.symbol && raw.quote ? raw.symbol + '/' + raw.quote : null),
      venue: raw.venue || null,
      source,
      liquidityUsd: raw.liquidityUsd != null ? Number(raw.liquidityUsd) : null,
      volume24hUsd: raw.volume24hUsd != null ? Number(raw.volume24hUsd) : null,
      ageSec: raw.ageSec != null ? Number(raw.ageSec) : null,
      // carry raw safety signals through for flagsFor()
      liquidityLocked: raw.liquidityLocked,
      mintAuthorityRenounced: raw.mintAuthorityRenounced,
      honeypot: raw.honeypot,
      topHolderPct: raw.topHolderPct != null ? Number(raw.topHolderPct) : null,
      verified: raw.verified,
      quote: raw.quote || null,
      flags: Array.isArray(raw.flags) ? raw.flags.slice() : [],
      trust: SOURCE_TRUST[source] != null ? SOURCE_TRUST[source] : 0,
      score: 0,
      approved: false,   // NEVER auto-approved; explicit user action only
    };
    return c;
  }

  function dedupeKey(c) {
    if (c.chain && c.address) return lc(c.chain) + ':' + lc(c.address);
    return lc(c.chain) + ':' + lc(c.symbol) + ':' + lc(c.pair);
  }

  // ---- the module ------------------------------------------------------------

  class Discovery {
    constructor(deps) {
      deps = deps || {};
      this.ctx = deps.ctx || {};
      const c = deps.config || {};
      this.sources = Object.assign({}, DEFAULT_SOURCES, c.sources || {});
      this.filters = Object.assign({}, DEFAULT_FILTERS, c.filters || {});
      this.weights = Object.assign({}, DEFAULT_WEIGHTS, c.weights || {});
      this.norm = Object.assign({}, DEFAULT_NORM, c.normalizers || {});
      this.rejectFlags = (c.rejectFlags || DEFAULT_REJECT_FLAGS).slice();
      this.trust = Object.assign({}, SOURCE_TRUST, c.trust || {});
      this.tokenListUrls = c.tokenListUrls || [];
      this.watchlist = c.watchlist || [];
      this.fetchImpl = deps.fetchImpl || c.fetchImpl ||
        (typeof fetch === 'function' ? fetch : null);
    }

    // ---- sources: each READ-ONLY, independently toggleable, fail-soft to [] --

    async _blockLaunches() {
      const ctx = this.ctx;
      const fn = (ctx.getBlockLaunches) || (ctx.launchpad && ctx.launchpad.recent);
      if (typeof fn !== 'function') return [];
      try {
        const rows = await fn.call(ctx.launchpad || ctx);
        return (rows || []).map((r) => normalize(r, 'blockLaunches'));
      } catch (_) { return []; }
    }

    async _exchangeListings() {
      const ex = this.ctx.exchange;
      if (!ex || typeof ex.getMarkets !== 'function') return [];
      try {
        const markets = await ex.getMarkets();
        return (markets || []).map((m) => normalize(Object.assign({}, m, {
          chain: m.chain || 'blockle',
          symbol: m.base || m.symbol,
          quote: m.quote,
          pair: m.pair || (m.base && m.quote ? m.base + '/' + m.quote : null),
          venue: m.venue || 'exchange',
        }), 'exchangeListings'));
      } catch (_) { return []; }
    }

    async _venuePairs() {
      const venues = this.ctx.venues;
      if (!venues || typeof venues.list !== 'function') return [];
      const out = [];
      let list;
      try { list = venues.list() || []; } catch (_) { return []; }
      for (const v of list) {
        if (!v || typeof v.getNewPairs !== 'function') continue;
        try {
          const pairs = await v.getNewPairs();
          for (const p of (pairs || [])) out.push(normalize(Object.assign({ venue: v.id || v.name }, p), 'venuePairs'));
        } catch (_) { /* honor failure of one venue without poisoning the rest */ }
      }
      return out;
    }

    // operator-configured token-list URLs (Uniswap/CoinGecko-style JSON). Fetch
    // is READ-ONLY (GET); NEVER sends wallet data. Nothing hardcoded.
    async _tokenLists() {
      if (!this.tokenListUrls.length || typeof this.fetchImpl !== 'function') return [];
      const out = [];
      for (const url of this.tokenListUrls) {
        try {
          const resp = await this.fetchImpl(url, { method: 'GET' });
          const json = await resp.json();
          const tokens = (json && (json.tokens || json)) || [];
          for (const t of tokens) out.push(normalize({
            chain: t.chain || chainFromId(t.chainId),
            symbol: t.symbol, address: t.address,
            quote: t.quote, pair: t.pair,
            liquidityUsd: t.liquidityUsd, volume24hUsd: t.volume24hUsd, ageSec: t.ageSec,
            verified: t.verified != null ? t.verified : true, // listed => treat as verified
          }, 'tokenLists'));
        } catch (_) { /* a bad URL must not break the scan */ }
      }
      return out;
    }

    _watchlist() {
      return (this.watchlist || []).map((w) => normalize(Object.assign({ verified: true }, w), 'watchlist'));
    }

    // ---- the pipeline --------------------------------------------------------

    async scan() {
      const raw = [];
      if (this.sources.blockLaunches) raw.push(...await this._blockLaunches());
      if (this.sources.exchangeListings) raw.push(...await this._exchangeListings());
      if (this.sources.venuePairs) raw.push(...await this._venuePairs());
      if (this.sources.tokenLists) raw.push(...await this._tokenLists());
      if (this.sources.watchlist) raw.push(...this._watchlist());

      // dedupe (first-seen wins — source order above is the trust-ish priority)
      const seen = new Map();
      for (const c of raw) { const k = dedupeKey(c); if (!seen.has(k)) seen.set(k, c); }

      const f = this.filters;
      const allowSet = f.allowlist && f.allowlist.length ? f.allowlist : null;
      const rejectSet = new Set((this.rejectFlags || []).map(lc));

      const kept = [];
      for (const c of seen.values()) {
        c.trust = this.trust[c.source] != null ? this.trust[c.source] : 0;
        c.flags = flagsFor(c, f);

        // ---- HARD FILTERS (drop, do not flag) --------------------------------
        if (inList(f.denylist, c)) continue;                         // denylisted
        if (allowSet && !inList(allowSet, c)) continue;              // not allowlisted
        if (f.chains && f.chains.length && !f.chains.map(lc).includes(lc(c.chain))) continue;
        if (c.liquidityUsd != null && c.liquidityUsd < f.minLiquidityUsd) continue;
        if (c.ageSec != null && c.ageSec < f.minAgeSec) continue;    // too new
        if (f.maxAgeSec != null && c.ageSec != null && c.ageSec > f.maxAgeSec) continue;
        if (f.quoteAssets && f.quoteAssets.length) {
          const q = quoteOf(c);
          if (q != null && !f.quoteAssets.map(lc).includes(lc(q))) continue;
        }
        // requireVerified applies to EXTERNAL sources only (watchlist is trusted)
        if (f.requireVerified && c.source !== 'watchlist' && c.verified === false) continue;
        // rejectFlags hard-drop (default: honeypot)
        if (c.flags.some((fl) => rejectSet.has(lc(fl)))) continue;

        c.score = scoreOf(c, this.weights, this.norm);
        c.approved = false; // belt-and-suspenders: never leaves here approved
        kept.push(c);
      }

      // rank by score desc, stable tiebreak by symbol for determinism
      kept.sort((a, b) => (b.score - a.score) || lc(a.symbol).localeCompare(lc(b.symbol)));
      return kept.slice(0, f.maxCandidates);
    }
  }

  function chainFromId(id) {
    const map = { 1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 56: 'bnb', 43114: 'avalanche' };
    return id != null && map[id] ? map[id] : null;
  }

  const AgentDiscovery = {
    create(deps) { return new Discovery(deps); },
    Discovery, scoreOf, flagsFor,
    SOURCE_TRUST, DEFAULT_SOURCES, DEFAULT_FILTERS, DEFAULT_WEIGHTS, DEFAULT_NORM, DEFAULT_REJECT_FLAGS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AgentDiscovery;
  root.AgentDiscovery = AgentDiscovery;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
