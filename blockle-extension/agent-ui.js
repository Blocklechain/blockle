// agent-ui.js — the AGENT COCKPIT for the popup. One screen that:
//   • CONNECTS an LLM provider (Claude / ChatGPT / Copilot / Other OpenAI-compat),
//     showing each provider's PROVIDER_GUIDES help + link; the connection is sealed
//     in the vault (agent-store.js) and AUTO-RECONNECTS on unlock.
//   • manages MULTI-CHANNEL agents (agent/channels.js), each bound to a wallet,
//     with its own caps, venue/strategy config, P&L, command box, predefined
//     prompts and a live event log.
//   • ENFORCES THE SAFETY CONTRACT (RED-3): the host passes a REQUIRED confirm
//     handler (a real modal), a VISIBLE kill switch (KILL ALL), SANE DEFAULT caps,
//     and the channel manager REFUSES to start a value-moving channel until caps
//     are set.
//   • wires venues.js (incl. the 0.05% treasury fee) + telemetry.js into the
//     runner via Wiring (agent ctx + per-trade telemetry emit).
//
// Global `AgentUI`. Depends on Wiring, AgentStore, AgentChannels, Agent, Wallet,
// Exchange, Store and the popup's shared `BlockleUI`.
(function (global) {
  'use strict';

  const GUIDES = (global.AgentChannels && global.AgentChannels.PROVIDER_GUIDES) || {};
  const PREDEFINED = [
    'DCA $50/week into BLOCK',
    'rebalance 50/50',
    'buy the dip -10%',
    'take profit +25%',
    'market-make BLOCK/USDC',
  ];
  const VENUE_CHOICES = ['blockle', 'evmdex', 'jupiter'];

  let UI = null;
  let manager = null;
  // Confirmation QUEUE: concurrent channels can each await their own prompt. We
  // show one modal at a time and never drop or overwrite a pending request — each
  // enqueued {summary, resolve} is answered in turn (FIFO).
  const confirmQueue = [];  // [{ summary, resolve }]
  let confirmActive = false;
  let expanded = null;      // expanded channel id
  const logs = {};          // channelId -> [lines]

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function init(ui) {
    UI = ui;
    const kill = $('#agent-kill');
    if (kill) kill.addEventListener('click', killAll);
    const ca = $('#agent-confirm-approve');
    const cr = $('#agent-confirm-reject');
    if (ca) ca.addEventListener('click', () => resolveConfirm(true));
    if (cr) cr.addEventListener('click', () => resolveConfirm(false));
  }

  // ---- lifecycle hooks (called by popup.js) ---------------------------------
  // After a password unlock: open the encrypted connection store, then build +
  // auto-resume channels.
  async function onUnlock(password) {
    try { await AgentStore.unlock(password); } catch {}
    await bootChannels();
  }
  // After a session resume (no fresh password): restore from the session mirror.
  async function onResume() {
    const ok = await AgentStore.resume();
    if (ok) await bootChannels();
  }
  async function onLock() {
    // Drop the live manager (its Agent instances hold the only decrypted creds);
    // persisted records keep enabled=true so they auto-resume on next unlock.
    manager = null;
    await AgentStore.lock();
  }

  async function bootChannels() {
    try {
      await Wiring.ensureAgentDeps();         // venues + telemetry ready
      buildManager();
      await manager.load();
      const r = await manager.resume();        // auto-reconnect enabled channels
      if (r && r.skipped && r.skipped.length) {
        // non-fatal: surfaced in the list (a channel missing caps/cred just stays off)
      }
    } catch (_) {}
  }

  function buildManager() {
    if (manager) return manager;
    manager = AgentChannels.create({
      store: Store,
      agentFactory: global.Agent,
      resolveCredential: (credRef) => AgentStore.resolve(credRef),
      confirm: (summary) => doConfirm(summary),          // REQUIRED modal (RED-3)
      onKill: async () => { await globalKill(); },        // KILL ALL host hook
      onChannelKill: (id) => { pushLog(id, 'channel killed'); },
      onEvent: (id, ev) => onChannelEvent(id, ev),
      ctxFor: () => Wiring.agentCtx(),                    // incl. venues + 0.05% fee
      fetchImpl: typeof fetch !== 'undefined' ? fetch.bind(global) : undefined,
    });
    return manager;
  }

  // ---- the REQUIRED confirmation modal (returns Promise<boolean>) -----------
  // Enqueue + show one at a time so N concurrent channels each get their own
  // prompt in turn. A kill (globalKill/killAll) drains the queue as rejections.
  function doConfirm(summary) {
    return new Promise((resolve) => {
      confirmQueue.push({ summary, resolve });
      if (!confirmActive) showNextConfirm();
    });
  }
  function showNextConfirm() {
    const head = confirmQueue[0];
    if (!head) { confirmActive = false; return; }
    confirmActive = true;
    const detail = $('#agent-confirm-detail');
    if (detail) {
      const more = confirmQueue.length - 1;
      detail.textContent = summarize(head.summary) + (more > 0 ? '\n\n(' + more + ' more awaiting confirmation)' : '');
    }
    UI.show('agent-confirm');
  }
  function resolveConfirm(ok) {
    const head = confirmQueue.shift();
    if (head && head.resolve) { try { head.resolve(ok); } catch (_) {} }
    if (confirmQueue.length) showNextConfirm();
    else { confirmActive = false; UI.show('agent'); }
  }
  // Reject + clear every queued confirmation (used on kill, so no promise dangles).
  function drainConfirms() {
    while (confirmQueue.length) {
      const h = confirmQueue.shift();
      if (h && h.resolve) { try { h.resolve(false); } catch (_) {} }
    }
    confirmActive = false;
  }
  function summarize(s) {
    if (!s) return 'Confirm this action?';
    if (typeof s === 'string') return s;
    try {
      const parts = [];
      if (s.action) parts.push(s.action.toUpperCase());
      if (s.from && s.to) parts.push(s.from + ' → ' + s.to);
      if (s.market) parts.push(s.market + (s.side ? ' ' + s.side : ''));
      if (s.chain) parts.push('on ' + s.chain);
      if (s.amount) parts.push('amount ' + s.amount);
      if (s.amountIn) parts.push('in ' + s.amountIn);
      if (s.price) parts.push('@ ' + s.price);
      if (s.to && !s.from) parts.push('to ' + UI.shortAddr(s.to));
      if (s.fee) parts.push('fee ' + s.fee);
      return parts.join(' · ') || JSON.stringify(s).slice(0, 240);
    } catch { return 'Confirm this action?'; }
  }

  // ---- kill switch ----------------------------------------------------------
  async function killAll() {
    if (!global.confirm('Kill ALL agent channels and lock the wallet now?')) return;
    drainConfirms(); // reject anything waiting so no commit can slip through
    try { if (manager) await manager.killAll('user kill'); else await globalKill(); } catch {}
    UI.toast('Agent stopped · wallet locked');
    UI.route('unlock');
  }
  async function globalKill() {
    drainConfirms();
    try { await global.Exchange.signOut(); } catch {}
    try { await Wallet.lock(); } catch {}
    await AgentStore.lock();
    Wiring.reset();
    manager = null;
  }

  // ---- live events + telemetry ---------------------------------------------
  async function onChannelEvent(id, ev) {
    if (!ev) return;
    if (ev.type === 'text') pushLog(id, 'agent: ' + (ev.text || '').slice(0, 300));
    else if (ev.type === 'tool_call') pushLog(id, '→ ' + ev.name + '(' + shortArgs(ev.args) + ')');
    else if (ev.type === 'prepared') pushLog(id, 'prepared: ' + summarize(ev.summary));
    else if (ev.type === 'declined') pushLog(id, '✗ declined: ' + ev.name);
    else if (ev.type === 'executed') { pushLog(id, '✓ executed ' + ev.name + (ev.txid ? ' · ' + String(ev.txid).slice(0, 12) + '…' : '')); emitTelemetry(id, ev); }
    else if (ev.type === 'fee') { const f = ev.fee || {}; pushLog(id, '  ⬩ agent fee ' + (f.amount || '') + ' ' + (f.asset || '') + ' → treasury' + (ev.txid ? ' · ' + String(ev.txid).slice(0, 12) + '…' : (f.error ? ' · FAILED: ' + f.error : ''))); }
    else if (ev.type === 'tool_error') pushLog(id, '! error ' + ev.name + ': ' + ev.error);
    else if (ev.type === 'killed') pushLog(id, 'killed: ' + (ev.reason || ''));
    if (expanded === id) renderLog(id);
  }
  function shortArgs(a) { try { return JSON.stringify(a).slice(0, 80); } catch { return ''; } }
  function pushLog(id, line) {
    logs[id] = logs[id] || [];
    logs[id].push('[' + new Date().toLocaleTimeString() + '] ' + line);
    if (logs[id].length > 200) logs[id].splice(0, logs[id].length - 200);
  }
  async function emitTelemetry(id, ev) {
    try {
      const tel = await Wiring.telemetry();
      if (!tel.isEnabled()) return;
      const ch = manager && manager.get(id);
      const cfg = (ch && ch.meta && ch.meta.config) || {};
      const s = ev.summary || {};
      const fee = ev.fee || (ev.result && ev.result.agentFee) || null;
      const chain = (ev.result && ev.result.chain) || s.chain || 'unknown';
      const venue = s.venue || (cfg.venues && cfg.venues[0]) || 'blockle';
      await tel.emit({
        strategy: cfg.strategy || 'manual',
        venue, chain,
        pair: (s.from && s.to) ? (s.from + '/' + s.to) : (s.market || null),
        side: s.side || null,
        slippagePct: cfg.slippagePct != null ? Number(cfg.slippagePct) : undefined,
        intent: ev.name, outcome: 'executed',
        // the mandatory 0.05% agent fee, as a percent (5 bps -> 0.05)
        feePct: fee && fee.bps != null ? Number(fee.bps) / 100 : undefined,
      });
    } catch (_) {}
  }

  // ---- main render ----------------------------------------------------------
  async function enter() {
    UI.show('agent');
    const body = $('#agent-body');
    if (!Wallet.isUnlocked() || !AgentStore.isUnlocked()) {
      body.innerHTML = '<div class="notice">Unlock your wallet to configure the AI trading agent. Your LLM connection is sealed in the vault and reconnects automatically after unlock.</div>';
      return;
    }
    buildManager();
    if (!manager.list().length) { try { await manager.load(); } catch {} }
    body.innerHTML = renderConnections() + renderTelemetry() + renderChannels() + renderConnectForm() + renderNewChannelForm();
    wireBody();
  }

  function renderConnections() {
    const conns = AgentStore.list();
    const rows = conns.length ? conns.map((c) =>
      `<div class="row"><div class="l"><b>${esc(c.label || c.provider)}</b><small>${esc(c.provider)}${c.model ? ' · ' + esc(c.model) : ''}</small></div>
       <button class="mini-btn" data-disc="${esc(c.credRef)}">Disconnect</button></div>`).join('')
      : '<div class="empty">No providers connected.</div>';
    return `<div class="section-h">Provider connections</div><div class="list" style="flex:none">${rows}</div>
      <button class="btn ghost" id="agent-add-conn" style="margin:0 0 6px">+ Connect a provider</button>`;
  }

  function renderConnectForm() {
    const opts = Object.keys(GUIDES).map((k) => `<option value="${k}">${esc(GUIDES[k].label)}</option>`).join('');
    return `<div id="agent-connect" hidden class="agent-card">
      <div class="section-h" style="padding-top:0">Connect provider</div>
      <label class="field"><span>Provider</span>
        <select id="ac-provider" class="mono">${opts}</select></label>
      <div class="notice" id="ac-guide"></div>
      <a id="ac-link" href="#" target="_blank" rel="noopener" class="btn link" style="padding:4px 0">Get an API key ↗</a>
      <label class="field"><span>API key</span><input type="password" id="ac-key" placeholder="sk-…" class="mono" /></label>
      <label class="field" id="ac-model-field"><span>Model</span><input type="text" id="ac-model" class="mono" /></label>
      <label class="field" id="ac-baseurl-field" hidden><span>Base URL (OpenAI-compatible)</span><input type="text" id="ac-baseurl" class="mono" placeholder="https://host/v1" /></label>
      <div class="err" id="ac-err"></div>
      <div class="row-btns"><button class="btn ghost" id="ac-cancel">Cancel</button><button class="btn primary" id="ac-save">Connect</button></div>
    </div>`;
  }

  function renderTelemetry() {
    return `<div class="section-h">Anonymous telemetry</div>
      <label class="agent-toggle"><input type="checkbox" id="agent-tel" /> <span>Share anonymized, bucketed performance stats (default off)</span></label>`;
  }

  function renderChannels() {
    const list = manager ? manager.list() : [];
    const rows = list.length ? list.map(renderChannelRow).join('')
      : '<div class="empty">No channels yet. Create one to let the agent trade a specific account.</div>';
    return `<div class="section-h">Channels</div><div id="agent-channels">${rows}</div>
      <button class="btn ghost" id="agent-new-ch" style="margin:6px 0">+ New channel</button>`;
  }

  function renderChannelRow(d) {
    const open = expanded === d.id;
    const status = d.killed ? 'killed' : d.running ? 'running' : (d.enabled ? 'connecting' : 'stopped');
    const dot = d.running ? '#34d399' : d.killed ? '#fb7185' : '#8a90a6';
    const pnl = d.pnl ? d.pnl.realizedUsd : 0;
    const pnlColor = pnl > 0 ? '#34d399' : pnl < 0 ? '#fb7185' : 'var(--muted)';
    let body = '';
    if (open) body = renderChannelDetail(d);
    return `<div class="agent-ch" data-ch="${esc(d.id)}">
      <div class="agent-ch-head" data-expand="${esc(d.id)}">
        <div><b>${esc(d.label)}</b> <small class="muted">${esc(d.provider)}${d.readOnly ? ' · read-only' : ''}</small>
          <div><small class="muted">${esc(status)} · <span style="color:${pnlColor}">P&L $${(pnl || 0).toFixed(2)}</span> · ${d.pnl ? d.pnl.tradeCount : 0} trades</small></div></div>
        <span class="agent-dot" style="background:${dot}"></span>
      </div>${body}</div>`;
  }

  function renderChannelDetail(d) {
    const caps = d.caps || {};
    const venuesOn = (d.config && d.config.venues) || ['blockle'];
    const chips = PREDEFINED.map((p) => `<button class="chip-btn pp" data-prompt="${esc(p)}">${esc(p)}</button>`).join('');
    const venueToggles = VENUE_CHOICES.map((v) =>
      `<label class="agent-toggle"><input type="checkbox" class="vt" data-venue="${v}" ${venuesOn.includes(v) ? 'checked' : ''}/> <span>${v}</span></label>`).join('');
    const spark = sparkline(d);
    const log = (logs[d.id] || []).slice(-14).map((l) => `<div>${esc(l)}</div>`).join('') || '<div class="muted">No activity yet.</div>';
    return `<div class="agent-ch-body">
      <div class="agent-eq">${spark}</div>
      <div class="pnl-grid">
        <div><small class="muted">Realized</small><b style="color:${(d.pnl && d.pnl.realizedUsd) >= 0 ? '#34d399' : '#fb7185'}">$${((d.pnl && d.pnl.realizedUsd) || 0).toFixed(2)}</b></div>
        <div><small class="muted">Trades</small><b>${(d.pnl && d.pnl.tradeCount) || 0}</b></div>
        <div><small class="muted">Fee bps</small><b>5 (0.05%)</b></div>
      </div>
      <div class="section-h" style="padding-left:0">Caps (required to move value)</div>
      <label class="field"><span>Session cap (USD)</span><input type="text" class="cap-usd mono" value="${caps.sessionUsd != null ? esc(caps.sessionUsd) : ''}" placeholder="100" inputmode="decimal"/></label>
      <label class="field"><span>Per-asset cap · BLOCK (base units)</span><input type="text" class="cap-block mono" value="${caps.perAsset && caps.perAsset.BLOCK != null ? esc(caps.perAsset.BLOCK) : ''}" placeholder="optional"/></label>
      <button class="mini-btn cap-save" style="background:var(--surface2);color:var(--text)">Save caps</button>
      <div class="section-h" style="padding-left:0">Venues</div>${venueToggles}
      <label class="field"><span>Strategy note</span><input type="text" class="strat mono" value="${esc((d.config && d.config.strategy) || '')}" placeholder="e.g. conservative DCA"/></label>
      <label class="field"><span>Slippage (%)</span><input type="text" class="slip mono" value="${esc((d.config && d.config.slippagePct) != null ? d.config.slippagePct : '0.5')}" inputmode="decimal"/></label>
      <button class="mini-btn cfg-save" style="background:var(--surface2);color:var(--text)">Save config</button>
      <div class="section-h" style="padding-left:0">Command</div>
      <div class="pp-chips">${chips}</div>
      <label class="field"><span>Message the agent</span><input type="text" class="cmd" placeholder="e.g. buy 10 USDC of BLOCK"/></label>
      <div class="row-btns">
        ${d.running ? `<button class="btn ghost ch-stop">Stop</button>` : `<button class="btn primary ch-start">Connect</button>`}
        <button class="btn primary ch-send" ${d.running ? '' : 'disabled'}>Send</button>
      </div>
      <div class="row-btns"><button class="btn danger ch-kill">Kill</button><button class="btn ghost ch-del">Delete</button></div>
      <div class="err ch-err"></div>
      <div class="section-h" style="padding-left:0">Activity</div>
      <div class="agent-log mono">${log}</div>
    </div>`;
  }

  // simple cumulative-realized sparkline from the channel's recorded P&L trades
  function sparkline(d) {
    const ch = manager && manager.get(d.id);
    const trades = (ch && ch.pnl && ch.pnl.trades) || [];
    const pts = [];
    let cum = 0;
    for (const t of trades) { if (t.realizedUsd != null) cum += Number(t.realizedUsd); pts.push(cum); }
    if (pts.length < 2) return '<small class="muted">Equity curve appears after trades.</small>';
    const w = 300, h = 46, min = Math.min(0, ...pts), max = Math.max(0, ...pts), span = (max - min) || 1;
    const step = w / (pts.length - 1);
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((p - min) / span) * h).toFixed(1)}`).join(' ');
    const up = pts[pts.length - 1] >= 0;
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="${up ? '#34d399' : '#fb7185'}" stroke-width="2"/></svg>`;
  }

  function renderNewChannelForm() {
    const conns = AgentStore.list();
    const connOpts = conns.map((c) => `<option value="${esc(c.credRef)}">${esc(c.label || c.provider)}</option>`).join('');
    return `<div id="agent-newch" hidden class="agent-card">
      <div class="section-h" style="padding-top:0">New channel</div>
      <label class="field"><span>Label</span><input type="text" id="nc-label" placeholder="e.g. BLOCK trader"/></label>
      <label class="field"><span>Connection</span><select id="nc-conn" class="mono">${connOpts || '<option value="">connect a provider first</option>'}</select></label>
      <div class="notice">Bound to your ACTIVE wallet. Value-moving channels require a spend cap before they can start.</div>
      <label class="agent-toggle"><input type="checkbox" id="nc-readonly"/> <span>Read-only (analysis only — no caps required)</span></label>
      <label class="field"><span>Session cap (USD)</span><input type="text" id="nc-cap" class="mono" value="100" inputmode="decimal"/></label>
      <div class="err" id="nc-err"></div>
      <div class="row-btns"><button class="btn ghost" id="nc-cancel">Cancel</button><button class="btn primary" id="nc-create">Create</button></div>
    </div>`;
  }

  // ---- wiring (CSP-safe: addEventListener only) -----------------------------
  function wireBody() {
    const addConn = $('#agent-add-conn');
    if (addConn) addConn.addEventListener('click', () => { const f = $('#agent-connect'); f.hidden = !f.hidden; if (!f.hidden) fillGuide(); });
    const newCh = $('#agent-new-ch');
    if (newCh) newCh.addEventListener('click', () => { const f = $('#agent-newch'); f.hidden = !f.hidden; });

    // telemetry toggle
    Wiring.telemetry().then((tel) => {
      const t = $('#agent-tel');
      if (t) { t.checked = tel.isEnabled(); t.addEventListener('change', async () => { await tel.setEnabled(t.checked); UI.toast(t.checked ? 'Telemetry on' : 'Telemetry off'); }); }
    });

    // connect form
    const prov = $('#ac-provider');
    if (prov) prov.addEventListener('change', fillGuide);
    const save = $('#ac-save'); if (save) save.addEventListener('click', connectProvider);
    const cancel = $('#ac-cancel'); if (cancel) cancel.addEventListener('click', () => { $('#agent-connect').hidden = true; });
    $$('[data-disc]').forEach((b) => b.addEventListener('click', async () => {
      await AgentStore.remove(b.getAttribute('data-disc')); UI.toast('Disconnected'); enter();
    }));

    // new channel form
    const ncCreate = $('#nc-create'); if (ncCreate) ncCreate.addEventListener('click', createChannel);
    const ncCancel = $('#nc-cancel'); if (ncCancel) ncCancel.addEventListener('click', () => { $('#agent-newch').hidden = true; });

    // channel rows
    $$('[data-expand]').forEach((h) => h.addEventListener('click', () => {
      const id = h.getAttribute('data-expand');
      expanded = expanded === id ? null : id;
      enter();
    }));
    $$('.agent-ch').forEach((row) => wireChannelRow(row));
  }
  function $$(s) { return Array.from(document.querySelectorAll(s)); }

  function fillGuide() {
    const k = $('#ac-provider').value;
    const g = GUIDES[k] || {};
    $('#ac-guide').textContent = g.how || '';
    const link = $('#ac-link');
    if (g.url) { link.href = g.url; link.hidden = false; } else { link.hidden = true; }
    $('#ac-model').value = g.defaultModel || '';
    $('#ac-baseurl-field').hidden = !(g.needs && g.needs.includes('baseUrl'));
  }

  async function connectProvider() {
    const err = $('#ac-err'); err.textContent = '';
    const k = $('#ac-provider').value;
    const g = GUIDES[k] || {};
    const apiKey = $('#ac-key').value.trim();
    const model = $('#ac-model').value.trim();
    const baseUrl = $('#ac-baseurl').value.trim();
    if (!apiKey) return (err.textContent = 'Paste an API key.');
    if (g.needs && g.needs.includes('baseUrl') && !baseUrl) return (err.textContent = 'A base URL is required for this provider.');
    if (g.needs && g.needs.includes('model') && !model) return (err.textContent = 'A model name is required for this provider.');
    try {
      await AgentStore.add({ provider: g.provider || k, apiKey, model: model || null, baseUrl: baseUrl || null, label: g.label || k });
      UI.toast('Provider connected');
      enter();
    } catch (e) { err.textContent = e.message || String(e); }
  }

  async function createChannel() {
    const err = $('#nc-err'); err.textContent = '';
    const label = $('#nc-label').value.trim() || 'Channel';
    const credRef = $('#nc-conn').value;
    const readOnly = $('#nc-readonly').checked;
    const capUsd = parseFloat($('#nc-cap').value);
    if (!credRef) return (err.textContent = 'Connect a provider first.');
    const conn = AgentStore.list().find((c) => c.credRef === credRef);
    if (!conn) return (err.textContent = 'Pick a connection.');
    const rec = await Wallet.selected();
    const caps = readOnly ? {} : { sessionUsd: isFinite(capUsd) ? capUsd : 100, perAsset: {} };
    try {
      buildManager();
      await manager.create({
        label, provider: conn.provider, model: conn.model, baseUrl: conn.baseUrl,
        credRef, walletId: (rec && rec.id) || Wallet.activeId || 'active',
        readOnly, caps, config: { venues: ['blockle'], slippagePct: 0.5 },
      });
      $('#agent-newch').hidden = true;
      UI.toast('Channel created');
      enter();
    } catch (e) { err.textContent = e.message || String(e); }
  }

  function wireChannelRow(row) {
    const id = row.getAttribute('data-ch');
    const q = (sel) => row.querySelector(sel);
    const err = q('.ch-err');
    const setErr = (m) => { if (err) err.textContent = m; };

    const start = q('.ch-start');
    if (start) start.addEventListener('click', async () => {
      setErr(''); start.disabled = true; start.textContent = 'Connecting…';
      try { await manager.start(id); UI.toast('Channel connected'); enter(); }
      catch (e) { setErr(e.message || String(e)); start.disabled = false; start.textContent = 'Connect'; }
    });
    const stop = q('.ch-stop');
    if (stop) stop.addEventListener('click', async () => { await manager.stop(id); UI.toast('Stopped'); enter(); });
    const kill = q('.ch-kill');
    if (kill) kill.addEventListener('click', async () => { await manager.get(id).kill('user kill'); UI.toast('Channel killed'); enter(); });
    const del = q('.ch-del');
    if (del) del.addEventListener('click', async () => { if (global.confirm('Delete this channel?')) { await manager.delete(id); expanded = null; enter(); } });

    const capSave = q('.cap-save');
    if (capSave) capSave.addEventListener('click', async () => {
      const usd = parseFloat(q('.cap-usd').value);
      const block = q('.cap-block').value.trim();
      const caps = { sessionUsd: isFinite(usd) ? usd : null, perAsset: {} };
      if (block && /^\d+$/.test(block)) caps.perAsset.BLOCK = block;
      await manager.get(id).setCaps(caps);
      UI.toast('Caps saved'); enter();
    });

    const cfgSave = q('.cfg-save');
    if (cfgSave) cfgSave.addEventListener('click', async () => {
      const ch = manager.get(id);
      const venues = Array.from(row.querySelectorAll('.vt')).filter((c) => c.checked).map((c) => c.getAttribute('data-venue'));
      ch.meta.config = Object.assign({}, ch.meta.config, {
        venues: venues.length ? venues : ['blockle'],
        strategy: q('.strat').value.trim(),
        slippagePct: parseFloat(q('.slip').value) || 0.5,
      });
      await manager._persist();
      UI.toast('Config saved');
    });

    row.querySelectorAll('.pp').forEach((chip) => chip.addEventListener('click', () => {
      const cmd = q('.cmd'); if (cmd) cmd.value = chip.getAttribute('data-prompt');
    }));

    const send = q('.ch-send');
    if (send) send.addEventListener('click', async () => {
      const cmd = q('.cmd'); const text = cmd && cmd.value.trim();
      if (!text) return;
      setErr('');
      const ch = manager.get(id);
      if (!ch || !ch.running) return setErr('Connect the channel first.');
      send.disabled = true; send.textContent = 'Running…';
      pushLog(id, 'you: ' + text); renderLog(id);
      try { await ch.run(text); }
      catch (e) { setErr(e.message || String(e)); }
      finally { send.disabled = false; send.textContent = 'Send'; if (cmd) cmd.value = ''; enter(); }
    });
  }

  function renderLog(id) {
    if (expanded !== id) return;
    const el = document.querySelector(`.agent-ch[data-ch="${id}"] .agent-log`);
    if (!el) return;
    el.innerHTML = (logs[id] || []).slice(-14).map((l) => `<div>${esc(l)}</div>`).join('') || '<div class="muted">No activity yet.</div>';
    el.scrollTop = el.scrollHeight;
  }

  global.AgentUI = { init, enter, onUnlock, onResume, onLock };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.AgentUI;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
