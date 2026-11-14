/**
 * Upgrading — the per-item modification ledger + stat math + persistence.
 *
 * IDENTITY MODEL (read against src/inventory/core.ts): the inventory bag has
 * no per-copy identity — gear is tracked by catalog id (two iron swords are
 * one fungible "iron_sword" to the bag, and the mint store likewise claims
 * "a copy" by id). So the clean, consistent key for a modification is the
 * catalog id: all copies of an id share one +level / enchant set / reforge.
 * This is the ONLY coherent model without rebuilding the bag to be
 * instance-based, and it keeps everything downstream (equip doll, combat,
 * pet DPS) correct because they all resolve by id too.
 *
 * NFT honesty: upgrading never touches the mint store or any uid — a minted
 * piece keeps its uid and mints untouched through every ascension, so an
 * upgraded minted item is simply a more valuable instance of the same uid.
 *
 * STORAGE: own saveRegistry provider 'upgrades' (additive — the inventory
 * blob is left exactly as-is). Compact row form per modified id:
 *   { v: 1, g: [[id, plus, [enchantId,...], [reforgeAtk,def,str,int,agi]|0], ...] }
 */
import { events } from '../events'
import { saveRegistry } from '../save/registry'
import {
  MAX_PLUS, MAX_ENCHANT_SLOTS, PLUS_STEP, STAT_KEYS,
  enchantDef, type Stats
} from './data'

export interface GearMods {
  /** 0..MAX_PLUS. */
  plus: number
  /** Enchant ids in slot order (length <= MAX_ENCHANT_SLOTS). */
  enchants: string[]
  /** Rerolled base stat spread that REPLACES the catalog spread, or null. */
  reforge: Stats | null
}

type DefResolver = (id: string) => { rarity: number; stats?: Partial<Stats> } | undefined

