// Read-only chain + markets client for the hosted vault. NON-CUSTODIAL: it only reads public
// data (balance for a given PUBLIC address) and relays an already-signed transaction to the node.
// It holds no keys and never signs. Injectable (tests pass a stub); in prod it targets the site's
// existing /api endpoints (explorer / submit / dex) served alongside the node.
export function makeChain(config, deps = {}) {
  if (deps.stub) return deps.stub;
  const fetchFn = deps.fetch || globalThis.fetch;
  const base = config.chainApiBase || config.publicOrigin || 'https://blockle.org';

  async function getJson(path, init) {
    try {
      const r = await fetchFn(base + path, init);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  return {
    stub: false,
    // Public balance + token holdings for an address (no key involved).
    async balance(address) {
      const j = await getJson('/api/explorer/address/' + encodeURIComponent(address));
      if (!j) return { address, balance: null, tokens: [], unavailable: true };
      return { address, balance: j.balance ?? j.confirmed ?? null, tokens: j.tokens || [] };
    },
    // Relay an opaque, client-signed raw transaction. The server forwards bytes; it cannot sign.
    async broadcast(rawtx) {
      const j = await getJson('/api/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawtx }),
      });
      if (!j) throw new Error('broadcast failed');
      return j;
    },
    // Public market list (BLOCK + BLOCK-20 tokens) with prices, for the Markets tab.
    async markets() {
      const j = await getJson('/api/dex/tokens');
      const list = Array.isArray(j) ? j : (j && j.tokens) || [];
      return list.slice(0, 50).map((t) => ({
        symbol: t.symbol || t.ticker || t.id, name: t.name || t.symbol || '',
        price: t.price ?? t.priceUsd ?? null, change: t.change24h ?? null, logo: t.logo || null,
      }));
    },
  };
}
