/**
 * The Anvil of Ascension — the upgrading module's world-side station prop,
 * built from the shared kit vocabulary (VoxelBatch Lambert boxes, flat
 * colors, glow ONLY via the shared flickering window batch — no new lights),
 * exactly like crafting/stations.ts.
 *
 * `registerAnvilStation(ctx)` is called by src/world/index.ts during the eager
 * build (right after the crafting stations, so the clear-spot search sees
 * every other prop). It places the anvil in the Royal Capital, marks the
 * collision grid, and records the interact anchor the module polls via
 * `anvilSpot()`.
 *
 * Placement: the Capital region is x[-80..80] z[-240..-80]; the Capital
 * waystone sits at (6, -140). The anvil wants (12, -148) — a few steps off
 * the waystone plaza, so players teleport in and ascend their gear.
 */
import { CRYSTAL_GLOW, EMBER } from '../world/kit'
import * as P from '../world/palette'
import { S_BRIDGE, S_RIVER, surfaceAt, type Ctx } from '../world/layout'

export interface AnvilSpot {
  id: string
  name: string
  /** Interact anchor (world units, footprint center). */
  x: number
  z: number
}

let spot: AnvilSpot | null = null

/** The placed anvil's interact anchor (null before the world builds). */
export function anvilSpot(): AnvilSpot | null {
  return spot
}

const ANVIL_IRON = 0x4a4e57
const ANVIL_DARK = 0x33363d
const RUNE_BLUE = CRYSTAL_GLOW

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
function findSpot(ctx: Ctx, px: number, pz: number, w: number, d: number): { x: number; z: number } | null {
  for (let r = 0; r <= 10; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        if (clear(ctx, px + dx, pz + dz, w, d)) return { x: px + dx, z: pz + dz }
      }
    }
  }
  return null
}

/**
 * Stone plinth + iron anvil + a slow-floating enchant crystal and ember bed.
 * 2x2 footprint; the "float" is faked with a thin stem so no runtime anim is
 * needed (atmosphere handles the window-batch glow pulse).
 */
function buildAnvil(ctx: Ctx, x: number, z: number): void {
  const { rng, batches, grid } = ctx
  // Stepped stone plinth (back-left of the footprint).
  batches.stone.add(x + 0.1, 0, z + 0.1, 1.8, 0.5, 1.8, rng.pick(P.STONE))
  batches.stone.add(x + 0.35, 0.5, z + 0.35, 1.3, 0.45, 1.3, rng.pick(P.STONE))
  // The anvil: base, waist, face + one horn.
  batches.misc.add(x + 0.55, 0.95, z + 0.55, 0.9, 0.28, 0.6, ANVIL_DARK)
  batches.misc.add(x + 0.75, 1.23, z + 0.62, 0.45, 0.22, 0.45, ANVIL_DARK)
  batches.misc.add(x + 0.5, 1.45, z + 0.55, 1.0, 0.26, 0.62, ANVIL_IRON)
  batches.misc.add(x + 1.45, 1.5, z + 0.7, 0.4, 0.16, 0.3, ANVIL_IRON) // horn
  // Ember bed glowing in the plinth notch (shared flicker batch — no lights).
  batches.window.add(x + 0.3, 0.5, z + 1.5, 0.5, 0.2, 0.35, EMBER)
  batches.window.add(x + 1.2, 1.46, z + 0.6, 0.3, 0.06, 0.45, EMBER) // hot face
  // Floating ascension crystal: thin dark stem + a glowing cut shard up top.
  batches.misc.add(x + 0.95, 1.71, z + 0.8, 0.05, 0.5, 0.05, ANVIL_DARK)
  batches.window.add(x + 0.82, 2.18, z + 0.67, 0.28, 0.46, 0.28, RUNE_BLUE)
  batches.window.add(x + 0.9, 2.62, z + 0.75, 0.12, 0.2, 0.12, RUNE_BLUE) // tip
  grid.blockRect(x, z, 2, 2)
}

/** Build + register the one Anvil of Ascension. Idempotent per world build. */
export function registerAnvilStation(ctx: Ctx): void {
  spot = null
  const w = 2
  const d = 2
  const at = findSpot(ctx, 12, -148, w, d)
  if (!at) {
    console.warn('[upgrading] no clear spot for the Anvil of Ascension near (12, -148)')
    return
  }
  buildAnvil(ctx, at.x, at.z)
  spot = { id: 'anvil_capital', name: 'Anvil of Ascension', x: at.x + w / 2, z: at.z + d / 2 }
}
