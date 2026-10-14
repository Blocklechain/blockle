// test/backtest/fetch-candles.js — pull REAL historical hourly candles from a
// PUBLIC (keyless) exchange API and cache them to candles.json so the backtest
// harness runs deterministically + offline (and `npm test` never touches the net).
//
// Binance.com geo-blocks this host ("Service unavailable from a restricted
// location"), so we use api.binance.us (same kline shape). Coinbase is the
// documented secondary fallback. ~720 hourly candles ≈ 30 days per symbol.
//
//   node test/backtest/fetch-candles.js
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'ADA', 'LINK', 'DOGE'];
const LIMIT = 720;
const OUT = path.join(__dirname, 'candles.json');

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function binanceUs(sym) {
  const url = `https://api.binance.us/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=${LIMIT}`;
  const rows = await get(url);
  // kline: [openTime, open, high, low, close, volume, closeTime, ...]
  return rows.map((r) => ({ t: r[0], close: Number(r[4]) }));
}

async function coinbase(sym) {
  // Coinbase public candles: granularity 3600 (1h), max 300 per call.
  const url = `https://api.exchange.coinbase.com/products/${sym}-USD/candles?granularity=3600`;
  const rows = await get(url);
  // [ time, low, high, open, close, volume ] — newest first; reverse to oldest-first.
  return rows.map((r) => ({ t: r[0] * 1000, close: Number(r[4]) })).reverse();
}

async function main() {
  const out = { source: null, fetchedAt: new Date().toISOString(), interval: '1h', symbols: {} };
  let source = 'binance.us';
  for (const sym of SYMBOLS) {
    try {
      const candles = await binanceUs(sym);
      out.symbols[sym] = candles;
      process.stdout.write(`binance.us ${sym}: ${candles.length} candles\n`);
    } catch (e) {
      process.stdout.write(`binance.us ${sym} FAILED (${e.message}); trying coinbase\n`);
      try {
        const candles = await coinbase(sym);
        out.symbols[sym] = candles;
        source = 'mixed(binance.us+coinbase)';
        process.stdout.write(`coinbase ${sym}: ${candles.length} candles\n`);
      } catch (e2) {
        process.stdout.write(`coinbase ${sym} FAILED (${e2.message})\n`);
      }
    }
  }
  out.source = Object.keys(out.symbols).length ? source : 'none';
  if (!Object.keys(out.symbols).length) { console.error('NO real data fetched from any source.'); process.exit(1); }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nWrote ${OUT} (source=${out.source}, ${Object.keys(out.symbols).length} symbols)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
