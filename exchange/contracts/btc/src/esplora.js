'use strict';

/**
 * Esplora wiring for the BTC leg — the thin, node-dependent shell between a
 * finalized PSBT (built/signed by src/htlc.js) and a LIVE spend on Bitcoin
 * testnet3 / signet / regtest / mainnet.
 *
 * src/htlc.js is pure: it derives the P2WSH address, builds the lock/redeem/
 * refund PSBTs, signs them, and extracts a fully-finalized raw transaction. It
 * deliberately has NO network I/O. This module supplies exactly the two chain
 * interactions a real swap needs, against the per-network Esplora endpoint in
 * config.json (`networks.<net>.esplora`):
 *
 *   1. UTXO discovery — what can the depositor / receiver / refunder spend?
 *   2. Broadcast       — POST the finalized raw tx (`POST /tx`).
 *
 * Plus fee estimation + confirmation polling, which every live spend needs.
 *
 * NON-CUSTODIAL + KEYLESS: this module never sees a private key. It fetches
 * public UTXO/fee data and relays a tx the CALLER already signed. The funded
 * BTC hot wallet (config: htlc.btc.hotWallet on the relay side) is whatever
 * address the operator funds and signs from; its key stays in the operator's
 * own signer, never here and never in the repo.
 *
 * Esplora is Blockstream's open REST API (blockstream.info/testnet/api) and is
 * API-compatible with a self-hosted `electrs`/`esplora` and mempool.space. No
 * SDK or extra dependency: uses Node 18+ global `fetch`.
 *
 * Reference: https://github.com/Blockstream/esplora/blob/master/API.md
 */

const fs = require('fs');
const path = require('path');

/** Read the per-network Esplora base URL from config.json. */
function esploraFor(network, cfgPath = path.join(__dirname, '..', 'config.json')) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const net = cfg.networks && cfg.networks[network];
  if (!net || !net.esplora) throw new Error(`no esplora endpoint for network '${network}' in config.json`);
  if (network === 'mainnet' && cfg.mainnet_enabled !== true) {
    throw new Error('mainnet is gated: set mainnet_enabled=true only after a recorded legal/compliance review');
  }
  return net.esplora.replace(/\/+$/, '');
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}

/**
 * UTXOs spendable by `address`, mapped into the exact shape src/htlc.js wants.
 *
 * Esplora `GET /address/:addr/utxo` returns `[{ txid, vout, value, status }]`.
 * For a native-segwit spend every input needs a `witnessUtxo` = { script,
 * value }, where `script` is the output's scriptPubKey. We fetch the
 * scriptPubKey from `GET /tx/:txid` (output `vout`).
 *
 * The returned objects carry BOTH:
 *   - `{ txid, index, value }`     — the `utxo` arg for buildRedeemPsbt/buildRefundPsbt
 *   - `{ hash, index, witnessUtxo }` — a ready `inputs[]` entry for buildLockPsbt
 */
async function fetchUtxos(baseUrl, address) {
  const utxos = await getJson(`${baseUrl}/address/${address}/utxo`);
  const out = [];
  for (const u of utxos) {
    const tx = await getJson(`${baseUrl}/tx/${u.txid}`);
    const spk = tx.vout[u.vout].scriptpubkey; // hex
    out.push({
      txid: u.txid,
      index: u.vout,
      value: u.value,
      confirmed: !!(u.status && u.status.confirmed),
      // ready-to-use PSBT input for buildLockPsbt():
      hash: u.txid,
      witnessUtxo: { script: Buffer.from(spk, 'hex'), value: u.value },
    });
  }
  return out;
}

/** The single HTLC output funded at `htlc.address`, as the `utxo` arg for
 *  buildRedeemPsbt/buildRefundPsbt. Returns null until the lock tx is seen. */
async function fetchHtlcUtxo(baseUrl, htlcAddress) {
  const utxos = await getJson(`${baseUrl}/address/${htlcAddress}/utxo`);
  if (!utxos.length) return null;
  const u = utxos[0];
  return { txid: u.txid, index: u.vout, value: u.value, confirmed: !!(u.status && u.status.confirmed) };
}

/** sat/vB fee estimate for `targetBlocks` confirmation (default next-ish). */
async function fetchFeeRate(baseUrl, targetBlocks = 3) {
  const est = await getJson(`${baseUrl}/fee-estimates`);
  // map of confirmation-target -> sat/vB; fall back to 1 sat/vB on regtest
  return Math.ceil(est[String(targetBlocks)] || est['6'] || 1);
}

/**
 * Broadcast a finalized raw transaction. `rawTxHex` comes from
 * `psbt.extractTransaction().toHex()` after finalizeRedeem/finalizeRefund (or a
 * fully-signed lock tx). Esplora `POST /tx` takes the hex as the request body
 * and returns the txid as plain text.
 */
async function broadcast(baseUrl, rawTxHex) {
  const r = await fetch(`${baseUrl}/tx`, { method: 'POST', body: rawTxHex });
  const text = (await r.text()).trim();
  if (!r.ok) throw new Error(`broadcast failed: ${r.status} ${text}`);
  return text; // txid
}

/** Confirmation count for `txid` (0 if unconfirmed / not yet seen). */
async function confirmations(baseUrl, txid) {
  const status = await getJson(`${baseUrl}/tx/${txid}/status`);
  if (!status.confirmed) return 0;
  const tip = Number(await (await fetch(`${baseUrl}/blocks/tip/height`)).text());
  return tip - status.block_height + 1;
}

/** Poll until `txid` reaches `depth` confirmations (or `timeoutMs` elapses). */
async function waitForConfirmations(baseUrl, txid, depth = 2, { intervalMs = 15000, timeoutMs = 3600_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await confirmations(baseUrl, txid);
    if (n >= depth) return n;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${depth} confs on ${txid} (have ${n})`);
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

module.exports = {
  esploraFor,
  fetchUtxos,
  fetchHtlcUtxo,
  fetchFeeRate,
  broadcast,
  confirmations,
  waitForConfirmations,
};
