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
    await renderTokens();
  }

  async function renderTokens() {
    const box = $('#tokens');
    if (!box) return;
    const ids = (await Store.get('tokens')).tokens || [];
    if (!ids.length) {
      box.innerHTML = '<div class="empty">No BLOCK-20 tokens imported.</div>';
      return;
    }
    const infos = await Promise.all(ids.map((id) => Chain.token(id, Wallet.address)));
    box.innerHTML = ids
      .map((id, i) => {
        const t = infos[i];
        if (!t) return `<div class="row"><div class="l"><b class="mono">${id.slice(0, 12)}…</b><small>unavailable</small></div></div>`;
        const dec = Number(t.decimals || 0);
        const bal = t.balance != null ? (Number(t.balance) / Math.pow(10, dec)).toLocaleString(undefined, { maximumFractionDigits: dec }) : '—';
        const sym = t.symbol || '?';
        return `<div class="row"><div class="l"><b>${sym}</b><small>${t.name || ''}</small></div><div class="r">${bal} ${sym}</div></div>`;
      })
      .join('');
  }

  async function importToken() {
    const id = (prompt('BLOCK-20 token contract id (64 hex chars):') || '').trim().toLowerCase();
    if (!id) return;
    if (!/^[0-9a-f]{64}$/.test(id)) { alert('That is not a 64-hex-char contract id.'); return; }
    const t = await Chain.token(id, Wallet.address);
    if (!t || !t.isToken) { alert('No BLOCK-20 token found at that contract id.'); return; }
    const ids = (await Store.get('tokens')).tokens || [];
    if (!ids.includes(id)) { ids.push(id); await Store.set({ tokens: ids }); }
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
    const impBtn = $('#import-token');
    if (impBtn) impBtn.addEventListener('click', importToken);
    const qref = $('#queue-refresh');
    if (qref) qref.addEventListener('click', renderQueue);
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
        await recordPending(res.txid || built.txid, 'Send');
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
    $('#exchange-base').addEventListener('change', async (e) => {
      await Store.set({ exchangeBase: e.target.value.trim() || Exchange.DEFAULT_BASE });
      await Exchange.signOut(); // a different relay means a new session
      toast('Exchange endpoint saved');
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
      const confd = t && (t.confirmations != null || t.height != null);
      cell.innerHTML = confd
        ? `<span style="color:#34d399">confirmed${t.confirmations != null ? ' · ' + t.confirmations + ' conf' : ''}</span>`
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
    if (name === 'exchange') {
      show('exchange');
      enterExchange();
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
      const titles = { pool: 'Create liquidity pool', init: 'Initialize token (mint supply)', swap: 'Swap' };
      $('#action-title').textContent = titles[detail.kind] || 'Confirm';
      $('#action-detail').textContent =
        detail.kind === 'pool'
          ? 'Seed ' + (Number(detail.blockAmt) / COIN) + ' BLOCK + ' + detail.tokenAmt + ' base-unit tokens. LP locks for 1 week.'
          : detail.kind === 'swap'
          ? (detail.side === 'buy'
              ? 'Spend ' + (Number(detail.amountIn) / COIN) + ' BLOCK for ' + (detail.token || '').slice(0, 10) + '… tokens (min ' + detail.minOut + ' base units).'
              : 'Sell ' + detail.amountIn + ' base-unit tokens for BLOCK (min ' + (Number(detail.minOut) / COIN) + ' BLOCK).')
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
          const u = await Chain.utxos(Wallet.address);
          if (!u || !u.utxos.length) throw new Error('no spendable funds');
          let built;
          if (detail.kind === 'pool') {
            built = await Wallet.buildPoolCreate(u.utxos, detail.token, detail.blockAmt, detail.tokenAmt, gas, GAS_PRICE);
          } else if (detail.kind === 'swap') {
            built = detail.side === 'buy'
              ? await Wallet.buildPoolSwapBuy(u.utxos, detail.token, detail.amountIn, detail.minOut, gas, GAS_PRICE)
              : await Wallet.buildPoolSwapSell(u.utxos, detail.token, detail.amountIn, detail.minOut, gas, GAS_PRICE);
          } else {
            built = await Wallet.buildCall(u.utxos, detail.contractId, '00', 0, gas, GAS_PRICE);
          }
          const res = await Chain.submit(built.raw);
          const kindLabel = detail.kind === 'pool' ? 'Create pool'
            : detail.kind === 'swap' ? (detail.side === 'buy' ? 'Buy' : 'Sell') : 'Init';
          await recordPending(res.txid || built.txid, kindLabel);
          respond(true, { txid: res.txid || built.txid });
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Approve';
          $('#action-err').textContent = /locked|no wallet|password/i.test(e.message)
            ? 'Wrong password.' : 'Failed: ' + e.message;
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
