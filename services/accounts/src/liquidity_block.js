// liquidity_block.js — the BLOCK (post-quantum, ML-DSA-44) leg of the liquidity
// treasury's on-chain settlement. BLOCK is NOT secp256k1: addresses are bech32m
// `block1…`, signatures are ML-DSA-44, txs are UTXO-based. All of that lives in
// the Rust core, loaded here via the Node wasm build (vendor/blockle_wasm.js).
//
// keygen() is RANDOM (not seed-derived), so the treasury BLOCK key is generated
// ONCE and persisted ENCRYPTED (AES-256-GCM, key = scrypt of LIQUIDITY_TREASURY_SEED)
// — the seed stays the root of trust, the raw secret never sits in plaintext at
// rest and never leaves this process. Everything that moves funds is gated by
// LIQUIDITY_MAINNET; with the gate off it throws, so no BLOCK ever moves without
// the operator's switch.
//
// Verified primitives (round-trip proven): keygen → {address,publicKey,secretKey};
// address_from_pubkey(pub)===address; sign/verify; build_transfer(sec,pub,utxos,
// to,amountBigInt,feeBigInt) → {raw,txid}; broadcast via /api/submit; deposits read
// from /api/explorer/tx/:txid and /utxos/:addr.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const COIN = 100000000n; // base units per BLOCK

/// The node's RPC (submitrawtransaction) and the WASM builder report a txid as
/// the raw hash bytes, while the explorer displays — and looks up — the
/// byte-REVERSED form (display_hash). Same tx, two spellings. Helpers below
/// accept either and report the explorer (display) form, which is what users
/// and wallets can actually look up.
export function flipTxid(txid) {
  const t = String(txid || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(t)) return t;
  return Buffer.from(t, 'hex').reverse().toString('hex');
}
const DEFAULT_FEE = 100000n; // 0.001 BLOCK flat fee
const require = createRequire(import.meta.url);

let _wasm = null;
function wasm() {
  if (_wasm) return _wasm;
  _wasm = require('./vendor/blockle_wasm.js');
  return _wasm;
}

