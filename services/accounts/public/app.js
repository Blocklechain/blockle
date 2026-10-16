// Client for the Blockle account pages. Talks to /api/* same-origin with cookies. CSRF token
// for authenticated mutations comes from /api/me. No secrets or keys are handled here — wallet
// backup encryption happens in the wallet app, not in the browser.
(() => {
  const page = document.body.dataset.page;
  const $ = (s, r = document) => r.querySelector(s);
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

  const pages = {
    login() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/api/login', form(e.target));
        if (r.status === 200) { location.href = '/account'; return; }
        if (r.data.error === '2fa') { $('#totpWrap').classList.remove('hidden'); show(r.data.message || 'Enter your 2FA code.', 'ok'); return; }
        show(r.data.error || 'Could not sign in.');
      });
    },
    register() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/api/register', form(e.target));
        if (r.status === 200) { show(r.data.message || 'Check your email to verify.', 'ok'); e.target.reset(); }
        else show(r.data.error || 'Could not register.');
      });
    },
    forgot() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/api/request-reset', form(e.target));
        show(r.data.message || (r.status === 200 ? 'Check your email.' : 'Error.'), r.status === 200 ? 'ok' : 'err');
      });
    },
    reset() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/api/reset', { token: qs('token'), password: form(e.target).password });
        if (r.status === 200) show('Password updated. You can sign in now.', 'ok');
        else show(r.data.error || 'Could not reset.');
      });
    },
    async verify() {
      const r = await api('GET', '/api/verify?token=' + encodeURIComponent(qs('token') || ''));
      $('#status').textContent = r.status === 200 ? 'Email verified — you can sign in.' : (r.data.error || 'Invalid link.');
      if (r.status === 200) show('Verified.', 'ok'); else show(r.data.error || 'Invalid link.');
    },
    support() {
      $('#f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await api('POST', '/api/tickets', form(e.target));
        if (r.status === 200) { show('Sent — ticket ' + r.data.id + '. We\'ll reply by email.', 'ok'); e.target.reset(); }
        else show(r.data.error || 'Could not send.');
      });
    },
    async account() {
      const me = await api('GET', '/api/me');
      if (me.status !== 200) { location.href = '/account/login'; return; }
      CSRF = me.data.csrf; const u = me.data.user;
      $('#email').textContent = u.email + (u.role === 'admin' ? ' · admin' : '');
      const plan = document.body.dataset.plan, price = document.body.dataset.price, ccy = document.body.dataset.ccy;
      $('#subBox').innerHTML = u.sub && u.sub.active
        ? `<p class="note">✓ ${plan} active.</p>`
        : `<button id="sub">Upgrade to ${plan} — ${price} ${ccy}/mo</button>`;
      const subBtn = $('#sub'); if (subBtn) subBtn.addEventListener('click', async () => {
        const r = await api('POST', '/api/subscribe', {});
        if (r.data.approveUrl) location.href = r.data.approveUrl; else show('Billing is not configured yet.');
      });
      $('#twofaBox').innerHTML = u.totpEnabled
        ? `<p class="note">✓ Two-factor is on.</p>`
        : `<button class="ghost" id="setup2fa">Turn on two-factor (recommended)</button><div id="setupArea"></div>`;
      const setupBtn = $('#setup2fa'); if (setupBtn) setupBtn.addEventListener('click', async () => {
        const r = await api('POST', '/api/2fa/setup', {});
        $('#setupArea').innerHTML = `<p class="note mono" style="word-break:break-all">${r.data.secret}</p>
          <p class="note">Add that secret to your authenticator, then enter a code:</p>
          <input id="code" class="mono" inputmode="numeric" placeholder="123456"><button id="en2fa">Enable</button>`;
        $('#en2fa').addEventListener('click', async () => {
          const er = await api('POST', '/api/2fa/enable', { totp: $('#code').value });
          if (er.status === 200) { show('Two-factor enabled. Save your recovery codes: ' + er.data.recovery.join(' '), 'ok'); }
          else show(er.data.error || 'Code did not match.');
        });
      });
      if (u.role === 'admin') { const a = document.createElement('a'); a.href = '/account/admin'; a.textContent = 'Open admin →'; a.className = 'row'; $('.card').appendChild(a); }
      $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout', {}); location.href = '/account/login'; });
    },
    async admin() {
      const me = await api('GET', '/api/me');
      if (me.status !== 200) { location.href = '/account/login'; return; }
      CSRF = me.data.csrf;
      const st = await api('GET', '/api/admin/stats');
      if (st.status !== 200) { location.href = '/account'; return; }
      $('#who').textContent = me.data.user.email;
      const s = st.data;
      $('#stats').innerHTML = [['Users', s.users], ['Verified', s.verified], ['Subscribers', s.subscribers],
        ['2FA on', s.with2fa], ['Backups', s.backups], ['Open tickets', s.tickets.open]]
        .map(([k, n]) => `<div class="stat"><div class="n">${n}</div><div class="k">${k}</div></div>`).join('');
      const t = await api('GET', '/api/admin/tickets');
      $('#tickets').innerHTML = (t.data.tickets || []).map((x) => `<div class="ticket">
        <b>${esc(x.subject)}</b> <span class="note">· ${esc(x.email)} · ${x.status}</span>
        <p class="note">${esc(x.messages[x.messages.length - 1].body)}</p>
        <input placeholder="Reply…" data-id="${x.id}"><button data-id="${x.id}" class="reply" style="max-width:120px">Reply</button></div>`).join('') || '<p class="note">No tickets.</p>';
      $('#tickets').querySelectorAll('.reply').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.id; const inp = $(`input[data-id="${id}"]`);
        const r = await api('POST', '/api/admin/ticket-reply', { id, body: inp.value });
        show(r.status === 200 ? 'Reply sent.' : (r.data.error || 'Error.'), r.status === 200 ? 'ok' : 'err');
      }));
      $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout', {}); location.href = '/account/login'; });
    },
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  (pages[page] || (() => {}))();
})();
