// command-ui.js — the NATURAL-LANGUAGE COMMAND BAR surface for the popup.
//
// A single text input, surfaced in the wallet ALONGSIDE the existing agent/bots
// cockpit. It drives agent/command.js (the CommandRouter) and renders, inline:
//   • the interpreted INTENT (action vs query),
//   • for an ACTION, the proposed PLAN (one row per step) and, per step, the
//     RESOLVED recipient (name -> address) and the step outcome
//     (committed / declined / error),
//   • for a QUERY, the answer text.
//
// It adds NO new power and owns NO gate. Every value-moving step is confirmed by
// the HOST's shared security confirm sheet — the SAME modal the agent cockpit
// already wires into policy.gateConfirm (passed in via the router the host builds).
// This module never signs, never broadcasts, and never shows its own "approve"
// button; it only shows what the router reports.
//
// Decoupled by construction: the host passes `buildRouter({ onEvent })` which
// wires the provider / tools / policy / confirm / engines for the active wallet
// and returns an AgentCommand router. CommandUI subscribes to that router's events.
//
// Global `CommandUI`; module.exports for node tests (pure renderers are exported).
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function short(addr) {
    const s = String(addr || '');
    return s.length > 14 ? s.slice(0, 8) + '…' + s.slice(-6) : s;
  }

  // ---- pure renderers (unit-tested) -----------------------------------------

  function intentBadgeHtml(intent) {
    const isAction = intent === 'action';
    return '<span class="cmd-badge ' + (isAction ? 'cmd-action' : 'cmd-query') + '">' +
      (isAction ? 'ACTION' : 'QUERY') + '</span>';
  }

  // A proposed multi-step plan, shown BEFORE any step is confirmed. Each row is a
  // value-moving step the host's shared confirm sheet will gate individually.
  function planHtml(steps) {
    const rows = (steps || []).map((s, i) => {
      const a = s.args || {};
      let line;
      if (s.action === 'send') {
        line = 'send ' + esc(a.amount) + ' ' + esc((a.asset && a.asset.symbol) || (a.chain ? String(a.chain).toUpperCase() : '')) +
          ' → ' + esc(short(a.to));
      } else if (s.action === 'swap') {
        line = 'swap ' + esc(a.amount) + ' ' + esc(a.from) + ' → ' + esc(a.to);
      } else {
        line = esc(s.action);
      }
      return '<li class="cmd-plan-step"><span class="cmd-step-n">' + (s.index != null ? s.index + 1 : i + 1) + '</span>' +
        '<span class="cmd-step-desc">' + line + '</span>' +
        '<span class="cmd-step-status" data-status="pending">awaiting confirm</span></li>';
    }).join('');
    return '<div class="cmd-plan"><div class="cmd-plan-h">Plan — each step needs your confirmation</div>' +
      '<ol class="cmd-plan-list">' + rows + '</ol></div>';
  }

  // The name -> resolved-address mapping, surfaced so the human verifies WHO gets
  // paid (anti-spoofing). The resolved address is what is confirmed and sent.
  function resolvedHtml(ev) {
    return '<div class="cmd-resolved">Resolved <b>' + esc(ev.input) + '</b> → <span class="mono">' +
      esc(ev.address) + '</span> <span class="cmd-src">(' + esc(ev.source || 'raw') + ')</span></div>';
  }

  function stepOutcomeHtml(name, status, detail) {
    const label = status === 'committed' ? 'confirmed & sent'
      : status === 'declined' ? 'declined'
      : status === 'error' ? 'blocked'
      : status;
    return '<div class="cmd-outcome" data-status="' + esc(status) + '">' +
      esc(name) + ': <b>' + esc(label) + '</b>' + (detail ? ' — ' + esc(detail) : '') + '</div>';
  }

  function answerHtml(text) {
    return '<div class="cmd-answer">' + esc(text || '') + '</div>';
  }

  function errorHtml(text) {
    return '<div class="cmd-err">' + esc(text || '') + '</div>';
  }

  // Turn ONE router event into an HTML fragment (or '' to ignore). Centralized so
  // the mount controller and tests share the exact same mapping.
  function eventHtml(ev) {
    if (!ev || !ev.type) return '';
    switch (ev.type) {
      case 'intent': return intentBadgeHtml(ev.intent);
      case 'plan': return planHtml(ev.steps);
      case 'resolved': return resolvedHtml(ev);
      case 'text': return answerHtml(ev.text);
      case 'declined': return stepOutcomeHtml(ev.name, 'declined');
      case 'executed': return stepOutcomeHtml(ev.name, 'committed', ev.txid ? String(ev.txid).slice(0, 14) + '…' : null);
      case 'step_error': return errorHtml((ev.name ? ev.name + ': ' : '') + ev.error);
      case 'tool_error': return errorHtml((ev.name ? ev.name + ': ' : '') + ev.error);
      case 'killed': return errorHtml('killed — ' + (ev.reason || ''));
      default: return '';
    }
  }

  // ---- mount controller (browser only) --------------------------------------
  // container: a DOM element to render into.
  // opts.buildRouter({ onEvent }) -> AgentCommand router (host wires provider/
  //   tools/policy/confirm/engines for the active wallet). REQUIRED to run.
  function mount(container, opts) {
    opts = opts || {};
    if (!container) throw new Error('CommandUI.mount requires a container element');
    const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) throw new Error('CommandUI.mount requires a DOM');

    container.innerHTML =
      '<div class="cmd-bar">' +
        '<div class="cmd-input-row">' +
          '<input type="text" class="cmd-input" id="cmd-input" ' +
            'placeholder="Try: send 0.1 ETH to alice.eth · swap 100 USDC to SOL · what is my net worth?" autocomplete="off" />' +
          '<button class="btn" id="cmd-go">Run</button>' +
        '</div>' +
        '<div class="cmd-hint">The agent only proposes actions. Every fund move is capped and needs your confirmation.</div>' +
        '<div class="cmd-transcript" id="cmd-transcript"></div>' +
      '</div>';

    const input = container.querySelector('#cmd-input');
    const go = container.querySelector('#cmd-go');
    const transcript = container.querySelector('#cmd-transcript');
    let busy = false;

    function append(html) {
      if (!html) return;
      const div = doc.createElement('div');
      div.innerHTML = html;
      transcript.appendChild(div);
      transcript.scrollTop = transcript.scrollHeight;
    }

    async function submit() {
      const text = String(input.value || '').trim();
      if (!text || busy) return;
      busy = true;
      go.disabled = true;
      append('<div class="cmd-you">' + esc(text) + '</div>');
      input.value = '';
      let router;
      try {
        router = opts.buildRouter({ onEvent: (ev) => append(eventHtml(ev)) });
        const r = await router.run(text);
        // the final answer text (query) or a closing note (action) if the router
        // returned text without a trailing 'text' event.
        if (r && r.text) append(answerHtml(r.text));
      } catch (e) {
        append(errorHtml((e && e.message) || 'command failed'));
      } finally {
        busy = false;
        go.disabled = false;
        input.focus();
      }
    }

    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    return { submit, destroy() { container.innerHTML = ''; } };
  }

  const CommandUI = {
    mount,
    // pure renderers (exported for tests / ports):
    esc, short, intentBadgeHtml, planHtml, resolvedHtml, stepOutcomeHtml, answerHtml, errorHtml, eventHtml,
  };
  global.CommandUI = CommandUI;
  if (inNode) module.exports = CommandUI;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
