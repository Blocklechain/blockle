/**
 * Loot tables — per-species weighted material/food drops + a rarer
 * equipment roll whose material tier follows the mob's tier (bosses get
 * guaranteed rolls, tier bumps, and a shot at crystal/mythic gear).
 *
 * All ids follow the items catalog conventions from src/ids.ts.
 */

import { MOUNT_IDS } from '../items/catalog'
import { EXTRA_LOOT } from '../content/mobpacks'
import { itemsApi } from '../items'

export interface LootRoll {
  id: string
  qty: number
}

/** ULTRA-RARE: 1 / 8000 off ANY kill drops a random mount. Gated to level >= 5
 *  so the very first trash mobs can't hand one over. */
const MOUNT_DROP_ODDS = 1 / 8000
const MOUNT_MIN_LEVEL = 5

/**
 * Rarity-gated "treasure" drops. Rare+ (rarity >= 2) loot now REQUIRES a mob of
 * sufficient level, so Epic/Legendary/Mythical gear can only fall from monsters
 * that earned it — never a level-1 slime. The rarity a kill is even eligible for
 * is capped by its level, and within that cap the roll is biased hard toward the
 * low end (Epic+ are a small slice of an already-uncommon event).
 *
 *   Rarity ladder (index == material tier):
 *     0 Common 1 Uncommon 2 Rare 3 Epic 4 Legendary 5 Mythical
 *     6 Ancient 7 Relic 8 Divine 9 Cosmic 10 Transcendent 11 Eternal
 *   Each unlocks at TIER_UNLOCK[tier], so Eternal (runic) gear only falls from
 *   level-999 monsters.
 */
function rareTierCap(level: number): number {
  const t = tierForLevel(level)
  return t >= 2 ? t : -1 // rare-tier treasure needs at least the Rare (steel, L10) tier
}

/** Special (non-gear) treasures per rarity band, layered on top of banded gear. */
const RARE_SPECIALS: Record<number, readonly string[]> = {
  2: ['crystal_shard', 'potion_hp_large', 'potion_mp_large'],
  3: ['crystal_raw', 'acc_lucky_rock', 'potion_hp_huge'],
  4: ['crystal_cut', 'amulet_block', 'amulet_debt'],
  5: ['potion_elixir', 'crystal_cut']
}

/** [itemId, weight, maxQty?] — 'nothing' rows keep kills from raining items. */
type Row = readonly [string, number, number?]

const TABLES: Record<string, readonly Row[]> = {
  slime: [['food_jelly', 38, 2], ['herb_green', 20], ['potion_regret', 6], ['nothing', 36]],
  mushroom: [['herb_green', 24, 2], ['herb_red', 14], ['food_burnt', 8], ['nothing', 54]],
  crab: [['fish_raw', 24], ['ore_copper', 16, 2], ['food_skewer', 10], ['nothing', 50]],
  wolf: [['hide_wolf', 42, 2], ['food_jerky', 15], ['nothing', 43]],
  goblin: [['ore_copper', 14, 2], ['food_skewer', 12], ['potion_hp_small', 10], ['bar_copper', 8], ['nothing', 56]],
  bat: [['herb_blue', 22], ['potion_mp_small', 12], ['nothing', 66]],
  spider: [['hide_tough', 20], ['herb_red', 14], ['nothing', 66]],
  bandit: [['bar_iron', 15], ['potion_hp_med', 12], ['food_pie', 10], ['acc_lucky_rock', 4], ['nothing', 59]],
  skeleton: [['bar_iron', 16], ['herb_blue', 12], ['potion_mp_med', 8], ['nothing', 64]],
  imp: [['herb_red', 18], ['crystal_shard', 10], ['potion_hp_med', 10], ['nothing', 62]],
  golem: [['ore_iron', 24, 2], ['ore_gold', 12], ['bar_steel', 8], ['crystal_raw', 5], ['nothing', 51]],
  orc: [['food_kebab', 20], ['hide_boar', 16, 2], ['bar_steel', 10], ['potion_hp_large', 8], ['nothing', 46]],
  wisp: [['crystal_shard', 18], ['herb_gold', 14], ['potion_mp_large', 8], ['crystal_cut', 4], ['nothing', 56]],
}

const EQUIP_KINDS = ['sword', 'axe', 'staff', 'bow', 'shield', 'helm', 'chest', 'boots'] as const
// Full 12-material ladder — index == rarity. Mirrors ids.ts MATERIALS + the
// catalog's TIER_LEVEL so dropped gear exists all the way to level 999.
const MATERIALS = [
  'copper', 'iron', 'steel', 'gold', 'crystal', 'mythic',
  'obsidian', 'dragonbone', 'void', 'astral', 'titan', 'runic'
] as const
/** Level at which each material/rarity tier unlocks (keep in sync with catalog TIER_LEVEL). */
const TIER_UNLOCK = [1, 5, 10, 20, 30, 40, 80, 150, 260, 420, 640, 999] as const
/** Highest material/rarity tier (0..11) a mob of this level may ever drop. */
function tierForLevel(level: number): number {
  let t = 0
  for (let i = 0; i < TIER_UNLOCK.length; i++) if (level >= TIER_UNLOCK[i]!) t = i
  return t
}

