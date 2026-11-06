// chains/cardano.js — the Cardano (ADA) ChainAdapter. v1: native ADA transfer
// (build + sign + submit) + balance reads (native-asset amounts surfaced for
// DISPLAY only). Native-asset (CNT) SENDING is OUT of scope (min-ADA +
// multi-asset bundling is a v2 follow-up — we never fake it).
//
// • KEY: Icarus (CIP-3) master key from the BIP39 ENTROPY + CIP-1852
//   BIP32-Ed25519 (chains/cardano-crypto.js). payment = m/1852'/1815'/0'/0/0,
//   stake = m/1852'/1815'/0'/2/0. NOT SLIP-0010. The extension has no BIP39
//   mnemonic — its HD root is the 32-byte Wallet.seedHex (seedFromBlock); we
//   feed those 32 bytes AS the Icarus entropy input. That is self-consistent +
//   reproducible within Blockle but NOT interoperable with Daedalus/Yoroi (which
//   need a real BIP39 mnemonic). A real mnemonic (Qt/Flutter, or a web
//   imported-mnemonic account) yields canonical, interoperable CIP-3 keys; pass
//   it as root.entropy.
// • ADDRESS: Shelley base, mainnet — header 0x01 || blake2b224(paymentPub)(28)
//   || blake2b224(stakePub)(28); bech32 hrp 'addr' => addr1…
// • TX: canonical CBOR (chains/cardano-cbor.js); txHash = blake2b256(tx_body);
//   witness = ed25519-BIP32 signExtended over txHash. CLIENT-BUILT +
//   CLIENT-SIGNED (fund-safety) like Tezos/TON/Stellar.
// • PROVIDER: config-overridable. Default KEYLESS Koios
//   (https://api.koios.rest/api/v1); Blockfrost when a projectId is configured.
// • ADA = lovelace, 6 decimals. fee = 44*size + 155381. Explorer cardanoscan.io.
//
// NOT post-quantum — Ed25519/BIP32-Ed25519 is classical EC crypto.
//
// Global `CardanoAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const ED = inNode ? require('../ed25519.js') : global.Ed25519;
  const CC = inNode ? require('./cardano-crypto.js') : global.CardanoCrypto;
  const CBOR = inNode ? require('./cardano-cbor.js') : global.CardanoCbor;

  const LOVELACE = 1_000_000;                 // 1 ADA = 1e6 lovelace (6 decimals)
  const DEFAULT_KOIOS = 'https://api.koios.rest/api/v1';
  const DEFAULT_EXPLORER = 'https://cardanoscan.io/transaction/';
  const MIN_FEE_A = 44;
  const MIN_FEE_B = 155381;
  // Conservative min-UTXO for a simple output (Babbage coinsPerUTxOByte); a
  // self-change output below this is dropped into the fee instead.
  const MIN_UTXO = 1_000_000n;
  const PAYMENT_PATH = "m/1852'/1815'/0'/0";   // + '/' + index
  const STAKE_PATH = "m/1852'/1815'/0'/2/0";
  const ADDR_HRP = 'addr';
  const ADDR_HEADER = 0x01;                    // type 0 (base) + network 1 (mainnet)

  // ---- bech32 (plain, no segwit witver, no 90-char cap) --------------------
  // Self-contained (encode + decode) so address validation works in node tests
  // and the browser identically. Mirrors BIP-173 with checksum const ^1.
  const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function b32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const b = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  }
  function b32HrpExpand(hrp) {
    const ret = [];
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
    ret.push(0);
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
    return ret;
  }
  function b32Checksum(hrp, data) {
    const values = b32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    const mod = b32Polymod(values) ^ 1;
    const ret = [];
    for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 31);
    return ret;
  }
  function convertBits(data, from, to, pad) {
    let acc = 0, bits = 0;
    const ret = [];
    const maxv = (1 << to) - 1;
    for (const value of data) {
      acc = (acc << from) | value;
      bits += from;
      while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); }
    }
    if (pad) { if (bits > 0) ret.push((acc << (to - bits)) & maxv); }
    else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
    return ret;
  }
  function bech32Encode(hrp, bytes) {
    const data = convertBits(Array.from(C.toBytes(bytes)), 8, 5, true);
    const combined = data.concat(b32Checksum(hrp, data));
    let ret = hrp + '1';
    for (const d of combined) ret += B32_CHARSET[d];
    return ret;
  }
  function bech32Decode(str) {
    const s = String(str);
    const pos = s.lastIndexOf('1');
    if (pos < 1 || pos + 7 > s.length) return null;
    const hrp = s.slice(0, pos);
    const dataPart = s.slice(pos + 1);
    const data = [];
    for (const ch of dataPart) {
      const d = B32_CHARSET.indexOf(ch);
      if (d === -1) return null;
      data.push(d);
    }
    const values = b32HrpExpand(hrp).concat(data);
    if (b32Polymod(values) !== 1) return null;
    const payload = data.slice(0, data.length - 6);
    const bytes = convertBits(payload, 5, 8, false);
    if (!bytes) return null;
    return { hrp, bytes: Uint8Array.from(bytes) };
  }

  // ---- address ------------------------------------------------------------
  function blake2b224(b) { return C.blake2b(b, 28); }
  function blake2b256(b) { return C.blake2b(b, 32); }

  function addressBytes(paymentPub32, stakePub32) {
    const payCred = blake2b224(paymentPub32);
    const stakeCred = blake2b224(stakePub32);
    return C.concatBytes(Uint8Array.of(ADDR_HEADER), payCred, stakeCred);
  }
  function addressFromPubkeys(paymentPub32, stakePub32) {
    return bech32Encode(ADDR_HRP, addressBytes(paymentPub32, stakePub32));
  }
  // Validate a mainnet Shelley base address (addr1…): bech32 ok, hrp 'addr',
  // header 0x01, 57-byte payload.
  function isCardanoAddress(addr) {
    try {
      const dec = bech32Decode(addr);
      if (!dec || dec.hrp !== ADDR_HRP) return false;
      if (dec.bytes.length !== 57) return false;
      if (dec.bytes[0] !== ADDR_HEADER) return false;
      return true;
    } catch { return false; }
  }
  function addressToBytes(addr) {
    const dec = bech32Decode(addr);
    if (!dec || dec.hrp !== ADDR_HRP || dec.bytes.length !== 57 || dec.bytes[0] !== ADDR_HEADER) {
      throw new Error('cardano: invalid addr1 address: ' + addr);
    }
    return dec.bytes;
  }

  // ---- derivation ---------------------------------------------------------
  // entropy = BIP39 entropy bytes (Qt/Flutter) OR the 32-byte seedFromBlock
  // (extension / web-main). Returns { payment:node, stake:node }.
  function deriveFromEntropy(entropy, index) {
    const master = CC.icarusMasterKey(entropy);
    const payment = CC.derivePathFromMaster(master, PAYMENT_PATH + '/' + (index || 0));
    const stake = CC.derivePathFromMaster(master, STAKE_PATH);
    return { payment, stake };
  }

  function formatUnits(baseStr, decimals) {
    const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
    const i = s.slice(0, s.length - decimals);
    const f = s.slice(s.length - decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  // Decode an asset-name hex to printable ASCII (a CNT's ticker), else null.
  function hexToUtf8Printable(hex) {
    const h = String(hex || '');
    if (!h || h.length % 2) return null;
    let s = '';
    for (let i = 0; i < h.length; i += 2) {
      const c = parseInt(h.slice(i, i + 2), 16);
      if (!(c >= 0x20 && c <= 0x7e)) return null;
      s += String.fromCharCode(c);
    }
    return s || null;
  }
  // A display symbol for a native-asset: the utf8 asset name if printable, else a
  // shortened unit (policyId+assetNameHex).
  function assetSymbol(assetNameHex, unit) {
    const dec = hexToUtf8Printable(assetNameHex);
    if (dec) return dec;
    const u = String(unit || '');
    return u.length > 12 ? u.slice(0, 6) + '…' + u.slice(-4) : u;
  }

  // ---- tx build + sign (pure, offline) ------------------------------------
  // inputs:  [{ txHashHex, index }]
  // outputs: [{ address:'addr1…', coin:'lovelace' }]
  // paymentNode: the BIP32-Ed25519 payment node { kL, kR, A }.
  // Returns { bodyHex, txHashHex, vkeyHex, signatureHex, signedTxHex }.
  function buildSignedTransaction(params, paymentNode) {
    const inputs = params.inputs.map((i) => ({ txHashHex: i.txHashHex || i.txHash, index: i.index || 0 }));
    const outputs = params.outputs.map((o) => ({
      addressBytes: addressToBytes(o.address),
      coin: BigInt(o.coin),
    }));
    const body = CBOR.txBody(inputs, outputs, BigInt(params.fee), BigInt(params.ttl));
    const txHash = blake2b256(body);
    const vkey = paymentNode.A;
    const sig = ED.signExtended(txHash, paymentNode.kL, paymentNode.kR, vkey);
    const wset = CBOR.witnessSet([{ vkey, sig }]);
    const signed = CBOR.signedTx(body, wset);
    return {
      bodyHex: C.bytesToHex(body),
      txHashHex: C.bytesToHex(txHash),
      vkeyHex: C.bytesToHex(vkey),
      signatureHex: C.bytesToHex(sig),
      signedTxHex: C.bytesToHex(signed),
    };
  }

  // fee = a*size + b over the SERIALIZED signed-tx size.
  function feeForSize(sizeBytes, a, b) { return BigInt(a) * BigInt(sizeBytes) + BigInt(b); }

  function createCardanoAdapter(opts) {
    opts = opts || {};
    const id = 'cardano';
    const explorer = opts.explorer || DEFAULT_EXPLORER;
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'ADA', decimals: 6 };
    const feeA = opts.minFeeA != null ? opts.minFeeA : MIN_FEE_A;
    const feeB = opts.minFeeB != null ? opts.minFeeB : MIN_FEE_B;
    const ttlDelta = opts.ttlDelta != null ? opts.ttlDelta : 7200; // ~2h of slots
    let entropy = null;                 // Icarus entropy (in-memory only)

    const koios = String(opts.koios || DEFAULT_KOIOS).replace(/\/+$/, '');
    const blockfrost = opts.blockfrost && opts.blockfrost.projectId ? {
      url: String(opts.blockfrost.url || 'https://cardano-mainnet.blockfrost.io/api/v0').replace(/\/+$/, ''),
      projectId: opts.blockfrost.projectId,
    } : null;

    const httpGet = opts.httpGet || (async (url, headers) => { const r = await fetch(url, { headers: headers || {} }); return await r.text(); });
    const httpPost = opts.httpPost || (async (url, body, headers) => {
      const r = await fetch(url, { method: 'POST', headers: headers || { 'content-type': 'application/json' }, body });
      return await r.text();
    });

    function rootEntropy(root) {
      if (!root) return null;
      if (root.entropy) return C.toBytes(root.entropy);     // real BIP39 entropy (canonical CIP-3)
      if (root.seed) return C.toBytes(root.seed);           // 32-byte seedFromBlock (extension/web-main)
      return C.toBytes(root);
    }

    // ---- provider reads ----------------------------------------------------
    // UTXOs for an address -> [{ txHashHex, index, lovelace, assets:[{unit,quantity}] }]
    async function fetchUtxos(address) {
      if (blockfrost) {
        const raw = await httpGet(blockfrost.url + '/addresses/' + encodeURIComponent(address) + '/utxos', { project_id: blockfrost.projectId });
        const arr = JSON.parse(raw);
        return (Array.isArray(arr) ? arr : []).map((u) => {
          const lov = (u.amount || []).find((a) => a.unit === 'lovelace');
          const assets = (u.amount || []).filter((a) => a.unit !== 'lovelace').map((a) => ({ unit: a.unit, quantity: a.quantity }));
          return { txHashHex: u.tx_hash, index: u.output_index, lovelace: lov ? lov.quantity : '0', assets };
        });
      }
      const raw = await httpPost(koios + '/address_utxos', JSON.stringify({ _addresses: [address] }), { 'content-type': 'application/json' });
      const arr = JSON.parse(raw);
      return (Array.isArray(arr) ? arr : []).map((u) => ({
        txHashHex: u.tx_hash,
        index: u.tx_index,
        lovelace: String(u.value || '0'),
        assets: (u.asset_list || []).map((a) => ({ unit: (a.policy_id || '') + (a.asset_name || ''), quantity: String(a.quantity), policyId: a.policy_id, assetName: a.asset_name })),
      }));
    }

    async function fetchTipSlot() {
      if (blockfrost) {
        const raw = await httpGet(blockfrost.url + '/blocks/latest', { project_id: blockfrost.projectId });
        return Number(JSON.parse(raw).slot || 0);
      }
      const raw = await httpGet(koios + '/tip');
      const arr = JSON.parse(raw);
      const row = Array.isArray(arr) ? arr[0] : arr;
      return Number((row && (row.abs_slot != null ? row.abs_slot : row.slot)) || 0);
    }

    async function submit(signedTxBytes) {
      if (blockfrost) {
        const res = await httpPost(blockfrost.url + '/tx/submit', signedTxBytes, { 'content-type': 'application/cbor', project_id: blockfrost.projectId });
        return String(res).trim().replace(/^"|"$/g, '');
      }
      const res = await httpPost(koios + '/submittx', signedTxBytes, { 'content-type': 'application/cbor' });
      return String(res).trim().replace(/^"|"$/g, '');
    }

    function nodesFor(index) {
      if (!entropy) throw new Error('locked');
      return deriveFromEntropy(entropy, index || 0);
    }

    return {
      id, native, scheme: 'ed25519-bip32', lovelace: LOVELACE,
      unlock(root) { entropy = rootEntropy(root); },
      lock() { entropy = null; },

      async deriveAccount(root, index) {
        const ent = entropy || rootEntropy(root);
        if (!ent) throw new Error('no root entropy');
        const master = CC.icarusMasterKey(ent);
        const payment = CC.derivePathFromMaster(master, PAYMENT_PATH + '/' + (index || 0));
        const stake = CC.derivePathFromMaster(master, STAKE_PATH);
        return {
          chain: id, index: index || 0,
          address: addressFromPubkeys(payment.A, stake.A),
          publicKey: C.bytesToHex(payment.A),
          stakeKey: C.bytesToHex(stake.A),
          scheme: 'ed25519-bip32',
          path: PAYMENT_PATH + '/' + (index || 0),
        };
      },

      // Native ADA confirmed balance + native-asset amounts (DISPLAY only).
      async getBalance(address) {
        const out = [];
        try {
          const utxos = await fetchUtxos(address);
          let lovelace = 0n;
          const assetMap = {}; // unit -> { quantity, policyId, assetName }
          for (const u of utxos) {
            lovelace += BigInt(u.lovelace || '0');
            for (const a of (u.assets || [])) {
              const prev = assetMap[a.unit] || { quantity: 0n, policyId: a.policyId, assetName: a.assetName };
              prev.quantity += BigInt(a.quantity || '0');
              assetMap[a.unit] = prev;
            }
          }
          out.push({ asset: native, confirmed: lovelace.toString(), display: formatUnits(lovelace.toString(), 6) });
          for (const unit of Object.keys(assetMap)) {
            const a = assetMap[unit];
            out.push({
              asset: { chain: id, kind: 'native-asset', unit, policyId: a.policyId, assetName: a.assetName, displayOnly: true },
              confirmed: a.quantity.toString(), display: a.quantity.toString(),
            });
          }
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        return out;
      },

      // Held native-assets (CNTs) aggregated from the account's UTXOs. Reuses the
      // SAME provider read getBalance uses. DISPLAY-ONLY (decimals 0, displayOnly
      // true) — no send path in v1. Keyed by unit (policyId+assetNameHex).
      // Read-only, best-effort, never throws.
      async discoverTokens(address) {
        try {
          const utxos = await fetchUtxos(address);
          const assetMap = {}; // unit -> { quantity, policyId, assetName }
          for (const u of utxos) {
            for (const a of (u.assets || [])) {
              const prev = assetMap[a.unit] || { quantity: 0n, policyId: a.policyId, assetName: a.assetName };
              prev.quantity += BigInt(a.quantity || '0');
              assetMap[a.unit] = prev;
            }
          }
          const out = [];
          for (const unit of Object.keys(assetMap)) {
            const a = assetMap[unit];
            if (a.quantity <= 0n) continue;
            out.push({
              chain: id, kind: 'native-asset', address: unit,
              symbol: assetSymbol(a.assetName, unit), decimals: 0,
              balance: a.quantity.toString(), display: a.quantity.toString(),
              displayOnly: true,
            });
          }
          return out;
        } catch { return []; }
      },

      // CLIENT-BUILT + CLIENT-SIGNED native ADA transfer. req: { to, amount
      // (lovelace), index? }. UTXOs + tip come from the provider (verifiable);
      // everything signed is built locally. Coin selection: largest-first UTXOs
      // covering amount + fee, change back to self (dropped into fee if below
      // the min-UTXO).
      async buildSend(account, req) {
        if (!entropy) throw new Error('locked');
        if (!req || !req.to || req.amount == null) throw new Error('cardano: to + amount required');
        if (!isCardanoAddress(req.to)) throw new Error('cardano: invalid destination address ' + req.to);
        const index = (account && account.index) || 0;
        const { payment, stake } = nodesFor(index);
        const self = (account && account.address) || addressFromPubkeys(payment.A, stake.A);
        const amount = BigInt(req.amount);
        if (amount <= 0n) throw new Error('cardano: amount must be positive');

        const utxos = await fetchUtxos(self);
        if (!utxos.length) throw new Error('cardano: no spendable UTXOs');
        utxos.sort((a, b) => (BigInt(b.lovelace) > BigInt(a.lovelace) ? 1 : -1));
        const tip = await fetchTipSlot();
        const ttl = tip + ttlDelta;

        // Iterate fee <-> size <-> change to a stable solution.
        let fee = feeForSize(250, feeA, feeB); // seed estimate
        let selected = [];
        let picked = 0n;
        let built = null;
        for (let iter = 0; iter < 8; iter++) {
          // (re)select enough inputs to cover amount + fee
          selected = [];
          picked = 0n;
          for (const u of utxos) {
            selected.push(u);
            picked += BigInt(u.lovelace);
            if (picked >= amount + fee) break;
          }
          if (picked < amount + fee) throw new Error('cardano: insufficient funds (need ' + (amount + fee) + ', have ' + picked + ')');
          let change = picked - amount - fee;
          const outputs = [{ address: req.to, coin: amount.toString() }];
          if (change >= MIN_UTXO) {
            outputs.push({ address: self, coin: change.toString() });
          } else {
            // fold dust change into the fee (no change output)
            fee = picked - amount;
            change = 0n;
          }
          built = buildSignedTransaction({
            inputs: selected.map((u) => ({ txHashHex: u.txHashHex, index: u.index })),
            outputs, fee, ttl,
          }, payment);
          const size = built.signedTxHex.length / 2;
          const needFee = feeForSize(size, feeA, feeB);
          if (needFee === fee) break;
          fee = needFee;
        }

        return {
          chain: id, kind: 'send', raw: built.signedTxHex, txid: built.txHashHex, needsSign: false,
          summary: {
            from: self, to: req.to, amount: amount.toString(), asset: native.symbol,
            fee: fee.toString(), ttl, inputs: selected.length, txHash: built.txHashHex,
          },
        };
      },

      // Already built + signed by buildSend; submit the raw CBOR bytes.
      async broadcast(tx) {
        const hex = (tx && (tx.raw || tx.signedTxHex)) || tx;
        const txid = await submit(C.hexToBytes(hex));
        return { txid: txid || (tx && tx.txid) || null, accepted: !!txid, raw: txid };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  const API = {
    createCardanoAdapter, buildSignedTransaction,
    deriveFromEntropy, addressFromPubkeys, addressBytes, isCardanoAddress, addressToBytes,
    bech32Encode, bech32Decode, blake2b224, blake2b256, formatUnits, feeForSize,
    PAYMENT_PATH, STAKE_PATH, DEFAULT_KOIOS, DEFAULT_EXPLORER, LOVELACE, MIN_FEE_A, MIN_FEE_B,
  };
  global.CardanoAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
