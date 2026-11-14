/**
 * Quest guide — the glowing "follow the sparkles" trail.
 *
 * Three jobs, one module:
 *   1. OBJECTIVE RESOLVER — turns the tracked quest/contract's CURRENT step
 *      into a world-space target. Honesty rule: 'exact' only when we truly
 *      know the spot (NPC anchors, live gather nodes via a registered
 *      provider); everything inferred from biome/level-band tables is 'area'
 *      and guides to the region, never pretending precision.
 *   2. PATHFINDING — coarse A* over the global walkability grid downsampled
 *      4x (360x360 cells over the 1440-unit continent), with a road bias
 *      (cobble/bridge cells cost 0.45 vs 1 for open ground) so trails
 *      naturally follow the King's roads. Capped at ~20k node expansions;
 *      straight-line chain fallback; string-pulled smooth; recomputed at
 *      most every 2s or when the player moves >6 units.
 *   3. RENDER — ONE InstancedMesh (one draw call, no lights): small additive
 *      gold-green orbs every ~2.5 units along the next ~80 units of path,
 *      bobbing/pulsing/fading in, plus a taller pulsing beacon column at the
 *      final target (same instanced mesh, stretched instance — pokes above
 *      walls). Quest completion fires the orbs off as a little firework,
 *      then untracks with a comedy line.
 *
 * Tracking state lives in ./tracking (one id, persisted via the 'quests'
 * save blob in ./index); Track/Untrack pills live in ./panel + ./board.
 */
import * as THREE from 'three'
import type { GameAPI, QuestDef, QuestStep } from '../types'
import { events } from '../events'
import { BOSSES, NPCS, NODE_KINDS, REGIONS } from '../ids'
import { ZONES } from '../world/zones/registry'
import { surfaceTypeAt, S_COBBLE, S_BRIDGE } from '../world/surface'
// PURE data tables only (same sanctioned-leaf precedent as world/surface):
// where gather nodes live, per biome + the hand-placed heart clusters.
import { BIOME_NODES, CLUSTERS, FIXED } from '../gather/data'
import { questsApi } from './index'
import { contractsApi } from './contracts'
import { trackedId, setTracked, onTrackedChange } from './tracking'

// ---------------------------------------------------------------------------
// Species/boss venue tables — DUPLICATED from the combat module's private
// REGION_MIX / BIOME_MIX / BOSS_DENS (weights dropped; membership is all the
// resolver needs). Modules must not import each other, so the data is carried
// here — the same precedent as worldmap/data.ts mirroring the road waypoints.
// If combat's mixes ever change, update this copy to match.
// ---------------------------------------------------------------------------

/** Heart region id -> species that spawn there. */
const SPECIES_REGIONS: Readonly<Record<string, readonly string[]>> = {
  beginnings: ['slime', 'mushroom', 'crab'],
  greenwood: ['wolf', 'goblin', 'spider', 'slime', 'mushroom'],
  ironhold: ['bat', 'goblin', 'wolf', 'bandit', 'golem'],
  ashen: ['skeleton', 'imp', 'bat', 'spider', 'wisp'],
  forgotten: ['orc', 'golem', 'wisp', 'bandit', 'skeleton'],
}

/** Wilderness biome -> species that spawn there (the 90 streamed zones). */
const SPECIES_BIOMES: Readonly<Record<string, readonly string[]>> = {
  meadow: ['slime', 'mushroom', 'crab', 'wolf'],
  forest: ['wolf', 'goblin', 'spider', 'mushroom'],
  mountain: ['golem', 'bat', 'wolf', 'bandit'],
  dungeon: ['skeleton', 'bat', 'imp', 'spider'],
  city: ['bandit', 'goblin', 'skeleton'],
  wastes: ['orc', 'bandit', 'skeleton', 'golem'],
  swamp: ['slime', 'spider', 'mushroom', 'wisp'],
  desert: ['crab', 'bandit', 'skeleton', 'orc'],
  tundra: ['wolf', 'bat', 'golem', 'wisp'],
  volcanic: ['imp', 'golem', 'skeleton', 'bat'],
  crystal: ['wisp', 'golem', 'bat', 'slime'],
  ruins: ['skeleton', 'bandit', 'wisp', 'spider'],
  beach: ['crab', 'slime', 'bandit'],
  mushroom: ['mushroom', 'slime', 'spider'],
  cherry: ['slime', 'wolf', 'goblin', 'wisp'],
  savanna: ['wolf', 'crab', 'orc', 'bandit'],
  canyon: ['bat', 'bandit', 'golem', 'orc'],
  lagoon: ['crab', 'slime', 'wisp'],
  graveyard: ['skeleton', 'wisp', 'bat'],
  glacier: ['wolf', 'golem', 'wisp', 'bat'],
}

