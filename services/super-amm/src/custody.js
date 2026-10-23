// custody.js — per-chain custody adapters: watch for deposits + sign payouts from
// the pool's hot wallets. This is the ONLY part of the AMM that touches real keys
// and moves real funds, so each adapter is built and proven on testnet/devnet first.
//
// Uniform adapter interface (one per asset the pool trades):
//   {
//     chain, asset, decimals,
//     address(),                            // the pool deposit/hot-wallet address
//     async observedBalanceBase(),          // on-chain balance we hold (solvency)
//     async listDeposits(sinceCursor),      // new CONFIRMED incoming deposits
//                                           //   -> { cursor, deposits:[{txid,amountBase}] }
//     async payout(toAddr, amountBase),     // build+sign+broadcast -> { txid }
//     ready(),                              // true once keys/config are present
//   }
//
// The registry exposes getAdapter(sym). Assets without a built adapter return a
// stub whose ready()===false and whose payout throws NOT_IMPLEMENTED, so the server
// gates any live trade in that currency until the real adapter lands.
'use strict';
const fs = require('node:fs');
const { createSolanaAdapter } = require('./custody-solana.js');
const { createEthereumAdapter } = require('./custody-ethereum.js');
const { createUtxoAdapter } = require('./custody-utxo.js');

// ---- BLOCK (native) adapter — same ML-DSA signer the wallets/faucet use --------
function createBlockAdapter(opts = {}) {
  const NODE = (opts.nodeUrl || process.env.AMM_BLOCK_NODE || 'http://127.0.0.1:8455' /* testnet default */).replace(/\/+$/, '');
  const KEYPATH = opts.keypairPath || process.env.AMM_BLOCK_KEYPAIR || '/opt/blockle/secrets/amm-block.json';
  const WASM = opts.wasmPath || '../wasm/blockle_wasm.js';
  const FEE_BASE = BigInt(opts.feeBase || 10000n);
  let kp = null, wasm = null;
  try { kp = JSON.parse(fs.readFileSync(KEYPATH, 'utf8')); } catch (_) { /* not provisioned yet */ }
  function loadWasm() { if (!wasm) wasm = require(WASM); return wasm; }

  async function nodeGet(p) {
    const r = await fetch(NODE + p, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('GET ' + p + ' ' + r.status);
    return r.json();
  }
  async function rpc(method, params) {
    const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'amm', method, params }) });
    const b = await r.json().catch(() => ({}));
    if (b && b.error) throw new Error(method + ': ' + JSON.stringify(b.error));
    return b.result != null ? b.result : b;
  }

  return {
    chain: 'block', asset: 'BLOCK', decimals: 8,
    ready() { return !!kp; },
    address() { return kp && kp.address; },
    async observedBalanceBase() {
      const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(kp.address));
      return BigInt(u.spendable || 0);
    },
    // Incoming confirmed deposits since `sinceCursor` (a block height). Uses the
    // address history; only net-positive (received) entries count as deposits.
    async listDeposits(sinceCursor) {
      const since = Number(sinceCursor || 0);
      const a = await nodeGet('/explorer/address/' + encodeURIComponent(kp.address));
      const hist = (a.history || []).filter((h) => Number(h.net) > 0 && Number(h.height) > since);
      let maxH = since;
      const deposits = hist.map((h) => { maxH = Math.max(maxH, Number(h.height)); return { txid: h.txid, amountBase: BigInt(h.net).toString(), height: Number(h.height) }; });
      return { cursor: maxH, deposits };
    },
    async payout(toAddr, amountBase) {
      if (!kp) throw Object.assign(new Error('BLOCK pool key not provisioned'), { code: 'NO_KEY' });
      const w = loadWasm();
      const u = await nodeGet('/explorer/utxos/' + encodeURIComponent(kp.address));
      const utxos = (u.utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, amount: Number(x.amount) }));
      const built = JSON.parse(w.build_transfer(kp.secretKey, kp.publicKey, JSON.stringify(utxos), toAddr, BigInt(amountBase), FEE_BASE));
      await rpc('submitrawtransaction', [built.raw]);
      return { txid: built.txid };
    },
  };
}

// ---- stub adapter for chains not yet wired ------------------------------------
function stubAdapter(asset, decimals, chain) {
  return {
    chain: chain || asset.toLowerCase(), asset, decimals,
    ready() { return false; },
    address() { return null; },
    async observedBalanceBase() { return 0n; },
    async listDeposits() { return { cursor: 0, deposits: [] }; },
    async payout() { throw Object.assign(new Error(asset + ' custody adapter not implemented yet'), { code: 'NOT_IMPLEMENTED' }); },
  };
}

// ---- registry ------------------------------------------------------------------
function createCustody(opts = {}) {
  const adapters = {
    BLOCK: createBlockAdapter(opts.block || {}),
    // TODO: real adapters, testnet/devnet first, in this order:
    SOL: createSolanaAdapter(opts.sol || {}),   // devnet-first; ready() once amm-sol.json exists
    ETH: createEthereumAdapter(opts.eth || {}), // sepolia-first; ready() once amm-eth.json exists
    BTC: createUtxoAdapter('BTC', opts.btc || {}),
    LTC: createUtxoAdapter('LTC', opts.ltc || {}),
    DOGE: createUtxoAdapter('DOGE', opts.doge || {}), // uses the doge-esplora indexer I built
  };
  return {
    get(sym) { return adapters[String(sym).toUpperCase()] || null; },
    ready(sym) { const a = adapters[String(sym).toUpperCase()]; return !!(a && a.ready()); },
    readyAssets() { return Object.keys(adapters).filter((s) => adapters[s].ready()); },
    all() { return adapters; },
  };
}

module.exports = { createCustody, createBlockAdapter, stubAdapter };
