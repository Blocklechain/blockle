/**
 * Gathering professions — ore veins, trees, fishing spots, herb patches,
 * berry bushes, mushroom clusters, clay pits and farm plots scattered
 * biome-appropriately across the continent — heart regions eagerly, the
 * 90 streamed wilderness zones on residency (registerZoneNodes + a
 * regionAt poll fallback), ~10-18 nodes per zone, deterministic per zone.
 *
 * Flow: walk up to a node → prompt pill ([E] / tap) → harvest bar with
 * arm swings → 'gather:done' + 'item:gained' (source 'gather') +
 * 'xp:gained' on the node's skill → the node DEPLETES with juice:
 * trees topple and leave a stump, ore mounds crumble into rubble, fish
 * rings pause and shrink, plants/clay wilt or empty — then regrow/pop
 * back on a per-kind respawn timer. Better picks/hatchets shorten the
 * bar; skill-tree gatherSpeed/doubleOre modifiers apply when wired.
 *
 * Contract compliance: items flow ONLY via 'item:gained' (the inventory
 * module applies it); tool reads come through setInventory(); the swing
 * animation comes through setSwing(); talent modifiers through
 * setSkillTree() (all integrator-wired).
 */
import * as THREE from 'three'
import type { GameAPI, InventoryAPI, SkillTreeAPI } from '../types'
import { events } from '../events'
import { MATERIALS, NODE_KINDS } from '../ids'
// PURE lookups only (sanctioned): zone defs + side-effect-free regionAt.
import { regionOrZoneAt } from '../world/index'
import { ZONES, type ZoneDef } from '../world/zones/registry'
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
import { makeGatherRng, placeNodes, placeZoneNodes } from './placement'
import { createGatherUI, type GatherPromptUI } from './ui'
import { maybeSuccessLine, noToolLine, underTierLine } from './flavor'

export interface GatherModule {
  /** Wire the inventory so tool gating can read the equipped 'tool' slot. */
  setInventory(inv: InventoryAPI): void
  /** Wire the player's arm-swing (integrator passes player.triggerAttack). */
  setSwing(fn: () => void): void
  /** Wire talent trees (gatherSpeed / doubleOre modifiers). Optional. */
  setSkillTree(st: SkillTreeAPI): void
  /**
   * Streamed-zone residency hook: place the zone's nodes (idempotent,
   * deterministic per zone id). The integrator calls this from stream
   * residency; an internal regionAt poll also calls it for whatever
   * zone the player is standing in, so it works unwired too.
   */
  registerZoneNodes(zoneId: string): void
  /** Placed-node tally per region/zone id (debug/balance peek). */
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
  /** The prop batch this node lives in (heart or a zone batch). */
  props: NodeProps
  /** Stand/interact anchor (cell center). */
  x: number
  z: number
  prop: number
  harvested: boolean
  respawnAt: number
}

/** Hide a zone's prop batch beyond this distance from the player. */
const ZONE_PROP_VIS = 320

