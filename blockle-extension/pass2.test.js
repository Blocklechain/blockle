// pass2.test.js — load-sim + integration tests for the Pass-2 wiring:
//   • storage.js backed by an in-memory chrome.storage shim
//   • agent-store.js: vault-sealed LLM-credential roundtrip + disk reopen
//   • venues.js: the 0.05% treasury fee resolves end-to-end
//   • telemetry.js: default OFF (no emit)
//   • agent/channels.js driven by AgentStore.resolve as its credential source:
//     RED-3 refusal of a capless value-moving channel, and a read-only start.
//
//   node pass2.test.js
//
// No network, no browser — a fake `chrome` + Node's WebCrypto back the vault.

const { test } = require('node:test');
const assert = require('node:assert');

// ---- in-memory chrome.storage shim (installed BEFORE requiring storage.js) ---
function memArea() {
  const m = new Map();
  return {
    async get(keys) {
      if (keys == null) { const o = {}; for (const [k, v] of m) o[k] = v; return o; }
      const list = Array.isArray(keys) ? keys : typeof keys === 'object' ? Object.keys(keys) : [keys];
      const out = {};
      for (const k of list) if (m.has(k)) out[k] = m.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) m.set(k, v); },
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) m.delete(k); },
    _map: m,
  };
}
globalThis.chrome = { storage: { local: memArea(), session: memArea() } };

// Pass-1 libs set their own globals when required.
require('./storage.js');     // -> globalThis.Store, globalThis.Session
require('./vault.js');       // -> globalThis.Vault
require('./agent-store.js'); // -> globalThis.AgentStore
require('./agent/policy.js');
require('./agent/audit.js');
require('./agent/providers.js');
require('./agent/tools.js');
require('./agent/runner.js');
const Agent = require('./agent/index.js');
const AgentChannels = require('./agent/channels.js');
const Venues = require('./venues.js');
const AgentTelemetry = require('./telemetry.js');

const TREASURY = {
  agentTradeFeeBps: 5,
  mainnet: {
    solana: 'EJiCDB6PmvvkGgNBxf84yMAkNKYdk2N1Qc7p4fziWC6j',
    ethereum: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
    base: '0x2eCC3cbCDc53471209Ecbc039b7FFB63744A3a3c',
  },
};

// ---------------------------------------------------------------------------
test('storage shim: Store + Session read/write through chrome.storage', async () => {
  await Store.set({ hello: 'world' });
  assert.strictEqual((await Store.get('hello')).hello, 'world');
  await Session.set('tok', { a: 1 });
  assert.deepStrictEqual(await Session.get('tok'), { a: 1 });
  await Session.clear('tok');
  assert.strictEqual(await Session.get('tok'), undefined);
});

test('AgentStore: vault-sealed credential roundtrip, secret-free list, resolve', async () => {
  await AgentStore.unlock('wallet-pw');
  assert.strictEqual(AgentStore.isUnlocked(), true);
  const view = await AgentStore.add({ provider: 'claude', apiKey: 'sk-ant-SECRET', model: 'claude-sonnet-4-5', label: 'Claude' });
  assert.ok(view.credRef);
  // the list view must NEVER carry the apiKey
  const listed = AgentStore.list();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual('apiKey' in listed[0], false);
  // resolve returns the full credential for the runner
  const cred = AgentStore.resolve(view.credRef);
  assert.strictEqual(cred.apiKey, 'sk-ant-SECRET');
  assert.strictEqual(cred.provider, 'claude');

  // what landed on "disk" is encrypted — the plaintext key must not appear
  const sealed = (await Store.get('agentConnections')).agentConnections;
  assert.ok(sealed && sealed.v === 2 && sealed.kdf && sealed.kdf.name === 'scrypt');
  assert.strictEqual(JSON.stringify(sealed).includes('sk-ant-SECRET'), false);
});

