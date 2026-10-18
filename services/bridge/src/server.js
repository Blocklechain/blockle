// Bridge HTTP API — the /api/bridge/* surface the /bridge frontend + explorer
// call, plus the relayer's real adapters (SPL minter + reserve-signer client).
//
// Honesty rules baked in:
//  - `live` is false until a wBLOCK mint is configured → the UI shows "not yet live".
//  - The minter THROWS when Solana sends aren't enabled (dry-run / no mint), so a
//    deposit reaches MINTING and WAITS — it is never falsely marked completed
//    without a real on-chain mint. Same for releases via reserve-signer.
//  - Every money/deploy path stays gated; this server moves nothing by itself.
//  - All figures come from the durable store + accounting; nothing fabricated.
import http from 'node:http';
import { json, readJson, securityHeaders } from '../../accounts/src/http.js';
import { loadConfig } from './config.js';
import { BridgeStore } from './store.js';
import { BridgeEngine, DIRECTIONS } from './statemachine.js';
import { reserves, outstanding } from './accounting.js';
import { health } from './metrics.js';
import { createBlockWatch } from './blockwatch.js';
import { Relayer } from './relayer.js';

// Map the frontend's direction codes to the engine's canonical directions.
function toDirection(d) {
  if (d === DIRECTIONS.DEPOSIT || d === 'b2s' || d === 'block-to-sol') return DIRECTIONS.DEPOSIT;
  if (d === DIRECTIONS.REDEEM || d === 's2b' || d === 'sol-to-block') return DIRECTIONS.REDEEM;
  return null;
}

// ---- relayer adapters (lazy Solana imports; gated; store-guarded idempotency) ----
function makeMinter(cfg, store) {
  return {
    async mint({ amountBase, recipient, ref }) {
      // store-level idempotency guard (survives restarts); on-chain idempotency
      // additionally requires the mint to carry `ref` as a memo — see SOLANA.md.
      const prior = store.get('meta', 'minted:' + ref);
      if (prior && prior.sig) return prior.sig;
      const mintMod = await import('../solana/mint.js');
      const res = await mintMod.mintSolblock({
        recipient, amountBase, depositRef: ref,
        execute: true, // honored only if sends are enabled in Solana config
      });
      if (res.dryRun || !res.signature) {
        // Sends not enabled / no mint yet: DO NOT settle. Leave the transfer in
        // MINTING so it retries once Solana is live — never fake a completion.
        throw new Error('wBLOCK mint not executed (Solana sends disabled or no mint configured)');
      }
      await store.put('meta', 'minted:' + ref, { sig: res.signature, at: Date.now() });
      return res.signature;
    },
  };
}

function makeReserveSigner(cfg, store, fetchImpl = fetch) {
  return {
    async dispense({ amountBase, to, ref }) {
      const prior = store.get('meta', 'released:' + ref);
      if (prior && prior.txid) return { txid: prior.txid };
      const headers = { 'content-type': 'application/json' };
      if (cfg.reserveSignerToken) headers.authorization = 'Bearer ' + cfg.reserveSignerToken;
      const r = await fetchImpl(cfg.reserveSignerUrl.replace(/\/+$/, '') + '/reserve/dispense', {
        method: 'POST', headers,
        body: JSON.stringify({ purpose: 'bridge-redeem', asset: 'BLOCK', amountBase: String(amountBase), to, ref }),
      });
      if (!r.ok) throw new Error('reserve-signer ' + r.status);
      const j = await r.json();
      if (j.dryRun || !j.txid) {
        // reserve-signer ran in dry-run (mainnet not enabled): leave RELEASING, retry later.
        throw new Error('BLOCK release not executed (reserve-signer dry-run / mainnet disabled)');
      }
      await store.put('meta', 'released:' + ref, { txid: j.txid, at: Date.now() });
      return { txid: j.txid };
    },
  };
}

