// popup.js — UI controller for the Blockle Wallet popup. Two modes:
//   normal  — onboarding / unlock / dashboard / receive / send / apps / settings
//   approve — a dApp connect or signature request (opened as its own window)
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const logos = {};

  function show(name) {
    $$('.screen').forEach((s) => (s.hidden = s.dataset.screen !== name));
    mountLogos();
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 1800);
  }
  const shortAddr = (a) => (a ? a.slice(0, 10) + '…' + a.slice(-6) : '—');

  // ---- SHARED SECURITY GATE ------------------------------------------------
  // Every value-moving / sign call site in this popup (the in-wallet BLOCK send
  // + AMM swap, and the dApp approvals that actually SIGN here: signMessage /
  // deployContract / tokenInit / swap / createPool) runs SecurityGate.gate()
  // BEFORE the existing signer. It inspects (read-only) and routes through the
  // shared confirm sheet below; a DANGER forces the explicit "understand the
  // risk" confirm, a reject (or an unavailable suite) aborts WITHOUT signing.
  // The suite never signs — the existing signer runs only on cleared:true.

  // The security ctx: the SAME denylist/thresholds the agent + WalletConnect gate
  // use (agentSettings.security). A best-effort BLOCK balance feeds large-share.
  async function securityCtx() {
    let sec = {};
    try { sec = ((await Store.get('agentSettings')).agentSettings || {}).security || {}; } catch (_) {}
    const extra = {};
    if (window.Wallet && Wallet.address && window.Chain) {
      extra.getBalance = async () => {
        try { const a = await Chain.account(Wallet.address); return a && a.balance != null ? String(a.balance) : '0'; }
        catch (_) { return '0'; }
      };
    }
    return SecurityGate.ctxFromSecuritySettings(sec, extra);
  }

  // Run the gate for `action`; resolves true only when the user cleared the
  // shared confirm sheet. Fails closed (returns false) if the suite is missing.
  async function securityGate(action) {
    if (!window.SecurityGate) return false; // fail closed — never sign un-inspected
    const ctx = await securityCtx();
    const res = await SecurityGate.gate({ action, ctx, confirm: securitySheet });
    return !!(res && res.cleared);
  }

  // The shared confirm sheet (reuses the .wallet-root sheet styling). Returns a
  // Promise<bool>: approve=true / reject=false. DANGER forces the explicit
  // "I understand the risk" button; a clean inspection shows "no warnings".
  function securitySheet(inspection) {
    inspection = inspection || {};
    return new Promise((resolve) => {
      const danger = inspection.severity === 'danger';
      const wrap = document.createElement('div');
      wrap.className = 'wallet-root';
      wrap.style.position = 'fixed';
      wrap.style.inset = '0';
      wrap.style.zIndex = '2000';
      const rows = (inspection.details || []).map((d) =>
        `<div class="wpvrow"><span class="k">${esc(d.label)}</span><span class="v num">${esc(d.value)}</span></div>`).join('');
      const warns = (inspection.warnings || []).map((w) => {
        const sev = w.severity === 'danger' ? 'danger' : w.severity === 'warn' ? 'warn' : 'info';
        return `<div class="wwarn ${sev}"><div class="t">${esc(w.code)}</div><div class="d">${esc(w.message)}</div></div>`;
      }).join('');
      const ran = (inspection.checks && inspection.checks.ran) || [];
      const clean = !(inspection.warnings || []).length;
      const checks = clean
        ? `No warnings from ${ran.length} check${ran.length === 1 ? '' : 's'}. Absence of a warning is not a safety guarantee.`
        : '';
      wrap.innerHTML =
        '<div class="wscrim"></div>' +
        '<div class="wsheet card" role="dialog" aria-modal="true" aria-label="Review before signing">' +
          '<h3>Review before signing</h3>' +
          (inspection.summary ? `<div class="wsummary">${esc(inspection.summary)}</div>` : '') +
          '<div class="wpreview"><div class="wpvh">Transaction preview</div>' + rows + '</div>' +
          warns +
          (checks ? `<div class="wchecks">${esc(checks)}</div>` : '') +
          '<div class="wsheet-actions">' +
            '<button class="wbtn" data-act="reject">Reject</button>' +
            (danger
              ? '<button class="wbtn danger" data-act="ok">I understand the risk — approve</button>'
              : '<button class="wbtn primary" data-act="ok">Approve</button>') +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('.wscrim').addEventListener('click', () => done(false));
      wrap.querySelector('[data-act="reject"]').addEventListener('click', () => done(false));
      wrap.querySelector('[data-act="ok"]').addEventListener('click', () => done(true));
    });
  }

  // The explicit DANGER confirm for the key/seed export (the gate's `confirm`).
  // Surfaces the plain-language warning verbatim and forces an explicit choice:
  // resolves true only when the user presses "I understand — show my keys".
  function dangerConfirmSheet(warning) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'wallet-root';
      wrap.style.position = 'fixed';
      wrap.style.inset = '0';
      wrap.style.zIndex = '2000';
      wrap.innerHTML =
        '<div class="wscrim"></div>' +
        '<div class="wsheet card" role="dialog" aria-modal="true" aria-label="Export keys and seed">' +
          '<h3>Export keys &amp; recovery phrase</h3>' +
          '<div class="wwarn danger"><div class="t">DANGER</div><div class="d">' + esc(warning) + '</div></div>' +
          '<div class="wsheet-actions">' +
            '<button class="wbtn" data-act="reject">Cancel</button>' +
            '<button class="wbtn danger" data-act="ok">I understand — show my keys</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('.wscrim').addEventListener('click', () => done(false));
      wrap.querySelector('[data-act="reject"]').addEventListener('click', () => done(false));
      wrap.querySelector('[data-act="ok"]').addEventListener('click', () => done(true));
    });
  }

  // Present the exported secrets panel (export-ui.js built the markup). Returns the
  // container element so export-ui can wire the Core-dump download buttons.
  function presentSecretsSheet(html) {
    const wrap = document.createElement('div');
    wrap.className = 'wallet-root';
    wrap.style.position = 'fixed';
    wrap.style.inset = '0';
    wrap.style.zIndex = '2000';
    wrap.innerHTML =
      '<div class="wscrim"></div>' +
      '<div class="wsheet card" role="dialog" aria-modal="true" aria-label="Your exported keys">' +
        '<h3>Your keys &amp; recovery phrase</h3>' + html +
        '<div class="wsheet-actions"><button class="wbtn primary" data-act="close">Done</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.wscrim').addEventListener('click', close);
    wrap.querySelector('[data-act="close"]').addEventListener('click', close);
    return wrap;
  }

  // Encrypted cloud backup / restore form. Resolves with the entered values, or null on cancel.
  function backupSheet(mode) {
    const isRestore = mode === 'restore';
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'wallet-root';
      wrap.style.position = 'fixed'; wrap.style.inset = '0'; wrap.style.zIndex = '2000';
      const inp = (id, ph, type) => '<input id="' + id + '" placeholder="' + ph + '" type="' + type + '" autocomplete="off" style="width:100%;margin:6px 0;padding:10px;border-radius:9px;border:1px solid var(--line,#1e2838);background:var(--bg,#0b0e14);color:inherit">';
      wrap.innerHTML =
        '<div class="wscrim"></div>' +
        '<div class="wsheet card" role="dialog" aria-modal="true">' +
          '<h3>' + (isRestore ? 'Restore from backup' : 'Encrypted cloud backup') + '</h3>' +
          '<div class="wnote">Signs in to your Blockle account and ' + (isRestore ? 'downloads your encrypted vault' : 'uploads your vault encrypted with a backup passphrase') + '. Self-custody: the server only stores ciphertext it can’t read. Support will never ask for your backup passphrase.</div>' +
          inp('bk-email', 'Blockle account email', 'email') +
          inp('bk-pw', 'Account password', 'password') +
          inp('bk-totp', '2FA code (6 digits)', 'text') +
          inp('bk-pass', 'Backup passphrase', 'password') +
          (isRestore ? inp('bk-newpw', 'New password for this device', 'password') : '') +
          '<div class="wsheet-actions">' +
            '<button class="wbtn" data-act="cancel">Cancel</button>' +
            '<button class="wbtn primary" data-act="ok">' + (isRestore ? 'Restore' : 'Back up now') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      const val = (id) => (wrap.querySelector('#' + id) || {}).value || '';
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('.wscrim').addEventListener('click', () => done(null));
      wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
      wrap.querySelector('[data-act="ok"]').addEventListener('click', () => done({
        email: val('bk-email').trim(), password: val('bk-pw'), totp: val('bk-totp').trim(),
        passphrase: val('bk-pass'), newPassword: val('bk-newpw'),
      }));
    });
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function mountLogos() {
    $$('canvas.logo').forEach((c) => {
      if (c.offsetParent === null) return; // not visible
      if (logos[c.id]) return;
      logos[c.id] = new ParticleLogo(c, { glyph: 'B', density: c.clientWidth < 60 ? 2 : 4 });
    });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Copy failed');
    }
  }

  // ---- blocks "identicon" derived from the address -----------------------
  function identicon(canvas, addr) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width,
      N = 7,
      cell = W / N,
      gap = cell * 0.12;
    ctx.clearRect(0, 0, W, W);
    let h = 2166136261;
    for (let i = 0; i < addr.length; i++) {
      h ^= addr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const rng = () => {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      return ((h >>> 0) % 1000) / 1000;
    };
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < Math.ceil(N / 2); x++) {
        if (rng() > 0.5) {
          const hue = 188 + rng() * 88;
          ctx.fillStyle = `hsl(${hue}, 85%, 62%)`;
          for (const xx of [x, N - 1 - x]) {
            ctx.fillRect(xx * cell + gap, y * cell + gap, cell - 2 * gap, cell - 2 * gap);
          }
        }
      }
    }
  }

  // ---- live chain data ----------------------------------------------------
  async function refreshNet() {
    const s = await Chain.stats();
    $$('[data-height]').forEach((e) => (e.textContent = s ? 'height ' + s.height : 'offline'));
  }
  // Reflect the current BLOCK network (mainnet vs the valueless testnet) in the
  // settings badge + toggle label + a dashboard pill.
  async function syncNetBadge() {
    const onTest = await Chain.isTestnet();
    const badge = $('#net-badge'); if (badge) { badge.textContent = onTest ? 'Testnet' : 'Mainnet'; badge.style.color = onTest ? '#f2b04a' : 'var(--muted)'; }
    const tgl = $('#net-toggle'); if (tgl) tgl.textContent = onTest ? 'Switch to Mainnet' : 'Switch to Testnet';
    const pill = $('#testnet-pill'); if (pill) pill.hidden = !onTest;
  }
  async function refreshDashboard() {
    const addr = Wallet.address;
    const shortEl = $('#addr-short'); if (shortEl) shortEl.textContent = shortAddr(addr);
    const balEl = $('#bal');
    // Fetch the account defensively: a transport/throw must never leave the
    // balance stuck on its "—" placeholder. Set a value no matter what, and log
    // the real cause so it's visible in the popup console.
    let acct = null;
    try {
      acct = await Chain.account(addr);
    } catch (e) {
      console.error('[dashboard] balance fetch failed', e);
    }
    if (balEl) {
      balEl.textContent = acct && acct.balanceFmt != null
        ? acct.balanceFmt
        : (acct && acct.balance != null ? String(Number(acct.balance) / 1e8) : '0');
    }
    const act = $('#activity');
    const txs = (acct && acct.txs) || [];
    if (!txs.length) {
      act.innerHTML = '<div class="empty">No transactions yet.</div>';
    } else {
      act.innerHTML = txs
        .slice(0, 25)
        .map((t) => {
          const inc = t.direction === 'in' || (t.value || 0) > 0;
          return `<div class="row"><div class="l"><b>${inc ? 'Received' : 'Sent'}</b><small class="mono">${(t.txid || '').slice(0, 20)}…</small></div><div class="r">${inc ? '+' : '−'}${t.valueFmt || ''}</div></div>`;
        })
        .join('');
    }
    await renderTokens();
  }

  // Official BLOCK-20 tokens always appear (even at 0 balance), ahead of any the
  // user imported. WORLD (game currency) + USDB (stablecoin).
  const CURATED_TOKEN_IDS = [
    '32a97972001bd895203c4bb5ac4645af02d81263438968ea32e35140f130d00f',
    '2beadf6b409427aacca1030778671ead6b9cdc5e817f1b6743c6d931c0c7ae7a',
  ];
  // Logos are bundled in the extension (local, same-origin — reliable in the
  // popup regardless of network/CSP).
  const CURATED_TOKEN_LOGO = {
    '32a97972001bd895203c4bb5ac4645af02d81263438968ea32e35140f130d00f': 'world-token.svg',
    '2beadf6b409427aacca1030778671ead6b9cdc5e817f1b6743c6d931c0c7ae7a': 'usdb-token.svg',
  };
  // The monogram letter is the base; the logo <img> layers on top and simply
  // hides itself on error (onerror holds NO markup, so it can't break the HTML).
  function tokenIcon(id, sym) {
    const ch = (sym || '?').slice(0, 1).toUpperCase();
    const logo = CURATED_TOKEN_LOGO[id];
    if (!logo) return `<span class="tok-ico">${ch}</span>`;
    return `<span class="tok-ico">${ch}<img src="${logo}" alt="" onerror="this.style.display='none'"></span>`;
  }

  // Send context: a BLOCK-20 token {contract, decimals, symbol} when sending a
  // token, or null for native BLOCK. `pendingSendCtx` is a one-shot set by a
  // token row's Send button just before route('send').
  let sendCtx = null;
  let pendingSendCtx;
  function configureSendScreen() {
    const isTok = !!sendCtx;
    const lbl = $('#send-amt-label'); if (lbl) lbl.textContent = 'Amount (' + (isTok ? (sendCtx.symbol || 'TOKEN') : 'BLOCK') + ')';
    const ban = $('#send-token-banner');
    if (ban) { ban.hidden = !isTok; if (isTok) ban.textContent = 'Sending BLOCK-20 token ' + (sendCtx.symbol || '') + ' · gas paid in BLOCK.'; }
    const setHidden = (id, on) => { const e = $(id); if (e) e.hidden = !on; };
    setHidden('#send-fee-row', !isTok);
    setHidden('#send-gaslimit-row', isTok);
    setHidden('#send-gasprice-row', isTok);
  }

  async function renderTokens() {
    const box = $('#tokens');
    if (!box) return;
    const stored = (await Store.get('tokens')).tokens || [];
    const ids = CURATED_TOKEN_IDS.concat(stored.filter((i) => CURATED_TOKEN_IDS.indexOf(i) < 0));
    const infos = await Promise.all(ids.map((id) => Chain.token(id, Wallet.address)));
    box.innerHTML = ids
      .map((id, i) => {
        const t = infos[i];
        if (!t) return `<div class="row"><div class="l" style="display:flex;align-items:center;gap:10px">${tokenIcon(id, '?')}<div><b class="mono">${id.slice(0, 12)}…</b><small>unavailable</small></div></div></div>`;
        const dec = Number(t.decimals || 0);
        const bal = t.balance != null ? (Number(t.balance) / Math.pow(10, dec)).toLocaleString(undefined, { maximumFractionDigits: dec }) : '0';
        const sym = t.symbol || '?';
        return `<div class="row"><div class="l" style="display:flex;align-items:center;gap:10px">${tokenIcon(id, sym)}<div><b>${sym}</b><small>${t.name || ''}</small></div></div><div class="r" style="display:flex;align-items:center;gap:8px"><span>${bal} ${sym}</span><button class="btn tiny" data-tok-send="${id}" data-tok-dec="${dec}" data-tok-sym="${sym}">Send</button></div></div>`;
      })
      .join('');
    box.querySelectorAll('[data-tok-send]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingSendCtx = { contract: b.getAttribute('data-tok-send'), decimals: Number(b.getAttribute('data-tok-dec') || 0), symbol: b.getAttribute('data-tok-sym') || 'TOKEN' };
        route('send');
      });
    });
  }

  // Toggle the inline import field (window.prompt is blocked in MV3 popups, so
  // we use an in-popup input instead).
  function importToken() {
    const row = $('#import-row');
    if (!row) return;
    const open = row.style.display === 'flex';
    row.style.display = open ? 'none' : 'flex';
    const msg = $('#import-msg'); if (msg) msg.style.display = 'none';
    if (!open) { const inp = $('#import-id'); if (inp) inp.focus(); }
  }

  async function addImportedToken() {
    const msg = $('#import-msg');
    const fail = (m) => { if (msg) { msg.style.display = 'block'; msg.textContent = m; } };
    if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
    const id = (($('#import-id') && $('#import-id').value) || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id)) return fail('Enter a 64-hex-character contract id.');
    let t;
    try { t = await Chain.token(id, Wallet.address); } catch { t = null; }
    if (!t || !(t.isToken || t.name || t.symbol)) return fail('No BLOCK-20 token found at that id.');
    const ids = (await Store.get('tokens')).tokens || [];
    if (ids.indexOf(id) < 0) { ids.push(id); await Store.set({ tokens: ids }); }
    if ($('#import-id')) $('#import-id').value = '';
    if ($('#import-row')) $('#import-row').style.display = 'none';
    await renderTokens();
  }
  async function refreshConnections() {
    const sites = (await Store.get('sites')).sites || {};
    const el = $('#sites');
    const keys = Object.keys(sites);
    if (!keys.length) {
      el.innerHTML = '<div class="empty">No apps connected yet.</div>';
      return;
    }
    el.innerHTML = keys
      .map((origin) => {
        let host = origin;
        try {
          host = new URL(origin).host;
        } catch {}
        return `<div class="row"><div class="l" style="flex-direction:row;align-items:center;gap:10px"><div class="site-ico">${host[0] ? host[0].toUpperCase() : '•'}</div><div><b>${host}</b><small>connected</small></div></div><button class="mini-btn" data-revoke="${origin}">Disconnect</button></div>`;
      })
      .join('');
    $$('[data-revoke]', el).forEach((b) =>
      b.addEventListener('click', async () => {
        const origin = b.dataset.revoke;
        try {
          await chrome.runtime.sendMessage({ type: 'revoke-site', origin });
        } catch {
          const sites2 = (await Store.get('sites')).sites || {};
          delete sites2[origin];
          await Store.set({ sites: sites2 });
        }
        refreshConnections();
        toast('Disconnected');
      })
    );
  }

  async function renderWallets() {
    const list = await Wallet.list();
    const el = $('#wallet-list');
    if (!list.length) {
      el.innerHTML = '<div class="empty">No wallets yet.</div>';
      return;
    }
    el.innerHTML = list
      .map(
        (w) =>
          `<div class="w-item ${w.active ? 'active' : ''}" data-switch="${w.id}">
             <div class="wl"><b>${w.label}${w.watchOnly ? ' · watch' : ''}</b><small>${shortAddr(w.address)}</small></div>
             ${w.active ? '<span class="w-check">✓</span>' : `<button class="mini-btn" data-remove="${w.id}">Remove</button>`}
           </div>`
      )
      .join('');
    $$('[data-switch]', el).forEach((it) =>
      it.addEventListener('click', async (e) => {
        if (e.target.closest('[data-remove]')) return;
        await Wallet.select(it.dataset.switch);
        enterSelected();
      })
    );
    $$('[data-remove]', el).forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this wallet from the extension? Make sure you exported it first.')) return;
        await Wallet.remove(b.dataset.remove);
        renderWallets();
      })
    );
  }

  async function setActiveLabel() {
    const list = await Wallet.list();
    const active = list.find((w) => w.active) || list[0];
    if (active) $('#active-label').textContent = active.label;
  }

  // ---- password meter -----------------------------------------------------
  function scorePw(p) {
    let s = 0;
    if (p.length >= 8) s += 34;
    if (p.length >= 12) s += 20;
    if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s += 18;
    if (/\d/.test(p)) s += 14;
    if (/[^A-Za-z0-9]/.test(p)) s += 14;
    return Math.min(100, s);
  }

  // ---- normal-mode wiring -------------------------------------------------
  function wireNormal() {
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) route(go.dataset.go);
    });

    $('#create-pw').addEventListener('input', (e) => {
      $('#pw-meter').style.width = scorePw(e.target.value) + '%';
    });
    $('#create-go').addEventListener('click', async () => {
      const pw = $('#create-pw').value,
        pw2 = $('#create-pw2').value;
      const err = $('#create-err');
      err.textContent = '';
      if (pw.length < 8) return (err.textContent = 'Password must be at least 8 characters.');
      if (pw !== pw2) return (err.textContent = 'Passwords do not match.');
      await Wallet.create(pw);
      await afterUnlock(pw);
      toast('Wallet created');
      route('dashboard');
    });

    // import
    const fileInput = $('#import-file');
    const drop = $('#import-drop');
    let importedObj = null;
    const onFile = (file) => {
      const r = new FileReader();
      r.onload = () => {
        try {
          importedObj = JSON.parse(r.result);
          $('#import-filename').textContent = file.name;
          $('#import-go').disabled = false;
        } catch {
          $('#import-err').textContent = 'Not a valid JSON file.';
        }
      };
      r.readAsText(file);
    };
    fileInput.addEventListener('change', (e) => e.target.files[0] && onFile(e.target.files[0]));
    ['dragover', 'dragenter'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('drag');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('drag');
      })
    );
    drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && onFile(e.dataTransfer.files[0]));
    $('#import-go').addEventListener('click', async () => {
      $('#import-err').textContent = '';
      const filePw = $('#import-filepw').value;
      const newPw = $('#import-pw').value;
      // A new password is required for any wallet that can sign (has secret).
      const needsPw =
        importedObj &&
        (importedObj.crypto || importedObj.secret || importedObj.secretKey || importedObj.sk || importedObj.secret_hex);
      if (needsPw && newPw.length < 8) {
        $('#import-err').textContent = 'Set a new password of at least 8 characters.';
        return;
      }
      try {
        const res = await Wallet.importFile(importedObj, filePw, newPw);
        if (res.mode !== 'watch-only') await afterUnlock(newPw);
        toast(res.mode === 'watch-only' ? 'Imported (watch-only)' : 'Wallet imported');
        route('dashboard');
      } catch (err) {
        $('#import-err').textContent = 'Could not import: ' + (err.message || err);
      }
    });

    // unlock
    const doUnlock = async () => {
      $('#unlock-err').textContent = '';
      try {
        const pw = $('#unlock-pw').value;
        await Wallet.unlock(pw);
        await afterUnlock(pw);
        route('dashboard');
      } catch {
        $('#unlock-err').textContent = 'Wrong password.';
      }
    };
    $('#unlock-go').addEventListener('click', doUnlock);
    $('#unlock-pw').addEventListener('keydown', (e) => e.key === 'Enter' && doUnlock());
    $('#unlock-reset').addEventListener('click', confirmReset);

    // dashboard
    $('#lock-btn').addEventListener('click', async () => {
      await doLock();
    });
    const impBtn = $('#import-token');
    if (impBtn) impBtn.addEventListener('click', importToken);
    const impAdd = $('#import-add');
    if (impAdd) impAdd.addEventListener('click', addImportedToken);
    const impId = $('#import-id');
    if (impId) impId.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addImportedToken(); } });
    const qref = $('#queue-refresh');
    if (qref) qref.addEventListener('click', renderQueue);
    $('#addr-chip').addEventListener('click', () => copy(Wallet.address));
    $('#copy-addr').addEventListener('click', () => copy(Wallet.address));

    // send — native BLOCK or a BLOCK-20 token (sendCtx), ML-DSA signed + broadcast
    $('#send-go').addEventListener('click', async () => {
      const to = $('#send-to').value.trim();
      const amtStr = ($('#send-amt').value || '').trim();
      const amt = parseFloat(amtStr);
      const err = $('#send-err');
      err.textContent = '';
      if (!/^block1[0-9a-z]+$/.test(to)) return (err.textContent = 'Enter a valid block1… address.');
      if (!(amt > 0)) return (err.textContent = 'Enter an amount greater than 0.');
      if (!Wallet.isUnlocked()) return (err.textContent = 'Unlock your wallet to send.');
      const COIN = 100000000;
      // Exact decimal -> base units (no float rounding; safe for large amounts).
      const toBase = (v, d) => {
        const s = String(v == null ? '' : v).trim().replace(/,/g, '');
        if (s === '' || s === '.' || !/^\d*(\.\d*)?$/.test(s)) return '0';
        const dd = Math.max(0, d || 0), p = s.split('.');
        const frac = ((p[1] || '') + '00000000000000000000').slice(0, dd);
        try { return (BigInt(p[0] || '0') * (10n ** BigInt(dd)) + BigInt(frac || '0')).toString(); } catch (_) { return '0'; }
      };
      const isTok = !!sendCtx;
      const dec = isTok ? Number(sendCtx.decimals || 0) : 8;
      const amountBase = toBase(amtStr, dec);
      let feeBase, gasLimit, gasPrice;
      if (isTok) {
        gasLimit = Math.max(1, Math.round(Number(($('#send-gaslimit') && $('#send-gaslimit').value) || 200000) || 200000));
        gasPrice = Math.max(1, Math.round(Number(($('#send-gasprice') && $('#send-gasprice').value) || 10) || 10));
        feeBase = gasLimit * gasPrice;
      } else {
        let feeBlk = Number(($('#send-fee') && $('#send-fee').value) || 0.0001);
        if (!isFinite(feeBlk) || feeBlk < 0) feeBlk = 0.0001;
        feeBase = Math.round(feeBlk * COIN);
      }
      // SECURITY GATE: inspect (read-only) + shared confirm sheet BEFORE signing.
      const cleared = await securityGate({ kind: 'send', to, amount: Number(amountBase), fee: feeBase, token: isTok ? sendCtx.contract : undefined, symbol: isTok ? sendCtx.symbol : 'BLOCK' });
      if (!cleared) { err.textContent = 'Send cancelled by the security review.'; return; }
      const btn = $('#send-go');
      btn.disabled = true;
      btn.textContent = 'Signing & sending…';
      try {
        const u = await Chain.utxos(Wallet.address);
        if (!u || !u.utxos.length) throw new Error(isTok ? 'need a little BLOCK for gas (coinbase matures after 100 blocks)' : 'no spendable funds (coinbase matures after 100 blocks)');
        const built = isTok
          ? await Wallet.buildTokenTransfer(u.utxos, String(sendCtx.contract).toLowerCase(), to, amountBase, gasLimit, gasPrice)
          : await Wallet.buildTransfer(u.utxos, to, amountBase, feeBase);
        const res = await Chain.submit(built.raw);
        await recordPending(res.txid || built.txid, isTok ? ('Send ' + (sendCtx.symbol || 'token')) : 'Send');
        toast('Sent · ' + (res.txid || built.txid).slice(0, 14) + '…');
        $('#send-to').value = '';
        $('#send-amt').value = '';
        route('dashboard');
      } catch (e) {
        err.textContent = 'Send failed: ' + (e.message || e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send';
      }
    });

    // ---- USDB (Blockle USD stablecoin) ----
    const USDB_API = 'https://blockle.org/api/usdb';
    let usdbInfo = null;
    function u64leHex(n) {
      const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
      return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    async function usdbLoad() {
      const bEl = $('#usdb-bal'); if (bEl) bEl.textContent = '…';
      try {
        usdbInfo = await (await fetch(USDB_API + '/info')).json();
        const dec = (usdbInfo && usdbInfo.decimals) || 6;
        if (usdbInfo && usdbInfo.contract && Wallet.address) {
          let bal = 0;
          try { const t = await Chain.token(usdbInfo.contract, Wallet.address); bal = Number((t && (t.holderBalance != null ? t.holderBalance : t.balance)) || 0); } catch {}
          if (bEl) bEl.textContent = (bal / Math.pow(10, dec)).toLocaleString(undefined, { maximumFractionDigits: 2 });
        } else if (bEl) bEl.textContent = '0';
      } catch { if (bEl) bEl.textContent = '—'; }
    }
    $('#usdb-buy').addEventListener('click', () => {
      const url = 'https://blockle.org/usdb?to=' + encodeURIComponent(Wallet.address || '');
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
      else window.open(url, '_blank', 'noopener');
    });
    $('#usdb-redeem').addEventListener('click', async () => {
      const err = $('#usdb-err'), ok = $('#usdb-ok'); err.textContent = ''; ok.hidden = true;
      const amt = parseFloat($('#usdb-ramt').value);
      const email = $('#usdb-remail').value.trim();
      if (!(amt > 0)) return (err.textContent = 'Enter a USDB amount.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return (err.textContent = 'Enter your PayPal email.');
      if (!Wallet.isUnlocked()) return (err.textContent = 'Unlock your wallet to redeem.');
      const btn = $('#usdb-redeem'); btn.disabled = true; btn.textContent = 'Preparing…';
      try {
        // 1) register the payout intent -> payoutRef + the on-chain amount to burn
        const intent = await (await fetch(USDB_API + '/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payoutEmail: email, amountUsd: amt }) })).json();
        if (intent.error) throw new Error(intent.error);
        if (!intent.payoutRef || !intent.contract) throw new Error('redeem not available');
        // 2) sign the on-chain redeem: selector 15 (0x0f) ‖ payoutRef(32) ‖ amount(8 LE)
        const input = '0f' + intent.payoutRef + u64leHex(intent.amountBase);
        const u = await Chain.utxos(Wallet.address);
        if (!u || !u.utxos.length) throw new Error('no spendable BLOCK for gas');
        btn.textContent = 'Signing redeem…';
        const built = await Wallet.buildCall(u.utxos, intent.contract, input, 0, 120000, 10);
        const res = await Chain.submit(built.raw);
        await recordPending(res.txid || built.txid, 'Redeem USDB');
        ok.hidden = false;
        ok.textContent = 'Redeem submitted — $' + intent.estPayoutUsd + ' will arrive in your PayPal once the burn confirms (~1 block).';
        $('#usdb-ramt').value = '';
        setTimeout(usdbLoad, 1500);
      } catch (e) {
        err.textContent = 'Redeem failed: ' + (e.message || e);
      } finally {
        btn.disabled = false; btn.textContent = 'Redeem to PayPal';
      }
    });

    // settings
    $('#export-wallet').addEventListener('click', async () => {
      try {
        const rec = await Wallet.exportFile();
        const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'blockle-wallet.json';
        a.click();
        URL.revokeObjectURL(url);
        toast('Wallet file exported');
      } catch {
        toast('Nothing to export');
      }
    });
    // NEW gated key/seed/dump export — runs WalletExport.exportSecrets behind the
    // security gate (vault unlocked + an explicit danger confirm), then presents
    // the mnemonic/seed + per-chain WIF/hex/base58 keys and offers the BTC/LTC/DOGE
    // Bitcoin-Core importwallet dumps for download. (The encrypted-file export
    // above stays available.)
    const exportKeysBtn = $('#export-keys');
    if (exportKeysBtn) exportKeysBtn.addEventListener('click', async () => {
      if (!window.WalletExportUI) return toast('Export unavailable');
      if (!Wallet.isUnlocked()) return toast('Unlock your wallet to export keys');
      const res = await WalletExportUI.open({
        wallet: Wallet,
        confirm: dangerConfirmSheet,
        present: presentSecretsSheet,
        download: downloadText,
        onBlocked: (r) => toast(r && r.reason === 'locked' ? 'Unlock your wallet to export keys' : 'Export cancelled'),
      });
      if (res && res.ok) toast('Keys exported — keep them private and offline');
    });
    // Encrypted cloud backup — vault is encrypted on-device under a backup passphrase; only
    // ciphertext is uploaded to your Blockle account (the server can never read it).
    const cloudBackupBtn = $('#cloud-backup');
    if (cloudBackupBtn) cloudBackupBtn.addEventListener('click', async () => {
      if (!window.WalletBackupUI) return toast('Backup unavailable');
      if (!Wallet.isUnlocked()) return toast('Unlock your wallet to back up');
      const v = await backupSheet('backup');
      if (!v) return;
      if (!v.email || !v.password || !v.passphrase) return toast('Fill in email, password and a backup passphrase');
      toast('Encrypting & uploading…');
      try {
        const res = await WalletBackupUI.backup({ email: v.email, password: v.password, totp: v.totp, passphrase: v.passphrase, device: 'extension' });
        toast(res && res.ok ? 'Backed up — encrypted, we can’t read it' : 'Backup failed: ' + ((res && res.reason) || 'error'));
      } catch (e) { toast('Backup failed: ' + (e && e.message ? e.message : e)); }
    });
    const cloudRestoreBtn = $('#cloud-restore');
    if (cloudRestoreBtn) cloudRestoreBtn.addEventListener('click', async () => {
      if (!window.WalletBackupUI) return toast('Backup unavailable');
      const v = await backupSheet('restore');
      if (!v) return;
      if (!v.email || !v.password || !v.passphrase || !v.newPassword) return toast('Fill in all fields');
      toast('Downloading & decrypting…');
      try {
        const res = await WalletBackupUI.restore({ email: v.email, password: v.password, totp: v.totp, passphrase: v.passphrase, newPassword: v.newPassword });
        if (res && res.ok) { toast('Wallet restored'); setTimeout(() => location.reload(), 900); }
        else toast('Restore failed: ' + (res && res.reason === 'bad-passphrase' ? 'wrong backup passphrase' : (res && res.reason) || 'error'));
      } catch (e) { toast('Restore failed: ' + (e && e.message ? e.message : e)); }
    });
    $('#lock-now').addEventListener('click', async () => {
      await doLock();
    });
    $('#reset-wallet').addEventListener('click', confirmReset);
    $('#api-base').addEventListener('change', async (e) => {
      await Store.set({ apiBase: e.target.value.trim() || Chain.DEFAULT_API });
      toast('Endpoint saved');
      await syncNetBadge();
      refreshNet();
    });
    // One-click Mainnet <-> Testnet. Testnet BLOCK is valueless (free from the
    // faucet) — for rehearsing launches/bridging without spending real BLOCK.
    $('#net-toggle').addEventListener('click', async () => {
      const onTest = await Chain.isTestnet();
      const next = onTest ? Chain.DEFAULT_API : Chain.TESTNET_API;
      await Store.set({ apiBase: next });
      if ($('#api-base')) $('#api-base').value = next;
      toast(onTest ? 'Switched to Mainnet' : 'Switched to Testnet — BLOCK here is free test coin');
      await syncNetBadge();
      refreshNet();
      refreshDashboard();
    });
    syncNetBadge();
    $('#exchange-base').addEventListener('change', async (e) => {
      await Store.set({ exchangeBase: e.target.value.trim() || Exchange.DEFAULT_BASE });
      await Exchange.signOut(); // a different relay means a new session
      toast('Exchange endpoint saved');
    });

    // multi-chain endpoints (all config, sane public defaults in the registry)
    const saveEndpoint = async (chain, key, value) => {
      const cur = (await Store.get('chainEndpoints')).chainEndpoints || {};
      cur[chain] = cur[chain] || {};
      const v = value.trim();
      if (v) cur[chain][key] = v; else delete cur[chain][key];
      await Store.set({ chainEndpoints: cur });
      if (window.Wiring) Wiring.reset();
      toast('Endpoint saved');
    };
    const epMap = [
      ['#ep-eth', 'ethereum', 'rpcUrl'],
      ['#ep-base', 'base', 'rpcUrl'],
      ['#ep-arb', 'arbitrum', 'rpcUrl'],
      ['#ep-op', 'optimism', 'rpcUrl'],
      ['#ep-poly', 'polygon', 'rpcUrl'],
      ['#ep-bnb', 'bnb', 'rpcUrl'],
      ['#ep-avax', 'avalanche', 'rpcUrl'],
      ['#ep-btc', 'bitcoin', 'esplora'],
      ['#ep-ltc', 'litecoin', 'esplora'],
      ['#ep-doge', 'dogecoin', 'esplora'],
    ];
    for (const [sel, chain, key] of epMap) {
      const el = $(sel);
      if (el) el.addEventListener('change', (e) => saveEndpoint(chain, key, e.target.value));
    }
    // Alchemy indexer key (read-only) under chainEndpoints.alchemy.apiKey —
    // shared across all Alchemy-backed EVM networks; enables ERC-20 auto-detect.
    const alk = $('#ep-alchemy');
    if (alk) alk.addEventListener('change', (e) => saveEndpoint('alchemy', 'apiKey', e.target.value));

    // MoonPay "Buy with card" config (publishable key + optional signing URL).
    // The publishable key is client-side and not a secret; the secret key is
    // never stored here (signing is server-side at the signing endpoint).
    const saveMoonPay = async (patch) => {
      if (!window.MoonPay) return;
      await MoonPay.saveConfig(patch);
      toast('MoonPay settings saved');
    };
    const mpKey = $('#mp-apikey');
    if (mpKey) mpKey.addEventListener('change', (e) => saveMoonPay({ apiKey: e.target.value.trim() || MoonPay.DEFAULT_API_KEY }));
    const mpSign = $('#mp-signurl');
    if (mpSign) mpSign.addEventListener('change', (e) => saveMoonPay({ signingEndpoint: e.target.value.trim() }));

    // ---- custom networks (user-added EVM networks; config, not secrets) ----
    const cnAdd = $('#cn-add');
    if (cnAdd) cnAdd.addEventListener('click', () => openCustomNetForm(null));
    const cnCancel = $('#cn-cancel');
    if (cnCancel) cnCancel.addEventListener('click', closeCustomNetForm);
    const cnSave = $('#cn-save');
    if (cnSave) cnSave.addEventListener('click', saveCustomNet);
    const cnList = $('#cn-list');
    if (cnList) cnList.addEventListener('click', (e) => {
      const ed = e.target.closest('[data-cn-edit]');
      if (ed) return void openCustomNetForm(ed.getAttribute('data-cn-edit'));
      const rm = e.target.closest('[data-cn-remove]');
      if (rm) return void removeCustomNet(rm.getAttribute('data-cn-remove'));
    });
  }

  // ---- custom networks: persistence + form (CustomNetworks is the pure logic) --
  let cnEditingId = null; // slug being edited, or null when adding

  async function getCustomNetworks() {
    return (await Store.get('customNetworks')).customNetworks || [];
  }
  async function setCustomNetworks(list) {
    await Store.set({ customNetworks: list });
    if (window.Wiring) Wiring.reset();
  }

  async function renderCustomNetworks() {
    const box = $('#cn-list');
    if (!box) return;
    const list = await getCustomNetworks();
    if (!list.length) { box.innerHTML = '<div class="empty">No custom networks yet.</div>'; return; }
    box.innerHTML = list.map((n) => `<div class="mc-acct" data-cn="${esc(n.id)}">
        <div class="mc-head">
          <div class="mc-name">${esc(n.name)} <span class="pill">#${esc(n.chainId)}</span></div>
          <div>
            <button class="mini-btn" data-cn-edit="${esc(n.id)}">Edit</button>
            <button class="mini-btn" data-cn-remove="${esc(n.id)}">Remove</button>
          </div>
        </div>
        <div class="mc-bal"><small class="muted mono">${esc(n.nativeSymbol)} · ${esc(n.rpcUrl)}</small></div>
      </div>`).join('');
  }

  function cnFormMsg(text, kind) {
    const el = $('#cn-form-msg');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = text;
    el.style.color = kind === 'error' ? 'var(--danger, #f85149)' : (kind === 'warn' ? '#e3b341' : '');
  }

  async function openCustomNetForm(id) {
    cnEditingId = id || null;
    const list = await getCustomNetworks();
    const n = id ? list.find((x) => x.id === id) : null;
    $('#cn-form-title').textContent = n ? 'Edit network' : 'Add network';
    $('#cn-name').value = n ? n.name : '';
    $('#cn-chainid').value = n ? String(n.chainId) : '';
    $('#cn-rpc').value = n ? n.rpcUrl : '';
    $('#cn-symbol').value = n ? n.nativeSymbol : '';
    $('#cn-decimals').value = n ? String(n.decimals) : '18';
    $('#cn-explorer').value = n ? (n.explorerUrl || '') : '';
    $('#cn-indexer').value = n ? (n.tokenIndexerUrl || '') : '';
    cnFormMsg('');
    $('#cn-form').hidden = false;
  }
  function closeCustomNetForm() {
    cnEditingId = null;
    $('#cn-form').hidden = true;
    cnFormMsg('');
  }

  async function saveCustomNet() {
    const CN = window.CustomNetworks;
    const raw = {
      name: $('#cn-name').value,
      chainId: $('#cn-chainid').value,
      rpcUrl: $('#cn-rpc').value,
      nativeSymbol: $('#cn-symbol').value,
      decimals: $('#cn-decimals').value,
      explorerUrl: $('#cn-explorer').value,
      tokenIndexerUrl: $('#cn-indexer').value,
    };
    const res = CN.validate(raw);
    if (!res.ok) {
      const first = Object.keys(res.errors)[0];
      cnFormMsg(res.errors[first], 'error');
      return;
    }
    const btn = $('#cn-save'); btn.disabled = true; btn.textContent = 'Checking RPC…';
    // Non-blocking eth_chainId probe: warn (don't block) on a mismatch.
    let warn = '';
    try {
      const reported = await CN.probeChainId(res.value.rpcUrl);
      if (reported != null && reported !== res.value.chainId) {
        warn = `RPC reports chain ID ${reported}, not ${res.value.chainId}. Saved anyway — double-check the values.`;
      }
    } catch { /* probe is best-effort */ }
    try {
      const list = await getCustomNetworks();
      const next = CN.upsert(list, raw, cnEditingId);
      await setCustomNetworks(next);
      if (warn) { cnFormMsg(warn, 'warn'); toast('Network saved (with a warning)'); }
      else { toast('Network saved'); closeCustomNetForm(); }
      await renderCustomNetworks();
    } catch (e) {
      cnFormMsg('Could not save: ' + (e.message || e), 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Save network';
    }
  }

  async function removeCustomNet(id) {
    if (!confirm('Remove this custom network?')) return;
    const CN = window.CustomNetworks;
    const list = await getCustomNetworks();
    await setCustomNetworks(CN.remove(list, id));
    if (cnEditingId === id) closeCustomNetForm();
    await renderCustomNetworks();
    toast('Network removed');
  }

  // Pass-2 lifecycle: keep the multi-chain Wiring caches + the in-wallet agent
  // credential store in step with the wallet session.
  async function afterUnlock(pw) {
    try { if (window.Wiring) Wiring.reset(); } catch {}
    try { if (window.AgentUI) await AgentUI.onUnlock(pw); } catch {}
    try { if (window.BotsUI) await BotsUI.onUnlock(pw); } catch {}
    try { if (window.WalletUI) await WalletUI.onUnlock(pw); } catch {}
  }
  async function afterResume() {
    try { if (window.Wiring) Wiring.reset(); } catch {}
    try { if (window.AgentUI) await AgentUI.onResume(); } catch {}
    try { if (window.BotsUI) await BotsUI.onResume(); } catch {}
    try { if (window.WalletUI) await WalletUI.onResume(); } catch {}
  }
  async function doLock() {
    await Wallet.lock();
    try { if (window.Wiring) Wiring.reset(); } catch {}
    try { if (window.AgentUI) await AgentUI.onLock(); } catch {}
    try { if (window.BotsUI) await BotsUI.onLock(); } catch {}
    try { if (window.WalletUI) await WalletUI.onLock(); } catch {}
    route('unlock');
  }

  async function confirmReset() {
    if (!confirm('Reset this wallet? Make sure you exported your wallet file — this cannot be undone.')) return;
    try { if (window.AgentUI) await AgentUI.onLock(); } catch {}
    try { if (window.BotsUI) await BotsUI.onLock(); } catch {}
    try { if (window.WalletUI) await WalletUI.onLock(); } catch {}
    try { if (window.Wiring) Wiring.reset(); } catch {}
    await Wallet.reset();
    try {
      await chrome.runtime.sendMessage({ type: 'wallet-state-changed', accounts: [] });
    } catch {}
    location.hash = '';
    route('welcome');
  }

  // ---- swap (native AMM) --------------------------------------------------
  let swapPools = [], swapSide = 'buy';
  const SWAP_FEE = 0.003, SLIPPAGE = 0.01, GAS_PRICE = 10, COIN = 100000000;
  const sfmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const curPool = () => swapPools[parseInt($('#swap-pool').value, 10)];
  function amountOut(inAmt, inRes, outRes) {
    if (inAmt <= 0 || inRes <= 0 || outRes <= 0) return 0;
    const ain = inAmt * (1 - SWAP_FEE);
    return (outRes * ain) / (inRes + ain);
  }

  async function initSwap() {
    $('#swap-err').textContent = '';
    $('#swap-amt').value = '';
    swapPools = await Chain.pools();
    const sel = $('#swap-pool');
    if (!swapPools.length) {
      sel.innerHTML = '<option value="">No liquidity pools yet</option>';
      $('#swap-go').disabled = true;
      swapQuote();
      return;
    }
    $('#swap-go').disabled = false;
    sel.innerHTML = swapPools
      .map((p, i) => `<option value="${i}">${p.symbol || '?'} — ${p.name || p.token.slice(0, 10)}</option>`)
      .join('');
    sel.onchange = () => setSwapSide(swapSide);
    $('#swap-amt').oninput = swapQuote;
    $('#swap-buy').onclick = () => setSwapSide('buy');
    $('#swap-sell').onclick = () => setSwapSide('sell');
    $('#swap-go').onclick = doSwap;
    $('#swap-unlock').hidden = Wallet.isUnlocked();
    setSwapSide('buy');
  }

  function setSwapSide(s) {
    swapSide = s;
    $('#swap-buy').classList.toggle('ghost', s !== 'buy');
    $('#swap-sell').classList.toggle('ghost', s !== 'sell');
    const p = curPool();
    const sym = (p && p.symbol) || 'token';
    $('#swap-in-label').textContent = s === 'buy' ? 'You pay (BLOCK)' : `You pay (${sym})`;
    swapQuote();
  }

  function swapQuote() {
    const p = curPool();
    const raw = parseFloat($('#swap-amt').value);
    if (!p || !(raw > 0)) {
      $('#swap-rate').textContent = '—'; $('#swap-out').textContent = '—'; $('#swap-min').textContent = '—';
      return;
    }
    const dec = Number(p.decimals || 0);
    const blockRes = p.blockReserve / COIN;
    const tokRes = p.tokenReserve / Math.pow(10, dec);
    const sym = p.symbol || 'token';
    let out, rate, outSym;
    if (swapSide === 'buy') { out = amountOut(raw, blockRes, tokRes); rate = `1 BLOCK ≈ ${sfmt(amountOut(1, blockRes, tokRes))} ${sym}`; outSym = sym; }
    else { out = amountOut(raw, tokRes, blockRes); rate = `1 ${sym} ≈ ${sfmt(amountOut(1, tokRes, blockRes))} BLOCK`; outSym = 'BLOCK'; }
    $('#swap-rate').textContent = rate;
    $('#swap-out').textContent = `${sfmt(out)} ${outSym}`;
    $('#swap-min').textContent = `${sfmt(out * (1 - SLIPPAGE))} ${outSym}`;
  }

  async function doSwap() {
    const p = curPool();
    const raw = parseFloat($('#swap-amt').value);
    const err = $('#swap-err'); err.textContent = '';
    if (!p || !(raw > 0)) { err.textContent = 'Enter an amount.'; return; }
    const btn = $('#swap-go'); btn.disabled = true; btn.textContent = 'Swapping…';
    try {
      if (!Wallet.isUnlocked()) await Wallet.unlock($('#swap-pw').value);
      // SECURITY GATE: inspect the pool/token target + confirm sheet BEFORE signing.
      const dec0 = Number(p.decimals || 0);
      const swapIn = swapSide === 'buy' ? Math.round(raw * COIN) : Math.round(raw * Math.pow(10, dec0));
      const cleared = await securityGate({ kind: 'swap', side: swapSide, token: p.token, amountIn: String(swapIn) });
      if (!cleared) { btn.disabled = false; btn.textContent = 'Swap'; err.textContent = 'Swap cancelled by the security review.'; return; }
      const u = await Chain.utxos(Wallet.address);
      if (!u || !u.utxos.length) throw new Error('no spendable funds for gas');
      const dec = Number(p.decimals || 0);
      const blockRes = p.blockReserve / COIN, tokRes = p.tokenReserve / Math.pow(10, dec);
      let built;
      if (swapSide === 'buy') {
        const blockIn = BigInt(Math.round(raw * COIN));
        const minOut = BigInt(Math.floor(amountOut(raw, blockRes, tokRes) * (1 - SLIPPAGE) * Math.pow(10, dec)));
        built = await Wallet.buildPoolSwapBuy(u.utxos, p.token, blockIn.toString(), minOut.toString(), 200000, GAS_PRICE);
      } else {
        const tokIn = BigInt(Math.round(raw * Math.pow(10, dec)));
        const minOut = BigInt(Math.floor(amountOut(raw, tokRes, blockRes) * (1 - SLIPPAGE) * COIN));
        built = await Wallet.buildPoolSwapSell(u.utxos, p.token, tokIn.toString(), minOut.toString(), 200000, GAS_PRICE);
      }
      const sres = await Chain.submit(built.raw);
      await recordPending(sres.txid || built.txid, swapSide === 'buy' ? 'Buy' : 'Sell');
      toast('Swap submitted');
      route('queue');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Swap';
      err.textContent = /locked|password|no wallet/i.test(e.message) ? 'Wrong password.' : 'Swap failed: ' + e.message;
    }
  }

  // ---- transaction queue (blocks are ~10 min; show pending until mined) ---
  async function recordPending(txid, kind) {
    if (!txid) return;
    const list = (await Store.get('pending')).pending || [];
    if (!list.some((x) => x.txid === txid)) {
      list.unshift({ txid, kind, time: Date.now() });
      await Store.set({ pending: list.slice(0, 30) });
    }
  }

  async function renderQueue() {
    const box = $('#queue-list');
    if (!box) return;
    const list = (await Store.get('pending')).pending || [];
    if (!list.length) {
      box.innerHTML = '<div class="empty">No recent transactions. Submitted sends, swaps and deploys appear here until they confirm.</div>';
      return;
    }
    box.innerHTML = list
      .map((x) => `<div class="row"><div class="l"><b>${x.kind}</b><small class="mono">${x.txid.slice(0, 22)}…</small></div><div class="r" data-tx="${x.txid}">checking…</div></div>`)
      .join('');
    const infos = await Promise.all(list.map((x) => Chain.tx(x.txid)));
    list.forEach((x, i) => {
      const cell = box.querySelector(`[data-tx="${x.txid}"]`);
      if (!cell) return;
      const t = infos[i];
      // The node returns { block_hash, tx:{ block_height, confirmations, … } }.
      // A non-null block_hash means it's mined; confirmations live on tx.
      const txo = (t && t.tx) || t || null;
      const confd = !!(t && t.block_hash) || !!(txo && (txo.confirmations != null || txo.block_height != null));
      const confs = txo && txo.confirmations != null ? txo.confirmations : null;
      // A tx that is neither mined nor in the mempool after several block
      // intervals was almost certainly dropped (e.g. it lost a double-spend race
      // to another attempt on the same input) and will never confirm.
      const agedMs = Date.now() - (x.time || 0);
      const dropped = !confd && agedMs > 20 * 60 * 1000;
      cell.innerHTML = confd
        ? `<span style="color:#34d399">confirmed${confs != null ? ' · ' + confs + ' conf' : ''}</span>`
        : dropped
        ? '<span style="color:#9aa0aa">dropped · safe to ignore</span>'
        : '<span style="color:#f2b04a">pending…</span>';
    });
  }

  // ---- embedded exchange --------------------------------------------------
  // Talks to the Blockle Exchange relay via exchange-client.js (the SHARED API
  // CONTRACT). Signing is local ML-DSA (Wallet); the relay never sees a key.
  let exMarkets = [], exMarket = null, exSide = 'buy', exType = 'limit', exStream = null, exWired = false;
  const exCur = () => exMarkets.find((m) => m.market === exMarket);
  const exBaseDec = () => { const m = exCur(); return (m && m.baseAsset && m.baseAsset.decimals) || 0; };
  const exQuoteDec = () => { const m = exCur(); return (m && m.quoteAsset && m.quoteAsset.decimals) || 0; };
  const exBaseSym = () => { const m = exCur(); return (m && m.base) || 'BASE'; };
  const exQuoteSym = () => { const m = exCur(); return (m && m.quote) || 'QUOTE'; };

  function showExSignin() {
    $('#ex-main').hidden = true;
    $('#ex-signin').hidden = false;
    const locked = !Wallet.isUnlocked();
    const watch = false;
    $('#ex-unlock').hidden = !locked;
    Wallet.selected().then((rec) => {
      if (rec && rec.watchOnly) {
        $('#ex-signin-note').textContent = 'This is a watch-only wallet — it cannot sign in to trade. Import a signing wallet to use the exchange.';
        $('#ex-signin-go').disabled = true;
        $('#ex-unlock').hidden = true;
      } else {
        $('#ex-signin-go').disabled = false;
      }
    });
  }
  function showExMain() {
    $('#ex-signin').hidden = true;
    $('#ex-main').hidden = false;
  }

  async function exLoadMarkets() {
    const sel = $('#ex-market');
    try {
      exMarkets = (await Exchange.getMarkets()) || [];
    } catch (e) {
      exMarkets = [];
    }
    if (!exMarkets.length) {
      sel.innerHTML = '<option value="">No markets listed yet</option>';
      $('#ex-book').innerHTML = '<div class="empty">No markets listed yet.</div>';
      $('#ex-place').disabled = true;
      return;
    }
    $('#ex-place').disabled = false;
    sel.innerHTML = exMarkets.map((m) => `<option value="${m.market}">${m.market}</option>`).join('');
    if (!exMarket || !exCur()) exMarket = exMarkets[0].market;
    sel.value = exMarket;
    exSelectMarket(exMarket);
  }

  function exSelectMarket(m) {
    exMarket = m;
    const cm = exCur();
    $('#ex-meta').textContent = cm
      ? `${exBaseSym()} (${cm.baseAsset.chain}) / ${exQuoteSym()} (${cm.quoteAsset.chain})`
      : '';
    exUpdateLabels();
    exLoadBook();
    exSubscribe();
  }

  function exUpdateLabels() {
    $('#ex-price-label').textContent = `Price (${exQuoteSym()} per ${exBaseSym()})`;
    $('#ex-amt-label').textContent = `Amount (${exBaseSym()})`;
    $('#ex-price-field').style.display = exType === 'market' ? 'none' : '';
  }

  async function exLoadBook() {
    let book = { bids: [], asks: [] };
    try {
      book = (await Exchange.getBook(exMarket)) || book;
    } catch {}
    exRenderBook(book);
  }
  function exRenderBook(book) {
    const bids = book.bids || [], asks = book.asks || [];
    const box = $('#ex-book');
    if (!bids.length && !asks.length) {
      box.innerHTML = '<div class="empty">No resting orders. Place one — it posts to the book.</div>';
      return;
    }
    let maxAmt = 0;
    bids.concat(asks).forEach((l) => (maxAmt = Math.max(maxAmt, Number(l.amount) || 0)));
    const dec = exBaseDec();
    const row = (l, cls) => {
      const w = maxAmt ? ((Number(l.amount) || 0) / maxAmt) * 100 : 0;
      const amt = Number(Exchange.toHuman(l.amount, dec)).toLocaleString(undefined, { maximumFractionDigits: 6 });
      return `<div class="ex-lvl ${cls}" data-px="${l.price}" data-amt="${l.amount}"><span class="ex-depth" style="width:${w}%"></span><span class="ex-px">${l.price}</span><span class="ex-qty">${amt}</span></div>`;
    };
    box.innerHTML =
      `<div class="ex-side asks">${asks.slice(0, 8).reverse().map((l) => row(l, 'ask')).join('') || '<div class="muted" style="padding:4px 8px">—</div>'}</div>` +
      `<div class="ex-side bids">${bids.slice(0, 8).map((l) => row(l, 'bid')).join('') || '<div class="muted" style="padding:4px 8px">—</div>'}</div>`;
    $$('.ex-lvl', box).forEach((r) =>
      r.addEventListener('click', () => {
        $('#ex-price').value = r.getAttribute('data-px');
        $('#ex-amt').value = Exchange.toHuman(r.getAttribute('data-amt'), dec);
      })
    );
  }

  function exSubscribe() {
    if (exStream) { try { exStream.close(); } catch {} exStream = null; }
    Exchange.stream(exMarket, (msg) => {
      if (!msg) return;
      if ((msg.type === 'book' || msg.book) && (msg.market === exMarket || !msg.market)) {
        exRenderBook(msg.book || msg);
      } else if (msg.type === 'trade' || msg.trade) {
        exLoadBook();
      }
    }).then((s) => (exStream = s));
  }

  async function exRenderMine() {
    const box = $('#ex-myorders');
    let orders = [];
    try {
      orders = (await Exchange.getMyOrders()) || [];
    } catch {
      box.innerHTML = '<div class="empty">Sign in to see your orders.</div>';
      return;
    }
    const open = orders.filter((o) => !o.status || /open|resting|partial|new/i.test(o.status));
    if (!open.length) {
      box.innerHTML = '<div class="empty">No open orders.</div>';
      return;
    }
    box.innerHTML = open
      .map((o) => {
        const m = exMarkets.find((mm) => mm.market === o.market);
        const dec = (m && m.baseAsset && m.baseAsset.decimals) || 0;
        const amt = Number(Exchange.toHuman(o.amount, dec)).toLocaleString(undefined, { maximumFractionDigits: 6 });
        return `<div class="row"><div class="l"><b>${(o.side || '').toUpperCase()} ${o.market}</b><small class="mono">${amt} @ ${o.price != null ? o.price : 'mkt'}</small></div><button class="mini-btn" data-cancel="${o.orderId || o.id}">Cancel</button></div>`;
      })
      .join('');
    $$('[data-cancel]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        // CONFIRM-GATE the (signed, authenticated) cancel through the SHARED
        // sheet. First-party orderbook action => inspect() N/A, confirm-only.
        const row = open.find((o) => String(o.orderId || o.id) === String(b.dataset.cancel));
        const cleared = await securityGate({
          kind: 'cancel', orderId: b.dataset.cancel,
          market: row && row.market, side: row && row.side,
        });
        if (!cleared) { toast('Cancel not confirmed'); return; }
        b.disabled = true;
        try {
          await Exchange.cancelOrder(b.dataset.cancel);
          toast('Order cancelled');
          exRenderMine();
        } catch (e) {
          b.disabled = false;
          toast('Cancel failed');
        }
      })
    );
  }

  function exSetSide(s) {
    exSide = s;
    $('#ex-buy').classList.toggle('ghost', s !== 'buy');
    $('#ex-sell').classList.toggle('ghost', s !== 'sell');
  }
  function exSetType(t) {
    exType = t;
    $('#ex-limit').classList.toggle('active', t === 'limit');
    $('#ex-market-type').classList.toggle('active', t === 'market');
    exUpdateLabels();
  }

  async function exPlace() {
    const err = $('#ex-order-err');
    err.textContent = '';
    const amtHuman = $('#ex-amt').value.trim();
    const pxHuman = $('#ex-price').value.trim();
    if (!(parseFloat(amtHuman) > 0)) return (err.textContent = 'Enter an amount.');
    if (exType === 'limit' && !(parseFloat(pxHuman) > 0)) return (err.textContent = 'Enter a limit price.');
    // CONFIRM-GATE every value-moving exchange action through the SHARED sheet.
    // A place_order is a FIRST-PARTY orderbook action — no external recipient /
    // calldata, so inspect() is N/A; the sheet is reused for a consistent preview
    // and nothing is signed/placed until the operator clears it.
    const cleared = await securityGate({
      kind: 'order', market: exMarket, side: exSide, type: exType,
      base: exBaseSym(), quote: exQuoteSym(),
      amount: amtHuman, price: exType === 'market' ? null : pxHuman,
    });
    if (!cleared) { err.textContent = 'Order cancelled at review (or security suite unavailable).'; return; }
    const btn = $('#ex-place');
    btn.disabled = true;
    btn.textContent = 'Signing & placing…';
    try {
      await Exchange.placeOrder({
        market: exMarket,
        side: exSide,
        type: exType,
        price: exType === 'market' ? null : pxHuman,
        amount: Exchange.toBase(amtHuman, exBaseDec()),
      });
      toast('Order placed');
      $('#ex-amt').value = '';
      exLoadBook();
      exRenderMine();
    } catch (e) {
      err.textContent = /locked|no wallet|password/i.test(e.message) ? 'Unlock your wallet first.' : 'Order failed: ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place order';
    }
  }

  async function exBuyBlock() {
    const err = $('#ex-x402-err');
    err.textContent = '';
    const usdc = parseFloat($('#ex-usdc').value);
    if (!(usdc > 0)) return (err.textContent = 'Enter a USDC amount.');
    const btn = $('#ex-buyblock');
    btn.disabled = true;
    btn.textContent = 'Requesting…';
    try {
      const usdcBase = Exchange.toBase(String(usdc), 6); // USDC = 6 dp on Base
      // NO SECURITY GATE HERE — and that is correct TODAY: this build has no
      // EVM/USDC signer, so buyBlock NEVER signs/broadcasts. A 402 only surfaces
      // the relay challenge to the user (handled below); no value moves from this
      // path. MUST GAIN THE SHARED CONFIRM GATE (SecurityGate.gate / inspect on the
      // relay/seller-supplied payTo, like the agent buy_block tool) the moment a
      // real USDC signer is wired so an x402 settlement cannot sign un-inspected.
      const res = await Exchange.buyBlock(usdcBase, Wallet.address);
      if (res.paymentRequired) {
        err.textContent =
          'The relay requires a USDC payment (x402). This wallet has no EVM/USDC signer yet (multi-chain pass). Use the hosted buy page to complete, or add an EVM account when available.';
      } else {
        const r = res.receipt || {};
        const out = r.blockOut ? Exchange.toHuman(r.blockOut, 8) + ' BLOCK' : 'order accepted';
        toast('Buy: ' + out);
        $('#ex-usdc').value = '';
      }
    } catch (e) {
      err.textContent = 'Buy failed: ' + (e.message || e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Buy BLOCK';
    }
  }

  function wireExchange() {
    if (exWired) return;
    exWired = true;
    $('#ex-refresh').addEventListener('click', () => enterExchange());
    $('#ex-signin-go').addEventListener('click', async () => {
      $('#ex-signin-err').textContent = '';
      const btn = $('#ex-signin-go');
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      try {
        if (!Wallet.isUnlocked()) await Wallet.unlock($('#ex-pw').value);
        await Exchange.signIn();
        $('#ex-pw').value = '';
        await enterExchange();
      } catch (e) {
        $('#ex-signin-err').textContent = /locked|no wallet|password|wrong/i.test(e.message)
          ? 'Wrong password.'
          : 'Sign-in failed: ' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign in to exchange';
      }
    });
    $('#ex-signout').addEventListener('click', async () => {
      await Exchange.signOut();
      enterExchange();
    });
    $('#ex-market').addEventListener('change', (e) => exSelectMarket(e.target.value));
    $('#ex-buy').addEventListener('click', () => exSetSide('buy'));
    $('#ex-sell').addEventListener('click', () => exSetSide('sell'));
    $('#ex-limit').addEventListener('click', () => exSetType('limit'));
    $('#ex-market-type').addEventListener('click', () => exSetType('market'));
    $('#ex-place').addEventListener('click', exPlace);
    $('#ex-buyblock').addEventListener('click', exBuyBlock);
  }

  async function enterExchange() {
    wireExchange();
    exSetSide('buy');
    exSetType('limit');
    await Exchange.resume();
    if (Exchange.isSignedIn()) {
      showExMain();
      $('#ex-conn').textContent = 'signed in · ' + shortAddr(Exchange.sessionAddress());
      await exLoadMarkets();
      await exRenderMine();
    } else {
      showExSignin();
    }
  }

  // ---- Trade (super-AMM: custodial shared-price BLOCK market) -------------
  const AMM_API = 'https://blockle.org/api/amm';
  let ammSide = 'buy', ammPairs = [], ammDec = { BLOCK: 8 }, ammWired = false, ammQTimer = null, ammLive = false, ammPollTimer = null;
  function ammToBase(str, dec) {
    str = String(str == null ? '' : str).trim();
    if (!str || !/^\d*\.?\d*$/.test(str)) return '0';
    const parts = str.split('.'); const whole = parts[0] || '0';
    let frac = (parts[1] || '').slice(0, dec); while (frac.length < dec) frac += '0';
    try { return (BigInt(whole) * (10n ** BigInt(dec)) + BigInt(frac || '0')).toString(); } catch (_) { return '0'; }
  }
  function ammWhole(base, dec) { try { return Number(BigInt(base)) / Math.pow(10, dec); } catch (_) { return Number(base) / Math.pow(10, dec); } }
  function ammCur() { return $('#amm-cur').value; }
  function ammCurDec() { return ammDec[ammCur()] || 8; }
  function ammSetSide(s) {
    ammSide = s;
    $('#amm-buy').classList.toggle('ghost', s !== 'buy');
    $('#amm-sell').classList.toggle('ghost', s !== 'sell');
    $('#amm-amt-l').textContent = s === 'buy' ? 'You pay' : 'You sell (BLOCK)';
    ammQuote();
  }
  async function tradeLoad() {
    $('#amm-err').textContent = '';
    if (!ammWired) {
      ammWired = true;
      $('#amm-buy').addEventListener('click', () => ammSetSide('buy'));
      $('#amm-sell').addEventListener('click', () => ammSetSide('sell'));
      $('#amm-amt').addEventListener('input', () => { clearTimeout(ammQTimer); ammQTimer = setTimeout(ammQuote, 220); });
      $('#amm-cur').addEventListener('change', ammQuote);
      $('#amm-go').addEventListener('click', ammExecute);
    }
    try {
      const info = await fetch(AMM_API + '/info').then((r) => r.json());
      ammLive = !!info.live;
      ammPairs = info.pairs || [];
      ammDec = { BLOCK: info.blockDecimals || 8 };
      ammPairs.forEach((p) => (ammDec[p.sym] = p.decimals));
      $('#amm-price').textContent = '$' + Number(info.priceUsd).toLocaleString(undefined, { maximumFractionDigits: 6 });
      $('#amm-mode').textContent = info.paper ? 'paper' : 'live';
      $('#amm-sub').textContent = (info.paper ? 'Paper market — no real funds move yet · ' : '') + 'fee ' + (info.feeBps / 100) + '% · seed ' + info.seed.block.toLocaleString() + ' BLOCK @ $' + info.seed.priceUsd;
      const sel = $('#amm-cur');
      if (sel.options.length !== ammPairs.length) sel.innerHTML = ammPairs.map((p) => `<option value="${p.sym}">${p.sym} · ${p.network}</option>`).join('');
      $('#amm-pairs').innerHTML = ammPairs.map((p) => {
        const liq = p.hasLiquidity; const maxBlk = ammWhole(p.maxSellableBlockBase, info.blockDecimals || 8);
        return `<div class="row"><div class="l"><b>${p.pair}</b><br><small>${p.network} · ${liq ? 'sellable ≤ ' + maxBlk.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' BLOCK' : 'no liquidity yet — buys seed it'}</small></div><span class="pill">${liq ? 'live' : 'empty'}</span></div>`;
      }).join('') || '<div class="muted">No pairs.</div>';
      ammQuote();
    } catch (_) { $('#amm-err').textContent = 'Market unavailable right now.'; }
  }
  async function ammQuote() {
    const amtStr = $('#amm-amt').value, sym = ammCur(), side = ammSide;
    const go = $('#amm-go'), q = $('#amm-quote');
    $('#amm-err').textContent = '';
    const inDec = side === 'buy' ? ammCurDec() : (ammDec.BLOCK || 8);
    const amountBase = ammToBase(amtStr, inDec);
    if (!amtStr || amountBase === '0') { q.textContent = 'Enter an amount to see a quote.'; go.disabled = true; go.textContent = 'Enter an amount'; return; }
    q.textContent = 'Quoting…'; go.disabled = true;
    try {
      const r = await fetch(`${AMM_API}/quote?side=${side}&sym=${encodeURIComponent(sym)}&amount=${amountBase}`);
      const d = await r.json();
      if (!r.ok) { q.textContent = d.error || 'Quote failed'; return; }
      const impact = Number(d.priceBeforeMicroUsd) > 0 ? (Number(d.priceAfterMicroUsd) - Number(d.priceBeforeMicroUsd)) / Number(d.priceBeforeMicroUsd) * 100 : 0;
      if (side === 'buy') {
        q.innerHTML = `Receive <b>${ammWhole(d.blockOut, ammDec.BLOCK || 8).toLocaleString(undefined, { maximumFractionDigits: 4 })} BLOCK</b> · fee $${(Number(d.feeUsd) / 1e6).toFixed(2)} · impact ${impact.toFixed(2)}%`;
        go.disabled = false; go.textContent = 'Buy BLOCK';
      } else {
        const out = ammWhole(d.assetOut, ammCurDec());
        if (!d.liquidity) {
          const p = ammPairs.find((x) => x.sym === sym) || {}; const maxBlk = ammWhole(p.maxSellableBlockBase || '0', ammDec.BLOCK || 8);
          q.innerHTML = `<small>Would receive ${out.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym}, but the ${sym} pair only has liquidity for ≤ ${maxBlk.toLocaleString(undefined, { maximumFractionDigits: 2 })} BLOCK.</small>`;
          go.disabled = true; go.textContent = maxBlk > 0 ? 'Reduce amount' : 'No ' + sym + ' liquidity';
        } else {
          q.innerHTML = `Receive <b>${out.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym}</b> · fee $${(Number(d.feeUsd) / 1e6).toFixed(2)} · impact ${impact.toFixed(2)}%`;
          go.disabled = false; go.textContent = 'Sell BLOCK';
        }
      }
    } catch (_) { q.textContent = 'Quote unavailable'; }
  }
  async function ammExecute() {
    if (ammLive) return ammLiveIntent();
    const side = ammSide, sym = ammCur();
    const inDec = side === 'buy' ? ammCurDec() : (ammDec.BLOCK || 8);
    const amountBase = ammToBase($('#amm-amt').value, inDec);
    if (amountBase === '0') return;
    const go = $('#amm-go'); const label = go.textContent; go.disabled = true; go.textContent = 'Submitting…';
    try {
      const r = await fetch(AMM_API + '/trade', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ side, sym, amount: amountBase, to: Wallet.address }) });
      const d = await r.json();
      if (!r.ok) { toast(d.code === 'NO_LIQUIDITY' ? ('Not enough ' + sym + ' liquidity') : (d.error || 'Trade failed')); go.disabled = false; go.textContent = label; return; }
      if (side === 'buy') toast('Bought ' + ammWhole(d.blockOut, ammDec.BLOCK || 8).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' BLOCK' + (d.paper ? ' (paper)' : ''));
      else toast('Sold BLOCK for ' + ammWhole(d.assetOut, ammCurDec()).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' ' + sym + (d.paper ? ' (paper)' : ''));
      $('#amm-amt').value = ''; go.textContent = label;
      tradeLoad();
    } catch (_) { toast('Trade unavailable'); go.disabled = false; go.textContent = label; }
  }

  // LIVE: create an intent -> show deposit instructions -> poll to settlement.
  async function ammLiveIntent() {
    const side = ammSide, sym = ammCur();
    const pair = ammPairs.find((p) => p.sym === sym) || {};
    const inDec = side === 'buy' ? ammCurDec() : (ammDec.BLOCK || 8);
    const amountBase = ammToBase($('#amm-amt').value, inDec);
    if (amountBase === '0') return;
    const go = $('#amm-go'); const label = go.textContent; go.disabled = true; go.textContent = 'Creating order…';
    let payoutAddress = Wallet.address; // buy -> your BLOCK address
    if (side === 'sell') {
      try { payoutAddress = window.Wiring ? await Wiring.accounts().then((a) => a.accountFor(pair.chain || 'block')).then((x) => x.address) : Wallet.address; }
      catch (_) { payoutAddress = Wallet.address; }
    }
    try {
      const r = await fetch(AMM_API + '/intent', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ side, sym, amount: amountBase, payoutAddress }) });
      const it = await r.json();
      go.textContent = label; go.disabled = false;
      if (!r.ok) { toast(it.code === 'NO_LIQUIDITY' ? ('Not enough ' + sym + ' liquidity') : (it.error || 'Could not create order')); return; }
      ammShowDeposit(it);
    } catch (_) { toast('Order failed'); go.textContent = label; go.disabled = false; }
  }
  function ammShowDeposit(it) {
    const depDec = ammDec[it.depositAsset] || 8, outDec = ammDec[it.payoutAsset] || 8;
    const amt = ammWhole(it.amountInBase, depDec), out = ammWhole(it.quote.outBase, outDec);
    $('#amm-quote').innerHTML = `Send exactly <b>${amt} ${it.depositAsset}</b> to:<br><code style="font-size:10px;word-break:break-all">${it.depositAddress}</code> <button class="btn" id="amm-dp-copy" style="padding:2px 8px">copy</button><br>You receive ≈ <b>${out.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${it.payoutAsset}</b><br><span id="amm-dp-status" class="muted">Waiting for your deposit…</span>`;
    const cp = $('#amm-dp-copy'); if (cp) cp.onclick = () => { navigator.clipboard.writeText(it.depositAddress); toast('Copied'); };
    ammPollIntent(it.id);
  }
  function ammPollIntent(id) {
    clearInterval(ammPollTimer);
    const tick = async () => {
      try {
        const it = await fetch(AMM_API + '/intent/' + encodeURIComponent(id)).then((r) => r.json());
        const el = $('#amm-dp-status'); if (!el) { clearInterval(ammPollTimer); return; }
        const outDec = ammDec[it.payoutAsset] || 8;
        if (it.status === 'awaiting_deposit') el.textContent = 'Waiting for your deposit…';
        else if (it.status === 'funded') el.textContent = 'Deposit detected — executing…';
        else if (it.status === 'executed' || it.status === 'paid') el.textContent = 'Paying out…';
        else if (it.status === 'settled') { el.innerHTML = `<b style="color:#4ADE80">✓ Done</b> — received ${ammWhole(it.executedOutBase || it.quote.outBase, outDec).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${it.payoutAsset}`; clearInterval(ammPollTimer); tradeLoad(); }
        else if (it.status === 'refund') { el.innerHTML = '<b style="color:#f87171">Refunded</b> — ' + (it.error || 'price moved / no liquidity'); clearInterval(ammPollTimer); }
        else if (it.status === 'expired') { el.textContent = 'Order expired — no deposit received.'; clearInterval(ammPollTimer); }
      } catch (_) {}
    };
    tick(); ammPollTimer = setInterval(tick, 5000);
  }

  async function route(name) {
    if (name === 'queue') {
      show('queue');
      renderQueue();
      return;
    }
    if (name === 'dashboard') {
      const rec = await Wallet.selected();
      $('#watch-pill').hidden = !(rec && rec.watchOnly);
      setActiveLabel();
      show('dashboard');
      syncNetBadge();
      refreshDashboard();
      refreshNet();
      return;
    }
    if (name === 'wallets') {
      show('wallets');
      renderWallets();
      return;
    }
    if (name === 'receive') {
      show('receive');
      $('#addr-full').textContent = Wallet.address;
      identicon($('#identicon'), Wallet.address || 'block1');
      return;
    }
    if (name === 'swap') {
      show('swap');
      initSwap();
      return;
    }
    if (name === 'trade') {
      show('trade');
      tradeLoad();
      return;
    }
    if (name === 'usdb') {
      show('usdb');
      usdbLoad();
      return;
    }
    if (name === 'exchange') {
      show('exchange');
      enterExchange();
      return;
    }
    if (name === 'accounts') {
      if (window.AccountsUI) return void AccountsUI.enter();
      show('accounts');
      return;
    }
    if (name === 'agent') {
      if (window.AgentUI) return void AgentUI.enter();
      show('agent');
      return;
    }
    if (name === 'bots') {
      if (window.BotsUI) return void BotsUI.enter();
      show('bots');
      return;
    }
    if (name === 'wallet') {
      if (window.WalletUI) return void WalletUI.enter();
      show('wallet');
      return;
    }
    if (name === 'connections') {
      show('connections');
      refreshConnections();
      return;
    }
    if (name === 'settings') {
      show('settings');
      $('#api-base').value = (await Store.get('apiBase')).apiBase || Chain.DEFAULT_API;
      $('#exchange-base').value = (await Store.get('exchangeBase')).exchangeBase || Exchange.DEFAULT_BASE;
      const ep = (await Store.get('chainEndpoints')).chainEndpoints || {};
      if ($('#ep-eth')) $('#ep-eth').value = (ep.ethereum && ep.ethereum.rpcUrl) || '';
      if ($('#ep-base')) $('#ep-base').value = (ep.base && ep.base.rpcUrl) || '';
      if ($('#ep-arb')) $('#ep-arb').value = (ep.arbitrum && ep.arbitrum.rpcUrl) || '';
      if ($('#ep-op')) $('#ep-op').value = (ep.optimism && ep.optimism.rpcUrl) || '';
      if ($('#ep-poly')) $('#ep-poly').value = (ep.polygon && ep.polygon.rpcUrl) || '';
      if ($('#ep-bnb')) $('#ep-bnb').value = (ep.bnb && ep.bnb.rpcUrl) || '';
      if ($('#ep-avax')) $('#ep-avax').value = (ep.avalanche && ep.avalanche.rpcUrl) || '';
      if ($('#ep-btc')) $('#ep-btc').value = (ep.bitcoin && ep.bitcoin.esplora) || '';
      if ($('#ep-ltc')) $('#ep-ltc').value = (ep.litecoin && ep.litecoin.esplora) || '';
      if ($('#ep-doge')) $('#ep-doge').value = (ep.dogecoin && ep.dogecoin.esplora) || '';
      if ($('#ep-alchemy')) $('#ep-alchemy').value = (ep.alchemy && ep.alchemy.apiKey) || '';
      if (window.MoonPay && ($('#mp-apikey') || $('#mp-signurl'))) {
        const mp = await MoonPay.loadConfig();
        if ($('#mp-apikey')) $('#mp-apikey').value = mp.apiKey || '';
        if ($('#mp-signurl')) $('#mp-signurl').value = mp.signingEndpoint || '';
      }
      closeCustomNetForm();
      await renderCustomNetworks();
      return;
    }
    if (name === 'send') { sendCtx = (pendingSendCtx !== undefined) ? pendingSendCtx : null; pendingSendCtx = undefined; configureSendScreen(); }
    show(name);
  }

  // Open the selected wallet: resume its session → dashboard; a watch-only
  // wallet → dashboard; otherwise ask for its password.
  async function enterSelected() {
    try { if (window.Wiring) Wiring.reset(); } catch {}
    await Wallet.loadPublic();
    if (await Wallet.resumeSession()) { await afterResume(); return route('dashboard'); }
    const rec = await Wallet.selected();
    if (rec && rec.watchOnly) return route('dashboard');
    return route('unlock');
  }

  // Shared nav/util surface the Pass-2 UI controllers (AccountsUI, AgentUI) call
  // into, so they don't duplicate the popup's screen/toast/copy plumbing.
  // confirmInspection: show the shared confirm sheet for a pre-computed
  // Inspection (e.g. from Wiring.inspect for a multi-chain send). Fails closed
  // (false) on a null inspection — the caller then MUST NOT sign/broadcast.
  async function confirmInspection(inspection) {
    if (!inspection) return false;
    return securitySheet(inspection);
  }
  const BlockleUI = { show, toast, route, shortAddr, copy, recordPending, $, $$,
    securityGate, securitySheet, confirmInspection };
  window.BlockleUI = BlockleUI;

  async function initNormal() {
    wireNormal();
    if (window.AccountsUI) AccountsUI.init(BlockleUI);
    if (window.AgentUI) AgentUI.init(BlockleUI);
    if (window.BotsUI) BotsUI.init(BlockleUI);
    if (window.WalletUI) WalletUI.init(BlockleUI);
    refreshNet();
    if (!(await Wallet.exists())) return route('welcome');
    enterSelected();
  }

  // ---- approve-mode wiring (dApp connect / sign) --------------------------
  async function initApprove(reqId) {
    const detail = (await Store.get('pending:' + reqId))['pending:' + reqId];
    const respond = (approved, payload) => {
      chrome.runtime.sendMessage({ type: 'approve-response', req: reqId, approved, payload }).finally(() => window.close());
    };
    if (!detail) {
      window.close();
      return;
    }
    await Wallet.loadPublic().catch(() => {});
    await Wallet.resumeSession().catch(() => {});

    if (detail.type === 'connect') {
      $('#connect-origin').textContent = detail.origin;
      show('approve-connect');
      $('#connect-reject').addEventListener('click', () => respond(false));
      $('#connect-approve').addEventListener('click', () => respond(true));
    } else if (detail.type === 'sign') {
      $('#sign-origin').textContent = detail.origin;
      $('#sign-msg').textContent = detail.message || '(empty message)';
      show('approve-sign');
      const needUnlock = !Wallet.isUnlocked();
      $('#sign-unlock').hidden = !needUnlock;
      $('#sign-reject').addEventListener('click', () => respond(false));
      $('#sign-approve').addEventListener('click', async () => {
        $('#sign-err').textContent = '';
        try {
          if (!Wallet.isUnlocked()) {
            await Wallet.unlock($('#sign-pw').value);
          }
          // SECURITY GATE: decode the message + shared confirm sheet BEFORE signing.
          const cleared = await securityGate({ kind: 'signMessage', message: detail.message || '' });
          if (!cleared) { $('#sign-err').textContent = 'Signature cancelled by the security review.'; return; }
          const sig = await Wallet.signMessage(detail.message || '');
          respond(true, sig);
        } catch (e) {
          $('#sign-err').textContent = /locked|no wallet|password/i.test(e.message)
            ? 'Wrong password.'
            : 'Could not sign: ' + e.message;
        }
      });
    } else if (detail.type === 'deploy') {
      const GAS_PRICE = 10,
        COIN = 100000000;
      const gas = parseInt(detail.gas) || 200000;
      $('#deploy-origin').textContent = detail.origin;
      $('#deploy-size').textContent = (detail.code || '').length / 2 + ' bytes';
      $('#deploy-gas').textContent = gas;
      $('#deploy-fee').textContent = (gas * GAS_PRICE) / COIN + ' BLOCK';
      show('approve-deploy');
      $('#deploy-unlock').hidden = Wallet.isUnlocked();
      $('#deploy-reject').addEventListener('click', () => respond(false));
      $('#deploy-approve').addEventListener('click', async () => {
        $('#deploy-err').textContent = '';
        const btn = $('#deploy-approve');
        btn.disabled = true;
        btn.textContent = 'Deploying…';
        try {
          if (!Wallet.isUnlocked()) await Wallet.unlock($('#deploy-pw').value);
          // SECURITY GATE: inspect + shared confirm sheet BEFORE signing/broadcast.
          const cleared = await securityGate({ kind: 'deploy', value: 0, fee: gas * GAS_PRICE });
          if (!cleared) { btn.disabled = false; btn.textContent = 'Deploy'; $('#deploy-err').textContent = 'Deployment cancelled by the security review.'; return; }
          const u = await Chain.utxos(Wallet.address);
          if (!u || !u.utxos.length) throw new Error('no spendable funds for gas');
          const built = await Wallet.buildDeploy(u.utxos, detail.code, gas, GAS_PRICE);
          const res = await Chain.submit(built.raw);
          await recordPending(res.txid || built.txid, 'Deploy');
          respond(true, { txid: res.txid || built.txid, contractId: built.contractId });
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Deploy';
          $('#deploy-err').textContent = /locked|no wallet|password/i.test(e.message)
            ? 'Wrong password.'
            : 'Deploy failed: ' + e.message;
        }
      });
    } else if (detail.type === 'action') {
      const GAS_PRICE = 10, COIN = 100000000;
      const gas = parseInt(detail.gas) || 200000;
      $('#action-origin').textContent = detail.origin;
      const titles = { pool: 'Create liquidity pool', init: 'Initialize token (mint supply)', swap: 'Swap', launch: 'Launch token', launchNft: 'Launch NFT collection' };
      $('#action-title').textContent = titles[detail.kind] || 'Confirm';
      $('#action-detail').textContent =
        detail.kind === 'pool'
          ? 'Seed ' + (Number(detail.blockAmt) / COIN) + ' BLOCK + ' + detail.tokenAmt + ' base-unit tokens. LP locks for 1 week.'
          : detail.kind === 'swap'
          ? (detail.side === 'buy'
              ? 'Spend ' + (Number(detail.amountIn) / COIN) + ' BLOCK for ' + (detail.token || '').slice(0, 10) + '… tokens (min ' + detail.minOut + ' base units).'
              : 'Sell ' + detail.amountIn + ' base-unit tokens for BLOCK (min ' + (Number(detail.minOut) / COIN) + ' BLOCK).')
          : detail.kind === 'launch'
          ? 'Launch ' + detail.supply + ' ' + detail.symbol + ' — deploy, mint to you, and seed a pool with ' + detail.seedBlock + ' BLOCK / ' + detail.seedToken + ' ' + detail.symbol + ', all in ONE transaction. LP locks 1 week.'
          : detail.kind === 'launchNft'
          ? 'Deploy an NFT collection and set you as its minter — one transaction.'
          : 'Mint the full supply of ' + (detail.contractId || '').slice(0, 12) + '… to your wallet.';
      $('#action-fee').textContent = (gas * GAS_PRICE) / COIN + ' BLOCK';
      show('approve-action');
      $('#action-unlock').hidden = Wallet.isUnlocked();
      $('#action-reject').addEventListener('click', () => respond(false));
      $('#action-approve').addEventListener('click', async () => {
        $('#action-err').textContent = '';
        const btn = $('#action-approve');
        btn.disabled = true;
        btn.textContent = 'Submitting…';
        try {
          if (!Wallet.isUnlocked()) await Wallet.unlock($('#action-pw').value);
          // SECURITY GATE: inspect the pool/token/contract target + confirm sheet
          // BEFORE signing/broadcast.
          const gateAction = detail.kind === 'pool'
            ? { kind: 'pool', token: detail.token, blockAmt: detail.blockAmt, fee: gas * GAS_PRICE }
            : detail.kind === 'swap'
            ? { kind: 'swap', side: detail.side, token: detail.token, amountIn: detail.amountIn, fee: gas * GAS_PRICE }
            : detail.kind === 'launch'
            ? { kind: 'launch', symbol: detail.symbol, blockAmt: String(Number(detail.seedBlock) * COIN), fee: gas * GAS_PRICE }
            : detail.kind === 'launchNft'
            ? { kind: 'launchNft', fee: gas * GAS_PRICE }
            : { kind: 'init', contractId: detail.contractId, fee: gas * GAS_PRICE };
          const cleared = await securityGate(gateAction);
          if (!cleared) { btn.disabled = false; btn.textContent = 'Approve'; $('#action-err').textContent = 'Cancelled by the security review.'; return; }
          // Prerequisite gate — blocks can be ~10 min and the prototype mempool
          // has no unconfirmed-tx chaining, so a step whose predecessor is still
          // pending would re-spend the predecessor's input and be rejected as a
          // double-spend. So AUTO-WAIT for the prerequisite to confirm, then
          // submit — no doomed tx, no retry loop. The user already approved; we
          // just hold until the chain is ready (polling, ~5 min cap).
          const waitFor = async (label, ready) => {
            const deadline = Date.now() + 300000; // ~5 min — several block intervals
            // one immediate check, then poll
            if (await ready()) return true;
            $('#action-err').textContent = '';
            while (Date.now() < deadline) {
              btn.textContent = label + ' — waiting for a block…';
              await new Promise((r) => setTimeout(r, 5000));
              if (await ready()) { btn.textContent = 'Submitting…'; return true; }
            }
            return false;
          };
          if (detail.kind === 'init') {
            // init needs the deployed contract to exist on-chain first.
            const ok = await waitFor('Deploy confirming', async () =>
              !!(await Chain.token(detail.contractId, Wallet.address)));
            if (!ok) {
              btn.disabled = false; btn.textContent = 'Approve';
              $('#action-err').textContent = 'Your token deploy still isn’t confirmed. Leave it a moment and try Initialize again — don’t re-deploy.';
              return;
            }
          } else if (detail.kind === 'pool') {
            // pool creation needs the minted token balance (init confirmed).
            const ok = await waitFor('Mint confirming', async () => {
              const t = await Chain.token(detail.token, Wallet.address);
              return !!(t && t.balance && Number(t.balance) > 0);
            });
            if (!ok) {
              btn.disabled = false; btn.textContent = 'Approve';
              $('#action-err').textContent = 'The mint (Initialize) still isn’t confirmed. Leave it a moment and try Create pool again.';
              return;
            }
          }
          const u = await Chain.utxos(Wallet.address);
          if (!u || !u.utxos.length) throw new Error('no spendable funds');
          let built;
          if (detail.kind === 'pool') {
            built = await Wallet.buildPoolCreate(u.utxos, detail.token, detail.blockAmt, detail.tokenAmt, gas, GAS_PRICE);
          } else if (detail.kind === 'swap') {
            built = detail.side === 'buy'
              ? await Wallet.buildPoolSwapBuy(u.utxos, detail.token, detail.amountIn, detail.minOut, gas, GAS_PRICE)
              : await Wallet.buildPoolSwapSell(u.utxos, detail.token, detail.amountIn, detail.minOut, gas, GAS_PRICE);
          } else if (detail.kind === 'launch') {
            built = await Wallet.buildLaunchToken(u.utxos, detail.name, detail.symbol, detail.decimals, detail.supply, detail.seedBlock, detail.seedToken, gas, GAS_PRICE);
          } else if (detail.kind === 'launchNft') {
            built = await Wallet.buildLaunchNft(u.utxos, detail.code, gas, GAS_PRICE);
          } else {
            built = await Wallet.buildCall(u.utxos, detail.contractId, '00', 0, gas, GAS_PRICE);
          }
          const res = await Chain.submit(built.raw);
          const txid = res.txid || built.txid;
          const kindLabel = detail.kind === 'pool' ? 'Create pool'
            : detail.kind === 'swap' ? (detail.side === 'buy' ? 'Buy' : 'Sell')
            : detail.kind === 'launch' ? 'Launch'
            : detail.kind === 'launchNft' ? 'Launch NFT' : 'Init';
          await recordPending(txid, kindLabel);
          // Atomic launches create a contract; report its id (derived from txid).
          var contractId = null;
          if (detail.kind === 'launch' || detail.kind === 'launchNft') {
            try { contractId = Signer.contractIdForTxid(txid); } catch (_) {}
          }
          respond(true, { txid, contractId });
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Approve';
          const msg = e && e.message ? e.message : String(e);
          $('#action-err').textContent = /locked|no wallet|password/i.test(msg)
            ? 'Wrong password.'
            : /double-spend|already in the mempool|invalid/i.test(msg)
            ? 'Rejected — a previous step is still confirming. Wait for the next block (watch the Transaction queue, usually 1–2 min), then try again. Don’t re-submit in the meantime.'
            : 'Failed: ' + msg;
        }
      });
    } else {
      window.close();
    }
  }

  // ---- boot ---------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'approve' && params.get('req')) {
    initApprove(params.get('req'));
  } else {
    initNormal();
  }
})();
