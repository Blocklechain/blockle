// store.js — durable state: pool reserves, per-currency custody, trade ledger,
// the live-trade INTENTS, per-asset deposit-watch cursors, claimed deposit txids
// (so one deposit can't fund two intents), and the solvency pause flag.
// JSON file with atomic write (temp + rename). BigInts persist as decimal strings.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function reviveState(obj) {
  const custody = {};
  for (const [k, v] of Object.entries(obj.custody || {})) custody[k] = BigInt(v);
  return { rBlock: BigInt(obj.rBlock), rUsd: BigInt(obj.rUsd), custody };
}
function dumpState(s) {
  const custody = {};
  for (const [k, v] of Object.entries(s.custody || {})) custody[k] = v.toString();
  return { rBlock: s.rBlock.toString(), rUsd: s.rUsd.toString(), custody };
}

function createStore(file, seedState) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data;
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    data = { state: dumpState(seedState), ledger: [], intents: {}, cursors: {}, claimed: {}, paused: false, seededAt: null };
  }
  // migrate older files
  data.intents = data.intents || {}; data.cursors = data.cursors || {};
  data.claimed = data.claimed || {}; data.paused = data.paused || false;

  let timer = null;
  function persist() {
    // debounce bursts a touch but always flush within 300ms
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, 50);
  }
  function flush() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }
  if (!fs.existsSync(file)) flush();

  return {
    getState() { return reviveState(data.state); },
    setState(s) { data.state = dumpState(s); flush(); },

    appendTrade(entry) { data.ledger.push(entry); if (data.ledger.length > 100000) data.ledger = data.ledger.slice(-100000); persist(); },
    ledger(limit = 100) { return data.ledger.slice(-limit).reverse(); },

    // intents
    putIntent(it) { data.intents[it.id] = it; flush(); },
    getIntent(id) { return data.intents[id] || null; },
    listIntents(status) { const a = Object.values(data.intents); return status ? a.filter((i) => i.status === status) : a; },

    // per-asset deposit-watch cursor (block height / slot)
    getCursor(asset) { return data.cursors[asset] || 0; },
    setCursor(asset, c) { data.cursors[asset] = c; persist(); },

    // claimed deposit txids (one deposit funds at most one intent)
    isClaimed(txid) { return !!data.claimed[txid]; },
    claim(txid, intentId) { data.claimed[txid] = intentId; flush(); },

    // solvency pause flag
    isPaused() { return !!data.paused; },
    setPaused(p) { data.paused = !!p; flush(); },

    stats() { return { trades: data.ledger.length, volumeUsd: data.ledger.reduce((a, t) => a + (t.usd || 0), 0), openIntents: Object.values(data.intents).filter((i) => i.status === 'awaiting_deposit').length }; },
    flush,
  };
}

module.exports = { createStore, reviveState, dumpState };
