/**
 * Gathering professions — ore veins, trees, fishing spots, herb patches
 * and farm plots scattered biome-appropriately across the continent.
 *
 * Flow: walk up to a node → prompt pill ([E] / tap) → 1.8s harvest bar
 * with arm swings → 'gather:done' + 'item:gained' (source 'gather') +
 * 'xp:gained' on the node's skill → node hides to a stump/bare rock and
 * respawns ~30s later. Better picks/hatchets shorten the bar and unlock
 * the gold/crystal tiers; under-tooled attempts get mocked in chat.
 *
 * Contract compliance: items flow ONLY via 'item:gained' (the inventory
 * module applies it); tool reads come through setInventory(); the swing
 * animation comes through setSwing() (integrator wires player.triggerAttack).
 */
import * as THREE from 'three'
import type { GameAPI, InventoryAPI } from '../types'
import { events } from '../events'
import { MATERIALS, NODE_KINDS } from '../ids'
import {
  BASE_TIME,
  INTERACT_RADIUS,
  MIN_TIME,
  RESPAWN_MAX,
  RESPAWN_MIN,
  TIME_PER_TIER,
  TUNING,
  parseTool,
  type KindTuning
} from './data'
import { NodeProps } from './props'
import { makeGatherRng, placeNodes } from './placement'
import { createGatherUI, type GatherPromptUI } from './ui'
import { maybeSuccessLine, noToolLine, underTierLine } from './flavor'

export interface GatherModule {
  /** Wire the inventory so tool gating can read the equipped 'tool' slot. */
  setInventory(inv: InventoryAPI): void
  /** Wire the player's arm-swing (integrator passes player.triggerAttack). */
  setSwing(fn: () => void): void
  /** Placed-node tally per region id (debug/balance peek). */
  counts(): Readonly<Record<string, number>>
  dispose(): void
}

interface KindDef {
  id: string
  skill: string
  itemId: string
  name: string
}

interface LiveNode {
  kind: KindDef
  tune: KindTuning
  /** Stand/interact anchor (cell center). */
  x: number
  z: number
  prop: number
  harvested: boolean
  respawnAt: number
}

