/**
 * src/world/stream.ts — ZONE STREAMING ENGINE for the 1440x1440 world.
 *
 * The 6-region heart (|x|,|z| <= 240) is eagerly built and always resident;
 * the 90 outer-ring zones (src/world/zones/registry.ts) build LAZILY:
 *
 *  - Every ~0.2s the stream checks which zone rects intersect a
 *    RESIDENT_RADIUS (260u) circle around the focus (the player, or a
 *    cinematic camera via `setStreamFocus`). Those become resident.
 *  - First residency enqueues work steps: run the zone's builder into a
 *    FRESH per-zone Ctx (fresh VoxelBatches, the GLOBAL collision grid +
 *    surface map), then bake each batch kind into that zone's own
 *    InstancedMesh. Steps drain under a ~4ms/frame budget — no hitches.
 *  - Leaving (distance > RESIDENT_RADIUS + HYSTERESIS) removes + disposes
 *    the zone's meshes. Geometry + materials are SHARED module singletons —
 *    only the per-zone instance buffers are freed (`mesh.dispose()`).
 *  - COLLISION IS GLOBAL AND PERMANENT: builders mark the global grid and
 *    marks are never unmarked on visual dispose. Builders MUST therefore be
 *    deterministic + idempotent (each zone gets an rng seeded from its id,
 *    so re-entry rebuilds the identical zone).
 *
 * ZONE BUILDER CONTRACT (src/world/zones/* batch files):
 *
 *   import { registerZoneBuilder, streamGroundPass } from '../stream'
 *   registerZoneBuilder('zn_frostfen', (ctx, scene, zone) => {
 *     // 1. stamp surfaces first (kitPath / kitBridgePlank / setSurface)
 *     // 2. streamGroundPass(ctx, zone)  — paints the rect's ground
 *     // 3. props via the kit builders (they mark collision themselves)
 *   })
 *
 * Zones with no registered builder still get streamGroundPass ground, so
 * the world is walkable end-to-end before the zone agents land.
 *
 * This module emits NOTHING on the event bus.
 */
import * as THREE from 'three'
import { VoxelBatch } from './batch'
import { HALF, type CollisionGrid } from './collision'
import {
  S_BANK,
  S_BRIDGE,
  S_COBBLE,
  S_GRASS,
  S_RIVER,
  S_SAND,
  S_SOIL,
  surfaceAt,
  type Ctx
} from './layout'
import { makeRng } from './rng'
import * as P from './palette'
import { BIOME_GROUND, CRYSTAL_GLOW, EMBER, FOREST_MOSS, SWAMP_MURK, isLand } from './kit'
import { regionAt as heartRegionAt } from '../ids'
import { ZONES, type ZoneDef } from './zones/registry'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Zones whose rect is within this of the focus become resident. */
export const RESIDENT_RADIUS = 260
/** Extra distance before a resident zone is evicted (no thrash at edges). */
export const HYSTERESIS = 60
/** Per-frame build/bake budget, milliseconds. */
export const FRAME_BUDGET_MS = 4
/** Residency re-scan cadence, seconds. */
const SCAN_INTERVAL = 0.2

// ---------------------------------------------------------------------------
// Builder registry (module-level so zone files register at import time)
// ---------------------------------------------------------------------------

export type ZoneBuilder = (ctx: Ctx, scene: THREE.Scene, zone: ZoneDef) => void

const builders = new Map<string, ZoneBuilder>()

/** Register the builder for a zone id (one per zone; last write wins). */
export function registerZoneBuilder(zoneId: string, builder: ZoneBuilder): void {
  builders.set(zoneId, builder)
}

/** The registered builder for a zone id, if any (debug/verification). */
export function getZoneBuilder(zoneId: string): ZoneBuilder | undefined {
  return builders.get(zoneId)
}

// ---------------------------------------------------------------------------
// Focus (player or cinematic camera) — integrator calls this each frame
// ---------------------------------------------------------------------------

let focusX = 0.5
let focusZ = 5.5 // spawn plaza — sensible zones stream in even before wiring

/** Point the stream at the player (or a cinematic focus) in world space. */
export function setStreamFocus(x: number, z: number): void {
  focusX = x
  focusZ = z
}

// ---------------------------------------------------------------------------
// Shared bake resources — ONE unit box + ONE material per batch kind.
// Zone meshes all share these; disposing a zone frees only instance buffers.
// ---------------------------------------------------------------------------

type BatchKind = keyof Ctx['batches']

