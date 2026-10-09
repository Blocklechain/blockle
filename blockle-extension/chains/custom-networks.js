// chains/custom-networks.js — the USER-ADDED custom EVM networks store logic.
//
// Network definitions are CONFIG, not secrets: a list of
//   { id(slug), name, chainId, rpcUrl, nativeSymbol, decimals, explorerUrl,
//     tokenIndexerUrl? }
// persisted in normal settings (Store.customNetworks), NOT the vault. This
// module is PURE (no Store, no DOM): validation + list upsert/remove +
// normalization + an optional eth_chainId probe (fetch injected). The popup
// owns persistence; the registry consumes normalizeList(); both reuse validate().
//
// Global `CustomNetworks`; module.exports for tests + the registry (node).
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  // slug: lowercase, alnum + single dashes, trimmed, capped. Used as the chain
  // id (adapter key). Falls back are handled by the caller when empty.
  function slugify(s) {
    return String(s == null ? '' : s).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  // Accept only http(s) URLs — these are RPC/indexer/explorer endpoints.
  function isHttpUrl(s) {
    if (typeof s !== 'string' || !s.trim()) return false;
    let u;
    try { u = new URL(s.trim()); } catch { return false; }
    return u.protocol === 'http:' || u.protocol === 'https:';
  }

  // Coerce a chainId (decimal string / 0x-hex / number) to a positive int, else null.
  function toChainId(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null;
    if (typeof v === 'string') {
      const t = v.trim();
      if (/^0x[0-9a-fA-F]+$/.test(t)) { const n = parseInt(t, 16); return Number.isSafeInteger(n) && n > 0 ? n : null; }
      if (/^[0-9]+$/.test(t)) { const n = parseInt(t, 10); return Number.isSafeInteger(n) && n > 0 ? n : null; }
    }
    return null;
  }

  // Validate a raw input → { ok, errors:{field:msg}, value }. `value` is the
  // normalized network (only when ok). Decimals defaults to 18.
  function validate(raw) {
    raw = raw || {};
    const errors = {};
    const name = String(raw.name == null ? '' : raw.name).trim();
    if (!name) errors.name = 'Name is required';
    const chainId = toChainId(raw.chainId);
    if (chainId == null) errors.chainId = 'Chain ID must be a positive integer';
    if (!isHttpUrl(raw.rpcUrl)) errors.rpcUrl = 'RPC URL must be a valid http(s) URL';
    const nativeSymbol = String(raw.nativeSymbol == null ? '' : raw.nativeSymbol).trim();
    if (!nativeSymbol) errors.nativeSymbol = 'Native symbol is required';
    let decimals = (raw.decimals == null || raw.decimals === '') ? 18 : Number(raw.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) errors.decimals = 'Decimals must be an integer 0–36';
    const explorerUrl = String(raw.explorerUrl == null ? '' : raw.explorerUrl).trim();
    if (explorerUrl && !isHttpUrl(explorerUrl)) errors.explorerUrl = 'Explorer URL must be a valid http(s) URL';
    const tokenIndexerUrl = String(raw.tokenIndexerUrl == null ? '' : raw.tokenIndexerUrl).trim();
    if (tokenIndexerUrl && !isHttpUrl(tokenIndexerUrl)) errors.tokenIndexerUrl = 'Token indexer URL must be a valid http(s) URL';

    const ok = Object.keys(errors).length === 0;
    let value = null;
    if (ok) {
      const id = slugify(raw.id) || slugify(name) || ('net-' + chainId);
      value = {
        id, name, chainId,
        rpcUrl: String(raw.rpcUrl).trim(),
        nativeSymbol, decimals,
        explorerUrl, tokenIndexerUrl,
      };
    }
    return { ok, errors, value };
  }

  // Upsert into `list` (returns a NEW array). `originalId` targets an existing
  // row for edit (so a renamed slug still replaces the right entry); otherwise
  // the validated id matches/appends. Throws (err.errors set) on invalid input.
  function upsert(list, raw, originalId) {
    const res = validate(raw);
    if (!res.ok) { const e = new Error('invalid custom network'); e.errors = res.errors; throw e; }
    const out = Array.isArray(list) ? list.slice() : [];
    const key = originalId || res.value.id;
    const idx = out.findIndex((n) => n && n.id === key);
    if (idx >= 0) out[idx] = res.value; else out.push(res.value);
    return out;
  }

  // Remove the row with this id (returns a NEW array).
  function remove(list, id) {
    return (Array.isArray(list) ? list : []).filter((n) => n && n.id !== id);
  }

  // Drop invalid entries + normalize the survivors — defensive for the registry.
  function normalizeList(list) {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      const res = validate(raw);
      if (res.ok) out.push(res.value);
    }
    return out;
  }

  // Probe the RPC's eth_chainId (NON-blocking convenience for the UI). Returns
  // the numeric chainId the endpoint reports, or null on any failure. `fetchImpl`
  // is injected for tests; defaults to global fetch. Never throws.
  async function probeChainId(rpcUrl, fetchImpl) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f || !isHttpUrl(rpcUrl)) return null;
    try {
      const r = await f(String(rpcUrl).trim(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const j = await r.json();
      return toChainId(j && j.result);
    } catch { return null; }
  }

  const API = { slugify, isHttpUrl, toChainId, validate, upsert, remove, normalizeList, probeChainId };
  global.CustomNetworks = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
