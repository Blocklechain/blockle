/**
 * Minting — pure `mintedOnly` helpers (stateless leaf utilities, like
 * src/uid.ts / src/ids.ts). The marketplace uses these to gate crypto
 * listings per the NFT LAW: only minted things trade for crypto, and a
 * crypto price on chain C requires a MintRecord ON chain C. Gold listings
 * need no mint.
 *
 * They work on anything shaped like Mintable / ItemInstance / PetInstance.
 */
import type { ChainId, MintRecord } from '../types'

/** Anything that may carry an NFT identity. */
export interface MaybeMintable {
  uid?: string
  mints?: readonly MintRecord[]
}

/** A mint only counts when it carries a REAL token + tx (never fabricated). */
function realMints(x: MaybeMintable): readonly MintRecord[] {
  return (x.mints ?? []).filter((m) => Boolean(m.token) && Boolean(m.tx))
}

/** True if the goods carry a uid and at least one real mint on any chain. */
export function isMinted(x: MaybeMintable): boolean {
  return Boolean(x.uid) && realMints(x).length > 0
}

/** The MintRecord for `chain`, if the goods are minted there. */
export function mintedOn(x: MaybeMintable, chain: ChainId): MintRecord | undefined {
  if (!x.uid) return undefined
  return realMints(x).find((m) => m.chain === chain)
}

/** Chains the goods are minted on (empty = unminted → gold-trade only). */
export function mintedChains(x: MaybeMintable): readonly ChainId[] {
  if (!x.uid) return []
  const out: ChainId[] = []
  for (const m of realMints(x)) if (!out.includes(m.chain)) out.push(m.chain)
  return out
}

/**
 * NFT-LAW gate for crypto listings: a listing priced in crypto on `chain`
 * requires the goods minted on that same chain. (Gold listings skip this.)
 */
export function canListForCrypto(x: MaybeMintable, chain: ChainId): boolean {
  return mintedOn(x, chain) !== undefined
}

/** Keep only crypto-listable goods for `chain` (marketplace convenience). */
export function mintedOnly<T extends MaybeMintable>(goods: readonly T[], chain?: ChainId): T[] {
  return goods.filter((g) => (chain ? canListForCrypto(g, chain) : isMinted(g)))
}
