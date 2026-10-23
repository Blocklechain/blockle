// custody-utxo.js — one UTXO custody adapter factory for BTC, LTC and DOGE.
// Deposit-watch + payout over an Esplora API (DOGE uses the indexer I built;
// BTC/LTC use public esplora). Signing via bitcoinjs-lib: P2WPKH (segwit) for
// BTC/LTC, legacy P2PKH for DOGE. Key file: { privateKeyHex }.
//
// Uniform adapter interface (see custody.js). testnet-first via per-coin config.
'use strict';
const fs = require('node:fs');

// per-coin params (mainnet). `segwit` picks P2WPKH vs legacy P2PKH; `feeRate` is
// sat(or koinu)/vByte; `esplora` is the API base.
const COINS = {
  BTC: { asset: 'BTC', chain: 'bitcoin', decimals: 8, segwit: true, feeRate: 8n,
    esplora: 'https://blockstream.info/api',
    network: { messagePrefix: '\x18Bitcoin Signed Message:\n', bech32: 'bc', bip32: { public: 0x0488b21e, private: 0x0488ade4 }, pubKeyHash: 0x00, scriptHash: 0x05, wif: 0x80 } },
  LTC: { asset: 'LTC', chain: 'litecoin', decimals: 8, segwit: true, feeRate: 20n,
    esplora: 'https://litecoinspace.org/api',
    network: { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 } },
  DOGE: { asset: 'DOGE', chain: 'dogecoin', decimals: 8, segwit: false, feeRate: 2000n,
    esplora: 'https://doge-esplora.blockle.org',
    network: { messagePrefix: '\x19Dogecoin Signed Message:\n', bip32: { public: 0x02facafd, private: 0x02fac398 }, pubKeyHash: 0x1e, scriptHash: 0x16, wif: 0x9e } },
};

function createUtxoAdapter(sym, opts = {}) {
  const C = COINS[sym]; if (!C) throw new Error('no UTXO config for ' + sym);
  const ESPLORA = (opts.esplora || process.env['AMM_' + sym + '_ESPLORA'] || C.esplora).replace(/\/+$/, '');
  const KEYPATH = opts.keypairPath || process.env['AMM_' + sym + '_KEYPAIR'] || '/opt/blockle/secrets/amm-' + sym.toLowerCase() + '.json';
  let lib = null, ecpair = null, keyPair = null, payment = null, loaded = false, loadErr = null;

  function load() {
    if (loaded) return; loaded = true;
    try {
      lib = require('bitcoinjs-lib');
      const ecc = require('tiny-secp256k1');
      const { ECPairFactory } = require('ecpair');
      lib.initEccLib && lib.initEccLib(ecc);
      ecpair = ECPairFactory(ecc);
      const kp = JSON.parse(fs.readFileSync(KEYPATH, 'utf8'));
      keyPair = ecpair.fromPrivateKey(Buffer.from(kp.privateKeyHex, 'hex'), { network: C.network });
      payment = C.segwit
        ? lib.payments.p2wpkh({ pubkey: keyPair.publicKey, network: C.network })
        : lib.payments.p2pkh({ pubkey: keyPair.publicKey, network: C.network });
    } catch (e) { loadErr = e; }
  }

  async function api(path, init) {
    const r = await fetch(ESPLORA + path, init);
    if (!r.ok) throw new Error(sym + ' esplora ' + path + ' ' + r.status);
    return r;
  }

  return {
    chain: C.chain, asset: sym, decimals: C.decimals,
    ready() { load(); return !!(keyPair && payment && !loadErr); },
    address() { load(); return payment ? payment.address : null; },

    async observedBalanceBase() {
      load(); const r = await api('/address/' + payment.address); const j = await r.json();
      const cs = j.chain_stats || {};
      return BigInt(cs.funded_txo_sum || 0) - BigInt(cs.spent_txo_sum || 0);
    },

    // All incoming txs to our address (settle loop dedups by claimed txid).
    async listDeposits(sinceCursor) {
      load();
      let txs = []; try { txs = await (await api('/address/' + payment.address + '/txs')).json(); } catch { return { cursor: Number(sinceCursor || 0), deposits: [] }; }
      const me = payment.address; const deposits = [];
      for (const tx of txs) {
        let credited = 0n;
        for (const vout of (tx.vout || [])) if (vout.scriptpubkey_address === me) credited += BigInt(vout.value || 0);
        if (credited > 0n) deposits.push({ txid: tx.txid, amountBase: credited.toString(), confirmed: !!(tx.status && tx.status.confirmed) });
      }
      return { cursor: Number(sinceCursor || 0), deposits };
    },

    async payout(toAddr, amountBase) {
      load(); if (!keyPair) throw Object.assign(new Error(sym + ' pool key not provisioned'), { code: 'NO_KEY' });
      const want = BigInt(amountBase);
      const utxos = await (await api('/address/' + payment.address + '/utxo')).json();
      // greedily select inputs
      utxos.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
      const psbt = new lib.Psbt({ network: C.network });
      let inSum = 0n; const chosen = [];
      const feeGuess = C.feeRate * 200n; // rough; refined below
      for (const u of utxos) { chosen.push(u); inSum += BigInt(u.value); if (inSum >= want + feeGuess) break; }
      if (inSum < want + feeGuess) throw Object.assign(new Error('insufficient ' + sym + ' pool funds'), { code: 'NO_FUNDS' });
      for (const u of chosen) {
        if (C.segwit) {
          psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: payment.output, value: Number(u.value) } });
        } else {
          const rawHex = await (await api('/tx/' + u.txid + '/hex')).text().catch(() => null) || (await (await api('/tx/' + u.txid)).json());
          psbt.addInput({ hash: u.txid, index: u.vout, nonWitnessUtxo: Buffer.from(typeof rawHex === 'string' ? rawHex : rawHex.hex, 'hex') });
        }
      }
      const vbytes = BigInt((C.segwit ? 68 : 148) * chosen.length + 34 * 2 + 10);
      const fee = vbytes * C.feeRate;
      const change = inSum - want - fee;
      psbt.addOutput({ address: toAddr, value: Number(want) });
      if (change > 546n) psbt.addOutput({ address: payment.address, value: Number(change) });
      chosen.forEach((_, i) => psbt.signInput(i, keyPair));
      psbt.finalizeAllInputs();
      const rawHex = psbt.extractTransaction().toHex();
      const txid = (await (await api('/tx', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: rawHex })).text()).trim();
      return { txid };
    },
  };
}

module.exports = { createUtxoAdapter, COINS };
