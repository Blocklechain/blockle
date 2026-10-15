// command-ui.test.js — pure renderers for the natural-language command bar.
// The UI owns no gate: it only renders what the router reports. These tests pin
// the event -> HTML mapping and the anti-XSS escaping.

const { test } = require('node:test');
const assert = require('node:assert');

const CommandUI = require('./command-ui.js');

test('intent badge distinguishes action vs query', () => {
  assert.match(CommandUI.intentBadgeHtml('action'), /ACTION/);
  assert.match(CommandUI.intentBadgeHtml('query'), /QUERY/);
});

test('plan renders one row per step, each marked awaiting confirmation', () => {
  const html = CommandUI.planHtml([
    { index: 0, action: 'swap', args: { from: 'USDC', to: 'ETH', amount: '60000000' } },
    { index: 1, action: 'swap', args: { from: 'ETH', to: 'USDC', amount: '40000000' } },
  ]);
  const rows = html.match(/cmd-plan-step/g) || [];
  assert.equal(rows.length, 2, 'two steps shown');
  assert.match(html, /awaiting confirm/);
  assert.match(html, /USDC/);
});

test('resolved mapping shows name -> resolved address + source (anti-spoofing)', () => {
  const html = CommandUI.resolvedHtml({ input: 'alice.eth', address: '0x' + 'b'.repeat(40), source: 'ens' });
  assert.match(html, /alice\.eth/);
  assert.match(html, /ens/);
  assert.match(html, /0xbbbbbbbb/);
});

test('eventHtml maps router events to fragments and ignores unknowns', () => {
  assert.match(CommandUI.eventHtml({ type: 'intent', intent: 'action' }), /ACTION/);
  assert.match(CommandUI.eventHtml({ type: 'executed', name: 'send', txid: '0xdeadbeefcafef00d' }), /confirmed &amp; sent/);
  assert.match(CommandUI.eventHtml({ type: 'declined', name: 'send' }), /declined/);
  assert.match(CommandUI.eventHtml({ type: 'step_error', name: 'send', error: 'per-asset cap exceeded' }), /cap exceeded/);
  assert.match(CommandUI.eventHtml({ type: 'text', text: 'your net worth is $123.45' }), /123\.45/);
  assert.equal(CommandUI.eventHtml({ type: 'prepared', name: 'send' }), '');
  assert.equal(CommandUI.eventHtml(null), '');
});

test('the command bar renders NO approve/sign control of its own (gate is the host sheet)', () => {
  // the outcome/plan renderers must never present a clickable approve button —
  // confirmation belongs to the shared security sheet via policy.gateConfirm.
  const html = CommandUI.planHtml([{ index: 0, action: 'send', args: { chain: 'ethereum', to: '0x' + 'a'.repeat(40), amount: '1' } }]) +
    CommandUI.stepOutcomeHtml('send', 'committed', '0xabc');
  assert.ok(!/<button[^>]*>(\s*)(approve|confirm|sign)/i.test(html), 'no self-owned approve button');
});

test('escaping neutralizes HTML in user/engine strings (no injection)', () => {
  const html = CommandUI.answerHtml('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/.test(html), 'markup is escaped');
  assert.match(html, /&lt;img/);
});
