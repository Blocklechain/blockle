// coin-esplora — one public, read-only REST face for the exchange's coin nodes,
// shaped so the wallets can talk to it with no new client code.
//
//   GET  /<coin>/address/:a        -> { address, chain_stats:{funded_txo_sum,
//                                       spent_txo_sum, tx_count}, mempool_stats }
//   GET  /<coin>/address/:a/utxo   -> [ { txid, vout, value, status:{confirmed} } ]
//   POST /<coin>/tx                -> txid            (body: raw signed tx hex)
//   GET  /<coin>/status            -> what this coin can and cannot answer
//   GET  /health
//
// WHY THIS SHAPE. The Flutter and extension wallets already speak Esplora
// (`/address/{a}` -> chain_stats, `/address/{a}/utxo`, `POST /tx`) for Bitcoin
// and Litecoin. Matching it means a new coin is a row of config in the wallet
// rather than a new adapter, and it is the same three calls this file serves.
//
// READ THIS BEFORE EXTENDING IT.
//
// This is a PUBLIC endpoint in front of nodes that the exchange also reconciles
// against. It is therefore an ALLOWLIST, not a proxy: there is no path that
// forwards a caller's method name. The only RPCs it will ever issue are the
// ones named in STRATEGIES and BROADCAST below, and a reviewer should be able
// to confirm that by grepping for `rpc(` and finding nothing variable.
//
// `sendrawtransaction` is the one write, and it has to be: a self-custody
// wallet signs locally and needs somewhere to hand the bytes. It moves nothing
// that is not already signed by the owner's key.
//
// HOW A BALANCE IS FOUND, which differs per coin because the daemons differ.
// Measured on the real binaries, not assumed:
//
//   addrindex  getaddressutxos / getaddressbalance, from `addressindex=1`.
//              RTM, MEWC, NEOX. Complete and cheap. Enabled while those chains
//              were near height zero, because switching it on after a sync
//              costs a full reindex.
//   scan       scantxoutset with an addr() descriptor. Also complete, but it
//              walks the whole UTXO set per call, so it is the fallback.
//   watch      importaddress (no rescan) + listunspent. PEP and DINGO only,
//              which have NEITHER of the above — Pepecoin 1.1 and Dingocoin
//              1.18 predate both RPCs and have no addressindex option at all.
//
// THE `watch` LIMITATION, STATED PLAINLY because it is a real one: an address
// is only tracked from the moment it is first asked about. Coins that arrived
// at an address BEFORE its first query are invisible until a rescan. That fits
// how a wallet actually behaves — it derives an address and displays it, which
// queries it, and only then can anyone send to it — but it is not true
// indexing, `/status` reports it as `complete: false`, and restoring a seed
// against a node whose wallet file was lost will under-report until rescanned.
// The fix is an external index per coin; until then this is honest rather than
// silently wrong.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const NODES_DIR = process.env.COIN_DATA_DIR || '/var/lib/blockle-coins';
const PORT = Number(process.env.PORT || 3070);
const CACHE_MS = Number(process.env.CACHE_MS || 10_000);
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 240);
const MAX_TX_HEX = 200_000; // ~100 kB of transaction; far above any real send

/** Coins this service will serve, with the RPC port provisioning assigned. */
const COINS = {
  rtm: { port: 19001, name: 'Raptoreum', decimals: 8 },
  pep: { port: 19002, name: 'Pepecoin', decimals: 8 },
  neox: { port: 19003, name: 'Neoxa', decimals: 8 },
  mewc: { port: 19004, name: 'Meowcoin', decimals: 8 },
  dingo: { port: 19005, name: 'Dingocoin', decimals: 8 },
};

// ---------------------------------------------------------------- credentials

/**
 * Read rpcuser/rpcpassword from the node's own conf.
 *
 * Deliberately not from this service's environment: the credential has exactly
 * one home, the file provisioning wrote it to, and copying it into a second
 * place is how the two drift and a rotation half-lands.
 */
function creds(coin) {
  const f = path.join(NODES_DIR, coin, `${coin}.conf`);
  const txt = fs.readFileSync(f, 'utf8');
  const get = (k) => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(txt);
    return m ? m[1].trim() : undefined;
  };
  const user = get('rpcuser');
  const pass = get('rpcpassword');
  if (!user || !pass) throw new Error(`${coin}: no rpcuser/rpcpassword in ${f}`);
  return { user, pass };
}

const authCache = new Map();
function authFor(coin) {
  if (!authCache.has(coin)) authCache.set(coin, creds(coin));
  return authCache.get(coin);
}

