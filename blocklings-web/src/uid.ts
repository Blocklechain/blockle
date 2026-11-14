/**
 * Blocklings — canonical UID minting (part of the frozen contract).
 *
 * Every item/pet INSTANCE gets exactly one uid at creation, via newUid().
 * The uid is permanent: NFT mints on any chain embed it, and it travels
 * with the instance on every trade. Time + random base36 — collision-safe
 * enough for client-side instance creation.
 */

/** Monotonic tail so two uids minted in the same millisecond still differ. */
let seq = 0

/**
 * Mint a fresh canonical uid, e.g. `u-mhx3k2p1-7f3q9z8k1c-01`.
 * Format: 'u-' + ms-timestamp base36 + '-' + 10 random base36 chars + '-' + seq.
 */
export function newUid(): string {
  const t = Date.now().toString(36)
  const r = (Math.random().toString(36).slice(2, 7) + Math.random().toString(36).slice(2, 7)).padEnd(10, '0')
  seq = (seq + 1) % 1296 // 36^2
  const s = seq.toString(36).padStart(2, '0')
  return `u-${t}-${r}-${s}`
}
