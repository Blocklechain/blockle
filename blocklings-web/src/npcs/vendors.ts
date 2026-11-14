/**
 * NPCs — vendor stock lists. Item ids follow the frozen conventions in
 * src/ids.ts; the inventory module resolves defs (or synthesizes them), we
 * only name and price things.
 *
 * ECONOMY LAW: prices are REAL on-chain crypto — mostly tiny BLOCK amounts,
 * plus a couple of ETH/SOL novelty pieces — or GOLD, the IAP premium
 * currency. Every item is payable on any of the four rails (BLOCK / ETH /
 * SOL / GOLD); the entry's `price` is the anchor and `railPrices()` derives
 * the other three via the VENDOR-POSTED exchange rates below. The buy flow
 * settles through the integrator-wired pay functions (wallet.sendOn to the
 * treasury address for crypto, server-side spend for GOLD); nothing here
 * fabricates a tx or a balance.
 */
import type { ChainId } from '../types'

export interface VendorPrice {
  chain: ChainId
  amount: number
}

export interface StockEntry {
  id: string
  name: string
  price: VendorPrice
  /** One-liner shown under the item in the shop list. */
  pitch: string
}

/** Ticker shown on the per-chain price badges. */
export const CHAIN_SYMBOL: Record<ChainId, string> = {
  blockle: 'BLOCK',
  ethereum: 'ETH',
  solana: 'SOL'
}

/** "0.4 BLOCK" / "0.0001 ETH" — exact amount, no rounding games. */
export function fmtPrice(p: VendorPrice): string {
  return `${p.amount} ${CHAIN_SYMBOL[p.chain]}`
}

// ---------------------------------------------------------------------------
// Payment rails — every item is buyable in BLOCK, ETH, SOL or GOLD.
// ---------------------------------------------------------------------------

/** A way to pay a vendor: one of the three crypto chains, or GOLD (IAP). */
export type PayRail = ChainId | 'gold'

export interface RailPrice {
  rail: PayRail
  amount: number
}

/**
 * VENDOR-POSTED exchange rates — the shopkeepers' own board, chalked up and
 * stubbornly never updated. NOT a market feed, NOT an oracle, NOT financial
 * advice. 1 BLOCK = 0.00002 ETH = 0.0005 SOL = 20 GOLD.
 */
const BLOCK_TO: Record<PayRail, number> = {
  blockle: 1,
  ethereum: 0.00002,
  solana: 0.0005,
  gold: 20
}

/** Ticker shown on each rail's price badge. */
export const RAIL_SYMBOL: Record<PayRail, string> = {
  ...CHAIN_SYMBOL,
  gold: 'GOLD'
}

/** Round to `sig` significant decimal digits (prices are all < 10). */
const sigRound = (n: number, sig: number): number => Number(n.toPrecision(sig))

/**
 * All four prices for an entry, in fixed order [BLOCK, ETH, SOL, GOLD],
 * derived from the entry's anchor price via the posted rates. Rounding:
 * BLOCK/ETH 6 significant digits, SOL 4, GOLD whole coins (minimum 1 —
 * no vendor swings a door for zero gold).
 */
export function railPrices(e: StockEntry): RailPrice[] {
  const inBlock = e.price.amount / BLOCK_TO[e.price.chain]
  return [
    { rail: 'blockle', amount: sigRound(inBlock, 6) },
    { rail: 'ethereum', amount: sigRound(inBlock * BLOCK_TO.ethereum, 6) },
    { rail: 'solana', amount: sigRound(inBlock * BLOCK_TO.solana, 4) },
    { rail: 'gold', amount: Math.max(1, Math.round(inBlock * BLOCK_TO.gold)) }
  ]
}

/** "0.5 BLOCK" / "12 GOLD" — exact amount, no rounding games past the board. */
export function fmtRail(p: RailPrice): string {
  return `${p.amount} ${RAIL_SYMBOL[p.rail]}`
}

const block = (amount: number): VendorPrice => ({ chain: 'blockle', amount })

export const VENDOR_STOCK: Record<string, readonly StockEntry[]> = {
  merchant_hilda: [
    { id: 'food_apple', name: 'Apple', price: block(0.05), pitch: 'Keeps the doctor away. We don’t have a doctor.' },
    { id: 'food_bread', name: 'Bread Loaf', price: block(0.08), pitch: 'Day-old. The day in question is classified.' },
    { id: 'potion_health', name: 'Health Potion', price: block(0.2), pitch: 'Red means healthy. That’s just science.' },
    { id: 'potion_mana', name: 'Mana Potion', price: block(0.2), pitch: 'Tastes blue. You’ll understand.' },
    { id: 'rod_basic', name: 'Fishing Rod', price: block(0.35), pitch: 'Fish not included. That’s the whole premise.' },
    { id: 'sword_copper', name: 'Copper Sword', price: block(0.5), pitch: 'Entry-level stabbing. Everyone starts somewhere.' },
    { id: 'shield_copper', name: 'Copper Shield', price: block(0.45), pitch: 'Hide behind your problems, professionally.' }
  ],
  herbalist_moss: [
    { id: 'herb_green', name: 'Green Herb', price: block(0.06), pitch: 'It’s green. It’s an herb. I never oversell.' },
    { id: 'potion_health', name: 'Health Potion', price: block(0.18), pitch: 'Locally brewed. Lovingly unregulated.' },
    { id: 'potion_mana', name: 'Mana Potion', price: block(0.18), pitch: 'Side effects include wizardry.' },
    { id: 'elixir_focus', name: 'Focus Elixir', price: block(0.3), pitch: 'Like sleep, but you can skip the sleep part.' },
    { id: 'food_mushroom', name: 'Forest Mushroom', price: block(0.1), pitch: 'Edible! (Confidence: medium.)' }
  ],
  prospector_finn: [
    { id: 'pick_copper', name: 'Copper Pickaxe', price: block(0.4), pitch: 'Swing at rocks, not coworkers.' },
    { id: 'hatchet_copper', name: 'Copper Hatchet', price: block(0.4), pitch: 'The trees started it.' },
    { id: 'pick_iron', name: 'Iron Pickaxe', price: block(1.2), pitch: 'For when the mountain stops respecting copper.' },
    { id: 'ore_copper', name: 'Copper Ore', price: block(0.12), pitch: 'Skip the mining, keep the glory.' },
    { id: 'ore_iron', name: 'Iron Ore', price: block(0.3), pitch: 'Pre-mined by someone with worse knees than you.' },
    { id: 'food_jerky', name: 'Mine Jerky', price: block(0.08), pitch: 'Of what? Don’t worry about it.' }
  ],
  banker_aldous: [
    { id: 'ring_gold', name: 'Gold Ring', price: { chain: 'ethereum', amount: 0.0001 }, pitch: 'Priced in ETH. Prestige has a gas fee.' },
    { id: 'amulet_gold', name: 'Gold Amulet', price: block(1.8), pitch: 'Heavy enough to count as exercise.' },
    { id: 'charm_crystal', name: 'Crystal Charm', price: { chain: 'solana', amount: 0.005 }, pitch: 'Priced in SOL. Probably magic. Definitely marked up.' },
    { id: 'potion_health', name: 'Health Potion', price: block(0.25), pitch: 'Capital pricing. The potion is the same.' },
    { id: 'food_cake', name: 'Tiny Expensive Cake', price: block(2), pitch: 'Let yourself eat cake. Expensively.' }
  ]
}
