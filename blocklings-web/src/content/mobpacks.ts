/**
 * MOB content-pack registry — the plug-in point for bulk monster + pet content
 * (new SPECIES, their PET variants, spawn-table entries and loot rows) authored
 * as self-contained modules under src/content/. Each `mobpack_*.ts` file calls
 * `registerMobPack({...})` at import time; the read-sites merge these EXTRA_*
 * collections with the hand-authored base content:
 *
 *   - src/ids.ts            SPECIES = [...BASE, ...EXTRA_SPECIES]
 *                           PET_VARIANTS = [...BASE, ...EXTRA_PETS]
 *   - src/combat/index.ts   pickSpecies merges EXTRA_REGION_SPAWNS/EXTRA_BIOME_SPAWNS
 *   - src/combat/loot.ts    tableRoll merges EXTRA_LOOT[species]
 *
 * ORDERING (crucial): SPECIES is snapshotted ONCE at ids.ts eval, and many
 * modules build `new Map(SPECIES.map(...))` at their own eval. So every mobpack
 * MUST register BEFORE ids.ts builds SPECIES. That is guaranteed because ids.ts
 * side-effect-imports './content/mobpacks_all' (which imports every pack) at the
 * TOP of the file — ES import hoisting runs all pack registrations before the
 * SPECIES const is evaluated. mobpacks_all is ALSO imported from
 * src/content/index.ts (main.ts's first import) so the registration happens
 * exactly once either way.
 *
 * NO IMPORT CYCLES: this file and every mobpack import only TYPES from ../ids /
 * ../types (erased at runtime) plus `registerMobPack` here — never SPECIES,
 * mobs, loot or any value from ids at runtime.
 */
import type { SpeciesDef } from '../ids'
import type { PetDef } from '../types'

/** Loot table row: [itemId, weight, maxQty?]. Matches src/combat/loot.ts. */
export type Row = readonly [string, number, number?]
/** Weighted spawn entry: [speciesId, weight]. Matches the combat spawn mixes. */
export type SpawnEntry = readonly [string, number]

export interface MobPack {
  /** New monster species. Meshes auto-generate from `shape` (no mesh code). */
  species?: SpeciesDef[]
  /** Pet variants for any species (base/new). Mesh = species rig recolored. */
  pets?: PetDef[]
  /** region-id -> extra weighted species entries (appended to REGION_MIX). */
  regionSpawns?: Record<string, SpawnEntry[]>
  /** biome -> extra weighted species entries (appended to BIOME_MIX). */
  biomeSpawns?: Record<string, SpawnEntry[]>
  /** species-id -> extra loot rows (appended to that species' TABLES rows). */
  loot?: Record<string, Row[]>
}

export const EXTRA_SPECIES: SpeciesDef[] = []
export const EXTRA_PETS: PetDef[] = []
export const EXTRA_REGION_SPAWNS: Record<string, SpawnEntry[]> = {}
export const EXTRA_BIOME_SPAWNS: Record<string, SpawnEntry[]> = {}
export const EXTRA_LOOT: Record<string, Row[]> = {}

const seenSpecies = new Set<string>()
const seenPet = new Set<string>()

/** Append weight-lists keyed by string, creating the key's array on demand. */
function mergeSpawns(
  into: Record<string, SpawnEntry[]>,
  from: Record<string, SpawnEntry[]> | undefined
): void {
  if (!from) return
  for (const key of Object.keys(from)) {
    const rows = from[key]
    if (!rows) continue
    ;(into[key] ??= []).push(...rows)
  }
}

/**
 * Register one mob pack. Species are deduped by id, pets by `species+variant`;
 * spawn weight-lists are merged per key; loot rows are appended per species id.
 * Duplicate species/pets are skipped defensively so re-imports are harmless.
 */
export function registerMobPack(pack: MobPack): void {
  for (const sp of pack.species ?? []) {
    if (seenSpecies.has(sp.id)) continue
    seenSpecies.add(sp.id)
    EXTRA_SPECIES.push(sp)
  }
  for (const pet of pack.pets ?? []) {
    const key = `${pet.species}.${pet.variant}`
    if (seenPet.has(key)) continue
    seenPet.add(key)
    EXTRA_PETS.push(pet)
  }
  mergeSpawns(EXTRA_REGION_SPAWNS, pack.regionSpawns)
  mergeSpawns(EXTRA_BIOME_SPAWNS, pack.biomeSpawns)
  if (pack.loot) {
    for (const species of Object.keys(pack.loot)) {
      const rows = pack.loot[species]
      if (!rows) continue
      ;(EXTRA_LOOT[species] ??= []).push(...rows)
    }
  }
}
