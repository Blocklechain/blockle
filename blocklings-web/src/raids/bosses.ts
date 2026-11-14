/**
 * RAID BOSS ROSTER — the four apex world-boss fights, summoned at altars in
 * the far outer zones. Pure data: silhouette archetype, placement, tuning,
 * the mechanics each phase unlocks, and the loot table (guaranteed EPIC+,
 * a chance at a unique LEGENDARY, raid tokens, a royal treat, an ascended pet).
 *
 * MUSIC: `themeSong` reuses an existing registered boss theme id, so emitting
 * `mob:hit {boss:true, bossId: themeSong}` makes the music director swell the
 * right theme during the fight and release it on the kill — no new audio asset
 * and no fighting the director.
 *
 * ASCENDED PET: `petSpecies` is a species that owns a `.boss` baby in
 * PET_VARIANTS (src/ids.ts). On the kill we emit `mob:killed {species:
 * petSpecies, boss:true}`, so the pets module rolls that rare boss-baby — the
 * closest thing to an "ascended" variant the frozen PetVariant union allows
 * today (a true 'ascended' variant would need a PET_VARIANTS append; see the
 * reserved ids note at the bottom of this file).
 *
 * RESERVED ITEM IDS: the unique legendaries and the raid-token material are
 * NOT in src/items/catalog.ts (not ours to edit). They are granted by id now
 * (functional inventory stacks; fallback crate mesh + "unknown" name until the
 * items agent adds the defs) and are listed in RESERVED_ITEM_IDS below for
 * that agent to register. The guaranteed drops come from REAL crystal/mythic
 * catalog items, so every kill pays out usable EPIC+ gear immediately.
 */
import type { RaidArchetype } from './model'

export interface RaidPhaseDef {
  /** Enter this phase when the boss drops to/below this HP fraction. */
  at: number
  /** Patterns this phase cycles through (see src/raids/index.ts executor). */
  patterns: RaidPattern[]
  /** Seconds between pattern casts in this phase (shrinks as phases escalate). */
  castEvery: number
}

export type RaidPattern = 'slam' | 'rings' | 'adds' | 'breath'

export interface RaidLoot {
  /** Real catalog ids, rarity 4-5 — one guaranteed, more rolled on top. */
  epicPool: readonly string[]
  /** How many guaranteed epic pulls (before the bonus roll). */
  guaranteed: number
  /** Reserved unique legendary id (chance drop). */
  legendaryId: string
  legendaryName: string
  /** 0..1 chance the legendary drops. */
  legendaryChance: number
  /** Reserved raid-token material id (gear-upgrade currency material). */
  tokenId: string
  tokenQty: readonly [number, number]
  /** Real catalog royal consumable, always dropped. */
  treat: string
}

export interface RaidBossDef {
  id: string
  name: string
  title: string
  archetype: RaidArchetype
  level: number
  /** Zone the altar lives in (src/world/zones/registry.ts id). */
  zoneId: string
  /** Altar world position (summon point; boss spawns a few units off it). */
  altar: { x: number; z: number }
  /** Existing registered boss theme the director should play. */
  themeSong: string
  /** Species whose `.boss` baby drops on the kill (must own one). */
  petSpecies: string
  /** Visual palette. */
  color: number
  dark: number
  glow: number
  /** UI accent (CSS hex string). */
  tint: string
  // --- tuning ---
  baseHp: number
  baseAtk: number
  /** Soft-enrage kicks in after this many seconds; damage then ramps. */
  enrageSecs: number
  /** Cooldown between summons of THIS boss, ms (persisted). */
  cooldownMs: number
  phases: readonly RaidPhaseDef[]
  loot: RaidLoot
}

const TEN_MIN = 10 * 60 * 1000

