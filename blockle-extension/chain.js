// chain.js — read-only client for live BLOCK chain data via the public API.
// Everything is best-effort: on any failure the UI shows "—" and stays usable.
// Exposed as global `Chain`.
(function (global) {
  const DEFAULT_API = 'https://blockle.org/api/explorer';
  const COIN = 100000000; // base units per BLOCK

  async function endpoint() {
    const { apiBase } = await Store.get('apiBase');
    return apiBase || DEFAULT_API;
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
    // Broadcast a bincode-hex transaction via the submit proxy.
    async submit(rawHex) {
      const base = (await endpoint()).replace(/\/api\/explorer$/, '/api');
      try {
        const r = await fetch(base + '/submit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ raw: rawHex }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error)) || 'submit failed');
        return j.result || j;
      } catch (e) {
        throw new Error(e.message || 'network error');
      }
    },
  };

  global.Chain = Chain;
})(typeof self !== 'undefined' ? self : window);
