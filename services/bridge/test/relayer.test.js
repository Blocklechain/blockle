// relayer.test.js — the cross-chain relayer driving the engine from fake chain
// adapters. No live chain/RPC/reserve-signer is touched; adapters are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { BridgeStore } from '../src/store.js';
import { BridgeEngine, STATES, DIRECTIONS } from '../src/statemachine.js';
import { toBase } from '../src/accounting.js';
import { Relayer } from '../src/relayer.js';

const DEP_TX = 'a'.repeat(64);
const SOL_DEST = 'So1Recipient11111111111111111111111111111111';
const BURN_SIG = '5Xp9QwZ' + 'z'.repeat(80);
const BLOCK_DEST = 'block1userredeemaddress000000000000000000';

function makeHarness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-relayer-'));
  const cfg = loadConfig({
    dataDir: dir, confirmationDepth: 3,
    blockBridgeAddr: 'block1bridgereserveaddress00000000000000',
    solblockMint: 'So1b1ockMintPubkey1111111111111111111111111',
    perTxCapBase: toBase('100'), dailyCapBase: toBase('1000'),
    ...overrides,
  });
  const store = new BridgeStore(dir);
  const engine = new BridgeEngine({ store, config: cfg });

  // fake BLOCK deposit confirmer — configurable per-txid
  const seenByTx = new Map(); // txid -> { amountBase, confirmations } | 'throw'
  const blockClient = {
    async confirmTx(txid) {
      const v = seenByTx.get(txid);
      if (v === 'throw') throw new Error('rpc outage');
      return v || null;
    },
  };
  // fake Solana burn scanner — a queue of burns
  let burns = [];
  const solClient = { async burnsSince() { return burns; } };

  // idempotent-by-ref adapters: map ref -> output; `unique` = on-chain executions.
  const mintByRef = new Map();
  const minter = {
    invocations: 0,
    async mint({ ref }) { this.invocations++; if (!mintByRef.has(ref)) mintByRef.set(ref, 'sig_' + ref.slice(0, 8)); return mintByRef.get(ref); },
    get unique() { return mintByRef.size; },
  };
  const relByRef = new Map();
  const reserveSigner = {
    invocations: 0,
    async dispense({ ref }) { this.invocations++; if (!relByRef.has(ref)) relByRef.set(ref, 'blocktx_' + ref.slice(0, 8)); return { txid: relByRef.get(ref) }; },
    get unique() { return relByRef.size; },
  };

  const relayer = new Relayer({ engine, store, config: cfg, blockClient, solClient, minter, reserveSigner });
  return { dir, cfg, store, engine, relayer, minter, reserveSigner, setSeen: (tx, v) => seenByTx.set(tx, v), setBurns: (b) => { burns = b; } };
}

test('deposit -> mint: a confirmed intent mints exactly once and completes', async () => {
  const h = makeHarness();
  await h.engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, destination: SOL_DEST });
  h.setSeen(DEP_TX, { amountBase: toBase('10').toString(), confirmations: 5 });
  await h.relayer.tick();
  assert.equal(h.minter.unique, 1, 'minted once');
  assert.equal(h.store.all('deposits')[0].state, STATES.COMPLETED);
});

test('idempotent: re-ticking a completed deposit does not re-mint', async () => {
  const h = makeHarness();
  await h.engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, destination: SOL_DEST });
  h.setSeen(DEP_TX, { amountBase: toBase('10').toString(), confirmations: 5 });
  await h.relayer.tick();
  await h.relayer.tick();
  await h.relayer.tick();
  assert.equal(h.minter.unique, 1, 'still one on-chain mint');
});

test('insufficient confirmations: no mint until depth reached', async () => {
  const h = makeHarness();
  await h.engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, destination: SOL_DEST });
  h.setSeen(DEP_TX, { amountBase: toBase('10').toString(), confirmations: 2 }); // depth is 3
  await h.relayer.tick();
  assert.equal(h.minter.unique, 0, 'not minted below depth');
  h.setSeen(DEP_TX, { amountBase: toBase('10').toString(), confirmations: 3 });
  await h.relayer.tick();
  assert.equal(h.minter.unique, 1, 'minted at depth');
});

test('crash recovery: a MINTING record (settle never ran) re-mints idempotently', async () => {
  const h = makeHarness();
  // drive to MINTING via the engine directly, as if the relayer crashed before settle
  await h.engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, destination: SOL_DEST });
  await h.engine.observeSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, confirmations: 3, amountBase: toBase('10').toString() });
  const rec = await h.engine.verify({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX });
  assert.equal(rec.state, STATES.MINTING);
  await h.relayer.tick(); // recovery path
  assert.equal(h.minter.unique, 1);
  assert.equal(h.store.all('deposits')[0].state, STATES.COMPLETED);
});

test('rpc outage: tick does not throw and increments retries', async () => {
  const h = makeHarness();
  await h.engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, destination: SOL_DEST });
  h.setSeen(DEP_TX, 'throw');
  await h.relayer.tick(); // must not throw
  assert.ok(h.relayer.retries >= 1, 'retry counter advanced');
  assert.equal(h.minter.unique, 0);
  assert.ok(h.relayer.backoffMs() > 0);
});

test('redeem -> release: a finalized burn releases BLOCK once (needs backing)', async () => {
  const h = makeHarness();
  // first create backing: a completed deposit of 100 BLOCK
  await h.engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, destination: SOL_DEST });
  h.setSeen(DEP_TX, { amountBase: toBase('100').toString(), confirmations: 5 });
  await h.relayer.tick();
  // now a burn of 10 wBLOCK redeeming to a BLOCK address
  h.setBurns([{ signature: BURN_SIG, slot: 10, finalized: true, amountBase: toBase('10').toString(), blockDestination: BLOCK_DEST }]);
  await h.relayer.tick();
  assert.equal(h.reserveSigner.unique, 1, 'released once');
  const burn = h.store.all('burns')[0];
  assert.equal(burn.state, STATES.COMPLETED);
});

test('concurrent duplicate processing: parallel ticks release at most once', async () => {
  const h = makeHarness();
  await h.engine.submitSource({ direction: DIRECTIONS.DEPOSIT, sourceTx: DEP_TX, destination: SOL_DEST });
  h.setSeen(DEP_TX, { amountBase: toBase('100').toString(), confirmations: 5 });
  await h.relayer.tick();
  h.setBurns([{ signature: BURN_SIG, slot: 10, finalized: true, amountBase: toBase('10').toString(), blockDestination: BLOCK_DEST }]);
  await Promise.all([h.relayer.tick(), h.relayer.tick()]);
  assert.equal(h.reserveSigner.unique, 1, 'at most one on-chain release');
});
