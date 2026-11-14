/**
 * Crafting — the production professions (blacksmithing, cooking, alchemy,
 * tailoring) at their world stations (forge / stove / alchemy table / loom).
 *
 * Flow: walk up to a station → prompt pill ([E] / tap) → centered crafting
 * panel listing that profession's recipes (locked rows show requirements +
 * comedy; unlocked rows show have/need per input) → Craft or x5 → a 1.6s
 * progress bar with profession-appropriate SFX per cycle → on each success:
 *   'item:removed' per input, 'item:gained' (source 'craft'),
 *   'xp:gained', 'save:dirty' — the inventory module applies mutations,
 * we only emit. Honest failures: missing mats stop the batch with a buzz.
 *
 * Skill-tree hooks (via setSkillTree):
 *   gates     'recipe:*' / 'unlock:*' flags (auto-granted at level)
 *   speed     smithSpeed / cookSpeed / brewSpeed / sewSpeed
 *   economy   saveBar / saveCloth (refund chance), doublePotion (bonus out),
 *             noBurn (cooking's 10% burn-to-food_burnt chance, reduced)
 *
 * Contract compliance: talks through the event bus + integrator setters
 * only; sanctioned leaf import: audio/engine. Station placement lives in
 * ./stations.ts (the world-side hook world/index.ts calls at build time).
 */
import type { GameAPI, InventoryAPI, ItemDef, SkillsAPI, SkillTreeAPI } from '../types'
import { events } from '../events'
import { audio } from '../audio/engine'
import { stationSpots, type StationKind, type StationSpot } from './stations'
import { recipesFor, type CraftSkill, type Recipe } from './recipes'
import { burntLine, lockedLine, maybeSuccessLine } from './flavor'
import { createCraftingUI, type CraftPanelData, type CraftRowView } from './ui'

export interface CraftingModule {
  /** Wire the inventory for have/need counts (mutations stay event-driven). */
  setInventory(inv: InventoryAPI): void
  /** Wire skill levels (recipe level gates + the panel's level chip). */
  setSkills(s: SkillsAPI): void
  /** Wire talent trees (recipe gates + speed/economy modifiers). Optional. */
  setSkillTree(st: SkillTreeAPI): void
  /** Wire real catalog defs (names in the recipe list). */
  setDefSource(fn: (id: string) => ItemDef | undefined): void
  dispose(): void
}

/** Stand this close (world units) to a station to interact. */
const INTERACT_RADIUS = 3.2
/** Walk this far from the open station and the panel closes. */
const LEAVE_RADIUS = 4.5
/** Base craft time per item, seconds (shortened by the speed modifiers). */
const BASE_TIME = 1.6
const MIN_TIME = 0.7

const SKILL_OF: Record<StationKind, CraftSkill> = {
  forge: 'blacksmithing',
  stove: 'cooking',
  alchemy: 'alchemy',
  loom: 'tailoring'
}

const SKILL_LABEL: Record<CraftSkill, string> = {
  blacksmithing: 'Blacksmithing',
  cooking: 'Cooking',
  alchemy: 'Alchemy',
  tailoring: 'Tailoring'
}

const SPEED_KEY: Record<CraftSkill, string> = {
  blacksmithing: 'smithSpeed',
  cooking: 'cookSpeed',
  alchemy: 'brewSpeed',
  tailoring: 'sewSpeed'
}

/** Per-cycle work-loop SFX (names verified against audio/sfx-defs.ts). */
const TICK_SFX: Record<CraftSkill, { name: string; pitch: number; vel: number }> = {
  blacksmithing: { name: 'pick-clink-1', pitch: 0.9, vel: 0.8 },
  cooking: { name: 'clay-squish', pitch: 1.15, vel: 0.7 },
  alchemy: { name: 'fish-splash', pitch: 0.75, vel: 0.45 },
  tailoring: { name: 'herb-pluck', pitch: 1.2, vel: 0.7 }
}

