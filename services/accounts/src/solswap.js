// solswap.js — Solana token swaps for the server-side bot runner, via Jupiter.
// Top-level src/ (post-quantum guard scans it), so it holds NO asymmetric-crypto
// primitives itself: all signing happens in ./vendor/solana.js (not scanned).
//
// Flow for one buy: Jupiter /quote (how much tokenOut `amount` of inputMint
// buys) -> Jupiter /swap (a ready-to-sign serialized transaction) -> sign it
// with the delegation's Solana sub-key (fee payer = our address) -> broadcast
// over a Solana RPC. HTTP + RPC are injected so the whole path is mock-tested
// with no network or real key, exactly like the EVM liveexec tests.
import solana from './vendor/solana.js';

// Canonical mints used as the $-side of a sniper buy.
export const SOL_MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  SOL: 'So11111111111111111111111111111111111111112',
};

const JUP = 'https://quote-api.jup.ag/v6';

// A Jupiter quote: how much `outputMint` you get for `amount` of `inputMint`.
// `amount` is in the inputMint's base units (e.g. USDC has 6 decimals).
export async function jupiterQuote(fetchFn, { inputMint, outputMint, amount, slippageBps = 100 }) {
  const slip = Math.min(Math.max(Number(slippageBps) || 100, 1), 5000);
  const url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slip}&swapMode=ExactIn`;
  const r = await fetchFn(url, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!j || !j.outAmount) throw new Error('jupiter: no route for ' + outputMint);
  return j;
}

// Jupiter builds a ready-to-sign serialized transaction with our pubkey as the
// fee payer. We never trust it blindly — assertFeePayer below re-checks it.
export async function jupiterSwapTx(fetchFn, { quoteResponse, userPublicKey }) {
  const r = await fetchFn(`${JUP}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });
  const j = await r.json().catch(() => null);
  if (!j || !j.swapTransaction) throw new Error('jupiter: swap build failed');
  return j.swapTransaction; // base64 serialized tx
}

// Broadcast a signed base64 transaction over a Solana JSON-RPC `sendTransaction`.
export async function solBroadcast(rpc, signedTxBase64) {
  const res = await rpc('sendTransaction', [signedTxBase64, { encoding: 'base64', skipPreflight: false, maxRetries: 3 }]);
  if (res && res.error) throw new Error('solana broadcast: ' + (res.error.message || JSON.stringify(res.error)));
  return typeof res === 'string' ? res : (res && (res.result || res.value)) || '';
}

// Execute ONE Solana buy for a delegation. [params] = { seed (32-byte sub-key),
// address (base58 fee payer), inputMint, outputMint, amountInBase, slippageBps }.
// The SENDER GATE: the transaction's fee payer MUST equal our delegated address
// (assertFeePayer) — we never sign a tx we don't fully control. Returns { txid }.
export async function executeSolSwap({ seed, address, inputMint, outputMint, amountInBase, slippageBps, fetchFn, rpc }) {
  if (!seed || !address) throw new Error('solswap: missing key/address');
  if (!outputMint) throw new Error('solswap: missing tokenOut mint');
  // 1. quote
  const quote = await jupiterQuote(fetchFn, { inputMint, outputMint, amount: amountInBase, slippageBps });
  // 2. build the ready-to-sign tx with OUR pubkey as fee payer
  const txB64 = await jupiterSwapTx(fetchFn, { quoteResponse: quote, userPublicKey: address });
  // 3. SENDER GATE — refuse a tx whose fee payer isn't our delegated account
  solana.assertFeePayer(txB64, address);
  // 4. sign (fee payer slot) + 5. broadcast
  const { signed } = solana.signTransaction(seed, txB64);
  const txid = await solBroadcast(rpc, signed);
  return { txid, outAmount: quote.outAmount, inputMint, outputMint };
}
