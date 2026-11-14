/**
 * Crafting stations — voxel props for the 4 production professions, built
 * with the shared world kit vocabulary (VoxelBatch Lambert boxes, flat
 * colors, glow ONLY via the shared flickering window batch — no new lights).
 *
 * This file is the sanctioned WORLD-SIDE hook of the crafting module:
 * `registerCraftingStations(ctx)` is called by src/world/index.ts during the
 * eager build passes (after the region builders, before the batches bake).
 * It places each station at its preferred cell — nudged by a spiral search
 * to the nearest clear footprint — marks the collision grid like every other
 * prop, and records the interact anchors the crafting module polls at
 * runtime via `stationSpots()`.
 *
 * Placement (read against src/ids.ts NPCS + src/world/village.ts layout):
 *   forge_ironhold  (-154, 32)  beside Smith Orin's camp forge, Ironhold
 *   forge_village   ( 15, -10)  south of the village Blacksmith's door
 *   stove_village   (-11,  -7)  by the Sleeping Blockling Inn's east door
 *   alchemy_capital (-28, -187) at the foot of Archmage Lyra's tower
 *   loom_village    (-11,  13)  by Cottage A, across from the farm
 */
import { CRYSTAL_GLOW, EMBER } from '../world/kit'
import * as P from '../world/palette'
import { S_BRIDGE, S_RIVER, surfaceAt, type Ctx } from '../world/layout'

export type StationKind = 'forge' | 'stove' | 'alchemy' | 'loom'

export interface StationSpot {
  id: string
  kind: StationKind
  /** Display name for the prompt + panel header. */
  name: string
  /** Interact anchor (world units, footprint center). */
  x: number
  z: number
}

const spots: StationSpot[] = []

/** Interact anchors of every placed station (empty before the world builds). */
export function stationSpots(): readonly StationSpot[] {
  return spots
}

const ANVIL_IRON = 0x6a6f78
const CAULDRON_BREW = 0x7ed957
const CLOTH_ROLL = 0xc46a9e
const WOOL_WHITE = 0xf2ede2

/** True when the footprint [x..x+w) x [z..z+d) is clear, walkable ground. */
function clear(ctx: Ctx, x: number, z: number, w: number, d: number): boolean {
  for (let ix = x; ix < x + w; ix++) {
    for (let iz = z; iz < z + d; iz++) {
      if (ctx.grid.isBlocked(ix + 0.5, iz + 0.5)) return false
      const s = surfaceAt(ctx, ix, iz)
      if (s === S_RIVER || s === S_BRIDGE) return false
    }
  }
  return true
}

