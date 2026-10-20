// wallet-export.js — WALLET EXPORT (docs/WALLET-EXPORT.md). The REFERENCE
// implementation; the Dart + Python wallets reproduce docs/wallet-export-vectors.json.
//
// Lets the user export everything needed to recover funds elsewhere, BEHIND THE
// SECURITY GATE (vault unlocked + an explicit confirm with a plain-language
// danger warning):
//
//   1. the BIP-39 mnemonic (+ passphrase) and the raw seed hex,
//   2. per-chain private keys for the active account:
//        • UTXO (BTC/LTC/DOGE): WIF, chain-correct version byte (BTC 0x80,
//          LTC 0xb0, DOGE 0x9e),
//        • EVM: 0x-hex private key,
//        • Solana: base58 secret key (64-byte seed||pubkey, Phantom-style),
//        • BLOCK: the native ML-DSA key from the Wallet session (where applicable),
//   3. a Bitcoin-Core `importwallet`-format dump file for BTC/LTC/DOGE — the
//      "# Wallet dump" header + per-key lines Core ingests via `importwallet`
//      to rebuild its wallet.dat.
//
// SAFETY: export is READ-ONLY key material. It NEVER moves funds, NEVER touches
// the network, is NEVER logged and is NEVER placed in any agent / telemetry /
// gateway payload. This module contains ZERO network and ZERO logging calls by
// construction. Every path is blocked while the vault is locked and on a
// declined confirm.
//
// Global `WalletExport`; module.exports for the node tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('./crypto-core.js') : global.BLKCrypto;
  const Addr = inNode ? require('./address.js') : global.Addr;
  const HD = inNode ? require('./hd.js') : global.HD;
  const ED = inNode ? require('./ed25519.js') : global.Ed25519;
  const Utxo = inNode ? require('./chains/utxo.js') : global.UtxoAdapter;
  const Solana = inNode ? require('./chains/solana.js') : global.SolanaAdapter;

  // The derivation paths MUST match the live adapters exactly (chains/evm.js,
  // chains/solana.js, chains/utxo.js) so an exported key controls the same
  // address the wallet shows.
  const EVM_PATH = "m/44'/60'/0'/0";       // chains/evm.js
  const SOL_PATH = "m/44'/501'/0'/0'";     // chains/solana.js (SLIP-0010, hardened)

  // Plain-language danger warning the confirm MUST surface before any export.
  const DANGER_WARNING =
    'DANGER — these secrets give FULL, IRREVERSIBLE control of your funds. ' +
    'Anyone who sees your recovery phrase or a private key can take everything. ' +
    'Never share them, never type them into a website or chat, and never send ' +
    'them to anyone — Blockle support will NEVER ask for them. Only save them ' +
    'somewhere private and offline.';

  function toSeed(seed) {
    if (!seed) throw new Error('no seed');
    if (seed instanceof Uint8Array) return seed;
    if (seed.seed) return toSeed(seed.seed);
    if (typeof seed === 'string') return C.hexToBytes(seed);
    return C.toBytes(seed);
  }

  // ---- 1. mnemonic + seed hex ----------------------------------------------
  // The mnemonic is NOT recoverable from the seed, so the caller supplies it
  // (it lives in the vault). Returns the seed too, so the key derivations can
  // reuse it without re-running PBKDF2.
  function fromMnemonic(mnemonic, passphrase) {
    const seed = HD.mnemonicToSeed(mnemonic, passphrase || '');
    return { mnemonic, passphrase: passphrase || '', seedHex: C.bytesToHex(seed), seed };
  }

  // ---- 2. per-chain private keys -------------------------------------------
  function utxoNet(chainId) {
    const net = Utxo.NETWORKS[chainId];
    if (!net) throw new Error('not a UTXO chain: ' + chainId);
    return net;
  }
  function utxoAddress(net, node) {
    return net.segwit ? Addr.p2wpkh(node.publicKey, net.hrp) : Addr.p2pkh(node.publicKey, net.p2pkh);
  }
  function utxoKey(chainId, seed, index) {
    index = index || 0;
    const net = utxoNet(chainId);
    const path = net.path + '/' + index;
    const node = HD.derivePath(toSeed(seed), path);
    return {
      chain: chainId, index, path,
      address: utxoAddress(net, node),
      wif: Addr.toWIF(node.privateKey, net.wif, true),
      wifVersion: net.wif,
      publicKey: C.bytesToHex(node.publicKey),
    };
  }
  function evmKey(seed, index) {
    index = index || 0;
    const path = EVM_PATH + '/' + index;
    const node = HD.derivePath(toSeed(seed), path);
    return {
      chain: 'evm', index, path,
      address: Addr.evmAddress(node.publicKey),
      privateKey: '0x' + C.bytesToHex(node.privateKey),
      publicKey: C.bytesToHex(node.publicKey),
    };
  }
  function solPathForIndex(index) {
    return index ? SOL_PATH.replace(/\/0'$/, '/' + index + "'") : SOL_PATH;
  }
  function solanaKey(seed, index) {
    index = index || 0;
    const path = solPathForIndex(index);
    const node = Solana.deriveSlip10(toSeed(seed), path);
    const pub = ED.publicKey(node.key);
    // Phantom/Solana-CLI "secret key" = base58(32-byte seed || 32-byte pubkey).
    const secret = C.concatBytes(node.key, pub);
    return {
      chain: 'solana', index, path,
      address: C.base58encode(pub),
      secretKey: C.base58encode(secret),
      publicKey: C.bytesToHex(pub),
    };
  }

  // BLOCK is NOT HD-derived — its ML-DSA-44 keypair lives in the Wallet session.
  // Export it straight from the (unlocked) session object the popup passes in.
  // Not part of the shared vectors (not seed-derivable). Returns null when the
  // session has no key material.
  function blockKey(session) {
    if (!session) return null;
    const secret = session.secretKeyHex || session.secretHex || session.privateKeyHex;
    const pub = session.publicKeyHex || session.publicHex;
    const address = session.address;
    if (!secret || !pub) return null;
    return { chain: 'block', scheme: 'ml-dsa-44', address, secretKey: secret, publicKey: pub };
  }

  // Every seed-derived private key for one account index.
  function privateKeys(seed, index) {
    index = index || 0;
    const s = toSeed(seed);
    return {
      bitcoin: utxoKey('bitcoin', s, index),
      litecoin: utxoKey('litecoin', s, index),
      dogecoin: utxoKey('dogecoin', s, index),
      evm: evmKey(s, index),
      solana: solanaKey(s, index),
    };
  }

  // ---- 3. Bitcoin-Core importwallet dump (BTC/LTC/DOGE) --------------------
  // Core's `importwallet` reads whitespace-separated lines of the form
  //   <WIF> <timestamp> label=<label> # addr=<address> hdkeypath=<path>
  // the `# Wallet dump` header + `#`-comment lines are ignored. Field 1 is the
  // key-creation time (ISO-8601) Core expects; the label, address and HD path
  // follow the `#` for human/round-trip use. Core rebuilds its wallet.dat from
  // exactly these keys.
  function dumpLine(k, label, time) {
    return k.wif + ' ' + time + ' label=' + label + ' # addr=' + k.address + ' hdkeypath=' + k.path;
  }
  function coreDump(chainId, seed, opts) {
    opts = opts || {};
    utxoNet(chainId); // validate
    const indices = opts.indices || [opts.index || 0];
    const label = opts.label || ('blockle-' + chainId);
    const time = opts.time || '2024-01-01T00:00:00Z';
    const s = toSeed(seed);
    const lines = [
      '# Wallet dump created by Blockle',
      '# * Created on ' + time,
      '#',
    ];
    for (const i of indices) lines.push(dumpLine(utxoKey(chainId, s, i), label, time));
    lines.push(''); // trailing newline
    return lines.join('\n');
  }
  function coreDumpFilename(chainId) { return chainId + '-blockle-import.txt'; }

  // Parse a dump back to its key lines — the inverse used by the Core round-trip
  // test (and by any importer): [{ wif, address, hdkeypath, label, time }].
  function parseDump(text) {
    const out = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const hashAt = line.indexOf(' # ');
      const head = hashAt >= 0 ? line.slice(0, hashAt) : line;
      const tail = hashAt >= 0 ? line.slice(hashAt + 3) : '';
      const parts = head.split(/\s+/);
      const wif = parts[0];
      const time = parts[1] || '';
      let label = '';
      for (let i = 2; i < parts.length; i++) if (parts[i].startsWith('label=')) label = parts[i].slice(6);
      const addrM = /(?:^|\s)addr=([^\s,]+)/.exec(tail);
      const pathM = /(?:^|\s)hdkeypath=([^\s]+)/.exec(tail);
      out.push({ wif, time, label, address: addrM ? addrM[1] : null, hdkeypath: pathM ? pathM[1] : null });
    }
    return out;
  }

  // ---- THE SECURITY GATE ----------------------------------------------------
  // Blocks export unless the vault is unlocked AND the user passes an explicit
  // confirm that surfaces DANGER_WARNING. Fails closed (no confirm handler → no
  // export). Touches NO secret material itself.
  async function gate(opts) {
    opts = opts || {};
    if (!opts.unlocked) return { allowed: false, reason: 'locked', warning: DANGER_WARNING };
    if (typeof opts.confirm !== 'function') return { allowed: false, reason: 'no-confirm-handler', warning: DANGER_WARNING };
    let ok = false;
    try { ok = await opts.confirm(DANGER_WARNING); } catch (_) { ok = false; }
    return { allowed: !!ok, reason: ok ? 'confirmed' : 'declined', warning: DANGER_WARNING };
  }

  // Gated export: runs the gate, then (only if allowed) assembles the requested
  // material. Returns { ok:false, reason, warning } when blocked — never any
  // secret. No logging, no network, nothing handed to any sink.
  async function exportSecrets(opts) {
    opts = opts || {};
    const g = await gate(opts);
    if (!g.allowed) return { ok: false, reason: g.reason, warning: g.warning };
    const index = opts.index || 0;
    const out = { ok: true };
    let seed = opts.seed;
    if (opts.mnemonic) { out.mnemonic = fromMnemonic(opts.mnemonic, opts.passphrase); seed = seed || out.mnemonic.seed; }
    if (seed) out.keys = privateKeys(seed, index);
    if (opts.blockSession) { const b = blockKey(opts.blockSession); if (b) out.block = b; }
    if (opts.coreDumps && seed) {
      const indices = opts.indices || [index];
      out.dumps = {};
      for (const c of ['bitcoin', 'litecoin', 'dogecoin']) {
        out.dumps[c] = { filename: coreDumpFilename(c), text: coreDump(c, seed, { indices }) };
      }
    }
    return out;
  }

  const API = {
    DANGER_WARNING, EVM_PATH, SOL_PATH,
    fromMnemonic, privateKeys, utxoKey, evmKey, solanaKey, blockKey,
    coreDump, coreDumpFilename, dumpLine, parseDump, solPathForIndex,
    gate, exportSecrets,
  };
  global.WalletExport = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