const BOSS_TREATS = ['food_cake', 'food_feast', 'potion_elixir', 'amulet_debt', 'amulet_block'] as const

function pickWeighted(rows: readonly Row[], rng: () => number): Row | null {
  let total = 0
  for (const r of rows) total += r[1]
  if (total <= 0) return null
  let roll = rng() * total
  for (const r of rows) {
    roll -= r[1]
    if (roll <= 0) return r
  }
  return rows[rows.length - 1] ?? null
}

function tableRoll(species: string, rng: () => number): LootRoll | null {
  // Base rows ++ any mobpack-registered extras for this species.
  const base = TABLES[species]
  const extra = EXTRA_LOOT[species]
  const rows: readonly Row[] | undefined =
    base && extra ? [...base, ...extra] : base ?? extra
  if (!rows || rows.length === 0) return null
  const row = pickWeighted(rows, rng)
  if (!row || row[0] === 'nothing') return null
  const maxQty = row[2] ?? 1
  return { id: row[0], qty: 1 + Math.floor(rng() * maxQty) }
}

/** Highest material index (=rarity) a mob of this level may ever drop. Gating by
 *  LEVEL (not just species tier) is what stops a low-level mob — even one with a
 *  high species tier — from handing out Epic/Legendary/Mythical gear. */
function matCapForLevel(level: number): number {
  return tierForLevel(level) // 0..11, gated by TIER_UNLOCK
}

/** Equipment drop: material tier follows mob tier, bosses punch above it — but
 *  the final rarity is hard-capped by the mob's LEVEL. */
function equipRoll(tier: number, level: number, boss: boolean, rng: () => number): LootRoll | null {
  const chance = boss ? 0.9 : 0.022 + tier * 0.007
  if (rng() >= chance) return null
  const kind = EQUIP_KINDS[Math.floor(rng() * EQUIP_KINDS.length)] ?? 'sword'
  // tier -> material index: t1 copper, t2 iron, t3 steel/gold, t4 gold/crystal
  let matIdx: number
  if (tier <= 1) matIdx = 0
  else if (tier === 2) matIdx = 1
  else if (tier === 3) matIdx = rng() < 0.7 ? 2 : 3
  else matIdx = rng() < 0.6 ? 3 : 4
  if (boss) {
    if (rng() < 0.3) matIdx += 1 // bump
    if (tier >= 4 && rng() < 0.05) matIdx = 5 // Warchief's mythic jackpot
  }
  // Level gate: a mob can never drop gear rarer than its level warrants.
  matIdx = Math.max(0, Math.min(MATERIALS.length - 1, matIdx, matCapForLevel(level)))
  return { id: `${kind}_${MATERIALS[matIdx]}`, qty: 1 }
}

/**
 * Rare-tier "treasure" drop — the ONLY source of Epic+ gear off a normal kill,
 * and only from mobs high enough level to deserve it. Uncommon by design; Epic,
 * Legendary and Mythical are progressively rarer sub-rolls on top of that.
 */
function rareDropRoll(level: number, boss: boolean, rng: () => number): LootRoll | null {
  const cap = rareTierCap(level)
  if (cap < 2) return null
  // Per-kill eligibility: SCARCE, grows slowly with level, big boss multiplier.
  // Non-boss tops out ~1/250 at the highest levels; a Rare-tier event at all is
  // meant to be a pleasant surprise, Epic+ a genuine occasion.
  let chance = (boss ? 0.02 : 0.00055) + level * (boss ? 0.00022 : 0.0000075)
  chance = Math.min(chance, boss ? 0.11 : 0.004)
  if (rng() >= chance) return null
  // Pick a rarity within [2..cap], biased HARD toward the low end via a geometric
  // walk: each step up costs another roll, so every tier is far rarer than the
  // last (Eternal gear is astronomically scarce even from a level-999 mob).
  let rarity = 2
  const stepUp = boss ? 0.42 : 0.3
  while (rarity < cap && rng() < stepUp) rarity++
  // 70% a gear piece at that rarity, 30% a themed special.
  if (rng() < 0.7) {
    const kind = EQUIP_KINDS[Math.floor(rng() * EQUIP_KINDS.length)] ?? 'sword'
    const mat = MATERIALS[rarity] ?? 'steel'
    return { id: `${kind}_${mat}`, qty: 1 }
  }
  // Endgame bands (6..11) have no special pool of their own — fall back to the
  // top defined band so they always yield the material gear or a Mythic-grade treat.
  const specials = RARE_SPECIALS[rarity] ?? RARE_SPECIALS[5] ?? RARE_SPECIALS[2]!
  const id = specials[Math.floor(rng() * specials.length)]
  return id ? { id, qty: 1 } : null
}

