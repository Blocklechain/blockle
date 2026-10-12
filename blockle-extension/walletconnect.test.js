// walletconnect.test.js — Wallet dApp Connect / WalletConnect v2 core
// (docs/WALLET-WALLETCONNECT.md). Run: node --test walletconnect.test.js
//
// Asserts the reference implementation against the AUTHORITATIVE shared vectors
// (docs/walletconnect-vectors.json) — the exact pairing / proposal / approval /
// request-routing / expiry cases the Dart + Python ports must reproduce — plus
// unit tests for the SECURITY integration + the explicit-approval gate.
//
// The relay transport + WC crypto are ABSTRACTED: we inject a FAKE relay and a
// FAKE signer. The core is PURE given those — it NEVER holds keys and signs only
// AFTER explicit human approval + the security pre-sign gate. No dApp request
// ever auto-approves.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const WC = require('./walletconnect.js');
const Security = require('./security.js');
const vectors = require(path.join('..', 'docs', 'walletconnect-vectors.json'));

const NOW = vectors.nowMs;

// ---- a FAKE relay: records calls, grants/holds nothing on its own -----------
function fakeRelay() {
  const calls = { pair: [], approveProposal: [], rejectProposal: [], respond: [], disconnect: [] };
  let onRequest = null;
  return {
    calls,
    async pair(parsed) { calls.pair.push(parsed); },
    async approveProposal(proposal, settled) { calls.approveProposal.push({ proposal, settled }); },
    async rejectProposal(proposal, reason) { calls.rejectProposal.push({ proposal, reason }); },
    async respond(topic, response) { calls.respond.push({ topic, response }); },
    async disconnect(topic, reason) { calls.disconnect.push({ topic, reason }); },
    subscribeRequests(fn) { onRequest = fn; return () => { onRequest = null; }; },
    _emit(request) { return onRequest(request); },
  };
}

// ---- a FAKE signer: deterministic, NEVER real crypto, records what it signed -
function fakeSigner() {
  const signed = [];
  return {
    signed,
    async ethSendTransaction(a) { signed.push({ m: 'eth_sendTransaction', a }); return '0xhash_' + (a.tx && (a.tx.value || a.tx.data || '')); },
    async ethSignTypedData(a) { signed.push({ m: 'ethSignTypedData', a }); return '0xsig_typed'; },
    async personalSign(a) { signed.push({ m: 'personalSign', a }); return '0xsig_personal'; },
    async solanaSignTransaction(a) { signed.push({ m: 'solanaSignTransaction', a }); return { signature: 'solsig' }; },
    async solanaSignAndSend(a) { signed.push({ m: 'solanaSignAndSend', a }); return { signature: 'solsig_sent' }; },
    async solanaSignMessage(a) { signed.push({ m: 'solanaSignMessage', a }); return '0xsol_msg_sig'; },
  };
}

// ---- a FAKE encrypted store: a plain in-memory map (NO key material ever) ----
function fakeStore() {
  const mem = {};
  return {
    mem,
    async get(key) { return { [key]: mem[key] }; },
    async set(obj) { Object.assign(mem, obj); },
  };
}

function makeWC(extra) {
  extra = extra || {};
  const relay = extra.relay || fakeRelay();
  const signer = extra.signer || fakeSigner();
  const store = extra.store || fakeStore();
  const wc = WC.createWalletConnect({
    relay, signer, store, security: Security,
    now: () => (extra.now != null ? extra.now : NOW),
    config: Object.assign({}, vectors.config, extra.config),
  });
  return { wc, relay, signer, store };
}

// approval/confirm hooks that just record + return a fixed decision
function hooks(decision) {
  const seen = { approve: [], confirm: [] };
  const ctx = { security: {} };
  if (decision.approve !== undefined) ctx.approve = async (p) => { seen.approve.push(p); return decision.approve; };
  if (decision.confirm !== undefined && decision.confirm !== null) ctx.confirm = async (p) => { seen.confirm.push(p); return decision.confirm; };
  return { ctx, seen };
}

// ===========================================================================
// 1. PAIRING URI — accept v2, reject v1 + malformed (vectors)
// ===========================================================================
test('pairing: a valid v2 URI parses to topic/relay/symKey', () => {
  const v = vectors.pairing.valid;
  const got = WC.parsePairingUri(v.uri);
  assert.deepEqual(got, v.expect);
});

