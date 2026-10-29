// Writes a cached arbitrage-board snapshot (all 4 modes) for the home-page demo.
// Hits the local signals service (/api/signals/arb) so the demo can read a static,
// fast arb.json instead of making many live DexScreener calls per visitor.
// Run on the box via a systemd timer; output → /opt/blockle/web/arb.json.
import fs from 'node:fs';

const BASE = process.env.SIGNALS_URL || 'http://127.0.0.1:8809';
const OUT = process.env.ARB_OUT || '/opt/blockle/web/arb.json';
const MODES = ['safe', 'medium', 'high', 'sniper'];
const LIMIT = Number(process.env.ARB_LIMIT || 12);

async function board(mode) {
  const url = `${BASE}/api/signals/arb?mode=${mode}&limit=${LIMIT}`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { mode, scanned: 0, profitableAfterFees: 0, opportunities: [] };
}

const out = { generatedAt: new Date().toISOString(), source: 'live cross-DEX spreads (DexScreener), net of a conservative round-trip cost', modes: {} };
for (const m of MODES) {
  out.modes[m] = await board(m);
  const b = out.modes[m];
  console.error(`${m.padEnd(7)} scanned=${b.scanned} profitable=${b.profitableAfterFees} shown=${(b.opportunities || []).length}`);
}
fs.writeFileSync(OUT, JSON.stringify(out));
console.error(`wrote ${OUT}`);
