// liquidity_sol.js — the SOL (Solana, ed25519) leg of the liquidity treasury's
// on-chain settlement. Deposits are verified over JSON-RPC (getTransaction: the
// tx must be confirmed, successful, and raise the treasury's lamport balance by
// at least the swap's amountIn); payouts are native System-program transfers
// built here from scratch (legacy message, no third-party deps), signed with the
// treasury's Solana key (vendor/solana.js — the same seed derivation as
// liquidity.js custodialAddresses: sha256('sol:' + LIQUIDITY_TREASURY_SEED)),
// and broadcast with sendTransaction. GATED by LIQUIDITY_MAINNET like every other
// leg: with the gate off payoutSol throws and no funds move.
//
// Deterministic + injectable (rpc) — unit-tested with a canned RPC + test seed.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sol = require('./vendor/solana.js');
const C = require('./vendor/crypto-core.js');

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TRANSFER_IX = 2; // SystemInstruction::Transfer

export function liquidityMainnet(env = process.env) {
  return /^(1|true|yes|on)$/i.test(env.LIQUIDITY_MAINNET || '');
}

/// 32-byte ed25519 seed of the treasury's Solana hot wallet (matches liquidity.js).
export function solTreasurySeed(seedHex) {
  if (!seedHex || seedHex.length < 32) throw new Error('no treasury seed');
  return crypto.createHash('sha256').update('sol:' + seedHex).digest();
}
export function solTreasuryAddress(seedHex) { return sol.addressFromSeed(solTreasurySeed(seedHex)); }


// Decimal string for an amount that may be a JS number in scientific notation
// (e.g. 4.68e-06): fixed to `dec` places, never "4.68e-6".
function decStr(amount, dec) {
  const s = String(amount);
  if (/e/i.test(s)) return Number(amount).toFixed(dec);
  return s;
}

/// Whole SOL (string/number) -> lamports (BigInt), exact to 9 dp.
export function lamports(amountSol) {
  const [i, f = ''] = decStr(amountSol, 9).split('.');
  const frac = (f + '000000000').slice(0, 9);
  return BigInt(i || '0') * LAMPORTS_PER_SOL + BigInt(frac || '0');
}

function shortVec(n) {
  const out = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f; v >>= 7;
    if (v === 0) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}
function u64le(v) {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b;
}

/// Build the LEGACY message for a native SOL transfer from→to. Accounts: fee
/// payer (signer, writable), recipient (writable), System program (readonly).
/// Exported for tests (byte layout is the consensus wire format).
export function buildTransferMessage({ from, to, lamports: lam, recentBlockhash }) {
  const fromKey = Buffer.from(C.base58decode(from));
  const toKey = Buffer.from(C.base58decode(to));
  const prog = Buffer.from(C.base58decode(SYSTEM_PROGRAM));
  const bh = Buffer.from(C.base58decode(recentBlockhash));
  if (fromKey.length !== 32 || toKey.length !== 32 || bh.length !== 32) throw new Error('solana: bad key/blockhash');
  if (fromKey.equals(toKey)) throw new Error('solana: refusing a self-transfer');
  const data = Buffer.concat([Buffer.from([TRANSFER_IX, 0, 0, 0]), u64le(lam)]);
  return Buffer.concat([
    Buffer.from([1, 0, 1]),            // numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
    shortVec(3), fromKey, toKey, prog, // account keys
    bh,                                // recent blockhash
    shortVec(1),                       // one instruction
    Buffer.from([2]),                  // program id index (System program)
    shortVec(2), Buffer.from([0, 1]),  // account indexes: from, to
    shortVec(data.length), data,
  ]);
}

/// Decode a transfer message built by buildTransferMessage (tests / audit).
export function decodeTransferMessage(msg) {
  const b = Buffer.from(msg);
  let o = 3;
  const n = b[o++]; // shortvec (<128)
  const keys = [];
  for (let i = 0; i < n; i++) { keys.push(C.base58encode(Uint8Array.from(b.subarray(o, o + 32)))); o += 32; }
  const blockhash = C.base58encode(Uint8Array.from(b.subarray(o, o + 32))); o += 32;
  const nIx = b[o++]; const progIdx = b[o++]; const nAcc = b[o++];
  const acc = [...b.subarray(o, o + nAcc)]; o += nAcc;
  const dlen = b[o++]; const data = b.subarray(o, o + dlen);
  return { keys, blockhash, nIx, program: keys[progIdx], from: keys[acc[0]], to: keys[acc[1]], ix: data.readUInt32LE(0), lamports: data.readBigUInt64LE(4) };
}