test('pairing: a v1 (@1) URI is rejected with a clear error', () => {
  const v = vectors.pairing.rejectV1;
  assert.throws(() => WC.parsePairingUri(v.uri), new RegExp(v.expectErrorMatch, 'i'));
});

test('pairing: malformed URIs are each rejected with a clear error', () => {
  for (const c of vectors.pairing.rejectMalformed) {
    assert.throws(() => WC.parsePairingUri(c.uri), new RegExp(escapeRe(c.expectErrorMatch), 'i'), 'should reject: ' + c.uri);
  }
});

test('pair(): parses then hands the pairing to the injected relay (grants nothing)', async () => {
  const { wc, relay } = makeWC();
  const parsed = await wc.pair(vectors.pairing.valid.uri);
  assert.equal(parsed.version, 2);
  assert.equal(relay.calls.pair.length, 1);
  assert.deepEqual(await wc.listSessions(), []); // pairing alone grants no session
});

test('pair(): a v1 URI never reaches the relay', async () => {
  const { wc, relay } = makeWC();
  await assert.rejects(() => wc.pair(vectors.pairing.rejectV1.uri), /v1/i);
  assert.equal(relay.calls.pair.length, 0);
});

// ===========================================================================
// 2. PROPOSAL REVIEW — claimed metadata surfaced (never trusted) + warnings
// ===========================================================================
test('reviewProposal: surfaces CLAIMED dApp metadata + requested chains/methods + warnings', () => {
  const { wc } = makeWC();
  const v = vectors.proposalReview['surfaces-metadata-and-warnings'];
  const r = wc.reviewProposal(v.proposal);
  assert.equal(r.dapp.name, v.expect.dapp.name);
  assert.equal(r.dapp.url, v.expect.dapp.url);
  assert.equal(r.dapp.description, v.expect.dapp.description);
  assert.deepEqual(r.chains.slice().sort(), v.expect.chains.slice().sort());
  for (const m of v.expect.methodsInclude) assert.ok(r.methods.includes(m), 'surfaces method ' + m);
  assert.deepEqual(codesOf(r.warnings), v.expect.warnings.slice().sort());
  assert.equal(r.severity, v.expect.severity);
});

test('reviewProposal: a denylisted dApp domain is a DANGER warning', () => {
  const { wc } = makeWC();
  const v = vectors.proposalReview['denylisted-dapp-is-danger'];
  const r = wc.reviewProposal(v.proposal);
  assert.deepEqual(codesOf(r.warnings), v.expect.warnings.slice().sort());
  assert.equal(r.severity, 'danger');
});

// ===========================================================================
// 3. APPROVAL — settled namespace = requested ∩ wallet-controlled (never fabricated)
// ===========================================================================
test('approveProposal: settles the INTERSECTION of requested ∩ wallet-controlled + supported-safe methods', async () => {
  const { wc, relay, store } = makeWC();
  const v = vectors.approval.intersection;
  const session = await wc.approveProposal(v.proposal, { accounts: v.accounts });
  const ns = session.namespaces[v.expect.namespaceKey];
  assert.ok(ns, 'eip155 namespace settled');
  assert.deepEqual(ns.chains.slice().sort(), v.expect.chains.slice().sort(), 'settled chains = intersection');
  assert.deepEqual(ns.accounts.slice().sort(), v.expect.accounts.slice().sort(), 'settled accounts');
  for (const m of v.expect.methodsInclude) assert.ok(ns.methods.includes(m), 'settles supported method ' + m);
  for (const m of v.expect.methodsExclude) assert.ok(!ns.methods.includes(m), 'drops unsafe/unsupported method ' + m);
  for (const c of v.expect.chainsExclude) assert.ok(!ns.chains.includes(c), 'never fabricates unsupported chain ' + c);
  assert.equal(session.activeChainId, v.expect.activeChainId);
  // persisted via the injected store; NO key material
  assert.ok(store.mem['wc:sessions'][session.topic], 'session persisted');
  assert.ok(!JSON.stringify(session).match(/symKey|privateKey|secret|seed/i), 'no key material in the session');
  assert.equal(relay.calls.approveProposal.length, 1, 'relay told of the settlement');
});

