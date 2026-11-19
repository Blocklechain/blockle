/**
 * Mini-boss trophies — one unique, un-stackable accessory per zone/region,
 * dropped only by that zone's mini-boss (see src/minibosses). Generated in a
 * loop (≈980 items) rather than hand-written. All render via the generic
 * `trophy_` mesh family (src/items/mesh.ts buildTrophy), so none hit the '?'
 * fallback.
 */
import { registerPack } from './packs'
import type { ItemDef, Rarity } from '../types'
import { MAX_LEVEL } from '../skills/curve'
import { MINIBOSS_ZONES, miniBossForZone } from '../minibosses'

const items: ItemDef[] = []
const itemNames: Record<string, string> = {}

for (const z of MINIBOSS_ZONES) {
  const mb = miniBossForZone(z)
  const lvl = mb.level
  // Rarity climbs with the zone's level band (1..999 → Common..Mythical).
  const rarity = Math.max(0, Math.min(5, Math.floor((lvl - 1) / 167))) as Rarity
  const r = rarity as number
  items.push({
    id: mb.trophyId,
    name: mb.trophyName,
    slot: 'accessory',
    rarity,
    value: (r + 1) * (r + 1) * 20,
    stats: { int: 1 + r, agi: 1 + r },
    levelReq: Math.max(1, Math.min(MAX_LEVEL, lvl)),
    desc: `A one-of-a-kind trophy, pried off ${mb.name}. Proof you were there and it, regrettably, was not.`,
  })
  itemNames[mb.trophyId] = mb.trophyName
}

registerPack({ items, itemNames })
