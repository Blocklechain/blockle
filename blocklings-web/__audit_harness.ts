/** TEMP AUDIT HARNESS — runs every zone builder headlessly and reports
 *  per-zone instance counts + PointLight counts. Deleted after the sweep. */
import * as THREE from 'three'
import { registerAllZoneBatches } from './src/world/zones/index'
import { getZoneBuilder } from './src/world/stream'
import { ZONES } from './src/world/zones/registry'
import { CollisionGrid, SIZE } from './src/world/collision'
import { makeRng } from './src/world/rng'
import { VoxelBatch } from './src/world/batch'
import type { Ctx } from './src/world/layout'

function zoneSeed(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h ^ 0xb10c1e) >>> 0
}

registerAllZoneBatches()

const grid = new CollisionGrid()
const surface = new Uint8Array(SIZE * SIZE)

type Row = { id: string; total: number; lights: number }
const rows: Row[] = []
let missing = 0

for (const zone of ZONES) {
  const builder = getZoneBuilder(zone.id)
  if (!builder) {
    missing++
    continue
  }
  const ctx: Ctx = {
    rng: makeRng(zoneSeed(zone.id)),
    grid,
    surface,
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
  const scene = new THREE.Scene()
  builder(ctx, scene, zone)
  let total = 0
  for (const k of Object.keys(ctx.batches) as (keyof Ctx['batches'])[]) {
    total += ctx.batches[k].count
  }
  let lights = 0
  scene.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) lights++
  })
  rows.push({ id: zone.id, total, lights })
}

rows.sort((a, b) => b.total - a.total)
console.log('builders missing:', missing)
console.log('zones run:', rows.length)
console.log('--- top 12 by instances ---')
for (const r of rows.slice(0, 12)) console.log(r.id, r.total, 'lights:', r.lights)
const over = rows.filter((r) => r.total > 12000)
console.log('--- over 12k:', over.length, over.map((r) => `${r.id}=${r.total}`).join(' '))
const overL = rows.filter((r) => r.lights > 1)
console.log('--- over 1 PointLight:', overL.length, overL.map((r) => `${r.id}=${r.lights}`).join(' '))
const totals = rows.reduce((s, r) => s + r.total, 0)
console.log('mean instances/zone:', Math.round(totals / rows.length))

// Determinism probe: rebuild 5 zones with fresh ctx, counts must match.
const probe = rows.slice(0, 5).map((r) => r.id)
for (const id of probe) {
  const zone = ZONES.find((z) => z.id === id)!
  const builder = getZoneBuilder(id)!
  const ctx: Ctx = {
    rng: makeRng(zoneSeed(id)),
    grid,
    surface,
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
  builder(ctx, new THREE.Scene(), zone)
  let total = 0
  for (const k of Object.keys(ctx.batches) as (keyof Ctx['batches'])[]) total += ctx.batches[k].count
  const prev = rows.find((r) => r.id === id)!.total
  console.log('determinism', id, prev === total ? 'OK' : `MISMATCH ${prev} vs ${total}`)
}

// Collision idempotence proof: hash the global grid + surface, re-run the two
// drifting zones, hash again — any NEW mark changes the hash.
function hashBuf(b: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < b.length; i++) { h ^= b[i]!; h = Math.imul(h, 0x01000193) }
  return h >>> 0
}
const gridCells: Uint8Array = (grid as any).cells ?? (grid as any).grid ?? (grid as any).data
console.log('grid buffer found:', gridCells instanceof Uint8Array)
const h1 = hashBuf(gridCells), s1 = hashBuf(surface)
for (const id of ['undercrack', 'deepfreeze']) {
  const zone = ZONES.find((z) => z.id === id)!
  const builder = getZoneBuilder(id)!
  const ctx: Ctx = { rng: makeRng(zoneSeed(id)), grid, surface, batches: { grass: new VoxelBatch(), path: new VoxelBatch(), stone: new VoxelBatch(), wood: new VoxelBatch(), plaster: new VoxelBatch(), roof: new VoxelBatch(), window: new VoxelBatch(), leaf: new VoxelBatch(), misc: new VoxelBatch() } }
  builder(ctx, new THREE.Scene(), zone)
}
const h2 = hashBuf(gridCells), s2 = hashBuf(surface)
console.log('collision idempotent:', h1 === h2 ? 'YES' : 'NO — grid changed on re-run')
console.log('surface idempotent:', s1 === s2 ? 'YES' : 'NO — surface changed on re-run')
