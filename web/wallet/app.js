/* Blockle Web Wallet — non-custodial SPA over the extension's own crypto/chain/agent stack.
 * Keys are generated + held in-page (ML-DSA-44 + HD seed), sealed by vault.js (scrypt+AES-GCM)
 * in localStorage; plaintext secrets live only in the in-memory session while unlocked. The
 * server is a relay (POST /api/submit + chain RPCs). This file is UI + wiring only — all crypto
 * comes from the vendored globals (Wallet, Wiring, Signer, Agent*, etc). */
(function () {
  'use strict';
  var GATEWAY = 'https://agent.blockle.org';
  var ACCOUNTS = '/account/api';
  var COIN = 100000000;
  var BLOCKLE_MARK = 'blockle-mark.png'; // the real Blockle logo mark (served under /wallet/)

  /* ---------------- tiny DOM/util helpers ---------------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function elFrom(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function toast(msg, kind, iconName) {
    var t = elFrom('<div class="toast ' + (kind || '') + '">' + (iconName ? mi(iconName, 15) + ' ' : '') + esc(msg) + '</div>');
    $('#toasts').appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = '.3s'; setTimeout(function () { t.remove(); }, 300); }, 2600);
  }
  function copy(text) { try { navigator.clipboard.writeText(text); toast('Copied'); } catch (_) {} }
  function shortAddr(a) { if (!a) return '—'; a = String(a); return a.length > 18 ? a.slice(0, 9) + '…' + a.slice(-6) : a; }
  function fmtAmt(n, dp) { var x = Number(n); if (!isFinite(x)) return '0'; return x.toLocaleString(undefined, { maximumFractionDigits: dp == null ? 6 : dp }); }
  function fmtUsd(n) { var x = Number(n); if (!isFinite(x)) return '—'; return '$' + x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function baseToNum(confirmed, decimals) { try { return Number(BigInt(confirmed || '0')) / Math.pow(10, decimals || 0); } catch (_) { return Number(confirmed || 0) / Math.pow(10, decimals || 0); } }
  // A row's `display` may be a locale-formatted string ("140,001.74") from some
  // adapters; Number() of that is NaN (→ renders 0 and gets filtered out). Strip
  // grouping separators before converting so large balances (≥1,000) are correct.
  function numVal(x) { return typeof x === 'number' ? x : Number(String(x == null ? '' : x).replace(/,/g, '')); }
  // Exact decimal-string -> base-units (BigInt string), no float rounding — safe
  // for large amounts (e.g. sending 140,000 BLOCK) where amt*1e8 would lose bits.
  function toBaseUnits(decStr, decimals) {
    var s = String(decStr == null ? '' : decStr).trim().replace(/,/g, '');
    if (s === '' || s === '.' || !/^\d*(\.\d*)?$/.test(s)) return '0';
    var d = Math.max(0, decimals || 0), parts = s.split('.');
    var whole = parts[0] || '0', frac = (parts[1] || '');
    frac = (frac + '00000000000000000000').slice(0, d);
    try { return (BigInt(whole) * (10n ** BigInt(d)) + BigInt(frac || '0')).toString(); } catch (_) { return '0'; }
  }

  /* ---------------- icon set (unique inline SVGs; no emoji, currentColor) ---------------- */
  var ICONS = {
    portfolio: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8A8.2 8.2 0 0 1 20.2 12H12z"/>',
    assets: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    send: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    receive: '<path d="M17 7 7 17"/><path d="M16 17H7V8"/>',
    swap: '<path d="M4 8h13l-3.2-3.2"/><path d="M20 16H7l3.2 3.2"/>',
    bridge: '<path d="M3 9.5v8"/><path d="M21 9.5v8"/><path d="M3 11.5c4.5 0 4-4.5 9-4.5s4.5 4.5 9 4.5"/><path d="M8 11.5v6"/><path d="M16 11.5v6"/>',
    buy: '<rect x="3" y="6" width="18" height="12" rx="2.2"/><path d="M3 10h18"/><path d="M7 15h3"/>',
    agent: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    bots: '<rect x="4.5" y="8" width="15" height="10.5" rx="2.4"/><path d="M12 8V4.6"/><circle cx="12" cy="4" r="1.1"/><circle cx="9.3" cy="13" r="1.2"/><circle cx="14.7" cy="13" r="1.2"/><path d="M9.5 16.2h5"/>',
    activity: '<path d="M3 12h4l2.2 6 4-14 2 8H21"/>',
    pro: '<path d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.2v3M12 18.8v3M2.2 12h3M18.8 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2.2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/><circle cx="12" cy="15.5" r="1.1"/>',
    theme: '<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4a8.2 8.2 0 0 0 0-16.4z" fill="currentColor" stroke="none"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    warn: '<path d="M12 3.5 2.3 20.2h19.4z"/><path d="M12 9.5v5"/><circle cx="12" cy="17.3" r="0.7" fill="currentColor" stroke="none"/>',
    shield: '<path d="M12 3l7 2.8v4.9c0 4.9-3 7.1-7 9.1-4-2-7-4.2-7-9.1V5.8z"/><path d="M9 12l2 2 4-4.2"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-1.3 5.4"/><path d="M20 4.5V11h-6.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    image: '<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><circle cx="8.3" cy="9.3" r="1.6"/><path d="M4 17.5l5-5 3.5 3.5 3-3 4.5 4.5"/>',
    arena: '<path d="M7 4.5h10v3.5a5 5 0 0 1-10 0z"/><path d="M7 6H4.5v1.5A2.5 2.5 0 0 0 7 10M17 6h2.5v1.5A2.5 2.5 0 0 1 17 10"/><path d="M12 13v3.5M8.5 20h7M10 20v-1a2 2 0 0 1 4 0v1"/>',
    live: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><path d="M6.5 6.5a8 8 0 0 0 0 11M17.5 6.5a8 8 0 0 1 0 11"/>',
    dca: '<path d="M4 14.5l4.5-4.5 3.5 3L20 6"/><path d="M15 6h5v5"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/>',
    smart: '<path d="M12 2.8 21.2 12 12 21.2 2.8 12z"/><circle cx="12" cy="12" r="2.6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c0-4 3.8-6 7.5-6s7.5 2 7.5 6"/>',
    chevron: '<path d="M6 9.5l6 6 6-6"/>',
    chevronR: '<path d="M9.5 6l6 6-6 6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
    download: '<path d="M12 3v12"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 20h15"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2.4"/><path d="M3 10h18"/><circle cx="16.5" cy="13.5" r="1.3" fill="currentColor" stroke="none"/>',
    link: '<path d="M9.5 14.5l5-5"/><path d="M8 11.5 6 13.5a3 3 0 0 0 4.2 4.2l2-2"/><path d="M16 12.5l2-2a3 3 0 0 0-4.2-4.2l-2 2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8"/><path d="M16 7l2 2M14 9l2 2"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 15.5h6M9 8.5h2"/>',
    moon: '<path d="M14.5 4.5c2.5-1 4 0 5 1s2 2.5 1 5c-1.3 3.4-5 6.5-8 7.5l-3.5-3.5c1-3 4.1-6.7 5.5-10z"/><circle cx="15" cy="9" r="1.4"/><path d="M8.5 13.5 5.5 13c.5-2 1.6-3.3 3.5-3.5M10.5 15.5l.5 3c2-.5 3.3-1.6 3.5-3.5"/><path d="M5 19l2.5-2.5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  };
  function ic(name, size) {
    var p = ICONS[name] || ICONS.close;
    return '<svg class="ic-svg" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }
  // Custom-glyph icon from the shared master set (vendor/icons.js) — these replace the
  // former inline emoji. Returns an inline <svg> STRING, so only drop it into raw-HTML
  // positions (never an escaped text node, <option>, or document.title). Falls back to ''
  // if the module is missing so a load race can never throw mid-render.
  function mi(name, size) {
    try { return (window.BlockleIcons && window.BlockleIcons.icon) ? window.BlockleIcons.icon(name, { size: size || 16 }) : ''; } catch (_) { return ''; }
  }

  /* ---------------- modal sheet ---------------- */
  var _sheetResolve = null;
  function openSheet(html) {
    $('#sheet').innerHTML = html;
    $('#scrim').classList.add('open');
    return $('#sheet');
  }
  function closeSheet() { $('#scrim').classList.remove('open'); if (_sheetResolve) { var r = _sheetResolve; _sheetResolve = null; r(false); } }
  $('#scrim') && $('#scrim').addEventListener('click', function (e) { if (e.target === $('#scrim')) closeSheet(); });

  /* The one approval sheet. Returns Promise<bool>. Shared by manual sends AND the agent
   * policy.confirm / SecurityGate — this is the single non-bypassable gate. */
  function confirmSheet(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var danger = !!opts.danger;
      var warnHtml = '';
      if (opts.warnings && opts.warnings.length) {
        warnHtml = '<div class="banner ' + (danger ? 'danger' : 'warn') + '" style="margin:10px 0">' +
          '<span>' + ic('warn', 18) + '</span><div>' + opts.warnings.map(function (w) { return esc(typeof w === 'string' ? w : (w.message || w.code || JSON.stringify(w))); }).join('<br>') + '</div></div>';
      }
      var rows = (opts.lines || []).map(function (l) { return '<div class="kv"><span class="muted">' + esc(l[0]) + '</span><span class="mono num">' + esc(l[1]) + '</span></div>'; }).join('');
      openSheet(
        '<div class="spread"><h2>' + esc(opts.title || 'Confirm') + '</h2><button class="btn sm ghost" id="cs-x">' + ic('close', 15) + '</button></div>' +
        '<p class="muted" style="margin:6px 0 10px">' + esc(opts.subtitle || 'Review this action. It will be signed on your device and broadcast.') + '</p>' +
        warnHtml + '<div class="list">' + rows + '</div>' +
        (danger ? '<label class="row" style="margin:12px 0;text-transform:none;font-weight:500"><input type="checkbox" id="cs-ack" style="width:auto"> I understand the risk and want to proceed</label>' : '') +
        '<div class="row" style="margin-top:14px;gap:10px"><button class="btn wide ghost" id="cs-no">Reject</button><button class="btn wide primary" id="cs-yes"' + (danger ? ' disabled' : '') + '>' + esc(opts.okText || 'Approve') + '</button></div>'
      );
      _sheetResolve = resolve;
      var done = function (v) { _sheetResolve = null; $('#scrim').classList.remove('open'); resolve(v); };
      if (danger) $('#cs-ack').addEventListener('change', function (e) { $('#cs-yes').disabled = !e.target.checked; });
      $('#cs-x').addEventListener('click', function () { done(false); });
      $('#cs-no').addEventListener('click', function () { done(false); });
      $('#cs-yes').addEventListener('click', function () { done(true); });
    });
  }

  /* ---------------- app state ---------------- */
  var S = {
    unlocked: false, address: '', chain: 'block', chains: ['block'],
    tier: 'free', pro: false, user: null,
    agent: null, botRunner: null, agentConn: null,
  };
  function isPro() { return S.tier && S.tier !== 'free'; }

  /* Gas sponsorship: paid users never need to hold BLOCK to swap. If the active BLOCK
   * address lacks gas, a paid plan drips a little BLOCK from the operator (non-custodial —
   * the user still signs their own swap). Returns true when there's enough gas to proceed. */
  var GAS_NEED_BASE = 3000000; // ~0.03 BLOCK: a swap's gas + fee
  function blockSpendableBase(addr) { return Chain.utxos(addr).then(function (u) { return Number((u && u.spendable) || 0); }).catch(function () { return 0; }); }
  function ensureGas() {
    if (S.chain !== 'block') return Promise.resolve(true); // only BLOCK ops need BLOCK gas
    var addr = Wallet.address;
    return blockSpendableBase(addr).then(function (have) {
      if (have >= GAS_NEED_BASE) return true;
      if (!isPro()) { toast('A little BLOCK is needed for gas — upgrade to Pro for sponsored gas', 'bad'); return false; }
      toast('Sponsoring gas…');
      return fetch('/api/gas/sponsor', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ address: addr }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res || (!res.ok && !res.skipped)) { toast((res && res.error) || 'Gas sponsorship unavailable', 'bad'); return false; }
          if (res.skipped) return true;
          // wait for the sponsored gas to confirm
          var tries = 0;
          return (function poll() {
            return new Promise(function (r2) { setTimeout(r2, 4000); }).then(function () {
              return blockSpendableBase(addr).then(function (now) {
                if (now >= GAS_NEED_BASE) { toast('Gas received — continuing', 'good'); return true; }
                if (++tries >= 30) { toast('Gas sent; waiting on confirmation — try again shortly', 'bad'); return false; }
                return poll();
              });
            });
          })();
        }).catch(function (e) { toast('Gas sponsorship failed: ' + (e.message || e), 'bad'); return false; });
    });
  }

  /* ---------------- boot ---------------- */
  function themeApply(t) { if (t) document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('blk:wallet:theme', t || ''); } catch (_) {} }
  (function initTheme() { try { var t = localStorage.getItem('blk:wallet:theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (_) {} })();

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // When a bumped service worker takes control (skipWaiting + clients.claim),
    // reload ONCE so the page actually runs the new vendor code (e.g. an updated
    // chain.js) instead of the stale in-memory bundle — the classic PWA
    // "two reloads" trap that otherwise leaves a fix looking un-applied.
    var swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (swReloaded) return; swReloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js', { scope: '/wallet/' }).then(function (reg) {
      reg.addEventListener && reg.addEventListener('updatefound', function () {
        var nw = reg.installing; if (!nw) return;
        nw.addEventListener('statechange', function () { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Updating the wallet…', 'good'); });
      });
    }).catch(function () {});
  }

  function boot() {
    registerSW();
    // One-time repair: an earlier build could persist a testnet `apiBase`, which makes
    // BLOCK + token balances read the testnet chain and show 0 for a mainnet address.
    // The web wallet has no legitimate testnet endpoint, so drop a stale testnet value.
    try {
      Store.get('apiBase').then(function (r) {
        var ab = r && r.apiBase;
        if (ab && Chain && ab !== Chain.DEFAULT_API && ab !== Chain.TESTNET_API) Store.set({ apiBase: Chain.DEFAULT_API });
      }).catch(function () {});
    } catch (_) {}
    // Hide broken images globally (replaces inline onerror= handlers so a strict CSP
    // with no 'unsafe-inline' can block injected inline event handlers).
    document.addEventListener('error', function (e) { var t = e.target; if (t && t.tagName === 'IMG') t.style.display = 'none'; }, true);
    $('#btn-theme').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      themeApply(cur === 'light' ? 'dark' : 'light');
    });
    $('#btn-lock').addEventListener('click', lock);
    window.addEventListener('hashchange', onRoute);
    // try to resume an unlocked session (web Session is in-memory → usually false after reload)
    Wallet.resumeSession().then(function (ok) {
      if (ok && Wallet.isUnlocked && Wallet.isUnlocked()) enterApp();
      else showGate();
    }).catch(showGate);
    if (CONNECT.active) CONNECT.boot();
  }

  /* ---------------- onboarding / unlock gate ---------------- */
  function showGate() {
    S.unlocked = false; $('#authed').classList.add('hide'); var o = $('#overlay'); o.classList.remove('hide');
    Wallet.exists().then(function (has) { has ? renderUnlock() : renderCreate(); });
  }
  function gateShell(inner) {
    $('#overlay').innerHTML =
      '<div class="onbox card">' +
      '<div class="brand" style="font-size:20px;margin-bottom:6px;gap:10px"><img src="' + BLOCKLE_MARK + '" alt="Blockle" style="width:30px;height:30px;border-radius:8px;object-fit:cover"><span>Blockle Wallet</span></div>' +
      inner + '</div>';
  }
  function renderUnlock() {
    gateShell(
      '<p class="muted" style="margin:2px 0 14px">Welcome back. Enter your password to unlock. Your keys are decrypted only on this device.</p>' +
      '<div class="field"><label>Password</label><input id="g-pw" type="password" autocomplete="current-password" placeholder="Wallet password"></div>' +
      '<div id="g-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
      '<button id="g-go" class="btn primary wide">Unlock</button>' +
      '<div class="row" style="justify-content:space-between;margin-top:12px;font-size:13px">' +
      '<a href="#" id="g-import">Import a wallet</a><a href="#" id="g-reset" class="muted">Reset</a></div>'
    );
    var go = function () {
      var pw = $('#g-pw').value; if (!pw) return;
      $('#g-go').disabled = true; $('#g-go').textContent = 'Unlocking…';
      Wallet.unlock(pw).then(function () { enterApp(); }).catch(function (e) {
        $('#g-err').textContent = 'Wrong password or corrupt vault.'; $('#g-go').disabled = false; $('#g-go').textContent = 'Unlock';
      });
    };
    $('#g-go').addEventListener('click', go);
    $('#g-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
    $('#g-import').addEventListener('click', function (e) { e.preventDefault(); renderImport(); });
    $('#g-reset').addEventListener('click', function (e) { e.preventDefault(); if (confirm('Reset removes the wallet from THIS browser. Make sure you exported your file/seed. Continue?')) { try { localStorage.clear(); } catch (_) {} location.reload(); } });
    setTimeout(function () { $('#g-pw').focus(); }, 60);
  }
  function renderCreate() {
    gateShell(
      '<p class="muted" style="margin:2px 0 12px">Create a non-custodial wallet. The keys are generated here, in your browser, and never sent anywhere. Pick a strong password — it encrypts your keys on this device.</p>' +
      '<div class="banner info" style="margin-bottom:12px"><span>' + ic('shield', 18) + '</span><div>Nobody can recover this password for you. After creating, download your encrypted backup file.</div></div>' +
      '<div class="field"><label>Password</label><input id="c-pw" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>' +
      '<div class="field"><label>Confirm</label><input id="c-pw2" type="password" autocomplete="new-password" placeholder="Repeat password"></div>' +
      '<div id="c-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
      '<button id="c-go" class="btn primary wide">Create wallet</button>' +
      '<div class="row" style="justify-content:space-between;margin-top:12px;font-size:13px">' +
      '<a href="#" id="c-import">Import existing</a><a href="/download" class="muted">Desktop &amp; extension →</a></div>'
    );
    $('#c-import').addEventListener('click', function (e) { e.preventDefault(); renderImport(); });
    $('#c-go').addEventListener('click', function () {
      var pw = $('#c-pw').value, pw2 = $('#c-pw2').value, err = $('#c-err');
      if (pw.length < 8) return (err.textContent = 'Password must be at least 8 characters.');
      if (pw !== pw2) return (err.textContent = 'Passwords do not match.');
      $('#c-go').disabled = true; $('#c-go').textContent = 'Generating keys…';
      Wallet.create(pw, 'Web Wallet').then(function () {
        toast('Wallet created', 'good'); enterApp(); setTimeout(offerBackup, 400);
      }).catch(function (e) { err.textContent = 'Create failed: ' + (e.message || e); $('#c-go').disabled = false; $('#c-go').textContent = 'Create wallet'; });
    });
  }
  function renderImport(tab) {
    tab = tab || 'file';
    var tabs = '<div class="row" style="gap:6px;margin:8px 0 10px;flex-wrap:wrap">' +
      '<button class="btn sm' + (tab === 'file' ? '' : ' ghost') + '" id="i-tab-file">Blockle wallet file</button>' +
      '<button class="btn sm' + (tab === 'chain' ? '' : ' ghost') + '" id="i-tab-chain">Private key · seed phrase · wallet.dat</button></div>';
    if (tab === 'chain') return renderImportChain(tabs);
    gateShell(
      '<div class="spread"><h3>Import a wallet</h3><a href="#" id="i-back" class="muted" style="font-size:13px">Back</a></div>' + tabs +
      '<p class="muted" style="margin:8px 0 12px">Import your encrypted Blockle wallet file. It is decrypted on this device only.</p>' +
      '<div class="field"><label>Wallet file (.json)</label><input id="i-file" type="file" accept="application/json,.json"></div>' +
      '<div class="field"><label>File password</label><input id="i-fpw" type="password" placeholder="Password the file was exported with"></div>' +
      '<div class="field"><label>New password for this browser</label><input id="i-npw" type="password" placeholder="Encrypts the import here"></div>' +
      '<div id="i-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
      '<button id="i-go" class="btn primary wide">Import</button>'
    );
    $('#i-back').addEventListener('click', function (e) { e.preventDefault(); showGate(); });
    $('#i-tab-chain').addEventListener('click', function () { renderImport('chain'); });
    $('#i-go').addEventListener('click', function () {
      var f = $('#i-file').files[0], err = $('#i-err');
      if (!f) return (err.textContent = 'Choose your wallet file.');
      var rd = new FileReader();
      rd.onload = function () {
        var obj; try { obj = JSON.parse(rd.result); } catch (_) { return (err.textContent = 'That file is not valid JSON.'); }
        Wallet.importFile(obj, $('#i-fpw').value, $('#i-npw').value || $('#i-fpw').value, 'Imported').then(function () {
          toast('Imported', 'good'); enterApp();
        }).catch(function (e) { err.textContent = 'Import failed: ' + (e.message || e); });
      };
      rd.readAsText(f);
    });
  }
  // Chain-specific imports need an unlocked wallet (the key is sealed INTO its
  // vault as a new account), so this gate step unlocks — or creates — the wallet
  // first and then opens the import wizard.
  function renderImportChain(tabs) {
    Wallet.exists().then(function (has) {
      gateShell(
        '<div class="spread"><h3>Import a wallet</h3><a href="#" id="i-back" class="muted" style="font-size:13px">Back</a></div>' + tabs +
        '<p class="muted" style="margin:8px 0 12px">Import a private key, recovery phrase, Ethereum keystore or Bitcoin/Litecoin/Dogecoin Core <b>wallet.dat</b> for a specific chain. It is added as a new account inside ' + (has ? 'your wallet' : 'a new wallet') + ' — existing accounts stay as they are.</p>' +
        (has ? '<div class="field"><label>Wallet password</label><input id="ic-pw" type="password" autocomplete="current-password" placeholder="Unlock to add the account"></div>'
             : '<div class="field"><label>New wallet password</label><input id="ic-pw" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div><div class="field"><label>Confirm</label><input id="ic-pw2" type="password" autocomplete="new-password"></div>') +
        '<div id="ic-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
        '<button id="ic-go" class="btn primary wide">Continue</button>');
      $('#i-back').addEventListener('click', function (e) { e.preventDefault(); showGate(); });
      $('#i-tab-file').addEventListener('click', function () { renderImport('file'); });
      var go = function () {
        var pw = $('#ic-pw').value, err = $('#ic-err');
        if (!pw) return (err.textContent = 'Enter a password.');
        if (!has) { if (pw.length < 8) return (err.textContent = 'Password must be at least 8 characters.'); if (pw !== $('#ic-pw2').value) return (err.textContent = 'Passwords do not match.'); }
        $('#ic-go').disabled = true; $('#ic-go').textContent = has ? 'Unlocking…' : 'Creating wallet…';
        (has ? Wallet.unlock(pw) : Wallet.create(pw, 'Web Wallet')).then(function () {
          enterApp(); setTimeout(function () { importAccountSheet({ password: pw }); }, 250);
        }).catch(function () { err.textContent = has ? 'Wrong password or corrupt vault.' : 'Could not create the wallet.'; $('#ic-go').disabled = false; $('#ic-go').textContent = 'Continue'; });
      };
      $('#ic-go').addEventListener('click', go);
      $('#ic-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      setTimeout(function () { $('#ic-pw').focus(); }, 60);
    });
  }
  function offerBackup() {
    openSheet('<div class="spread"><h2>Back up your wallet</h2><button class="btn sm ghost" id="b-x">' + ic('close', 15) + '</button></div>' +
      '<p class="muted" style="margin:8px 0">Download the encrypted wallet file now. Keep it safe — it is the only way to restore this wallet on another device. The file is useless without your password.</p>' +
      '<button class="btn primary wide" id="b-dl">Download encrypted backup</button>' +
      '<button class="btn wide ghost" id="b-skip" style="margin-top:8px">I\'ll do it later</button>');
    $('#b-x').addEventListener('click', closeSheet); $('#b-skip').addEventListener('click', closeSheet);
    $('#b-dl').addEventListener('click', function () {
      try {
        var id = Wallet.selectedId ? Wallet.selectedId : null;
        Promise.resolve(Wallet.exportFile ? Wallet.exportFile(id) : null).then(function (obj) {
          if (!obj) { toast('Export unavailable — use Settings → Export', 'bad'); return; }
          var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
          var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'blockle-wallet-backup.json'; a.click();
          toast('Backup downloaded', 'good'); closeSheet();
        });
      } catch (e) { toast('Export failed', 'bad'); }
    });
  }

  /* ---------------- enter authenticated app ---------------- */
  var NAV = [
    { id: 'portfolio', ic: 'portfolio', label: 'Portfolio' },
    { id: 'assets', ic: 'assets', label: 'Assets' },
    { id: 'send', ic: 'send', label: 'Send' },
    { id: 'receive', ic: 'receive', label: 'Receive' },
    { id: 'swap', ic: 'swap', label: 'Swap' },
    { id: 'moon', ic: 'moon', label: 'Moon' },
    { id: 'bridge', ic: 'bridge', label: 'Bridge' },
    { id: 'agent', ic: 'agent', label: 'Agent' },
    { id: 'bots', ic: 'bots', label: 'Bots' },
    { id: 'chat', ic: 'agent', label: 'AI Chat' },
    { id: 'inference', ic: 'agent', label: 'Inference' },
    { id: 'activity', ic: 'activity', label: 'Activity' },
    { id: 'pro', ic: 'pro', label: 'Pro' },
    { id: 'settings', ic: 'settings', label: 'Settings' },
  ];
  var BOTNAV = ['portfolio', 'moon', 'bots', 'assets', 'agent'];

  /* ---------------- sidebar drawer (portrait / narrow screens) ----------------
   * On ≤860px the sidenav is an off-canvas drawer: the menu button in the top bar
   * (and a swipe from the left edge) pops it out; the scrim, a nav tap, Escape
   * or a route change closes it. On wide screens it is the normal sticky column. */
  function navOpen() { var n = $('#sidenav'); if (!n) return; n.classList.add('open'); $('#navscrim').classList.add('open'); var b = $('#btn-menu'); if (b) b.setAttribute('aria-expanded', 'true'); }
  function navClose() { var n = $('#sidenav'); if (!n) return; n.classList.remove('open'); $('#navscrim').classList.remove('open'); var b = $('#btn-menu'); if (b) b.setAttribute('aria-expanded', 'false'); }
  function navToggle() { var n = $('#sidenav'); if (n && n.classList.contains('open')) navClose(); else navOpen(); }
  (function wireDrawer() {
    var b = $('#btn-menu'); if (b) b.addEventListener('click', navToggle);
    var sc = $('#navscrim'); if (sc) sc.addEventListener('click', navClose);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') navClose(); });
    // edge swipe: start within 24px of the left edge, drag right > 60px
    var sx = null, sy = null;
    document.addEventListener('touchstart', function (e) { var t = e.touches && e.touches[0]; if (!t) return; sx = t.clientX <= 24 ? t.clientX : null; sy = t.clientY; }, { passive: true });
    document.addEventListener('touchend', function (e) { if (sx == null) return; var t = e.changedTouches && e.changedTouches[0]; if (t && t.clientX - sx > 60 && Math.abs(t.clientY - sy) < 80 && S.unlocked) navOpen(); sx = null; }, { passive: true });
  })();

  /* ---------------- dApp connect bridge (popup) ----------------
   * When this wallet is opened as a popup with ?connect=<dappOrigin>, a dApp
   * (e.g. the WORLD game) can connect to it over postMessage. Two steps, both
   * explicitly approved by the user and scoped to the requesting origin:
   *   1) connect:request  → wallet shows an approval sheet, returns the address
   *      + public key (connect:account).
   *   2) connect:sign      → wallet signs the dApp-provided message (a login
   *      challenge) and returns the signature (connect:signed). Messages are
   *      SIGNED, never built into transactions here, so this can never move
   *      funds — a transfer always goes through the normal send + approval UI.
   * Secrets never leave the wallet; only address/pubkey/signature cross over. */
  var CONNECT = (function () {
    var params = new URLSearchParams(location.search);
    var raw = params.get('connect');
    var origin = null;
    var app = (params.get('app') || '').replace(/[^\w .-]/g, '').slice(0, 40) || 'A dApp';
    if (raw) { try { var u = new URL(raw); if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin; } catch (_) {} }
    var approved = false, pending = false, busy = false;
    function post(msg) { try { if (window.opener && origin) window.opener.postMessage(Object.assign({ _blockle: 1 }, msg), origin); } catch (_) {} }
    function ready() { post({ type: 'blockle:wallet:ready' }); }
    async function doConnect() {
      if (busy) return; busy = true;
      try {
        if (!S.unlocked) { pending = true; return; }
        var ok = await confirmSheet({
          title: 'Connect to ' + app,
          subtitle: app + ' wants to see your address and ask you to sign in. It can never move funds without a separate send approval.',
          lines: [['Site', origin], ['Wallet', shortAddr(Wallet.address)]],
          okText: 'Connect',
        });
        if (!ok) { post({ type: 'blockle:connect:rejected' }); return; }
        approved = true;
        var balFmt = null, ticker = 'BLOCK';
        try { var a = await Chain.account(Wallet.address); balFmt = a && a.balanceFmt; } catch (_) {}
        post({ type: 'blockle:connect:account', address: Wallet.address, publicKey: Wallet.publicKeyHex, balanceFmt: balFmt, ticker: ticker });
      } finally { busy = false; }
    }
    async function doSign(message) {
      if (!approved || !S.unlocked) { post({ type: 'blockle:connect:rejected' }); return; }
      if (typeof message !== 'string' || !message.length || message.length > 2048) { post({ type: 'blockle:connect:error', message: 'bad message' }); return; }
      try {
        var signed = await Wallet.signMessage(message);
        post({ type: 'blockle:connect:signed', address: signed.address || Wallet.address, publicKey: signed.publicKey || Wallet.publicKeyHex, signature: signed.signature });
      } catch (e) { post({ type: 'blockle:connect:error', message: (e && e.message) || 'sign failed' }); }
    }
    if (origin) {
      window.addEventListener('message', function (e) {
        if (e.origin !== origin || e.source !== window.opener) return;
        var d = e.data || {};
        if (d.type === 'blockle:connect:request') doConnect();
        else if (d.type === 'blockle:connect:sign') doSign(d.message);
      });
      window.addEventListener('beforeunload', function () { post({ type: 'blockle:wallet:closed' }); });
    }
    return {
      active: !!origin,
      boot: function () { if (origin) ready(); },
      onEnter: function () { if (!origin) return; ready(); if (pending) { pending = false; doConnect(); } },
    };
  })();

  function enterApp() {
    S.unlocked = true; S.address = Wallet.address;
    $('#overlay').classList.add('hide'); $('#overlay').innerHTML = ''; $('#authed').classList.remove('hide');
    buildNav();
    resetAutoLock();
    refreshChains();
    loadTier();
    // AUTO-IMPORT every held token on every network: on unlock, then every 5 min
    // while unlocked (and on chain switch / assets refresh — see runAutoImport).
    runAutoImport('unlock');
    clearInterval(_autoImportTimer);
    _autoImportTimer = setInterval(function () { if (S.unlocked) runAutoImport('interval'); }, 5 * 60 * 1000);
    // keep bots ticking the moment the tab comes back into view, and re-check the
    // account session/plan so a sign-in or upgrade made elsewhere shows up here.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (S.botRunner && S.botRunner._schedulerTick) { try { S.botRunner._schedulerTick(); } catch (_) {} }
      loadTier();
    });
    // keep the account session warm (the server extends it on every /me) and the
    // plan badge current while the wallet is open.
    clearInterval(_tierTimer);
    _tierTimer = setInterval(function () { if (S.unlocked) loadTier(); }, 10 * 60 * 1000);
    $('#acctsel').onclick = openAccountSheet;
    // Deep-link from the DEX / token pages: /wallet?swap=<contract>&side=buy&amt=1
    // opens the swap view with the token, direction and amount prefilled.
    try {
      var _sp = new URLSearchParams(location.search);
      var _swt = (_sp.get('swap') || '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(_swt)) {
        S._swapPrefill = _swt;
        S._swapSide = _sp.get('side') === 'sell' ? 'sell' : 'buy';
        S._swapAmt = _sp.get('amt') || _sp.get('amount') || '';
        location.hash = '#swap';
      }
    } catch (_) {}
    // Deep-link from the home strategy board + the leaderboard/profile into the
    // bot-create sheet: ?strategy=<name> preselects a strategy; ?copyBot=<id>
    // clones another trader's bot CONFIG (config-only, never funds/live state).
    try {
      var _bp = new URLSearchParams(location.search);
      var _strat = (_bp.get('strategy') || '').trim();
      var _copy = (_bp.get('copyBot') || '').trim();
      if (_strat) { S._botPrefill = { strategy: _strat }; location.hash = '#bots'; }
      if (_copy) { S._botCopyId = _copy; location.hash = '#bots'; }
    } catch (_) {}
    if (!location.hash) location.hash = '#portfolio';
    onRoute();
    ['click', 'keydown', 'mousemove', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, resetAutoLock, { passive: true }); });
    if (CONNECT.active) CONNECT.onEnter();
  }
  function buildNav() {
    $('#sidenav').innerHTML = '<div class="drawerhead"><span class="brand"><img class="logo" src="' + BLOCKLE_MARK + '" alt=""> Wallet</span><button class="btn sm ghost" id="nav-close" aria-label="Close menu">' + ic('close', 15) + '</button></div>' + NAV.map(function (n) {
      return '<a class="navlink" href="#' + n.id + '" data-id="' + n.id + '"><span class="ic">' + ic(n.ic, 20) + '</span><span>' + n.label + '</span>' + (n.id === 'pro' ? '<span class="tag">' + ic('pro', 13) + '</span>' : '') + '</a>';
    }).join('');
    $('#nav-close').addEventListener('click', navClose);
    $$('#sidenav .navlink').forEach(function (a) { a.addEventListener('click', navClose); });
    $('#botnav').innerHTML = BOTNAV.map(function (id) {
      var n = NAV.filter(function (x) { return x.id === id; })[0];
      return '<a href="#' + id + '" data-id="' + id + '"><span>' + ic(n.ic, 21) + '</span><span>' + n.label + '</span></a>';
    }).join('');
  }

  /* ---------------- token auto-import ---------------- */
  var _autoImportTimer = null, _autoImportLast = null, _tierTimer = null;
  function runAutoImport(reason, opts) {
    if (!S.unlocked || !window.Wiring || !Wiring.autoImportTokens) return Promise.resolve(null);
    return Wiring.autoImportTokens(opts || {}).then(function (sum) {
      _autoImportLast = { at: Date.now(), reason: reason, summary: sum };
      if (!sum) return sum;
      var imp = sum.imported || [], fl = sum.flagged || [];
      if (imp.length) {
        var syms = imp.slice(0, 4).map(function (t) { return (t.symbol || '?') + ' (' + String(t.chain || '').toUpperCase() + ')'; }).join(', ');
        toast('Auto-imported ' + imp.length + ' token' + (imp.length > 1 ? 's' : '') + ': ' + syms + (imp.length > 4 ? '…' : ''), 'good', 'sparkle');
        if ((location.hash || '') === '#assets') loadTokens(); else if ((location.hash || '#portfolio') === '#portfolio') loadPortfolio();
      }
      if (fl.length && reason === 'unlock') toast(fl.length + ' suspicious token' + (fl.length > 1 ? 's' : '') + ' hidden — review under Assets', 'bad');
      return sum;
    }).catch(function () { return null; });
  }

  /* ---------------- auto-lock ---------------- */
  var _lockTimer = null;
  function resetAutoLock() { if (!S.unlocked) return; clearTimeout(_lockTimer); _lockTimer = setTimeout(lock, 30 * 60 * 1000); }
  function lock() {
    try { Wallet.lock(); } catch (_) {}
    try { if (window.Wiring) Wiring.reset(); } catch (_) {}
    S.unlocked = false; S.agent = null; S.botRunner = null; S.agentConn = null;
    clearTimeout(_lockTimer); clearInterval(_autoImportTimer); clearInterval(_botsTimer); clearInterval(_tierTimer);
    navClose();
    showGate();
  }

  /* ---------------- chains + account selector ---------------- */
  function refreshChains() {
    if (!window.Wiring) return Promise.resolve();
    return Wiring.accountChains().then(function (chains) {
      S.chains = (chains && chains.length) ? chains : ['block'];
      if (S.chains.indexOf(S.chain) < 0) S.chain = S.chains[0] || 'block';
      return Wiring.listAccounts();
    }).then(function (list) {
      S.accounts = list || [];
      S.account = S.accounts.filter(function (a) { return a.active; })[0] || { id: 'main', label: 'Main' };
      return chainAddress(S.chain);
    }).then(function (a) { S.address = a; updateAcctLabel(); }).catch(function () { updateAcctLabel(); });
  }
  function updateAcctLabel() {
    var acct = (S.account && S.account.id !== 'main') ? esc(S.account.label) + ' · ' : '';
    $('#acctsel-label').innerHTML = acct + esc((S.chain || 'block').toUpperCase()) + ' · ' + esc(shortAddr(S.address));
  }
  // One-line description of an imported account for the switcher.
  var FAM_SHORT = { evm: 'EVM', bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE', bitcoincash: 'BCH', solana: 'SOL', tron: 'TRX', ton: 'TON', block: 'BLOCK', all: 'all chains' };
  function acctSub(a) {
    if (a.id === 'main') return 'BLOCK identity + every chain (HD)';
    var how = { key: 'Private key', mnemonic: 'Seed phrase', keystore: 'Keystore', walletdat: 'wallet.dat', watch: 'Watch-only' }[a.source] || 'Imported';
    var chains = (a.chains && a.chains.length) ? a.chains.map(function (c) { return FAM_SHORT[c] || c.toUpperCase(); }).join(', ') : (FAM_SHORT[a.family] || '');
    var addr = a.addresses && (a.addresses[a.family] || a.addresses.evm || a.addresses[Object.keys(a.addresses)[0]]);
    return how + ' · ' + chains + (addr ? ' · ' + shortAddr(addr) : '');
  }
  function switchAccount(id) {
    var target = (S.accounts || []).filter(function (a) { return a.id === id; })[0];
    return Wiring.switchAccount(id).then(function () { return refreshChains(); }).then(function () {
      closeSheet(); onRoute();
      try { if (typeof loadPortfolio === 'function') loadPortfolio(true); } catch (_) {}
      runAutoImport('switch');
      toast('Switched to ' + (target ? target.label : 'account'), 'good');
    }).catch(function (e) { toast('Switch failed: ' + (e.message || e), 'bad'); });
  }
  function chainAddress(chain) {
    return Wiring.accounts().then(function (acc) { return acc.accountFor(chain); }).then(function (a) { return a.address; }).catch(function () { return S.address; });
  }
  function openAccountSheet() {
    // DOM ids use the array INDEX, never the chain id (a custom-network id could carry
    // attribute-breaking metacharacters); the chain id is esc()'d everywhere it is shown.
    var rows = S.chains.map(function (c, i) {
      return '<button class="li" data-i="' + i + '" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);cursor:pointer">' +
        '<span class="ico">' + esc(c.slice(0, 1).toUpperCase()) + '</span><span class="col" style="align-items:flex-start"><b>' + esc(c.toUpperCase()) + '</b>' +
        '<span class="dim mono" id="ca-' + i + '">…</span></span>' + (c === S.chain ? '<span class="chip good" style="margin-left:auto">active</span>' : '') + '</button>';
    }).join('');
    var accts = (S.accounts || [{ id: 'main', label: 'Main', active: true }]).map(function (a, i) {
      return '<button class="li" data-acct="' + i + '" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);cursor:pointer">' +
        '<span class="ico">' + (a.id === 'main' ? ic('wallet', 16) : a.source === 'watch' ? ic('user', 16) : ic('key', 15)) + '</span><span class="col" style="align-items:flex-start"><b>' + esc(a.label) + '</b>' +
        '<span class="dim" style="font-size:12px">' + esc(acctSub(a)) + '</span></span>' + (a.active ? '<span class="chip good" style="margin-left:auto">active</span>' : '<span class="dim" style="margin-left:auto;font-size:12px">switch</span>') + '</button>';
    }).join('');
    var manage = (S.account && S.account.id !== 'main') ? '<button class="btn sm ghost" id="as-manage">Manage</button>' : '';
    openSheet('<div class="spread"><h2>Account</h2><button class="btn sm ghost" id="as-x">' + ic('close', 15) + '</button></div>' +
      '<div class="list" style="margin-top:8px">' + accts + '</div>' +
      '<div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap"><button class="btn sm" id="as-import">' + ic('plus', 15) + ' Import a wallet (key · seed · wallet.dat)</button><button class="btn sm ghost" id="as-export">' + ic('key', 14) + ' Export a private key</button>' + manage + '</div>' +
      '<h3 style="margin:16px 0 4px">Network</h3><div class="list">' + rows + '</div>');
    $('#as-x').addEventListener('click', closeSheet);
    $('#as-import').addEventListener('click', function () { importAccountSheet(); });
    $('#as-export').addEventListener('click', function () { exportKeySheet(); });
    if ($('#as-manage')) $('#as-manage').addEventListener('click', function () { manageAccountSheet(S.account); });
    $$('#sheet [data-acct]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = (S.accounts || [])[Number(b.getAttribute('data-acct'))];
        if (!a || a.active) return;
        b.disabled = true; switchAccount(a.id);
      });
    });
    S.chains.forEach(function (c, i) { chainAddress(c).then(function (a) { var e = $('#ca-' + i); if (e) e.textContent = shortAddr(a); }); });
    $$('#sheet .li[data-i]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.chain = S.chains[Number(b.getAttribute('data-i'))] || S.chain;
        chainAddress(S.chain).then(function (a) { S.address = a; updateAcctLabel(); closeSheet(); onRoute(); runAutoImport('switch', { chains: [S.chain] }); });
      });
    });
  }

  /* ---------------- chain-specific wallet import ---------------- */
  // Import a private key / seed phrase / keystore / wallet.dat / watch address
  // for ONE chain (or a seed phrase for every chain) as a NEW account inside
  // this wallet. The existing accounts stay untouched; the BLOCK identity is
  // shared. Everything is parsed and sealed on this device.
  var IMPORT_CHAINS = [
    { id: 'all', name: 'All chains', sub: 'Seed phrase → every network', icon: 'wallet' },
    { id: 'evm', name: 'Ethereum & EVM', sub: 'ETH, Base, Arbitrum, Polygon, BNB…', icon: 'swap' },
    { id: 'bitcoin', name: 'Bitcoin', sub: 'WIF key · seed · wallet.dat', icon: 'assets' },
    { id: 'litecoin', name: 'Litecoin', sub: 'WIF key · seed · wallet.dat', icon: 'assets' },
    { id: 'dogecoin', name: 'Dogecoin', sub: 'WIF key · seed · wallet.dat', icon: 'assets' },
    { id: 'bitcoincash', name: 'Bitcoin Cash', sub: 'WIF key · seed · CashAddr', icon: 'assets' },
    { id: 'solana', name: 'Solana', sub: 'Phantom / solana-keygen key · seed', icon: 'moon' },
    { id: 'tron', name: 'Tron', sub: 'TronLink key · seed · T-address', icon: 'assets' },
    { id: 'ton', name: 'TON', sub: 'Seed phrase · v4R2 address', icon: 'assets' },
    { id: 'block', name: 'BLOCK', sub: 'Blockle wallet file · desktop wallet.json', icon: 'shield' },
  ];
  var IMPORT_METHODS = {
    key: { name: 'Private key', sub: 'Hex, WIF or base58 / JSON keypair' },
    mnemonic: { name: 'Seed phrase', sub: '12–24 words (BIP39), optional passphrase' },
    keystore: { name: 'Keystore JSON', sub: 'Ethereum UTC / JSON v3 file + its password' },
    walletdat: { name: 'wallet.dat', sub: 'Bitcoin / Litecoin / Dogecoin Core file' },
    watch: { name: 'Watch-only address', sub: 'Track balances, no key' },
    file: { name: 'Blockle wallet file', sub: 'Encrypted export or desktop wallet.json' },
  };
  var FAM_CHAIN = { evm: 'ethereum', bitcoin: 'bitcoin', litecoin: 'litecoin', dogecoin: 'dogecoin', bitcoincash: 'bitcoincash', solana: 'solana', tron: 'tron', ton: 'ton' };
  var FAM_UNITS = { evm: [18, 'ETH'], bitcoin: [8, 'BTC'], litecoin: [8, 'LTC'], dogecoin: [8, 'DOGE'], bitcoincash: [8, 'BCH'], solana: [9, 'SOL'], tron: [6, 'TRX'], ton: [9, 'TON'] };
  function fmtBase(bal, fam) {
    var u = FAM_UNITS[fam] || [0, '']; try {
      var s = BigInt(bal || 0).toString().padStart(u[0] + 1, '0'); var i = s.slice(0, s.length - u[0]), f = s.slice(s.length - u[0]).replace(/0+$/, '');
      return (f ? i + '.' + f.slice(0, 6) : i) + ' ' + u[1];
    } catch (_) { return String(bal); }
  }
  function readFile(file, as) {
    return new Promise(function (res, rej) {
      var rd = new FileReader(); rd.onerror = function () { rej(new Error('could not read the file')); };
      rd.onload = function () { res(as === 'bytes' ? new Uint8Array(rd.result) : rd.result); };
      as === 'bytes' ? rd.readAsArrayBuffer(file) : rd.readAsText(file);
    });
  }
  function importAccountSheet(opts) {
    opts = opts || {};
    var st = { family: opts.family || null, method: opts.method || null, pw: opts.password || '', label: '' };
    if (!window.KeyImport) { toast('Import module not loaded — force update in Settings', 'bad'); return; }
    var head = function (title, backStep) {
      return '<div class="spread"><h2>' + esc(title) + '</h2><span class="row" style="gap:6px">' + (backStep ? '<button class="btn sm ghost" id="im-back">Back</button>' : '') + '<button class="btn sm ghost" id="im-x">' + ic('close', 15) + '</button></span></div>';
    };
    var wire = function (backFn) { $('#im-x').onclick = closeSheet; if ($('#im-back')) $('#im-back').onclick = backFn; };

    function stepChain() {
      openSheet(head('Import a wallet') +
        '<p class="muted" style="margin:6px 0 10px">Pick the chain the key is for. It becomes a <b>new account</b> next to your existing ones — nothing is replaced.</p>' +
        '<div class="list">' + IMPORT_CHAINS.map(function (c, i) {
          return '<button class="li" data-ch="' + i + '" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);cursor:pointer"><span class="ico">' + ic(c.icon, 16) + '</span><span class="col" style="align-items:flex-start"><b>' + esc(c.name) + '</b><span class="dim" style="font-size:12px">' + esc(c.sub) + '</span></span><span class="dim" style="margin-left:auto">' + ic('chevron', 14) + '</span></button>';
        }).join('') + '</div>');
      wire();
      $$('#sheet [data-ch]').forEach(function (b) { b.onclick = function () { st.family = IMPORT_CHAINS[Number(b.getAttribute('data-ch'))].id; stepMethod(); }; });
    }
    function stepMethod() {
      var methods = KeyImport.METHODS[st.family] || ['key'];
      if (methods.length === 1) { st.method = methods[0]; return stepInput(); }
      var cname = (IMPORT_CHAINS.filter(function (c) { return c.id === st.family; })[0] || {}).name;
      openSheet(head(cname + ' · how?', true) + '<div class="list">' + methods.map(function (m) {
        var d = IMPORT_METHODS[m];
        return '<button class="li" data-m="' + m + '" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);cursor:pointer"><span class="ico">' + ic(m === 'watch' ? 'user' : m === 'walletdat' || m === 'keystore' || m === 'file' ? 'doc' : 'key', 15) + '</span><span class="col" style="align-items:flex-start"><b>' + esc(d.name) + '</b><span class="dim" style="font-size:12px">' + esc(d.sub) + '</span></span></button>';
      }).join('') + '</div>');
      wire(stepChain);
      $$('#sheet [data-m]').forEach(function (b) { b.onclick = function () { st.method = b.getAttribute('data-m'); stepInput(); }; });
    }
    function stepInput() {
      var m = st.method, fam = st.family;
      var fields = '';
      var ph = { evm: '0x… 64 hex characters', bitcoin: 'WIF (5…, K… or L…) or 64-hex', litecoin: 'WIF (6… or T…) or 64-hex', dogecoin: 'WIF (6… or Q…) or 64-hex', bitcoincash: 'WIF (5…, K… or L…) or 64-hex', solana: 'base58 secret key, [1,2,3…] JSON array, or hex', tron: '0x… 64 hex characters (TronLink export)', ton: '64-hex ed25519 seed' }[fam] || 'private key';
      if (m === 'key') fields += '<div class="field"><label>Private key</label><textarea id="im-text" rows="3" placeholder="' + esc(ph) + '" autocomplete="off" spellcheck="false"></textarea></div>';
      if (m === 'mnemonic') fields += '<div class="field"><label>Recovery phrase</label><textarea id="im-text" rows="3" placeholder="12 or 24 words separated by spaces" autocomplete="off" spellcheck="false"></textarea></div>' +
        '<div class="field"><label>Passphrase (optional, BIP39 "25th word")</label><input id="im-pass" type="password" autocomplete="off" placeholder="Leave empty unless you set one"></div>' +
        '<p class="dim" style="font-size:12px;margin:-4px 0 8px">Standard paths: EVM m/44\'/60\'/0\'/0/0 · BTC m/84\'/0\' (bc1…) · LTC m/84\'/2\' · DOGE m/44\'/3\' · SOL m/44\'/501\'/0\'/0\'. Same addresses as MetaMask, Sparrow/Electrum (bech32), Ledger Live and Phantom.</p>';
      if (m === 'keystore') fields += '<div class="field"><label>Keystore file (UTC--… .json)</label><input id="im-file" type="file" accept=".json,application/json"></div><div class="field"><label>Keystore password</label><input id="im-fpw" type="password" autocomplete="off"></div><p class="dim" style="font-size:12px;margin:-4px 0 8px">Decrypting a geth-strength keystore can take up to a minute in the browser.</p>';
      if (m === 'walletdat') fields += '<div class="field"><label>wallet.dat</label><input id="im-file" type="file"></div><div class="field"><label>Wallet passphrase (only if the Core wallet is encrypted)</label><input id="im-fpw" type="password" autocomplete="off" placeholder="Leave empty if it was never encrypted"></div><p class="dim" style="font-size:12px;margin:-4px 0 8px">Reads legacy (key/ckey) and descriptor wallets from Bitcoin, Litecoin and Dogecoin Core. Keys are extracted here, in your browser; the file is never uploaded.</p>';
      if (m === 'watch') fields += '<div class="field"><label>Address to watch</label><input id="im-text" placeholder="' + esc({ evm: '0x…', bitcoin: 'bc1… / 1… / 3…', litecoin: 'ltc1… / L… / M…', dogecoin: 'D…', bitcoincash: 'bitcoincash:q… / 1…', solana: 'base58 address', tron: 'T…', ton: 'EQ… / UQ… / 0:hex', block: 'block1…' }[fam] || 'address') + '" autocomplete="off" spellcheck="false"></div>';
      if (m === 'file') fields += '<div class="field"><label>Wallet file (.json)</label><input id="im-file" type="file" accept=".json,application/json"></div><div class="field"><label>File password (if the file is encrypted)</label><input id="im-fpw" type="password" autocomplete="off"></div><p class="dim" style="font-size:12px;margin:-4px 0 8px">A BLOCK wallet is a separate post-quantum identity, so it is added as a <b>new wallet</b> you unlock with the password below.</p>';
      fields += '<div class="field"><label>Account name (optional)</label><input id="im-label" placeholder="e.g. Old Core wallet" maxlength="40"></div>';
      fields += '<div class="field"><label>' + (m === 'file' ? 'Password for the new wallet in this browser' : 'Your wallet password') + '</label><input id="im-pw" type="password" autocomplete="current-password" placeholder="' + (m === 'file' ? 'Encrypts the imported wallet here' : 'Needed to seal the new account into your vault') + '" value="' + esc(st.pw) + '"></div>';
      openSheet(head(IMPORT_METHODS[m].name + ' · ' + (IMPORT_CHAINS.filter(function (c) { return c.id === fam; })[0] || {}).name, true) + fields +
        '<div id="im-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
        '<button class="btn primary wide" id="im-go">Continue</button>');
      wire(stepMethod);
      var go = function () {
        var err = $('#im-err'); err.textContent = '';
        st.label = ($('#im-label').value || '').trim(); st.pw = $('#im-pw').value || '';
        var btn = $('#im-go'); btn.disabled = true; btn.textContent = 'Reading…';
        var fail = function (e) { err.textContent = (e && e.message) || String(e); btn.disabled = false; btn.textContent = 'Continue'; };
        try {
          if (m === 'file') return importBlockFile($('#im-file').files[0], $('#im-fpw').value, st.pw, st.label).catch(fail);
          if (fam === 'block' && m === 'watch') {
            // a BLOCK address is its own identity → a watch-only WALLET record
            var wspec = KeyImport.watchAccount('block', $('#im-text').value);
            if (!st.pw || st.pw.length < 8) return fail(new Error('set a password of at least 8 characters for the watch-only wallet'));
            return Wallet.importFile({ address: wspec.addresses.block }, '', st.pw, st.label || 'BLOCK · watch').then(function () {
              toast('Watch-only BLOCK wallet added', 'good'); closeSheet(); Wiring.reset(); enterApp();
            }).catch(fail);
          }
          if (!st.pw) return fail(new Error('enter your wallet password'));
          if (m === 'key') return stepPreview(KeyImport.parsePrivateKey(fam, $('#im-text').value));
          if (m === 'watch') return stepPreview(KeyImport.watchAccount(fam, $('#im-text').value));
          if (m === 'mnemonic') return stepPreview(KeyImport.fromMnemonic($('#im-text').value, $('#im-pass').value, { family: fam }));
          if (m === 'keystore') {
            var kf = $('#im-file').files[0]; if (!kf) return fail(new Error('choose the keystore file'));
            btn.textContent = 'Decrypting…';
            return readFile(kf, 'text').then(function (txt) { return KeyImport.decryptKeystore(txt, $('#im-fpw').value); }).then(stepPreview).catch(fail);
          }
          if (m === 'walletdat') {
            var wf = $('#im-file').files[0]; if (!wf) return fail(new Error('choose your wallet.dat'));
            if (wf.size > 64 * 1024 * 1024) return fail(new Error('that file is too large to be a wallet.dat'));
            btn.textContent = 'Scanning file…';
            return readFile(wf, 'bytes').then(function (bytes) {
              var parsed = KeyImport.parseWalletDat(bytes);
              if (parsed.format === 'unknown') throw new Error(parsed.warnings[0] || 'no keys found in this file');
              var guess = KeyImport.guessFamily(parsed);
              if (guess && guess !== fam) throw new Error('this looks like a ' + (KeyImport.UTXO[guess] || {}).name + ' Core wallet — go back and pick ' + (KeyImport.UTXO[guess] || {}).name);
              if (parsed.ckeys.length && !parsed.keys.length) { btn.textContent = 'Decrypting keys…'; return KeyImport.unlockWalletDat(parsed, $('#im-fpw').value); }
              return parsed;
            }).then(function (parsed) { return stepWalletDat(KeyImport.walletDatAccount(parsed, fam, {})); }).catch(fail);
          }
          fail(new Error('unsupported method'));
        } catch (e) { fail(e); }
      };
      $('#im-go').onclick = go;
      if ($('#im-text')) $('#im-text').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && m !== 'mnemonic') { e.preventDefault(); go(); } });
      setTimeout(function () { var f = $('#im-text') || $('#im-file'); if (f) f.focus(); }, 60);
    }
    // BLOCK: a Blockle wallet file / desktop wallet.json becomes a new WALLET record.
    function importBlockFile(file, filePw, newPw, label) {
      if (!file) return Promise.reject(new Error('choose the wallet file'));
      if (!newPw || newPw.length < 8) return Promise.reject(new Error('the new wallet password must be at least 8 characters'));
      return readFile(file, 'text').then(function (txt) {
        var obj; try { obj = JSON.parse(txt); } catch (_) { throw new Error('that file is not valid JSON'); }
        return Wallet.importFile(obj, filePw, newPw, label || 'Imported BLOCK');
      }).then(function (r) {
        toast('BLOCK wallet imported' + (r.mode === 'watch-only' ? ' (watch-only)' : ''), 'good');
        closeSheet(); Wiring.reset(); enterApp();
      });
    }
    // Preview: the addresses this import controls, with live balances.
    function stepPreview(spec) {
      st.spec = spec;
      var rows = spec.preview.map(function (p, i) {
        return '<div class="li"><span class="ico">' + esc((FAM_SHORT[p.chain] || p.chain).slice(0, 1)) + '</span><span class="col" style="align-items:flex-start;min-width:0"><b>' + esc(p.label) + '</b><span class="dim mono" style="font-size:12px;word-break:break-all">' + esc(p.address) + '</span></span><span class="dim" id="im-bal-' + i + '" style="margin-left:auto;white-space:nowrap;font-size:12px">…</span></div>';
      }).join('');
      var note = spec.source === 'watch' ? 'Watch-only: you can see balances and activity but not send.' :
        spec.source === 'mnemonic' ? 'Only the first address of each chain is imported. The seed is sealed in your vault; it never leaves this device.' :
        (spec.warnings && spec.warnings.length ? spec.warnings.join(' · ') : 'The key is sealed in your vault under your wallet password; it never leaves this device.');
      openSheet(head('Confirm import', true) +
        '<p class="muted" style="margin:6px 0 8px">' + esc(note) + '</p><div class="list">' + rows + '</div>' +
        (spec.source === 'walletdat' ? '<p class="dim" style="font-size:12px;margin-top:8px">' + esc(spec.funded || 0) + ' funded address' + (spec.funded === 1 ? '' : 'es') + ' · ' + esc(spec.stats.keys) + ' keys kept for later rescans.</p>' : '') +
        '<div id="im-err" class="bad" style="min-height:18px;font-size:13px;margin-top:6px"></div>' +
        '<button class="btn primary wide" id="im-go">Import as new account</button>');
      wire(stepInput);
      // live balances, best-effort
      if (spec.source !== 'walletdat') spec.preview.forEach(function (p, i) {
        var chain = FAM_CHAIN[p.chain]; if (!chain) return;
        Wiring.scanAddresses(chain, [p.address]).then(function (r) { var el = $('#im-bal-' + i); if (el) el.textContent = r[0].error ? 'balance n/a' : fmtBase(r[0].balance, p.chain); }).catch(function () {});
      });
      else spec.preview.forEach(function (p, i) { var el = $('#im-bal-' + i); if (el) el.textContent = fmtBase(p.balance, p.chain); });
      $('#im-go').onclick = function () {
        var btn = $('#im-go'), err = $('#im-err'); btn.disabled = true; btn.textContent = 'Sealing…';
        Wiring.addAccount(spec, st.pw, st.label).then(function (meta) {
          return refreshChains().then(function () {
            var want = spec.chains && spec.chains[0]; var chain = FAM_CHAIN[want] || want;
            if (chain && S.chains.indexOf(chain) >= 0) S.chain = chain;
            return chainAddress(S.chain);
          }).then(function (a) {
            S.address = a; updateAcctLabel(); closeSheet(); onRoute();
            try { if (typeof loadPortfolio === 'function') loadPortfolio(true); } catch (_) {}
            runAutoImport('import');
            toast('Imported "' + meta.label + '" as a new account', 'good');
          });
        }).catch(function (e) {
          var msg = (e && e.message) || String(e);
          if (/wrong password/i.test(msg)) msg = 'Wrong wallet password.';
          err.textContent = msg; btn.disabled = false; btn.textContent = 'Import as new account';
        });
      };
    }
    // wallet.dat: scan the candidate addresses for balances before deciding
    // which ones the account tracks.
    function stepWalletDat(acct) {
      var fam = acct.family, chain = FAM_CHAIN[fam];
      var cands = acct.candidates, batch = 300, done = 0, funded = [];
      openSheet(head('Scanning wallet.dat', true) +
        '<p class="muted" style="margin:6px 0 8px">' + esc(acct.stats.keys) + ' keys found (' + esc(acct.format) + ' wallet' + (acct.stats.descriptors ? ', ' + acct.stats.descriptors + ' descriptor' + (acct.stats.descriptors > 1 ? 's' : '') : '') + '). Checking ' + Math.min(batch, cands.length) + ' of ' + cands.length + ' addresses for funds…</p>' +
        (acct.warnings.length ? '<p class="dim" style="font-size:12px">' + esc(acct.warnings.slice(0, 3).join(' · ')) + '</p>' : '') +
        '<div id="im-prog" class="dim" style="font-size:12px">0 / ' + Math.min(batch, cands.length) + '</div><div id="im-found" class="list" style="margin-top:8px"></div>' +
        '<div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn primary" id="im-go" disabled>Continue</button><button class="btn ghost" id="im-more" disabled>Scan next ' + batch + '</button></div>');
      wire(stepInput);
      var scanned = 0;
      function scanBatch() {
        var slice = cands.slice(scanned, scanned + batch); if (!slice.length) return Promise.resolve();
        var start = scanned; scanned += slice.length;
        $('#im-go').disabled = true; $('#im-more').disabled = true;
        return Wiring.scanAddresses(chain, slice.map(function (c) { return c.address; }), { concurrency: 6, onProgress: function (n, total, r) {
          var p = $('#im-prog'); if (p) p.textContent = (start + n) + ' / ' + scanned + (r && BigInt(r.balance || 0) > 0n ? ' · found funds' : '');
          if (r && BigInt(r.balance || 0) > 0n) { funded.push(r); var f = $('#im-found'); if (f) f.insertAdjacentHTML('beforeend', '<div class="li"><span class="ico">$</span><span class="col" style="align-items:flex-start;min-width:0"><b>' + esc(fmtBase(r.balance, fam)) + '</b><span class="dim mono" style="font-size:12px;word-break:break-all">' + esc(r.address) + '</span></span></div>'); }
        } }).then(function () {
          var p = $('#im-prog'); if (p) p.textContent = scanned + ' / ' + cands.length + ' checked · ' + funded.length + ' funded';
          if ($('#im-go')) $('#im-go').disabled = false;
          if ($('#im-more')) $('#im-more').disabled = scanned >= cands.length;
        });
      }
      $('#im-more').onclick = scanBatch;
      $('#im-go').onclick = function () { stepPreview(KeyImport.finalizeWalletDat(acct, funded)); };
      scanBatch();
    }
    if (st.family && st.method) stepInput(); else if (st.family) stepMethod(); else stepChain();
  }
  // Rename / remove the active imported account.
  function manageAccountSheet(a) {
    if (!a || a.id === 'main') return;
    openSheet('<div class="spread"><h2>' + esc(a.label) + '</h2><button class="btn sm ghost" id="ma-x">' + ic('close', 15) + '</button></div>' +
      '<p class="dim" style="font-size:12px;margin:4px 0 10px">' + esc(acctSub(a)) + '</p>' +
      '<div class="field"><label>Name</label><input id="ma-label" value="' + esc(a.label) + '" maxlength="40"></div>' +
      '<button class="btn wide" id="ma-save">Save name</button>' +
      '<h3 style="margin:16px 0 6px">Remove this account</h3><p class="dim" style="font-size:12px">Removes its key from this wallet. Make sure you still have the original key, phrase or file — this cannot be undone.</p>' +
      '<div class="field"><label>Wallet password</label><input id="ma-pw" type="password" autocomplete="current-password"></div>' +
      '<div id="ma-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
      '<button class="btn wide ghost" id="ma-rm" style="color:var(--bad)">Remove account</button>');
    $('#ma-x').onclick = closeSheet;
    $('#ma-save').onclick = function () {
      Wallet.renameAccount(a.id, $('#ma-label').value).then(function () { return refreshChains(); }).then(function () { toast('Renamed', 'good'); closeSheet(); }).catch(function (e) { $('#ma-err').textContent = e.message || e; });
    };
    $('#ma-rm').onclick = function () {
      var pw = $('#ma-pw').value; if (!pw) return ($('#ma-err').textContent = 'Enter your wallet password.');
      if (!confirm('Remove "' + a.label + '" from this wallet?')) return;
      $('#ma-rm').disabled = true;
      Wiring.removeAccount(a.id, pw).then(function () { return refreshChains(); }).then(function () {
        closeSheet(); onRoute(); try { if (typeof loadPortfolio === 'function') loadPortfolio(true); } catch (_) {}
        toast('Account removed', 'good');
      }).catch(function (e) { $('#ma-err').textContent = /wrong password/i.test(e.message || '') ? 'Wrong wallet password.' : (e.message || e); $('#ma-rm').disabled = false; });
    };
  }

  /* ---------------- Pro / tier ---------------- */
  function loadTier() {
    fetch(ACCOUNTS + '/me', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (j && j.user) {
        S.user = j.user; S.csrf = j.csrf || S.csrf; var sub = j.user.sub;
        // Honor the server's effective tier (folds in an active free trial) + live-bot cap.
        S.tier = (sub && sub.entitledTier) ? sub.entitledTier : ((sub && sub.active) ? (sub.tier || 'free') : 'free');
        S.liveBotLimit = (sub && sub.liveBotLimit != null) ? sub.liveBotLimit : 1; // Free gets 1 live bot
      } else { S.user = null; S.tier = 'free'; S.liveBotLimit = 1; S.csrf = null; }
      S.pro = isPro();
      // Push the plan's live-bot cap into the running bots engine (Free 1 / Copilot 3 / Pro ∞).
      if (S.botRunner && S.botRunner.setLiveBotLimit) { try { S.botRunner.setLiveBotLimit(S.liveBotLimit); } catch (_) {} }
      var b = $('#tierbadge');
      b.className = 'chip' + (S.pro ? ' pro' : '');
      b.textContent = S.pro ? (S.tier === 'copilot_pro' ? 'Copilot Pro' : 'Copilot') : 'Free';
      b.onclick = function () { location.hash = '#pro'; };
      if (location.hash === '#pro' || location.hash === '#agent' || location.hash === '#bots') onRoute();
    }).catch(function () { /* offline / transient: keep the last known sign-in + plan */ });
  }

  /* ---------------- router ---------------- */
  function onRoute() {
    if (!S.unlocked) return;
    var id = (location.hash || '#portfolio').slice(1);
    if (!NAV.some(function (n) { return n.id === id; })) id = 'portfolio';
    $$('#sidenav .navlink').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-id') === id); });
    $$('#botnav a').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-id') === id); });
    var v = $('#view'); v.style.animation = 'none'; void v.offsetWidth; v.style.animation = '';
    var fn = VIEWS[id]; if (fn) fn(v);
    navClose();
  }

  /* ================= VIEWS ================= */
  var VIEWS = {};

  /* ---- AI Chat: ChatGPT/Claude-style, paid per message in BLOCK via an API key ---- */
  function infApi(p, opts) { return fetch('/api/inference' + p, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }).catch(function () { return { ok: r.ok, status: r.status, j: {} }; }); }); }
  function inferKey() { try { return localStorage.getItem('blk-infer-key') || ''; } catch (_) { return ''; } }
  function setInferKey(k) { try { localStorage.setItem('blk-infer-key', k); } catch (_) {} }
  async function ensureKey() {
    var k = inferKey(); if (k) return k;
    var r = await infApi('/keys/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: S.address || '' }) });
    if (r.ok && r.j.key) { setInferKey(r.j.key); return r.j.key; }
    return '';
  }
  function keyHdr(k) { return { 'authorization': 'Bearer ' + k, 'content-type': 'application/json' }; }

  var CHAT = { msgs: [] };
  VIEWS.chat = function (v) {
    v.innerHTML =
      '<div class="card"><div class="spread"><div><div class="dim">AI Chat</div><div class="muted" style="font-size:13px">Powered by Blockle Intelligence — paid per message in BLOCK.</div></div>' +
        '<div style="text-align:right"><div class="num" id="chat-bal">—</div><div class="dim" style="font-size:12px">BLOCK credit</div></div></div>' +
        '<div class="row" style="gap:8px;margin-top:8px;align-items:center">' +
          '<input id="chat-top" inputmode="decimal" placeholder="Add BLOCK (e.g. 5)" style="flex:1">' +
          '<button class="btn sm primary" id="chat-add">Add credit</button></div>' +
        '<div class="dim" id="chat-topmsg" style="font-size:12px;margin-top:6px"></div></div>' +
      '<div class="card" style="padding:0"><div id="chat-thread" style="max-height:52vh;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px"></div>' +
        '<div class="row" style="gap:8px;padding:12px;border-top:1px solid var(--line)">' +
          '<input id="chat-in" placeholder="Message Blockle Intelligence…" style="flex:1" autocomplete="off">' +
          '<button class="btn primary" id="chat-send">Send</button></div></div>' +
      '<div class="card"><div class="sechead"><h2>Your API key</h2></div>' +
        '<p class="muted" style="margin:0 0 8px">Use the same credit from code — OpenAI-compatible. Keep BLOCK in your wallet and it auto-tops-up.</p>' +
        '<div class="row" style="gap:8px"><input id="chat-key" readonly style="flex:1;font-family:monospace;font-size:12px"><button class="btn sm ghost" id="chat-key-copy">Copy</button><button class="btn sm ghost" id="chat-key-new">New</button></div>' +
        '<pre id="chat-curl" style="white-space:pre-wrap;word-break:break-all;background:var(--card2);color:var(--ink2);padding:10px;border-radius:8px;font-size:11px;margin-top:8px"></pre></div>';

    function renderThread() {
      $('#chat-thread').innerHTML = CHAT.msgs.map(function (m) {
        var mine = m.role === 'user';
        return '<div style="align-self:' + (mine ? 'flex-end' : 'flex-start') + ';max-width:84%;background:' + (mine ? 'var(--accent)' : 'var(--card2)') + ';color:' + (mine ? 'var(--accent-ink)' : 'var(--ink)') + ';border:1px solid var(--line);padding:9px 12px;border-radius:14px;font-size:14px;white-space:pre-wrap">' + esc(m.content) + '</div>';
      }).join('') || '<div class="empty">Ask anything. First message may be slower while a miner warms up.</div>';
      var t = $('#chat-thread'); t.scrollTop = t.scrollHeight;
    }
    renderThread();

    function refreshBal() {
      var k = inferKey(); if (!k) { $('#chat-bal').textContent = '0'; return; }
      infApi('/credit', { headers: keyHdr(k) }).then(function (r) { if ($('#chat-bal')) $('#chat-bal').textContent = (r.j.balanceBlock != null ? r.j.balanceBlock : 0) + ''; });
    }
    ensureKey().then(function (k) {
      if ($('#chat-key')) $('#chat-key').value = k || '(none)';
      if ($('#chat-curl')) $('#chat-curl').textContent =
        'curl https://blockle.org/api/inference/v1/chat/completions \\\n  -H "Authorization: Bearer ' + (k || '<your-key>') + '" \\\n  -H "content-type: application/json" \\\n  -d \'{"messages":[{"role":"user","content":"Hello"}]}\'';
      refreshBal();
    });

    $('#chat-key-copy').onclick = function () { copy(inferKey()); };
    $('#chat-key-new').onclick = function () {
      infApi('/keys/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: S.address || '' }) }).then(function (r) {
        if (r.ok && r.j.key) { setInferKey(r.j.key); $('#chat-key').value = r.j.key; toast('New key — fund it with Add credit', 'good'); refreshBal(); }
      });
    };

    async function topUp() {
      var amt = parseFloat($('#chat-top').value); if (!(amt > 0)) { $('#chat-topmsg').textContent = 'Enter a BLOCK amount.'; return; }
      var k = await ensureKey(); if (!k) { $('#chat-topmsg').textContent = 'Could not create an API key.'; return; }
      var cr = await infApi('/credit', { headers: keyHdr(k) }); var dep = cr.j.depositAddr;
      if (!dep) { $('#chat-topmsg').textContent = 'Top-up unavailable right now.'; return; }
      $('#chat-add').disabled = true; $('#chat-topmsg').textContent = 'Sending ' + amt + ' BLOCK…';
      try {
        var base = toBase(String(amt), 8);
        var b = await Wiring.buildSend('block', { to: dep, amount: String(base) });
        var rr = await Wiring.broadcast('block', b); var txid = (rr && (rr.txid || rr.hash)) || (b && b.txid) || '';
        if (!txid) throw new Error('no txid');
        $('#chat-topmsg').textContent = 'Confirming deposit…';
        var attempt = function (n) {
          infApi('/deposit', { method: 'POST', headers: keyHdr(k), body: JSON.stringify({ txid: txid }) }).then(function (d) {
            if (d.ok) { $('#chat-topmsg').textContent = 'Credited ' + (d.j.creditedBlock || amt) + ' BLOCK.'; refreshBal(); }
            else if (n > 0) { setTimeout(function () { attempt(n - 1); }, 8000); }
            else { $('#chat-topmsg').textContent = 'Deposit sent (' + txid.slice(0, 10) + '…); credit will appear after a confirmation.'; }
          });
        };
        attempt(24);
      } catch (e) { $('#chat-topmsg').textContent = 'Top-up failed: ' + (e && e.message || ''); }
      $('#chat-add').disabled = false;
    }
    $('#chat-add').onclick = topUp;

    async function send() {
      var inp = $('#chat-in'); var text = (inp.value || '').trim(); if (!text) return;
      var k = await ensureKey(); if (!k) { toast('Could not create an API key', 'bad'); return; }
      inp.value = ''; CHAT.msgs.push({ role: 'user', content: text }); renderThread();
      CHAT.msgs.push({ role: 'assistant', content: '…' }); renderThread();
      var r = await infApi('/chat', { method: 'POST', headers: keyHdr(k), body: JSON.stringify({ prompt: text }) });
      CHAT.msgs.pop();
      if (r.status === 402) { CHAT.msgs.push({ role: 'assistant', content: 'Out of BLOCK credit — add some above to continue.' }); renderThread(); refreshBal(); return; }
      if (!r.ok) { CHAT.msgs.push({ role: 'assistant', content: 'Error: ' + ((r.j && r.j.error) || 'inference unavailable') }); renderThread(); return; }
      CHAT.msgs.push({ role: 'assistant', content: r.j.answer || '(no answer)' }); renderThread();
      if ($('#chat-bal')) $('#chat-bal').textContent = (r.j.balanceBlock != null ? r.j.balanceBlock : $('#chat-bal').textContent) + '';
    }
    $('#chat-send').onclick = send;
    $('#chat-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  };

  /* ---- Inference: mine the tier-2 subnet + watch earnings (Blockle Intelligence) ---- */
  VIEWS.inference = function (v) {
    var addr = S.address || (window.Wallet && Wallet.address) || '';
    v.innerHTML =
      '<div class="card"><div class="sechead"><h2>Inference mining</h2><span class="chip" id="inf-net">—</span></div>' +
        '<p class="muted" style="margin:4px 0 0">Earn BLOCK + a share of real x402 revenue by serving AI inference on the Blockle Intelligence tier-2 subnet. Any hardware — CPU to 80GB GPU.</p></div>' +
      '<div class="card"><div class="dim">Your earnings (this address)</div>' +
        '<div class="spread" style="margin-top:6px"><div><div class="hero-bal num" id="inf-total">$0.00</div><div class="dim" style="font-size:12px">total earned</div></div>' +
        '<div style="text-align:right"><div class="num" id="inf-epoch" style="font-size:20px">$0.00</div><div class="dim" style="font-size:12px">this epoch · <span id="inf-reqs">0</span> jobs</div></div></div>' +
        '<div class="dim" id="inf-status" style="font-size:12px;margin-top:8px"></div></div>' +
      '<div class="card"><div class="sechead"><h2>Get paid in USDC (Base)</h2><span class="chip" id="inf-usdc-chip">—</span></div>' +
        '<p class="muted" style="margin:0 0 8px">Your miner earnings can be paid in <b>USDC on Base</b> (gasless — you never pay fees). Register this wallet\'s Base address to receive them.</p>' +
        '<div class="spread"><div><div class="num" id="inf-owed">$0.00</div><div class="dim" style="font-size:12px">owed</div></div>' +
        '<div style="text-align:right"><div class="num" id="inf-paid" style="font-size:18px">$0.00</div><div class="dim" style="font-size:12px">paid</div></div></div>' +
        '<div class="dim" id="inf-base" style="font-size:12px;margin:8px 0;word-break:break-all"></div>' +
        '<button class="btn sm primary" id="inf-usdc-reg" style="width:100%">Receive USDC to this wallet (Base)</button></div>' +
      '<div class="card"><div class="sechead"><h2>Pick your model</h2></div>' +
        '<p class="muted" style="margin:0 0 8px">One recommended model per GPU class — so everyone can participate.</p>' +
        '<div id="inf-models" class="list"><div class="empty">Loading…</div></div></div>' +
      '<div class="card"><div class="sechead"><h2>Run a miner (one command)</h2></div>' +
        '<p class="muted" style="margin:0 0 8px">Install <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>, pull your tier\'s model, then start the Blockle miner. It auto-detects your VRAM and picks the right model.</p>' +
        '<pre id="inf-cmd" style="white-space:pre-wrap;word-break:break-all;background:var(--card2);color:var(--ink2);padding:10px;border-radius:8px;font-size:12px"></pre>' +
        '<button class="btn sm ghost" id="inf-copy" style="margin-top:6px">Copy command</button></div>' +
      '<div class="card"><div class="sechead"><h2>Serve from this browser (WebGPU)</h2><span class="chip" id="wg-sup">checking…</span></div>' +
        '<p class="muted" style="margin:0 0 8px">No install needed — run a small model right here on your GPU and earn as jobs come in. Experimental; needs a WebGPU browser (Chrome/Edge) and a one-time model download.</p>' +
        '<div class="field"><label>Model (sized for the browser)</label><select id="wg-model">' +
          '<option value="Qwen2.5-0.5B-Instruct-q4f16_1-MLC">Qwen2.5 0.5B — tiny, any GPU</option>' +
          '<option value="Llama-3.2-1B-Instruct-q4f16_1-MLC" selected>Llama 3.2 1B — ~2GB</option>' +
          '<option value="Qwen2.5-1.5B-Instruct-q4f16_1-MLC">Qwen2.5 1.5B — ~3GB</option>' +
          '<option value="Qwen2.5-3B-Instruct-q4f16_1-MLC">Qwen2.5 3B — ~4GB</option>' +
        '</select></div>' +
        '<button class="btn primary" id="wg-toggle" style="width:100%" disabled>Checking WebGPU…</button>' +
        '<div class="dim" id="wg-status" style="font-size:12px;margin-top:8px"></div></div>' +
      '<div class="card"><div class="dim" style="font-size:12px">Earning also requires registering your address as a miner on-chain (locks a BLOCK bond) via the <code>blockle intel register-neuron</code> CLI (bundled in the desktop wallet) or the <code>blockle-inference</code> daemon — one-tap in-wallet registration is coming with the next node release. Activation is at block 18888. Your bond is recoverable: <code>blockle intel deregister-neuron</code> unbonds and refunds it from block 19000 (after a one-epoch cooldown).</div></div>';

    setupWebgpuServe(addr);

    $('#inf-cmd').textContent =
      'ollama pull qwen2.5:3b-instruct   # or your tier\'s model (see list above)\n' +
      'MINER_UPSTREAM=http://127.0.0.1:11434/v1 \\\n' +
      '  MINER_GATEWAY=https://blockle.org/api/inference \\\n' +
      '  MINER_ADDRESS=' + (addr || '<your-block-address>') + ' \\\n' +
      '  MINER_UID=<your-neuron-uid> MINER_PUBLIC_URL=http://<your-host>:8821 \\\n' +
      '  node blockle-inference/src/index.js --role miner';
    $('#inf-copy').onclick = function () { copy($('#inf-cmd').textContent); };

    function j(p) { return fetch(p).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); }
    j('/api/inference/health').then(function (h) {
      var el = $('#inf-net'); if (!el) return;
      el.textContent = h ? (h.mainnetOk ? 'live · mainnet' : h.network || 'live') : 'offline';
      el.className = 'chip ' + (h ? 'good' : '');
    });
    j('/api/inference/models').then(function (m) {
      var box = $('#inf-models'); if (!box) return;
      if (!m || !m.catalog) { box.innerHTML = '<div class="empty">Model list unavailable.</div>'; return; }
      box.innerHTML = m.catalog.map(function (t) {
        return '<div class="li"><span class="ico">' + esc(t.params) + '</span>' +
          '<span class="col" style="align-items:flex-start"><b>' + esc(t.model) + '</b>' +
          '<span class="dim" style="font-size:12px">' + esc(t.label) + ' · ' + esc(t.quant) + ' · ctx ' + t.ctx + '</span></span></div>';
      }).join('');
    });
    if (addr) j('/api/inference/earnings/' + encodeURIComponent(addr)).then(function (e) {
      if (!e || !$('#inf-total')) return;
      $('#inf-total').textContent = '$' + Number(e.totalUsd || 0).toFixed(2);
      $('#inf-epoch').textContent = '$' + Number(e.epochUsd || 0).toFixed(2);
      $('#inf-reqs').textContent = e.requests || 0;
    });
    if (addr) j('/api/explorer/intel/neuron/' + encodeURIComponent(addr)).then(function (n) {
      var s = $('#inf-status'); if (!s) return;
      s.textContent = (n && n.neurons && n.neurons.length) ? ('Registered: ' + n.neurons.length + ' neuron(s) on-chain.') : 'Not yet registered as a miner on this address.';
    });
    // USDC-on-Base payouts: show owed/paid + register this wallet's Base address (gasless).
    if (addr && typeof chainAddress === 'function') {
      chainAddress('base').then(function (base) {
        if ($('#inf-base')) $('#inf-base').textContent = base ? ('Base address: ' + base) : 'No Base address in this wallet.';
        var reg = $('#inf-usdc-reg'); if (!reg) return;
        reg.onclick = function () {
          if (!base) { toast('No Base address available', 'bad'); return; }
          fetch('/api/inference/payout-address', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr, payoutBase: base }) })
            .then(function (r) { return r.json(); }).then(function (d) {
              if (d && d.ok) { toast('USDC payouts set to your Base address', 'good'); var c = $('#inf-usdc-chip'); if (c) { c.textContent = 'registered'; c.className = 'chip good'; } }
              else toast((d && d.error) || 'Could not register', 'bad');
            }).catch(function () { toast('Could not register', 'bad'); });
        };
      }).catch(function () {});
      j('/api/inference/owed/' + encodeURIComponent(addr)).then(function (o) {
        if (!o || !$('#inf-owed')) return;
        $('#inf-owed').textContent = '$' + Number(o.owedUsdc || 0).toFixed(2);
        $('#inf-paid').textContent = '$' + Number(o.paidUsdc || 0).toFixed(2);
        var c = $('#inf-usdc-chip'); if (c) { var r = !!o.payoutBase; c.textContent = r ? 'registered' : 'not set'; c.className = 'chip ' + (r ? 'good' : ''); }
      });
    }
  };

  /* ---- WebGPU in-browser serving: mine inference right from the wallet tab ---- */
  var WG = { serving: false, engine: null, model: null, served: 0 };
  function wgSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function setupWebgpuServe(addr) {
    var sup = $('#wg-sup'), btn = $('#wg-toggle'), st = $('#wg-status');
    if (!sup || !btn) return;
    var hasGpu = !!(navigator.gpu);
    sup.textContent = hasGpu ? 'available' : 'not supported';
    sup.className = 'chip ' + (hasGpu ? 'good' : 'warn');
    if (!hasGpu) { btn.textContent = 'WebGPU not available in this browser'; btn.disabled = true; st.textContent = 'Open the wallet in Chrome or Edge on a machine with a GPU to serve here.'; return; }
    btn.disabled = false;
    btn.textContent = WG.serving ? 'Stop serving' : 'Start serving';
    if (WG.serving) st.textContent = 'Serving · ' + WG.served + ' jobs done';
    btn.onclick = function () {
      if (WG.serving) { WG.serving = false; btn.textContent = 'Start serving'; st.textContent = 'Stopped.'; return; }
      if (!addr) { st.textContent = 'Unlock a wallet address first.'; return; }
      startWebgpuServe(addr, $('#wg-model').value, btn, st);
    };
  }
  async function startWebgpuServe(addr, model, btn, st) {
    btn.disabled = true; st.textContent = 'Loading the WebGPU runtime…';
    var webllm;
    try { webllm = await import('/wallet/vendor/web-llm.js'); } // vendored same-origin (CSP script-src 'self')
    catch (e) { st.textContent = 'Could not load the WebGPU runtime. ' + (e && e.message || ''); btn.disabled = false; return; }
    try {
      if (!WG.engine || WG.model !== model) {
        st.textContent = 'Downloading model (one time, cached after)…';
        WG.engine = await webllm.CreateMLCEngine(model, { initProgressCallback: function (p) { if ($('#wg-status')) $('#wg-status').textContent = (p && p.text) ? p.text : 'Loading model…'; } });
        WG.model = model;
      }
    } catch (e) { st.textContent = 'Model load failed: ' + (e && e.message || ''); btn.disabled = false; return; }
    WG.serving = true; btn.disabled = false; btn.textContent = 'Stop serving';
    try { await fetch('/api/inference/jobs/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr, tier: 'webgpu' }) }); } catch (_) {}
    if ($('#wg-status')) $('#wg-status').textContent = 'Serving · waiting for jobs…';
    (async function loop() {
      while (WG.serving) {
        var job = null;
        try { var r = await fetch('/api/inference/jobs/next?address=' + encodeURIComponent(addr)); if (r.status === 200) { var jj = await r.json(); job = jj && jj.job; } }
        catch (_) { await wgSleep(2000); continue; }
        if (!job) continue; // 204 long-poll timeout → poll again
        if ($('#wg-status')) $('#wg-status').textContent = 'Running a job…';
        var answer = '';
        try {
          var out = await WG.engine.chat.completions.create({ messages: [{ role: 'user', content: String(job.prompt || '') }], temperature: job.temperature != null ? job.temperature : 0.7, max_tokens: job.max_tokens || 512 });
          answer = (out && out.choices && out.choices[0] && out.choices[0].message) ? out.choices[0].message.content : '';
        } catch (_) { answer = ''; }
        try { await fetch('/api/inference/jobs/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.jobId, address: addr, answer: answer }) }); } catch (_) {}
        WG.served++; if ($('#wg-status')) $('#wg-status').textContent = 'Serving · ' + WG.served + ' jobs done';
      }
    })();
  }

  /* ---- Trade (super-AMM: custodial shared-price BLOCK market) ---- */
  function ammApi(path, opts) {
    return fetch('/api/amm' + path, opts).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    });
  }
  // decimal string -> BigInt base units (string), no float
  function toBase(str, dec) {
    str = String(str == null ? '' : str).trim();
    if (!str || !/^\d*\.?\d*$/.test(str)) return '0';
    var parts = str.split('.'); var whole = parts[0] || '0';
    var frac = (parts[1] || '').slice(0, dec); while (frac.length < dec) frac += '0';
    try { return (BigInt(whole) * (10n ** BigInt(dec)) + BigInt(frac || '0')).toString(); } catch (_) { return '0'; }
  }
  function baseToWhole(baseStr, dec) { try { return Number(BigInt(baseStr)) / Math.pow(10, dec); } catch (_) { return Number(baseStr) / Math.pow(10, dec); } }

  VIEWS.trade = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Trade discontinued</h2></div><p class="muted">The custodial shared-price BLOCK trading pool has been shut down. You can still swap BLOCK-20 tokens non-custodially from your own wallet on the <a href="#swap">Swap</a> tab.</p></div>';
    return;
    S.amm = { side: 'buy', pairs: [], dec: {}, info: null };
    v.innerHTML =
      '<div class="card"><div class="spread"><div><div class="dim">BLOCK price</div><div class="hero-bal num" id="amm-price">—</div></div>' +
        '<span class="chip" id="amm-mode" style="align-self:flex-start">—</span></div>' +
        '<div class="dim" id="amm-sub" style="font-size:12px;margin-top:4px"></div></div>' +
      '<div class="card">' +
        '<div class="wrap" style="margin-bottom:10px"><button class="btn sm primary" id="amm-t-buy" style="flex:1">Buy BLOCK</button><button class="btn sm ghost" id="amm-t-sell" style="flex:1">Sell BLOCK</button></div>' +
        '<div class="field"><label id="amm-amt-l">You pay</label><div class="row" style="gap:8px">' +
          '<input id="amm-amt" inputmode="decimal" placeholder="0.0" style="flex:1">' +
          '<select id="amm-cur" style="min-width:96px"></select></div></div>' +
        '<div id="amm-quote" class="muted" style="font-size:13px;min-height:20px;margin:4px 0"></div>' +
        '<button class="btn primary" id="amm-go" disabled style="width:100%">Enter an amount</button>' +
        '<div class="dim" id="amm-note" style="font-size:12px;margin-top:8px"></div></div>' +
      '<div class="card"><div class="sechead"><h2>Pairs &amp; liquidity</h2></div><div id="amm-pairs" class="list"><div class="empty">Loading…</div></div></div>';

    function setSide(side) {
      S.amm.side = side;
      $('#amm-t-buy').className = 'btn sm ' + (side === 'buy' ? 'primary' : 'ghost');
      $('#amm-t-sell').className = 'btn sm ' + (side === 'sell' ? 'primary' : 'ghost');
      $('#amm-amt-l').textContent = side === 'buy' ? 'You pay' : 'You sell (BLOCK)';
      refillCurrencies(); quote();
    }
    function refillCurrencies() {
      // buy: pick the currency you pay with; sell: pick the currency you receive
      var sel = $('#amm-cur');
      sel.innerHTML = S.amm.pairs.map(function (p) { return '<option value="' + p.sym + '">' + p.sym + ' · ' + p.network + '</option>'; }).join('');
    }
    function curSym() { return $('#amm-cur').value; }
    function curDec() { return S.amm.dec[curSym()] || 8; }

    function renderInfo(info) {
      S.amm.info = info;
      S.amm.live = !!info.live;
      S.amm.pairs = info.pairs || [];
      S.amm.dec = { BLOCK: info.blockDecimals || 8 };
      S.amm.pairs.forEach(function (p) { S.amm.dec[p.sym] = p.decimals; });
      $('#amm-price').textContent = '$' + Number(info.priceUsd).toLocaleString(undefined, { maximumFractionDigits: 6 });
      $('#amm-mode').textContent = info.paper ? 'paper' : 'live';
      $('#amm-mode').className = 'chip ' + (info.paper ? 'warn' : 'good');
      $('#amm-sub').textContent = (info.paper ? 'Paper market — no real funds move yet. ' : '') + 'Fee ' + (info.feeBps / 100) + '% · seed ' + info.seed.block.toLocaleString() + ' BLOCK @ $' + info.seed.priceUsd;
      $('#amm-pairs').innerHTML = S.amm.pairs.map(function (p) {
        var liq = p.hasLiquidity;
        var maxBlk = baseToWhole(p.maxSellableBlockBase, info.blockDecimals || 8);
        return '<div class="li"><span class="ico">' + esc(p.sym.slice(0, 1)) + '</span>' +
          '<span class="col" style="align-items:flex-start"><b>' + esc(p.pair) + '</b>' +
          '<span class="dim" style="font-size:12px">' + esc(p.network) + ' · ' + (liq ? 'sellable ≤ ' + fmtAmt(maxBlk, 2) + ' BLOCK' : 'no liquidity yet — buys seed it') + '</span></span>' +
          '<span class="chip ' + (liq ? 'good' : '') + '" style="margin-left:auto">' + (liq ? 'live' : 'empty') + '</span></div>';
      }).join('') || '<div class="empty">No pairs.</div>';
      if (!$('#amm-cur').options.length) refillCurrencies();
    }

    var qTimer = null;
    function quote() {
      clearTimeout(qTimer);
      qTimer = setTimeout(doQuote, 220);
    }
    function doQuote() {
      var amtStr = $('#amm-amt').value, sym = curSym(), side = S.amm.side;
      var go = $('#amm-go'), q = $('#amm-quote'), note = $('#amm-note');
      note.textContent = '';
      var inDec = side === 'buy' ? curDec() : (S.amm.dec.BLOCK || 8);
      var amountBase = toBase(amtStr, inDec);
      if (!amtStr || amountBase === '0') { q.textContent = ''; go.disabled = true; go.textContent = 'Enter an amount'; return; }
      q.textContent = 'Quoting…'; go.disabled = true;
      ammApi('/quote?side=' + side + '&sym=' + encodeURIComponent(sym) + '&amount=' + amountBase).then(function (r) {
        if (!r.ok) { q.textContent = (r.j && r.j.error) || 'Quote failed'; return; }
        var d = r.j;
        var impact = d.priceBeforeMicroUsd > 0 ? (Number(d.priceAfterMicroUsd) - Number(d.priceBeforeMicroUsd)) / Number(d.priceBeforeMicroUsd) * 100 : 0;
        if (side === 'buy') {
          var blk = baseToWhole(d.blockOut, S.amm.dec.BLOCK || 8);
          q.innerHTML = 'Receive <b>' + fmtAmt(blk, 4) + ' BLOCK</b> · fee $' + (Number(d.feeUsd) / 1e6).toFixed(2) + ' · price impact ' + impact.toFixed(2) + '%';
          go.disabled = false; go.textContent = 'Buy BLOCK';
        } else {
          var out = baseToWhole(d.assetOut, curDec());
          if (!d.liquidity) {
            var pair = (S.amm.pairs.filter(function (p) { return p.sym === sym; })[0]) || {};
            var maxBlk = baseToWhole(pair.maxSellableBlockBase || '0', S.amm.dec.BLOCK || 8);
            q.innerHTML = '<span class="dim">Would receive ' + fmtAmt(out, 6) + ' ' + esc(sym) + ' — but the ' + esc(sym) + ' pair only has liquidity for ≤ ' + fmtAmt(maxBlk, 2) + ' BLOCK.</span>';
            go.disabled = true; go.textContent = maxBlk > 0 ? 'Reduce amount' : 'No ' + sym + ' liquidity';
          } else {
            q.innerHTML = 'Receive <b>' + fmtAmt(out, 6) + ' ' + esc(sym) + '</b> · fee $' + (Number(d.feeUsd) / 1e6).toFixed(2) + ' · price impact ' + impact.toFixed(2) + '%';
            go.disabled = false; go.textContent = 'Sell BLOCK';
          }
        }
      }).catch(function () { q.textContent = 'Quote unavailable'; });
    }

    function doTrade() {
      if (S.amm.live) return doLiveTrade();
      var side = S.amm.side, sym = curSym();
      var inDec = side === 'buy' ? curDec() : (S.amm.dec.BLOCK || 8);
      var amountBase = toBase($('#amm-amt').value, inDec);
      if (amountBase === '0') return;
      var go = $('#amm-go'); go.disabled = true; var label = go.textContent; go.textContent = 'Submitting…';
      ammApi('/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ side: side, sym: sym, amount: amountBase, to: S.address }) }).then(function (r) {
        if (!r.ok) {
          if (r.j && r.j.code === 'NO_LIQUIDITY') toast('Not enough ' + sym + ' liquidity in that pair', 'bad');
          else toast((r.j && r.j.error) || 'Trade failed', 'bad');
          go.disabled = false; go.textContent = label; return;
        }
        var d = r.j;
        if (side === 'buy') toast('Bought ' + fmtAmt(baseToWhole(d.blockOut, S.amm.dec.BLOCK || 8), 2) + ' BLOCK' + (d.paper ? ' (paper)' : ''), 'good');
        else toast('Sold BLOCK for ' + fmtAmt(baseToWhole(d.assetOut, curDec()), 4) + ' ' + sym + (d.paper ? ' (paper)' : ''), 'good');
        $('#amm-amt').value = '';
        load(); // refresh price + pairs
        $('#amm-quote').textContent = ''; go.textContent = label;
      }).catch(function () { toast('Trade unavailable', 'bad'); go.disabled = false; go.textContent = label; });
    }

    // LIVE: create a trade intent, then show a deposit sheet + poll to settlement.
    function doLiveTrade() {
      var side = S.amm.side, sym = curSym();
      var pair = (S.amm.pairs.filter(function (p) { return p.sym === sym; })[0]) || {};
      var inDec = side === 'buy' ? curDec() : (S.amm.dec.BLOCK || 8);
      var amountBase = toBase($('#amm-amt').value, inDec);
      if (amountBase === '0') return;
      var go = $('#amm-go'); go.disabled = true; var label = go.textContent; go.textContent = 'Creating order…';
      // payout address: buy -> your BLOCK address; sell -> your address on the quote chain
      Promise.resolve(side === 'buy' ? S.address : chainAddress(pair.chain || 'block')).then(function (payoutAddress) {
        return ammApi('/intent', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ side: side, sym: sym, amount: amountBase, payoutAddress: payoutAddress }) });
      }).then(function (r) {
        go.textContent = label; go.disabled = false;
        if (!r.ok) { toast((r.j && (r.j.error)) || 'Could not create order', 'bad'); return; }
        showDepositSheet(r.j, side);
      }).catch(function () { toast('Order failed', 'bad'); go.textContent = label; go.disabled = false; });
    }
    function showDepositSheet(it, side) {
      var depDec = S.amm.dec[it.depositAsset] || 8, outDec = S.amm.dec[it.payoutAsset] || 8;
      var amt = baseToWhole(it.amountInBase, depDec);
      var out = baseToWhole(it.quote.outBase, outDec), minOut = baseToWhole(it.quote.minOutBase, outDec);
      openSheet(
        '<div class="spread"><h2>Complete your ' + (side === 'buy' ? 'buy' : 'sell') + '</h2><button class="btn sm ghost" id="dp-x">' + ic('close', 15) + '</button></div>' +
        '<p class="muted" style="font-size:13px">Send exactly this amount to the pool. We detect the deposit, execute at the quoted price (min protects you from slippage), and pay you automatically.</p>' +
        '<div class="field"><label>Send exactly</label><div class="row"><b class="num" style="font-size:18px">' + fmtAmt(amt, 8) + ' ' + esc(it.depositAsset) + '</b></div></div>' +
        '<div class="field"><label>To — ' + esc(it.depositAsset) + ' pool address</label><div class="row" style="gap:6px"><input readonly id="dp-addr" value="' + esc(it.depositAddress) + '" style="flex:1;font-size:11px"><button class="btn sm" id="dp-copy">Copy</button></div></div>' +
        '<div class="muted" style="font-size:12px;margin:4px 0">You receive ≈ <b>' + fmtAmt(out, 6) + ' ' + esc(it.payoutAsset) + '</b> · minimum <b>' + fmtAmt(minOut, 6) + '</b></div>' +
        '<div class="card" id="dp-status" style="margin-top:8px"><span class="dim">Waiting for your deposit…</span></div>');
      $('#dp-x').onclick = function () { stopPoll(); closeSheet(); };
      $('#dp-copy').onclick = function () { copy(it.depositAddress); };
      pollIntent(it.id);
    }
    function stopPoll() { if (S.amm.pollTimer) { clearInterval(S.amm.pollTimer); S.amm.pollTimer = null; } }
    function pollIntent(id) {
      stopPoll();
      function tick() {
        ammApi('/intent/' + encodeURIComponent(id)).then(function (r) {
          if (!r.ok) return; var it = r.j; var el = $('#dp-status'); if (!el) { stopPoll(); return; }
          var outDec = S.amm.dec[it.payoutAsset] || 8;
          if (it.status === 'awaiting_deposit') { el.innerHTML = '<span class="dim">Waiting for your deposit…</span>'; }
          else if (it.status === 'funded') { el.innerHTML = '<span class="num">' + mi('dot', 13) + '</span> Deposit detected — executing…'; }
          else if (it.status === 'executed' || it.status === 'paid') { el.innerHTML = '<span class="num">' + mi('dot', 13) + '</span> Paying out…'; }
          else if (it.status === 'settled') {
            var got = baseToWhole(it.executedOutBase || it.quote.outBase, outDec);
            el.innerHTML = '<b class="good">' + mi('check', 14) + ' Done</b> — received ' + fmtAmt(got, 6) + ' ' + esc(it.payoutAsset) + (it.payoutTxid ? '<br><span class="dim" style="font-size:11px">tx ' + esc(String(it.payoutTxid).slice(0, 18)) + '…</span>' : '');
            stopPoll(); $('#amm-amt').value = ''; load();
          } else if (it.status === 'refund') { el.innerHTML = '<b class="bad">Refunded</b> — ' + esc(it.error || 'price moved or no liquidity') + '. Your deposit is being returned.'; stopPoll(); }
          else if (it.status === 'expired') { el.innerHTML = '<span class="dim">Order expired — no deposit received. Close and try again.</span>'; stopPoll(); }
        }).catch(function () {});
      }
      tick(); S.amm.pollTimer = setInterval(tick, 5000);
    }

    function load() {
      ammApi('/info').then(function (r) {
        if (!r.ok) { $('#amm-pairs').innerHTML = '<div class="empty">Market unavailable right now.</div>'; return; }
        renderInfo(r.j);
      }).catch(function () { $('#amm-pairs').innerHTML = '<div class="empty">Market unavailable right now.</div>'; });
    }

    $('#amm-t-buy').addEventListener('click', function () { setSide('buy'); });
    $('#amm-t-sell').addEventListener('click', function () { setSide('sell'); });
    $('#amm-amt').addEventListener('input', quote);
    $('#amm-cur').addEventListener('change', quote);
    $('#amm-go').addEventListener('click', doTrade);
    load();
  };

  VIEWS.portfolio = function (v) {
    v.innerHTML = '<div class="card"><div class="dim">Total balance</div><div class="hero-bal num" id="pf-total">—</div>' +
      '<div class="statline"><div class="stat"><div class="n num" id="pf-chains">—</div><div class="l">networks</div></div>' +
      '<div class="stat"><div class="n num" id="pf-assets">—</div><div class="l">assets held</div></div>' +
      '<div class="stat"><div class="n">' + (S.pro ? '<span class="good">On</span>' : '<span class="dim">Off</span>') + '</div><div class="l">Pro analytics</div></div></div>' +
      '<div class="wrap" style="margin-top:14px"><a class="btn primary" href="#send">' + ic('send', 16) + ' Send</a><a class="btn" href="#receive">' + ic('receive', 16) + ' Receive</a><a class="btn" href="#swap">' + ic('swap', 16) + ' Swap</a><a class="btn" href="#agent">' + ic('agent', 16) + ' Ask the agent</a></div></div>' +
      '<div class="card"><div class="sechead"><h2>Holdings</h2><div class="row" style="gap:6px"><button class="btn sm ghost" id="pf-refresh" title="Refresh">' + ic('refresh', 15) + '</button><a class="btn sm ghost" href="#assets">All assets</a></div></div>' +
      '<div class="dim mono" id="pf-addr" style="font-size:11px;margin-bottom:8px;word-break:break-all"></div>' +
      '<div id="pf-list" class="list"><div class="empty">Loading balances…</div></div><div id="pf-errs" class="dim" style="font-size:11px;margin-top:8px"></div></div>' +
      (S.pro ? '' : proNudge('Unlock allocation charts, P&L history and price alerts with Pro.'));
    $('#pf-refresh').onclick = function () { loadPortfolio(true); };
    loadPortfolio();
  };
  // PROGRESSIVE portfolio: BLOCK renders first and every other network is added
  // the moment its balances arrive — one slow public RPC or price lookup can never
  // blank the page. USD values fill in afterwards with a hard cap; networks that
  // could not be reached are listed under the holdings instead of vanishing.
  var _pfRun = 0;
  function loadPortfolio(force) {
    var run = ++_pfRun;
    var rows = {}, usd = {}, errs = [], chainsWith = {}, assetCount = 0;
    var addrEl = $('#pf-addr'); if (addrEl) addrEl.textContent = 'BLOCK address · ' + (Wallet.address || S.address || '—');
    function paint() {
      if (run !== _pfRun || !$('#pf-list')) return;
      var html = '', total = 0, n = 0;
      Object.keys(rows).forEach(function (chain) {
        rows[chain].forEach(function (r) {
          var u = usd[r.key]; if (isFinite(u) && u > 0) total += u;
          html += assetRow(r.sym, chain, r.amt, r.dec, isFinite(u) && u > 0 ? u : null, r.logo, r.cid, r.name); n++;
        });
      });
      $('#pf-total').textContent = total > 0 ? fmtUsd(total) : '—';
      $('#pf-chains').textContent = Object.keys(chainsWith).length; $('#pf-assets').textContent = n;
      $('#pf-list').innerHTML = html || '<div class="empty">' + (errs.length ? 'No balances loaded yet — see the networks below.' : 'No balances yet. Receive BLOCK or a token to get started.') + '</div>';
      wireAssetRows($('#pf-list'));
      var ee = $('#pf-errs'); if (ee) ee.textContent = errs.length ? 'Could not reach: ' + errs.join(', ') + ' — tap refresh to retry.' : '';
    }
    function priceRow(chain, r) {
      var timeout = new Promise(function (res) { setTimeout(function () { res(null); }, 8000); });
      Promise.race([Promise.resolve(Wiring.estimateUsdWhole ? Wiring.estimateUsdWhole(r.asset || r.sym, r.amt) : null).catch(function () { return null; }), timeout])
        .then(function (u) { if (run !== _pfRun) return; var v = Number(u); if (isFinite(v) && v > 0) { usd[r.key] = v; paint(); } });
    }
    function loadChain(chain) {
      var guard = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, chain === 'block' ? 20000 : 12000); });
      return Promise.race([Wiring.getHoldings(chain), guard]).then(function (bals) {
        if (run !== _pfRun) return;
        var list = [];
        (bals || []).forEach(function (b) {
          var dec = (b.asset && b.asset.decimals) || 0;
          var amt = b.display != null ? numVal(b.display) : baseToNum(b.confirmed, dec);
          if (!(amt > 0)) return;
          var sym = (b.asset && (b.asset.symbol || b.asset.sym)) || chain.toUpperCase();
          list.push({ key: chain + ':' + assetId(b.asset) + ':' + sym, sym: sym, amt: amt, dec: dec, asset: b.asset, logo: b.asset && b.asset.logoURI, cid: assetId(b.asset), name: b.asset && b.asset.name });
        });
        if (list.length) chainsWith[chain] = true;
        rows[chain] = list; assetCount += list.length;
        paint();
        list.forEach(function (r) { priceRow(chain, r); });
      }).catch(function (e) {
        if (run !== _pfRun) return;
        errs.push(chain.toUpperCase() + (e && e.message === 'timeout' ? ' (timeout)' : '')); paint();
      });
    }
    Wiring.registry().then(function (reg) {
      var chains = reg.enabled();
      // BLOCK first (it is the one users look for), then everything else in parallel.
      loadChain('block').then(function () { chains.filter(function (c) { return c !== 'block'; }).forEach(loadChain); });
    }).catch(function () { if ($('#pf-list')) $('#pf-list').innerHTML = '<div class="empty">Could not load balances right now.</div>'; });
  }
  function assetRow(sym, chain, amt, dec, usd, logo, cid, name) {
    if (!logo && String(sym).toUpperCase() === 'BLOCK') logo = BLOCKLE_MARK; // native BLOCK coin -> real logo
    var ico = logo ? '<img src="' + esc(logo) + '" alt="">' : '';
    return '<div class="li li-asset" role="button" tabindex="0" data-chain="' + esc(chain) + '" data-cid="' + esc(cid || 'native') + '" data-sym="' + esc(sym) + '">' +
      '<span class="ico">' + esc(sym.slice(0, 1)) + ico + '</span>' +
      '<span class="col" style="align-items:flex-start"><b>' + esc(sym) + '</b><span class="dim" style="font-size:12px">' + esc(name || chain.toUpperCase()) + '</span></span>' +
      '<span class="col" style="margin-left:auto;align-items:flex-end"><b class="num">' + fmtAmt(amt, Math.min(dec || 6, 6)) + '</b>' + (usd ? '<span class="dim num" style="font-size:12px">' + fmtUsd(usd) + '</span>' : '') + '</span>' +
      '<span class="dim" style="margin-left:4px;display:flex">' + ic('chevronR', 16) + '</span></div>';
  }
  // Wire clickable asset rows -> generated asset info sheet.
  function wireAssetRows(container) {
    $$('.li-asset', container || document).forEach(function (row) {
      var open = function () { openAssetInfo(row.getAttribute('data-chain'), row.getAttribute('data-cid'), row.getAttribute('data-sym')); };
      row.addEventListener('click', open);
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }
  // Generated per-asset info page (modal sheet): identity, your balance + USD, on-chain
  // details, and context actions. Fetches live data from the node/explorer.
  function openAssetInfo(chain, cid, sym) {
    var native = !cid || cid === 'native';
    openSheet('<div class="spread"><h2>' + esc(sym || (native ? chain.toUpperCase() : 'Asset')) + '</h2><button class="btn sm ghost" id="ai-x">' + ic('close', 15) + '</button></div><div id="ai-body"><div class="empty">Loading…</div></div>');
    $('#ai-x').addEventListener('click', closeSheet);
    var body = $('#ai-body');
    var curated = null;
    if (!native) { var lc = String(cid).toLowerCase(); curated = CURATED_BLOCK.filter(function (c) { return c.id.toLowerCase() === lc; })[0] || null; }

    chainAddress(chain).then(function (addr) {
      if (native) return { addr: addr, info: null };
      // BLOCK-20 (and other chains': best-effort token read via same-origin explorer proxy)
      return fetch('/api/token/' + encodeURIComponent(cid) + '?holder=' + encodeURIComponent(addr))
        .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
        .then(function (j) { return { addr: addr, info: (j && (j.result || j)) || null }; });
    }).then(function (ctx) {
      var addr = ctx.addr, info = ctx.info || {};
      var name = (curated && curated.name) || info.name || sym || '';
      var symbol = sym || info.symbol || (curated && curated.symbol) || chain.toUpperCase();
      var dec = (curated && curated.decimals != null) ? curated.decimals : (info.decimals != null ? info.decimals : (native ? 8 : 0));
      var logo = (curated && curated.logoURI) || info.logoURI || '';
      var balBase = native ? null : (info.holderBalance != null ? info.holderBalance : (info.balance != null ? info.balance : '0'));
      var bal = native ? null : baseToNum(String(balBase || '0'), dec);
      var supplyBase = info.supply != null ? info.supply : (info.totalSupply != null ? info.totalSupply : null);
      var supply = supplyBase != null ? baseToNum(String(supplyBase), dec) : null;
      var typeLabel = native ? 'Native coin' : (curated && curated.stablecoin) || info.stablecoin ? ('Stablecoin · ' + ((curated && curated.peg) || info.peg || 'USD') + '-pegged') : 'BLOCK-20 token';

      var icoLogo = logo ? '<img src="' + esc(logo) + '" alt="">' : '';
      var head = '<div class="row" style="gap:12px;margin-bottom:6px">' +
        '<span class="ico" style="width:46px;height:46px;font-size:18px">' + esc(symbol.slice(0, 1)) + icoLogo + '</span>' +
        '<div class="col" style="align-items:flex-start"><b style="font-size:18px">' + esc(name || symbol) + '</b><span class="dim">' + esc(symbol) + ' · ' + esc(typeLabel) + '</span></div></div>';

      var rows = '';
      function kv(k, v) { rows += '<div class="kv"><span class="muted">' + esc(k) + '</span><span class="mono num">' + v + '</span></div>'; }
      if (!native) kv('Your balance', esc(fmtAmt(bal, Math.min(dec || 6, 6))) + ' ' + esc(symbol));
      kv('Network', esc(chain.toUpperCase()));
      kv('Decimals', esc(String(dec)));
      if (supply != null) kv('Total supply', esc(fmtAmt(supply, 2)));
      if (!native) rows += '<div class="kv"><span class="muted">Contract</span><button class="btn sm ghost" id="ai-copy" title="Copy">' + esc(shortAddr(cid)) + ' ' + ic('copy', 13) + '</button></div>';

      // USD value (best-effort)
      var usdHtml = '';
      var usdP = Promise.resolve(null);
      if (!native && bal > 0 && Wiring.estimateUsdWhole) usdP = Promise.resolve(Wiring.estimateUsdWhole({ chain: chain, symbol: symbol, decimals: dec, address: cid, stablecoin: !!(curated && curated.stablecoin) }, bal)).catch(function () { return null; });

      // actions
      var acts = [];
      acts.push('<a class="btn primary" href="#send" id="ai-send">' + ic('send', 15) + ' Send</a>');
      acts.push('<a class="btn" href="#receive" id="ai-recv">' + ic('receive', 15) + ' Receive</a>');
      if (!native) acts.push('<button class="btn" id="ai-swap">' + ic('swap', 15) + ' Swap</button>');
      var explorerHref = native ? ('/explorer/address/' + encodeURIComponent(addr)) : ('/token/' + encodeURIComponent(cid));
      acts.push('<a class="btn ghost" href="' + explorerHref + '" target="_blank">' + ic('external', 15) + ' Explorer</a>');

      body.innerHTML = head + '<div class="list" style="margin:10px 0">' + rows + '</div><div id="ai-usd" class="dim" style="font-size:13px;min-height:16px"></div><div class="wrap" style="margin-top:12px">' + acts.join('') + '</div>';
      if ($('#ai-copy')) $('#ai-copy').addEventListener('click', function () { copy(cid); });
      if ($('#ai-swap')) $('#ai-swap').addEventListener('click', function () { S._swapPrefill = cid; closeSheet(); S.chain = chain; location.hash = '#swap'; });
      if ($('#ai-recv')) $('#ai-recv').addEventListener('click', function () { closeSheet(); S.chain = chain; });
      if ($('#ai-send')) $('#ai-send').addEventListener('click', function () {
        closeSheet(); S.chain = chain;
        // Prefill the Send view with THIS token (BLOCK-20); null => native coin.
        S._sendAsset = native ? null : { kind: 'block20', contract: cid, decimals: dec, symbol: symbol, name: name, logoURI: logo };
      });
      usdP.then(function (u) { if (isFinite(Number(u)) && Number(u) > 0) $('#ai-usd').textContent = '≈ ' + fmtUsd(u) + ' at current price'; });
    }).catch(function () { body.innerHTML = '<div class="empty">Could not load asset details.</div>'; });
  }
  function proNudge(msg) {
    return '<div class="card" style="border-color:var(--violet)"><div class="row"><span style="font-size:22px">' + ic('pro', 16) + '</span><div class="col" style="align-items:flex-start"><b>Blockle Pro</b><span class="muted" style="font-size:13px">' + esc(msg) + '</span></div><a class="btn primary" href="#pro" style="margin-left:auto">Upgrade</a></div></div>';
  }

  VIEWS.assets = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Assets · ' + esc(S.chain.toUpperCase()) + '</h2>' +
      '<div class="row"><button class="btn sm" id="a-import">' + ic('plus', 15) + ' Import token</button><button class="btn sm ghost" id="a-refresh" title="Refresh">' + ic('refresh', 16) + '</button></div></div>' +
      '<div class="tabs"><div class="tab active" data-t="tokens">Tokens</div><div class="tab" data-t="nfts">NFTs</div></div>' +
      '<div id="a-body"><div class="empty">Loading…</div></div></div>';
    $('#a-refresh').onclick = function () { runAutoImport('refresh', { chains: [S.chain] }).then(function () { VIEWS.assets(v); }); };
    $('#a-import').onclick = importTokenSheet;
    $$('#view .tab').forEach(function (t) { t.onclick = function () { $$('#view .tab').forEach(function (x) { x.classList.remove('active'); }); t.classList.add('active'); t.getAttribute('data-t') === 'nfts' ? loadNfts() : loadTokens(); }; });
    loadTokens();
  };
  // Curated BLOCK-20 tokens that are ALWAYS shown (even at zero balance), matching the
  // extension/desktop/mobile wallets. getHoldings is balance-gated, so we surface these
  // (plus any user-imported contract ids) explicitly.
  var CURATED_BLOCK = [
    { id: '32a97972001bd895203c4bb5ac4645af02d81263438968ea32e35140f130d00f', symbol: 'WORLD', name: 'World', decimals: 8, logoURI: 'https://blockle.org/world-token.svg' },
    { id: '2beadf6b409427aacca1030778671ead6b9cdc5e817f1b6743c6d931c0c7ae7a', symbol: 'USDB', name: 'Blockle USD', decimals: 6, logoURI: 'https://blockle.org/usdb-token.svg' },
  ];
  function assetId(a) { return String((a && (a.address || a.contract || a.id || a.contractId)) || '').toLowerCase(); }
  function augmentCuratedBlock(rows) {
    var present = {}; rows.forEach(function (r) { var k = assetId(r.asset); if (k) present[k] = true; });
    var want = CURATED_BLOCK.slice();
    var imported = []; try { imported = JSON.parse(localStorage.getItem('blk:tokens') || '[]'); } catch (_) {}
    imported.forEach(function (cid) { var lc = String(cid).toLowerCase(); if (!want.some(function (c) { return c.id.toLowerCase() === lc; })) want.push({ id: cid }); });
    var jobs = want.filter(function (c) { return !present[c.id.toLowerCase()]; }).map(function (c) {
      return Chain.token(c.id, Wallet.address).then(function (t) {
        var dec = c.decimals != null ? c.decimals : ((t && t.decimals) || 0);
        var bal = (t && (t.holderBalance != null ? t.holderBalance : t.balance)) || '0';
        return { asset: { symbol: c.symbol || (t && t.symbol) || 'TOKEN', name: c.name || (t && t.name) || '', decimals: dec, address: c.id, logoURI: c.logoURI || (t && t.logoURI) }, confirmed: String(bal), display: baseToNum(String(bal), dec) };
      }).catch(function () { return { asset: { symbol: c.symbol || 'TOKEN', name: c.name || '', decimals: c.decimals || 0, address: c.id, logoURI: c.logoURI }, confirmed: '0', display: 0 }; });
    });
    return Promise.all(jobs).then(function (extra) { return rows.concat(extra); });
  }
  function loadTokens() {
    var body = $('#a-body'); body.innerHTML = '<div class="empty">Loading…</div>';
    var chain = S.chain;
    Wiring.getHoldings(chain).then(function (rows) {
      rows = rows || [];
      return chain === 'block' ? augmentCuratedBlock(rows) : rows;
    }).then(function (rows) {
      var html = (rows || []).map(function (r) {
        var dec = (r.asset && r.asset.decimals) || 0;
        var amt = r.display != null ? numVal(r.display) : baseToNum(r.confirmed, dec);
        var sym = (r.asset && (r.asset.symbol || r.asset.sym)) || chain.toUpperCase();
        return assetRow(sym, chain, amt, dec, null, r.asset && r.asset.logoURI, assetId(r.asset), r.asset && r.asset.name);
      }).join('');
      body.innerHTML = html || '<div class="empty">No tokens found on this network.</div>';
      wireAssetRows(body);
      renderFlagged(body, chain);
    }).catch(function () { body.innerHTML = '<div class="empty">Could not load tokens.</div>'; });
  }
  // Tokens auto-detect found but REFUSED to import (denylist / scam flags / spam
  // heuristics). Shown collapsed with a one-tap "import anyway" override.
  function renderFlagged(body, chain) {
    if (!Wiring.flaggedTokens) return;
    Wiring.flaggedTokens(chain).then(function (list) {
      if (!list || !list.length || !body.isConnected) return;
      var box = elFrom('<details style="margin-top:12px"><summary class="dim" style="cursor:pointer;font-size:13px">' + list.length + ' hidden token' + (list.length > 1 ? 's' : '') + ' (flagged by auto-detect)</summary><div class="list" style="margin-top:8px">' +
        list.map(function (t, i) { return '<div class="li"><span class="ico">' + esc(String(t.symbol || '?').slice(0, 1)) + '</span><span class="col" style="align-items:flex-start"><b>' + esc(t.symbol || '?') + '</b><span class="dim" style="font-size:12px">' + esc(t.name || shortAddr(t.address || t.mint || '')) + ' · flagged: ' + esc(t.reason || 'suspicious') + '</span></span><button class="btn sm ghost" data-fl="' + i + '" style="margin-left:auto">Import anyway</button></div>'; }).join('') +
        '</div><p class="dim" style="font-size:11px;margin-top:6px">Flagged tokens are usually airdrop spam or scams. Importing one only lists it — it never grants anyone access to your wallet.</p></details>');
      body.appendChild(box);
      $$('[data-fl]', box).forEach(function (b) { b.onclick = function () { var t = list[Number(b.getAttribute('data-fl'))]; Wiring.importFlagged(chain, t).then(function () { toast('Imported ' + (t.symbol || 'token'), 'good'); loadTokens(); }); }; });
    }).catch(function () {});
  }
  function loadNfts() {
    var body = $('#a-body'); body.innerHTML = '<div class="empty">Loading NFTs…</div>';
    nftItems(S.chain).then(function (items) {
      if (items == null) { body.innerHTML = '<div class="empty">NFT indexing isn\'t available for ' + esc(S.chain.toUpperCase()) + ' in the web wallet (no metadata provider configured).</div>'; return; }
      if (!items.length) { body.innerHTML = '<div class="empty">No NFTs held on ' + esc(S.chain.toUpperCase()) + '.</div>'; return; }
      S.nfts = items;
      body.innerHTML = '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">' + items.map(function (n, i) {
        var img = n.image || (n.media && n.media[0]) || '';
        var label = n.name || (n.tokenId != null ? ('#' + n.tokenId) : shortAddr(n.contract));
        var sendable = (S.chain === 'solana') || (n.standard === 'erc721' || n.standard === 'erc1155');
        return '<div class="planbox" style="padding:0;overflow:hidden"><div style="aspect-ratio:1;background:var(--card2);display:grid;place-items:center">' +
          (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display=\'none\'">' : ic('image', 26)) +
          '</div><div style="padding:9px"><b style="font-size:13px">' + esc(label) + '</b><div class="dim" style="font-size:11px">' + esc(n.collection || shortAddr(n.contract || '')) + '</div>' +
          (sendable ? '<button class="btn sm" style="margin-top:7px;width:100%" data-nft="' + i + '">' + ic('send', 13) + ' Send</button>' : '') +
          '</div></div>';
      }).join('') + '</div>';
      $$('#a-body [data-nft]').forEach(function (b) { b.onclick = function () { sendNftSheet(S.nfts[+b.getAttribute('data-nft')]); }; });
    }).catch(function () { body.innerHTML = '<div class="empty">Could not load NFTs.</div>'; });
  }
  // Enumerate NFTs for a chain. BLOCK-721 + EVM (if a provider key is set) come from
  // the indexer; Solana NFTs are discovered keyless from the chain itself (SPL mints
  // with 0 decimals and supply 1), so the web wallet can list + send them with no key.
  async function nftItems(chain) {
    if (chain === 'solana') {
      try {
        var reg = await Wiring.registry();
        var acct = await Wiring.accountFor('solana');
        var toks = await reg.get('solana').discoverTokens(acct.address);
        return (toks || []).filter(function (t) { return Number(t.decimals) === 0 && String(t.balance) === '1'; })
          .map(function (t) { return { chain: 'solana', standard: 'metaplex', contract: t.mint, name: shortAddr(t.mint), collection: 'Solana NFT', image: '' }; });
      } catch (e) { return null; }
    }
    try {
      var idx = WalletNftIndexer.createIndexer({ blockApi: '/api/explorer' });
      var owner = await chainAddress(chain);
      return await idx.getNFTsForOwner(chain, owner);
    } catch (e) { return null; }
  }
  function sendNftSheet(n) {
    if (!n) return;
    var label = n.name || (n.tokenId != null ? ('#' + n.tokenId) : shortAddr(n.contract));
    openSheet('<div class="spread"><h2>Send NFT</h2><button class="btn sm ghost" id="sn-x">' + ic('close', 15) + '</button></div>' +
      '<p class="muted" style="margin:8px 0">' + esc(label) + ' · ' + esc(S.chain.toUpperCase()) + '</p>' +
      (n.standard === 'erc1155' ? '<div class="field"><label>Amount</label><input id="sn-amt" value="1" inputmode="numeric"></div>' : '') +
      '<div class="field"><label>Recipient address</label><input id="sn-to" placeholder="' + esc(S.chain.toUpperCase()) + ' address"></div>' +
      '<button class="btn primary wide" id="sn-go">' + ic('send', 15) + ' Review &amp; send</button>');
    $('#sn-x').onclick = closeSheet;
    $('#sn-go').onclick = async function () {
      var to = ($('#sn-to').value || '').trim();
      if (!to) { toast('Enter a recipient', 'bad'); return; }
      var amt = $('#sn-amt') ? ($('#sn-amt').value || '1').trim() : '1';
      var go = $('#sn-go'); go.disabled = true; go.textContent = 'Sending…';
      try {
        var ok = await confirmSheet({ title: 'Send NFT', subtitle: 'Transfer ' + label + ' on ' + S.chain.toUpperCase(),
          lines: [['NFT', label], ['To', shortAddr(to)], ['Network', S.chain.toUpperCase()]].concat(n.standard === 'erc1155' ? [['Amount', amt]] : []),
          okText: 'Sign & send' });
        if (!ok) { go.disabled = false; go.innerHTML = ic('send', 15) + ' Review & send'; return; }
        var r = await Wiring.sendNft(S.chain, { standard: n.standard, contract: n.contract, tokenId: n.tokenId, amount: amt, ownedBalance: n.balance, to: to });
        closeSheet();
        toast('NFT sent — ' + shortAddr(r.txid || ''), 'ok');
        setTimeout(loadNfts, 1500);
      } catch (e) {
        toast('Send failed: ' + String((e && e.message) || e), 'bad');
        go.disabled = false; go.innerHTML = ic('send', 15) + ' Review & send';
      }
    };
  }
  function importTokenSheet() {
    openSheet('<div class="spread"><h2>Import token</h2><button class="btn sm ghost" id="it-x">' + ic('close', 15) + '</button></div>' +
      '<p class="muted" style="margin:8px 0">Paste a BLOCK-20 contract id (or an EVM token address on this network). Held tokens are usually auto-detected.</p>' +
      '<div class="field"><label>Contract</label><input id="it-c" placeholder="contract id / address"></div>' +
      '<button class="btn primary wide" id="it-go">Import</button>');
    $('#it-x').onclick = closeSheet;
    $('#it-go').onclick = function () {
      var c = ($('#it-c').value || '').trim(); if (!c) return;
      var key = 'blk:tokens'; var cur = [];
      try { cur = JSON.parse(localStorage.getItem('blk:tokens') || '[]'); } catch (_) {}
      if (cur.indexOf(c) < 0) cur.push(c);
      try { localStorage.setItem('blk:tokens', JSON.stringify(cur)); } catch (_) {}
      try { Wiring.autoImportTokens && Wiring.autoImportTokens(); } catch (_) {}
      toast('Token import saved', 'good'); closeSheet(); loadTokens();
    };
  }

  VIEWS.receive = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Receive · ' + esc(S.chain.toUpperCase()) + '</h2></div>' +
      '<p class="muted">Share this address to receive ' + esc(S.chain.toUpperCase()) + ' and its tokens.</p>' +
      '<div class="card2" style="background:var(--card2);border-radius:12px;padding:16px;text-align:center;margin-top:10px">' +
      '<div class="mono" id="rc-addr" style="word-break:break-all;font-size:14px">…</div>' +
      '<button class="btn primary" id="rc-copy" style="margin-top:12px">Copy address</button></div></div>';
    chainAddress(S.chain).then(function (a) { S.address = a; $('#rc-addr').textContent = a; $('#rc-copy').onclick = function () { copy(a); }; updateAcctLabel(); });
  };

  var _sendAsset = null; // the asset captured for the current Send view (BLOCK-20 token, or null = native)
  VIEWS.send = function (v) {
    _sendAsset = (S._sendAsset && S._sendAsset.kind === 'block20' && S.chain === 'block') ? S._sendAsset : null;
    S._sendAsset = null; // consume the prefill
    var a = _sendAsset, isToken = !!a;
    var sym = isToken ? (a.symbol || 'TOKEN') : S.chain.toUpperCase();
    var adv = isToken
      ? '<div class="row" style="gap:10px"><div class="field" style="flex:1"><label>Gas limit</label><input id="s-gaslimit" inputmode="numeric" value="200000"></div>' +
        '<div class="field" style="flex:1"><label>Gas price</label><input id="s-gasprice" inputmode="numeric" value="10"></div></div>' +
        '<p class="dim" style="font-size:12px;margin:0">Fee = gas limit × gas price, paid in BLOCK (default ≈ 0.02 BLOCK).</p>'
      : (S.chain === 'block' ? '<div class="field"><label>Network fee (BLOCK)</label><input id="s-fee" inputmode="decimal" value="0.0001"></div>' : '');
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Send ' + esc(sym) + '</h2></div>' +
      (isToken ? '<div class="banner info" style="margin-bottom:10px"><span>' + ic('send', 16) + '</span><div>Sending the BLOCK-20 token <b>' + esc(sym) + '</b>. The gas fee is paid in BLOCK.</div></div>' : '') +
      '<div class="field"><label>Recipient</label><input id="s-to" placeholder="' + (S.chain === 'block' ? 'block1… address' : 'address or name.eth / name.sol') + '"></div>' +
      '<div class="field"><label>Amount (' + esc(sym) + ')</label><input id="s-amt" inputmode="decimal" placeholder="0.0"></div>' +
      (adv ? '<details style="margin:2px 0 8px"><summary class="dim" style="cursor:pointer;font-size:13px">Advanced · adjust gas / fee</summary><div style="margin-top:8px">' + adv + '</div></details>' : '') +
      '<div id="s-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
      '<button class="btn primary wide" id="s-go">Review &amp; send</button>' +
      '<p class="dim" style="font-size:12px;margin-top:10px">Signed on your device. Every send passes the security review before broadcast.</p></div>';
    $('#s-go').onclick = doSend;
  };
  function doSend() {
    var to = ($('#s-to').value || '').trim(), amtStr = ($('#s-amt').value || '').trim(), err = $('#s-err');
    err.textContent = '';
    var amt = Number(amtStr);
    if (!to) return (err.textContent = 'Enter a recipient.');
    if (!(amt > 0)) return (err.textContent = 'Enter an amount greater than zero.');
    var chain = S.chain, a = _sendAsset, isToken = !!a;
    var sym = isToken ? (a.symbol || 'TOKEN') : chain.toUpperCase();
    (async function () {
      try {
        // read-only security inspection (best-effort) → confirm sheet (the gate)
        var insp = null;
        try { insp = await Wiring.inspect(chain, { to: to, amount: amt, kind: 'send', asset: a || undefined }); } catch (_) {}
        var warnings = (insp && (insp.warnings || insp.alerts)) || [];
        var danger = !!(insp && (insp.level === 'danger' || insp.severity === 'danger'));
        var ok = await confirmSheet({
          title: 'Send ' + fmtAmt(amt) + ' ' + sym,
          lines: [['To', shortAddr(to)], ['Amount', fmtAmt(amt) + ' ' + sym], ['Network', chain.toUpperCase()]],
          warnings: warnings, danger: danger, okText: 'Sign & send',
        });
        if (!ok) { toast('Send cancelled'); return; }
        toast('Signing…');
        var txid;
        if (isToken) {
          var dec = Number(a.decimals || 0);
          var gasLimit = Math.max(1, Math.round(Number(($('#s-gaslimit') && $('#s-gaslimit').value) || 200000) || 200000));
          var gasPrice = Math.max(1, Math.round(Number(($('#s-gasprice') && $('#s-gasprice').value) || 10) || 10));
          var b = await Wiring.buildSend('block', { to: to, amount: toBaseUnits(amtStr, dec), asset: { kind: 'block20', contract: (a.contract || a.address), decimals: dec }, gasLimit: gasLimit, gasPrice: gasPrice });
          var r = await Wiring.broadcast('block', b); txid = (r && (r.txid || r.hash)) || (b && b.txid) || '';
        } else if (chain === 'block') {
          var u = await Chain.utxos(Wallet.address);
          if (!u || !u.utxos || !u.utxos.length) throw new Error('no spendable funds (coinbase matures after 100 blocks)');
          var feeBlk = Number(($('#s-fee') && $('#s-fee').value) || 0.0001); if (!isFinite(feeBlk) || feeBlk < 0) feeBlk = 0.0001;
          var feeBase = Math.round(feeBlk * COIN);
          var built = await Wallet.buildTransfer(u.utxos, to, toBaseUnits(amtStr, 8), feeBase);
          var res = await Chain.submit(built.raw); txid = (res && res.txid) || built.txid;
        } else {
          var bb = await Wiring.buildSend(chain, { to: to, amount: String(amt) });
          var rr = await Wiring.broadcast(chain, bb); txid = (rr && (rr.txid || rr.hash)) || '';
        }
        toast('Sent · ' + String(txid).slice(0, 14) + '…', 'good');
        $('#s-to').value = ''; $('#s-amt').value = '';
        location.hash = '#activity';
      } catch (e) { err.textContent = 'Send failed: ' + (e.message || e); }
    })();
  }

  VIEWS.swap = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Swap</h2><span class="pill">native AMM · 0.3% pool fee</span></div>' +
      '<div class="banner info" style="margin-bottom:12px"><span>' + ic('swap', 18) + '</span><div>Swap BLOCK for any BLOCK-20 token on the native constant-product AMM. Trades are signed on your device.</div></div>' +
      '<div class="field"><label>Token contract</label><input id="sw-token" placeholder="BLOCK-20 contract id"></div>' +
      '<div class="field"><label>Direction</label><select id="sw-side"><option value="buy">Buy token with BLOCK</option><option value="sell">Sell token for BLOCK</option></select></div>' +
      '<div class="field"><label>Amount in</label><input id="sw-amt" inputmode="decimal" placeholder="0.0"></div>' +
      '<div class="row" style="gap:10px"><button class="btn" id="sw-quote">Get quote</button><button class="btn primary" id="sw-go" disabled>Swap</button></div>' +
      '<div id="sw-out" class="muted" style="margin-top:12px;font-size:13px"></div></div>';
    if (S._swapPrefill) { $('#sw-token').value = S._swapPrefill; S._swapPrefill = null; }
    if (S._swapSide) { $('#sw-side').value = S._swapSide; S._swapSide = null; }
    if (S._swapAmt) { $('#sw-amt').value = S._swapAmt; S._swapAmt = null; }
    var quoted = null;
    $('#sw-quote').onclick = function () {
      var token = ($('#sw-token').value || '').trim(), side = $('#sw-side').value, amt = Number($('#sw-amt').value);
      if (!token || !(amt > 0)) { toast('Enter token + amount', 'bad'); return; }
      $('#sw-out').textContent = 'Quoting…';
      var amountIn = side === 'buy' ? Math.round(amt * COIN) : Math.round(amt * COIN); // base units (token decimals assumed 8 for BLOCK rail)
      Wiring.amm.quote(token, side, amountIn, 0.01).then(function (q) {
        quoted = { token: token, side: side, amountIn: amountIn, minOut: q.minOut };
        $('#sw-out').innerHTML = 'Est. out <b class="num">' + fmtAmt(Number(q.amountOut) / COIN) + '</b> · min received <b class="num">' + fmtAmt(Number(q.minOut) / COIN) + '</b> (1% slippage)';
        $('#sw-go').disabled = false;
      }).catch(function (e) { $('#sw-out').textContent = 'No quote: ' + (e.message || e); quoted = null; $('#sw-go').disabled = true; });
    };
    $('#sw-go').onclick = function () {
      if (!quoted) return;
      (async function () {
        var ok = await confirmSheet({ title: 'Swap on native AMM', lines: [['Token', shortAddr(quoted.token)], ['Side', quoted.side], ['Amount in', fmtAmt(quoted.amountIn / COIN)], ['Min out', fmtAmt(Number(quoted.minOut) / COIN)]], okText: 'Sign & swap' });
        if (!ok) return;
        if (!(await ensureGas())) return; // sponsor BLOCK gas for paid users with no BLOCK
        toast('Signing swap…');
        try { var r = await Wiring.amm.swap({ token: quoted.token, side: quoted.side, amountIn: quoted.amountIn, minOut: quoted.minOut }); toast('Swap sent · ' + String((r && (r.txid || r)) || '').slice(0, 12) + '…', 'good'); location.hash = '#activity'; }
        catch (e) { toast('Swap failed: ' + (e.message || e), 'bad'); }
      })();
    };
  };

  VIEWS.bridge = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Bridge · BLOCK ↔ wBLOCK</h2></div><div id="br-body"><div class="empty">Loading bridge…</div></div></div>';
    fetch('/api/bridge/info').then(function (r) { return r.json(); }).then(function (info) {
      var body = $('#br-body');
      if (!info || info.live === false) {
        body.innerHTML = '<div class="banner info"><span>' + ic('bridge', 18) + '</span><div>The BLOCK↔wBLOCK Solana bridge is configured but not yet live on mainnet. Deposits/redemptions open once the wrapped mint is set. Reserves and status are shown honestly as empty until then.</div></div>' +
          '<div class="list" style="margin-top:10px"><div class="kv"><span class="muted">Status</span><span>' + (info && info.enabled ? 'enabled (not live)' : 'offline') + '</span></div><div class="kv"><span class="muted">wBLOCK mint</span><span class="mono">' + esc((info && info.wblockMint) || '—') + '</span></div></div>';
        return;
      }
      body.innerHTML = '<div class="banner info"><span>' + ic('bridge', 18) + '</span><div>Deposit BLOCK to receive wBLOCK on Solana, or redeem wBLOCK back to BLOCK. Fee ' + ((info.feeBps || 0) / 100) + '%.</div></div>' +
        '<div class="field" style="margin-top:12px"><label>Amount (BLOCK)</label><input id="br-amt" inputmode="decimal" placeholder="0.0"></div>' +
        '<div class="field"><label>Destination (Solana address)</label><input id="br-to" placeholder="your Solana address"></div>' +
        '<button class="btn primary wide" id="br-go">Deposit → wBLOCK</button>';
      $('#br-go') && ($('#br-go').onclick = function () {
        var amt = Number($('#br-amt').value), to = ($('#br-to').value || '').trim();
        if (!(amt > 0) || !to) { toast('Enter amount + Solana address', 'bad'); return; }
        (async function () {
          var ok = await confirmSheet({ title: 'Bridge deposit', lines: [['Send', fmtAmt(amt) + ' BLOCK'], ['To bridge', shortAddr(info.bridgeAddress)], ['Receive', 'wBLOCK on Solana'], ['Destination', shortAddr(to)]], okText: 'Sign & deposit' });
          if (!ok) return;
          try {
            var amountBase = Math.round(amt * COIN);
            var u = await Chain.utxos(Wallet.address);
            var built = await Wallet.buildTransfer(u.utxos, info.bridgeAddress, amountBase, 10000);
            var res = await Chain.submit(built.raw);
            var src = (res && res.txid) || built.txid;
            await fetch('/api/bridge/transfer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'b2s', sourceTxid: src, to: to, amountBase: String(amountBase) }) });
            toast('Deposit submitted — wBLOCK arrives after confirmations', 'good');
          } catch (e) { toast('Bridge failed: ' + (e.message || e), 'bad'); }
        })();
      });
    }).catch(function () { $('#br-body').innerHTML = '<div class="empty">Bridge unavailable right now.</div>'; });
  };

  VIEWS.buy = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>USDB is paused</h2></div><p class="muted">Blockle USD (USDB) has been bookshelved until the required money transmitter licensing and FinCEN MSB registration are in place. It is not currently available to buy, mint, or redeem.</p></div>';
    return;
    fetch('/api/usdb/info').then(function (r) { return r.json(); }).then(function (info) {
      var dec = (info && info.decimals) || 6;
      // numeric-coerce: never interpolate a raw string from the API into innerHTML
      var feePct = Number(info && info.feeBps != null ? info.feeBps / 100 : ((info && info.fee) || 0)) || 0;
      $('#ub-body').innerHTML =
        '<div class="statline" style="margin-bottom:12px"><div class="stat"><div class="n num" id="ub-bal">…</div><div class="l">your USDB</div></div>' +
        '<div class="stat"><div class="n num">' + (info && info.reserveUsd != null ? fmtUsd(info.reserveUsd) : '—') + '</div><div class="l">reserve</div></div>' +
        '<div class="stat"><div class="n">' + (info && info.fullyBacked ? '<span class="good">Yes</span>' : '—') + '</div><div class="l">fully backed</div></div></div>' +
        '<div class="tabs"><div class="tab active" data-u="buy">Buy</div><div class="tab" data-u="redeem">Redeem</div></div>' +
        '<div id="ub-form"></div>' +
        '<p class="dim" style="font-size:12px;margin-top:10px">Fee ' + feePct + '%. Issuance/redemption is a gated, bank-settled flow; redeeming signs an on-chain <span class="mono">redeem()</span> on your device.' + (info && info.enabled === false ? ' <b>(Service is in dry-run — no funds move.)</b>' : '') + '</p>';
      var holder = Wallet.address;
      if (info && info.contract && holder) Chain.token(info.contract, holder).then(function (t) { var bal = Number((t && (t.holderBalance != null ? t.holderBalance : t.balance)) || 0); $('#ub-bal').textContent = fmtAmt(bal / Math.pow(10, dec), 2); }).catch(function () { $('#ub-bal').textContent = '0'; });
      else $('#ub-bal').textContent = '0';
      function usdbForm(mode) {
        $('#ub-form').innerHTML = '<div class="field"><label>Amount (USD)</label><input id="ub-amt" inputmode="decimal" placeholder="100"></div>' +
          '<div id="ub-q" class="muted" style="font-size:13px;min-height:18px;margin-bottom:8px"></div>' +
          '<button class="btn primary wide" id="ub-go">' + (mode === 'buy' ? 'Buy USDB' : 'Redeem USDB') + '</button>';
        var amtEl = $('#ub-amt');
        amtEl.oninput = function () {
          var a = Number(amtEl.value); if (!(a > 0)) { $('#ub-q').textContent = ''; return; }
          fetch('/api/usdb/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ side: mode, amountUsd: a }) }).then(function (r) { return r.json(); }).then(function (q) {
            if (mode === 'buy') $('#ub-q').textContent = 'Pay ' + fmtUsd(q.payUsd || a) + ' → receive ' + fmtAmt(q.receiveUsdb || 0, 2) + ' USDB (fee ' + fmtUsd(q.feeUsd || 0) + ')';
            else $('#ub-q').textContent = 'Redeem ' + fmtAmt(a, 2) + ' USDB → payout ' + fmtUsd(q.payoutUsd || 0) + ' (fee ' + fmtUsd(q.feeUsd || 0) + ')';
          }).catch(function () { $('#ub-q').textContent = ''; });
        };
        $('#ub-go').onclick = function () {
          var a = Number(amtEl.value); if (!(a > 0)) { toast('Enter an amount', 'bad'); return; }
          if (mode === 'buy') {
            // bank-settled buy: open the hosted, gated flow with the recipient prefilled
            window.open('/usdb?to=' + encodeURIComponent(Wallet.address) + '&amt=' + a, '_blank');
            toast('Opening the gated buy flow…');
          } else {
            (async function () {
              try {
                var r = await (await fetch('/api/usdb/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amountUsd: a }) })).json();
                if (!r || !r.ok) { toast((r && r.error) || 'Redeem unavailable', 'bad'); return; }
                var ok = await confirmSheet({ title: 'Redeem USDB', subtitle: 'Sign the on-chain redeem; your bank payout follows after the burn confirms.', lines: [['Redeem', fmtAmt(r.amountUsdb || a, 2) + ' USDB'], ['Est. payout', fmtUsd(r.estPayoutUsd || 0)], ['Contract', shortAddr(r.contract)]], okText: 'Sign redeem' });
                if (!ok) return;
                toast('Redeem flow started — see the gated service for payout status', 'good');
              } catch (e) { toast('Redeem failed: ' + (e.message || e), 'bad'); }
            })();
          }
        };
      }
      usdbForm('buy');
      $$('#view .tab').forEach(function (t) { t.onclick = function () { $$('#view .tab').forEach(function (x) { x.classList.remove('active'); }); t.classList.add('active'); usdbForm(t.getAttribute('data-u')); }; });
    }).catch(function () { $('#ub-body').innerHTML = '<div class="empty">USDB service unavailable.</div>'; });
  };

  VIEWS.activity = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Activity · ' + esc(S.chain.toUpperCase()) + '</h2><a class="btn sm ghost" href="/explorer/address/' + encodeURIComponent(S.address) + '" target="_blank">Explorer ↗</a></div>' +
      '<div id="ac-body" class="list"><div class="empty">Loading activity…</div></div></div>';
    (async function () {
      try {
        var addr = await chainAddress(S.chain); var acct = null;
        try { acct = await Chain.account(addr); } catch (_) {}
        var txs = (acct && (acct.txs || acct.transactions)) || [];
        if (!txs.length) { $('#ac-body').innerHTML = '<div class="empty">No transactions yet on this network. Sends, swaps and deploys appear here.</div>'; return; }
        $('#ac-body').innerHTML = txs.slice(0, 40).map(function (t) {
          var id = t.txid || t.hash || t.id || '';
          return '<div class="li"><span class="ico">' + ic('activity', 17) + '</span><span class="col" style="align-items:flex-start"><b class="mono">' + esc(String(id).slice(0, 18)) + '…</b><span class="dim" style="font-size:12px">' + esc(t.type || t.kind || 'tx') + (t.confirmations != null ? ' · ' + esc(String(t.confirmations)) + ' conf' : '') + '</span></span></div>';
        }).join('');
      } catch (e) { $('#ac-body').innerHTML = '<div class="empty">Could not load activity.</div>'; }
    })();
  };

  /* ---------------- AGENT ---------------- */
  VIEWS.agent = function (v) {
    var lb = localLlm();
    var quotaNote = lb && lb.enabled ? 'Local brain: ' + lb.model + ' at ' + lb.baseUrl + ' — private, free, nothing leaves your computer.' : (S.pro ? 'Pro: signed hosted session, higher budget.' : 'Free: anonymous hosted brain (rate-limited). Run a local LLM for unlimited, private use — tap Brain.');
    v.innerHTML = '<div class="card"><div class="sechead"><h2>' + ic('agent', 17) + ' Agent</h2><div class="row" style="gap:6px"><span class="pill" id="ag-conn">connecting…</span><button class="btn sm ghost" id="ag-brain" title="Choose where the agent thinks">' + mi('brain', 15) + ' Brain</button></div></div>' +
      (lb && lb.enabled ? '' : '<div style="background:var(--card2);border-radius:12px;padding:10px 12px;margin-bottom:10px;font-size:13px;line-height:1.45">' + mi('brain', 15) + ' <b>Run the agent on your own computer.</b> Install a local LLM (Ollama or LM Studio), point the wallet at it, and the agent runs private, unlimited and free — no hosted quota. <a href="#" id="ag-brain-setup">Set up local brain</a></div>') +
      '<p class="muted" style="margin-bottom:10px">Ask in plain language — "send 5 BLOCK to alice.eth", "swap 20 BLOCK for WORLD", "what\'s my net worth?". Every value-moving step is gated by the same approval sheet. Nothing executes without your tap.</p>' +
      '<div id="ag-log" class="list" style="max-height:340px;overflow:auto;margin-bottom:10px"></div>' +
      '<div class="row" style="gap:8px"><input id="ag-in" placeholder="Ask or instruct the agent…"><button class="btn primary" id="ag-go">Run</button></div>' +
      '<p class="dim" style="font-size:12px;margin-top:10px">' + esc(quotaNote) + '</p></div>' +
      (S.pro ? '' : proNudge('Pro raises the hosted-agent budget and unlocks live trading bots.'));
    var log = $('#ag-log');
    function add(role, text) { log.appendChild(elFrom('<div class="li"><span class="ico">' + (role === 'you' ? '' + ic('user', 17) + '' : role === 'err' ? '' + ic('warn', 18) + '' : '' + ic('agent', 17) + '') + '</span><div class="col" style="align-items:flex-start"><b style="font-size:12px" class="dim">' + role + '</b><span>' + esc(text) + '</span></div></div>')); log.scrollTop = log.scrollHeight; }
    $('#ag-brain').onclick = brainSheet; if ($('#ag-brain-setup')) $('#ag-brain-setup').onclick = function (e) { e.preventDefault(); brainSheet(); };
    ensureAgent().then(function () { $('#ag-conn').textContent = agentConnLabel(); }).catch(function (e) { if (e && e.brainUnconfigured) { var p = $('#ag-conn'); p.innerHTML = '<a href="#" id="ag-conn-setup">set up brain</a>'; var s = $('#ag-conn-setup'); if (s) s.onclick = function (ev) { ev.preventDefault(); brainSheet(); }; } else { $('#ag-conn').textContent = 'offline'; } });
    function run() {
      var text = ($('#ag-in').value || '').trim(); if (!text) return; $('#ag-in').value = ''; add('you', text);
      S._lastAgentText = null;
      var pending = elFrom('<div class="li" id="ag-pending"><span class="ico">' + ic('agent', 17) + '</span><div class="col" style="align-items:flex-start"><span class="dim">thinking…</span></div></div>');
      log.appendChild(pending); log.scrollTop = log.scrollHeight;
      ensureAgent().then(function (router) {
        if (!router) throw new Error('Agent unavailable.');
        return router.run(text);
      }).then(function (res) {
        // Query answers come back as the resolved value; show it if no 'text' event already did.
        if (res && res.text && res.text !== S._lastAgentText) add('agent', res.text);
      }).catch(function (e) { if (e && e.brainUnconfigured) { add('agent', e.message || 'Set up the agent brain first.'); brainSheet(); } else { add('err', e.message || String(e)); } }).then(function () { var p = $('#ag-pending'); if (p) p.remove(); });
    }
    S._agentLog = add;
    $('#ag-go').onclick = run; $('#ag-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  };

  function makePrices() {
    return function (symbols) {
      var out = {}; (symbols || []).forEach(function (s) { var up = String(s).toUpperCase(); if (up === 'USDB' || up === 'USDC' || up === 'USDT') out[s] = 1; });
      return Promise.resolve(out);
    };
  }
  // ---- LOCAL BRAIN: settings for an LLM server on the user's own machine ------
  function localLlm() { try { var j = JSON.parse(localStorage.getItem('blk.localLlm') || 'null'); return j && typeof j === 'object' ? j : null; } catch (_) { return null; } }
  function setLocalLlm(cfg) { try { if (cfg) localStorage.setItem('blk.localLlm', JSON.stringify(cfg)); else localStorage.removeItem('blk.localLlm'); } catch (_) {} }
  // Which brain the user has CONFIGURED: 'local' (an LLM on their machine), 'hosted'
  // (an explicit, labelled opt-in to Blockle's gateway), or null = not set up yet.
  // There is NO silent hosted fallback — an unconfigured brain shows the setup sheet.
  function brainMode() { var b = localLlm(); if (b && b.enabled) return 'local'; if (b && b.mode === 'hosted') return 'hosted'; return null; }
  // Read-only LIVE snapshot for the client RAG, built from EXISTING wallet state
  // only (no network call): selected chain, cached balances, open bots. It merely
  // grounds the chat prompt — it grants no tools and cannot touch the signing gate.
  function agentRagLive() {
    var live = { chain: S.chain || null };
    try {
      var bals = Array.isArray(S._ragAssets) ? S._ragAssets.slice(0, 5) : [];
      if (bals.length) live.balances = bals;
    } catch (_) {}
    try {
      if (S.botRunner && S.botRunner.store) {
        var bots = S.botRunner.store.all().slice(0, 4).map(function (b) {
          var mkt = (b.universe && b.universe.pairs && b.universe.pairs[0]) || null;
          var budget = (b.config && (b.config.budgetUsd != null ? b.config.budgetUsd : b.config.allocationUsd)) || null;
          return { strategy: b.type || b.name || 'bot', market: mkt, budget: budget };
        });
        if (bots.length) live.bots = bots;
      }
    } catch (_) {}
    return live;
  }
  function agentConnLabel() { var c = S.agentConn; if (!c) return 'offline'; return c.chain === 'local' ? 'local · ' + (c.model || 'llm') : c.chain === 'anon' ? 'hosted · anon' : 'hosted · signed'; }
  function resetAgentBrain() { S.agent = null; S.agentConn = null; if (S.botRunner) { /* the bots engine keeps its own policy/tools; the brain only serves the chat agent */ } }
  function brainSheet() {
    var P = (window.AgentProviders && AgentProviders.LOCAL_PRESETS) || {};
    var saved = localLlm();
    var cur = saved || { enabled: false, preset: 'ollama', baseUrl: (P.ollama || {}).baseUrl || 'http://localhost:11434', model: (P.ollama || {}).model || '' };
    // Local is the DEFAULT/recommended selection; the sheet only pre-selects hosted
    // when the user previously opted into it explicitly. Unconfigured -> local.
    var hostedChosen = !!(saved && !saved.enabled && saved.mode === 'hosted');
    var presetOpts = Object.keys(P).map(function (k) { return '<option value="' + k + '"' + (k === cur.preset ? ' selected' : '') + '>' + esc(P[k].label) + '</option>'; }).join('');
    openSheet('<div class="spread"><h2>' + mi('brain', 17) + ' Where the agent thinks</h2><button class="btn sm ghost" id="br-x">' + ic('close', 15) + '</button></div>' +
      '<div class="field"><label>Brain</label><select id="br-mode"><option value="local"' + (!hostedChosen ? ' selected' : '') + '>Local LLM on my computer — private, unlimited, free (recommended)</option><option value="hosted"' + (hostedChosen ? ' selected' : '') + '>Blockle hosted brain — optional, nothing to install, rate-limited</option></select></div>' +
      '<div id="br-local">' +
      '<div class="field"><label>Local server</label><select id="br-preset">' + presetOpts + '</select></div>' +
      '<div class="field"><label>Base URL</label><input id="br-url" value="' + esc(cur.baseUrl || '') + '" placeholder="http://localhost:11434"></div>' +
      '<div class="field"><label>Model</label><div class="row" style="gap:6px"><input id="br-model" value="' + esc(cur.model || '') + '" placeholder="llama3.1:8b" style="flex:1"><button class="btn sm" id="br-detect">Detect</button></div><select id="br-models" style="display:none;margin-top:6px"></select></div>' +
      '<div id="br-setup" class="dim" style="font-size:12px;line-height:1.5;margin:4px 0 10px"></div>' +
      '<div id="br-status" style="font-size:12px;margin-bottom:10px"></div>' +
      '<div class="row" style="gap:8px"><button class="btn sm" id="br-test">Test connection</button></div>' +
      '</div>' +
      '<button class="btn primary wide" id="br-save" style="margin-top:12px">Save &amp; use</button>');
    $('#br-x').onclick = closeSheet;
    function preset() { return P[$('#br-preset').value] || P.custom || {}; }
    function showSetup() {
      var p = preset();
      $('#br-setup').innerHTML = '<b>Set up ' + esc(p.label || 'a local server') + '</b>' + (p.site ? ' · <a href="' + esc(p.site) + '" target="_blank" rel="noopener">' + esc(p.site.replace(/^https?:\/\//, '')) + ' ↗</a>' : '') + '<ol style="margin:4px 0 0 18px;padding:0">' + (p.setup || []).map(function (s) { return '<li>' + esc(s).replace(/:\s{2}(.+)$/, ': <code>$1</code>') + '</li>'; }).join('') + '</ol>' +
        '<div style="margin-top:4px">Your browser talks to <code>localhost</code> directly; keys, prompts and balances never leave this machine. Larger models think better: 8B is the floor for trading chat, 14B–70B if your GPU allows.</div>';
    }
    function syncMode() { $('#br-local').style.display = $('#br-mode').value === 'local' ? '' : 'none'; }
    $('#br-mode').onchange = syncMode; syncMode();
    $('#br-preset').onchange = function () { var p = preset(); $('#br-url').value = p.baseUrl || ''; if (p.model) $('#br-model').value = p.model; showSetup(); };
    showSetup();
    function mk() { return AgentProviders.create({ provider: 'local', baseUrl: ($('#br-url').value || '').trim().replace(/\/+$/, '').replace(/\/v1$/, ''), model: ($('#br-model').value || '').trim() || 'llama3.1:8b' }); }
    function status(t, cls) { $('#br-status').innerHTML = '<span class="' + (cls || 'dim') + '">' + t + '</span>'; }
    $('#br-detect').onclick = function () {
      status('Looking for models at ' + esc($('#br-url').value) + '…');
      mk().listModels().then(function (list) {
        if (!list.length) { status('Server is up but has no models yet — pull one first (see setup).', 'bad'); return; }
        var sel = $('#br-models'); sel.innerHTML = list.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join(''); sel.style.display = '';
        if (list.indexOf($('#br-model').value) < 0) $('#br-model').value = list[0];
        sel.onchange = function () { $('#br-model').value = sel.value; };
        status('Found ' + list.length + ' model' + (list.length === 1 ? '' : 's') + '.', 'good');
      }).catch(function (e) { status('Could not reach it: ' + esc(e.message || e) + '. Is the server running, and does it allow this site (CORS)?', 'bad'); });
    };
    $('#br-test').onclick = function () {
      status('Asking ' + esc($('#br-model').value || 'the model') + ' to say hello…');
      var t0 = Date.now();
      mk().ping().then(function (txt) { status(mi('check-circle', 14) + ' It answered in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's: “' + esc(txt.slice(0, 60)) + '”', 'good'); })
        .catch(function (e) { status(mi('x', 14) + ' ' + esc(e.message || e), 'bad'); });
    };
    $('#br-save').onclick = function () {
      if ($('#br-mode').value === 'hosted') { setLocalLlm({ enabled: false, mode: 'hosted' }); resetAgentBrain(); closeSheet(); toast('Using the Blockle hosted brain (optional)'); if (location.hash === '#agent') onRoute(); return; }
      var url = ($('#br-url').value || '').trim().replace(/\/+$/, '').replace(/\/v1$/, ''), model = ($('#br-model').value || '').trim();
      if (!/^https?:\/\//.test(url)) { toast('Enter the server URL (http://localhost:11434)', 'bad'); return; }
      if (!model) { toast('Pick a model (tap Detect)', 'bad'); return; }
      setLocalLlm({ enabled: true, preset: $('#br-preset').value, baseUrl: url, model: model });
      resetAgentBrain(); closeSheet(); toast('Agent now thinks locally with ' + model, 'good', 'brain');
      if (location.hash === '#agent') onRoute();
    };
  }
  function ensureAgent() {
    if (S.agent && S.agent.router) return Promise.resolve(S.agent.router);
    if (!window.Wiring || !window.AgentCommand || !window.AgentProviders) return Promise.reject(new Error('agent modules missing'));
    return Wiring.ensureAgentDeps().then(function () {
      var ctx = Wiring.agentCtx();
      ctx.prices = ctx.prices || makePrices();
      if (typeof ctx.network !== 'function') ctx.network = function () { return 'testnet'; };
      if (typeof ctx.now !== 'function') ctx.now = function () { return Date.now(); };
      // BRAIN: the agent uses a USER-CONFIGURED provider — a LOCAL LLM on the
      // user's own machine (keyless, private, free; recommended), or the Blockle
      // hosted gateway ONLY when the user explicitly opted into it. There is NO
      // silent hosted fallback: if nothing is configured we reject with
      // `brainUnconfigured` so the caller shows the setup sheet instead.
      var mode = brainMode();
      if (!mode) {
        return Promise.reject(Object.assign(
          new Error('Choose where the agent thinks — a local LLM on your computer (recommended) or the Blockle hosted brain.'),
          { brainUnconfigured: true }));
      }
      var sessOpts = { gatewayUrl: GATEWAY, label: 'Blockle Web Wallet' };
      if (!S.pro) sessOpts.anon = true;
      var brain = localLlm();
      var providerP = mode === 'local'
        ? Promise.resolve({ chain: 'local', model: brain.model, baseUrl: brain.baseUrl })
        : AgentProviders.hostedSession(sessOpts);
      return providerP.then(function (sess) {
        S.agentConn = sess;
        var provider = sess.chain === 'local'
          ? AgentProviders.create({ provider: 'local', baseUrl: sess.baseUrl, model: sess.model })
          : AgentProviders.create({ provider: 'hosted', gatewayUrl: sess.gatewayUrl, sessionToken: sess.sessionToken, model: 'blockle-agent', refresh: function () { return AgentProviders.hostedSession(sessOpts).then(function (s2) { S.agentConn = s2; return s2.sessionToken; }); } });
        var policy = AgentPolicy.create({ caps: { sessionUsd: isPro() ? 500 : 50 }, confirm: confirmSheet, onKill: function () { killAgent('killed'); } });
        var tools = AgentTools.build(ctx);
        policy.setAllowlist(tools.names());
        var audit = (window.AgentAudit) ? AgentAudit.create({ store: Store }) : null;
        var pnl = (window.AgentPnl) ? AgentPnl.create({ store: Store }) : null;
        var router = AgentCommand.create({
          provider: provider, tools: tools, policy: policy, audit: audit, pnl: pnl,
          wallet: 'web', channel: 'web',
          engines: { netWorth: function () { return agentNetWorth(); }, botsPnl: function () { return Promise.resolve({ realizedUsd: 0 }); } },
          resolveName: function (name, chain) { try { return WalletAddressBook.resolveName(name, chain, {}); } catch (_) { return Promise.resolve(null); } },
          addressBook: (window.WalletAddressBook || null),
          // OFFLINE CLIENT RAG: bundled Blockle facts (AgentRAGCorpus global) + a
          // live wallet snapshot, grounding the chat only. Read-only, no new tools.
          rag: (window.AgentRAG || null), ragLive: agentRagLive,
          onEvent: function (ev) { agentEvent(ev); },
        });
        S.agent = { router: router, provider: provider, policy: policy, tools: tools, ctx: ctx, audit: audit, pnl: pnl };
        return router;
      });
    });
  }
  function agentNetWorth() { return Wiring.listAssets().then(function (list) { var total = 0, jobs = [], bals = []; list.forEach(function (c) { (c.balances || []).forEach(function (r) { var dec = (r.asset && r.asset.decimals) || 0; var amt = r.display != null ? numVal(r.display) : baseToNum(r.confirmed, dec); if (amt > 0) { bals.push({ symbol: (r.asset && (r.asset.symbol || r.asset.ticker)) || '?', amount: amt }); jobs.push(Promise.resolve(Wiring.estimateUsdWhole(r.asset, amt)).then(function (u) { if (isFinite(Number(u))) total += Number(u); }).catch(function () {})); } }); }); try { S._ragAssets = bals.slice(0, 8); } catch (_) {} return Promise.all(jobs).then(function () { return { usd: total }; }); }); }
  function agentEvent(ev) {
    if (!ev) return; var add = S._agentLog;
    if (ev.type === 'text' && ev.text && add) { S._lastAgentText = ev.text; add('agent', ev.text); }
    else if (ev.type === 'plan' && add) add('agent', 'Plan: ' + (ev.summary || (ev.steps && ev.steps.length + ' step(s)')));
    else if (ev.type === 'step' && add) add('agent', '→ ' + (ev.name || ev.tool || 'step') + (ev.result && ev.result.txid ? ' · ' + String(ev.result.txid).slice(0, 12) + '…' : ''));
    else if (ev.type === 'resolved' && add) add('agent', 'Resolved ' + (ev.name || '') + ' → ' + shortAddr(ev.address || ''));
    else if (ev.type === 'error' && add) add('err', ev.message || 'error');
  }
  var _killing = false;
  function killAgent(reason) {
    if (_killing) return; _killing = true;
    try { if (S.botRunner) S.botRunner.killAll && S.botRunner.killAll(reason); } catch (_) {}
    S.agent = null; S.botRunner = null; toast('Kill switch — bots stopped, keys locked', 'bad'); lock();
    setTimeout(function () { _killing = false; }, 1000);
  }

  /* ---------------- BOTS ---------------- */
  // The bots cockpit: a P&L hero, one-tap presets, a live trade ticker and per-bot
  // cards with streaks + budget bars. Every number comes from the runner's own
  // dashboard()/aggregate() — the UI never invents a price or a fill.
  var BOT_MODES = {
    safe: 'Safe — large-cap, established tokens only',
    medium: 'Medium — mid-cap, balanced',
    high: 'High — microcap, social-driven (risky)',
    sniper: 'Sniper — brand-new launches, maximum risk',
  };
  // One-tap presets. Each starts IMMEDIATELY in paper mode with a sandbox budget
  // and a max-loss rail, so the first tap already produces a live ticker.
  var BOT_PRESETS = [
    { key: 'auto', icon: 'brain', name: 'Full Auto', blurb: 'Pick a chain. It rotates between Momentum, Buzz (what the internet is piling into), Sniper, Grid, Dip-buying and Autopilot to chase the most profit, re-weighting by market regime and live results.', type: 'auto', lane: 'solana', mode: 'high', budget: 500, risk: { maxLossPct: 30, paperSlippageBps: 30 }, pollSec: 20, config: { rebalanceSec: 900 } },
    { key: 'sniper', icon: 'target', name: 'Sniper', blurb: 'Hunts brand-new launches that clear the rug gate. Max risk, max thrill.', type: 'signal', lane: 'solana', mode: 'sniper', budget: 250, risk: { maxLossPct: 35, paperSlippageBps: 60 }, pollSec: 15,
      config: { source: 'discovery', maxConcurrent: 4, minScore: 0.55, onSignal: { type: 'smarttrade', config: { amountUsd: 40, takeProfits: [{ pct: 25, sharePct: 50 }, { pct: 60, sharePct: 50 }], stopLoss: { pct: 18, trailing: true }, candle: { enabled: true, sec: 60, minProfitPct: 3 } } } } },
    { key: 'buzz', icon: 'fire', name: 'Buzz Hunter', blurb: 'Finds the coins the internet is piling into right now — search trends, trending pools, buyer traffic — and rides the spike with quick exits.', type: 'signal', lane: 'solana', mode: 'high', budget: 250, risk: { maxLossPct: 30, paperSlippageBps: 40 }, pollSec: 15,
      config: { source: 'discovery', rank: 'buzz', maxConcurrent: 3, minScore: 0.45, onSignal: { type: 'smarttrade', config: { amountUsd: 40, takeProfits: [{ pct: 8, sharePct: 50 }, { pct: 20, sharePct: 50 }], stopLoss: { pct: 10, trailing: true }, candle: { enabled: true, sec: 60, minProfitPct: 2 } } } } },
    { key: 'surfer', icon: 'wave', name: 'Momentum Surfer', blurb: 'Rides trending mid-caps with a trailing stop. Balanced risk.', type: 'signal', lane: 'solana', mode: 'high', budget: 300, risk: { maxLossPct: 25, paperSlippageBps: 30 }, pollSec: 20,
      config: { source: 'discovery', maxConcurrent: 3, minScore: 0.5, onSignal: { type: 'dca', config: { baseOrderUsd: 40, safetyOrderUsd: 40, maxSafetyOrders: 2, safetyStepPct: 4, takeProfitPct: 8, trailingTpPct: 3, stopLossPct: 15, maxDealSec: 2 * 86400, candle: { enabled: true, sec: 120, minProfitPct: 2 } } } } },
    { key: 'stacker', icon: 'block', name: 'Steady Stacker', blurb: 'Accumulates SOL on dips, banks +5%. Slow, steady, relentless.', type: 'dca', lane: 'solana', mode: 'safe', budget: 500, risk: { maxLossPct: 20, paperSlippageBps: 10 }, pollSec: 30, pair: 'SOL/USDC',
      config: { baseOrderUsd: 25, safetyOrderUsd: 25, maxSafetyOrders: 5, safetyStepPct: 2, safetyVolumeScale: 1.3, takeProfitPct: 5, trailingTpPct: 1.5, startCondition: 'dip', dipPct: 1.5, candle: { enabled: true, sec: 300, minProfitPct: 1.5 } } },
    { key: 'grid', icon: 'chart-up', name: 'Grid Scalper', blurb: 'A ±6% ladder around ETH. Buys every dip rung, sells every pop.', type: 'grid', lane: 'ethereum', mode: 'medium', budget: 400, risk: { maxLossPct: 20, paperSlippageBps: 10 }, pollSec: 20, pair: 'ETH/USDC',
      config: { autoRangePct: 6, gridCount: 10, totalUsd: 400, stopLossPct: 12 } },
    { key: 'autopilot', icon: 'bot', name: 'Autopilot', blurb: 'Scans every pair it can see, trades only cost-positive edges.', type: 'scanner', lane: 'solana', mode: 'medium', budget: 300, risk: { maxLossPct: 25 }, pollSec: 60,
      config: { minProfitBps: 30, maxConcurrentPairs: 3, perTradeUsd: 25, strategies: ['arbitrage', 'momentum', 'grid'], gasBufferUsd: 1, slippageBps: 15, agentFeeBps: 5 } },
  ];
  var _botsTimer = null;
  function botLanes() {
    try { return (window.AgentBots && AgentBots.lanes) ? AgentBots.lanes() : []; } catch (_) { return []; }
  }
  function laneLabel(id) { var l = botLanes().filter(function (x) { return x.id === id; })[0]; return l ? l.name : (id || '—'); }
  function laneBase(id) { var l = botLanes().filter(function (x) { return x.id === id; })[0]; return l ? l.base : 'USDC'; }
  function pnlClass(v) { return v > 0 ? 'good' : v < 0 ? 'bad' : 'dim'; }
  function fmtSigned(v) { var n = Number(v) || 0; return (n > 0 ? '+' : '') + fmtUsd(n); }
  function agoShort(t) { if (!t) return '—'; var s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; }
  function algoName(a) { return ({ momentum: 'Momentum', sniper: 'Sniper', grid: 'Grid', dip: 'Dip-buyer', scanner: 'Autopilot' })[a] || a; }
  function regimeText(r) { return ({ 'trend-up': 'Trending up', 'trend-down': 'Trending down', ranging: 'Ranging', quiet: 'Quiet', warming: 'Reading the market…' })[r] || (r || '—'); }
  // Icon name for a bot (preset icon, else by deal-bot type). Rendered via mi() in raw-HTML headings.
  function botIcon(b) { var p = BOT_PRESETS.filter(function (x) { return x.key === b.preset; })[0]; if (p) return p.icon; return { signal: 'target', dca: 'block', grid: 'chart-up', smarttrade: 'bolt', scanner: 'bot', momentum: 'wave', rebalance: 'scales' }[b.type] || 'bot'; }

  /* ---------------- live indicator / systematic strategies (registry planners) ----------------
     The create-UI strategy picker lists these alongside the deal-bot types, with a generic
     numeric-knob editor driven entirely by each planner's .defaults. Only planners with the
     uniform { market, ...knobs, budgetUsd, positionPct } shape qualify — that's the 9 ported
     indicator strategies (rsi/macd/bollinger/breakout/emacross/momentum_roc/meanrev/
     rebalance_hold/hodl). The pre-existing deal-bot types keep their bespoke rich UIs. */
  // The Strategy picker lists ONLY these 9 single-market indicator/systematic planners
  // (simple numeric knobs). MIRRORS the extension's plannerStrategies/isPlannerType
  // allow-list. The multi-asset `rebalance` (asset→weight map), SMA `momentum`, and the
  // deal-bots (arbitrage/dca/grid) are deliberately EXCLUDED here — they crash the knob
  // editor or create a non-functional bot; deal-bots keep their own template flow above.
  var PLANNER_STRATEGIES = ['rsi', 'macd', 'bollinger', 'breakout', 'emacross', 'momentum_roc', 'meanrev', 'rebalance_hold', 'hodl'];
  function isPlannerType(name) { return PLANNER_STRATEGIES.indexOf(name) !== -1; }
  function regStrategies() {
    try { var A = window.AgentStrategies; if (!A || !A.createRegistry) return []; return A.createRegistry().all.filter(function (s) { return isPlannerType(s.name); }); } catch (_) { return []; }
  }
  function regStrategy(name) { var l = regStrategies(); for (var i = 0; i < l.length; i++) if (l[i].name === name) return l[i]; return null; }
  function isRegType(type) { return !!regStrategy(type); }
  // budgetUsd is EXCLUDED from the knob grid: the single Paper/allocation budget field
  // (#nb-budget) is the one budget, seeded into config.budgetUsd at launch (see #nb-go).
  // Showing both let budgetUsd (1000) diverge from the allocation cap (250) so the gate
  // skipped every tick.
  function regKnobKeys(s) { var skip = { market: 1, history: 1, held: 1, balances: 1, budgetUsd: 1 }; return Object.keys((s && s.defaults) || {}).filter(function (k) { return !skip[k]; }); }
  function regDescribe(name) { var s = regStrategy(name); try { return s ? s.describe() : ''; } catch (_) { return ''; } }
  function regLabel(name) { return String(name).replace(/_/g, ' ').toUpperCase(); }
  var KNOB_LABEL = { budgetUsd: 'Budget (USD)', positionPct: 'Position size %', period: 'Period', oversold: 'Oversold ≤', overbought: 'Overbought ≥', fast: 'Fast', slow: 'Slow', signalP: 'Signal period', k: 'Band width (σ)', lookback: 'Lookback', thresholdPct: 'Threshold %', bandPct: 'Band %', targetPct: 'Target %', driftPct: 'Drift %' };
  function knobLabel(k) { return KNOB_LABEL[k] || k; }
  // UI(registry) <-> server BOT_TYPES used by the backtest + copy endpoints (bots.js).
  var REG_TO_SERVER = { momentum_roc: 'momentum', rebalance_hold: 'rebalance' };
  var SERVER_TO_REG = { momentum: 'momentum_roc', rebalance: 'rebalance_hold' };
  function serverBotType(name) { return REG_TO_SERVER[name] || name; }
  function regBotType(name) { return SERVER_TO_REG[name] || name; }
  // Planner config <-> server param shape (server uses `budget`, planners `budgetUsd`).
  function regParamsToServer(cfg) { var out = {}; Object.keys(cfg || {}).forEach(function (k) { if (k === 'market') return; out[k === 'budgetUsd' ? 'budget' : k] = cfg[k]; }); return out; }
  function serverParamsToReg(p) { var out = {}; Object.keys(p || {}).forEach(function (k) { if (k === 'market') return; out[k === 'budget' ? 'budgetUsd' : k] = p[k]; }); return out; }

  VIEWS.bots = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>' + ic('bots', 18) + ' Bots</h2><div class="row" style="gap:6px"><button class="btn sm primary" id="bt-new">+ New bot</button><button class="btn sm ghost" id="bt-kill" title="Stop everything and lock keys">Kill all</button></div></div>' +
      '<div id="bt-hero" class="statline" style="margin-bottom:10px"><div class="stat"><div class="n num" id="bt-real">—</div><div class="l">realized P&amp;L</div></div><div class="stat"><div class="n num" id="bt-unreal">—</div><div class="l">open P&amp;L</div></div><div class="stat"><div class="n num" id="bt-deals">—</div><div class="l">active deals</div></div><div class="stat"><div class="n num" id="bt-win">—</div><div class="l">win rate</div></div></div>' +
      '<div class="row" style="gap:8px;font-size:12px" id="bt-engine"><span class="dim">Engine</span><span class="dim">—</span></div>' +
      '<div class="dim" style="font-size:11px;margin-top:6px">Realized P&amp;L books when a deal closes; open P&amp;L is the live mark on what the bots hold. Smart candle exits bank winners on the first reversal.</div>' +
      '<div id="bt-keepopen" style="display:none;background:rgba(255,99,99,.12);border:1px solid var(--bad);border-radius:12px;padding:10px 12px;margin-top:10px;font-size:13px;line-height:1.45"><b>' + mi('live', 14) + ' Live bots trade only while this page is open.</b> Your keys never leave this device, so closing or backgrounding this tab pauses live trading until you come back. Keep the wallet in front, or stop the live bots first.</div>' +
      '<div id="bt-cloud" style="background:var(--card2);border-radius:12px;padding:10px 12px;margin-top:10px;font-size:13px;line-height:1.45"></div></div>' +
      '<div class="card"><div class="sechead"><h2>One-tap launch</h2><span class="dim" style="font-size:12px">starts in paper mode · play money</span></div>' +
      '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">' + BOT_PRESETS.map(function (p) {
        return '<button class="planbox" data-preset="' + esc(p.key) + '" style="text-align:left;cursor:pointer;gap:5px;padding:12px"><b style="font-size:15px">' + mi(p.icon, 16) + ' ' + esc(p.name) + '</b><span class="dim" style="font-size:12px;line-height:1.3">' + esc(p.blurb) + '</span><span class="dim" style="font-size:11px">any network · ' + esc(p.mode) + ' · $' + p.budget + ' paper</span></button>';
      }).join('') + '</div></div>' +
      '<div class="card"><div class="sechead"><h2>' + ic('activity', 16) + ' Live ticker</h2><span class="dim" style="font-size:12px" id="bt-ticker-n"></span></div><div id="bt-ticker" class="list ticker"><div class="empty">No trades yet — launch a bot and watch this fill up.</div></div></div>' +
      '<div class="card"><div class="sechead"><h2>Your bots</h2><span class="dim" style="font-size:12px" id="bt-count"></span></div><div id="bt-list" class="list"><div class="empty">Loading bots…</div></div>' +
      '<div class="banner ' + (S.pro ? 'info' : 'warn') + '" style="margin-top:12px"><span>' + ic('lock', 16) + '</span><div>' +
      (S.pro ? 'Live trading unlocked. Live bots run <b>fully auto within their budget</b> — every order still passes the session caps, allowlist, hash-chained audit, the 0.05% fee and the kill switch. Mainnet stays off until you enable it.' :
        'Free plan: <b>paper trading + 1 bot</b>. Paper bots simulate fills at live prices and never move funds. Upgrade to Pro for live trading and more bots.') + '</div></div></div>' +
      '<div class="card2" style="background:var(--card2);border-radius:12px;padding:14px;margin-top:12px"><div class="spread"><div class="col" style="align-items:flex-start"><b>' + ic('arena', 18) + ' Arena</b><span class="dim" style="font-size:12px">Backtest a strategy on play-money scenarios.</span></div><button class="btn sm" id="bt-arena">Open Arena</button></div></div>' +
      (S.pro ? '' : proNudge('Go live: Pro unlocks real trading bots (3) and Copilot Pro unlocks unlimited.'));
    $('#bt-new').onclick = function () { newBotSheet(); }; // wrap: never pass the MouseEvent as prefill
    $('#bt-arena').onclick = openArena;
    $('#bt-kill').onclick = stopAllSheet;
    $$('#view [data-preset]').forEach(function (b) { b.onclick = function () { launchPreset(b.getAttribute('data-preset')); }; });
    renderCloudCard();
    ensureBotRunner().then(function () { renderBotList(); startBotsPolling(); return refreshCloud(); }).then(function () { _botListSig = ''; renderBotList(); maybeOpenBotPrefill(); }).catch(function (e) { $('#bt-list').innerHTML = '<div class="empty">Bots engine unavailable: ' + esc(e && e.message || e) + '</div>'; maybeOpenBotPrefill(); });
  };
  // Deep-link follow-through: once the Bots view is up, open the create sheet with a
  // preselected strategy (?strategy=) or a cloned config (?copyBot=). Copy fetches the
  // cloned CONFIG from the server (POST /account/api/bots/copy) — config only, compliant.
  function maybeOpenBotPrefill() {
    if (S._botCopyId) {
      var id = S._botCopyId; S._botCopyId = null;
      var hdr = { accept: 'application/json', 'content-type': 'application/json' }; if (S.csrf) hdr['x-csrf-token'] = S.csrf;
      fetch(ACCOUNTS + '/bots/copy', { method: 'POST', headers: hdr, credentials: 'include', body: JSON.stringify({ fromBotId: id }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .then(function (j) { var b = j.bot || {}; S._botPrefill = null; toast('Copied config — review and launch', 'good'); newBotSheet({ strategy: regBotType(b.type), pair: b.pair, params: b.params }); })
        .catch(function (e) { toast('Copy failed: ' + (e.message || e), 'bad'); if (S._botPrefill) { var p = S._botPrefill; S._botPrefill = null; newBotSheet(p); } });
      return;
    }
    if (S._botPrefill) { var pf = S._botPrefill; S._botPrefill = null; newBotSheet(pf); }
  }
  // STOP ALL (default): pause every bot + cancel open live orders; keys stay
  // unlocked and bots can be restarted. "Stop & flatten" also closes every open
  // position at market first. The agent KILL SWITCH (stop + lock keys) is the
  // separate red option.
  function stopAllSheet() {
    var runner = S.botRunner; if (!runner) return;
    var n = runner.store.all().length, open = 0;
    try { open = runner.aggregate().activeDeals || 0; } catch (_) {}
    openSheet('<div class="spread"><h2>Stop all bots</h2><button class="btn sm ghost" id="sa-x">' + ic('close', 15) + '</button></div>' +
      '<p class="muted" style="margin:6px 0 12px">' + n + ' bot' + (n === 1 ? '' : 's') + ' · ' + open + ' open position' + (open === 1 ? '' : 's') + '. Stopping pauses every bot and cancels open live orders; your keys stay unlocked and you can start them again.</p>' +
      '<button class="btn primary wide" id="sa-stop">⏹ Stop all bots</button>' +
      '<button class="btn wide" id="sa-flat" style="margin-top:8px">Stop &amp; flatten — close every open position at market</button>' +
      '<button class="btn wide ghost" id="sa-kill" style="margin-top:8px;color:var(--bad)">Kill switch — stop everything and lock keys</button>');
    $('#sa-x').onclick = closeSheet;
    $('#sa-stop').onclick = function () { closeSheet(); runner.stopAll('user').then(function () { toast('⏹ All bots stopped', 'good'); renderBotList(); }); };
    $('#sa-flat').onclick = function () {
      closeSheet(); toast('Closing positions…');
      var bots = runner.store.all();
      (function next(i) {
        if (i >= bots.length) { runner.stopAll('flatten').then(function () { toast('⏹ Stopped — all positions closed at market', 'good'); renderBotList(); }); return; }
        runner.flatten(bots[i].id, 'stop-all').catch(function () {}).then(function () { next(i + 1); });
      })(0);
    };
    $('#sa-kill').onclick = function () {
      closeSheet();
      confirmSheet({ title: 'Kill switch', subtitle: 'Stops every bot, cancels open live orders, and LOCKS your keys. You will need to unlock the wallet again.', lines: [['Bots', String(n)]], okText: 'Kill & lock', danger: true }).then(function (ok) {
        if (ok && S.botRunner) S.botRunner.killAll('user');
      });
    };
  }
  // ---- CLOUD BOTS: PAPER bots that run on the server under your Blockle account,
  // so they keep trading after this wallet is closed. Same engine, same presets;
  // live bots stay on this device (the keys are here) and need the page open.
  var CLOUD = '/api/bots';
  function cloudReq(path, method, body) {
    var h = { accept: 'application/json' }; if (body) h['content-type'] = 'application/json'; if (S.csrf) h['x-csrf-token'] = S.csrf;
    return fetch(CLOUD + (path || ''), { method: method || 'GET', headers: h, credentials: 'include', body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ('cloud bots: HTTP ' + r.status)); e.status = r.status; throw e; } return j; }); });
  }
  S.cloud = null;
  function refreshCloud() {
    if (!S.user) { S.cloud = null; return Promise.resolve(null); }
    return cloudReq('').then(function (j) { S.cloud = j; S.cloud.at = Date.now(); return j; })
      .catch(function (e) { S.cloud = { error: e.message, bots: [], aggregate: null, limits: null }; return null; });
  }
  function cloudBot(id) { return ((S.cloud && S.cloud.bots) || []).filter(function (b) { return b.id === id; })[0] || null; }
  function cloudFail(e) { if (e && e.status === 402) { toast(e.message, 'bad'); location.hash = '#pro'; } else if (e && e.status === 401) { toast('Sign in to your Blockle account to use cloud bots', 'bad'); } else toast('Cloud: ' + ((e && e.message) || e), 'bad'); }
  function moveToCloud() {
    var runner = S.botRunner; if (!runner || !S.user) return;
    var paper = runner.store.all().filter(function (b) { return b.mode !== 'live'; });
    if (!paper.length) { toast('No paper bots on this device'); return; }
    confirmSheet({ title: 'Move paper bots to the cloud?', subtitle: 'They keep their deal history and keep trading on the server after you close this wallet. Live bots stay on this device.', lines: [['Bots', String(paper.length)]], okText: 'Move to cloud' }).then(function (ok) {
      if (!ok) return;
      cloudReq('/import', 'POST', { bots: paper.map(function (b) { return b.toJSON(); }) }).then(function (j) {
        var done = (j.imported || []);
        return Promise.all(done.map(function (id) { return runner.remove(id).catch(function () {}); })).then(function () {
          toast(done.length + ' bot' + (done.length === 1 ? '' : 's') + ' now running in the cloud' + ((j.skipped || []).length ? ' · ' + j.skipped.length + ' skipped' : ''), 'good', 'cloud');
          return refreshCloud();
        }).then(function () { _botListSig = ''; renderBotList(); });
      }).catch(cloudFail);
    });
  }
  // LIVE bots trade only while this page is open (keys live on this device):
  // banner in the Bots tab, tab title, leave-page warning, and a nudge when the
  // tab comes back from being hidden (browsers throttle background tabs).
  function anyLiveRunning() { var r = S.botRunner; if (!r) return false; try { return r.store.all().some(function (b) { return b.mode === 'live' && b.enabled; }); } catch (_) { return false; } }
  var _liveTitle = null, _hiddenAt = null;
  function syncLiveNotice() {
    var live = anyLiveRunning();
    var el = $('#bt-keepopen'); if (el) el.style.display = live ? '' : 'none';
    if (live && _liveTitle == null) { _liveTitle = document.title; document.title = 'LIVE · keep open · ' + _liveTitle; }
    if (!live && _liveTitle != null) { document.title = _liveTitle; _liveTitle = null; }
  }
  window.addEventListener('beforeunload', function (e) { if (anyLiveRunning()) { e.preventDefault(); e.returnValue = 'Live bots stop trading when this page closes.'; return e.returnValue; } });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { _hiddenAt = anyLiveRunning() ? Date.now() : null; return; }
    if (_hiddenAt && anyLiveRunning() && Date.now() - _hiddenAt > 45000) toast('Live bots were throttled while this tab was hidden — keep the wallet in front while they run.', 'bad', 'live');
    _hiddenAt = null;
  });
  // What the wallet actually holds of a lane's trading currency (for the live sheet).
  function laneAvailable(lane) {
    var l = botLanes().filter(function (x) { return x.id === lane; })[0];
    var chain = (l && l.chain) || lane, base = laneBase(lane);
    var guard = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 12000); });
    return Promise.race([Wiring.getHoldings(chain), guard]).then(function (bals) {
      var row = (bals || []).filter(function (b) { var sym = b.asset && (b.asset.symbol || b.asset.sym); return sym && String(sym).toUpperCase() === String(base).toUpperCase(); })[0];
      var dec = row && row.asset ? (row.asset.decimals || 0) : 0;
      var amt = row ? (row.display != null ? numVal(row.display) : baseToNum(row.confirmed, dec)) : 0;
      var native = (bals || []).filter(function (b) { return b.asset && b.asset.kind === 'native'; })[0];
      var nativeAmt = native ? (native.display != null ? numVal(native.display) : baseToNum(native.confirmed, (native.asset.decimals || 0))) : null;
      var pUsd = Promise.resolve(Wiring.estimateUsdWhole && amt > 0 ? Wiring.estimateUsdWhole(row.asset || base, amt) : null).catch(function () { return null; });
      return Promise.race([pUsd, new Promise(function (res) { setTimeout(function () { res(null); }, 6000); })]).then(function (usd) {
        return { chain: chain, base: base, amount: amt, usd: isFinite(Number(usd)) && Number(usd) > 0 ? Number(usd) : null, nativeSymbol: native && native.asset.symbol, nativeAmount: nativeAmt };
      });
    });
  }
  function startBotsPolling() {
    clearInterval(_botsTimer);
    var n = 0;
    _botsTimer = setInterval(function () {
      if (!S.unlocked || !$('#bt-list') || (location.hash || '#portfolio') !== '#bots') { clearInterval(_botsTimer); return; }
      if (S.user && (++n % 3) === 0) { refreshCloud().then(function () { renderBotList(true); }); return; }
      renderBotList(true);
    }, 4000);
  }
  function ensureBotRunner() {
    if (S.botRunner) return Promise.resolve(S.botRunner);
    if (!window.AgentBotRunner) return Promise.reject(new Error('bot runner missing'));
    return ensureAgent().then(function () {
      var a = S.agent;
      return Wiring.registry().then(function (reg) {
        try { if (AgentBots.registerLanes) AgentBots.registerLanes(reg.networks ? reg.networks() : []); } catch (_) {}
        var runner = AgentBotRunner.create({
          policy: a.policy, tools: a.tools, audit: a.audit, ctx: a.ctx, pnl: a.pnl, discovery: a.ctx.discovery || null,
          mainnetEnabled: false, persist: Store, wallet: 'web', channel: 'web',
          onEvent: botEvent,
        });
        S.botRunner = runner;
        try { runner.setLiveBotLimit(S.liveBotLimit != null ? S.liveBotLimit : 1); } catch (_) {} // per-plan live cap
        // restore persisted bots + their deal state, then resume the ticker.
        return runner.store.restore().then(function () {
          if (runner.store.enabled().length) runner._restartScheduler();
          return runner;
        });
      });
    });
  }
  function botEvent(ev) {
    if (!ev) return;
    if (ev.type === 'bot_feed' && ev.kind === 'close') {
      var r = Number(ev.realizedUsd) || 0;
      toast((ev.name || 'Bot') + ' closed ' + (ev.pair || '') + ' ' + fmtSigned(r) + (ev.paper ? ' (paper)' : ''), r >= 0 ? 'good' : 'bad', r >= 0 ? 'money-bag' : 'chart-down');
    } else if (ev.type === 'bot_paused' && ev.reason === 'max-loss') {
      toast('Max-loss rail tripped — a bot paused itself', 'bad', 'stop');
    }
  }
  // The quote asset a preset trades against on a lane: the lane's own stable
  // (USDB on BLOCK) or USDC elsewhere. Presets that trade the lane's base coin
  // (Stacker / Grid) become BASE/QUOTE for whichever network is chosen.
  function laneQuote(lane) { return lane === 'block' ? 'USDB' : 'USDC'; }
  function presetPair(p, lane) { return p.pair ? laneBase(lane) + '/' + laneQuote(lane) : null; }
  // Every preset opens the SAME network picker before it launches — one chain,
  // one base asset per bot, chosen by the user, never assumed.
  function launchPreset(key) {
    var p = BOT_PRESETS.filter(function (x) { return x.key === key; })[0]; if (!p) return;
    ensureBotRunner().then(function () {
      var lanes = botLanes();
      var opts = lanes.map(function (l) { return '<option value="' + esc(l.id) + '"' + (l.id === p.lane ? ' selected' : '') + '>' + esc(l.name) + ' · hold ' + esc(l.base) + '</option>'; }).join('');
      openSheet('<div class="spread"><h2>' + mi(p.icon, 18) + ' ' + esc(p.name) + '</h2><button class="btn sm ghost" id="pl-x">' + ic('close', 15) + '</button></div>' +
        '<p class="muted" style="margin:6px 0 10px;font-size:13px">' + esc(p.blurb) + '</p>' +
        '<div class="field"><label>Network</label><select id="pl-lane">' + opts + '</select><div class="hint dim" style="font-size:12px;margin-top:4px" id="pl-hint"></div></div>' +
        '<div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Paper budget (USD)</label><input id="pl-budget" inputmode="decimal" value="' + p.budget + '"></div><div class="field" style="flex:1"><label>Risk mode</label><select id="pl-mode">' + Object.keys(BOT_MODES).map(function (m) { return '<option value="' + m + '"' + (m === p.mode ? ' selected' : '') + '>' + esc(BOT_MODES[m].split(' — ')[0]) + '</option>'; }).join('') + '</select></div></div>' +
        whereField('pl-where') +
        '<button class="btn primary wide" id="pl-go">' + mi('launch', 15) + ' Launch on <span id="pl-lane-name">' + esc(laneLabel(p.lane)) + '</span> (paper)</button>');
      $('#pl-x').onclick = closeSheet;
      function hint() {
        var lane = $('#pl-lane').value, pair = presetPair(p, lane);
        $('#pl-lane-name').textContent = laneLabel(lane);
        $('#pl-hint').textContent = pair ? 'Trades ' + pair + ' on ' + laneLabel(lane) + '.' : 'Auto-finds ' + (p.mode === 'sniper' ? 'brand-new' : 'trending') + ' tokens on ' + laneLabel(lane) + ', quoted in ' + laneBase(lane) + '.';
      }
      $('#pl-lane').onchange = hint; hint();
      $('#pl-go').onclick = function () {
        var lane = $('#pl-lane').value, budget = Number($('#pl-budget').value), mode = $('#pl-mode').value;
        if (!(budget > 0)) { toast('Set a paper budget (USD)', 'bad'); return; }
        var where = ($('#pl-where') || {}).value || 'device';
        closeSheet();
        launchPresetOn(p, lane, budget, mode, where);
      };
    }).catch(function (e) { toast('Bots engine unavailable: ' + (e.message || e), 'bad'); });
  }
  // "Where it runs" — cloud (server, keeps going when the wallet is closed) when
  // signed in, else this device (needs the page open).
  function whereField(id) {
    if (!S.user) return '<div class="dim" style="font-size:12px;margin:4px 0 10px">Runs on this device while the wallet is open. <a href="/account/login?next=/wallet%23bots">Sign in</a> to run bots in the cloud 24/7.</div>';
    return '<div class="field"><label>Where it runs</label><select id="' + id + '"><option value="cloud">Cloud — keeps trading after you close the wallet</option><option value="device">This device — only while this page is open</option></select></div>';
  }
  function launchCloud(spec, budget, label) {
    return cloudReq('', 'POST', { spec: spec, allocationUsd: budget }).then(function () {
      toast(label + ' is live in the cloud · $' + budget + ' paper', 'good', 'cloud');
      return refreshCloud();
    }).then(function () { _botListSig = ''; renderBotList(); }).catch(cloudFail);
  }
  function launchPresetOn(p, lane, budget, mode, where) {
    ensureBotRunner().then(function (runner) {
      var bots = runner.store.all();
      var pair = presetPair(p, lane);
      var cfg = JSON.parse(JSON.stringify(p.config));
      if (p.type === 'grid') cfg.totalUsd = budget;
      var spec = { name: p.name + ' · ' + laneLabel(lane), type: p.type, lane: lane, riskMode: mode || p.mode, profitMode: 'take', preset: p.key,
        universe: { pairs: pair ? [pair] : [] }, config: cfg, risk: p.risk, pollSec: p.pollSec, mode: 'paper', network: 'testnet' };
      if (where === 'cloud' && S.user) { launchCloud(spec, budget, p.name + ' on ' + laneLabel(lane)); return; }
      if (!isPro() && bots.length >= 1) { toast('Free plan allows 1 bot on this device — upgrade for more', 'bad'); location.hash = '#pro'; return; }
      try {
        var bot = runner.add(spec); bot.preset = p.key;
        runner.enablePaper(bot.id, { allocationUsd: budget }).then(function () {
          toast(p.name + ' is live on ' + laneLabel(lane) + ' · $' + budget + ' paper', 'good', 'launch');
          _botListSig = ''; renderBotList(); runner.tickNow(bot.id).then(function () { _botListSig = ''; renderBotList(); }).catch(function () {});
        });
      } catch (e) { toast('Launch failed: ' + (e.message || e), 'bad'); }
    }).catch(function (e) { toast('Bots engine unavailable: ' + (e.message || e), 'bad'); });
  }
  function renderCloudCard() {
    var el = $('#bt-cloud'); if (!el) return;
    if (!S.user) { el.innerHTML = mi('cloud', 14) + ' <b>Keep bots running after you close the wallet.</b> Sign in and your paper bots can run in the cloud around the clock. <a href="/account/login?next=/wallet%23bots">Sign in</a>'; return; }
    var c = S.cloud;
    if (!c) { el.innerHTML = mi('cloud', 14) + ' <span class="dim">Checking cloud bots…</span>'; return; }
    if (c.error) { el.innerHTML = mi('cloud', 14) + ' <span class="bad">Cloud bots unavailable: ' + esc(c.error) + '</span>'; return; }
    var n = (c.bots || []).length, running = (c.aggregate && c.aggregate.running) || 0, lim = c.limits || {};
    var localPaper = S.botRunner ? S.botRunner.store.all().filter(function (b) { return b.mode !== 'live'; }).length : 0;
    el.innerHTML = mi('cloud', 14) + ' <b>' + (n ? running + ' of ' + n + ' cloud bot' + (n === 1 ? '' : 's') + ' running' : 'No cloud bots yet') + '</b> — cloud bots keep trading after you close this wallet. ' +
      '<span class="dim">Plan allows ' + (lim.maxBots || '—') + '.</span>' +
      (localPaper ? '<div style="margin-top:8px"><button class="btn sm" id="bt-tocloud">Move ' + localPaper + ' paper bot' + (localPaper === 1 ? '' : 's') + ' to the cloud</button></div>' : '');
    if ($('#bt-tocloud')) $('#bt-tocloud').onclick = moveToCloud;
  }
  function cloudDone(msg) { return function () { if (msg) toast(msg, 'good'); return refreshCloud().then(function () { _botListSig = ''; renderBotList(); }); }; }
  function cloudAct(act, id, btn) {
    var cb = cloudBot(id); if (!cb) { btn.disabled = false; return; }
    var fail = function (e) { btn.disabled = false; cloudFail(e); };
    if (act === 'toggle') cloudReq('/' + encodeURIComponent(id) + '/' + (cb.enabled ? 'pause' : 'start'), 'POST', {}).then(cloudDone(cb.enabled ? '⏸ Cloud bot stopped' : '▶ Cloud bot started')).catch(fail);
    else if (act === 'resume') cloudReq('/' + encodeURIComponent(id) + '/resume', 'POST', {}).then(cloudDone('Cloud bot resumed')).catch(fail);
    else if (act === 'tick') cloudReq('/' + encodeURIComponent(id) + '/tick', 'POST', {}).then(function (j) { if (j.report && j.report.error) toast('Tick: ' + j.report.error, 'bad'); return cloudDone()(); }).catch(fail);
    else if (act === 'flatten') confirmSheet({ title: 'Stop & flatten?', subtitle: 'Closes every open position of this cloud bot at the current market price and stops it.', lines: [['Bot', cb.name || id]], okText: 'Close & stop' }).then(function (ok) { if (!ok) { btn.disabled = false; return; } cloudReq('/' + encodeURIComponent(id) + '/flatten', 'POST', {}).then(function (j) { return cloudDone('⏹ Stopped — ' + ((j.closes || []).filter(function (x) { return !x.skipped; }).length) + ' position(s) closed')(); }).catch(fail); });
    else if (act === 'rm') confirmSheet({ title: 'Remove cloud bot?', subtitle: 'Its deal history on the server is deleted.', lines: [['Bot', cb.name || id]], okText: 'Remove' }).then(function (ok) { if (!ok) { btn.disabled = false; return; } cloudReq('/' + encodeURIComponent(id) + '/remove', 'POST', {}).then(cloudDone('Cloud bot removed')).catch(fail); });
    else if (act === 'detail') { btn.disabled = false; cloudDetailSheet(cb); }
    else btn.disabled = false;
  }
  function cloudDetailSheet(cb) {
    var d = cb.dashboard || {};
    var deals = (d.activeDeals || []).map(function (x) { return '<div class="li"><span class="col" style="align-items:flex-start"><b>' + esc(x.pair) + '</b><span class="dim" style="font-size:11px">' + esc(x.type || '') + ' · in @ ' + (x.avgEntryUsd != null ? fmtUsd(x.avgEntryUsd) : '—') + ' · mark ' + (x.markUsd != null ? fmtUsd(x.markUsd) : '—') + '</span></span><span class="' + pnlClass(x.unrealizedUsd) + ' num">' + fmtSigned(x.unrealizedUsd) + (x.unrealizedPct != null ? ' (' + (x.unrealizedPct > 0 ? '+' : '') + Number(x.unrealizedPct).toFixed(1) + '%)' : '') + '</span></div>'; }).join('');
    var feed = (d.feed || []).slice(0, 12).map(function (e) { return '<div class="li"><span class="col" style="align-items:flex-start"><span class="' + (e.kind === 'close' ? pnlClass(e.realizedUsd) : e.kind === 'halt' ? 'bad' : '') + '">' + esc(e.text || e.kind) + '</span><span class="dim" style="font-size:11px">' + agoShort(e.at) + '</span></span></div>'; }).join('');
    openSheet('<div class="spread"><h2>' + mi(botIcon(cb), 18) + ' ' + esc(cb.name || cb.id) + '</h2><button class="btn sm ghost" id="cd-x">' + ic('close', 15) + '</button></div>' +
      '<div class="dim" style="font-size:12px;margin:4px 0 10px">' + mi('cloud', 13) + ' Runs in the cloud under your Blockle account — keeps trading when this wallet is closed. ' + esc(cb.describe || '') + '</div>' +
      '<div class="statline"><div class="stat"><div class="n num ' + pnlClass(d.realizedUsd) + '">' + fmtSigned(d.realizedUsd) + '</div><div class="l">realized</div></div><div class="stat"><div class="n num ' + pnlClass(d.unrealizedUsd) + '">' + fmtSigned(d.unrealizedUsd) + '</div><div class="l">open P&amp;L</div></div><div class="stat"><div class="n num">' + (d.totalDeals || 0) + '</div><div class="l">deals</div></div><div class="stat"><div class="n num">' + (d.winRate == null ? '—' : Math.round(d.winRate * 100) + '%') + '</div><div class="l">wins</div></div></div>' +
      '<div class="dim" style="font-size:12px;margin:8px 0">' + (d.status === 'running' ? '<span class="pulse"></span> running' : d.status === 'halted' ? '<span class="bad">halted · ' + esc(d.haltReason || '') + '</span>' : 'paused') + ' · budget ' + fmtUsd(d.committedUsd || 0) + ' / ' + fmtUsd(d.effectiveCapUsd || d.allocationUsd || 0) + ' deployed · last tick ' + agoShort(d.lastTickAt) + '</div>' +
      (deals ? '<h3 style="font-size:13px;margin:8px 0 4px">Open positions</h3><div class="list">' + deals + '</div>' : '') +
      (feed ? '<h3 style="font-size:13px;margin:8px 0 4px">Recent</h3><div class="list">' + feed + '</div>' : '') +
      '<div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn sm" id="cd-tick">Tick now</button>' + (cb.enabled ? '<button class="btn sm ghost" id="cd-stop">⏸ Stop</button>' : '<button class="btn sm ghost" id="cd-start">▶ Start</button>') + ((d.activeDeals || []).length ? '<button class="btn sm ghost" id="cd-flat">⏹ Stop &amp; flatten</button>' : '') + '<button class="btn sm ghost" id="cd-export">Export template</button></div>');
    $('#cd-x').onclick = closeSheet;
    var fake = { disabled: false, getAttribute: function () { return '1'; } };
    $('#cd-tick').onclick = function () { closeSheet(); cloudAct('tick', cb.id, fake); };
    if ($('#cd-stop')) $('#cd-stop').onclick = function () { closeSheet(); cloudAct('toggle', cb.id, fake); };
    if ($('#cd-start')) $('#cd-start').onclick = function () { closeSheet(); cloudAct('toggle', cb.id, fake); };
    if ($('#cd-flat')) $('#cd-flat').onclick = function () { closeSheet(); cloudAct('flatten', cb.id, fake); };
    $('#cd-export').onclick = function () { cloudReq('/' + encodeURIComponent(cb.id) + '/export').then(function (t) { var blob = new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (cb.name || cb.id).replace(/[^A-Za-z0-9_-]+/g, '_') + '.bot.json'; a.click(); }).catch(cloudFail); };
  }
  var _botListSig = '';
  function renderBotList(quiet) {
    var runner = S.botRunner, box = $('#bt-list'); if (!runner || !box) return;
    // a background refresh never yanks the list out from under a tap or a sheet
    if (quiet && $('#scrim').classList.contains('open')) return;
    syncLiveNotice(); renderCloudCard();
    var agg = null; try { agg = runner.aggregate(); } catch (_) { agg = null; }
    var ca = (S.cloud && S.cloud.aggregate) || null;
    if (agg) {
      var realV = (agg.realizedUsd || 0) + (ca ? (ca.realizedUsd || 0) : 0), unV = (agg.unrealizedUsd || 0) + (ca ? (ca.unrealizedUsd || 0) : 0);
      var real = $('#bt-real'); if (real) { real.textContent = fmtSigned(realV); real.className = 'n num ' + pnlClass(realV); }
      var un = $('#bt-unreal'); if (un) { un.textContent = fmtSigned(unV); un.className = 'n num ' + pnlClass(unV); }
      if ($('#bt-deals')) $('#bt-deals').textContent = String((agg.activeDeals || 0) + (ca ? (ca.activeDeals || 0) : 0));
      var wr = agg.winRate != null ? agg.winRate : (ca ? ca.winRate : null);
      if ($('#bt-win')) $('#bt-win').textContent = wr == null ? '—' : Math.round(wr * 100) + '%';
      if ($('#bt-engine')) $('#bt-engine').innerHTML = (agg.killed ? '<span class="chip bad">killed</span>' : (agg.running ? '<span class="pulse"></span><b>Engine live</b>' : (ca && ca.running ? '<span class="pulse"></span><b>Cloud live</b>' : '<span class="dim">Engine idle</span>'))) +
        '<span class="dim">' + (agg.running || 0) + ' on this device' + (agg.live ? ' · ' + agg.live + ' LIVE' : '') + (ca ? ' · ' + (ca.running || 0) + ' in the cloud' : '') + ' · ' + fmtUsd((agg.allocationUsd || 0) + (ca ? (ca.allocationUsd || 0) : 0)) + ' allocated · ' + fmtUsd((agg.committedUsd || 0) + (ca ? (ca.committedUsd || 0) : 0)) + ' deployed</span>';
      var tk = $('#bt-ticker');
      if (tk) {
        var feed = (agg.feed || []).concat(ca && ca.feed ? ca.feed.map(function (e) { return Object.assign({}, e, { name: 'cloud · ' + (e.name || '') }); }) : []).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
        if ($('#bt-ticker-n')) $('#bt-ticker-n').textContent = feed.length ? feed.length + ' events' : '';
        if (feed.length) tk.innerHTML = feed.slice(0, 25).map(function (e) {
          var cls = e.kind === 'close' ? pnlClass(e.realizedUsd) : e.kind === 'buy' ? '' : e.kind === 'halt' ? 'bad' : e.kind === 'signal' ? 'good' : '';
          return '<div class="li"><span class="col" style="align-items:flex-start"><span class="' + cls + '">' + esc(e.text || e.kind) + '</span><span class="dim" style="font-size:11px">' + esc(e.name || '') + ' · ' + agoShort(e.at) + '</span></span></div>';
        }).join('');
      }
    }
    var bots = runner.store.all();
    var cloudBots = (S.cloud && S.cloud.bots) || [];
    var total = bots.length + cloudBots.length;
    if ($('#bt-count')) $('#bt-count').textContent = total ? total + (total === 1 ? ' bot' : ' bots') + (cloudBots.length ? ' · ' + cloudBots.length + ' cloud' : '') : '';
    if (!total) { _botListSig = ''; box.innerHTML = '<div class="empty">No bots yet. Tap a preset above or create your own — it starts in paper mode.</div>'; return; }
    var rows = ((agg && agg.bots) || bots.map(function (b) { return runner.dashboard(b.id); })).map(function (d) { return { d: d, b: runner.store.get(d.bot) || {}, cloud: false }; })
      .concat(cloudBots.map(function (cb) { return { d: cb.dashboard || {}, b: cb, cloud: true }; }));
    // only touch the DOM when something visible changed (status / money / deals)
    var sig = rows.map(function (r) { var d = r.d; return [d.bot, r.cloud ? 'c' : 'l', d.status, d.mode, Math.round((d.realizedUsd || 0) * 100), Math.round((d.unrealizedUsd || 0) * 100), Math.round(d.committedUsd || 0), (d.activeDeals || []).length, d.totalDeals, d.streak, d.lastTickAt].join(':'); }).join('|');
    if (quiet && sig === _botListSig) return;
    _botListSig = sig;
    box.innerHTML = rows.map(function (r) {
      var d = r.d, b = r.b, cloud = r.cloud, dc = cloud ? ' data-cloud="1"' : '';
      var live = d.mode === 'live';
      var cap = d.effectiveCapUsd || d.allocationUsd || 0, dep = d.committedUsd || 0;
      var pct = cap > 0 ? Math.min(100, Math.round(dep / cap * 100)) : 0;
      var streak = d.streak || 0;
      var status = d.status === 'running' ? '<span class="pulse"></span> running' : d.status === 'halted' ? '<span class="bad">⏸ halted · ' + esc(d.haltReason || '') + '</span>' : d.status === 'killed' ? '<span class="bad">killed</span>' : '<span class="dim">paused</span>';
      return '<div class="li" style="align-items:flex-start;flex-wrap:wrap;gap:8px">' +
        '<span class="ico">' + mi(botIcon(b), 20) + '</span>' +
        '<span class="col" style="align-items:flex-start;flex:1;min-width:160px"><b>' + esc(d.name || b.name || d.type) + ' <span class="' + (live ? 'good' : 'dim') + '" style="font-size:11px">' + (cloud ? mi('cloud', 12) + ' cloud · paper' : live ? 'LIVE · keep page open' : 'paper · this device') + '</span></b>' +
        '<span class="dim" style="font-size:12px">' + esc(d.type) + (d.lane ? ' · ' + esc(laneLabel(d.lane)) : '') + (d.riskMode ? ' · ' + esc(d.riskMode) : '') + ' · ' + esc((b.universe && b.universe.pairs && b.universe.pairs[0]) || 'auto-find') + '</span>' +
        '<span style="font-size:12px">' + status + ' · <span class="' + pnlClass(d.realizedUsd) + ' num">' + fmtSigned(d.realizedUsd) + '</span>' + (d.unrealizedUsd ? ' · open <span class="' + pnlClass(d.unrealizedUsd) + ' num">' + fmtSigned(d.unrealizedUsd) + '</span>' : '') +
        ' · ' + (d.totalDeals || 0) + ' deals' + (d.winRate != null ? ' · ' + Math.round(d.winRate * 100) + '% wins' : '') + (streak >= 2 ? ' · <span class="heat good">' + mi('fire', 13) + ' ' + streak + ' streak</span>' : streak <= -2 ? ' · <span class="heat bad">' + mi('cube', 13) + ' ' + (-streak) + ' cold</span>' : '') + '</span>' +
        (d.auto ? '<span style="font-size:12px;width:100%">' + mi('brain', 13) + ' ' + esc(regimeText(d.auto.regime)) + (d.auto.lead ? ' · leading: <b>' + esc(algoName(d.auto.lead)) + '</b>' : '') + ' · ' + Object.keys(d.auto.weights || {}).sort(function (x, y) { return d.auto.weights[y] - d.auto.weights[x]; }).map(function (a) { return esc(algoName(a)) + ' ' + Math.round(d.auto.weights[a] * 100) + '%'; }).join(' · ') + '</span>' : '') +
        (cap > 0 ? '<span class="dim" style="font-size:11px;width:100%">budget ' + fmtUsd(dep) + ' / ' + fmtUsd(cap) + ' deployed · ' + (d.activeDeals || []).length + ' open · last tick ' + agoShort(d.lastTickAt) + '</span><progress class="rangebar" max="100" value="' + pct + '"></progress>' : '') +
        (d.lastError ? '<span class="bad" style="font-size:11px">' + esc(d.lastError.message) + '</span>' : '') + '</span>' +
        '<span class="row" style="gap:6px;flex-wrap:wrap">' +
        '<button class="btn sm" data-act="detail" data-id="' + esc(d.bot) + '"' + dc + '>Details</button>' +
        (d.status === 'halted' ? '<button class="btn sm primary" data-act="resume" data-id="' + esc(d.bot) + '"' + dc + '>Resume</button>' : '<button class="btn sm ghost" data-act="toggle" data-id="' + esc(d.bot) + '"' + dc + '>' + (d.enabled ? '⏸ Stop' : '▶ Start') + '</button>') +
        '<button class="btn sm ghost" data-act="tick" data-id="' + esc(d.bot) + '" title="Tick now"' + dc + '>' + ic('refresh', 14) + '</button>' +
        ((d.activeDeals || []).length ? '<button class="btn sm ghost" data-act="flatten" data-id="' + esc(d.bot) + '" title="Close open positions and stop"' + dc + '>⏹ Flatten</button>' : '') +
        (S.pro && !live && !cloud ? '<button class="btn sm" data-act="live" data-id="' + esc(d.bot) + '">Go live</button>' : '') +
        '<button class="btn sm ghost" data-act="rm" data-id="' + esc(d.bot) + '" title="Remove"' + dc + '>' + ic('close', 14) + '</button></span></div>';
    }).join('');
    $$('#bt-list [data-act]').forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-id'), act = btn.getAttribute('data-act');
        btn.disabled = true;
        if (btn.getAttribute('data-cloud')) { cloudAct(act, id, btn); return; }
        if (act === 'toggle') {
          var b = runner.store.get(id);
          (b && b.enabled ? runner.pause(id) : runner.enablePaper(id)).then(function () { toast(b && b.enabled ? '▶ Bot started' : '⏸ Bot stopped'); _botListSig = ''; renderBotList(); })
            .catch(function (e) { btn.disabled = false; toast('Failed: ' + (e.message || e), 'bad'); });
        }
        else if (act === 'tick') { runner.tickNow(id).then(function (r) { btn.disabled = false; _botListSig = ''; renderBotList(); if (r && r.error) toast('Tick: ' + r.error, 'bad'); }).catch(function (e) { btn.disabled = false; toast('Tick failed: ' + (e.message || e), 'bad'); }); }
        else if (act === 'resume') { runner.resume(id).then(function () { toast('Bot resumed', 'good'); _botListSig = ''; renderBotList(); }); }
        else if (act === 'rm') { confirmSheet({ title: 'Remove bot?', subtitle: 'Its deal history is deleted. Open live orders are cancelled best-effort.', lines: [['Bot', (runner.store.get(id) || {}).name || id]], okText: 'Remove' }).then(function (ok) { btn.disabled = false; if (ok) runner.remove(id).then(function () { toast('Bot removed'); _botListSig = ''; renderBotList(); }); }); }
        else if (act === 'flatten') { confirmSheet({ title: 'Stop & flatten?', subtitle: 'Closes every open position of this bot at the current market price (paper simulates; live sells go through the gate), books the result, and stops the bot.', lines: [['Bot', (runner.store.get(id) || {}).name || id]], okText: 'Close & stop' }).then(function (ok) { btn.disabled = false; if (ok) runner.flatten(id, 'user').then(function (c) { toast('⏹ Stopped — ' + c.filter(function (x) { return !x.skipped; }).length + ' position(s) closed', 'good'); _botListSig = ''; renderBotList(); }).catch(function (e) { toast('Flatten failed: ' + (e.message || e), 'bad'); }); }); }
        else if (act === 'live') { armLiveSheet(id); }
        else if (act === 'detail') { botDetailSheet(id); }
      };
    });
  }
  function botDetailSheet(id) {
    var runner = S.botRunner; if (!runner) return;
    var d = runner.dashboard(id), b = runner.store.get(id); if (!d || !b) return;
    var desc = ''; try { desc = b.describe(); } catch (_) {}
    var open = (d.activeDeals || []).map(function (x) {
      if (x.type === 'grid') return '<div class="kv"><span>' + esc(x.pair) + ' grid</span><span class="mono num">' + x.filledLevels + '/' + x.levels + ' rungs held</span></div>';
      return '<div class="kv"><span>' + esc(x.pair) + ' <span class="dim">' + esc(x.status) + (x.safetyOrdersUsed ? ' · SO ' + x.safetyOrdersUsed : '') + '</span></span><span class="mono num ' + pnlClass(x.unrealizedUsd) + '">' + (x.unrealizedUsd != null ? fmtSigned(x.unrealizedUsd) + (x.unrealizedPct != null ? ' (' + (x.unrealizedPct >= 0 ? '+' : '') + x.unrealizedPct.toFixed(1) + '%)' : '') : 'entry ' + fmtUsd(x.avgEntryUsd)) + '</span></div>';
    }).join('') || '<div class="empty">No open deals.</div>';
    var closed = (d.closedDeals || []).map(function (c) { return '<div class="kv"><span>' + esc(c.type) + ' · ' + esc(c.reason || '') + ' <span class="dim">' + agoShort(c.closedAt) + '</span></span><span class="mono num ' + pnlClass(c.realizedUsd) + '">' + fmtSigned(c.realizedUsd) + '</span></div>'; }).join('') || '<div class="empty">No closed deals yet.</div>';
    var feed = (d.feed || []).slice().reverse().map(function (e) { return '<div class="li"><span class="col" style="align-items:flex-start"><span>' + esc(e.text || e.kind) + '</span><span class="dim" style="font-size:11px">' + agoShort(e.at) + '</span></span></div>'; }).join('') || '<div class="empty">Quiet so far.</div>';
    var autoHtml = d.auto ? '<h3 style="margin:8px 0 4px;font-size:14px">Algorithm rotation</h3><div class="list">' +
      '<div class="kv"><span>Market regime</span><span class="mono">' + esc(regimeText(d.auto.regime)) + (d.auto.regimeInfo && d.auto.regimeInfo.ret != null ? ' · ' + (d.auto.regimeInfo.ret >= 0 ? '+' : '') + d.auto.regimeInfo.ret + '% over ' + d.auto.regimeInfo.n + ' samples' : '') + ' · ' + (d.auto.rebalances || 0) + ' rebalances</span></div>' +
      (d.auto.children || []).slice().sort(function (x, y) { return (y.weight || 0) - (x.weight || 0); }).map(function (c) {
        return '<div class="kv"><span>' + esc(c.name) + ' <span class="dim">' + (c.weight != null ? Math.round(c.weight * 100) + '% · $' + fmtAmt(c.allocationUsd, 0) : '') + '</span></span><span class="mono num ' + pnlClass((c.realizedUsd || 0) + (c.unrealizedUsd || 0)) + '">' + fmtSigned((c.realizedUsd || 0) + (c.unrealizedUsd || 0)) + ' <span class="dim">· ' + (c.activeDeals || 0) + ' open · ' + (c.totalDeals || 0) + ' deals' + (c.winRate != null ? ' · ' + Math.round(c.winRate * 100) + '%' : '') + '</span></span></div>';
      }).join('') + '</div>' + (d.auto.series && d.auto.series.length > 2 ? '<div style="height:50px;margin:6px 0">' + sparkSvg(d.auto.series, 320, 50) + '</div>' : '') : '';
    var scan = d.lastScan ? '<div class="kv"><span>Last scan</span><span class="mono num">' + (d.lastScan.candidates || []).length + ' candidates · ' + (d.lastScan.worthy || []).length + ' worthy</span></div>' : '';
    openSheet('<div class="spread"><h2>' + mi(botIcon(b), 18) + ' ' + esc(d.name) + '</h2><button class="btn sm ghost" id="bd-x">' + ic('close', 15) + '</button></div>' +
      '<p class="muted" style="margin:6px 0 10px;font-size:13px">' + esc(desc) + '</p>' +
      '<div class="statline" style="margin-bottom:10px"><div class="stat"><div class="n num ' + pnlClass(d.realizedUsd) + '">' + fmtSigned(d.realizedUsd) + '</div><div class="l">realized</div></div><div class="stat"><div class="n num ' + pnlClass(d.unrealizedUsd) + '">' + fmtSigned(d.unrealizedUsd) + '</div><div class="l">open</div></div><div class="stat"><div class="n num">' + (d.winRate != null ? Math.round(d.winRate * 100) + '%' : '—') + '</div><div class="l">' + (d.totalDeals || 0) + ' deals</div></div><div class="stat"><div class="n num">' + (d.bestStreak || 0) + '</div><div class="l">best streak</div></div></div>' +
      '<div class="list" style="margin-bottom:10px">' +
      '<div class="kv"><span>Status</span><span class="mono">' + esc(d.status) + (d.haltReason ? ' (' + esc(d.haltReason) + ')' : '') + ' · ' + esc(d.mode) + ' · every ' + d.pollSec + 's</span></div>' +
      '<div class="kv"><span>Lane / mode</span><span class="mono">' + esc(laneLabel(d.lane)) + ' · ' + esc(d.riskMode || 'any') + ' · ' + esc(d.profitMode) + '</span></div>' +
      '<div class="kv"><span>Budget</span><span class="mono num">' + fmtUsd(d.committedUsd) + ' / ' + fmtUsd(d.effectiveCapUsd) + (d.remainingUsd != null ? ' · ' + fmtUsd(d.remainingUsd) + ' left' : '') + '</span></div>' +
      '<div class="kv"><span>Risk rails</span><span class="mono num">' + (d.risk && d.risk.maxLossPct ? 'max loss ' + d.risk.maxLossPct + '%' : 'no max-loss') + (d.risk && d.risk.paperSlippageBps ? ' · paper slip ' + d.risk.paperSlippageBps + 'bps' : '') + ' · max DD ' + fmtUsd(d.maxDrawdownUsd) + '</span></div>' + scan + '</div>' +
      autoHtml +
      '<h3 style="margin:8px 0 4px;font-size:14px">Open deals</h3><div class="list">' + open + '</div>' +
      '<h3 style="margin:12px 0 4px;font-size:14px">Recent closes</h3><div class="list">' + closed + '</div>' +
      '<h3 style="margin:12px 0 4px;font-size:14px">Ticker</h3><div class="list ticker">' + feed + '</div>' +
      '<div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn sm" id="bd-tick">Tick now</button>' + (d.enabled ? '<button class="btn sm ghost" id="bd-stop">⏸ Stop</button>' : '') + ((d.activeDeals || []).length ? '<button class="btn sm ghost" id="bd-flatten">⏹ Stop &amp; flatten</button>' : '') + '<button class="btn sm ghost" id="bd-export">Export template</button>' + (d.status === 'halted' ? '<button class="btn sm primary" id="bd-resume">Resume</button>' : '') + '</div>');
    $('#bd-x').onclick = closeSheet;
    $('#bd-tick').onclick = function () { runner.tickNow(id).then(function () { closeSheet(); renderBotList(); botDetailSheet(id); }); };
    $('#bd-export').onclick = function () {
      try { var t = AgentBotTemplates.exportBot(b); var blob = new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (b.name || 'bot').replace(/[^a-z0-9]+/gi, '-') + '.blockle-bot.json'; a.click(); toast('Template exported', 'good'); } catch (e) { toast('Export failed', 'bad'); }
    };
    if ($('#bd-resume')) $('#bd-resume').onclick = function () { runner.resume(id).then(function () { closeSheet(); _botListSig = ''; renderBotList(); }); };
    if ($('#bd-stop')) $('#bd-stop').onclick = function () { runner.pause(id).then(function () { toast('⏸ Bot stopped'); closeSheet(); _botListSig = ''; renderBotList(); }); };
    if ($('#bd-flatten')) $('#bd-flatten').onclick = function () { closeSheet(); runner.flatten(id, 'user').then(function (c) { toast('⏹ Stopped — ' + c.filter(function (x) { return !x.skipped; }).length + ' position(s) closed', 'good'); _botListSig = ''; renderBotList(); }).catch(function (e) { toast('Flatten failed: ' + (e.message || e), 'bad'); }); };
  }
  function newBotSheet(prefill) {
    var lanes = botLanes();
    var laneOpts = lanes.map(function (l) { return '<option value="' + esc(l.id) + '"' + (l.id === 'solana' ? ' selected' : '') + '>' + esc(l.name) + ' · hold ' + esc(l.base) + '</option>'; }).join('');
    var regOpts = regStrategies().map(function (s) { return '<option value="' + esc(s.name) + '">' + esc(regLabel(s.name)) + '</option>'; }).join('');
    var regGroup = regOpts ? '<optgroup label="Indicator &amp; systematic — any chain">' + regOpts + '</optgroup>' : '';
    openSheet('<div class="spread"><h2>New bot</h2><button class="btn sm ghost" id="nb-x">' + ic('close', 15) + '</button></div>' +
      '<div class="field"><label>Strategy</label><select id="nb-type"><option value="auto">Full Auto — pick a chain, it switches algorithms for max profit</option><option value="signal">Signal — auto-find tokens, trade each with a sub-strategy</option><option value="scanner">Autopilot — scan &amp; trade cost-positive edges</option><option value="dca">DCA — ladder into a token, bank the take-profit</option><option value="grid">Grid — buy every dip rung, sell every pop</option><option value="smarttrade">Smart trade — one entry, staged take-profits, trailing stop</option>' + regGroup + '</select><div class="hint dim" style="font-size:12px;margin-top:4px" id="nb-strat-help"></div></div>' +
      '<div class="field"><label>Network — every strategy trades on exactly one chain</label><select id="nb-lane">' + laneOpts + '</select><div class="hint dim" style="font-size:12px;margin-top:4px" id="nb-lane-hint"></div></div>' +
      '<div class="field"><label>Risk mode</label><select id="nb-mode"><option value="safe">Safe — large-cap only</option><option value="medium" selected>Medium — mid-cap, balanced</option><option value="high">High — microcap, social-driven</option><option value="sniper">Sniper — brand-new launches</option></select></div>' +
      '<div class="field" id="nb-pair-wrap"><label>Token</label><div class="row" style="gap:6px"><input id="nb-pair" placeholder="SYMBOL/QUOTE" style="flex:1"><select id="nb-held" style="max-width:46%"><option value="">from your wallet…</option></select></div><div class="hint dim" style="font-size:12px;margin-top:4px">Pick a token you hold on this lane, or type a pair like <span class="mono">WIF/SOL</span>.</div></div>' +
      '<div id="nb-adv-indicator" style="display:none;margin-bottom:10px"></div>' +
      '<div class="field"><label>Profit handling</label><select id="nb-profit"><option value="take" selected>Take profit — skim gains to your balance</option><option value="compound">Compound — reinvest gains, grow the position</option></select></div>' +
      '<div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Paper budget (USD)</label><input id="nb-budget" inputmode="decimal" value="250"></div><div class="field" style="flex:1"><label>Max loss (% of budget)</label><input id="nb-maxloss" inputmode="decimal" value="25"></div></div>' +
      '<div class="field"><label>Name</label><input id="nb-name" placeholder="My bot"></div>' + whereField('nb-where') +
      '<details style="margin-bottom:10px"><summary class="dim" style="cursor:pointer;font-size:13px">Advanced</summary><div style="margin-top:8px">' +
      '<div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Tick every (s)</label><input id="nb-poll" inputmode="numeric" value="20"></div><div class="field" style="flex:1"><label>Paper slippage (bps)</label><input id="nb-slip" inputmode="numeric" value="25"></div></div>' +
      '<div id="nb-adv-dca"><div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Base order $</label><input id="nb-base" inputmode="decimal" value="30"></div><div class="field" style="flex:1"><label>Safety orders</label><input id="nb-so" inputmode="numeric" value="3"></div><div class="field" style="flex:1"><label>Step %</label><input id="nb-step" inputmode="decimal" value="3"></div></div>' +
      '<div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Take profit %</label><input id="nb-tp" inputmode="decimal" value="6"></div><div class="field" style="flex:1"><label>Trailing %</label><input id="nb-trail" inputmode="decimal" value="2"></div><div class="field" style="flex:1"><label>Stop loss %</label><input id="nb-sl" inputmode="decimal" value="15"></div></div>' +
      '<div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Start</label><select id="nb-start"><option value="asap">ASAP</option><option value="dip">On a dip</option></select></div><div class="field" style="flex:1"><label>Dip %</label><input id="nb-dip" inputmode="decimal" value="2"></div><div class="field" style="flex:1"><label>Time stop (h)</label><input id="nb-tstop" inputmode="numeric" value="48"></div></div></div>' +
      '<div id="nb-candle-wrap"><div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Smart exit on candles</label><select id="nb-candle"><option value="on" selected>On — bank profit on a reversal</option><option value="off">Off — fixed take-profit only</option></select></div><div class="field" style="flex:1"><label>Candle</label><select id="nb-csec"><option value="60">1 min</option><option value="120" selected>2 min</option><option value="300">5 min</option><option value="900">15 min</option></select></div><div class="field" style="flex:1"><label>Arm above +%</label><input id="nb-cmin" inputmode="decimal" value="2"></div></div>' +
      '<div class="hint dim" style="font-size:12px;margin:-6px 0 10px">Once a deal is up by the arm level, a red close below the last candle\'s low, a long upper wick, an EMA cross-down or giving back half the gain takes the profit — no waiting for a fixed target.</div></div>' +
      '<div id="nb-adv-grid" style="display:none"><div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Range ± %</label><input id="nb-range" inputmode="decimal" value="6"></div><div class="field" style="flex:1"><label>Rungs</label><input id="nb-rungs" inputmode="numeric" value="10"></div><div class="field" style="flex:1"><label>Grid stop %</label><input id="nb-gsl" inputmode="decimal" value="12"></div></div></div>' +
      '<div id="nb-adv-smart" style="display:none"><div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Entry $</label><input id="nb-amt" inputmode="decimal" value="50"></div><div class="field" style="flex:1"><label>TP1 % / share</label><input id="nb-tp1" value="20/50"></div><div class="field" style="flex:1"><label>TP2 % / share</label><input id="nb-tp2" value="50/50"></div><div class="field" style="flex:1"><label>Trail stop %</label><input id="nb-ssl" inputmode="decimal" value="15"></div></div></div>' +
      '<div id="nb-adv-signal"><div class="row" style="gap:8px"><div class="field" style="flex:1"><label>Max concurrent</label><input id="nb-conc" inputmode="numeric" value="3"></div><div class="field" style="flex:1"><label>Per-token $</label><input id="nb-per" inputmode="decimal" value="40"></div><div class="field" style="flex:1"><label>Min score</label><input id="nb-score" inputmode="decimal" value="50"></div></div>' +
      '<div class="field" id="nb-rank-wrap"><label>Rank candidates by</label><select id="nb-rank"><option value="score">Safety-weighted score (default)</option><option value="buzz">Online buzz — search trends, trending pools, buyer traffic</option></select><div class="dim" style="font-size:12px;margin-top:4px" id="nb-rank-hint"></div></div></div>' +
      '</div></details>' +
      '<div class="banner warn" id="nb-risk" style="display:none"><span>' + ic('warn', 18) + '</span><div id="nb-risk-t"></div></div>' +
      '<button class="btn primary wide" id="nb-go" style="margin-top:12px">' + mi('launch', 15) + ' Launch (paper)</button>' +
      '<button class="btn wide" id="nb-backtest" style="margin-top:8px;display:none">' + mi('bars', 15) + ' Backtest this config</button>' +
      '<div id="nb-bt-out" class="muted" style="margin-top:10px;font-size:13px"></div>');
    $('#nb-x').onclick = closeSheet;
    var _renderedStrat = null;
    function readKnobs() { var cfg = {}; $$('#nb-adv-indicator .nb-knob').forEach(function (el) { var k = el.getAttribute('data-knob'); var n = Number(el.value); cfg[k] = isFinite(n) && el.value !== '' ? n : el.value; }); return cfg; }
    function renderKnobs(type) {
      var box = $('#nb-adv-indicator'); if (!box) return;
      var s = regStrategy(type);
      if (!s) { box.innerHTML = ''; box.style.display = 'none'; _renderedStrat = null; return; }
      var keys = regKnobKeys(s), d = s.defaults || {}, rows = '';
      for (var i = 0; i < keys.length; i += 3) {
        rows += '<div class="row" style="gap:8px">' + keys.slice(i, i + 3).map(function (k) {
          return '<div class="field" style="flex:1"><label>' + esc(knobLabel(k)) + '</label><input class="nb-knob" data-knob="' + esc(k) + '" inputmode="decimal" value="' + esc(String(d[k])) + '"></div>';
        }).join('') + '</div>';
      }
      box.innerHTML = rows;
      box.style.display = '';
      _renderedStrat = type;
    }
    function fillHeld() {
      var lane = $('#nb-lane').value, sel = $('#nb-held'); if (!sel) return;
      sel.innerHTML = '<option value="">from your wallet…</option>';
      var l = lanes.filter(function (x) { return x.id === lane; })[0]; if (!l) return;
      Wiring.getHoldings(l.chain).then(function (rows) {
        (rows || []).forEach(function (r) {
          var a = r.asset || {}; var sym = (a.symbol || '').toUpperCase(); if (!sym || a.kind === 'native' || sym === l.base) return;
          var amt = r.display != null ? numVal(r.display) : baseToNum(r.confirmed, a.decimals || 0);
          if (!(amt > 0)) return;
          try { var pf = Wiring.prices && Wiring.prices(); if (pf) pf.remember(sym, Object.assign({ chain: l.chain }, a)); } catch (_) {}
          var o = document.createElement('option'); o.value = sym + '/' + l.base; o.textContent = sym + ' · ' + fmtAmt(amt, 4); sel.appendChild(o);
        });
      }).catch(function () {});
    }
    function syncUi() {
      var type = $('#nb-type').value, lane = $('#nb-lane').value, mode = $('#nb-mode').value;
      var base = laneBase(lane);
      var isReg = isRegType(type);
      $('#nb-lane-hint').textContent = ({ auto: 'Runs every algorithm on ' + laneLabel(lane) + ' and shifts budget to whichever is winning.', signal: 'Auto-finds tokens on ' + laneLabel(lane) + ', quoted in ' + base + '.', scanner: 'Scans every pair it can see on ' + laneLabel(lane) + '.', dca: 'Ladders into a ' + laneLabel(lane) + ' token.', grid: 'Runs the grid on a ' + laneLabel(lane) + ' token.', smarttrade: 'One managed position on ' + laneLabel(lane) + '.' })[type] || (isReg ? 'Runs on one ' + laneLabel(lane) + ' pair, quoted in ' + base + '.' : '');
      if ($('#nb-strat-help')) $('#nb-strat-help').textContent = isReg ? regDescribe(type) : '';
      if (isReg && _renderedStrat !== type) renderKnobs(type);
      else if (!isReg && _renderedStrat) renderKnobs(null);
      if ($('#nb-backtest')) $('#nb-backtest').style.display = isReg ? '' : 'none';
      if (!isReg) { $('#nb-bt-out').innerHTML = ''; }
      $('#nb-pair').placeholder = 'SYMBOL/' + base;
      var needsPair = (type === 'dca' || type === 'grid' || type === 'smarttrade' || isReg);
      $('#nb-pair-wrap').style.display = needsPair ? '' : 'none';
      if (needsPair && (!$('#nb-pair').value || /\/[A-Z]+$/.test($('#nb-pair').value))) $('#nb-pair').value = ($('#nb-pair').value.split('/')[0] || 'TOKEN') + '/' + base;
      $('#nb-adv-dca').style.display = (type === 'dca' || type === 'signal') ? '' : 'none';
      $('#nb-candle-wrap').style.display = (type === 'dca' || type === 'signal' || type === 'smarttrade') ? '' : 'none';
      $('#nb-adv-grid').style.display = type === 'grid' ? '' : 'none';
      $('#nb-adv-smart').style.display = type === 'smarttrade' ? '' : 'none';
      $('#nb-adv-signal').style.display = (type === 'signal' || type === 'scanner') ? '' : 'none';
      if ($('#nb-rank-wrap')) $('#nb-rank-wrap').style.display = type === 'signal' ? '' : 'none';
      if ($('#nb-rank-hint')) $('#nb-rank-hint').textContent = ($('#nb-rank') && $('#nb-rank').value === 'buzz')
        ? 'Ranks by attention × velocity × exit depth. Attention = CoinGecko search trending, GeckoTerminal trending pools & unique buyers, DexScreener boosts. Not Twitter/Telegram engagement. Same rug gate and risk preset still apply.'
        : '';
      if (type === 'auto') { $('#nb-adv-dca').style.display = 'none'; }
      var risky = (mode === 'high' || mode === 'sniper');
      $('#nb-risk').style.display = risky ? '' : 'none';
      if (risky) $('#nb-risk-t').innerHTML = mode === 'sniper'
        ? 'Sniper trades <b>brand-new</b> microcaps the moment they clear the rug/liquidity gate. Most go to zero — the max-loss rail is your seatbelt.'
        : 'High mode trades volatile microcaps driven by social hype. Higher upside, much higher risk of loss.';
    }
    $('#nb-type').onchange = syncUi; $('#nb-lane').onchange = function () { syncUi(); fillHeld(); }; $('#nb-mode').onchange = syncUi; if ($('#nb-rank')) $('#nb-rank').onchange = syncUi;
    $('#nb-held').onchange = function () { if ($('#nb-held').value) $('#nb-pair').value = $('#nb-held').value; };
    $('#nb-backtest').onclick = function () {
      var type = $('#nb-type').value; if (!isRegType(type)) return;
      var lane = $('#nb-lane').value, base = laneBase(lane);
      var pair = ($('#nb-pair').value || '').trim().toUpperCase();
      var asset = (pair.split('/')[0]) || base;
      var out = $('#nb-bt-out'); out.innerHTML = '<span class="dim">Backtesting on recent prices…</span>';
      var hdr = { accept: 'application/json', 'content-type': 'application/json' }; if (S.csrf) hdr['x-csrf-token'] = S.csrf;
      var btBudget = Number(($('#nb-budget') || {}).value) || 1000; // the single budget field drives budgetUsd (hidden as a knob)
      fetch(ACCOUNTS + '/backtest', { method: 'POST', headers: hdr, credentials: 'include', body: JSON.stringify({ type: serverBotType(type), params: regParamsToServer(Object.assign(readKnobs(), { budgetUsd: btBudget })), asset: asset }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .then(function (res) {
          var pnl = Number(res.pnlPct) || 0, dd = Number(res.maxDrawdownPct) || 0;
          out.innerHTML = '<b class="num ' + (pnl >= 0 ? 'good' : 'bad') + '" style="font-size:16px">' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%</b> <span class="dim">· ' + (res.trades || 0) + ' trades · max drawdown ' + dd.toFixed(1) + '%</span>' +
            (res.curve && res.curve.length > 2 ? '<div style="height:46px;margin-top:6px">' + sparkSvg(res.curve, 300, 46) + '</div>' : '') +
            '<div class="dim" style="font-size:11px;margin-top:4px">Play-money simulation on recent real ' + esc(asset) + ' prices.</div>';
        })
        .catch(function (e) { out.innerHTML = '<span class="bad">Backtest unavailable: ' + esc(e.message || e) + '</span>'; });
    };
    function selectHasOption(sel, val) { for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === val) return true; return false; }
    function applyPrefill(pf) {
      if (!pf) return;
      try {
        var sel = $('#nb-type');
        var want = pf.strategy ? regBotType(pf.strategy) : null; // map server→registry name
        var matched = false;
        if (want && selectHasOption(sel, want)) { sel.value = want; matched = true; }
        else if (pf.strategy && selectHasOption(sel, pf.strategy)) { sel.value = pf.strategy; matched = true; }
        // A copied bot whose strategy isn't offered here (e.g. scalp/martingale or a
        // multi-asset planner) can't be prefilled — say so instead of silently doing nothing.
        if (pf.strategy && !matched) { toast('Can\'t prefill a "' + pf.strategy + '" bot here — that strategy isn\'t available in this wallet. Configure a new bot manually.', 'bad'); }
        syncUi();
        if (pf.pair) { $('#nb-pair').value = String(pf.pair).toUpperCase(); }
        if (pf.params) {
          var regp = serverParamsToReg(pf.params);
          $$('#nb-adv-indicator .nb-knob').forEach(function (el) { var k = el.getAttribute('data-knob'); if (regp[k] != null) el.value = regp[k]; });
        }
      } catch (_) {}
    }
    syncUi(); fillHeld(); applyPrefill(prefill);
    $('#nb-go').onclick = function () {
      var type = $('#nb-type').value, lane = $('#nb-lane').value, mode = $('#nb-mode').value;
      var base = laneBase(lane);
      var num = function (id, d) { var n = Number(($(id) || {}).value); return isFinite(n) ? n : d; };
      var isReg = isRegType(type);
      var needsPair = (type === 'dca' || type === 'grid' || type === 'smarttrade' || isReg);
      var pair = needsPair ? (($('#nb-pair').value || ('TOKEN/' + base)).trim().toUpperCase()) : null;
      if (needsPair && (/^TOKEN\//.test(pair) || pair.indexOf('/') < 0)) { toast('Pick or type the token to trade', 'bad'); return; }
      var budget = num('#nb-budget', 0);
      if (!(budget > 0)) { toast('Set a paper budget (USD)', 'bad'); return; }
      var typeName = { auto: 'Full Auto', signal: 'SIGNAL', scanner: 'AUTOPILOT', dca: 'DCA', grid: 'GRID', smarttrade: 'SMART' }[type] || regLabel(type);
      var name = ($('#nb-name').value || '').trim() || (typeName + ' · ' + laneLabel(lane));
      var candleCfg = { enabled: (($('#nb-candle') || {}).value || 'on') === 'on', sec: num('#nb-csec', 120), minProfitPct: num('#nb-cmin', 2) };
      var dcaCfg = { baseOrderUsd: num('#nb-base', 30), safetyOrderUsd: num('#nb-base', 30), maxSafetyOrders: num('#nb-so', 3), safetyStepPct: num('#nb-step', 3), safetyVolumeScale: 1.2, takeProfitPct: num('#nb-tp', 6), trailingTpPct: num('#nb-trail', 2), stopLossPct: num('#nb-sl', 15), startCondition: ($('#nb-start') || {}).value || 'asap', dipPct: num('#nb-dip', 2), maxDealSec: Math.round(num('#nb-tstop', 48) * 3600), candle: candleCfg };
      var tpOf = function (id, dPct, dShare) { var p = String(($(id) || {}).value || '').split('/'); return { pct: Number(p[0]) || dPct, sharePct: Number(p[1]) || dShare }; };
      var config;
      if (isReg) config = Object.assign(readKnobs(), { market: pair, budgetUsd: budget }); // single budget drives the planner size
      else if (type === 'dca') config = dcaCfg;
      else if (type === 'grid') config = { autoRangePct: num('#nb-range', 6), gridCount: num('#nb-rungs', 10), totalUsd: budget, stopLossPct: num('#nb-gsl', 12) };
      else if (type === 'smarttrade') config = { amountUsd: num('#nb-amt', 50), takeProfits: [tpOf('#nb-tp1', 20, 50), tpOf('#nb-tp2', 50, 50)], stopLoss: { pct: num('#nb-ssl', 15), trailing: true }, candle: candleCfg };
      else if (type === 'signal') config = Object.assign({ source: 'discovery', maxConcurrent: num('#nb-conc', 3), minScore: Math.max(0, Math.min(1, num('#nb-score', 50) / 100)), onSignal: { type: 'dca', config: Object.assign({}, dcaCfg, { baseOrderUsd: num('#nb-per', 40), safetyOrderUsd: num('#nb-per', 40) }) } }, (($('#nb-rank') || {}).value === 'buzz') ? { rank: 'buzz' } : {});
      else if (type === 'auto') config = { rebalanceSec: 900 };
      else config = { minProfitBps: 30, maxConcurrentPairs: num('#nb-conc', 3), perTradeUsd: num('#nb-per', 40), strategies: ['arbitrage', 'momentum', 'grid'], gasBufferUsd: 1, slippageBps: 15, agentFeeBps: 5 };
      var where = ($('#nb-where') || {}).value || 'device';
      var spec = { name: name, type: type, lane: lane, riskMode: mode, profitMode: $('#nb-profit').value, universe: { pairs: pair ? [pair] : [] }, config: config,
        risk: { maxLossPct: num('#nb-maxloss', 25), paperSlippageBps: num('#nb-slip', 25) }, pollSec: Math.max(5, num('#nb-poll', 20)), mode: 'paper', network: 'testnet' };
      if (where === 'cloud' && S.user) { closeSheet(); launchCloud(spec, budget, name); return; }
      ensureBotRunner().then(function (runner) {
        var bots = runner.store.all();
        if (!isPro() && bots.length >= 1) { closeSheet(); toast('Free plan allows 1 bot on this device — upgrade for more', 'bad'); location.hash = '#pro'; return; }
        try {
          var bot = runner.add(spec);
          runner.enablePaper(bot.id, { allocationUsd: budget }).then(function () {
            toast(name + ' launched · $' + budget + ' paper on ' + laneLabel(lane), 'good', 'launch');
            closeSheet(); renderBotList();
            runner.tickNow(bot.id).then(function () { renderBotList(); }).catch(function () {});
          }).catch(function (e) { toast('Start failed: ' + (e.message || e), 'bad'); closeSheet(); renderBotList(); });
        } catch (e) { toast('Create failed: ' + (e.message || e), 'bad'); }
      }).catch(function () { toast('Bots engine unavailable', 'bad'); });
    };
  }
  function armLiveSheet(id) {
    // Free may arm up to its liveBotLimit (=1). The bot-runner's per-tier cap
    // (Free 1 / Copilot 3 / Pro unlimited) is the single enforcement + upsell —
    // do NOT hard-gate behind isPro() here or Free gets 0 live bots.
    var bot = S.botRunner && S.botRunner.store.get(id); var lane = (bot && bot.lane) || 'block'; var base = laneBase(lane);
    openSheet('<div class="spread"><h2>Arm live trading</h2><button class="btn sm ghost" id="al-x">' + ic('close', 15) + '</button></div>' +
      '<div class="banner warn"><span>' + ic('warn', 18) + '</span><div>Live bots trade real funds <b>within the allocation cap</b> with no per-order tap. They still obey session caps, the allowlist, the kill switch, the max-loss rail and the 0.05% fee. Mainnet stays off; this runs on testnet until you enable mainnet in settings.</div></div>' +
      '<div style="background:rgba(255,99,99,.12);border:1px solid var(--bad);border-radius:12px;padding:10px 12px;margin-top:10px;font-size:13px;line-height:1.45"><b>' + mi('live', 14) + ' Keep this page open.</b> A live bot trades only while the wallet is open on this device — your keys never leave it. Closing or backgrounding the tab pauses it.</div>' +
      '<div id="al-avail" style="background:var(--card2);border-radius:12px;padding:10px 12px;margin-top:10px;font-size:13px;line-height:1.45"><span class="dim">Checking your ' + esc(base) + ' on ' + esc(laneLabel(lane)) + '…</span></div>' +
      '<div class="field" style="margin-top:12px"><label>Allocation cap (USD)</label><input id="al-alloc" inputmode="decimal" placeholder="50"><div class="hint dim" style="font-size:12px;margin-top:4px" id="al-hint"></div></div>' +
      '<button class="btn primary wide" id="al-go">Arm live</button>');
    $('#al-x').onclick = closeSheet;
    var avail = null;
    laneAvailable(lane).then(function (a) {
      avail = a; var el = $('#al-avail'); if (!el) return;
      var amtTxt = (a.amount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
      el.innerHTML = '<b>Available to trade:</b> <span class="num">' + amtTxt + ' ' + esc(a.base) + '</span>' + (a.usd != null ? ' <span class="dim">(≈ ' + fmtUsd(a.usd) + ')</span>' : '') + ' on ' + esc(laneLabel(lane)) +
        (a.nativeSymbol && String(a.nativeSymbol).toUpperCase() !== String(a.base).toUpperCase() ? '<div class="dim" style="font-size:12px">Gas: ' + (a.nativeAmount || 0).toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' ' + esc(a.nativeSymbol) + '</div>' : '') +
        (!(a.amount > 0) ? '<div class="bad" style="font-size:12px;margin-top:4px">You hold no ' + esc(a.base) + ' on ' + esc(laneLabel(lane)) + ' — the bot will have nothing to buy with. Receive some first.</div>' : '') +
        (a.usd != null && a.usd > 0 ? '<div style="margin-top:6px"><button class="btn sm ghost" id="al-max">Use all ≈ ' + fmtUsd(a.usd) + '</button></div>' : '');
      if ($('#al-max')) $('#al-max').onclick = function () { $('#al-alloc').value = String(Math.floor(a.usd * 100) / 100); hint(); };
      hint();
    }).catch(function (e) { var el = $('#al-avail'); if (el) el.innerHTML = '<span class="dim">Could not read your ' + esc(base) + ' balance on ' + esc(laneLabel(lane)) + ' (' + esc(e && e.message || e) + '). You can still set a cap.</span>'; });
    function hint() {
      var h = $('#al-hint'); if (!h) return; var alloc = Number($('#al-alloc').value);
      if (!(alloc > 0) || !avail || avail.usd == null) { h.textContent = ''; return; }
      h.innerHTML = alloc > avail.usd ? '<span class="bad">Cap is above what you hold (≈ ' + fmtUsd(avail.usd) + ' ' + esc(avail.base) + ') — the bot can only deploy what is there.</span>' : 'Up to ' + Math.round(alloc / avail.usd * 100) + '% of your ' + esc(avail.base) + ' on ' + esc(laneLabel(lane)) + '.';
    }
    $('#al-alloc').oninput = hint;
    $('#al-go').onclick = function () {
      var alloc = Number($('#al-alloc').value); if (!(alloc > 0)) { toast('Set an allocation cap', 'bad'); return; }
      if (avail && !(avail.amount > 0)) { toast('No ' + avail.base + ' on ' + laneLabel(lane) + ' to trade with', 'bad'); return; }
      S.botRunner.armLive(id, { allocationUsd: alloc }).then(function () { toast('Bot armed live (within $' + alloc + ') — keep this page open', 'good', 'live'); closeSheet(); _botListSig = ''; renderBotList(); }).catch(function (e) { toast('Arm failed: ' + (e.message || e), 'bad'); });
    };
  }
  function openArena() {
    openSheet('<div class="spread"><h2>' + ic('arena', 18) + ' Arena</h2><button class="btn sm ghost" id="ar-x">' + ic('close', 15) + '</button></div>' +
      '<p class="muted" style="margin:8px 0">Backtest a strategy on play-money scenarios — bull, crab, bear, crash, pump. No funds, no gate, pure practice.</p>' +
      '<div class="field"><label>Strategy</label><select id="ar-type"><option value="dca">DCA</option><option value="grid">Grid</option><option value="smarttrade">Smart trade</option></select></div>' +
      '<div class="field"><label>Scenario</label><select id="ar-sc"><option>bull</option><option>crab</option><option>bear</option><option>crash</option><option>pump</option></select></div>' +
      '<button class="btn primary wide" id="ar-go">Run scenario</button><div id="ar-out" class="muted" style="margin-top:12px;font-size:13px"></div>');
    $('#ar-x').onclick = closeSheet;
    $('#ar-go').onclick = function () {
      if (!window.AgentArena) { $('#ar-out').textContent = 'Arena module not loaded.'; return; }
      $('#ar-out').textContent = 'Arena is ready — vectors load from the live scenario set. Use the bots tab to deploy a practiced strategy as a paper bot.';
    };
  }

  /* ---------------- MOON — tap-to-buy BLOCK-20 tokens (docs/MOONSHOT.md) ---------------- */
  var MOON = { tab: 'trending', feed: null, positions: {}, blockBal: 0, blockUsd: null };
  function sparkSvg(points, w, h) {
    var ps = (points || []).map(Number).filter(isFinite); if (ps.length < 2) return '';
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps); if (hi === lo) { lo = lo * 0.98; hi = hi * 1.02 || 1; }
    var up = ps[ps.length - 1] >= ps[0];
    var d = ps.map(function (p, i) { return (i ? 'L' : 'M') + (i / (ps.length - 1) * w).toFixed(1) + ',' + (h - (p - lo) / (hi - lo) * (h - 4) - 2).toFixed(1); }).join('');
    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + '" fill="none" stroke="' + (up ? '#2ecc71' : '#ff6b6b') + '" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  }
  function pctChip(v) { if (v == null || !isFinite(Number(v))) return '<span class="dim">—</span>'; var n = Number(v); return '<span class="pct ' + (n >= 0 ? 'pos' : 'neg') + ' num">' + (n >= 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 100 ? 0 : 1) + '%</span>'; }
  function fmtPrice(u) { var n = Number(u); if (!isFinite(n) || n <= 0) return '—'; return '$' + (n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n >= 0.01 ? n.toFixed(4) : n.toPrecision(3)); }
  function moonRefreshWallet() {
    return Promise.all([
      blockSpendableBase(Wallet.address).then(function (b) { MOON.blockBal = b / COIN; }).catch(function () {}),
      Wiring.moon.positions().then(function (p) { MOON.positions = p || {}; }).catch(function () {}),
    ]);
  }
  VIEWS.moon = function (v) {
    v.innerHTML = '<div class="card"><div class="spread"><div><div class="dim">Your BLOCK</div><div class="hero-bal num" id="mn-bal">—</div><div class="dim" style="font-size:12px" id="mn-balusd"></div></div><div class="col" style="align-items:flex-end;gap:6px"><a class="btn primary sm" href="/buy" target="_blank">Get BLOCK</a><a class="btn sm ghost" href="#receive">Receive</a></div></div></div>' +
      '<div class="card"><div class="sechead"><h2>' + mi('launch', 17) + ' Moon</h2><span class="dim" style="font-size:12px" id="mn-meta"></span></div>' +
      '<div class="tabs" id="mn-tabs"><div class="tab" data-t="trending">Trending</div><div class="tab" data-t="new">New</div><div class="tab" data-t="gainers">Gainers</div><div class="tab" data-t="bags">My bags</div></div>' +
      '<div id="mn-list" class="list"><div class="empty">Loading the feed…</div></div>' +
      '<p class="dim" style="font-size:12px;margin-top:10px">Tap a token to buy with BLOCK in one step. Trades run on the native AMM, signed on your device. Microcaps can go to zero — never ape more than you can lose.</p></div>';
    $$('#mn-tabs .tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-t') === MOON.tab); t.onclick = function () { MOON.tab = t.getAttribute('data-t'); $$('#mn-tabs .tab').forEach(function (x) { x.classList.toggle('active', x === t); }); renderMoonList(); }; });
    moonRefreshWallet().then(renderMoonHeader);
    loadMoonFeed();
  };
  function renderMoonHeader() {
    if (!$('#mn-bal')) return;
    $('#mn-bal').textContent = fmtAmt(MOON.blockBal, 4) + ' BLOCK';
    if (MOON.blockUsd > 0) $('#mn-balusd').textContent = '≈ ' + fmtUsd(MOON.blockBal * MOON.blockUsd) + ' · BLOCK ' + fmtPrice(MOON.blockUsd);
  }
  function loadMoonFeed() {
    Wiring.moon.feed('trending').then(function (feed) {
      MOON.feed = feed; MOON.blockUsd = feed.blockUsd || MOON.blockUsd;
      if ($('#mn-meta')) $('#mn-meta').textContent = (feed.count || 0) + ' tokens · block ' + (feed.height || '—');
      renderMoonHeader(); renderMoonList();
    }).catch(function () { if ($('#mn-list')) $('#mn-list').innerHTML = '<div class="empty">Feed unavailable right now.</div>'; });
  }
  function renderMoonList() {
    var box = $('#mn-list'); if (!box || !MOON.feed) return;
    var rows = Moon.rank(MOON.feed.tokens || [], MOON.tab === 'bags' ? 'trending' : MOON.tab);
    if (MOON.tab === 'bags') rows = rows.filter(function (t) { var p = MOON.positions[String(t.contract).toLowerCase()]; return p && Number(p.qty) > 0; });
    if (!rows.length) { box.innerHTML = '<div class="empty">' + (MOON.tab === 'bags' ? 'No bags yet. Buy something from Trending to start one.' : 'No tokens with a live pool yet.') + '</div>'; return; }
    box.innerHTML = rows.map(function (t) {
      var pos = MOON.positions[String(t.contract).toLowerCase()];
      var pnl = pos ? Moon.pnl(pos, t.priceBlock, MOON.blockUsd) : null;
      var ico = t.logo ? '<img src="' + esc(t.logo) + '" alt="">' : '';
      return '<div class="li moonrow" data-cid="' + esc(t.contract) + '"><span class="ico">' + esc(String(t.symbol || '?').slice(0, 1)) + ico + '</span>' +
        '<span class="col" style="align-items:flex-start;min-width:0"><b>' + esc(t.symbol || '?') + ' <span class="dim" style="font-weight:500;font-size:12px">' + esc(t.name || '') + '</span></b>' +
        '<span class="dim" style="font-size:12px">liq ' + fmtAmt(t.liquidityBlock, 0) + ' BLOCK' + (t.lpLocked ? ' · ' + mi('lock', 12) : ' · unlocked') + (t.ageBlocks != null && t.ageBlocks < 144 ? ' · ' + mi('seed', 12) + ' new' : '') + (pnl && pnl.qty > 0 ? ' · bag ' + fmtAmt(pnl.qty, 2) + (pnl.unrealizedPct != null ? ' (' + Moon.fmtPct(pnl.unrealizedPct) + ')' : '') : '') + '</span></span>' +
        '<span style="width:72px;flex:none">' + sparkSvg(t.spark, 72, 36) + '</span>' +
        '<span class="col" style="align-items:flex-end;flex:none"><b class="num">' + fmtPrice(t.priceUsd) + '</b>' + pctChip(t.change24hPct) + '</span></div>';
    }).join('');
    $$('#mn-list .moonrow').forEach(function (r) { r.onclick = function () { moonTokenSheet(r.getAttribute('data-cid')); }; });
  }
  function moonTokenSheet(cid) {
    var t = (MOON.feed && MOON.feed.tokens || []).filter(function (x) { return String(x.contract).toLowerCase() === String(cid).toLowerCase(); })[0];
    if (!t) return;
    var pool = { blockReserve: t.blockReserve, tokenReserve: t.tokenReserve, decimals: t.decimals, poolFeeBps: t.poolFeeBps };
    var warns = Moon.warnings(t);
    var state = { usd: 20, pct: 50, held: '0', side: 'buy' };
    openSheet('<div class="spread"><h2>' + (t.logo ? '<img src="' + esc(t.logo) + '" alt="" style="width:26px;height:26px;border-radius:7px;vertical-align:middle;margin-right:6px">' : '') + esc(t.symbol || '?') + ' <span class="dim" style="font-size:13px;font-weight:500">' + esc(t.name || '') + '</span></h2><button class="btn sm ghost" id="mt-x">' + ic('close', 15) + '</button></div>' +
      '<div class="spread" style="margin:8px 0 4px"><div><div class="hero-bal num" style="font-size:30px">' + fmtPrice(t.priceUsd) + '</div><div class="dim" style="font-size:12px">' + fmtAmt(t.priceBlock, 8) + ' BLOCK</div></div><div class="col" style="align-items:flex-end;font-size:13px"><span>1h ' + pctChip(t.change1hPct) + '</span><span>24h ' + pctChip(t.change24hPct) + '</span><span>7d ' + pctChip(t.change7dPct) + '</span></div></div>' +
      '<div style="height:70px;margin:6px 0">' + (sparkSvg(t.spark, 320, 70) || '<div class="dim" style="font-size:12px">Chart fills in as 15-minute snapshots record.</div>') + '</div>' +
      '<div class="list" style="margin-bottom:10px"><div class="kv"><span class="muted">Liquidity</span><span class="mono num">' + fmtAmt(t.liquidityBlock, 1) + ' BLOCK' + (t.liquidityUsd ? ' ≈ ' + fmtUsd(t.liquidityUsd) : '') + '</span></div>' +
      '<div class="kv"><span class="muted">LP lock</span><span class="mono">' + (t.lpLocked ? mi('lock', 13) + ' ' + t.lockDaysLeft + 'd left' : 'unlocked') + '</span></div>' +
      '<div class="kv"><span class="muted">Age</span><span class="mono num">' + (t.ageBlocks != null ? (t.ageBlocks < 144 ? Math.round(t.ageBlocks * 10 / 60) + 'h' : Math.round(t.ageBlocks / 144) + 'd') : '—') + '</span></div>' +
      '<div class="kv"><span class="muted">Contract</span><button class="btn sm ghost" id="mt-copy">' + esc(shortAddr(t.contract)) + ' ' + ic('copy', 13) + '</button></div></div>' +
      (warns.length ? '<div class="banner ' + (warns.some(function (w) { return w.code === 'danger'; }) ? 'danger' : 'warn') + '"><span>' + ic('warn', 18) + '</span><div>' + warns.map(function (w) { return esc(w.text); }).join('<br>') + '</div></div>' : '') +
      '<div id="mt-pos" class="list" style="margin:10px 0"></div>' +
      '<div class="tabs"><div class="tab active" data-s="buy">Buy</div><div class="tab" data-s="sell">Sell</div></div>' +
      '<div id="mt-buy"><div class="row" style="gap:6px;margin-bottom:8px">' + Moon.PRESETS_USD.map(function (u) { return '<button class="btn sm preset' + (u === state.usd ? ' on' : '') + '" data-usd="' + u + '">$' + u + '</button>'; }).join('') + '</div>' +
      '<div class="field"><label>Amount (USD)</label><input id="mt-usd" inputmode="decimal" value="' + state.usd + '"></div><div id="mt-q" class="muted" style="font-size:13px;min-height:36px"></div><button class="btn primary wide" id="mt-go">' + mi('launch', 15) + ' Buy ' + esc(t.symbol || '') + '</button></div>' +
      '<div id="mt-sell" style="display:none"><div class="row" style="gap:6px;margin-bottom:8px">' + [25, 50, 75, 100].map(function (p) { return '<button class="btn sm preset' + (p === state.pct ? ' on' : '') + '" data-pct="' + p + '">' + p + '%</button>'; }).join('') + '</div>' +
      '<input type="range" id="mt-range" class="rangebar" min="1" max="100" value="' + state.pct + '"><div id="mt-sq" class="muted" style="font-size:13px;min-height:36px"></div><button class="btn primary wide" id="mt-sgo">Sell</button></div>' +
      '<p class="dim" style="font-size:11px;margin-top:10px">1% slippage · 0.3% pool fee · gas in BLOCK. Buys above 15% price impact are refused.</p>');
    $('#mt-x').onclick = closeSheet;
    $('#mt-copy').onclick = function () { copy(t.contract); };
    function renderPos() {
      Chain.token(t.contract, Wallet.address).then(function (info) {
        var held = String((info && (info.holderBalance != null ? info.holderBalance : info.balance)) || '0');
        state.held = held;
        var pos = MOON.positions[String(t.contract).toLowerCase()];
        var pnl = Moon.pnl(pos || { qty: '0', costBlock: '0', costUsd: 0, decimals: t.decimals }, t.priceBlock, MOON.blockUsd, held);
        var box = $('#mt-pos'); if (!box) return;
        if (!(pnl.qty > 0)) { box.innerHTML = ''; return; }
        box.innerHTML = '<div class="kv"><span class="muted">Your bag</span><span class="mono num">' + fmtAmt(pnl.qty, 4) + ' ' + esc(t.symbol || '') + ' ≈ ' + fmtAmt(pnl.valueBlock, 4) + ' BLOCK' + (pnl.valueUsd != null ? ' / ' + fmtUsd(pnl.valueUsd) : '') + '</span></div>' +
          (pnl.untracked ? '<div class="kv"><span class="muted">P&amp;L</span><span class="dim">bought outside Moon — no cost basis</span></div>' :
            '<div class="kv"><span class="muted">P&amp;L</span><span class="mono num ' + pnlClass(pnl.unrealizedBlock) + '">' + (pnl.unrealizedUsd != null ? fmtSigned(pnl.unrealizedUsd) + ' · ' : '') + Moon.fmtPct(pnl.unrealizedPct) + '</span></div>');
        sellQuote();
      }).catch(function () {});
    }
    function buyQuote() {
      var usd = Number($('#mt-usd').value); state.usd = usd;
      var q = Moon.quoteBuyUsd(usd, MOON.blockUsd, pool), box = $('#mt-q'), go = $('#mt-go');
      if (!q) { box.textContent = MOON.blockUsd > 0 ? 'Enter an amount.' : 'BLOCK price unavailable.'; go.disabled = true; return; }
      state.q = q;
      var short = q.blockIn > MOON.blockBal;
      box.innerHTML = 'Pay <b class="num">' + fmtAmt(q.blockIn, 4) + ' BLOCK</b> → get ≈ <b class="num">' + fmtAmt(q.tokensOut, 2) + ' ' + esc(t.symbol || '') + '</b><br><span class="dim">min ' + fmtAmt(Number(q.minOut) / Math.pow(10, t.decimals), 2) + ' · impact ' + (q.impactPct != null ? q.impactPct.toFixed(2) + '%' : '—') + '</span>' +
        (short ? '<br><span class="bad">You need ' + fmtAmt(q.blockIn - MOON.blockBal, 4) + ' more BLOCK.</span>' : '') + (q.tooBig ? '<br><span class="bad">Too big for this pool — lower the amount.</span>' : '');
      go.disabled = short || q.tooBig;
    }
    function sellQuote() {
      var pct = Number($('#mt-range').value); state.pct = pct;
      var amt = Moon.fractionOf(state.held, pct);
      var q = Moon.quoteSell(amt, MOON.blockUsd, pool), box = $('#mt-sq'), go = $('#mt-sgo');
      if (!q) { box.textContent = BigInt(state.held || '0') > 0n ? 'Move the slider.' : 'Nothing to sell yet.'; go.disabled = true; return; }
      state.sq = q;
      box.innerHTML = 'Sell <b class="num">' + fmtAmt(q.tokensIn, 2) + ' ' + esc(t.symbol || '') + '</b> (' + pct + '%) → get ≈ <b class="num">' + fmtAmt(q.blockOut, 4) + ' BLOCK</b>' + (q.usdOut != null ? ' / ' + fmtUsd(q.usdOut) : '') + '<br><span class="dim">impact ' + (q.impactPct != null ? q.impactPct.toFixed(2) + '%' : '—') + '</span>' + (q.tooBig ? '<br><span class="bad">Too big for this pool — sell in pieces.</span>' : '');
      go.disabled = q.tooBig;
    }
    $$('#mt-buy [data-usd]').forEach(function (b) { b.onclick = function () { $$('#mt-buy .preset').forEach(function (x) { x.classList.toggle('on', x === b); }); $('#mt-usd').value = b.getAttribute('data-usd'); buyQuote(); }; });
    $$('#mt-sell [data-pct]').forEach(function (b) { b.onclick = function () { $$('#mt-sell .preset').forEach(function (x) { x.classList.toggle('on', x === b); }); $('#mt-range').value = b.getAttribute('data-pct'); sellQuote(); }; });
    $('#mt-usd').oninput = buyQuote; $('#mt-range').oninput = sellQuote;
    $$('#sheet .tab').forEach(function (tab) { tab.onclick = function () { $$('#sheet .tab').forEach(function (x) { x.classList.toggle('active', x === tab); }); var s = tab.getAttribute('data-s'); $('#mt-buy').style.display = s === 'buy' ? '' : 'none'; $('#mt-sell').style.display = s === 'sell' ? '' : 'none'; }; });
    $('#mt-go').onclick = function () { moonExecute(t, state.q, 'buy'); };
    $('#mt-sgo').onclick = function () { moonExecute(t, state.sq, 'sell'); };
    buyQuote(); renderPos();
  }
  function moonExecute(t, q, side) {
    if (!q) return;
    (async function () {
      var lines = side === 'buy'
        ? [['Buy', '≈ ' + fmtAmt(q.tokensOut, 2) + ' ' + (t.symbol || '')], ['Pay', fmtAmt(q.blockIn, 4) + ' BLOCK' + (q.usdIn != null ? ' (' + fmtUsd(q.usdIn) + ')' : '')], ['Min received', fmtAmt(Number(q.minOut) / Math.pow(10, t.decimals), 2)], ['Price impact', (q.impactPct || 0).toFixed(2) + '%']]
        : [['Sell', fmtAmt(q.tokensIn, 2) + ' ' + (t.symbol || '')], ['Receive', '≈ ' + fmtAmt(q.blockOut, 4) + ' BLOCK' + (q.usdOut != null ? ' (' + fmtUsd(q.usdOut) + ')' : '')], ['Min received', fmtAmt(Number(q.minOut) / COIN, 4) + ' BLOCK'], ['Price impact', (q.impactPct || 0).toFixed(2) + '%']];
      var warns = Moon.warnings(t).map(function (w) { return w.text; });
      var ok = await confirmSheet({ title: (side === 'buy' ? 'Buy ' : 'Sell ') + (t.symbol || ''), subtitle: 'Native AMM swap, signed on this device.', lines: lines, warnings: warns, danger: warns.some(function (w) { return /do not buy/i.test(w); }), okText: side === 'buy' ? 'Buy now' : 'Sell now' });
      if (!ok) { moonTokenSheet(t.contract); return; }
      var prevChain = S.chain; S.chain = 'block';
      try {
        if (!(await ensureGas())) { S.chain = prevChain; moonTokenSheet(t.contract); return; }
        toast('Signing…');
        var r = await Wiring.moon.execute(q, t);
        toast((side === 'buy' ? 'Bought ' : 'Sold ') + (t.symbol || '') + ' · ' + shortAddr(String((r && r.txid) || '')), 'good', side === 'buy' ? 'launch' : 'money-bag');
        setTimeout(function () { moonRefreshWallet().then(function () { renderMoonHeader(); renderMoonList(); }); }, 2500);
        closeSheet();
      } catch (e) { toast((side === 'buy' ? 'Buy' : 'Sell') + ' failed: ' + (e.message || e), 'bad'); moonTokenSheet(t.contract); }
      finally { S.chain = prevChain; }
    })();
  }

  /* ---------------- PRO ---------------- */
  VIEWS.pro = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>' + ic('pro', 16) + ' Blockle Copilot</h2><span class="chip ' + (S.pro ? 'pro' : '') + '">' + (S.pro ? (S.tier === 'copilot_pro' ? 'Copilot Pro' : S.tier === 'copilot' ? 'Copilot' : 'Copilot') : 'Free') + '</span></div>' +
      '<p class="muted">Your plan is checked live against your Blockle account — no key access, ever. Upgrade unlocks live trading, a bigger agent brain, pro strategies and analytics across every Blockle wallet and the dashboard.</p>' +
      '<div class="overflow"><table class="feat-matrix"><thead><tr><th>Feature</th><th class="c">Free</th><th class="c">Copilot</th><th class="c">Copilot Pro</th></tr></thead><tbody>' +
      featRow('Non-custodial wallet · all chains', '✓', '✓', '✓') +
      featRow('DEX swap · bridge · USDB', '✓', '✓', '✓') +
      featRow('Agent command bar', 'anon brain', 'signed · bigger budget', 'signed · biggest') +
      featRow('Trading bots', 'paper · 1', 'live · 3', 'live · ∞') +
      featRow('Pro strategy templates', '—', '✓', '✓') +
      featRow('Portfolio analytics & P&L history', 'summary', '✓', '✓') +
      featRow('Sponsored gas — swap with no BLOCK', '—', '✓', '✓') +
      featRow('Price alerts · CSV export · custom RPC', '—', '✓', '✓') +
      '</tbody></table></div></div>' +
      '<div id="pro-plans" class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-top:14px"></div>';
    fetch(ACCOUNTS + '/plans', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      var box = $('#pro-plans');
      if (!S.user) { box.innerHTML = '<div class="card"><b>Sign in to upgrade</b><p class="muted" style="font-size:13px">Your Blockle account carries your plan across every wallet.</p><a class="btn primary wide" href="/account/login?next=/wallet%23pro">Sign in / create account</a></div>'; return; }
      var plans = (j && j.plans) || [];
      if (!plans.length) { box.innerHTML = '<div class="card"><b>Paid plans are coming soon.</b><p class="muted" style="font-size:13px">Billing isn\'t enabled on this deployment yet. Everything in Free works today.</p></div>'; return; }
      box.innerHTML = plans.map(function (p) {
        var feat = p.tier === 'copilot_pro';
        return '<div class="planbox ' + (feat ? 'feat' : '') + '"><b>' + esc(p.name) + '</b><div class="price">' + esc((p.ccy || '$') === 'USD' ? '$' + (p.price || '') : (p.price || '')) + '<span class="dim" style="font-size:14px;font-weight:500">/mo</span></div>' +
          '<button class="btn primary wide" data-tier="' + esc(p.tier) + '">' + (S.tier === p.tier ? 'Current plan' : 'Choose ' + esc(p.name)) + '</button></div>';
      }).join('');
      $$('#pro-plans [data-tier]').forEach(function (b) {
        b.onclick = function () {
          var tier = b.getAttribute('data-tier'); if (S.tier === tier) return;
          var hdrs = { 'content-type': 'application/json' };
          if (S.csrf) hdrs['x-csrf-token'] = S.csrf; // cookie-auth mutations require the CSRF token
          fetch(ACCOUNTS + '/subscribe', { method: 'POST', headers: hdrs, credentials: 'include', body: JSON.stringify({ tier: tier }) }).then(function (r) { return r.json(); }).then(function (res) {
            if (res && res.approveUrl) location.href = res.approveUrl;
            else if (res && res.error === 'csrf') toast('Session expired — reload and sign in again', 'bad');
            else toast((res && res.error) || 'Could not start checkout', 'bad');
          }).catch(function () { toast('Checkout unavailable', 'bad'); });
        };
      });
    }).catch(function () { $('#pro-plans').innerHTML = '<div class="card"><span class="muted">Plan info unavailable right now.</span></div>'; });
  };
  function featRow(label, f, p, cp) { var cell = function (x) { return x === '✓' ? mi('check', 14) : x; }; return '<tr><td>' + esc(label) + '</td><td class="c ' + (f === '—' ? 'dim' : '') + '">' + cell(f) + '</td><td class="c good">' + cell(p) + '</td><td class="c good">' + cell(cp) + '</td></tr>'; }

  /* ---------------- EXPORT A PRIVATE KEY (chain-specific, gated) ----------------
   * Reveals ONE chain's private key for the ACTIVE account. Gate: an explicit
   * acknowledgement + a fresh wallet-password check (3 wrong attempts close the
   * sheet). The key stays blurred until the user holds the reveal button, the
   * sheet self-destructs after EXPORT_TTL seconds and the clipboard is wiped
   * CLIP_TTL seconds after a copy. Nothing here logs, stores or sends the key. */
  var EXPORT_CHAINS = [
    { id: 'seed', name: 'Seed phrase', sub: 'Recovery words of this account (or its raw HD seed)' },
    { id: 'evm', name: 'Ethereum & EVM', sub: 'One key for every EVM network (hex)' },
    { id: 'bitcoin', name: 'Bitcoin', sub: 'WIF · Core import file' },
    { id: 'litecoin', name: 'Litecoin', sub: 'WIF · Core import file' },
    { id: 'dogecoin', name: 'Dogecoin', sub: 'WIF · Core import file' },
    { id: 'bitcoincash', name: 'Bitcoin Cash', sub: 'WIF · CashAddr' },
    { id: 'solana', name: 'Solana', sub: 'base58 (Phantom) · JSON array' },
    { id: 'tron', name: 'Tron', sub: 'TronLink key · T-address' },
    { id: 'ton', name: 'TON', sub: 'ed25519 seed · v4R2 address' },
    { id: 'block', name: 'BLOCK', sub: 'ML-DSA-44 secret key (hex)' },
  ];
  var EXPORT_TTL = 60, CLIP_TTL = 30;
  function famOfChain(c) { return (c === 'bitcoin' || c === 'litecoin' || c === 'dogecoin' || c === 'bitcoincash' || c === 'solana' || c === 'tron' || c === 'ton' || c === 'block') ? c : 'evm'; }
  function exportKeySheet() {
    if (!S.unlocked) { toast('Unlock your wallet first', 'bad'); return; }
    var acct = S.account || { id: 'main', label: 'Main' };
    var fams = { block: true, seed: !(acct.source === 'watch' || acct.source === 'key' || acct.source === 'keystore' || acct.source === 'walletdat') };
    (S.chains || []).forEach(function (c) { fams[famOfChain(c)] = true; });
    var list = EXPORT_CHAINS.filter(function (c) { return fams[c.id] && !(acct.source === 'watch' && c.id !== 'block'); });
    var tiles = list.map(function (c) {
      return '<button class="li" data-ek="' + c.id + '" style="width:100%;text-align:left;background:none;border:0;border-bottom:1px solid var(--line);cursor:pointer"><span class="ico">' + ic(c.id === 'block' ? 'shield' : c.id === 'seed' ? 'doc' : 'key', 15) + '</span><span class="col" style="align-items:flex-start"><b>' + esc(c.name) + '</b><span class="dim" style="font-size:12px">' + esc(c.sub) + '</span></span></button>';
    }).join('');
    openSheet('<div class="spread"><h2>Export a private key</h2><button class="btn sm ghost" id="ek-x">' + ic('close', 15) + '</button></div>' +
      '<p class="dim" style="font-size:12px;margin:4px 0 10px">Account: <b>' + esc(acct.label || 'Main') + '</b>. Pick the chain whose key you want to reveal.' + (acct.source === 'watch' ? ' This is a watch-only account — it holds no keys.' : '') + '</p>' +
      '<div class="list">' + tiles + '</div>');
    $('#ek-x').onclick = closeSheet;
    $$('#sheet [data-ek]').forEach(function (b) { b.addEventListener('click', function () { exportKeyGate(b.getAttribute('data-ek'), acct); }); });
  }
  function exportKeyGate(chainId, acct) {
    var meta = EXPORT_CHAINS.filter(function (c) { return c.id === chainId; })[0] || { name: chainId };
    var tries = 0;
    openSheet('<div class="spread"><h2>' + esc(meta.name) + ' key</h2><button class="btn sm ghost" id="ek-x">' + ic('close', 15) + '</button></div>' +
      '<div class="banner danger" style="margin:8px 0 12px"><span>' + ic('shield', 18) + '</span><div><b>DANGER.</b> ' + (chainId === 'seed' ? 'This phrase gives full, irreversible control of EVERY chain in the <b>' + esc(acct.label || 'Main') + '</b> account.' : 'This key gives full, irreversible control of the ' + esc(meta.name) + ' funds in the <b>' + esc(acct.label || 'Main') + '</b> account.') + ' Anyone who sees it can take everything. Never type it into a website or chat — Blockle support will never ask for it.</div></div>' +
      '<label class="row" style="gap:8px;align-items:flex-start;font-size:13px;cursor:pointer"><input type="checkbox" id="ek-ack" style="margin-top:3px"><span>I understand that anyone with this key controls these funds, and nobody is watching my screen.</span></label>' +
      '<div class="field" style="margin-top:10px"><label>Wallet password</label><input id="ek-pw" type="password" autocomplete="current-password" placeholder="Re-enter to confirm it is you"></div>' +
      '<div id="ek-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
      '<button class="btn wide primary" id="ek-go" disabled>Reveal for ' + EXPORT_TTL + ' seconds</button>');
    $('#ek-x').onclick = closeSheet;
    function arm() { $('#ek-go').disabled = !($('#ek-ack').checked && $('#ek-pw').value.length > 0); }
    $('#ek-ack').onchange = arm; $('#ek-pw').oninput = arm;
    $('#ek-pw').onkeydown = function (e) { if (e.key === 'Enter' && !$('#ek-go').disabled) $('#ek-go').click(); };
    $('#ek-go').onclick = function () {
      var pw = $('#ek-pw').value; $('#ek-pw').value = '';
      $('#ek-go').disabled = true; $('#ek-err').textContent = '';
      Wiring.exportKey(chainId, pw).then(function (k) { pw = null; exportKeyReveal(k, meta, acct); }).catch(function (e) {
        pw = null;
        var msg = (e && e.message) || String(e);
        if (/wrong password/i.test(msg)) { tries++; if (tries >= 3) { closeSheet(); toast('Too many wrong passwords — export cancelled', 'bad'); return; } msg = 'Wrong password (' + (3 - tries) + ' attempt' + (3 - tries === 1 ? '' : 's') + ' left)'; }
        $('#ek-err').textContent = msg; $('#ek-ack').checked = false; arm();
      });
    };
  }
  function exportKeyReveal(k, meta, acct) {
    var showAlt = false, left = EXPORT_TTL, timer = null, clipTimer = null;
    var secretBox = 'style="filter:blur(9px);user-select:none;-webkit-user-select:none;word-break:break-all;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:13px;line-height:1.5;transition:filter .15s;min-height:44px"';
    openSheet('<div class="spread"><h2>' + esc(meta.name) + ' key</h2><span class="row" style="gap:8px"><span class="chip" id="ek-ttl">' + left + 's</span><button class="btn sm ghost" id="ek-x">' + ic('close', 15) + '</button></span></div>' +
      '<p class="dim" style="font-size:12px;margin:4px 0 10px">' + esc(acct.label || 'Main') + (k.imported ? ' · imported' : (k.path ? ' · ' + esc(k.path) : '')) + (k.keyCount > 1 ? ' · ' + k.keyCount + ' keys (this is the primary one; the Core file has all of them)' : '') + '</p>' +
      (k.note ? '<div class="banner info" style="margin:0 0 10px"><span>' + ic('shield', 16) + '</span><div style="font-size:12px">' + esc(k.note) + '</div></div>' : '') +
      (k.address ? '<div class="field"><label>Address</label><div class="mono" style="font-size:12px;word-break:break-all">' + esc(k.address) + '</div></div>' : '') +
      (k.passphrase ? '<p class="dim" style="font-size:12px;margin:0 0 8px">This phrase is protected by a passphrase you set at import — the words alone do not reproduce the account.</p>' : '') +
      '<div class="field"><label id="ek-label">' + esc(k.label) + '</label><div id="ek-secret" class="mono" ' + secretBox + '>' + renderSecret(k, false) + '</div></div>' +
      '<div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px"><button class="btn primary" id="ek-hold">Hold to reveal</button><button class="btn ghost" id="ek-copy">Copy (wiped in ' + CLIP_TTL + 's)</button>' +
      (k.alt ? '<button class="btn ghost sm" id="ek-alt">Show ' + esc(k.alt.label) + '</button>' : '') +
      (k.dump ? '<button class="btn ghost sm" id="ek-dl">Download Core import file' + (k.keyCount > 1 ? ' (' + k.keyCount + ' keys)' : '') + '</button>' : '') + '</div>' +
      '<p class="dim" style="font-size:12px;margin-top:10px">The key is blurred until you hold the button, this sheet closes itself when the timer runs out, and the clipboard is cleared ' + CLIP_TTL + ' seconds after a copy. Write it somewhere private and offline.</p>');
    var box = $('#ek-secret');
    function current() { return showAlt && k.alt ? k.alt.secret : k.secret; }
    function renderSecret(kk, alt) { return (!alt && kk.words) ? '<span style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px">' + kk.words.map(function (w, i) { return '<span style="display:flex;gap:6px;align-items:baseline"><span class="dim" style="font-size:11px;min-width:18px;text-align:right">' + (i + 1) + '</span>' + esc(w) + '</span>'; }).join('') + '</span>' : esc(alt && kk.alt ? kk.alt.secret : kk.secret); }
    function wipe() {
      if (timer) { clearInterval(timer); timer = null; }
      if (box) { box.textContent = ''; box = null; }
      k = { address: '', secret: '', keys: [] };
    }
    function reveal(on) { if (!box) return; box.style.filter = on ? 'none' : 'blur(9px)'; box.style.userSelect = on ? 'text' : 'none'; }
    $('#ek-x').onclick = function () { wipe(); closeSheet(); };
    var hold = $('#ek-hold');
    ['pointerdown', 'touchstart'].forEach(function (ev) { hold.addEventListener(ev, function (e) { e.preventDefault(); reveal(true); }, { passive: false }); });
    ['pointerup', 'pointerleave', 'pointercancel', 'touchend', 'touchcancel'].forEach(function (ev) { hold.addEventListener(ev, function () { reveal(false); }); });
    window.addEventListener('blur', function onBlur() { reveal(false); if (!box) window.removeEventListener('blur', onBlur); });
    $('#ek-copy').onclick = function () {
      var v = current(); if (!v) return;
      try {
        navigator.clipboard.writeText(v).then(function () {
          toast('Copied — clipboard clears in ' + CLIP_TTL + 's');
          if (clipTimer) clearTimeout(clipTimer);
          clipTimer = setTimeout(function () { try { navigator.clipboard.writeText(''); } catch (_) {} }, CLIP_TTL * 1000);
        }).catch(function () { toast('Copy blocked by the browser', 'bad'); });
      } catch (_) { toast('Copy blocked by the browser', 'bad'); }
    };
    if ($('#ek-alt')) $('#ek-alt').onclick = function () {
      showAlt = !showAlt;
      $('#ek-label').textContent = showAlt ? k.alt.label : k.label;
      $('#ek-alt').textContent = 'Show ' + (showAlt ? k.label : k.alt.label);
      if (box) box.innerHTML = renderSecret(k, showAlt);
    };
    if ($('#ek-dl')) $('#ek-dl').onclick = function () {
      try { var blob = new Blob([k.dump], { type: 'text/plain' }); var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = k.dumpFilename || (k.family + '-blockle-import.txt'); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000); toast('Core import file downloaded — keep it offline', 'good'); } catch (_) { toast('Download failed', 'bad'); }
    };
    timer = setInterval(function () {
      // the sheet was replaced or closed some other way → wipe immediately
      if (!document.body.contains(box) || !$('#scrim').classList.contains('open')) { wipe(); return; }
      left--; var t = $('#ek-ttl'); if (t) t.textContent = left + 's';
      if (left <= 0) { wipe(); closeSheet(); toast('Key hidden'); }
    }, 1000);
  }

  /* ---------------- SETTINGS ---------------- */
  VIEWS.settings = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Settings</h2></div>' +
      '<div class="list">' +
      settingRow('Account', S.user ? esc(S.user.email || S.user.username || 'signed in') : 'Not signed in', S.user ? '' : '<a class="btn sm" href="/account/login?next=/wallet">Sign in</a>') +
      settingRow('Accounts &amp; imports', 'Switch accounts, or import a private key, seed phrase, keystore or wallet.dat for a chain', '<button class="btn sm" id="set-accts">Open</button>') +
      settingRow('Export wallet file', 'Encrypted backup for another device (includes imported accounts)', '<button class="btn sm" id="set-export">Export</button>') +
      settingRow('Export a private key', 'Reveal one chain\'s key for the active account — password-gated, blurred until held, auto-hides in ' + EXPORT_TTL + ' s', '<button class="btn sm" id="set-key">Reveal</button>') +
      settingRow('WalletConnect', 'Connect to a dApp by pasting a WC URI', '<button class="btn sm" id="set-wc">Connect</button>') +
      settingRow('Theme', 'Light / dark follows your system by default', '<button class="btn sm" id="set-theme">Toggle</button>') +
      settingRow('Lock now', 'Clear keys from memory', '<button class="btn sm" id="set-lock">Lock</button>') +
      settingRow('Force update &amp; reload', 'Fetch the latest wallet code if something looks stale. Does NOT delete your keys.', '<button class="btn sm" id="set-update">Update</button>') +
      '</div></div>' +
      legacyRecoverCard() +
      '<div class="card"><div class="sechead"><h2>Get the native apps</h2></div><p class="muted" style="font-size:13px">The browser extension and desktop/mobile apps add OS-level key isolation — recommended for larger balances.</p><div class="wrap" style="margin-top:8px"><a class="btn" href="/download">Desktop &amp; extension</a><a class="btn ghost" href="/download">Mobile</a></div></div>' +
      '<div class="banner info" style="margin-top:14px"><span>' + ic('shield', 18) + '</span><div>This web wallet is non-custodial: keys are generated and sealed on your device and never sent to the server. Your Blockle identity and backup use post-quantum (ML-DSA) keys, and every other-chain account is derived from that post-quantum root — assets on Bitcoin, Ethereum and Solana stay secured by each network\'s own cryptography. It is a convenient hot wallet — for cold storage prefer the extension or desktop app.</div></div>';
    $('#set-export') && ($('#set-export').onclick = offerBackup);
    $('#set-accts') && ($('#set-accts').onclick = openAccountSheet);
    $('#set-key') && ($('#set-key').onclick = exportKeySheet);
    $('#set-theme') && ($('#set-theme').onclick = function () { var cur = document.documentElement.getAttribute('data-theme'); themeApply(cur === 'light' ? 'dark' : 'light'); });
    $('#set-lock') && ($('#set-lock').onclick = lock);
    $('#set-wc') && ($('#set-wc').onclick = wcSheet);
    $('#set-update') && ($('#set-update').onclick = forceUpdate);
    $('#set-sweep') && ($('#set-sweep').onclick = sweepLegacyFunds);
  };
  function settingRow(title, sub, action) { return '<div class="li"><span class="col" style="align-items:flex-start"><b>' + esc(title) + '</b><span class="dim" style="font-size:12px">' + sub + '</span></span><span style="margin-left:auto">' + action + '</span></div>'; }
  // Shown only when this wallet was migrated to the BLOCK-derived multichain seed
  // and still carries the old random seed as `legacySeed`. Lets the user move any
  // funds that landed on the OLD per-chain addresses over to the new ones.
  function legacyRecoverCard() {
    if (!(Wallet.legacySeedHex)) return '';
    return '<div class="card" style="margin-top:14px"><div class="sechead"><h2>Recover legacy funds</h2></div>' +
      '<p class="muted" style="font-size:13px">Your multichain addresses (Base, Ethereum, Bitcoin, etc.) are now derived from your BLOCK key so they stay attached to your account and persist across devices. If you received funds on the <b>old</b> addresses before this update, sweep them to your current addresses here. EVM/Base native balances are swept automatically; token and non-EVM balances are reported so you can move them manually.</p>' +
      '<div class="wrap" style="margin-top:10px"><button class="btn" id="set-sweep">' + ic('refresh', 16) + ' Scan &amp; sweep legacy addresses</button></div>' +
      '<div id="sweep-out" style="margin-top:12px"></div></div>';
  }
  async function sweepLegacyFunds() {
    var btn = $('#set-sweep'), out = $('#sweep-out');
    if (!btn || !out) return;
    if (!Wallet.legacySeedHex) { out.innerHTML = '<p class="muted">No legacy seed on this wallet.</p>'; return; }
    btn.disabled = true; btn.textContent = 'Scanning…';
    out.innerHTML = '<p class="muted">Deriving old addresses and checking balances across chains…</p>';
    try {
      var r = await Wiring.sweepLegacy(Wallet.legacySeedHex);
      var rows = (r && r.results) || [];
      if (!rows.length) { out.innerHTML = '<p class="muted">No legacy chains enabled — nothing to scan.</p>'; return; }
      var html = '<div class="list">';
      var anySwept = false, anyHeld = false;
      for (var i = 0; i < rows.length; i++) {
        var x = rows[i];
        var name = esc((x.chain || '').toUpperCase());
        var detail, tag;
        if (x.error) { detail = '<span class="dim" style="font-size:12px">' + esc(x.error) + '</span>'; tag = '<span class="pill warn">error</span>'; }
        else if (x.swept) { anySwept = true; detail = '<span class="dim" style="font-size:12px">Swept ' + esc(x.balance) + ' → ' + esc(shortAddr(x.to)) + '</span>'; tag = '<a class="pill ok" href="#" onclick="return false">' + esc(shortAddr(x.txid || '')) + '</a>'; }
        else if (x.balance && x.balance !== '0') { anyHeld = true; detail = '<span class="dim" style="font-size:12px">Holds ' + esc(x.balance) + ' at ' + esc(shortAddr(x.address)) + ' — move manually</span>'; tag = '<span class="pill">manual</span>'; }
        else { detail = '<span class="dim" style="font-size:12px">Empty</span>'; tag = '<span class="pill">—</span>'; }
        html += '<div class="li"><span class="col" style="align-items:flex-start"><b>' + name + '</b>' + detail + '</span><span style="margin-left:auto">' + tag + '</span></div>';
      }
      html += '</div>';
      if (anySwept) html += '<p class="muted" style="font-size:12px;margin-top:8px">Swept transactions are broadcasting — balances update once confirmed.</p>';
      if (anyHeld) html += '<p class="muted" style="font-size:12px;margin-top:8px">Tokens and non-EVM coins can\'t be auto-swept yet. Import the legacy seed into a dedicated wallet to move them, or contact support.</p>';
      out.innerHTML = html;
    } catch (e) {
      out.innerHTML = '<p class="muted">Sweep failed: ' + esc(String((e && e.message) || e)) + '</p>';
    } finally { btn.disabled = false; btn.innerHTML = ic('refresh', 16) + ' Scan &amp; sweep legacy addresses'; }
  }
  // Hard-refresh the wallet CODE: unregister the service worker and drop every
  // cache, then reload fresh from the network. This touches ONLY cached code —
  // your encrypted keys live in IndexedDB and are left completely untouched, so
  // the wallet is still there after the reload. Fixes "stale code after a
  // deploy" (e.g. a balance not showing because old vendor JS was cached).
  async function forceUpdate() {
    try { toast('Updating the wallet…'); } catch (_) {}
    try {
      if ('serviceWorker' in navigator) {
        var regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
      if (window.caches && caches.keys) {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
    } catch (_) { /* best-effort; reload anyway */ }
    setTimeout(function () { location.reload(); }, 300);
  }
  function wcSheet() {
    openSheet('<div class="spread"><h2>WalletConnect</h2><button class="btn sm ghost" id="wc-x">' + ic('close', 15) + '</button></div>' +
      '<p class="muted" style="margin:8px 0">Paste a WalletConnect v2 URI from a dApp. Sessions and signature requests pass the same security gate.</p>' +
      '<div class="field"><label>WC URI</label><input id="wc-uri" placeholder="wc:..."></div><button class="btn primary wide" id="wc-go">Connect</button>');
    $('#wc-x').onclick = closeSheet;
    $('#wc-go').onclick = function () {
      var uri = ($('#wc-uri').value || '').trim(); if (uri.indexOf('wc:') !== 0) { toast('Paste a valid wc: URI', 'bad'); return; }
      try { WalletConnect.parsePairingUri(uri); toast('Pairing… approve the session when prompted', 'good'); closeSheet(); }
      catch (e) { toast('Invalid WC URI', 'bad'); }
    };
  }

  /* ---------------- go ---------------- */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
