/**
 * Upgrading — gear progression at the Anvil of Ascension (Royal Capital).
 *
 * Flow: walk up to the anvil → prompt pill ([E] / tap) → the centered
 * Ascension panel. Pick an owned piece of gear, then UPGRADE (+0..+10),
 * ENCHANT (up to 2 sockets), or REFORGE (reroll the stat spread). Every
 * action consumes REAL materials via the inventory (emits 'item:removed');
 * nothing is faked, nothing is destroyed on a failed high-+ gamble.
 *
 * Contract compliance: talks through the event bus + integrator-wired setters
 * only; sanctioned leaf imports are audio/engine (SFX) and save/registry
 * (inside state.ts). The anvil prop + its interact anchor live in ./station.ts
 * (the world-side hook world/index.ts calls at build time).
 */
import type { GameAPI, InventoryAPI, ItemDef } from '../types'
import { events } from '../events'
import { audio } from '../audio/engine'
import { UpgradeState, rerollSpread } from './state'
import { line } from './flavor'
import {
  MAX_PLUS, MAX_ENCHANT_SLOTS, PLUS_STEP, RISK_FROM, STAT_KEYS, STAT_LABEL,
  ENCHANTS, ENCHANT_GLOW, enchantDef, enchantCost, reforgeCost, upgradeCost,
  successChance, type MatCost, type Stats
} from './data'
import { anvilSpot } from './station'
import {
  createUpgradingUI, type AscTab, type MatView, type PanelVM,
  type SelectedView, type UpgradeTabView, type EnchantTabView, type ReforgeTabView
} from './ui'

/** The inventory's lent rotating 3D viewer (structural — no cross import). */
export interface LentViewer {
  canvas: HTMLCanvasElement
  show(id: string, rarity: number): void
  stop(): void
}

export interface UpgradingModule {
  /** Inventory: owned-gear list, mat counts, and mat escrow (remove). */
  setInventory(inv: InventoryAPI): void
  /** Real catalog defs (slot/rarity/stats/name). */
  setDefSource(fn: (id: string) => ItemDef | undefined): void
  /** Blacksmithing level → softens the high-+ fail chance. Optional. */
  setSkillLevel(fn: (skill: string) => number): void
  /** Lend the inventory's 3D viewer for the panel preview. */
  setViewer(v: LentViewer): void
  /** THE equippedStats hook — pass to inventory.setUpgradeBonus. */
  bonusFor(id: string, base: Stats): Partial<Stats>
  dispose(): void
}

/** Slots the anvil will work on (tools are crafting-land, not combat gear). */
const UPGRADE_SLOTS = new Set(['weapon', 'shield', 'helm', 'chest', 'boots', 'accessory'])

const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythical'] as const
const RARITY_COLORS = ['#9aa0a6', '#7ed957', '#6cb8ff', '#b07df2', '#ffb04f', '#ff5c8a'] as const

const INTERACT_RADIUS = 3.4
const LEAVE_RADIUS = 4.8

function emptyStats(): Stats {
  return { atk: 0, def: 0, str: 0, int: 0, agi: 0 }
}