test('AgentStore: reopen from disk with the same password restores the credential', async () => {
  await AgentStore.lock();
  assert.strictEqual(AgentStore.isUnlocked(), false);
  assert.strictEqual(AgentStore.list().length, 0);
  await AgentStore.unlock('wallet-pw');          // decrypts the on-disk blob
  const listed = AgentStore.list();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(AgentStore.resolve(listed[0].credRef).apiKey, 'sk-ant-SECRET');
});

test('AgentStore: a wrong password degrades to empty, never throws', async () => {
  await AgentStore.lock();
  await AgentStore.unlock('WRONG');
  assert.strictEqual(AgentStore.list().length, 0);
  await AgentStore.unlock('wallet-pw'); // restore for later tests
});

test('venues: the 0.05% agent fee resolves per chain (exact BigInt floor)', () => {
  const vx = Venues.create({ treasury: TREASURY });
  assert.strictEqual(vx.feeBps, 5);
  const fee = vx.feeFor('base', '1000000', 'USDC');
  assert.strictEqual(fee.bps, 5);
  assert.strictEqual(fee.amount, '500');                 // floor(1_000_000 * 5 / 10_000)
  assert.strictEqual(fee.treasury, TREASURY.mainnet.base);
  // fail-closed: no treasury address for an unconfigured chain throws
  assert.throws(() => vx.feeFor('bitcoin', '1000', 'BTC'), /no treasury address/);
});

test('telemetry: default OFF — emit is a no-op with no network', async () => {
  const t = AgentTelemetry.create({});
  assert.strictEqual(t.isEnabled(), false);
  const r = await t.emit({ strategy: 's', venue: 'blockle', chain: 'block', result: 'win' });
  assert.strictEqual(r.emitted, false);
  assert.strictEqual(r.reason, 'disabled');
});

test('channels + AgentStore: RED-3 refuses a capless value channel; read-only starts', async () => {
  const conns = AgentStore.list();
  const credRef = conns[0].credRef;

  const mgr = AgentChannels.create({
    store: Store,
    agentFactory: Agent,
    resolveCredential: (ref) => AgentStore.resolve(ref),
    confirm: async () => true,          // REQUIRED confirm handler present
    ctxFor: () => ({}),
  });

  // value-moving channel WITH NO CAPS must refuse to start
  await mgr.create({ id: 'novalue', label: 'no caps', walletId: 'w1', provider: 'claude', credRef, caps: {} });
  await assert.rejects(() => mgr.start('novalue'), /set spend\/risk caps first/);

  // read-only channel needs no caps and connects via the resolved credential
  await mgr.create({ id: 'ro', label: 'analysis', walletId: 'w1', provider: 'claude', credRef, readOnly: true });
  const d = await mgr.start('ro');
  assert.strictEqual(d.running, true);
  assert.strictEqual(d.readOnly, true);

  // a value channel WITH caps also starts (caps + confirm satisfied)
  await mgr.create({ id: 'val', label: 'trader', walletId: 'w1', provider: 'claude', credRef, caps: { sessionUsd: 50 } });
  const dv = await mgr.start('val');
  assert.strictEqual(dv.running, true);
});

test('load-sim: wiring + UI controllers evaluate and init() is DOM-null-safe', () => {
  // Stub the browser surface the popup controllers expect. document.query*
  // returns null/[]; every controller guards with `if (el)`, so init() must not
  // throw even with no real DOM.
  globalThis.window = globalThis;
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

  const Wiring = require('./wiring.js');
  const AccountsUI = require('./accounts-ui.js');
  const AgentUI = require('./agent-ui.js');

  assert.strictEqual(typeof Wiring.agentCtx, 'function');
  assert.ok(Wiring.DEFAULT_TREASURY.agentTradeFeeBps === 5);
  // reset() must be safe with no registry built yet
  assert.doesNotThrow(() => Wiring.reset());

  const stubUI = { show() {}, toast() {}, route() {}, shortAddr: (a) => a, copy() {}, recordPending: async () => {} };
  assert.doesNotThrow(() => AccountsUI.init(stubUI));
  assert.doesNotThrow(() => AgentUI.init(stubUI));
});
