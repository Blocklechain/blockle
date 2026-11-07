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
      if (!d.key || !d.plan || d.plan.type !== 'dca') { out.push({ botId: d.botId, skipped: 'no-plan' }); continue; }
      const plan = d.plan;
      const interval = Number(plan.intervalMs) || 3600_000;
      if (now() - (Number(plan.lastAt) || 0) < interval) { out.push({ botId: d.botId, skipped: 'not-due' }); continue; }
      const feeUsd = 0.2; // conservative est.; the hard cap gate lives in executeTrade
      const remaining = Math.max(0, d.capUsd - d.spentUsd);
      // Reserve the fee so notional + fee always fits the remaining cap.
      const usd = Math.min(Number(plan.perTradeUsd) || 0, remaining - feeUsd);
      if (usd <= 0.01) { out.push({ botId: d.botId, skipped: 'cap-exhausted' }); continue; }
      const sym = String(plan.sym || 'ETH').toUpperCase();
      const px = await prices(sym);
      if (!px || px <= 0) { out.push({ botId: d.botId, skipped: 'no-price' }); continue; }
      // native 18-decimal amount for `usd` of the coin.
      const amountBase = BigInt(Math.floor((usd / px) * 1e18)).toString();
      const r = await executeTrade({
        delegation: d,
        action: { kind: 'native', to: plan.to, amountBase, notionalUsd: usd, feeUsd, chainId: d.chainId },
        rpc: rpcFor(d.chainId), env,
      });
      // Ledger tracks notional + fee so repeated trades can't creep past the cap.
      delegations.recordSpend(uid, d.botId, usd + feeUsd);
      plan.lastAt = now();
      log(`[liverunner] bot ${d.botId} drip $${usd} on ${d.chain} tx ${r.txid}`);
      out.push({ botId: d.botId, usd, txid: r.txid });
    } catch (e) {
      out.push({ botId: d.botId, error: String(e && e.message || e) });
    }
  }
  return out;
}