export function initCrafting(api: GameAPI): CraftingModule {
  let inv: InventoryAPI | null = null
  let skills: SkillsAPI | null = null
  let skillTree: SkillTreeAPI | null = null
  let defSource: ((id: string) => ItemDef | undefined) | null = null

  const uiMount = document.getElementById('ui')
  const ui = uiMount ? createCraftingUI(uiMount) : null

  const mod = (key: string): number => {
    if (!skillTree) return 0
    const v = skillTree.modifier(key)
    return Number.isFinite(v) ? v : 0
  }

  const level = (skill: CraftSkill): number => skills?.level(skill) ?? 1
  const count = (id: string): number => inv?.count(id) ?? 0
  // Same reversed-title fallback the inventory uses for off-catalog ids
  // (berry_red → "Red Berry") — the panel never shows raw ids.
  const nameOf = (id: string): string =>
    defSource?.(id)?.name ??
    id
      .split('_')
      .reverse()
      .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
      .join(' ')

  /** '' = unlocked; otherwise the human-readable requirement. */
  const lockReason = (rec: Recipe): string => {
    // A tree node that names this exact output force-unlocks it.
    if (mod(`recipe:${rec.output.id}`) > 0) return ''
    if (level(rec.skill) < rec.levelReq) {
      return `${SKILL_LABEL[rec.skill]} ${rec.levelReq}`
    }
    // Gate flags are auto-granted at their tree level; with the tree wired
    // they must read >0, unwired we fall back to the level check above.
    if (rec.gate && skillTree && mod(rec.gate) <= 0) {
      return `${SKILL_LABEL[rec.skill]} ${rec.levelReq}`
    }
    return ''
  }

  const canAfford = (rec: Recipe): boolean =>
    rec.inputs.every((i) => count(i.id) >= i.qty)

  // -------------------------------------------------------------------------
  // Craft execution
  // -------------------------------------------------------------------------

  interface ActiveCraft {
    station: StationSpot
    recipe: Recipe
    /** Items finished / requested in this batch. */
    done: number
    total: number
    t: number
    dur: number
    nextTickSfxAt: number
    tickAlt: boolean
  }

  let near: StationSpot | null = null
  let openStation: StationSpot | null = null
  let active: ActiveCraft | null = null

  const panelData = (station: StationSpot): CraftPanelData => {
    const skill = SKILL_OF[station.kind]
    const rows: CraftRowView[] = recipesFor(skill).map((rec) => {
      const locked = lockReason(rec)
      return {
        recipeId: rec.id,
        name: nameOf(rec.output.id),
        outQty: rec.output.qty,
        xp: rec.xp,
        inputs: rec.inputs.map((i) => ({
          name: nameOf(i.id),
          have: count(i.id),
          need: i.qty
        })),
        locked,
        lockQuip: locked ? lockedLine(skill) : '',
        craftable: !locked && canAfford(rec)
      }
    })
    return {
      stationName: station.name,
      skillLabel: SKILL_LABEL[skill],
      skillLevel: level(skill),
      rows
    }
  }

  const refreshPanel = (): void => {
    if (openStation) ui?.refreshPanel(panelData(openStation))
  }

  const stopCraft = (): void => {
    active = null
    ui?.progress(NaN)
    ui?.setBusy(false)
  }

  const closePanel = (): void => {
    stopCraft()
    openStation = null
  }

  ui?.onClose(() => {
    stopCraft()
    openStation = null
    audio.sfx.play('ui-close', { vel: 0.6 })
  })

  const openPanel = (station: StationSpot): void => {
    openStation = station
    ui?.openPanel(panelData(station))
    audio.sfx.play('ui-open', { vel: 0.7 })
  }

  const startCraft = (recipeId: string, requested: number): void => {
    if (!openStation || active) return
    const skill = SKILL_OF[openStation.kind]
    const recipe = recipesFor(skill).find((r) => r.id === recipeId)
    if (!recipe) return
    if (lockReason(recipe) !== '') return
    if (!canAfford(recipe)) {
      audio.sfx.play('error-buzz', { vel: 0.6 })
      events.emit('chat:system', { text: `Missing materials for ${nameOf(recipe.output.id)}. The station is not a charity.` })
      return
    }
    const speed = mod(SPEED_KEY[skill])
    const dur = Math.max(MIN_TIME, BASE_TIME / (1 + Math.max(0, speed)))
    active = {
      station: openStation,
      recipe,
      done: 0,
      total: Math.max(1, Math.floor(requested)),
      t: 0,
      dur,
      nextTickSfxAt: 0,
      tickAlt: false
    }
    ui?.setBusy(true)
    ui?.progress(0, progressLabel(active))
  }

  ui?.onCraft((recipeId, n) => startCraft(recipeId, n))

  const progressLabel = (a: ActiveCraft): string =>
    a.total > 1
      ? `Crafting ${nameOf(a.recipe.output.id)} — ${a.done + 1}/${a.total}`
      : `Crafting ${nameOf(a.recipe.output.id)}...`

  /** One finished cycle: consume, produce, xp, chat — all via the bus. */
  const completeCycle = (a: ActiveCraft): void => {
    const rec = a.recipe
    const skill = rec.skill

    // Material-save rolls (smith/tailor talents) reduce ONE unit of the
    // profession's signature input — never below zero, always honest.
    const saveChance =
      skill === 'blacksmithing' ? mod('saveBar')
        : skill === 'tailoring' ? mod('saveCloth')
          : 0
    let saveId: string | null = null
    if (saveChance > 0 && Math.random() < saveChance) {
      const sig =
        skill === 'tailoring'
          ? rec.inputs.find((i) => i.id.startsWith('hide_')) ?? rec.inputs[0]
          : rec.inputs[0]
      if (sig) saveId = sig.id
    }
    for (const i of rec.inputs) {
      const qty = i.id === saveId ? i.qty - 1 : i.qty
      if (qty > 0) events.emit('item:removed', { id: i.id, qty })
    }
    if (saveId) {
      events.emit('chat:system', { text: `Saved one ${nameOf(saveId)}. The scrap bin seethes.` })
    }

    // Cooking can burn (base 10%, melted away by the noBurn talents).
    // The intentional char-grilling recipe is exempt — you can't fail at
    // failing on purpose.
    const burnChance =
      skill === 'cooking' && rec.output.id !== 'food_burnt'
        ? Math.max(0, 0.1 - mod('noBurn'))
        : 0
    if (burnChance > 0 && Math.random() < burnChance) {
      events.emit('item:gained', { id: 'food_burnt', qty: 1, source: 'craft' })
      events.emit('xp:gained', { skill, amount: Math.max(1, Math.round(rec.xp / 2)) })
      events.emit('save:dirty', { why: 'craft' })
      events.emit('chat:system', { text: burntLine() })
      audio.sfx.play('error-buzz', { vel: 0.5, pitch: 0.9 })
      return
    }

    // Output (alchemy talents can squeeze out a bonus batch).
    let outQty = rec.output.qty
    const dbl = skill === 'alchemy' ? mod('doublePotion') : 0
    if (dbl > 0 && Math.random() < dbl) {
      outQty *= 2
      events.emit('chat:system', { text: 'Bonus batch! The cauldron refuses to explain itself.' })
    }
    events.emit('item:gained', { id: rec.output.id, qty: outQty, source: 'craft' })
    events.emit('xp:gained', { skill, amount: rec.xp })
    events.emit('save:dirty', { why: 'craft' })
    audio.sfx.play('equip-clack', { vel: 0.8 })
    const quip = maybeSuccessLine(skill)
    if (quip) events.emit('chat:system', { text: quip })
  }

  // -------------------------------------------------------------------------
  // Interaction plumbing (prompt pill, E key, self-driven ticker)
  // -------------------------------------------------------------------------

  const activate = (): void => {
    if (!ui) return
    if (ui.isOpen()) return
    if (near) openPanel(near)
  }

  ui?.onPromptActivate(activate)

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || (e.key !== 'e' && e.key !== 'E')) return
    const el = document.activeElement
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    ) {
      return
    }
    activate()
  }
  window.addEventListener('keydown', onKeyDown)

  // Keep have/need counts live while the panel is open.
  const offGained = events.on('item:gained', () => refreshPanel())
  const offRemoved = events.on('item:removed', () => refreshPanel())

  const playerPos = api.player.pos
  let raf = 0
  let lastT = performance.now()

  const distSq = (s: StationSpot): number => {
    const dx = s.x - playerPos.x
    const dz = s.z - playerPos.z
    return dx * dx + dz * dz
  }

  const tick = (nowMs: number): void => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min((nowMs - lastT) / 1000, 0.1)
    lastT = nowMs

    // nearest station in range
    let best: StationSpot | null = null
    let bestD = INTERACT_RADIUS * INTERACT_RADIUS
    for (const s of stationSpots()) {
      const d = distSq(s)
      if (d < bestD) {
        bestD = d
        best = s
      }
    }
    near = best

    // prompt pill (hidden while the panel is up)
    if (ui) {
      if (near && !ui.isOpen()) ui.showPrompt(`Use ${near.name}`)
      else ui.hidePrompt()
    }

    // wandered off? the station keeps your place exactly nowhere
    if (openStation && distSq(openStation) > LEAVE_RADIUS * LEAVE_RADIUS) {
      ui?.closePanel() // fires onClose → stopCraft
    }

    // active craft cycle
    if (active) {
      const a = active
      a.t += dt
      if (a.t >= a.nextTickSfxAt) {
        a.nextTickSfxAt += 0.45
        const s = TICK_SFX[a.recipe.skill]
        const name =
          a.recipe.skill === 'blacksmithing'
            ? (a.tickAlt ? 'pick-clink-2' : 'pick-clink-1')
            : s.name
        a.tickAlt = !a.tickAlt
        audio.sfx.play(name, { vel: s.vel, pitch: s.pitch })
      }
      if (a.t >= a.dur) {
        completeCycle(a)
        a.done += 1
        if (a.done >= a.total) {
          stopCraft()
          refreshPanel()
        } else if (!canAfford(a.recipe)) {
          // honest batch stop: the mats ran out mid-run
          audio.sfx.play('error-buzz', { vel: 0.5 })
          events.emit('chat:system', { text: 'Out of materials — the batch stops here. Math remains undefeated.' })
          stopCraft()
          refreshPanel()
        } else {
          a.t = 0
          a.nextTickSfxAt = 0
          ui?.progress(0, progressLabel(a))
          refreshPanel()
          ui?.setBusy(true)
        }
      } else {
        ui?.progress(a.t / a.dur, progressLabel(a))
      }
    }
  }
  raf = requestAnimationFrame(tick)

  return {
    setInventory(i: InventoryAPI): void {
      inv = i
    },
    setSkills(s: SkillsAPI): void {
      skills = s
    },
    setSkillTree(st: SkillTreeAPI): void {
      skillTree = st
    },
    setDefSource(fn: (id: string) => ItemDef | undefined): void {
      defSource = fn
    },
    dispose(): void {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      offGained()
      offRemoved()
      closePanel()
      ui?.dispose()
    }
  }
}