test('approveProposal: a REQUIRED unsupported chain is rejected fail-closed (never fabricated)', async () => {
  const { wc } = makeWC();
  const v = vectors.approval['reject-required-unsupported-chain'];
  await assert.rejects(() => wc.approveProposal(v.proposal, { accounts: v.accounts }),
    new RegExp(escapeRe(v.expectThrowMatch), 'i'));
  assert.deepEqual(await wc.listSessions(), [], 'nothing settled on a fail-closed rejection');
});

test('rejectProposal: forwards a rejection to the relay, settles nothing', async () => {
  const { wc, relay } = makeWC();
  await wc.rejectProposal(vectors.approval.intersection.proposal, { code: 4001, message: 'no' });
  assert.equal(relay.calls.rejectProposal.length, 1);
  assert.deepEqual(await wc.listSessions(), []);
});

// ===========================================================================
// 4. REQUEST ROUTING — namespace enforcement first, then the signing surface.
//    Every signing path reuses the SAME security + explicit-approval gate.
// ===========================================================================
// install the canonical settled session, then drive the request vectors.
async function withSettledSession(extra) {
  const h = makeWC(extra);
  const v = vectors.approval.intersection;
  await h.wc.approveProposal(v.proposal, { accounts: v.accounts });
  return h;
}
function reqErr(resp) { return resp && resp.error ? resp.error.code : undefined; }

test('request: an out-of-namespace CHAIN is rejected 3001 (no security gate reached)', async () => {
  const { wc } = await withSettledSession();
  const v = vectors.requests['out-of-namespace-chain'];
  const resp = await wc.handleRequest(v.request, hooks({ approve: true }).ctx);
  assert.equal(reqErr(resp), v.expectErrorCode);
});

test('request: an out-of-namespace METHOD is rejected 3001', async () => {
  const { wc } = await withSettledSession();
  const v = vectors.requests['out-of-namespace-method'];
  const resp = await wc.handleRequest(v.request, hooks({ approve: true }).ctx);
  assert.equal(reqErr(resp), v.expectErrorCode);
});

test('request: an unknown topic is rejected 4202', async () => {
  const { wc } = await withSettledSession();
  const v = vectors.requests['unknown-topic'];
  const resp = await wc.handleRequest(v.request, hooks({ approve: true }).ctx);
  assert.equal(reqErr(resp), v.expectErrorCode);
});

test('request: eth_accounts / eth_chainId are answered from session state (no prompt)', async () => {
  const { wc } = await withSettledSession();
  const seen = hooks({ approve: true });
  const a = await wc.handleRequest(vectors.requests['eth_accounts-read'].request, seen.ctx);
  assert.deepEqual(a.result, vectors.requests['eth_accounts-read'].expectResult);
  const c = await wc.handleRequest(vectors.requests['eth_chainId-read'].request, seen.ctx);
  assert.equal(c.result, vectors.requests['eth_chainId-read'].expectResult);
  assert.equal(seen.seen.approve.length, 0, 'read methods never prompt');
});

test('request: eth_sendTransaction (clean) runs the security inspect + explicit approval, then signs', async () => {
  const { wc, signer } = await withSettledSession();
  const v = vectors.requests['eth_sendTransaction-clean-approved'];
  const seen = hooks({ approve: true });
  const resp = await wc.handleRequest(v.request, seen.ctx);
  assert.ok(String(resp.result).startsWith(v.expectResultMatch), 'returns the tx hash from the signer');
  assert.equal(seen.seen.approve.length, 1, 'required an explicit approval');
  assert.equal(seen.seen.approve[0].severity, v.expectSeverity);
  assert.equal(signer.signed.length, 1, 'signed exactly once, only after approval');
});