// AES-256-GCM key bound to the treasury seed (the seed is the root of trust).
function encKey(seedHex) {
  return crypto.scryptSync(String(seedHex), 'blockle-liquidity-treasury-v1', 32);
}
function encryptSecret(secretHex, seedHex) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(seedHex), iv);
  const data = Buffer.concat([c.update(secretHex, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function decryptSecret(enc, seedHex) {
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(seedHex), Buffer.from(enc.iv, 'hex'));
  d.setAuthTag(Buffer.from(enc.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(enc.data, 'hex')), d.final()]).toString('utf8');
}

// Generate (once) + persist the treasury BLOCK wallet. Returns {address,publicKey}.
// The secret is only ever stored encrypted. Idempotent.
export async function ensureTreasuryWallet(store, seedHex, { walletKey = 'blockWallet' } = {}) {
  if (!seedHex || seedHex.length < 32) throw new Error('no treasury seed');
  const existing = store.get('liquidity', walletKey);
  if (existing && existing.address) return { address: existing.address, publicKey: existing.publicKey };
  const kp = JSON.parse(wasm().keygen());
  const rec = { address: kp.address, publicKey: kp.publicKey, enc: encryptSecret(kp.secretKey, seedHex), createdAt: Date.now() };
  await store.put('liquidity', walletKey, rec);
  return { address: rec.address, publicKey: rec.publicKey };
}

export function treasuryBlockAddress(store, seedHex, { walletKey = 'blockWallet' } = {}) {
  const rec = store.get('liquidity', walletKey);
  if (rec && rec.address) return rec.address;
  if (!seedHex) return null;
  return null; // not yet generated — call ensureTreasuryWallet first (on a write path)
}

function loadSigningMaterial(store, seedHex, walletKey = 'blockWallet') {
  const rec = store.get('liquidity', walletKey);
  if (!rec || !rec.enc) throw new Error('treasury BLOCK wallet not provisioned');
  return { address: rec.address, publicKey: rec.publicKey, secretKey: decryptSecret(rec.enc, seedHex) };
}


// Decimal string for an amount that may be a JS number in scientific notation
// (e.g. 4.68e-06): fixed to `dec` places, never "4.68e-6".
function decStr(amount, dec) {
  const s = String(amount);
  if (/e/i.test(s)) return Number(amount).toFixed(dec);
  return s;
}

function base(amountBlock) {
  // whole BLOCK -> base units (BigInt), exact to 8 dp.
  const [i, f = ''] = decStr(amountBlock, 8).split('.');
  const frac = (f + '00000000').slice(0, 8);
  return BigInt(i || '0') * COIN + BigInt(frac || '0');
}

async function getJson(chainBase, path, fetchFn) {
  const r = await fetchFn((chainBase || 'https://blockle.org') + '/api/explorer' + path, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  return r.json();
}

// Verify a user's BLOCK DEPOSIT: the tx must be MINED and have an output paying
// `expectTo` at least `minBlock` BLOCK. Read-only (explorer), no signing.
//
// Explorer shape: /api/explorer/tx/:txid returns { block_hash, tx: { outputs:
// [{address, amount, vout}], block_height, confirmations, ... } } — block_hash is
// null while the tx is still in the mempool. (A bare { outputs } body is also
// accepted for older/other explorers.) An unconfirmed deposit is reported as
// "not confirmed yet" so the wallet's pending-settlement loop simply retries.
export async function verifyBlockDeposit({ txid, expectTo, minBlock, chainBase, fetchFn = globalThis.fetch }) {
  if (!/^[0-9a-f]{64}$/i.test(String(txid || ''))) return { ok: false, reason: 'bad deposit txid' };
  // Wallets post the txid the node's submit returned (raw byte order); the
  // explorer indexes the reversed display form. Try the given spelling, then
  // the flipped one.
  let j = await getJson(chainBase, '/tx/' + encodeURIComponent(txid), fetchFn);
  if (!j || j.error) j = await getJson(chainBase, '/tx/' + flipTxid(txid), fetchFn);
  if (!j || j.error) return { ok: false, reason: 'tx not found' };
  const tx = (j.tx && typeof j.tx === 'object') ? j.tx : j;
  const wrapped = Object.prototype.hasOwnProperty.call(j, 'block_hash') || Object.prototype.hasOwnProperty.call(tx, 'block_height');
  const mined = !wrapped || j.block_hash != null || tx.block_height != null;
  if (!mined) return { ok: false, reason: 'deposit not confirmed yet' };
  const minBase = base(minBlock);
  const outs = tx.outputs || tx.vout || tx.out || [];
  let credited = 0n;
  for (const o of outs) {
    const addr = o.address || o.addr || o.scriptpubkey_address;
    if (addr === expectTo) credited += BigInt(o.amount ?? o.value ?? 0);
  }
  if (credited < minBase) return { ok: false, reason: 'deposit to treasury too low' };
  // Where a refund would go: the depositor's first input address.
  const ins = tx.inputs || tx.vin || [];
  const refundAddress = (ins[0] && (ins[0].address || ins[0].addr)) || null;
  return { ok: true, creditedBase: credited.toString(), refundAddress };
}

// Read the ACTUAL on-chain BLOCK balance of an address (whole BLOCK). Read-only
// (explorer /address/:addr → balance in base units). Returns 0 on any failure.
export async function blockAddressBalance(address, chainBase, fetchFn = globalThis.fetch) {
  if (!address) return 0;
  try {
    const j = await getJson(chainBase, '/address/' + encodeURIComponent(address), fetchFn);
    const baseUnits = BigInt((j && (j.balance ?? j.spendable)) || 0);
    return Number(baseUnits) / Number(COIN);
  } catch (_) {
    return 0;
  }
}

/// A payout failure the relayer should RETRY rather than treat as final: our own
/// previous payout is still confirming (its inputs look unspent to the explorer
/// until the next block), or the node/RPC was momentarily unreachable.
export function isRetryablePayoutError(msg) {
  // An underfunded treasury hot wallet is retryable too: the operator gets the
  // retry budget (8 attempts / 30 min) to fund it before the deposit is refunded.
  return /double-spend|already in the mempool|payout queued|waiting for a previous|unknown or already-spent|nonce|underfunded|rent-exempt|insufficient funds: has|ECONN|ETIMEDOUT|timed? ?out|fetch failed|rpc:|503|502|blockhash/i.test(String(msg || ''));
}

const PENDING_KEY = 'blockPendingSpends';
const PENDING_TTL_MS = 30 * 60 * 1000;
const opKey = (u) => `${u.txid}:${u.vout}`;

/// Outpoints our own not-yet-confirmed payouts already spend. The explorer's
/// /utxos keeps listing them until the payout is mined, so a second payout
/// built from the same list would double-spend and be rejected. Entries vanish
/// once the outpoint leaves the utxo set (confirmed) or after a TTL.
function loadPending(store, utxos, nowMs, pendingKey = PENDING_KEY) {
  const rec = (store && store.get('liquidity', pendingKey)) || {};
  const live = new Set(utxos.map(opKey));
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!live.has(k)) continue; // spent for real (confirmed) — drop
    if (nowMs - (v.at || 0) > PENDING_TTL_MS) continue; // stale — the tx was dropped; free it
    out[k] = v;
  }
  return out;
}

