// chains/xrp.js — the XRP Ledger (XRP) ChainAdapter.
//
// • account key: secp256k1 at BIP44 m/44'/144'/0'/0/0 — the SAME curve + HD lib
//   the wallet already uses for EVM/BTC/Tron. No new crypto. SigningPubKey is the
//   33-byte COMPRESSED pubkey (0x02/0x03).
// • address = classic 'r…' = ripple-base58check(0x00 || RIPEMD160(SHA256(pub)))
//   — the codec lives in chains/xrpl-codec.js (XrplCodec.classicAddress / …).
// • native XRP (6 decimals; 1 XRP = 1e6 drops). 10-XRP base reserve (noted in UI).
// • SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety): the Payment is serialized
//   LOCALLY with the XRPL binary codec and SHA512-half-signed; the only node
//   inputs are the account Sequence (account_info) and the current ledger index
//   (for LastLedgerSequence) — verifiable, never define the payload. So XRP uses
//   the TON-style buildSend -> broadcast path (needsSign:false).
// • endpoint is CONFIG (default https://xrplcluster.com; fallback
//   https://s1.ripple.com:51234) via rippled JSON-RPC.
//
// NOT post-quantum — secp256k1/ECDSA, exactly like Bitcoin/Ethereum.
//
// Global `XrpAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const HD = inNode ? require('../hd.js') : global.HD;
  const XC = inNode ? require('./xrpl-codec.js') : global.XrplCodec;

  const DROPS = 1_000_000;
  const DEFAULT_PATH = "m/44'/144'/0'/0/0";
  const DEFAULT_RPC = 'https://xrplcluster.com';
  const FALLBACK_RPC = 'https://s1.ripple.com:51234';
  const DEFAULT_FEE_DROPS = '10';
  const BASE_RESERVE_XRP = 10;
  const LEDGER_OFFSET = 20;

  function formatUnits(baseStr, decimals) {
    const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
    const i = s.slice(0, s.length - decimals);
    let f = s.slice(s.length - decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  function createXrpAdapter(opts) {
    opts = opts || {};
    const id = 'xrp';
    const path = opts.path || DEFAULT_PATH;
    const explorer = opts.explorer || 'https://xrpscan.com/tx/';
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'XRP', decimals: 6 };
    let rootSeed = null;
    let getEndpoint = opts.endpoint || (async () => opts.rpc || opts.rpcUrl || DEFAULT_RPC);

    // rippled JSON-RPC: POST {method, params:[{...}]} to the configured rpc url.
    async function xrplRpc(method, params) {
      let base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      base = String(base || DEFAULT_RPC).replace(/\/+$/, '');
      const r = await fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params: [params || {}] }),
      });
      const j = await r.json();
      return (j && j.result) || j;
    }

    function pathWithIndex(index) { if (!index) return path; return path.replace(/\/0$/, '/' + index); }
    function nodeFor(index) { if (!rootSeed) throw new Error('locked'); return HD.derivePath(rootSeed, pathWithIndex(index || 0)); }

    async function accountInfo(address) { return xrplRpc('account_info', { account: address, ledger_index: 'validated' }); }
    async function currentLedger() {
      try { const r = await xrplRpc('ledger_current', {}); if (r && r.ledger_current_index) return Number(r.ledger_current_index); } catch (_) {}
      try { const r = await xrplRpc('server_info', {}); return Number(((r && r.info && r.info.validated_ledger) || {}).seq || 0); } catch (_) { return 0; }
    }

    return {
      id, native, scheme: 'secp256k1', drops: DROPS, baseReserveXrp: BASE_RESERVE_XRP,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = HD.derivePath(seed, pathWithIndex(index || 0));
        return {
          chain: id, index: index || 0,
          address: XC.classicAddress(node.publicKey),
          publicKey: C.bytesToHex(node.publicKey),
          scheme: 'secp256k1', path: pathWithIndex(index || 0),
        };
      },

      async getBalance(address) {
        const out = [];
        try {
          const res = await accountInfo(address);
          const bal = BigInt(((res && res.account_data) || {}).Balance || 0).toString();
          out.push({ asset: native, confirmed: bal, display: formatUnits(bal, 6) });
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        return out;
      },

      async discoverTokens() { return []; },

      // CLIENT-BUILT + CLIENT-SIGNED Payment. seqno + ledger come from the node.
      // req: { to, amount(drops), fee?, destinationTag?, index? }
      async buildSend(account, req) {
        if (!rootSeed) throw new Error('locked');
        if (!req || !req.to || req.amount == null) throw new Error('xrp: to + amount required');
        if (!XC.isXrpAddress(req.to)) throw new Error('xrp: invalid destination address ' + req.to);
        const index = (account && account.index) || 0;
        const node = nodeFor(index);
        const owner = (account && account.address) || XC.classicAddress(node.publicKey);
        const info = await accountInfo(owner);
        const seq = Number(((info && info.account_data) || {}).Sequence || 0);
        const lastLedger = (await currentLedger()) + LEDGER_OFFSET;
        const fee = String(req.fee || DEFAULT_FEE_DROPS);
        const fields = XC.buildPaymentFields(owner, req.to, String(req.amount), fee, seq,
          lastLedger, C.bytesToHex(node.publicKey), { destinationTag: req.destinationTag });
        const built = XC.buildSignedPayment(fields, node.privateKey);
        return {
          chain: id, kind: 'send', raw: built.txBlobHex, txid: built.hash, needsSign: false,
          summary: { from: owner, to: req.to, amount: String(req.amount), asset: native.symbol,
            sequence: seq, lastLedgerSequence: lastLedger, fee },
        };
      },

      async broadcast(tx) {
        const blob = (tx && (tx.raw || tx.txBlobHex)) || tx;
        const res = await xrplRpc('submit', { tx_blob: blob });
        const engine = res && res.engine_result;
        const accepted = engine === 'tesSUCCESS' || engine === 'terQUEUED';
        const txid = (tx && tx.txid) || ((res && res.tx_json) || {}).hash || null;
        return { txid, accepted, raw: res };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  // Re-export the codec helpers on the adapter module too, so callers that reach
  // for XRP.buildPayment / XRP.amountDrops / XRP.vlPrefix / XRP.classicAddress
  // (instead of the XrplCodec module) resolve them here as well.
  const API = Object.assign({}, XC, {
    createXrpAdapter, formatUnits,
    DEFAULT_PATH, DEFAULT_RPC, FALLBACK_RPC, DROPS, BASE_RESERVE_XRP, LEDGER_OFFSET,
  });
  global.XrpAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