// ------------------------------------------------------------------- the RPC

class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function rpc(coin, method, params = []) {
  const { user, pass } = authFor(coin);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20_000);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${COINS[coin].port}/`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'px', method, params }),
      signal: ac.signal,
    });
  } catch (e) {
    throw new RpcError(`${coin} node unreachable: ${e.message}`, -1);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // A loading daemon answers with non-JSON or a bare error page. Saying so
    // beats a parse stack trace that looks like a bug in this service.
    throw new RpcError(`${coin} node is not answering JSON yet (HTTP ${res.status})`, -28);
  }
  if (body.error) throw new RpcError(body.error.message || 'rpc error', body.error.code);
  return body.result;
}

// ------------------------------------------------------- strategy, per coin

const STRATEGIES = ['addrindex', 'scan', 'watch'];

/** Probed once per coin, then remembered. */
const strategy = new Map();

/**
 * Ask the daemon what it can do, in order of preference.
 *
 * Probed rather than configured: these nodes come up over hours of initial
 * block download, and a daemon that is still loading answers everything with
 * an error. A hardcoded table would be wrong for whichever coin was mid-start
 * when this service booted.
 */
async function probe(coin) {
  if (strategy.has(coin)) return strategy.get(coin);
  for (const [name, method, params] of [
    ['addrindex', 'getaddressbalance', [{ addresses: [] }]],
    ['scan', 'scantxoutset', []],
  ]) {
    let present;
    try {
      await rpc(coin, method, params);
      present = true; // answered outright
    } catch (e) {
      // -28 "loading" / -1 unreachable say nothing about capability, so do not
      // record one — ask again once the daemon is up.
      if (e.code === -28 || e.code === -1) throw e;
      /*
       * -32601 IS THE ONLY "NOT THERE".
       *
       * DO NOT go back to probing with `help <method>`: bitcoind answers that
       * with a STRING ("help: unknown command: ...") and no error at all, so
       * every probe succeeded and every coin was labelled addrindex —
       * including Pepecoin and Dingocoin, which have neither RPC. Calling the
       * method for real and reading the code is the only reliable signal: a
       * wrong-params or wrong-type complaint (-1, -3, -5, -8) means the method
       * exists and was reached.
       */
      present = e.code !== -32601;
    }
    if (present) {
      strategy.set(coin, name);
      return name;
    }
  }
  strategy.set(coin, 'watch');
  return 'watch';
}

// --------------------------------------------------------------- validation

/**
 * Is this a well-formed address FOR THIS CHAIN? Asked of the daemon.
 *
 * Not a regex. Each of these chains has its own version bytes, and the daemon
 * is the only authority on its own encoding — getting it wrong here would mean
 * reporting a zero balance for a valid address, or passing a foreign one
 * through to an RPC. It also means no caller-supplied string reaches a method
 * argument without the node having accepted it as an address first.
 */
async function validAddress(coin, addr) {
  if (typeof addr !== 'string' || addr.length < 20 || addr.length > 120) return false;
  if (!/^[A-Za-z0-9]+$/.test(addr)) return false; // base58 only on these chains
  try {
    const r = await rpc(coin, 'validateaddress', [addr]);
    return r && r.isvalid === true;
  } catch (e) {
    if (e.code === -28 || e.code === -1) throw e;
    return false;
  }
}

// ------------------------------------------------------------------ queries

const watched = new Set(); // `${coin}:${addr}` already importaddress'd
const cache = new Map();

function cached(key, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && hit.until > now) return hit.value;
  const value = fn();
  cache.set(key, { value, until: now + CACHE_MS });
  // Bounded: this is a public endpoint and the key space is caller-controlled.
  if (cache.size > 20_000) {
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size <= 10_000) break;
    }
  }
  return value;
}

/** Unspent outputs for one address, in Esplora's shape. */
async function utxosOf(coin, addr) {
  const how = await probe(coin);
  const tip = await rpc(coin, 'getblockcount', []);
  if (how === 'addrindex') {
    const rows = await rpc(coin, 'getaddressutxos', [{ addresses: [addr] }]);
    return (rows || []).map((u) => ({
      txid: u.txid,
      vout: u.outputIndex !== undefined ? u.outputIndex : u.vout,
      // This family reports satoshis as an integer already.
      value: Number(u.satoshis !== undefined ? u.satoshis : u.value),
      status: { confirmed: true, block_height: u.height },
    }));
  }
  if (how === 'scan') {
    const r = await rpc(coin, 'scantxoutset', ['start', [{ desc: `addr(${addr})` }]]);
    return ((r && r.unspents) || []).map((u) => ({
      txid: u.txid,
      vout: u.vout,
      // `amount` is decimal coins here, unlike every other path.
      value: Math.round(Number(u.amount) * 1e8),
      status: { confirmed: true, block_height: u.height },
    }));
  }
  // watch: register the address, then read what the wallet has seen since.
  const key = `${coin}:${addr}`;
  if (!watched.has(key)) {
    // rescan=false ON PURPOSE. A rescan of a 1.3M-block chain per unknown
    // address, on a public endpoint, is a denial of service with extra steps.
    await rpc(coin, 'importaddress', [addr, 'blockle-wallet', false]);
    watched.add(key);
  }
  const rows = await rpc(coin, 'listunspent', [0, 9_999_999, [addr]]);
  return (rows || [])
    .filter((u) => u.address === addr)
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: Math.round(Number(u.amount) * 1e8),
      status: { confirmed: (u.confirmations || 0) > 0, block_height: tip - (u.confirmations || 0) + 1 },
    }));
}

// ------------------------------------------------------------------- server

const hits = new Map();
function rateLimited(ip) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `${ip}:${minute}`;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 50_000) hits.clear();
  return n > RATE_PER_MIN;
}

function send(res, status, body, cacheSeconds = 0) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
    'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store',
    // The wallets are apps and web origins; this is public read-only data.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() ||
    req.socket.remoteAddress || '';
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (rateLimited(ip)) return send(res, 429, { error: 'slow down' });

  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'health') {
    return send(res, 200, { ok: true, coins: Object.keys(COINS) });
  }

  const coin = (parts[0] || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(COINS, coin)) {
    return send(res, 404, { error: 'unknown coin' });
  }

  try {
    // ---- status: what this coin can actually answer, and how completely
    if (parts[1] === 'status' && req.method === 'GET') {
      let how, height, err;
      try {
        how = await probe(coin);
        height = await rpc(coin, 'getblockcount', []);
      } catch (e) {
        err = e.message;
      }
      return send(res, 200, {
        coin,
        name: COINS[coin].name,
        decimals: COINS[coin].decimals,
        strategy: how || null,
        // The honest bit: `watch` only knows an address from its first query.
        complete: how === undefined ? null : how !== 'watch',
        height: height === undefined ? null : height,
        note:
          how === 'watch'
            ? 'addresses are tracked from first query; funds that arrived earlier ' +
              'need a rescan to appear'
            : undefined,
        error: err,
      });
    }

    // ---- POST /<coin>/tx : broadcast an already-signed transaction
    if (parts[1] === 'tx' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_TX_HEX) return send(res, 413, { error: 'transaction too large' });
      }
      raw = raw.trim();
      if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
        return send(res, 400, { error: 'body must be raw transaction hex' });
      }
      const txid = await rpc(coin, 'sendrawtransaction', [raw]);
      return send(res, 200, String(txid));
    }

    // ---- GET /<coin>/address/:a[/utxo]
    if (parts[1] === 'address' && req.method === 'GET' && parts[2]) {
      const addr = decodeURIComponent(parts[2]);
      if (!(await validAddress(coin, addr))) {
        return send(res, 400, { error: 'not a valid address for this chain' });
      }
      const us = await cached(`u:${coin}:${addr}`, () => utxosOf(coin, addr));
      const list = await us;

      if (parts[3] === 'utxo') return send(res, 200, list);
      if (parts[3] !== undefined) return send(res, 404, { error: 'not found' });

      const sum = list.reduce((a, u) => a + Number(u.value), 0);
      return send(res, 200, {
        address: addr,
        /*
         * ONLY THE DIFFERENCE IS MEANINGFUL, and the wallets only use the
         * difference: funded − spent is the confirmed balance. These are NOT
         * lifetime received/sent totals — nothing here indexes spent outputs —
         * so `spent_txo_sum` is zero and `funded_txo_sum` carries the current
         * balance. Reading either on its own as history would be wrong.
         */
        chain_stats: { funded_txo_sum: sum, spent_txo_sum: 0, tx_count: list.length },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
      });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof RpcError && (e.code === -28 || e.code === -1)) {
      // Still syncing or not up: 503 so a client retries rather than caching a
      // zero balance, which would read to a customer as "my coins are gone".
      return send(res, 503, { error: e.message, retry: true });
    }
    return send(res, 502, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[coin-esplora] listening on 127.0.0.1:${PORT} for ${Object.keys(COINS).join(', ')}`);
});

module.exports = { COINS, STRATEGIES };
