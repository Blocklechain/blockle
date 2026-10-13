// export-ui.js — WIRES the gated key/seed/dump export (wallet-export.js) into the
// popup UI. This is the thin UI seam the Settings "Export keys & seed" action
// calls: it supplies the security gate's inputs (vault UNLOCKED + an explicit
// confirm that surfaces the plain-language DANGER warning), then turns the result
// into a rendered panel + downloadable Bitcoin-Core `importwallet` dumps for
// BTC/LTC/DOGE.
//
// It changes NEITHER the export module's logic NOR its security gate — the gate
// lives inside WalletExport.exportSecrets and this module only feeds it `unlocked`
// + `confirm` and renders what comes back. It holds NO keys and contains ZERO
// network/logging; secret material comes straight from exportSecrets and is only
// shown / offered for download here. When the gate blocks (locked / declined /
// no confirm) exportSecrets returns { ok:false, reason } and nothing is rendered.
//
// Global `WalletExportUI`; module.exports for the node test.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  function dep(name, file) {
    if (global[name]) return global[name];
    if (inNode) { try { return require(file); } catch (_) {} }
    return null;
  }
  const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); };

  // The optional BLOCK native (ML-DSA) session, only when the wallet exposes its
  // secret — otherwise omitted (seed-derived chains + Core dumps still export).
  function blockSessionFor(wallet) {
    if (!wallet) return null;
    const secret = wallet.secretKeyHex || wallet.secretHex || wallet.privateKeyHex || null;
    const pub = wallet.publicKeyHex || wallet.publicHex || null;
    if (!secret || !pub) return null;
    return { secretKeyHex: secret, publicKeyHex: pub, address: wallet.address };
  }

  // Run the gated export. `deps`:
  //   wallet   — unlocked Wallet (isUnlocked()/seedHex/publicKeyHex/address)
  //   exporter — WalletExport (defaults to the global/module)
  //   confirm  — async (warning) => bool : the explicit danger confirm (REQUIRED
  //              for the gate to pass; this module never bypasses it)
  //   index    — account index (default 0)
  // Returns the WalletExport.exportSecrets result; { ok:false, reason, warning }
  // when the gate blocks.
  async function run(deps) {
    deps = deps || {};
    const wallet = deps.wallet || dep('Wallet', './wallet.js');
    const exporter = deps.exporter || dep('WalletExport', './wallet-export.js');
    if (!exporter) return { ok: false, reason: 'no-exporter' };
    return exporter.exportSecrets({
      unlocked: !!(wallet && wallet.isUnlocked && wallet.isUnlocked()),
      confirm: deps.confirm,
      seed: wallet && wallet.seedHex,
      coreDumps: true,
      blockSession: blockSessionFor(wallet),
      index: deps.index || 0,
    });
  }

  // Pure: the result panel markup (mnemonic + seed hex, per-chain WIF/hex/base58,
  // and a download button per BTC/LTC/DOGE Core dump). Secrets are rendered for
  // the user to copy/save; nothing is logged or sent.
  function resultHtml(res) {
    if (!res || !res.ok) return '<div class="wnote">Export unavailable.</div>';
    const rows = [];
    if (res.mnemonic) {
      rows.push(secretRow('Recovery phrase', res.mnemonic.mnemonic));
      if (res.mnemonic.passphrase) rows.push(secretRow('Passphrase', res.mnemonic.passphrase));
      rows.push(secretRow('Seed (hex)', res.mnemonic.seedHex));
    }
    const k = res.keys || {};
    if (k.bitcoin) rows.push(secretRow('Bitcoin WIF', k.bitcoin.wif, k.bitcoin.address));
    if (k.litecoin) rows.push(secretRow('Litecoin WIF', k.litecoin.wif, k.litecoin.address));
    if (k.dogecoin) rows.push(secretRow('Dogecoin WIF', k.dogecoin.wif, k.dogecoin.address));
    if (k.evm) rows.push(secretRow('EVM private key', k.evm.privateKey, k.evm.address));
    if (k.solana) rows.push(secretRow('Solana secret key', k.solana.secretKey, k.solana.address));
    if (res.block) rows.push(secretRow('BLOCK (ML-DSA) secret key', res.block.secretKey, res.block.address));
    const dumps = res.dumps || {};
    const dumpBtns = ['bitcoin', 'litecoin', 'dogecoin'].filter(function (c) { return dumps[c]; }).map(function (c) {
      return '<button class="btn ghost wexp-dl" data-dump="' + c + '">Download ' + esc(c) + ' wallet.dat (importwallet)</button>';
    }).join('');
    return '<div class="wexp">' +
      '<div class="wwarn danger"><div class="t">DANGER</div><div class="d">' + esc(WalletExportModule().DANGER_WARNING) + '</div></div>' +
      '<div class="wexp-secrets">' + rows.join('') + '</div>' +
      (dumpBtns ? '<div class="wexp-dumps"><div class="wexp-dh">Bitcoin-Core <span class="mono">importwallet</span> dumps</div><div class="row-btns">' + dumpBtns + '</div></div>' : '') +
      '</div>';
  }
  function secretRow(label, value, addr) {
    return '<div class="wexp-row"><div class="wexp-k">' + esc(label) + (addr ? ' <span class="wexp-a mono">' + esc(addr) + '</span>' : '') + '</div>' +
      '<div class="wexp-v mono">' + esc(value) + '</div></div>';
  }
  function WalletExportModule() { return dep('WalletExport', './wallet-export.js') || { DANGER_WARNING: '' }; }

  // Orchestrate the whole Settings action: run the gated export, and on success
  // render the panel + wire the Core-dump download buttons. `deps` adds to run()'s:
  //   present(html, res) — show the result panel; returns the container element
  //   download(filename, text) — save a dump file
  //   onBlocked(res) — called when the gate blocks (locked/declined)
  async function open(deps) {
    deps = deps || {};
    const res = await run(deps);
    if (!res || !res.ok) { if (deps.onBlocked) deps.onBlocked(res || { ok: false, reason: 'error' }); return res; }
    const html = resultHtml(res);
    let container = null;
    if (typeof deps.present === 'function') container = deps.present(html, res);
    if (container && typeof container.querySelectorAll === 'function' && typeof deps.download === 'function') {
      const btns = container.querySelectorAll('.wexp-dl');
      Array.prototype.forEach.call(btns, function (b) {
        b.addEventListener('click', function () {
          const c = b.getAttribute('data-dump');
          const d = res.dumps && res.dumps[c];
          if (d) deps.download(d.filename, d.text);
        });
      });
    }
    return res;
  }

  const API = { run, open, resultHtml, blockSessionFor };
  global.WalletExportUI = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
