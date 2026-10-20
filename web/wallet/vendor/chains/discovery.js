// chains/discovery.js — token auto-detection helpers shared by every chain
// adapter + the registry. PURE logic only (no network): the per-chain
// `discoverTokens(address)` methods live on the adapters; this module merges
// what they return with the default (USDC/USDT/…) list, dedupes by
// (chain, contract|mint), sorts non-zero balances first, and applies an
// optional spam filter. Fully node-testable.
//
// A discovered/merged token is an AssetRef with an optional live balance:
//   { chain, kind, symbol, decimals, address|mint, name?, logo?, balance?, display? }
// `balance` is a base-unit decimal string when known (from discovery); absent
// means "not yet queried" (a default-list entry we still owe an RPC read).
//
// Global `TokenDiscovery`; module.exports for tests.
(function (global) {
  'use strict';

  // Dedupe key: a token is the same asset iff it's the same contract/mint on the
  // same chain. Fall back to symbol when neither is present (native-ish edge).
  function tokenKey(t) {
    if (!t) return '';
    const chain = String(t.chain || '').toLowerCase();
    const id = String(t.address || t.mint || t.contract || t.symbol || '').toLowerCase();
    return chain + ':' + id;
  }

  // True when the token carries a known, strictly-positive balance.
  function hasBalance(t) {
    if (!t || t.balance == null) return false;
    try { return BigInt(t.balance) > 0n; } catch { return false; }
  }

  // Obvious-spam heuristic (names only — intentionally conservative). Default
  // (first-class) tokens are never treated as spam by the caller.
  function looksSpam(t) {
    const name = String((t && (t.name || t.symbol)) || '');
    if (!name) return false;
    if (name.length > 48) return true;
    // URLs / domains / claim-bait are the overwhelming majority of airdrop spam.
    if (/https?:\/\/|www\.|\.(com|net|io|org|xyz|app|fi|co|vip|cash|gift)\b/i.test(name)) return true;
    if (/\b(airdrop|claim|voucher|reward|visit|redeem|bonus|free|giveaway|t\.me|telegram)\b/i.test(name)) return true;
    return false;
  }

  // Strip undefined fields so Object.assign-merge never overwrites a good value
  // with `undefined` from the other source.
  function pruneUndef(o) {
    const out = {};
    for (const k of Object.keys(o || {})) if (o[k] !== undefined) out[k] = o[k];
    return out;
  }

  // Merge the default list with discovered tokens.
  //  • dedupe by (chain, contract|mint) — a default that was also discovered
  //    becomes one row carrying the live balance + any discovered metadata
  //  • non-zero balances first, then defaults, then alphabetical by symbol
  //  • opts.spamFilter (default false): drop non-default rows that are
  //    zero-balance OR look like spam. Defaults are always kept.
  // Every merged row carries `isDefault` so the caller/UI can treat the
  // first-class list specially.
  function mergeTokens(defaults, discovered, opts) {
    opts = opts || {};
    const byKey = new Map();
    const add = (t, isDefault) => {
      if (!t) return;
      const key = tokenKey(t);
      if (!key || key.endsWith(':')) return;
      const prev = byKey.get(key);
      if (prev) {
        // Discovered data wins for live fields; keep whichever symbol/decimals we
        // already have if the new one omits them. isDefault is sticky.
        byKey.set(key, Object.assign({}, prev, pruneUndef(t), { isDefault: prev.isDefault || isDefault }));
      } else {
        byKey.set(key, Object.assign({ isDefault: !!isDefault }, pruneUndef(t)));
      }
    };
    for (const t of (defaults || [])) add(t, true);
    for (const t of (discovered || [])) add(t, false);

    let list = [...byKey.values()];
    if (opts.spamFilter) {
      list = list.filter((t) => t.isDefault || (hasBalance(t) && !looksSpam(t)));
    }
    list.sort((a, b) => {
      const ab = hasBalance(a) ? 1 : 0, bb = hasBalance(b) ? 1 : 0;
      if (ab !== bb) return bb - ab;                        // non-zero first
      const ad = a.isDefault ? 1 : 0, bd = b.isDefault ? 1 : 0;
      if (ad !== bd) return bd - ad;                        // then first-class
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    });
    return list;
  }

  // Format a base-unit string with `decimals` into a human string (trim zeros).
  function formatUnits(baseStr, decimals) {
    try {
      const d = Number(decimals) || 0;
      const s = BigInt(baseStr).toString().padStart(d + 1, '0');
      const i = s.slice(0, s.length - d);
      const f = s.slice(s.length - d).replace(/0+$/, '');
      return f ? `${i}.${f}` : i;
    } catch { return String(baseStr); }
  }

  const API = { tokenKey, hasBalance, looksSpam, mergeTokens, formatUnits };
  global.TokenDiscovery = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
