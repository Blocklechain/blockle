// chains/block.js — the BLOCK ChainAdapter. This is a THIN wrapper over the
// existing, consensus-correct BLOCK stack (`Signer` = blockle-wasm ML-DSA-44,
// `Wallet` = key session, `Chain` = explorer/submit). It does NOT reimplement
// any BLOCK crypto — ML-DSA signing stays entirely in blockle-wasm.
//
// BLOCK is the wallet's native identity and is ALWAYS enabled. This adapter
// exists so the UI / exchange / agent can talk to every chain through one
// uniform ChainAdapter interface.
//
// Post-quantum: YES — BLOCK alone is signed with ML-DSA-44 (FIPS 204).
//
// Global `BlockAdapter` (factory). Browser-only (depends on wasm globals); the
// unit tests exercise the secp256k1 adapters, not this wrapper.
(function (global) {
  'use strict';
  const COIN = 100000000;

  // Curated BLOCK-20 tokens: official contracts get a canonical name / symbol /
  // decimals / logo even before the node metadata loads, so e.g. USDB always
  // renders as "Blockle USD" with its brand mark rather than a bare monogram.
  // Keyed by lowercase contract id. Node-read metadata still wins for balance.
  const CURATED = {
    '2beadf6b409427aacca1030778671ead6b9cdc5e817f1b6743c6d931c0c7ae7a': {
      symbol: 'USDB', name: 'Blockle USD', decimals: 6,
      logoURI: 'https://blockle.org/usdb-token.svg', stablecoin: true, peg: 'USD',
    },
    '32a97972001bd895203c4bb5ac4645af02d81263438968ea32e35140f130d00f': {
      symbol: 'WORLD', name: 'World', decimals: 8,
      logoURI: 'https://blockle.org/world-token.svg',
    },
  };
  function curatedFor(cid) { return (cid && CURATED[String(cid).toLowerCase()]) || null; }

  function fmtUnits(baseStr, decimals) {
    try {
      const d = Number(decimals) || 0;
      const s = BigInt(baseStr).toString().padStart(d + 1, '0');
      const i = s.slice(0, s.length - d);
      const f = s.slice(s.length - d).replace(/0+$/, '');
      return f ? `${i}.${f}` : i;
    } catch { return String(baseStr); }
  }

  function createBlockAdapter(opts) {
    opts = opts || {};
    const id = 'block';
    const native = { chain: id, kind: 'native', symbol: 'BLOCK', decimals: 8 };
    const W = opts.wallet || global.Wallet;
    const Chain = opts.chain || global.Chain;
    const explorer = opts.explorer || 'https://blockle.org/tx/';

    return {
      id, native, postQuantum: true, scheme: 'ml-dsa-44',

      // No-ops for interface symmetry: the BLOCK key lives in the Wallet session.
      unlock() {},
      lock() {},

      async deriveAccount() {
        // BLOCK identity is the ML-DSA keypair in the Wallet session — not HD.
        return {
          chain: id, index: 0,
          address: W.address,
          publicKey: W.publicKeyHex,
          scheme: 'ml-dsa-44',
        };
      },

      // Auto-detect the BLOCK-20 tokens this address holds, via the node's
      // token/holder interface. Preferred path: a direct address-token-holdings
      // read (Chain.addressTokens) when the node exposes one. Fallback: list the
      // known BLOCK-20 contracts from the DEX pools (Chain.pools) and read the
      // holder's balance per token (Chain.token(contractId, holder)) — the
      // balanceOf-equivalent read. Only non-zero holdings are returned.
      // Best-effort: returns [] on any failure.
      async discoverTokens(address) {
        const holder = address || (W && W.address);
        if (!holder) return [];
        const out = [];
        // 1) direct holdings read, if available
        try {
          if (typeof Chain.addressTokens === 'function') {
            const list = await Chain.addressTokens(holder);
            for (const t of (list || [])) {
              const cid = t.contract || t.contractId || t.id || t.token;
              let bal; try { bal = BigInt(t.balance != null ? t.balance : (t.holderBalance || 0)); } catch { bal = 0n; }
              if (!cid || bal <= 0n) continue;
              const cur = curatedFor(cid);
              const dec = Number((cur && cur.decimals != null ? cur.decimals : t.decimals) || 0);
              out.push({ chain: id, kind: 'block20', contract: cid, address: cid, symbol: (cur && cur.symbol) || t.symbol || 'TOKEN', decimals: dec, name: (cur && cur.name) || t.name || undefined, logoURI: cur && cur.logoURI, balance: bal.toString(), display: fmtUnits(bal.toString(), dec) });
            }
            if (out.length) return out;
          }
        } catch { /* fall through to pool enumeration */ }
        // 2) enumerate BLOCK-20 contracts from the AMM pools + read holder balance
        try {
          const pools = (typeof Chain.pools === 'function') ? (await Chain.pools()) : [];
          const seen = new Set();
          for (const p of (pools || [])) {
            const cid = p && (p.token || p.contract || p.contractId || p.poolId);
            if (!cid || seen.has(cid)) continue;
            seen.add(cid);
            let info; try { info = await Chain.token(cid, holder); } catch { info = null; }
            if (!info) continue;
            let bal; try { bal = BigInt(info.holderBalance != null ? info.holderBalance : (info.balance != null ? info.balance : 0)); } catch { bal = 0n; }
            if (bal <= 0n) continue;
            const cur = curatedFor(cid);
            const dec = Number((cur && cur.decimals != null ? cur.decimals : info.decimals) || 0);
            out.push({ chain: id, kind: 'block20', contract: cid, address: cid, symbol: (cur && cur.symbol) || info.symbol || 'TOKEN', decimals: dec, name: (cur && cur.name) || info.name || undefined, logoURI: cur && cur.logoURI, balance: bal.toString(), display: fmtUnits(bal.toString(), dec) });
          }
        } catch { /* best-effort */ }
        // 3) always probe the curated/official tokens by balanceOf. Some (e.g.
        // USDB) have no AMM pool to enumerate from, so a held official token
        // would otherwise never surface. Dedups against what pools already found.
        try {
          const have = new Set(out.map(function (t) { return String(t.contract).toLowerCase(); }));
          for (const cid in CURATED) {
            if (have.has(cid)) continue;
            let info; try { info = await Chain.token(cid, holder); } catch { info = null; }
            let bal; try { bal = BigInt(info && (info.holderBalance != null ? info.holderBalance : (info.balance != null ? info.balance : 0))); } catch { bal = 0n; }
            if (bal <= 0n) continue;
            const cur = CURATED[cid];
            const dec = Number((cur && cur.decimals != null ? cur.decimals : (info && info.decimals)) || 0);
            out.push({ chain: id, kind: 'block20', contract: cid, address: cid, symbol: (cur && cur.symbol) || (info && info.symbol) || 'TOKEN', decimals: dec, name: (cur && cur.name) || (info && info.name) || undefined, logoURI: cur && cur.logoURI, balance: bal.toString(), display: fmtUnits(bal.toString(), dec) });
          }
        } catch { /* best-effort */ }
        return out;
      },

      async getBalance(address) {
        try {
          const a = await Chain.account(address || W.address);
          const confirmed = a ? String(a.balance) : '0';
          // display is a NUMBER (whole BLOCK), not a locale-formatted string —
          // callers do Number(display), and a comma-grouped string ("140,001.74")
          // would become NaN and render as 0 for balances ≥ 1,000.
          const display = a ? Number(BigInt(confirmed)) / 1e8 : 0;
          return [{ asset: native, confirmed, spendable: confirmed, display }];
        } catch (e) {
          return [{ asset: native, confirmed: '0', display: '—', error: String(e.message || e) }];
        }
      },

      // Native:   req = {to, amount(base), feeRate?(fee base)}
      // BLOCK-20: req = {to, amount(base), asset:{kind:'block20', contract|address}, gasLimit?, gasPrice?}
      async buildSend(account, req) {
        if (!W.isUnlocked()) throw new Error('locked');
        const u = await Chain.utxos(W.address);
        const utxos = (u && u.utxos) || [];
        const asset = req.asset;
        const contract = asset && (asset.contract || asset.address);
        const isToken = !!(asset && (asset.kind === 'block20' || (contract && /^[0-9a-f]{64}$/i.test(String(contract)))));
        if (isToken) {
          const gasLimit = BigInt(req.gasLimit || 200000);
          const gasPrice = BigInt(req.gasPrice || 10);
          const built = await W.buildTokenTransfer(utxos, String(contract).toLowerCase(), req.to, BigInt(req.amount), gasLimit, gasPrice);
          return { chain: id, raw: built.raw, txid: built.txid, fee: (gasLimit * gasPrice).toString(), token: String(contract).toLowerCase(), summary: req };
        }
        const fee = BigInt(req.feeRate || 100000);
        const built = await W.buildTransfer(utxos, req.to, BigInt(req.amount), fee);
        // Signer.buildTransfer returns { raw, txid } (bincode hex)
        return { chain: id, raw: built.raw, txid: built.txid, fee: fee.toString(), summary: req };
      },

      async broadcast(tx) {
        const res = await Chain.submit(tx.raw);
        const txid = (res && (res.txid || res.result || res)) || tx.txid;
        return { txid: String(txid), accepted: true };
      },

      explorerTx(txid) { return explorer + txid; },
    };
  }

  global.BlockAdapter = { createBlockAdapter, COIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.BlockAdapter;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