export function initUpgrading(api: GameAPI): UpgradingModule {
  const state = new UpgradeState()
  const uiMount = document.getElementById('ui')
  const ui = uiMount ? createUpgradingUI(uiMount) : null

  let inv: InventoryAPI | null = null
  let defSource: ((id: string) => ItemDef | undefined) | null = null
  let skillLevel: ((skill: string) => number) | null = null
  let viewer: LentViewer | null = null

  let selectedId: string | null = null
  let tab: AscTab = 'upgrade'

  // --- helpers --------------------------------------------------------------

  const def = (id: string): ItemDef | undefined => defSource?.(id)
  const rarityOf = (id: string): number => def(id)?.rarity ?? 0
  const nameOf = (id: string): string =>
    def(id)?.name ??
    id.split('_').reverse().map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ')
  const count = (id: string): number => inv?.count(id) ?? 0

  const catalogBase = (id: string): Stats => {
    const s = def(id)?.stats
    const out = emptyStats()
    if (s) for (const k of STAT_KEYS) out[k] = s[k] ?? 0
    return out
  }

  const matViews = (cost: MatCost[]): MatView[] =>
    cost.map((m) => {
      const have = count(m.id)
      return { name: nameOf(m.id), have, need: m.qty, ok: have >= m.qty }
    })

  const affordable = (cost: MatCost[]): boolean => cost.every((m) => count(m.id) >= m.qty)

  /** Distinct, upgrade-eligible gear the player owns (equipped first). */
  const ownedGear = (): string[] => {
    if (!inv) return []
    const seen = new Set<string>()
    const out: string[] = []
    const consider = (id: string | null): void => {
      if (!id || seen.has(id)) return
      const slot = def(id)?.slot ?? ''
      if (!UPGRADE_SLOTS.has(slot)) return
      seen.add(id)
      out.push(id)
    }
    for (const id of Object.values(inv.equipment())) consider(id)
    for (const s of inv.items()) consider(s.id)
    return out
  }

  const smith = (): number => skillLevel?.('blacksmithing') ?? 1

  // --- view-model -----------------------------------------------------------

  const effectiveBase = (id: string): Stats => state.effectiveBase(id)

  const selectedView = (id: string): SelectedView => {
    const d = def(id)
    const r = d?.rarity ?? 0
    const mods = state.get(id)
    const base = catalogBase(id)
    const bonus = state.bonusFor(id, base)
    const stats = STAT_KEYS
      .map((k) => ({ label: STAT_LABEL[k], base: base[k], eff: base[k] + (bonus[k] ?? 0) }))
      .filter((s) => s.base > 0 || s.eff > 0)
    const enchantNames = mods.enchants.map((e) => enchantDef(e)?.name ?? e)
    const glow = mods.enchants.length ? (ENCHANT_GLOW[mods.enchants[mods.enchants.length - 1]!] ?? null) : null
    return {
      id,
      name: nameOf(id),
      rarity: r,
      rarityName: RARITY_NAMES[r] ?? 'Common',
      rarityColor: RARITY_COLORS[r] ?? RARITY_COLORS[0],
      plus: mods.plus,
      stats,
      enchantNames,
      glow
    }
  }

  const upgradeView = (id: string): UpgradeTabView => {
    const mods = state.get(id)
    const r = rarityOf(id)
    if (mods.plus >= MAX_PLUS) {
      return { maxed: true, fromPlus: mods.plus, toPlus: mods.plus, chancePct: 100, risky: false, cost: [], affordable: false, gain: [] }
    }
    const to = mods.plus + 1
    const cost = upgradeCost(to, r)
    const eff = effectiveBase(id)
    const gain: string[] = []
    for (const k of STAT_KEYS) {
      const add = Math.round(eff[k] * PLUS_STEP * to) - Math.round(eff[k] * PLUS_STEP * mods.plus)
      if (add > 0) gain.push(`+${add} ${STAT_LABEL[k]}`)
    }
    const chance = successChance(to, smith())
    return {
      maxed: false,
      fromPlus: mods.plus,
      toPlus: to,
      chancePct: Math.round(chance * 100),
      risky: to >= RISK_FROM,
      cost: matViews(cost),
      affordable: affordable(cost),
      gain
    }
  }

  const enchantView = (id: string): EnchantTabView => {
    const mods = state.get(id)
    const r = rarityOf(id)
    const current = mods.enchants.map((e, slot) => ({
      slot,
      name: enchantDef(e)?.name ?? e,
      effect: effectStr(e, r)
    }))
    const freeSlot = mods.enchants.length
    const options = ENCHANTS.map((e) => {
      const equipped = mods.enchants.includes(e.id)
      const slotForCost = equipped ? mods.enchants.indexOf(e.id) : freeSlot
      const cost = enchantCost(slotForCost, r)
      const canApply = !equipped && freeSlot < MAX_ENCHANT_SLOTS && affordable(cost)
      return {
        id: e.id,
        name: e.name,
        blurb: e.blurb,
        effect: effectStr(e.id, r),
        cost: matViews(cost),
        affordable: affordable(cost),
        equipped,
        canApply
      }
    })
    return { slotsUsed: mods.enchants.length, maxSlots: MAX_ENCHANT_SLOTS, current, options }
  }

  const effectStr = (enchantId: string, rarity: number): string => {
    const grant = enchantDef(enchantId)?.grant(rarity)
    if (!grant) return ''
    return STAT_KEYS.filter((k) => (grant[k] ?? 0) > 0).map((k) => `+${grant[k]} ${STAT_LABEL[k]}`).join(' ')
  }

  const reforgeView = (id: string): ReforgeTabView => {
    const r = rarityOf(id)
    const cost = reforgeCost(r)
    const eff = effectiveBase(id)
    const current = STAT_KEYS.filter((k) => eff[k] > 0).map((k) => ({ label: STAT_LABEL[k], base: eff[k], eff: eff[k] }))
    const hasStats = STAT_KEYS.some((k) => catalogBase(id)[k] > 0)
    return { cost: matViews(cost), affordable: hasStats && affordable(cost), current }
  }

  const buildVM = (): PanelVM => {
    const gear = ownedGear()
    // keep selection valid
    if (selectedId && !gear.includes(selectedId)) selectedId = null
    if (!selectedId && gear.length) selectedId = gear[0]!
    const list = gear.map((id) => {
      const mods = state.get(id)
      return {
        id,
        name: nameOf(id),
        plus: mods.plus,
        enchantCount: mods.enchants.length,
        rarityColor: RARITY_COLORS[rarityOf(id)] ?? RARITY_COLORS[0],
        selected: id === selectedId
      }
    })
    const selected = selectedId ? selectedView(selectedId) : null
    return {
      list,
      selected,
      tab,
      upgrade: selectedId ? upgradeView(selectedId) : null,
      enchant: selectedId ? enchantView(selectedId) : null,
      reforge: selectedId ? reforgeView(selectedId) : null
    }
  }

  // --- viewer preview -------------------------------------------------------

  let shownForId: string | null = null
  const showViewer = (): void => {
    if (!ui || !viewer || !selectedId) return
    const host = ui.viewerHost()
    if (viewer.canvas.parentElement !== host) host.appendChild(viewer.canvas)
    if (shownForId !== selectedId) {
      viewer.show(selectedId, rarityOf(selectedId))
      shownForId = selectedId
    }
  }

  const refresh = (): void => {
    if (!ui?.isOpen()) return
    ui.render(buildVM())
    showViewer()
  }

  // --- actions --------------------------------------------------------------

  const sys = (text: string): void => events.emit('chat:system', { text })

  const consume = (cost: MatCost[], fraction = 1): void => {
    for (const m of cost) {
      const qty = fraction >= 1 ? m.qty : Math.ceil(m.qty * fraction)
      if (qty > 0) inv?.remove(m.id, qty)
    }
  }

  const doUpgrade = (): void => {
    if (!selectedId) return
    const id = selectedId
    const mods = state.get(id)
    if (mods.plus >= MAX_PLUS) { sys('Already +10 — the ceiling of mortal gear.'); return }
    const to = mods.plus + 1
    const cost = upgradeCost(to, rarityOf(id))
    if (!affordable(cost)) {
      audio.sfx.play('error-buzz', { vel: 0.6 })
      sys(line.noMats())
      return
    }
    const chance = successChance(to, smith())
    const ok = Math.random() < chance
    if (ok) {
      consume(cost, 1)
      const plus = state.bumpPlus(id)
      audio.sfx.play('pick-clink-1', { vel: 0.9, pitch: 0.8 })
      audio.sfx.play('cha-ching-chime', { vel: 0.7 })
      if (plus >= MAX_PLUS) {
        audio.sfx.play('level-up', { vel: 0.8 })
        sys(line.upgradeMax())
      } else {
        sys(`${nameOf(id)} is now +${plus}. ${line.upgradeOk()}`)
      }
    } else {
      consume(cost, 0.5)
      audio.sfx.play('error-buzz', { vel: 0.6 })
      audio.sfx.play('rock-crumble', { vel: 0.5, pitch: 0.9 })
      sys(line.upgradeFail())
    }
    refresh()
  }

  const doEnchant = (enchantId: string): void => {
    if (!selectedId) return
    const id = selectedId
    const mods = state.get(id)
    if (mods.enchants.includes(enchantId)) return
    if (mods.enchants.length >= MAX_ENCHANT_SLOTS) { sys(line.enchantFull()); return }
    const slot = mods.enchants.length
    const cost = enchantCost(slot, rarityOf(id))
    if (!affordable(cost)) { audio.sfx.play('error-buzz', { vel: 0.6 }); sys(line.noMats()); return }
    consume(cost, 1)
    state.setEnchant(id, slot, enchantId)
    audio.sfx.play('waystone-attune', { vel: 0.6 })
    audio.sfx.play('cha-ching-chime', { vel: 0.6, pitch: 1.1 })
    sys(`${enchantDef(enchantId)?.name ?? 'Enchant'} etched onto ${nameOf(id)}. ${line.enchantOk()}`)
    refresh()
  }

  const doRemoveEnchant = (slot: number): void => {
    if (!selectedId) return
    state.removeEnchant(selectedId, slot)
    audio.sfx.play('ui-close', { vel: 0.6 })
    refresh()
  }

  const doReforge = (): void => {
    if (!selectedId) return
    const id = selectedId
    const base = catalogBase(id)
    if (!STAT_KEYS.some((k) => base[k] > 0)) { sys('Nothing to reforge — this piece has no stats to shuffle.'); return }
    const cost = reforgeCost(rarityOf(id))
    if (!affordable(cost)) { audio.sfx.play('error-buzz', { vel: 0.6 }); sys(line.noMats()); return }
    consume(cost, 1)
    state.setReforge(id, rerollSpread(base))
    audio.sfx.play('pick-clink-2', { vel: 0.8, pitch: 1.0 })
    audio.sfx.play('equip-clack', { vel: 0.7 })
    sys(`${nameOf(id)} reforged. ${line.reforgeOk()}`)
    refresh()
  }

  // --- panel open/close + proximity ----------------------------------------

  const openPanel = (): void => {
    if (!ui || ui.isOpen()) return
    shownForId = null
    ui.open(buildVM())
    showViewer()
    audio.sfx.play('ui-open', { vel: 0.7 })
  }

  const closePanel = (): void => {
    if (!ui) return
    const was = ui.isOpen()
    ui.close()
    viewer?.stop()
    shownForId = null
    if (was) audio.sfx.play('ui-close', { vel: 0.6 })
  }

  if (ui) {
    ui.onClose(() => closePanel())
    ui.onSelect((id) => { selectedId = id; refresh() })
    ui.onTab((t) => { tab = t; refresh() })
    ui.onUpgrade(doUpgrade)
    ui.onEnchant(doEnchant)
    ui.onRemoveEnchant(doRemoveEnchant)
    ui.onReforge(doReforge)
    ui.onPromptActivate(openPanel)
  }

  // live mat counts while open
  const offGained = events.on('item:gained', () => refresh())
  const offRemoved = events.on('item:removed', () => refresh())
  state.onChange(() => refresh())

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || (e.key !== 'e' && e.key !== 'E')) return
    const el = document.activeElement
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) return
    if (nearAnvil()) { e.preventDefault(); openPanel() }
  }
  window.addEventListener('keydown', onKeyDown)

  const nearAnvil = (): boolean => {
    const s = anvilSpot()
    if (!s) return false
    const dx = s.x - api.player.pos.x
    const dz = s.z - api.player.pos.z
    return dx * dx + dz * dz < INTERACT_RADIUS * INTERACT_RADIUS
  }

  let raf = 0
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    const s = anvilSpot()
    if (!s || !ui) return
    const dx = s.x - api.player.pos.x
    const dz = s.z - api.player.pos.z
    const d2 = dx * dx + dz * dz
    if (ui.isOpen()) {
      if (d2 > LEAVE_RADIUS * LEAVE_RADIUS) closePanel()
    } else {
      if (d2 < INTERACT_RADIUS * INTERACT_RADIUS) ui.showPrompt('Use the Anvil of Ascension')
      else ui.hidePrompt()
    }
  }
  raf = requestAnimationFrame(tick)

  return {
    setInventory(i) { inv = i },
    setDefSource(fn) { defSource = fn; state.setDefSource((id) => { const d = fn(id); if (!d) return undefined; return d.stats ? { rarity: d.rarity, stats: d.stats } : { rarity: d.rarity } }) },
    setSkillLevel(fn) { skillLevel = fn },
    setViewer(v) { viewer = v },
    bonusFor: (id, base) => state.bonusFor(id, base),
    dispose() {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      offGained()
      offRemoved()
      closePanel()
      ui?.dispose()
    }
  }
}
