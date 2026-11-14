/**
 * Blocklings world module — the 480x480 OPEN CONTINENT, with the loved
 * hand-built KINGDOM OF BEGINNINGS village untouched at its heart.
 *
 * `createWorld(scene)` runs the build passes in this order:
 *   1. markSurfaces  — village plaza/roads/river/farm + BOTH bridges
 *   2. paintRoads    — winding cobble from the village to every waystone
 *   3. buildVillage  — the original village, exactly as-built
 *   4. buildNature   — village tree ring/flowers + distant island peaks
 *   5. buildBorders  — tree-line/rock/hedge region transitions (road gaps)
 *   6. buildRegions  — the five region builders (stubs until their agents
 *                      land) — they may still stamp surfaces here
 *   7. buildGround   — instances the whole continent's ground from the
 *                      surface map with per-region biome palettes
 * then bakes every batch into one InstancedMesh each and adds the animated
 * river + ocean water and the sea-floor horizon.
 *
 * This module emits NOTHING on the event bus; the integrator wires
 * 'region:entered' using the re-exported `regionAt`.
 */
import * as THREE from 'three'
import type { World } from '../types'
import { VoxelBatch } from './batch'
import { CollisionGrid, SIZE } from './collision'
import { type Ctx } from './layout'
import { makeRng } from './rng'
import { buildGround, buildHorizon, buildOcean, buildWater, markSurfaces } from './terrain'
import { buildNature } from './nature'
import { buildVillage } from './village'
import { paintRoads } from './roads'
import { buildBorders } from './borders'
import { buildRegions } from './regions'

export { regionAt, REGIONS } from '../ids'

/** World + per-frame animation hook (main.ts auto-hooks `update`). */
export interface VillageWorld extends World {
  update(dt: number): void
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
  markSurfaces(ctx)
  paintRoads(ctx)
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

  // --- animation: lapping river + rolling ocean + flickering window glow
  let t = 0
  const windowMat = windowMesh?.material as THREE.MeshLambertMaterial | undefined

  const world: VillageWorld = {
    // Open plaza, south of the well and clear of the market stall's awning.
    spawn: new THREE.Vector3(0.5, 0, 5.5),

    isBlocked(x: number, z: number): boolean {
      return ctx.grid.isBlocked(x, z)
    },

    // Flat continent for now — API-ready for hills later.
    groundHeight(_x: number, _z: number): number {
      return 0
    },

    update(dt: number): void {
      t += dt
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
