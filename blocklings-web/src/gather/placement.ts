/**
 * Node placement — pure (no scene, no DOM) so it can be unit-sanity-run
 * headlessly against the real world's collision grid. Deterministic for a
 * given rng; index.ts feeds the result into NodeProps + the interaction
 * layer.
 */
import type { World } from '../types'
// PURE heart-region + streamed-zone lookup (no stream-focus side channel),
// so regionCounts attribute correctly across the whole 1440x1440 continent.
import { regionOrZoneAt as regionAt } from '../world/index'
import { CLUSTERS, FIXED } from './data'
import { buildKindBoxes, type BoxSpec } from './props'

export interface PlacedNode {
  kindId: string
  /** Stand/interact anchor (cell center). */
  x: number
  z: number
  /** Prop world position (fish rings float offset over the water). */
  px: number
  py: number
  pz: number
  boxes: BoxSpec[]
}

export interface PlacementResult {
  nodes: PlacedNode[]
  /** regionId -> nodes placed there. */
  regionCounts: Record<string, number>
  /** kindId -> nodes placed. */
  kindCounts: Record<string, number>
}

export function placeNodes(world: World, rng: () => number): PlacementResult {
  const nodes: PlacedNode[] = []
  const regionCounts: Record<string, number> = {}
  const kindCounts: Record<string, number> = {}

  const freeAt = (x: number, z: number): boolean => !world.isBlocked(x, z)

  const spacedOk = (x: number, z: number): boolean => {
    for (const n of nodes) {
      const dx = n.x - x
      const dz = n.z - z
      if (dx * dx + dz * dz < 2.5 * 2.5) return false
    }
    return true
  }

  const place = (kindId: string, x: number, z: number, ox: number, oz: number): void => {
    const onWater = ox !== 0 || oz !== 0
    nodes.push({
      kindId,
      x,
      z,
      px: x + ox,
      py: onWater ? -0.14 : world.groundHeight(x, z),
      pz: z + oz,
      boxes: buildKindBoxes(kindId, rng)
    })
    const region = regionAt(x, z)
    if (region) regionCounts[region.id] = (regionCounts[region.id] ?? 0) + 1
    kindCounts[kindId] = (kindCounts[kindId] ?? 0) + 1
  }

  // Clustered nodes (ore/trees/herbs): rejection-sample walkable cells.
  for (const c of CLUSTERS) {
    let placed = 0
    for (let attempt = 0; attempt < 70 && placed < c.count; attempt++) {
      const ang = rng() * Math.PI * 2
      const rad = Math.sqrt(rng()) * c.r
      const x = Math.floor(c.cx + Math.cos(ang) * rad) + 0.5
      const z = Math.floor(c.cz + Math.sin(ang) * rad) + 0.5
      if (!freeAt(x, z) || !spacedOk(x, z)) continue
      place(c.kind, x, z, 0, 0)
      placed++
    }
  }

  // Fixed anchors (fishing banks, farm plots): nudge along z off blockers.
  for (const f of FIXED) {
    const x = f.x + 0.5
    let z = f.z + 0.5
    let ok = freeAt(x, z) && spacedOk(x, z)
    for (let dz = 1; !ok && dz <= 4; dz++) {
      for (const s of [dz, -dz]) {
        if (freeAt(x, f.z + s + 0.5) && spacedOk(x, f.z + s + 0.5)) {
          z = f.z + s + 0.5
          ok = true
          break
        }
      }
    }
    if (!ok) continue
    place(f.kind, x, z, f.ox ?? 0, f.oz ?? 0)
  }

  return { nodes, regionCounts, kindCounts }
}

/** Deterministic rng so the world lays out identically every boot. */
export function makeGatherRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
