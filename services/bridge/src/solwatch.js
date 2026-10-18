// Solana burn watcher — finds finalized wBLOCK burns and the BLOCK redemption
// address the user attached as an SPL-memo. Read-only (@solana/web3.js). It does
// NOT release BLOCK; it only surfaces verified burn events for the relayer.
//
// A redeem = the user burns wBLOCK from their token account and includes a Memo
// instruction whose data is their bech32 `block1…` address. We page
// getSignaturesForAddress(mint) forward from the last processed slot, read each
// finalized tx, and extract (burned amount, memo address).

const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export function createSolWatch({ connection, maxPage = 100 }) {
  if (!connection) throw new Error('solwatch needs a @solana/web3.js Connection');

  function extractBurn(tx, mint) {
    // Compare pre/post token balances for the mint to find the burned amount,
    // and pull the memo from the Memo program instruction (if present).
    const meta = tx && tx.meta;
    if (!meta || meta.err) return null;
    const pre = meta.preTokenBalances || [];
    const post = meta.postTokenBalances || [];
    let burned = 0n;
    for (const p of pre) {
      if (p.mint !== mint) continue;
      const q = post.find((x) => x.accountIndex === p.accountIndex);
      const a = BigInt(p.uiTokenAmount?.amount ?? '0');
      const b = BigInt(q?.uiTokenAmount?.amount ?? '0');
      if (a > b) burned += a - b;
    }
    if (burned <= 0n) return null;
    let memo = null;
    const msg = tx.transaction?.message;
    const instrs = msg?.instructions || [];
    for (const ix of instrs) {
      if (ix.program === 'spl-memo' || ix.programId?.toString?.() === MEMO_PROGRAM) {
        memo = typeof ix.parsed === 'string' ? ix.parsed : (ix.parsed?.toString?.() ?? null);
      }
    }
    for (const ix of meta.innerInstructions || []) {
      for (const inner of ix.instructions || []) {
        if (inner.program === 'spl-memo') memo = inner.parsed ?? memo;
      }
    }
    return { amountBase: burned.toString(), blockDestination: memo };
  }

  return {
    /** Burns of `mint` with slot > sinceSlot; each { signature, amountBase, blockDestination, slot, finalized }. */
    async burnsSince(mint, sinceSlot = 0) {
      const { PublicKey } = await import('@solana/web3.js');
      const mintPk = new PublicKey(mint);
      const sigs = await connection.getSignaturesForAddress(mintPk, { limit: maxPage }, 'finalized');
      const out = [];
      for (const s of sigs) {
        if ((s.slot ?? 0) <= sinceSlot) continue;
        if (s.err) continue;
        const tx = await connection.getParsedTransaction(s.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
        const burn = extractBurn(tx, mint);
        if (!burn) continue;
        out.push({ signature: s.signature, slot: s.slot ?? 0, finalized: true, ...burn });
      }
      // oldest first so cursors advance monotonically
      out.sort((a, b) => a.slot - b.slot);
      return out;
    },
  };
}

export default createSolWatch;
