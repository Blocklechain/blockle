// wallet-ui.js — the native WALLET surfaces for the popup (docs/design/wallet/
// index.html + docs/WALLET-PORTFOLIO.md / WALLET-SECURITY.md / WALLET-NFT.md /
// WALLET-WALLETCONNECT.md). FIVE tabbed surfaces in one screen, each wired to the
// REAL engine modules already in this wallet — NEVER mock data, NEVER a new money
// path. The UI only calls the engines + the EXISTING signer (Wiring.buildSend/
// broadcast), and every send/sign goes through the security pre-sign gate (the
// shared confirm sheet); a DANGER severity forces the explicit "understand the
// risk" confirm. Nothing auto-signs.
//
//   PORTFOLIO — net-worth hero + 30-day sparkline (WalletPortfolio.portfolio() +
//               the daily snapshot store), by-chain breakdown bar + legend, the
//               holdings list with UNPRICED shown-not-counted. Send/Receive/Swap.
//   ACTIVITY  — the aggregated cross-chain feed (WalletActivity.activity()) with
//               the security decoder labels + flagged counterparties inline, plus
//               the audited "history unavailable" notes (never a fake empty feed).
//   NFTS      — gallery from WalletNft.nfts() (spam flag, metadata-unavailable
//               tile, operator-approval badge -> revoke via the security approval
//               manager); send routes through the security gate.
//   CONNECT   — WalletConnect sessions list + paste-URI connect; the proposal
//               review sheet + the per-request SIGNATURE/SEND approval sheet (the
//               shared security confirm sheet) driven by the walletconnect core.
//   BOOK      — labeled contacts with ENS/SNS badges + a Send shortcut.
//
// SEND FLOW NAME RESOLUTION (the deferred piece): a typed name (alice.eth / .sol /
// a saved label) -> WalletAddressBook.resolveName -> SHOW the resolved address for
// confirmation -> Security.inspectTransaction (via Wiring.inspect) on the RESOLVED
// address -> the shared confirm sheet (a danger forces the extra confirm) -> the
// EXISTING signer. This module never signs and never holds keys.
//
// Global `WalletUI`; pure helpers also on module.exports for the DOM-level test.
(function (global) {
  'use strict';

  var UI = null;                 // BlockleUI (show/toast/route/$/$$)
  var engine = null;             // the real-engine seam (built on unlock; injected in tests)
  var activeTab = 'portfolio';
  var actCursor = null;          // activity paging cursor
  var actItems = [];             // accumulated activity items
  var send = { input: '', chain: 'ethereum', amount: '', resolved: null };

  // chain -> categorical key color (fixed order, never cycled — matches the
  // shared design reference's validated k-a..k-d palette).
  var CHAIN_KEY = ['--w-k-a', '--w-k-b', '--w-k-c', '--w-k-d'];
  // per-token avatar colors (brand-ish, display only)
  var TOKEN_BG = { ETH: '#627eea', SOL: '#9945ff', USDC: '#2775ca', USDT: '#26a17b', BLOCK: '#4c8dff', BTC: '#f7931a', LTC: '#345d9d', DOGE: '#c2a633' };

  function dep(name, file) {
    if (global[name]) return global[name];
    if (typeof require === 'function') { try { return require(file); } catch (_) {} }
    return null;
  }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); };
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  // ===========================================================================
  // formatting helpers (some exported pure for the test)
  // ===========================================================================
  function usd(n) {
    n = Number(n) || 0;
    return '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function signedUsd(n) { n = Number(n) || 0; return (n < 0 ? '−' : '+') + usd(n); }
  function shortAddr(a) {
    var s = String(a || '');
    if (s.length <= 16) return s;
    return s.slice(0, 8) + '…' + s.slice(-4);
  }
  function pct(bps) { return (Number(bps) / 100).toFixed(1) + '%'; }

  var SEV_RANK = { none: 0, info: 1, warn: 2, danger: 3 };
  function maxSev(warnings) {
    var best = 'none';
    (warnings || []).forEach(function (w) { if (SEV_RANK[w.severity] > SEV_RANK[best]) best = w.severity; });
    return best;
  }

  // The transparency line: "N checks ran · M skipped. Nothing here claims this is
  // safe." — read straight off the inspection's checks object (never a safety
  // claim). A signature (typed-data / message) has no checks object.
  function checksLine(inspection) {
    var c = inspection && inspection.checks;
    if (c && (c.ran || c.skipped)) {
      var ran = (c.ran || []).length, sk = (c.skipped || []).length;
      return ran + ' check' + (ran === 1 ? '' : 's') + ' ran · ' + sk + ' skipped. Nothing here claims this address is safe.';
    }
    return 'This is a signature, not a transfer — review the decoded request. Nothing here claims it is safe.';
  }

  // Build the shared confirm-sheet config from either a WalletConnect presentation
  // ({inspection|decoded, warnings, severity, dapp, method}) OR a plain send
  // inspection. Exported pure for the test. `danger` drives the forced confirm.
  function sheetConfigFor(presentation, opts) {
    opts = opts || {};
    var p = presentation || {};
    var insp = p.inspection || p.decoded || p;
    var warnings = p.warnings || insp.warnings || [];
    var severity = p.severity || insp.severity || maxSev(warnings);
    var details = insp.details || [];
    var rows = details.map(function (d) { return [d.label, fmtVal(d.value)]; });
    var dapp = '';
    if (p.dapp) {
      var nm = p.dapp.name || 'Unknown dApp';
      var url = p.dapp.url || '';
      dapp = esc(nm) + (url ? ' · ' + esc(url) : '');
    }
    return {
      title: opts.title || titleFor(p, insp),
      dapp: dapp,
      summary: insp.summary || '',
      previewHead: opts.previewHead || methodLabel(p) || 'Transaction preview',
      rows: rows,
      warnings: (warnings || []).map(function (w) {
        return { sev: w.severity, t: labelForCode(w.code), d: w.message };
      }),
      checks: checksLine(insp),
      danger: severity === 'danger',
      severity: severity,
    };
  }
  function fmtVal(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    var s = String(v == null ? '' : v);
    if (/^0x[0-9a-fA-F]{40}$/.test(s) || s.length > 22) return shortAddr(s);
    return s;
  }
  function methodLabel(p) {
    if (!p || !p.method) return null;
    return String(p.method);
  }
  function titleFor(p, insp) {
    if (p && p.method) {
      if (/sendtransaction|solana_sign/i.test(p.method)) return 'Transaction request';
      if (/sign/i.test(p.method)) return 'Signature request';
      return 'dApp request';
    }
    if (insp && /approval/i.test(insp.kind || '')) return 'Review approval';
    return 'Review transaction';
  }
  var CODE_LABEL = {
    'unlimited-approval': 'Unlimited approval',
    'permit-unlimited': 'Unlimited approval (off-chain)',
    'permit-long-deadline': 'Never-expiring approval',
    'offchain-approval': 'Off-chain approval signature',
    'approval-to-unknown-spender': 'Unknown spender',
    'approval-to-eoa': 'Spender has no contract code',
    'setApprovalForAll-true': 'Collection-wide operator grant',
    'known-drainer': 'Known drainer',
    'send-to-flagged': 'Flagged recipient',
    'new-address': 'First time sending here',
    'large-share': 'Large share of balance',
    'mismatch-currency': 'Unpriceable asset',
    'dapp-domain-denylisted': 'Phishing domain',
    'requests-unsupported-chain': 'Unsupported chain requested',
    'requests-eth_sign': 'Legacy eth_sign requested',
    'personal-sign-structured': 'Structured data in a "message"',
    'personal-sign-binary': 'Binary blob in a "message"',
  };
  function labelForCode(code) { return CODE_LABEL[code] || String(code || 'Warning'); }

  // ===========================================================================
  // lifecycle (called by popup.js, mirrors AgentUI / BotsUI)
  // ===========================================================================
  function init(ui) { UI = ui; }
  async function onUnlock() { engine = null; await ensureEngine(); autoImportThenRefresh(); }
  async function onResume() { engine = null; await ensureEngine(); autoImportThenRefresh(); }
  async function onLock() { engine = null; actCursor = null; actItems = []; }

  // Auto-detect + auto-import held tokens on every chain (Feature A). Best-effort,
  // fire-and-forget on unlock / account-switch / resume: it persists newly-found
  // tokens into the SAME list a manual import writes, then — if anything changed —
  // drops the engine cache + re-renders so the new tokens + balances appear with no
  // manual add. Never throws; never blocks the unlock.
  function autoImportThenRefresh() {
    try {
      var Wiring = dep('Wiring', './wiring.js');
      if (!Wiring || typeof Wiring.autoImportTokens !== 'function') return;
      Promise.resolve(Wiring.autoImportTokens()).then(function (summary) {
        if (summary && summary.changed) { engine = null; try { enter(); } catch (_) {} }
      }).catch(function () {});
    } catch (_) {}
  }

  function Wallet() { return global.Wallet; }
  function unlocked() { try { return !!(Wallet() && Wallet().isUnlocked && Wallet().isUnlocked()); } catch (_) { return false; } }

  // The REAL-engine seam. Everything here is READ-ONLY except the explicit send,
  // which goes buildSend -> broadcast (the EXISTING signer) only after the shared
  // security sheet clears. No mock data; an unconfigured indexer surfaces an
  // audited "unavailable" note from the engine, never a fabricated empty result.
  var EVM_CHAINS = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, bnb: 56, avalanche: 43114 };

  async function ensureEngine() {
    if (engine) return engine;
    if (!unlocked()) return null;
    try {
      var Wiring = dep('Wiring', './wiring.js');
      var WP = dep('WalletPortfolio', './portfolio.js');
      var WA = dep('WalletActivity', './activity.js');
      var WB = dep('WalletAddressBook', './addressbook.js');
      var WN = dep('WalletNft', './nft.js');
      var WC = dep('WalletConnect', './walletconnect.js');
      var WS = dep('WalletSecurity', './security.js');
      if (!Wiring || !WP) return null;

      await Wiring.ensureAgentDeps();
      var settings = {};
      try { settings = await Wiring.settings(); } catch (_) {}
      var sec = (settings.agent && settings.agent.security) || {};
      var reg = await Wiring.registry();
      var chains = (reg.enabled && reg.enabled()) || [];

      var accounts = [];
      for (var i = 0; i < chains.length; i++) {
        try { var a = await Wiring.accountFor(chains[i]); if (a && a.address) accounts.push({ chain: chains[i], address: a.address }); }
        catch (_) {}
      }

      // price per WHOLE unit via the SHARED estimateUsd (stablecoins + the
      // configured priceUsd map) — returns null when unknown -> portfolio puts the
      // holding in `unpriced` (shown, NOT counted, NEVER guessed).
      async function priceUsd(asset) {
        var dec = Number(asset && asset.decimals != null ? asset.decimals : 0);
        var whole; try { whole = (BigInt(10) ** BigInt(dec)).toString(); } catch (_) { whole = '1'; }
        try { return await Wiring.estimateUsd(asset, whole); } catch (_) { return null; }
      }

      // per-chain adapter history, if the adapter exposes one; otherwise the
      // engine emits an audited "history unavailable" note (never a fake empty).
      async function history(chain, address) {
        var adapter = null; try { adapter = reg.get(chain); } catch (_) { adapter = null; }
        var fn = adapter && (adapter.getHistory || adapter.history || adapter.getTransactions);
        if (typeof fn !== 'function') return null;
        try { return await fn.call(adapter, address); } catch (_) { return null; }
      }

      // ENS/SNS resolvers from the adapters when present; absent -> .eth/.sol
      // resolve to null (honest — never a guessed address).
      function resolverCtx() {
        var eth = null, sol = null;
        try { eth = reg.get('ethereum'); } catch (_) {}
        try { sol = reg.get('solana'); } catch (_) {}
        return {
          resolveEns: eth && typeof eth.resolveEns === 'function' ? function (n) { return eth.resolveEns(n); } : undefined,
          reverseEns: eth && typeof eth.reverseEns === 'function' ? function (x) { return eth.reverseEns(x); } : undefined,
          resolveSns: sol && typeof sol.resolveSns === 'function' ? function (n) { return sol.resolveSns(n); } : undefined,
          reverseSns: sol && typeof sol.reverseSns === 'function' ? function (x) { return sol.reverseSns(x); } : undefined,
        };
      }

      var book = WB && global.Store ? WB.createBook({ store: global.Store }) : null;

      // WalletConnect core — the encrypted Store for sessions (NO key material),
      // the shared security suite, and a signer that routes through Wiring (the
      // EXISTING signer). No relay transport object in this build, so live
      // proposals/requests arrive only when one is wired; the review + approval
      // sheets are driven by the core either way.
      var walletChains = [];
      Object.keys(EVM_CHAINS).forEach(function (c) { if (chains.indexOf(c) >= 0) walletChains.push('eip155:' + EVM_CHAINS[c]); });
      if (chains.indexOf('solana') >= 0) walletChains.push('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
      var wc = WC && global.Store ? WC.createWalletConnect({
        store: global.Store, security: WS, relay: global.WalletConnectRelay || null,
        config: { walletChains: walletChains, denylist: sec.denylist || [], unlimitedThreshold: sec.unlimitedThreshold },
      }) : null;

      engine = {
        accounts: accounts,
        settings: settings,
        securityConfig: sec,
        config: { ipfsGateway: sec.ipfsGateway, nftDenylist: sec.nftDenylist || [] },
        portfolioCtx: { getHoldings: function (chain) { return Wiring.getHoldings(chain); }, priceUsd: priceUsd, asOf: Date.now() },
        activityCtx: { history: history, securityConfig: sec, explorerTx: function (c, t) { return Wiring.explorerTx(c, t); } },
        nftCtx: { indexer: sec.nftIndexer || sec.indexer || null, config: { ipfsGateway: sec.ipfsGateway, nftDenylist: sec.nftDenylist || [] } },
        approvalCtx: { indexer: sec.indexer || null, config: sec },
        book: book, resolverCtx: resolverCtx(), wc: wc,
        WP: WP, WA: WA, WB: WB, WN: WN, WC: WC, WS: WS, Wiring: Wiring,
        // the ONE value path: inspect (security) then buildSend -> broadcast (the
        // existing signer) then remember the recipient. Never a new money path.
        inspect: function (chain, intent) { return Wiring.inspect(chain, intent); },
        async send(chain, req) {
          var built = await Wiring.buildSend(chain, req);
          var res = await Wiring.broadcast(chain, built);
          try { await Wiring.rememberRecipient(req.to); } catch (_) {}
          return res;
        },
        buildRevoke: function (chain, token, spender) { return Wiring.buildRevoke(chain, token, spender); },
      };
      if (accounts[0] && accounts[0].chain) send.chain = accounts[0].chain;
    } catch (_) { engine = null; }
    return engine;
  }

  // ===========================================================================
  // main render — shell + tabs (mirrors BotsUI)
  // ===========================================================================
  async function enter() {
    UI.show('wallet');
    var body = $('#wallet-body');
    if (!body) return;
    if (!unlocked()) {
      body.innerHTML = '<div class="notice">Unlock your wallet to see your portfolio, activity, NFTs, and connected dApps. Everything here is read-only; every send or signature passes the security review first.</div>';
      return;
    }
    if (!engine) await ensureEngine();
    body.innerHTML = renderShell();
    wireShell();
    await renderActiveTab();
  }

  function renderShell() {
    return '' +
      '<div class="wallet-root" data-theme-scope>' +
        '<div class="wtabs" role="tablist">' +
          tabBtn('portfolio', 'Portfolio') + tabBtn('activity', 'Activity') +
          tabBtn('nfts', 'NFTs') + tabBtn('connect', 'Connect') + tabBtn('book', 'Address book') +
        '</div>' +
        '<div id="wallet-panel"></div>' +
        '<div id="wallet-sheet"></div>' +
      '</div>';
  }
  function tabBtn(id, label) {
    return '<button role="tab" data-tab="' + id + '" aria-selected="' + (activeTab === id) + '">' + label + '</button>';
  }
  function wireShell() {
    $$('.wtabs [role=tab]').forEach(function (t) {
      t.addEventListener('click', function () { activeTab = t.getAttribute('data-tab'); enter(); });
    });
  }
  async function renderActiveTab() {
    var panel = $('#wallet-panel');
    if (!panel) return;
    try {
      if (activeTab === 'portfolio') return await renderPortfolio(panel);
      if (activeTab === 'activity') return await renderActivity(panel);
      if (activeTab === 'nfts') return await renderNfts(panel);
      if (activeTab === 'connect') return await renderConnect(panel);
      if (activeTab === 'book') return await renderBook(panel);
    } catch (e) {
      panel.innerHTML = '<div class="wnote">Could not load this view: ' + esc(e && e.message || String(e)) + '</div>';
    }
  }

  // ===========================================================================
  // PORTFOLIO
  // ===========================================================================
  async function loadSnapshot(totalUsdMicro) {
    var WP = engine.WP, Store = global.Store;
    var history = [];
    try { var s = Store ? await Store.get(['portfolioHistory']) : null; history = (s && s.portfolioHistory) || []; } catch (_) { history = []; }
    if (totalUsdMicro != null) {
      history = WP.recordSnapshot(history, { ts: Date.now(), totalUsdMicro: String(totalUsdMicro) });
      try { if (Store) await Store.set({ portfolioHistory: history }); } catch (_) {}
    }
    return history;
  }

  async function renderPortfolio(panel) {
    var WP = engine.WP;
    var pf = await WP.portfolio(engine.accounts, engine.portfolioCtx);
    var history = await loadSnapshot(pf.totalUsdMicro);
    var spark = WP.sparkline(history, 30);

    // today's delta: latest snapshot vs the prior day's point (never guessed).
    var deltaUsd = null, deltaPct = null;
    if (spark.length >= 2) {
      var prev = spark[spark.length - 2].usd, cur = spark[spark.length - 1].usd;
      deltaUsd = cur - prev;
      if (prev > 0) deltaPct = deltaUsd / prev * 100;
    }
    var unpricedN = (pf.unpriced || []).length;

    var chainColors = {};
    (pf.byChain || []).forEach(function (c, i) { chainColors[c.chain] = CHAIN_KEY[i % CHAIN_KEY.length]; });

    panel.innerHTML = '' +
      '<div class="wpf-top">' +
        '<div class="card whero">' +
          '<span class="weyebrow">Net worth · all chains</span>' +
          '<div class="wbig num">' + usd(pf.totalUsd) + '</div>' +
          '<div class="wsub">' + heroDelta(deltaUsd, deltaPct) +
            (unpricedN ? ' · <span class="num">' + unpricedN + '</span> holding' + (unpricedN === 1 ? '' : 's') + ' unpriced' : '') + '</div>' +
          '<div class="wspark"><canvas id="w-nw-spark" aria-label="30-day net worth sparkline"></canvas></div>' +
          '<div class="wsend-row">' +
            '<button class="wbtn primary" id="w-send">Send</button>' +
            '<button class="wbtn" id="w-recv">Receive</button>' +
            '<button class="wbtn" id="w-swap">Swap</button>' +
          '</div>' +
        '</div>' +
        '<div class="card wchains">' +
          '<span class="weyebrow">By chain</span>' +
          '<div class="wchainbar">' + (pf.byChain || []).map(function (c) {
            return '<span style="width:' + pct(c.pctBps) + ';background:var(' + chainColors[c.chain] + ')"></span>';
          }).join('') + '</div>' +
          '<div class="wchain-legend">' + (pf.byChain || []).map(function (c) {
            return '<div class="row"><span class="dot" style="background:var(' + chainColors[c.chain] + ')"></span>' + esc(c.chain) +
              '<span class="num val">' + usd(c.usd) + '</span><span class="pc num">' + pct(c.pctBps) + '</span></div>';
          }).join('') + (pf.byChain && pf.byChain.length ? '' : '<div class="wmeta">No priced balances yet.</div>') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="wsec-head"><h3>Holdings</h3><span class="wcount">' + (pf.holdings || []).length + '</span></div>' +
      '<div class="card whold">' + ((pf.holdings || []).length ? pf.holdings.map(holdingRowHtml).join('') : '<div class="wnote">No balances found on your configured chains.</div>') + '</div>' +
      '<div class="wfoot-note">Unpriced tokens are shown but not counted in net worth — never guessed.</div>';

    var sd = $('#w-send'); if (sd) sd.addEventListener('click', openSendSheet);
    var rc = $('#w-recv'); if (rc) rc.addEventListener('click', function () { UI.route('receive'); });
    var sw = $('#w-swap'); if (sw) sw.addEventListener('click', function () { UI.route('swap'); });
    drawSpark($('#w-nw-spark'), spark.map(function (p) { return p.usd; }));
  }

  function heroDelta(deltaUsd, deltaPct) {
    if (deltaUsd == null) return '<span class="wsub-muted">tracking net worth daily</span>';
    var cls = deltaUsd >= 0 ? 'pos' : 'neg';
    var arrow = deltaUsd >= 0 ? '▲' : '▼';
    return '<span class="wchip-pnl ' + cls + '">' + arrow + ' ' + (deltaPct == null ? signedUsd(deltaUsd) : (deltaUsd >= 0 ? '+' : '−') + Math.abs(deltaPct).toFixed(2) + '%') + '</span> ' +
      signedUsd(deltaUsd) + ' today';
  }

  // Exported pure: one holdings row. Priced -> USD quote; unpriced -> the UNPRICED
  // tag (shown, not counted).
  function holdingRowHtml(h) {
    var sym = h.symbol || (h.asset && h.asset.symbol) || '?';
    var bg = TOKEN_BG[String(sym).toUpperCase()] || '#8795a4';
    var amt = fmtAmount(h.amountBase, h.decimals);
    var right = h.pricedOk
      ? '<div class="q num">' + usd(h.usd) + '</div>'
      : '<span class="wtag unpriced">UNPRICED</span>';
    return '<div class="whrow"><span class="wtoken" style="background:' + bg + '">' + esc(String(sym).slice(0, 2).toUpperCase()) + '</span>' +
      '<div><div class="nm">' + esc(sym) + '</div><div class="ch">' + esc(h.chain) + '</div></div>' +
      '<div class="amt"><div class="num">' + esc(amt) + ' ' + esc(sym) + '</div>' + right + '</div></div>';
  }
  function fmtAmount(base, decimals) {
    try {
      var dec = Number(decimals || 0);
      var s = String(base || '0');
      if (dec <= 0) return Number(s).toLocaleString();
      var neg = s[0] === '-'; if (neg) s = s.slice(1);
      while (s.length <= dec) s = '0' + s;
      var whole = s.slice(0, s.length - dec), frac = s.slice(s.length - dec).replace(/0+$/, '').slice(0, 6);
      var out = Number(whole).toLocaleString() + (frac ? '.' + frac : '');
      return (neg ? '-' : '') + out;
    } catch (_) { return String(base); }
  }

  // ===========================================================================
  // ACTIVITY — WalletActivity.activity() + the audited unavailable notes
  // ===========================================================================
  async function renderActivity(panel) {
    var WA = engine.WA;
    var out = await WA.activity(engine.accounts, engine.activityCtx, { limit: 25, cursor: actCursor });
    if (!actCursor) actItems = [];
    actItems = actItems.concat(out.items || []);
    actCursor = out.nextCursor || null;

    panel.innerHTML = '' +
      '<div class="wsec-head"><h3>Activity</h3><span class="wcount">all chains</span></div>' +
      (actItems.length ? '<div class="card wfeed">' + actItems.map(activityRowHtml).join('') + '</div>'
        : '<div class="card"><div class="wnote">No activity to show yet.</div></div>') +
      ((out.notes && out.notes.length) ? '<div class="wnotes">' + out.notes.map(function (n) {
        return '<div class="wnote">Note · ' + esc(n.note) + '</div>';
      }).join('') + '</div>' : '') +
      (actCursor ? '<div class="wmore"><button class="wbtn" id="w-act-more">Load more</button></div>' : '');

    var more = $('#w-act-more'); if (more) more.addEventListener('click', function () { renderActivity(panel); });
  }

  // Exported pure: one activity row with the security label + flagged counterparty.
  function activityRowHtml(it) {
    var dir = it.direction;
    var sign = dir === 'in' ? 'pos' : dir === 'out' ? 'neg' : '';
    var lead = it.summary || (it.kind + (it.counterparty ? ' · ' + shortAddr(it.counterparty) : ''));
    var flag = it.flagged ? '<span class="wflag">⚑ flagged</span>' : '';
    var sev = it.severity && it.severity !== 'none' ? '<span class="wsev ' + esc(it.severity) + '">' + esc(it.severity) + '</span>' : '';
    var meta = esc(it.chain) + ' · ' + esc(it.kind) + (it.counterparty ? ' · ' + esc(shortAddr(it.counterparty)) : '');
    var val = it.amountBase != null ? (dir === 'out' ? '−' : dir === 'in' ? '+' : '') + esc(fmtAmount(it.amountBase, it.asset && it.asset.decimals)) + ' ' + esc((it.asset && it.asset.symbol) || '') : '';
    return '<div class="warow"><span class="waic">' + dirIcon(dir) + '</span>' +
      '<div class="wa-main"><div class="lead">' + esc(lead) + ' ' + sev + ' ' + flag + '</div><div class="meta">' + meta + '</div></div>' +
      '<div class="val ' + sign + ' num">' + val + '</div></div>';
  }
  function dirIcon(dir) { return dir === 'in' ? '↓' : dir === 'out' ? '↑' : dir === 'self' ? '⟳' : '⚙'; }

  // ===========================================================================
  // NFTS — WalletNft.nfts() + operator-approval badge -> revoke via the gate
  // ===========================================================================
  async function renderNfts(panel) {
    var WN = engine.WN;
    var res = await WN.nfts(engine.accounts, engine.nftCtx);

    // operator approvals (danger) per EVM chain — reuse the security approval mgr.
    var operatorApprovals = [];
    for (var i = 0; i < engine.accounts.length; i++) {
      var a = engine.accounts[i];
      if (EVM_CHAINS[a.chain] == null) continue;
      try {
        var sa = await WN.surfaceApprovals(a.chain, a.address, engine.approvalCtx);
        (sa.operatorApprovals || []).forEach(function (op) { op.chain = a.chain; operatorApprovals.push(op); });
      } catch (_) {}
    }
    var approvalByCollection = {};
    operatorApprovals.forEach(function (op) { approvalByCollection[String(op.collection).toLowerCase()] = op; });

    var tiles = (res.items || []).map(function (n) {
      var key = String(n.contract || '').toLowerCase();
      return nftTileHtml(n, approvalByCollection[key]);
    });

    panel.innerHTML = '' +
      '<div class="wsec-head"><h3>NFTs</h3><span class="wcount">' + (res.items || []).length + ' · ' + (res.collections || []).length + ' collections</span></div>' +
      (tiles.length ? '<div class="wgal">' + tiles.join('') + '</div>' : '<div class="card"><div class="wnote">No NFTs found on your configured chains.</div></div>') +
      (operatorApprovals.length ? '<div class="wfoot-note">One or more collections have an open <b class="warn-ink">operator approval</b> — tap the badge to revoke (the security gate applies).</div>' : '') +
      ((res.unavailable && res.unavailable.length) ? '<div class="wnotes">' + res.unavailable.map(function (u) {
        return '<div class="wnote">Note · ' + esc(u.chain) + ' — ' + esc(u.reason) + '</div>';
      }).join('') + '</div>' : '');

    $$('.wnft[data-revoke]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var chain = el.getAttribute('data-chain');
        var op = approvalByCollection[el.getAttribute('data-revoke')];
        if (op) revokeOperator(chain, op);
      });
    });
    $$('.wnft[data-send]').forEach(function (el) {
      el.addEventListener('click', function () { UI.toast('NFT send opens the security review first (not auto-signed).'); });
    });
  }

  // Exported pure: one NFT tile (spam flag / metadata-unavailable / operator badge).
  function nftTileHtml(n, operatorApproval) {
    if (n.metadataOk === false) {
      return '<div class="wnft" data-send="1"><div class="art"><div class="unav">' + esc(labelOf(n)) + '<br>metadata unavailable</div></div>' +
        '<div class="meta"><div class="nm">' + esc(labelOf(n)) + '</div><div class="col">metadata unavailable</div></div></div>';
    }
    var badge = '';
    if (n.spam) badge = '<span class="spam">SPAM?</span>';
    else if (operatorApproval) badge = '<span class="approval" title="Open operator approval — tap to revoke">APPROVAL</span>';
    var art = n.image ? '<img class="nft-img" src="' + esc(n.image) + '" alt="" loading="lazy">' : '<span class="nft-emoji">🖼️</span>';
    var revokeAttr = operatorApproval ? ' data-revoke="' + esc(String(n.contract).toLowerCase()) + '" data-chain="' + esc(n.chain) + '"' : ' data-send="1"';
    return '<div class="wnft"' + revokeAttr + '><div class="art">' + badge + art + '</div>' +
      '<div class="meta"><div class="nm">' + esc(labelOf(n)) + '</div><div class="col">' + esc(n.collection || n.chain) + '</div></div></div>';
  }
  function labelOf(n) { return n.name || ((n.collection || 'Token') + ' #' + (n.tokenId != null ? n.tokenId : '?')); }

  async function revokeOperator(chain, op) {
    try {
      var revokeTx = engine.buildRevoke(chain, op.collection, op.operator);
      var intent = { to: revokeTx.to, data: revokeTx.data, value: '0' };
      var inspection = await engine.inspect(chain, intent);
      var cleared = await openSecuritySheet(sheetConfigFor(inspection, { title: 'Revoke operator approval', previewHead: 'setApprovalForAll(operator, false)' }));
      if (!cleared) return;
      await engine.send(chain, { to: revokeTx.to, data: revokeTx.data, amount: '0' });
      UI.toast('Revoke submitted');
      enter();
    } catch (e) { UI.toast(e && e.message || String(e)); }
  }

  // ===========================================================================
  // CONNECT — WalletConnect sessions + paste-URI + the review / approval sheets
  // ===========================================================================
  async function renderConnect(panel) {
    var wc = engine.wc;
    var sessions = [];
    try { sessions = wc ? (await wc.listSessions()) : []; } catch (_) { sessions = []; }

    panel.innerHTML = '' +
      '<div class="wsec-head"><h3>Connected dApps</h3><span class="wcount">WalletConnect</span></div>' +
      '<div class="card">' +
        '<div class="wpaste"><div class="winp"><input id="w-wc-uri" placeholder="Paste a WalletConnect URI (wc:…@2)" autocomplete="off" spellcheck="false"></div>' +
          '<button class="wbtn primary" id="w-wc-connect">Connect</button></div>' +
        '<div id="w-sessions">' + (sessions.length ? sessions.map(sessionRowHtml).join('') : '<div class="wnote">No connected dApps.</div>') + '</div>' +
      '</div>' +
      '<div class="wfoot-note">dApps are untrusted — every signing request needs your explicit approval and runs the security check. Nothing auto-signs.</div>';

    var btn = $('#w-wc-connect'); if (btn) btn.addEventListener('click', connectPasted);
    $$('#w-sessions [data-disconnect]').forEach(function (el) {
      el.addEventListener('click', async function () {
        try { await wc.disconnect(el.getAttribute('data-disconnect'), { code: 6000, message: 'user disconnected' }); UI.toast('Disconnected'); enter(); }
        catch (e) { UI.toast(e && e.message || String(e)); }
      });
    });
  }

  // Exported pure: one session row.
  function sessionRowHtml(s) {
    var dapp = s.dapp || {};
    var methods = [];
    Object.keys(s.namespaces || {}).forEach(function (k) { (s.namespaces[k].methods || []).forEach(function (m) { if (methods.indexOf(m) < 0) methods.push(m); }); });
    return '<div class="wses"><span class="logo">🔗</span><div class="wses-main"><div class="nm">' + esc(dapp.name || 'Unknown dApp') + '</div>' +
      '<div class="url">' + esc(dapp.url || '') + '</div>' +
      '<div class="scope">' + methods.slice(0, 6).map(function (m) { return '<span class="mchip">' + esc(m) + '</span>'; }).join('') + '</div></div>' +
      '<button class="wiconbtn" title="Disconnect" data-disconnect="' + esc(s.topic) + '">✕</button></div>';
  }

  async function connectPasted() {
    var wc = engine.wc;
    var el = $('#w-wc-uri');
    var uri = el ? String(el.value || '').trim() : '';
    if (!uri) return UI.toast('Paste a WalletConnect URI first');
    try {
      wc.parsePairingUri(uri); // throws on v1 / malformed
      await wc.pair(uri);
      UI.toast('Pairing… approve the session in the dApp. The proposal review opens here.');
    } catch (e) {
      UI.toast('Invalid URI: ' + (e && e.message || String(e)));
    }
  }

  // The proposal review sheet (driven by wc.reviewProposal). Called by the relay
  // callback when a proposal arrives. Returns the chosen action; never auto-approves.
  async function openProposalSheet(proposal) {
    var wc = engine.wc;
    var review = wc.reviewProposal(proposal);
    var cfg = {
      title: 'Connection request',
      dapp: esc((review.dapp && review.dapp.name) || 'Unknown dApp') + ((review.dapp && review.dapp.url) ? ' · ' + esc(review.dapp.url) : ''),
      previewHead: 'Requested access',
      rows: [['Chains', (review.chains || []).join(', ') || '—'], ['Methods', (review.methods || []).length + ' methods'], ['Events', (review.events || []).join(', ') || '—']],
      warnings: (review.warnings || []).map(function (w) { return { sev: w.severity, t: labelForCode(w.code), d: w.message }; }),
      checks: 'Review what the dApp can request. Approving grants only the chains/accounts you control.',
      danger: review.severity === 'danger',
      severity: review.severity,
      approveLabel: 'Connect',
    };
    var ok = await openSecuritySheet(cfg);
    if (!ok) { try { await wc.rejectProposal(proposal); } catch (_) {} return false; }
    try {
      var offered = engine.accounts.filter(function (a) { return EVM_CHAINS[a.chain] != null || a.chain === 'solana'; })
        .map(function (a) { return (EVM_CHAINS[a.chain] != null ? 'eip155:' + EVM_CHAINS[a.chain] : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') + ':' + a.address; });
      await wc.approveProposal(proposal, { accounts: offered });
      UI.toast('Connected'); enter();
    } catch (e) { UI.toast(e && e.message || String(e)); }
    return true;
  }

  // The per-request SIGNATURE/SEND approval context passed to wc.handleRequest.
  // approve() + confirm() both open the shared security sheet; confirm() is the
  // DANGER-forced explicit confirm (fail-closed when the human declines).
  function wcRequestCtx() {
    return {
      approve: function (presentation) { return openSecuritySheet(sheetConfigFor(presentation)); },
      confirm: function (presentation) { return openSecuritySheet(sheetConfigFor(presentation), { forceDanger: true }); },
      security: { config: engine.securityConfig },
    };
  }

  // ===========================================================================
  // ADDRESS BOOK
  // ===========================================================================
  async function renderBook(panel) {
    var list = [];
    try { list = engine.book ? await engine.book.list() : []; } catch (_) { list = []; }

    panel.innerHTML = '' +
      '<div class="wsec-head"><h3>Address book</h3><span class="wcount">' + list.length + '</span>' +
        '<button class="wbtn" id="w-book-add" style="margin-left:auto">+ Add contact</button></div>' +
      '<div class="card whold">' + (list.length ? list.map(bookRowHtml).join('') : '<div class="wnote">No saved contacts yet.</div>') + '</div>';

    var add = $('#w-book-add'); if (add) add.addEventListener('click', openAddContact);
    $$('.whrow[data-send-to]').forEach(function (el) {
      el.addEventListener('click', function () {
        send.input = el.getAttribute('data-send-label') || el.getAttribute('data-send-to');
        var ch = el.getAttribute('data-chain'); if (ch) send.chain = ch;
        openSendSheet();
      });
    });
  }
  function bookRowHtml(b) {
    var badge = '<span class="mchip">saved</span>';
    return '<div class="whrow" data-send-to="' + esc(b.address) + '" data-send-label="' + esc(b.label) + '"' + (b.chain ? ' data-chain="' + esc(b.chain) + '"' : '') + '>' +
      '<span class="wtoken" style="background:var(--w-k-a)">' + esc(String(b.label).slice(0, 2).toUpperCase()) + '</span>' +
      '<div><div class="nm">' + esc(b.label) + ' ' + badge + (b.chain ? ' <span class="mchip">' + esc(b.chain) + '</span>' : '') + '</div>' +
      '<div class="ch num">' + esc(shortAddr(b.address)) + '</div></div>' +
      '<button class="wbtn" style="margin-left:auto;pointer-events:none">Send</button></div>';
  }
  function openAddContact() {
    var label = global.prompt ? global.prompt('Contact label (e.g. savings, alice.eth):') : '';
    if (!label) return;
    var address = global.prompt ? global.prompt('Address for "' + label + '":') : '';
    if (!address) return;
    (async function () {
      try { await engine.book.add({ label: String(label).trim(), address: String(address).trim() }); UI.toast('Contact saved'); enter(); }
      catch (e) { UI.toast(e && e.message || String(e)); }
    })();
  }

  // ===========================================================================
  // SEND FLOW — name resolution -> show resolved address -> inspect -> gate -> sign
  // ===========================================================================
  function openSendSheet() {
    var sheet = $('#wallet-sheet');
    if (!sheet) return;
    var chainOpts = engine.accounts.map(function (a) {
      return '<option value="' + esc(a.chain) + '"' + (a.chain === send.chain ? ' selected' : '') + '>' + esc(a.chain) + '</option>';
    }).join('');
    sheet.innerHTML = '' +
      '<div class="wscrim" id="w-send-x"></div>' +
      '<div class="wsheet card" role="dialog" aria-modal="true" aria-label="Send">' +
        '<h3>Send</h3>' +
        '<label class="wfield"><span>Network</span><select id="w-send-chain" class="winp-sel">' + chainOpts + '</select></label>' +
        '<label class="wfield"><span>To — name or address</span><input id="w-send-to" placeholder="alice.eth · name.sol · a saved label · 0x…" value="' + esc(send.input) + '"></label>' +
        '<div id="w-send-resolved"></div>' +
        '<label class="wfield"><span>Amount</span><input id="w-send-amt" inputmode="decimal" placeholder="0.00" value="' + esc(send.amount) + '"></label>' +
        '<div class="wsend-err" id="w-send-err"></div>' +
        '<div class="wsheet-actions"><button class="wbtn" id="w-send-cancel">Cancel</button>' +
          '<button class="wbtn primary" id="w-send-review">Review</button></div>' +
      '</div>';
    var close = function () { sheet.innerHTML = ''; };
    var x = $('#w-send-x'); if (x) x.addEventListener('click', close);
    var c = $('#w-send-cancel'); if (c) c.addEventListener('click', close);
    var chainSel = $('#w-send-chain'); if (chainSel) chainSel.addEventListener('change', function () { send.chain = chainSel.value; send.resolved = null; $('#w-send-resolved').innerHTML = ''; });
    var to = $('#w-send-to'); if (to) to.addEventListener('input', function () { send.input = to.value; send.resolved = null; $('#w-send-resolved').innerHTML = ''; });
    var amt = $('#w-send-amt'); if (amt) amt.addEventListener('input', function () { send.amount = amt.value; });
    var review = $('#w-send-review'); if (review) review.addEventListener('click', reviewSend);
  }

  async function reviewSend() {
    var errEl = $('#w-send-err'); if (errEl) errEl.textContent = '';
    var input = String(send.input || '').trim();
    var chain = send.chain;
    if (!input) { if (errEl) errEl.textContent = 'Enter a name or address.'; return; }

    // 1. RESOLVE the name via the address book (ENS/SNS/book/raw) — never guessed.
    var resolution = null;
    try { resolution = await engine.book.resolveName(input, chain, engine.resolverCtx); }
    catch (_) { resolution = null; }
    if (!resolution) { if (errEl) errEl.textContent = 'Could not resolve "' + input + '" to an address on ' + chain + '. A name must resolve; nothing is guessed.'; return; }
    send.resolved = resolution;

    // 2. SHOW the resolved address for confirmation (anti-spoofing).
    var rEl = $('#w-send-resolved'); if (rEl) rEl.innerHTML = resolvedLineHtml(resolution);

    // 3. INSPECT the RESOLVED address (security pre-sign), then the shared sheet.
    var amount = String(send.amount || '').trim();
    var intent = { to: resolution.address, amount: amount || '0' };
    var inspection = null;
    try { inspection = await engine.inspect(chain, intent); } catch (_) { inspection = null; }
    if (!inspection) { if (errEl) errEl.textContent = 'Could not inspect this transaction — not signing.'; return; }

    var cfg = sheetConfigFor(inspection, { title: 'Review send', previewHead: 'Transaction preview' });
    // show the resolved name/address inside the sheet too
    cfg.resolved = resolution;
    var cleared = await openSecuritySheet(cfg);
    if (!cleared) return;

    // 4. SIGN via the EXISTING signer (buildSend -> broadcast). No new money path.
    try {
      await engine.send(chain, { to: resolution.address, amount: amount || '0' });
      UI.toast('Sent');
      var sheet = $('#wallet-sheet'); if (sheet) sheet.innerHTML = '';
      activeTab = 'activity'; actCursor = null; enter();
    } catch (e) { if (errEl) errEl.textContent = e && e.message || String(e); }
  }

  // Exported pure: the resolved-address confirmation line.
  function resolvedLineHtml(res) {
    var label = res.name || res.label || (res.source === 'raw' ? 'address' : '');
    var via = res.source === 'ens' ? 'ENS' : res.source === 'sns' ? 'SNS' : res.source === 'book' ? 'saved contact' : 'address';
    return '<div class="wresolved">✓ ' + (label ? esc(label) + ' resolves to ' : '') +
      '<span class="num">' + esc(shortAddr(res.address)) + '</span> <span class="mchip">' + via + '</span></div>';
  }

  // ===========================================================================
  // SHARED SECURITY CONFIRM SHEET — used by Send AND dApp requests. Returns a
  // Promise<bool> (approve=true / reject=false). A DANGER forces the explicit
  // "I understand the risk" confirm; nothing auto-signs.
  // ===========================================================================
  function openSecuritySheet(cfg, opts) {
    opts = opts || {};
    cfg = cfg || {};
    var danger = !!(cfg.danger || opts.forceDanger);
    return new Promise(function (resolve) {
      var sheet = $('#wallet-sheet');
      if (!sheet) { resolve(false); return; }
      var rows = (cfg.rows || []).map(function (r) {
        return '<div class="wpvrow"><span class="k">' + esc(r[0]) + '</span><span class="v num">' + esc(r[1]) + '</span></div>';
      }).join('');
      var warns = (cfg.warnings || []).map(function (w) {
        var sev = w.sev === 'danger' ? 'danger' : w.sev === 'warn' ? 'warn' : 'info';
        return '<div class="wwarn ' + sev + '"><div class="t">' + esc(w.t) + '</div><div class="d">' + esc(w.d) + '</div></div>';
      }).join('');
      var resolvedHtml = cfg.resolved ? resolvedLineHtml(cfg.resolved) : '';
      sheet.innerHTML = '' +
        '<div class="wscrim" id="w-sec-x"></div>' +
        '<div class="wsheet card" role="dialog" aria-modal="true" aria-label="Review before signing">' +
          '<h3>' + esc(cfg.title || 'Review') + '</h3>' +
          (cfg.dapp ? '<div class="wdapp">' + cfg.dapp + '</div>' : '') +
          resolvedHtml +
          (cfg.summary ? '<div class="wsummary">' + esc(cfg.summary) + '</div>' : '') +
          '<div class="wpreview"><div class="wpvh">' + esc(cfg.previewHead || 'Preview') + '</div>' + rows + '</div>' +
          warns +
          '<div class="wchecks">' + esc(cfg.checks || '') + '</div>' +
          '<div class="wsheet-actions">' +
            '<button class="wbtn" id="w-sec-reject">Reject</button>' +
            (danger ? '<button class="wbtn danger" id="w-sec-ok">I understand the risk — approve</button>'
                    : '<button class="wbtn primary" id="w-sec-ok">' + esc(cfg.approveLabel || 'Approve') + '</button>') +
          '</div>' +
        '</div>';
      var done = function (v) { sheet.innerHTML = ''; resolve(v); };
      var x = $('#w-sec-x'); if (x) x.addEventListener('click', function () { done(false); });
      var rej = $('#w-sec-reject'); if (rej) rej.addEventListener('click', function () { done(false); });
      var ok = $('#w-sec-ok'); if (ok) ok.addEventListener('click', function () { done(true); });
    });
  }

  // ===========================================================================
  // canvas sparkline (ported from the design reference; no-op without a 2d ctx) —
  // single-series area + line (gain hue), the net-worth trend.
  // ===========================================================================
  function cssv(n) {
    try { return getComputedStyle(document.querySelector('.wallet-root') || document.documentElement).getPropertyValue(n).trim() || fallbackVar(n); }
    catch (_) { return fallbackVar(n); }
  }
  function fallbackVar(n) { var m = { '--w-gain': '#2fd39b', '--w-accent': '#4c8dff', '--w-loss': '#f0536a' }; return m[n] || '#4c8dff'; }
  function fit(cv) {
    if (!cv || typeof cv.getContext !== 'function') return null;
    var r = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: cv.width || 280, height: cv.height || 72 };
    var w = r.width || cv.width || 280, h = r.height || cv.height || 72;
    if (!w) return null;
    var d = Math.max(1, (global.devicePixelRatio || 1));
    cv.width = w * d; cv.height = h * d;
    var ctx = cv.getContext('2d'); if (!ctx) return null;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function drawSpark(cv, data) {
    var f = fit(cv); if (!f) return;
    if (!data || data.length < 2) return;
    var ctx = f.ctx, w = f.w, h = f.h, pad = 6;
    var min = Math.min.apply(null, data), max = Math.max.apply(null, data), rng = (max - min) || 1;
    var up = data[data.length - 1] >= data[0];
    var col = up ? cssv('--w-gain') : cssv('--w-loss');
    var X = function (i) { return pad + i / (data.length - 1) * (w - pad * 2); };
    var Y = function (v) { return h - pad - (v - min) / rng * (h - pad * 2); };
    var g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, col + '44'); g.addColorStop(1, col + '00');
    ctx.beginPath(); ctx.moveTo(X(0), Y(data[0]));
    for (var i = 1; i < data.length; i++) ctx.lineTo(X(i), Y(data[i]));
    ctx.lineTo(X(data.length - 1), h - pad); ctx.lineTo(X(0), h - pad); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(0), Y(data[0]));
    for (var j = 1; j < data.length; j++) ctx.lineTo(X(j), Y(data[j]));
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    var lx = X(data.length - 1), ly = Y(data[data.length - 1]);
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, 7); ctx.fillStyle = col; ctx.fill();
  }

  // ===========================================================================
  global.WalletUI = {
    init: init, enter: enter, onUnlock: onUnlock, onResume: onResume, onLock: onLock,
    openProposalSheet: openProposalSheet, wcRequestCtx: wcRequestCtx, openSecuritySheet: openSecuritySheet,
    // pure helpers (DOM-level test + reuse)
    usd: usd, signedUsd: signedUsd, shortAddr: shortAddr, checksLine: checksLine,
    sheetConfigFor: sheetConfigFor, maxSev: maxSev,
    holdingRowHtml: holdingRowHtml, activityRowHtml: activityRowHtml,
    nftTileHtml: nftTileHtml, sessionRowHtml: sessionRowHtml, resolvedLineHtml: resolvedLineHtml,
    bookRowHtml: bookRowHtml, fmtAmount: fmtAmount,
    _setEngine: function (e) { engine = e; },
    _state: function () { return { activeTab: activeTab, send: send }; },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.WalletUI;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
