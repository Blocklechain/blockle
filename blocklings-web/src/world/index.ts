/**
 * Blocklings world module — the KINGDOM OF BEGINNINGS starting village.
 *
 * `createWorld(scene)` builds the whole ~120x120 voxel village (terrain,
 * buildings, river + bridge, tree line, mountains) into a handful of
 * InstancedMeshes (~12 draw calls total) and returns the World contract
 * from ../types plus an `update(dt)` hook that main.ts wires into the
 * frame loop (animated water, flickering window glow).
 */
import * as THREE from 'three'
import type { World } from '../types'
import { VoxelBatch } from './batch'
import { CollisionGrid, SIZE } from './collision'
import { type Ctx } from './layout'
import { makeRng } from './rng'
import { buildGround, buildHorizon, buildWater, markSurfaces } from './terrain'
import { buildNature } from './nature'
import { buildVillage } from './village'

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

  // --- build passes (order matters: surfaces → ground → structures → nature)
  markSurfaces(ctx)
  buildGround(ctx)
  buildVillage(ctx, scene)
  buildNature(ctx, scene)

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
  buildHorizon(scene)

  // --- animation: lapping water + gently flickering window glow
  let t = 0
  const windowMat = windowMesh?.material as THREE.MeshLambertMaterial | undefined

  const world: VillageWorld = {
    // Open plaza, south of the well and clear of the market stall's awning.
    spawn: new THREE.Vector3(0.5, 0, 5.5),

    isBlocked(x: number, z: number): boolean {
      return ctx.grid.isBlocked(x, z)
    },

    // Flat kingdom for now — API-ready for hills later.
    groundHeight(_x: number, _z: number): number {
      return 0
    },

    update(dt: number): void {
      t += dt
      water.mesh.position.y = -0.22 + Math.sin(t * 1.3) * 0.045
      water.material.opacity = 0.78 + Math.sin(t * 0.9 + 1.7) * 0.06
      if (windowMat) {
        windowMat.emissiveIntensity = 0.85 + Math.sin(t * 2.1) * 0.08 + Math.sin(t * 5.3) * 0.04
      }
    }
  }

  return world
}