/// Largest-first selection of spendable inputs covering `need`, excluding
/// outpoints pending in our own unconfirmed payouts. Capped at 140 inputs (the
/// post-quantum signature size makes bigger txs unminable).
function selectInputs(utxos, pending, need) {
  const free = utxos.filter((u) => !pending[opKey(u)]).sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  const picked = [];
  let total = 0n;
  for (const u of free) {
    picked.push(u); total += BigInt(u.amount);
    if (total >= need) break;
    if (picked.length >= 140) break;
  }
  return { picked, total, excluded: utxos.length - free.length };
}

// Pay out `amountBlock` BLOCK from the treasury to `toAddress`. GATED. Fetches the
// treasury UTXOs, selects inputs (skipping ones our own confirming payouts already
// spend), builds + ML-DSA-signs the transfer (wasm), broadcasts via submit, and
// records the spent outpoints as pending until they confirm.
export async function payoutBlock({ store, seedHex, toAddress, amountBlock, chainBase, fetchFn = globalThis.fetch, env = process.env, now = () => Date.now(), walletKey = 'blockWallet', pendingKey = PENDING_KEY }) {
  if (!/^(1|true|yes|on)$/i.test(env.LIQUIDITY_MAINNET || '')) throw new Error('liquidity settlement disabled (LIQUIDITY_MAINNET not set)');
  const { address, publicKey, secretKey } = loadSigningMaterial(store, seedHex, walletKey);
  const u = await getJson(chainBase, '/utxos/' + address, fetchFn);
  const utxos = (u && u.utxos) || [];
  if (!utxos.length) throw new Error('treasury BLOCK wallet has no spendable funds');
  const need = base(amountBlock) + DEFAULT_FEE;
  const pending = loadPending(store, utxos, now(), pendingKey);
  const sel = selectInputs(utxos, pending, need);
  if (sel.total < need) {
    if (sel.excluded > 0) throw new Error(`payout queued: treasury BLOCK inputs are waiting for a previous payout to confirm (${sel.excluded} pending) — will retry`);
    throw new Error(`treasury BLOCK wallet has insufficient funds: has ${Number(sel.total) / Number(COIN)} BLOCK, needs ${Number(need) / Number(COIN)} BLOCK`);
  }
  const built = JSON.parse(wasm().build_transfer(secretKey, publicKey, JSON.stringify(sel.picked), toAddress, base(amountBlock), DEFAULT_FEE));
  const raw = built.raw || built.rawtx || built.hex;
  if (!raw) throw new Error('build_transfer produced no raw tx');
  const markPending = async (txid) => {
    if (!store) return;
    const cur = loadPending(store, utxos, now(), pendingKey);
    for (const u of sel.picked) cur[opKey(u)] = { txid, at: now() };
    await store.put('liquidity', pendingKey, cur);
  };
  // The submit proxy (biz /api/submit -> node submitrawtransaction) reads the
  // signed tx from the `raw` field. A rejected broadcast MUST fail loudly: the
  // caller marks the swap settled only after this returns, so swallowing an
  // error here would record a payout that never reached the chain.
  const br = await fetchFn((chainBase || 'https://blockle.org') + '/api/submit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
  });
  const bj = await br.json().catch(() => ({}));
  const err = bj && bj.error;
  if (!br.ok || err) {
    const msg = err && typeof err === 'object' ? (err.message || JSON.stringify(err)) : (err || ('http ' + br.status));
    // A double-spend rejection means these inputs ARE already spent by a payout
    // we did not track (e.g. an older build): mark them pending so the retry
    // picks different inputs instead of failing the same way.
    if (/double-spend|already in the mempool|already-spent/i.test(String(msg))) await markPending('unknown');
    throw new Error('BLOCK payout broadcast rejected: ' + msg);
  }
  const res = bj && typeof bj.result === 'object' && bj.result ? bj.result : bj;
  const rpcTxid = (res && (res.txid || (typeof bj.result === 'string' ? bj.result : null))) || built.txid;
  await markPending(rpcTxid);
  // Report the explorer-visible (display) spelling; keep the node's for audit.
  return { txid: flipTxid(rpcTxid), txidRpc: rpcTxid, raw, inputs: sel.picked.map(opKey) };
}
