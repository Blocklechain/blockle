// security-gate.js — the SHARED pre-sign gate reused by every value-moving /
// sign call site in the popup UI that was NOT already behind the WalletConnect /
// wallet-ui reviewSend gate:
//
//   • the in-wallet BLOCK send         (popup.js send-go)
//   • the in-wallet native AMM swap    (popup.js doSwap)
//   • the dApp provider approvals that actually SIGN in the approval window:
//     blockle_signMessage / blockle_deployContract / blockle_tokenInit /
//     blockle_swap / blockle_createPool  (popup.js initApprove)
//
// It runs the READ-ONLY WalletSecurity.inspectTransaction (or a message decode
// for a sign) BEFORE the existing signer runs, routes the result through a
// confirm sheet, and FORCES an explicit confirm on DANGER. It NEVER signs — the
// existing signer still does the signing, only AFTER gate() returns cleared:true.
// Mirrors wallet-ui.js reviewSend + security.presign; composes with, and never
// weakens, any gate that already exists.
//
// Global `SecurityGate`; module.exports for node tests. WalletSecurity is read
// LAZILY (never captured at load) so the <script> order can never null it out.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  function security() {
    if (inNode) return require('./security.js');
    return global.WalletSecurity || null;
  }

  const SEV_RANK = { none: 0, info: 1, warn: 2, danger: 3 };
  function maxSeverity(warnings) {
    let best = 'none';
    for (const w of (warnings || [])) if (SEV_RANK[w.severity] > SEV_RANK[best]) best = w.severity;
    return best;
  }

  // ---- BLOCK action -> the tx shape WalletSecurity decodes -------------------
  // Every BLOCK value-moving action maps to a block-send whose `to` is the
  // counterparty (recipient / token / pool / contract) so the denylist +
  // large-share checks always have a target. (BLOCK decode is native-send per
  // docs/WALLET-SECURITY.md §1 — a swap/deploy/pool has no EVM-style calldata to
  // decode, but a flagged target address/id must still be caught.)
  function blockAsset() { return { chain: 'block', kind: 'native', symbol: 'BLOCK', decimals: 8 }; }
  function feeOf(a) { return a.fee != null ? String(a.fee) : undefined; }

  function buildBlockTx(action) {
    action = action || {};
    const asset = blockAsset();
    switch (action.kind) {
      case 'send':
        return { chain: 'block', to: action.to, amount: String(action.amount || 0), fee: feeOf(action), asset };
      case 'swap':
        // buy spends BLOCK (amountIn); sell spends tokens and receives BLOCK.
        return { chain: 'block', to: action.token, amount: String(action.side === 'buy' ? (action.amountIn || 0) : 0), fee: feeOf(action), asset };
      case 'pool':
        return { chain: 'block', to: action.token, amount: String(action.blockAmt || 0), fee: feeOf(action), asset };
      case 'init':
        return { chain: 'block', to: action.contractId, amount: '0', fee: feeOf(action), asset };
      case 'deploy':
        // a deploy has no recipient; still inspected for a uniform preview.
        return { chain: 'block', to: action.to, amount: String(action.value || 0), fee: feeOf(action), asset };
      case 'call':
        return { chain: 'block', to: action.contractId || action.to, amount: String(action.value || 0), fee: feeOf(action), asset };
      default:
        return { chain: 'block', to: action.to, amount: String(action.amount || 0), fee: feeOf(action), asset };
    }
  }

  // ---- sign-message -> an inspection-like object (same shape the sheet eats) --
  // Mirrors walletconnect.decodePersonalSign heuristics: a structured EIP-712
  // blob or a long non-printable hex body smuggled as a "message" is flagged.
  function isMostlyPrintable(s) {
    if (!s || !s.length) return false;
    let printable = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160) printable++;
    }
    return printable / s.length >= 0.8;
  }
  function hexToUtf8(hex) {
    try {
      const h = String(hex).replace(/^0x/, '');
      if (h.length % 2 !== 0) return null;
      const bytes = [];
      for (let i = 0; i < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
      if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('utf8');
      return new TextDecoder().decode(new Uint8Array(bytes));
    } catch (_) { return null; }
  }

  function decodeSignMessage(message) {
    const text = message == null ? '' : String(message);
    const warnings = [];
    const looksTyped = /"types"\s*:/.test(text) && /"domain"\s*:/.test(text);
    const isHex = /^0x[0-9a-fA-F]*$/.test(text);
    const hexBody = isHex ? text.replace(/^0x/, '') : '';
    const decoded = isHex ? (hexToUtf8(text) || '') : text;
    const looksRawTx = isHex && hexBody.length >= 64 && !isMostlyPrintable(decoded);
    if (looksTyped) warnings.push({ code: 'personal-sign-structured', severity: 'warn',
      message: 'This "message" contains EIP-712 typed-data JSON — a structured approval may be smuggled as plain text. Read it carefully.' });
    if (looksRawTx) warnings.push({ code: 'personal-sign-binary', severity: 'warn',
      message: 'This "message" is a long binary/hex blob (not human-readable text) — it may be a raw transaction or digest. Do not sign unless you know what it is.' });
    return {
      chain: 'block', kind: 'sign-message',
      summary: 'Sign message: ' + (text.length > 80 ? text.slice(0, 80) + '…' : (text || '(empty message)')),
      details: [{ label: 'Message', value: text }],
      effects: [],
      warnings, severity: maxSeverity(warnings),
      checks: { ran: ['personal-sign-structured', 'personal-sign-binary'], skipped: [] },
    };
  }

  // ---- first-party orderbook/exchange actions -> a confirm-only preview -------
  // place_order / cancel_order on the first-party exchange have NO external
  // recipient or calldata to flag (docs/WALLET-SECURITY.md §: first-party
  // reserve/orderbook), so security.inspectTransaction is N/A. They still route
  // through the SHARED confirm sheet (requirement A: every value-moving action is
  // confirm-gated) with a decoded preview — exactly like a sign-message decode.
  function decodeFirstParty(action) {
    action = action || {};
    const isCancel = action.kind === 'cancel';
    const side = String(action.side || '').toUpperCase();
    const type = action.type || 'limit';
    const base = action.base || '';
    const market = action.market || (base && action.quote ? base + '/' + action.quote : base);
    const atMarket = type === 'market' || action.price == null || action.price === '';
    let summary;
    if (isCancel) {
      summary = 'Cancel order ' + (action.orderId || '') + (market ? ' on ' + market : '');
    } else {
      summary = (side + ' ' + (action.amount != null ? action.amount : '') + ' ' + base + ' '
        + (atMarket ? 'at market' : '@ ' + action.price)).replace(/\s+/g, ' ').trim();
    }
    const details = [];
    if (market) details.push({ label: 'Market', value: market });
    if (side) details.push({ label: 'Side', value: side });
    if (!isCancel) details.push({ label: 'Type', value: type });
    if (!isCancel && action.amount != null) details.push({ label: 'Amount', value: String(action.amount) });
    if (!isCancel && !atMarket) details.push({ label: 'Price', value: String(action.price) });
    if (action.orderId) details.push({ label: 'Order', value: String(action.orderId) });
    return {
      chain: 'block', kind: isCancel ? 'exchange-cancel' : 'exchange-order',
      summary, details, effects: [],
      warnings: [], severity: 'none',
      // first-party reserve/orderbook: no external recipient/calldata to inspect.
      checks: { ran: [], skipped: [],
        note: 'first-party orderbook action — no external recipient or calldata to inspect (confirm-gated only)' },
    };
  }

  // ---- ctx from the wallet's saved security settings -------------------------
  // (agentSettings.security.denylist etc.) — the SAME config the agent + WC gate
  // use. A getBalance may be injected by the caller for the large-share check.
  function ctxFromSecuritySettings(sec, extra) {
    sec = sec || {};
    const ctx = Object.assign({
      config: {
        denylist: sec.denylist || [],
        knownSpenders: sec.knownSpenders || [],
        largeSharePct: sec.largeSharePct != null ? sec.largeSharePct : 50,
        unlimitedThreshold: sec.unlimitedThreshold,
        warnings: sec.warnings || {},
      },
    }, extra || {});
    return ctx;
  }

  // Run inspect for an action. For a sign, decode the message; otherwise run the
  // READ-ONLY WalletSecurity.inspectTransaction over the built tx. Returns the
  // Inspection, or null when the suite is unavailable (caller FAILS CLOSED).
  async function inspect(action, ctx) {
    action = action || {};
    if (action.kind === 'signMessage' || action.kind === 'sign') return decodeSignMessage(action.message);
    // first-party orderbook/exchange actions: confirm-only preview (inspect N/A).
    if (action.kind === 'order' || action.kind === 'cancel') return decodeFirstParty(action);
    const S = security();
    if (!S || typeof S.inspectTransaction !== 'function') return null;
    const tx = action.tx || buildBlockTx(action);
    try { return await S.inspectTransaction(tx, ctx || {}); }
    catch (_) { return null; }
  }

  // THE GATE. inspect -> shared confirm sheet. A DANGER forces the explicit
  // confirm; reject aborts without signing; a null inspection fails closed
  // (never signs). The suite NEVER signs — the caller's existing signer runs
  // only when this resolves { cleared: true }.
  async function gate(opts) {
    opts = opts || {};
    const inspection = await inspect(opts.action, opts.ctx);
    if (!inspection) {
      return { cleared: false, inspection: null, reason: 'security-unavailable' };
    }
    const danger = inspection.severity === 'danger';
    if (typeof opts.confirm !== 'function') {
      // No confirm handler wired: the shared confirm sheet is mandatory (uniform
      // preview even for a clean tx), and a danger can NEVER auto-approve. Fail
      // closed — matching security.presign + the WalletConnect fail-closed gate.
      return { cleared: false, inspection, reason: 'no-confirm-handler', blocked: danger };
    }
    const ok = await opts.confirm(inspection, { danger: danger });
    return { cleared: !!ok, inspection };
  }

  const API = {
    buildBlockTx, decodeSignMessage, decodeFirstParty, ctxFromSecuritySettings,
    inspect, gate, maxSeverity, SEV_RANK,
  };
  global.SecurityGate = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
