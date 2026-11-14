/**
 * Terrain pass — classifies every ground cell (grass / cobble / river /
 * bridge / soil / sand), then instances the ground voxels, the river bed,
 * the bridge deck and the water plane.
 */
import * as THREE from 'three'
import {
  BRIDGE,
  BUILDINGS,
  DUMMY_YARD,
  FARM,
  FENCE_R,
  PLAZA_RADIUS,
  RIVER_X0,
  RIVER_X1,
  S_BANK,
  S_BRIDGE,
  S_COBBLE,
  S_RIVER,
  S_SAND,
  S_SOIL,
  setSurface,
  setSurfaceRect,
  surfaceAt,
  type Ctx
} from './layout'
import * as P from './palette'
import { HALF } from './collision'

/** Stamp all surface types into ctx.surface. Order matters (later wins). */
export function markSurfaces(ctx: Ctx): void {
  // Central plaza — round cobbled square
  for (let ix = -PLAZA_RADIUS; ix <= PLAZA_RADIUS; ix++) {
    for (let iz = -PLAZA_RADIUS; iz <= PLAZA_RADIUS; iz++) {
      const cx = ix + 0.5
      const cz = iz + 0.5
      if (cx * cx + cz * cz < PLAZA_RADIUS * PLAZA_RADIUS) setSurface(ctx, ix, iz, S_COBBLE)
    }
  }

  // Main roads: north-south between the gates, west gate to the bridge
  setSurfaceRect(ctx, { x0: -1, z0: -FENCE_R - 2, w: 3, d: 2 * FENCE_R + 5 }, S_COBBLE)
  setSurfaceRect(ctx, { x0: -FENCE_R - 2, z0: -1, w: FENCE_R + 2 + RIVER_X0, d: 3 }, S_COBBLE)

  // Door spurs
  for (const b of BUILDINGS) {
    if (b.spur) setSurfaceRect(ctx, b.spur, S_COBBLE)
  }

  // Training yard — packed sand
  setSurfaceRect(ctx, DUMMY_YARD, S_SAND)

  // Farm — tilled soil
  setSurfaceRect(ctx, FARM, S_SOIL)

  // River along the east edge, with grassy-sand banks
  for (let iz = -HALF; iz < HALF; iz++) {
    setSurface(ctx, RIVER_X0 - 1, iz, S_BANK)
    setSurface(ctx, RIVER_X1 + 1, iz, S_BANK)
    for (let ix = RIVER_X0; ix <= RIVER_X1; ix++) setSurface(ctx, ix, iz, S_RIVER)
  }

  // Bridge deck overrides the river
  setSurfaceRect(ctx, BRIDGE, S_BRIDGE)
}

/** Instance the ground from the surface map; blocks river cells. */
export function buildGround(ctx: Ctx): void {
  const { rng, grid, batches } = ctx
  for (let ix = -HALF; ix < HALF; ix++) {
    for (let iz = -HALF; iz < HALF; iz++) {
      const s = surfaceAt(ctx, ix, iz)
      switch (s) {
        case S_COBBLE:
          batches.path.voxel(ix, -1, iz, rng.pick(P.COBBLE))
          break
        case S_RIVER:
          // sunken river bed (water plane floats above it)
          batches.grass.add(ix, -1, iz, 1, 0.42, 1, P.RIVERBED)
          grid.block(ix, iz)
          break
        case S_BANK:
          batches.grass.voxel(ix, -1, iz, rng.pick(P.SAND))
          break
        case S_SOIL:
          batches.path.voxel(ix, -1, iz, P.SOIL)
          break
        case S_SAND:
          batches.path.voxel(ix, -1, iz, rng.pick(P.SAND))
          break
        case S_BRIDGE: {
          // wooden deck at walking height; outer rows carry the railings
          batches.wood.voxel(ix, -1, iz, rng.pick(P.WOOD))
          const isRail = iz === BRIDGE.z0 || iz === BRIDGE.z0 + BRIDGE.d - 1
          if (isRail) {
            grid.block(ix, iz)
            if ((ix - BRIDGE.x0) % 3 === 0) {
              batches.wood.add(ix + 0.35, 0, iz + 0.35, 0.3, 1.1, 0.3, P.WOOD_DARK)
            }
            batches.wood.add(ix, 0.75, iz + 0.38, 1, 0.18, 0.24, P.WOOD_DARK)
          }
          break
        }
        default: {
          // grass with occasional darker patches
          const c = rng.next() < 0.08 ? P.GRASS_DARK : rng.pick(P.GRASS)
          batches.grass.voxel(ix, -1, iz, c)
        }
      }
    }
  }
}

export interface WaterRefs {
  mesh: THREE.Mesh
  material: THREE.MeshLambertMaterial
}

/** Translucent animated water plane over the river bed. */
export function buildWater(scene: THREE.Scene): WaterRefs {
  const w = RIVER_X1 - RIVER_X0 + 1
  const material = new THREE.MeshLambertMaterial({
    color: P.WATER,
    transparent: true,
    opacity: 0.78
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, HALF * 2), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(RIVER_X0 + w / 2, -0.22, 0)
  mesh.receiveShadow = true
  scene.add(mesh)
  return { mesh, material }
}

/** Big flat horizon plane so the world doesn't float in the sky. */
export function buildHorizon(scene: THREE.Scene): void {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.MeshLambertMaterial({ color: 0x4c8443 })
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = -0.03
  mesh.receiveShadow = true
  scene.add(mesh)
}
