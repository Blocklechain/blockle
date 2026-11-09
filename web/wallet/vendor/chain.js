// chain.js — read-only client for live BLOCK chain data via the public API.
// Everything is best-effort: on any failure the UI shows "—" and stays usable.
// Exposed as global `Chain`.
(function (global) {
  const DEFAULT_API = 'https://blockle.org/api/explorer';
  const TESTNET_API = 'https://blockle.org/api/testnet/explorer';
  const COIN = 100000000; // base units per BLOCK

  async function endpoint() {
    // Honor a stored apiBase ONLY if it is a currently-recognized endpoint. Any
    // stale/legacy value (an old host or path persisted by a previous build)
    // falls back to mainnet — otherwise BLOCK + token balances read a dead API
    // and show 0 for a funded mainnet address.
    const { apiBase } = await Store.get('apiBase');
    return apiBase === DEFAULT_API || apiBase === TESTNET_API ? apiBase : DEFAULT_API;
  }

  async function get(path) {
    const base = await endpoint();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch(base + path, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  function fmt(base) {
    if (base == null) return null;
    return (base / COIN).toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  const Chain = {
    DEFAULT_API,
    TESTNET_API,
    async isTestnet() { return (await endpoint()) === TESTNET_API; },
    async stats() {
      const s = await get('/stats');
      if (!s) return null;
      return { height: s.height, supply: s.supply, ticker: s.ticker || 'BLOCK' };
    },
    async account(address) {
      if (!address) return null;
      const a = await get('/address/' + address);
      if (!a) return null;
      const bal = a.balance ?? a.confirmed ?? a.final_balance ?? 0;
      return {
        balance: bal,
        balanceFmt: fmt(bal),
        received: a.total_received,
        sent: a.total_sent,
        txCount: a.tx_count ?? (a.history ? a.history.length : undefined),
        txs: a.history || [],
      };
    },
    // Spendable (mature) UTXOs for building a transfer.
    async utxos(address) {
      const u = await get('/utxos/' + address);
      return u ? { utxos: u.utxos || [], spendable: u.spendable || 0 } : null;
    },
    // Read a BLOCK-20 token by contract id (hex). `holderHex` optional (32-byte
    // address hex) to include the holder's balance. Returns the token info or null.
    async token(contractId, holderHex) {
        const base = (await endpoint()).replace(/\/explorer$/, '');
        const q = holderHex ? '?holder=' + encodeURIComponent(holderHex) : '';
        try {
            const r = await fetch(base + '/token/' + encodeURIComponent(contractId) + q, {
                headers: { accept: 'application/json' },
            });
            if (!r.ok) return null;
            const j = await r.json();
            const t = j && j.result ? j.result : j;
            return t && (t.isToken || t.name || t.symbol) ? t : (t || null);
        } catch {
            return null;
        }
    },

    // Look up a transaction by id. Returns the tx JSON (with block height +
    // confirmations if mined) or null if not found / still unconfirmed.
    // The node's submit RPC (and the WASM builder) spell a txid as the raw hash
    // bytes; the explorer displays and looks up the byte-REVERSED form. Convert
    // between the two (64-hex only; anything else is returned unchanged).
    flipTxid(txid) {
        const t = String(txid || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(t)) return txid;
        let out = '';
        for (let i = t.length - 2; i >= 0; i -= 2) out += t.slice(i, i + 2);
        return out;
    },
    // Look up a tx by id — accepts either spelling (given first, then flipped).
    async tx(txid) {
        const base = await endpoint();
        const get = async (id) => {
            try {
                const r = await fetch(base + '/tx/' + id, { headers: { accept: 'application/json' } });
                if (!r.ok) return null;
                const j = await r.json();
                return j && !j.error ? j : null;
            } catch { return null; }
        };
        const first = await get(txid);
        if (first) return first;
        const alt = Chain.flipTxid(txid);
        return alt === txid ? null : get(alt);
    },

    // List native AMM pools (DEX). Returns [] on failure.
    async pools() {
        const base = (await endpoint()).replace(/\/explorer$/, '');
        try {
            const r = await fetch(base + '/dex/pools', { headers: { accept: 'application/json' } });
            if (!r.ok) return [];
            const j = await r.json();
            return (j.pools || []);
        } catch {
            return [];
        }
    },

    // Broadcast a bincode-hex transaction via the submit proxy.
    async submit(rawHex) {
      // Derive the submit endpoint by stripping the trailing /explorer. Works for
      // mainnet (…/api/explorer → …/api/submit) AND testnet (…/api/testnet/explorer
      // → …/api/testnet/submit).
      const base = (await endpoint()).replace(/\/explorer$/, '');
      try {
        const r = await fetch(base + '/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ raw: rawHex }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error)) || 'submit failed');
        const res = j.result || j;
        // Normalise the accepted txid to the explorer's (display) spelling so
        // activity/explorer links resolve; keep the node's under txidRpc.
        if (res && typeof res === 'object' && typeof res.txid === 'string') {
          return Object.assign({}, res, { txid: Chain.flipTxid(res.txid), txidRpc: res.txid });
        }
        return res;
      } catch (e) {
        throw new Error(e.message || 'network error');
      }
    },
  };

  global.Chain = Chain;
})(typeof self !== 'undefined' ? self : window);