export const RAID_BOSSES: readonly RaidBossDef[] = [
  {
    id: 'raid_frostwyrm',
    name: 'The Frostwyrm',
    title: 'Terror of the Nope Shelf',
    archetype: 'wyrm',
    level: 50,
    zoneId: 'nope_shelf',
    altar: { x: -662, z: -612 },
    themeSong: 'boss_greenwood', // feral beast theme fits a wyrm
    petSpecies: 'wolf', // → 'Beta Direpup' (boss baby)
    color: 0xbfe3f2,
    dark: 0x6fa8c7,
    glow: 0x7fd4ff,
    tint: '#7fd4ff',
    baseHp: 4200,
    baseAtk: 26,
    enrageSecs: 150,
    cooldownMs: TEN_MIN,
    phases: [
      { at: 1.0, patterns: ['slam', 'breath'], castEvery: 4.0 },
      { at: 0.66, patterns: ['slam', 'breath', 'rings'], castEvery: 3.4 },
      { at: 0.33, patterns: ['rings', 'breath', 'adds', 'slam'], castEvery: 2.8 }
    ],
    loot: {
      epicPool: ['staff_crystal', 'bow_crystal', 'helm_crystal', 'boots_crystal', 'shield_crystal'],
      guaranteed: 1,
      legendaryId: 'relic_frostfang',
      legendaryName: 'Frostfang, the Last Laugh',
      legendaryChance: 0.2,
      tokenId: 'raid_token',
      tokenQty: [3, 6],
      treat: 'potion_elixir'
    }
  },
  {
    id: 'raid_magma_colossus',
    name: 'The Magma Colossus',
    title: 'That Which Should Have Cooled',
    archetype: 'colossus',
    level: 65,
    zoneId: 'mount_tantrum',
    altar: { x: 542, z: 618 },
    themeSong: 'boss_ironhold', // stone march + anvil fits a colossus
    petSpecies: 'golem', // → 'Gravel Intern' (boss baby)
    color: 0x5a4a44,
    dark: 0x3a2f2d,
    glow: 0xff6a2a,
    tint: '#ff7a3a',
    baseHp: 6400,
    baseAtk: 34,
    enrageSecs: 165,
    cooldownMs: TEN_MIN,
    phases: [
      { at: 1.0, patterns: ['slam', 'rings'], castEvery: 3.8 },
      { at: 0.66, patterns: ['slam', 'rings', 'adds'], castEvery: 3.2 },
      { at: 0.33, patterns: ['rings', 'slam', 'adds', 'breath'], castEvery: 2.6 }
    ],
    loot: {
      epicPool: ['axe_crystal', 'chest_crystal', 'shield_crystal', 'sword_mythic', 'helm_crystal'],
      guaranteed: 1,
      legendaryId: 'relic_cinderwall',
      legendaryName: 'Cinderwall, the Load-Bearing Grudge',
      legendaryChance: 0.22,
      tokenId: 'raid_token',
      tokenQty: [4, 7],
      treat: 'food_feast'
    }
  },
  {
    id: 'raid_bone_tyrant',
    name: 'The Bone Tyrant',
    title: 'Chairman of the Bored',
    archetype: 'tyrant',
    level: 80,
    zoneId: 'pharaohs_folly',
    altar: { x: 162, z: 618 },
    themeSong: 'boss_ashen', // rattling bone waltz — perfect
    petSpecies: 'skeleton', // → 'Skeleton Prince (Unpaid)' (boss baby)
    color: 0xe8e2d2,
    dark: 0xb8ad94,
    glow: 0x35bfe8,
    tint: '#9fe4ff',
    baseHp: 9000,
    baseAtk: 44,
    enrageSecs: 180,
    cooldownMs: TEN_MIN,
    phases: [
      { at: 1.0, patterns: ['adds', 'slam'], castEvery: 3.6 },
      { at: 0.66, patterns: ['adds', 'slam', 'rings'], castEvery: 3.0 },
      { at: 0.33, patterns: ['rings', 'adds', 'breath', 'slam'], castEvery: 2.4 }
    ],
    loot: {
      epicPool: ['staff_mythic', 'helm_mythic', 'chest_crystal', 'bow_mythic', 'shield_mythic'],
      guaranteed: 2,
      legendaryId: 'relic_bonecaller',
      legendaryName: "Bonecaller, HR's Final Memo",
      legendaryChance: 0.24,
      tokenId: 'raid_token',
      tokenQty: [6, 10],
      treat: 'potion_elixir'
    }
  },
  {
    id: 'raid_grukk_eternal',
    name: 'Grukk the Eternal',
    title: 'Warchief of the Afterward',
    archetype: 'warlord',
    level: 99,
    zoneId: 'obsidian_strand',
    altar: { x: 662, z: 612 },
    themeSong: 'boss_forgotten', // war-chant stomp — Grukk's own theme family
    petSpecies: 'orc', // → "Grukk's Nephew Kevin" (boss baby)
    color: 0x4f7a45,
    dark: 0x2f4a2a,
    glow: 0x8fffa0,
    tint: '#8fffa0',
    baseHp: 14000,
    baseAtk: 58,
    enrageSecs: 210,
    cooldownMs: TEN_MIN,
    phases: [
      { at: 1.0, patterns: ['slam', 'breath'], castEvery: 3.4 },
      { at: 0.75, patterns: ['slam', 'breath', 'adds'], castEvery: 2.9 },
      { at: 0.5, patterns: ['rings', 'slam', 'adds', 'breath'], castEvery: 2.5 },
      { at: 0.25, patterns: ['rings', 'breath', 'adds', 'slam'], castEvery: 2.0 }
    ],
    loot: {
      epicPool: ['axe_mythic', 'sword_mythic', 'chest_mythic', 'helm_mythic', 'shield_mythic', 'boots_mythic'],
      guaranteed: 2,
      legendaryId: 'relic_eternal_cleaver',
      legendaryName: 'The Eternal Cleaver (Still Warm)',
      legendaryChance: 0.28,
      tokenId: 'raid_token',
      tokenQty: [8, 14],
      treat: 'food_feast'
    }
  }
] as const

export function raidBossById(id: string): RaidBossDef | undefined {
  return RAID_BOSSES.find((b) => b.id === id)
}

/**
 * Item ids referenced by raid loot that are NOT yet in src/items/catalog.ts —
 * for the items agent to register. Granting them already works as inventory
 * stacks; they get a real name + voxel mesh once added.
 *
 *  raid_token            material, rarity 4 — "Raid Token". Gear-upgrade sink
 *                        (the upgrading module's premium material). value ~500.
 *  relic_frostfang       weapon (sword), rarity 5, gripStyle 'forward'. Frost.
 *                        Unique drop: The Frostwyrm. Suggested special family:
 *                        a chilling 'lunge_nova' re-skin (ice).
 *  relic_cinderwall      shield, rarity 5, gripStyle 'shield'. Magma.
 *                        Unique drop: The Magma Colossus. 'bash_shockwave'.
 *  relic_bonecaller      weapon (staff), rarity 5, gripStyle 'upright'. Bone.
 *                        Unique drop: The Bone Tyrant. 'fireball_nova' re-skin.
 *  relic_eternal_cleaver weapon (axe), rarity 5, gripStyle 'forward'. Spectral.
 *                        Unique drop: Grukk the Eternal. 'whirlwind_nova'.
 */
export const RESERVED_ITEM_IDS = [
  'raid_token',
  'relic_frostfang',
  'relic_cinderwall',
  'relic_bonecaller',
  'relic_eternal_cleaver'
] as const
