// USDB (Blockle USD) issuance + reserve service.
//
// The licensed issuer (ALienbeing LLC) mints USDB against VERIFIED USD reserves
// and burns it on redemption, so on-chain supply never exceeds custodied USD
// (supply <= reserves, fully backed). A small mint/redeem fee is the issuer's
// margin, taken on the fiat side so it never mints unbacked tokens.
//
// SAFETY POSTURE (money + regulated product — everything OFF by default):
//   * USDB_ENABLED defaults 0 → buy/redeem return an honest DRY-RUN plan and
//     mint/burn NOTHING. Real issuance requires the operator to flip it on AFTER
//     USDB is deployed on-chain AND reserves are funded.
//   * No secrets here: the issuer key is referenced by PATH (box-only); it signs
//     mint/burn on the node. Reserves are recorded in a durable ledger; the
//     proof-of-reserves endpoint compares on-chain supply vs recorded backing.
//   * Per-tx + daily issuance caps are finite by default (blast radius).
//   * KYC + sanctions/blacklist are required before any real issuance (hooks
//     here fail-closed when enabled without a configured verifier).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.USDB_PORT || 8801);
const DATA = process.env.USDB_DATA || '/var/lib/blockle-usdb';
const NODE = (process.env.USDB_NODE_URL || 'http://127.0.0.1:8445').replace(/\/+$/, '');
const CONTRACT = (process.env.USDB_CONTRACT || '').trim();     // deployed USDB contract id (hex)
const DECIMALS = Number(process.env.USDB_DECIMALS || 6);
const UNIT = 10 ** DECIMALS;
const MINT_FEE_BPS = Number(process.env.USDB_MINT_FEE_BPS || 0);   // margin on buy (default 0)
const REDEEM_FEE_BPS = Number(process.env.USDB_REDEEM_FEE_BPS || 20); // margin on redeem (0.20%)
const PER_TX_CAP_USD = Number(process.env.USDB_PER_TX_CAP_USD || 10000);
const DAILY_CAP_USD = Number(process.env.USDB_DAILY_CAP_USD || 100000);
const ENABLED = (process.env.USDB_ENABLED || '0') === '1';     // master gate for REAL mint/burn
const KYC_URL = (process.env.USDB_KYC_URL || '').trim();        // sanctions/KYC verifier (required when ENABLED)

fs.mkdirSync(DATA, { recursive: true });
const LEDGER = path.join(DATA, 'reserve-ledger.json');
function load() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return { reserveUsd: 0, issued: [], day: '', dayUsd: 0 }; } }
function save(l) { fs.writeFileSync(LEDGER, JSON.stringify(l)); }