test('request: eth_sendTransaction DANGER forces the extra confirm (fail-closed without one)', async () => {
  const v = vectors.requests['eth_sendTransaction-danger-setApprovalForAll'];

  // (a) no confirm handler wired -> BLOCKED 5000, never signs
  {
    const { wc, signer } = await withSettledSession();
    const c = v.cases['no-confirm-handler-blocks'];
    const resp = await wc.handleRequest(v.request, hooks({ approve: c.approve, confirm: c.confirm }).ctx);
    assert.equal(reqErr(resp), c.expectErrorCode);
    assert.equal(signer.signed.length, 0, 'danger w/o confirm never signs');
  }
  // (b) confirm declined -> 4001, never signs
  {
    const { wc, signer } = await withSettledSession();
    const c = v.cases['confirm-declined-rejects'];
    const resp = await wc.handleRequest(v.request, hooks({ approve: c.approve, confirm: c.confirm }).ctx);
    assert.equal(reqErr(resp), c.expectErrorCode);
    assert.equal(signer.signed.length, 0);
  }
  // (c) confirmed + approved -> signs
  {
    const { wc, signer } = await withSettledSession();
    const c = v.cases['confirmed-and-approved-signs'];
    const seen = hooks({ approve: c.approve, confirm: c.confirm });
    const resp = await wc.handleRequest(v.request, seen.ctx);
    assert.ok(String(resp.result).startsWith(c.expectResultMatch));
    assert.equal(seen.seen.confirm.length, 1, 'the human WAS asked to confirm the danger');
    assert.equal(seen.seen.approve[0].severity, 'danger');
    assert.equal(signer.signed.length, 1);
  }
});

test('request: a declined approval returns the user-rejected error 4001 (never signs)', async () => {
  const { wc, signer } = await withSettledSession();
  const v = vectors.requests['eth_sendTransaction-declined-approval'];
  const resp = await wc.handleRequest(v.request, hooks({ approve: false }).ctx);
  assert.equal(reqErr(resp), v.expectErrorCode);
  assert.equal(signer.signed.length, 0);
});

test('request: an external dApp signing request can NEVER auto-approve (no approve handler => fail-closed)', async () => {
  const { wc, signer } = await withSettledSession();
  const v = vectors.requests['eth_sendTransaction-clean-approved'];
  // ctx carries NO approve handler at all
  const resp = await wc.handleRequest(v.request, { security: {} });
  assert.equal(reqErr(resp), WC.ERR.BLOCKED, 'fail-closed, not a silent sign');
  assert.equal(signer.signed.length, 0);
});

test('request: eth_signTypedData_v4 Permit with an UNLIMITED allowance is DANGER', async () => {
  const { wc, signer } = await withSettledSession();
  const v = vectors.requests['eth_signTypedData_v4-permit-unlimited-danger'];
  const seen = hooks({ approve: v.approve, confirm: v.confirm });
  const resp = await wc.handleRequest(v.request, seen.ctx);
  const pres = seen.seen.approve[0];
  assert.equal(pres.severity, v.expectSeverity);
  const codes = codesOf(pres.decoded.warnings);
  for (const c of v.expectWarningsInclude) assert.ok(codes.includes(c), 'detects ' + c);
  assert.ok(String(resp.result).startsWith(v.expectResultMatch));
  assert.equal(seen.seen.confirm.length, 1, 'danger permit forced a confirm');
  assert.equal(signer.signed[0].m, 'ethSignTypedData');
});

test('request: eth_signTypedData_v4 a SIZED Permit with a short deadline is NOT danger', async () => {
  const { wc } = await withSettledSession();
  const v = vectors.requests['eth_signTypedData_v4-permit-sized-ok'];
  const seen = hooks({ approve: true });
  const resp = await wc.handleRequest(v.request, seen.ctx);
  const pres = seen.seen.approve[0];
  assert.notEqual(pres.severity, 'danger');
  const codes = codesOf(pres.decoded.warnings);
  for (const c of v.expectWarningsInclude) assert.ok(codes.includes(c), 'still flags ' + c);
  assert.ok(String(resp.result).startsWith(v.expectResultMatch));
});

test('request: eth_sign is REFUSED by default with an explanatory error (4100)', async () => {
  const { wc, signer } = await withSettledSession();
  const v = vectors.requests['eth_sign-refused'];
  const resp = await wc.handleRequest(v.request, hooks({ approve: true }).ctx);
  assert.equal(reqErr(resp), v.expectErrorCode);
  assert.match(resp.error.message, new RegExp(escapeRe(v.expectErrorMatch), 'i'));
  assert.equal(signer.signed.length, 0, 'never blind-signs');
});

