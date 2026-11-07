// liverunner.js — the server-side live-bot loop (Stage 2c). On each tick it
// walks every ACTIVE delegation, evaluates its server-side plan, and calls the
// gated liveexec.executeTrade for anything due. Keeps bots acting while the
// user's app is closed, within every Stage 1/2b guarantee (ephemeral key, cap,
// mainnet gate, sender gate — all enforced inside executeTrade).
//
// Supported plan (v1): { type:'dca', to, sym, perTradeUsd, intervalMs } — a
// periodic DCA drip of `perTradeUsd` of the chain's native coin to `to`, paced
// by intervalMs, stopping at the cap. (Real token SWAPS via a DEX router are a
// follow-on plan type — 'swap' — not wired yet.)
//
// Everything is injected (delegations, prices, rpcFor, now) so the loop is unit
// tested deterministically with no network and no real keys.

import { executeTrade } from './liveexec.js';

// Uniswap V3 SwapRouter02 + wrapped-native per chain (for 'swap' plans).
export const V3_ROUTER = {
  1: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  8453: '0x2626664c2603336E57B271c5C0b26F421741e481',
  42161: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  10: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  137: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  // testnets
  11155111: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  84532: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
};
export const WNATIVE = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  8453: '0x4200000000000000000000000000000000000006',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  10: '0x4200000000000000000000000000000000000006',
  137: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  11155111: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  84532: '0x4200000000000000000000000000000000000006',
};
export const NATIVE_SYM = {
  1: 'ETH', 8453: 'ETH', 42161: 'ETH', 10: 'ETH', 137: 'POL',
  11155111: 'ETH', 84532: 'ETH',
};

// Public JSON-RPC per chain. Testnets are always usable; mainnet entries are
// only ever reached when executeTrade's mainnet gate is open (operator flag).
export const CHAIN_RPC = {
  // testnets
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  84532: 'https://sepolia.base.org',
  421614: 'https://sepolia-rollup.arbitrum.io/rpc',
  11155420: 'https://sepolia.optimism.io',
  80002: 'https://rpc-amoy.polygon.technology',
  97: 'https://bsc-testnet-rpc.publicnode.com',
  43113: 'https://api.avax-test.network/ext/bc/C/rpc',
  // mainnets (used only when BLOCKLE_BOT_MAINNET=1)
  1: 'https://ethereum-rpc.publicnode.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
  10: 'https://mainnet.optimism.io',
  137: 'https://polygon-rpc.com',
  56: 'https://bsc-rpc.publicnode.com',
  43114: 'https://api.avax.network/ext/bc/C/rpc',
};

/// A JSON-RPC sender bound to [chainId] over [fetchFn].
export function rpcSenderFor(chainId, fetchFn = fetch) {
  const url = CHAIN_RPC[Number(chainId)];
  return async (method, params) => {
    if (!url) throw new Error('no RPC for chain ' + chainId);
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'rpc error');
    return j.result;
  };
}

const _now = () => Date.now();

/// Run one loop pass. deps:
///   delegations : the botdelegate registry (uses allActive + recordSpend)
///   prices(sym) : async USD price for a native symbol (→ convert USD to wei)
///   rpcFor(id)  : returns a JSON-RPC sender for a chainId (default: real RPC)
///   env, now, log
/// Returns a summary [{ botId, usd, txid } | { botId, skipped }].
export async function runOnce(deps) {
  const {
    delegations, prices, rpcFor = (id) => rpcSenderFor(id),
    env = process.env, now = _now, log = () => {},
  } = deps;
  const out = [];
  for (const { uid, d } of delegations.allActive()) {
    try {
      const plan = d.plan;
      if (!d.key || !plan || (plan.type !== 'dca' && plan.type !== 'swap')) {
        out.push({ botId: d.botId, skipped: 'no-plan' }); continue;
      }
      const interval = Number(plan.intervalMs) || 3600_000;
      if (now() - (Number(plan.lastAt) || 0) < interval) { out.push({ botId: d.botId, skipped: 'not-due' }); continue; }
      const feeUsd = 0.2; // conservative est.; the hard cap gate lives in executeTrade
      const remaining = Math.max(0, d.capUsd - d.spentUsd);
      // Reserve the fee so notional + fee always fits the remaining cap.
      const usd = Math.min(Number(plan.perTradeUsd) || 0, remaining - feeUsd);
      if (usd <= 0.01) { out.push({ botId: d.botId, skipped: 'cap-exhausted' }); continue; }

      // Native coin price → how much native `usd` buys (amountIn in wei).
      const nativeSym = NATIVE_SYM[d.chainId] || String(plan.sym || 'ETH');
      const pxNative = await prices(nativeSym);
      if (!pxNative || pxNative <= 0) { out.push({ botId: d.botId, skipped: 'no-price' }); continue; }
      const amountInWei = BigInt(Math.floor((usd / pxNative) * 1e18)).toString();

      let action;
      if (plan.type === 'swap') {
        // Real token BUY: native → tokenOut via Uniswap V3, slippage floor from
        // the tokenOut price feed (a trade returning less reverts on-chain).
        const router = V3_ROUTER[d.chainId], weth = WNATIVE[d.chainId];
        if (!router || !weth || !plan.tokenOut) { out.push({ botId: d.botId, skipped: 'no-router' }); continue; }
        const pxToken = await prices(String(plan.tokenOutSym || '').toUpperCase());
        if (!pxToken || pxToken <= 0) { out.push({ botId: d.botId, skipped: 'no-token-price' }); continue; }
        const dec = Number(plan.tokenOutDecimals) || 18;
        const slip = Math.min(Math.max(Number(plan.slippageBps) || 100, 0), 5000) / 10000; // cap 50%
        const expectedOut = (usd / pxToken) * (1 - slip);
        const minOut = BigInt(Math.floor(expectedOut * Math.pow(10, dec))).toString();
        action = {
          kind: 'swap', router, weth, tokenOut: plan.tokenOut, fee: Number(plan.feeTier) || 3000,
          recipient: plan.to, amountBase: amountInWei, minOut, notionalUsd: usd, feeUsd, chainId: d.chainId,
        };
      } else {
        // DCA drip: periodic native transfer into the target (plan.to).
        action = { kind: 'native', to: plan.to, amountBase: amountInWei, notionalUsd: usd, feeUsd, chainId: d.chainId };
      }

      const r = await executeTrade({ delegation: d, action, rpc: rpcFor(d.chainId), env });
      // Ledger tracks notional + fee so repeated trades can't creep past the cap.
      delegations.recordSpend(uid, d.botId, usd + feeUsd);
      plan.lastAt = now();
      log(`[liverunner] bot ${d.botId} ${plan.type} $${usd} on ${d.chain} tx ${r.txid}`);
      out.push({ botId: d.botId, usd, txid: r.txid, type: plan.type });
    } catch (e) {
      out.push({ botId: d.botId, error: String(e && e.message || e) });
    }
  }
  return out;
}