function emptyStats(): Stats {
  return { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
}

function cloneMods(m: GearMods): GearMods {
  return { plus: m.plus, enchants: [...m.enchants], reforge: m.reforge ? { ...m.reforge } : null }
}

export class UpgradeState {
  private ledger = new Map<string, GearMods>()
  private defSource: DefResolver | null = null
  private listeners: Array<() => void> = []

  constructor() {
    saveRegistry.register('upgrades', {
      dump: () => this.dump(),
      load: (d) => this.load(d)
    })
  }

  /** Integrator wires ItemsAPI.def here so enchant grants know the rarity. */
  setDefSource(fn: DefResolver): void {
    this.defSource = fn
  }

  /** UI subscribes; fired after any ledger mutation. */
  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  private notify(why: string): void {
    events.emit('save:dirty', { why: `upgrades:${why}` })
    for (const fn of this.listeners) {
      try { fn() } catch (e) { console.error('[upgrading] listener threw', e) }
    }
  }

  private rarityOf(id: string): number {
    return this.defSource?.(id)?.rarity ?? 0
  }

  private baseStatsOf(id: string): Stats {
    const s = this.defSource?.(id)?.stats
    const out = emptyStats()
    if (s) for (const k of STAT_KEYS) out[k] = s[k] ?? 0
    return out
  }

  // --- queries --------------------------------------------------------------

  /** The mods for `id` (a copy — never the live row), defaulting to empty. */
  get(id: string): GearMods {
    const m = this.ledger.get(id)
    return m ? cloneMods(m) : { plus: 0, enchants: [], reforge: null }
  }

  has(id: string): boolean {
    const m = this.ledger.get(id)
    return !!m && (m.plus > 0 || m.enchants.length > 0 || m.reforge !== null)
  }

  /**
   * The effective base spread (catalog spread, or the reforged override if the
   * item has been rerolled). Used by the UI's stat preview.
   */
  effectiveBase(id: string): Stats {
    const m = this.ledger.get(id)
    if (m?.reforge) return { ...m.reforge }
    return this.baseStatsOf(id)
  }

  /**
   * THE equippedStats hook. Given a catalog id and the base spread the
   * inventory already summed, return the DELTA to add so the total reflects
   * the reforge override, the +level %, and every enchant's flat grant.
   */
  bonusFor(id: string, base: Stats): Partial<Stats> {
    const m = this.ledger.get(id)
    if (!m) return {}
    const out = emptyStats()
    // Effective base = reforge replaces the catalog spread (correct inv's add).
    const eff = m.reforge ?? base
    for (const k of STAT_KEYS) out[k] += eff[k] - base[k]
    // +level: a percentage of the effective base, rounded per stat.
    if (m.plus > 0) {
      const mult = PLUS_STEP * m.plus
      let any = 0
      for (const k of STAT_KEYS) {
        const add = Math.round(eff[k] * mult)
        out[k] += add
        any += add
      }
      // Floor: a plus should always do SOMETHING — if every stat rounded to
      // zero (tiny base), nudge the largest base stat by +1.
      if (any === 0) {
        let bk: keyof Stats = 'atk'
        let bv = -1
        for (const k of STAT_KEYS) if (eff[k] > bv) { bv = eff[k]; bk = k }
        if (bv > 0) out[bk] += 1
      }
    }
    // Enchants: flat grants scaled by item rarity.
    if (m.enchants.length) {
      const r = this.rarityOf(id)
      for (const eid of m.enchants) {
        const grant = enchantDef(eid)?.grant(r)
        if (grant) for (const k of STAT_KEYS) out[k] += grant[k] ?? 0
      }
    }
    return out
  }

  // --- mutations ------------------------------------------------------------

  private edit(id: string): GearMods {
    let m = this.ledger.get(id)
    if (!m) { m = { plus: 0, enchants: [], reforge: null }; this.ledger.set(id, m) }
    return m
  }

  /** Bump +level by one (caller has already validated mats + the roll). */
  bumpPlus(id: string): number {
    const m = this.edit(id)
    m.plus = Math.min(MAX_PLUS, m.plus + 1)
    this.notify(`plus:${id}:${m.plus}`)
    return m.plus
  }

  /** Put `enchantId` in `slot` (replacing whatever is there). */
  setEnchant(id: string, slot: number, enchantId: string): boolean {
    if (slot < 0 || slot >= MAX_ENCHANT_SLOTS) return false
    if (!enchantDef(enchantId)) return false
    const m = this.edit(id)
    // No duplicate enchant on the same piece (dupes would be a non-choice).
    if (m.enchants.some((e, i) => e === enchantId && i !== slot)) return false
    m.enchants[slot] = enchantId
    // keep the array dense
    m.enchants = m.enchants.filter((e) => !!e)
    this.notify(`enchant:${id}:${slot}`)
    return true
  }

  removeEnchant(id: string, slot: number): void {
    const m = this.ledger.get(id)
    if (!m || slot < 0 || slot >= m.enchants.length) return
    m.enchants.splice(slot, 1)
    this.notify(`unench:${id}:${slot}`)
  }

  /** Store a rerolled base spread. */
  setReforge(id: string, spread: Stats): void {
    const m = this.edit(id)
    m.reforge = { ...spread }
    this.notify(`reforge:${id}`)
  }

  // --- persistence ----------------------------------------------------------

  private dump(): unknown {
    const g: unknown[] = []
    for (const [id, m] of this.ledger) {
      if (m.plus === 0 && m.enchants.length === 0 && !m.reforge) continue
      const rf = m.reforge ? STAT_KEYS.map((k) => m.reforge![k]) : 0
      g.push([id, m.plus, [...m.enchants], rf])
    }
    return { v: 1, g }
  }

  private load(data: unknown): void {
    this.ledger.clear()
    if (!data || typeof data !== 'object') return
    const d = data as { g?: unknown }
    if (!Array.isArray(d.g)) return
    for (const row of d.g) {
      if (!Array.isArray(row)) continue
      const [id, plus, ench, rf] = row as unknown[]
      if (typeof id !== 'string' || !id) continue
      const mods: GearMods = { plus: 0, enchants: [], reforge: null }
      if (typeof plus === 'number' && Number.isFinite(plus)) {
        mods.plus = Math.max(0, Math.min(MAX_PLUS, Math.floor(plus)))
      }
      if (Array.isArray(ench)) {
        for (const e of ench) {
          if (typeof e === 'string' && enchantDef(e) && mods.enchants.length < MAX_ENCHANT_SLOTS) {
            if (!mods.enchants.includes(e)) mods.enchants.push(e)
          }
        }
      }
      if (Array.isArray(rf) && rf.length === STAT_KEYS.length) {
        const spread = emptyStats()
        let ok = true
        STAT_KEYS.forEach((k, i) => {
          const v = rf[i]
          if (typeof v === 'number' && Number.isFinite(v)) spread[k] = v
          else ok = false
        })
        if (ok) mods.reforge = spread
      }
      if (mods.plus > 0 || mods.enchants.length > 0 || mods.reforge) {
        this.ledger.set(id, mods)
      }
    }
    for (const fn of this.listeners) {
      try { fn() } catch (e) { console.error('[upgrading] listener threw', e) }
    }
  }
}

/**
 * Reroll a stat spread, keeping the SAME total budget (±10%) redistributed
 * across the stats that were already present, with a fresh random emphasis.
 * Deterministic-free (uses Math.random) — this is the reforge gamble.
 */
export function rerollSpread(base: Stats): Stats {
  const keys = STAT_KEYS.filter((k) => base[k] > 0)
  const total = keys.reduce((n, k) => n + base[k], 0)
  const out = emptyStats()
  if (keys.length === 0 || total <= 0) return out
  // random weights, each key guaranteed a floor of 1
  const weights = keys.map(() => 0.4 + Math.random())
  const wsum = weights.reduce((a, b) => a + b, 0)
  let assigned = 0
  keys.forEach((k, i) => {
    const share = Math.max(1, Math.round((weights[i]! / wsum) * total))
    out[k] = share
    assigned += share
  })
  // Reconcile rounding drift onto a random present key, never below 1.
  let drift = total - assigned
  let guard = 0
  while (drift !== 0 && guard++ < 50) {
    const k = keys[Math.floor(Math.random() * keys.length)]!
    if (drift > 0) { out[k] += 1; drift -= 1 }
    else if (out[k] > 1) { out[k] -= 1; drift += 1 }
  }
  return out
}
