/**
 * Blocklings world module — the 1440x1440 CONTINENT: the loved hand-built
 * 6-region HEART (|x|,|z| <= 240, village at the origin) eagerly built and
 * always resident, exactly as before, ringed by 90 streamed wilderness
 * zones out to the coast (see ./stream + ./zones/registry).
 *
 * `createWorld(scene)` runs the EAGER build passes in this order:
 *   1. blockOpenSea  — permanent collision on the open ocean past the coast
 *   2. markSurfaces  — village plaza/roads/river/farm + BOTH bridges
 *   3. paintRoads    — village↔waystone cobble + the 8 compass ARTERIALS
 *                      stamped out to ~±680 (zones render them on arrival)
 *   4. buildVillage  — the original village, exactly as-built
 *   5. buildNature   — village tree ring/flowers + distant island peaks
 *   6. buildBorders  — tree-line/rock/hedge region transitions (road gaps)
 *   7. buildRegions  — the five heart region builders
 *   8. buildGround   — instances the HEART's ground only; streamed zones
 *                      paint their own rects via streamGroundPass
 * then bakes every batch into one InstancedMesh each, adds the animated
 * river + ocean water and the sea-floor horizon, and starts the ZoneStream
 * (~4ms/frame build budget, radius-260 residency, +60 eviction hysteresis).
 *
 * This module emits NOTHING on the event bus; the integrator wires
 * 'region:entered' using the re-exported `regionAt` (heart regions + zones).
 */
import * as THREE from 'three'
import type { World } from '../types'
import { VoxelBatch } from './batch'
import { CollisionGrid, SIZE } from './collision'
import { type Ctx } from './layout'
import { makeRng } from './rng'
import {
  blockOpenSea,
  buildGround,
  buildHorizon,
  buildOcean,
  buildWater,
  markSurfaces
} from './terrain'
import { buildNature } from './nature'
import { buildVillage } from './village'
import { paintRoads } from './roads'
import { buildBorders } from './borders'
import { buildRegions } from './regions'
import { ZoneStream, setStreamFocus, zoneAt, zoneWindowMat } from './stream'
import { publishSurface } from './surface'
import { regionAt as heartRegionAt, REGIONS, type RegionDef } from '../ids'
import type { ZoneDef } from './zones/registry'

export { REGIONS }
export { setStreamFocus, registerZoneBuilder, streamGroundPass, zoneAt } from './stream'

/**
 * ZONE-BUILDER PLUMBING — the zones barrel imports all 15 batch files (each
 * registers its six builders via registerZoneBuilder at import time) and the
 * explicit call re-runs the hooks once more (idempotent, last-write-wins).
 * All 90 builders are therefore registered before any ZoneStream exists;
 * builders only RUN when their zone streams in.
 */
import { registerAllZoneBatches } from './zones/index'
registerAllZoneBatches()

/**
 * Region/zone lookup across the WHOLE 1440x1440 world: the 6 heart regions
 * first (their edges win, exactly as before), then the 90 outer-ring zones.
 * Both carry { id, name, biome, minLevel, maxLevel } so the HUD banner and
 * 'region:entered' wiring work unchanged.
 *
 * SIDE CHANNEL, by design: main.ts polls regionAt with the PLAYER's position
 * every ~0.5s — that poll doubles as the zone-stream focus, so streaming
 * tracks the player with zero integrator changes. Cinematics can override
 * with setStreamFocus (re-exported above) at any time.
 */
export function regionAt(x: number, z: number): RegionDef | ZoneDef | null {
  setStreamFocus(x, z)
  return heartRegionAt(x, z) ?? zoneAt(x, z)
}

/**
 * PURE region/zone lookup — identical result to `regionAt` but with NO
 * stream-focus side channel. Spawners, placement passes and AI steering
 * probe arbitrary world points every frame; they MUST use this one, or
 * their probes would yank zone streaming away from the player.
 */
export function regionOrZoneAt(x: number, z: number): RegionDef | ZoneDef | null {
  return heartRegionAt(x, z) ?? zoneAt(x, z)
}

/** World + per-frame animation hook (main.ts auto-hooks `update`). */
export interface VillageWorld extends World {
  update(dt: number): void
  /**
   * The shared emissive glow materials (village windows + the streamed-zone
   * window material) — integrator wiring for the atmosphere night ramp.
   */
  glowMaterials: readonly THREE.MeshLambertMaterial[]
}