const KIND_OPTS: Record<
  BatchKind,
  { emissive?: number; emissiveIntensity?: number; cast: boolean; receive: boolean }
> = {
  grass: { cast: false, receive: true },
  path: { cast: false, receive: true },
  stone: { cast: true, receive: true },
  wood: { cast: true, receive: true },
  plaster: { cast: true, receive: true },
  roof: { cast: true, receive: true },
  leaf: { cast: true, receive: true },
  misc: { cast: true, receive: true },
  window: { emissive: 0xffa94d, emissiveIntensity: 0.85, cast: false, receive: false }
}

const KINDS = Object.keys(KIND_OPTS) as BatchKind[]

const sharedGeo = new THREE.BoxGeometry(1, 1, 1)
const sharedMats = {} as Record<BatchKind, THREE.MeshLambertMaterial>
for (const k of KINDS) {
  const o = KIND_OPTS[k]
  sharedMats[k] = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.emissiveIntensity ?? 1
  })
}

/**
 * The ONE shared window-glow material every streamed zone bakes with —
 * exposed so the atmosphere module can ramp its emissive color at night
 * (integrator-wired via VillageWorld.glowMaterials; read-only here).
 */
export const zoneWindowMat: THREE.MeshLambertMaterial = sharedMats.window

// ---------------------------------------------------------------------------
// Zone lookup helpers
// ---------------------------------------------------------------------------

let lastZone: ZoneDef | null = null

/** Zone containing (x, z), heart excluded. Cached for spatial locality. */
export function zoneAt(x: number, z: number): ZoneDef | null {
  const lz = lastZone
  if (lz && x >= lz.x0 && x <= lz.x1 && z >= lz.z0 && z <= lz.z1) return lz
  for (const zn of ZONES) {
    if (x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1) {
      lastZone = zn
      return zn
    }
  }
  return null
}

/** Biome at (x, z) across heart regions AND outer zones (for dithering). */
function biomeAt(x: number, z: number, fallback: string): string {
  const r = heartRegionAt(x, z)
  if (r) return r.biome
  return zoneAt(x, z)?.biome ?? fallback
}

/** Squared distance from (x, z) to the zone's rect (0 inside). */
function rectDistSq(zn: ZoneDef, x: number, z: number): number {
  const dx = Math.max(zn.x0 - x, 0, x - zn.x1)
  const dz = Math.max(zn.z0 - z, 0, z - zn.z1)
  return dx * dx + dz * dz
}

/** Cells beyond the zone rect included in its pre-build grid snapshot —
 *  covers props that mark collision just across the border. */
const SNAP_MARGIN = 16

/** Per-zone pre-FIRST-build grid cells (rect + margin), captured once so
 *  re-entry rebuilds replay the first build bit-for-bit (see admit step 1). */
const prebuildGridSnaps = new Map<string, Uint8Array>()

/** FNV-1a of the zone id → deterministic per-zone rng seed. */
function zoneSeed(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h ^ 0xb10c1e) >>> 0
}

// ---------------------------------------------------------------------------
// Streamed ground pass — shared helper every zone builder calls
// ---------------------------------------------------------------------------

/**
 * Paint the zone rect's ground into ctx.batches by biome palette, honoring
 * everything already stamped in the GLOBAL surface map (arterial roads,
 * kitPath streets, kitBridgePlank decks, S_RIVER water channels...).
 * Open-ocean cells are skipped + permanently blocked; near-ocean cells get
 * sand beaches; borders dither into neighboring zones/heart biomes; uniform
 * interior cells collapse into 2x2 macro tiles like the heart's ground.
 * Call AFTER your surface stamps and BEFORE placing props.
 */