// ---------------------------------------------------------------------------
// Catch-all "miscellany" drop — guarantees EVERY catalog item is obtainable.
// The tables + the 8-kind equip ladder + specials + mounts + boss treats cover
// most items, but tools (pick/hatchet/rod), rings & capes & most amulets, the
// higher-tier raws/bars/hides, and every content-pack item had NO drop path.
// This pool is exactly those orphans, bucketed by rarity, surfaced by a scarce
// level-gated roll so they fall only from mobs that deserve them. Mounts keep
// their dedicated 1/8000 channel and are excluded here. Built lazily (after the
// content packs have registered their EXTRA_ITEMS).
// ---------------------------------------------------------------------------
let FALLBACK_BY_TIER: string[][] | null = null
function buildFallbackPool(): string[][] {
  const covered = coveredItemIds() // mounts included → their 1/8000 channel stays exclusive
  const buckets: string[][] = Array.from({ length: MATERIALS.length }, () => [])
  for (const d of itemsApi.all()) {
    if (covered.has(d.id)) continue
    const tier = Math.max(0, Math.min(MATERIALS.length - 1, d.rarity))
    buckets[tier]!.push(d.id)
  }
  return buckets
}

/** The already-covered set: every item reachable through a dedicated channel
 *  (species tables, the equip ladder, rare specials, boss treats, mounts). */
function coveredItemIds(): Set<string> {
  const covered = new Set<string>()
  const addRows = (rows: readonly Row[]): void => {
    for (const r of rows) if (r[0] !== 'nothing') covered.add(r[0])
  }
  for (const rows of Object.values(TABLES)) addRows(rows)
  for (const rows of Object.values(EXTRA_LOOT)) addRows(rows)
  for (const k of EQUIP_KINDS) for (const m of MATERIALS) covered.add(`${k}_${m}`)
  for (const list of Object.values(RARE_SPECIALS)) for (const id of list) covered.add(id)
  for (const id of BOSS_TREATS) covered.add(id)
  for (const id of MOUNT_IDS) covered.add(id)
  return covered
}

/** Dev/CI self-audit: proves every catalog item is obtainable from a kill —
 *  either through a dedicated channel or the catch-all fallback. `unreachable`
 *  must always be empty. */
export function auditLootCoverage(): {
  total: number
  viaChannel: number
  viaFallback: number
  unreachable: string[]
} {
  const covered = coveredItemIds()
  const inFallback = new Set<string>()
  for (const b of buildFallbackPool()) for (const id of b) inFallback.add(id)
  const all = itemsApi.all()
  const unreachable = all
    .filter((d) => !covered.has(d.id) && !inFallback.has(d.id))
    .map((d) => d.id)
  return { total: all.length, viaChannel: covered.size, viaFallback: inFallback.size, unreachable }
}

/** Scarce catch-all: a level-appropriate orphan item (tool, trinket, raw, pack
 *  gear, …). Rarity is capped by the mob's level exactly like gear, so a slime
 *  can only ever cough up a copper pick, never an eternal cape. */
function fallbackRoll(level: number, boss: boolean, rng: () => number): LootRoll | null {
  if (rng() >= (boss ? 0.03 : 0.0033)) return null
  if (!FALLBACK_BY_TIER) FALLBACK_BY_TIER = buildFallbackPool()
  const cap = matCapForLevel(level)
  const pool: string[] = []
  for (let t = 0; t <= cap; t++) {
    const bucket = FALLBACK_BY_TIER[t]
    if (bucket) pool.push(...bucket)
  }
  if (!pool.length) return null
  const id = pool[Math.floor(rng() * pool.length)]
  return id ? { id, qty: 1 } : null
}

/**
 * Roll a kill's drops. Regular mobs: one table roll + a slim equipment
 * chance. Bosses: three table rolls, a near-guaranteed equipment piece,
 * and a royal treat on top.
 */
export function rollLoot(
  species: string,
  tier: number,
  level: number,
  boss: boolean,
  rng: () => number
): LootRoll[] {
  const out: LootRoll[] = []
  const tableRolls = boss ? 3 : 1
  for (let i = 0; i < tableRolls; i++) {
    const r = tableRoll(species, rng)
    if (r) out.push(r)
  }
  const eq = equipRoll(tier, level, boss, rng)
  if (eq) out.push(eq)
  if (boss) {
    const treat = BOSS_TREATS[Math.floor(rng() * BOSS_TREATS.length)]
    if (treat) out.push({ id: treat, qty: 1 })
  }

  // ULTRA-RARE tier. The 1/8000 mount is the headline chase drop (level-gated so
  // the first mobs can't hand one over; bosses get a 3x shot). Otherwise a
  // level-gated rare-treasure roll — the ONLY off-kill source of Epic+ gear.
  const mountOdds = boss ? MOUNT_DROP_ODDS * 3 : MOUNT_DROP_ODDS
  if (level >= MOUNT_MIN_LEVEL && rng() < mountOdds) {
    const m = MOUNT_IDS[Math.floor(rng() * MOUNT_IDS.length)]
    if (m) out.push({ id: m, qty: 1 })
  } else {
    const treasure = rareDropRoll(level, boss, rng)
    if (treasure) out.push(treasure)
  }

  // Catch-all so nothing in the catalog is unobtainable (tools, trinkets, raws,
  // content-pack gear, …). Independent, scarce, and level-capped like gear.
  const misc = fallbackRoll(level, boss, rng)
  if (misc) out.push(misc)
  return out
}