let streamRef: ZoneStream | null = null

/** Zone-stream debug counts (resident zones, queued work steps). */
export function streamDebug(): { resident: number; queued: number } {
  return streamRef?.debug() ?? { resident: 0, queued: 0 }
}

export function createWorld(scene: THREE.Scene): VillageWorld {
  const ctx: Ctx = {
    rng: makeRng(0xb10c1e),
    grid: new CollisionGrid(),
    surface: new Uint8Array(SIZE * SIZE),
    batches: {
      grass: new VoxelBatch(),
      path: new VoxelBatch(),
      stone: new VoxelBatch(),
      wood: new VoxelBatch(),
      plaster: new VoxelBatch(),
      roof: new VoxelBatch(),
      window: new VoxelBatch(),
      leaf: new VoxelBatch(),
      misc: new VoxelBatch()
    }
  }

  // --- build passes (surface stamps first, ground instancing LAST)
  publishSurface(ctx.surface) // read-only overlay sampling (see ./surface)
  blockOpenSea(ctx.grid) // open ocean blocked from frame one (permanent)
  markSurfaces(ctx)
  paintRoads(ctx) // village routes + the 8 arterials, stamped world-wide
  buildVillage(ctx, scene)
  buildNature(ctx, scene)
  buildBorders(ctx, scene)
  buildRegions(ctx, scene)
  buildGround(ctx)

  // --- bake each batch into one InstancedMesh (one draw call each)
  const b = ctx.batches
  const bake = (
    batch: VoxelBatch,
    opts: Parameters<VoxelBatch['build']>[0]
  ): THREE.InstancedMesh | null => {
    const mesh = batch.build(opts)
    if (mesh) scene.add(mesh)
    return mesh
  }

  bake(b.grass, { receiveShadow: true })
  bake(b.path, { receiveShadow: true })
  bake(b.stone, { castShadow: true, receiveShadow: true })
  bake(b.wood, { castShadow: true, receiveShadow: true })
  bake(b.plaster, { castShadow: true, receiveShadow: true })
  bake(b.roof, { castShadow: true, receiveShadow: true })
  bake(b.leaf, { castShadow: true, receiveShadow: true })
  bake(b.misc, { castShadow: true, receiveShadow: true })
  const windowMesh = bake(b.window, {
    emissive: 0xffa94d,
    emissiveIntensity: 0.85,
    castShadow: false,
    receiveShadow: false
  })

  const water = buildWater(scene)
  const ocean = buildOcean(scene)
  buildHorizon(scene)

  // --- the 90 outer-ring zones stream in/out around the focus from here on
  const stream = new ZoneStream(scene, ctx.grid, ctx.surface)
  streamRef = stream

  // --- animation: lapping river + rolling ocean + flickering window glow
  let t = 0
  const windowMat = windowMesh?.material as THREE.MeshLambertMaterial | undefined

  const world: VillageWorld = {
    // Open plaza, south of the well and clear of the market stall's awning.
    spawn: new THREE.Vector3(0.5, 0, 5.5),

    glowMaterials: windowMat ? [windowMat, zoneWindowMat] : [zoneWindowMat],

    isBlocked(x: number, z: number): boolean {
      return ctx.grid.isBlocked(x, z)
    },

    // Flat continent for now — API-ready for hills later.
    groundHeight(_x: number, _z: number): number {
      return 0
    },

    update(dt: number): void {
      t += dt
      stream.update(dt) // residency scan + ≤4ms of budgeted zone build/bake
      water.mesh.position.y = -0.22 + Math.sin(t * 1.3) * 0.045
      water.material.opacity = 0.78 + Math.sin(t * 0.9 + 1.7) * 0.06
      ocean.mesh.position.y = -0.42 + Math.sin(t * 0.6) * 0.05
      ocean.material.opacity = 0.85 + Math.sin(t * 0.5 + 0.8) * 0.05
      if (windowMat) {
        windowMat.emissiveIntensity = 0.85 + Math.sin(t * 2.1) * 0.08 + Math.sin(t * 5.3) * 0.04
      }
    }
  }

  return world
}
