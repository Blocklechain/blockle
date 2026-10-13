// export-ui.test.js — the UI/integration wiring test proving the Settings
// "Export keys & seed" action is REACHABLE and runs WalletExport.exportSecrets
// THROUGH the security gate (vault unlocked + an explicit danger confirm), and
// presents the mnemonic/seed + per-chain keys + downloadable BTC/LTC/DOGE Core
// dumps. It also asserts the gate fails closed (locked / declined) with NO panel.
//
//   node --test   (and `node export-ui.test.js` directly)

const { test } = require('node:test');
const assert = require('node:assert');

const WalletExportUI = require('./export-ui.js');
const WalletExport = require('./wallet-export.js');

// a real 32-byte HD seed (hex) — exportSecrets derives real keys + dumps from it
const SEED_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function fakeWallet(unlocked) {
  return { isUnlocked: () => !!unlocked, seedHex: SEED_HEX, address: 'block1exampleaddr', publicKeyHex: null };
}
// a minimal fake DOM container that captures the dump-download button wiring
function fakeContainer() {
  const btns = [];
  for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
    btns.push({
      _c: c, _h: null,
      getAttribute(k) { return k === 'data-dump' ? this._c : null; },
      addEventListener(ev, h) { if (ev === 'click') this._h = h; },
      click() { if (this._h) this._h(); },
    });
  }
  return { querySelectorAll() { return btns; }, _btns: btns };
}

test('export action: reachable + runs exportSecrets THROUGH the gate (unlock + explicit confirm)', async () => {
  let sawWarning = null;
  let presented = null;
  const downloads = [];
  const container = fakeContainer();

  const res = await WalletExportUI.open({
    wallet: fakeWallet(true),
    // the explicit danger confirm — the gate passes ONLY because this resolves true
    confirm: async (warning) => { sawWarning = warning; return true; },
    present: (html, r) => { presented = { html, r }; return container; },
    download: (filename, text) => downloads.push({ filename, text }),
  });

  // the gate's danger warning was surfaced to the confirm (not bypassed)
  assert.equal(sawWarning, WalletExport.DANGER_WARNING, 'the explicit confirm received the DANGER warning');
  assert.ok(res && res.ok, 'export ran and returned material');

  // seed + per-chain WIF/hex/base58 came back
  assert.ok(res.keys && res.keys.bitcoin && res.keys.bitcoin.wif, 'per-chain BTC WIF present');
  assert.ok(res.keys.evm.privateKey.startsWith('0x'), 'EVM 0x-hex private key present');
  assert.ok(res.keys.solana.secretKey, 'Solana base58 secret key present');

  // BTC/LTC/DOGE Bitcoin-Core importwallet dumps present
  assert.ok(res.dumps.bitcoin.text.includes('# Wallet dump'), 'BTC Core dump produced');
  assert.equal(res.dumps.bitcoin.filename, 'bitcoin-blockle-import.txt');

  // the panel was presented and carries the secrets
  assert.ok(presented, 'the result panel was presented');
  assert.ok(presented.html.includes(res.keys.bitcoin.wif), 'panel shows the BTC WIF');
  assert.ok(/DANGER/.test(presented.html), 'panel restates the danger warning');

  // the dump-download buttons are wired to the real dump text
  container._btns[0].click();
  assert.equal(downloads.length, 1, 'clicking a dump button triggers a download');
  assert.equal(downloads[0].filename, 'bitcoin-blockle-import.txt');
  assert.ok(downloads[0].text.includes('# Wallet dump'));
});

test('export action: LOCKED vault fails closed — no secrets, no panel', async () => {
  let presented = false;
  let confirmed = false;
  const res = await WalletExportUI.open({
    wallet: fakeWallet(false),
    confirm: async () => { confirmed = true; return true; },
    present: () => { presented = true; return null; },
  });
  assert.ok(res && res.ok === false, 'blocked when locked');
  assert.equal(res.reason, 'locked');
  assert.equal(confirmed, false, 'confirm is never even reached while locked');
  assert.equal(presented, false, 'no panel rendered when the gate blocks');
});

test('export action: a DECLINED confirm blocks — no secrets, no panel', async () => {
  let presented = false;
  const res = await WalletExportUI.open({
    wallet: fakeWallet(true),
    confirm: async () => false, // user declines the danger confirm
    present: () => { presented = true; return null; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'declined');
  assert.equal(presented, false, 'declining the danger confirm renders nothing');
});

test('export action: a missing confirm handler fails closed (no-confirm-handler)', async () => {
  const res = await WalletExportUI.open({ wallet: fakeWallet(true), present: () => null });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-confirm-handler');
});