/** Boss lair anchors (combat's fixed dens, same duplication precedent). */
const BOSS_DENS: Readonly<Record<string, { x: number; z: number }>> = {
  boss_greenwood: { x: 200, z: 70 },
  boss_ironhold: { x: -200, z: 70 },
  boss_ashen: { x: -170, z: 200 },
  boss_forgotten: { x: 170, z: 205 },
}

// ---------------------------------------------------------------------------
// Objective resolver
// ---------------------------------------------------------------------------

export interface StepTarget {
  x: number
  z: number
  /** 'exact' = we know the spot; 'area' = we guide to the hosting region. */
  confidence: 'exact' | 'area'
}

/**
 * Optional live gather-node positions, (kindId) -> un-harvested node anchors.
 * The gather module keeps its nodes private today; if an integrator ever
 * exposes them, registering a provider upgrades gather steps to 'exact'.
 */
export type GuideNodeProvider = (kindId: string) => readonly { x: number; z: number }[]
let nodeProvider: GuideNodeProvider | null = null
export function setGuideNodeProvider(fn: GuideNodeProvider | null): void {
  nodeProvider = fn
}

interface Rect {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** Distance from a point to a rect (0 inside) — nearest-candidate picking. */
function rectDist(px: number, pz: number, r: Rect): number {
  const dx = Math.max(r.x0 - px, 0, px - r.x1)
  const dz = Math.max(r.z0 - pz, 0, pz - r.z1)
  return Math.hypot(dx, dz)
}

function rectCenter(r: Rect): { x: number; z: number } {
  return { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }
}

/** Heart region or wilderness zone rect by id (explore targets use both). */
function areaById(id: string): Rect | null {
  const region = REGIONS.find((r) => r.id === id)
  if (region) return region
  const zone = ZONES.find((z) => z.id === id)
  return zone ?? null
}

type Candidate = { x: number; z: number; d: number; confidence: 'exact' | 'area' }

function best(cands: Candidate[]): StepTarget | null {
  if (cands.length === 0) return null
  let b = cands[0]!
  for (const c of cands) if (c.d < b.d) b = c
  return { x: b.x, z: b.z, confidence: b.confidence }
}

/** Candidates for "where does gather-node kind `kind` live". */
function gatherCandidates(kind: string, px: number, pz: number): Candidate[] {
  const out: Candidate[] = []
  // live nodes, when a provider is registered — the only 'exact' gather path
  if (nodeProvider) {
    for (const n of nodeProvider(kind)) {
      out.push({ x: n.x, z: n.z, d: Math.hypot(n.x - px, n.z - pz), confidence: 'exact' })
    }
    if (out.length > 0) return out
  }
  // heart clusters + fixed anchors (authored placement data; nodes scatter
  // within cluster radius / nudge off blockers, so honestly 'area')
  for (const c of CLUSTERS) {
    if (c.kind === kind) {
      out.push({ x: c.cx, z: c.cz, d: Math.hypot(c.cx - px, c.cz - pz), confidence: 'area' })
    }
  }
  for (const f of FIXED) {
    if (f.kind === kind) {
      out.push({ x: f.x, z: f.z, d: Math.hypot(f.x - px, f.z - pz), confidence: 'area' })
    }
  }
  // wilderness zones whose biome mix hosts the kind
  for (const z of ZONES) {
    const mix = BIOME_NODES[z.biome]
    if (!mix || !mix.some((m) => m.kind === kind)) continue
    const c = rectCenter(z)
    out.push({ x: c.x, z: c.z, d: rectDist(px, pz, z), confidence: 'area' })
  }
  return out
}

/** Candidates for "where does species `sp` spawn". */
function speciesCandidates(sp: string, px: number, pz: number): Candidate[] {
  const out: Candidate[] = []
  for (const r of REGIONS) {
    if (!SPECIES_REGIONS[r.id]?.includes(sp)) continue
    const c = rectCenter(r)
    out.push({ x: c.x, z: c.z, d: rectDist(px, pz, r), confidence: 'area' })
  }
  for (const z of ZONES) {
    if (!SPECIES_BIOMES[z.biome]?.includes(sp)) continue
    const c = rectCenter(z)
    out.push({ x: c.x, z: c.z, d: rectDist(px, pz, z), confidence: 'area' })
  }
  return out
}

/**
 * Resolve a quest step's CURRENT objective to a world target, nearest
 * candidate to the player. Null = we honestly don't know (no trail).
 */
export function resolveStepTarget(
  step: QuestStep,
  px: number,
  pz: number
): StepTarget | null {
  switch (step.kind) {
    case 'talk': {
      const npc = NPCS.find((n) => n.id === step.target)
      return npc ? { x: npc.x, z: npc.z, confidence: 'exact' } : null
    }
    case 'explore': {
      const area = areaById(step.target)
      if (!area) return null
      const c = rectCenter(area)
      return { x: c.x, z: c.z, confidence: 'area' }
    }
    case 'gather':
      return best(gatherCandidates(step.target, px, pz))
    case 'kill': {
      if (step.target.startsWith('boss_')) {
        const den = BOSS_DENS[step.target]
        const boss = BOSSES.find((b) => b.id === step.target)
        if (den) return { x: den.x, z: den.z, confidence: 'area' }
        return boss ? best(speciesCandidates(boss.species, px, pz)) : null
      }
      return best(speciesCandidates(step.target, px, pz))
    }
    case 'collect': {
      // Collect = bring N of an item. If a gather node yields it, guide to
      // the nodes; if it's named after a species ('hide_wolf'...), guide to
      // the species; otherwise we'd be guessing — no trail, honestly.
      const node = NODE_KINDS.find((n) => n.itemId === step.target)
      if (node) return best(gatherCandidates(node.id, px, pz))
      const suffix = step.target.slice(step.target.lastIndexOf('_') + 1)
      if (suffix && speciesKnown(suffix)) return best(speciesCandidates(suffix, px, pz))
      return null
    }
  }
}

function speciesKnown(sp: string): boolean {
  for (const list of Object.values(SPECIES_REGIONS)) if (list.includes(sp)) return true
  for (const list of Object.values(SPECIES_BIOMES)) if (list.includes(sp)) return true
  return false
}

// ---------------------------------------------------------------------------
// Coarse A* over the walkability grid (4x downsample, road-biased)
// ---------------------------------------------------------------------------

const CELL = 4 // world units per coarse cell
const GHALF = 180 // coarse cells per half-axis -> 360x360 grid
const GSIZE = GHALF * 2
const ROAD_COST = 0.45 // cobble/bridge cells — trails hug the roads
const OPEN_COST = 1
const MAX_EXPAND = 20_000 // A* node-expansion cap
const SQRT2 = Math.SQRT2

/** Per-search cell-cost memo (0 = unknown, -1 = blocked, else cost). */
const costMemo = new Float32Array(GSIZE * GSIZE)
const costGen = new Int32Array(GSIZE * GSIZE)
let gen = 0

let worldRef: GameAPI['world'] | null = null

function cellIdx(cx: number, cz: number): number {
  return cx + GHALF + (cz + GHALF) * GSIZE
}

/** Movement cost of a coarse cell: ROAD_COST | OPEN_COST | Infinity. */
function cellCost(cx: number, cz: number): number {
  if (cx < -GHALF || cx >= GHALF || cz < -GHALF || cz >= GHALF) return Infinity
  const i = cellIdx(cx, cz)
  if (costGen[i] === gen) {
    const m = costMemo[i]!
    return m < 0 ? Infinity : m
  }
  const w = worldRef
  let walkable = false
  let road = false
  if (w) {
    // 2x2 subsample of the 4x4-unit cell: walkable if ANY column is open,
    // road-priced if ANY sampled column is cobble or a bridge deck.
    for (let sz = 1; sz <= 3; sz += 2) {
      for (let sx = 1; sx <= 3; sx += 2) {
        const x = cx * CELL + sx
        const z = cz * CELL + sz
        if (!w.isBlocked(x, z)) {
          walkable = true
          const s = surfaceTypeAt(x, z)
          if (s === S_COBBLE || s === S_BRIDGE) road = true
        }
      }
    }
  }
  const cost = !walkable ? -1 : road ? ROAD_COST : OPEN_COST
  costGen[i] = gen
  costMemo[i] = cost
  return cost < 0 ? Infinity : cost
}

/** Octile-distance heuristic, scaled by the cheapest per-cell cost. */
function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx)
  const dz = Math.abs(az - bz)
  return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * ROAD_COST
}

