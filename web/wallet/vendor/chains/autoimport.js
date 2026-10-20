// chains/autoimport.js — AUTO-DETECT + AUTO-IMPORT held tokens on EVERY chain.
//
// On unlock / account-switch / manual refresh the wallet runs per-chain token
// discovery for EVERY enabled chain + custom network and AUTO-IMPORTS (persists)
// any newly-found token that carries a REAL positive balance into the SAME
// persisted list a manual "import token" writes (the `chainTokens` map for EVM /
// Solana / custom nets; the `tokens` id array for BLOCK-20) — so it shows up with
// its balance + in the portfolio automatically, no manual add.
//
// NON-NEGOTIABLE RULES:
//   • NEVER fabricate — a token is imported ONLY with a real detected balance +
//     metadata from the adapter's discoverTokens (balance > 0).
//   • Dedupe by (chain, contract|mint) — re-running adds nothing new (idempotent).
//   • Honor the security suite: a token whose contract/mint is on the denylist, or
//     that trips the spam heuristic, or that carries a scam/honeypot/rug flag, is
//     NOT auto-imported — it is MARKED into a separate `flaggedTokens` list instead.
//   • Default first-class tokens (USDC/USDT/…) are already shown; they are never
//     re-imported here.
//
// PURE core (filterForImport) + an async orchestrator (autoImport) with every
// dependency injected, so it is fully node-testable with no network. Shared vector:
// docs/scan-vectors.json → tokenImport.
//
// Global `TokenAutoImport`; module.exports for tests.
(function (global) {
  'use strict';

  const inNode = (typeof module !== 'undefined' && module.exports);
  const Discovery = inNode ? require('./discovery.js') : global.TokenDiscovery;

  function lc(x) { return x == null ? '' : String(x).toLowerCase(); }

  // Canonical identity of a token on a chain: (chain, contract|mint|id). Matches
  // TokenDiscovery.tokenKey so dedupe is consistent with the merge/discovery layer.
  function tokenKey(t) {
    if (!t) return '';
    const id = lc(t.address || t.mint || t.contract || t.id || t.symbol);
    return lc(t.chain) + ':' + id;
  }

  // The on-chain id a persisted entry is keyed by (what addToken writes).
  function tokenId(t) { return t.address || t.mint || t.contract || t.id || null; }

  function hasPositiveBalance(t) {
    if (!t || t.balance == null) return false;
    try { return BigInt(t.balance) > 0n; } catch { return false; }
  }

  function looksSpam(t) {
    if (Discovery && typeof Discovery.looksSpam === 'function') return Discovery.looksSpam(t);
    const name = String((t && (t.name || t.symbol)) || '');
    return name.length > 48;
  }

  // The scam/danger flags that BLOCK an auto-import (fail-closed). A token carrying
  // ANY of these — from the adapter, the discovery feed, or our own checks — is
  // marked, never imported.
  const DANGER_FLAGS = new Set(['honeypot', 'scam', 'rug', 'denylist', 'malicious', 'blocklisted']);

  // ---- PURE: classify a batch of DISCOVERED tokens for ONE chain against the
  // already-persisted list + the security denylist. Deterministic, no I/O. --------
  //
  //   discovered : the adapter's merged discovery output (AssetRefs, some with
  //                `balance`, some `isDefault`).
  //   existing   : the tokens already persisted for this chain (addToken shape).
  //   opts.denylist : array of contract/mint strings the security suite flags.
  //   opts.spamFilter (default true): drop obvious-spam non-default rows.
  //
  // Returns { toImport, flagged, skipped } — each an array of {token, reason?}.
  function filterForImport(discovered, existing, opts) {
    opts = opts || {};
    const denylist = new Set((opts.denylist || []).map(lc));
    const spamFilter = opts.spamFilter !== false;
    const existingKeys = new Set((existing || []).map(tokenKey));
    const toImport = [], flagged = [], skipped = [];

    for (const t of (discovered || [])) {
      if (!t) continue;
      const key = tokenKey(t);
      if (!key || key.endsWith(':')) { skipped.push({ token: t, reason: 'no-identity' }); continue; }
      // default (first-class) rows are already displayed — never re-imported.
      if (t.isDefault) { skipped.push({ token: t, reason: 'default' }); continue; }
      // NEVER fabricate: only a real, strictly-positive detected balance qualifies.
      if (!hasPositiveBalance(t)) { skipped.push({ token: t, reason: 'zero-balance' }); continue; }
      // idempotent: already persisted → nothing to do.
      if (existingKeys.has(key)) { skipped.push({ token: t, reason: 'already-imported' }); continue; }

      // ---- security gate: denylist / scam flags / spam → MARK, do not import ----
      const flags = (t.flags || []).map(lc);
      const id = lc(tokenId(t));
      if (id && denylist.has(id)) { flagged.push({ token: t, reason: 'denylist' }); continue; }
      const danger = flags.find((f) => DANGER_FLAGS.has(f));
      if (danger) { flagged.push({ token: t, reason: danger }); continue; }
      if (spamFilter && looksSpam(t)) { flagged.push({ token: t, reason: 'spam' }); continue; }

      toImport.push({ token: normalizeImport(t) });
    }
    return { toImport, flagged, skipped };
  }

  // Strip transient balance/display fields — the persisted entry mirrors exactly
  // what addToken writes (chain, kind, symbol, decimals, address|mint). The live
  // balance is re-read by getHoldings; persisting it would go stale.
  function normalizeImport(t) {
    const out = { chain: t.chain, kind: t.kind || 'erc20', symbol: t.symbol || 'TOKEN', decimals: Number(t.decimals != null ? t.decimals : 18) };
    if (t.address) out.address = t.address;
    if (t.mint) out.mint = t.mint;
    if (t.name) out.name = t.name;
    return out;
  }

  // ---- async orchestrator: run discovery for every chain + auto-import. --------
  //
  // deps: {
  //   registry,                 // ChainRegistry (discoverTokens(chain,addr,opts))
  //   addressFor(chain),        // async -> the account address for a chain
  //   store,                    // { get(keys), set(obj) } chrome.storage shim
  //   chains,                   // optional explicit chain id list; else registry.enabled()
  //   denylist,                 // optional security denylist (contract/mint strings)
  //   spamFilter,               // default true
  // }
  //
  // Writes newly-found non-flagged tokens into `chainTokens[chain]` (BLOCK-20 ids
  // into `tokens`), MARKS flagged ones into `flaggedTokens[chain]`, persists, and
  // returns a per-chain summary. Incremental + idempotent.
  async function autoImport(deps) {
    deps = deps || {};
    const registry = deps.registry;
    if (!registry || typeof registry.discoverTokens !== 'function') throw new Error('autoImport requires a registry');
    const store = deps.store;
    const chains = deps.chains || (typeof registry.enabled === 'function' ? registry.enabled() : []);
    const denylist = deps.denylist || [];
    const spamFilter = deps.spamFilter !== false;

    // load the persisted lists (the SAME keys manual import writes).
    const got = store && typeof store.get === 'function'
      ? (await store.get(['chainTokens', 'tokens', 'flaggedTokens'])) || {}
      : {};
    const chainTokens = Object.assign({}, got.chainTokens || {});
    const blockIds = (got.tokens || []).slice();
    const flaggedTokens = Object.assign({}, got.flaggedTokens || {});

    const summary = { imported: [], flagged: [], perChain: {} };
    let changed = false;

    for (const chain of chains) {
      let address;
      try { address = deps.addressFor ? await deps.addressFor(chain) : null; } catch (_) { address = null; }
      if (!address) { summary.perChain[chain] = { error: 'no-address' }; continue; }

      let discovered = [];
      try { discovered = (await registry.discoverTokens(chain, address, { spamFilter: false })) || []; }
      catch (_) { discovered = []; }

      const existing = chain === 'block'
        ? blockIds.map((id) => ({ chain: 'block', id }))
        : (chainTokens[chain] || []);

      const { toImport, flagged, skipped } = filterForImport(discovered, existing, { denylist, spamFilter });

      // persist the imports into the SAME list a manual import writes.
      if (toImport.length) {
        if (chain === 'block') {
          for (const { token } of toImport) { const id = tokenId(token); if (id && !blockIds.includes(id)) { blockIds.push(id); changed = true; } }
        } else {
          const list = (chainTokens[chain] = (chainTokens[chain] || []).slice());
          const keys = new Set(list.map(tokenKey));
          for (const { token } of toImport) { const k = tokenKey(token); if (!keys.has(k)) { list.push(token); keys.add(k); changed = true; } }
        }
        for (const { token } of toImport) summary.imported.push(token);
      }
      // MARK flagged tokens (deduped) — surfaced in the UI, never auto-imported.
      if (flagged.length) {
        const flist = (flaggedTokens[chain] = (flaggedTokens[chain] || []).slice());
        const fkeys = new Set(flist.map(tokenKey));
        for (const { token, reason } of flagged) {
          const k = tokenKey(token);
          if (!fkeys.has(k)) { flist.push(Object.assign(normalizeImport(token), { reason })); fkeys.add(k); changed = true; }
          summary.flagged.push({ token: normalizeImport(token), reason });
        }
      }
      summary.perChain[chain] = { imported: toImport.length, flagged: flagged.length, skipped: skipped.length };
    }

    if (changed && store && typeof store.set === 'function') {
      await store.set({ chainTokens, tokens: blockIds, flaggedTokens });
    }
    summary.changed = changed;
    summary.chainTokens = chainTokens;
    summary.tokens = blockIds;
    summary.flaggedTokens = flaggedTokens;
    return summary;
  }

  const API = { filterForImport, autoImport, tokenKey, normalizeImport, hasPositiveBalance, DANGER_FLAGS };
  global.TokenAutoImport = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