export function createApp(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides.config };
  const store = overrides.store || new BridgeStore(cfg.dataDir);
  const engine = overrides.engine || new BridgeEngine({ store, config: cfg });
  const isLive = !!cfg.solblockMint && !cfg.paused;

  const pub = (t) => t && ({
    id: t.id, direction: t.direction, state: t.state,
    sourceTx: t.sourceTx, outputTx: t.outputTx || null,
    amountBase: t.sourceAmountBase ?? null, receivedBase: t.outputAmountBase ?? null,
    feeBase: t.feeBase ?? null, destination: t.destination || null,
    sourceConfirmations: t.sourceConfirmations ?? null,
    failReason: t.failReason || null, createdAt: t.createdAt || null, updatedAt: t.updatedAt || null,
  });

  const routes = [];
  const on = (method, re, fn) => routes.push({ method, re, fn });

  on('GET', /^\/api\/bridge\/info$/, (req, res) => json(res, 200, {
    live: isLive, enabled: isLive, paused: !!cfg.paused,
    bridgeAddress: cfg.blockBridgeAddr || null,
    confirmations: cfg.confirmationDepth, decimals: cfg.decimals,
    feeBps: cfg.feeBps ?? 0, minFlatBlock: cfg.feeFlatBase ? Number(cfg.feeFlatBase) : 0,
    minAmount: cfg.minAmountBase != null ? Number(cfg.minAmountBase) : null,
    maxAmount: cfg.perTxCapBase != null ? Number(cfg.perTxCapBase) : null,
    wblockMint: cfg.solblockMint || null, solanaCluster: cfg.solanaCluster,
  }));

  on('GET', /^\/api\/bridge\/reserves$/, (req, res) => {
    const mints = store.all('mints') || [];
    const releases = store.all('releases') || [];
    json(res, 200, {
      reserveBlock: reserves(mints, releases).toString(),
      wrappedSupply: outstanding(mints, releases).toString(),
      feeBps: cfg.feeBps ?? 0,
      minAmount: cfg.minAmountBase != null ? Number(cfg.minAmountBase) : null,
      maxAmount: cfg.perTxCapBase != null ? Number(cfg.perTxCapBase) : null,
    });
  });

  on('GET', /^\/api\/bridge\/health$/, (req, res) => json(res, 200, health(store, cfg, overrides.relayer)));

  on('GET', /^\/api\/bridge\/transactions$/, (req, res) =>
    json(res, 200, { transactions: [...(store.all('deposits') || []), ...(store.all('burns') || [])].map(pub).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 200) }));

  on('GET', /^\/api\/bridge\/transactions\/([^/]+)$/, (req, res, m) => {
    const id = decodeURIComponent(m[1]);
    const t = store.get('deposits', id) || store.get('burns', id);
    if (!t) return json(res, 404, { error: 'not found' });
    json(res, 200, pub(t));
  });

  on('GET', /^\/api\/bridge\/balance$/, async (req, res, _m, url) => {
    const owner = url.searchParams.get('owner');
    if (!owner || !cfg.solblockMint) return json(res, 200, { solblock: null });
    try {
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const conn = new Connection(cfg.solanaRpc, 'confirmed');
      const accts = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(cfg.solblockMint) });
      let bal = 0n;
      for (const a of accts.value) bal += BigInt(a.account.data.parsed.info.tokenAmount.amount);
      json(res, 200, { solblock: bal.toString() });
    } catch { json(res, 200, { solblock: null }); }
  });

  on('POST', /^\/api\/bridge\/transfer$/, async (req, res) => {
    if (!isLive) return json(res, 503, { error: 'bridge not live yet' });
    const b = await readJson(req, 8 * 1024).catch(() => ({}));
    const direction = toDirection(b.direction);
    if (!direction) return json(res, 400, { error: 'bad direction' });
    if (!b.sourceTxid) return json(res, 400, { error: 'sourceTxid required (send the source tx first)' });
    if (!b.to) return json(res, 400, { error: 'destination required' });
    try {
      const rec = await engine.submitSource({ direction, sourceTx: String(b.sourceTxid), destination: String(b.to), grossAmountBase: b.amountBase });
      json(res, 200, { id: rec.id, state: rec.state });
    } catch (e) { json(res, 400, { error: String(e && e.message || e) }); }
  });

  // Build an UNSIGNED Solana burn(+memo) tx for the user to sign in their wallet.
  on('POST', /^\/api\/bridge\/burn\/build$/, async (req, res) => {
    if (!isLive) return json(res, 503, { error: 'bridge not live yet' });
    const b = await readJson(req, 8 * 1024).catch(() => ({}));
    if (!b.owner || !b.amountBase || !b.to) return json(res, 400, { error: 'owner, amountBase, to required' });
    try {
      const built = await buildBurnTx(cfg, b.owner, BigInt(b.amountBase), String(b.to));
      json(res, 200, built); // { txBase64 }
    } catch (e) { json(res, 400, { error: String(e && e.message || e) }); }
  });

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return json(res, 400, { error: 'bad url' }); }
    const pathn = url.pathname;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathn);
      if (m) { try { return await r.fn(req, res, m, url); } catch (e) { return json(res, 500, { error: String(e && e.message || e) }); } }
    }
    json(res, 404, { error: 'not found' });
  });

  // Optional relayer loop — wired with the real adapters. Gated: the minter and
  // reserve-signer throw unless sends are enabled, so nothing settles falsely.
  let relayer = null, timer = null;
  function startRelayer() {
    if (relayer) return relayer;
    relayer = new Relayer({
      engine, store, config: cfg,
      blockClient: createBlockWatch({ explorerBase: cfg.blockNodeUrl }),
      solClient: overrides.solClient || null, // set in production (createSolWatch) once a Connection exists
      minter: makeMinter(cfg, store),
      reserveSigner: makeReserveSigner(cfg, store),
      log: (...a) => console.log('[bridge]', ...a),
    });
    const loop = async () => { try { await relayer.tick(); } catch (_) {} timer = setTimeout(loop, relayer.backoffMs(5000, 60000)); };
    timer = setTimeout(loop, 1000);
    return relayer;
  }
  function stop() { if (timer) clearTimeout(timer); if (server.listening) server.close(); }

  return { server, store, engine, cfg, startRelayer, stop, _routes: routes };
}

