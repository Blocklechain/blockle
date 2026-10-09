// accounts-ui.js — the MULTI-CHAIN accounts screen for the popup. Lists every
// enabled chain (BLOCK + ETH/Base + BTC/LTC/DOGE) with its derived address and
// live balances (incl. ERC-20 USDC/USDT), and drives a per-chain Send flow
// (build via the ChainAdapter -> review details -> confirm -> broadcast) plus
// add-token for EVM chains. All data flows through Wiring -> the adapters; keys
// never leave the device.
//
// Global `AccountsUI`. Depends on Wiring, Wallet, Store, and the popup's shared
// `BlockleUI` nav helpers (show/route/toast/shortAddr/copy).
(function (global) {
  'use strict';

  const CHAIN_META = {
    block:    { name: 'BLOCK',    sym: 'BLOCK', pq: true,  addrPrefix: 'block1' },
    ethereum: { name: 'Ethereum', sym: 'ETH',   pq: false },
    base:     { name: 'Base',     sym: 'ETH',   pq: false },
    bitcoin:  { name: 'Bitcoin',  sym: 'BTC',   pq: false },
    litecoin: { name: 'Litecoin', sym: 'LTC',   pq: false },
    dogecoin: { name: 'Dogecoin', sym: 'DOGE',  pq: false },
  };

  let UI = null;              // BlockleUI
  let sendState = null;       // { chain, asset, built }

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function init(ui) { UI = ui; wire(); }

  function wire() {
    const back = $('#mc-send-back');
    if (back) back.addEventListener('click', () => enter());
    const rev = $('#mc-review');
    if (rev) rev.addEventListener('click', doReview);
    const bc = $('#mc-broadcast');
    if (bc) bc.addEventListener('click', doBroadcast);
    const sel = $('#mc-asset');
    if (sel) sel.addEventListener('change', () => { resetReview(); });
  }

  // ---- accounts list --------------------------------------------------------
  async function enter() {
    UI.show('accounts');
    const box = $('#mc-list');
    box.innerHTML = '<div class="empty">Loading accounts…</div>';
    let reg;
    try { reg = await Wiring.registry(); } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
    const ids = reg.enabled();
    box.innerHTML = ids.map((id) => {
      const m = CHAIN_META[id] || { name: id, sym: id.toUpperCase() };
      return `<div class="mc-acct" data-chain="${id}">
        <div class="mc-head">
          <div class="mc-name">${esc(m.name)} ${m.pq ? '<span class="pill" style="color:#7ee787;border-color:#7ee78755">PQ</span>' : ''}</div>
          <button class="mini-btn mc-send-btn" data-send="${id}">Send</button>
        </div>
        <button class="addr-chip mc-addr" data-copy-chain="${id}"><span>…</span><span class="copy">⧉</span></button>
        <div class="mc-bal" data-bal="${id}"><small class="muted">—</small></div>
      </div>`;
    }).join('');

    // addresses + balances (per chain, independent — one failure doesn't block others)
    for (const id of ids) {
      renderChain(id).catch(() => {});
    }

    box.querySelectorAll('[data-send]').forEach((b) =>
      b.addEventListener('click', () => openSend(b.getAttribute('data-send'))));
    box.querySelectorAll('[data-copy-chain]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-copy-chain');
        try { const a = await Wiring.accountFor(id); UI.copy(a.address); } catch {}
      }));
  }

  async function renderChain(id) {
    const addrEl = document.querySelector(`[data-copy-chain="${id}"] span`);
    const balEl = document.querySelector(`[data-bal="${id}"]`);
    let acct;
    try { acct = await Wiring.accountFor(id); } catch (e) {
      if (addrEl) addrEl.textContent = (/locked|seed/i.test(e.message) ? 'unlock to derive' : 'unavailable');
      if (balEl) balEl.innerHTML = '';
      return;
    }
    if (addrEl) addrEl.textContent = UI.shortAddr(acct.address);
    if (!balEl) return;
    balEl.innerHTML = '<small class="muted">loading balance…</small>';
    try {
      const bals = await Wiring.getBalance(id);
      balEl.innerHTML = bals.map((b) => {
        const sym = (b.asset && b.asset.symbol) || '?';
        const disp = b.display != null ? b.display : '—';
        return `<div class="mc-bal-row"><span>${esc(sym)}</span><b class="mono">${esc(disp)}</b></div>`;
      }).join('');
    } catch (e) {
      balEl.innerHTML = '<small class="muted">balance unavailable</small>';
    }
  }

  // ---- per-chain Send -------------------------------------------------------
  async function openSend(chain) {
    const m = CHAIN_META[chain] || { name: chain, sym: chain.toUpperCase() };
    sendState = { chain, asset: null, built: null };
    UI.show('mc-send');
    $('#mc-send-title').textContent = 'Send · ' + m.name;
    $('#mc-send-err').textContent = '';
    $('#mc-to').value = '';
    $('#mc-amt').value = '';
    resetReview();

    // asset selector: native + imported tokens on this chain
    const sel = $('#mc-asset');
    let tokens = [];
    try { tokens = (await Wiring.registry()).tokensFor(chain) || []; } catch {}
    const opts = [`<option value="native">${esc(m.sym)} (native)</option>`]
      .concat(tokens.map((t, i) => `<option value="tok:${i}">${esc(t.symbol || 'token')}</option>`));
    sel.innerHTML = opts.join('');
    sel._tokens = tokens;
    $('#mc-asset-field').style.display = tokens.length ? '' : 'none';
    $('#mc-send-note').textContent = m.pq
      ? 'Signed with your post-quantum key (ML-DSA-44) and broadcast to BLOCK.'
      : 'Signed locally with your ECDSA (secp256k1) key for this chain — NOT post-quantum. The key never leaves this device.';
  }

  function resetReview() {
    const r = $('#mc-review-box');
    if (r) { r.hidden = true; r.innerHTML = ''; }
    const bc = $('#mc-broadcast');
    if (bc) bc.hidden = true;
    if (sendState) sendState.built = null;
  }

  function selectedAsset() {
    const sel = $('#mc-asset');
    if (!sel || sel.value === 'native' || !sel._tokens) return undefined;
    const i = parseInt(String(sel.value).split(':')[1], 10);
    return sel._tokens[i];
  }

  async function doReview() {
    const err = $('#mc-send-err'); err.textContent = '';
    if (!sendState) return;
    const to = $('#mc-to').value.trim();
    const amtHuman = $('#mc-amt').value.trim();
    if (!to) return (err.textContent = 'Enter a recipient address.');
    if (!(parseFloat(amtHuman) > 0)) return (err.textContent = 'Enter an amount greater than 0.');
    if (!Wallet.isUnlocked()) return (err.textContent = 'Unlock your wallet to send.');

    const asset = selectedAsset();
    const chain = sendState.chain;
    // decimals: token decimals, else native (BLOCK/BTC/LTC/DOGE=8, EVM native=18)
    const dec = asset ? Number(asset.decimals || 0)
      : (chain === 'ethereum' || chain === 'base') ? 18 : 8;
    const amountBase = toBase(amtHuman, dec);

    const btn = $('#mc-review'); btn.disabled = true; btn.textContent = 'Building…';
    try {
      const req = { to, amount: amountBase, asset };
      const built = await Wiring.buildSend(chain, req);
      sendState.built = built; sendState.asset = asset;
      const sym = asset ? (asset.symbol || 'token') : (CHAIN_META[chain] ? CHAIN_META[chain].sym : chain);
      const feeTxt = built.fee != null ? fmtFee(chain, built.fee) : '—';
      const box = $('#mc-review-box');
      box.hidden = false;
      box.innerHTML = `<div class="perm"><span>↗</span> Send <b>${esc(amtHuman)} ${esc(sym)}</b></div>
        <div class="perm"><span>→</span> To <b class="mono">${esc(UI.shortAddr(to))}</b></div>
        <div class="perm"><span>₿</span> Network fee <b>${esc(feeTxt)}</b></div>
        <div class="perm"><span>#</span> Tx <b class="mono">${esc((built.txid || '').slice(0, 20))}…</b></div>`;
      $('#mc-broadcast').hidden = false;
    } catch (e) {
      err.textContent = 'Could not build: ' + (e.message || e);
    } finally {
      btn.disabled = false; btn.textContent = 'Review';
    }
  }

  async function doBroadcast() {
    const err = $('#mc-send-err'); err.textContent = '';
    if (!sendState || !sendState.built) return;
    const btn = $('#mc-broadcast'); btn.disabled = true; btn.textContent = 'Broadcasting…';
    try {
      const res = await Wiring.broadcast(sendState.chain, sendState.built);
      const txid = (res && res.txid) || sendState.built.txid;
      UI.toast('Sent · ' + String(txid).slice(0, 14) + '…');
      if (UI.recordPending) await UI.recordPending(txid, 'Send ' + sendState.chain);
      enter();
    } catch (e) {
      err.textContent = 'Broadcast failed: ' + (e.message || e);
      btn.disabled = false; btn.textContent = 'Broadcast';
    }
  }

  // ---- add token (EVM) ------------------------------------------------------
  async function addToken(chain) {
    if (chain !== 'ethereum' && chain !== 'base') { UI.toast('Token import is EVM-only here'); return; }
    const address = (prompt('ERC-20 contract address (0x…):') || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { if (address) alert('Not a valid 0x address.'); return; }
    const symbol = (prompt('Token symbol (e.g. DAI):') || '').trim();
    const decimals = parseInt(prompt('Token decimals (e.g. 18):') || '18', 10);
    const s = (await Store.get('chainTokens')).chainTokens || {};
    s[chain] = s[chain] || [];
    if (!s[chain].some((t) => (t.address || '').toLowerCase() === address.toLowerCase())) {
      s[chain].push({ chain, kind: 'erc20', symbol: symbol || 'TOKEN', decimals: isFinite(decimals) ? decimals : 18, address });
      await Store.set({ chainTokens: s });
      Wiring.reset();
      UI.toast('Token added');
      enter();
    }
  }

  // ---- helpers --------------------------------------------------------------
  function toBase(human, decimals) {
    const d = Number(decimals) || 0;
    let s = String(human == null ? '' : human).trim();
    if (!s) return '0';
    const neg = s.charAt(0) === '-'; if (neg) s = s.slice(1);
    const parts = s.split('.');
    const whole = parts[0] || '0';
    let frac = parts[1] || '';
    frac = (frac + '0'.repeat(d)).slice(0, d);
    const combined = (whole + frac).replace(/^0+/, '') || '0';
    return (neg ? '-' : '') + combined;
  }
  function fmt(baseStr, decimals) {
    try {
      const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
      const i = s.slice(0, s.length - decimals);
      const f = s.slice(s.length - decimals).replace(/0+$/, '');
      return f ? `${i}.${f}` : i;
    } catch { return String(baseStr); }
  }
  function fmtFee(chain, feeBase) {
    if (chain === 'ethereum' || chain === 'base') return fmt(feeBase, 18) + ' ETH';
    const m = CHAIN_META[chain]; return fmt(feeBase, 8) + ' ' + (m ? m.sym : '');
  }

  global.AccountsUI = { init, enter, openSend, addToken };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.AccountsUI;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
