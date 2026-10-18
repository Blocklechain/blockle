// BLOCK deposit watcher — confirms a specific BLOCK txid paid the bridge address
// and how deep it is buried. Read-only: reads the node explorer exactly as
// services/settlement/src/chain.ts does (GET /explorer/tx/{id}); no keys, no wasm.
//
// txid convention (see sdk/src/hex.ts + settlement): the wasm signer returns a
// RAW hex txid while the explorer addresses txs by the DISPLAY hash (reversed).
// A user may hand us either, so we try the id as-given and reversed.
//
// Node tx JSON shape (chain/crates/node/src/pool.rs tx_json):
//   { txid, block_hash, confirmations, outputs: [{ vout, address, amount }], ... }
// `amount` is in BLOCK base units (8dp). `confirmations` null/absent => 0 (mempool).

function reverseHex(h) {
  if (typeof h !== 'string' || h.length % 2 !== 0) return h;
  const b = [];
  for (let i = 0; i < h.length; i += 2) b.push(h.slice(i, i + 2));
  return b.reverse().join('');
}

export function createBlockWatch({ explorerBase, fetchImpl = fetch }) {
  if (!explorerBase) throw new Error('blockwatch needs explorerBase');
  const base = String(explorerBase).replace(/\/+$/, '');

  async function fetchTx(id) {
    try {
      const r = await fetchImpl(`${base}/explorer/tx/${id}`, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  return {
    /** Confirm `txid` paid `bridgeAddress`; returns { amountBase, confirmations, displayTxid } or null. */
    async confirmTx(txid, bridgeAddress) {
      let tx = await fetchTx(txid);
      let used = txid;
      if (!tx || !tx.outputs) {
        used = reverseHex(txid);
        tx = await fetchTx(used);
      }
      if (!tx || !Array.isArray(tx.outputs)) return null;
      let amountBase = 0n;
      for (const o of tx.outputs) {
        if (o && o.address === bridgeAddress) amountBase += BigInt(o.amount ?? 0);
      }
      if (amountBase <= 0n) return null; // did not pay the bridge
      const confirmations = Number(tx.confirmations ?? 0) || 0;
      return { amountBase: amountBase.toString(), confirmations, displayTxid: tx.txid ?? used };
    },
  };
}

export default createBlockWatch;
