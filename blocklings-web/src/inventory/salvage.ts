/**
 * Salvage / breakdown — turn any item (except mounts) back into some of the
 * materials it's made from. The yield is always LESS than it would cost to
 * craft the item, but always at least one material: nothing is a dead end.
 *
 *   - Crafted items reclaim a fraction (RECOVER) of their recipe inputs.
 *   - Dropped / synthesized gear with no recipe reclaims a raw material by
 *     its material tier (copper..mythic) and slot weight.
 *   - Mounts never salvage (by design). Raw materials and uncrafted
 *     consumables are already "at their base" and have nothing to give back.
 */
import type { ItemDef } from '../types'
import { MATERIALS } from '../ids'
import { recipeForOutput } from '../crafting/recipes'

export interface SalvageItem {
  id: string
  qty: number
}

/** Fraction of a recipe's inputs returned on breakdown (always < 1). */
const RECOVER = 0.4

/** Reclaimed base metal per material-tier index (copper, iron, …, mythic). */
const TIER_BAR = ['bar_copper', 'bar_iron', 'bar_steel', 'bar_gold', 'crystal_cut', 'crystal_cut'] as const

/** Highest material-ladder tier whose name appears in the id; else by rarity. */
function materialTier(def: ItemDef): number {
  for (let i = MATERIALS.length - 1; i >= 0; i--) {
    const m = MATERIALS[i]
    if (m && def.id.includes(m)) return i
  }
  return Math.min(def.rarity, MATERIALS.length - 1)
}

/**
 * Can this item be broken down at all? Mounts never can. A base material or
 * an uncrafted consumable (e.g. a raw fish) is already a material — nothing
 * to reclaim — so it offers no breakdown either.
 */
export function canSalvage(def: ItemDef): boolean {
  if (def.slot === 'mount') return false
  if ((def.slot === 'material' || def.slot === 'consumable') && !recipeForOutput(def.id)) return false
  return true
}

function mergeSame(list: SalvageItem[]): SalvageItem[] {
  const m = new Map<string, number>()
  for (const x of list) m.set(x.id, (m.get(x.id) ?? 0) + x.qty)
  return [...m.entries()].map(([id, qty]) => ({ id, qty }))
}

/**
 * Materials a SINGLE unit of this item breaks into. Always `< ` craft cost,
 * always ≥ 1 material in total (unless the item can't be salvaged, then []).
 */
export function salvageYield(def: ItemDef): SalvageItem[] {
  if (!canSalvage(def)) return []

  const rec = recipeForOutput(def.id)
  if (rec) {
    const perOut = rec.output.qty || 1
    const out: SalvageItem[] = []
    for (const input of rec.inputs) {
      const q = Math.floor((input.qty / perOut) * RECOVER)
      if (q > 0) out.push({ id: input.id, qty: q })
    }
    if (out.length > 0) return mergeSame(out)
    // Everything floored to zero (cheap recipe) — hand back one of the first
    // input so a breakdown is never literally nothing.
    const first = rec.inputs[0]
    return first ? [{ id: first.id, qty: 1 }] : []
  }

  // No recipe (loot drop / synthesized gear): reclaim raw material by tier.
  const t = materialTier(def)
  const bar = TIER_BAR[t] ?? 'bar_copper'
  const weight = def.slot === 'chest' || def.slot === 'shield' ? 2 : 1
  const out: SalvageItem[] = [{ id: bar, qty: weight }]
  if (def.rarity >= 3) out.push({ id: 'crystal_shard', qty: 1 }) // epic+ bonus
  return out
}

/** Scale a per-unit yield by a count (for breaking down a whole stack). */
export function scaleYield(y: readonly SalvageItem[], n: number): SalvageItem[] {
  return y.map((x) => ({ id: x.id, qty: x.qty * n }))
}
