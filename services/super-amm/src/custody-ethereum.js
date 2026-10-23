// custody-ethereum.js — ETH custody adapter (deposit-watch + signed payout) via
// ethers v6. Deposits: scan blocks forward from a cursor for txs paying our pool
// address. Payout: a signed value transfer (ethers handles nonce/gas/EIP-1559).
// Defaults to SEPOLIA testnet (testnet-first). Key file: { address, privateKey }.
//
// Uniform adapter interface (see custody.js).
'use strict';
const fs = require('node:fs');

function createEthereumAdapter(opts = {}) {
  const RPC = opts.rpcUrl || process.env.AMM_ETH_RPC || 'https://ethereum-sepolia-rpc.publicnode.com';
  const KEYPATH = opts.keypairPath || process.env.AMM_ETH_KEYPAIR || '/opt/blockle/secrets/amm-eth.json';
  const MAX_SCAN = Number(opts.maxScan || 200); // cap blocks scanned per tick
  let ethers = null, provider = null, wallet = null, loaded = false, loadErr = null;

  function load() {
    if (loaded) return; loaded = true;
    try {
      ethers = require('ethers');
      const kp = JSON.parse(fs.readFileSync(KEYPATH, 'utf8'));
      provider = new ethers.JsonRpcProvider(RPC);
      wallet = new ethers.Wallet(kp.privateKey, provider);
    } catch (e) { loadErr = e; }
  }

  return {
    chain: 'ethereum', asset: 'ETH', decimals: 18,
    ready() { load(); return !!(wallet && provider && !loadErr); },
    address() { load(); return wallet ? wallet.address : null; },

    async observedBalanceBase() {
      load(); if (!provider) throw loadErr || new Error('eth adapter not loaded');
      return BigInt(await provider.getBalance(wallet.address));
    },

    // Deposits since block `sinceCursor`: scan forward (capped) for txs to our addr.
    async listDeposits(sinceCursor) {
      load(); if (!provider) return { cursor: Number(sinceCursor || 0), deposits: [] };
      const latest = await provider.getBlockNumber();
      let from = Number(sinceCursor || 0);
      if (from === 0) from = Math.max(0, latest - 1); // first run: don't scan all history
      const to = Math.min(latest, from + MAX_SCAN);
      const me = wallet.address.toLowerCase();
      const deposits = [];
      for (let n = from + 1; n <= to; n++) {
        const blk = await provider.getBlock(n, true);
        if (!blk) continue;
        for (const tx of blk.prefetchedTransactions || []) {
          if (tx.to && tx.to.toLowerCase() === me && tx.value > 0n) deposits.push({ txid: tx.hash, amountBase: tx.value.toString(), block: n });
        }
      }
      return { cursor: to, deposits };
    },

    async payout(toAddr, amountBase) {
      load(); if (!wallet) throw Object.assign(new Error('ETH pool key not provisioned'), { code: 'NO_KEY' });
      const tx = await wallet.sendTransaction({ to: toAddr, value: BigInt(amountBase) });
      const rc = await tx.wait(1);
      return { txid: rc.hash };
    },
  };
}

module.exports = { createEthereumAdapter };
