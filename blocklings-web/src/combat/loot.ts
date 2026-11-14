/**
 * Loot tables — per-species weighted material/food drops + a rarer
 * equipment roll whose material tier follows the mob's tier (bosses get
 * guaranteed rolls, tier bumps, and a shot at crystal/mythic gear).
 *
 * All ids follow the items catalog conventions from src/ids.ts.
 */

export interface LootRoll {
  id: string
  qty: number
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
const MATERIALS = ['copper', 'iron', 'steel', 'gold', 'crystal', 'mythic'] as const

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
  const rows = TABLES[species]
  if (!rows) return null
  const row = pickWeighted(rows, rng)
  if (!row || row[0] === 'nothing') return null
  const maxQty = row[2] ?? 1
  return { id: row[0], qty: 1 + Math.floor(rng() * maxQty) }
}

/** Equipment drop: material tier follows mob tier, bosses punch above it. */
function equipRoll(tier: number, boss: boolean, rng: () => number): LootRoll | null {
  const chance = boss ? 0.95 : 0.04 + tier * 0.012
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
  matIdx = Math.max(0, Math.min(MATERIALS.length - 1, matIdx))
  return { id: `${kind}_${MATERIALS[matIdx]}`, qty: 1 }
}

/**
 * Roll a kill's drops. Regular mobs: one table roll + a slim equipment
 * chance. Bosses: three table rolls, a near-guaranteed equipment piece,
 * and a royal treat on top.
 */
export function rollLoot(
  species: string,
  tier: number,
  boss: boolean,
  rng: () => number
): LootRoll[] {
  const out: LootRoll[] = []
  const tableRolls = boss ? 3 : 1
  for (let i = 0; i < tableRolls; i++) {
    const r = tableRoll(species, rng)
    if (r) out.push(r)
  }
  const eq = equipRoll(tier, boss, rng)
  if (eq) out.push(eq)
  if (boss) {
    const treat = BOSS_TREATS[Math.floor(rng() * BOSS_TREATS.length)]
    if (treat) out.push({ id: treat, qty: 1 })
  }
  return out
}
