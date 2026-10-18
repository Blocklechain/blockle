// config.js — operator configuration for the BLOCK <-> wBLOCK bridge.
//
// TRUST MODEL (stated plainly, everywhere): this is a CUSTODIAL / trusted-operator
// bridge. wBLOCK is a STANDARD SPL mint (Token Program, 8 decimals to match
// BLOCK's COIN=1e8) whose mint authority is the bridge operator key. Every
// wBLOCK in circulation is backed ONLY by BLOCK held in the operator's reserve
// wallet. This is NOT a trustless on-chain vault and an off-chain DB is NOT an
// on-chain vault. Do not claim otherwise.
//
// SAFETY POSTURE — everything that could move money or deploy is OFF by default:
//   - mainnetEnabled defaults false. The accounting core + state machine never
//     move money themselves; execution adapters (sibling streams) must refuse to
//     act unless mainnetEnabled === true AND dryRun === false.
//   - solanaCluster defaults "devnet" (never mainnet-beta unless an operator sets
//     it AND flips mainnetEnabled).
//   - confirmationDepth defaults 100 — the same reorg-safety depth the settlement
//     service uses for inbound BLOCK (coinbase maturity).
//   - per-tx + daily issuance caps default conservative + finite (blast radius).
//   - paused is a hard kill-switch for new issuance.
//
// NO SECRETS LIVE HERE. The reserve/mint keys never enter this process — BLOCK is
// released only by POSTing the loopback reserve-signer; wBLOCK is minted only by
// the operator's keyed signer (sibling stream). Config holds URLs + flags only.

import path from 'node:path';

const COIN = 100000000n; // 1 BLOCK / 1 wBLOCK = 1e8 base units (8 decimals)

function envStr(k, d) {
  const v = process.env[k];
  return v == null || v === '' ? d : v;
}
function envNum(k, d) {
  const v = process.env[k];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}
function envBool(k, d) {
  const v = process.env[k];
  if (v == null || v === '') return d;
  return v === '1' || v.toLowerCase() === 'true';
}

// Whole-unit (BLOCK/wBLOCK) decimal string/number -> integer base units (bigint).
// Exact to 8 dp; rejects extra precision so an operator can't silently round money.
export function unitsToBase(whole) {
  const s = String(whole).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount "${whole}"`);
  const neg = s.startsWith('-');
  const [intPart, fracPart = ''] = (neg ? s.slice(1) : s).split('.');
  if (fracPart.length > 8) throw new Error(`amount "${whole}" exceeds 8 decimals`);
  const frac = fracPart.padEnd(8, '0');
  const base = BigInt(intPart) * COIN + BigInt(frac || '0');
  return neg ? -base : base;
}

export function loadConfig(overrides = {}) {
  const dataDir = envStr('BRIDGE_DATA', path.join(process.cwd(), 'data'));

  const cfg = {
    // --- storage ---
    dataDir,

    // --- BLOCK side (read-only verification) ---
    // Node aux-http explorer base; we GET /explorer/tx/{id} exactly like the
    // settlement service to confirm a deposit paid the bridge address + its depth.
    blockNodeUrl: envStr('BRIDGE_BLOCK_NODE_URL', 'http://127.0.0.1:18444'),
    // The block1… address users deposit BLOCK to for a mint.
    blockBridgeAddr: envStr('BRIDGE_BLOCK_ADDR', ''),

    // --- BLOCK release path (the ONLY way BLOCK leaves the reserve) ---
    // Loopback reserve-signer. We POST /reserve/dispense to release BLOCK on a
    // verified redemption. We NEVER hold the reserve key.
    reserveSignerUrl: envStr('BRIDGE_RESERVE_SIGNER_URL', 'http://127.0.0.1:8795'),
    reserveSignerToken: envStr('BRIDGE_RESERVE_SIGNER_TOKEN', ''), // optional bearer

    // --- Solana / wBLOCK side ---
    solanaRpc: envStr('BRIDGE_SOLANA_RPC', 'https://api.devnet.solana.com'),
    solanaCluster: envStr('BRIDGE_SOLANA_CLUSTER', 'devnet'), // devnet | testnet | mainnet-beta
    // The SPL mint for wBLOCK (base58). Optional until created by an operator.
    solblockMint: envStr('BRIDGE_wBLOCK_MINT', ''),

    // --- economics / safety ---
    decimals: 8,
    confirmationDepth: envNum('BRIDGE_CONFIRMATION_DEPTH', 100),
    // Fees (default 0): a flat fee in base units plus a basis-points fee. Charged
    // on the OUTPUT so backing can only ever meet-or-exceed outstanding supply.
    feeFlatBase: BigInt(Math.trunc(envNum('BRIDGE_FEE_FLAT_BASE', 0))),
    feeBps: envNum('BRIDGE_FEE_BPS', 0),
    // Limits (finite + conservative by default). <=0 means "unlimited" ONLY if an
    // operator explicitly sets it; the defaults are finite on purpose.
    perTxCapBase: unitsToBase(envNum('BRIDGE_PER_TX_CAP', 100)),
    dailyCapBase: unitsToBase(envNum('BRIDGE_DAILY_CAP', 1000)),

    // --- master gates (default OFF / dry-run) ---
    paused: envBool('BRIDGE_PAUSED', false),
    mainnetEnabled: envBool('BRIDGE_MAINNET_ENABLED', false),
    dryRun: envBool('BRIDGE_DRY_RUN', true),

    COIN,
  };

  return { ...cfg, ...overrides };
}

export { COIN };