/** Tiny binary min-heap over (f, cellIndex) pairs. */
class Heap {
  private f: number[] = []
  private v: number[] = []
  size(): number {
    return this.f.length
  }
  push(f: number, v: number): void {
    const fa = this.f
    const va = this.v
    let i = fa.length
    fa.push(f)
    va.push(v)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (fa[p]! <= fa[i]!) break
      ;[fa[p], fa[i]] = [fa[i]!, fa[p]!]
      ;[va[p], va[i]] = [va[i]!, va[p]!]
      i = p
    }
  }
  pop(): number {
    const fa = this.f
    const va = this.v
    const top = va[0]!
    const lf = fa.pop()!
    const lv = va.pop()!
    if (fa.length > 0) {
      fa[0] = lf
      va[0] = lv
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < fa.length && fa[l]! < fa[m]!) m = l
        if (r < fa.length && fa[r]! < fa[m]!) m = r
        if (m === i) break
        ;[fa[m], fa[i]] = [fa[i]!, fa[m]!]
        ;[va[m], va[i]] = [va[i]!, va[m]!]
        i = m
      }
    }
    return top
  }
}

/** Nearest walkable coarse cell to (cx, cz) within `r` rings (spiral). */
function nearestWalkable(cx: number, cz: number, r: number): { cx: number; cz: number } | null {
  if (cellCost(cx, cz) < Infinity) return { cx, cz }
  for (let ring = 1; ring <= r; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
        if (cellCost(cx + dx, cz + dz) < Infinity) return { cx: cx + dx, cz: cz + dz }
      }
    }
  }
  return null
}

