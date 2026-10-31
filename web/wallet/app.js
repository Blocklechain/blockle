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
  function toast(msg, kind) {
    var t = elFrom('<div class="toast ' + (kind || '') + '">' + esc(msg) + '</div>');
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
  };
  function ic(name, size) {
    var p = ICONS[name] || ICONS.close;
    return '<svg class="ic-svg" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
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
  function renderImport() {
    gateShell(
      '<div class="spread"><h3>Import a wallet</h3><a href="#" id="i-back" class="muted" style="font-size:13px">Back</a></div>' +
      '<p class="muted" style="margin:8px 0 12px">Import your encrypted Blockle wallet file. It is decrypted on this device only.</p>' +
      '<div class="field"><label>Wallet file (.json)</label><input id="i-file" type="file" accept="application/json,.json"></div>' +
      '<div class="field"><label>File password</label><input id="i-fpw" type="password" placeholder="Password the file was exported with"></div>' +
      '<div class="field"><label>New password for this browser</label><input id="i-npw" type="password" placeholder="Encrypts the import here"></div>' +
      '<div id="i-err" class="bad" style="min-height:18px;font-size:13px"></div>' +
      '<button id="i-go" class="btn primary wide">Import</button>'
    );
    $('#i-back').addEventListener('click', function (e) { e.preventDefault(); showGate(); });
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
    { id: 'trade', ic: 'buy', label: 'Trade' },
    { id: 'bridge', ic: 'bridge', label: 'Bridge' },
    { id: 'buy', ic: 'buy', label: 'Buy USDB' },
    { id: 'agent', ic: 'agent', label: 'Agent' },
    { id: 'bots', ic: 'bots', label: 'Bots' },
    { id: 'chat', ic: 'agent', label: 'AI Chat' },
    { id: 'inference', ic: 'agent', label: 'Inference' },
    { id: 'activity', ic: 'activity', label: 'Activity' },
    { id: 'pro', ic: 'pro', label: 'Pro' },
    { id: 'settings', ic: 'settings', label: 'Settings' },
  ];
  var BOTNAV = ['portfolio', 'assets', 'trade', 'agent', 'bots'];

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
    if (!location.hash) location.hash = '#portfolio';
    onRoute();
    ['click', 'keydown', 'mousemove', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, resetAutoLock, { passive: true }); });
    if (CONNECT.active) CONNECT.onEnter();
  }
  function buildNav() {
    $('#sidenav').innerHTML = NAV.map(function (n) {
      return '<a class="navlink" href="#' + n.id + '" data-id="' + n.id + '"><span class="ic">' + ic(n.ic, 20) + '</span><span>' + n.label + '</span>' + (n.id === 'pro' ? '<span class="tag">' + ic('pro', 13) + '</span>' : '') + '</a>';
    }).join('');
    $('#botnav').innerHTML = BOTNAV.map(function (id) {
      var n = NAV.filter(function (x) { return x.id === id; })[0];
      return '<a href="#' + id + '" data-id="' + id + '"><span>' + ic(n.ic, 21) + '</span><span>' + n.label + '</span></a>';
    }).join('');
  }

  /* ---------------- auto-lock ---------------- */
  var _lockTimer = null;
  function resetAutoLock() { if (!S.unlocked) return; clearTimeout(_lockTimer); _lockTimer = setTimeout(lock, 30 * 60 * 1000); }
  function lock() {
    try { Wallet.lock(); } catch (_) {}
    try { if (window.Wiring) Wiring.reset(); } catch (_) {}
    S.unlocked = false; S.agent = null; S.botRunner = null; S.agentConn = null;
    clearTimeout(_lockTimer);
    showGate();
  }

  /* ---------------- chains + account selector ---------------- */
  function refreshChains() {
    if (!window.Wiring) return;
    Wiring.registry().then(function (reg) {
      try { S.chains = reg.enabled(); } catch (_) { S.chains = ['block']; }
      if (S.chains.indexOf(S.chain) < 0) S.chain = S.chains[0] || 'block';
      updateAcctLabel();
    }).catch(function () {});
  }
  function updateAcctLabel() { $('#acctsel-label').textContent = (S.chain || 'block').toUpperCase() + ' · ' + shortAddr(S.address); }
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
    openSheet('<div class="spread"><h2>Network</h2><button class="btn sm ghost" id="as-x">' + ic('close', 15) + '</button></div><div class="list" style="margin-top:8px">' + rows + '</div>');
    $('#as-x').addEventListener('click', closeSheet);
    S.chains.forEach(function (c, i) { chainAddress(c).then(function (a) { var e = $('#ca-' + i); if (e) e.textContent = shortAddr(a); }); });
    $$('#sheet .li').forEach(function (b) {
      b.addEventListener('click', function () {
        S.chain = S.chains[Number(b.getAttribute('data-i'))] || S.chain;
        chainAddress(S.chain).then(function (a) { S.address = a; updateAcctLabel(); closeSheet(); onRoute(); });
      });
    });
  }

  /* ---------------- Pro / tier ---------------- */
  function loadTier() {
    fetch(ACCOUNTS + '/me', { credentials: 'include' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (j && j.user) { S.user = j.user; S.csrf = j.csrf || S.csrf; var sub = j.user.sub; S.tier = (sub && sub.active) ? (sub.tier || 'free') : 'free'; }
      else { S.user = null; S.tier = 'free'; S.csrf = null; }
      S.pro = isPro();
      var b = $('#tierbadge');
      b.className = 'chip' + (S.pro ? ' pro' : '');
      b.textContent = S.pro ? (S.tier === 'copilot_pro' ? 'Copilot Pro' : 'Copilot') : 'Free';
      b.onclick = function () { location.hash = '#pro'; };
      if (location.hash === '#pro' || location.hash === '#agent' || location.hash === '#bots') onRoute();
    }).catch(function () { S.tier = 'free'; S.pro = false; });
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
        '<div class="row" style="gap:8px;padding:12px;border-top:1px solid var(--line,#222)">' +
          '<input id="chat-in" placeholder="Message Blockle Intelligence…" style="flex:1" autocomplete="off">' +
          '<button class="btn primary" id="chat-send">Send</button></div></div>' +
      '<div class="card"><div class="sechead"><h2>Your API key</h2></div>' +
        '<p class="muted" style="margin:0 0 8px">Use the same credit from code — OpenAI-compatible. Keep BLOCK in your wallet and it auto-tops-up.</p>' +
        '<div class="row" style="gap:8px"><input id="chat-key" readonly style="flex:1;font-family:monospace;font-size:12px"><button class="btn sm ghost" id="chat-key-copy">Copy</button><button class="btn sm ghost" id="chat-key-new">New</button></div>' +
        '<pre id="chat-curl" style="white-space:pre-wrap;word-break:break-all;background:var(--panel,#111);padding:10px;border-radius:8px;font-size:11px;margin-top:8px"></pre></div>';

    function renderThread() {
      $('#chat-thread').innerHTML = CHAT.msgs.map(function (m) {
        var mine = m.role === 'user';
        return '<div style="align-self:' + (mine ? 'flex-end' : 'flex-start') + ';max-width:84%;background:' + (mine ? 'var(--accent,#2b6cff)' : 'var(--panel,#1a1a1a)') + ';color:' + (mine ? '#fff' : 'inherit') + ';padding:9px 12px;border-radius:14px;font-size:14px;white-space:pre-wrap">' + esc(m.content) + '</div>';
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
            else if (n > 0) { setTimeout(function () { attempt(n - 1); }, 6000); }
            else { $('#chat-topmsg').textContent = 'Deposit sent (' + txid.slice(0, 10) + '…); credit will appear after a confirmation.'; }
          });
        };
        attempt(10);
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
      '<div class="card"><div class="sechead"><h2>Pick your model</h2></div>' +
        '<p class="muted" style="margin:0 0 8px">One recommended model per GPU class — so everyone can participate.</p>' +
        '<div id="inf-models" class="list"><div class="empty">Loading…</div></div></div>' +
      '<div class="card"><div class="sechead"><h2>Run a miner (one command)</h2></div>' +
        '<p class="muted" style="margin:0 0 8px">Install <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>, pull your tier\'s model, then start the Blockle miner. It auto-detects your VRAM and picks the right model.</p>' +
        '<pre id="inf-cmd" style="white-space:pre-wrap;word-break:break-all;background:var(--panel,#111);padding:10px;border-radius:8px;font-size:12px"></pre>' +
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
      '<div class="card"><div class="dim" style="font-size:12px">Earning also requires registering your address as a miner on-chain (locks a small BLOCK bond) via the <code>blockle intel register-neuron</code> CLI (bundled in the desktop wallet) or the <code>blockle-inference</code> daemon — one-tap in-wallet registration is coming with the next node release. Activation is at block 18888.</div></div>';

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
          else if (it.status === 'funded') { el.innerHTML = '<span class="num">●</span> Deposit detected — executing…'; }
          else if (it.status === 'executed' || it.status === 'paid') { el.innerHTML = '<span class="num">●</span> Paying out…'; }
          else if (it.status === 'settled') {
            var got = baseToWhole(it.executedOutBase || it.quote.outBase, outDec);
            el.innerHTML = '<b class="good">✓ Done</b> — received ' + fmtAmt(got, 6) + ' ' + esc(it.payoutAsset) + (it.payoutTxid ? '<br><span class="dim" style="font-size:11px">tx ' + esc(String(it.payoutTxid).slice(0, 18)) + '…</span>' : '');
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
      '<div class="card"><div class="sechead"><h2>Holdings</h2><a class="btn sm ghost" href="#assets">All assets</a></div><div id="pf-list" class="list"><div class="empty">Loading balances…</div></div></div>' +
      (S.pro ? '' : proNudge('Unlock allocation charts, P&L history and price alerts with Pro.'));
    loadPortfolio();
  };
  function loadPortfolio() {
    Wiring.listAssets().then(function (list) {
      var total = 0, assetCount = 0, chainsWith = 0, rowsHtml = '';
      var jobs = [];
      list.forEach(function (chainRow) {
        if (!chainRow.balances) return; var had = false;
        chainRow.balances.forEach(function (r) {
          var dec = (r.asset && r.asset.decimals) || 0;
          var amt = r.display != null ? numVal(r.display) : baseToNum(r.confirmed, dec);
          if (!(amt > 0)) return; had = true; assetCount++;
          var sym = (r.asset && (r.asset.symbol || r.asset.sym)) || chainRow.chain.toUpperCase();
          var job = Promise.resolve(Wiring.estimateUsd ? Wiring.estimateUsd(r.asset || sym, amt) : null).catch(function () { return null; }).then(function (usd) {
            var u = Number(usd); if (isFinite(u) && u > 0) total += u;
            rowsHtml += assetRow(sym, chainRow.chain, amt, dec, isFinite(u) && u > 0 ? u : null, r.asset && r.asset.logoURI, assetId(r.asset), r.asset && r.asset.name);
          });
          jobs.push(job);
        });
        if (had) chainsWith++;
      });
      Promise.all(jobs).then(function () {
        if (!$('#pf-total')) return; // user navigated away before balances resolved
        $('#pf-total').textContent = total > 0 ? fmtUsd(total) : '—';
        $('#pf-chains').textContent = chainsWith; $('#pf-assets').textContent = assetCount;
        $('#pf-list').innerHTML = rowsHtml || '<div class="empty">No balances yet. Receive BLOCK or a token to get started.</div>';
        wireAssetRows($('#pf-list'));
      });
    }).catch(function () { $('#pf-list').innerHTML = '<div class="empty">Could not load balances right now.</div>'; });
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
      if (!native && bal > 0 && Wiring.estimateUsd) usdP = Promise.resolve(Wiring.estimateUsd({ symbol: symbol, decimals: dec, address: cid, stablecoin: !!(curated && curated.stablecoin) }, bal)).catch(function () { return null; });

      // actions
      var acts = [];
      acts.push('<a class="btn primary" href="#send" id="ai-send">' + ic('send', 15) + ' Send</a>');
      acts.push('<a class="btn" href="#receive" id="ai-recv">' + ic('receive', 15) + ' Receive</a>');
      if (!native) acts.push('<button class="btn" id="ai-swap">' + ic('swap', 15) + ' Swap</button>');
      if (!native && (symbol === 'USDB' || (curated && curated.symbol === 'USDB'))) acts.push('<a class="btn" href="#buy">' + ic('buy', 15) + ' Buy / Redeem</a>');
      if (!native && (symbol === 'WORLD' || (curated && curated.symbol === 'WORLD'))) acts.push('<a class="btn" href="/market" target="_blank">' + ic('external', 15) + ' Marketplace</a>');
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
    $('#a-refresh').onclick = function () { VIEWS.assets(v); };
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
    }).catch(function () { body.innerHTML = '<div class="empty">Could not load tokens.</div>'; });
  }
  function loadNfts() {
    var body = $('#a-body'); body.innerHTML = '<div class="empty">Loading NFTs…</div>';
    try {
      // blockApi must be a URL STRING base (the indexer does .replace on it); same-origin
      // /api/explorer is proxied to the node. EVM/Solana need keys → honest-empty without them.
      var idx = WalletNftIndexer.createIndexer({ blockApi: '/api/explorer' });
      chainAddress(S.chain).then(function (owner) {
        return idx.getNFTsForOwner(S.chain, owner);
      }).then(function (items) {
        if (items == null) { body.innerHTML = '<div class="empty">NFT indexing isn\'t available for this network in the web wallet.</div>'; return; }
        if (!items.length) { body.innerHTML = '<div class="empty">No NFTs held on ' + esc(S.chain.toUpperCase()) + '.</div>'; return; }
        body.innerHTML = '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">' + items.map(function (n) {
          var img = n.image || (n.media && n.media[0]) || '';
          return '<div class="planbox" style="padding:0;overflow:hidden"><div style="aspect-ratio:1;background:var(--card2);display:grid;place-items:center">' + (img ? '<img src="' + esc(img) + '" alt="" style="width:100%;height:100%;object-fit:cover">' : '' + ic('image', 26) + '') + '</div><div style="padding:9px"><b style="font-size:13px">' + esc(n.name || ('#' + (n.tokenId || ''))) + '</b><div class="dim" style="font-size:11px">' + esc(n.collection || n.contract || '') + '</div></div></div>';
        }).join('') + '</div>';
      }).catch(function () { body.innerHTML = '<div class="empty">Could not load NFTs.</div>'; });
    } catch (e) { body.innerHTML = '<div class="empty">NFT view unavailable.</div>'; }
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
    v.innerHTML = '<div class="card"><div class="sechead"><h2>USDB · Blockle USD</h2><span class="pill">1:1 USD · fully reserved</span></div><div id="ub-body"><div class="empty">Loading…</div></div></div>';
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
    var quotaNote = S.pro ? 'Pro: signed hosted session, higher budget.' : 'Free: anonymous hosted brain (rate-limited). Upgrade to Pro for a signed session + larger budget.';
    v.innerHTML = '<div class="card"><div class="sechead"><h2>' + ic('agent', 17) + ' Agent</h2><span class="pill" id="ag-conn">connecting…</span></div>' +
      '<p class="muted" style="margin-bottom:10px">Ask in plain language — "send 5 BLOCK to alice.eth", "swap 20 BLOCK for WORLD", "what\'s my net worth?". Every value-moving step is gated by the same approval sheet. Nothing executes without your tap.</p>' +
      '<div id="ag-log" class="list" style="max-height:340px;overflow:auto;margin-bottom:10px"></div>' +
      '<div class="row" style="gap:8px"><input id="ag-in" placeholder="Ask or instruct the agent…"><button class="btn primary" id="ag-go">Run</button></div>' +
      '<p class="dim" style="font-size:12px;margin-top:10px">' + esc(quotaNote) + '</p></div>' +
      (S.pro ? '' : proNudge('Pro raises the hosted-agent budget and unlocks live trading bots.'));
    var log = $('#ag-log');
    function add(role, text) { log.appendChild(elFrom('<div class="li"><span class="ico">' + (role === 'you' ? '' + ic('user', 17) + '' : role === 'err' ? '' + ic('warn', 18) + '' : '' + ic('agent', 17) + '') + '</span><div class="col" style="align-items:flex-start"><b style="font-size:12px" class="dim">' + role + '</b><span>' + esc(text) + '</span></div></div>')); log.scrollTop = log.scrollHeight; }
    ensureAgent().then(function () { $('#ag-conn').textContent = S.agentConn && S.agentConn.chain === 'anon' ? 'hosted · anon' : 'hosted · signed'; }).catch(function () { $('#ag-conn').textContent = 'offline'; });
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
      }).catch(function (e) { add('err', e.message || String(e)); }).then(function () { var p = $('#ag-pending'); if (p) p.remove(); });
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
  function ensureAgent() {
    if (S.agent && S.agent.router) return Promise.resolve(S.agent.router);
    if (!window.Wiring || !window.AgentCommand || !window.AgentProviders) return Promise.reject(new Error('agent modules missing'));
    return Wiring.ensureAgentDeps().then(function () {
      var ctx = Wiring.agentCtx();
      ctx.prices = ctx.prices || makePrices();
      if (typeof ctx.network !== 'function') ctx.network = function () { return 'testnet'; };
      if (typeof ctx.now !== 'function') ctx.now = function () { return Date.now(); };
      // keyless hosted brain: anonymous by default; Pro users get a signed session when an EVM signer is available
      var sessOpts = { gatewayUrl: GATEWAY, label: 'Blockle Web Wallet' };
      if (!S.pro) sessOpts.anon = true;
      return AgentProviders.hostedSession(sessOpts).then(function (sess) {
        S.agentConn = sess;
        var provider = AgentProviders.create({ provider: 'hosted', gatewayUrl: sess.gatewayUrl, sessionToken: sess.sessionToken, model: 'blockle-agent', refresh: function () { return AgentProviders.hostedSession(sessOpts).then(function (s2) { S.agentConn = s2; return s2.sessionToken; }); } });
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
          onEvent: function (ev) { agentEvent(ev); },
        });
        S.agent = { router: router, provider: provider, policy: policy, tools: tools, ctx: ctx, audit: audit, pnl: pnl };
        return router;
      });
    });
  }
  function agentNetWorth() { return Wiring.listAssets().then(function (list) { var total = 0, jobs = []; list.forEach(function (c) { (c.balances || []).forEach(function (r) { var dec = (r.asset && r.asset.decimals) || 0; var amt = r.display != null ? numVal(r.display) : baseToNum(r.confirmed, dec); if (amt > 0) jobs.push(Promise.resolve(Wiring.estimateUsd(r.asset, amt)).then(function (u) { if (isFinite(Number(u))) total += Number(u); }).catch(function () {})); }); }); return Promise.all(jobs).then(function () { return { usd: total }; }); }); }
  function agentEvent(ev) {
    if (!ev) return; var add = S._agentLog;
    if (ev.type === 'text' && ev.text && add) { S._lastAgentText = ev.text; add('agent', ev.text); }
    else if (ev.type === 'plan' && add) add('agent', 'Plan: ' + (ev.summary || (ev.steps && ev.steps.length + ' step(s)')));
    else if (ev.type === 'step' && add) add('agent', '→ ' + (ev.name || ev.tool || 'step') + (ev.result && ev.result.txid ? ' · ' + String(ev.result.txid).slice(0, 12) + '…' : ''));
    else if (ev.type === 'resolved' && add) add('agent', 'Resolved ' + (ev.name || '') + ' → ' + shortAddr(ev.address || ''));
    else if (ev.type === 'error' && add) add('err', ev.message || 'error');
  }
  function killAgent(reason) { try { if (S.botRunner) S.botRunner.killAll && S.botRunner.killAll(reason); } catch (_) {} S.agent = null; S.botRunner = null; toast('Agent killed — keys locked', 'bad'); lock(); }

  /* ---------------- BOTS ---------------- */
  VIEWS.bots = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>' + ic('bots', 18) + ' Bots</h2><div class="row"><button class="btn sm" id="bt-new">+ New bot</button><button class="btn sm ghost" id="bt-kill" title="Stop everything">Kill all</button></div></div>' +
      '<div class="banner ' + (S.pro ? 'info' : 'warn') + '" style="margin-bottom:12px"><span>' + (S.pro ? '' + ic('lock', 16) + '' : '' + ic('lock', 16) + '') + '</span><div>' +
      (S.pro ? 'Live trading unlocked. Bots run <b>fully auto within their allocation cap</b> — no per-order tap inside the cap — but every order still passes the session caps, allowlist, hash-chained audit, the 0.05% fee and the kill switch. Mainnet stays off until you enable it.' :
        'Free plan: <b>paper trading + 1 bot</b>. Bots simulate fills and never move funds. Upgrade to Pro for live trading and more bots.') + '</div></div>' +
      '<div id="bt-dash"></div><div id="bt-list" class="list"><div class="empty">Loading bots…</div></div>' +
      '<div class="card2" style="background:var(--card2);border-radius:12px;padding:14px;margin-top:12px"><div class="spread"><div class="col" style="align-items:flex-start"><b>' + ic('arena', 18) + ' Arena</b><span class="dim" style="font-size:12px">Practice strategies with play money — zero risk.</span></div><button class="btn sm" id="bt-arena">Open Arena</button></div></div></div>' +
      (S.pro ? '' : proNudge('Go live: Pro unlocks real trading bots (3) and Copilot Pro unlocks unlimited.'));
    $('#bt-new').onclick = newBotSheet;
    $('#bt-arena').onclick = openArena;
    $('#bt-kill').onclick = function () { if (S.botRunner) { S.botRunner.killAll && S.botRunner.killAll('user'); toast('All bots stopped'); renderBotList(); } };
    ensureBotRunner().then(renderBotList).catch(function () { $('#bt-list').innerHTML = '<div class="empty">Bots engine unavailable.</div>'; });
  };
  function ensureBotRunner() {
    if (S.botRunner) return Promise.resolve(S.botRunner);
    if (!window.AgentBotRunner) return Promise.reject(new Error('bot runner missing'));
    return ensureAgent().then(function () {
      var a = S.agent;
      S.botRunner = AgentBotRunner.create({ policy: a.policy, tools: a.tools, audit: a.audit, ctx: a.ctx, pnl: a.pnl, discovery: a.ctx.discovery || null, mainnetEnabled: false, persist: Store, wallet: 'web', channel: 'web' });
      return S.botRunner;
    });
  }
  function renderBotList() {
    var runner = S.botRunner, box = $('#bt-list'); if (!box) return;
    var bots = []; try { bots = (runner.store && runner.store.all && runner.store.all()) || []; } catch (_) {}
    try { var agg = runner.aggregate && runner.aggregate(); if (agg) $('#bt-dash').innerHTML = '<div class="statline" style="margin-bottom:12px"><div class="stat"><div class="n num">' + fmtUsd(agg.realizedUsd || 0) + '</div><div class="l">realized</div></div><div class="stat"><div class="n num">' + (agg.activeDeals || 0) + '</div><div class="l">active deals</div></div><div class="stat"><div class="n num">' + fmtUsd(agg.allocationUsd || 0) + '</div><div class="l">allocation</div></div></div>'; } catch (_) {}
    if (!bots.length) { box.innerHTML = '<div class="empty">No bots yet. Create one — it starts in paper mode.</div>'; return; }
    box.innerHTML = bots.map(function (b) {
      var live = b.mode === 'live';
      return '<div class="li"><span class="ico">' + (b.type === 'grid' ? '' + ic('grid', 16) + '' : b.type === 'dca' ? '' + ic('dca', 16) + '' : '' + ic('smart', 16) + '') + '</span>' +
        '<span class="col" style="align-items:flex-start"><b>' + esc(b.name || b.type) + '</b><span class="dim" style="font-size:12px">' + esc(b.type) +
        (b.lane ? ' · ' + esc(((BOT_LANES[b.lane] || {}).name || b.lane)) : '') + (b.riskMode ? ' · ' + esc(b.riskMode) : '') +
        (b.profitMode && b.profitMode !== 'off' ? ' · ' + esc(b.profitMode) : '') +
        ' · ' + esc((b.universe && b.universe.pairs && b.universe.pairs[0]) || 'auto') + ' · <span class="' + (live ? 'good' : '') + '">' + (live ? 'LIVE' : 'paper') + '</span>' +
        (b.allocationUsd > 0 ? ' · $' + b.allocationUsd : '') + (b.enabled ? ' · running' : ' · paused') + '</span></span>' +
        '<span class="row" style="margin-left:auto;gap:6px">' +
        '<button class="btn sm ghost" data-act="toggle" data-id="' + esc(b.id) + '">' + (b.enabled ? 'Pause' : 'Start') + '</button>' +
        (S.pro ? '<button class="btn sm" data-act="live" data-id="' + esc(b.id) + '">' + (live ? '' + ic('live', 15) + '' : 'Go live') + '</button>' : '') +
        '<button class="btn sm ghost" data-act="rm" data-id="' + esc(b.id) + '">' + ic('close', 15) + '</button></span></div>';
    }).join('');
    $$('#bt-list [data-act]').forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-id'), act = btn.getAttribute('data-act'), runner = S.botRunner;
        if (act === 'toggle') { var b = (runner.store.all() || []).filter(function (x) { return x.id === id; })[0]; (b && b.enabled ? runner.pause(id) : runner.enablePaper(id)); setTimeout(renderBotList, 150); }
        else if (act === 'rm') { runner.remove(id); setTimeout(renderBotList, 100); }
        else if (act === 'live') { armLiveSheet(id); }
      };
    });
  }
  // Lane = the ONE chain + base asset a bot trades (never cross-chain).
  var BOT_LANES = { solana: { base: 'SOL', name: 'Solana' }, ethereum: { base: 'ETH', name: 'Ethereum' }, bsc: { base: 'BNB', name: 'BSC' }, block: { base: 'BLOCK', name: 'BLOCK' } };
  var BOT_MODES = {
    safe: 'Safe — large-cap, established tokens only',
    medium: 'Medium — mid-cap, balanced',
    high: 'High — microcap, social-driven (risky)',
    sniper: 'Sniper — brand-new launches, maximum risk',
  };
  function newBotSheet() {
    openSheet('<div class="spread"><h2>New bot</h2><button class="btn sm ghost" id="nb-x">' + ic('close', 15) + '</button></div>' +
      '<div class="field"><label>Strategy</label><select id="nb-type"><option value="scanner">Autopilot (scan &amp; trade the lane)</option><option value="signal">Signal (auto-find tokens)</option><option value="dca">DCA (dollar-cost average)</option><option value="grid">Grid</option><option value="smarttrade">Smart trade</option></select></div>' +
      '<div class="field"><label>Lane — one chain, one base asset</label><select id="nb-lane"><option value="solana">Solana · hold SOL</option><option value="ethereum">Ethereum · hold ETH</option><option value="bsc">BSC · hold BNB</option><option value="block">BLOCK · hold BLOCK</option></select></div>' +
      '<div class="field"><label>Risk mode</label><select id="nb-mode"><option value="safe">Safe — large-cap only</option><option value="medium" selected>Medium — mid-cap, balanced</option><option value="high">High — microcap, social-driven</option><option value="sniper">Sniper — brand-new launches</option></select></div>' +
      '<div class="field"><label>Profit handling</label><select id="nb-profit"><option value="take" selected>Take profit — skim gains to your balance</option><option value="compound">Compound — reinvest gains, grow the position</option></select><div class="hint" style="font-size:12px;color:var(--muted);margin-top:4px">Losses only ever draw down this bot\'s budget — never your wallet.</div></div>' +
      '<div class="field" id="nb-pair-wrap" style="display:none"><label>Token pair (quoted in your base)</label><input id="nb-pair" value=""></div>' +
      '<div class="field"><label>Paper budget (USD)</label><input id="nb-budget" inputmode="decimal" placeholder="1000"></div>' +
      '<div class="field"><label>Name</label><input id="nb-name" placeholder="My autopilot bot"></div>' +
      '<div class="banner warn" id="nb-risk" style="display:none"><span>' + ic('warn', 18) + '</span><div id="nb-risk-t"></div></div>' +
      '<div class="banner info"><span>' + ic('doc', 18) + '</span><div>Starts in <b>paper mode</b> (simulated) with the budget above. The bot trades <b>only this lane</b> with your base asset. Arm it live later' + (S.pro ? '' : ' once you upgrade to Pro') + '.</div></div>' +
      '<button class="btn primary wide" id="nb-go" style="margin-top:12px">Create &amp; start (paper)</button>');
    $('#nb-x').onclick = closeSheet;
    function syncUi() {
      var type = $('#nb-type').value, lane = $('#nb-lane').value, mode = $('#nb-mode').value;
      var base = (BOT_LANES[lane] || {}).base || 'USDC';
      // DCA/grid/smarttrade trade a user-named token; signal/scanner auto-discover.
      var needsPair = (type === 'dca' || type === 'grid' || type === 'smarttrade');
      $('#nb-pair-wrap').style.display = needsPair ? '' : 'none';
      if (needsPair && !$('#nb-pair').value) $('#nb-pair').value = 'TOKEN/' + base;
      var risky = (mode === 'high' || mode === 'sniper');
      $('#nb-risk').style.display = risky ? '' : 'none';
      if (risky) $('#nb-risk-t').innerHTML = mode === 'sniper'
        ? 'Sniper trades <b>brand-new</b> microcaps the moment they clear the rug/liquidity gate. There is no track record for new tokens and <b>most go to zero</b> — risk only what you can lose.'
        : 'High mode trades volatile microcaps driven by social hype. Higher upside, much higher risk of loss.';
    }
    $('#nb-type').onchange = syncUi; $('#nb-lane').onchange = syncUi; $('#nb-mode').onchange = syncUi;
    syncUi();
    $('#nb-go').onclick = function () {
      var type = $('#nb-type').value, lane = $('#nb-lane').value, mode = $('#nb-mode').value;
      var profitMode = $('#nb-profit').value;
      var base = (BOT_LANES[lane] || {}).base || 'USDC';
      var needsPair = (type === 'dca' || type === 'grid' || type === 'smarttrade');
      var pair = needsPair ? (($('#nb-pair').value || ('TOKEN/' + base)).trim()) : (base + '/' + base);
      var budget = Number($('#nb-budget').value);
      var name = ($('#nb-name').value || '').trim() || (type.toUpperCase() + ' ' + (BOT_LANES[lane] || {}).name);
      if (!(budget > 0)) { toast('Set a paper budget (USD)', 'bad'); return; }
      ensureBotRunner().then(function (runner) {
        var bots = (runner.store.all && runner.store.all()) || [];
        if (!isPro() && bots.length >= 1) { closeSheet(); toast('Free plan allows 1 bot — upgrade for more', 'bad'); location.hash = '#pro'; return; }
        try {
          var bot = runner.add({ name: name, type: type, lane: lane, riskMode: mode, profitMode: profitMode, universe: { pairs: needsPair ? [pair] : [] }, config: {}, mode: 'paper', network: 'testnet' });
          runner.enablePaper(bot.id, { allocationUsd: budget }).then(function () {
            toast('Bot started (paper, $' + budget + ' on ' + (BOT_LANES[lane] || {}).name + ')', 'good');
            closeSheet(); renderBotList();
          }).catch(function (e) { toast('Start failed: ' + (e.message || e), 'bad'); closeSheet(); renderBotList(); });
        } catch (e) { toast('Create failed: ' + (e.message || e), 'bad'); }
      }).catch(function () { toast('Bots engine unavailable', 'bad'); });
    };
  }
  function armLiveSheet(id) {
    if (!isPro()) { toast('Live trading is a Pro feature', 'bad'); location.hash = '#pro'; return; }
    openSheet('<div class="spread"><h2>Arm live trading</h2><button class="btn sm ghost" id="al-x">' + ic('close', 15) + '</button></div>' +
      '<div class="banner warn"><span>' + ic('warn', 18) + '</span><div>Live bots trade real funds <b>within the allocation cap</b> with no per-order tap. They still obey session caps, the allowlist, the kill switch and the 0.05% fee. Mainnet stays off; this runs on testnet until you enable mainnet in settings.</div></div>' +
      '<div class="field" style="margin-top:12px"><label>Allocation cap (USD)</label><input id="al-alloc" inputmode="decimal" placeholder="50"></div>' +
      '<button class="btn primary wide" id="al-go">Arm live</button>');
    $('#al-x').onclick = closeSheet;
    $('#al-go').onclick = function () {
      var alloc = Number($('#al-alloc').value); if (!(alloc > 0)) { toast('Set an allocation cap', 'bad'); return; }
      S.botRunner.armLive(id, { allocationUsd: alloc }).then(function () { toast('Bot armed live (within $' + alloc + ')', 'good'); closeSheet(); renderBotList(); }).catch(function (e) { toast('Arm failed: ' + (e.message || e), 'bad'); });
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
  function featRow(label, f, p, cp) { return '<tr><td>' + esc(label) + '</td><td class="c ' + (f === '—' ? 'dim' : '') + '">' + f + '</td><td class="c good">' + p + '</td><td class="c good">' + cp + '</td></tr>'; }

  /* ---------------- SETTINGS ---------------- */
  VIEWS.settings = function (v) {
    v.innerHTML = '<div class="card"><div class="sechead"><h2>Settings</h2></div>' +
      '<div class="list">' +
      settingRow('Account', S.user ? esc(S.user.email || S.user.username || 'signed in') : 'Not signed in', S.user ? '' : '<a class="btn sm" href="/account/login?next=/wallet">Sign in</a>') +
      settingRow('Export wallet file', 'Encrypted backup for another device', '<button class="btn sm" id="set-export">Export</button>') +
      settingRow('WalletConnect', 'Connect to a dApp by pasting a WC URI', '<button class="btn sm" id="set-wc">Connect</button>') +
      settingRow('Theme', 'Light / dark follows your system by default', '<button class="btn sm" id="set-theme">Toggle</button>') +
      settingRow('Lock now', 'Clear keys from memory', '<button class="btn sm" id="set-lock">Lock</button>') +
      settingRow('Force update &amp; reload', 'Fetch the latest wallet code if something looks stale. Does NOT delete your keys.', '<button class="btn sm" id="set-update">Update</button>') +
      '</div></div>' +
      '<div class="card"><div class="sechead"><h2>Get the native apps</h2></div><p class="muted" style="font-size:13px">The browser extension and desktop/mobile apps add OS-level key isolation — recommended for larger balances.</p><div class="wrap" style="margin-top:8px"><a class="btn" href="/download">Desktop &amp; extension</a><a class="btn ghost" href="/download">Mobile</a></div></div>' +
      '<div class="banner info" style="margin-top:14px"><span>' + ic('shield', 18) + '</span><div>This web wallet is non-custodial: keys are generated and sealed on your device and never sent to the server. It is a convenient hot wallet — for cold storage prefer the extension or desktop app.</div></div>';
    $('#set-export') && ($('#set-export').onclick = offerBackup);
    $('#set-theme') && ($('#set-theme').onclick = function () { var cur = document.documentElement.getAttribute('data-theme'); themeApply(cur === 'light' ? 'dark' : 'light'); });
    $('#set-lock') && ($('#set-lock').onclick = lock);
    $('#set-wc') && ($('#set-wc').onclick = wcSheet);
    $('#set-update') && ($('#set-update').onclick = forceUpdate);
  };
  function settingRow(title, sub, action) { return '<div class="li"><span class="col" style="align-items:flex-start"><b>' + esc(title) + '</b><span class="dim" style="font-size:12px">' + sub + '</span></span><span style="margin-left:auto">' + action + '</span></div>'; }
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
