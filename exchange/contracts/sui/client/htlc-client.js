// JS client stub for the Blockle Sui HTLC leg.
//
// Builds UNSIGNED programmable transaction blocks (PTBs) for lock / redeem /
// refund that the frontend wallet or the relay-driven SDK can sign and submit.
// This module is non-custodial by construction: it never takes a private key,
// never signs, and never submits — it only shapes the Move calls. Signing +
// submission is the wallet's job (frontend) exactly like the other legs.
//
// Protocol hash is SHA-256 (matches EVM/Solana/BTC): H = sha256(preimage), so
// one preimage opens every leg. See ../../PROTOCOL.md.
//
// Peer dependency: `@mysten/sui` (v1.x). Install in the consuming package:
//   npm i @mysten/sui
//
// Usage (frontend):
//   import { Transaction } from "@mysten/sui/transactions";
//   import { buildLockTx, deriveHashlock } from "./htlc-client.js";
//   const hashlock = await deriveHashlock(preimageBytes);
//   const tx = buildLockTx({ packageId, coinType: "0x2::sui::SUI",
//     amount: 1_000_000n, receiver, hashlock, timelockMs, feeBps: 10, feeRecipient });
//   const res = await wallet.signAndExecuteTransaction({ transaction: tx });

import { Transaction } from "@mysten/sui/transactions";

/** The Sui system Clock object — the same well-known id on every network. */
export const SUI_CLOCK_OBJECT_ID = "0x6";

/** Settlement-fee hard cap, mirroring the on-chain `MAX_FEE_BPS` (1.00%). */
export const MAX_FEE_BPS = 100;

/** Native SUI coin type. Any other `Coin<T>` (e.g. USDC-on-Sui) works too. */
export const SUI_COIN_TYPE = "0x2::sui::SUI";

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v);
  if (typeof v === "string") {
    const hex = v.startsWith("0x") ? v.slice(2) : v;
    if (hex.length % 2 !== 0) throw new Error("hex hashlock/preimage must be byte-aligned");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  throw new Error("expected Uint8Array | number[] | hex string");
}

/**
 * H = sha256(preimage) as a 32-byte Uint8Array. Uses Web Crypto (browser +
 * modern Node). The relay typically generates the preimage and hashlock; this
 * helper lets the client verify/derive it with the identical hash the module
 * checks on-chain.
 */
export async function deriveHashlock(preimage) {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(preimage));
  return new Uint8Array(digest);
}

function assertHashlock(hashlock) {
  const h = toBytes(hashlock);
  if (h.length !== 32) throw new Error(`hashlock must be 32 bytes, got ${h.length}`);
  return h;
}

/**
 * Build a lock PTB: escrow `amount` of `coinType` into a fresh shared HTLC.
 * For native SUI the escrow is split off the gas coin; for any other coin pass
 * `coinObjectId` (an owned Coin<T> object) to split from instead.
 *
 * @returns {Transaction} unsigned; hand to the wallet to sign + execute.
 */
export function buildLockTx({
  packageId,
  coinType = SUI_COIN_TYPE,
  amount,
  receiver,
  hashlock,
  timelockMs,
  feeBps,
  feeRecipient,
  coinObjectId, // required for non-SUI coins; optional for SUI (defaults to gas)
  tx = new Transaction(),
}) {
  if (!packageId) throw new Error("packageId required");
  if (feeBps > MAX_FEE_BPS) throw new Error(`feeBps ${feeBps} exceeds MAX_FEE_BPS ${MAX_FEE_BPS}`);
  const h = assertHashlock(hashlock);
  const amt = BigInt(amount);
  if (amt <= 0n) throw new Error("amount must be > 0");

  const source = coinType === SUI_COIN_TYPE && !coinObjectId ? tx.gas : tx.object(coinObjectId);
  const [escrow] = tx.splitCoins(source, [tx.pure.u64(amt)]);

  tx.moveCall({
    target: `${packageId}::htlc::lock`,
    typeArguments: [coinType],
    arguments: [
      escrow,
      tx.pure.address(receiver),
      tx.pure.vector("u8", Array.from(h)),
      tx.pure.u64(BigInt(timelockMs)),
      tx.pure.u16(feeBps),
      tx.pure.address(feeRecipient),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build a redeem PTB: reveal `preimage` to settle, paying the receiver (minus
 * fee) and the fee recipient. Valid only before the timelock.
 */
export function buildRedeemTx({
  packageId,
  coinType = SUI_COIN_TYPE,
  htlcId,
  preimage,
  tx = new Transaction(),
}) {
  if (!packageId) throw new Error("packageId required");
  if (!htlcId) throw new Error("htlcId (shared HTLC object id) required");
  const p = toBytes(preimage);

  tx.moveCall({
    target: `${packageId}::htlc::redeem`,
    typeArguments: [coinType],
    arguments: [
      tx.object(htlcId),
      tx.pure.vector("u8", Array.from(p)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build a refund PTB: return the full escrow to the sender after the timelock.
 * No fee. Must be submitted by the recorded sender.
 */
export function buildRefundTx({
  packageId,
  coinType = SUI_COIN_TYPE,
  htlcId,
  tx = new Transaction(),
}) {
  if (!packageId) throw new Error("packageId required");
  if (!htlcId) throw new Error("htlcId (shared HTLC object id) required");

  tx.moveCall({
    target: `${packageId}::htlc::refund`,
    typeArguments: [coinType],
    arguments: [tx.object(htlcId), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  return tx;
}

/**
 * Compute a Sui timelock (ms since epoch) from a unix-seconds deadline, so the
 * relay can size the Sui leg against the EVM/Solana unix-second timelocks while
 * honoring the protocol's T2 < T1 rule.
 */
export function timelockMsFromUnixSeconds(unixSeconds) {
  return BigInt(Math.floor(unixSeconds)) * 1000n;
}
