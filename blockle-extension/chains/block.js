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
              const dec = Number(t.decimals || 0);
              out.push({ chain: id, kind: 'block20', contract: cid, address: cid, symbol: t.symbol || 'TOKEN', decimals: dec, name: t.name || undefined, balance: bal.toString(), display: fmtUnits(bal.toString(), dec) });
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
            const dec = Number(info.decimals || 0);
            out.push({ chain: id, kind: 'block20', contract: cid, address: cid, symbol: info.symbol || 'TOKEN', decimals: dec, name: info.name || undefined, balance: bal.toString(), display: fmtUnits(bal.toString(), dec) });
          }
        } catch { /* best-effort */ }
        return out;
      },

      async getBalance(address) {
        try {
          const a = await Chain.account(address || W.address);
          const confirmed = a ? String(a.balance) : '0';
          return [{ asset: native, confirmed, spendable: confirmed, display: a ? a.balanceFmt : '—' }];
        } catch (e) {
          return [{ asset: native, confirmed: '0', display: '—', error: String(e.message || e) }];
        }
      },

      // req: {to, amount(base), feeRate?(fee base)}
      async buildSend(account, req) {
        if (!W.isUnlocked()) throw new Error('locked');
        const u = await Chain.utxos(W.address);
        const utxos = (u && u.utxos) || [];
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
