// custody-solana.js — SOL custody adapter (deposit-watch + payout) via
// @solana/web3.js. Modeled on the bridge's solwatch pattern: scan signatures for
// the pool address forward from a slot cursor, and credit the net lamports that
// landed in our account. Payout is a plain SystemProgram.transfer, signed by the
// pool's SOL hot key. Defaults to DEVNET (testnet-first).
//
// Uniform adapter interface (see custody.js).
'use strict';
const fs = require('node:fs');

function createSolanaAdapter(opts = {}) {
  const RPC = opts.rpcUrl || process.env.AMM_SOL_RPC || 'https://api.devnet.solana.com';
  const KEYPATH = opts.keypairPath || process.env.AMM_SOL_KEYPAIR || '/opt/blockle/secrets/amm-sol.json';
  let web3 = null, conn = null, kp = null, pub = null, loaded = false, loadErr = null;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      web3 = require('@solana/web3.js');
      const arr = JSON.parse(fs.readFileSync(KEYPATH, 'utf8'));
      kp = web3.Keypair.fromSecretKey(Uint8Array.from(arr));
      pub = kp.publicKey;
      conn = new web3.Connection(RPC, 'confirmed');
    } catch (e) { loadErr = e; }
  }

  return {
    chain: 'solana', asset: 'SOL', decimals: 9,
    ready() { load(); return !!(kp && conn && !loadErr); },
    address() { load(); return pub ? pub.toBase58() : null; },

    async observedBalanceBase() {
      load(); if (!conn) throw loadErr || new Error('solana adapter not loaded');
      return BigInt(await conn.getBalance(pub, 'confirmed'));
    },

    // Deposits since slot `sinceCursor`: scan recent signatures newest→oldest, keep
    // those above the cursor, and for each compute the net lamports credited to us.
    async listDeposits(sinceCursor) {
      load(); if (!conn) return { cursor: Number(sinceCursor || 0), deposits: [] };
      const since = Number(sinceCursor || 0);
      const sigs = await conn.getSignaturesForAddress(pub, { limit: 50 }, 'confirmed');
      let maxSlot = since; const deposits = [];
      for (const s of sigs) {
        if (s.err) continue;
        if (Number(s.slot) <= since) continue;
        maxSlot = Math.max(maxSlot, Number(s.slot));
        let tx; try { tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); } catch { continue; }
        if (!tx || !tx.meta) continue;
        const keys = tx.transaction.message.accountKeys.map((k) => (k.pubkey ? k.pubkey.toBase58() : String(k)));
        const idx = keys.indexOf(pub.toBase58());
        if (idx < 0) continue;
        const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
        if (delta > 0n) deposits.push({ txid: s.signature, amountBase: delta.toString(), slot: Number(s.slot) });
      }
      return { cursor: maxSlot, deposits };
    },

    async payout(toAddr, amountBase) {
      load(); if (!kp) throw Object.assign(new Error('SOL pool key not provisioned'), { code: 'NO_KEY' });
      const toPk = new web3.PublicKey(toAddr);
      const tx = new web3.Transaction().add(web3.SystemProgram.transfer({
        fromPubkey: pub, toPubkey: toPk, lamports: Number(BigInt(amountBase)),
      }));
      const sig = await web3.sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      return { txid: sig };
    },
  };
}

module.exports = { createSolanaAdapter };
