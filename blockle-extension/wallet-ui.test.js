// wallet-ui.test.js — DOM-level tests for the native wallet UI controller
// (wallet-ui.js). Uses a MINIMAL fake document (no jsdom) like the other *-ui
// tests, plus pure-helper tests for the pieces that carry the safety + wiring
// contract:
//
//   • sheetConfigFor restates the decoded preview + warnings by severity + the
//     "N checks ran / M skipped; nothing claims safe" line, and flags DANGER so
//     the shared confirm sheet forces the explicit "understand the risk" confirm.
//   • holdingRowHtml shows an UNPRICED holding (shown, NOT counted) vs a priced one.
//   • activityRowHtml surfaces the security decoder label + the flagged counterparty.
//   • nftTileHtml renders spam / metadata-unavailable / operator-approval badges.
//   • resolvedLineHtml shows the resolved address + its source (ENS/SNS/book/raw).
//   • openSecuritySheet renders the forced-confirm button only when danger.
//   • enter() renders the five-surface shell + the PORTFOLIO hero off the REAL
//     WalletPortfolio engine (net worth counts only priced holdings), and the
//     locked state shows the unlock notice and builds no engine.
//
//   node --test   (and `node wallet-ui.test.js` directly)

const { test } = require('node:test');
const assert = require('node:assert');

const WalletUI = require('./wallet-ui.js');
const WalletPortfolio = require('./portfolio.js');

// ---------------------------------------------------------------------------
// sheetConfigFor — the shared security confirm sheet config (send + dApp)
// ---------------------------------------------------------------------------
test('sheetConfigFor: a DANGER WC presentation forces the explicit confirm', () => {
  const presentation = {
    method: 'eth_sendTransaction',
    dapp: { name: 'Uniswap', url: 'app.uniswap.org' },
    severity: 'danger',
    warnings: [{ code: 'known-drainer', severity: 'danger', message: 'Target is on the denylist.' }],
    inspection: {
      summary: 'Send 1 ETH to 0xbad',
      details: [{ label: 'To', value: '0xbadC0ffee0000000000000000000000000000001' }, { label: 'Amount', value: '1000000000000000000' }],
      checks: { ran: ['send-to-flagged', 'new-address'], skipped: [{ code: 'large-share', reason: 'no balance' }] },
    },
  };
  const cfg = WalletUI.sheetConfigFor(presentation);
  assert.equal(cfg.danger, true, 'danger severity sets the forced-confirm flag');
  assert.ok(/Uniswap/.test(cfg.dapp) && /app\.uniswap\.org/.test(cfg.dapp), 'dApp identity is surfaced');
  assert.ok(cfg.warnings.length === 1 && cfg.warnings[0].sev === 'danger', 'warning carried with its severity');
  assert.ok(/2 checks ran · 1 skipped/.test(cfg.checks), 'checks line counts ran + skipped');
  assert.ok(/claims this address is safe/.test(cfg.checks), 'never claims safe');
  assert.ok(cfg.rows.some((r) => r[0] === 'To'), 'decoded preview rows carried');
});

test('sheetConfigFor: a clean send inspection is not danger', () => {
  const inspection = {
    kind: 'native-transfer', severity: 'info',
    summary: 'Send 0.5 ETH', details: [{ label: 'Amount', value: '500000000000000000' }],
    warnings: [{ code: 'new-address', severity: 'info', message: 'First time sending here.' }],
    checks: { ran: ['send-to-flagged'], skipped: [] },
  };
  const cfg = WalletUI.sheetConfigFor(inspection, { title: 'Review send' });
  assert.equal(cfg.danger, false);
  assert.equal(cfg.title, 'Review send');
  assert.ok(/1 check ran · 0 skipped/.test(cfg.checks));
});

test('sheetConfigFor: a signature (no checks object) still disclaims safety', () => {
  const decoded = { kind: 'personal-sign', severity: 'none', details: [{ label: 'Message', value: 'hello' }], warnings: [] };
  const cfg = WalletUI.sheetConfigFor({ method: 'personal_sign', decoded });
  assert.ok(/signature, not a transfer/.test(cfg.checks));
  assert.equal(cfg.danger, false);
});

// ---------------------------------------------------------------------------
// holdingRowHtml — priced vs UNPRICED (shown, not counted)
// ---------------------------------------------------------------------------
test('holdingRowHtml: priced holding shows a USD quote, unpriced shows the tag', () => {
  const priced = WalletUI.holdingRowHtml({ symbol: 'ETH', chain: 'ethereum', amountBase: '2000000000000000000', decimals: 18, pricedOk: true, usd: 6000 });
  assert.ok(/\$6,000\.00/.test(priced), 'priced row shows the USD quote');
  assert.ok(!/UNPRICED/.test(priced));
  const unpriced = WalletUI.holdingRowHtml({ symbol: 'MYST', chain: 'base', amountBase: '15000000000000000000000', decimals: 18, pricedOk: false, usd: null });
  assert.ok(/UNPRICED/.test(unpriced), 'unpriced row shows the UNPRICED tag (not counted)');
});

