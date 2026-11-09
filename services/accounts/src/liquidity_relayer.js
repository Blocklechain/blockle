// liquidity_relayer.js — the ON-CHAIN payout relayer for the liquidity treasury.
//
// Makes a treasury swap REAL: once the user deposits their input asset to the
// treasury's custodial hot wallet, the relayer verifies that deposit on-chain and
// pays out the output asset to the user — signed with the treasury key derived
// from LIQUIDITY_TREASURY_SEED. EVERYTHING here is gated by LIQUIDITY_MAINNET=1;
// with the gate off it throws, so no funds ever move without the operator's
// deliberate switch. EVM coins (native + ERC-20) are supported; Solana/BLOCK
// payouts are an explicit follow-on (reported as unsupported, never faked).
//
// Deterministic + injectable (rpc, now) — unit-tested with mock RPC + a test seed.

import crypto from 'node:crypto';
import { signEip1559, evmAddressFromPrivate, erc20TransferData } from './evmsign.js';
import { verifyBlockDeposit, payoutBlock } from './liquidity_block.js';

const isBlock = (c) => String(c || '').toUpperCase() === 'BLOCK';

const _big = (v) => (typeof v === 'bigint' ? v : BigInt(v == null ? 0 : (String(v).startsWith('0x') ? String(v) : String(v))));

export function liquidityMainnet(env = process.env) {
  return /^(1|true|yes|on)$/i.test(env.LIQUIDITY_MAINNET || '');
}

// Treasury keys derived from the seed — MUST match liquidity.js's address math so
// the deposit address a user funds is the same wallet we pay out from.
export function treasuryKeys(seedHex) {
  if (!seedHex || seedHex.length < 32) throw new Error('no treasury seed');
  const evmPriv = '0x' + crypto.createHash('sha256').update('evm:' + seedHex).digest('hex');
  return { evmPriv, evmAddress: evmAddressFromPrivate(evmPriv) };
}

// Chain id per EVM coin's native settlement network. (USDC/USDT/DAI settle on
// Ethereum mainnet here; extend as more reserves are funded.)
export const COIN_CHAIN = {
  ETH: 1, USDC: 1, USDT: 1, DAI: 1, BNB: 56, MATIC: 137, AVAX: 43114,
};
// ERC-20 contract per token (mainnet). Natives (ETH/BNB/…) have no token entry.
export const COIN_TOKEN = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
};
export const COIN_DECIMALS = { USDC: 6, USDT: 6, DAI: 18, ETH: 18, BNB: 18, MATIC: 18, AVAX: 18 };

const _supported = (coin) => Object.prototype.hasOwnProperty.call(COIN_CHAIN, String(coin || '').toUpperCase());

// Whole-unit amount → base units (wei / token base) as a BigInt string.
function toBase(coin, amount) {
  const dec = COIN_DECIMALS[String(coin).toUpperCase()] ?? 18;
  const [i, f = ''] = String(amount).split('.');
  const frac = (f + '0'.repeat(dec)).slice(0, dec);
  return (BigInt(i || '0') * 10n ** BigInt(dec) + BigInt(frac || '0')).toString();
}

// Pay out `amount` whole units of `coin` from the treasury to `toAddress`. GATED.
export async function payoutEvm({ coin, toAddress, amount, rpc, seedHex, env = process.env }) {
  if (!liquidityMainnet(env)) throw new Error('liquidity settlement disabled (LIQUIDITY_MAINNET not set)');
  const c = String(coin || '').toUpperCase();
  if (!_supported(c)) throw new Error('unsupported payout coin: ' + c);
  const chainId = COIN_CHAIN[c];
  const { evmPriv, evmAddress } = treasuryKeys(seedHex);
  const amountBase = toBase(c, amount);
  const nonce = _big(await rpc('eth_getTransactionCount', [evmAddress, 'pending']));
  const gasPrice = _big(await rpc('eth_gasPrice', []));
  let to, value, data, gasLimit;
  if (COIN_TOKEN[c]) {
    to = COIN_TOKEN[c]; value = 0n; data = erc20TransferData(toAddress, amountBase); gasLimit = 0x15f90n;
  } else {
    to = toAddress; value = _big(amountBase); data = '0x'; gasLimit = 0x5208n;
  }
  const signed = signEip1559({
    chainId, nonce, maxPriorityFeePerGas: gasPrice, maxFeePerGas: gasPrice * 2n,
    gasLimit, to, value, data,
  }, evmPriv);
  const txid = await rpc('eth_sendRawTransaction', [signed.raw]);
  return { txid: txid || signed.txid, from: evmAddress, chainId, amountBase };
}

