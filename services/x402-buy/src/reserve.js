// Read the live USDC reserve R (dollars raised) the curve prices against —
// exactly as web/buy.js does: eth_call balanceOf(reserveAddr) on the USDC
// contract over the configured Base RPC. Falls back to R=0 (the $0.10 floor
// still applies) when the reserve/RPC/contract is not configured or reachable.

"use strict";

async function readReserveUsd(buyCfg, timeoutMs = 8000) {
  const u = buyCfg.usdc || {};
  if (!u.reserveAddr || !u.rpc || !u.contract) return 0;
  const addr = u.reserveAddr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: u.contract, data: "0x70a08231" + addr }, "latest"],
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(u.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j && j.result && j.result !== "0x") {
      return parseInt(j.result, 16) / Math.pow(10, u.decimals || 6);
    }
    return 0;
  } catch (e) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { readReserveUsd };
