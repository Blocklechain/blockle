// chains/stellar.js — the Stellar (XLM) ChainAdapter.
//
// • account key: ed25519 via SLIP-0010 at m/44'/148'/0' (coin type 148, three
//   hardened segments). SLIP-0010 helper inlined (cloned from ton.js/solana.js).
//   No new crypto. node.key is the 32-byte ed25519 seed.
// • address = strkey 'G…' = base32(0x30 || 32-byte ed25519 pub || crc16-xmodem-LE)
//   — the codec lives in chains/stellar-xdr.js (StellarXdr.encodeEd25519PublicKey).
// • native XLM (7 decimals; 1 XLM = 1e7 stroops). 1-XLM base reserve (noted in UI).
// • SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety): the v1 TransactionEnvelope
//   with a single Payment op is serialized LOCALLY with Stellar XDR and ed25519-
//   signed over SHA256(networkId || ENVELOPE_TYPE_TX || txXDR); the only node
//   input is the account sequence (Horizon GET /accounts) — verifiable, never
//   defines the payload. So Stellar uses the TON-style buildSend path.
// • endpoint is CONFIG (default https://horizon.stellar.org) via Horizon REST.
//
// NOT post-quantum — ed25519 is classical EC crypto.
//
// Global `StellarAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const ED = inNode ? require('../ed25519.js') : global.Ed25519;
  const SX = inNode ? require('./stellar-xdr.js') : global.StellarXdr;

  const STROOP = 10_000_000;
  const DEFAULT_PATH = "m/44'/148'/0'";
  const DEFAULT_HORIZON = 'https://horizon.stellar.org';
  const HARDENED = 0x80000000;
  const BASE_RESERVE_XLM = 1;

  // ---- SLIP-0010 (ed25519) HD derivation (INLINE, cloned from ton.js) -------
  function ser32(i) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, i >>> 0, false); return b; }
  function masterKey(seed) { const I = C.hmacSha512(C.utf8('ed25519 seed'), C.toBytes(seed)); return { key: I.slice(0, 32), chainCode: I.slice(32, 64) }; }
  function deriveChild(node, index) {
    const data = C.concatBytes(Uint8Array.of(0x00), node.key, ser32(index));
    const I = C.hmacSha512(node.chainCode, data);
    return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
  }
  function parsePath(path) {
    const parts = path.split('/');
    if (parts[0] !== 'm') throw new Error("path must start with 'm'");
    return parts.slice(1).map((p) => {
      const hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
      if (!hardened) throw new Error('ed25519 derivation requires hardened segments: ' + p);
      const n = parseInt(p.slice(0, -1), 10);
      if (!Number.isInteger(n) || n < 0) throw new Error('bad path segment: ' + p);
      return (n + HARDENED) >>> 0;
    });
  }
  function deriveSlip10(seed, path) {
    let node = masterKey(seed);
    for (const index of parsePath(path)) node = deriveChild(node, index);
    return node;
  }

  function formatUnits(baseStr, decimals) {
    const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
    const i = s.slice(0, s.length - decimals);
    let f = s.slice(s.length - decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  // Adapter-style convenience wrapper over the XDR codec. args: { pub, seedKey,
  // source, destination, amount, fee, sequence, asset, passphrase }. `asset` is
  // 'native' or { code, issuer }. Returns BOTH Design-A (…Hex/…Base64) and
  // Design-B (txXDR/signingPayload/envelope) field names.
  function buildPaymentEnvelope(args) {
    const pub = C.toBytes(args.pub);
    const dest = SX.decodeEd25519PublicKey(args.destination);
    let assetXdr = null;
    if (args.asset && args.asset !== 'native') {
      const issuer = SX.decodeEd25519PublicKey(args.asset.issuer);
      assetXdr = SX.assetAlphanum4(args.asset.code, issuer);
    }
    const ops = [SX.paymentOp(dest, String(args.amount), assetXdr)];
    const built = SX.buildSignedEnvelope(pub, args.seedKey, String(args.sequence), ops,
      { fee: args.fee, passphrase: args.passphrase });
    return Object.assign({}, built, {
      txXDR: SX.toBase64(C.hexToBytes(built.txXDRunsignedHex)),
      signingPayload: built.hash,
      signature: built.signatureHex,
      envelope: built.envelopeXDRBase64,
    });
  }

  function createStellarAdapter(opts) {
    opts = opts || {};
    const id = 'stellar';
    const path = opts.path || DEFAULT_PATH;
    const explorer = opts.explorer || 'https://stellar.expert/explorer/public/tx/';
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'XLM', decimals: 7 };
    const passphrase = opts.passphrase || SX.PUBLIC_NETWORK_PASSPHRASE;
    let rootSeed = null;
    let getEndpoint = opts.endpoint || (async () => opts.horizon || opts.api || DEFAULT_HORIZON);

    async function horizonBase() {
      let base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      return String(base || DEFAULT_HORIZON).replace(/\/+$/, '');
    }
    async function accountOf(address) { const r = await fetch((await horizonBase()) + '/accounts/' + encodeURIComponent(address)); return await r.json(); }

    function pathWithIndex(index) { if (!index) return path; return path.replace(/\/0'$/, '/' + index + "'"); }
    function keyFor(index) { if (!rootSeed) throw new Error('locked'); return deriveSlip10(rootSeed, pathWithIndex(index || 0)).key; }

    return {
      id, native, scheme: 'ed25519', stroop: STROOP, baseReserveXlm: BASE_RESERVE_XLM,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = deriveSlip10(seed, pathWithIndex(index || 0));
        const pub = ED.publicKey(node.key);
        return {
          chain: id, index: index || 0,
          address: SX.encodeEd25519PublicKey(pub),
          publicKey: C.bytesToHex(pub),
          scheme: 'ed25519', path: pathWithIndex(index || 0),
        };
      },

      async getBalance(address) {
        const out = [];
        try {
          const acct = await accountOf(address);
          let nativeStr = '0';
          for (const b of (acct.balances || [])) {
            if (b.asset_type === 'native') { nativeStr = String(Math.round(parseFloat(b.balance || '0') * STROOP)); break; }
          }
          out.push({ asset: native, confirmed: nativeStr, display: formatUnits(nativeStr, 7) });
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        return out;
      },

      // Non-native trustlines the account holds -> discovered stellar-asset rows.
      // Reuses the SAME Horizon /accounts/{G...} read getBalance uses. Each row is
      // keyed by code:issuer (unique dedupe id); balance is stroops (base unit).
      // Read-only, best-effort, never throws.
      async discoverTokens(address) {
        try {
          const acct = await accountOf(address);
          const out = [];
          for (const b of ((acct && acct.balances) || [])) {
            if (!b || b.asset_type === 'native') continue;
            if (!b.asset_code || !b.asset_issuer) continue;
            const stroops = BigInt(Math.round(parseFloat(b.balance || '0') * STROOP));
            if (stroops <= 0n) continue;
            out.push({
              chain: id, kind: 'stellar-asset',
              address: b.asset_code + ':' + b.asset_issuer,
              symbol: b.asset_code, decimals: 7,
              balance: stroops.toString(), display: formatUnits(stroops.toString(), 7),
            });
          }
          return out;
        } catch { return []; }
      },

      // CLIENT-BUILT + CLIENT-SIGNED envelope. sequence comes from Horizon.
      // req: { to, amount(stroops), asset?{kind:'stellar-asset',symbol,address:issuer}, index? }
      async buildSend(account, req) {
        if (!rootSeed) throw new Error('locked');
        if (!req || !req.to || req.amount == null) throw new Error('stellar: to + amount required');
        if (!SX.isStellarAddress(req.to)) throw new Error('stellar: invalid destination address ' + req.to);
        const index = (account && account.index) || 0;
        const key = keyFor(index);
        const pub = ED.publicKey(key);
        const owner = (account && account.address) || SX.encodeEd25519PublicKey(pub);
        const acct = await accountOf(owner);
        const seq = BigInt(acct.sequence) + 1n;
        const dest = SX.decodeEd25519PublicKey(req.to);
        let assetXdr = null;
        const isIssued = req.asset && (req.asset.kind === 'stellar-asset' || req.asset.kind === 'credit_alphanum4');
        if (isIssued) {
          const issuer = SX.decodeEd25519PublicKey(req.asset.address || req.asset.issuer);
          assetXdr = SX.assetAlphanum4(req.asset.symbol, issuer);
        }
        const ops = [SX.paymentOp(dest, String(req.amount), assetXdr)];
        const built = SX.buildSignedEnvelope(pub, key, seq.toString(), ops,
          { fee: SX.BASE_FEE * ops.length, passphrase });
        return {
          chain: id, kind: 'send', raw: built.envelopeXDRBase64, txid: built.hash, needsSign: false,
          summary: { from: owner, to: req.to, amount: String(req.amount),
            asset: isIssued ? req.asset.symbol : native.symbol, sequence: seq.toString(),
            fee: String(SX.BASE_FEE * ops.length) },
        };
      },

      async broadcast(tx) {
        const env = (tx && (tx.raw || tx.envelopeXDRBase64)) || tx;
        const r = await fetch((await horizonBase()) + '/transactions', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'tx=' + encodeURIComponent(env),
        });
        const res = await r.json();
        const txid = (res && res.hash) || (tx && tx.txid) || null;
        const accepted = !!(res && (res.successful || res.hash));
        return { txid, accepted, raw: res };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  // Re-export the XDR codec helpers on the adapter module too, so callers that
  // reach for STELLAR.networkId / STELLAR.buildPaymentEnvelope / STELLAR.paymentOp
  // (instead of the StellarXdr module) resolve them here as well.
  const API = Object.assign({}, SX, {
    createStellarAdapter, buildPaymentEnvelope, deriveSlip10, masterKey, deriveChild, parsePath,
    formatUnits, DEFAULT_PATH, DEFAULT_HORIZON, STROOP, BASE_RESERVE_XLM,
  });
  global.StellarAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
