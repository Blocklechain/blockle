// chains/utxo.js — the UTXO ChainAdapter shared by Bitcoin, Litecoin and
// Dogecoin. One base implementation parameterized by network (address prefixes,
// bech32 HRP, BIP44/84 path, segwit on/off).
//
// • BTC/LTC: BIP84 P2WPKH (native segwit, bech32), BIP143 sighash
// • DOGE:    BIP44 P2PKH (legacy base58), legacy sighash
// • UTXO fetch / fee / broadcast via a configurable Esplora-style endpoint
// • coin selection + change; keys never leave the adapter
//
// NOT post-quantum: ECDSA / secp256k1, exactly like Bitcoin itself.
//
// Global `UtxoAdapter` (factory + networks); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const S = inNode ? require('../secp256k1.js') : global.Secp256k1;
  const HD = inNode ? require('../hd.js') : global.HD;
  const Addr = inNode ? require('../address.js') : global.Addr;

  const NETWORKS = {
    bitcoin:  { id: 'bitcoin',  symbol: 'BTC', decimals: 8, hrp: 'bc',  p2pkh: 0x00, p2sh: 0x05, wif: 0x80, segwit: true,  path: "m/84'/0'/0'/0",  explorer: 'https://mempool.space/tx/',           esplora: 'https://blockstream.info/api' },
    litecoin: { id: 'litecoin', symbol: 'LTC', decimals: 8, hrp: 'ltc', p2pkh: 0x30, p2sh: 0x32, wif: 0xb0, segwit: true,  path: "m/84'/2'/0'/0",  explorer: 'https://blockchair.com/litecoin/transaction/', esplora: 'https://litecoinspace.org/api' },
    dogecoin: { id: 'dogecoin', symbol: 'DOGE', decimals: 8, hrp: null, p2pkh: 0x1e, p2sh: 0x16, wif: 0x9e, segwit: false, path: "m/44'/3'/0'/0",  explorer: 'https://blockchair.com/dogecoin/transaction/',  esplora: 'https://doge-esplora.blockle.org' },
    // Bitcoin Cash: secp256k1 UTXO, NOT segwit — signs with BIP143 preimage +
    // SIGHASH_FORKID (0x41). `forkId` selects that branch; `cashaddr` selects
    // CashAddr receive/display. coin type 145, P2PKH only.
    bitcoincash: { id: 'bitcoincash', symbol: 'BCH', decimals: 8, hrp: null, p2pkh: 0x00, p2sh: 0x05, wif: 0x80, segwit: false, forkId: true, cashaddr: 'bitcoincash', path: "m/44'/145'/0'/0", explorer: 'https://blockchair.com/bitcoin-cash/transaction/', esplora: 'https://bch.imaginary.cash/api' },
  };

  // ---- little-endian + varint helpers -------------------------------------
  function u32le(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
  function u64le(v) {
    v = BigInt(v); const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return b;
  }
  function varint(n) {
    n = Number(n);
    if (n < 0xfd) return Uint8Array.of(n);
    if (n <= 0xffff) return C.concatBytes(Uint8Array.of(0xfd), u32le(n).slice(0, 2));
    if (n <= 0xffffffff) return C.concatBytes(Uint8Array.of(0xfe), u32le(n));
    return C.concatBytes(Uint8Array.of(0xff), u64le(n));
  }
  function pushData(data) {
    const d = C.toBytes(data);
    if (d.length < 0x4c) return C.concatBytes(Uint8Array.of(d.length), d);
    if (d.length <= 0xff) return C.concatBytes(Uint8Array.of(0x4c, d.length), d);
    return C.concatBytes(Uint8Array.of(0x4d), u32le(d.length).slice(0, 2), d);
  }
  function revHex(txidHex) { return C.toBytes(txidHex).reverse(); }

  // scriptPubKey builders
  function p2wpkhScript(h160) { return C.concatBytes(Uint8Array.of(0x00, 0x14), C.toBytes(h160)); }
  function p2pkhScript(h160) { return C.concatBytes(Uint8Array.of(0x76, 0xa9, 0x14), C.toBytes(h160), Uint8Array.of(0x88, 0xac)); }

  // Address -> scriptPubKey (for building outputs to arbitrary recipients)
  function addressToScript(addr, net) {
    // CashAddr (BCH): accept 'bitcoincash:q...' and bare 'q...'. Legacy base58
    // BCH destinations still fall through to the base58 branch below.
    if (net.cashaddr && (addr.startsWith(net.cashaddr + ':') || Addr.looksLikeCashAddr(addr))) {
      const { type, hash } = Addr.cashAddrDecode(addr, net.cashaddr);
      if (type === 0) return p2pkhScript(hash);
      if (type === 1) return C.concatBytes(Uint8Array.of(0xa9, 0x14), hash, Uint8Array.of(0x87)); // P2SH
      throw new Error('unsupported cashaddr type');
    }
    if (net.segwit && net.hrp && addr.toLowerCase().startsWith(net.hrp + '1')) {
      const { version, program } = Addr.segwitDecode(net.hrp, addr);
      if (version === 0 && program.length === 20) return p2wpkhScript(program);
      if (version === 0 && program.length === 32) return C.concatBytes(Uint8Array.of(0x00, 0x20), program); // P2WSH
      throw new Error('unsupported segwit output');
    }
    // base58 legacy
    const dec = C.base58checkDecode(addr);
    const ver = dec[0], h160 = dec.slice(1);
    if (ver === net.p2pkh) return p2pkhScript(h160);
    if (ver === net.p2sh) return C.concatBytes(Uint8Array.of(0xa9, 0x14), h160, Uint8Array.of(0x87)); // P2SH
    throw new Error('unknown address version for ' + net.id);
  }

  // ---- BIP143 (segwit) sighash for a P2WPKH input --------------------------
  // inputs: [{txid, vout, value, h160(ownerPubkeyHash)}], outputs:[{script,value}]
  function sighashSegwit(version, inputs, outputs, index, scriptCode, amount, sequence, locktime, hashType) {
    const prevouts = C.concatBytes(...inputs.map((i) => C.concatBytes(revHex(i.txid), u32le(i.vout))));
    const sequences = C.concatBytes(...inputs.map((i) => u32le(i.sequence != null ? i.sequence : 0xffffffff)));
    const outs = C.concatBytes(...outputs.map((o) => C.concatBytes(u64le(o.value), varint(o.script.length), o.script)));
    const hashPrevouts = C.hash256(prevouts);
    const hashSequence = C.hash256(sequences);
    const hashOutputs = C.hash256(outs);
    const thisIn = inputs[index];
    const preimage = C.concatBytes(
      u32le(version),
      hashPrevouts,
      hashSequence,
      revHex(thisIn.txid), u32le(thisIn.vout),
      varint(scriptCode.length), scriptCode,
      u64le(amount),
      u32le(sequence != null ? sequence : 0xffffffff),
      hashOutputs,
      u32le(locktime),
      u32le(hashType),
    );
    return C.hash256(preimage);
  }

  // ---- legacy sighash for a P2PKH input ------------------------------------
  function sighashLegacy(version, inputs, outputs, index, subScript, locktime, hashType) {
    const parts = [u32le(version), varint(inputs.length)];
    inputs.forEach((inp, i) => {
      parts.push(revHex(inp.txid), u32le(inp.vout));
      if (i === index) { parts.push(varint(subScript.length), subScript); }
      else { parts.push(varint(0)); }
      parts.push(u32le(inp.sequence != null ? inp.sequence : 0xffffffff));
    });
    parts.push(varint(outputs.length));
    outputs.forEach((o) => parts.push(u64le(o.value), varint(o.script.length), o.script));
    parts.push(u32le(locktime), u32le(hashType));
    return C.hash256(C.concatBytes(...parts));
  }

  // ---- full tx serializer --------------------------------------------------
  // signedInputs: [{txid,vout,sequence, scriptSig:Uint8Array, witness:[Uint8Array]|null}]
  function serializeTx(version, signedInputs, outputs, locktime, hasWitness) {
    const parts = [u32le(version)];
    if (hasWitness) parts.push(Uint8Array.of(0x00, 0x01));
    parts.push(varint(signedInputs.length));
    for (const inp of signedInputs) {
      parts.push(revHex(inp.txid), u32le(inp.vout));
      const ss = inp.scriptSig || new Uint8Array(0);
      parts.push(varint(ss.length), ss);
      parts.push(u32le(inp.sequence != null ? inp.sequence : 0xffffffff));
    }
    parts.push(varint(outputs.length));
    for (const o of outputs) parts.push(u64le(o.value), varint(o.script.length), o.script);
    if (hasWitness) {
      for (const inp of signedInputs) {
        const w = inp.witness || [];
        parts.push(varint(w.length));
        for (const item of w) parts.push(varint(item.length), item);
      }
    }
    parts.push(u32le(locktime));
    return C.concatBytes(...parts);
  }
  // txid = dSHA256 of the NON-witness serialization, displayed reversed
  function txidOf(version, signedInputs, outputs, locktime) {
    const nonWit = serializeTx(version, signedInputs, outputs, locktime, false);
    return C.bytesToHex(C.hash256(nonWit).reverse());
  }

  // ---- coin selection (accumulative) --------------------------------------
  function selectCoins(utxos, target, feeRate, net, vbytesOf) {
    const sorted = utxos.slice().sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    const chosen = [];
    let sum = 0n, inVbytes = 0;
    const defaultIn = net.segwit ? 68 : 148; // approx per-input vsize
    const base = 10 + 34;                   // header + one output
    for (const u of sorted) {
      chosen.push(u);
      sum += BigInt(u.value);
      inVbytes += (vbytesOf ? vbytesOf(u) : defaultIn);
      const vbytes = base + inVbytes + 34; // + change output
      const fee = BigInt(Math.ceil(vbytes * feeRate));
      if (sum >= BigInt(target) + fee) return { chosen, fee, sum };
    }
    const vbytes = base + inVbytes;
    const fee = BigInt(Math.ceil(vbytes * feeRate));
    if (sum >= BigInt(target) + fee) return { chosen, fee, sum };
    throw new Error('insufficient funds');
  }

  // ---- sign a full send ----------------------------------------------------
  // keyOf: an HD node {privateKey, publicKey} (every input is the account's
  //        own P2WPKH / P2PKH), or a resolver utxo -> {node, type} for imported
  //        key sets where each input may be owned by a different key and script
  //        type ('p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh').
  // req = {to, amount(base), feeRate(sat/vB), utxos:[{txid,vout,value,address?}]}
  const IN_VBYTES = { p2wpkh: 68, 'p2sh-p2wpkh': 91, p2pkh: 148, 'p2pkh-forkid': 148 };
  function buildAndSign(net, keyOf, fromAddress, req) {
    const SIGHASH_ALL = 0x01;
    const FORKID_ALL = 0x41; // SIGHASH_ALL | SIGHASH_FORKID (forkID 0)
    const defaultType = net.forkId ? 'p2pkh-forkid' : (net.segwit ? 'p2wpkh' : 'p2pkh');
    const resolve = typeof keyOf === 'function' ? keyOf : () => ({ node: keyOf, type: defaultType });
    const feeRate = Number(req.feeRate || 10);
    const { chosen, fee } = selectCoins(req.utxos, BigInt(req.amount), feeRate, net, (u) => IN_VBYTES[(resolve(u) || {}).type] || IN_VBYTES[defaultType]);
    const inSum = chosen.reduce((a, u) => a + BigInt(u.value), 0n);
    const change = inSum - BigInt(req.amount) - fee;

    const outputs = [{ script: addressToScript(req.to, net), value: BigInt(req.amount) }];
    if (change > 546n) outputs.push({ script: addressToScript(fromAddress, net), value: change });

    const inputs = chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), sequence: 0xffffffff }));
    const version = 1, locktime = 0;
    const signedInputs = [];
    let hasWitness = false;

    chosen.forEach((u, i) => {
      const k = resolve(u);
      if (!k || !k.node || !k.node.privateKey) throw new Error('no key for input ' + u.txid + ':' + u.vout);
      const type = k.type || defaultType;
      const pub = k.node.publicKey;
      const h160 = C.hash160(pub);
      let sh, scriptSig, witness;
      if (type === 'p2pkh-forkid') {
        // BCH: BIP143 preimage (reuse sighashSegwit) with hashType 0x41 and a
        // legacy P2PKH scriptSig; NO witness, NO segwit marker. MUST win over
        // the plain-legacy branch below (segwit is false for BCH).
        sh = sighashSegwit(version, inputs, outputs, i, p2pkhScript(h160), BigInt(u.value), 0xffffffff, locktime, FORKID_ALL);
        const sig = S.sign(sh, k.node.privateKey);
        const sigPlusType = C.concatBytes(sig.der, Uint8Array.of(FORKID_ALL));
        scriptSig = C.concatBytes(pushData(sigPlusType), pushData(pub));
        signedInputs.push({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, scriptSig, witness: null, _sh: sh, _sig: sig });
      } else if (type === 'p2wpkh' || type === 'p2sh-p2wpkh') {
        if (!net.segwit) throw new Error(net.id + ' has no segwit');
        sh = sighashSegwit(version, inputs, outputs, i, p2pkhScript(h160), BigInt(u.value), 0xffffffff, locktime, SIGHASH_ALL);
        const sig = S.sign(sh, k.node.privateKey);
        const sigPlusType = C.concatBytes(sig.der, Uint8Array.of(SIGHASH_ALL));
        witness = [sigPlusType, pub];
        // wrapped segwit spends push the P2WPKH redeem script in scriptSig
        scriptSig = type === 'p2sh-p2wpkh' ? pushData(p2wpkhScript(h160)) : new Uint8Array(0);
        hasWitness = true;
        signedInputs.push({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, scriptSig, witness, _sh: sh, _sig: sig });
      } else {
        sh = sighashLegacy(version, inputs, outputs, i, p2pkhScript(h160), locktime, SIGHASH_ALL);
        const sig = S.sign(sh, k.node.privateKey);
        const sigPlusType = C.concatBytes(sig.der, Uint8Array.of(SIGHASH_ALL));
        scriptSig = C.concatBytes(pushData(sigPlusType), pushData(pub));
        signedInputs.push({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, scriptSig, witness: null, _sh: sh, _sig: sig });
      }
    });
    const rawBytes = serializeTx(version, signedInputs, outputs, locktime, hasWitness);
    const txid = txidOf(version, signedInputs, outputs, locktime);
    return { raw: C.bytesToHex(rawBytes), txid, fee: fee.toString(), change: change.toString(), signedInputs, outputs, sighashes: signedInputs.map((s) => C.bytesToHex(s._sh)) };
  }

  function createUtxoAdapter(netOrId, opts) {
    opts = opts || {};
    const net = typeof netOrId === 'string' ? NETWORKS[netOrId] : netOrId;
    if (!net) throw new Error('unknown network');
    const id = net.id;
    const native = { chain: id, kind: 'native', symbol: net.symbol, decimals: net.decimals };
    let rootSeed = null;
    // Imported key set for this account (wallet.dat / WIF): every key with the
    // address types it may own, plus the tracked addresses to poll and spend.
    // { keys:[{node, compressed, types}], track:[{address, type, key}], primary, byAddress:Map }
    let imported = null;
    let watchAddr = null;
    function buildImported(spec) {
      if (!spec || !Array.isArray(spec.keys) || !spec.keys.length) return null;
      const keys = spec.keys.map((k) => {
        const priv = C.toBytes(k.priv);
        return { node: { privateKey: priv, publicKey: S.publicKey(priv, k.compressed !== false) }, compressed: k.compressed !== false, types: k.types || [] };
      });
      let track = Array.isArray(spec.track) ? spec.track.slice() : [];
      if (!track.length) {
        // default: every address type of the first key
        for (const a of addressesOf(keys[0])) track.push({ address: a.address, type: a.type, key: 0 });
      }
      const byAddress = new Map();
      for (const t of track) if (keys[t.key]) byAddress.set(t.address, t);
      return { keys, track, byAddress, primary: track[0].address };
    }
    function addressesOf(k) {
      const out = [];
      const pub = k.node.publicKey;
      // BCH: CashAddr P2PKH is the PRIMARY (display/receive); legacy base58 P2PKH
      // is tracked as an alt so imported keys + legacy-only indexers still resolve.
      // Both are the same key under the FORKID signing type.
      if (net.cashaddr) {
        out.push({ type: 'p2pkh-forkid', address: Addr.cashAddrP2pkh(pub, net.cashaddr) });
        out.push({ type: 'p2pkh-forkid', address: Addr.p2pkh(pub, net.p2pkh) });
        return out;
      }
      if (net.segwit && k.compressed) {
        out.push({ type: 'p2wpkh', address: Addr.p2wpkh(pub, net.hrp) });
        const redeem = p2wpkhScript(C.hash160(pub));
        out.push({ type: 'p2sh-p2wpkh', address: C.base58checkEncode(C.concatBytes(Uint8Array.of(net.p2sh), C.hash160(redeem))) });
      }
      out.push({ type: 'p2pkh', address: Addr.p2pkh(pub, net.p2pkh) });
      return out;
    }
    function resolveRoot(root) {
      if (!root) return { seed: rootSeed, imported, watch: watchAddr };
      if (root instanceof Uint8Array) return { seed: root, imported: null, watch: null };
      return { seed: root.seed || null, imported: buildImported(root.keys && root.keys[id]), watch: (root.watch && root.watch[id]) || null };
    }
    // run `fn` over `items` with bounded concurrency
    async function pmap(items, limit, fn) {
      const out = new Array(items.length); let i = 0;
      async function worker() { while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); } }
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
      return out;
    }
    const getEndpoint = opts.endpoint || (async () => opts.esplora || net.esplora);

    async function api(path, init) {
      const base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      if (!base) throw new Error(id + ': no endpoint configured');
      const r = await fetch(base + path, init);
      if (!r.ok) throw new Error(id + ' api ' + r.status);
      return r;
    }
    function nodeFor(index) {
      if (imported) return imported.keys[0].node;
      if (!rootSeed) throw new Error(watchAddr ? 'watch-only account: no key to sign with' : 'locked');
      return HD.derivePath(rootSeed, net.path + '/' + (index || 0));
    }
    function addressOf(node) {
      if (net.cashaddr) return Addr.cashAddrP2pkh(node.publicKey, net.cashaddr);
      return net.segwit ? Addr.p2wpkh(node.publicKey, net.hrp) : Addr.p2pkh(node.publicKey, net.p2pkh);
    }

    return {
      id, native, network: net,
      unlock(root) { const r = resolveRoot(root || {}); rootSeed = r.seed; imported = r.imported; watchAddr = r.watch; },
      lock() { rootSeed = null; imported = null; watchAddr = null; },

      // BTC/LTC/DOGE are coin-only — there are no on-chain tokens to detect.
      async discoverTokens() { return []; },

      async deriveAccount(root, index) {
        const r = resolveRoot(root);
        if (r.imported) {
          const k = r.imported.keys[r.imported.byAddress.get(r.imported.primary).key];
          return {
            chain: id, index: 0, address: r.imported.primary, addresses: r.imported.track.map((t) => t.address),
            publicKey: C.bytesToHex(k.node.publicKey), scheme: 'secp256k1', path: null, imported: true,
          };
        }
        if (r.watch) return { chain: id, index: 0, address: r.watch, publicKey: '', scheme: 'secp256k1', path: null, watchOnly: true };
        const seed = r.seed;
        if (!seed) throw new Error('no root seed');
        const node = HD.derivePath(seed, net.path + '/' + (index || 0));
        return {
          chain: id, index: index || 0, address: addressOf(node),
          publicKey: C.bytesToHex(node.publicKey),
          scheme: 'secp256k1', path: net.path + '/' + (index || 0),
        };
      },

      // The set of addresses `address` stands for: an imported key set's primary
      // address aggregates every tracked address; anything else is itself.
      addressSet(address) {
        if (imported && address === imported.primary) return imported.track.map((t) => t.address);
        return [address];
      },

      async addressBalance(address) {
        const r = await api('/address/' + address);
        const j = await r.json();
        const cs = j.chain_stats || {};
        return BigInt(cs.funded_txo_sum || 0) - BigInt(cs.spent_txo_sum || 0);
      },

      async getBalance(address) {
        try {
          const set = this.addressSet(address);
          const parts = await pmap(set, 6, (a) => this.addressBalance(a));
          const confirmed = parts.reduce((s, v) => s + v, 0n).toString();
          return [{ asset: native, confirmed, spendable: confirmed, display: fmt(confirmed, net.decimals) }];
        } catch (e) {
          return [{ asset: native, confirmed: '0', display: '—', error: String(e.message || e) }];
        }
      },

      async utxos(address) {
        const set = this.addressSet(address);
        const lists = await pmap(set, 6, async (a) => {
          const r = await api('/address/' + a + '/utxo');
          const j = await r.json();
          return j.map((u) => ({ txid: u.txid, vout: u.vout, value: String(u.value), address: a }));
        });
        return [].concat(...lists);
      },

      async buildSend(account, req) {
        if (!rootSeed && !imported) throw new Error(watchAddr ? 'watch-only account' : 'locked');
        let keyOf, from;
        if (imported) {
          from = account.address || imported.primary;
          keyOf = (u) => {
            const t = imported.byAddress.get(u.address || from);
            return t ? { node: imported.keys[t.key].node, type: t.type } : null;
          };
        } else {
          const node = nodeFor(account.index);
          from = account.address || addressOf(node);
          keyOf = node;
        }
        const utxos = req.utxos || (await this.utxos(from));
        const built = buildAndSign(net, keyOf, from, { ...req, utxos });
        return { chain: id, raw: built.raw, txid: built.txid, fee: built.fee, summary: req };
      },

      async broadcast(tx) {
        const r = await api('/tx', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: tx.raw });
        const txid = (await r.text()).trim();
        return { txid, accepted: true };
      },

      explorerTx(txid) { return net.explorer + txid; },
    };
  }

  function fmt(baseStr, decimals) {
    const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
    const i = s.slice(0, s.length - decimals);
    const f = s.slice(s.length - decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  const API = {
    NETWORKS, createUtxoAdapter,
    // exported for tests:
    varint, u64le, u32le, pushData, addressToScript,
    p2wpkhScript, p2pkhScript, sighashSegwit, sighashLegacy, serializeTx, txidOf,
    selectCoins, buildAndSign, fmt,
  };
  global.UtxoAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
