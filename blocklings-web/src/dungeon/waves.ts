/**
 * Trial of the Deep — PURE difficulty + reward curves (no THREE, no DOM, no
 * side effects). The index module turns these numbers into real mobs, loot
 * grants and HUD text. Kept pure so the balance can be unit-reasoned.
 *
 * SCORE = waves cleared. Waves are ENDLESS and escalate forever; the only
 * thing that ends a run is death or fleeing. Every 5th wave is a mini-boss
 * wave, every 10th a full boss wave (boss supersedes mini on multiples of 10).
 */

/** One reward line (catalog item id + quantity) granted into the inventory. */
export interface RewardRoll {
  id: string
  qty: number
}

/** A difficulty tier, unlocked by your best clear on the tier below it. */
export interface TierDef {
  id: number
  name: string
  blurb: string
  /** Best waves required on tier (id-1) to unlock this one (0 = always open). */
  unlockBestPrev: number
  /** First time your best reaches this wave, the tier's cosmetic unlocks. */
  clearWave: number
  /** Mob level at wave 1. */
  mobLevelBase: number
  /** Added mob level per wave beyond the first. */
  mobLevelPerWave: number
  /** Hardest SpeciesDef.tier that may appear (species roster gate). */
  maxSpeciesTier: 1 | 2 | 3 | 4
  /** Multiplies mob attack (how hard getting hit hurts). */
  dmgMul: number
  /** Multiplies Deep Shard payouts. */
  shardMul: number
  /** Cosmetic title + cape id granted on first clear of this tier. */
  title: string
  capeId: string
}

export const TIERS: readonly TierDef[] = [
  {
    id: 0,
    name: 'The Shallow Deep',
    blurb: 'Damp, mildly haunted. A reasonable place to die for the first time.',
    unlockBestPrev: 0,
    clearWave: 10,
    mobLevelBase: 8,
    mobLevelPerWave: 0.7,
    maxSpeciesTier: 2,
    dmgMul: 1.0,
    shardMul: 1.0,
    title: 'Deepwalker',
    capeId: 'cape_deep_0'
  },
  {
    id: 1,
    name: 'The Long Dark',
    blurb: 'The torches gave up. So did the last three people who came here.',
    unlockBestPrev: 10,
    clearWave: 12,
    mobLevelBase: 18,
    mobLevelPerWave: 1.0,
    maxSpeciesTier: 3,
    dmgMul: 1.15,
    shardMul: 1.7,
    title: 'The Unlit',
    capeId: 'cape_deep_1'
  },
  {
    id: 2,
    name: 'The Screaming Depths',
    blurb: "It's not the screaming that gets you. It's the brief, hopeful silences.",
    unlockBestPrev: 12,
    clearWave: 15,
    mobLevelBase: 30,
    mobLevelPerWave: 1.4,
    maxSpeciesTier: 4,
    dmgMul: 1.32,
    shardMul: 2.6,
    title: 'Abyss-Touched',
    capeId: 'cape_deep_2'
  },
  {
    id: 3,
    name: 'The Maw',
    blurb: 'A difficulty setting shaped like a regret. Brings its own ambulance.',
    unlockBestPrev: 15,
    clearWave: 20,
    mobLevelBase: 46,
    mobLevelPerWave: 1.9,
    maxSpeciesTier: 4,
    dmgMul: 1.5,
    shardMul: 3.8,
    title: 'Maw-Marked',
    capeId: 'cape_deep_3'
  }
] as const

/** Hard cap on simultaneous wave mobs (keeps the arena readable + fast). */
export const WAVE_MOB_CAP = 16
/** Seconds of breather between waves. */
export const BREATHER_SECS = 10
/** Seconds before the very first wave drops in. */
export const INTRO_SECS = 3.5

export type WaveKind = 'normal' | 'mini' | 'boss'

export interface WavePlan {
  wave: number
  kind: WaveKind
  /** Total mobs this wave, INCLUDING the boss/mini if present. */
  count: number
  /** Level for the rank-and-file adds. */
  mobLevel: number
  /** Level for the boss/mini (0 when none). */
  champLevel: number
  /** Highest SpeciesDef.tier that may be rolled for picks. */
  speciesTierCap: number
}

/** What kind of wave number `wave` is (1-indexed). */
export function waveKind(wave: number): WaveKind {
  if (wave % 10 === 0) return 'boss'
  if (wave % 5 === 0) return 'mini'
  return 'normal'
}