export function initGather(api: GameAPI): GatherModule {
  const kinds = new Map<string, KindDef>()
  for (const k of NODE_KINDS) kinds.set(k.id, k)

  const rng = makeGatherRng(0x6a7e4)
  const heartProps = new NodeProps()
  const nodes: LiveNode[] = []

  const pushNode = (
    batch: NodeProps,
    kindId: string,
    x: number,
    z: number,
    prop: number
  ): void => {
    const kind = kinds.get(kindId)
    const tune = TUNING[kindId]
    if (!kind || !tune) return
    nodes.push({ kind, tune, props: batch, x, z, prop, harvested: false, respawnAt: 0 })
  }

  // --- heart regions: eager, exactly as before -----------------------------
  const placement = placeNodes(api.world, rng)
  const regionCounts: Record<string, number> = placement.regionCounts
  for (const p of placement.nodes) {
    if (!kinds.has(p.kindId) || !TUNING[p.kindId]) continue
    const prop = heartProps.addNode(p.boxes, p.px, p.py, p.pz)
    pushNode(heartProps, p.kindId, p.x, p.z, prop)
  }
  heartProps.build(api.scene)

  // --- streamed zones: density pass on residency ---------------------------
  const zoneIndex = new Map<string, ZoneDef>(ZONES.map((z) => [z.id, z]))
  const registeredZones = new Set<string>()
  const pendingZones: { zone: ZoneDef; at: number }[] = []
  const zoneBatches: { zone: ZoneDef; props: NodeProps; visible: boolean }[] = []

  const buildZone = (zone: ZoneDef): void => {
    const placed = placeZoneNodes(api.world, zone, nodes)
    if (placed.length === 0) {
      regionCounts[zone.id] = regionCounts[zone.id] ?? 0
      return
    }
    const batch = new NodeProps()
    for (const p of placed) {
      if (!kinds.has(p.kindId) || !TUNING[p.kindId]) continue
      const prop = batch.addNode(p.boxes, p.px, p.py, p.pz)
      pushNode(batch, p.kindId, p.x, p.z, prop)
    }
    batch.build(api.scene)
    zoneBatches.push({ zone, props: batch, visible: true })
    regionCounts[zone.id] = (regionCounts[zone.id] ?? 0) + placed.length
  }

  const registerZoneNodes = (zoneId: string): void => {
    if (registeredZones.has(zoneId)) return
    const zone = zoneIndex.get(zoneId)
    if (!zone) return // heart region / unknown id — nothing to do
    registeredZones.add(zoneId)
    // small grace so the zone's streamed collision/ground finishes baking
    pendingZones.push({ zone, at: performance.now() / 1000 + 1.2 })
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  const uiMount = document.getElementById('ui')
  const ui: GatherPromptUI | null = uiMount ? createGatherUI(uiMount) : null

  let inv: InventoryAPI | null = null
  let swing: (() => void) | null = null
  let skillTree: SkillTreeAPI | null = null

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
    if (n.kind.id === 'fishing_spot') base = 'Fish the Water'
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

  /** Summed talent modifier, defensively (API may not be wired yet). */
  const mod = (key: string): number => {
    if (!skillTree) return 0
    const v = skillTree.modifier(key)
    return Number.isFinite(v) ? v : 0
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
    let dur = Math.max(MIN_TIME, BASE_TIME - check.bonusTiers * TIME_PER_TIER)
    // skill tree: 'gatherSpeed' (global) + '<skill>.speed' (per profession)
    const speed = mod('gatherSpeed') + mod(`${n.kind.skill}.speed`)
    if (speed > 0) dur = Math.max(0.45, dur / (1 + speed))
    gatherDur = dur
    nextSwingAt = 0
    ui?.progress(0)
  }

  const completeGather = (n: LiveNode): void => {
    cancelGather()
    const now = performance.now() / 1000
    n.harvested = true
    const [rMin, rMax] = n.tune.respawn ?? [RESPAWN_MIN, RESPAWN_MAX]
    n.respawnAt = now + rMin + rng() * (rMax - rMin)
    n.props.deplete(n.prop, n.tune.style, now)

    // skill tree: 'doubleOre' (mining) + '<skill>.double' (any profession)
    let qty = n.tune.qty
    const dblChance =
      mod(`${n.kind.skill}.double`) + (n.kind.skill === 'mining' ? mod('doubleOre') : 0)
    if (dblChance > 0 && Math.random() < dblChance) qty *= 2

    events.emit('item:gained', { id: n.kind.itemId, qty, source: 'gather' })
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
  // Self-driven ticker (prompt, progress, respawns, animations, zone poll)
  // -------------------------------------------------------------------------

  const playerPos: THREE.Vector3 = api.player.pos
  let raf = 0
  let lastT = performance.now()
  let nextZonePollAt = 0

  /** Distance² from the player to a zone's rect (0 when inside). */
  const zoneDistSq = (z: ZoneDef): number => {
    const dx = Math.max(z.x0 - playerPos.x, 0, playerPos.x - z.x1)
    const dz = Math.max(z.z0 - playerPos.z, 0, playerPos.z - z.z1)
    return dx * dx + dz * dz
  }

  const tick = (nowMs: number): void => {
    raf = requestAnimationFrame(tick)
    const now = nowMs / 1000
    const dt = Math.min((nowMs - lastT) / 1000, 0.1)
    lastT = nowMs

    // zone residency poll (1 Hz): register the zone under the player's feet
    // + toggle far zone batches invisible so evicted terrain isn't haunted
    // by floating trees.
    if (now >= nextZonePollAt) {
      nextZonePollAt = now + 1.0
      const here = regionOrZoneAt(playerPos.x, playerPos.z)
      if (here && zoneIndex.has(here.id)) registerZoneNodes(here.id)
      for (const b of zoneBatches) {
        const vis = zoneDistSq(b.zone) < ZONE_PROP_VIS * ZONE_PROP_VIS
        if (vis !== b.visible) {
          b.visible = vis
          b.props.setVisible(vis)
        }
      }
    }

    // deferred zone builds (placed after the stream has had time to bake)
    if (pendingZones.length > 0 && pendingZones[0] && now >= pendingZones[0].at) {
      const next = pendingZones.shift()
      if (next) buildZone(next.zone)
    }

    // respawns — regrow pop via props.restore
    for (const n of nodes) {
      if (n.harvested && now >= n.respawnAt) {
        n.harvested = false
        n.props.restore(n.prop, n.tune.style, now)
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

    heartProps.update(now)
    for (const b of zoneBatches) if (b.visible) b.props.update(now)
  }
  raf = requestAnimationFrame(tick)

  return {
    setInventory(i: InventoryAPI): void {
      inv = i
    },
    setSwing(fn: () => void): void {
      swing = fn
    },
    setSkillTree(st: SkillTreeAPI): void {
      skillTree = st
    },
    registerZoneNodes,
    counts(): Readonly<Record<string, number>> {
      return regionCounts
    },
    dispose(): void {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
      heartProps.dispose(api.scene)
      for (const b of zoneBatches) b.props.dispose(api.scene)
      ui?.dispose()
    }
  }
}
