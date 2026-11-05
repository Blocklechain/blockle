// chains/tron.js — the Tron (TRX + TRC-20) ChainAdapter.
//
// • secp256k1 account at BIP44 m/44'/195'/0'/0/index — the SAME curve + HD lib
//   the wallet already uses for EVM/BTC. No new crypto.
// • address = base58check( 0x41 || keccak256(uncompressedPub[1:])[-20:] ) => 'T…'
//   (the EVM keccak-of-pubkey body, but a 0x41 version byte + base58check).
// • native TRX (6 decimals) + TRC-20 (USDT @ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t)
//   balances + sends.
// • TX FLOW keeps keys LOCAL and avoids reimplementing the Tron protobuf: the
//   NODE (TronGrid REST) ASSEMBLES the unsigned tx (createtransaction /
//   triggersmartcontract) and returns { txID, raw_data, raw_data_hex }. Before
//   signing, the client DECODES the node-returned raw_data protobuf and ASSERTS
//   it encodes EXACTLY the transfer buildSend() was asked for (owner==us, to==
//   requested recipient, amount==requested; for TRC-20: token contract, zero
//   call_value, and the transfer(address,uint256) calldata we built locally).
//   Only then does it sign the 32-byte txID with the existing secp256k1 signer
//   -> 65-byte [r||s||v] recoverable signature, attach it to tx.signature[], and
//   broadcast via /wallet/broadcasttransaction. This is the real fund-safety
//   guard: a malicious/compromised node that returns a raw_data paying an
//   attacker is REJECTED because the decode+assert fails (recomputing txID ==
//   sha256(raw_data_hex) alone proves NOTHING about the payload's contents).
// • endpoint is CONFIG (default https://api.trongrid.io); an API key header is
//   optional config. No secret ever leaves the adapter.
//
// NOT post-quantum: this is ECDSA / secp256k1, exactly like Ethereum/Bitcoin.
//
// Global `TronAdapter` (factory); module.exports for tests.
(function (global) {
  'use strict';
  const inNode = (typeof module !== 'undefined' && module.exports);
  const C = inNode ? require('../crypto-core.js') : global.BLKCrypto;
  const S = inNode ? require('../secp256k1.js') : global.Secp256k1;
  const HD = inNode ? require('../hd.js') : global.HD;
  const Addr = inNode ? require('../address.js') : global.Addr;

  const SUN = 1_000_000;                      // 1 TRX = 1e6 sun (6 decimals)
  const DEFAULT_PATH = "m/44'/195'/0'/0/0";
  const DEFAULT_API = 'https://api.trongrid.io';
  const DEFAULT_FEE_LIMIT = 100_000_000;      // 100 TRX cap for a TRC-20 call
  const TRC20_TRANSFER = 'transfer(address,uint256)';
  const TRC20_BALANCEOF = 'balanceOf(address)';
  // Tron Contract.type enum values we recognize, + the ERC/TRC-20 transfer
  // selector (keccak256('transfer(address,uint256)')[:4]).
  const TRON_TRANSFER_CONTRACT = 1;
  const TRON_TRIGGER_SMART_CONTRACT = 31;
  const TRC20_SELECTOR = 'a9059cbb';

  // ---- Tron address codec (delegates to the shared Addr recipe) ------------
  function tronAddressFromPub(pub) { return Addr.tronAddress(pub); }
  function addressToHex(addr) { return Addr.tronAddressToHex(addr); }   // 'T…' -> '41'+40hex
  function hexToBase58(hex) { return Addr.tronHexToBase58(hex); }       // '41…'|20B -> 'T…'
  function isTronAddress(a) { return Addr.isTronAddress(a); }
  // Normalize any accepted recipient form to the canonical base58 'T…'.
  function toBase58(addr) {
    if (/^(0x)?41[0-9a-fA-F]{40}$/.test(String(addr))) return hexToBase58(addr);
    if (!isTronAddress(addr)) throw new Error('tron: invalid address ' + addr);
    return String(addr);
  }
  // The 20-byte EVM-style body (40-hex, NO 0x41 prefix) for ABI encoding.
  function addressBody20(addr) { return addressToHex(toBase58(addr)).slice(2); }

  function pad32(hexNo0x) { return String(hexNo0x).replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
  // ABI-encode transfer(address,uint256): 32B to-address ++ 32B amount.
  function trc20TransferParam(toAddr, amountStr) {
    return pad32(addressBody20(toAddr)) + pad32(BigInt(amountStr).toString(16));
  }

  function formatUnits(baseStr, decimals) {
    const s = BigInt(baseStr).toString().padStart(decimals + 1, '0');
    const i = s.slice(0, s.length - decimals);
    let f = s.slice(s.length - decimals).replace(/0+$/, '');
    return f ? `${i}.${f}` : i;
  }

  // Recompute the Tron txID (sha256 of raw_data_hex bytes) and REQUIRE it to
  // match the node-returned txID. NOTE: this only binds the txID to the bytes we
  // are about to sign — it is NOT a fund-safety check. Because the node both
  // builds raw_data AND derives txID = sha256(raw_data_hex), this equality is
  // ALWAYS true and proves NOTHING about who the payload pays. The real guard is
  // decodeRawData()/assertRawDataMatches() below, which inspect the payload.
  function verifyTxId(rawDataHex, claimedTxId) {
    const computed = C.bytesToHex(C.sha256(C.hexToBytes(String(rawDataHex))));
    if (!claimedTxId || computed.toLowerCase() !== String(claimedTxId).toLowerCase()) {
      throw new Error('tron: txID != sha256(raw_data_hex) — refusing to sign');
    }
    return computed;
  }
  // Sign the 32-byte txID -> 65-byte recoverable [r(32)||s(32)||v(1)] signature.
  // v = recovery id (0/1), NO +27 (the golden vector pins this).
  function signTxId(txIdHex, privBytes) {
    const sig = S.sign(C.hexToBytes(txIdHex), privBytes);
    return C.concatBytes(sig.compact, Uint8Array.of(sig.recovery)); // 65 bytes
  }

  // ---- raw_data decoder (DECODE-ONLY protobuf field walk, no deps) ----------
  // Tron's Transaction.raw / Contract / google.protobuf.Any / *Contract messages
  // use only wire type 0 (varint) and 2 (length-delimited); we decode exactly
  // those. Returns fields as {field, wire, varint|bytes}. Throws on truncation /
  // overrun / unexpected wire (each itself a reason to refuse to sign).
  function pbWalk(bytes) {
    const out = []; let i = 0;
    function vi() {
      let sh = 0n, r = 0n;
      for (;;) {
        if (i >= bytes.length) throw new Error('tron: truncated varint in raw_data');
        const x = BigInt(bytes[i++]); r |= (x & 0x7fn) << sh;
        if (!(x & 0x80n)) break; sh += 7n;
      }
      return r;
    }
    while (i < bytes.length) {
      const tag = Number(vi()); const field = tag >>> 3; const wire = tag & 7;
      if (wire === 0) out.push({ field, wire, varint: vi() });
      else if (wire === 2) {
        const len = Number(vi());
        if (len < 0 || i + len > bytes.length) throw new Error('tron: length overruns raw_data');
        out.push({ field, wire, bytes: bytes.slice(i, i + len) }); i += len;
      } else throw new Error('tron: unexpected wire type ' + wire + ' in raw_data');
    }
    return out;
  }
  function pbField(fields, n) { return fields.find((f) => f.field === n); }

  // Decode a node-returned raw_data_hex into the transfer it ACTUALLY encodes.
  // Returns { type, owner, to?, amount?, contract?, callValue?, data? } with
  // addresses as 21-byte 0x41-prefixed lowercase hex and amounts as BigInt.
  // Throws on any structural problem.
  function decodeRawData(rawDataHex) {
    const top = pbWalk(C.hexToBytes(String(rawDataHex)));
    const cField = pbField(top, 11);                 // Transaction.raw.contract[] (repeated)
    if (!cField || !cField.bytes) throw new Error('tron: raw_data has no contract');
    const contract = pbWalk(cField.bytes);           // take contract[0]
    const typeF = pbField(contract, 1);
    const type = typeF ? Number(typeF.varint) : 0;   // Contract.type enum
    const anyF = pbField(contract, 2);               // Contract.parameter = Any
    if (!anyF || !anyF.bytes) throw new Error('tron: contract has no parameter');
    const any = pbWalk(anyF.bytes);
    const valF = pbField(any, 2);                    // Any.value (bytes)
    if (!valF || !valF.bytes) throw new Error('tron: Any has no value');
    const val = pbWalk(valF.bytes);
    if (type === TRON_TRANSFER_CONTRACT) {
      const owner = pbField(val, 1), to = pbField(val, 2), amt = pbField(val, 3);
      if (!owner || !owner.bytes || !to || !to.bytes || !amt) throw new Error('tron: malformed TransferContract');
      return { type, owner: C.bytesToHex(owner.bytes), to: C.bytesToHex(to.bytes), amount: amt.varint };
    }
    if (type === TRON_TRIGGER_SMART_CONTRACT) {
      const owner = pbField(val, 1), caddr = pbField(val, 2),
        cv = pbField(val, 3), data = pbField(val, 4);
      if (!owner || !owner.bytes || !caddr || !caddr.bytes || !data || !data.bytes) throw new Error('tron: malformed TriggerSmartContract');
      return { type, owner: C.bytesToHex(owner.bytes), contract: C.bytesToHex(caddr.bytes),
        callValue: cv ? cv.varint : 0n, data: C.bytesToHex(data.bytes) };
    }
    throw new Error('tron: unsupported contract type ' + type);
  }

  // THE fund-safety gate. Decode the node's raw_data and ASSERT it encodes
  // EXACTLY the transfer we intend. `want`: { owner, to, amount, asset? }.
  // Any mismatch throws ("refusing to sign"); returns the decoded payload on OK.
  function assertRawDataMatches(rawDataHex, want) {
    const d = decodeRawData(rawDataHex);
    const owner21 = addressToHex(toBase58(want.owner)).toLowerCase(); // '41'+40hex, 21 bytes
    if (d.owner.toLowerCase() !== owner21) throw new Error('tron: raw_data owner != our address — refusing to sign');
    const isTrc20 = want.asset && want.asset.kind === 'trc20' && want.asset.address;
    if (isTrc20) {
      if (d.type !== TRON_TRIGGER_SMART_CONTRACT) throw new Error('tron: expected TriggerSmartContract — refusing to sign');
      const contract21 = addressToHex(toBase58(want.asset.address)).toLowerCase();
      if (d.contract.toLowerCase() !== contract21) throw new Error('tron: raw_data token contract mismatch — refusing to sign');
      if (BigInt(d.callValue) !== 0n) throw new Error('tron: raw_data call_value != 0 — refusing to sign');
      const expectData = (TRC20_SELECTOR + trc20TransferParam(want.to, want.amount)).toLowerCase();
      if (d.data.toLowerCase() !== expectData) throw new Error('tron: raw_data transfer args mismatch — refusing to sign');
    } else {
      if (d.type !== TRON_TRANSFER_CONTRACT) throw new Error('tron: expected TransferContract — refusing to sign');
      const to21 = addressToHex(toBase58(want.to)).toLowerCase();
      if (d.to.toLowerCase() !== to21) throw new Error('tron: raw_data recipient mismatch — refusing to sign');
      if (BigInt(d.amount) !== BigInt(want.amount)) throw new Error('tron: raw_data amount mismatch — refusing to sign');
    }
    return d;
  }

  function createTronAdapter(opts) {
    opts = opts || {};
    const id = 'tron';
    const path = opts.path || DEFAULT_PATH;
    const explorer = opts.explorer || 'https://tronscan.org/#/transaction/';
    const native = { chain: id, kind: 'native', symbol: opts.symbol || 'TRX', decimals: 6 };
    const apiKey = opts.apiKey || null;
    let rootSeed = null; // unlocked HD seed (Uint8Array), in-memory only
    // base TronGrid REST endpoint; opts.endpoint may be a string or async fn.
    let getEndpoint = opts.endpoint || (async () => opts.api || opts.rpcUrl || DEFAULT_API);

    // REST POST {base}/wallet/<path> with optional TRON-PRO-API-KEY header.
    async function tronPost(apiPath, body) {
      let base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
      base = String(base || DEFAULT_API).replace(/\/+$/, '');
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;
      const r = await fetch(base + apiPath, {
        method: 'POST', headers, body: JSON.stringify(body || {}),
      });
      return await r.json();
    }

    function pathWithIndex(index) {
      if (!index) return path;
      return path.replace(/\/0$/, '/' + index);
    }
    function nodeFor(index) {
      if (!rootSeed) throw new Error('locked');
      return HD.derivePath(rootSeed, pathWithIndex(index || 0));
    }

    return {
      id, native, scheme: 'secp256k1', sun: SUN,
      unlock(root) { rootSeed = root && (root.seed || root); },
      lock() { rootSeed = null; },

      async deriveAccount(root, index) {
        const seed = (root && (root.seed || root)) || rootSeed;
        if (!seed) throw new Error('no root seed');
        const node = HD.derivePath(seed, pathWithIndex(index || 0));
        return {
          chain: id, index: index || 0,
          address: Addr.tronAddress(node.publicKey),
          publicKey: C.bytesToHex(node.publicKey),
          scheme: 'secp256k1', path: pathWithIndex(index || 0),
        };
      },

      // tokens: [{kind:'trc20', address, symbol, decimals}]
      async getBalance(address, tokens) {
        const out = [];
        try {
          const res = await tronPost('/wallet/getaccount', { address, visible: true });
          const bal = BigInt((res && res.balance) || 0).toString();
          out.push({ asset: native, confirmed: bal, display: formatUnits(bal, 6) });
        } catch (e) {
          out.push({ asset: native, confirmed: '0', display: '—', error: String(e.message || e) });
        }
        for (const t of (tokens || [])) {
          if (t.kind !== 'trc20') continue;
          try {
            const res = await tronPost('/wallet/triggerconstantcontract', {
              owner_address: address, contract_address: t.address,
              function_selector: TRC20_BALANCEOF, parameter: pad32(addressBody20(address)),
              visible: true,
            });
            const cr = res && res.constant_result && res.constant_result[0];
            const v = (cr ? BigInt('0x' + cr) : 0n).toString();
            out.push({ asset: t, confirmed: v, display: formatUnits(v, t.decimals) });
          } catch (e) {
            out.push({ asset: t, confirmed: '0', display: '—', error: String(e.message || e) });
          }
        }
        return out;
      },

      // Auto-detect TRC-20 holdings via TronGrid's account API (best-effort;
      // returns [] on failure — the registry's known list is then the source).
      async discoverTokens(address) {
        try {
          let base = typeof getEndpoint === 'function' ? await getEndpoint() : getEndpoint;
          base = String(base || DEFAULT_API).replace(/\/+$/, '');
          const headers = {};
          if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey;
          const r = await fetch(base + '/v1/accounts/' + address + '/trc20', { headers });
          const j = await r.json();
          const rows = (j && j.data) || [];
          const out = [];
          for (const row of rows) {
            // each row is { <contract>: <balanceStr> } with token meta elsewhere
            for (const contract of Object.keys(row || {})) {
              let amt; try { amt = BigInt(row[contract]); } catch { continue; }
              if (amt <= 0n) continue;
              out.push({
                chain: id, kind: 'trc20', address: contract,
                symbol: contract.slice(0, 4) + '…' + contract.slice(-4),
                decimals: 6, balance: amt.toString(), display: formatUnits(amt.toString(), 6),
              });
            }
          }
          return out;
        } catch { return []; }
      },

      // Build an UNSIGNED transfer by having the NODE assemble it. Returns
      // { chain, kind, raw_data_hex, txID, unsigned, needsSign, summary }.
      // req: { asset?, to, amount(base units), feeLimit? }.
      async buildSend(account, req) {
        if (!req || !req.to || req.amount == null) throw new Error('tron: to + amount required');
        const owner = (account && account.address)
          || (rootSeed && Addr.tronAddress(nodeFor(0).publicKey));
        if (!owner) throw new Error('tron: no account');
        const to = toBase58(req.to);
        const isTrc20 = req.asset && req.asset.kind === 'trc20' && req.asset.address;
        let unsigned, rawHex, txId;
        if (isTrc20) {
          const res = await tronPost('/wallet/triggersmartcontract', {
            owner_address: owner, contract_address: req.asset.address,
            function_selector: TRC20_TRANSFER,
            parameter: trc20TransferParam(to, req.amount),
            fee_limit: Number(req.feeLimit || DEFAULT_FEE_LIMIT), call_value: 0,
            visible: true,
          });
          unsigned = res && res.transaction;
          if (!unsigned || !unsigned.raw_data_hex || !unsigned.txID) {
            throw new Error('tron: node did not assemble a transfer (' +
              JSON.stringify((res && (res.result || res.message)) || res) + ')');
          }
          rawHex = unsigned.raw_data_hex; txId = unsigned.txID;
        } else {
          const res = await tronPost('/wallet/createtransaction', {
            owner_address: owner, to_address: to, amount: Number(req.amount), visible: true,
          });
          if (!res || !res.raw_data_hex || !res.txID) {
            throw new Error('tron: node did not assemble a transfer (' +
              JSON.stringify((res && (res.Error || res.message)) || res) + ')');
          }
          unsigned = res; rawHex = res.raw_data_hex; txId = res.txID;
        }
        // Bind txID to the bytes, THEN decode the node's raw_data and assert it
        // pays exactly who/what we asked — the fund-safety guard against a
        // malicious/compromised node assembling an attacker-paying payload.
        verifyTxId(rawHex, txId);
        const want = { owner, to, amount: req.amount, asset: isTrc20 ? req.asset : null };
        assertRawDataMatches(rawHex, want);
        return {
          chain: id, kind: isTrc20 ? 'trc20-transfer' : 'send',
          raw_data_hex: rawHex, txID: txId, unsigned, needsSign: true,
          assert: want, // intent travels with the tx so signTx can re-verify
          summary: { from: owner, to, amount: String(req.amount),
            asset: isTrc20 ? req.asset.symbol : native.symbol },
        };
      },

      // RE-VERIFY txID == sha256(raw_data_hex), DECODE raw_data and re-assert it
      // is the transfer we intend, then secp256k1-sign that txID (and ONLY that)
      // -> 65-byte [r||s||v], attach to tx.signature[].
      async signTx(account, tx) {
        if (!rootSeed) throw new Error('locked');
        const unsigned = (tx && tx.unsigned) || tx;
        const rawHex = (tx && tx.raw_data_hex) || (unsigned && unsigned.raw_data_hex);
        const claimed = (tx && tx.txID) || (unsigned && unsigned.txID);
        if (!rawHex) throw new Error('tron: nothing to sign (no raw_data_hex)');
        const txIdHex = verifyTxId(rawHex, claimed);
        const node = nodeFor((account && account.index) || 0);
        // Fund-safety gate: re-decode + re-assert the payload before signing.
        // Prefer the build-time intent carried on the tx; otherwise require at
        // least that the decoded owner is the account we are about to sign with.
        const want = (tx && tx.assert) || (unsigned && unsigned.assert);
        if (want) {
          assertRawDataMatches(rawHex, want);
        } else {
          const ownAddr = (account && account.address) || Addr.tronAddress(node.publicKey);
          const d = decodeRawData(rawHex);
          if (d.owner.toLowerCase() !== addressToHex(toBase58(ownAddr)).toLowerCase()) {
            throw new Error('tron: raw_data owner != signing account — refusing to sign');
          }
        }
        const sig65 = signTxId(txIdHex, node.privateKey);
        const sigHex = C.bytesToHex(sig65);
        const signed = Object.assign({}, unsigned, { signature: [sigHex] });
        return { chain: id, txid: claimed, signature: sigHex, signed, raw: signed };
      },

      async broadcast(tx) {
        const signed = (tx && tx.signed) || (tx && tx.raw) || tx;
        const res = await tronPost('/wallet/broadcasttransaction', signed);
        const accepted = !!(res && (res.result === true || (res.result === undefined && res.txid)));
        return { txid: (signed && signed.txID) || (res && res.txid) || null, accepted, raw: res };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  const API = {
    createTronAdapter,
    tronAddressFromPub, addressToHex, hexToBase58, isTronAddress, toBase58,
    addressBody20, trc20TransferParam, pad32, formatUnits,
    verifyTxId, signTxId, decodeRawData, assertRawDataMatches,
    DEFAULT_PATH, DEFAULT_API, SUN, TRC20_TRANSFER, TRC20_BALANCEOF,
    TRON_TRANSFER_CONTRACT, TRON_TRIGGER_SMART_CONTRACT, TRC20_SELECTOR,
  };
  global.TronAdapter = API;
  if (inNode) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
