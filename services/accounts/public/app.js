// Client for the Blockle account pages. Talks to /api/* same-origin with cookies. CSRF token
// for authenticated mutations comes from /api/me. No secrets or keys are handled here — wallet
// backup encryption happens in the wallet app, not in the browser.
(() => {
  const page = document.body.dataset.page;
  const $ = (s, r = document) => r.querySelector(s);
  // Theme: apply the saved choice immediately, then wire the toggle (light ⇄ dark, persisted).
  try { const t = localStorage.getItem('blk-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) {}
  function wireTheme() {
    const tt = $('#theme-toggle'); if (!tt) return;
    const prefersDark = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const sync = () => { const c = document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light'); tt.textContent = c === 'light' ? '☀' : '☾'; };
    sync();
    tt.addEventListener('click', () => {
      const c = document.documentElement.getAttribute('data-theme') || (prefersDark() ? 'dark' : 'light');
      const next = c === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('blk-theme', next); } catch (e) {}
      sync();
    });
  }
  const msgEl = () => $('#msg');
  const show = (text, kind = 'err') => { const m = msgEl(); if (!m) return; m.textContent = text; m.className = 'msg ' + kind; };
  let CSRF = null;

  async function api(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body) h['Content-Type'] = 'application/json';
    if (method !== 'GET' && CSRF) h['X-CSRF-Token'] = CSRF;
    const r = await fetch(path, { method, credentials: 'include', headers: h, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }
  const form = (el) => Object.fromEntries(new FormData(el).entries());
  const qs = (k) => new URLSearchParams(location.search).get(k);
  const copyText = async (t) => { try { await navigator.clipboard.writeText(t); return true; } catch (e) { return false; } };
  const downloadText = (name, t) => { const b = new Blob([t], { type: 'text/plain' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); };
  // Render a copyable/downloadable panel of recovery codes into `el`.
  function showRecovery(el, codes) {
    const text = codes.join('\n');
    el.innerHTML = `<div class="codes"><p class="note"><b>Save these recovery codes</b> — each works once if you lose your authenticator. They won't be shown again.</p>
      <pre class="codeblock">${codes.map((c) => `<span>${c}</span>`).join('')}</pre>
      <div class="row2"><button class="ghost sm" data-a="copy">Copy</button><button class="ghost sm" data-a="dl">Download</button></div></div>`;
    el.querySelector('[data-a="copy"]').addEventListener('click', async (e) => { e.target.textContent = (await copyText(text)) ? 'Copied ✓' : 'Copy failed'; });
    el.querySelector('[data-a="dl"]').addEventListener('click', () => downloadText('blockle-recovery-codes.txt', text + '\n'));
  }

  const pages = {
    login() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/account/api/login', form(e.target));
        if (r.status === 200) {
          // honor a same-origin ?next= so sign-in returns you where you came from
          const next = new URLSearchParams(location.search).get('next');
          const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
          location.href = safe || (r.data.user && r.data.user.onboarded ? '/account' : '/account/welcome');
          return;
        }
        if (r.data.error === '2fa') { $('#totpWrap').classList.remove('hidden'); show(r.data.message || 'Enter your 2FA code.', 'ok'); return; }
        show(r.data.error || 'Could not sign in.');
      });
    },
    register() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/account/api/register', form(e.target));
        if (r.status === 200) { show(r.data.message || 'Check your email to verify.', 'ok'); e.target.reset(); }
        else show(r.data.error || 'Could not register.');
      });
    },
    forgot() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/account/api/request-reset', form(e.target));
        show(r.data.message || (r.status === 200 ? 'Check your email.' : 'Error.'), r.status === 200 ? 'ok' : 'err');
      });
    },
    reset() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/account/api/reset', { token: qs('token'), password: form(e.target).password });
        if (r.status === 200) show('Password updated. You can sign in now.', 'ok');
        else show(r.data.error || 'Could not reset.');
      });
    },
    async verify() {
      const r = await api('GET', '/account/api/verify?token=' + encodeURIComponent(qs('token') || ''));
      $('#status').textContent = r.status === 200 ? 'Email verified — you can sign in.' : (r.data.error || 'Invalid link.');
      if (r.status === 200) show('Verified.', 'ok'); else show(r.data.error || 'Invalid link.');
    },
    async verifyEmail() {
      const r = await api('GET', '/account/api/verify-email?token=' + encodeURIComponent(qs('token') || ''));
      $('#status').textContent = r.status === 200 ? 'Email updated — you can use the new address to sign in.' : (r.data.error || 'Invalid link.');
      show(r.status === 200 ? 'Email confirmed.' : (r.data.error || 'Invalid link.'), r.status === 200 ? 'ok' : 'err');
    },
    support() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/account/api/tickets', form(e.target));
        if (r.status === 200) { show('Sent — ticket ' + r.data.id + '. We\'ll reply by email.', 'ok'); e.target.reset(); }
        else show(r.data.error || 'Could not send.');
      });
    },
    async account() {
      const me = await api('GET', '/account/api/me');
      if (me.status !== 200) { location.href = '/account/login?next=' + encodeURIComponent(location.pathname); return; }
      CSRF = me.data.csrf; const u = me.data.user;
      const ov = (await api('GET', '/account/api/overview')).data || {};
      const social = ov.social || null;
      const plan = document.body.dataset.plan, price = document.body.dataset.price, ccy = document.body.dataset.ccy;
      const fmtk = (n) => (n == null ? '—' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n)));
      const dt = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

      $('#email').textContent = (u.username ? '@' + u.username + ' · ' : '') + u.email;
      if (u.role === 'admin') { const b = $('#role'); b.textContent = 'admin'; b.className = 'badge admin'; b.style.display = ''; }

      // headline stats
      const stat = (n, k) => `<div class="stat"><div class="n">${n}</div><div class="k">${k}</div></div>`;
      $('#stats').innerHTML =
        stat(social ? social.blockUnits : '—', 'BLOCK') +
        stat(social ? fmtk(social.karma) : '—', 'Karma') +
        stat(u.sub && u.sub.active ? 'Pro' : 'Free', 'Plan') +
        stat(u.totpEnabled ? 'On' : 'Off', '2FA') +
        (u.createdAt ? stat(new Date(u.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }), 'Member since') : '');

      // security: 2FA
      $('#twofaBox').innerHTML = u.totpEnabled
        ? `<div class="statusline"><span class="on">✓ Two-factor is on${u.recoveryLeft != null ? ' · ' + u.recoveryLeft + ' recovery code' + (u.recoveryLeft === 1 ? '' : 's') + ' left' : ''}</span><button class="ghost sm" id="regen" style="max-width:210px">Regenerate recovery codes</button></div><div id="regenArea"></div>`
        : `<div class="statusline"><span class="off">Two-factor is off</span><button class="ghost sm" id="setup2fa" style="max-width:150px">Turn on 2FA</button></div><div id="setupArea"></div>`;
      const regenBtn = $('#regen'); if (regenBtn) regenBtn.addEventListener('click', () => {
        $('#regenArea').innerHTML = `<p class="note">Enter a current 2FA code to generate a fresh set (the old codes stop working).</p>
          <input id="regen-code" class="mono" inputmode="numeric" placeholder="123456"><button class="sm" id="regen-go" style="margin-top:8px;max-width:140px">Generate</button>`;
        $('#regen-go').addEventListener('click', async () => {
          const r = await api('POST', '/account/api/2fa/recovery', { totp: $('#regen-code').value });
          if (r.status === 200) { show('New recovery codes generated.', 'ok'); showRecovery($('#regenArea'), r.data.recovery); }
          else show(r.data.error || 'Could not regenerate.');
        });
      });
      const setupBtn = $('#setup2fa'); if (setupBtn) setupBtn.addEventListener('click', async () => {
        const r = await api('POST', '/account/api/2fa/setup', {});
        $('#setupArea').innerHTML = `<p class="note">Add this secret to your authenticator app (or tap it on mobile), then enter a code:</p>
          <pre class="codeblock"><span>${esc(r.data.secret)}</span></pre>
          <div class="row2"><button class="ghost sm" id="copy-secret">Copy secret</button>${r.data.uri ? `<a class="btn-sm-link" href="${esc(r.data.uri)}">Open in app</a>` : ''}</div>
          <input id="code" class="mono" inputmode="numeric" placeholder="123456" style="margin-top:10px"><button id="en2fa" style="margin-top:8px;max-width:140px">Enable</button>`;
        $('#copy-secret').addEventListener('click', async (e) => { e.target.textContent = (await copyText(r.data.secret)) ? 'Copied ✓' : 'Copy failed'; });
        $('#en2fa').addEventListener('click', async () => {
          const er = await api('POST', '/account/api/2fa/enable', { totp: $('#code').value });
          if (er.status === 200) { show('Two-factor enabled.', 'ok'); showRecovery($('#setupArea'), er.data.recovery); }
          else show(er.data.error || 'Code did not match.');
        });
      });

      // security: backup status
      $('#backupBox').innerHTML = ov.hasBackup
        ? `<div class="statusline"><span class="on">✓ Encrypted cloud backup — ${ov.backupCount} version${ov.backupCount === 1 ? '' : 's'}${ov.lastBackupAt ? ', last ' + dt(ov.lastBackupAt) : ''}${ov.lastBackupDevice ? ' (' + esc(ov.lastBackupDevice) + ')' : ''}</span></div>`
        : `<div class="statusline"><span class="off">No cloud backup yet — create one from your wallet app</span></div>`;

      // sessions
      $('#sessLine').textContent = 'Active sessions: ' + (ov.sessions || 1);
      $('#logoutAll').addEventListener('click', async () => {
        if (!confirm('Sign out of all devices? You’ll need to sign in again everywhere.')) return;
        await api('POST', '/account/api/logout-all', {}); location.href = '/account/login';
      });

      // plan
      $('#subBox').innerHTML = u.sub && u.sub.active
        ? `<div class="statusline"><span class="on">✓ ${esc(plan)} active</span></div>`
        : `<div class="statusline"><span class="off">Free plan</span><button class="sm" id="sub" style="max-width:220px">Upgrade to ${esc(plan)} — ${esc(price)} ${esc(ccy)}/mo</button></div>`;
      const subBtn = $('#sub'); if (subBtn) subBtn.addEventListener('click', async () => {
        const r = await api('POST', '/account/api/subscribe', {});
        if (r.data.approveUrl) location.href = r.data.approveUrl; else show(r.data.error || 'Billing is not configured yet.');
      });

      // quick links
      const links = [
        ['⬇ Download wallet', '/#download'],
        ['◆ Social' + (social ? ' · @' + esc(social.handle) : ''), '/social'],
        ['✉ Support', '/account/support'],
      ];
      if (u.role === 'admin') links.push(['🛠 Admin', '/account/admin']);
      $('#links').innerHTML = links.map(([t, h]) => `<a href="${h}">${t}</a>`).join('');

      // devices / sessions
      const shortUA = (ua) => ua ? esc(ua.replace(/^Mozilla\/[\d.]+ \(/, '').split(')')[0]) : 'Unknown device';
      async function loadDevices() {
        const r = await api('GET', '/account/api/sessions');
        const devices = (r.data && r.data.devices) || [];
        $('#devices').innerHTML = devices.map((d, i) =>
          `<div class="device"><div class="d"><div class="ua">${shortUA(d.ua)}</div><div class="meta">${d.ip ? esc(d.ip) + ' · ' : ''}seen ${dt(d.lastSeen)}${d.count > 1 ? ' · ' + d.count + ' sessions' : ''}${d.current ? ' · <span class="here">this device</span>' : ''}</div></div>${d.current ? '' : `<button class="ghost sm revoke" data-i="${i}" style="max-width:90px">Revoke</button>`}</div>`).join('') || '<p class="muted">No active sessions.</p>';
        $('#sessLine').textContent = 'Active devices: ' + devices.length;
        $('#devices').querySelectorAll('.revoke').forEach((b) => b.addEventListener('click', async () => {
          const d = devices[+b.dataset.i]; if (!d) return;
          const r2 = await api('POST', '/account/api/sessions/revoke', { sids: d.sids });
          if (r2.status === 200) loadDevices(); else show(r2.data.error || 'Could not revoke.');
        }));
      }
      loadDevices();

      // change password
      $('#pw-save').addEventListener('click', async () => {
        const cur = $('#pw-current').value, nxt = $('#pw-next').value;
        if (!cur || nxt.length < 10) return show('Enter your current password and a new password of 10+ characters.');
        const r = await api('POST', '/account/api/change-password', { current: cur, next: nxt });
        if (r.status === 200) { CSRF = r.data.csrf; $('#pw-current').value = ''; $('#pw-next').value = ''; show('Password updated — other devices were signed out.', 'ok'); loadDevices(); }
        else show(r.data.error || 'Could not change password.');
      });

      // username (unique @handle)
      $('#unameLine').textContent = u.username ? '@' + u.username : 'No username set';
      $('#uname-new').value = u.username || '';
      $('#uname-save').addEventListener('click', async () => {
        const r = await api('POST', '/account/api/username', { username: $('#uname-new').value });
        if (r.status === 200) { u.username = r.data.username; $('#unameLine').textContent = '@' + r.data.username; $('#email').textContent = '@' + r.data.username + ' · ' + u.email; show('Username saved.', 'ok'); }
        else show(r.data.error || 'Could not save username.');
      });

      // change email (re-verification)
      $('#emailLine').textContent = u.email;
      $('#email-open').addEventListener('click', () => {
        const area = $('#email-area'); area.classList.remove('hidden');
        area.innerHTML = `<p class="note">We'll send a confirmation link to the new address; your email changes only after you click it.</p>
          <input id="email-new" type="email" placeholder="New email" autocomplete="email">
          <input id="email-pw" type="password" placeholder="Password" autocomplete="current-password">
          <button class="ghost sm" id="email-go" style="margin-top:8px;max-width:180px">Send confirmation</button>`;
        $('#email-go').addEventListener('click', async () => {
          const r = await api('POST', '/account/api/change-email', { newEmail: $('#email-new').value, password: $('#email-pw').value });
          if (r.status === 200) { show(r.data.message || 'Check the new address for a link.', 'ok'); area.classList.add('hidden'); }
          else show(r.data.error || 'Could not change email.');
        });
      });

      // ---- Coinbase×3Commas tabs ----
      let pfLoaded = false, mkLoaded = false, botsLoaded = false;
      async function renderPortfolio() {
        if (pfLoaded) return; pfLoaded = true;
        const [addrR, balR] = await Promise.all([api('GET', '/account/api/vault/address'), api('GET', '/account/api/vault/balance')]);
        const bal = balR.data || {};
        const addr = (addrR.data && addrR.data.address) || bal.address;
        $('#pf-address').innerHTML = addr ? `<span>${esc(addr)}</span>` : '<span class="muted">Back up your wallet to link a receive address.</span>';
        $('#pf-total').textContent = bal.balance == null ? '—' : (Number(bal.balance).toLocaleString() + ' BLOCK');
        const tokens = bal.tokens || [];
        $('#pf-holdings').innerHTML = ((bal.balance != null ? `<div class="hold"><span>BLOCK</span><span>${Number(bal.balance).toLocaleString()}</span></div>` : '') +
          tokens.map((t) => `<div class="hold"><span>${esc(t.symbol || t.ticker || 'token')}</span><span>${esc(String(t.amount ?? t.balance ?? ''))}</span></div>`).join('')) || '<p class="muted">No holdings yet — deposit to your address below.</p>';
        const cp = $('#pf-copy');
        if (cp && addr) cp.addEventListener('click', async (e) => { e.target.textContent = (await copyText(addr)) ? 'Copied ✓' : 'Copy failed'; });
        else if (cp) cp.style.display = 'none';
      }
      async function renderMarkets() {
        if (mkLoaded) return; mkLoaded = true;
        const r = await api('GET', '/account/api/markets');
        const list = (r.data && r.data.markets) || [];
        $('#mk-list').innerHTML = list.map((m) => { const up = (m.change || 0) >= 0; return `<div class="mkrow"><span class="sym">${esc(m.symbol || '')}</span><span class="px">${m.price != null ? esc(String(m.price)) : '—'}</span>${m.change != null ? `<span class="chg ${up ? 'up' : 'down'}">${up ? '+' : ''}${esc(String(m.change))}%</span>` : '<span class="muted">—</span>'}</div>`; }).join('') || '<p class="muted">Markets unavailable right now.</p>';
      }
      async function renderBots() {
        botsLoaded = true;
        const r = await api('GET', '/account/api/bots');
        const bots = (r.data && r.data.bots) || [];
        $('#bots-list').innerHTML = bots.map((b) => { const up = (b.pnl || 0) >= 0; return `<div class="botrow"><div><b>${esc(b.type.toUpperCase())}</b> ${esc(b.pair)} <span class="meta">· ${esc(b.status)} · ${b.trades} trades</span></div><div style="display:flex;gap:10px;align-items:center"><span class="pnl ${up ? 'up' : 'down'}">${up ? '+' : ''}${esc(String(b.pnl))} (${up ? '+' : ''}${esc(String(b.pnlPct))}%)</span><button class="ghost sm bot-del" data-id="${esc(b.id)}" style="max-width:70px">Delete</button></div></div>`; }).join('') || '<p class="muted">No bots yet. Create a paper bot to test a strategy risk-free.</p>';
        $('#bots-list').querySelectorAll('.bot-del').forEach((btn) => btn.addEventListener('click', async () => { await api('POST', '/account/api/bots/' + btn.dataset.id + '/delete', {}); renderBots(); }));
      }
      $('#bot-new').addEventListener('click', () => {
        $('#bot-create').innerHTML = `<div class="sec" style="margin-top:10px"><label>Strategy</label>
          <select id="nb-type"><option value="dca">DCA — buy on a schedule</option><option value="grid">Grid — buy low / sell high</option></select>
          <label>Pair</label><input id="nb-pair" value="BLOCK/USD"><label>Budget (paper)</label><input id="nb-budget" type="number" value="1000">
          <button class="sm" id="nb-go" style="margin-top:10px;max-width:140px">Create</button></div>`;
        $('#nb-go').addEventListener('click', async () => {
          const type = $('#nb-type').value; const budget = Number($('#nb-budget').value) || 1000;
          const params = type === 'dca' ? { budget, buyAmount: Math.max(1, Math.round(budget / 10)), everyTicks: 3 } : { budget, lower: 0, upper: 0, grids: 6 };
          const r = await api('POST', '/account/api/bots', { type, pair: $('#nb-pair').value, params });
          if (r.status === 200) { $('#bot-create').innerHTML = ''; renderBots(); } else show(r.data.error || 'Could not create bot.');
        });
      });
      $('#tabnav').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        const tab = b.dataset.tab;
        $('#tabnav').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        ['portfolio', 'markets', 'bots', 'account'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== tab));
        if (tab === 'portfolio') renderPortfolio();
        if (tab === 'markets') renderMarkets();
        if (tab === 'bots' && !botsLoaded) renderBots();
      }));
      renderPortfolio();

      // danger zone: delete account
      $('#del-open').addEventListener('click', () => {
        const area = $('#del-area'); area.classList.remove('hidden');
        area.innerHTML = `<p class="note">This permanently deletes your account, encrypted backup and sessions. Your wallet funds are unaffected — Blockle is self-custody. Type <b>DELETE</b> to confirm.</p>
          <input id="del-pw" type="password" placeholder="Password" autocomplete="current-password">
          ${u.totpEnabled ? '<input id="del-totp" class="mono" inputmode="numeric" placeholder="2FA code">' : ''}
          <input id="del-confirm" placeholder="Type DELETE">
          <button class="danger sm" id="del-go" style="margin-top:8px;max-width:220px">Permanently delete account</button>`;
        $('#del-go').addEventListener('click', async () => {
          if ($('#del-confirm').value !== 'DELETE') return show('Type DELETE to confirm.');
          const body = { password: $('#del-pw').value };
          if (u.totpEnabled) body.totp = $('#del-totp').value;
          const r = await api('POST', '/account/api/delete-account', body);
          if (r.status === 200) { show('Account deleted.', 'ok'); setTimeout(() => { location.href = '/'; }, 1200); }
          else show(r.data.error || 'Could not delete account.');
        });
      });

      $('#logout').addEventListener('click', async () => { await api('POST', '/account/api/logout', {}); location.href = '/account/login'; });
    },
    async welcome() {
      const me = await api('GET', '/account/api/me');
      if (me.status !== 200) { location.href = '/account/login'; return; }
      CSRF = me.data.csrf;
      const slides = [
        { ico: '🔑', h: 'Your keys, your coins', p: 'Blockle is fully self-custody. This account syncs your preferences and an encrypted backup we can never read — it never holds your keys or funds.' },
        { ico: '🤖', h: 'AI proposes. You approve.', p: 'Agents can scan markets, build strategies and draft trades — but every move hits one non-bypassable confirm. The AI is the brain, never the hands.' },
        { ico: '📈', h: 'Trade, automate, compete', p: 'Swap across chains at the best venue, run DCA / grid / smart-trade bots, and test strategies risk-free in the Arena with play money.' },
        { ico: '🛡️', h: 'Lock it down', p: 'Turn on two-factor now — it protects your account and is required to store your encrypted wallet backup. Takes 30 seconds.', cta: 'Set up 2FA' },
        { ico: '◆', h: 'Welcome to Blockle', p: 'Social, BLOCK rewards and more are landing soon. Jump in whenever you\'re ready.', last: true },
      ];
      let i = 0;
      const dots = $('#dots'); dots.innerHTML = slides.map(() => '<i></i>').join('');
      const render = () => {
        const s = slides[i];
        $('#slide').className = 'slide';
        $('#slide').innerHTML = `<div class="ico">${s.ico}</div><h2>${s.h}</h2><p>${s.p}</p>`;
        [...dots.children].forEach((d, n) => d.classList.toggle('on', n === i));
        $('#back').style.visibility = i === 0 ? 'hidden' : 'visible';
        $('#next').textContent = s.last ? 'Enter Blockle' : (s.cta || 'Next');
      };
      const finish = async () => { await api('POST', '/account/api/onboarded', {}); location.href = '/account'; };
      $('#next').addEventListener('click', async () => {
        const s = slides[i];
        if (s.cta) { await api('POST', '/account/api/onboarded', {}); location.href = '/account?twofa=1'; return; }
        if (s.last) return finish();
        i++; render();
      });
      $('#back').addEventListener('click', () => { if (i > 0) { i--; render(); } });
      render();
    },
    async admin() {
      const me = await api('GET', '/account/api/me');
      if (me.status !== 200) { location.href = '/account/login'; return; }
      CSRF = me.data.csrf;
      const st = await api('GET', '/account/api/admin/stats');
      if (st.status !== 200) { location.href = '/account'; return; }
      $('#who').textContent = me.data.user.email;
      const s = st.data;
      $('#stats').innerHTML = [['Users', s.users], ['Verified', s.verified], ['Subscribers', s.subscribers],
        ['2FA on', s.with2fa], ['Backups', s.backups], ['Open tickets', s.tickets.open]]
        .map(([k, n]) => `<div class="stat"><div class="n">${n}</div><div class="k">${k}</div></div>`).join('');
      const t = await api('GET', '/account/api/admin/tickets');
      $('#tickets').innerHTML = (t.data.tickets || []).map((x) => `<div class="ticket">
        <b>${esc(x.subject)}</b> <span class="note">· ${esc(x.email)} · ${x.status}</span>
        <p class="note">${esc(x.messages[x.messages.length - 1].body)}</p>
        <input placeholder="Reply…" data-id="${x.id}"><button data-id="${x.id}" class="reply" style="max-width:120px">Reply</button></div>`).join('') || '<p class="note">No tickets.</p>';
      $('#tickets').querySelectorAll('.reply').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.id; const inp = $(`input[data-id="${id}"]`);
        const r = await api('POST', '/account/api/admin/ticket-reply', { id, body: inp.value });
        show(r.status === 200 ? 'Reply sent.' : (r.data.error || 'Error.'), r.status === 200 ? 'ok' : 'err');
      }));
      $('#logout').addEventListener('click', async () => { await api('POST', '/account/api/logout', {}); location.href = '/account/login'; });
    },
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  wireTheme();
  (pages[page] || (() => {}))();
})();