// ---------------------------------------------------------------------------
// holdingRowHtml — the row CALLS the Logos resolver for real per-chain/token icons
// ---------------------------------------------------------------------------
test('holdingRowHtml: calls the Logos resolver (chain icon for native, logoURI for a token)', () => {
  const Logos = require('./logos.js');
  const calls = { resolve: [], chainIcon: [] };
  // spy wrapper installed as the global the UI's dep() resolves first
  global.Logos = Object.assign({}, Logos, {
    resolve: (a) => { calls.resolve.push(a); return Logos.resolve(a); },
    chainIcon: (id) => { calls.chainIcon.push(id); return Logos.chainIcon(id); },
  });
  try {
    // native ETH -> the bundled brand chain icon (no text badge)
    const nativeRow = WalletUI.holdingRowHtml({ symbol: 'ETH', chain: 'ethereum', amountBase: '1000000000000000000', decimals: 18, pricedOk: true, usd: 3000, asset: { symbol: 'ETH', kind: 'native' } });
    assert.ok(calls.resolve.length >= 1, 'holdingRowHtml routed the asset through Logos.resolve');
    assert.ok(calls.chainIcon.some((id) => id === 'ethereum'), 'the chain badge came from Logos.chainIcon');
    assert.ok(/<img[^>]+wtoken-img/.test(nativeRow), 'renders a real icon <img>, not a text badge');
    assert.ok(!/>ET<\/span>/.test(nativeRow), 'no longer the old 2-letter TOKEN_BG badge');

    // a token WITH a metadata logoURI -> an <img> pointing at that URI
    const tokenRow = WalletUI.holdingRowHtml({ symbol: 'USDC', chain: 'base', amountBase: '5000000', decimals: 6, pricedOk: true, usd: 5, asset: { symbol: 'USDC', kind: 'token', contract: '0xusdc', logoURI: 'https://logos.example/usdc.png' } });
    assert.ok(/https:\/\/logos\.example\/usdc\.png/.test(tokenRow), 'token row uses the metadata logoURI');
    // CSP-safe fallback: MV3 blocks inline onerror=, so a broken remote logo
    // degrades to its monogram via a data-fallback data: URI + a capturing error listener.
    assert.ok(/data-fallback="data:/.test(tokenRow), 'a broken remote logo falls back to the monogram (CSP-safe, never a broken image)');
  } finally {
    delete global.Logos;
  }
});

// ---------------------------------------------------------------------------
// activityRowHtml — security label + flagged counterparty inline
// ---------------------------------------------------------------------------
test('activityRowHtml: shows the decoder summary, severity badge and flag', () => {
  const html = WalletUI.activityRowHtml({
    chain: 'ethereum', kind: 'approval', direction: 'out',
    summary: 'Approve 0x3f… to spend UNLIMITED USDC',
    severity: 'danger', flagged: true, counterparty: '0x3f90000000000000000000000000000000000abc',
    asset: { symbol: 'USDC', decimals: 6 },
  });
  assert.ok(/Approve 0x3f/.test(html), 'uses the security decoder summary as the label');
  assert.ok(/wsev danger/.test(html), 'renders the severity badge');
  assert.ok(/flagged/.test(html), 'flags the counterparty inline');
});

// ---------------------------------------------------------------------------
// nftTileHtml — spam / metadata-unavailable / operator-approval
// ---------------------------------------------------------------------------
test('nftTileHtml: spam flag, metadata-unavailable tile, operator-approval badge', () => {
  const spam = WalletUI.nftTileHtml({ chain: 'ethereum', contract: '0x1', name: 'CLAIM 5 ETH', collection: 'reward.xyz', spam: true, metadataOk: true });
  assert.ok(/SPAM\?/.test(spam), 'suspected-spam collection is flagged, not hidden');

  const unavailable = WalletUI.nftTileHtml({ chain: 'ethereum', contract: '0x2', tokenId: '9', metadataOk: false });
  assert.ok(/metadata unavailable/.test(unavailable), 'metadata-unavailable tile, never invented');

  const op = { operator: '0xop', collection: '0x3' };
  const withApproval = WalletUI.nftTileHtml({ chain: 'ethereum', contract: '0x3', name: 'Degen #77', collection: 'Degen', metadataOk: true }, op);
  assert.ok(/APPROVAL/.test(withApproval), 'open operator approval gets a badge');
  assert.ok(/data-revoke="0x3"/.test(withApproval), 'the badge is wired to revoke this collection');
});

// ---------------------------------------------------------------------------
// resolvedLineHtml — the resolved-address confirmation (anti-spoofing)
// ---------------------------------------------------------------------------
test('resolvedLineHtml: shows the resolved address + its source', () => {
  const ens = WalletUI.resolvedLineHtml({ address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', source: 'ens', name: 'vitalik.eth' });
  assert.ok(/vitalik\.eth resolves to/.test(ens) && /ENS/.test(ens));
  const raw = WalletUI.resolvedLineHtml({ address: '0xabc0000000000000000000000000000000000001', source: 'raw' });
  assert.ok(/address/.test(raw));
});

// ---------------------------------------------------------------------------
// DOM-level: a MINIMAL fake document
// ---------------------------------------------------------------------------
function installFakeDom() {
  const store = new Map();
  function El() { this.innerHTML = ''; this.textContent = ''; this.hidden = false; this.className = ''; this.value = ''; this.dataset = {}; this._attr = {}; }
  El.prototype.addEventListener = function () {};
  El.prototype.setAttribute = function (k, v) { this._attr[k] = v; };
  El.prototype.getAttribute = function (k) { return this._attr[k] != null ? this._attr[k] : null; };
  El.prototype.querySelector = function () { return new El(); };
  El.prototype.querySelectorAll = function () { return []; };
  // NB: no getContext -> the canvas-fit helper short-circuits (no drawing in tests)
  const doc = {
    documentElement: new El(),
    querySelector(sel) { if (!store.has(sel)) store.set(sel, new El()); return store.get(sel); },
    querySelectorAll() { return []; },
  };
  global.document = doc;
  global.getComputedStyle = function () { return { getPropertyValue: function () { return ''; } }; };
  return { doc, store };
}
function stubUI() { return { show() {}, toast() {}, route() {} }; }

test('openSecuritySheet: renders the forced-confirm button only when danger', () => {
  const { store } = installFakeDom();
  WalletUI.init(stubUI());
  WalletUI.openSecuritySheet({ title: 'Review', rows: [['To', '0xabc']], warnings: [{ sev: 'danger', t: 'Known drainer', d: 'on the denylist' }], checks: '1 check ran', danger: true });
  const sheet = store.get('#wallet-sheet');
  assert.ok(/I understand the risk/.test(sheet.innerHTML), 'a danger forces the explicit confirm button');
  assert.ok(/Known drainer/.test(sheet.innerHTML), 'warnings are shown by severity');

  WalletUI.openSecuritySheet({ title: 'Review', rows: [], warnings: [], checks: 'ok', danger: false });
  const sheet2 = store.get('#wallet-sheet');
  assert.ok(!/I understand the risk/.test(sheet2.innerHTML) && /Approve/.test(sheet2.innerHTML), 'a clean review uses a plain Approve');
});

test('enter(): LOCKED wallet shows the unlock notice and builds no engine', async () => {
  const { store } = installFakeDom();
  global.Wallet = { isUnlocked: () => false };
  WalletUI._setEngine(null);
  WalletUI.init(stubUI());
  await WalletUI.enter();
  const body = store.get('#wallet-body');
  assert.ok(/Unlock your wallet/i.test(body.innerHTML), 'locked state renders the unlock notice');
});

test('enter(): UNLOCKED renders the 5-surface shell + a net worth that counts only priced holdings', async () => {
  const { store } = installFakeDom();
  global.Wallet = { isUnlocked: () => true };
  const mem = {};
  global.Store = { async get(keys) { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => (o[k] = mem[k])); return o; }, async set(obj) { Object.assign(mem, obj); } };

  const holdings = {
    ethereum: [
      { asset: { symbol: 'ETH', decimals: 18, kind: 'native' }, confirmed: '2000000000000000000' },     // 2 ETH @ $3000
      { asset: { symbol: 'MYST', decimals: 18 }, confirmed: '15000000000000000000000' },               // unpriced
    ],
    solana: [{ asset: { symbol: 'SOL', decimals: 9, kind: 'native' }, confirmed: '10000000000' }],      // 10 SOL @ $150
  };
  const prices = { ETH: 3000, SOL: 150 };

  // inject the REAL-engine seam, but with the REAL WalletPortfolio engine + fake
  // read-only data sources (no network, no mock money path).
  WalletUI._setEngine({
    accounts: [{ chain: 'ethereum', address: '0xabc' }, { chain: 'solana', address: 'So111' }],
    WP: WalletPortfolio,
    portfolioCtx: {
      getHoldings: async (chain) => holdings[chain] || [],
      priceUsd: async (asset) => (prices[String(asset.symbol).toUpperCase()] != null ? prices[String(asset.symbol).toUpperCase()] : null),
      asOf: Date.now(),
    },
  });
  WalletUI.init(stubUI());
  await WalletUI.enter();

  const body = store.get('#wallet-body');
  assert.ok(/Portfolio/.test(body.innerHTML) && /Activity/.test(body.innerHTML) && /NFTs/.test(body.innerHTML) &&
    /Connect/.test(body.innerHTML) && /Address book/.test(body.innerHTML), 'all five surfaces are tabbed');

  const panel = store.get('#wallet-panel');
  assert.ok(/\$7,500\.00/.test(panel.innerHTML), 'net worth = 2 ETH*$3000 + 10 SOL*$150 = $7,500 (MYST unpriced, not counted)');
  assert.ok(/UNPRICED/.test(panel.innerHTML), 'the unpriced holding is shown, not counted');
  assert.ok(/ethereum/.test(panel.innerHTML) && /solana/.test(panel.innerHTML), 'by-chain breakdown lists both chains');
  assert.ok(/not counted in net worth/.test(panel.innerHTML), 'the shown-not-counted note is present');

  WalletUI._setEngine(null);
});
