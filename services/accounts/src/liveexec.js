// liveexec.js — the GATED on-chain execute for the server-side live bot runner
// (Stage 2b, EVM). Signs with the delegated key (evmsign) and broadcasts via an
// injected RPC. Fund-critical, so every trade passes hard gates BEFORE signing:
//
//   1. MAINNET GATE — refused unless the operator sets BLOCKLE_BOT_MAINNET=1.
//      By default only TESTNET chain ids are allowed, so a misconfig can never
//      move real funds.
//   2. CAP GATE — the trade's USD (notional + est. fee) must fit the
//      delegation's remaining cap (capUsd − spentUsd). The caller records the
//      spend on success.
//   3. SENDER GATE — the delegated key must control the delegation's `address`
//      (the from), so a trade can only ever originate from the delegated
//      account.
//
// RPC is injected (`rpc(method, params) → result`) so the whole path is unit
// tested deterministically with no network. Returns { txid }.

import { signEip1559, evmAddressFromPrivate, erc20TransferData } from './evmsign.js';

// Testnet chain ids (always allowed). Mainnet ids require the operator flag.
export const TESTNET_CHAIN_IDS = new Set([
  11155111, // ethereum sepolia
  84532,    // base sepolia
  421614,   // arbitrum sepolia
  11155420, // optimism sepolia
  80002,    // polygon amoy
  97,       // bnb testnet
  43113,    // avalanche fuji
]);
export const MAINNET_CHAIN_IDS = new Set([1, 8453, 42161, 10, 137, 56, 43114]);

export function mainnetEnabled(env = process.env) {
  return String(env.BLOCKLE_BOT_MAINNET || '') === '1';
}

const _big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

// Uniswap V3 SwapRouter02.exactInputSingle(struct) — selector 0x04e45aaf. The
// struct is all-static (3×address, uint24, address, 2×uint256, uint160), so it
// ABI-encodes inline as 7 words after the selector. Used for NATIVE→token buys:
// tokenIn = WETH and the call carries msg.value = amountIn (the router wraps),
// so no ERC-20 approve is needed. `minOut` is the slippage floor (computed by
// the runner from the price feed) — a trade returning less reverts on-chain.
export function uniV3ExactInputSingle({ tokenIn, tokenOut, fee, recipient, amountIn, minOut, sqrtPriceLimitX96 = 0 }) {
  const w = (h) => String(h).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  const n = (v) => w(_big(v).toString(16));
  return '0x04e45aaf' + w(tokenIn) + w(tokenOut) + n(fee) + w(recipient) + n(amountIn) + n(minOut) + n(sqrtPriceLimitX96);
}

/// Execute one EVM trade for a delegation. [action] = { to, chainId, kind:
/// 'native'|'erc20', token?, amountBase (string/bigint, wei or token base
/// units), notionalUsd, feeUsd? }. [rpc] = async (method, params) => result.
/// Throws on any gate failure (nothing is signed/broadcast). Returns { txid }.
export async function executeTrade({ delegation, action, rpc, env = process.env }) {
  const d = delegation;
  if (!d || !d.key) throw new Error('no delegated key');
  const chainId = Number(action.chainId ?? d.chainId);
  if (!Number.isFinite(chainId)) throw new Error('missing chainId');

  // 1. mainnet gate
  const isMainnet = MAINNET_CHAIN_IDS.has(chainId);
  const isTestnet = TESTNET_CHAIN_IDS.has(chainId);
  if (!isTestnet && !isMainnet) throw new Error('unsupported chainId ' + chainId);
  if (isMainnet && !mainnetEnabled(env)) {
    throw new Error('mainnet trading is disabled (BLOCKLE_BOT_MAINNET not set)');
  }

  // 2. cap gate
  const notional = Number(action.notionalUsd) || 0;
  const fee = Number(action.feeUsd) || 0;
  if (notional <= 0) throw new Error('notionalUsd must be > 0');
  const remaining = Math.max(0, d.capUsd - d.spentUsd);
  if (notional + fee > remaining + 1e-9) {
    throw new Error('over cap: ' + (notional + fee).toFixed(2) + ' > ' + remaining.toFixed(2));
  }

  // 3. sender gate — the key must control the delegation address
  const from = evmAddressFromPrivate(d.key);
  if (d.address && from.toLowerCase() !== String(d.address).toLowerCase()) {
    throw new Error('delegated key does not control the delegation address');
  }

  // Build the tx: nonce + gas from RPC, then native transfer or ERC-20 call.
  const nonce = _big(await rpc('eth_getTransactionCount', [from, 'pending']));
  const gasPrice = _big(await rpc('eth_gasPrice', []));
  const maxFee = gasPrice * 2n;
  const maxPrio = gasPrice;

  let to, value, data, gasLimit;
  if (action.kind === 'swap') {
    // NATIVE → token buy via Uniswap V3 SwapRouter02. value = amountIn (native);
    // the router wraps to WETH (tokenIn). minOut is the slippage floor.
    if (!action.router || !action.weth || !action.tokenOut) {
      throw new Error('swap needs router, weth, tokenOut');
    }
    to = action.router;
    value = _big(action.amountBase);
    data = uniV3ExactInputSingle({
      tokenIn: action.weth, tokenOut: action.tokenOut, fee: action.fee || 3000,
      recipient: action.recipient || from, amountIn: value, minOut: _big(action.minOut || 0),
    });
    gasLimit = 0x493e0n; // 300000
  } else if (action.kind === 'erc20') {
    if (!action.token) throw new Error('erc20 trade needs token');
    to = action.token;
    value = 0n;
    data = erc20TransferData(action.to, action.amountBase);
    gasLimit = 0x15f90n; // 90000
  } else {
    to = action.to;
    value = _big(action.amountBase);
    data = '0x';
    gasLimit = 0x5208n; // 21000
  }

  const signed = signEip1559({
    chainId, nonce,
    maxPriorityFeePerGas: maxPrio, maxFeePerGas: maxFee,
    gasLimit, to, value, data,
  }, d.key);

  const txid = await rpc('eth_sendRawTransaction', [signed.raw]);
  return { txid: txid || signed.txid, from, chainId };
}
