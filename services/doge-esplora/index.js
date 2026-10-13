// doge-esplora — a minimal Esplora-compatible shim over a full, address-indexed
// Dogecoin Core node (addressindex=1). It exposes ONLY the handful of endpoints
// the wallet's UTXO adapter (blockle-extension/chains/utxo.js and the flutter/qt
// equivalents) actually calls:
//   GET  /address/:addr          -> { address, chain_stats:{funded_txo_sum, spent_txo_sum, tx_count} }
//   GET  /address/:addr/utxo     -> [ { txid, vout, value, status:{confirmed} } ]
//   POST /tx            (raw hex) -> "<txid>"   (text/plain)
//   GET  /tx/:txid               -> raw tx (verbose) passthrough (best-effort)
//   GET  /fee-estimates          -> { "1": sat/vB, ... }
//   GET  /blocks/tip/height      -> <height>
//   GET  /healthz                -> { ok, chain, blocks, synced }
// A leading "/api" prefix (the Blockstream esplora convention) is accepted + stripped.
// Loopback only; nginx terminates TLS in front. It moves NO funds and holds NO
// wallet keys — it only reads the node + relays a signed raw tx the wallet built.
"use strict";
const http = require("http");

const RPC_URL = process.env.DOGE_RPC_URL || "http://blockle@127.0.0.1:22600/";
const RPC_USER = process.env.DOGE_RPC_USER || "";
const RPC_PASS = process.env.DOGE_RPC_PASS || "";
const PORT = Number(process.env.DOGE_ESPLORA_PORT || 8797);
const COIN = 1e8; // dogecoin uses 8 decimals

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(RPC_URL);
    const user = RPC_USER || decodeURIComponent(u.username || "");
    const pass = RPC_PASS || decodeURIComponent(u.password || "");
    const body = JSON.stringify({ jsonrpc: "1.0", id: "shim", method, params: params || [] });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 22600,
        path: "/",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(user || pass ? { authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64") } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            if (j.error) return reject(new Error(j.error.message || "rpc error"));
            resolve(j.result);
          } catch (e) {
            reject(new Error("bad rpc response (" + res.statusCode + ")"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sat(n) {
  // node returns DOGE floats for some calls; addressindex returns satoshis as ints.
  return typeof n === "number" && !Number.isInteger(n) ? Math.round(n * COIN) : Number(n);
}

async function handle(method, path, bodyText, rpcImpl) {
  const call = rpcImpl || rpc; // injectable for tests
  // address balance -> esplora chain_stats
  let m = path.match(/^\/address\/([^/]+)$/);
  if (m && method === "GET") {
    const addr = decodeURIComponent(m[1]);
    const bal = await call("getaddressbalance", [{ addresses: [addr] }]); // { balance, received }
    let txCount = 0;
    try {
      const ids = await call("getaddresstxids", [{ addresses: [addr] }]);
      txCount = Array.isArray(ids) ? ids.length : 0;
    } catch (_) {}
    const received = Number(bal.received || 0); // total funded (satoshis)
    const balance = Number(bal.balance || 0); // funded - spent
    return {
      status: 200,
      json: {
        address: addr,
        chain_stats: { funded_txo_sum: received, spent_txo_sum: received - balance, tx_count: txCount },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
      },
    };
  }
  // address utxos
  m = path.match(/^\/address\/([^/]+)\/utxo$/);
  if (m && method === "GET") {
    const addr = decodeURIComponent(m[1]);
    const utxos = await call("getaddressutxos", [{ addresses: [addr] }]); // [{txid, outputIndex, satoshis, height}]
    const out = (utxos || []).map((u) => ({
      txid: u.txid,
      vout: u.outputIndex,
      value: sat(u.satoshis),
      status: { confirmed: true, block_height: u.height },
    }));
    return { status: 200, json: out };
  }
  // broadcast a signed raw tx the wallet built
  if (path === "/tx" && method === "POST") {
    const raw = (bodyText || "").trim();
    if (!/^[0-9a-fA-F]+$/.test(raw)) return { status: 400, text: "invalid raw tx" };
    const txid = await call("sendrawtransaction", [raw]);
    return { status: 200, text: String(txid) };
  }
  // tx passthrough (verbose)
  m = path.match(/^\/tx\/([0-9a-fA-F]{64})$/);
  if (m && method === "GET") {
    const tx = await call("getrawtransaction", [m[1], true]);
    return { status: 200, json: tx };
  }
  if (path === "/fee-estimates" && method === "GET") {
    let perKb = 0;
    try {
      const est = await call("estimatesmartfee", [6]);
      perKb = est && est.feerate ? est.feerate : 0;
    } catch (_) {}
    const satVb = perKb > 0 ? Math.max(1, Math.round((perKb * COIN) / 1000)) : 1000; // doge fees are high; floor sane
    return { status: 200, json: { 1: satVb, 6: satVb, 25: Math.max(1, Math.round(satVb / 2)) } };
  }
  if (path === "/blocks/tip/height" && method === "GET") {
    const h = await call("getblockcount", []);
    return { status: 200, text: String(h) };
  }
  if (path === "/healthz" && method === "GET") {
    const info = await call("getblockchaininfo", []);
    return {
      status: 200,
      json: { ok: true, chain: info.chain, blocks: info.blocks, headers: info.headers, synced: info.blocks === info.headers && info.initialblockdownload === false },
    };
  }
  return { status: 404, text: "not found" };
}

function createServer() {
  return http.createServer((req, res) => {
    let path = req.url.split("?")[0];
    if (path.startsWith("/api/")) path = path.slice(4);
    else if (path === "/api") path = "/";
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const out = await handle(req.method, path, body);
        if (out.json !== undefined) {
          res.writeHead(out.status, { "content-type": "application/json" });
          res.end(JSON.stringify(out.json));
        } else {
          res.writeHead(out.status, { "content-type": "text/plain" });
          res.end(out.text || "");
        }
      } catch (e) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("upstream error"); // never leak rpc creds / internals
      }
    });
  });
}

if (require.main === module) {
  createServer().listen(PORT, "127.0.0.1", () => console.log("doge-esplora on 127.0.0.1:" + PORT));
}
module.exports = { createServer, rpc, handle };
