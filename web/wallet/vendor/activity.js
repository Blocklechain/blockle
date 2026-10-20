// activity.js — WALLET ACTIVITY: one time-sorted cross-chain history feed
// (docs/WALLET-PORTFOLIO.md §2).
//
// READ-ONLY. `activity(accounts, ctx, {cursor?, limit?})` pulls per-chain history
// from the indexers injected via ctx (EVM getAssetTransfers/logs, Solana
// signatures-for-address, UTXO esplora address txs, BLOCK node history), merges
// them into ONE feed sorted newest-first, and pages it with a STABLE cursor.
//
// An indexer that is unavailable contributes NOTHING plus an audited note — never
// a fabricated empty "no activity" (which would read as a safety/emptiness claim).
//
// It DECODES each item's `kind` by REUSING the wallet security suite's decoder
// (security.js inspectTransaction) so the label matches the pre-sign preview
// EXACTLY, and marks any item whose counterparty the security suite would flag
// (so past interactions with a flagged address stay visible in history too).
//
// PURE given the injected indexers + security ctx; no network here, no clock.
//
// Global `WalletActivity`; module.exports for node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const Security = inNode ? require('./security.js') : global.WalletSecurity;
  const EVM = inNode ? require('./chains/evm.js') : global.EvmAdapter;

  const EVM_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche']);
  const UTXO_CHAINS = new Set(['bitcoin', 'litecoin', 'dogecoin']);

  // security-decoder kind -> Activity kind (docs §2). Never fabricates a meaning
  // the decoder didn't produce: an unknown selector decodes to contract-call.
  const KIND_MAP = {
    'native-transfer': 'transfer',
    'block-send': 'transfer',
    'utxo-send': 'transfer',
    'token-transfer': 'token-transfer',
    'token-approval': 'approval',
    'contract-call': 'contract',
    'unknown': 'contract',
  };
  // warning codes that flag the COUNTERPARTY (not merely the shape of the tx).
  const COUNTERPARTY_FLAGS = new Set(['send-to-flagged', 'known-drainer', 'approval-to-eoa', 'setApprovalForAll-true']);

  function norm(a) {
    if (a == null) return a;
    const s = String(a);
    return /^0x[0-9a-fA-F]*$/.test(s) ? s.toLowerCase() : s;
  }
  function eq(a, b) { return a != null && b != null && norm(a) === norm(b); }

  // Build the tx shape the security decoder understands from a raw indexer row,
  // RECONSTRUCTING the same calldata the pre-sign path would see (so the decoded
  // kind/label is identical). Never invents fields the row didn't carry.
  function buildTx(chain, row) {
    const asset = row.asset || null;
    const value = row.value != null ? row.value : row.amount;
    if (EVM_CHAINS.has(chain)) {
      if (row.data && row.data !== '0x') return { chain, to: row.to, data: row.data, value: row.value, asset };
      if (asset && asset.kind === 'erc20' && asset.address) {
        return { chain, to: asset.address, data: EVM.erc20TransferData(row.to, value || 0), asset };
      }
      return { chain, to: row.to, value: value || 0, asset };
    }
    if (chain === 'block') return { chain, to: row.to, amount: value || 0, asset };
    if (chain === 'solana') {
      if (Array.isArray(row.instructions)) return { chain, instructions: row.instructions, asset };
      return { chain, instructions: [{ program: 'system', type: 'transfer', info: { destination: row.to, lamports: String(value || 0) } }], asset };
    }
    if (UTXO_CHAINS.has(chain)) {
      if (Array.isArray(row.outputs)) return { chain, inputs: row.inputs, outputs: row.outputs, ownAddresses: row.ownAddresses, changeAddress: row.changeAddress, asset };
      return { chain, outputs: [{ address: row.to, value: String(value || 0) }], ownAddresses: row.ownAddresses, asset };
    }
    return { chain, to: row.to, value: value || 0, asset };
  }

  // Resolve direction relative to the owning account address.
  function directionOf(chain, row, address, activityKind) {
    if (activityKind === 'approval') return 'out';
    if (activityKind === 'contract') return 'contract';
    const from = row.from, to = row.to;
    const isFrom = address != null && eq(from, address);
    const isTo = address != null && eq(to, address);
    if (isFrom && isTo) return 'self';
    if (isFrom) return 'out';
    if (isTo) return 'in';
    // explicit hint when from/to don't resolve against this address
    if (row.direction) return row.direction;
    return 'out';
  }

  // The security ctx for decode: the same config the pre-sign uses (denylist /
  // knownSpenders / thresholds), carried on ctx.securityConfig. No network reads
  // here, so getCode-dependent checks simply don't run (decode + denylist still do).
  function secCtx(ctx) {
    return { config: (ctx && ctx.securityConfig) || {} };
  }

  async function inspect(ctx, tx) {
    // allow a caller-provided inspector (wiring.inspect); else the suite directly.
    if (ctx && typeof ctx.inspect === 'function') {
      try { return await ctx.inspect(tx.chain, tx); } catch (_) { /* fall through */ }
    }
    if (Security && typeof Security.inspectTransaction === 'function') {
      try { return await Security.inspectTransaction(tx, secCtx(ctx)); } catch (_) { return null; }
    }
    return null;
  }

  // Pull one chain's raw history via the injected indexer. Distinguishes
  // UNAVAILABLE (null / throw -> audited note) from a real empty list ([]).
  async function pullHistory(ctx, chain, address) {
    const fn = ctx && (ctx.history || (ctx.indexers && ctx.indexers[chain]));
    if (typeof fn !== 'function') {
      return { rows: [], note: { chain, note: 'history unavailable: no indexer configured for ' + chain + ' — not a claim of no activity.' } };
    }
    let rows;
    try { rows = ctx.history ? await ctx.history(chain, address) : await fn(address); }
    catch (e) {
      return { rows: [], note: { chain, note: 'history unavailable: indexer error (' + (e && e.message || e) + ') for ' + chain + ' — not a claim of no activity.' } };
    }
    if (rows == null) {
      return { rows: [], note: { chain, note: 'history unavailable: indexer returned no result for ' + chain + ' — not a claim of no activity.' } };
    }
    return { rows: Array.isArray(rows) ? rows : [], note: null };
  }

  // Stable total order: ts DESC, then chain ASC, then txid ASC.
  function cmp(a, b) {
    if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1;
    if (a.chain !== b.chain) return a.chain < b.chain ? -1 : 1;
    const at = String(a.txid), bt = String(b.txid);
    return at < bt ? -1 : at > bt ? 1 : 0;
  }
  function cursorKey(it) { return String(it.ts) + ':' + it.chain + ':' + it.txid; }
  function parseCursor(c) {
    if (!c) return null;
    const i = String(c).indexOf(':');
    const j = String(c).indexOf(':', i + 1);
    if (i < 0 || j < 0) return null;
    return { ts: Number(String(c).slice(0, i)), chain: String(c).slice(i + 1, j), txid: String(c).slice(j + 1) };
  }

  // ===========================================================================
  // activity(accounts, ctx, opts) -> { items, nextCursor?, notes }
  // ===========================================================================
  async function activity(accounts, ctx, opts) {
    ctx = ctx || {};
    opts = opts || {};
    accounts = Array.isArray(accounts) ? accounts : [];
    const limit = opts.limit != null ? Math.max(1, Number(opts.limit)) : 25;

    const items = [];
    const notes = [];
    for (const acc of accounts) {
      const chain = acc && acc.chain;
      const address = acc && acc.address;
      if (!chain) continue;
      const { rows, note } = await pullHistory(ctx, chain, address);
      if (note) notes.push(note);
      for (const row of rows) {
        const tx = buildTx(chain, row);
        const insp = await inspect(ctx, tx);
        const decKind = insp && insp.kind ? insp.kind : 'unknown';
        const kind = KIND_MAP[decKind] || 'contract';
        const warnings = (insp && insp.warnings) || [];
        const flagged = warnings.some((w) => COUNTERPARTY_FLAGS.has(w.code));
        const direction = directionOf(chain, row, address, kind);
        const amountBase = (row.value != null ? row.value : row.amount);
        const it = {
          chain, txid: String(row.txid), ts: Number(row.ts), direction, kind,
          status: row.status || 'confirmed',
          account: address,
          summary: insp ? insp.summary : undefined,
          flagged,
          warnings: warnings.map((w) => w.code),
          severity: insp ? insp.severity : 'none',
        };
        if (row.asset) { it.asset = row.asset; }
        if (amountBase != null) it.amountBase = String(amountBase);
        if (row.counterparty != null || row.from != null || row.to != null) {
          it.counterparty = row.counterparty != null ? row.counterparty : (eq(row.from, address) ? row.to : row.from);
        }
        if (row.fee != null) it.feeBase = String(row.fee);
        if (row.memo != null) it.memo = row.memo;
        if (typeof ctx.explorerTx === 'function') {
          try { const u = await ctx.explorerTx(chain, row.txid); if (u) it.explorerUrl = u; } catch (_) {}
        }
        items.push(it);
      }
    }

    items.sort(cmp);

    // stable paging: keep only items strictly AFTER the cursor in sort order.
    const cur = parseCursor(opts.cursor);
    let page = items;
    if (cur) {
      page = items.filter((it) => cmp(cur, it) < 0);
    }
    const slice = page.slice(0, limit);
    const out = { items: slice, notes };
    if (page.length > slice.length && slice.length > 0) {
      out.nextCursor = cursorKey(slice[slice.length - 1]);
    }
    return out;
  }

  const API = {
    activity,
    // internals exported for tests / ports:
    buildTx, directionOf, cmp, cursorKey, parseCursor,
    KIND_MAP, COUNTERPARTY_FLAGS, norm,
  };
  global.WalletActivity = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
