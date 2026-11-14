/**
 * Inventory — stacks, equipment and persistence (the single source of truth
 * for what the player owns).
 *
 * Rules:
 *   - materials + consumables stack to 999 per stack (overflow opens a new
 *     stack); gear never stacks (one entry per piece, qty always 1);
 *   - this module is the ONLY listener that applies 'item:gained' /
 *     'item:removed' — other systems emit, we mutate;
 *   - equip/unequip move exactly one piece between the bag and the
 *     equipment map, emit 'item:equipped' and 'save:dirty';
 *   - persists via saveRegistry provider 'inv'.
 */
import type { GameAPI, InventoryAPI, ItemDef, ItemStack } from '../types'
import { events, type GameEvents } from '../events'
import { saveRegistry } from '../save/registry'
import { GEAR_SLOTS, isGearSlot, isStackable, synthDef, type DefSource } from './defs'

export const MAX_STACK = 999

const GAIN_SOURCES = ['loot', 'gather', 'quest', 'craft', 'vendor', 'restore'] as const
type GainSource = GameEvents['item:gained']['source']

const STAT_KEYS = ['atk', 'def', 'str', 'int', 'agi'] as const

export class InventoryCore implements InventoryAPI {
  private stacks: ItemStack[] = []
  private equipMap: Record<string, string | null> = {}
  private defSource: DefSource | null = null
  private changeListeners: Array<() => void> = []
  /** Integrator-wired (upgrading module): per-item upgrade/enchant/reforge delta. */
  private upgradeBonus:
    | ((id: string, base: { atk: number; def: number; str: number; int: number; agi: number }) => Partial<{ atk: number; def: number; str: number; int: number; agi: number }>)
    | null = null

  constructor(private readonly gameApi: GameAPI) {
    for (const slot of GEAR_SLOTS) this.equipMap[slot] = null

    // The one place item:gained / item:removed are APPLIED.
    events.on('item:gained', (e) => {
      this.grant(e.id, e.qty)
      events.emit('save:dirty', { why: `inv:gain:${e.id}` })
      this.notify()
    })
    events.on('item:removed', (e) => {
      this.take(e.id, e.qty)
      events.emit('save:dirty', { why: `inv:remove:${e.id}` })
      this.notify()
    })

    saveRegistry.register('inv', {
      dump: () => ({
        inv: this.stacks.map((s) => [s.id, s.qty] as [string, number]),
        equip: { ...this.equipMap }
      }),
      load: (data: unknown) => this.restore(data)
    })
  }

  // --- wiring ---------------------------------------------------------------

  /**
   * Integrator wires this to the upgrading module's bonusFor(id, base) so
   * equippedStats() reflects +levels, enchants, and reforge overrides. The
   * delta is applied on top of the catalog spread the inventory already sums.
   */
  setUpgradeBonus(
    fn: (id: string, base: { atk: number; def: number; str: number; int: number; agi: number }) => Partial<{ atk: number; def: number; str: number; int: number; agi: number }>,
  ): void {
    this.upgradeBonus = fn
    this.notify()
  }

  /** Integrator wires this to ItemsAPI.def for real catalog data. */
  setDefSource(fn: DefSource): void {
    this.defSource = fn
    this.notify()
  }

  /** UI subscribes here; fired after every mutation. */
  onChange(fn: () => void): void {
    this.changeListeners.push(fn)
  }

  private notify(): void {
    for (const fn of this.changeListeners) {
      try {
        fn()
      } catch (e) {
        console.error('[inventory] change listener threw', e)
      }
    }
  }

  /** Resolved item definition — catalog first, id-convention fallback second. */
  def(id: string): ItemDef {
    return this.defSource?.(id) ?? synthDef(id)
  }

  // --- InventoryAPI ---------------------------------------------------------

  items(): readonly ItemStack[] {
    return this.stacks
  }

  add(id: string, qty: number, source?: string): void {
    if (qty <= 0) return
    const src: GainSource = (GAIN_SOURCES as readonly string[]).includes(source ?? '')
      ? (source as GainSource)
      : 'loot'
    // Emitting (not mutating) keeps 'item:gained' the one canonical path;
    // our own listener above applies it.
    events.emit('item:gained', { id, qty, source: src })
  }

