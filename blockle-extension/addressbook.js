// addressbook.js — WALLET ADDRESS BOOK + NAME RESOLUTION (docs/WALLET-PORTFOLIO.md §3).
//
// READ-ONLY with respect to the chain; the only writes are to the LOCAL labeled-
// contacts store (encrypted-at-rest alongside settings — persistence is delegated
// to the injected Store, which is the same encrypted settings backend). No key
// material, no money path.
//
// Two parts:
//   1. A local labeled-contacts store: add / edit / remove / list
//      { label, address, chain?, note? }.
//   2. resolveName(input, chain, ctx) -> { address, source:'ens'|'sns'|'book'|'raw' } | null
//      ENS (.eth) via the injected resolver, SNS (.sol) via the injected resolver,
//      the local book by label, else a verbatim raw address — or null. It NEVER
//      returns a guessed address: a name that doesn't resolve returns null, and a
//      raw string that isn't a plausible address for the chain returns null.
//   + reverseName(address, chain, ctx): book label > forward-verified ENS/SNS
//      reverse > null (the caller then shows truncated hex).
//
// The send flow resolves a typed name, SHOWS the resolved address for user
// confirmation (anti-spoofing), and STILL runs the §-security pre-sign inspection
// on the resolved address — this module only resolves; it never signs or sends.
//
// Global `WalletAddressBook`; module.exports for node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  const STORE_KEY = 'addressBook';

  // ---- address shape checks (plausibility only; never a guess) ---------------
  function isEvmAddress(s) { return /^0x[0-9a-fA-F]{40}$/.test(String(s || '')); }
  function isSolAddress(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || '')); }
  function isBlockAddress(s) { return /^block1[0-9a-z]{20,}$/i.test(String(s || '')); }
  function isBech32Utxo(s) { return /^(bc1|ltc1)[0-9a-z]{20,}$/i.test(String(s || '')); }
  function isBase58Utxo(s) { return /^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(String(s || '')); }

  const EVM_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche']);

  function isAddressLike(input, chain) {
    const s = String(input || '');
    if (!s) return false;
    if (EVM_CHAINS.has(chain)) return isEvmAddress(s);
    if (chain === 'solana') return isSolAddress(s);
    if (chain === 'block') return isBlockAddress(s);
    if (chain === 'bitcoin' || chain === 'litecoin') return isBech32Utxo(s) || isBase58Utxo(s);
    if (chain === 'dogecoin') return isBase58Utxo(s);
    // unknown chain: accept the broadest set of plausible shapes
    return isEvmAddress(s) || isSolAddress(s) || isBlockAddress(s) || isBech32Utxo(s);
  }

  // compare addresses: EVM hex case-insensitive; everything else case-sensitive.
  function addrEq(a, b) {
    if (a == null || b == null) return false;
    const x = String(a), y = String(b);
    if (/^0x[0-9a-fA-F]+$/.test(x) && /^0x[0-9a-fA-F]+$/.test(y)) return x.toLowerCase() === y.toLowerCase();
    return x === y;
  }
  function labelKey(s) { return String(s || '').trim().toLowerCase(); }

  // ---- pure list operations (the store wrapper persists the result) ----------
  function normalizeEntry(e) {
    e = e || {};
    const label = String(e.label || '').trim();
    const address = String(e.address || '').trim();
    if (!label) throw new Error('address book entry requires a label');
    if (!address) throw new Error('address book entry requires an address');
    const out = { label, address };
    if (e.chain) out.chain = String(e.chain);
    if (e.note != null && String(e.note) !== '') out.note = String(e.note);
    return out;
  }
  // add OR edit (dedup by label, case-insensitive): a matching label is replaced.
  function upsertEntry(list, entry) {
    const e = normalizeEntry(entry);
    const out = (Array.isArray(list) ? list : []).slice();
    const i = out.findIndex((x) => labelKey(x.label) === labelKey(e.label));
    if (i >= 0) out[i] = e; else out.push(e);
    out.sort((a, b) => labelKey(a.label) < labelKey(b.label) ? -1 : labelKey(a.label) > labelKey(b.label) ? 1 : 0);
    return out;
  }
  function removeEntry(list, label) {
    return (Array.isArray(list) ? list : []).filter((x) => labelKey(x.label) !== labelKey(label));
  }
  function findByLabel(list, label) {
    return (Array.isArray(list) ? list : []).find((x) => labelKey(x.label) === labelKey(label)) || null;
  }
  // first book entry matching an address (optionally constrained to a chain).
  function findByAddress(list, address, chain) {
    return (Array.isArray(list) ? list : []).find((x) =>
      addrEq(x.address, address) && (!chain || !x.chain || x.chain === chain)) || null;
  }

  // ===========================================================================
  // resolveName(input, chain, ctx) -> { address, source } | null
  //   ctx.resolveEns(name) -> address | null      (injected, for .eth)
  //   ctx.resolveSns(name) -> address | null      (injected, for .sol)
  //   ctx.book            -> [entry]               (the local book list)
  // Never returns a guessed address.
  // ===========================================================================
  async function resolveName(input, chain, ctx) {
    ctx = ctx || {};
    const raw = String(input || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();

    // ENS (.eth) — the injected resolver is the sole authority.
    if (lower.endsWith('.eth')) {
      if (typeof ctx.resolveEns !== 'function') return null;
      let addr = null;
      try { addr = await ctx.resolveEns(raw); } catch (_) { addr = null; }
      return addr ? { address: String(addr), source: 'ens', name: raw } : null;
    }
    // SNS (.sol)
    if (lower.endsWith('.sol')) {
      if (typeof ctx.resolveSns !== 'function') return null;
      let addr = null;
      try { addr = await ctx.resolveSns(raw); } catch (_) { addr = null; }
      return addr ? { address: String(addr), source: 'sns', name: raw } : null;
    }
    // local book by label
    const book = ctx.book || [];
    const hit = findByLabel(book, raw);
    if (hit) return { address: hit.address, source: 'book', label: hit.label };

    // a verbatim raw address — returned ONLY when it is a plausible address for
    // the chain (never a guess, never a transform of the input).
    if (isAddressLike(raw, chain)) return { address: raw, source: 'raw' };

    return null;
  }

  // ===========================================================================
  // reverseName(address, chain, ctx) -> { label, source } | null
  //   preference: book label > forward-verified ENS/SNS reverse > null.
  //   ctx.reverseEns(addr)->name, ctx.reverseSns(addr)->name (injected),
  //   each only trusted when it FORWARD-verifies (name resolves back to addr).
  // ===========================================================================
  async function reverseName(address, chain, ctx) {
    ctx = ctx || {};
    if (!address) return null;
    const book = ctx.book || [];
    const hit = findByAddress(book, address, chain);
    if (hit) return { label: hit.label, source: 'book' };

    async function tryReverse(revFn, fwdFn, source) {
      if (typeof revFn !== 'function') return null;
      let name = null;
      try { name = await revFn(address); } catch (_) { name = null; }
      if (!name) return null;
      // forward-verify: the claimed name MUST resolve back to this address.
      if (typeof fwdFn !== 'function') return null;
      let fwd = null;
      try { fwd = await fwdFn(name); } catch (_) { fwd = null; }
      return fwd && addrEq(fwd, address) ? { label: String(name), source } : null;
    }

    if (EVM_CHAINS.has(chain)) return await tryReverse(ctx.reverseEns, ctx.resolveEns, 'ens');
    if (chain === 'solana') return await tryReverse(ctx.reverseSns, ctx.resolveSns, 'sns');
    return null;
  }

  // ===========================================================================
  // The stateful store wrapper (persists to the injected Store under STORE_KEY).
  // ===========================================================================
  function createBook(opts) {
    opts = opts || {};
    const store = opts.store || (typeof global !== 'undefined' ? global.Store : null);
    const key = opts.key || STORE_KEY;
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
      throw new Error('createBook: an injected Store with get/set is required');
    }
    async function load() {
      const s = await store.get([key]);
      const v = s && s[key];
      return Array.isArray(v) ? v : [];
    }
    async function save(list) { await store.set({ [key]: list }); return list; }
    return {
      async list() { return load(); },
      async add(entry) { return save(upsertEntry(await load(), entry)); },
      async edit(entry) { return save(upsertEntry(await load(), entry)); }, // same dedup-by-label path
      async remove(label) { return save(removeEntry(await load(), label)); },
      async get(label) { return findByLabel(await load(), label); },
      async findAddress(address, chain) { return findByAddress(await load(), address, chain); },
      async resolveName(input, chain, ctx) { return resolveName(input, chain, Object.assign({ book: await load() }, ctx || {})); },
      async reverseName(address, chain, ctx) { return reverseName(address, chain, Object.assign({ book: await load() }, ctx || {})); },
    };
  }

  const API = {
    resolveName, reverseName, createBook,
    // pure list ops + helpers exported for tests / ports:
    normalizeEntry, upsertEntry, removeEntry, findByLabel, findByAddress,
    isAddressLike, addrEq, labelKey,
    STORE_KEY,
  };
  global.WalletAddressBook = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
