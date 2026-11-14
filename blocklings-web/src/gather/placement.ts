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
import type { ZoneDef } from '../world/zones/registry'
import { BIOME_NODES, CLUSTERS, FIXED } from './data'
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

// ---------------------------------------------------------------------------
// Streamed-zone density pass
// ---------------------------------------------------------------------------

/**
 * Place one streamed zone's biome-appropriate nodes (~10-18, from
 * data.ts BIOME_NODES). Deterministic: the rng is seeded from the zone
 * id, so every client lays the same zone out identically regardless of
 * visit order. `taken` are anchors of already-placed nodes (heart +
 * other zones) for spacing.
 *
 * Fishing spots need a WATERLINE cell: a walkable low cell with a
 * blocked 4-neighbour (the sea/lagoon edge); the ring offsets over the
 * blocked side. Land kinds just need a free, spaced cell.
 */
export function placeZoneNodes(
  world: World,
  zone: ZoneDef,
  taken: readonly { x: number; z: number }[]
): PlacedNode[] {
  const mixes = BIOME_NODES[zone.biome] ?? []
  if (mixes.length === 0) return []
  const rng = makeGatherRng(hashZoneId(zone.id))
  const out: PlacedNode[] = []

  const MARGIN = 6
  const x0 = zone.x0 + MARGIN
  const x1 = zone.x1 - MARGIN
  const z0 = zone.z0 + MARGIN
  const z1 = zone.z1 - MARGIN

  const spacedOk = (x: number, z: number): boolean => {
    for (const n of out) {
      const dx = n.x - x
      const dz = n.z - z
      if (dx * dx + dz * dz < 4 * 4) return false
    }
    for (const n of taken) {
      const dx = n.x - x
      const dz = n.z - z
      if (dx * dx + dz * dz < 2.5 * 2.5) return false
    }
    return true
  }

  const sampleCell = (): { x: number; z: number } => ({
    x: Math.floor(x0 + rng() * (x1 - x0)) + 0.5,
    z: Math.floor(z0 + rng() * (z1 - z0)) + 0.5
  })

  for (const mix of mixes) {
    const want = mix.min + Math.floor(rng() * (mix.max - mix.min + 1))
    let placed = 0
    for (let attempt = 0; attempt < 90 && placed < want; attempt++) {
      const { x, z } = sampleCell()
      if (world.isBlocked(x, z) || !spacedOk(x, z)) continue

      if (mix.water) {
        // shoreline only: low ground with a blocked 4-neighbour to ring over
        if (world.groundHeight(x, z) > 0.6) continue
        const dirs = [
          [1, 0], [-1, 0], [0, 1], [0, -1]
        ] as const
        let ox = 0
        let oz = 0
        for (const [dx, dz] of dirs) {
          if (world.isBlocked(x + dx, z + dz)) {
            ox = dx * 1.6
            oz = dz * 1.6
            break
          }
        }
        if (ox === 0 && oz === 0) continue
        out.push({
          kindId: mix.kind,
          x, z,
          px: x + ox,
          py: -0.14,
          pz: z + oz,
          boxes: buildKindBoxes(mix.kind, rng)
        })
      } else {
        out.push({
          kindId: mix.kind,
          x, z,
          px: x,
          py: world.groundHeight(x, z),
          pz: z,
          boxes: buildKindBoxes(mix.kind, rng)
        })
      }
      placed++
    }
  }
  return out
}

/** Stable 32-bit hash of a zone id (placement seed). */
export function hashZoneId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
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
