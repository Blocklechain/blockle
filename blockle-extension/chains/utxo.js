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
    dogecoin: { id: 'dogecoin', symbol: 'DOGE', decimals: 8, hrp: null, p2pkh: 0x1e, p2sh: 0x16, wif: 0x9e, segwit: false, path: "m/44'/3'/0'/0",  explorer: 'https://blockchair.com/dogecoin/transaction/',  esplora: null },
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
  function selectCoins(utxos, target, feeRate, net) {
    const sorted = utxos.slice().sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    const chosen = [];
    let sum = 0n;
    const inVbytes = net.segwit ? 68 : 148; // approx per-input vsize
    const base = 10 + 34;                   // header + one output
    for (const u of sorted) {
      chosen.push(u);
      sum += BigInt(u.value);
      const vbytes = base + chosen.length * inVbytes + 34; // + change output
      const fee = BigInt(Math.ceil(vbytes * feeRate));
      if (sum >= BigInt(target) + fee) return { chosen, fee, sum };
    }
    const vbytes = base + chosen.length * inVbytes;
    const fee = BigInt(Math.ceil(vbytes * feeRate));
    if (sum >= BigInt(target) + fee) return { chosen, fee, sum };
    throw new Error('insufficient funds');
  }

  // ---- sign a full send ----------------------------------------------------
  // account = {node(HD node w/ privateKey,publicKey), address}
  // req = {to, amount(base), feeRate(sat/vB), utxos:[{txid,vout,value}]}
  function buildAndSign(net, node, fromAddress, req) {
    const SIGHASH_ALL = 0x01;
    const pub = node.publicKey;
    const ownH160 = C.hash160(pub);
    const feeRate = Number(req.feeRate || 10);
    const { chosen, fee } = selectCoins(req.utxos, BigInt(req.amount), feeRate, net);
    const inSum = chosen.reduce((a, u) => a + BigInt(u.value), 0n);
    const change = inSum - BigInt(req.amount) - fee;

    const outputs = [{ script: addressToScript(req.to, net), value: BigInt(req.amount) }];
    if (change > 546n) outputs.push({ script: addressToScript(fromAddress, net), value: change });

    const inputs = chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), sequence: 0xffffffff }));
    const version = 1, locktime = 0;
    const signedInputs = [];

    if (net.segwit) {
      const scriptCode = p2pkhScript(ownH160); // BIP143 scriptCode for P2WPKH
      chosen.forEach((u, i) => {
        const sh = sighashSegwit(version, inputs, outputs, i, scriptCode, BigInt(u.value), 0xffffffff, locktime, SIGHASH_ALL);
        const sig = S.sign(sh, node.privateKey);
        const sigPlusType = C.concatBytes(sig.der, Uint8Array.of(SIGHASH_ALL));
        signedInputs.push({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, scriptSig: new Uint8Array(0), witness: [sigPlusType, pub], _sh: sh, _sig: sig });
      });
    } else {
      const subScript = p2pkhScript(ownH160);
      chosen.forEach((u, i) => {
        const sh = sighashLegacy(version, inputs, outputs, i, subScript, locktime, SIGHASH_ALL);
        const sig = S.sign(sh, node.privateKey);
        const sigPlusType = C.concatBytes(sig.der, Uint8Array.of(SIGHASH_ALL));
        const scriptSig = C.concatBytes(pushData(sigPlusType), pushData(pub));
        signedInputs.push({ txid: u.txid, vout: u.vout, sequence: 0xffffffff, scriptSig, witness: null, _sh: sh, _sig: sig });
      });
    }
    const rawBytes = serializeTx(version, signedInputs, outputs, locktime, net.segwit);
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
    const getEndpoint = opts.endpoint || (async () => opts.esplora || net.esplora);

    async function api(path, init) {
      const base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      if (!base) throw new Error(id + ': no endpoint configured');
      const r = await fetch(base + path, init);
      if (!r.ok) throw new Error(id + ' api ' + r.status);
      return r;
    }
    function nodeFor(index) {
      if (!rootSeed) throw new Error('locked');
      return HD.derivePath(rootSeed, net.path + '/' + (index || 0));
    }
    function addressOf(node) {
      return net.segwit ? Addr.p2wpkh(node.publicKey, net.hrp) : Addr.p2pkh(node.publicKey, net.p2pkh);
    }

    return {
      id, native, network: net,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = HD.derivePath(seed, net.path + '/' + (index || 0));
        return {
          chain: id, index: index || 0, address: addressOf(node),
          publicKey: C.bytesToHex(node.publicKey),
          scheme: 'secp256k1', path: net.path + '/' + (index || 0),
        };
      },

      async getBalance(address) {
        try {
          const r = await api('/address/' + address);
          const j = await r.json();
          const cs = j.chain_stats || {};
          const confirmed = (BigInt(cs.funded_txo_sum || 0) - BigInt(cs.spent_txo_sum || 0)).toString();
          return [{ asset: native, confirmed, spendable: confirmed, display: fmt(confirmed, net.decimals) }];
        } catch (e) {
          return [{ asset: native, confirmed: '0', display: '—', error: String(e.message || e) }];
        }
      },

      async utxos(address) {
        const r = await api('/address/' + address + '/utxo');
        const j = await r.json();
        return j.map((u) => ({ txid: u.txid, vout: u.vout, value: String(u.value) }));
      },

      async buildSend(account, req) {
        if (!rootSeed) throw new Error('locked');
        const node = nodeFor(account.index);
        const from = account.address || addressOf(node);
        const utxos = req.utxos || (await this.utxos(from));
        const built = buildAndSign(net, node, from, { ...req, utxos });
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