function j(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(obj));
}
async function nodeGet(p) { const r = await fetch(NODE + p, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('node ' + r.status); return r.json(); }
function today() { return new Date(Date.now()).toISOString().slice(0, 10); }
function feeOf(usd, bps) { return Math.round(usd * bps) / 10000 * 1; } // USD fee, rounded to cents-ish
function net(usd, bps) { return usd - (usd * bps) / 10000; }

// On-chain USDB supply (whole USDB) via the stablecoin contract's totalSupply (selector 3).
async function onchainSupply() {
  if (!CONTRACT) return null;
  try {
    const t = await nodeGet('/token/' + encodeURIComponent(CONTRACT)); // proxied tokeninfo (supply in base units)
    const tok = (t && t.result) ? t.result : t;
    const sup = tok && (tok.supply != null ? tok.supply : tok.totalSupply);
    return sup != null ? Number(sup) / UNIT : null;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return j(res, 204, {});
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/usdb/info') {
      const l = load();
      const supply = await onchainSupply();
      return j(res, 200, {
        asset: 'USDB', name: 'Blockle USD', peg: 'USD', decimals: DECIMALS,
        contract: CONTRACT || null,
        mintFeeBps: MINT_FEE_BPS, redeemFeeBps: REDEEM_FEE_BPS,
        perTxCapUsd: PER_TX_CAP_USD, dailyCapUsd: DAILY_CAP_USD,
        enabled: ENABLED,
        supply, reserveUsd: l.reserveUsd,
        fullyBacked: supply == null ? null : l.reserveUsd >= supply,
        note: ENABLED ? 'live' : 'issuance not enabled — buy/redeem return a dry-run plan and mint/burn nothing',
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/usdb/reserves') {
      // Proof-of-reserves: on-chain USDB supply vs recorded USD backing.
      const l = load();
      const supply = await onchainSupply();
      return j(res, 200, {
        supplyUsdb: supply, reserveUsd: l.reserveUsd,
        deltaUsd: supply == null ? null : (l.reserveUsd - supply),
        fullyBacked: supply == null ? null : l.reserveUsd >= supply,
        asOf: Date.now(),
      });
    }

    if (req.method === 'POST' && (url.pathname === '/api/usdb/quote' || url.pathname === '/api/usdb/buy' || url.pathname === '/api/usdb/redeem')) {
      let raw = ''; for await (const c of req) raw += c;
      let b = {}; try { b = JSON.parse(raw || '{}'); } catch { return j(res, 400, { error: 'bad json' }); }
      const side = url.pathname.endsWith('/redeem') ? 'redeem' : (url.pathname.endsWith('/buy') ? 'buy' : (b.side === 'redeem' ? 'redeem' : 'buy'));
      const usd = Number(b.amountUsd || b.amount || 0);
      if (!(usd > 0)) return j(res, 400, { error: 'amount (USD) must be positive' });
      if (usd > PER_TX_CAP_USD) return j(res, 400, { error: 'exceeds per-tx cap of $' + PER_TX_CAP_USD });
      const bps = side === 'buy' ? MINT_FEE_BPS : REDEEM_FEE_BPS;
      const fee = (usd * bps) / 10000;
      const quote = side === 'buy'
        ? { side, payUsd: usd, feeUsd: fee, receiveUsdb: net(usd, bps) }   // pay USD → get USDB (minus mint fee)
        : { side, burnUsdb: usd, feeUsd: fee, payoutUsd: net(usd, bps) };  // burn USDB → get USD (minus redeem fee)

      if (url.pathname === '/api/usdb/quote') return j(res, 200, quote);

      // --- money paths: gated + fail-closed ---
      if (!ENABLED) {
        return j(res, 200, { dryRun: true, ...quote, note: 'DRY-RUN: issuance is not enabled. No USDB minted/burned, no reserve moved. The issuer must deploy USDB, fund reserves, configure KYC/sanctions, and set USDB_ENABLED=1.' });
      }
      if (!CONTRACT) return j(res, 503, { error: 'USDB contract not configured' });
      if (!KYC_URL) return j(res, 503, { error: 'KYC/sanctions verifier not configured — refusing to issue (fail-closed)' });
      // daily cap
      const l = load();
      if (l.day !== today()) { l.day = today(); l.dayUsd = 0; }
      if (l.dayUsd + usd > DAILY_CAP_USD) return j(res, 429, { error: 'daily issuance cap reached' });
      // NOTE: real mint/burn (issuer-signed call to the USDB contract selector
      // 7/8) + the verified-deposit / payout rails execute here once enabled.
      // Until the operator wires the issuer signer + reserve custody + KYC, this
      // stays fail-closed rather than minting unbacked or unscreened USDB.
      return j(res, 503, { error: 'live issuance pending issuer-signer + reserve-custody + KYC wiring (fail-closed; nothing issued)' });
    }
    return j(res, 404, { error: 'not found' });
  } catch (e) { return j(res, 500, { error: (e && e.message) || String(e) }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[usdb] issuance on 127.0.0.1:${PORT} enabled=${ENABLED} mintFee=${MINT_FEE_BPS}bps redeemFee=${REDEEM_FEE_BPS}bps contract=${CONTRACT || '(unset)'}`));
