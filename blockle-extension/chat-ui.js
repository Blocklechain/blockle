// chat-ui.js — AI Chat for the extension popup. ChatGPT/Claude-style, paid per message in
// BLOCK via a generatable API key against the Blockle Intelligence gateway (same backend as
// the web wallet: /keys/create, /credit, /chat, /deposit). Additive + self-contained — a
// failure here never touches the core wallet screens. Global `ChatUI`.
(function (global) {
  'use strict';
  var API = 'https://blockle.org/api/inference';
  var UI = null;
  var msgs = [];

  function api(path, opts) {
    return fetch(API + path, opts).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }).catch(function () { return { ok: r.ok, status: r.status, j: {} }; }); });
  }
  function getKey() { return (global.Store ? Store.get('inferKey') : Promise.resolve({})).then(function (s) { return (s && s.inferKey) || ''; }); }
  function setKey(k) { return global.Store ? Store.set({ inferKey: k }) : Promise.resolve(); }
  function hdr(k) { return { 'authorization': 'Bearer ' + k, 'content-type': 'application/json' }; }
  async function ensureKey() {
    var k = await getKey(); if (k) return k;
    var addr = (global.Wallet && Wallet.address) || '';
    var r = await api('/keys/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr }) });
    if (r.ok && r.j.key) { await setKey(r.j.key); return r.j.key; }
    return '';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function render(root) {
    root.innerHTML =
      '<div class="section-h">AI Chat <span style="float:right;font-weight:600" id="ch-bal">—</span></div>' +
      '<div id="ch-thread" style="min-height:160px;max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:6px 2px"></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px"><input id="ch-in" placeholder="Message Blockle Intelligence…" style="flex:1;background:var(--surface2,#1a1d26);border:1px solid var(--line2,#2e323c);color:var(--text,#dfe6f5);border-radius:7px;padding:8px;font-size:13px;outline:none"><button id="ch-send" style="background:var(--accent,#7c5cff);border:0;color:#fff;border-radius:7px;padding:0 12px;font-weight:700;cursor:pointer">Send</button></div>' +
      '<div class="section-h" style="margin-top:12px">Top up (BLOCK credit)</div>' +
      '<div style="font-size:12px;color:var(--muted,#8b93a7);margin-bottom:6px">Send BLOCK to the address below (Home ▸ Send), then paste the transaction id to credit your key.</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="ch-dep" readonly style="flex:1;font-family:ui-monospace,monospace;font-size:11px;background:var(--surface2,#1a1d26);border:1px solid var(--line2,#2e323c);color:var(--text,#dfe6f5);border-radius:7px;padding:7px"><button id="ch-dep-copy" style="background:var(--surface2,#1a1d26);border:1px solid var(--line2,#2e323c);color:var(--text,#dfe6f5);border-radius:7px;padding:0 10px;cursor:pointer">Copy</button></div>' +
      '<div style="display:flex;gap:6px"><input id="ch-txid" placeholder="deposit transaction id" style="flex:1;font-family:ui-monospace,monospace;font-size:11px;background:var(--surface2,#1a1d26);border:1px solid var(--line2,#2e323c);color:var(--text,#dfe6f5);border-radius:7px;padding:7px"><button id="ch-credit" style="background:var(--surface2,#1a1d26);border:1px solid var(--line2,#2e323c);color:var(--text,#dfe6f5);border-radius:7px;padding:0 10px;cursor:pointer">Credit</button></div>' +
      '<div id="ch-msg" style="font-size:12px;color:var(--muted,#8b93a7);margin-top:6px"></div>' +
      '<div class="section-h" style="margin-top:12px">API key</div>' +
      '<div style="display:flex;gap:6px"><input id="ch-key" readonly style="flex:1;font-family:ui-monospace,monospace;font-size:11px;background:var(--surface2,#1a1d26);border:1px solid var(--line2,#2e323c);color:var(--text,#dfe6f5);border-radius:7px;padding:7px"><button id="ch-key-copy" style="background:var(--surface2,#1a1d26);border:1px solid var(--line2,#2e323c);color:var(--text,#dfe6f5);border-radius:7px;padding:0 10px;cursor:pointer">Copy</button></div>';

    var $ = function (s) { return root.querySelector(s); };
    function thread() {
      $('#ch-thread').innerHTML = msgs.map(function (m) {
        var mine = m.role === 'user';
        return '<div style="align-self:' + (mine ? 'flex-end' : 'flex-start') + ';max-width:85%;background:' + (mine ? 'var(--accent,#7c5cff)' : 'var(--surface2,#1a1d26)') + ';color:' + (mine ? '#fff' : 'var(--text,#dfe6f5)') + ';padding:7px 10px;border-radius:12px;font-size:13px;white-space:pre-wrap">' + esc(m.content) + '</div>';
      }).join('') || '<div class="empty">Ask anything. Paid per message in BLOCK.</div>';
      var t = $('#ch-thread'); t.scrollTop = t.scrollHeight;
    }
    thread();

    function refreshBal() { getKey().then(function (k) { if (!k) { $('#ch-bal').textContent = '0 BLOCK'; return; } api('/credit', { headers: hdr(k) }).then(function (r) { if ($('#ch-bal')) $('#ch-bal').textContent = (r.j.balanceBlock != null ? r.j.balanceBlock : 0) + ' BLOCK'; if ($('#ch-dep') && r.j.depositAddr) $('#ch-dep').value = r.j.depositAddr; }); }); }
    ensureKey().then(function (k) { if ($('#ch-key')) $('#ch-key').value = k || '(none)'; refreshBal(); });

    function copy(t) { try { navigator.clipboard.writeText(t); if (UI && UI.toast) UI.toast('Copied'); } catch (_) {} }
    $('#ch-key-copy').onclick = function () { copy($('#ch-key').value); };
    $('#ch-dep-copy').onclick = function () { copy($('#ch-dep').value); };
    $('#ch-credit').onclick = async function () {
      var txid = ($('#ch-txid').value || '').trim(); if (!txid) { $('#ch-msg').textContent = 'Paste a transaction id.'; return; }
      var k = await ensureKey(); $('#ch-msg').textContent = 'Confirming…';
      var r = await api('/deposit', { method: 'POST', headers: hdr(k), body: JSON.stringify({ txid: txid }) });
      $('#ch-msg').textContent = r.ok ? ('Credited ' + (r.j.creditedBlock || '') + ' BLOCK.') : ((r.j && r.j.error) || 'Not confirmed yet — try again shortly.');
      refreshBal();
    };
    async function send() {
      var text = ($('#ch-in').value || '').trim(); if (!text) return;
      var k = await ensureKey(); if (!k) { if (UI && UI.toast) UI.toast('Could not create a key'); return; }
      $('#ch-in').value = ''; msgs.push({ role: 'user', content: text }); msgs.push({ role: 'assistant', content: '…' }); thread();
      var r = await api('/chat', { method: 'POST', headers: hdr(k), body: JSON.stringify({ prompt: text }) });
      msgs.pop();
      if (r.status === 402) { msgs.push({ role: 'assistant', content: 'Out of BLOCK credit — top up below.' }); thread(); refreshBal(); return; }
      msgs.push({ role: 'assistant', content: r.ok ? (r.j.answer || '(no answer)') : ('Error: ' + ((r.j && r.j.error) || 'unavailable')) }); thread();
      if (r.ok && $('#ch-bal') && r.j.balanceBlock != null) $('#ch-bal').textContent = r.j.balanceBlock + ' BLOCK';
    }
    $('#ch-send').onclick = send;
    $('#ch-in').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  }

  global.ChatUI = {
    init: function (blockleUI) { UI = blockleUI; },
    enter: function () {
      if (UI && UI.show) UI.show('chat');
      var root = document.getElementById('chat-root');
      if (root) { try { render(root); } catch (e) { root.innerHTML = '<div class="empty">Chat failed to load.</div>'; } }
    },
  };
})(typeof window !== 'undefined' ? window : this);
