// chains/tezos.js — the Tezos (XTZ) ChainAdapter.
//
// • account key: ed25519 via SLIP-0010 at m/44'/1729'/0'/0' (coin type 1729,
//   FOUR hardened segments — Solana-style, unlike Stellar/TON's three). SLIP-0010
//   helper inlined (cloned from stellar.js/ton.js). No new EC crypto. node.key is
//   the 32-byte ed25519 seed. Pinned by docs/tezos-vectors.json.
// • address = tz1 = base58check([6,161,159] || blake2b(pub,20)). Public-key export
//   is edpk = base58check([13,15,37,217] || pub). (chains/tezos-forge.js is the
//   forge/zarith/pkh/base58check codec engine.)
// • native XTZ (6 decimals; 1 XTZ = 1e6 mutez).
// • SEND is CLIENT-BUILT + CLIENT-SIGNED (fund-safety): the whole 'transaction'
//   manager operation is forged LOCALLY to bytes and ed25519-signed over
//   blake2b(0x03 || forged, 32). The ONLY node inputs are branch (head block hash)
//   + counter (per-account) — both verifiable, never define the signed payload.
//   So Tezos uses the TON/Stellar-style buildSend -> broadcast path.
// • endpoint is CONFIG (default https://mainnet.api.tez.ie; alt https://rpc.tzkt.io/mainnet)
//   via the Tezos node RPC.
//
// NOT post-quantum — ed25519 is classical EC crypto.
//
// Global `TezosAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const ED = inNode ? require('../ed25519.js') : global.Ed25519;
  const TZ = inNode ? require('./tezos-forge.js') : global.TezosForge;

  const MUTEZ = 1_000_000;                         // 1 XTZ = 1e6 mutez (6 decimals)
  const DEFAULT_PATH = "m/44'/1729'/0'/0'";
  const DEFAULT_RPC = 'https://mainnet.api.tez.ie'; // alt: 'https://rpc.tzkt.io/mainnet'
  const HARDENED = 0x80000000;
  // Conservative defaults for a simple tz1->tz1 transfer (overridable per request).
  const DEFAULT_FEE = '1420';
  const DEFAULT_GAS_LIMIT = '1040';
  const DEFAULT_STORAGE_LIMIT = '257';

  // ---- SLIP-0010 (ed25519) HD derivation (INLINE, cloned from stellar.js) ---
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

  // Build + sign the full 'transaction' manager operation LOCALLY. Shared by
  // buildSend + the golden-vector tests; deterministic + offline (no network).
  // fields = { branch, source, fee, counter, gas_limit, storage_limit, amount,
  //            destination }. Returns { forgedHex, signingHashHex, signature,
  //            signatureHex, edsig, injectionHex }.
  function buildSignedTransaction(fields, seedKey) {
    const forgedHex = TZ.forgeTransaction(fields);
    const signingHash = TZ.signingBytes(forgedHex);
    const signature = ED.sign(signingHash, seedKey);
    return {
      forgedHex,
      signingHashHex: C.bytesToHex(signingHash),
      signature,
      signatureHex: C.bytesToHex(signature),
      edsig: TZ.edsig(signature),
      injectionHex: TZ.injectionHex(forgedHex, signature),
    };
  }

  function createTezosAdapter(opts) {
    opts = opts || {};
    const id = 'tezos';
    const path = opts.path || DEFAULT_PATH;
    const explorer = opts.explorer || 'https://tzkt.io/';
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'XTZ', decimals: 6 };
    let rootSeed = null; // unlocked HD seed (Uint8Array), in-memory only
    let getEndpoint = opts.endpoint || (async () => opts.rpc || opts.rpcUrl || DEFAULT_RPC);

    async function rpcBase() {
      let base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      return String(base || DEFAULT_RPC).replace(/\/+$/, '');
    }
    // Injectable transport hooks (so the golden-vector test runs offline). Default
    // to fetch; registry/tests may pass opts.httpGet / opts.httpPost.
    const httpGet = opts.httpGet || (async (url) => { const r = await fetch(url); return await r.text(); });
    const httpPost = opts.httpPost || (async (url, body, headers) => {
      const r = await fetch(url, { method: 'POST', headers: headers || { 'content-type': 'application/json' }, body });
      return await r.text();
    });

    async function branchHead() {
      const base = await rpcBase();
      const raw = await httpGet(base + '/chains/main/blocks/head/hash');
      return String(raw).trim().replace(/^"|"$/g, '');
    }
    async function counterOf(address) {
      const base = await rpcBase();
      const raw = await httpGet(base + '/chains/main/blocks/head/context/contracts/' + encodeURIComponent(address) + '/counter');
      return BigInt(String(raw).trim().replace(/^"|"$/g, ''));
    }
    async function balanceOf(address) {
      const base = await rpcBase();
      const raw = await httpGet(base + '/chains/main/blocks/head/context/contracts/' + encodeURIComponent(address) + '/balance');
      return String(raw).trim().replace(/^"|"$/g, '');
    }

    function pathWithIndex(index) { if (!index) return path; return path.replace(/\/0'$/, '/' + index + "'"); }
    function keyFor(index) { if (!rootSeed) throw new Error('locked'); return deriveSlip10(rootSeed, pathWithIndex(index || 0)).key; }

    return {
      id, native, scheme: 'ed25519', mutez: MUTEZ,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = deriveSlip10(seed, pathWithIndex(index || 0));
        const pub = ED.publicKey(node.key);
        return {
          chain: id, index: index || 0,
          address: TZ.tz1(pub),
          publicKey: C.bytesToHex(pub),
          edpk: TZ.edpk(pub),
          scheme: 'ed25519', path: pathWithIndex(index || 0),
        };
      },

      async getBalance(address) {
        const out = [];
        try {
          const bal = BigInt(await balanceOf(address)).toString();
          out.push({ asset: native, confirmed: bal, display: formatUnits(bal, 6) });
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        return out;
      },

      // Tezos FA1.2/FA2 token discovery needs an indexer; native-only to start
      // (mirrors XRP/Stellar). Best-effort no-op.
      async discoverTokens() { return []; },

      // CLIENT-BUILT + CLIENT-SIGNED single 'transaction' manager op. branch +
      // counter come from the node (both verifiable), everything signed is forged
      // locally. req: { to, amount(mutez), fee?, gasLimit?, storageLimit?, index? }
      async buildSend(account, req) {
        if (!rootSeed) throw new Error('locked');
        if (!req || !req.to || req.amount == null) throw new Error('tezos: to + amount required');
        if (!TZ.isTezosDestination(req.to)) throw new Error('tezos: invalid destination address ' + req.to);
        const index = (account && account.index) || 0;
        const key = keyFor(index);
        const pub = ED.publicKey(key);
        const owner = (account && account.address) || TZ.tz1(pub);
        const branch = await branchHead();
        const counter = (await counterOf(owner)) + 1n;
        const fields = {
          branch, source: owner,
          fee: String(req.fee != null ? req.fee : DEFAULT_FEE),
          counter: counter.toString(),
          gas_limit: String(req.gasLimit != null ? req.gasLimit : DEFAULT_GAS_LIMIT),
          storage_limit: String(req.storageLimit != null ? req.storageLimit : DEFAULT_STORAGE_LIMIT),
          amount: String(req.amount),
          destination: req.to,
        };
        const built = buildSignedTransaction(fields, key);
        return {
          chain: id, kind: 'send', raw: built.injectionHex, txid: null, needsSign: false,
          summary: {
            from: owner, to: req.to, amount: String(req.amount), asset: native.symbol,
            fee: fields.fee, counter: fields.counter, edsig: built.edsig,
          },
        };
      },

      // Already forged + signed by buildSend; inject the hex op via RPC.
      async broadcast(tx) {
        const hex = (tx && (tx.raw || tx.injectionHex)) || tx;
        const base = await rpcBase();
        const res = await httpPost(base + '/injection/operation', JSON.stringify(String(hex)), { 'content-type': 'application/json' });
        const txid = String(res).trim().replace(/^"|"$/g, '');
        return { txid, accepted: !!txid, raw: res };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  const API = {
    createTezosAdapter, buildSignedTransaction,
    deriveSlip10, masterKey, deriveChild, parsePath, formatUnits,
    DEFAULT_PATH, DEFAULT_RPC, MUTEZ,
    DEFAULT_FEE, DEFAULT_GAS_LIMIT, DEFAULT_STORAGE_LIMIT,
  };
  global.TezosAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