// Verify a user's DEPOSIT tx on-chain: it must be mined, sent TO the treasury
// deposit address, and carry at least the expected amount of the right asset.
export async function verifyDepositEvm({ rpc, txid, expectTo, coin, minAmount }) {
  const c = String(coin || '').toUpperCase();
  const rcpt = await rpc('eth_getTransactionReceipt', [txid]);
  if (!rcpt || _big(rcpt.status) !== 1n) return { ok: false, reason: 'not mined / reverted' };
  const tx = await rpc('eth_getTransactionByHash', [txid]);
  if (!tx) return { ok: false, reason: 'tx not found' };
  const minBase = _big(toBase(c, minAmount));
  if (COIN_TOKEN[c]) {
    // ERC-20 transfer(to,amount): to == token contract, data = selector+to+amount.
    if (String(tx.to || '').toLowerCase() !== COIN_TOKEN[c].toLowerCase()) return { ok: false, reason: 'wrong token contract' };
    const data = String(tx.input || tx.data || '');
    if (!data.startsWith('0xa9059cbb')) return { ok: false, reason: 'not an erc20 transfer' };
    const toArg = '0x' + data.slice(10 + 24, 10 + 64);
    const amtArg = _big('0x' + data.slice(10 + 64, 10 + 128));
    if (toArg.toLowerCase() !== String(expectTo).toLowerCase()) return { ok: false, reason: 'deposit not to treasury' };
    if (amtArg < minBase) return { ok: false, reason: 'deposit amount too low' };
    return { ok: true };
  }
  // Native transfer: to == treasury, value >= min.
  if (String(tx.to || '').toLowerCase() !== String(expectTo).toLowerCase()) return { ok: false, reason: 'deposit not to treasury' };
  if (_big(tx.value) < minBase) return { ok: false, reason: 'deposit amount too low' };
  return { ok: true };
}

// Settle one swap record: verify the user's deposit, pay out the output asset,
// mark settled. deps: { store, rpcFor(chainId), seedHex, env, now }. Returns the
// updated record. Idempotent — a record already 'settled' is returned unchanged.
export async function settleSwap(id, depositTxid, deps) {
  const { store, rpcFor, seedHex, env = process.env, now = () => Date.now(), chainBase, fetchFn = globalThis.fetch } = deps;
  if (!liquidityMainnet(env)) throw new Error('liquidity settlement disabled (LIQUIDITY_MAINNET not set)');
  const rec = store.get('liquidity', 'swap:' + id);
  if (!rec) throw new Error('unknown swap ' + id);
  if (rec.status === 'settled') return rec;

  // The user DEPOSITS the input asset; we PAY OUT the output asset. Each leg is
  // BLOCK (post-quantum, liquidity_block.js) or EVM — one of the two is always
  // BLOCK. A leg on a chain we haven't wired is honestly marked 'unsupported'.
  const depositCoin = String(rec.from).toUpperCase();
  const payoutCoin = String(rec.to).toUpperCase();
  const legOk = (c) => isBlock(c) || _supported(c);
  if (!legOk(depositCoin) || !legOk(payoutCoin)) {
    rec.status = 'unsupported'; rec.reason = 'chain not wired for on-chain settlement yet';
    await store.put('liquidity', 'swap:' + id, rec); return rec;
  }
  if (!rec.userAddress) { rec.status = 'failed'; rec.reason = 'no user address'; await store.put('liquidity', 'swap:' + id, rec); return rec; }

  // 1) verify the deposit (BLOCK via explorer; EVM via receipt).
  const dv = isBlock(depositCoin)
    ? await verifyBlockDeposit({ txid: depositTxid, expectTo: rec.depositAddress, minBlock: rec.amountIn, chainBase, fetchFn })
    : await verifyDepositEvm({ rpc: rpcFor(COIN_CHAIN[depositCoin]), txid: depositTxid, expectTo: rec.depositAddress, coin: depositCoin, minAmount: rec.amountIn });
  if (!dv.ok) { rec.status = 'awaiting-deposit'; rec.reason = dv.reason; await store.put('liquidity', 'swap:' + id, rec); return rec; }

  // 2) pay out the output asset (BLOCK ML-DSA transfer; or EVM native/ERC-20).
  const pay = isBlock(payoutCoin)
    ? await payoutBlock({ store, seedHex, toAddress: rec.userAddress, amountBlock: rec.amountOut, chainBase, fetchFn, env })
    : await payoutEvm({ coin: payoutCoin, toAddress: rec.userAddress, amount: rec.amountOut, rpc: rpcFor(COIN_CHAIN[payoutCoin]), seedHex, env });
  rec.status = 'settled'; rec.depositTxid = depositTxid; rec.payoutTxid = pay.txid; rec.settledAt = now(); rec.reason = '';
  await store.put('liquidity', 'swap:' + id, rec);
  return rec;
}

// What the public state should report for which coins can actually settle today.
export function settleableCoins() { return Object.keys(COIN_CHAIN); }