export function streamGroundPass(ctx: Ctx, zone: ZoneDef): void {
  const { grid, batches } = ctx
  // Ground paint rolls on a PRIVATE zone-seeded rng, NOT ctx.rng: how many
  // draws happen per cell depends on the GLOBAL surface map (stamped cobble
  // vs open ground, macro-tile collapse), and neighbor zones may stamp
  // border cells after this zone first builds. Were these draws taken from
  // ctx.rng, a rebuild would shift every later prop roll — props drifting
  // away from their permanent collision marks. Isolated here, a late stamp
  // repaints only the affected ground cells (the honored-stamp behavior).
  const rng = makeRng(zoneSeed(zone.id) ^ 0x6702d)
  const pal = BIOME_GROUND[zone.biome] ?? P.GRASS
  const x0 = Math.max(zone.x0, -HALF)
  const z0 = Math.max(zone.z0, -HALF)
  const x1 = Math.min(zone.x1, HALF - 1)
  const z1 = Math.min(zone.z1, HALF - 1)

  const nearOcean = (ix: number, iz: number): boolean =>
    !isLand(ix + 3, iz) || !isLand(ix - 3, iz) || !isLand(ix, iz + 3) || !isLand(ix, iz - 3) ||
    !isLand(ix + 2, iz + 2) || !isLand(ix - 2, iz - 2) || !isLand(ix + 2, iz - 2) || !isLand(ix - 2, iz + 2)

  const groundColor = (ix: number, iz: number): number => {
    if (nearOcean(ix, iz)) return rng.pick(P.SAND)
    // jittered biome sample → dithered borders with neighbors + the heart
    const biome = biomeAt(
      ix + 0.5 + rng.range(-2.5, 2.5),
      iz + 0.5 + rng.range(-2.5, 2.5),
      zone.biome
    )
    switch (biome) {
      case 'meadow':
        return rng.next() < 0.08 ? P.GRASS_DARK : rng.pick(P.GRASS)
      case 'forest':
        return rng.next() < 0.14 ? FOREST_MOSS : rng.pick(BIOME_GROUND['forest']!)
      case 'swamp':
        return rng.next() < 0.1 ? SWAMP_MURK : rng.pick(BIOME_GROUND['swamp']!)
      default:
        return rng.pick(BIOME_GROUND[biome] ?? pal)
    }
  }

  /** Rare glowing fleck (volcanic embers / crystal motes) on open ground. */
  const maybeFleck = (x: number, z: number, span: number, p: number): void => {
    if (zone.biome !== 'volcanic' && zone.biome !== 'crystal') return
    if (rng.next() >= p) return
    batches.window.add(
      x + rng.range(0.1, span - 0.45),
      0,
      z + rng.range(0.1, span - 0.45),
      0.3,
      0.14,
      0.3,
      zone.biome === 'volcanic' ? EMBER : CRYSTAL_GLOW
    )
  }

  const paintCell = (ix: number, iz: number): void => {
    if (!isLand(ix + 0.5, iz + 0.5)) {
      grid.block(ix, iz) // open sea — no ground voxel (permanent mark)
      return
    }
    const s = surfaceAt(ctx, ix, iz)
    switch (s) {
      case S_COBBLE:
        batches.path.voxel(ix, -1, iz, rng.pick(P.COBBLE))
        break
      case S_RIVER:
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
      case S_BRIDGE:
        break // kitBridgePlank (or the zone builder) owns the deck
      default:
        batches.grass.voxel(ix, -1, iz, groundColor(ix, iz))
        maybeFleck(ix, iz, 1, 0.012)
    }
  }

  const mx0 = x0 - (((x0 % 2) + 2) % 2) // even-align so macro tiling is stable
  const mz0 = z0 - (((z0 % 2) + 2) % 2)
  for (let mx = mx0; mx <= x1; mx += 2) {
    for (let mz = mz0; mz <= z1; mz += 2) {
      let macro = true
      let land = 0
      let inRect = 0
      for (let d = 0; d < 4; d++) {
        const ix = mx + (d & 1)
        const iz = mz + (d >> 1)
        if (ix < x0 || ix > x1 || iz < z0 || iz > z1) continue // other zone paints it
        inRect++
        if (surfaceAt(ctx, ix, iz) !== S_GRASS) macro = false
        if (isLand(ix + 0.5, iz + 0.5)) land++
      }
      if (inRect < 4) macro = false // rect edge → per-cell
      if (macro && land !== 0 && land !== 4) macro = false // shoreline → per-cell
      if (macro && land === 0) {
        grid.blockRect(mx, mz, 2, 2) // open sea (permanent)
        continue
      }
      if (macro) {
        batches.grass.add(mx, -1, mz, 2, 1, 2, groundColor(mx, mz))
        maybeFleck(mx, mz, 2, 0.035)
      } else {
        for (let d = 0; d < 4; d++) {
          const ix = mx + (d & 1)
          const iz = mz + (d >> 1)
          if (ix < x0 || ix > x1 || iz < z0 || iz > z1) continue
          paintCell(ix, iz)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

interface ResidentZone {
  zone: ZoneDef
  meshes: THREE.InstancedMesh[]
  ctx: Ctx | null // alive only between build and final bake step
  cancelled: boolean
  baked: boolean
}

type WorkStep = () => void

export class ZoneStream {
  private resident = new Map<string, ResidentZone>()
  private queue: WorkStep[] = []
  private scanT = SCAN_INTERVAL // scan immediately on first update
  private flickerT = 0

  constructor(
    private scene: THREE.Scene,
    private grid: CollisionGrid,
    private surface: Uint8Array
  ) {}

  /** Advance streaming: residency scan + budgeted build/bake work. */
  update(dt: number): void {
    this.scanT += dt
    if (this.scanT >= SCAN_INTERVAL) {
      this.scanT = 0
      this.scan()
    }

    const start = performance.now()
    while (this.queue.length > 0 && performance.now() - start < FRAME_BUDGET_MS) {
      const step = this.queue.shift()!
      step()
    }

    // zone window/ember/crystal glow flickers in step with the heart's
    this.flickerT += dt
    sharedMats.window.emissiveIntensity =
      0.85 + Math.sin(this.flickerT * 2.1) * 0.08 + Math.sin(this.flickerT * 5.3) * 0.04
  }

  /** Debug counts: resident zones and queued work steps. */
  debug(): { resident: number; queued: number } {
    return { resident: this.resident.size, queued: this.queue.length }
  }

  private scan(): void {
    const enterSq = RESIDENT_RADIUS * RESIDENT_RADIUS
    const exit = RESIDENT_RADIUS + HYSTERESIS
    const exitSq = exit * exit

    for (const zn of ZONES) {
      const dSq = rectDistSq(zn, focusX, focusZ)
      const rec = this.resident.get(zn.id)
      if (!rec && dSq <= enterSq) this.admit(zn)
      else if (rec && dSq > exitSq) this.evict(rec)
    }
  }

  private admit(zone: ZoneDef): void {
    const rec: ResidentZone = { zone, meshes: [], ctx: null, cancelled: false, baked: false }
    this.resident.set(zone.id, rec)

    // Step 1 — run the builder into a fresh per-zone Ctx (deterministic rng,
    // GLOBAL grid + surface, fresh batches).
    this.queue.push(() => {
      if (rec.cancelled) return
      // Builders consult the grid (isBlocked scatter skips), so a rebuild on
      // a grid that already holds this zone's own marks would drift the rng
      // stream — different prop spots, NEW permanent marks every re-entry.
      // First build: snapshot the rect's pre-build cells and write marks to
      // the global grid (permanent). Rebuilds: run against a throwaway clone
      // restored to that snapshot — the builder reproduces the first build
      // exactly, and its (identical) marks are simply discarded.
      const m = SNAP_MARGIN
      const sx0 = Math.floor(zone.x0) - m, sz0 = Math.floor(zone.z0) - m
      const sx1 = Math.ceil(zone.x1) + m, sz1 = Math.ceil(zone.z1) + m
      const prior = prebuildGridSnaps.get(zone.id)
      let grid = this.grid
      if (prior) {
        grid = this.grid.clone()
        grid.restoreRect(sx0, sz0, sx1, sz1, prior)
      } else {
        prebuildGridSnaps.set(zone.id, this.grid.snapshotRect(sx0, sz0, sx1, sz1))
      }
      const ctx: Ctx = {
        rng: makeRng(zoneSeed(zone.id)),
        grid,
        surface: this.surface,
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
      rec.ctx = ctx
      const builder = builders.get(zone.id)
      if (builder) builder(ctx, this.scene, zone)
      else streamGroundPass(ctx, zone) // ground-only until the zone agent lands
    })

    // Steps 2..10 — bake one batch kind per step (shared geo + materials).
    for (const kind of KINDS) {
      this.queue.push(() => {
        if (rec.cancelled || !rec.ctx) return
        const mesh = rec.ctx.batches[kind].bakeInto(sharedGeo, sharedMats[kind])
        if (mesh) {
          mesh.castShadow = KIND_OPTS[kind].cast
          mesh.receiveShadow = KIND_OPTS[kind].receive
          this.scene.add(mesh)
          rec.meshes.push(mesh)
        }
      })
    }

    // Final step — drop the build ctx (batch item arrays) once fully baked.
    this.queue.push(() => {
      rec.ctx = null
      rec.baked = true
    })
  }

  private evict(rec: ResidentZone): void {
    rec.cancelled = true // aborts any still-queued steps for this zone
    rec.ctx = null
    for (const mesh of rec.meshes) {
      this.scene.remove(mesh)
      mesh.dispose() // instance buffers ONLY — geometry/materials are shared
    }
    rec.meshes.length = 0
    this.resident.delete(rec.zone.id)
    // collision + surface marks stay — permanent by design
  }
}