/** Spiral out from the preferred cell to the nearest clear footprint. */
function findSpot(
  ctx: Ctx,
  px: number,
  pz: number,
  w: number,
  d: number
): { x: number; z: number } | null {
  for (let r = 0; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        if (clear(ctx, px + dx, pz + dz, w, d)) return { x: px + dx, z: pz + dz }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Builders (each marks its own collision; glow via the window batch only)
// ---------------------------------------------------------------------------

/** Forge: stone hearth + chimney, flickering coal bed, anvil, quench barrel. */
function buildForge(ctx: Ctx, x: number, z: number): void {
  const { rng, batches, grid } = ctx
  // 3x2 footprint: hearth row at the back (+z), work row at the front
  batches.stone.add(x, 0, z + 1, 3, 1.1, 1, rng.pick(P.STONE)) // hearth block
  batches.stone.add(x + 1, 1.1, z + 1.05, 1, 1.9, 0.9, rng.pick(P.STONE)) // chimney
  batches.stone.add(x + 0.9, 3.0, z + 0.95, 1.2, 0.3, 1.1, rng.pick(P.STONE)) // cap
  // coal bed, spilling embers — shared flickering window batch, no lights
  batches.window.add(x + 0.2, 1.1, z + 1.15, 0.6, 0.25, 0.7, EMBER)
  batches.window.add(x + 2.2, 1.1, z + 1.15, 0.6, 0.25, 0.7, EMBER)
  batches.window.add(x + 1.15, 0.25, z + 0.6, 0.4, 0.2, 0.35, EMBER)
  // anvil on a stump + quench barrel
  batches.wood.add(x + 0.25, 0, z + 0.2, 0.6, 0.45, 0.6, P.WOOD_DARK)
  batches.misc.add(x + 0.08, 0.45, z + 0.28, 0.95, 0.32, 0.45, ANVIL_IRON)
  batches.wood.add(x + 2.2, 0, z + 0.15, 0.7, 0.75, 0.7, rng.pick(P.WOOD))
  batches.misc.add(x + 2.3, 0.68, z + 0.25, 0.5, 0.1, 0.5, 0x3f87d6) // water
  grid.blockRect(x, z, 3, 2)
}

/** Stove: stone oven with a glowing firebox, stovepipe, bread on the board. */
function buildStove(ctx: Ctx, x: number, z: number): void {
  const { rng, batches, grid } = ctx
  // oven body (2x1, back cell) with the arch mouth + ember glow inside
  batches.stone.add(x, 0, z + 1, 2, 1.5, 1, rng.pick(P.STONE))
  batches.stone.add(x + 0.2, 1.5, z + 1.1, 1.6, 0.5, 0.8, rng.pick(P.STONE)) // dome
  batches.wood.add(x + 1.45, 2.0, z + 1.3, 0.35, 1.2, 0.35, P.WOOD_DARK) // pipe
  batches.misc.add(x + 0.5, 0.35, z + 0.92, 1.0, 0.75, 0.12, 0x2a2118) // mouth
  batches.window.add(x + 0.65, 0.42, z + 1.0, 0.7, 0.45, 0.3, EMBER) // fire
  // prep counter in front, with the day's questionable output
  batches.wood.add(x, 0, z, 2, 0.75, 0.8, rng.pick(P.WOOD))
  batches.misc.add(x + 0.2, 0.75, z + 0.18, 0.5, 0.3, 0.4, 0x7a4e26) // bread
  batches.misc.add(x + 1.25, 0.75, z + 0.22, 0.45, 0.25, 0.4, 0xf0c33c) // cheese
  grid.blockRect(x, z, 2, 2)
}

/** Alchemy table: dark bench, glowing flasks, bubbling cauldron, one book. */
function buildAlchemyTable(ctx: Ctx, x: number, z: number): void {
  const { rng, batches, grid } = ctx
  // the bench (front cell pair)
  batches.wood.add(x + 0.1, 0, z + 0.15, 0.25, 0.8, 0.25, P.WOOD_DARK)
  batches.wood.add(x + 1.65, 0, z + 0.15, 0.25, 0.8, 0.25, P.WOOD_DARK)
  batches.wood.add(x, 0.8, z, 2, 0.15, 0.9, P.WOOD_DARK)
  // glowing flasks on the bench (shared flicker batch — they hum, gently)
  batches.window.add(x + 0.25, 0.95, z + 0.25, 0.25, 0.4, 0.25, CRYSTAL_GLOW)
  batches.window.add(x + 0.65, 0.95, z + 0.4, 0.2, 0.3, 0.2, CAULDRON_BREW)
  batches.window.add(x + 1.5, 0.95, z + 0.3, 0.22, 0.34, 0.22, EMBER)
  batches.misc.add(x + 1.0, 0.95, z + 0.3, 0.45, 0.12, 0.35, 0xd8d4c8) // book
  // cauldron behind (back row): stone ring + suspicious green surface
  batches.stone.add(x + 0.55, 0, z + 1.05, 0.9, 0.7, 0.9, rng.pick(P.STONE))
  batches.window.add(x + 0.68, 0.7, z + 1.18, 0.64, 0.12, 0.64, CAULDRON_BREW)
  grid.blockRect(x, z, 2, 2)
}

/** Loom: timber frame, warp threads, cloth roll, wool basket, work bench. */
function buildLoom(ctx: Ctx, x: number, z: number): void {
  const { rng, batches, grid } = ctx
  // frame: two uprights + top/bottom beams (back row)
  batches.wood.add(x + 0.1, 0, z + 1.3, 0.3, 2.2, 0.3, P.WOOD_DARK)
  batches.wood.add(x + 1.6, 0, z + 1.3, 0.3, 2.2, 0.3, P.WOOD_DARK)
  batches.wood.add(x, 2.0, z + 1.28, 2, 0.22, 0.34, rng.pick(P.WOOD))
  batches.wood.add(x, 0.35, z + 1.28, 2, 0.2, 0.34, rng.pick(P.WOOD))
  // the warp: one thin pale sheet + a half-woven colored band
  batches.plaster.add(x + 0.4, 0.55, z + 1.38, 1.2, 1.45, 0.08, WOOL_WHITE)
  batches.misc.add(x + 0.4, 0.55, z + 1.33, 1.2, 0.55, 0.1, CLOTH_ROLL)
  // front row: bench + wool basket with fluff
  batches.wood.add(x + 0.15, 0, z + 0.2, 1.0, 0.45, 0.5, rng.pick(P.WOOD))
  batches.wood.add(x + 1.35, 0, z + 0.15, 0.6, 0.5, 0.6, P.WOOD_DARK)
  batches.misc.add(x + 1.42, 0.5, z + 0.22, 0.45, 0.25, 0.45, WOOL_WHITE)
  batches.misc.add(x + 1.52, 0.75, z + 0.35, 0.22, 0.16, 0.22, WOOL_WHITE)
  grid.blockRect(x, z, 2, 2)
}

// ---------------------------------------------------------------------------
// Registration (called from src/world/index.ts during the eager build)
// ---------------------------------------------------------------------------

interface StationDef {
  id: string
  kind: StationKind
  name: string
  px: number
  pz: number
  w: number
  d: number
  build: (ctx: Ctx, x: number, z: number) => void
}

const STATIONS: readonly StationDef[] = [
  { id: 'forge_village', kind: 'forge', name: 'Village Forge', px: 15, pz: -10, w: 3, d: 2, build: buildForge },
  { id: 'forge_ironhold', kind: 'forge', name: 'Ironhold Forge', px: -154, pz: 32, w: 3, d: 2, build: buildForge },
  { id: 'stove_village', kind: 'stove', name: 'Inn Stove', px: -11, pz: -7, w: 2, d: 2, build: buildStove },
  { id: 'alchemy_capital', kind: 'alchemy', name: 'Alchemy Table', px: -28, pz: -187, w: 2, d: 2, build: buildAlchemyTable },
  { id: 'loom_village', kind: 'loom', name: 'Village Loom', px: -11, pz: 13, w: 2, d: 2, build: buildLoom }
]

/**
 * Build + register every station. Idempotent per world build (clears the
 * spot registry first so a hot-reloaded world doesn't double up).
 */
export function registerCraftingStations(ctx: Ctx): void {
  spots.length = 0
  for (const s of STATIONS) {
    const at = findSpot(ctx, s.px, s.pz, s.w, s.d)
    if (!at) {
      console.warn(`[crafting] no clear spot for station ${s.id} near (${s.px}, ${s.pz})`)
      continue
    }
    s.build(ctx, at.x, at.z)
    spots.push({ id: s.id, kind: s.kind, name: s.name, x: at.x + s.w / 2, z: at.z + s.d / 2 })
  }
}
