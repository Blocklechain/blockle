/**
 * Content pack registry — the plug-in point for bulk world content (towns,
 * NPCs, quests, recipes) generated as self-contained modules under
 * src/content/. Each pack file calls `registerPack({...})` at import time; the
 * read-sites (npcs, quests, crafting, world build) merge these EXTRA_* arrays
 * with the hand-authored base content.
 *
 * IMPORTANT: `src/content/index.ts` (which imports every pack) is imported as
 * the FIRST statement in main.ts, so every pack has registered before any
 * consumer module evaluates. Packs reference ids as plain strings and import
 * only TYPES + `registerPack` — never catalog/mobs/quests at runtime — so there
 * are no import cycles and the registration order is deterministic.
 */
import type { NpcDef } from '../ids'
import type { QuestDef, ItemDef } from '../types'
import type { Recipe } from '../crafting/recipes'
import type { Ctx } from '../world/layout'

export interface ContentPack {
  /** New catalog items (consumables/materials/gear) this pack introduces.
   *  food_* / potion_* / herb_* / fish_* ids render via their mesh family;
   *  anything else falls back to a generic crate mesh. */
  items?: ItemDef[]
  /** Quest-giver / vendor / trainer / flavor NPCs to place. */
  npcs?: NpcDef[]
  /** Quest definitions (givers must resolve to a real or pack NPC id). */
  quests?: QuestDef[]
  /** Quest prerequisite chains: questId -> prerequisite questIds. */
  prereqs?: Record<string, readonly string[]>
  /** Display names for any reward/collect item ids not already in the catalog. */
  itemNames?: Record<string, string>
  /** Crafting recipes (all inputs/outputs must be real catalog item ids). */
  recipes?: Recipe[]
  /** Optional world-build hook: place a town's buildings/props for a region. */
  town?: (ctx: Ctx) => void
}

export const EXTRA_ITEMS: ItemDef[] = []
export const EXTRA_NPCS: NpcDef[] = []
export const EXTRA_QUESTS: QuestDef[] = []
export const EXTRA_PREREQS: Record<string, readonly string[]> = {}
export const EXTRA_ITEM_NAMES: Record<string, string> = {}
export const EXTRA_RECIPES: Recipe[] = []
export const TOWN_BUILDERS: ((ctx: Ctx) => void)[] = []

const seenNpc = new Set<string>()
const seenQuest = new Set<string>()

/** Register one content pack. Duplicate NPC/quest ids are skipped defensively. */
const seenItem = new Set<string>()

export function registerPack(p: ContentPack): void {
  for (const it of p.items ?? []) {
    if (seenItem.has(it.id)) continue
    seenItem.add(it.id)
    EXTRA_ITEMS.push(it)
  }
  for (const n of p.npcs ?? []) {
    if (seenNpc.has(n.id)) continue
    seenNpc.add(n.id)
    EXTRA_NPCS.push(n)
  }
  for (const q of p.quests ?? []) {
    if (seenQuest.has(q.id)) continue
    seenQuest.add(q.id)
    EXTRA_QUESTS.push(q)
  }
  if (p.prereqs) Object.assign(EXTRA_PREREQS, p.prereqs)
  if (p.itemNames) Object.assign(EXTRA_ITEM_NAMES, p.itemNames)
  if (p.recipes) EXTRA_RECIPES.push(...p.recipes)
  if (p.town) TOWN_BUILDERS.push(p.town)
}