  remove(id: string, qty: number): boolean {
    if (qty <= 0) return false
    if (this.count(id) < qty) return false
    events.emit('item:removed', { id, qty })
    return true
  }

  count(id: string): number {
    let n = 0
    for (const s of this.stacks) if (s.id === id) n += s.qty
    return n
  }

  equipment(): Readonly<Record<string, string | null>> {
    return this.equipMap
  }

  equip(id: string): boolean {
    const def = this.def(id)
    if (!isGearSlot(def.slot)) return false
    if (this.count(id) < 1) return false
    if ((def.levelReq ?? 1) > this.gameApi.player.level) return false

    this.take(id, 1)
    const prev = this.equipMap[def.slot]
    if (prev) this.grant(prev, 1)
    this.equipMap[def.slot] = id

    events.emit('item:equipped', { slot: def.slot, id })
    events.emit('save:dirty', { why: `inv:equip:${id}` })
    this.notify()
    return true
  }

  unequip(slot: string): void {
    const id = this.equipMap[slot]
    if (!id) return
    this.equipMap[slot] = null
    this.grant(id, 1)
    events.emit('item:equipped', { slot, id: null })
    events.emit('save:dirty', { why: `inv:unequip:${slot}` })
    this.notify()
  }

  equippedStats(): { atk: number; def: number; str: number; int: number; agi: number } {
    const total = { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
    for (const slot of GEAR_SLOTS) {
      const id = this.equipMap[slot]
      if (!id) continue
      // Catalog base spread for this piece (all five keys, zero-filled).
      const base = { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
      const stats = this.def(id).stats
      if (stats) for (const k of STAT_KEYS) base[k] = stats[k] ?? 0
      // Upgrade/enchant/reforge delta (0 for untouched gear, or when unwired).
      const bonus = this.upgradeBonus?.(id, base) ?? {}
      for (const k of STAT_KEYS) total[k] += base[k] + (bonus[k] ?? 0)
    }
    return total
  }

  // --- internal stack mechanics (no events — callers handle those) ----------

  private grant(id: string, qty: number): void {
    let left = Math.max(0, Math.floor(qty))
    if (left === 0) return
    const def = this.def(id)
    if (isStackable(def)) {
      for (const s of this.stacks) {
        if (left === 0) break
        if (s.id !== id || s.qty >= MAX_STACK) continue
        const fit = Math.min(MAX_STACK - s.qty, left)
        s.qty += fit
        left -= fit
      }
      while (left > 0) {
        const fit = Math.min(MAX_STACK, left)
        this.stacks.push({ id, qty: fit })
        left -= fit
      }
    } else {
      // Gear never stacks: one entry per piece.
      for (let i = 0; i < left; i++) this.stacks.push({ id, qty: 1 })
    }
  }

  private take(id: string, qty: number): number {
    let left = Math.max(0, Math.floor(qty))
    let taken = 0
    for (const s of this.stacks) {
      if (left === 0) break
      if (s.id !== id) continue
      const n = Math.min(s.qty, left)
      s.qty -= n
      left -= n
      taken += n
    }
    this.stacks = this.stacks.filter((s) => s.qty > 0)
    return taken
  }

  // --- persistence ----------------------------------------------------------

  private restore(data: unknown): void {
    this.stacks = []
    for (const slot of GEAR_SLOTS) this.equipMap[slot] = null
    if (!data || typeof data !== 'object') return

    const d = data as { inv?: unknown; equip?: unknown }
    const rawInv = Array.isArray(data) ? data : d.inv
    if (Array.isArray(rawInv)) {
      for (const entry of rawInv) {
        if (!Array.isArray(entry)) continue
        const [id, qty] = entry as [unknown, unknown]
        if (typeof id === 'string' && typeof qty === 'number' && qty > 0) {
          this.grant(id, qty)
        }
      }
    }
    if (d.equip && typeof d.equip === 'object') {
      for (const [slot, id] of Object.entries(d.equip as Record<string, unknown>)) {
        if (!isGearSlot(slot)) continue
        if (typeof id === 'string' && id) this.equipMap[slot] = id
      }
    }
    this.notify()
  }
}
