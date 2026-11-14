/**
 * Upgrading — static tables: the material sinks, the success ladder, and the
 * enchant pool. Pure data + pure functions (no state, no DOM, no events).
 *
 * MATERIAL LAW: every mat referenced here is a REAL, obtainable item id —
 * bars (forge), crystals (mined/cut), and the glimmering gold herb — so the
 * sinks are never dead ends. No new "raid token" catalog ids are invented;
 * crystal_shard / crystal_cut ARE the deep-end mats (rare mob drops + cut at
 * the forge). This keeps the ECONOMY LAW intact: items in, items out, never
 * an earnable soft currency.
 */

/** The five combat/utility stats, matching InventoryAPI.equippedStats(). */
export type Stats = { atk: number; def: number; str: number; int: number; agi: number }
export const STAT_KEYS = ['atk', 'def', 'str', 'int', 'agi'] as const
export const STAT_LABEL: Record<keyof Stats, string> = {
  atk: 'ATK', def: 'DEF', str: 'STR', int: 'INT', agi: 'AGI'
}

export interface MatCost { id: string; qty: number }

/** Hard ceiling on the upgrade track. */
export const MAX_PLUS = 10
/** Each +level adds this fraction of the item's (reforged) base stats. */
export const PLUS_STEP = 0.05 // +10 == +50% of base, rounded per stat
/** How many enchant slots a single piece can hold. */
export const MAX_ENCHANT_SLOTS = 2
/** At/above this +level the forge can FAIL (never destroys — see rules). */
export const RISK_FROM = 7

/** Rarity 0..5 clamp. */
function rr(r: number): number {
  return Math.max(0, Math.min(5, Math.floor(r)))
}

/**
 * Materials consumed to reach `toPlus` (1..10) on a piece of `rarity`.
 * Low +: cheap bars. Mid +: steel + raw crystal. High +: the deep shards.
 * +10: the Ascension tax — cut crystal + a fistful of shards.
 */
export function upgradeCost(toPlus: number, rarity: number): MatCost[] {
  const r = rr(rarity)
  const scale = 1 + Math.floor(r / 2) // 1 (common/uncommon) .. 3 (legendary/mythic)
  if (toPlus <= 3) {
    return [
      { id: 'bar_copper', qty: (1 + toPlus) * scale },
      { id: 'bar_iron', qty: toPlus * scale }
    ]
  }
  if (toPlus <= 6) {
    return [
      { id: 'bar_steel', qty: (toPlus - 2) * scale },
      { id: 'crystal_raw', qty: (toPlus - 3) * scale }
    ]
  }
  if (toPlus <= 9) {
    return [
      { id: 'crystal_shard', qty: (toPlus - 6) * scale },
      { id: 'bar_steel', qty: (toPlus - 4) * scale }
    ]
  }
  // +10
  return [
    { id: 'crystal_cut', qty: 2 * scale },
    { id: 'crystal_shard', qty: 3 * scale }
  ]
}

/**
 * Chance (0..1) that upgrading TO `toPlus` succeeds. 100% up to +6; from +7
 * on it ladders down, softened by Blacksmithing level (up to +20% at Lv50),
 * capped at 98% so the dice are always at the table. A failure never breaks
 * the item or drops its +level — it just eats part of the mats (see rules).
 */
export function successChance(toPlus: number, smithLevel: number): number {
  const base =
    toPlus <= 6 ? 1
      : toPlus === 7 ? 0.9
        : toPlus === 8 ? 0.8
          : toPlus === 9 ? 0.65
            : 0.5
  if (base >= 1) return 1
  const bonus = Math.min(0.2, Math.max(0, smithLevel) * 0.004)
  return Math.min(0.98, base + bonus)
}

/** Mats consumed to etch an enchant into slot `slot` (0 = first, 1 = second). */
export function enchantCost(slot: number, rarity: number): MatCost[] {
  const r = rr(rarity)
  if (slot <= 0) {
    return [
      { id: 'crystal_shard', qty: 1 + r },
      { id: 'herb_gold', qty: 2 + r }
    ]
  }
  // the second socket always costs more — and one cut crystal to seat it
  return [
    { id: 'crystal_shard', qty: 2 + r },
    { id: 'herb_gold', qty: 3 + r },
    { id: 'crystal_cut', qty: 1 }
  ]
}

/** Mats consumed to reroll an item's stat spread. */
export function reforgeCost(rarity: number): MatCost[] {
  const r = rr(rarity)
  return [
    { id: 'bar_steel', qty: 2 + r },
    { id: 'crystal_raw', qty: 1 + r }
  ]
}

// ---------------------------------------------------------------------------
// Enchant pool — comedy names, HONEST effects.
//
// Every enchant grants REAL stats the combat + pet engines already read
// (atk/def/str/int/agi). The fantasy names are flavor; the tooltip shows the
// true +stat so nothing is faked. (lifesteal/thorns/elemental are costume for
// sustain/retaliation/burst expressed in the stat the engine honors.)
// ---------------------------------------------------------------------------

export interface EnchantDef {
  id: string
  name: string
  /** One-line comedy blurb. */
  blurb: string
  /** Real stat grant at item `rarity` (0..5). */
  grant: (rarity: number) => Partial<Stats>
}

/** Base grant magnitude: common +2 … mythical +7. */
function g(rarity: number): number {
  return 2 + rr(rarity)
}

export const ENCHANTS: readonly EnchantDef[] = [
  {
    id: 'bear',
    name: 'of the Bear',
    blurb: 'Big arms. Bigger opinions about doors. +STR.',
    grant: (r) => ({ str: g(r) })
  },
  {
    id: 'fox',
    name: 'of the Fox',
    blurb: 'Sharper eyes, luckier hits, zero remorse. +AGI.',
    grant: (r) => ({ agi: g(r) })
  },
  {
    id: 'owl',
    name: 'of the Owl',
    blurb: 'Smug about things it cannot explain. +INT.',
    grant: (r) => ({ int: g(r) })
  },
  {
    id: 'boar',
    name: 'of the Boar (Thorns)',
    blurb: 'Hitting you is its own punishment. +DEF.',
    grant: (r) => ({ def: g(r) })
  },
  {
    id: 'tiger',
    name: 'of the Tiger (Flame)',
    blurb: 'Every swing arrives slightly on fire. +ATK.',
    grant: (r) => ({ atk: g(r) })
  },
  {
    id: 'haste',
    name: 'of Haste',
    blurb: 'Does everything 20% too soon. +AGI, +ATK.',
    grant: (r) => ({ agi: Math.ceil(g(r) * 0.6), atk: Math.ceil(g(r) * 0.4) })
  },
  {
    id: 'vampiric',
    name: 'Vampiric (Lifesteal)',
    blurb: 'Hits harder so it hurts longer — for them. +ATK, +STR.',
    grant: (r) => ({ atk: Math.ceil(g(r) * 0.5), str: Math.ceil(g(r) * 0.5) })
  }
]

export function enchantDef(id: string): EnchantDef | undefined {
  return ENCHANTS.find((e) => e.id === id)
}

/** An enchant's tint for the item's glow aura. */
export const ENCHANT_GLOW: Record<string, string> = {
  bear: '#c58b4a',
  fox: '#e8c15a',
  owl: '#6cb8ff',
  boar: '#7ed957',
  tiger: '#ff6a2a',
  haste: '#9fe8ff',
  vampiric: '#ff5c8a'
}
