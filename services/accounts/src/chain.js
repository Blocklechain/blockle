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
    // Public market list for the Markets tab: BLOCK (native) always, plus any BLOCK-20 tokens
    // with their AMM price (BLOCK-denominated). Never throws / never empty — if no tokens are
    // listed yet, the caller shows a "launch a token" empty state rather than "unavailable".
    async markets() {
      const rows = [{ symbol: 'BLOCK', name: 'Blockle', price: null, change: null, native: true }];
      const [toks, pools] = await Promise.all([getJson('/api/dex/tokens'), getJson('/api/dex/pools')]);
      const list = Array.isArray(toks)
        ? toks
        : (toks && typeof toks === 'object' ? Object.entries(toks).map(([id, v]) => ({ id, ...(v || {}) })) : []);
      const priceByToken = {};
      if (pools && Array.isArray(pools.pools)) {
        for (const p of pools.pools) { if (p && p.token != null && p.price != null) priceByToken[p.token] = p.price; }
      }
      for (const t of list.slice(0, 50)) {
        const sym = t.symbol || t.ticker || t.id;
        rows.push({ symbol: sym, name: t.name || sym, logo: t.logo || null,
          price: t.price ?? t.priceUsd ?? priceByToken[t.id] ?? null, change: t.change24h ?? null });
      }
      return rows;
    },
  };
}