/// A Solana JSON-RPC sender over fetch (result unwrapped; RPC errors throw).
export function solRpcSender(url, fetchFn = globalThis.fetch) {
  return async (method, params) => {
    const r = await fetchFn(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error('solana rpc: bad response');
    if (j.error) throw new Error('solana rpc: ' + (j.error.message || JSON.stringify(j.error)));
    return j.result;
  };
}

/// Verify a user's SOL DEPOSIT: `signature` must be a confirmed, successful tx
/// that raised `expectTo`'s lamport balance by >= minSol. Balance-delta based,
/// so it holds for plain transfers and for transfers wrapped in other programs.
export async function verifySolDeposit({ rpc, signature, expectTo, minSol }) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(signature || ''))) return { ok: false, reason: 'bad deposit signature' };
  let tx;
  try {
    tx = await rpc('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  } catch (e) { return { ok: false, reason: 'rpc: ' + (e.message || e) }; }
  if (!tx) return { ok: false, reason: 'deposit not confirmed yet' };
  if (!tx.meta) return { ok: false, reason: 'deposit not confirmed yet' };
  if (tx.meta.err) return { ok: false, reason: 'deposit transaction failed on-chain' };
  const rawKeys = (tx.transaction && tx.transaction.message && tx.transaction.message.accountKeys) || [];
  const keys = rawKeys.map((k) => (typeof k === 'string' ? k : (k && k.pubkey) || ''));
  // loaded addresses (v0 lookup tables) follow the static keys in pre/postBalances order
  const la = tx.meta.loadedAddresses || {};
  const allKeys = keys.concat(la.writable || [], la.readonly || []);
  const idx = allKeys.indexOf(expectTo);
  if (idx < 0) return { ok: false, reason: 'deposit not to treasury' };
  const pre = BigInt(tx.meta.preBalances?.[idx] ?? 0), post = BigInt(tx.meta.postBalances?.[idx] ?? 0);
  const credited = post - pre;
  if (credited < lamports(minSol)) return { ok: false, reason: 'deposit to treasury too low' };
  return { ok: true, creditedLamports: credited.toString() };
}

/// Pay out `amountSol` SOL from the treasury to `toAddress`. GATED. Builds a
/// legacy System transfer, signs with the treasury ed25519 key, broadcasts.
export async function payoutSol({ seedHex, toAddress, amountSol, rpc, env = process.env }) {
  if (!liquidityMainnet(env)) throw new Error('liquidity settlement disabled (LIQUIDITY_MAINNET not set)');
  const seed = solTreasurySeed(seedHex);
  const from = sol.addressFromSeed(seed);
  const lam = lamports(amountSol);
  if (lam <= 0n) throw new Error('solana: zero payout');
  // Pre-flight the treasury balance so an underfunded hot wallet fails with a
  // clear, actionable reason instead of an opaque RPC/rent error. A system
  // account must either empty completely or stay above the rent-exempt minimum.
  const FEE = 5000n;
  let bal = null, rent = 890880n;
  try {
    const b = await rpc('getBalance', [from, { commitment: 'confirmed' }]);
    const v = b && typeof b === 'object' ? b.value : b;
    if (v != null) bal = BigInt(v);
  } catch (_) {/* best-effort */}
  try { const r = await rpc('getMinimumBalanceForRentExemption', [0]); if (r != null) rent = BigInt(r); } catch (_) {}
  if (bal != null) {
    const need = lam + FEE;
    if (bal < need) {
      throw new Error(`treasury SOL wallet ${from} is underfunded: has ${Number(bal) / 1e9} SOL, payout needs ${Number(need) / 1e9} SOL — fund it`);
    }
    const left = bal - need;
    if (left > 0n && left < rent) {
      throw new Error(`treasury SOL wallet ${from} would drop below Solana's rent-exempt minimum (${Number(rent) / 1e9} SOL); fund it with at least ${Number(rent - left) / 1e9} more SOL`);
    }
  }
  const bh = await rpc('getLatestBlockhash', [{ commitment: 'finalized' }]);
  const blockhash = bh && (bh.value ? bh.value.blockhash : bh.blockhash);
  if (!blockhash) throw new Error('solana: could not fetch a recent blockhash');
  const message = buildTransferMessage({ from, to: toAddress, lamports: lam, recentBlockhash: blockhash });
  const sig = Buffer.from(sol.signMessage(seed, message));
  const tx = Buffer.concat([shortVec(1), sig, message]).toString('base64');
  const res = await rpc('sendTransaction', [tx, { encoding: 'base64', skipPreflight: false, maxRetries: 3 }]);
  if (!res || typeof res !== 'string') throw new Error('solana: sendTransaction returned no signature');
  return { txid: res, from, lamports: lam.toString(), signature: C.base58encode(Uint8Array.from(sig)) };
}