const NBR: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
]

/**
 * Road-biased A* from world (sx,sz) to (tx,tz). Returns a smoothed world
 * polyline, or null when no path survives the expansion cap (caller falls
 * back to a straight chain).
 */
function findPath(sx: number, sz: number, tx: number, tz: number): { x: number; z: number }[] | null {
  gen++ // fresh memo per search (world streams in; marks are additive)
  const start = nearestWalkable(Math.floor(sx / CELL), Math.floor(sz / CELL), 4)
  const goal = nearestWalkable(Math.floor(tx / CELL), Math.floor(tz / CELL), 12)
  if (!start || !goal) return null

  const open = new Heap()
  const gScore = new Map<number, number>()
  const cameFrom = new Map<number, number>()
  const closed = new Set<number>()
  const si = cellIdx(start.cx, start.cz)
  const gi = cellIdx(goal.cx, goal.cz)
  gScore.set(si, 0)
  open.push(heuristic(start.cx, start.cz, goal.cx, goal.cz), si)

  let expanded = 0
  let found = false
  while (open.size() > 0) {
    const cur = open.pop()
    if (closed.has(cur)) continue
    closed.add(cur)
    if (cur === gi) {
      found = true
      break
    }
    if (++expanded > MAX_EXPAND) break
    const cx = (cur % GSIZE) - GHALF
    const cz = Math.floor(cur / GSIZE) - GHALF
    const g = gScore.get(cur)!
    for (const [dx, dz] of NBR) {
      const nx = cx + dx
      const nz = cz + dz
      const c = cellCost(nx, nz)
      if (c === Infinity) continue
      // no diagonal corner-cutting through blocked cells
      if (dx !== 0 && dz !== 0) {
        if (cellCost(cx + dx, cz) === Infinity || cellCost(cx, cz + dz) === Infinity) continue
      }
      const ni = cellIdx(nx, nz)
      if (closed.has(ni)) continue
      const ng = g + c * (dx !== 0 && dz !== 0 ? SQRT2 : 1)
      const old = gScore.get(ni)
      if (old !== undefined && old <= ng) continue
      gScore.set(ni, ng)
      cameFrom.set(ni, cur)
      open.push(ng + heuristic(nx, nz, goal.cx, goal.cz), ni)
    }
  }
  if (!found) return null

  // reconstruct (cell centers), goal -> start, then reverse
  const cells: { cx: number; cz: number }[] = []
  let at: number | undefined = gi
  while (at !== undefined) {
    cells.push({ cx: (at % GSIZE) - GHALF, cz: Math.floor(at / GSIZE) - GHALF })
    at = cameFrom.get(at)
  }
  cells.reverse()

  // string-pulling over the coarse cells: greedily keep the farthest
  // line-of-sight waypoint so trails cut clean corners along roads
  const pts = cells.map((c) => ({ x: c.cx * CELL + CELL / 2, z: c.cz * CELL + CELL / 2 }))
  const smooth: { x: number; z: number }[] = []
  let i = 0
  smooth.push(pts[0]!)
  while (i < pts.length - 1) {
    let j = pts.length - 1
    for (; j > i + 1; j--) {
      if (losClear(pts[i]!.x, pts[i]!.z, pts[j]!.x, pts[j]!.z)) break
    }
    smooth.push(pts[j]!)
    i = j
  }
  return smooth
}