// Build an unsigned base64 Solana tx: burn `amountBase` wBLOCK from `owner`'s ATA
// + a Memo carrying the BLOCK redemption address. Lazy-imports so the server runs
// without the Solana deps for the non-Solana endpoints.
async function buildBurnTx(cfg, owner, amountBase, blockAddr) {
  if (!cfg.solblockMint) throw new Error('no wBLOCK mint configured');
  const web3 = await import('@solana/web3.js');
  const spl = await import('@solana/spl-token');
  const ownerPk = new web3.PublicKey(owner);
  const mintPk = new web3.PublicKey(cfg.solblockMint);
  const ata = await spl.getAssociatedTokenAddress(mintPk, ownerPk);
  const conn = new web3.Connection(cfg.solanaRpc, 'confirmed');
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  const MEMO = new web3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
  const ixs = [
    spl.createBurnInstruction(ata, mintPk, ownerPk, amountBase),
    new web3.TransactionInstruction({ keys: [], programId: MEMO, data: Buffer.from(blockAddr, 'utf8') }),
  ];
  const msg = new web3.TransactionMessage({ payerKey: ownerPk, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new web3.VersionedTransaction(msg);
  return { txBase64: Buffer.from(tx.serialize()).toString('base64') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  const port = Number(process.env.BRIDGE_PORT || 8797);
  if (process.env.BRIDGE_RELAYER_ENABLED === '1') app.startRelayer();
  app.server.listen(port, '127.0.0.1', () =>
    console.log(`[bridge] api on 127.0.0.1:${port} live=${!!app.cfg.solblockMint && !app.cfg.paused} relayer=${process.env.BRIDGE_RELAYER_ENABLED === '1'}`));
}

export default createApp;
