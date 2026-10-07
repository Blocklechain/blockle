// popup.js — UI controller for the Blockle Wallet popup. Two modes:
//   normal  — onboarding / unlock / dashboard / receive / send / apps / settings
//   approve — a dApp connect or signature request (opened as its own window)
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
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
  async function refreshDashboard() {
    const addr = Wallet.address;
    $('#addr-short').textContent = shortAddr(addr);
    const acct = await Chain.account(addr);
    $('#bal').textContent = acct && acct.balanceFmt != null ? acct.balanceFmt : '0';
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
        await Wallet.unlock($('#unlock-pw').value);
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
      await Wallet.lock();
      route('unlock');
    });
    $('#addr-chip').addEventListener('click', () => copy(Wallet.address));
    $('#copy-addr').addEventListener('click', () => copy(Wallet.address));

    // send — build (ML-DSA signed) + broadcast
    $('#send-go').addEventListener('click', async () => {
      const to = $('#send-to').value.trim();
      const amt = parseFloat($('#send-amt').value);
      const err = $('#send-err');
      err.textContent = '';
      if (!/^block1[0-9a-z]+$/.test(to)) return (err.textContent = 'Enter a valid block1… address.');
      if (!(amt > 0)) return (err.textContent = 'Enter an amount greater than 0.');
      if (!Wallet.isUnlocked()) return (err.textContent = 'Unlock your wallet to send.');
      const COIN = 100000000;
      const amountBase = Math.round(amt * COIN);
      const feeBase = 10000; // 0.0001 BLOCK
      const btn = $('#send-go');
      btn.disabled = true;
      btn.textContent = 'Signing & sending…';
      try {
        const u = await Chain.utxos(Wallet.address);
        if (!u || !u.utxos.length) throw new Error('no spendable funds (coinbase matures after 100 blocks)');
        const built = await Wallet.buildTransfer(u.utxos, to, amountBase, feeBase);
        const res = await Chain.submit(built.raw);
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
    $('#lock-now').addEventListener('click', async () => {
      await Wallet.lock();
      route('unlock');
    });
    $('#reset-wallet').addEventListener('click', confirmReset);
    $('#api-base').addEventListener('change', async (e) => {
      await Store.set({ apiBase: e.target.value.trim() || Chain.DEFAULT_API });
      toast('Endpoint saved');
      refreshNet();
    });
  }

  async function confirmReset() {
    if (!confirm('Reset this wallet? Make sure you exported your wallet file — this cannot be undone.')) return;
    await Wallet.reset();
    try {
      await chrome.runtime.sendMessage({ type: 'wallet-state-changed', accounts: [] });
    } catch {}
    location.hash = '';
    route('welcome');
  }

  async function route(name) {
    if (name === 'dashboard') {
      const rec = await Wallet.selected();
      $('#watch-pill').hidden = !(rec && rec.watchOnly);
      setActiveLabel();
      show('dashboard');
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
    if (name === 'connections') {
      show('connections');
      refreshConnections();
      return;
    }
    if (name === 'settings') {
      show('settings');
      $('#api-base').value = (await Store.get('apiBase')).apiBase || Chain.DEFAULT_API;
      return;
    }
    show(name);
  }

  // Open the selected wallet: resume its session → dashboard; a watch-only
  // wallet → dashboard; otherwise ask for its password.
  async function enterSelected() {
    await Wallet.loadPublic();
    if (await Wallet.resumeSession()) return route('dashboard');
    const rec = await Wallet.selected();
    if (rec && rec.watchOnly) return route('dashboard');
    return route('unlock');
  }

  async function initNormal() {
    wireNormal();
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
          const u = await Chain.utxos(Wallet.address);
          if (!u || !u.utxos.length) throw new Error('no spendable funds for gas');
          const built = await Wallet.buildDeploy(u.utxos, detail.code, gas, GAS_PRICE);
          const res = await Chain.submit(built.raw);
          respond(true, { txid: res.txid || built.txid, contractId: built.contractId });
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Deploy';
          $('#deploy-err').textContent = /locked|no wallet|password/i.test(e.message)
            ? 'Wrong password.'
            : 'Deploy failed: ' + e.message;
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
