/**
 * Items — ItemsAPI implementation (catalog lookup + mesh factory).
 */
import type * as THREE from 'three'
import type { ItemDef, ItemsAPI, Rarity } from '../types'
import { CATALOG } from './catalog'
import { buildItemMesh } from './mesh'
import { EXTRA_ITEMS } from '../content/packs'
import { MATERIALS } from '../ids'

// Gear whose id ends in a late-game material (obsidian..runic) should read as
// its own rarity (Ancient..Eternal), not the old clamped Mythical. This upgrades
// ANY material-suffixed gear — core ladder AND the fancy content-pack sets — so
// the whole endgame ladder to level 999 is rarity-consistent and sorts right.
const GEAR_SLOTS = new Set(['weapon', 'shield', 'helm', 'chest', 'boots', 'accessory', 'tool'])
function normalizeRarity(d: ItemDef): ItemDef {
  if (!GEAR_SLOTS.has(d.slot)) return d
  const tail = d.id.slice(d.id.lastIndexOf('_') + 1)
  const t = (MATERIALS as readonly string[]).indexOf(tail)
  return t > 5 && t > d.rarity ? { ...d, rarity: t as Rarity } : d
}

// Content packs may introduce new items; they registered before this loads.
const ALL_ITEMS = [...CATALOG, ...EXTRA_ITEMS].map(normalizeRarity)
const byId = new Map(ALL_ITEMS.map(d => [d.id, d] as const))

export const itemsApi: ItemsAPI = {
  def(id: string) {
    return byId.get(id)
  },
  all() {
    return ALL_ITEMS
  },
  buildMesh(id: string): THREE.Group {
    const d = byId.get(id)
    if (!d) console.warn(`[items] buildMesh: unknown item id "${id}" — using fallback crate`)
    return buildItemMesh(d)
  },
}
