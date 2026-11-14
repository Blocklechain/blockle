/**
 * Terrain pass — the whole 480x480 continent. The village core keeps its
 * exact per-cell surfaces (grass / cobble / river / bridge / soil / sand);
 * the lands beyond are painted with per-region biome palettes (REGIONS in
 * ../ids): meadow greens, deep mossy forest, grey-brown mountain with snow
 * near the rim, pale Capital flagstone, charcoal dungeon floor with ember
 * flecks (they share the flickering window batch), purple-grey wastes.
 * Region borders dither into each other; the coast gets sand beaches; the
 * NW/NE corners are ocean bays. Also builds the river bed, BOTH bridge
 * decks, the animated river + ocean water and the sea-floor horizon.
 */
import * as THREE from 'three'
import { regionAt } from '../ids'
import {
  BRIDGES,
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
  S_GRASS,
  S_RIVER,
  S_SAND,
  S_SOIL,
  VILLAGE_HALF,
  setSurface,
  setSurfaceRect,
  surfaceAt,
  type Ctx
} from './layout'
import * as P from './palette'
import { BIOME_GROUND, EMBER, FOREST_MOSS, isLand } from './kit'
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

  // River flowing sea-to-sea down the east side, with grassy-sand banks
  for (let iz = -HALF; iz < HALF; iz++) {
    setSurface(ctx, RIVER_X0 - 1, iz, S_BANK)
    setSurface(ctx, RIVER_X1 + 1, iz, S_BANK)
    for (let ix = RIVER_X0; ix <= RIVER_X1; ix++) setSurface(ctx, ix, iz, S_RIVER)
  }

  // Bridge decks override the river (village bridge + the south crossing)
  for (const b of BRIDGES) setSurfaceRect(ctx, b, S_BRIDGE)
}

/** Base ground color for a cell, from its region biome (dithered borders). */
function groundColor(ctx: Ctx, ix: number, iz: number): number {
  const { rng } = ctx
  // beaches: sand wherever the sea is a couple of cells away
  if (
    !isLand(ix + 3, iz) || !isLand(ix - 3, iz) || !isLand(ix, iz + 3) || !isLand(ix, iz - 3) ||
    !isLand(ix + 2, iz + 2) || !isLand(ix - 2, iz - 2) || !isLand(ix + 2, iz - 2) || !isLand(ix - 2, iz + 2)
  ) {
    return rng.pick(P.SAND)
  }
  // jittered region sample → soft dithered transitions at every border
  const r = regionAt(ix + 0.5 + rng.range(-2.5, 2.5), iz + 0.5 + rng.range(-2.5, 2.5))
  const biome = r?.biome ?? 'meadow'
  switch (biome) {
    case 'meadow':
      return rng.next() < 0.08 ? P.GRASS_DARK : rng.pick(P.GRASS)
    case 'forest':
      return rng.next() < 0.14 ? FOREST_MOSS : rng.pick(BIOME_GROUND['forest']!)
    case 'mountain': {
      // snow caps creeping in from the continent rim
      const rim = HALF - Math.max(Math.abs(ix), Math.abs(iz))
      if (rim < 16 && rng.next() < (16 - rim) / 16) return P.SNOW
      return rng.pick(BIOME_GROUND['mountain']!)
    }
    default:
      return rng.pick(BIOME_GROUND[biome]!)
  }
}

/** Rare glowing ember fleck on dungeon ground (shares the window flicker). */
function maybeEmber(ctx: Ctx, x: number, z: number, span: number, p: number): void {
  const { rng, batches } = ctx
  if (rng.next() >= p) return
  const reg = regionAt(x + span / 2, z + span / 2)
  if (reg?.biome !== 'dungeon') return
  batches.window.add(
    x + rng.range(0.1, span - 0.45),
    0,
    z + rng.range(0.1, span - 0.45),
    0.3,
    0.14,
    0.3,
    EMBER
  )
}

/** Instance a single ground cell from the surface map. */
function paintCell(ctx: Ctx, ix: number, iz: number): void {
  const { rng, grid, batches } = ctx
  if (!isLand(ix + 0.5, iz + 0.5)) {
    grid.block(ix, iz) // open sea — no ground voxel
    return
  }
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
      const b = BRIDGES.find(
        (r) => ix >= r.x0 && ix < r.x0 + r.w && iz >= r.z0 && iz < r.z0 + r.d
      )
      if (b) {
        const isRail = iz === b.z0 || iz === b.z0 + b.d - 1
        if (isRail) {
          grid.block(ix, iz)
          if ((ix - b.x0) % 3 === 0) {
            batches.wood.add(ix + 0.35, 0, iz + 0.35, 0.3, 1.1, 0.3, P.WOOD_DARK)
          }
          batches.wood.add(ix, 0.75, iz + 0.38, 1, 0.18, 0.24, P.WOOD_DARK)
        }
      }
      break
    }
    default:
      batches.grass.voxel(ix, -1, iz, groundColor(ctx, ix, iz))
      maybeEmber(ctx, ix, iz, 1, 0.01)
  }
}

/**
 * Instance the whole continent's ground. The village core (±VILLAGE_HALF)
 * stays per-cell; beyond it, uniform-grass 2x2 blocks collapse into single
 * instances (≈4x fewer ground instances with the same dappled look).
 */
export function buildGround(ctx: Ctx): void {
  for (let mx = -HALF; mx < HALF; mx += 2) {
    for (let mz = -HALF; mz < HALF; mz += 2) {
      const inVillage =
        mx >= -VILLAGE_HALF && mx < VILLAGE_HALF && mz >= -VILLAGE_HALF && mz < VILLAGE_HALF
      let macro = !inVillage
      let land = 0
      if (macro) {
        for (let d = 0; d < 4; d++) {
          const ix = mx + (d & 1)
          const iz = mz + (d >> 1)
          if (surfaceAt(ctx, ix, iz) !== S_GRASS) {
            macro = false
            break
          }
          if (isLand(ix + 0.5, iz + 0.5)) land++
        }
        if (macro && land !== 0 && land !== 4) macro = false // shoreline → per-cell
      }
      if (macro && land === 0) {
        ctx.grid.blockRect(mx, mz, 2, 2) // open sea
        continue
      }
      if (macro) {
        ctx.batches.grass.add(mx, -1, mz, 2, 1, 2, groundColor(ctx, mx, mz))
        maybeEmber(ctx, mx, mz, 2, 0.03)
      } else {
        paintCell(ctx, mx, mz)
        paintCell(ctx, mx + 1, mz)
        paintCell(ctx, mx, mz + 1)
        paintCell(ctx, mx + 1, mz + 1)
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

/** The ocean ring beyond the continent edge (animated like the river). */
export function buildOcean(scene: THREE.Scene): WaterRefs {
  const material = new THREE.MeshLambertMaterial({
    color: 0x2f6fb8,
    transparent: true,
    opacity: 0.85
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(0, -0.42, 0)
  scene.add(mesh)
  return { mesh, material }
}

/** Deep sea-floor plane under everything so the world never shows void. */
export function buildHorizon(scene: THREE.Scene): void {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2600, 2600),
    new THREE.MeshLambertMaterial({ color: 0x27486b })
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = -0.95
  scene.add(mesh)
}