export function initGather(api: GameAPI): GatherModule {
  const kinds = new Map<string, KindDef>()
  for (const k of NODE_KINDS) kinds.set(k.id, k)

  const rng = makeGatherRng(0x6a7e4)
  const props = new NodeProps()
  const nodes: LiveNode[] = []

  const placement = placeNodes(api.world, rng)
  const regionCounts = placement.regionCounts
  for (const p of placement.nodes) {
    const kind = kinds.get(p.kindId)
    const tune = TUNING[p.kindId]
    if (!kind || !tune) continue
    const prop = props.addNode(p.boxes, p.px, p.py, p.pz)
    nodes.push({ kind, tune, x: p.x, z: p.z, prop, harvested: false, respawnAt: 0 })
  }

  props.build(api.scene)

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  const uiMount = document.getElementById('ui')
  const ui: GatherPromptUI | null = uiMount ? createGatherUI(uiMount) : null

  let inv: InventoryAPI | null = null
  let swing: (() => void) | null = null

  let near: LiveNode | null = null
  let active: LiveNode | null = null
  let gatherT = 0
  let gatherDur = BASE_TIME
  let nextSwingAt = 0
  let lastSassAt = 0

  /** Equipped-tool check: ok | missing-tool | tier-too-low (+ speed tiers). */
  const toolCheck = (
    tune: KindTuning
  ): { ok: boolean; reason: 'none' | 'missing' | 'tier'; bonusTiers: number } => {
    if (!tune.tool) return { ok: true, reason: 'none', bonusTiers: 0 }
    const tool = parseTool(inv?.equipment()['tool'])
    if (!tool || tool.family !== tune.tool) return { ok: false, reason: 'missing', bonusTiers: 0 }
    if (tune.tool !== 'rod' && tool.tier < tune.minTier) {
      return { ok: false, reason: 'tier', bonusTiers: 0 }
    }
    return { ok: true, reason: 'none', bonusTiers: Math.max(0, tool.tier - tune.minTier) }
  }

  const promptLabel = (n: LiveNode, check: ReturnType<typeof toolCheck>): string => {
    let base: string
    if (n.kind.id === 'fishing_spot') base = 'Fish the River'
    else if (n.kind.id === 'farm_plot') base = 'Harvest Wheat'
    else base = `${n.tune.verb} ${n.kind.name}`
    if (check.ok) return base
    if (check.reason === 'missing') {
      return `${base} — needs a ${n.tune.tool === 'rod' ? 'fishing rod' : n.tune.tool}`
    }
    return `${base} — needs a ${MATERIALS[n.tune.minTier] ?? 'better'} ${n.tune.tool}`
  }

  const cancelGather = (): void => {
    active = null
    ui?.progress(NaN)
  }

  const startGather = (n: LiveNode): void => {
    const check = toolCheck(n.tune)
    const now = performance.now() / 1000
    if (!check.ok) {
      if (now - lastSassAt > 1.5 && n.tune.tool) {
        lastSassAt = now
        events.emit('chat:system', {
          text: check.reason === 'missing' ? noToolLine(n.tune.tool) : underTierLine(n.tune.tool)
        })
      }
      return
    }
    active = n
    gatherT = 0
    gatherDur = Math.max(MIN_TIME, BASE_TIME - check.bonusTiers * TIME_PER_TIER)
    nextSwingAt = 0
    ui?.progress(0)
  }

  const completeGather = (n: LiveNode): void => {
    cancelGather()
    n.harvested = true
    n.respawnAt =
      performance.now() / 1000 + RESPAWN_MIN + rng() * (RESPAWN_MAX - RESPAWN_MIN)
    props.setHarvested(n.prop, true)
    events.emit('item:gained', { id: n.kind.itemId, qty: n.tune.qty, source: 'gather' })
    events.emit('xp:gained', { skill: n.kind.skill, amount: n.tune.xp })
    events.emit('gather:done', { nodeType: n.kind.id, itemId: n.kind.itemId, skill: n.kind.skill })
    const quip = maybeSuccessLine(n.kind.skill)
    if (quip) events.emit('chat:system', { text: quip })
  }

  const activate = (): void => {
    if (active) return
    if (near) startGather(near)
  }

  ui?.onActivate(activate)

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

  // -------------------------------------------------------------------------
  // Self-driven ticker (prompt, progress, respawns, bob/sparkle)
  // -------------------------------------------------------------------------

  const playerPos: THREE.Vector3 = api.player.pos
  let raf = 0
  let lastT = performance.now()

  const tick = (nowMs: number): void => {
    raf = requestAnimationFrame(tick)
    const now = nowMs / 1000
    const dt = Math.min((nowMs - lastT) / 1000, 0.1)
    lastT = nowMs

    // respawns
    for (const n of nodes) {
      if (n.harvested && now >= n.respawnAt) {
        n.harvested = false
        props.setHarvested(n.prop, false)
      }
    }

    // nearest interactable
    let best: LiveNode | null = null
    let bestD = INTERACT_RADIUS * INTERACT_RADIUS
    for (const n of nodes) {
      if (n.harvested) continue
      const dx = n.x - playerPos.x
      const dz = n.z - playerPos.z
      const d = dx * dx + dz * dz
      if (d < bestD) {
        bestD = d
        best = n
      }
    }
    near = best

    // active harvest: cancel on wander, finish on full bar
    if (active) {
      const dx = active.x - playerPos.x
      const dz = active.z - playerPos.z
      const gone = dx * dx + dz * dz > (INTERACT_RADIUS + 0.6) ** 2
      if (gone || api.player.moving) {
        cancelGather()
      } else {
        gatherT += dt
        if (gatherT >= nextSwingAt) {
          nextSwingAt += 0.6
          swing?.()
        }
        if (gatherT >= gatherDur) completeGather(active)
        else ui?.progress(gatherT / gatherDur)
      }
    }

    // prompt pill
    if (ui) {
      const show = active ?? near
      if (show) {
        const check = toolCheck(show.tune)
        ui.show(promptLabel(show, check), !check.ok)
      } else {
        ui.hide()
      }
    }

    props.update(now, (i) => nodes[i]?.harvested ?? false)
  }
  raf = requestAnimationFrame(tick)

  return {
    setInventory(i: InventoryAPI): void {
      inv = i
    },
    setSwing(fn: () => void): void {
      swing = fn
    },
    counts(): Readonly<Record<string, number>> {
      return regionCounts
    },
    dispose(): void {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      ui?.dispose()
    }
  }
}
