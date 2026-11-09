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
export async function ensureTreasuryWallet(store, seedHex) {
  if (!seedHex || seedHex.length < 32) throw new Error('no treasury seed');
  const existing = store.get('liquidity', 'blockWallet');
  if (existing && existing.address) return { address: existing.address, publicKey: existing.publicKey };
  const kp = JSON.parse(wasm().keygen());
  const rec = { address: kp.address, publicKey: kp.publicKey, enc: encryptSecret(kp.secretKey, seedHex), createdAt: Date.now() };
  await store.put('liquidity', 'blockWallet', rec);
  return { address: rec.address, publicKey: rec.publicKey };
}

export function treasuryBlockAddress(store, seedHex) {
  const rec = store.get('liquidity', 'blockWallet');
  if (rec && rec.address) return rec.address;
  if (!seedHex) return null;
  return null; // not yet generated — call ensureTreasuryWallet first (on a write path)
}

function loadSigningMaterial(store, seedHex) {
  const rec = store.get('liquidity', 'blockWallet');
  if (!rec || !rec.enc) throw new Error('treasury BLOCK wallet not provisioned');
  return { address: rec.address, publicKey: rec.publicKey, secretKey: decryptSecret(rec.enc, seedHex) };
}

function base(amountBlock) {
  // whole BLOCK -> base units (BigInt), exact to 8 dp.
  const [i, f = ''] = String(amountBlock).split('.');
  const frac = (f + '00000000').slice(0, 8);
  return BigInt(i || '0') * COIN + BigInt(frac || '0');
}

async function getJson(chainBase, path, fetchFn) {
  const r = await fetchFn((chainBase || 'https://blockle.org') + '/api/explorer' + path, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  return r.json();
}

// Verify a user's BLOCK DEPOSIT: the tx must have an output paying `expectTo` at
// least `minBlock` BLOCK. Read-only (explorer), no signing.
export async function verifyBlockDeposit({ txid, expectTo, minBlock, chainBase, fetchFn = globalThis.fetch }) {
  const j = await getJson(chainBase, '/tx/' + encodeURIComponent(txid), fetchFn);
  if (!j || j.error) return { ok: false, reason: 'tx not found' };
  const minBase = base(minBlock);
  const outs = j.outputs || j.vout || j.out || [];
  let credited = 0n;
  for (const o of outs) {
    const addr = o.address || o.addr || o.scriptpubkey_address;
    if (addr === expectTo) credited += BigInt(o.amount ?? o.value ?? 0);
  }
  if (credited < minBase) return { ok: false, reason: 'deposit to treasury too low' };
  return { ok: true, creditedBase: credited.toString() };
}

// Pay out `amountBlock` BLOCK from the treasury to `toAddress`. GATED. Fetches the
// treasury UTXOs, builds + ML-DSA-signs the transfer (wasm), broadcasts via submit.
export async function payoutBlock({ store, seedHex, toAddress, amountBlock, chainBase, fetchFn = globalThis.fetch, env = process.env }) {
  if (!/^(1|true|yes|on)$/i.test(env.LIQUIDITY_MAINNET || '')) throw new Error('liquidity settlement disabled (LIQUIDITY_MAINNET not set)');
  const { address, publicKey, secretKey } = loadSigningMaterial(store, seedHex);
  const u = await getJson(chainBase, '/utxos/' + address, fetchFn);
  const utxos = (u && u.utxos) || [];
  if (!utxos.length) throw new Error('treasury BLOCK wallet has no spendable funds');
  const built = JSON.parse(wasm().build_transfer(secretKey, publicKey, JSON.stringify(utxos), toAddress, base(amountBlock), DEFAULT_FEE));
  const raw = built.raw || built.rawtx || built.hex;
  if (!raw) throw new Error('build_transfer produced no raw tx');
  const br = await fetchFn((chainBase || 'https://blockle.org') + '/api/submit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawtx: raw }),
  });
  const bj = await br.json().catch(() => ({}));
  return { txid: bj.txid || bj.result || built.txid, raw };
}