/** Line-of-sight across walkable coarse cells (samples every ~2 units). */
function losClear(x0: number, z0: number, x1: number, z1: number): boolean {
  const dist = Math.hypot(x1 - x0, z1 - z0)
  const steps = Math.max(1, Math.ceil(dist / 2))
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    const x = x0 + (x1 - x0) * t
    const z = z0 + (z1 - z0) * t
    if (cellCost(Math.floor(x / CELL), Math.floor(z / CELL)) === Infinity) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Tracked-step lookup (book quests via ./index, contracts via ./contracts)
// ---------------------------------------------------------------------------

function currentTrackedStep(): { def: QuestDef; step: QuestStep } | null {
  const id = trackedId()
  if (!id) return null
  if (id.startsWith('contract:')) {
    const st = contractsApi.status(id)
    if (st.state !== 'active') return null
    const def = contractsApi.today().find((d) => d.id === id)
    const step = def?.steps[st.step]
    return def && step ? { def, step } : null
  }
  for (const a of questsApi.active()) {
    if (a.def.id === id) {
      const step = a.def.steps[a.step]
      return step ? { def: a.def, step } : null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Trail + beacon render (one InstancedMesh, one draw call, no lights)
// ---------------------------------------------------------------------------

const ORB_SPACING = 2.5 // world units between orbs
const TRAIL_SPAN = 80 // guide the next ~80 units of path
const ORB_MAX = 32 // 80 / 2.5
const INST_CAP = ORB_MAX + 1 // + the beacon column
const GOLD = new THREE.Color(0xe8c15a) // the UI gold
const GREEN = new THREE.Color(0x9fdd62) // leaning gold-green down the trail
const RECOMPUTE_MS = 2000
const MOVE_RECOMPUTE = 6 // world units
const FIREWORK_S = 1.15

const COMPLETE_LINES = [
  'The sparkles burst into fireworks, take a bow, and clock out. Union rules.',
  'Guide trail complete. The sparkles have gone home to their sparkle families.',
  'The sparkles explode with pride. They billed hourly, by the way.',
] as const

let inited = false

export function initQuestGuide(api: GameAPI): void {
  if (inited) return
  inited = true
  worldRef = api.world

  // --- instanced mesh --------------------------------------------------------
  const geo = new THREE.OctahedronGeometry(0.3)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, INST_CAP)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false // instances span up to 80 units of trail
  mesh.count = 0
  // touch every instance color once so instanceColor exists before render
  const white = new THREE.Color(1, 1, 1)
  for (let i = 0; i < INST_CAP; i++) mesh.setColorAt(i, white)
  if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
  api.scene.add(mesh)

  const m4 = new THREE.Matrix4()
  const col = new THREE.Color()

  // --- live state ------------------------------------------------------------
  interface Orb {
    x: number
    y: number
    z: number
    /** Seconds (performance.now()/1000) this orb starts fading in. */
    bornAt: number
  }
  let orbs: Orb[] = []
  let beacon: { x: number; y: number; z: number; confidence: 'exact' | 'area' } | null = null
  let target: StepTarget | null = null
  let pathAnchor = { x: 0, z: 0 } // player pos at last compute
  let lastComputeAt = 0
  let forceCompute = false
  let fireworks: { x: number; y: number; z: number; vx: number; vy: number; vz: number }[] = []
  let fireworkUntil = 0

  const groundY = (x: number, z: number): number => api.world.groundHeight(x, z)

  // --- path -> orb chain -----------------------------------------------------
  function rebuildTrail(now: number): void {
    const resolved = currentTrackedStep()
    const px = api.player.pos.x
    const pz = api.player.pos.z
    target = resolved ? resolveStepTarget(resolved.step, px, pz) : null
    pathAnchor = { x: px, z: pz }
    lastComputeAt = now
    if (!target) {
      orbs = []
      beacon = null
      return
    }

    let line = findPath(px, pz, target.x, target.z)
    if (!line || line.length === 0) {
      // straight line-of-sight chain fallback — honest about not knowing a
      // walkable route, still points the way
      line = [
        { x: px, z: pz },
        { x: target.x, z: target.z },
      ]
    } else {
      line[0] = { x: px, z: pz } // anchor at the player's feet
      line.push({ x: target.x, z: target.z })
    }

    // sample orbs every ORB_SPACING along the polyline, next TRAIL_SPAN units
    const next: Orb[] = []
    let travelled = 0
    let carry = ORB_SPACING // skip the orb directly underfoot
    outer: for (let s = 0; s < line.length - 1; s++) {
      const a = line[s]!
      const b = line[s + 1]!
      const segLen = Math.hypot(b.x - a.x, b.z - a.z)
      if (segLen <= 1e-4) continue
      let along = carry
      while (along < segLen) {
        const t = along / segLen
        const x = a.x + (b.x - a.x) * t
        const z = a.z + (b.z - a.z) * t
        next.push({ x, y: groundY(x, z), z, bornAt: now + next.length * 0.045 })
        travelled += ORB_SPACING
        if (next.length >= ORB_MAX || travelled >= TRAIL_SPAN) break outer
        along += ORB_SPACING
      }
      carry = along - segLen
    }
    // keep already-visible orbs from re-fading on every recompute
    for (let i = 0; i < next.length && i < orbs.length; i++) next[i]!.bornAt = orbs[i]!.bornAt
    orbs = next
    beacon = {
      x: target.x,
      y: groundY(target.x, target.z),
      z: target.z,
      confidence: target.confidence,
    }
  }

  // --- per-frame animation ---------------------------------------------------
  function draw(now: number): void {
    let n = 0

    if (fireworks.length > 0 && now < fireworkUntil) {
      // completion firework: orbs scatter up + out and fade
      const left = fireworkUntil - now
      const t = 1 - left / FIREWORK_S
      for (const f of fireworks) {
        const x = f.x + f.vx * t * 7
        const y = f.y + f.vy * t * 7 - 4.5 * t * t
        const z = f.z + f.vz * t * 7
        m4.makeScale(1, 1, 1)
        m4.setPosition(x, y, z)
        mesh.setMatrixAt(n, m4)
        col.copy(GOLD).multiplyScalar(Math.max(0, 1 - t) * 1.4)
        mesh.setColorAt(n, col)
        n++
      }
    } else if (fireworks.length > 0) {
      fireworks = []
    } else {
      // trail orbs: bob + pulse + staggered fade-in, gold -> green down-trail
      for (let i = 0; i < orbs.length; i++) {
        const o = orbs[i]!
        const fade = Math.min(1, Math.max(0, (now - o.bornAt) / 0.35))
        if (fade <= 0) continue
        const bob = Math.sin(now * 2.4 + i * 0.7) * 0.16
        const pulse = 0.85 + 0.2 * Math.sin(now * 3.1 - i * 0.9)
        m4.makeScale(pulse, pulse, pulse)
        m4.setPosition(o.x, o.y + 0.6 + bob, o.z)
        mesh.setMatrixAt(n, m4)
        col.copy(GOLD).lerp(GREEN, (i / ORB_MAX) * 0.6).multiplyScalar(fade * pulse)
        mesh.setColorAt(n, col)
        n++
      }
      // beacon: tall pulsing column at the target, high enough to show over
      // walls ('area' targets get a wider, softer column — region, not spot)
      if (beacon) {
        const area = beacon.confidence === 'area'
        const p = 0.8 + 0.25 * Math.sin(now * 2.2)
        const girth = (area ? 2.2 : 1.2) * p
        const h = 30 // octahedron r=0.3 -> ~18-unit column
        m4.makeScale(girth, h, girth)
        m4.setPosition(beacon.x, beacon.y + h * 0.3, beacon.z)
        mesh.setMatrixAt(n, m4)
        col.copy(GOLD).multiplyScalar((area ? 0.4 : 0.6) * p)
        mesh.setColorAt(n, col)
        n++
      }
    }

    mesh.count = n
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  // --- drive -----------------------------------------------------------------
  let raf = 0
  const tick = (): void => {
    raf = requestAnimationFrame(tick)
    void raf // guide lives for the page's lifetime
    const now = performance.now() / 1000
    const tracked = trackedId()

    if (fireworks.length === 0) {
      if (!tracked) {
        if (orbs.length > 0 || beacon) {
          orbs = []
          beacon = null
          target = null
        }
      } else {
        const moved = Math.hypot(api.player.pos.x - pathAnchor.x, api.player.pos.z - pathAnchor.z)
        const stale = (now - lastComputeAt) * 1000
        if (forceCompute || stale >= RECOMPUTE_MS || (moved > MOVE_RECOMPUTE && stale >= 400)) {
          forceCompute = false
          rebuildTrail(now)
          // tracked thing no longer exists (abandoned contract, stale save
          // id...) — quietly let go
          if (!target && !currentTrackedStep()) setTracked(null)
        }
      }
    }
    draw(now)
  }
  raf = requestAnimationFrame(tick)

  // --- events ----------------------------------------------------------------
  onTrackedChange(() => {
    forceCompute = true
    orbs = []
  })

  // auto-advance: tracked step completed -> retarget the next step
  events.on('quest:progress', ({ questId }) => {
    if (questId === trackedId()) forceCompute = true
  })

  // quest completion: firework fade at the beacon + comedy untrack
  events.on('quest:completed', ({ questId }) => {
    if (questId !== trackedId()) return
    const at = beacon ?? {
      x: api.player.pos.x,
      y: groundY(api.player.pos.x, api.player.pos.z),
      z: api.player.pos.z,
    }
    fireworks = []
    for (let i = 0; i < 24; i++) {
      const ang = (i / 24) * Math.PI * 2
      const up = 0.55 + ((i * 37) % 10) / 18
      fireworks.push({
        x: at.x,
        y: at.y + 1.2,
        z: at.z,
        vx: Math.cos(ang) * (0.5 + ((i * 13) % 7) / 10),
        vy: up,
        vz: Math.sin(ang) * (0.5 + ((i * 29) % 7) / 10),
      })
    }
    fireworkUntil = performance.now() / 1000 + FIREWORK_S
    orbs = []
    beacon = null
    setTracked(null)
    events.emit('chat:system', {
      text: COMPLETE_LINES[Math.floor(Math.random() * COMPLETE_LINES.length)]!,
    })
  })
}