/** The full composition of a given wave on a given tier. */
export function planWave(t: TierDef, wave: number): WavePlan {
  const kind = waveKind(wave)
  const mobLevel = Math.max(1, Math.round(t.mobLevelBase + (wave - 1) * t.mobLevelPerWave))
  const speciesTierCap = Math.min(t.maxSpeciesTier, 1 + Math.floor((wave - 1) / 4))

  let count: number
  let champLevel = 0
  if (kind === 'boss') {
    count = Math.min(WAVE_MOB_CAP, 2 + Math.floor(wave * 0.2)) // adds + the boss
    champLevel = mobLevel + 6
  } else if (kind === 'mini') {
    count = Math.min(WAVE_MOB_CAP, 3 + Math.floor(wave * 0.3))
    champLevel = mobLevel + 3
  } else {
    count = Math.min(WAVE_MOB_CAP, 3 + Math.floor((wave - 1) * 0.6))
  }
  return { wave, kind, count, mobLevel, champLevel, speciesTierCap }
}

/** Mob combat stats — mirrors the open-world combat formula, tier-scaled. */
export function mobStats(level: number, boss: boolean, dmgMul: number): { maxHp: number; atk: number } {
  const maxHp = Math.round((12 + level * 6) * (boss ? 5 : 1))
  const atk = (2 + level * 1.1) * (boss ? 1.5 : 1) * dmgMul
  return { maxHp, atk }
}

// ---------------------------------------------------------------------------
// Rewards — banked the instant a wave is cleared, so a death mid-wave keeps
// everything earned up to the last full wave.
// ---------------------------------------------------------------------------

const MAT_LADDER = ['copper', 'iron', 'steel', 'gold', 'crystal', 'mythic'] as const
const MAT_DROPS = ['ore_copper', 'ore_iron', 'bar_iron', 'bar_steel', 'ore_gold', 'crystal_raw', 'crystal_shard', 'crystal_cut']
const HP_POTIONS = ['potion_hp_small', 'potion_hp_med', 'potion_hp_large', 'potion_hp_huge']
const MP_POTIONS = ['potion_mp_small', 'potion_mp_med', 'potion_mp_large', 'potion_mp_huge']
const EQUIP_KINDS = ['sword', 'axe', 'staff', 'bow', 'shield', 'helm', 'chest', 'boots'] as const

function pick<T>(arr: readonly T[], rng: () => number, fallback: T): T {
  if (arr.length === 0) return fallback
  return arr[Math.floor(rng() * arr.length)] ?? fallback
}

function clampIdx(i: number, len: number): number {
  return Math.max(0, Math.min(len - 1, i))
}

/** Deep Shards + inventory items for clearing `plan` on tier `t`. */
export function waveRewards(t: TierDef, plan: WavePlan, rng: () => number): { shards: number; items: RewardRoll[] } {
  const w = plan.wave
  let shards = Math.round((1.5 + w * 0.6) * t.shardMul)
  const items: RewardRoll[] = []

  // tier-appropriate material index, nudged up as waves climb
  const matBase = Math.min(5, (t.maxSpeciesTier - 1) + Math.floor(w / 12))

  // a trickle of raw materials every wave
  items.push({ id: pick(MAT_DROPS, rng, 'ore_iron'), qty: 1 + Math.floor(rng() * 2) })

  // consumable now and then (keeps you alive deeper)
  if (rng() < 0.45) {
    const pots = rng() < 0.65 ? HP_POTIONS : MP_POTIONS
    items.push({ id: pots[clampIdx(1 + Math.floor(w / 8), pots.length)] ?? pots[0]!, qty: 1 })
  }

  if (plan.kind === 'mini') {
    shards += Math.round(6 * t.shardMul)
    if (rng() < 0.7) {
      const kind = pick(EQUIP_KINDS, rng, 'sword')
      const mat = MAT_LADDER[clampIdx(matBase, MAT_LADDER.length)]!
      items.push({ id: `${kind}_${mat}`, qty: 1 })
    }
  } else if (plan.kind === 'boss') {
    shards += Math.round(15 * t.shardMul)
    // guaranteed gear, one material tier above the grind
    const kind = pick(EQUIP_KINDS, rng, 'sword')
    const mat = MAT_LADDER[clampIdx(matBase + 1, MAT_LADDER.length)]!
    items.push({ id: `${kind}_${mat}`, qty: 1 })
    items.push({ id: pick(['food_cake', 'food_feast', 'potion_elixir'], rng, 'food_cake'), qty: 1 })
  }

  return { shards, items }
}

/** Is tier `id` unlocked given the per-tier personal bests? */
export function tierUnlocked(best: readonly number[], id: number): boolean {
  const t = TIERS[id]
  if (!t) return false
  if (t.unlockBestPrev <= 0) return true
  return (best[id - 1] ?? 0) >= t.unlockBestPrev
}
