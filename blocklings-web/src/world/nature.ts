/**
 * Nature pass — the tree line around the outskirts, scattered flowers,
 * and the distant low-poly mountain silhouettes.
 */
import * as THREE from 'three'
import { RIVER_X0, RIVER_X1, S_GRASS, VILLAGE_HALF, surfaceAt, type Ctx } from './layout'
import * as P from './palette'
import { kitTree } from './kit'

// ---------------------------------------------------------------------------
// Trees (village ring — the shared kitTree IS the village tree)
// ---------------------------------------------------------------------------

function buildTree(ctx: Ctx, ix: number, iz: number): void {
  kitTree(ctx, ix, iz)
}

function treeSpotOk(ctx: Ctx, ix: number, iz: number): boolean {
  if (ix < -VILLAGE_HALF + 1 || ix >= VILLAGE_HALF - 1 || iz < -VILLAGE_HALF + 1 || iz >= VILLAGE_HALF - 1) return false
  if (ix >= RIVER_X0 - 2 && ix <= RIVER_X1 + 2) return false // keep off the river
  if (surfaceAt(ctx, ix, iz) !== S_GRASS) return false
  if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
  return true
}

function buildTrees(ctx: Ctx): void {
  const { rng } = ctx
  // dense ring around the outskirts, between the fence and the world edge
  let placed = 0
  let tries = 0
  while (placed < 60 && tries < 600) {
    tries++
    const angle = rng.range(0, Math.PI * 2)
    const radius = rng.range(42, 56)
    const ix = Math.round(Math.cos(angle) * radius)
    const iz = Math.round(Math.sin(angle) * radius)
    if (!treeSpotOk(ctx, ix, iz)) continue
    buildTree(ctx, ix, iz)
    placed++
  }
  // a few shade trees inside the village corners
  for (const [ix, iz] of [
    [-30, -28],
    [28, -30],
    [-32, 30],
    [30, 28]
  ] as const) {
    if (treeSpotOk(ctx, ix, iz)) buildTree(ctx, ix, iz)
  }
}

// ---------------------------------------------------------------------------
// Flowers
// ---------------------------------------------------------------------------

function buildFlowers(ctx: Ctx): void {
  const { rng, batches } = ctx
  let placed = 0
  let tries = 0
  while (placed < 200 && tries < 1200) {
    tries++
    // flowers stay in the home meadow — regions scatter their own flora
    const ix = rng.int(VILLAGE_HALF * 2 - 4) - VILLAGE_HALF + 2
    const iz = rng.int(VILLAGE_HALF * 2 - 4) - VILLAGE_HALF + 2
    if (surfaceAt(ctx, ix, iz) !== S_GRASS) continue
    if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) continue
    const fx = ix + rng.range(0.15, 0.6)
    const fz = iz + rng.range(0.15, 0.6)
    batches.misc.add(fx, 0, fz, 0.22, rng.range(0.25, 0.45), 0.22, rng.pick(P.FLOWER))
    placed++
  }
}

// ---------------------------------------------------------------------------
// Distant mountains — island silhouettes out past the ocean ring
// (one instanced low-poly cone mesh: bodies + snow tips)
// ---------------------------------------------------------------------------

function buildMountains(ctx: Ctx, scene: THREE.Scene): void {
  const { rng } = ctx
  const peaks: Array<{ x: number; z: number; r: number; h: number }> = []
  const count = 14
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + rng.range(-0.15, 0.15)
    const dist = rng.range(300, 400)
    peaks.push({
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      r: rng.range(26, 48),
      h: rng.range(36, 80)
    })
  }

  const geo = new THREE.ConeGeometry(1, 1, 5)
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true })
  const mesh = new THREE.InstancedMesh(geo, mat, peaks.length * 2)

  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const p = new THREE.Vector3()
  const s = new THREE.Vector3()
  const c = new THREE.Color()
  let i = 0
  for (const pk of peaks) {
    const yaw = rng.range(0, Math.PI * 2)
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    // body
    p.set(pk.x, pk.h / 2 - 0.5, pk.z)
    s.set(pk.r, pk.h, pk.r)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.setHex(rng.pick(P.MOUNTAIN)))
    i++
    // snow tip (matches the cone slope at 60% height)
    p.set(pk.x, pk.h * 0.8 - 0.5, pk.z)
    s.set(pk.r * 0.42, pk.h * 0.42, pk.r * 0.42)
    m.compose(p, q, s)
    mesh.setMatrixAt(i, m)
    mesh.setColorAt(i, c.setHex(P.SNOW))
    i++
  }
  mesh.matrixAutoUpdate = false
  scene.add(mesh)
}

/** Build all the greenery + scenery. */
export function buildNature(ctx: Ctx, scene: THREE.Scene): void {
  buildTrees(ctx)
  buildFlowers(ctx)
  buildMountains(ctx, scene)
}
