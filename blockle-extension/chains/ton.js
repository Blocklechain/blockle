// chains/ton.js — the TON (The Open Network) ChainAdapter.
//
// • account key: ed25519 via SLIP-0010 at m/44'/607'/0' (coin type 607). TON's
//   own standard derives ed25519 from a TON-specific mnemonic, but Blockle wallets
//   derive EVERY chain from ONE BIP39 seed, so TON uses SLIP-0010 ed25519 from
//   that seed. Deterministic + reproducible; pinned by docs/ton-vectors.json.
//   NOTE: three hardened segments (Solana uses four: m/44'/501'/0'/0').
// • address = the v4R2 wallet CONTRACT address = cellHash(StateInit{code, data{
//   seqno=0, subwallet_id=698983191, publicKey, plugins=empty}}), encoded as the
//   user-friendly bounceable base64url ('EQ…'); non-bounceable ('UQ…') + raw
//   '0:hex' also supported. (chains/ton-cell.js is the cell/BOC engine.)
// • native TON (9 decimals) + jetton (USDT) balances via toncenter v2 jsonRPC.
// • SEND is CLIENT-BUILT (fund-safety): the signing payload (the v4R2 external
//   message) is assembled LOCALLY from the user's request and its cell hash is
//   ed25519-signed — nothing signed is node-supplied. The ONLY node inputs are
//   seqno (runGetMethod) and, for jetton, the owner's jetton-wallet address
//   (get_wallet_address on the master) — both verifiable/address-shaped, never
//   blindly trusted. So TON uses the generic buildSend -> broadcast path.
// • endpoint is CONFIG (default https://toncenter.com/api/v2); optional API key.
//
// NOT post-quantum — Ed25519 is classical EC crypto (only BLOCK is PQ).
//
// Global `TonAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const ED = inNode ? require('../ed25519.js') : global.Ed25519;
  const T = inNode ? require('./ton-cell.js') : global.TonCell;

  const NANO = 1_000_000_000;                 // 1 TON = 1e9 nanoton (9 decimals)
  const DEFAULT_PATH = "m/44'/607'/0'";
  const DEFAULT_API = 'https://toncenter.com/api/v2';
  const HARDENED = 0x80000000;
  const DEFAULT_SUBWALLET = T.SUBWALLET_ID;   // 698983191
  const JETTON_TRANSFER_OP = 0x0f8a7ea5;
  const DEFAULT_JETTON_GAS = '100000000';     // 0.1 TON attached to a jetton transfer
  const DEFAULT_FWD_AMOUNT = '1';             // 1 nanoton notify

  // ---- SLIP-0010 (ed25519) HD derivation (INLINE, copied from solana.js) ----
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

  // ---- deterministic client-built external messages (fund-safety core) ------
  // All cells are built LOCALLY. Shared by buildSend + the golden-vector tests.
  function v4SigningCell(subwalletId, validUntil, seqno, internalMsg) {
    const b = T.beginCell().storeUint(subwalletId, 32);
    if (validUntil === 0xffffffff) { for (let i = 0; i < 32; i++) b.storeBit(1); }
    else b.storeUint(validUntil >>> 0, 32);
    b.storeUint(seqno, 32).storeUint(0, 8).storeUint(3, 8).storeRef(internalMsg); // op=0, sendMode=3
    return b.endCell();
  }
  // Inline a body cell into a builder when it fits (refs<=4), else by ref —
  // byte-identical to @ton/core's storeMessage/storeMessageRelaxed heuristic.
  function storeBodyMaybeInline(b, body) {
    const needRef = (b.availableBits() - 1) < body.bitLen || (b.refs.length + body.refs.length) > 4;
    if (needRef) b.storeBit(1).storeRef(body); else b.storeBit(0).storeSlice(body);
  }
  function internalMessage(destParts, amountStr, bounce, bodyCell) {
    const b = T.beginCell()
      .storeBit(0).storeBit(1).storeBit(bounce ? 1 : 0).storeBit(0) // int tag, ihrDisabled, bounce, bounced
      .storeAddress(null).storeAddress(destParts)                    // src none, dest
      .storeCoins(amountStr).storeBit(0).storeCoins(0).storeCoins(0) // value + empty extra + ihr/fwd fee
      .storeUint(0, 64).storeUint(0, 32)                             // created_lt, created_at
      .storeBit(0);                                                  // no state init
    storeBodyMaybeInline(b, bodyCell);
    return b.endCell();
  }
  function externalMessage(selfParts, stateInit, body) {
    const b = T.beginCell().storeBit(1).storeBit(0)   // ext_in_msg_info$10
      .storeAddress(null).storeAddress(selfParts).storeCoins(0);
    if (stateInit) {
      b.storeBit(1);
      const initRef = (b.availableBits() - 2) < (stateInit.bitLen + body.bitLen);
      if (initRef) b.storeBit(1).storeRef(stateInit); else b.storeBit(0).storeSlice(stateInit);
    } else b.storeBit(0);
    storeBodyMaybeInline(b, body);
    return b.endCell();
  }
  // The canonical comment body: op 0x00000000 ++ utf8 text (empty = just the op).
  function commentBody(text) {
    const b = T.beginCell().storeUint(0, 32);
    if (text) b.storeBytes(C.utf8(text));
    return b.endCell();
  }
  // Build the FULL signed external message for a native TON transfer.
  // Returns { signingCell, signature, internalMsg, external, boc(base64), hash }.
  function buildNativeExternal(args) {
    const { pubKey, seedKey, dest, amount, seqno } = args;
    const subwalletId = args.subwalletId === undefined ? DEFAULT_SUBWALLET : args.subwalletId;
    const bounce = args.bounce === undefined ? (dest.bounceable !== false) : !!args.bounce;
    const validUntil = args.validUntil === undefined ? (seqno === 0 ? 0xffffffff : Math.floor(Date.now() / 1000) + 60) : args.validUntil;
    const destParts = { workchain: dest.workchain, hash: dest.hash };
    const internalMsg = internalMessage(destParts, String(amount), bounce, commentBody(args.comment || ''));
    const signingCell = v4SigningCell(subwalletId, validUntil, seqno, internalMsg);
    const signature = ED.sign(signingCell.hash(), seedKey);
    const body = T.beginCell().storeBuffer(signature).storeSlice(signingCell).endCell();
    const stateInit = seqno === 0 ? T.v4r2StateInit(pubKey, subwalletId) : null;
    const self = { workchain: 0, hash: T.v4r2StateInit(pubKey, subwalletId).hash() };
    const external = externalMessage(self, stateInit, body);
    const boc = T.serializeBoc(external);
    return { signingCell, signature, internalMsg, external, boc: T.toBase64(boc, false), hash: C.bytesToHex(external.hash()) };
  }
  // Build the FULL signed external message for a jetton (e.g. USDT) transfer.
  // `jettonWallet` is the OWNER's jetton-wallet address (node-derived + validated).
  function buildJettonExternal(args) {
    const { pubKey, seedKey, jettonWallet, dest, response, amount, seqno } = args;
    const subwalletId = args.subwalletId === undefined ? DEFAULT_SUBWALLET : args.subwalletId;
    const fwdAmount = String(args.fwdAmount === undefined ? DEFAULT_FWD_AMOUNT : args.fwdAmount);
    const gas = String(args.gas === undefined ? DEFAULT_JETTON_GAS : args.gas);
    const validUntil = args.validUntil === undefined ? (seqno === 0 ? 0xffffffff : Math.floor(Date.now() / 1000) + 60) : args.validUntil;
    const jbody = T.beginCell()
      .storeUint(JETTON_TRANSFER_OP, 32).storeUint(0, 64).storeCoins(String(amount))
      .storeAddress({ workchain: dest.workchain, hash: dest.hash })
      .storeAddress({ workchain: response.workchain, hash: response.hash })
      .storeBit(0).storeCoins(fwdAmount).storeBit(0).endCell();
    const internalMsg = internalMessage({ workchain: jettonWallet.workchain, hash: jettonWallet.hash }, gas, true, jbody);
    const signingCell = v4SigningCell(subwalletId, validUntil, seqno, internalMsg);
    const signature = ED.sign(signingCell.hash(), seedKey);
    const body = T.beginCell().storeBuffer(signature).storeSlice(signingCell).endCell();
    const stateInit = seqno === 0 ? T.v4r2StateInit(pubKey, subwalletId) : null;
    const self = { workchain: 0, hash: T.v4r2StateInit(pubKey, subwalletId).hash() };
    const external = externalMessage(self, stateInit, body);
    const boc = T.serializeBoc(external);
    return { jettonBody: jbody, signingCell, signature, internalMsg, external, boc: T.toBase64(boc, false), hash: C.bytesToHex(external.hash()) };
  }

  // ---- jetton-wallet address derivation (defense-in-depth validation) -------
  // The standard (TEP-74) jetton wallet's address is cellHash(StateInit{ code:
  // jettonWalletCode, data: coins(0) ++ owner ++ jettonMaster ++ ref(code) }).
  // We derive it LOCALLY and assert the node's get_wallet_address answer matches
  // — closing the gas-misdirect gap where a malicious node could point the
  // attached gas at an attacker's jetton wallet. (The real recipient/amount live
  // in the CLIENT-signed transfer body, so funds were never at risk; this hardens
  // where the gas-bearing internal message is routed.)
  function toCodeCell(code) {
    if (!code) return null;
    if (code && typeof code.hash === 'function' && code.bitLen !== undefined) return code; // a Cell
    return T.parseBoc(T.fromBase64(String(code)))[0];
  }
  function jettonWalletStateInit(ownerParts, masterParts, code) {
    const codeCell = toCodeCell(code);
    if (!codeCell) throw new Error('ton: jetton-wallet code required to derive wallet address');
    const data = T.beginCell()
      .storeCoins(0)
      .storeAddress({ workchain: ownerParts.workchain, hash: ownerParts.hash })
      .storeAddress({ workchain: masterParts.workchain, hash: masterParts.hash })
      .storeRef(codeCell)
      .endCell();
    return T.beginCell()
      .storeUint(0, 2)                 // split_depth(Maybe)=0, special(Maybe)=0
      .storeBit(1).storeRef(codeCell)
      .storeBit(1).storeRef(data)
      .storeBit(0)                     // library (HashmapE) empty
      .endCell();
  }
  function jettonWalletAddress(ownerParts, masterParts, code, workchain) {
    const si = jettonWalletStateInit(ownerParts, masterParts, code);
    return { workchain: workchain === undefined ? 0 : workchain, hash: si.hash() };
  }
  // Assert a node-returned jetton-wallet address equals the locally-derived one.
  // Jetton wallets live in the basechain (workchain 0) unless overridden.
  function assertJettonWallet(nodeParts, ownerParts, masterParts, code, workchain) {
    const want = jettonWalletAddress(ownerParts, masterParts, code, workchain === undefined ? 0 : workchain);
    if (nodeParts.workchain !== want.workchain || C.bytesToHex(nodeParts.hash) !== C.bytesToHex(want.hash)) {
      throw new Error('ton: node jetton-wallet address != locally-derived StateInit — refusing to use');
    }
    return nodeParts;
  }

  function createTonAdapter(opts) {
    opts = opts || {};
    const id = 'ton';
    const path = opts.path || DEFAULT_PATH;
    const explorer = opts.explorer || 'https://tonviewer.com/transaction/';
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'TON', decimals: 9 };
    const apiKey = opts.apiKey || null;
    const subwalletId = opts.subwalletId === undefined ? DEFAULT_SUBWALLET : opts.subwalletId;
    let rootSeed = null; // unlocked HD seed (Uint8Array), in-memory only
    let getEndpoint = opts.endpoint || (async () => opts.api || opts.rpcUrl || DEFAULT_API);

    // toncenter v2 is JSON-RPC over {base}/jsonRPC. One helper serves all calls.
    async function tonApi(method, params) {
      let base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      base = String(base || DEFAULT_API).replace(/\/+$/, '');
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers['X-API-Key'] = apiKey;
      const r = await fetch(base + '/jsonRPC', {
        method: 'POST', headers,
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params: params || {} }),
      });
      const j = await r.json();
      if (j.error) throw new Error((j.error && (j.error.message || JSON.stringify(j.error))) || 'toncenter error');
      return j.result;
    }

    // Resolve the config-overridable jetton index URL for `address`. opts.jettonIndex
    // may be a function(address)->url or a string template ({address}); otherwise we
    // derive toncenter v3 from the configured v2 api base. No secret.
    async function jettonIndexUrl(address) {
      if (typeof opts.jettonIndex === 'function') return await opts.jettonIndex(address);
      if (opts.jettonIndex) return String(opts.jettonIndex).replace(/\{address\}|\{addr\}/g, encodeURIComponent(address));
      let base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      base = String(base || DEFAULT_API).replace(/\/+$/, '');
      const v3 = base.replace(/\/api\/v2$/, '/api/v3');
      return v3 + '/jetton/wallets?owner_address=' + encodeURIComponent(address);
    }
    // Map either indexer shape to discovered jetton rows (keyed by master addr).
    //  • TON API (tonapi.io): { balances:[{ balance, jetton:{address,symbol,decimals,name,image} }] }
    //  • toncenter v3:        { jetton_wallets:[{ balance, jetton:<master> }], metadata:{<master>:{token_info:[{symbol,decimals,name,image}]}} }
    function mapJettons(j) {
      const out = [];
      if (!j) return out;
      if (Array.isArray(j.balances)) {
        for (const b of j.balances) {
          let amt; try { amt = BigInt(b.balance); } catch { continue; }
          if (amt <= 0n) continue;
          const jt = b.jetton || {};
          const master = jt.address || b.jetton_master || b.jetton;
          if (!master) continue;
          const decimals = Number(jt.decimals != null ? jt.decimals : 9);
          const o = { chain: id, kind: 'jetton', address: String(master),
            symbol: jt.symbol || 'JETTON', decimals,
            balance: amt.toString(), display: formatUnits(amt.toString(), decimals) };
          if (jt.name) o.name = jt.name;
          if (jt.image) o.logo = jt.image;
          out.push(o);
        }
        return out;
      }
      if (Array.isArray(j.jetton_wallets)) {
        const meta = j.metadata || {};
        for (const w of j.jetton_wallets) {
          let amt; try { amt = BigInt(w.balance); } catch { continue; }
          if (amt <= 0n) continue;
          const master = w.jetton || w.jetton_master;
          if (!master) continue;
          const info = (((meta[master] || {}).token_info) || [])[0] || {};
          const decimals = Number(info.decimals != null ? info.decimals : 9);
          const o = { chain: id, kind: 'jetton', address: String(master),
            symbol: info.symbol || 'JETTON', decimals,
            balance: amt.toString(), display: formatUnits(amt.toString(), decimals) };
          if (info.name) o.name = info.name;
          if (info.image) o.logo = info.image;
          out.push(o);
        }
        return out;
      }
      return out;
    }

    function pathWithIndex(index) { if (!index) return path; return path.replace(/\/0'$/, '/' + index + "'"); }
    function keyFor(index) {
      if (!rootSeed) throw new Error('locked');
      return deriveSlip10(rootSeed, pathWithIndex(index || 0)).key;
    }
    function selfParts(index) { const k = keyFor(index); const pub = ED.publicKey(k); return { pub, seedKey: k, hash: T.v4r2StateInit(pub, subwalletId).hash() }; }
    function ownerAddress(index) { const sp = selfParts(index); return T.formatAddress(0, sp.hash, {}); }

    // Parse the single integer off a runGetMethod stack (num -> decimal/0x hex).
    function stackInt(result) {
      const st = result && result.stack;
      if (!st || !st.length) return 0n;
      const v = st[0][1];
      if (typeof v === 'string') return BigInt(v);
      if (v && v.number) return BigInt(v.number);
      return 0n;
    }
    // Parse an address off a runGetMethod stack (cell/slice holding a MsgAddress).
    function stackAddress(result) {
      const st = result && result.stack;
      if (!st || !st.length) throw new Error('ton: empty stack for address');
      const entry = st[0];
      const payload = entry[1];
      const b64 = (payload && (payload.bytes || payload.object && payload.object.data && payload.object.data.b64))
        || (typeof payload === 'string' ? payload : null);
      if (!b64) throw new Error('ton: no cell in address stack');
      const cell = T.parseBoc(T.fromBase64(b64))[0];
      const a = T.loadMsgAddress(cell);
      if (!a) throw new Error('ton: get_wallet_address returned addr_none');
      return a;
    }
    async function seqnoOf(address) {
      try { const r = await tonApi('runGetMethod', { address, method: 'seqno', stack: [] }); return Number(stackInt(r)); }
      catch (_) { return 0; } // undeployed wallet -> seqno 0 (send carries StateInit)
    }
    // Resolve a verified jetton-wallet code cell for `master` from config:
    // opts.jettonWalletCode may be a Cell / base64 BOC (one code for all masters)
    // or a function(master)->code / a { master: code } map. Returns null when
    // unconfigured (validation then falls back to the node address shape-check).
    function resolveJettonCode(master) {
      const jc = opts.jettonWalletCode;
      if (!jc) return null;
      try {
        if (typeof jc === 'function') return jc(master) || null;
        if (typeof jc === 'string') return jc;
        if (jc && typeof jc.hash === 'function') return jc;        // a Cell
        return jc[master] || jc[String(master)] || null;          // per-master map
      } catch (_) { return null; }
    }
    async function jettonWalletOf(ownerAddr, master) {
      const ownerCellBoc = T.toBase64(T.serializeBoc(T.addressCell(T.parseAddress(ownerAddr))), false);
      const r = await tonApi('runGetMethod', { address: master, method: 'get_wallet_address', stack: [['tvm.Slice', ownerCellBoc]] });
      const nodeAddr = stackAddress(r); // { workchain, hash } — shape-validated
      // DEFENSE-IN-DEPTH: when a verified jetton-wallet code is configured for
      // this master, DERIVE the owner's jetton-wallet StateInit address locally
      // and assert the node's answer matches (reject on mismatch). Defaults to
      // the shape-check only when no code is configured, so real sends never
      // break on a missing code.
      const code = resolveJettonCode(master);
      if (code) assertJettonWallet(nodeAddr, T.parseAddress(ownerAddr), T.parseAddress(master), code);
      return nodeAddr;
    }

    return {
      id, native, scheme: 'ed25519', nano: NANO,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = deriveSlip10(seed, pathWithIndex(index || 0));
        const pub = ED.publicKey(node.key);
        const hash = T.v4r2StateInit(pub, subwalletId).hash();
        return {
          chain: id, index: index || 0,
          address: T.formatAddress(0, hash, {}),
          publicKey: C.bytesToHex(pub),
          scheme: 'ed25519', path: pathWithIndex(index || 0),
        };
      },

      // tokens: [{kind:'jetton', master, symbol, decimals}]
      async getBalance(address, tokens) {
        const out = [];
        try {
          const res = await tonApi('getAddressBalance', { address });
          const bal = BigInt((typeof res === 'string' ? res : (res && res.balance)) || 0).toString();
          out.push({ asset: native, confirmed: bal, display: formatUnits(bal, 9) });
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        for (const t of (tokens || [])) {
          if (t.kind !== 'jetton' || !t.master) continue;
          try {
            const jw = await jettonWalletOf(address, t.master);
            const jwAddr = T.formatAddress(jw.workchain, jw.hash, {});
            const r = await tonApi('runGetMethod', { address: jwAddr, method: 'get_wallet_data', stack: [] });
            const v = stackInt(r).toString();
            out.push({ asset: t, confirmed: v, display: formatUnits(v, t.decimals) });
          } catch (e) {
            out.push({ asset: t, confirmed: '0', display: '—', error: String(e.message || e) });
          }
        }
        return out;
      },

      // Auto-detect jetton holdings via a config-overridable index endpoint
      // (toncenter v3 /api/v3/jetton/wallets or TON API /v2/accounts/{addr}/jettons).
      // Each non-zero jetton -> a discovered row keyed by the jetton master address.
      // Read-only, best-effort, never throws.
      async discoverTokens(address) {
        try {
          const url = await jettonIndexUrl(address);
          if (!url) return [];
          const headers = {};
          if (apiKey) headers['X-API-Key'] = apiKey;
          const r = await fetch(url, { headers });
          const j = await r.json();
          return mapJettons(j);
        } catch { return []; }
      },

      // CLIENT-BUILT signed external message (native or jetton). The signing cell
      // is assembled locally; only seqno (+ jetton-wallet addr) come from the node.
      // req: { asset?, to, amount(base units), comment?, bounce?, fwdAmount?, gas?, index? }
      async buildSend(account, req) {
        if (!rootSeed) throw new Error('locked');
        if (!req || !req.to || req.amount == null) throw new Error('ton: to + amount required');
        const index = (account && account.index) || 0;
        const sp = selfParts(index);
        const owner = (account && account.address) || T.formatAddress(0, sp.hash, {});
        const seqno = await seqnoOf(owner);
        const isJetton = req.asset && req.asset.kind === 'jetton' && req.asset.master;
        if (isJetton) {
          const dest = T.parseAddress(req.to);         // recipient OWNER address
          const jw = await jettonWalletOf(owner, req.asset.master);
          const built = buildJettonExternal({
            pubKey: sp.pub, seedKey: sp.seedKey, jettonWallet: jw, dest,
            response: { workchain: 0, hash: sp.hash }, amount: req.amount,
            fwdAmount: req.fwdAmount, gas: req.gas, seqno, subwalletId,
          });
          return {
            chain: id, kind: 'jetton-transfer', raw: built.boc, txid: built.hash, needsSign: false,
            summary: { from: owner, to: req.to, amount: String(req.amount), asset: req.asset.symbol || 'jetton',
              jettonWallet: T.formatAddress(jw.workchain, jw.hash, {}), seqno },
          };
        }
        const dest = T.parseAddress(req.to);
        const built = buildNativeExternal({
          pubKey: sp.pub, seedKey: sp.seedKey, dest, amount: req.amount,
          comment: req.comment, bounce: req.bounce, seqno, subwalletId,
        });
        return {
          chain: id, kind: 'send', raw: built.boc, txid: built.hash, needsSign: false,
          summary: { from: owner, to: req.to, amount: String(req.amount), asset: native.symbol, seqno },
        };
      },

      // Already signed by buildSend; broadcast the BOC via toncenter sendBoc.
      async broadcast(tx) {
        const boc = (tx && (tx.raw || tx.boc)) || tx;
        const res = await tonApi('sendBoc', { boc });
        const txid = (tx && tx.txid) || (res && (res.hash || res['@extra'])) || null;
        return { txid, accepted: true, raw: res };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  const API = {
    createTonAdapter,
    deriveSlip10, masterKey, deriveChild, parsePath,
    buildNativeExternal, buildJettonExternal,
    jettonWalletStateInit, jettonWalletAddress, assertJettonWallet, toCodeCell,
    v4SigningCell, internalMessage, externalMessage, commentBody,
    formatUnits,
    DEFAULT_PATH, DEFAULT_API, NANO, DEFAULT_SUBWALLET, JETTON_TRANSFER_OP,
  };
  global.TonAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