test('request: personal_sign decodes the UTF-8 message and signs on approval', async () => {
  const { wc, signer } = await withSettledSession();
  const v = vectors.requests['personal_sign-decodes-message'];
  const seen = hooks({ approve: true });
  const resp = await wc.handleRequest(v.request, seen.ctx);
  assert.equal(seen.seen.approve[0].decoded.text, v.expectDecodedText, 'decodes the hex message to UTF-8');
  assert.ok(String(resp.result).startsWith(v.expectResultMatch));
  assert.equal(signer.signed[0].m, 'personalSign');
});

// ===========================================================================
// 5. EXPIRY + sessions
// ===========================================================================
test('request: a request on an EXPIRED session is rejected (4201)', async () => {
  const v = vectors.expiry['expired-session-rejected'];
  const { wc, store, signer } = makeWC();
  // seed the expired session directly into the store (persisted shape)
  store.mem['wc:sessions'] = { [v.session.topic]: v.session };
  const resp = await wc.handleRequest(v.request, hooks({ approve: true }).ctx);
  assert.equal(reqErr(resp), v.expectErrorCode);
  assert.equal(signer.signed.length, 0, 'an expired session never signs');
});

test('sessions: list / get / disconnect round-trip via the injected store', async () => {
  const { wc, relay } = await withSettledSession();
  const topic = vectors.approval.intersection.proposal.sessionTopic;
  const list = await wc.listSessions();
  assert.equal(list.length, 1);
  const got = await wc.getSession(topic);
  assert.equal(got.topic, topic);
  const d = await wc.disconnect(topic, { code: 6000, message: 'user disconnected' });
  assert.equal(d.disconnected, true);
  assert.equal(relay.calls.disconnect.length, 1);
  assert.equal((await wc.listSessions()).length, 0);
  assert.equal(await wc.getSession(topic), null);
});

test('sessions: switching to an approved chain updates activeChainId (and is prompted)', async () => {
  const { wc } = await withSettledSession();
  const seen = hooks({ approve: true });
  const resp = await wc.handleRequest(
    { id: 30, topic: 'sess-abc', chainId: 'eip155:1', method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] },
    seen.ctx);
  assert.equal(resp.result, null, 'switch returns null on success');
  assert.equal(seen.seen.approve.length, 1, 'a chain switch is still prompted, never silent');
  const got = await wc.getSession('sess-abc');
  assert.equal(got.activeChainId, 'eip155:8453');
});

test('sessions: refusing to switch/add a chain the wallet does not have (4203)', async () => {
  const { wc } = await withSettledSession();
  const resp = await wc.handleRequest(
    { id: 31, topic: 'sess-abc', chainId: 'eip155:1', method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] },
    hooks({ approve: true }).ctx);
  assert.equal(reqErr(resp), WC.ERR.UNSUPPORTED_CHAIN);
});

// ===========================================================================
// config toggle: eth_sign can be explicitly allowed (off by default)
// ===========================================================================
test('config: allowEthSign=true lets eth_sign through the normal gate (opt-in only)', async () => {
  const { wc } = await withSettledSession({ config: { allowEthSign: true } });
  // with it enabled, eth_sign is no longer the hard 4100 refusal; it must still
  // be in the approved namespace to route. It is NOT (dApp didn't request it),
  // so it falls to the namespace gate (3001) — proving the refusal is config-gated.
  const resp = await wc.handleRequest(vectors.requests['eth_sign-refused'].request, hooks({ approve: true }).ctx);
  assert.notEqual(reqErr(resp), WC.ERR.ETH_SIGN_DISABLED, 'no longer a hard refusal when opted in');
  assert.equal(reqErr(resp), WC.ERR.UNAUTHORIZED, 'still namespace-gated');
});

// ===========================================================================
// relay glue: connectRelay routes an incoming relay request through handleRequest
// ===========================================================================
test('connectRelay: an incoming relay request is routed through the same gate + responded', async () => {
  const { wc, relay, signer } = await withSettledSession();
  const seen = hooks({ approve: true });
  wc.connectRelay(seen.ctx);
  await relay._emit(vectors.requests['eth_sendTransaction-clean-approved'].request);
  assert.equal(relay.calls.respond.length, 1, 'responded via the relay');
  assert.ok(String(relay.calls.respond[0].response.result).startsWith('0xhash'));
  assert.equal(signer.signed.length, 1);
});

// ---- helpers ----
function codesOf(ws) { return (ws || []).map((w) => w.code).sort(); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
